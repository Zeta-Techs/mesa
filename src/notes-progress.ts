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
