import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "../types";
import {
  breakdownSupported,
  contextView,
  fmtRatio,
  type ContextBreakdown,
  type ContextBreakdownRequest,
  type ContextTone,
} from "../context-breakdown";

/**
 * 上下文用量圆环（docs/design-chat-layer.md §4.4）：上一轮输入占模型上下文窗口的比例，≥80% 变 warn。
 * 聊天输入框（模型芯片左边）与终端底栏右区共用；终端底栏走 xterm 调色板，所以颜色可传进来。
 * 悬停是一句话的说明；点一下弹出浮层（2026-10-20 用户要 Claude 客户端那样的上下文面板）：总量、三段横条、
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

export default function ContextRing({
  ratio,
  used,
  window: win,
  agentId,
  breakdown = null,
  onCompact,
  color,
  warnColor,
  trackColor = "var(--color-field)",
  className = "",
  extra = [],
}: {
  ratio: number;
  used: number;
  window: number;
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
  /** 悬停里多写的几行（2026-10-23 底栏收字：本段用了多少 token、经哪条连接不再单写在底栏上） */
  extra?: string[];
}) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const warn = ratio >= 0.8;
  const stroke = warn ? warnColor : color;
  const pct = Math.round(ratio * 100);
  const label = AGENTS.find((a) => a.id === agentId)?.label ?? agentId;
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
  const view = contextView(detail.state === "ok" ? detail.data : null, { used, window: win }, light);
  const supported = breakdownSupported(agentId);
  const note =
    detail.state === "ok"
      ? `分类是 ${label} 用 /context 估算的，和上一轮的实际用量可能略有出入。`
      : detail.state === "loading"
        ? `正在向 ${label} 要分类明细…`
        : detail.state === "error"
          ? `没读到分类明细：${detail.message}`
          : supported
            ? "这段对话还没接上会话文件，暂时只有总量。"
            : `${label} 不提供分类明细，这里只有总量。`;

  return (
    <button
      ref={ringRef}
      type="button"
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-hover focus-visible:bg-hover ${
        stroke ? "" : warn ? "text-warn-text" : "text-l3"
      } ${className}`}
      style={stroke ? { color: stroke } : undefined}
      aria-label={`上下文已用 ${pct}%（${contextFmtTokens(used)} / ${contextFmtTokens(win)}），点开看明细`}
      aria-haspopup="dialog"
      aria-expanded={Boolean(panel)}
      onClick={togglePanel}
      onMouseEnter={(e) => !panel && setTip(anchor(e.currentTarget))}
      onMouseLeave={() => setTip(null)}
    >
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
              <div className={warn ? "text-warn-text" : "text-l1"}>上下文已用 {pct}%</div>
              <div className="mt-0.5 tabular-nums text-l3">
                {contextFmtTokens(used)} / {contextFmtTokens(win)} tokens
              </div>
              {extra.map((line) => (
                <div key={line} className="mt-0.5 tabular-nums text-l3">
                  {line}
                </div>
              ))}
              <div className="mt-1 leading-[18px] text-l4">点一下看分类{onCompact ? "，也能在里面压缩" : ""}</div>
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
              className="ccode-float-surface w-[18rem] rounded-lg border border-field p-3 text-left text-xs shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-l1">上下文</span>
                <span className={`tabular-nums ${warn ? "text-warn-text" : "text-l3"}`}>
                  {contextFmtTokens(used)} / {contextFmtTokens(win)}（{pct}%）
                </span>
              </div>
              <div className="relative mt-2 h-1.5">
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
              <div className="mt-2.5 space-y-1">
                {view.rows.map((row) => (
                  <div key={row.label} className="flex items-center gap-2 tabular-nums">
                    <span
                      className={`size-2 shrink-0 rounded-xs ${toneClass(row.tone, warn)}`}
                      style={row.color ? { background: row.color } : undefined}
                    />
                    <span className="min-w-0 flex-1 truncate text-l2">{row.label}</span>
                    <span className="text-l3">{contextFmtTokens(row.tokens)}</span>
                    <span className="w-12 text-right text-l4">{fmtRatio(row.ratio)}</span>
                  </div>
                ))}
              </div>
              {(view.untilCompact !== null || onCompact) && (
                <div className="mt-2.5 flex min-h-7 items-center justify-between gap-2 border-t border-hairline pt-2.5">
                  <span className="tabular-nums text-l3">
                    {view.untilCompact !== null ? `离自动压缩还有 ${contextFmtTokens(view.untilCompact)}` : ""}
                  </span>
                  {onCompact && (
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-field px-2 py-1 text-l2 hover:bg-hover"
                      title="把前面的对话压成摘要，腾出上下文"
                      onClick={() => {
                        setPanel(null);
                        onCompact();
                      }}
                    >
                      压缩上下文
                    </button>
                  )}
                </div>
              )}
              <div className="mt-2 leading-[18px] text-l4">
                {note}
                {detail.state === "error" && (
                  <button type="button" className="ml-1 text-l3 underline-offset-2 hover:underline" onClick={fetchDetail}>
                    重试
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r={r} fill="none" stroke={trackColor} strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${c * ratio} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 8 8)"
        />
      </svg>
    </button>
  );
}
