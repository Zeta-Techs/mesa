import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * macOS Overlay 标题栏左边距：窗口态给红绿灯让 78px；
 * 全屏时系统把三个按钮收起，让位取消，否则左边空一块。
 */

export const MAC_TRAFFIC_PAD = "pl-[78px]";

export function macOverlayPadClass(
  isMac: boolean,
  fullscreen: boolean,
  idlePad: string,
): string {
  if (!isMac || fullscreen) return idlePad;
  return MAC_TRAFFIC_PAD;
}

/** 与 Rust mac_fullscreen.rs FULLSCREEN_WILL_CHANGE_EVENT 同名 */
export const FULLSCREEN_WILL_CHANGE_EVENT = "window:fullscreen-will-change";

/** 过渡标记挂多久：盖住系统全屏动画（约 0.5–0.7s），过后撤掉，免得换主题、调透明度时壳也慢慢变 */
export const FULLSCREEN_ANIM_HOLD_MS = 900;

/** 原生报了「将进 / 将出」之后，等多久不再信它而回到查询结果：进全屏失败（被系统拒）时不卡在错的状态 */
export const FULLSCREEN_TARGET_TIMEOUT_MS = 2000;

/**
 * onResized 查询结果与原生预告冲突时听谁的：预告的目标还没被查询追上（退全屏时 tao 要等缩回动画
 * 放完才翻状态），就继续用预告值；追上了或超时了，回到查询值。
 */
export function resolveFullscreen(
  queried: boolean,
  target: boolean | null,
  targetAgeMs: number,
): { fullscreen: boolean; keepTarget: boolean } {
  if (target === null) return { fullscreen: queried, keepTarget: false };
  if (queried === target || targetAgeMs >= FULLSCREEN_TARGET_TIMEOUT_MS) {
    return { fullscreen: queried, keepTarget: false };
  }
  return { fullscreen: target, keepTarget: true };
}

export interface MacFullscreenState {
  fullscreen: boolean;
  /** 刚开始进 / 出全屏、系统动画还在走：壳的底色这段时间淡变（App.css data-fullscreen-anim）。
      红绿灯让位不跟着动，进出都一步到位 */
  animating: boolean;
}

export function useMacFullscreenState(isMac: boolean): MacFullscreenState {
  const [state, setState] = useState<MacFullscreenState>({
    fullscreen: false,
    animating: false,
  });
  useEffect(() => {
    if (!isMac) return;
    const win = getCurrentWindow();
    let disposed = false;
    let target: boolean | null = null;
    let targetAt = 0;
    let animTimer: ReturnType<typeof setTimeout> | undefined;
    const unlisteners: Array<() => void> = [];

    const sync = () => {
      void win
        .isFullscreen()
        .then((queried) => {
          if (disposed) return;
          const r = resolveFullscreen(queried, target, Date.now() - targetAt);
          if (!r.keepTarget) target = null;
          setState((s) =>
            s.fullscreen === r.fullscreen ? s : { ...s, fullscreen: r.fullscreen },
          );
        })
        .catch(() => {});
    };
    sync();

    void win
      .onResized(sync)
      .then((u) => (disposed ? u() : unlisteners.push(u)))
      .catch(() => {});
    // 原生在系统动画开头预告：先翻状态并开过渡，onResized 的查询结果之后再对账
    void listen<boolean>(FULLSCREEN_WILL_CHANGE_EVENT, (e) => {
      target = e.payload;
      targetAt = Date.now();
      setState({ fullscreen: e.payload, animating: true });
      clearTimeout(animTimer);
      animTimer = setTimeout(() => {
        setState((s) => ({ ...s, animating: false }));
        // 进全屏失败等情形：预告没兑现，过渡结束后按真实状态收口
        sync();
      }, FULLSCREEN_ANIM_HOLD_MS);
    })
      .then((u) => (disposed ? u() : unlisteners.push(u)))
      .catch(() => {});

    return () => {
      disposed = true;
      clearTimeout(animTimer);
      unlisteners.forEach((u) => u());
    };
  }, [isMac]);
  return state;
}

export function useMacFullscreen(isMac: boolean): boolean {
  return useMacFullscreenState(isMac).fullscreen;
}
