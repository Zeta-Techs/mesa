/**
 * 评审页结构化批注清单与上一轮逐条验改纯逻辑（2026-11-23）：
 * 底层仍以 `.ccode/review-notes.md` 与一行一条的 Markdown 文本为唯一真实数据源（与现有划选批注、
 * 核验清单加进意见、方案研讨回流、AI 退回提示词 100% 兼容）；
 * 这里负责把文本解析成可点击定位、可单独删改、可逐条勾销「已解决」的结构化条目。
 */

export type ReviewNoteKind = "quote" | "image" | "check" | "plain";

export interface ReviewNoteItem {
  /** 原始文本中的 0-based 行号（用于精确删改，不破坏其他行） */
  lineIndex: number;
  /** 该行原始文本 */
  raw: string;
  kind: ReviewNoteKind;
  /** 关联文件名或相对路径（用于点卡片跳转文件/Diff） */
  file: string | null;
  /** 行号（核验项带 file:line 时提取） */
  line: number | null;
  /** 划选原文摘录或图名 */
  excerpt: string | null;
  /** 具体修改意见正文 */
  comment: string;
  /** 框图标注红框图路径（若有） */
  markPath: string | null;
  /** 稳定指纹：用于在 localStorage 记住上一轮每条意见的「已验改」状态 */
  key: string;
}

const MARK_SUFFIX_RE = /（标注图[^）]*：([^）]+)）\s*$/;
const QUOTE_LINE_RE = /^\s*[-*•]?\s*「(.+)」（((?:[^「」（）\n]|（[^「」（）\n]*）)+)）：(.*)$/;
const FILE_LINE_REF_RE = /([A-Za-z0-9_./-]+\.(?:md|qmd|bib|json|csv|ya?ml|toml|py|ts|tsx|rs|svg|png|jpe?g|pdf|docx))(?::(\d+)|#L(\d+))?/;

function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** 把多行退回意见解析为结构化批注条目（跳过纯空行与批处理引导句） */
export function parseReviewItems(notes: string): ReviewNoteItem[] {
  const lines = notes.replace(/\r\n/g, "\n").split("\n");
  const out: ReviewNoteItem[] = [];
  const seenKeys = new Map<string, number>();

  lines.forEach((raw, lineIndex) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // 跳过批量核验开头那句纯引导语（不作为独立可勾销卡片）
    if (/^请逐条判断/.test(trimmed) && !trimmed.startsWith("-")) return;

    const baseKey = shortHash(trimmed);
    const dupCount = seenKeys.get(baseKey) ?? 0;
    seenKeys.set(baseKey, dupCount + 1);
    const key = dupCount === 0 ? baseKey : `${baseKey}_${dupCount}`;

    const qm = QUOTE_LINE_RE.exec(trimmed);
    if (qm) {
      const excerpt = qm[1].trim();
      const file = qm[2].trim();
      let rest = qm[3].trim();
      let markPath: string | null = null;
      const mm = MARK_SUFFIX_RE.exec(rest);
      if (mm) {
        markPath = mm[1].trim();
        rest = rest.slice(0, mm.index).trim();
      }
      const isImg = Boolean(markPath) || /^图\s+/.test(excerpt);
      out.push({
        lineIndex,
        raw,
        kind: isImg ? "image" : "quote",
        file,
        line: null,
        excerpt,
        comment: rest || "（待补）",
        markPath,
        key,
      });
      return;
    }

    const body = trimmed.replace(/^[-*•]\s+/, "").trim();
    const fm = FILE_LINE_REF_RE.exec(body);
    const file = fm ? fm[1] : null;
    const lineNum = fm ? Number(fm[2] || fm[3] || 0) || null : null;
    const isCheck =
      /^\[?(?:核验|拦下|待你判断|检查)\]?/.test(body) ||
      /核验|覆盖检查|拼图|已排除|references\.bib|sections\.json|待绘制|\[待核实\]/.test(body);

    out.push({
      lineIndex,
      raw,
      kind: isCheck ? "check" : "plain",
      file,
      line: lineNum,
      excerpt: null,
      comment: body,
      markPath: null,
      key,
    });
  });

  return out;
}

/** 按原始行号删除一条批注；若只剩孤立的批量引导行则一并清掉 */
export function removeReviewItem(notes: string, lineIndex: number): string {
  const lines = notes.replace(/\r\n/g, "\n").split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return notes;
  lines.splice(lineIndex, 1);
  const cleaned = lines.filter((l) => l.trim().length > 0);
  if (cleaned.length === 1 && /^请逐条判断/.test(cleaned[0].trim()) && !cleaned[0].trim().startsWith("-")) {
    return "";
  }
  return cleaned.join("\n");
}

/** 就地修改一条批注的修改意见正文，保留原有的「引文」（文件）与（标注图…）外壳 */
export function updateReviewItemComment(notes: string, lineIndex: number, nextComment: string): string {
  const lines = notes.replace(/\r\n/g, "\n").split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return notes;
  const cleanComment = nextComment.replace(/\s+/g, " ").trim();
  if (!cleanComment) return notes;

  const raw = lines[lineIndex];
  const trimmed = raw.trim();
  const qm = QUOTE_LINE_RE.exec(trimmed);
  if (qm) {
    const excerpt = qm[1];
    const file = qm[2];
    const mm = MARK_SUFFIX_RE.exec(qm[3]);
    const suffix = mm ? mm[0] : "";
    lines[lineIndex] = `- 「${excerpt}」（${file}）：${cleanComment}${suffix}`;
  } else {
    const bullet = /^\s*[-*•]\s+/.test(raw) ? "- " : "";
    lines[lineIndex] = `${bullet}${cleanComment}`;
  }
  return lines.join("\n");
}

const RESOLVED_PREFIX = "ccode:review-resolved:";

function resolvedStorageKey(worktreePath: string, lastNotes: string): string {
  const norm = worktreePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return `${RESOLVED_PREFIX}${shortHash(norm)}:${shortHash(lastNotes.trim())}`;
}

export function readResolvedReviewKeys(worktreePath: string, lastNotes: string): string[] {
  if (!worktreePath || !lastNotes.trim()) return [];
  try {
    const raw = localStorage.getItem(resolvedStorageKey(worktreePath, lastNotes));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function writeResolvedReviewKeys(worktreePath: string, lastNotes: string, keys: readonly string[]): void {
  if (!worktreePath || !lastNotes.trim()) return;
  try {
    localStorage.setItem(resolvedStorageKey(worktreePath, lastNotes), JSON.stringify([...new Set(keys)]));
  } catch {
    /* 忽略存储受限 */
  }
}
