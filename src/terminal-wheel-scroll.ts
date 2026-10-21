/**
 * 触控板滚动合帧（终端滚动手感单一出处，配 docs/conventions/terminal.md）。
 *
 * 问题：xterm 的滚轮路径分两条——「物理滚轮」走平滑动画（内部 MouseWheelClassifier 判定
 * 为 physical 时才 `setScrollPositionSmooth`），触控板被判为非 physical，于是**每来一枚
 * wheel 事件就立刻写一次滚动位置**，每写一次触发一次整屏重绘。macOS 触控板是 60–120Hz
 * 的细粒度小增量（deltaMode=0、非整数、带惯性尾巴），叠加 DOM 渲染器逐行重建的成本就是
 * 「上下滑动一卡一卡」。硬件层面没有可调项能把这条路径变平滑（xterm 没有公开的亚行/像素
 * 滚动 API），能改的是**写入频率**。
 *
 * 做法：把同一动画帧内的多枚触控板事件合成一枚，再原样交回 xterm 自己的像素级滚动逻辑
 * 处理（不自己算行数、不改灵敏度与惯性语义）。收益：每帧最多一次滚动写入与重绘，亚像素
 * 余量由 xterm 原逻辑保留，手感从「事件驱动」变「帧驱动」。
 *
 * 拦截位置（2026-09-21 探针实测修正）：必须挂在**捕获阶段**。xterm 有两个滚轮监听——
 * 真正滚动的那个挂在滚动组件节点（`term.element` 的**后代**）上，元素级那个只管鼠标协议
 * 与备用屏方向键。后代监听先于祖先冒泡监听执行，所以 `attachCustomWheelEventHandler`
 * （元素级）拦不住滚动：事件到那里时滚动已经发生。捕获阶段自上而下，能先一步
 * `preventDefault + stopPropagation` 挡掉整条原路径；合成事件再派发到原事件的深层目标上，
 * 走完 xterm 原路径（`dispatching` 标志保证自己不被二次拦截）。
 *
 * 不接管的情形（任何一条命中即原样交给 xterm）：
 * - 备用屏幕（全屏 TUI）：此时 wheel 的语义是给 PTY 发方向键，不是滚动历史；
 * - TUI 开了鼠标上报：wheel 属于 TUI 自己（列表滚动/选择）；
 * - 带修饰键：Ctrl/⌘+wheel 是缩放、Alt 是快速滚动、Shift 是横向；
 * - 行/页模式的滚轮与带横向分量的手势：交给 xterm。
 * 鼠标滚轮在 macOS 上多半仍是像素模式，会进合帧；一格通常只有一枚事件，
 * 合帧省不下整屏重绘。那部分见 terminal-row-reuse.ts。
 */

/** 判定只需要这几个字段，便于纯逻辑测试（WheelEvent 结构上满足） */
export type WheelLike = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export type WheelContext = {
  /** 当前缓冲区类型：alternate = 备用屏幕（全屏 TUI） */
  bufferType: string;
  /** 鼠标上报模式：非 none 时 wheel 属于 TUI */
  mouseTrackingMode: string;
};

/** 这枚 wheel 事件该不该进合帧队列 */
export function shouldCoalesceTrackpadWheel(
  e: WheelLike,
  ctx: WheelContext,
): boolean {
  if (ctx.bufferType !== "normal") return false;
  if (ctx.mouseTrackingMode && ctx.mouseTrackingMode !== "none") return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  // 行/页模式是「一格若干行」的滚轮语义，交给 xterm。macOS 鼠标多半仍是像素模式。
  if (e.deltaMode !== 0) return false;
  // 横向分量与零增量交给 xterm 原路径
  if (e.deltaX !== 0) return false;
  if (!e.deltaY) return false;
  return true;
}

/** 合帧所需的最小终端面（xterm 的 Terminal 结构上满足；测试用假件） */
export interface WheelCoalesceHost {
  element?: HTMLElement | undefined;
  buffer: { active: { type: string } };
  modes: { mouseTrackingMode: string };
}

/** 装上触控板合帧，返回拆除函数；终端元素还没挂载时是空操作 */
export function installTrackpadWheelCoalescing(
  term: WheelCoalesceHost,
): () => void {
  const host = term.element;
  if (!host || typeof host.addEventListener !== "function") return () => {};

  let dispatching = false;
  let raf = 0;
  let pending: { deltaY: number; target: EventTarget | null } | null = null;

  const flush = () => {
    raf = 0;
    const item = pending;
    pending = null;
    if (!item) return;
    // 派发回原事件的深层目标：只有后代节点上的 xterm 滚动监听吃得到
    const target = item.target ?? host;
    dispatching = true;
    try {
      target.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: item.deltaY,
          deltaMode: 0,
          // 旧字段 wheelDeltaY 必须显式给反号：Chromium / WebView2 给合成事件填的是与 deltaY **同号**的值
          //（真事件是反号），xterm 的 StandardWheelEvent 先读 wheelDeltaY → Windows 上滚轮整个反向
          //（2026-10-21 Edge CDP 实测）。WebKit 默认就是 -deltaY，macOS 不变
          wheelDeltaY: -item.deltaY,
          bubbles: true,
          cancelable: true,
        } as WheelEventInit),
      );
    } catch {
      // 合成事件失败（老引擎缺 WheelEvent 构造器）时不再接管
      pending = null;
    } finally {
      dispatching = false;
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (dispatching) return; // 自己合成的这一枚，放它走完 xterm 原路径
    const ctx = {
      bufferType: term.buffer.active.type,
      mouseTrackingMode: term.modes.mouseTrackingMode,
    };
    if (!shouldCoalesceTrackpadWheel(e, ctx)) return;
    e.preventDefault();
    // 捕获阶段挡在 xterm 自己的滚动监听之前：同帧内的多枚事件不再各写一次滚动位置
    e.stopPropagation();
    pending = {
      deltaY: (pending?.deltaY ?? 0) + e.deltaY,
      target: e.target ?? host,
    };
    if (!raf) raf = requestAnimationFrame(flush);
  };

  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    pending = null;
    host.removeEventListener("wheel", onWheel, { capture: true });
  };
}