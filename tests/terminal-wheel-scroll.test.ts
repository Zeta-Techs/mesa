import assert from "node:assert/strict";
import test from "node:test";
import {
  installTrackpadWheelCoalescing,
  shouldCoalesceTrackpadWheel,
  type WheelContext,
  type WheelLike,
} from "../src/terminal-wheel-scroll.ts";

const base: WheelLike = {
  deltaX: 0,
  deltaY: -8,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
};
const normalCtx: WheelContext = {
  bufferType: "normal",
  mouseTrackingMode: "none",
};

test("普通缓冲 + 无鼠标上报 + 无修饰键 + 像素模式：接管合帧", () => {
  assert.equal(shouldCoalesceTrackpadWheel(base, normalCtx), true);
});

test("备用屏幕（全屏 TUI）不接管——wheel 要变方向键给 PTY", () => {
  assert.equal(
    shouldCoalesceTrackpadWheel(base, { ...normalCtx, bufferType: "alternate" }),
    false,
  );
});

test("TUI 开了鼠标上报不接管（wheel 属于 TUI）", () => {
  for (const mode of ["x10", "vt200", "drag", "any"]) {
    assert.equal(
      shouldCoalesceTrackpadWheel(base, {
        ...normalCtx,
        mouseTrackingMode: mode,
      }),
      false,
      mode,
    );
  }
});

test("带修饰键一律不接管（缩放/快滚/横向各归 xterm）", () => {
  for (const key of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) {
    assert.equal(
      shouldCoalesceTrackpadWheel({ ...base, [key]: true }, normalCtx),
      false,
      key,
    );
  }
});

test("行/页模式（物理滚轮）、横向分量、零增量不接管", () => {
  assert.equal(shouldCoalesceTrackpadWheel({ ...base, deltaMode: 1 }, normalCtx), false);
  assert.equal(shouldCoalesceTrackpadWheel({ ...base, deltaMode: 2 }, normalCtx), false);
  assert.equal(shouldCoalesceTrackpadWheel({ ...base, deltaX: 4 }, normalCtx), false);
  assert.equal(shouldCoalesceTrackpadWheel({ ...base, deltaY: 0 }, normalCtx), false);
});

/** --- 合帧管道：假 DOM（祖先捕获监听 + 后代滚动监听）验证「每帧一次写入」 --- */

type Synthetic = { type: string; init: { deltaY: number; wheelDeltaY?: number }; prevented: boolean };

function makeHarness() {
  const frames: { id: number; cb: () => void; cancelled: boolean }[] = [];
  let nextId = 1;
  (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame =
    (cb: () => void) => {
      const id = nextId++;
      frames.push({ id, cb, cancelled: false });
      return id;
    };
  (globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = (
    id: number,
  ) => {
    const item = frames.find((f) => f.id === id);
    if (item) item.cancelled = true;
  };
  class FakeWheelEvent {
    type: string;
    init: { deltaY: number; wheelDeltaY?: number };
    prevented = false;
    constructor(type: string, init: { deltaY: number; wheelDeltaY?: number }) {
      this.type = type;
      this.init = init;
    }
    preventDefault() {
      this.prevented = true;
    }
  }
  (globalThis as unknown as { WheelEvent: unknown }).WheelEvent = FakeWheelEvent;

  type Listener = { fn: (e: never) => void; capture: boolean };
  const listeners: Listener[] = [];
  const host = {
    addEventListener(_t: string, fn: (e: never) => void, opts?: { capture?: boolean }) {
      listeners.push({ fn, capture: Boolean(opts?.capture) });
    },
    removeEventListener(_t: string, fn: (e: never) => void) {
      const i = listeners.findIndex((l) => l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };

  /** 模拟 xterm 挂在后代节点上的滚动监听：收到一枚事件即算一次「滚动写入」 */
  const innerScrolls: number[] = [];
  const inner = {
    dispatchEvent(e: Synthetic) {
      innerScrolls.push(e.init.deltaY);
      // 真实浏览器里合成事件继续冒泡到祖先的捕获监听
      for (const l of [...listeners]) l.fn(e as never);
      return true;
    },
  };

  const external: (WheelLike & {
    target: unknown;
    prevented: boolean;
    stopped: boolean;
  })[] = [];
  const wheel = (deltaY: number) => {
    const e = {
      ...base,
      deltaY,
      target: inner as unknown,
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    };
    external.push(e);
    return e;
  };
  /** 模拟事件到达终端元素（祖先）的捕获监听 */
  const fire = (e: unknown) => {
    for (const l of [...listeners]) l.fn(e as never);
  };
  const flush = () => {
    for (const f of frames.splice(0)) if (!f.cancelled) f.cb();
  };

  return {
    host: host as unknown as HTMLElement,
    inner,
    innerScrolls,
    external,
    wheel,
    fire,
    flush,
    listeners,
    pendingFrames: () => frames.filter((f) => !f.cancelled).length,
  };
}

function hostOf(h: ReturnType<typeof makeHarness>) {
  return {
    element: h.host,
    buffer: { active: { type: "normal" } },
    modes: { mouseTrackingMode: "none" },
  };
}

test("捕获阶段拦截：拦下原事件、不自己滚、同帧只排一次", () => {
  const h = makeHarness();
  const teardown = installTrackpadWheelCoalescing(hostOf(h));

  assert.equal(h.listeners.length, 1);
  assert.equal(h.listeners[0].capture, true, "必须挂捕获阶段，否则滚动已先发生");

  const e1 = h.wheel(-3);
  h.fire(e1);
  assert.equal(e1.prevented, true, "要自己 preventDefault，否则页面跟着滚");
  assert.equal(e1.stopped, true, "要 stopPropagation 挡在 xterm 滚动监听之前");
  assert.deepEqual(h.innerScrolls, [], "原事件不许再触发一次滚动写入");

  const e2 = h.wheel(-4.5);
  h.fire(e2);
  assert.equal(h.innerScrolls.length, 0);
  assert.equal(h.pendingFrames(), 1, "同帧只排一次 rAF");

  h.flush();
  assert.deepEqual(h.innerScrolls, [-7.5], "合成事件带累加增量走 xterm 原路径");
  assert.equal(h.pendingFrames(), 0);

  teardown();
});

test("合成事件显式带反号 wheelDeltaY（Chromium 默认同号会让 xterm 反向滚）", () => {
  const h = makeHarness();
  const seen: Synthetic["init"][] = [];
  h.inner.dispatchEvent = (e: Synthetic) => {
    seen.push(e.init);
    return true;
  };
  const teardown = installTrackpadWheelCoalescing(hostOf(h));
  h.fire(h.wheel(-3));
  h.fire(h.wheel(-4));
  h.flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].deltaY, -7);
  assert.equal(seen[0].wheelDeltaY, 7);
  teardown();
});

test("合成事件不再被自己拦下（防递归）", () => {
  const h = makeHarness();
  const teardown = installTrackpadWheelCoalescing(hostOf(h));
  h.fire(h.wheel(-8));
  h.flush();
  assert.deepEqual(h.innerScrolls, [-8]);
  assert.equal(h.pendingFrames(), 0, "合成事件不得再入队");
  teardown();
});

test("不接管的场景原样放行，不排帧也不拦默认行为", () => {
  const h = makeHarness();
  const host = hostOf(h);
  host.modes.mouseTrackingMode = "vt200";
  const teardown = installTrackpadWheelCoalescing(host);
  const e = h.wheel(-8);
  h.fire(e);
  assert.equal(e.prevented, false);
  assert.equal(e.stopped, false);
  assert.equal(h.pendingFrames(), 0);
  teardown();
});

test("拆除后移除监听器并取消未执行的帧", () => {
  const h = makeHarness();
  const teardown = installTrackpadWheelCoalescing(hostOf(h));
  h.fire(h.wheel(-8));
  assert.equal(h.pendingFrames(), 1);

  teardown();
  assert.equal(h.listeners.length, 0, "拆除要卸载捕获监听");
  h.flush();
  assert.deepEqual(h.innerScrolls, [], "拆除时未执行的合帧必须取消");
});

test("终端元素未挂载时空操作，不抛错", () => {
  const teardown = installTrackpadWheelCoalescing({
    element: undefined,
    buffer: { active: { type: "normal" } },
    modes: { mouseTrackingMode: "none" },
  });
  assert.equal(typeof teardown, "function");
  teardown();
});