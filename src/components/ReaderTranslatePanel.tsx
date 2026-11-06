import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  clampReaderTlBall,
  clampReaderTlCard,
  loadReaderTlBall,
  loadReaderTlCard,
  parseBilingual,
  plainFromBilingual,
  readerTlBallOffset,
  readerTlWinPlace,
  READER_TL_BALL_SIZE,
  reflowBlockText,
  saveReaderTlBall,
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
 * 拖标题栏换位、拖右下角改大小（尺寸记住，双击复位）。有译文时 PDF 栏里常驻一颗 Mesa 图标样的「译」悬浮球
 * （同日用户：用悬浮球代替「—」小标记）：点球收起 / 展开浮窗，窗开着球也在；拖球换位记住（与窗的位置各管各的）；
 * × 彻底关掉（球一起收掉），PDF 顶栏「译文 N」重新打开（回到关掉时的位置与大小）。
 * 表头：译文 · 第 N 页 | 原文 | 存进笔记 | 复制 | ⋯（问这段 / 历史）| ×。
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
  light = false,
}: {
  /** open 开着 / min 收到悬浮球 / closed 关掉 */
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
  /** 浅色主题：悬浮球换浅色底板与深一档琥珀（同 Mesa 图标） */
  light?: boolean;
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

  /** 悬浮球位置（PDF 栏里的百分比，记 localStorage）；状态留在本组件，拖动不惊动 ReaderOverlay 整树 */
  const [ballPos, setBallPos] = useState(() => loadReaderTlBall());
  const ballPosRef = useRef(ballPos);
  ballPosRef.current = ballPos;
  const ballRef = useRef<HTMLButtonElement>(null);

  /** 覆盖层根的尺寸（摆位与钳制都按它算）；窗收着时借球找定位祖先 */
  function hostSize(): { width: number; height: number } | null {
    const host = (rootRef.current ?? ballRef.current)?.offsetParent as HTMLElement | null;
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

  /** 球的拖 / 点：4px 阈值内算点击（收起 ⇄ 展开），否则拖着走，松手记位置 */
  function onBallPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0 || !bounds) return;
    e.preventDefault();
    const host = hostSize();
    if (!host) return;
    const w = host.width - bounds.left - bounds.right;
    const h = host.height - (bounds.top ?? 0) - (bounds.bottom ?? 0);
    if (w <= 0 || h <= 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const start = ballPosRef.current;
    let last = start;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && dx * dx + dy * dy < 16) return;
      moved = true;
      last = clampReaderTlBall(start.xp + (dx / w) * 100, start.yp + (dy / h) * 100);
      setBallPos(last);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (moved) {
        saveReaderTlBall(last.xp, last.yp);
      } else {
        toggleOpen();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
  function toggleOpen() {
    setDrawerOpen(false);
    setMoreOpen(false);
    onMode(mode === "open" ? "min" : "open");
  }

  const ball =
    mode !== "closed" && hasContent && bounds ? (
      <ReaderTlBall
        ref={ballRef}
        light={light}
        open={mode === "open"}
        busy={pending?.phase === "loading"}
        page={(pending ?? current)?.page}
        onPointerDown={onBallPointerDown}
        onKey={toggleOpen}
        style={{
          left: readerTlBallOffset(ballPos.xp, bounds.left, bounds.left + bounds.right),
          top: readerTlBallOffset(ballPos.yp, bounds.top ?? 0, (bounds.top ?? 0) + (bounds.bottom ?? 0)),
        }}
      />
    ) : null;

  if (!visible || !bounds) return ball;

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
    <>
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
    {ball}
    </>
  );
}

/**
 * 「译」悬浮球：Mesa 图标的小号版——圆角底板（深色 #2b2d39→#17181f / 浅色 #fbf9f5→#ece7de）、顶上一道细高光边，
 * 中间「译」字、右下一道琥珀光标（深色 #f5b83d 带余辉 / 浅色 #e39a1c，同 src-tauri/icons/source/mesa-*.svg）。
 * 翻译在途时光标闪（减弱动态效果时常亮）；收着 / 开着靠 aria-expanded 与悬停提示说清，球本身不变形
 */
function ReaderTlBall({
  ref,
  light,
  open,
  busy,
  page,
  style,
  onPointerDown,
  onKey,
}: {
  ref: React.Ref<HTMLButtonElement>;
  light: boolean;
  open: boolean;
  busy: boolean;
  page?: number;
  style: React.CSSProperties;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onKey: () => void;
}) {
  const amber = light ? "#e39a1c" : "#f5b83d";
  const tip = `${open ? "收起译文" : "展开译文"}${page != null ? `（第 ${page} 页）` : ""}；拖着换位置`;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={open ? "收起译文" : "展开译文"}
      aria-expanded={open}
      title={tip}
      data-reader-translate-ball
      onPointerDown={onPointerDown}
      // 键盘：pointer 路径吃掉了鼠标点击，Enter / Space 走 onClick（detail = 0）
      onClick={(e) => {
        if (e.detail === 0) onKey();
      }}
      style={{
        ...style,
        width: READER_TL_BALL_SIZE,
        height: READER_TL_BALL_SIZE,
        borderRadius: Math.round(READER_TL_BALL_SIZE * 0.224),
        background: light
          ? "linear-gradient(180deg, #fbf9f5, #ece7de)"
          : "linear-gradient(180deg, #2b2d39, #17181f)",
        color: light ? "#22232f" : "#efebe4",
        boxShadow: light
          ? "inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 1px rgba(0,0,0,0.12), 0 3px 8px rgba(0,0,0,0.18)"
          : "inset 0 1px 0 rgba(255,255,255,0.16), 0 0 0 1px rgba(0,0,0,0.35), 0 3px 10px rgba(0,0,0,0.35)",
      }}
      className={`pointer-events-auto absolute z-31 flex -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none select-none items-baseline justify-center pt-[3px] text-sm font-semibold leading-none transition-opacity active:cursor-grabbing ${
        open ? "opacity-100" : "opacity-90 hover:opacity-100"
      }`}
    >
      <span aria-hidden="true">译</span>
      <span
        aria-hidden="true"
        className={`ml-[2px] inline-block h-[3px] w-[7px] ${busy ? "ccode-caret-blink" : ""}`}
        style={{ background: amber, boxShadow: light ? undefined : `0 0 5px ${amber}99` }}
      />
    </button>
  );
}

/** memo：父级（ReaderOverlay）重渲染不级联 */
export default memo(ReaderTranslatePanel);
