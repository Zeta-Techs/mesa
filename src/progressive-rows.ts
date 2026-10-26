import { useCallback, useState } from "react";

/**
 * 长列表分段渲染（2026-10-26 用户「操作流畅性全部都做」）：上千行的对话列表每次切筛选、选中、轮询刷新都要
 * 整列重画。先画前一段，滚到离底不到三屏再接下一段；不放「加载更多」按钮也不放提示行（同 2026-10-21
 * 回放往上翻的口径：要无缝衔接）。选中项在后面时画到它为止，键盘切换 / 外部跳转照样能滚到它。
 */
export const PROGRESSIVE_ROW_STEP = 150;

/** 这次画多少行：至少画到必须露出的那一行（-1 = 没有），不超过总数 */
export function progressiveLimit(limit: number, total: number, mustInclude = -1): number {
  return Math.min(total, Math.max(limit, mustInclude + 1));
}

/** 离底不到三屏（窗口矮时不低于 600px）就该接下一段 */
export function nearBottom(m: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  const remaining = m.scrollHeight - m.scrollTop - m.clientHeight;
  return remaining <= Math.max(600, m.clientHeight * 3);
}

/**
 * `resetKey` 变了（换筛选 / 搜索词）就回到第一段；同一筛选下列表刷新不回退，已经滚下去的不会被收回。
 * 滚动容器的 onScroll 里调 `onScroll(el)`。
 */
export function useProgressiveRows(total: number, resetKey: string, step = PROGRESSIVE_ROW_STEP) {
  const [limit, setLimit] = useState(step);
  const [key, setKey] = useState(resetKey);
  if (key !== resetKey) {
    // 渲染期间按键重置（React 官方「根据 props 调整 state」写法），不多画一帧旧长度
    setKey(resetKey);
    setLimit(step);
  }
  const onScroll = useCallback(
    (el: HTMLElement) => {
      if (!nearBottom(el)) return;
      setLimit((current) => (current < total ? current + step : current));
    },
    [total, step],
  );
  return { limit: key === resetKey ? limit : step, onScroll };
}
