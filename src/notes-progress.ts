/** 精读进度（文献精读与笔记步）：从 notes/index.json 数已写几篇。
 *  精读按批写、中途提交后接着读，一跑就是几十分钟；流程线上只有「AI 干活」一行，
 *  看不出读到哪了、剩多少、多少篇只能按摘要记——人要等到评审才知道。
 *  口径与 lit-notes 技能一致：reviewStatus = reviewed 才算写完（文件存在不算），
 *  fulltextStatus 区分全文精读与仅摘要。 */

export interface NotesProgress {
  /** index 记录数（与纳入清单 id 一一对应，含待确认） */
  total: number;
  /** reviewStatus = reviewed */
  reviewed: number;
  /** 已写完里按全文精读的 */
  fulltext: number;
  /** 已写完里只按摘要/题录记的 */
  abstractOnly: number;
  /** reviewStatus = blocked */
  blocked: number;
}

function records(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const key of ["records", "items", "papers", "entries", "notes"]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

function field(row: unknown, key: string): string {
  if (!row || typeof row !== "object") return "";
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** 「写完了」的同义写法：技能现行口径是 reviewed，旧轮次的索引写过 done / read / complete
 *  （2026-10-18「综述流程测试」72 篇全是 done，进度行显示「已写 0 / 72」）。 */
const REVIEWED = new Set(["reviewed", "done", "read", "complete", "completed", "已读", "已完成"]);
function isReviewed(row: unknown): boolean {
  return REVIEWED.has(field(row, "reviewStatus"));
}

/** papers/included.json 里人在评审中排除的篇（decision=excluded）的 id。
 *  旧索引可能给它们建过行：进度不算它们，免得「已写 40 / 45」永远写不满。 */
export function excludedIncludedIds(includedText: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(includedText);
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const row of records(parsed) ?? []) {
    const decision = field(row, "decision");
    const id = (row as Record<string, unknown> | null)?.id;
    if ((decision === "excluded" || decision === "exclude") && typeof id === "string") out.add(id);
  }
  return out;
}

/** 解析失败或没有记录返回 null（界面不出这一行，不猜）。 */
export function notesProgress(
  indexText: string,
  excluded: ReadonlySet<string> = new Set(),
): NotesProgress | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(indexText);
  } catch {
    return null;
  }
  const rows = records(parsed)?.filter((row) => {
    const id = (row as Record<string, unknown> | null)?.id;
    return !(typeof id === "string" && excluded.has(id));
  });
  if (!rows || rows.length === 0) return null;
  const out: NotesProgress = { total: rows.length, reviewed: 0, fulltext: 0, abstractOnly: 0, blocked: 0 };
  for (const row of rows) {
    if (field(row, "reviewStatus") === "blocked") out.blocked += 1;
    if (!isReviewed(row)) continue;
    out.reviewed += 1;
    if (field(row, "fulltextStatus") === "fulltext") out.fulltext += 1;
    else out.abstractOnly += 1;
  }
  return out;
}

/** 一行摘要：「已写笔记 42 / 199 篇 · 全文 30 · 仅摘要 12 · 卡住 3」。没写的分项不出。 */
export function notesProgressLine(p: NotesProgress): string {
  const parts = [`已写笔记 ${p.reviewed} / ${p.total} 篇`];
  if (p.fulltext > 0) parts.push(`全文 ${p.fulltext}`);
  if (p.abstractOnly > 0) parts.push(`仅摘要 ${p.abstractOnly}`);
  if (p.blocked > 0) parts.push(`卡住 ${p.blocked}`);
  return parts.join(" · ");
}

export interface SpotCheckPick {
  /** index 里的 notePath（相对工作区/项目根，或绝对路径） */
  notePath: string;
  fulltext: boolean;
  /** included.json 的 id（阅读区拿它找题名与摘要；仅摘要的篇拿摘要当原文对照） */
  id: string | null;
}

/** 抽查 3 篇的候选：全文精读与仅摘要各至少 1 篇（有的话），其余从已写完的里补齐。
 *  取位确定（各组中间那篇，再从整表尾部补）——每次打开同样三篇，刷新不换人，
 *  也不会总挑最前面那几篇（AI 分批写，开头几篇最认真）。 */
export function spotCheckPicks(indexText: string, count = 3): SpotCheckPick[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(indexText);
  } catch {
    return [];
  }
  const rows = (records(parsed) ?? [])
    .filter((row) => isReviewed(row))
    .map((row) => {
      const r = row as Record<string, unknown>;
      const raw = r.notePath;
      return {
        notePath: typeof raw === "string" ? raw.trim() : "",
        fulltext: field(row, "fulltextStatus") === "fulltext",
        id: typeof r.id === "string" && r.id.trim() ? r.id.trim() : null,
      };
    })
    .filter((row) => row.notePath !== "");
  const picks: SpotCheckPick[] = [];
  const take = (row: SpotCheckPick | undefined) => {
    if (row && picks.length < count && !picks.some((p) => p.notePath === row.notePath)) picks.push(row);
  };
  const full = rows.filter((row) => row.fulltext);
  const brief = rows.filter((row) => !row.fulltext);
  take(full[Math.floor(full.length / 2)]);
  take(brief[Math.floor(brief.length / 2)]);
  for (let i = rows.length - 1; i >= 0 && picks.length < count; i -= 1) take(rows[i]);
  return picks;
}

/** 检索步「AI 干活」行下的篇数（papers/included.json）：纳入 / 待确认 / 已有全文 / 缺全文。
 *  数字由 Mesa 从台账数，不靠 AI 在报告里自述——用户担心 AI 选择性下载，缺多少要摆在明处
 *  （2026-11-05 综述回路设计稿 §12）。全文按 pdf 字段认（lit_records.py write 认出项目里的 PDF 后写）。 */
export interface SearchProgress {
  included: number;
  pending: number;
  withPdf: number;
  /** 纳入里标成综述（kind=review）的；没人标类型时 0（行里不出） */
  reviews?: number;
}

export function searchProgress(includedText: string): SearchProgress | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(includedText);
  } catch {
    return null;
  }
  const rows = records(parsed);
  if (!rows || rows.length === 0) return null;
  const out: SearchProgress = { included: 0, pending: 0, withPdf: 0 };
  for (const row of rows) {
    const decision = field(row, "decision");
    if (decision === "pending") out.pending += 1;
    if (decision !== "included" && decision !== "include") continue;
    out.included += 1;
    const pdf = (row as Record<string, unknown>).pdf;
    if (typeof pdf === "string" && pdf.trim()) out.withPdf += 1;
    if (field(row, "kind") === "review") out.reviews = (out.reviews ?? 0) + 1;
  }
  return out.included + out.pending > 0 ? out : null;
}

/** 「纳入 40 篇 · 待确认 3 · 已有全文 31 · 缺全文 9」。没有的分项不出。 */
export function searchProgressLine(p: SearchProgress): string {
  const parts = [`纳入 ${p.included} 篇${p.reviews ? `（综述 ${p.reviews}）` : ""}`];
  if (p.pending > 0) parts.push(`待确认 ${p.pending}`);
  if (p.withPdf > 0) parts.push(`已有全文 ${p.withPdf}`);
  if (p.included - p.withPdf > 0) parts.push(`缺全文 ${p.included - p.withPdf}`);
  return parts.join(" · ");
}

/** 大纲 outline.md 的用图计划：初稿要拼几张图（「拼 图N」按编号去重）、几处只引原图（「仅引用 [@键] Fig」）、
 *  几张对照表（表计划「表 N（」按编号去重）。技能样例里的「凑不成则仅引用」是备选说明，不算一处。都没有返回 null。 */
export interface FigurePlan {
  composites: number;
  citeOnly: number;
  tables: number;
}

export function figurePlan(outlineText: string): FigurePlan | null {
  const ids = new Set<string>();
  for (const m of outlineText.matchAll(/拼\s*图\s*(\d+)/g)) ids.add(m[1]);
  let citeOnly = 0;
  for (const m of outlineText.matchAll(/(凑不成则)?仅引用\s*\[@[^\]]+\]\s*Fig/g)) {
    if (!m[1]) citeOnly += 1;
  }
  const tables = new Set<string>();
  for (const m of outlineText.matchAll(/(?:^|[^附])表\s*(\d+)\s*（/gm)) tables.add(m[1]);
  return ids.size + citeOnly + tables.size > 0 ? { composites: ids.size, citeOnly, tables: tables.size } : null;
}

export function figurePlanLine(p: FigurePlan): string {
  const parts: string[] = [];
  if (p.composites > 0) parts.push(`初稿要拼 ${p.composites} 张图`);
  if (p.citeOnly > 0) parts.push(`直接引原图 ${p.citeOnly} 处`);
  if (p.tables > 0) parts.push(`对照表 ${p.tables} 张`);
  return `用图计划：${parts.join(" · ")}`;
}

/** 速读表 notes/skim.md 有几行（去掉表头与分隔行）。综述精读第一轮研究论文只速读（2026-11-05 用户拍板），
 *  「已写笔记」不数它们，单给一行「速读 N 篇」。没有表返回 null。 */
export function skimRowCount(text: string): number | null {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .filter((l) => !/^\|(\s*:?-{2,}:?\s*\|)+$/.test(l));
  return rows.length > 0 ? rows.length - 1 : null;
}

/** 大纲 outline.md 的定框架与覆盖检查（综述回路三期）：「## 定框架记录」表里第 1–6 问有几问填了人的选择，
 *  「## 覆盖检查」表里还有几节判断是「薄」（「薄·不补」算处理过）。两节都没有返回 null。 */
export interface OutlineProgress {
  answered: number | null;
  thin: number | null;
}

/** 取 `## 标题` 到下一个 `## ` 之间的表格行（去掉表头与分隔行），每行切成格子 */
export function sectionTableRows(text: string, heading: string): string[][] | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim().startsWith(heading));
  if (start < 0) return null;
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##?\s/.test(line)) break;
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
    rows.push(cells);
  }
  // 第一行是表头
  return rows.slice(1);
}

export function outlineProgress(text: string): OutlineProgress | null {
  const framed = sectionTableRows(text, "定框架记录");
  const coverage = sectionTableRows(text, "覆盖检查");
  if (!framed && !coverage) return null;
  let answered: number | null = null;
  if (framed) {
    const done = new Set<string>();
    for (const row of framed) {
      const q = (row[0] ?? "").replace(/[^\d①②③④⑤⑥]/g, "");
      const n = "①②③④⑤⑥".indexOf(q) >= 0 ? String("①②③④⑤⑥".indexOf(q) + 1) : q;
      if (/^[1-6]$/.test(n) && (row[2] ?? "").trim() && !/^(待|—|-)$/.test((row[2] ?? "").trim())) done.add(n);
    }
    answered = done.size;
  }
  const thin = coverage ? coverage.filter((row) => /^薄/.test(row[4] ?? "") && !/不补/.test(row[4] ?? "")).length : null;
  return { answered, thin };
}

export function outlineProgressParts(p: OutlineProgress): string[] {
  const parts: string[] = [];
  if (p.answered !== null) parts.push(`定框架 ${p.answered}/6 问`);
  if (p.thin !== null) parts.push(p.thin > 0 ? `薄 ${p.thin} 节待补料` : "覆盖检查没有薄节");
  return parts;
}
