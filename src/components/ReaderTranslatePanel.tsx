import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  clampReaderTlCard,
  loadReaderTlCard,
  parseBilingual,
  plainFromBilingual,
  readerTlWinPlace,
  reflowBlockText,
  saveReaderTlCard,
  type ReaderPdfBounds,
  type TlHistoryEntry,
} from "../reader";

/** 在途翻译（ReaderOverlay 持有并下传）：loading 在途 / error 可重试 */
export interface TlPending {
  text: string;
  page: number;
  phase: "loading" | "error";
  error?: string;
}

/** 摆位请求：新翻译时上层量到原文段（或划词选区）的外框，换 key 就把窗挪到它旁边 */
export interface TlPlace {
  key: string;
  rect: { top: number; bottom: number; left: number; right: number } | null;
}

/** 抽屉摘要与「复制」都用纯译文：bilingual 模式下线前存的旧条目带「原：/译：」
 *  标记，经兼容 shim（parseBilingual/plainFromBilingual，reader.ts）转纯译文；
 *  新条目本就是纯译文，不会命中 */
function plainTextOf(e: TlHistoryEntry): string {
  const pairs = parseBilingual(e.translated);
  return pairs ? plainFromBilingual(pairs) : e.translated;
}

const DEFAULT_W = 416;
const EST_H = 240;

/**
 * 沉浸阅读的译文浮窗（2026-11-06 用户选「只留浮窗」，取代右栏原位 + 「译」悬浮球两种摆法）：
 * 和对照窗一个样——挂覆盖层根，只在 PDF 栏里活动；划词翻译时摆到原文段下方（放不下放上方，不压原文段），
 * 拖标题栏换位、拖右下角改大小（尺寸记住，双击复位）；「—」收成原位的小标记「译 · 第 N 页」（点它原处展开、拖它换位，
 * 同日用户：没有悬浮球就收不起来了，要留一个标记）；× 彻底关掉，PDF 顶栏「译文 N」重新打开（都回到关掉时的位置与大小）。
 * 表头：译文 · 第 N 页 | 原文 | 存进笔记 | 复制 | ⋯（问这段 / 历史）| — | ×。
 * 状态（历史 / 在途 / 开关）由 ReaderOverlay 持有，本组件只管位置、尺寸与面板内 UI 态。
 */
function ReaderTranslatePanel({
  mode,
  onMode,
  latest,
  pending,
  history,
  saving,
  canSave,
  bounds,
  place,
  onRetry,
  onCancelPending,
  onSaveEntry,
  onHint,
  onAsk,
  canAsk,
  onDisplay,
}: {
  /** open 开着 / min 收成小标记 / closed 关掉 */
  mode: "open" | "min" | "closed";
  onMode: (mode: "open" | "min" | "closed") => void;
  /** 最新历史条目（无历史且在途翻译时为 null） */
  latest: TlHistoryEntry | null;
  pending: TlPending | null;
  /** 全量历史（抽屉用，新条目在上） */
  history: readonly TlHistoryEntry[];
  saving: boolean;
  /** onSaveTranslation 链路是否可用 */
  canSave: boolean;
  /** PDF 栏离覆盖层四边的 px：浮窗只在 PDF 栏里，不盖笔记栏和对话栏；量到前不出窗 */
  bounds?: ReaderPdfBounds;
  /** 新翻译的摆位请求（见 TlPlace） */
  place?: TlPlace | null;
  /** 失败重试（回放上次的 text/page） */
  onRetry: (text: string, page: number) => void;
  /** × 时作废在途翻译（上层递增请求序号，迟到的结果直接丢弃） */
  onCancelPending: () => void;
  onSaveEntry: (entry: TlHistoryEntry) => void;
  /** 轻反馈（复制结果等；上层接 toast） */
  onHint: (msg: string) => void;
  /** 把当前译文放进对话的输入框，不发送 */
  onAsk?: (entry: TlHistoryEntry) => void;
  canAsk?: boolean;
  /** 窗里此刻摆出来的那条译文（关掉 / 在途 / 卸载 = null）：上层据此在 PDF 上标出它的原文段 */
  onDisplay?: (entry: TlHistoryEntry | null) => void;
}) {
  /** 原文显隐：窗就在原文段旁，默认只看译文；点「原文」临时对照 */
  const [showOriginal, setShowOriginal] = useState(false);
  /** 正在查看的条目（历史抽屉点行载入；null = 跟随最新，新翻译进来自动回最新） */
  const [viewingAt, setViewingAt] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 窗左上角（覆盖层根坐标 px）；null = 还没摆过（第一次出现时按摆位请求或 PDF 栏右上角摆） */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;
  /** 显式尺寸：拖过右下角后记住（null = 宽 26rem、高按内容自适应） */
  const [cardSize, setCardSize] = useState(() => loadReaderTlCard());
  const cardSizeRef = useRef(cardSize);
  cardSizeRef.current = cardSize;

  const current = viewingAt ? (history.find((e) => e.at === viewingAt) ?? latest) : latest;
  const hasContent = current !== null || pending !== null;
  const visible = mode === "open" && hasContent && bounds !== undefined;

  // 新翻译进来（在途开始 / 新条目落地）回到最新条
  const latestAt = latest?.at ?? null;
  useEffect(() => {
    setViewingAt(null);
  }, [latestAt, pending]);

  /** 覆盖层根的尺寸（摆位与钳制都按它算） */
  function hostSize(): { width: number; height: number } | null {
    const host = rootRef.current?.offsetParent as HTMLElement | null;
    if (!host) return null;
    const r = host.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }
  function winSize(): { w: number; h: number } {
    const r = rootRef.current?.getBoundingClientRect();
    return {
      w: r?.width || cardSizeRef.current?.w || DEFAULT_W,
      h: r?.height || cardSizeRef.current?.h || EST_H,
    };
  }

  // 摆位：新的摆位请求（换 key）→ 挪到原文段旁；第一次出现还没位置 → 按请求或 PDF 栏右上角摆
  const placedKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!visible || !bounds) return;
    const host = hostSize();
    if (!host) return;
    const fresh = place && place.key !== placedKeyRef.current;
    if (!fresh && posRef.current) return;
    if (place) placedKeyRef.current = place.key;
    setPos(readerTlWinPlace(place?.rect ?? null, bounds, host, winSize()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, place?.key, bounds]);

  // PDF 栏变窄 / 窗口变小：把窗收回 PDF 栏里
  useEffect(() => {
    if (!visible || !bounds || !posRef.current) return;
    const host = hostSize();
    if (!host) return;
    const s = winSize();
    const L = bounds.left + 8;
    const R = host.width - bounds.right - 8;
    const T = (bounds.top ?? 0) + 8;
    const B = host.height - (bounds.bottom ?? 0) - 8;
    const p = posRef.current;
    const x = Math.max(L, Math.min(p.x, R - s.w));
    const y = Math.max(T, Math.min(p.y, B - Math.min(s.h, B - T)));
    if (x !== p.x || y !== p.y) setPos({ x, y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, visible]);

  /** 拖标题栏换位：4px 阈值内不算拖，钳在 PDF 栏里 */
  function startMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !bounds || !posRef.current) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const host = hostSize();
    if (!host) return;
    const s = winSize();
    const start = posRef.current;
    const sx = e.clientX;
    const sy = e.clientY;
    const L = bounds.left + 8;
    const R = host.width - bounds.right - 8;
    const T = (bounds.top ?? 0) + 8;
    const B = host.height - (bounds.bottom ?? 0) - 8;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && dx * dx + dy * dy < 16) return;
      moved = true;
      setPos({
        x: Math.max(L, Math.min(start.x + dx, R - s.w)),
        y: Math.max(T, Math.min(start.y + dy, B - 40)),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /** 拖右下角改大小：钳在 PDF 栏余下的空间里，松手落键记住 */
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !bounds || !posRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const host = hostSize();
    const r = rootRef.current?.getBoundingClientRect();
    if (!host || !r) return;
    const p = posRef.current;
    const maxW = host.width - bounds.right - 8 - p.x;
    const maxH = host.height - (bounds.bottom ?? 0) - 8 - p.y;
    const base = { w: Math.round(r.width), h: Math.round(r.height) };
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && dx * dx + dy * dy < 16) return;
      moved = true;
      setCardSize(clampReaderTlCard(base.w + dx, base.h + dy, maxW, maxH));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (moved && cardSizeRef.current) saveReaderTlCard(cardSizeRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // 告诉上层窗里摆着哪条（PDF 上标它的原文段）；关掉 / 卸载时撤掉
  const displayed = visible && !pending ? current : null;
  const displayedAt = displayed?.at ?? null;
  const onDisplayRef = useRef(onDisplay);
  onDisplayRef.current = onDisplay;
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;
  useEffect(() => {
    onDisplayRef.current?.(displayedRef.current);
  }, [displayedAt]);
  useEffect(() => () => onDisplayRef.current?.(null), []);

  // ⋯ 菜单与历史抽屉：Esc（capture 抢在关阅读区之前）/ 点外关闭
  useEffect(() => {
    if (!moreOpen && !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      setMoreOpen(false);
      setDrawerOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (moreOpen && !moreRef.current?.contains(t)) setMoreOpen(false);
      if (drawerOpen && !rootRef.current?.contains(t)) setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [moreOpen, drawerOpen]);

  /** 正文下面还有没露出来的：窗底渐隐，别把一行拦腰切断还看不出下面有字 */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) {
      setMoreBelow(false);
      return;
    }
    const check = () => setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, [displayedAt, showOriginal, pending, visible]);

  /** 小标记：拖着换位（窗再展开就在这儿），没拖动算点击 = 原处展开 */
  function startMarker(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !bounds || !posRef.current) return;
    e.preventDefault();
    const host = hostSize();
    if (!host) return;
    const start = posRef.current;
    const sx = e.clientX;
    const sy = e.clientY;
    const L = bounds.left + 8;
    const R = host.width - bounds.right - 8;
    const T = (bounds.top ?? 0) + 8;
    const B = host.height - (bounds.bottom ?? 0) - 8;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && dx * dx + dy * dy < 16) return;
      moved = true;
      setPos({ x: Math.max(L, Math.min(start.x + dx, R - 96)), y: Math.max(T, Math.min(start.y + dy, B - 28)) });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!moved) onMode("open");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  if (mode === "min" && hasContent && bounds && pos) {
    const p = (pending ?? current)?.page;
    return (
      <div
        // 同用 rootRef：拖标记要按覆盖层根（offsetParent）算范围，收着时窗不在
        ref={rootRef}
        role="button"
        tabIndex={0}
        aria-label="展开译文"
        data-reader-translate-marker
        title="点一下展开译文；拖着换位置"
        onPointerDown={startMarker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onMode("open");
          }
        }}
        style={{ left: pos.x, top: pos.y }}
        className="ccode-float-surface pointer-events-auto absolute z-30 flex h-7 cursor-grab touch-none select-none items-center gap-1 rounded-full border border-field px-2.5 text-micro text-l2 shadow-md hover:text-l1 active:cursor-grabbing"
      >
        {pending?.phase === "loading" ? <span className="inline-block animate-spin">◌</span> : <span className="font-medium">译</span>}
        {p != null && <span className="text-l4">第 {p} 页</span>}
      </div>
    );
  }
  if (!visible || !bounds) return null;

  const bB = bounds.bottom ?? 0;
  const style: React.CSSProperties = pos
    ? {
        left: pos.x,
        top: pos.y,
        width: `min(${cardSize?.w ?? DEFAULT_W}px, calc(100% - ${pos.x + bounds.right + 8}px))`,
        ...(cardSize
          ? { height: `min(${cardSize.h}px, calc(100% - ${pos.y + bB + 8}px))` }
          : { maxHeight: `min(60%, calc(100% - ${pos.y + bB + 8}px))` }),
      }
    : // 第一帧还没摆：先量尺寸，不露出来
      { left: 0, top: 0, width: cardSize?.w ?? DEFAULT_W, visibility: "hidden" };
  const page = (pending ?? current)?.page;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="译文"
      data-reader-translate
      style={style}
      className="ccode-float-surface pointer-events-auto absolute z-30 flex flex-col rounded-lg border border-field shadow-lg"
    >
      {/* 表头 = 拖动把手；允许折行（窗被拖窄时动作钮折成两行，比挤出头干净） */}
      <div
        onPointerDown={startMove}
        title="拖动换位置"
        className="flex min-h-8 shrink-0 cursor-grab flex-wrap items-center gap-1 rounded-t-[7px] border-b border-hairline bg-strip px-2 py-1 text-micro active:cursor-grabbing"
      >
        <span className="flex select-none items-center gap-1 px-1 text-l2">
          <span>译文</span>
          {page != null && <span className="text-l4">第 {page} 页</span>}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {!pending && current && (
            <>
              <button
                type="button"
                onClick={() => setShowOriginal((v) => !v)}
                className={`rounded-sm px-1.5 py-0.5 ${
                  showOriginal ? "bg-seg-sel text-l1" : "text-l3 hover:bg-hover hover:text-l1"
                }`}
              >
                原文
              </button>
              {canSave && (
                <button
                  type="button"
                  disabled={current.saved || saving}
                  onClick={() => onSaveEntry(current)}
                  className="rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                >
                  {current.saved ? "✓ 已存" : "存进笔记"}
                </button>
              )}
              <button
                type="button"
                aria-label="复制译文"
                title="复制译文"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(reflowBlockText(plainTextOf(current), { cjk: true }))
                    .then(() => onHint("已复制译文"))
                    .catch(() => onHint("复制失败"))
                }
                className="flex h-5 w-5 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="5" y="5" width="9" height="9" rx="1.5" />
                  <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
                </svg>
              </button>
            </>
          )}
          <div ref={moreRef} className="relative">
            <button
              type="button"
              aria-label="更多"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
              className={`flex h-5 w-6 items-center justify-center rounded-sm ${
                moreOpen || drawerOpen ? "bg-seg-sel text-l1" : "text-l3 hover:bg-hover hover:text-l1"
              }`}
            >
              ⋯
            </button>
            {moreOpen && (
              <div className="ccode-float-surface absolute right-0 top-full z-40 mt-1 flex min-w-[8rem] flex-col rounded-md border border-field py-1 text-xs">
                {onAsk && current && !pending && (
                  <button
                    type="button"
                    disabled={!canAsk}
                    title={canAsk ? "放进右边对话的输入框，不发送" : "对话还没准备好"}
                    onClick={() => {
                      setMoreOpen(false);
                      onAsk(current);
                    }}
                    className="px-3 py-1.5 text-left text-l2 hover:bg-hover hover:text-l1 disabled:opacity-40"
                  >
                    问这段
                  </button>
                )}
                <button
                  type="button"
                  disabled={history.length === 0}
                  onClick={() => {
                    setMoreOpen(false);
                    setDrawerOpen(true);
                  }}
                  className="px-3 py-1.5 text-left text-l2 hover:bg-hover hover:text-l1 disabled:opacity-40"
                >
                  历史（{history.length}）
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="收起译文"
            title="收起成小标记（点它在原处展开）"
            onClick={() => {
              setDrawerOpen(false);
              setMoreOpen(false);
              onMode("min");
            }}
            className="flex h-5 w-5 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1"
          >
            —
          </button>
          <button
            type="button"
            aria-label="关掉译文"
            title="关掉（PDF 顶栏「译文」可再打开）"
            onClick={() => {
              onCancelPending();
              setDrawerOpen(false);
              setMoreOpen(false);
              onMode("closed");
            }}
            className="flex h-5 w-5 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1"
          >
            ×
          </button>
        </div>
      </div>
      {drawerOpen ? (
        // 历史：替换窗里的正文区（新条目在上），点行载入该条；不另弹浮层，不会探出窗外
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center border-b border-hairline px-3 py-1.5 text-micro text-l3">
            <span>本篇的翻译</span>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="ml-auto rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
            >
              返回
            </button>
          </div>
          <ul className="min-h-0 flex-1 overflow-auto py-1">
            {history.map((e) => (
              <li key={`${e.at}@${e.page}`} className="px-2.5 py-1.5 hover:bg-hover">
                <button
                  type="button"
                  onClick={() => {
                    setViewingAt(e.at);
                    setDrawerOpen(false);
                  }}
                  className="block w-full text-left"
                >
                  <span className="text-micro text-l4">第 {e.page} 页</span>
                  <span className="line-clamp-2 text-xs leading-4 text-l2">
                    {reflowBlockText(plainTextOf(e), { cjk: true })}
                  </span>
                </button>
                {canSave && (
                  <div className="mt-0.5 flex justify-end">
                    <button
                      type="button"
                      disabled={e.saved || saving}
                      onClick={() => onSaveEntry(e)}
                      className="rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                    >
                      {e.saved ? "✓ 已存" : "存进笔记"}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div
          ref={scrollerRef}
          // 下面还有字时窗底渐隐：一眼看出没完
          style={
            moreBelow
              ? {
                  maskImage: "linear-gradient(to bottom, black calc(100% - 28px), transparent)",
                  WebkitMaskImage: "linear-gradient(to bottom, black calc(100% - 28px), transparent)",
                }
              : undefined
          }
          className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3"
        >
          {pending ? (
            pending.phase === "loading" ? (
              <p className="pt-2 text-xs text-l3">
                <span className="inline-block animate-spin">◌</span> 正在翻译…
              </p>
            ) : (
              <div className="flex items-center gap-2 pt-2">
                <span className="min-w-0 flex-1 truncate text-xs text-err-text">翻译失败：{pending.error}</span>
                <button
                  type="button"
                  onClick={() => onRetry(pending.text, pending.page)}
                  className="shrink-0 rounded-sm border border-field bg-strip px-2 py-0.5 text-xs text-l2 hover:bg-inset hover:text-l1"
                >
                  重试
                </button>
              </div>
            )
          ) : (
            current && (
              <>
                {showOriginal && (
                  <p className="whitespace-pre-line pt-2 text-justify text-xs leading-5 text-l4">
                    {reflowBlockText(current.original, { cjk: false })}
                  </p>
                )}
                <p
                  // 行高写内联：工作台给 .text-xs 的 1.15rem 不在 layer 里，leading-* 压不过它，中文挤成一团
                  style={{ lineHeight: 1.7 }}
                  className="mt-1.5 whitespace-pre-line text-justify text-xs text-l1"
                >
                  {reflowBlockText(plainTextOf(current), { cjk: true })}
                </p>
              </>
            )
          )}
        </div>
      )}
      {/* 右下角柄：拖 = 改大小（记住），双击复位内容自适应 */}
      <div
        onPointerDown={startResize}
        onDoubleClick={() => {
          setCardSize(null);
          saveReaderTlCard(null);
        }}
        title="拖动改大小，双击恢复"
        className="group absolute bottom-0 right-0 z-10 flex size-4 translate-x-1/2 translate-y-1/2 cursor-nwse-resize touch-none items-center justify-center"
      >
        <span
          className="size-2.5 opacity-50 transition-opacity group-hover:opacity-100"
          style={{ background: "repeating-linear-gradient(45deg, transparent 0 2px, var(--color-l4) 2px 3px)" }}
        />
      </div>
    </div>
  );
}

/** memo：父级（ReaderOverlay）重渲染不级联 */
export default memo(ReaderTranslatePanel);
