/**
 * 无流程科研文献/笔记列表：展示名、编号、状态与过滤纯逻辑。
 */

import { normalizeTitle } from "./lit-watch.ts";

const DISPLAY_EXT = /\.(pdf|md|markdown|mdx|qmd|ris|bib|txt|csv|tsv|docx|xlsx)$/i;

/** 行上隐去类型后缀（左侧类型图标已按图形 + 识别色区分 PDF / 笔记），完整文件名留给 title */
export function displayFileTitle(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const stripped = base.replace(DISPLAY_EXT, "");
  return stripped.trim() ? stripped : base;
}

/** 笔记 `01-标题.md` / `100_标题`：前缀数字单独成列 */
export function splitNoteSeq(name: string): { seq: string | null; title: string } {
  const title = displayFileTitle(name);
  const m = title.match(/^(\d+)[-_.\s]+(.+)$/u);
  if (!m) return { seq: null, title };
  return { seq: m[1], title: m[2] };
}

export function compareNotesBySeq(a: string, b: string): number {
  const aa = splitNoteSeq(a);
  const bb = splitNoteSeq(b);
  const an = aa.seq ? Number(aa.seq) : Number.POSITIVE_INFINITY;
  const bn = bb.seq ? Number(bb.seq) : Number.POSITIVE_INFINITY;
  if (an !== bn) return an - bn;
  return aa.title.localeCompare(bb.title, "zh");
}

const SKIP_CONTINUE_NOTES = new Set(["index", "glossary", "inbox"]);

/** 精读步「继续精读笔记」打开哪一篇：按序号，跳过索引/生词本/收件箱。 */
export function pickContinueNotePath(names: readonly string[]): string | null {
  const notes = names.filter((name) => {
    const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
    if (!/\.md$/i.test(base)) return false;
    const stem = base.replace(/\.md$/i, "").toLowerCase();
    return !SKIP_CONTINUE_NOTES.has(stem);
  });
  if (!notes.length) return null;
  return [...notes].sort(compareNotesBySeq)[0] ?? null;
}

export type LitReadState = "read" | "queued" | "accumulated" | "unread";

/** 双台账口径：已有笔记 > 已在精读清单（流程正典 included.md）> 已积累（积累清单 reading-list.md）> 未读 */
export function litReadState(
  hasNote: boolean,
  accumulated: boolean,
  included: boolean,
): LitReadState {
  if (hasNote) return "read";
  if (included) return "queued";
  if (accumulated) return "accumulated";
  return "unread";
}

export const LIT_STATUS_FILTERS: {
  id: "all" | LitReadState;
  label: string;
}[] = [
  { id: "all", label: "全部" },
  { id: "read", label: "已读" },
  { id: "queued", label: "已在清单" },
  { id: "accumulated", label: "已积累" },
  { id: "unread", label: "未读" },
];

/** 双台账文件行的白话显示名：积累账与流程正典一眼可分，其余走文件名 */
export function ledgerFileDisplayName(path: string): string | null {
  const norm = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm === "papers/reading-list.md") return "积累清单（我的精读候选）";
  if (norm === "papers/included.md") return "精读清单（流程）";
  return null;
}

/** 文献 PDF 是否已进积累清单（papers/reading-list.md）：文件名 stem 与条目标题规范化互相包含，
 *  与精读清单（lit-watch 的 paperIsIncluded）同一匹配口径 */
export function paperIsAccumulated(
  pdfPath: string,
  entries: readonly { title: string }[],
): boolean {
  const name = pdfPath.replace(/\\/g, "/").split("/").pop() ?? pdfPath;
  const stem = name.replace(/\.[^.]*$/, "");
  const n = normalizeTitle(stem);
  if (!n) return false;
  return entries.some((e) => {
    const t = normalizeTitle(e.title);
    if (!t) return false;
    if (n === t) return true;
    if (!(n.includes(t) || t.includes(n))) return false;
    const shorter = n.length < t.length ? n : t;
    return shorter.length >= 12;
  });
}

export function litRowMatches(
  title: string,
  path: string,
  state: LitReadState,
  query: string,
  filter: "all" | LitReadState,
): boolean {
  if (filter !== "all" && state !== filter) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const n = title.toLowerCase();
  const p = path.replace(/\\/g, "/").toLowerCase();
  return n.includes(q) || p.includes(q);
}

export type NoteSort = "seq" | "recent";

export function compareNotes(
  a: { name: string; modified?: string | null },
  b: { name: string; modified?: string | null },
  sort: NoteSort,
): number {
  if (sort === "recent") {
    const ta = Date.parse(a.modified || "") || 0;
    const tb = Date.parse(b.modified || "") || 0;
    if (tb !== ta) return tb - ta;
  }
  return compareNotesBySeq(a.name, b.name);
}

/** 未搜索时文献/笔记/数据先露这么多，底部「显示全部」 */
export const LIST_PREVIEW_CAP = 10;

/** 预览条按钮文案：展开后改「收起」，单位默认「篇」（文献/笔记），会话/雷达用「条」 */
export function listPreviewToggleLabel(
  revealed: boolean,
  hidden: number,
  unit = "篇",
): string {
  return revealed ? "收起" : `显示全部（还有 ${hidden} ${unit}）`;
}
