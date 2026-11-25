import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Bot, Minimize2 } from "lucide-react";
import type { ContextSnapshot } from "../composer-assist";
import {
  contextView,
  fmtRatio,
  headlessBreakdownSupported,
  imageWeightNote,
  localBackendBreakdown,
  projectCalibratedBreakdown,
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

// 本地秒读（Antigravity）按「会话 + 当轮用量」缓存，避免重复读库
const breakdownCache = new Map<string, ContextBreakdown>();
const breakdownInflight = new Map<string, Promise<ContextBreakdown>>();

// 无头 `/context` 校准（Claude Code / Qwen Code）按「会话 + 模型 + 目录」只跑一次：
// 仅在会话真正运行/继续后于后台静默校准一次，后续每轮由 projectCalibratedBreakdown 实时投射
const calibratedCache = new Map<string, ContextBreakdown>();
const calibratedInflight = new Map<string, Promise<ContextBreakdown>>();
const calibratedAttempted = new Set<string>();
const MAX_CACHE_ENTRIES = 64;

function putBounded<V>(map: Map<string, V>, key: string, val: V) {
  if (map.size >= MAX_CACHE_ENTRIES && !map.has(key)) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, val);
}

function loadBreakdown(req: ContextBreakdownRequest, key: string): Promise<ContextBreakdown> {
  const hit = breakdownCache.get(key);
  if (hit) return Promise.resolve(hit);
  let p = breakdownInflight.get(key);
  if (!p) {
    p = invoke<ContextBreakdown>("context_breakdown", { ...req })
      .then((b) => {
        putBounded(breakdownCache, key, b);
        return b;
      })
      .finally(() => breakdownInflight.delete(key));
    breakdownInflight.set(key, p);
  }
  return p;
}

function loadCalibrated(req: ContextBreakdownRequest, key: string): Promise<ContextBreakdown> {
  const hit = calibratedCache.get(key);
  if (hit) return Promise.resolve(hit);
  let p = calibratedInflight.get(key);
  if (!p) {
    p = invoke<ContextBreakdown>("context_breakdown", { ...req })
      .then((b) => {
        putBounded(calibratedCache, key, b);
        return b;
      })
      .finally(() => calibratedInflight.delete(key));
    calibratedInflight.set(key, p);
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

/**
 * 底栏读数细环（2026-11-25 用户拍板 A 方案）：上下文与订阅用量同一种画法——
 * 12 点起顺时针、越满越接近上限；弧与底轨都取 currentColor（底轨 36% 透明，20% 在深色底上看不出整圈、低百分比时显小），颜色由外层文字色决定，
 * 平时灰、临界才着色。sm = 底栏 14px，md = 浮层 20px；线宽按尺寸等比，外径约占画布 91%。
 */
export function MicroRing({
  ratio,
  trackColor,
  size = "sm",
  className = "",
}: {
  /** 0–1，已用比例 */
  ratio: number;
  /** 不传 = currentColor 36% 透明 */
  trackColor?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const s = size === "md" ? 20 : 14;
  const sw = size === "md" ? 2.1 : 1.6;
  const r = s / 2 - sw / 2 - 0.6;
  const c = 2 * Math.PI * r;
  const p = Math.min(1, Math.max(0, ratio));
  return (
    <svg
      viewBox={`0 0 ${s} ${s}`}
      aria-hidden="true"
      className={`${size === "md" ? "size-5" : "size-3.5"} shrink-0 -rotate-90 ${className}`}
    >
      <circle
        cx={s / 2}
        cy={s / 2}
        r={r}
        fill="none"
        strokeWidth={sw}
        stroke={trackColor ?? "currentColor"}
        strokeOpacity={trackColor ? undefined : 0.36}
      />
      {p > 0 && (
        <circle
          cx={s / 2}
          cy={s / 2}
          r={r}
          fill="none"
          strokeWidth={sw}
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={`${(c * p).toFixed(3)} ${c.toFixed(3)}`}
        />
      )}
    </svg>
  );
}

export default function ContextRing({
  ratio,
  used,
  window: win,
  agentId,
  breakdown = null,
  localBreakdown = null,
  running = false,
  busy = false,
  onCompact,
  color,
  warnColor,
  trackColor,
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
  /** 纯前端秒算的本地分类明细（全 7 家有逐轮用量的 CLI 通用，零等待不起子进程） */
  localBreakdown?: ContextBreakdown | null;
  /** 当前会话是否正在运行（继续会话或新聊已启动）：仅运行中时为 Claude / Qwen 静默做一次 `/context` 校准 */
  running?: boolean;
  /** 当前回合是否正在生成/待确认：避开生成尖峰，等回合落地空闲后再静默校准 */
  busy?: boolean;
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
  const hasWindow = Boolean(win && win > 0 && ratio !== null);
  const safeRatio = Math.min(1, Math.max(0, ratio ?? 0));
  const visRatio = safeRatio <= 0 ? 0 : safeRatio >= 0.999 ? 1 : Math.max(0.03, safeRatio);
  const heavy = imageWeightNote(imageBytes);
  const warn = (hasWindow && safeRatio >= 0.8) || heavy !== null;
  const stroke = warn ? warnColor : color;
  const pct = hasWindow ? Math.round(safeRatio * 100) : null;
  const ringRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const pinnedRef = useRef(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  // 浮层右缘对齐图标右缘、底边在按钮上方 6px（通过外层 pb-1.5 形成隐形悬停桥，鼠标移入面板不断开）
  const [panel, setPanel] = useState<{ x: number; y: number } | null>(null);
  const [, setCacheRev] = useState(0);
  const anchor = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.right + 4, y: rect.top };
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isLocalBackend = localBackendBreakdown(agentId);
  const isHeadless = headlessBreakdownSupported(agentId);
  const localKey = breakdown && isLocalBackend ? `${breakdown.agentId}|${breakdown.sessionId}|${used}` : null;
  const calKey =
    breakdown && isHeadless
      ? `${breakdown.agentId}|${breakdown.sessionId}|${breakdown.model ?? ""}|${breakdown.cwd}`
      : null;

  function fetchLocalBackend() {
    if (!breakdown || !localKey || breakdownCache.has(localKey)) return;
    loadBreakdown(breakdown, localKey)
      .then(() => {
        if (mountedRef.current) setCacheRev((v) => v + 1);
      })
      .catch(() => {
        // 已有纯前端 localBreakdown 兜底，失败静默保持本地估算
      });
  }

  function clearHoverTimers() {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function openPanel(pin: boolean) {
    clearHoverTimers();
    if (!ringRef.current) return;
    if (pin) pinnedRef.current = true;
    setPanel(anchor(ringRef.current));
    // Antigravity 为纯本地秒读日志/子智能体库，悬停直接补读；Claude / Qwen 不因悬停起进程
    if (localKey) fetchLocalBackend();
  }

  function closePanel() {
    clearHoverTimers();
    pinnedRef.current = false;
    setPanel(null);
  }

  function handleTriggerEnter() {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (panel) return;
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      openPanel(false);
    }, 100);
  }

  function handleLeave() {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (pinnedRef.current) return;
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      closePanel();
    }, 180);
  }

  function handlePanelEnter() {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function togglePanel() {
    if (panel && pinnedRef.current) {
      closePanel();
      return;
    }
    openPanel(true);
  }

  useEffect(() => () => clearHoverTimers(), []);

  // Antigravity 浮层开着且用量变了：同步刷新本地只读库
  useEffect(() => {
    if (panel && localKey) fetchLocalBackend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, localKey]);

  // Claude Code / Qwen Code：仅在用户真正继续/运行会话、且回合落地空闲时于后台静默校准一次 `/context`，
  // 拿到精确的 MCP / 技能 / 内置工具与自动压缩预留后，后续每轮由 projectCalibratedBreakdown 实时投射，不再重复起进程
  useEffect(() => {
    if (!running || busy || used <= 0 || !breakdown || !calKey) return;
    if (calibratedCache.has(calKey) || calibratedAttempted.has(calKey)) return;
    const req = breakdown;
    const key = calKey;
    const timer = window.setTimeout(() => {
      if (calibratedCache.has(key) || calibratedAttempted.has(key)) return;
      calibratedAttempted.add(key);
      loadCalibrated(req, key)
        .then(() => {
          if (mountedRef.current) setCacheRev((v) => v + 1);
        })
        .catch(() => {
          // 静默回退到纯前端 localBreakdown，不打扰用户
        });
    }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, busy, used > 0, calKey]);

  useEffect(() => {
    if (!panel) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || ringRef.current?.contains(t)) return;
      closePanel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [panel]);

  const light = typeof document !== "undefined" && (document.documentElement.dataset.theme ?? "").endsWith("-light");
  const cachedLocal = localKey ? breakdownCache.get(localKey) ?? null : null;
  const cachedCalibrated = calKey ? calibratedCache.get(calKey) ?? null : null;
  const breakdownData = cachedLocal
    ? cachedLocal
    : cachedCalibrated
      ? projectCalibratedBreakdown(cachedCalibrated, used, win, localBreakdown)
      : localBreakdown;
  const view = contextView(breakdownData, { used, window: win }, light);
  const usedRows = view.rows.filter((r) => r.tone !== "reserve" && r.tone !== "free");
  const capRows = view.rows.filter((r) => r.tone === "reserve" || r.tone === "free");
  const splitRows = usedRows.length > 1 && capRows.length > 0;
  const compactions = Math.max(breakdownData?.compactions ?? 0, snapshot?.compactions ?? 0);
  const cacheRead = breakdownData?.cacheRead ?? snapshot?.cacheRead ?? 0;
  const freshInput = breakdownData?.freshInput ?? snapshot?.freshInput ?? 0;
  const cacheTotal = cacheRead + freshInput;
  const subagents = breakdownData?.subagents ?? [];
  const hasFooter = Boolean(onCompact);

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
            ? `上下文已用 ${pct}%（${contextFmtTokens(used)} / ${contextFmtTokens(win)}）`
            : `当前上下文 ${contextFmtTokens(used)} tokens`
        }
        aria-haspopup="dialog"
        aria-expanded={Boolean(panel)}
        onClick={togglePanel}
        onMouseEnter={handleTriggerEnter}
        onMouseLeave={handleLeave}
      >
        {hasWindow ? (
          <>
            <MicroRing ratio={visRatio} trackColor={warn ? undefined : trackColor} />
            {showPercent && <span className="text-micro font-normal tabular-nums">{pct}%</span>}
          </>
        ) : (
          <span className="text-micro font-normal tabular-nums text-l3">
            {tokenLabel ?? `${contextFmtTokens(used)} token`}
          </span>
        )}
      </button>
      {panel &&
        typeof document !== "undefined" &&
        createPortal(
          // 定位与悬停桥（pb-1.5）挂外层；内层负责 .ccode-float-surface 入场动画，不与 translate 冲突
          <div
            className="fixed z-70 pb-1.5"
            style={{ left: panel.x, top: panel.y, transform: "translate(-100%, -100%)" }}
            onMouseEnter={handlePanelEnter}
            onMouseLeave={handleLeave}
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
              </div>
              {/* 仅在支持「压缩上下文」且正在运行时显示卡底托盘 */}
              {hasFooter && onCompact && (
                <div className="border-t border-hairline bg-strip/60 px-3.5 py-2.5">
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
                        closePanel();
                        onCompact();
                      }}
                    >
                      <Minimize2 size={12} strokeWidth={1.8} aria-hidden="true" />
                      压缩上下文
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
