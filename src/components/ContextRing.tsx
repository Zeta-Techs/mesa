import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Bot, Minimize2 } from "lucide-react";
import type { ContextSnapshot } from "../composer-assist";
import {
  contextView,
  fmtRatio,
  imageWeightNote,
  longContextHint,
  type ContextBreakdown,
  type ContextBreakdownRequest,
  type ContextTone,
} from "../context-breakdown";

/**
 * 上下文用量圆环（docs/design-chat-layer.md §4.4）：上一轮输入占模型上下文窗口的比例，≥80% 变 warn。
 * 聊天输入框（模型芯片左边）与终端底栏右区共用；终端底栏走 xterm 调色板，所以颜色可传进来。
 * 悬停只写比例与用量（2026-11-20 用户：其余收进点开的浮层）；点一下弹出浮层（2026-10-20 用户要 Claude 客户端那样的上下文面板）：总量、三段横条、
 * 分类列表（Claude Code / Qwen Code 在后台跑它自己的 /context 得来）、离自动压缩还有多少、「压缩上下文」。
 * 浮层都挂到 body 上按圆环位置定位（底栏右区是 overflow-hidden；原生 title 在桌面窗口里不可靠）。
 */
export function contextFmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}K`;
  return String(n);
}

// 同一轮（用量没变）只读一次：后台起一次 CLI 要几秒，挂了 MCP 的更久
const breakdownCache = new Map<string, ContextBreakdown>();
const breakdownInflight = new Map<string, Promise<ContextBreakdown>>();

function loadBreakdown(req: ContextBreakdownRequest, key: string): Promise<ContextBreakdown> {
  const hit = breakdownCache.get(key);
  if (hit) return Promise.resolve(hit);
  let p = breakdownInflight.get(key);
  if (!p) {
    p = invoke<ContextBreakdown>("context_breakdown", { ...req })
      .then((b) => {
        breakdownCache.set(key, b);
        return b;
      })
      .finally(() => breakdownInflight.delete(key));
    breakdownInflight.set(key, p);
  }
  return p;
}

/** 四大类用分类色（行内 style）；这里只管主题灰：没有分类时的「已用」快满变橙，小类同一种灰 */
function toneClass(tone: ContextTone, warn: boolean): string {
  switch (tone) {
    case "series":
      return "";
    case "used":
      return warn ? "bg-warn-text" : "bg-l2";
    case "minor":
      return "bg-l3";
    case "reserve":
      return "border border-l4";
    case "free":
      return "bg-field";
  }
}

type Detail =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; data: ContextBreakdown }
  | { state: "error"; message: string };

/** 顺时针从 12 点起画实心扇形路径（0 < ratio < 1），避免描边法在 WebKit 上产生圆心针孔伪影 */
function contextPiePath(cx: number, cy: number, r: number, ratio: number): string {
  const theta = ratio * Math.PI * 2;
  const x = cx + r * Math.sin(theta);
  const y = cy - r * Math.cos(theta);
  const largeArc = ratio > 0.5 ? 1 : 0;
  return `M ${cx} ${cy} L ${cx} ${(cy - r).toFixed(3)} A ${r} ${r} 0 ${largeArc} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
}

export default function ContextRing({
  ratio,
  used,
  window: win,
  breakdown = null,
  onCompact,
  color,
  warnColor,
  trackColor = "var(--color-field)",
  className = "",
  showPercent = false,
  imageBytes = null,
  snapshot = null,
  tokenLabel = null,
}: {
  /** null = 模型窗口大小未知（改用 tokenLabel 文本触发，点开同样看本地分类/缓存复用/子智能体明细） */
  ratio: number | null;
  used: number;
  window: number | null;
  agentId: string;
  /** 去读分类明细要的参数（context-breakdown.ts breakdownRequest）；null = 这家不提供或还没有会话 */
  breakdown?: ContextBreakdownRequest | null;
  /** 「压缩上下文」：这家有压缩命令且正在运行时才给 */
  onCompact?: (() => void) | null;
  /** 不传 = 主题灰（text-l3 / 橙色 warn） */
  color?: string;
  warnColor?: string;
  trackColor?: string;
  className?: string;
  /** 本段对话累计 token（已格式化，如 "12.7 万"），收进浮层底栏左侧（2026-11-20 从悬停挪进浮层） */
  totalTokens?: string | null;
  /** 连接名（同 Agent 名时调用方不传），收进浮层底栏右侧 */
  profileName?: string | null;
  /** 聊天层直接显示比例，圆环与原有输入控件的位置不变。 */
  showPercent?: boolean;
  /** Codex 会话里存的图（字节，session_image_bytes）：到 8MB 圆环变橙并在悬停 / 浮层里说明（2026-11-11） */
  imageBytes?: number | null;
  /** 前端从会话消息现算的上一轮缓存复用 / 新增输入 / 压缩次数（所有 Agent 立即可用） */
  snapshot?: ContextSnapshot | null;
  /** 窗口未知时的按钮文案（如 "1.3 万 token"） */
  tokenLabel?: string | null;
}) {
  // 与底栏右侧订阅余量环（ChatQuotaRing）统一为 14×14 画布、12.6px 光学外径：
  // 外框 r=5.7 / sw=1.2（外径 12.6px），内嵌实心扇形饼盘 r=4.2（实心填充 = 上下文往里填，空心圆环 = 订阅配额往外扣）
  const rimR = 5.7;
  const pieR = 4.2;
  const hasWindow = Boolean(win && win > 0 && ratio !== null);
  const safeRatio = Math.min(1, Math.max(0, ratio ?? 0));
  const visRatio = safeRatio <= 0 ? 0 : safeRatio >= 0.999 ? 1 : Math.max(0.05, safeRatio);
  const heavy = imageWeightNote(imageBytes);
  const warn = (hasWindow && safeRatio >= 0.8) || heavy !== null;
  const stroke = warn ? warnColor : color;
  const pct = hasWindow ? Math.round(safeRatio * 100) : null;
  const ringRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 浮层右缘对齐圆环右缘、底边在圆环上方 6px（用 translate 往左上挪，不依赖视口高度）
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const [panel, setPanel] = useState<{ x: number; y: number } | null>(null);
  const [detail, setDetail] = useState<Detail>({ state: "idle" });
  const anchor = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.right + 4, y: rect.top - 6 };
  };

  const reqKey = breakdown ? `${breakdown.agentId}|${breakdown.sessionId}|${used}` : null;
  const reqKeyRef = useRef(reqKey);
  reqKeyRef.current = reqKey;
  function fetchDetail() {
    if (!breakdown || !reqKey) return;
    const cached = breakdownCache.get(reqKey);
    if (cached) {
      setDetail({ state: "ok", data: cached });
      return;
    }
    setDetail({ state: "loading" });
    const key = reqKey;
    loadBreakdown(breakdown, key)
      .then((data) => {
        if (reqKeyRef.current === key) setDetail({ state: "ok", data });
      })
      .catch((e) => {
        if (reqKeyRef.current === key) setDetail({ state: "error", message: String(e) });
      });
  }

  function togglePanel() {
    if (panel) {
      setPanel(null);
      return;
    }
    if (!ringRef.current) return;
    setTip(null);
    setPanel(anchor(ringRef.current));
    fetchDetail();
  }

  // 开着时这一轮结束、用量变了：重新读
  useEffect(() => {
    if (panel) fetchDetail();
    else setDetail({ state: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey]);

  useEffect(() => {
    if (!panel) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || ringRef.current?.contains(t)) return;
      setPanel(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [panel]);

  const light = typeof document !== "undefined" && (document.documentElement.dataset.theme ?? "").endsWith("-light");
  const breakdownData = detail.state === "ok" ? detail.data : null;
  const view = contextView(breakdownData, { used, window: win }, light);
  const usedRows = view.rows.filter((r) => r.tone !== "reserve" && r.tone !== "free");
  const capRows = view.rows.filter((r) => r.tone === "reserve" || r.tone === "free");
  const splitRows = usedRows.length > 1 && capRows.length > 0;
  const longHint = longContextHint(used);
  const compactions = Math.max(breakdownData?.compactions ?? 0, snapshot?.compactions ?? 0);
  const cacheRead = breakdownData?.cacheRead ?? snapshot?.cacheRead ?? 0;
  const freshInput = breakdownData?.freshInput ?? snapshot?.freshInput ?? 0;
  const cacheTotal = cacheRead + freshInput;
  const subagents = breakdownData?.subagents ?? [];
  const statusNote =
    detail.state === "loading"
      ? "正在读取明细…"
      : detail.state === "error"
        ? `没读到分类明细：${detail.message}`
        : null;
  const hasFooter = Boolean(onCompact || statusNote);

  const renderRow = (row: (typeof view.rows)[number], muted = false) => (
    <div key={row.label} className="flex items-center gap-2 tabular-nums leading-[20px]">
      <span
        className={`size-2 shrink-0 rounded-[2px] ${toneClass(row.tone, warn)}`}
        style={row.color ? { background: row.color } : undefined}
      />
      <span className={`min-w-0 flex-1 truncate ${muted ? "text-l3" : "text-l2"}`}>{row.label}</span>
      <span className={muted ? "text-l3" : "text-l2"}>{contextFmtTokens(row.tokens)}</span>
      <span className="w-[3.25rem] text-right text-l4">{fmtRatio(row.ratio)}</span>
    </div>
  );

  return (
    <>
      <button
        ref={ringRef}
        type="button"
        className={`inline-flex ${
          !hasWindow || showPercent ? "h-7 gap-1 px-1.5" : "size-6"
        } shrink-0 items-center justify-center rounded-md outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-cta ${
          stroke ? "" : warn ? "text-warn-text" : "text-l3"
        } ${className}`}
        style={stroke ? { color: stroke } : undefined}
        aria-label={
          hasWindow && win
            ? `上下文已用 ${pct}%（${contextFmtTokens(used)} / ${contextFmtTokens(win)}），点开看明细`
            : `当前上下文 ${contextFmtTokens(used)} tokens，点开看明细`
        }
        aria-haspopup="dialog"
        aria-expanded={Boolean(panel)}
        onClick={togglePanel}
        onMouseEnter={(e) => !panel && setTip(anchor(e.currentTarget))}
        onMouseLeave={() => setTip(null)}
      >
        {hasWindow ? (
          <>
            <svg viewBox="0 0 14 14" aria-hidden="true" className="size-3.5 shrink-0">
              <circle
                cx="7"
                cy="7"
                r={rimR}
                fill="none"
                stroke={warn ? "currentColor" : trackColor}
                strokeOpacity={warn ? 0.5 : undefined}
                strokeWidth="1.2"
              />
              <circle cx="7" cy="7" r={pieR} fill="currentColor" fillOpacity={0.14} />
              {visRatio >= 1 ? (
                <circle cx="7" cy="7" r={pieR} fill="currentColor" />
              ) : visRatio > 0 ? (
                <path d={contextPiePath(7, 7, pieR, visRatio)} fill="currentColor" />
              ) : null}
            </svg>
            {showPercent && <span className="text-micro font-normal tabular-nums">{pct}%</span>}
          </>
        ) : (
          <span className="text-micro font-normal tabular-nums text-l3">
            {tokenLabel ?? `${contextFmtTokens(used)} token`}
          </span>
        )}
      </button>
      {tip &&
        !panel &&
        typeof document !== "undefined" &&
        createPortal(
          // 定位挂外层（translate 往左上挪）；内层才是浮层皮肤——ccode-float-surface 的入场动画会改 transform，
          // 两者放在同一个元素上，入场那 150ms 浮层会先出现在错位置再跳回来
          <div
            className="pointer-events-none fixed z-70"
            style={{ left: tip.x, top: tip.y, transform: "translate(-100%, -100%)" }}
          >
            <div
              role="tooltip"
              className="ccode-float-surface w-max max-w-[16rem] rounded-lg border border-field px-2.5 py-2 text-xs shadow-lg"
            >
              <div className={warn ? "text-warn-text" : "text-l1"}>
                {hasWindow ? `上下文已用 ${pct}%` : "当前上下文"}
              </div>
              <div className="mt-0.5 tabular-nums text-l3">
                {hasWindow && win
                  ? `${contextFmtTokens(used)} / ${contextFmtTokens(win)} tokens`
                  : `${contextFmtTokens(used)} tokens`}
              </div>
              {cacheTotal > 0 && cacheRead > 0 && (
                <div className="mt-0.5 text-micro tabular-nums text-l4">
                  缓存复用 {fmtRatio(cacheRead / cacheTotal)}
                  {compactions > 0 ? ` · 已压缩 ${compactions} 次` : ""}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
      {panel &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed z-70"
            style={{ left: panel.x, top: panel.y, transform: "translate(-100%, -100%)" }}
          >
            <div
              ref={panelRef}
              role="dialog"
              aria-label="上下文"
              className="ccode-float-surface w-[20.5rem] overflow-hidden rounded-xl border border-field text-left text-sm shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-3.5 pt-3.5 pb-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-l1">上下文</span>
                    {compactions > 0 && (
                      <span className="rounded-full bg-inset px-1.5 py-px text-micro tabular-nums text-l3">
                        已压缩 {compactions} 次
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1.5 tabular-nums">
                    <span className={`text-xs ${warn ? "text-warn-text" : "text-l3"}`}>
                      {hasWindow && win
                        ? `${contextFmtTokens(used)} / ${contextFmtTokens(win)}`
                        : `${contextFmtTokens(used)} tokens`}
                    </span>
                    {hasWindow && (
                      <span className={`font-medium ${warn ? "text-warn-text" : "text-l1"}`}>{pct}%</span>
                    )}
                  </div>
                </div>
                {heavy && (
                  <p
                    className={`mt-2 rounded-md px-2.5 py-1.5 text-xs leading-[18px] ${
                      heavy.level === "stuck" ? "bg-err/60 text-err-text" : "bg-warn/60 text-warn-text"
                    }`}
                  >
                    {heavy.text}
                  </p>
                )}
                <div className="relative mt-2.5 h-1.5">
                  {/* 段与段之间留 2px 底色缝，相邻两色不糊在一起 */}
                  <div className="flex h-full gap-0.5 overflow-hidden rounded-full bg-field">
                    {view.bar.segments.map((seg, i) => (
                      <div
                        key={i}
                        className={`shrink-0 ${toneClass(seg.tone, warn)}`}
                        style={{ width: `${seg.ratio * 100}%`, ...(seg.color ? { background: seg.color } : {}) }}
                      />
                    ))}
                  </div>
                  {view.bar.compactAt !== null && (
                    <div
                      className="absolute -top-0.5 h-2.5 w-px bg-l3"
                      style={{ left: `${view.bar.compactAt * 100}%` }}
                      title="到这里自动压缩"
                    />
                  )}
                </div>
                <div className="mt-3">
                  {splitRows ? (
                    <>
                      <div className="space-y-1.5">{usedRows.map((row) => renderRow(row, false))}</div>
                      <div className="my-2 border-t border-hairline/70" />
                      <div className="space-y-1.5">{capRows.map((row) => renderRow(row, true))}</div>
                    </>
                  ) : (
                    <div className="space-y-1.5">{view.rows.map((row) => renderRow(row, row.tone === "free"))}</div>
                  )}
                </div>
                {cacheTotal > 0 && (
                  <div className="mt-2.5 space-y-1 border-t border-hairline/70 pt-2.5 text-xs tabular-nums leading-[18px]">
                    <div className="flex items-center gap-2">
                      <span className="size-1.5 shrink-0 rounded-full bg-cta" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-l2">缓存复用上下文</span>
                      <span className="text-l2">{contextFmtTokens(cacheRead)}</span>
                      <span className="w-[3.25rem] text-right text-l4">
                        {fmtRatio(cacheRead / cacheTotal)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="size-1.5 shrink-0 rounded-full bg-l3" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-l2">本步新增输入</span>
                      <span className="text-l2">{contextFmtTokens(freshInput)}</span>
                      <span className="w-[3.25rem] text-right text-l4">
                        {fmtRatio(freshInput / cacheTotal)}
                      </span>
                    </div>
                  </div>
                )}
                {subagents.length > 0 && (
                  <div className="mt-2.5 border-t border-hairline/70 pt-2.5">
                    <div className="mb-1.5 flex items-center gap-1.5 text-micro text-l3">
                      <Bot size={12} strokeWidth={1.8} aria-hidden="true" />
                      <span>子智能体上下文</span>
                      <span className="rounded-full bg-inset px-1.5 py-px tabular-nums text-l4">
                        {subagents.length}
                      </span>
                    </div>
                    <div className="max-h-36 space-y-2 overflow-y-auto pr-0.5">
                      {subagents.map((sub) => {
                        const subPct =
                          sub.window && sub.window > 0
                            ? Math.min(100, Math.round((sub.used / sub.window) * 100))
                            : null;
                        return (
                          <div key={sub.id} className="rounded-md bg-inset/70 px-2 py-1.5 text-xs">
                            <div className="flex items-center justify-between gap-1.5">
                              <span className="min-w-0 flex-1 truncate font-medium text-l1" title={sub.title}>
                                {sub.title}
                              </span>
                              {sub.model && (
                                <span className="max-w-[6.5rem] shrink-0 truncate rounded bg-raised px-1 py-px text-micro text-l3">
                                  {sub.model}
                                </span>
                              )}
                              {subPct !== null && (
                                <span className="shrink-0 text-micro tabular-nums text-l2">{subPct}%</span>
                              )}
                            </div>
                            {subPct !== null && (
                              <div className="mt-1 h-1 overflow-hidden rounded-full bg-field">
                                <div
                                  className="h-full rounded-full bg-cta/80"
                                  style={{ width: `${subPct}%` }}
                                />
                              </div>
                            )}
                            <div className="mt-1 flex items-center justify-between gap-2 text-micro tabular-nums text-l4">
                              <span>
                                总 {contextFmtTokens(sub.totalTokens)}
                                {sub.cacheHitPct != null ? ` · 缓存 ${sub.cacheHitPct}%` : ""}
                              </span>
                              <span>
                                {sub.window && sub.window > 0
                                  ? `${contextFmtTokens(sub.used)} / ${contextFmtTokens(sub.window)}`
                                  : contextFmtTokens(sub.used)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {longHint && (
                  <div className="mt-2.5 rounded-md bg-warn/50 px-2.5 py-1.5 text-xs leading-[18px] text-warn-text">
                    {longHint}
                  </div>
                )}
              </div>
              {/* 仅在有操作（「压缩上下文」）或加载/报错时显示卡底托盘；常驻说明已精简 */}
              {hasFooter && (
                <div className="border-t border-hairline bg-strip/60 px-3.5 py-2.5">
                  {onCompact && (
                    <div className="text-xs font-medium">
                      <button
                        type="button"
                        className={`flex h-7 w-full items-center justify-center gap-1.5 rounded-md border px-2.5 transition-colors ${
                          warn
                            ? "border-warn-text/40 bg-warn/40 text-warn-text hover:bg-warn/70"
                            : "border-field bg-raised text-l2 hover:border-l4 hover:bg-hover hover:text-l1"
                        }`}
                        title="把前面的对话压成摘要，腾出上下文"
                        onClick={() => {
                          setPanel(null);
                          onCompact();
                        }}
                      >
                        <Minimize2 size={12} strokeWidth={1.8} aria-hidden="true" />
                        压缩上下文
                      </button>
                    </div>
                  )}
                  {statusNote && (
                    <div className={`${onCompact ? "mt-2" : ""} text-micro leading-[16px] text-l4`}>
                      {statusNote}
                      {detail.state === "error" && (
                        <button type="button" className="ml-1 text-l3 underline-offset-2 hover:underline" onClick={fetchDetail}>
                          重试
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
