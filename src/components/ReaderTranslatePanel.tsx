import { memo, useEffect, useRef, useState } from "react";
import {
  clampReaderTlCard,
  clampReaderTlPct,
  loadReaderTlCard,
  parseBilingual,
  plainFromBilingual,
  reflowBlockText,
  saveReaderTlCard,
  type TlHistoryEntry,
} from "../reader";
import { FoldMark } from "./PageFrame";

/** 在途翻译（ReaderOverlay 持有并下传）：loading 在途 / error 可重试 */
export interface TlPending {
  text: string;
  page: number;
  phase: "loading" | "error";
  error?: string;
}

/** 抽屉摘要与「复制」都用纯译文：bilingual 模式下线前存的旧条目带「原：/译：」
 *  标记，经兼容 shim（parseBilingual/plainFromBilingual，reader.ts）转纯译文；
 *  新条目本就是纯译文，不会命中 */
function plainTextOf(e: TlHistoryEntry): string {
  const pairs = parseBilingual(e.translated);
  return pairs ? plainFromBilingual(pairs) : e.translated;
}

/**
 * 阅读区翻译面板，两种摆位（表头「钉住/回栏」切换，状态由上层持有）：
 * 原位 = 右栏状态行之下、xterm 之上（占布局流，% 高度/底缘拖拽只在这档有意义）；
 * 悬浮 = 锚在「译」悬浮球旁（ReaderTlFloat 持球拖位）：absolute 定位、60% 封顶自适应、
 * 历史抽屉按球位上下弹、× 直接收回球（不走「一行动作条」退场——那是原位档的形态）。
 * 上下结构——表头行（chevron 收起/展开 +「译 · 第 N 页」+ 原文显隐/钉位/存进笔记/复制/历史/×），
 * 之下块级对照正文（原文整段弱色小字在上可隐藏、译文整段正文在下，均两端对齐；
 * 悬浮档默认只看译文求紧凑，点「原文」临时对照）。
 * 历史抽屉点行 = 载入主面板（viewingAt，新翻译进来自动回最新）。
 * 状态（历史/pending）由 ReaderOverlay 持有，本组件只管呈现与面板内 UI 态
 * （chevron 收起 / × 收起 / 查看条目 / 抽屉开关）。
 */
function ReaderTranslatePanel({
  latest,
  pending,
  history,
  saving,
  canSave,
  heightPct,
  floatAnchor,
  onTogglePlacement,
  onClose,
  onResize,
  onResizeEnd,
  onResizeReset,
  onRetry,
  onCancelPending,
  onSaveEntry,
  onHint,
  onAsk,
  canAsk,
}: {
  /** 最新历史条目（无历史且在途翻译时为 null） */
  latest: TlHistoryEntry | null;
  pending: TlPending | null;
  /** 全量历史（抽屉用，新条目在上） */
  history: readonly TlHistoryEntry[];
  saving: boolean;
  /** onSaveTranslation 链路是否可用 */
  canSave: boolean;
  /** 面板高度（% 右栏总高）：null = 内容自适应（40% 封顶）；拖过底缘分割条后由上层记忆。
   *  悬浮档恒按内容自适应，上层传 null */
  heightPct: number | null;
  /** 悬浮档锚点（悬浮球在 PDF 栏内的百分比坐标，球心）：传入即悬浮形态——卡在球旁
   *  展开（球在右半区贴球左侧展开、左半区贴右侧），宽 ≤26rem、高 60% 封顶贴边钳制 */
  floatAnchor?: { xp: number; yp: number };
  /** 表头「钉住/回栏」；不传则不出现该钮（未接线的占位用法） */
  onTogglePlacement?: () => void;
  /** 悬浮档的 ×：收回球（由球组件接管）；不传则 × 走原位档的「一行动作条」退场 */
  onClose?: () => void;
  /** 拖动中实时回调（同右栏竖分割条口径：move 只更新 state） */
  onResize: (pct: number) => void;
  /** 松手落持久化 */
  onResizeEnd: (pct: number) => void;
  /** 双击分割条复位内容自适应（清记忆键） */
  onResizeReset: () => void;
  /** 失败重试（回放上次的 text/page） */
  onRetry: (text: string, page: number) => void;
  /** × 时作废在途翻译（上层递增请求序号，迟到的结果直接丢弃） */
  onCancelPending: () => void;
  onSaveEntry: (entry: TlHistoryEntry) => void;
  /** 轻反馈（复制结果等；上层接 toast） */
  onHint: (msg: string) => void;
  /** 把当前译文放进下方对话的输入行，不发送。 */
  onAsk?: (entry: TlHistoryEntry) => void;
  canAsk?: boolean;
}) {
  const floating = floatAnchor != null;
  /** chevron 收起：只折正文区、表头常驻（与「×」区分：× = 面板整体消失、新翻译再回来）。
      组件内 state 不持久化 */
  const [collapsed, setCollapsed] = useState(false);
  /** 原文显隐：原位档默认对照（右栏里对照着读），悬浮档默认只看译文（球旁求紧凑） */
  const [showOriginal, setShowOriginal] = useState(!floating);
  /** 「×」收起 = 记下当时显示条的 at：本轮不再弹出，新翻译进来（at 变）自动回来；
      收起态仍留一行动作条，历史抽屉随时可开 */
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  /** 正在查看的条目（历史抽屉点行载入主面板；null = 跟随最新）。
      按 at 标识，不碰 latest 语义；新翻译进来自动回到最新 */
  const [viewingAt, setViewingAt] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** 开抽屉时量得的几何（方向由上下空隙定，见 toggleDrawer） */
  const [drawerGeom, setDrawerGeom] = useState<{
    up: boolean;
    maxH: number;
    w: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 悬浮卡显式尺寸：拖过角柄后记住（null = 内容自适应 60% 封顶，双击角柄复位） */
  const [cardSize, setCardSize] = useState(() => (floating ? loadReaderTlCard() : null));
  const cardSizeRef = useRef(cardSize);
  cardSizeRef.current = cardSize;

  /** 主面板当前显示条：在途翻译优先，其次抽屉点选，缺省最新 */
  const current = viewingAt
    ? (history.find((e) => e.at === viewingAt) ?? latest)
    : latest;
  const panelOpen = current !== null && current.at !== dismissedAt;
  const showBody = pending !== null || panelOpen;

  // 新翻译进来（在途开始 / 新条目落地）自动展开正文区并回到最新条
  const latestAt = latest?.at ?? null;
  useEffect(() => {
    setCollapsed(false);
    setViewingAt(null);
  }, [latestAt, pending]);

  /** 抽屉点行 = 载入主面板（显式动作：即使该条刚被 × 掉也重新打开） */
  function pickEntry(e: TlHistoryEntry) {
    setViewingAt(e.at);
    setDismissedAt(null);
    setCollapsed(false);
    setDrawerOpen(false);
  }

  /** 开抽屉前先量：悬浮卡可能贴窗任何位置，固定「向下弹」会探出窗顶/窗底、
      固定 w-96 在窄卡/窄栏会横向越界——按卡与窗的实际空隙定方向、最大高与宽 */
  function toggleDrawer() {
    const root = rootRef.current;
    if (root) {
      const r = root.getBoundingClientRect();
      const spaceUp = r.top;
      const spaceDown = window.innerHeight - r.bottom;
      const up = spaceUp > spaceDown; // 哪边空隙大往哪边弹
      setDrawerGeom({
        up,
        maxH: Math.max(96, Math.floor((up ? spaceUp : spaceDown) - 16)),
        w: Math.min(384, Math.max(240, Math.floor(r.width) - 8)),
      });
    }
    setDrawerOpen((v) => !v);
  }

  // 历史抽屉：Esc（capture 相抢在关阅读区之前）/ 点外关闭（面板正文在布局流里，不参与）
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      setDrawerOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [drawerOpen]);

  /** 底缘纵向拖拽（仿 ReaderOverlay startSideResize 的 pointer 模式）：
      自适应高时起点取当前渲染高度的占比、按增量走不跳变；松手才落 localStorage */
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const root = rootRef.current;
    const col = root?.parentElement;
    if (!root || !col) return;
    const colH = col.getBoundingClientRect().height;
    if (colH <= 0) return;
    const startY = e.clientY;
    const startPct = clampReaderTlPct(
      heightPct ?? (root.getBoundingClientRect().height / colH) * 100,
      heightPct ?? 40,
    );
    const pctOf = (clientY: number) =>
      clampReaderTlPct(startPct + ((clientY - startY) / colH) * 100, startPct);
    const onMove = (ev: PointerEvent) => onResize(pctOf(ev.clientY));
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      onResizeEnd(pctOf(ev.clientY));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /** 悬浮卡角柄拖拽：宽高一起改（贴球侧的边不动，自由角在球对侧下方——
      贴右长宽向左、贴左向右，高度都向下长），钳在窗内可用空间，松手落键。
      与球同款 4px 阈值：抖一下不算拖（否则 1px 抖动就把自适应卡永久锁成显式
      尺寸、矮卡瞬间跳到 140 下限）；基值取当前渲染尺寸而非存档——窄窗下
      存档被渲染 min() 压小过，从存档起步会先吃一段看不见的死区 */
  function startCardResize(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const root = rootRef.current;
    const host = root?.offsetParent as HTMLElement | null;
    if (!root || !host || !floatAnchor) return;
    const hostRect = host.getBoundingClientRect();
    const startRect = root.getBoundingClientRect();
    const growLeft = floatAnchor.xp > 50;
    const base = {
      w: Math.round(startRect.width),
      h: Math.round(startRect.height),
    };
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && dx * dx + dy * dy < 16) return; // 4px 阈值：抖动不算拖
      moved = true;
      setCardSize(
        clampReaderTlCard(
          growLeft ? base.w - dx : base.w + dx,
          base.h + dy,
          hostRect.width - 16,
          hostRect.height - 16,
        ),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!moved) return; // 没拖动不落键（双击复位路径也不被污染）
      const s = cardSizeRef.current;
      if (s) saveReaderTlCard(s);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // 空历史且无在途翻译：面板整体不出现（空节点不出现）
  if (!latest && !pending) return null;
  const drawerUp = drawerGeom?.up ?? false; // 没量到（极端）缺省向下弹

  // 显式高度只在原位档、正文展开时套用（chevron 收起/× 收起后面板回归内容自适应高度）；
  // 未拖过保持内容自适应 + 40% 封顶，超出内部滚动——整段长译文不能无限顶高挤压终端区
  // （% 高/% max-h 挂栏根的 flex 子级上才解析得到定高，故放本容器而非内层）。
  // 悬浮档 absolute 挂覆盖层根：百分比一律对整窗解析。球心渲染位 = clamp(18px, x%,
  // 100%-18px)（ReaderTlFloat），卡的锚定必须用同一份钳制值——否则球贴边时卡按
  // 未钳制百分比锚位压住球（默认 xp=100 实测压 14px）。卡顶/卡高的 min() 用同一份
  // 活钳高度：窗口变小后存档高被渲染压缩，卡顶不再按裸存档值算出负数探出窗顶
  const fixedH = !floating && heightPct != null && showBody && !collapsed;
  // 球心距某侧窗边的钳制距离（与球渲染同款）：dist = clamp(18px, pct%, 100%-18px)
  const ballDist = (pct: number) =>
    `clamp(18px, ${pct}%, calc(100% - 18px))`;
  const anchorStyle = floating
    ? {
        left:
          floatAnchor.xp <= 50
            ? `calc(${ballDist(floatAnchor.xp)} + 22px)`
            : undefined,
        right:
          floatAnchor.xp > 50
            ? `calc(${ballDist(100 - floatAnchor.xp)} + 22px)`
            : undefined,
        top: cardSize
          ? `min(${floatAnchor.yp}%, calc(100% - min(${cardSize.h}px, calc(100% - 16px)) - 8px))`
          : `min(${floatAnchor.yp}%, calc(100% - 60% - 8px))`,
        width: cardSize
          ? `min(${cardSize.w}px, calc(100% - 16px), calc(100% - ${floatAnchor.xp > 50 ? ballDist(100 - floatAnchor.xp) : ballDist(floatAnchor.xp)} - 30px))`
          : `min(26rem, calc(100% - 44px), calc(100% - ${floatAnchor.xp > 50 ? ballDist(100 - floatAnchor.xp) : ballDist(floatAnchor.xp)} - 30px))`,
        // 显式尺寸走 height（60% 封顶会让拖大的卡被裁）；自适应走 60% 封顶
        ...(cardSize
          ? { height: `min(${cardSize.h}px, calc(100% - 16px))` }
          : { maxHeight: "60%" }),
      }
    : fixedH
      ? { height: `${heightPct}%` }
      : undefined;

  return (
    <div
      ref={rootRef}
      style={anchorStyle}
      className={`ccode-well flex shrink-0 flex-col rounded-lg ${
        floating
          ? "pointer-events-auto absolute z-30 border border-field shadow-lg"
          : `relative mx-2 mt-2 ${fixedH ? "" : "max-h-[40%]"}`
      }`}
    >
      {/* 注意根节点不能 overflow-hidden：历史抽屉（top-full）和底缘拖动手柄
          （translate-y-1/2 骑跨底边）都要伸出卡外，裁掉就点不到（2026-10-10 修）。
          圆角防溢出改为只给有底色的表头加 rounded-t。 */}
      {showBody ? (
        <>
          {/* 表头允许折行：窄卡（用户拖小）/ 最窄右栏里动作钮一排放不下，
              折成两行比挤出头干净；min-h-8 保证单行时与原 h-8 同高 */}
          <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1 rounded-t-[7px] border-b border-hairline bg-strip px-2 py-1 text-micro">
            {floating ? (
              // 悬浮档没有「只折正文」一说（点球/× 已是完全收起），纯标识行
              <span className="flex items-center gap-1 px-1 text-l2">
                <span>译文</span>
                <span className="text-l4">第 {(pending ?? current!).page} 页</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setCollapsed((v) => !v)}
                className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-l2 hover:bg-hover hover:text-l1"
              >
                <FoldMark open={!collapsed} />
                <span>译文</span>
                <span className="text-l4">第 {(pending ?? current!).page} 页</span>
              </button>
            )}
            <div className="ml-auto flex items-center gap-0.5">
              {!pending && current && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowOriginal((v) => !v)}
                    className={`rounded-sm px-1.5 py-0.5 ${
                      showOriginal
                        ? "bg-seg-sel text-l1"
                        : "text-l3 hover:bg-hover hover:text-l1"
                    }`}
                  >
                    原文
                  </button>
                  {onAsk && (
                    <button
                      type="button"
                      disabled={!canAsk}
                      title={canAsk ? "放进下方对话的输入行，不发送" : "对话还没准备好"}
                      onClick={() => onAsk(current)}
                      className="rounded-sm px-1.5 py-0.5 text-l2 hover:bg-hover hover:text-l1 disabled:opacity-40"
                    >
                      问这段
                    </button>
                  )}
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
                  {onTogglePlacement && (
                    <button
                      type="button"
                      onClick={onTogglePlacement}
                      title={
                        floating
                          ? "回到右栏对话上方（右栏收着会顺手展开）"
                          : "变成 PDF 边上的「译」悬浮球（可拖动，收起终端栏也在）"
                      }
                      className={`rounded-sm px-1.5 py-0.5 ${
                        floating
                          ? "bg-seg-sel text-l1"
                          : "text-l3 hover:bg-hover hover:text-l1"
                      }`}
                    >
                      {floating ? "回栏" : "钉住"}
                    </button>
                  )}
                  {/* 复制当前显示条的纯译文（兼容 shim 口径同 drawer/存笔记）；
                      细线图标风格同 TerminalStatusBar */}
                  <button
                    type="button"
                    aria-label="复制译文"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(
                          reflowBlockText(plainTextOf(current), { cjk: true }),
                        )
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
              <button
                type="button"
                onClick={toggleDrawer}
                className={`rounded-sm px-1.5 py-0.5 ${
                  drawerOpen
                    ? "bg-seg-sel text-l1"
                    : "text-l3 hover:bg-hover hover:text-l1"
                }`}
              >
                历史 {history.length}
              </button>
              <button
                type="button"
                onClick={() => {
                  onCancelPending();
                  // 悬浮档 × = 收回球；原位档 × = 本轮不再弹出（留一行动作条，历史随时可开）
                  if (onClose) onClose();
                  else if (current) setDismissedAt(current.at);
                  setDrawerOpen(false);
                }}
                className="flex h-5 w-5 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1"
              >
                ×
              </button>
            </div>
          </div>
          {!collapsed && (
            <div className="min-h-0 overflow-y-auto px-3.5 pb-2.5">
              {pending ? (
                pending.phase === "loading" ? (
                  // 在途提示：旋转小标 + 文本（TerminalStatusBar 的 ◌ animate-spin 同款克制写法）
                  <p className="pt-1 text-xs text-l3">
                    <span className="inline-block animate-spin">◌</span>{" "}
                    正在翻译…
                  </p>
                ) : (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="min-w-0 flex-1 truncate text-xs text-err-text">
                      翻译失败：{pending.error}
                    </span>
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
                  // 块级对照：原文整段弱色小字在上（可经表头「原文」隐藏）、译文整段正文在下；
                  // 中英文都两端对齐（text-justify）；两块都先 reflow（PDF 硬换行/断词/空行收起，
                  // 原文按英文、译文按中文口径），块间距 mt-1 收紧一档
                  <>
                    {showOriginal && (
                      <p className="whitespace-pre-line pt-0.5 text-justify text-xs leading-5 text-l4">
                        {reflowBlockText(current.original, { cjk: false })}
                      </p>
                    )}
                    <p className="mt-1 whitespace-pre-line text-justify text-sm leading-6 text-l1">
                      {reflowBlockText(plainTextOf(current), { cjk: true })}
                    </p>
                  </>
                )
              )}
            </div>
          )}
        </>
      ) : (
        // 收起态（本轮 × 掉后不再弹出，新翻译进来自动回来）：
        // 只留一行动作条，历史抽屉仍能随时打开
        <div className="flex h-7 items-center justify-end gap-1 px-2 text-micro">
          {canSave && current && (
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
            onClick={toggleDrawer}
            className={`rounded-sm px-1.5 py-0.5 ${
              drawerOpen
                ? "bg-seg-sel text-l1"
                : "text-l3 hover:bg-hover hover:text-l1"
            }`}
          >
            历史 {history.length}
          </button>
        </div>
      )}
      {drawerOpen && (
        // 历史抽屉（QuickChatHistoryMenu 同款浮层：Esc/点外关闭，新条目在上）：
        // 摘要两行 clamp（点行 = 载入主面板显示该条）；行内只留「存进笔记」
        // 且收到摘要下方——动作不再占正文宽度；「复制」挪到主面板表头图标钮。
        // 弹出方向/最大高/宽在 toggleDrawer 开抽屉时量好（悬浮卡可贴窗任何位置，
        // 固定方向会探出窗顶/窗底，固定 w-96 在窄卡/窄栏会横向越界）
        <div
          style={drawerGeom ? { width: drawerGeom.w, maxHeight: drawerGeom.maxH } : undefined}
          className={`absolute right-2 z-40 flex flex-col overflow-hidden rounded-md border border-field ccode-float-surface ${
            drawerUp ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          <div className="border-b border-hairline px-3 py-1.5 text-micro text-l3">
            本次阅读的翻译
          </div>
          <ul className="min-h-0 flex-1 overflow-auto py-1">
            {history.map((e) => (
              <li key={`${e.at}@${e.page}`} className="px-2.5 py-1.5 hover:bg-hover">
                <button
                  type="button"
                  onClick={() => pickEntry(e)}
                  className="block w-full text-left"
                >
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
      )}
      {floating && (
        // 悬浮卡角柄：拖 = 宽高一起改（自由角在球对侧下方），双击复位内容自适应
        // （拖过落键记住尺寸，与右栏高度条同款「拖过 = 显式记忆」口径）
        <div
          onPointerDown={startCardResize}
          onDoubleClick={() => {
            setCardSize(null);
            saveReaderTlCard(null);
          }}
          title="拖动调整大小，双击恢复自适应"
          className={`group absolute bottom-0 z-10 flex size-4 touch-none items-center justify-center ${
            floatAnchor.xp > 50
              ? "left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize"
              : "right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize"
          }`}
        >
          <span
            className="size-2.5 opacity-50 transition-opacity group-hover:opacity-100"
            style={{
              background:
                "repeating-linear-gradient(45deg, transparent 0 2px, var(--color-l4) 2px 3px)",
            }}
          />
        </div>
      )}
      {!floating && showBody && !collapsed && (
        // 底缘纵向分割条：抓取热区骑跨底边（translate-y-1/2），平时透明、悬停显色
        // （右栏竖分割条同款手法）；chevron 收起/× 收起时不出现（无正文可调）；
        // 悬浮档高度自适应封顶，无 % 高度语义，不给拖拽
        <div
          onPointerDown={startResize}
          onDoubleClick={onResizeReset}
          title="拖动调整译文高度，双击恢复"
          className="group absolute inset-x-3 bottom-0 z-10 h-2 translate-y-1/2 cursor-row-resize"
        >
          <span className="absolute inset-x-0 top-0.5 h-px bg-field transition-colors group-hover:bg-cta" />
        </div>
      )}
    </div>
  );
}

/** memo：父级（ReaderOverlay）重渲染不级联 */
export default memo(ReaderTranslatePanel);
