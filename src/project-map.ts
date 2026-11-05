/**
 * 项目地图（2026-11-05，docs/design-assistant-intake.md §3.2）：把后端 `project_file_map` 列出的文件拼成给项目助手看的一段文字。
 * 只有路径、大小、修改时间，不读内容；文件多的目录折成一行摘要（几个文件、什么类型、最近改在哪天）再列最新的几个；
 * 另列「最近改动」，上次问以来新出现或改过的标「新」。纯逻辑，配 tests/project-map.test.ts。
 */

export interface MapEntry {
  path: string;
  size: number;
  modifiedMs: number;
}

/** 一个目录里超过这么多文件就折成摘要 */
export const MAP_FOLD_OVER = 8;
/** 折起来的目录仍列出最新的几个 */
export const MAP_FOLD_SHOW = 3;
export const MAP_RECENT = 15;
export const MAP_MAX_CHARS = 6000;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 本机日期 YYYY-MM-DD；读不到修改时间写「?」 */
function day(ms: number): string {
  if (!ms) return "?";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extOf(path: string): string {
  const name = nameOf(path);
  const i = name.lastIndexOf(".");
  return i <= 0 ? "无后缀" : name.slice(i + 1).toLowerCase();
}

function fileLine(e: MapEntry, sinceMs: number | null, indent: string, full = false): string {
  const fresh = sinceMs !== null && e.modifiedMs > sinceMs ? " · 新" : "";
  return `${indent}${full ? e.path : nameOf(e.path)}  ${formatSize(e.size)} · ${day(e.modifiedMs)}${fresh}`;
}

/**
 * 拼地图。`sinceMs` = 上次问项目助手的时间（没有为 null，不标「新」）。
 * 超过字数上限从后面截掉，并写明截掉了。
 */
export function renderProjectMap(
  entries: readonly MapEntry[],
  opts: { truncated?: boolean; sinceMs?: number | null; maxChars?: number } = {},
): string {
  const since = opts.sinceMs ?? null;
  const max = opts.maxChars ?? MAP_MAX_CHARS;
  if (entries.length === 0) return "项目里还没有文件（隐藏文件与依赖目录不列）。";
  const byDir = new Map<string, MapEntry[]>();
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const d = dirOf(e.path);
    const list = byDir.get(d);
    if (list) list.push(e);
    else byDir.set(d, [e]);
  }
  const total = entries.reduce((s, e) => s + e.size, 0);
  const lines: string[] = [
    `共 ${entries.length} 个文件、${formatSize(total)}${opts.truncated ? "（太多没列完）" : ""}；隐藏文件与依赖、缓存目录不列。`,
  ];
  const fresh = since === null ? [] : entries.filter((e) => e.modifiedMs > since);
  const recent = [...entries].sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, MAP_RECENT);
  if (recent.length) {
    lines.push(
      "",
      since === null ? "最近改动：" : `最近改动（上次问我以来新出现或改过 ${fresh.length} 个，标「新」）：`,
      ...recent.map((e) => fileLine(e, since, "- ", true)),
    );
  }
  lines.push("", "按目录：");
  for (const [d, list] of byDir) {
    const label = d ? `${d}/` : "（项目根）";
    if (list.length <= MAP_FOLD_OVER) {
      lines.push(label, ...list.map((e) => fileLine(e, since, "  ")));
      continue;
    }
    const kinds = new Map<string, number>();
    for (const e of list) kinds.set(extOf(e.path), (kinds.get(extOf(e.path)) ?? 0) + 1);
    const kindText = [...kinds]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, n]) => `${k}×${n}`)
      .join("、");
    const newest = [...list].sort((a, b) => b.modifiedMs - a.modifiedMs);
    const size = list.reduce((s, e) => s + e.size, 0);
    lines.push(
      `${label}（${list.length} 个文件、${formatSize(size)}；${kindText}；最近改在 ${day(newest[0].modifiedMs)}；下面只列最新 ${MAP_FOLD_SHOW} 个）`,
      ...newest.slice(0, MAP_FOLD_SHOW).map((e) => fileLine(e, since, "  ")),
    );
  }
  const text = lines.join("\n");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf("\n"))}\n……（地图太长，后面的目录没写出来；需要时只读查看去列）`;
}
