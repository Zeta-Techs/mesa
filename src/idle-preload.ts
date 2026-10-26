/**
 * 启动后空闲时把常用的大块先载进来（2026-10-26 用户「操作流畅性全部都做」）。
 * 入口包瘦身后（vite.config.ts manualChunks 不再让入口静态带上 monaco / mermaid / pdfjs），运行页、
 * 文件预览编辑器、PDF 阅读第一次打开要现载现解析几 MB；这里趁空闲一块一块地预先 import，
 * 第一次点开就不用等。一次只载一块、载完再等下一个空闲，不和启动时的数据加载抢；失败静默（真打开时再报）。
 * mermaid 不预载：只有带图的笔记才用得到。
 */
export type IdleScheduler = (cb: () => void) => void;

export function preloadInIdle(
  loaders: ReadonlyArray<() => Promise<unknown>>,
  schedule: IdleScheduler,
): () => void {
  let cancelled = false;
  let index = 0;
  const next = () => {
    if (cancelled || index >= loaders.length) return;
    schedule(() => {
      if (cancelled) return;
      const load = loaders[index++];
      load().then(next, next);
    });
  };
  next();
  return () => {
    cancelled = true;
  };
}

/** WKWebView（Safari）没有 requestIdleCallback：退回定时 */
export function browserIdleScheduler(fallbackMs = 1500): IdleScheduler {
  return (cb) => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    };
    if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(cb, { timeout: 4000 });
    else window.setTimeout(cb, fallbackMs);
  };
}
