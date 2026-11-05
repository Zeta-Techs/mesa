import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import {
  clampPdfScale,
  pdfPinchScale,
  pdfWheelShouldZoom,
  pdfWheelZoomFactor,
} from "../reader";

/** 位图重绘延迟：布局倍率立即跟随输入，canvas/textLayer 等停稳才按新倍率重渲
 *  （官方 pdf.js viewer 的 drawingDelay 同款）；期间旧位图 CSS 拉伸跟手 */
export const PDF_RENDER_DEFER_MS = 120;
/** gestureend 后仍会尾随惯性 ctrl+wheel（pinch 双路事件），这段时间内忽略滚轮缩放 */
export const PDF_GESTURE_WHEEL_COOLDOWN_MS = 300;

/** WebKit 触控板 pinch（Safari/WKWebView）；标准 DOM 无此类型 */
type WebkitGestureEvent = Event & {
  scale: number;
  clientX: number;
  clientY: number;
};

/**
 * PDF 手势缩放共享绑定（PdfContinuousView 连续滚动 / PdfPreview 单页预览同一套）。
 * 设计对齐官方 pdf.js viewer（Firefox 阅读器）：
 * ① 倍率输入立即提交 React——页盒按新倍率即时重排（纯 div 尺寸，便宜），
 *    不做整层 CSS transform 跟手（巨型 layer 反复栅格化 + 手写 scroll 补偿 = 晃动源）；
 * ② canvas/textLayer 按 renderScale 延迟重绘（停稳 ~120ms），期间旧位图 CSS 拉伸，
 * ③ 锚点用实测不用公式：输入时记录「指针落在哪个页盒的哪个相对位置」（页间分隔行、
 *    padding、水平居中、取整误差都不随倍率缩放，纯数学换算必然错位），重排后量出该点
 *    新位置修正滚动；批处理/连发事件下锚点链式沿用直到 scale 追上目标；
 * ④ pinch 双路事件防叠倍：pinchActive 挡 gesture 期间的 ctrl+wheel，gestureend 后
 *    300ms 冷却挡惯性尾随。
 * 另含鼠标中键拖动平移（放大后鼠标的四向平移；左键永远留给文本选择）。
 * Shift+滚轮的横向滚动走 WebView 原生行为，不另接。
 * 宿主提供滚动层 ref + 当前倍率 + onCommit（= setFixedScale）+ 页盒选择器，用返回的
 * renderScale 喂 PdfPageView 的渲染倍率；liveZoomingRef 供适配宽度重算/IO 等让路。
 */
export function usePdfGestureZoom({
  scrollRef,
  scale,
  enabled,
  onCommit,
  anchorSelector,
  maxScale,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** 布局倍率（fixedScale ?? fitScale）：页盒尺寸立即跟随它 */
  scale: number;
  /** 文档就绪才挂监听 */
  enabled: boolean;
  /** 倍率输入立即提交（= setFixedScale） */
  onCommit: (next: number) => void;
  /** 页盒选择器（滚动层内查询）：锚点测量的目标元素（连续滚动 = 页盒，预览 = 页宿主） */
  anchorSelector: string;
  /** 宿主缩放上限（弹层限深用，缺省 = 全局 4×） */
  maxScale?: number;
}): {
  /** 渲染倍率：喂 PdfPageView 的 canvas/textLayer 重建；停稳才追上 scale */
  renderScale: number;
  liveZoomingRef: MutableRefObject<boolean>;
} {
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  /** 手势目标倍率：连续输入在事件间同步累积，不等 React 渲染 */
  const targetScaleRef = useRef(scale);
  const liveZoomingRef = useRef(false);
  /** 实测锚点：指针下的页盒 + 盒内相对位置 + 指针视口坐标；to = 该锚点对应的目标倍率 */
  const pendingAnchorRef = useRef<{
    el: HTMLElement;
    fx: number;
    fy: number;
    vx: number;
    vy: number;
    to: number;
  } | null>(null);
  const [renderScale, setRenderScale] = useState(scale);
  const renderDeferRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const maxScaleRef = useRef(maxScale ?? Number.POSITIVE_INFINITY);
  maxScaleRef.current = maxScale ?? Number.POSITIVE_INFINITY;

  // 位图重绘延迟：任何倍率变化（手势/按钮/适配）都等停稳再重渲；旧位图 CSS 拉伸兜底
  useEffect(() => {
    if (renderDeferRef.current != null) clearTimeout(renderDeferRef.current);
    renderDeferRef.current = setTimeout(() => {
      renderDeferRef.current = null;
      liveZoomingRef.current = false;
      setRenderScale(scale);
    }, PDF_RENDER_DEFER_MS);
    return () => {
      if (renderDeferRef.current != null) clearTimeout(renderDeferRef.current);
    };
  }, [scale]);

  // 锚点修正：布局已按新倍率就绪（layout effect 时序），量出锚点新位置把 scroll 补回去。
  // 连发事件被 React 批处理时锚点链式沿用：中间档也修正一次，直到 scale 追平目标
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending) return;
    const scroll = scrollRef.current;
    if (!scroll || !pending.el.isConnected) {
      pendingAnchorRef.current = null;
      return;
    }
    const br = pending.el.getBoundingClientRect();
    if (br.width > 0 && br.height > 0) {
      scroll.scrollLeft += br.left + pending.fx * br.width - pending.vx;
      scroll.scrollTop += br.top + pending.fy * br.height - pending.vy;
    }
    if (pending.to === scale) pendingAnchorRef.current = null;
  }, [scale]);

  // ⌘/Ctrl+滚轮 与触控板 pinch：立即提交布局倍率 + 记实测锚点
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;
    let pinchActive = false;
    let pinchStart = targetScaleRef.current;
    let lastGestureEndAt = 0;

    const pointerOf = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const overPane = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return (
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom
      );
    };

    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

    /** 指针（栏内坐标）→ 命中的页盒 + 盒内相对位置。快路径 elementFromPoint O(1)；
     *  指针在页间缝隙（命中分隔行等非页盒元素）才回落最近页盒扫描 */
    const anchorOf = (pointer: { x: number; y: number }) => {
      const r = el.getBoundingClientRect();
      const vx = r.left + pointer.x;
      const vy = r.top + pointer.y;
      const pack = (b: HTMLElement) => {
        const br = b.getBoundingClientRect();
        if (br.width === 0 || br.height === 0) return null;
        return {
          el: b,
          fx: clamp01((vx - br.left) / br.width),
          fy: clamp01((vy - br.top) / br.height),
          vx,
          vy,
        };
      };
      const hit = document
        .elementFromPoint(vx, vy)
        ?.closest(anchorSelector) as HTMLElement | null;
      if (hit && el.contains(hit)) {
        const a = pack(hit);
        if (a) return a;
      }
      let best: { el: HTMLElement; fx: number; fy: number; d: number } | null =
        null;
      for (const b of el.querySelectorAll<HTMLElement>(anchorSelector)) {
        const br = b.getBoundingClientRect();
        if (br.width === 0 || br.height === 0) continue;
        const dx = Math.max(br.left - vx, 0, vx - br.right);
        const dy = Math.max(br.top - vy, 0, vy - br.bottom);
        const d = dx + dy;
        if (!best || d < best.d) {
          best = {
            el: b,
            fx: clamp01((vx - br.left) / br.width),
            fy: clamp01((vy - br.top) / br.height),
            d,
          };
        }
      }
      return best ? { el: best.el, fx: best.fx, fy: best.fy, vx, vy } : null;
    };

    // 一帧只提交一次（2026-11-05 用户：缩放不丝滑）：触控板 / 滚轮一帧能来好几个事件，
    // 每个都量锚点、重渲整列页槽会把帧拖长；倍率仍在事件里同步累积，只把「量锚点 + 提交」并到下一帧
    let frame: number | null = null;
    let framePointer: { x: number; y: number } | null = null;
    const flushZoom = () => {
      frame = null;
      const pointer = framePointer;
      framePointer = null;
      const next = targetScaleRef.current;
      if (!pointer) return;
      if (next === scaleRef.current) {
        // 一帧内放大又缩回原倍率：没有提交，也就不会有停稳回调来清标记
        liveZoomingRef.current = false;
        return;
      }
      const anchor = anchorOf(pointer);
      if (!anchor) return; // 页盒还没渲染出来，等下一个事件
      pendingAnchorRef.current = { ...anchor, to: next };
      onCommitRef.current(next);
    };
    const queueZoom = (nextScale: number, pointer: { x: number; y: number }) => {
      const next = Math.min(maxScaleRef.current, clampPdfScale(nextScale));
      // 钳制到顶/底后倍率不再变：不记锚点不提交，避免滞留锚点在下次无关重排时误跳
      if (next === scaleRef.current && next === targetScaleRef.current) return;
      liveZoomingRef.current = true;
      targetScaleRef.current = next;
      framePointer = pointer;
      if (frame == null) frame = requestAnimationFrame(flushZoom);
    };

    const onWheel = (e: WheelEvent) => {
      if (!pdfWheelShouldZoom(e)) return;
      e.preventDefault();
      e.stopPropagation();
      // pinch 走 gesturechange 时 Chromium/WebKit 还会再发 ctrl+wheel，丢掉以免叠倍
      if (pinchActive) return;
      // 松手后的惯性 ctrl+wheel 同样属于那次 pinch，冷却期内忽略
      if (Date.now() - lastGestureEndAt < PDF_GESTURE_WHEEL_COOLDOWN_MS) return;
      const factor = pdfWheelZoomFactor(e.deltaY, e.deltaMode);
      if (factor == null) return;
      queueZoom(targetScaleRef.current * factor, pointerOf(e));
    };

    // gesture* 在 WKWebView 上常打到 window。一律 preventDefault 挡住整页缩放；
    // 只在指针落在 PDF 栏时才改页倍率。
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      const ge = e as WebkitGestureEvent;
      if (!overPane(ge)) return;
      pinchActive = true;
      pinchStart = targetScaleRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (!pinchActive) return;
      const ge = e as WebkitGestureEvent;
      queueZoom(pdfPinchScale(pinchStart, ge.scale), pointerOf(ge));
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      if (!pinchActive) return;
      pinchActive = false;
      lastGestureEndAt = Date.now();
    };

    const wheelOpts: AddEventListenerOptions = { passive: false, capture: true };
    const gestureOpts: AddEventListenerOptions = { passive: false, capture: true };
    el.addEventListener("wheel", onWheel, wheelOpts);
    window.addEventListener("gesturestart", onGestureStart, gestureOpts);
    window.addEventListener("gesturechange", onGestureChange, gestureOpts);
    window.addEventListener("gestureend", onGestureEnd, gestureOpts);
    window.addEventListener("gesturecancel", onGestureEnd, gestureOpts);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      el.removeEventListener("wheel", onWheel, wheelOpts);
      window.removeEventListener("gesturestart", onGestureStart, gestureOpts);
      window.removeEventListener("gesturechange", onGestureChange, gestureOpts);
      window.removeEventListener("gestureend", onGestureEnd, gestureOpts);
      window.removeEventListener("gesturecancel", onGestureEnd, gestureOpts);
    };
  }, [enabled]);

  // 鼠标中键拖动平移（放大后鼠标的四向平移手段；左键留给文本选择，不动）。
  // pointerdown 即 preventDefault：拦 Windows WebView2 的中键自动滚动模式
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;
    let panning = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const endPan = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.classList.remove("cursor-grabbing", "select-none");
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      panning = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = el.scrollLeft;
      startTop = el.scrollTop;
      el.setPointerCapture(e.pointerId);
      el.classList.add("cursor-grabbing", "select-none");
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!panning) return;
      el.scrollLeft = startLeft - (e.clientX - startX);
      el.scrollTop = startTop - (e.clientY - startY);
    };
    // 双保险：mousedown 的默认行为也会触发 WebView2 自动滚动
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", endPan);
    el.addEventListener("pointercancel", endPan);
    el.addEventListener("mousedown", onMouseDown);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", endPan);
      el.removeEventListener("pointercancel", endPan);
      el.removeEventListener("mousedown", onMouseDown);
      el.classList.remove("cursor-grabbing", "select-none");
    };
  }, [enabled]);

  return { renderScale, liveZoomingRef };
}
