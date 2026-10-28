import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ConversationSegment } from "./conversation-tools";

/**
 * 对话只画看得见的那一段（2026-10-26 用户：要像别的客户端那样点了就出来）。
 *
 * 整段记录一次取齐之后（get_session_conversation_rest），几千条一次全画，开发构建要 270ms；VS Code 的聊天面板用虚拟列表，
 * 只画视野上下各一屏多，其余用两块占位撑出整段高度（没画过的按字数估高，画过的记下实高）。这里同样：
 * - 视野上下各留 1.5 屏（至少 800px）画出来，其余是上下两块占位；
 * - 往上翻接着画更早的那几段时，估高和实高差多少就从上方占位里扣多少——视野里的字不挪、也不写 scrollTop
 *  （WebKit 里滑动途中改 scrollTop 会打断惯性），只有翻到最顶时占位归零那一下可能需要补一次；
 * - 已画的窗口还盖得住视野上下各半屏多就不换，免得来回抖。
 * 少于 30 段的对话不虚拟化，结构和原来一样。
 */
export const VIRTUAL_MIN_SEGMENTS = 30;
/** 刚摆出来时先画末尾这么高（px，按估高） */
const INITIAL_TAIL_PX = 3000;

export type VirtualWindow = { start: number; end: number; topPad: number };

/** 按字数粗估一段的高度（px）；画过的用量出来的实高 */
export function estimateSegmentHeight(seg: ConversationSegment): number {
  const lines = (text: string) =>
    text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 48)), 0);
  const textLines = (blocks: { kind: string; text: string }[]) =>
    blocks.filter((b) => b.kind === "text").reduce((n, b) => n + lines(b.text), 0);
  if (seg.kind === "message") {
    const m = seg.message;
    if (m.blocks.length > 0 && m.blocks.every((b) => b.kind === "command" || b.kind === "command_output")) return 40;
    // 用户长消息收起到约 12 行
    if (m.role === "user") return 44 + 22 * Math.min(12, Math.max(1, textLines(m.blocks)));
    return 28 + 24 * Math.max(1, textLines(m.blocks));
  }
  return 40 + (seg.answer ? 28 + 24 * Math.max(1, textLines(seg.answer.blocks)) : 0) + (seg.live ? seg.items.length * 26 : 0);
}

/** 刚摆出来：画末尾一段（有要钉住的下标就画它附近） */
export function initialWindow(count: number, height: (i: number) => number, pin = -1): VirtualWindow {
  if (count === 0) return { start: 0, end: 0, topPad: 0 };
  let start: number;
  let end: number;
  if (pin >= 0 && pin < count) {
    start = Math.max(0, pin - 12);
    end = Math.min(count, pin + 13);
  } else {
    end = count;
    start = count;
    let px = 0;
    while (start > 0 && px < INITIAL_TAIL_PX) px += height(--start);
  }
  let topPad = 0;
  for (let i = 0; i < start; i++) topPad += height(i);
  return { start, end, topPad };
}

/**
 * 视野在哪就画哪一段。`height(i)`：已画的给实高，没画的给估高。
 * 往上接画时 topPad 先不动：新画的几段让内容整体先变高（不会变矮，滚动位置就不会被浏览器压回去、也不发 scroll 事件），
 * 画出来之后调用方按锚点量出新画那几段的实高，从 topPad 里一次扣掉。往下收掉上面几段时 topPad 加上它们的实高（精确）。
 */
export function planWindow(p: {
  count: number;
  win: VirtualWindow;
  height: (i: number) => number;
  viewTop: number;
  viewBottom: number;
  over: number;
  pin: number;
}): VirtualWindow {
  const { count, win, height } = p;
  if (count === 0) return { start: 0, end: 0, topPad: 0 };
  const start = Math.min(win.start, count);
  const y = new Array<number>(count + 1);
  y[start] = win.topPad;
  for (let i = start - 1; i >= 0; i--) y[i] = y[i + 1] - height(i);
  for (let i = start; i < count; i++) y[i + 1] = y[i] + height(i);
  const lo = p.viewTop - p.over;
  const hi = p.viewBottom + p.over;
  let a = 0;
  while (a < count - 1 && y[a + 1] <= lo) a++;
  let b = a;
  while (b < count && y[b] < hi) b++;
  b = Math.max(b, a + 1);
  if (p.pin >= 0 && p.pin < count) {
    a = Math.min(a, p.pin);
    b = Math.max(b, p.pin + 1);
  }
  if (a < start) return { start: a, end: b, topPad: win.topPad };
  return { start: a, end: b, topPad: a === 0 ? 0 : Math.max(0, y[a]) };
}

/**
 * 跟着底部时的窗口：只画末尾、往上画够 `cover`（px），上方整段用占位。
 * 跟底时视野总在最底下，按视野挪窗口反而会来回换：刚贴到底就换成末尾几段，估高和实高一差，
 * 内容总高一变、位置被夹回中间，又换回中间那段……（2026-10-28 本机实录：点「回到最新」、发出一句都停在半中间）
 */
export function tailWindow(count: number, height: (i: number) => number, cover: number): VirtualWindow {
  if (count === 0) return { start: 0, end: 0, topPad: 0 };
  let start = count;
  let px = 0;
  while (start > 0 && px < cover) px += height(--start);
  let topPad = 0;
  for (let i = 0; i < start; i++) topPad += height(i);
  return { start, end: count, topPad };
}

/** 现有窗口还盖得住视野上下各半个余量：不换（防抖） */
export function windowCovers(p: {
  count: number;
  win: VirtualWindow;
  renderedHeight: number;
  viewTop: number;
  viewBottom: number;
  over: number;
}): boolean {
  const topOk = p.win.start === 0 || p.win.topPad <= p.viewTop - p.over / 2;
  const bottomOk = p.win.end >= p.count || p.win.topPad + p.renderedHeight >= p.viewBottom + p.over / 2;
  return topOk && bottomOk;
}

/** 列表换了（新消息、接上更早的、重分组）：按 key 把窗口挪到新下标；对不上就从末尾重来 */
export function remapWindow(
  oldKeys: readonly string[],
  newKeys: readonly string[],
  win: VirtualWindow,
  height: (i: number) => number,
  oldHeight: (key: string) => number,
  pin = -1,
): VirtualWindow {
  if (newKeys.length === 0) return { start: 0, end: 0, topPad: 0 };
  const startKey = oldKeys[win.start];
  const ns = startKey === undefined ? -1 : newKeys.indexOf(startKey);
  if (ns < 0) return initialWindow(newKeys.length, height, pin);
  const atTail = win.end >= oldKeys.length;
  const endKey = oldKeys[win.end - 1];
  const ne = atTail ? newKeys.length : Math.max(ns + 1, (endKey === undefined ? -1 : newKeys.indexOf(endKey)) + 1);
  // 窗口上方：新冒出来的按估高加进占位，没了的按原高扣掉（对得上的不动，占位原样保留）
  const before = new Set(oldKeys.slice(0, win.start));
  const now = new Set(newKeys.slice(0, ns));
  let topPad = win.topPad;
  for (let i = 0; i < ns; i++) if (!before.has(newKeys[i])) topPad += height(i);
  for (const key of before) if (!now.has(key)) topPad -= oldHeight(key);
  const next = { start: ns, end: Math.min(newKeys.length, ne), topPad: ns === 0 ? 0 : Math.max(0, topPad) };
  // 要钉住的那一段（换了一页搜索命中）不在窗口里：围着它重来
  if (pin >= 0 && pin < newKeys.length && (pin < next.start || pin >= next.end)) {
    return initialWindow(newKeys.length, height, pin);
  }
  return next;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null;
  while (cur) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === "auto" || oy === "scroll") return cur;
    cur = cur.parentElement;
  }
  return null;
}

/** 两块占位之间画着的那些段（每段一个根元素） */
function renderedElements(top: HTMLElement, bottom: HTMLElement | null): HTMLElement[] {
  const out: HTMLElement[] = [];
  let cur = top.nextElementSibling as HTMLElement | null;
  while (cur && cur !== bottom) {
    out.push(cur);
    cur = cur.nextElementSibling as HTMLElement | null;
  }
  return out;
}

export function useVirtualWindow(opts: {
  keys: string[];
  estimate: (i: number) => number;
  /** 必须画出来的那一段（搜索命中），-1 没有 */
  pin: number;
  /** 正跟着底部：窗口钉在末尾（tailWindow），不按视野挪 */
  stickToTail?: () => boolean;
}): {
  enabled: boolean;
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
  topRef: RefObject<HTMLDivElement | null>;
  bottomRef: RefObject<HTMLDivElement | null>;
} {
  const { keys, pin } = opts;
  const count = keys.length;
  const enabled = count >= VIRTUAL_MIN_SEGMENTS;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const measured = useRef(new Map<string, number>());
  const ratio = useRef(1);
  const topRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const pendingAnchor = useRef<{ key: string; offset: number } | null>(null);
  const height = (i: number) =>
    measured.current.get(optsRef.current.keys[i]) ?? optsRef.current.estimate(i) * ratio.current;

  const [win, setWin] = useState<VirtualWindow>(() => initialWindow(count, height, pin));
  const [prevKeys, setPrevKeys] = useState(keys);
  const [prevPin, setPrevPin] = useState(pin);
  let current = win;
  if (prevKeys !== keys || prevPin !== pin) {
    // 渲染期间按新列表挪窗口（React「根据 props 调整 state」写法）
    current = enabled ? remapWindow(prevKeys, keys, win, height, (k) => measured.current.get(k) ?? 0, pin) : win;
    setPrevKeys(keys);
    setPrevPin(pin);
    setWin(current);
  }
  const winRef = useRef(current);
  winRef.current = current;

  const recompute = useCallback(() => {
    const sc = scrollerRef.current;
    const top = topRef.current;
    // 藏起来时（切到终端层 / 别的标签，display:none）量出来全是 0：不按它挪窗口，否则会换到最上面那几段
    if (!sc || !top || !optsRef.current.keys.length || sc.clientHeight === 0) return;
    const k = optsRef.current.keys;
    const w = winRef.current;
    if (optsRef.current.pin < 0 && optsRef.current.stickToTail?.()) {
      const next = tailWindow(k.length, height, Math.max(800, sc.clientHeight * 2.5));
      if (next.start !== w.start || next.end !== w.end || Math.abs(next.topPad - w.topPad) >= 0.5) setWin(next);
      return;
    }
    const scTop = sc.getBoundingClientRect().top;
    const topY = top.getBoundingClientRect().top;
    const viewTop = scTop - topY;
    const viewBottom = viewTop + sc.clientHeight;
    const over = Math.max(800, sc.clientHeight * 1.5);
    const els = renderedElements(top, bottomRef.current);
    const tops = els.map((el) => el.getBoundingClientRect().top);
    const bottomY = bottomRef.current?.getBoundingClientRect().top ?? topY;
    const live = (i: number) => {
      const j = i - w.start;
      if (j < 0 || j >= els.length) return null;
      return (j + 1 < tops.length ? tops[j + 1] : bottomY) - tops[j];
    };
    const renderedHeight = bottomY - topY - w.topPad;
    if (windowCovers({ count: k.length, win: w, renderedHeight, viewTop, viewBottom, over })) return;
    const next = planWindow({
      count: k.length,
      win: w,
      height: (i) => live(i) ?? height(i),
      viewTop,
      viewBottom,
      over,
      pin: optsRef.current.pin,
    });
    if (next.start === w.start && next.end === w.end) return;
    // 锚：新旧窗口都画着的第一段，换完之后它的位置差多少就从上方占位里扣
    const keep = Math.max(w.start, next.start);
    if (keep < Math.min(w.end, next.end) && keep - w.start < els.length) {
      pendingAnchor.current = { key: k[keep], offset: tops[keep - w.start] - topY };
    }
    setWin(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每次画完：量实高、学估高比例，按锚点把上方占位校正到「视野里的字不挪」
  useLayoutEffect(() => {
    if (!enabled) return;
    const top = topRef.current;
    if (!top) return;
    if (!scrollerRef.current) scrollerRef.current = scrollParent(top);
    // 藏起来时量不出实高（全是 0）：不记，免得把估高冲成 0
    if (scrollerRef.current && scrollerRef.current.clientHeight === 0) return;
    const k = optsRef.current.keys;
    const w = winRef.current;
    const els = renderedElements(top, bottomRef.current);
    const bottomY = bottomRef.current?.getBoundingClientRect().top ?? 0;
    const tops = els.map((el) => el.getBoundingClientRect().top);
    let est = 0;
    let real = 0;
    for (let j = 0; j < els.length; j++) {
      const h = (j + 1 < tops.length ? tops[j + 1] : bottomY) - tops[j];
      const key = k[w.start + j];
      if (key === undefined) continue;
      measured.current.set(key, h);
      est += optsRef.current.estimate(w.start + j);
      real += h;
    }
    if (est > 0) ratio.current = Math.min(3, Math.max(0.3, real / est));
    const a = pendingAnchor.current;
    pendingAnchor.current = null;
    let pad = w.topPad;
    if (a) {
      const idx = k.indexOf(a.key);
      if (idx >= w.start && idx - w.start < els.length) {
        pad -= tops[idx - w.start] - top.getBoundingClientRect().top - a.offset;
      }
    }
    // 画到了第一段：上方不该再有占位（估高的余差这一下由阅读锚点补回）
    pad = w.start === 0 ? 0 : Math.max(0, pad);
    if (Math.abs(pad - w.topPad) >= 0.5) {
      setWin((cur) => ({ ...cur, topPad: pad }));
      return;
    }
    // 窗口还没盖住视野（刚换列表、窗口尺寸变了）：再算一次
    recompute();
  });

  useEffect(() => {
    if (!enabled) return;
    const sc = scrollerRef.current ?? scrollParent(topRef.current);
    scrollerRef.current = sc;
    if (!sc) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
    ro?.observe(sc);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, recompute]);

  if (!enabled) {
    return { enabled, start: 0, end: count, topPad: 0, bottomPad: 0, topRef, bottomRef };
  }
  let bottomPad = 0;
  for (let i = current.end; i < count; i++) bottomPad += height(i);
  return {
    enabled,
    start: current.start,
    end: Math.min(current.end, count),
    topPad: current.topPad,
    bottomPad,
    topRef,
    bottomRef,
  };
}
