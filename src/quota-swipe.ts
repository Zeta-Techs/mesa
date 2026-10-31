import { useRef } from "react";
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";
import {
  PLAN_SWIPE_THRESHOLD,
  PLAN_WHEEL_IDLE,
  planSwipeTarget,
  planWheelStep,
  type PlanWheelState,
} from "./plan-quota.ts";

/** 跟手位移：滑动过程中内容跟着手指走一小段（有阻力），到头的方向阻力更大——一看就知道「那边没有了」 */
export function swipeFollowOffset(dx: number, canGo: boolean): number {
  const sign = dx < 0 ? -1 : 1;
  const mag = Math.abs(dx);
  return sign * (canGo ? Math.min(mag * 0.35, 28) : Math.min(mag * 0.12, 10));
}

const SLIDE_MS = 200;
const SPRING_MS = 220;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/**
 * 订阅余量卡收起态的左右切换（2026-10-31 用户：收起时不放标签、滑动切换，手感要细腻）。
 * 触控板横扫（wheel，整张卡都收；按一次手势判定，见 plan-quota planWheelStep）、按住拖动（只在摘要区）、← →。
 * 位移直接写 areaRef 的 style，不进 React 状态——跟手每帧都改，走状态会让整页 60Hz 重渲染。
 * 切换时新内容从滑动方向那侧滑进来；没滑够或到头就弹回原位。减弱动态效果时只切不动。
 */
export function useQuotaSwipe(opts: {
  ids: readonly string[];
  active: string | null;
  onChange: (id: string) => void;
  /** 真切过一次（用来收掉「可以滑动」的提示气泡） */
  onSwiped?: () => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const st = useRef({
    wheel: PLAN_WHEEL_IDLE as PlanWheelState,
    wheelIdle: 0 as ReturnType<typeof setTimeout> | 0,
    startX: null as number | null,
    dragged: false,
    swipedAt: 0,
  });
  const enabled = opts.ids.length > 1;
  const current = opts.active ?? opts.ids[0] ?? null;

  const reduced = () =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  function place(px: number, ms = 0, opacity = 1) {
    const el = areaRef.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms ${EASE}, opacity ${ms}ms ${EASE}` : "none";
    el.style.transform = px ? `translateX(${px}px)` : "";
    el.style.opacity = opacity === 1 ? "" : String(opacity);
  }

  const canGo = (dir: 1 | -1) => {
    const next = planSwipeTarget(opts.ids, current, dir);
    return next != null && next !== current;
  };

  function follow(dx: number) {
    if (reduced()) return;
    place(swipeFollowOffset(dx, canGo(dx < 0 ? 1 : -1)));
  }

  function springBack() {
    place(0, reduced() ? 0 : SPRING_MS);
  }

  /** dir 1 = 下一家（内容往左走、新的从右边进来） */
  function go(dir: 1 | -1) {
    const next = planSwipeTarget(opts.ids, current, dir);
    if (!next || next === current) {
      springBack();
      return;
    }
    st.current.swipedAt = performance.now();
    opts.onChange(next);
    opts.onSwiped?.();
    if (reduced()) {
      place(0);
      return;
    }
    // 先摆到进场一侧（不带过渡），下一帧再滑回原位
    place(dir * 24, 0, 0);
    requestAnimationFrame(() => requestAnimationFrame(() => place(0, SLIDE_MS)));
  }

  function onWheel(e: WheelEvent) {
    if (!enabled) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const s = st.current;
    const r = planWheelStep(s.wheel, e.deltaX * unit, e.deltaY * unit, e.timeStamp);
    s.wheel = r.state;
    if (r.step) {
      go(r.step);
    } else if (!r.state.fired && r.state.dir !== 0 && Math.abs(r.state.x) > r.state.y) {
      // 横向为主才跟手（-x：两指往左扫 deltaX 为正，内容往左走）
      follow(-r.state.x);
    }
    // 手势停了还没切：弹回
    if (s.wheelIdle) clearTimeout(s.wheelIdle);
    s.wheelIdle = setTimeout(() => {
      s.wheelIdle = 0;
      if (!s.wheel.fired) springBack();
    }, 140);
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!enabled || e.button !== 0) return;
    st.current.startX = e.clientX;
    st.current.dragged = false;
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const s = st.current;
    if (s.startX == null) return;
    const dx = e.clientX - s.startX;
    if (!s.dragged && Math.abs(dx) > 6) {
      s.dragged = true;
      // 真拖起来才捕获：纯点击不受影响；捕获后在卡外松手也收得到 pointerup
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (s.dragged) follow(dx);
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
    if (!enabled) return;
    if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
  }

  /** 滑 / 拖之后紧跟的那次点击不当「展开」 */
  function swallowClick(): boolean {
    return performance.now() - st.current.swipedAt < 300;
  }

  return {
    areaRef,
    onWheel,
    areaHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown },
    swallowClick,
  };
}
