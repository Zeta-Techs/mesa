import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * 刚摆出一段对话时先不露，排好再一次露出（2026-10-26 用户：每切到这段对话，上方文字都会抖动两下）。
 *
 * 在 Mesa Dev 里逐帧量过：对话第一屏贴底摆出来之后，还有好几批后到的改动——表格套壳、行内文件链接与引用胶囊
 * （要问后端）、代码高亮、公式、图片、输入框那排芯片挪进状态栏、首屏补页——贴着底时每改一次高度，上面的字就跟着挪一下。
 * 逐个堵堵不完，所以从「从没有到有」那一刻起让对话区透明，等尺寸 120ms 不再变、也没在接更早一页时再淡入，最多等 600ms。
 * 已经开着的对话切回来不会重新摆，不遮。
 */
export const VEIL_QUIET_MS = 120;
export const VEIL_MAX_MS = 600;

export function veilDecision(m: {
  elapsedMs: number;
  quietMs: number;
  loadingOlder: boolean;
}): "reveal" | "wait" {
  if (m.elapsedMs >= VEIL_MAX_MS) return "reveal";
  if (m.loadingOlder) return "wait";
  return m.quietMs >= VEIL_QUIET_MS ? "reveal" : "wait";
}

/**
 * `hasContent` 从 false 变 true 时开始遮，返回此刻要不要遮。滚动容器的第一个子元素是内容根（同 useReadingAnchor）。
 * `loadingOlder` 读最新值（ref 或闭包都行），正在接更早一页时多等一会儿。
 */
export function useSettleVeil(
  scrollRef: RefObject<HTMLElement | null>,
  hasContent: boolean,
  loadingOlder: () => boolean,
): boolean {
  const [settled, setSettled] = useState(false);
  // 内容清空（换了一段、重开）就重新来一次；渲染期间按条件调整（React「根据 props 调整 state」写法）
  if (!hasContent && settled) setSettled(false);
  const veiled = hasContent && !settled;
  const loadingRef = useRef(loadingOlder);
  loadingRef.current = loadingOlder;
  useEffect(() => {
    if (!veiled) return;
    const scroller = scrollRef.current;
    const content = scroller?.firstElementChild ?? null;
    if (!scroller || !content || typeof ResizeObserver === "undefined") {
      setSettled(true);
      return;
    }
    const start = performance.now();
    let lastChange = start;
    let timer = 0;
    const check = () => {
      const now = performance.now();
      const d = veilDecision({
        elapsedMs: now - start,
        quietMs: now - lastChange,
        loadingOlder: loadingRef.current(),
      });
      if (d === "reveal") setSettled(true);
      else timer = window.setTimeout(check, 40);
    };
    const ro = new ResizeObserver(() => {
      lastChange = performance.now();
    });
    ro.observe(content);
    ro.observe(scroller);
    timer = window.setTimeout(check, 40);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [veiled, scrollRef]);
  return veiled;
}

/** 遮着时内容根的样式：只动透明度，不动排版（选锚、贴底照常算）；露出时淡入 */
export function veilClass(veiled: boolean): string {
  return veiled ? "opacity-0" : "opacity-100 transition-opacity duration-150 ease-out motion-reduce:transition-none";
}
