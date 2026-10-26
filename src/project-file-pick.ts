/**
 * 聊天输入框「＋ → 引用项目文件」弹层的纯逻辑（2026-10-26，ProjectFilePicker）：
 * 列表行的日期写法、搜索结果去掉文件夹、勾选切换。
 */

/** 弹层里一行：最近改过的文件（list_recent_files）或搜索命中（search_files 去掉文件夹） */
export interface PickFile {
  path: string;
  name: string;
  /** 相对项目根，分隔符统一成 / */
  rel: string;
  modified: string | null;
}

/** 行内第二行的时间：今年写「10月25日 1:49」，往年带年份，读不到写空 */
export function fileDateLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = `${d.getMonth() + 1}月${d.getDate()}日`;
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${d.getFullYear()}年${day}`;
}

/** 文件所在的文件夹（相对项目根）；在根下返回空 */
export function folderOf(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at > 0 ? rel.slice(0, at) : "";
}

/** 搜索结果只留文件（引用的是文件，文件夹交给 @ 输入去引用），路径分隔符统一 */
export function filesOnly(
  hits: readonly { path: string; name: string; rel: string; isDir: boolean; modified?: string | null }[],
): PickFile[] {
  return hits
    .filter((h) => !h.isDir)
    .map((h) => ({ path: h.path, name: h.name, rel: h.rel.replace(/\\/g, "/"), modified: h.modified ?? null }));
}

/** 点一行：没勾的勾上（排在最后，加进输入框也按这个顺序），勾过的去掉 */
export function toggleSelected(selected: readonly string[], path: string): string[] {
  return selected.includes(path) ? selected.filter((p) => p !== path) : [...selected, path];
}
