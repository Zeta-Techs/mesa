import { useEffect, useRef, type RefObject } from "react";

/**
 * 阅读位置自己锚住（2026-10-24 用户：「往上滑无缝展示，看这一块是否完善」；tests/reading-anchor.test.ts）。
 * 上面的内容变了——前插更早一页、图片晚到撑高、窗口变宽重排——眼睛正看着的那一行留在原处。
 *
 * 为什么不交给浏览器：WKWebView 与 WebView2 现在都自带滚动锚定，但它在滚到最顶时不管，
 * 跟原先「按 scrollHeight 差值补偿」叠在一起又会补两遍（同日两边实测：前插 20 屏高，阅读位置多跳一整页）。
 * 老一些的 macOS 上的 WebKit 有没有自带锚定也说不准。所以滚动容器一律关掉自带的（overflow-anchor:none），自己做，
 * 各平台、各系统版本一个口径。
 *
 * 选锚同浏览器的做法：从内容根往下，每层取第一个底边越过视口顶线的子元素；它整块在顶线以下就用它，
 * 跨着顶线就再往里找一层（跨线那块里面上半截变高时，锚住里面那块才跟得住）。
 */

type Box = { top: number; bottom: number; height: number };
export type AnchorEl = {
  readonly children: ArrayLike<AnchorEl>;
  getBoundingClientRect(): Box;
};

/** 往里找最多几层 */
const MAX_DEPTH = 8;
/** 人刚在聊天区里点过 / 按过键：这时内容变高多半是人展开了什么，跟随底部的也先锚住，不贴底 */
export const USER_SHIFT_MS = 800;

/**
 * 第一个底边越过顶线的子元素下标（没有高度的跳过：display:none、空占位）。
 * 从 `hint`（上次选中的位置）往两边走，滚动时每次只挪几格，长对话也不用从头扫。
 */
export function firstCrossing(kids: ArrayLike<AnchorEl>, viewTop: number, hint = 0): number {
  const n = kids.length;
  if (n === 0) return -1;
  const crosses = (i: number) => {
    const r = kids[i].getBoundingClientRect();
    return r.height > 0 && r.bottom > viewTop;
  };
  let i = Math.min(n - 1, Math.max(0, hint));
  while (i > 0) {
    const r = kids[i - 1].getBoundingClientRect();
    if (r.height > 0 && r.bottom <= viewTop) break;
    i--;
  }
  while (i < n && !crosses(i)) i++;
  return i < n ? i : -1;
}

/** 眼睛正看着的那一块；`rootIndex` 是它在内容根下那一层的位置，下次当 hint */
export function pickAnchor<T extends AnchorEl>(
  root: T,
  viewTop: number,
  hint = 0,
): { el: T; rootIndex: number } | null {
  let parent: AnchorEl = root;
  let picked: T | null = null;
  let rootIndex = 0;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const kids = parent.children;
    const i = firstCrossing(kids, viewTop, depth === 0 ? hint : 0);
    if (i < 0) break;
    const el = kids[i] as T;
    picked = el;
    if (depth === 0) rootIndex = i;
    // 整块在顶线以下就锚它——除非它是这一层唯一的子元素（纯包装层，如聊天的栏宽容器）：往它里面开头插内容
    //（加载更早一页）时它自己不挪，锚它等于没锚，停在最顶上时一接上更早的就整屏换成更早的内容（2026-10-26 实测）
    if (el.getBoundingClientRect().top >= viewTop && kids.length > 1) break;
    parent = el;
  }
  return picked ? { el: picked, rootIndex } : null;
}

/**
 * 挂在滚动容器上：滚动时记下锚点，内容尺寸一变（ResizeObserver，在绘制前）就把锚点挪回原处。
 * 内容根取滚动容器的第一个子元素。滚动容器要带 `[overflow-anchor:none]`。
 * `stickToBottom`：正贴着底部跟新消息时返回 true，内容变高就贴底（人刚点过除外，见 USER_SHIFT_MS）；
 * 那种情况锚住后调 `onUserShift`，调用方据此重算「还在不在底部」。
 */
export function useReadingAnchor(
  scrollRef: RefObject<HTMLElement | null>,
  opts: { stickToBottom?: () => boolean; onUserShift?: () => void } = {},
) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const attachedRef = useRef<{ scroller: HTMLElement; content: Element; off: () => void } | null>(null);

  // 滚动容器 / 内容根可能随状态换（空态与有对话是两种外形）：每次渲染核对一次，换了才重挂
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = scroller?.firstElementChild ?? null;
    const cur = attachedRef.current;
    if (cur && cur.scroller === scroller && cur.content === content) return;
    cur?.off();
    attachedRef.current = null;
    if (!scroller || !content) return;

    let anchor: { el: Element; top: number } | null = null;
    let hint = 0;
    let lastInputAt = Number.NEGATIVE_INFINITY;
    const viewTop = () => scroller.getBoundingClientRect().top + scroller.clientTop;
    const capture = () => {
      // 藏起来的标签量不出位置：留着上次的锚
      if (scroller.clientHeight === 0) return;
      const top = viewTop();
      const picked = pickAnchor(content, top, hint);
      if (!picked) {
        anchor = null;
        return;
      }
      hint = picked.rootIndex;
      anchor = { el: picked.el, top: picked.el.getBoundingClientRect().top - top };
    };
    const restore = () => {
      if (scroller.clientHeight === 0) return;
      const { stickToBottom, onUserShift } = optsRef.current;
      const userShift = performance.now() - lastInputAt < USER_SHIFT_MS;
      if (stickToBottom?.() && !userShift) {
        scroller.scrollTop = scroller.scrollHeight;
        capture();
        return;
      }
      const a = anchor;
      if (a && a.el.isConnected && content.contains(a.el)) {
        const r = a.el.getBoundingClientRect();
        const delta = r.top - viewTop() - a.top;
        if (r.height > 0 && Math.abs(delta) >= 0.5) scroller.scrollTop += delta;
      }
      capture();
      if (userShift) onUserShift?.();
    };
    const onInput = () => {
      lastInputAt = performance.now();
    };
    const ro = new ResizeObserver(restore);
    ro.observe(content);
    // 视口自己变高变矮（输入框长高、状态栏出现、窗口拉伸）内容不变，只看内容根时不会触发：跟底时也要贴回底部
    ro.observe(scroller);
    scroller.addEventListener("scroll", capture, { passive: true });
    scroller.addEventListener("pointerdown", onInput, { passive: true });
    scroller.addEventListener("keydown", onInput);
    capture();
    attachedRef.current = {
      scroller,
      content,
      off: () => {
        ro.disconnect();
        scroller.removeEventListener("scroll", capture);
        scroller.removeEventListener("pointerdown", onInput);
        scroller.removeEventListener("keydown", onInput);
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
}
