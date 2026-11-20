/**
 * 文件页左侧文件树的宽度（2026-11-20 用户：右边预览固定、左边太窄，想宽屏看文件；tests/file-tree-width.test.ts）。
 * 只在分栏时（宽屏且开着预览）用：拖分隔条改、双击回默认，记本机（localStorage，存 px）。没开预览时文件树铺满整行，不看它。
 * 下限 16rem，再窄文件名和日期挤不下；上限给预览至少留 24rem。
 */

export const FILE_TREE_WIDTH_KEY = "ccode.fileTreeWidth";
export const FILE_TREE_DEFAULT_REM = 22;
export const FILE_TREE_MIN_REM = 16;
export const FILE_TREE_PREVIEW_MIN_REM = 24;

/** hostWidth = 文件页整行宽（文件树 + 预览） */
export function clampFileTreeWidth(px: number, rem: number, hostWidth = Number.POSITIVE_INFINITY): number {
  const min = FILE_TREE_MIN_REM * rem;
  const max = Math.max(min, hostWidth - FILE_TREE_PREVIEW_MIN_REM * rem);
  return Math.round(Math.min(max, Math.max(min, Number.isFinite(px) ? px : FILE_TREE_DEFAULT_REM * rem)));
}

/** 存档读回来：坏值 / 没存过 = 默认宽；整行多宽此时不知道，渲染时再由 CSS 给预览留地方 */
export function parseFileTreeWidth(raw: string | null, rem: number): number {
  const v = Number(raw);
  return raw && Number.isFinite(v) && v > 0 ? clampFileTreeWidth(v, rem) : FILE_TREE_DEFAULT_REM * rem;
}
