import { useEffect, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import {
  PLAN_SWIPE_THRESHOLD,
  PLAN_WHEEL_IDLE,
  planSwipeTarget,
  planWheelStep,
  type PlanWheelState,
} from "./plan-quota.ts";
import type { PlanQuotaDto } from "./types.ts";

/** 跟手位移（旧单帧接口，保留兼容单测） */
export function swipeFollowOffset(dx: number, canGo: boolean): number {
  const sign = dx < 0 ? -1 : 1;
  const mag = Math.abs(dx);
  return sign * (canGo ? Math.min(mag * 0.35, 28) : Math.min(mag * 0.12, 10));
}

/** 连续轮播轨跟手位移：可切换方向近 1:1 顺滑拖出下一张，到头方向阻尼回弹 */
export function carouselDragOffset(dx: number, canGo: boolean, width: number): number {
  if (dx === 0) return 0;
  const sign = dx < 0 ? -1 : 1;
  const mag = Math.abs(dx);
  if (canGo) {
    const cap = Math.max(80, Math.min(width * 0.45, 180));
    return sign * Math.min(mag * 0.72, cap);
  }
  // 到头橡皮筋阻尼（渐近上限 22px）
  return sign * Math.min(mag * 0.18, 22);
}

/** 将后端渐进到达的部分余量行合入当前缓存列表：已存在的账号原地刷新、新账号按槽序追加，不闪丢其余尚未回来的缓存账号 */
export function mergePartialPlanRows(
  prev: readonly PlanQuotaDto[],
  partial: readonly PlanQuotaDto[],
): PlanQuotaDto[] {
  if (partial.length === 0) return prev.slice();
  if (prev.length === 0) return partial.slice();
  const byId = new Map<string, PlanQuotaDto>();
  for (const r of partial) byId.set(r.gatewayId, r);
  const seen = new Set<string>();
  const out: PlanQuotaDto[] = [];
  for (const r of prev) {
    const fresh = byId.get(r.gatewayId);
    if (fresh) {
      out.push(fresh);
      seen.add(r.gatewayId);
    } else {
      out.push(r);
    }
  }
  for (const r of partial) {
    if (!seen.has(r.gatewayId)) out.push(r);
  }
  return out;
}

const SLIDE_MS = 260;
const SPRING_MS = 240;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * 订阅余量 / 网关余额卡收起态的 GPU 连续轮播切换（2026-11-25 流畅度重构）：
 * - 非被动原生 `wheel` 监听（`{ passive: false }`）：横向轻扫时 `preventDefault()`，杜绝 macOS WKWebView 原生横向橡皮筋/返回手势打架；
 * - 全量收起态卡片横排在同一条 `will-change: transform` 轨道上，跟手阶段经 `requestAnimationFrame` 合并写 `translate3d`，
 *   零 60Hz React 重渲染、零 `opacity: 0` 闪灭、松手/跨阈值直接由 GPU 合成器丝滑滑入目标槽位；
 * - 需配合 `React.memo` 卡片隔离 `active` 状态，切卡不再触发整张用量页重算图表与热力图。
 */
export function useQuotaSwipe(opts: {
  ids: readonly string[];
  active: string | null;
  /** 收起态才启用横向滑切（展开态不拦截滚轮） */
  disabled?: boolean;
  onChange: (id: string) => void;
  /** 真切过一次（用来收掉「可以滑动」的提示气泡） */
  onSwiped?: () => void;
}) {
  const containerRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const ids = opts.ids;
  const enabled = !opts.disabled && ids.length > 1;
  const activeIdx = Math.max(0, opts.active != null ? ids.indexOf(opts.active) : 0);
  const current = ids[activeIdx] ?? ids[0] ?? null;

  const latestRef = useRef({
    ids,
    activeIdx,
    current,
    enabled,
    onChange: opts.onChange,
    onSwiped: opts.onSwiped,
  });
  latestRef.current = {
    ids,
    activeIdx,
    current,
    enabled,
    onChange: opts.onChange,
    onSwiped: opts.onSwiped,
  };

  const st = useRef({
    wheel: PLAN_WHEEL_IDLE as PlanWheelState,
    wheelIdle: 0 as ReturnType<typeof setTimeout> | 0,
    startX: null as number | null,
    dragged: false,
    swipedAt: 0,
    raf: 0 as number,
    pendingPx: 0,
    /** 最近一次主动切卡落下的目标下标，供 useLayoutEffect 区分「手势滑行中」与「外部列表变化需静默对齐」 */
    animatingIdx: null as number | null,
  });

  const reduced = () =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  function applyTrack(idx: number, offsetPx: number, ms: number) {
    const el = trackRef.current;
    if (!el) return;
    el.style.transition = ms > 0 ? `transform ${ms}ms ${EASE}` : "none";
    // 始终保持 calc(P% + Lpx) 同构表达式，避免 WebKit 合成器在 calc 与纯百分比之间切换动画插值路径时产生顿挫
    el.style.transform = `translate3d(calc(${-idx * 100}% + ${offsetPx}px), 0, 0)`;
  }

  function scheduleDrag(dx: number) {
    const L = latestRef.current;
    if (reduced()) return;
    const dir: 1 | -1 = dx < 0 ? 1 : -1;
    const next = planSwipeTarget(L.ids, L.current, dir);
    const canGo = next != null && next !== L.current;
    const width = trackRef.current?.clientWidth || containerRef.current?.clientWidth || 320;
    st.current.pendingPx = carouselDragOffset(dx, canGo, width);
    if (st.current.raf) return;
    st.current.raf = requestAnimationFrame(() => {
      st.current.raf = 0;
      applyTrack(latestRef.current.activeIdx, st.current.pendingPx, 0);
    });
  }

  function cancelDragRaf() {
    if (st.current.raf) {
      cancelAnimationFrame(st.current.raf);
      st.current.raf = 0;
    }
  }

  function springBack() {
    cancelDragRaf();
    applyTrack(latestRef.current.activeIdx, 0, reduced() ? 0 : SPRING_MS);
  }

  function goToIndex(nextIdx: number) {
    const L = latestRef.current;
    if (nextIdx < 0 || nextIdx >= L.ids.length) {
      springBack();
      return;
    }
    const nextId = L.ids[nextIdx];
    if (!nextId || nextIdx === L.activeIdx) {
      springBack();
      return;
    }
    cancelDragRaf();
    st.current.swipedAt = performance.now();
    st.current.animatingIdx = nextIdx;
    // 先把轨道直接推向目标槽位（GPU 合成器会从当前跟手像素无缝滑过去，不闪不跳），再通知 React 更新头标
    applyTrack(nextIdx, 0, reduced() ? 0 : SLIDE_MS);
    L.onChange(nextId);
    L.onSwiped?.();
  }

  /** dir 1 = 下一家（内容往左走、新的从右边滑进） */
  function go(dir: 1 | -1) {
    const L = latestRef.current;
    const next = planSwipeTarget(L.ids, L.current, dir);
    if (!next || next === L.current) {
      springBack();
      return;
    }
    goToIndex(L.ids.indexOf(next));
  }

  // 外部列表变化 / 首次挂载时把轨道对齐到 activeIdx（不打断刚刚触发的手势滑行）
  useLayoutEffect(() => {
    if (st.current.animatingIdx === activeIdx) {
      st.current.animatingIdx = null;
      return;
    }
    st.current.animatingIdx = null;
    cancelDragRaf();
    applyTrack(activeIdx, 0, 0);
  }, [activeIdx, ids.length, opts.disabled]);

  // 原生非被动 wheel 监听：横向手势时阻止 WKWebView 默认橡皮筋/后退手势，保证跟手丝滑不卡顿
  useEffect(() => {
    const node = containerRef.current;
    if (!node || !enabled) return;
    const onWheelNative = (e: globalThis.WheelEvent) => {
      const L = latestRef.current;
      if (!L.enabled) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      const s = st.current;
      const horizontalIntent =
        (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 0.5) ||
        (s.wheel.dir !== 0 && Math.abs(s.wheel.x) > s.wheel.y && Math.abs(dx) >= Math.abs(dy) * 0.5);
      if (horizontalIntent) {
        e.preventDefault();
      }
      const r = planWheelStep(s.wheel, dx, dy, e.timeStamp);
      s.wheel = r.state;
      if (r.step) {
        go(r.step);
      } else if (!r.state.fired && r.state.dir !== 0 && Math.abs(r.state.x) > r.state.y) {
        scheduleDrag(-r.state.x);
      }
      if (s.wheelIdle) clearTimeout(s.wheelIdle);
      s.wheelIdle = setTimeout(() => {
        s.wheelIdle = 0;
        if (!s.wheel.fired) springBack();
      }, 110);
    };
    node.addEventListener("wheel", onWheelNative, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheelNative);
      if (st.current.wheelIdle) {
        clearTimeout(st.current.wheelIdle);
        st.current.wheelIdle = 0;
      }
      cancelDragRaf();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!latestRef.current.enabled || e.button !== 0) return;
    st.current.startX = e.clientX;
    st.current.dragged = false;
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const s = st.current;
    if (s.startX == null) return;
    const dx = e.clientX - s.startX;
    if (!s.dragged && Math.abs(dx) > 6) {
      s.dragged = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (s.dragged) scheduleDrag(dx);
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    const s = st.current;
    if (s.startX == null) return;
    const dx = e.clientX - s.startX;
    s.startX = null;
    if (!s.dragged) return;
    s.swipedAt = performance.now();
    if (Math.abs(dx) >= PLAN_SWIPE_THRESHOLD) go(dx < 0 ? 1 : -1);
    else springBack();
  }

  function onPointerCancel() {
    if (st.current.startX == null) return;
    st.current.startX = null;
    springBack();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!latestRef.current.enabled) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    }
  }

  /** 滑 / 拖之后紧跟的那次点击不当「展开」 */
  function swallowClick(): boolean {
    return performance.now() - st.current.swipedAt < 300;
  }

  return {
    containerRef,
    trackRef,
    activeIdx,
    go,
    goToIndex,
    areaHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown },
    swallowClick,
  };
}
