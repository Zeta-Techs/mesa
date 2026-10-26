import { useEffect, useRef } from "react";

/**
 * 定时刷新的统一口径（2026-10-26 用户「操作流畅性全部都做」）：
 * - 窗口隐藏（最小化、关到托盘、⌘H）时停，回到前台立刻补拉一次再接着定时；
 * - 上一次还没回来就不叠下一次（慢的后端命令不会越排越多）；
 * - `alive()` 在依赖变化 / 卸载后变 false，异步回来的结果据此丢弃。
 * 只管定时那一下；挂载 / 依赖变化时的首拉仍由调用方自己做（各处首拉时机不一样）。
 * 驱动通知或回合判定的计时器（终端页认会话、PTY 静默）不走这里：窗口藏着时也得照常判断。
 */
export type PollTick = (alive: () => boolean) => unknown;

export type PollerEnv = {
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  hidden: () => boolean;
};

export function createPoller(tick: PollTick, intervalMs: number, env: PollerEnv) {
  let disposed = false;
  let inFlight = false;
  let timer: number | null = null;
  const alive = () => !disposed;
  const run = () => {
    if (disposed || inFlight || env.hidden()) return;
    let result: unknown;
    try {
      result = tick(alive);
    } catch {
      return;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      inFlight = true;
      const done = () => {
        inFlight = false;
      };
      (result as PromiseLike<unknown>).then(done, done);
    }
  };
  const start = () => {
    if (timer == null && !disposed) timer = env.setInterval(run, intervalMs);
  };
  const stop = () => {
    if (timer == null) return;
    env.clearInterval(timer);
    timer = null;
  };
  if (!env.hidden()) start();
  return {
    onVisibilityChange() {
      if (env.hidden()) {
        stop();
      } else {
        run();
        start();
      }
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}

/**
 * 命令式版本：在已有的 useEffect 里起定时（首拉、取消标记由那段 effect 自己管），返回停止函数。
 * 定时依赖好几个条件、和别的订阅写在一起的地方用它，比拆成 usePolling 少改动。
 */
export function pollEvery(tick: PollTick, intervalMs: number): () => void {
  const poller = createPoller(tick, intervalMs, {
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id),
    hidden: () => document.visibilityState === "hidden",
  });
  const onVisibility = () => poller.onVisibilityChange();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    poller.dispose();
  };
}

/** `intervalMs` 为 null = 这会儿不轮询（页面没显示、面板收着等） */
export function usePolling(tick: PollTick, intervalMs: number | null): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    if (intervalMs == null) return;
    return pollEvery((alive) => tickRef.current(alive), intervalMs);
  }, [intervalMs]);
}
