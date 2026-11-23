/**
 * 定稿步「AI 写好、人来填」两份文件的结构化读写（2026-10-24 用户：打开清单、打开填写很不方便）。
 * 原先就地打开 Markdown 编辑：许可清单是 8 列表格，改一块状态要在竖线里找格子；投稿声明要自己认小标题。
 * 这里把它们拆成一行一块 / 一节一框，改完按原格式写回，AI 读到的还是同一份 Markdown。
 */

export const PERMISSION_STATUSES = ["待申请", "已申请", "已获许可", "无需申请"] as const;

export interface PermissionRow {
  /** 在文件里的行号（写回用） */
  line: number;
  figure: string;
  /** 原文（去掉 DOI 链接后的引文） */
  paper: string;
  doiUrl: string | null;
  label: string;
  publisher: string;
  licence: string;
  need: string;
  credit: string;
  status: string;
}

const LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return null;
  return t.slice(1, -1).split("|").map((c) => c.trim());
}

/** 许可清单表格逐行拆出来；认表头「| 图 | … | 状态 |」，表头和分隔行之后到表格结束 */
export function parsePermissionRows(text: string): PermissionRow[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const head = lines.findIndex((l) => {
    const c = cells(l);
    return c != null && c[0] === "图" && c[c.length - 1] === "状态";
  });
  if (head < 0) return [];
  const rows: PermissionRow[] = [];
  for (let i = head + 2; i < lines.length; i++) {
    const c = cells(lines[i]);
    if (!c) break;
    if (c.length < 8 || c[0] === "—") continue;
    const doiUrl = [...c[1].matchAll(LINK)].find((m) => m[2].includes("doi.org"))?.[2] ?? null;
    rows.push({
      line: i,
      figure: c[0],
      paper: c[1].replace(LINK, "").replace(/\s+/g, " ").trim(),
      doiUrl,
      label: c[2],
      publisher: c[3],
      licence: c[4].replace(LINK, "$1"),
      need: c[5],
      credit: c[6],
      status: c[c.length - 1],
    });
  }
  return rows;
}

/** 改一块的「状态」，只动那一行最后一格 */
export function setPermissionStatus(text: string, line: number, status: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const c = cells(lines[line] ?? "");
  if (!c) return text;
  c[c.length - 1] = status.trim();
  lines[line] = `| ${c.join(" | ")} |`;
  return lines.join(eol);
}

export interface DeclarationSection {
  heading: string;
  /** 给人看的中文名 */
  label: string;
  /** 空 = 还没填（文件里写的是「待填」） */
  body: string;
  /** 「待填（…）」括号里的填写提示 */
  hint: string;
}

const LABELS: Record<string, string> = {
  authors: "作者与单位",
  funding: "基金",
  "conflicts of interest": "利益冲突",
  "author contributions (credit)": "作者贡献（CRediT）",
  "ai use declaration": "AI 使用声明",
};

function declarationLabel(heading: string): string {
  const exact = LABELS[heading.toLowerCase()];
  if (exact) return exact;
  const norm = heading.replace(/^\d+\s*[.、)]\s*/, "").trim();
  const lower = norm.toLowerCase();
  if (LABELS[lower]) return LABELS[lower];
  if (/author\s+contributions?|\bcredit\b|作者贡献/.test(lower)) return "作者贡献（CRediT）";
  if (/\bauthors?\b|作者与单位|^作者/.test(lower)) return "作者与单位";
  if (/\bfunding\b|基金/.test(lower)) return "基金";
  if (/conflicts?\s+of\s+interest|competing\s+interests?|利益冲突/.test(lower)) return "利益冲突";
  if (/\bai\b|generative\s+ai|ai\s*使用声明/.test(lower)) return "AI 使用声明";
  return norm || heading;
}

const PENDING = /^待填(?:[（(]([^）)]*)[）)])?\s*$/;
const PENDING_BULLET = /^[-*]\s*(?:\*\*([^*]+)\*\*|([^：:]+))\s*[：:]\s*待填(?:[（(]([^）)]*)[）)])?\s*$/;

function parsePendingBody(body: string): { isPending: boolean; hint: string } {
  const single = PENDING.exec(body);
  if (single) return { isPending: true, hint: single[1] ?? "" };
  const nonEmpty = body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return { isPending: true, hint: "" };
  const hints: string[] = [];
  for (const line of nonEmpty) {
    const m = PENDING_BULLET.exec(line);
    if (!m) return { isPending: false, hint: "" };
    const item = (m[1] ?? m[2] ?? "").trim();
    const extra = (m[3] ?? "").trim();
    hints.push(extra ? `${item}：${extra}` : item);
  }
  return { isPending: true, hint: hints.filter(Boolean).join("；") };
}

/** 投稿声明按「## 小标题」拆节；文件开头的说明不算一节 */
export function parseDeclarations(text: string): DeclarationSection[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: DeclarationSection[] = [];
  let cur: { heading: string; body: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n").trim();
    const pending = parsePendingBody(body);
    out.push({
      heading: cur.heading,
      label: declarationLabel(cur.heading),
      body: pending.isPending ? "" : body,
      hint: pending.hint,
    });
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      cur = { heading: m[1], body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  flush();
  return out;
}

export interface PermissionGroup {
  key: string;
  paper: string;
  doiUrl: string | null;
  publisher: string;
  licence: string;
  need: string;
  rows: PermissionRow[];
  selfDrawn: boolean;
}

export interface PermissionsSummary {
  paperCount: number;
  pending: number;
  applied: number;
  granted: number;
  exempt: number;
  selfDrawn: number;
}

export interface DeclarationsSummary {
  total: number;
  filled: number;
  pending: number;
}

export function groupPermissionsByPaper(rows: readonly PermissionRow[]): PermissionGroup[] {
  const map = new Map<string, PermissionGroup>();
  for (const row of rows) {
    const key = row.doiUrl ?? row.paper;
    const hit = map.get(key);
    if (hit) hit.rows.push(row);
    else {
      const selfDrawn = !row.doiUrl && row.licence === "作者自绘";
      map.set(key, {
        key,
        paper: row.paper,
        doiUrl: row.doiUrl,
        publisher: row.publisher,
        licence: row.licence,
        need: row.need,
        rows: [row],
        selfDrawn,
      });
    }
  }
  return [...map.values()];
}

export function summarizePermissions(text: string): PermissionsSummary {
  const groups = groupPermissionsByPaper(parsePermissionRows(text));
  const paperGroups = groups.filter((g) => !g.selfDrawn);
  const selfDrawn = groups.filter((g) => g.selfDrawn).reduce((sum, g) => sum + g.rows.length, 0);
  const count = (status: string) => paperGroups.filter((g) => g.rows.every((r) => r.status === status)).length;
  return {
    paperCount: paperGroups.length,
    pending: count("待申请"),
    applied: count("已申请"),
    granted: count("已获许可"),
    exempt: count("无需申请"),
    selfDrawn,
  };
}

export function summarizeDeclarations(text: string): DeclarationsSummary {
  const sections = parseDeclarations(text);
  const filled = sections.filter((s) => s.body.trim().length > 0).length;
  return {
    total: sections.length,
    filled,
    pending: Math.max(0, sections.length - filled),
  };
}

/** 按节写回：空的写「待填」（原来有提示的带上提示），其余原样；开头说明与小标题不动 */
export function writeDeclarations(text: string, sections: readonly DeclarationSection[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => /^##\s+/.test(l));
  const preamble = (first < 0 ? lines : lines.slice(0, first)).join("\n").replace(/\s+$/, "");
  const parts = sections.map((s) => {
    const body = s.body.trim() || (s.hint ? `待填（${s.hint}）` : "待填");
    return `## ${s.heading}\n\n${body}`;
  });
  return [preamble, ...parts].join("\n\n").concat("\n").replace(/\n/g, eol);
}
