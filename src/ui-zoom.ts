/**
 * 界面缩放（设置 → 外观「界面大小」、⌘= / ⌘-，Windows Ctrl+= / Ctrl+-）的纯逻辑。
 * 整页缩放由 Rust 走 webview 原生 zoom（ui_zoom.rs），不用 CSS zoom——原生缩放会同步改 devicePixelRatio，
 * 终端、PDF 画布按新像素比重画才清楚；CSS zoom 下 xterm 的鼠标坐标会错位。
 * 档位与 Rust `ui_zoom::MIN_ZOOM / MAX_ZOOM` 两端对齐（Rust 只夹范围，档位以这里为准）。
 */

export const UI_ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export const UI_ZOOM_DEFAULT = 1;

/** 存量值 / 外来值归到最近的档；非有限数回落 100% */
export function normalizeUiZoom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return UI_ZOOM_DEFAULT;
  let best: number = UI_ZOOM_STEPS[0];
  for (const s of UI_ZOOM_STEPS) {
    if (Math.abs(s - value) < Math.abs(best - value)) best = s;
  }
  return best;
}

/** 往大 / 往小挪一档；到头不动 */
export function stepUiZoom(current: number, dir: 1 | -1): number {
  const cur = normalizeUiZoom(current);
  const i = UI_ZOOM_STEPS.indexOf(cur as (typeof UI_ZOOM_STEPS)[number]);
  const next = Math.min(UI_ZOOM_STEPS.length - 1, Math.max(0, i + dir));
  return UI_ZOOM_STEPS[next];
}

/**
 * 这次按键是不是界面缩放：mod + = / + 放大，mod + - 缩小（主键盘或小键盘；Shift 可有可无，
 * 美式键盘的「+」就是 Shift+=）。带 Alt 的不算。复位没有快捷键——⌘0 已是「光标移到侧栏」（hotkeys.ts）
 */
export function uiZoomKeyDirection(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  key: string;
  code?: string;
}): 1 | -1 | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd") return 1;
  if (e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract") return -1;
  return null;
}

export function formatUiZoom(zoom: number): string {
  return `${Math.round(normalizeUiZoom(zoom) * 100)}%`;
}
