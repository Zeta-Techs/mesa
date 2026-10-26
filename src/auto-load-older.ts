import { useEffect, useRef, type RefObject } from "react";

/**
 * 对话回放「往上翻自动接着加载更早的」（2026-10-21 用户：对话页、项目对话、聊天层都要一直点「加载更早」）。
 * 顶部不放按钮也不放加载提示（同日用户：要无缝衔接）：离顶还有三屏就提前去拉，拉回来先攒着，
 * 等手停下来再接到上面（见 canCommitNow）。这是下限（px），窗口高时按三屏算。
 */
export const AUTO_LOAD_OLDER_THRESHOLD = 360;
/** 多久没有滚动事件算「手停了」（惯性滑动期间滚动事件几乎每帧都有） */
export const SCROLL_IDLE_MS = 140;

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** 人碰过滚动区之后多久内的滚动事件算人翻的（惯性滑动期间滚轮事件一直在来，会一直续上） */
export const USER_SCROLL_WINDOW_MS = 1200;

export function scrollIsUsers(sinceInputMs: number): boolean {
  return sinceInputMs <= USER_SCROLL_WINDOW_MS;
}

/** 内容不满一屏：没有滚动条可翻，只能自动补页（否则长会话打开只看见一两个气泡） */
export function needsFill(m: ScrollMetrics): boolean {
  return m.scrollHeight - m.clientHeight <= 1;
}

/** 用户往上翻到了离顶三屏以内（提前量，免得滑到顶再停下来等） */
export function nearTop(
  m: ScrollMetrics,
  threshold = Math.max(AUTO_LOAD_OLDER_THRESHOLD, m.clientHeight * 3),
): boolean {
  return m.scrollTop <= threshold;
}

/**
 * 拉回来的更早一页现在能不能接上去。滑动中途插内容要同步改 scrollTop 补偿位置，WebKit 里这会
 * 打断惯性、外加整列重排，手上感觉是一顿（2026-10-21 用户：「会有一瞬间的顿挫感」）。
 * 所以等手停了再接；离顶不到半屏就不等了——再等就要撞顶。
 */
export function canCommitNow(m: {
  sinceLastScrollMs: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return m.sinceLastScrollMs >= SCROLL_IDLE_MS || m.scrollTop <= m.clientHeight * 0.5;
}

/**
 * 头部是否多出了更早的消息：上一屏的第一条在新列表里往后挪了。
 * 只看首条是否换了不够——聊天层最新一窗随文件增长整体往后滑，首条会换但没有前插。
 */
export function wasPrepended(previousFirstKey: string | null, keys: string[]): boolean {
  if (previousFirstKey == null) return false;
  return keys.indexOf(previousFirstKey) > 0;
}

/**
 * 只认用户的滚动 / 滚轮触发，不在挂载时按 scrollTop 判断：首屏先渲染在顶部、下一帧才滚到底，
 * 那一瞬间 scrollTop=0 会被误判成「翻到顶」，一路把整份会话拉完。
 * 内容不满一屏时自动补页（`fillKey` 变化后复查，通常传消息条数）。
 * `onLoad` 拿到 `settle`：拉到数据后、写进列表前先 `await settle()`，等手停下来再接（canCommitNow）。
 * `onLoad` 返回的 Promise 结束后再等两帧才放开下一次：调用方在 layout effect 里把阅读位置
 * 挪回原处，放早了会在还没挪回的顶部再触发一次。
 */
export function useAutoLoadOlder(
  scrollRef: RefObject<HTMLElement | null>,
  opts: {
    enabled: boolean;
    busy: boolean;
    onLoad: (settle: () => Promise<void>) => void | Promise<void>;
    fillKey?: unknown;
  },
) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const inflightRef = useRef(false);
  const attachedRef = useRef<{ el: HTMLElement; off: () => void } | null>(null);
  const lastScrollAtRef = useRef(0);

  const settle = () =>
    new Promise<void>((resolve) => {
      const check = () => {
        const el = scrollRef.current;
        if (
          !el ||
          canCommitNow({
            sinceLastScrollMs: performance.now() - lastScrollAtRef.current,
            scrollTop: el.scrollTop,
            clientHeight: el.clientHeight,
          })
        ) {
          resolve();
          return;
        }
        window.setTimeout(check, 40);
      };
      check();
    });

  const trigger = () => {
    const { enabled, busy, onLoad } = optsRef.current;
    if (!enabled || busy || inflightRef.current) return;
    inflightRef.current = true;
    const release = () =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          inflightRef.current = false;
          // 这一页太短仍不满一屏：接着补（补页期间 fillKey 的变化被 inflight 挡掉了）
          const el = scrollRef.current;
          if (el && needsFill(el)) triggerRef.current();
        }),
      );
    Promise.resolve()
      .then(() => onLoad(settle))
      .catch(() => {})
      .finally(release);
  };
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;

  // 滚动容器可能随选中会话条件渲染：每次渲染核对一次，换了元素才重挂监听
  useEffect(() => {
    const el = scrollRef.current;
    if (el === (attachedRef.current?.el ?? null)) return;
    attachedRef.current?.off();
    attachedRef.current = null;
    if (!el) return;
    // 人碰过滚动区（滚轮 / 触控板惯性也是滚轮事件、拖滚动条、触摸、键盘）之后的滚动才算人翻的；
    // 贴底、锚点挪回这些程序改 scrollTop 也会发 scroll 事件，原先照样当「翻到离顶三屏内」去接更早一页，
    // 一打开对话就多接一页、整段重排一次（2026-10-26 逐帧实测）
    let lastInputAt = Number.NEGATIVE_INFINITY;
    const onInput = () => {
      lastInputAt = performance.now();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.buttons) lastInputAt = performance.now();
    };
    const onScroll = () => {
      const now = performance.now();
      lastScrollAtRef.current = now;
      if (scrollIsUsers(now - lastInputAt) && nearTop(el)) triggerRef.current();
    };
    // 已经停在顶部时再往上滚不会产生 scroll 事件，靠滚轮补一下
    const onWheel = (e: WheelEvent) => {
      lastInputAt = lastScrollAtRef.current = performance.now();
      if (e.deltaY < 0 && nearTop(el)) triggerRef.current();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("pointerdown", onInput, { passive: true });
    el.addEventListener("pointermove", onPointerMove, { passive: true });
    el.addEventListener("touchstart", onInput, { passive: true });
    el.addEventListener("keydown", onInput);
    attachedRef.current = {
      el,
      off: () => {
        el.removeEventListener("scroll", onScroll);
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("pointerdown", onInput);
        el.removeEventListener("pointermove", onPointerMove);
        el.removeEventListener("touchstart", onInput);
        el.removeEventListener("keydown", onInput);
      },
    };
  });
  useEffect(
    () => () => {
      attachedRef.current?.off();
      attachedRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!opts.enabled || opts.busy) return;
    const id = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && needsFill(el)) triggerRef.current();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.busy, opts.fillKey]);
}
