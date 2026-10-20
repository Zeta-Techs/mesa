/**
 * 纯路径工具（无依赖，可直接被 node --test 单测）。
 * 跨平台注意：Windows 下各后端接口返回的路径分隔符不统一——
 * list_dir 经 read_dir 得到全 `\`，git_status_map 用 Path::join 拼出混合分隔符
 * （cwd 里的 `\` + porcelain 相对路径的 `/`），前端匹配前必须先归一。
 */

/** 统一路径分隔符为 /（只做等价规范化，不改变路径语义） */
export function normSep(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 剥掉 Windows `canonicalize` 带出的 `\\?\` verbatim 前缀（`\\?\UNC\srv\s` → `\\srv\s`）。
 *  后端 canonical_key 现在落库前已经剥过，但**存量库里仍有 verbatim 记录**，
 *  显示与比较前都要过一道，否则界面上会直接出现 `\\?\C:\Users\...`。
 *  非 Windows 路径是恒等变换。 */
export function stripVerbatim(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

/** 跨来源路径比较键：剥 verbatim 前缀 + 分隔符统一 + 去尾分隔符，Windows 下折叠大小写。
 *  只用于比较，不要拿它显示或回写（有损）。
 *  后端同名口径见 src-tauri/src/paths.rs 的 path_key。 */
export function pathKey(p: string, isWindows = false): string {
  const s = normSep(stripVerbatim(p));
  const trimmed = s.length > 1 ? s.replace(/\/+$/, "") : s;
  return isWindows ? trimmed.toLowerCase() : trimmed;
}

/** 两条路径是否指向同一位置（跨方言） */
export function samePath(a: string, b: string, isWindows = false): boolean {
  return pathKey(a, isWindows) === pathKey(b, isWindows);
}

/** 子路径是否落在根目录内（段边界，含根自身）。比较走 pathKey。 */
export function pathWithin(
  child: string,
  root: string,
  isWindows = false,
): boolean {
  if (!child || !root) return false;
  const c = pathKey(child, isWindows);
  const r = pathKey(root, isWindows);
  if (!c || !r) return false;
  return c === r || c.startsWith(`${r}/`);
}

/** git 装饰表键归一：后端混合分隔符的键统一成 /，与归一后的 entry.path 同口径匹配 */
export function normalizeStatusKeys(
  map: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) out[normSep(key)] = value;
  return out;
}

/** 目录内是否有变更文件（文件夹装饰点）；gitMap 键须已用 normalizeStatusKeys 归一 */
export function hasChangedInside(
  gitMap: Record<string, string>,
  dirPath: string,
): boolean {
  const prefix = `${normSep(dirPath)}/`;
  return Object.keys(gitMap).some((p) => p.startsWith(prefix));
}

/** 上一级目录；已到文件系统根（或无法再上）时返回 null */
export function parentDir(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return null; // 形如 "~" 或 "C:"，无法再上
  if (idx === 0) return trimmed[0] === "/" ? "/" : null;
  // Windows 盘符：C:\foo（或 C:/foo）的上一级是盘符根 C:\（保留原分隔符）
  if (idx === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.slice(0, idx);
}

/** 家目录前缀折成 ~（显示用）。两侧先剥 verbatim；Windows 比较折叠大小写。 */
export function abbrevHome(
  path: string,
  home: string,
  isWindows = false,
): string {
  if (!home) return path;
  const shown = stripVerbatim(path);
  const h = stripVerbatim(home).replace(/[\\/]+$/, "");
  const fold = (s: string) => (isWindows ? s.toLowerCase() : s);
  if (fold(shown) === fold(h)) return "~";
  const head = fold(shown).slice(0, h.length);
  const next = shown[h.length];
  return head === fold(h) && (next === "/" || next === "\\")
    ? `~${shown.slice(h.length).replace(/\\/g, "/")}`
    : shown;
}

/** 「在系统文件管理器中显示」的平台叫法（右键菜单/图标钮共用；平台显式传参，禁模块内读平台） */
export function revealFolderLabel(isMac: boolean, isWindows: boolean): string {
  if (isMac) return "在访达中显示";
  if (isWindows) return "在资源管理器中显示";
  return "在文件管理器中显示";
}

/** filePath 落在 root 内时给相对路径（正斜杠，写进给 agent 的指令），否则原样（剥 verbatim）。
 *  跨方言判定走 pathWithin：Windows 上后端给 `\` 分隔，旧写法拼 `${root}/` 永不命中。 */
export function relativeUnder(
  filePath: string,
  root: string,
  isWindows: boolean,
): string {
  const shown = stripVerbatim(filePath);
  if (!root || !pathWithin(filePath, root, isWindows)) return shown;
  const c = normSep(shown);
  const r = normSep(stripVerbatim(root)).replace(/\/+$/, "");
  return c.length > r.length + 1 ? c.slice(r.length + 1) : shown;
}
