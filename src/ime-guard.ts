//! 输入法组词期间的 Enter / Escape 不得误触发提交或关闭（tests/ime-guard.test.ts）。
//!
//! WKWebView / Safari：确认候选的 Enter 与取消候选的 Escape 往往在 compositionend
//! 之后才到 keydown，此时 isComposing 已经是 false，只看 isComposing 会误触发发送或关窗。
//! Chromium 组词中的 keydown 常用 keyCode 229（IME）。两道都拦。

export function imeBlocksEnter(input: {
  isComposing: boolean;
  /** KeyboardEvent.keyCode；组词中常见 229 */
  keyCode: number;
  /** compositionstart 起、到 compositionend 后一帧仍为 true */
  composingLock: boolean;
}): boolean {
  return input.isComposing || input.keyCode === 229 || input.composingLock;
}

export const imeBlocksKey = imeBlocksEnter;

export interface KeyLikeEvent {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
}

export interface ImeLock {
  readonly locked: boolean;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  blocksKey: (event: KeyLikeEvent) => boolean;
  dispose: () => void;
}

function defaultScheduleUnlock(unlock: () => void): () => void {
  if (
    typeof globalThis.requestAnimationFrame === "function" &&
    typeof globalThis.cancelAnimationFrame === "function"
  ) {
    const id = globalThis.requestAnimationFrame(unlock);
    return () => globalThis.cancelAnimationFrame(id);
  }
  const timer = setTimeout(unlock, 0);
  return () => clearTimeout(timer);
}

/** 维护 compositionstart → compositionend 后一帧的 IME 锁，供单行输入与捕获层 Esc 共用 */
export function createImeLock(
  scheduleUnlock: (unlock: () => void) => () => void = defaultScheduleUnlock,
): ImeLock {
  let locked = false;
  let cancelUnlock: (() => void) | null = null;
  const clearPending = () => {
    if (!cancelUnlock) return;
    cancelUnlock();
    cancelUnlock = null;
  };
  return {
    get locked() {
      return locked;
    },
    onCompositionStart() {
      clearPending();
      locked = true;
    },
    onCompositionEnd() {
      clearPending();
      locked = true;
      cancelUnlock = scheduleUnlock(() => {
        cancelUnlock = null;
        locked = false;
      });
    },
    blocksKey(event: KeyLikeEvent) {
      const isComposing = Boolean(event.nativeEvent?.isComposing ?? event.isComposing);
      const keyCode = event.nativeEvent?.keyCode ?? event.keyCode ?? 0;
      return imeBlocksEnter({ isComposing, keyCode, composingLock: locked });
    },
    dispose() {
      clearPending();
      locked = false;
    },
  };
}
