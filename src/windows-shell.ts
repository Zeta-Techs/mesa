/**
 * Windows 版 WebView2 的浏览器默认行为收口（纯判定，挂载在 main.tsx）。
 * wry 默认开着 WebView2 的浏览器快捷键与右键菜单，Tauri 2 没有开关：
 * F5 / Ctrl+R 整页刷新会丢未保存的编辑，Ctrl+P 弹打印，Alt+← / 鼠标侧键后退会把单页应用导航走，
 * Ctrl+F 弹浏览器查找条；右键到处是「后退 / 刷新 / 另存为 / 打印」。
 * 只 preventDefault 不 stopPropagation：应用自己的 Ctrl+F（PDF 查找、Monaco）照常收到事件。
 */

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** 该按键是否是要拦下的浏览器快捷键 */
export function isBrowserShortcut(e: KeyLike): boolean {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === "F5" || key === "BrowserBack" || key === "BrowserForward" || key === "BrowserRefresh")
    return true;
  if (e.altKey && !e.ctrlKey && (key === "ArrowLeft" || key === "ArrowRight")) return true;
  if (e.ctrlKey && !e.altKey && (key === "r" || key === "p" || key === "f")) return true;
  return false;
}

/** 鼠标侧键（3 = 后退、4 = 前进）在 Chromium 里会触发页面导航 */
export function isNavigationMouseButton(button: number): boolean {
  return button === 3 || button === 4;
}

/** 右键是否交给 WebView2 默认菜单：应用自己处理过的、可编辑区域、有选中文字（要复制）都放行 */
export function keepNativeContextMenu(opts: {
  defaultPrevented: boolean;
  editable: boolean;
  hasSelection: boolean;
}): boolean {
  return opts.defaultPrevented || opts.editable || opts.hasSelection;
}

/** Windows 11 的 UA-CH platformVersion 主版本 ≥ 13；Windows 10 为 1–10（没有 Mica） */
export function isWindows11PlatformVersion(platformVersion: string): boolean {
  const major = Number.parseInt(platformVersion.split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= 13;
}
