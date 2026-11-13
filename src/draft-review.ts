/** 写作步评审：机械红线扫描 + 退回给 Agent 的提示词。不解释学术对错。 */
import type { CheckItem } from "./research-checks.ts";
import { manuscriptSourcePath } from "./manuscript-files.ts";

export interface WritingReviewHit {
  id: string;
  label: string;
}

function abstractBlock(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "");
  const start = trimmed.search(/^#{1,3}\s+abstract\b/im);
  if (start < 0) {
    return trimmed.slice(0, 1200);
  }
  const after = trimmed.slice(start);
  const nl = after.indexOf("\n");
  const rest = nl < 0 ? "" : after.slice(nl + 1);
  const next = rest.search(/^#{1,3}\s+/m);
  return next < 0 ? after : after.slice(0, nl + 1 + next);
}

function bodyWithoutFramework(text: string): string {
  const i = text.search(/^#{1,3}\s*框架推演\b/m);
  return i >= 0 ? text.slice(0, i) : text;
}

/** 图的占位：「待绘制」和空路径的图片 `![…]()`。写作扫描数处数、定稿核对按行拦下，共用这一份（2026-11-11） */
export function placeholderFigureLines(text: string): number[] {
  const out: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/待绘制|!\[[^\]]*\]\(\s*\)/.test(line)) out.push(i + 1);
  });
  return out;
}

export function scanWritingReview(
  text: string,
  /** 大纲两样都放行：空白编号本就在大纲里推演；大纲不渲染，章节号是给人看结构的（2026-11-11 HER 大纲误报「标题里写了序号」） */
  opts?: { allowGapIds?: boolean; allowNumberedHeadings?: boolean },
): WritingReviewHit[] {
  const hits: WritingReviewHit[] = [];
  const abstract = abstractBlock(text);
  if (/\[待核实\]/.test(abstract)) {
    hits.push({ id: "abstract-unverified", label: "摘要含 [待核实]" });
  }
  const body = bodyWithoutFramework(text);
  if (!opts?.allowGapIds && /\bG\d+\b/.test(body)) {
    hits.push({ id: "gap-ids", label: "正文含空白编号（G1…）" });
  }
  const drawn = placeholderFigureLines(body).length;
  if (drawn > 0) {
    hits.push({ id: "placeholder-fig", label: `${drawn} 处「待绘制」` });
  }
  if (!opts?.allowNumberedHeadings && /^#{1,6}\s+\d+(\.\d+)*[.\s]/m.test(body)) {
    hits.push({ id: "manual-numbers", label: "标题里写了序号，渲染时会再自动编号" });
  }
  return hits;
}

/** 源稿优先；渲染稿里 Word 先于 PDF。 */
export function sortWritingPreviewPaths(paths: readonly string[]): string[] {
  const rank = (path: string) => {
    const n = path.replace(/\\/g, "/").toLowerCase();
    if (n.endsWith(".md") || n.endsWith(".qmd")) return 0;
    if (n.endsWith(".docx")) return 1;
    if (n.endsWith(".pdf")) return 2;
    return 3;
  };
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "zh"));
}

/** 只扫稿件和大纲。检索记录、纳入清单、任务书里的编号标题不是稿件问题。
 *  写作规范 manuscript/style-sheet.md 不是稿件（大纲那步就交，2026-11-11 HER：它的「## 1 核心术语」被当成稿件报「标题里写了序号」） */
export function writingScanSourcePath(paths: readonly string[]): string | null {
  // 哪份是主稿、哪些是写作配套文件，统一按 manuscript-files.ts（写作规范、章节状态、修改记录等不当稿件扫）
  return manuscriptSourcePath(paths);
}

/** 划选批注的单行上限。整段引用会把意见框撑满，退回时 Agent 也读不清改哪一句。 */
const ANNOTATION_QUOTE_CAP = 160;

/** 点「加进意见」时记住的选段。空选区不开批注条。 */
export function annotationDraftFromSelection(selected: string): string | null {
  const quote = selected.trim();
  return quote ? quote : null;
}

/** 超长的选段收成「开头…结尾」：AI 照首尾认得出是哪一段，审阅高亮也能按首尾标全整段
 *（2026-11-13 用户：只截开头时高亮只盖住前一百多字，像没选全） */
const QUOTE_HEAD = 100;
const QUOTE_TAIL = 50;

function oneLineQuote(excerpt: string): string {
  const flat = excerpt.replace(/\s+/g, " ").trim();
  if (flat.length <= ANNOTATION_QUOTE_CAP) return flat;
  return `${flat.slice(0, QUOTE_HEAD).trimEnd()}…${flat.slice(-QUOTE_TAIL).trimStart()}`;
}

/**
 * 把划中的句子收成一条意见，追加到已有意见末尾。
 * 人还没写批注时先占一行「（待补）」，退回前可以改。
 * 同一段、同一句批注不重复追加。
 */
/** 扫描结果并进核验清单（2026-11-11 评审页整理：不再单独占一段黄字），算 Mesa 自己查的、只到「待你判断」 */
export function writingHitChecks(hits: readonly WritingReviewHit[], file: string): CheckItem[] {
  return hits.map((hit) => ({
    id: `writing-${hit.id}`,
    kind: "writing-scan",
    status: "needs_human",
    title: hit.label,
    target: { file },
    checker: "mesa",
  }));
}

/** 意见里追加一行；同一行已经有了就不重复加 */
export function appendReviewLine(notes: string, line: string): string {
  const existing = notes.trim();
  const next = line.trim();
  if (!next) return existing;
  if (!existing) return next;
  if (existing.split("\n").some((row) => row.trim() === next)) return existing;
  return `${existing}\n${next}`;
}

/** 给图加意见时写进意见行的「引文」：图名取文件名，没有就取图注文字 */
export function imageAnnotationExcerpt(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  return `图 ${base || "（无名图）"}`;
}

/** 审阅里「加进意见」的回调：第四个参数是带红框的标注图路径（图 / PDF 圈选才有）。返回 null = 已追加，字符串 = 提示 */
export type ReviewAnnotate = (
  text: string,
  fileName: string,
  comment: string,
  markPath?: string,
) => string | null;

export function appendReviewAnnotation(
  notes: string,
  input: { fileName: string; excerpt: string; comment?: string; markPath?: string },
): string {
  const quote = oneLineQuote(input.excerpt);
  if (!quote) return notes;
  const comment = (input.comment ?? "").replace(/\s+/g, " ").trim() || "（待补）";
  const image = input.markPath ? `（标注图，红框处就是要改的位置：${input.markPath}）` : "";
  return appendReviewLine(notes, `- 「${quote}」（${input.fileName}）：${comment}${image}`);
}

/** 意见栏里每条「- 「引文」（文件）：…」的引文与文件名。「开头…结尾」原样返回（反查时按首尾找）；
 *  旧格式只留开头、以省略号收尾的去掉省略号，当前缀用。引文自身含「……」（……）时按最后一个文件括号切分 */
export function reviewNoteQuotes(notes: string): { file: string; quote: string }[] {
  const out: { file: string; quote: string }[] = [];
  for (const line of notes.split("\n")) {
    const m = /^\s*- 「(.+)」（((?:[^「」（）\n]|（[^「」（）\n]*）)+)）：/.exec(line);
    if (!m) continue;
    const quote = m[1].replace(/…$/, "").trim();
    if (quote) out.push({ file: m[2], quote });
  }
  return out;
}

/** 评审「退回修改」选了另一家：新开的一段对话不知道这一步做过什么，先交代它从哪读起 */
export const FRESH_RETURN_LEAD =
  "你是新开的一段对话，接手这一步的返修（原来那段对话没有接回）。先读 TASK.md、`.ccode/review-notes.md` 和现有产物（稿件、figures/README.md、本步报告），在现稿上按意见改，不要从零重写。";

export function writingReturnPrompt(input: {
  notes: string;
  hits: readonly WritingReviewHit[];
  rewrite: boolean;
}): string {
  const notes = input.notes.trim();
  const lines = [
    input.rewrite
      ? "用户在评审里要求按意见重写本步稿件。读 TASK.md、outline.md、notes/ 和 `.ccode/review-notes.md`。保留已核对的论点和可解析引用键，不要另起无关结构，不要凑字数。"
      : "用户在评审里退回本步。读 TASK.md 和 `.ccode/review-notes.md`，按意见改现有产物，不要整篇从零重写，不要凑字数。",
  ];
  if (input.hits.length > 0) {
    lines.push(`机械红线：${input.hits.map((h) => h.label).join("；")}。`);
  }
  if (notes) {
    lines.push("意见：", notes);
  }
  lines.push("改完在本工作区提交。不要保存进项目。");
  return lines.join("\n");
}
