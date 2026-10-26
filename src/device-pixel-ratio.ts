import { useSyncExternalStore } from "react";

/**
 * 屏幕像素比变化的统一监听：窗口拖到另一块屏、界面缩放（⌘= / ⌘-）都会改它，
 * 画布类（终端单元格宽、PDF 位图）要按新值重算，否则发虚。
 * 只听 `(resolution: Xdppx)` 不够：真 WKWebView 实测（2026-10-26）pageZoom 1→1.25 后
 * devicePixelRatio 2→2.5，但 resolution 媒体查询仍按 2dppx 匹配、不发 change；
 * 那一下只有 window resize。所以两路都听，值真变了才回调。
 */

export interface DprWindow {
  readonly devicePixelRatio: number;
  matchMedia(query: string): Pick<MediaQueryList, "addEventListener" | "removeEventListener">;
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

export function watchDevicePixelRatio(
  onChange: (dpr: number) => void,
  win: DprWindow = window,
): () => void {
  let last = win.devicePixelRatio || 1;
  let query = win.matchMedia(`(resolution: ${last}dppx)`);
  const check = () => {
    const now = win.devicePixelRatio || 1;
    if (now === last) return;
    last = now;
    // 媒体查询按旧值建的，换成新值才能接住下一次变化
    query.removeEventListener("change", check);
    query = win.matchMedia(`(resolution: ${now}dppx)`);
    query.addEventListener("change", check);
    onChange(now);
  };
  query.addEventListener("change", check);
  win.addEventListener("resize", check);
  return () => {
    query.removeEventListener("change", check);
    win.removeEventListener("resize", check);
  };
}

// 组件侧共用一份监听：连续阅读里每页一个 PdfPreview，不给每页各挂一套
const subscribers = new Set<() => void>();
let stopShared: (() => void) | null = null;

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  if (!stopShared) stopShared = watchDevicePixelRatio(() => subscribers.forEach((s) => s()));
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && stopShared) {
      stopShared();
      stopShared = null;
    }
  };
}

const snapshot = () => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);

/** 当前像素比；变了组件跟着重渲 */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribe, snapshot, () => 1);
}
