import { useEffect, useRef, type RefObject } from "react";

/**
 * 对话回放「往上翻自动接着加载更早的」（2026-10-21 用户：对话页、项目对话、聊天层都要一直点「加载更早」）。
 * 按钮保留作兜底与进度提示；滚到离顶部这么近（px）时自动拉下一页，留一段余量让翻页不卡顿。
 */
export const AUTO_LOAD_OLDER_THRESHOLD = 360;

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** 内容不满一屏：没有滚动条可翻，只能自动补页（否则长会话打开只看见一两个气泡） */
export function needsFill(m: ScrollMetrics): boolean {
  return m.scrollHeight - m.clientHeight <= 1;
}

/** 用户往上翻到了顶部附近 */
export function nearTop(
  m: ScrollMetrics,
  threshold = AUTO_LOAD_OLDER_THRESHOLD,
): boolean {
  return m.scrollTop <= threshold;
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
 * `onLoad` 返回的 Promise 结束后再等两帧才放开下一次：调用方在 rAF / layout effect 里把阅读位置
 * 挪回原处，放早了会在还没挪回的顶部再触发一次。
 */
export function useAutoLoadOlder(
  scrollRef: RefObject<HTMLElement | null>,
  opts: {
    enabled: boolean;
    busy: boolean;
    onLoad: () => void | Promise<void>;
    fillKey?: unknown;
  },
) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const inflightRef = useRef(false);
  const attachedRef = useRef<{ el: HTMLElement; off: () => void } | null>(null);

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
      .then(onLoad)
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
    const onScroll = () => {
      if (nearTop(el)) triggerRef.current();
    };
    // 已经停在顶部时再往上滚不会产生 scroll 事件，靠滚轮补一下
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && nearTop(el)) triggerRef.current();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    attachedRef.current = {
      el,
      off: () => {
        el.removeEventListener("scroll", onScroll);
        el.removeEventListener("wheel", onWheel);
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
