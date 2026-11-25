import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { useAppStore } from "../store";
import type { GatewayBalanceDto, PlanQuotaDto } from "../types";
import {
  profileQuotaKind,
  resolveChatQuotaView,
  type ChatQuotaTone,
} from "../chat-quota";
import {
  planAbsoluteQuotaPair,
  planCapsuleLabel,
  planLevelLabel,
  planProviderLabel,
  planResetRemain,
  planWindowLabel,
} from "../plan-quota";
import {
  formatBalanceAmount,
  formatBalanceAmountMasked,
  walletAmountCaption,
} from "../gateway-balance";
import AgentIcon from "./AgentIcon";
import VendorIcon from "./VendorIcon";
import { vendorForPlanProvider } from "../vendor-icon";

const PLAN_CACHE_KEY = "ccode.stats.planRowsCache";
const WALLET_CACHE_KEY = "ccode.stats.walletRowsCache";
const FRESH_TTL_MS = 120_000;

let planInflight: Promise<PlanQuotaDto[]> | null = null;
let planFetchedAt = 0;
let walletInflight: Promise<GatewayBalanceDto[]> | null = null;
let walletFetchedAt = 0;

function readCachedPlans(): PlanQuotaDto[] {
  try {
    const raw = localStorage.getItem(PLAN_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is PlanQuotaDto => Boolean(r && typeof r === "object" && typeof r.gatewayId === "string"))
      .map((r) => ({ ...r, fromCache: true }));
  } catch {
    return [];
  }
}

function readCachedWallets(): GatewayBalanceDto[] {
  try {
    const raw = localStorage.getItem(WALLET_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is GatewayBalanceDto => Boolean(r && typeof r === "object" && typeof r.gatewayId === "string"))
      .map((r) => ({ ...r, fromCache: true }));
  } catch {
    return [];
  }
}

function writeCache(key: string, rows: unknown[]) {
  try {
    if (rows.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(rows));
  } catch {
    // 忽略本地配额异常
  }
}

async function fetchPlanQuota(force: boolean): Promise<PlanQuotaDto[]> {
  if (!force && planInflight) return planInflight;
  const req = invoke<PlanQuotaDto[]>("plan_quota_overview", { force })
    .then((rows) => {
      planFetchedAt = Date.now();
      useAppStore.getState().setPlanQuotaRows(rows);
      writeCache(PLAN_CACHE_KEY, rows);
      return rows;
    })
    .finally(() => {
      if (planInflight === req) planInflight = null;
    });
  planInflight = req;
  return req;
}

async function fetchWalletBalance(force: boolean): Promise<GatewayBalanceDto[]> {
  if (!force && walletInflight) return walletInflight;
  const req = invoke<GatewayBalanceDto[]>("gateway_balance_overview", { force })
    .then((rows) => {
      walletFetchedAt = Date.now();
      useAppStore.getState().setWalletBalanceRows(rows);
      writeCache(WALLET_CACHE_KEY, rows);
      return rows;
    })
    .finally(() => {
      if (walletInflight === req) walletInflight = null;
    });
  walletInflight = req;
  return req;
}

/** 5 小时窗走静默中性灰；警示档走哑光琥珀 caution-text，危急档走珊瑚红 */
function ringStrokeClass(tone: ChatQuotaTone, tinted = false): string {
  if (tone === "danger") return "text-err-text";
  if (tone === "warn") return "text-caution-text";
  return tinted ? "text-ok-text" : "text-l2";
}

function isWeeklyWindow(window: string): boolean {
  return window === "weekly" || window === "agy_argon_weekly" || window === "monthly";
}

function textToneClass(tone: ChatQuotaTone): string {
  if (tone === "danger") return "text-err-text";
  if (tone === "warn") return "text-caution-text";
  return "text-l3";
}

/** 14px 极简单环：与左侧上下文饼盘严格对齐 12.6px 光学外径；5 小时保持中性灰轨 + 细弧，本周剩余改为同色系浅弧 + 深轨 */
function SingleMicroRing({
  remainPct,
  tone,
  tinted = false,
}: {
  remainPct: number;
  tone: ChatQuotaTone;
  tinted?: boolean;
}) {
  // 外径统一：tinted 5.3 + 2.0/2 = 6.3（12.6px），5h 5.5 + 1.6/2 = 6.3（12.6px）
  const r = tinted ? 5.3 : 5.5;
  const sw = tinted ? 2.0 : 1.6;
  const c = 2 * Math.PI * r;
  const p = Math.min(100, Math.max(0, remainPct));
  const hueClass = ringStrokeClass(tone, tinted);
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden="true"
      className={`size-3.5 shrink-0 -rotate-90 ${tinted ? hueClass : ""}`}
    >
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth={sw}
        stroke="currentColor"
        strokeOpacity={tinted ? 0.28 : undefined}
        className={tinted ? undefined : "text-l1/12"}
      />
      {p > 0 && (
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          strokeWidth={sw}
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={`${(c * p) / 100} ${c}`}
          className={tinted ? undefined : hueClass}
        />
      )}
    </svg>
  );
}

/** 浮层内的 20px 单环（与底栏同一视觉语言：本周浅深双调、5 小时中性灰轨） */
function PopoverMiniRing({
  remainPct,
  tone,
  tinted = false,
}: {
  remainPct: number;
  tone: ChatQuotaTone;
  tinted?: boolean;
}) {
  const r = 7.8;
  const c = 2 * Math.PI * r;
  const p = Math.min(100, Math.max(0, remainPct));
  const hueClass = ringStrokeClass(tone, tinted);
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={`size-5 shrink-0 -rotate-90 ${tinted ? hueClass : ""}`}
    >
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        strokeWidth="2.1"
        stroke="currentColor"
        strokeOpacity={tinted ? 0.28 : undefined}
        className={tinted ? undefined : "text-l1/12"}
      />
      {p > 0 && (
        <circle
          cx="10"
          cy="10"
          r={r}
          fill="none"
          strokeWidth="2.1"
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={`${(c * p) / 100} ${c}`}
          className={tinted ? undefined : hueClass}
        />
      )}
    </svg>
  );
}

/**
 * 聊天底栏「订阅余量 / 网关余额」静默单环：
 * - 平时保持低饱和克制态，本周剩余用同色系浅深双调环、5 小时剩余用中性灰轨单环，仅警示/危急时着色；
 * - 悬停出轻量提示，点击弹出 .ccode-float-surface 精简玻璃浮层查看各窗剩余、倒计时与手动刷新；
 * - 当前连接无套餐/钱包余量时自动隐藏，绝不占空位。
 */
export default function ChatQuotaRing({
  profileId,
}: {
  profileId: string | null | undefined;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const gateways = useAppStore((s) => s.gateways);
  const planRows = useAppStore((s) => s.planQuotaRows);
  const walletRows = useAppStore((s) => s.walletBalanceRows);

  const profile = useMemo(
    () => (profileId ? profiles.find((p) => p.id === profileId) ?? null : null),
    [profiles, profileId],
  );
  const expectedKind = useMemo(() => profileQuotaKind(profile, gateways), [profile, gateways]);

  // 首次进聊天未去过用量页时：先读 localStorage 快照秒出，再静默后台拉一次（带 2 分钟 TTL 防抖）
  useEffect(() => {
    if (!expectedKind) return;
    if (expectedKind === "plan") {
      if (useAppStore.getState().planQuotaRows.length === 0) {
        const cached = readCachedPlans();
        if (cached.length > 0) useAppStore.getState().setPlanQuotaRows(cached);
      }
      if (Date.now() - planFetchedAt > FRESH_TTL_MS) {
        void fetchPlanQuota(false).catch(() => {});
      }
    } else {
      if (useAppStore.getState().walletBalanceRows.length === 0) {
        const cached = readCachedWallets();
        if (cached.length > 0) useAppStore.getState().setWalletBalanceRows(cached);
      }
      if (Date.now() - walletFetchedAt > FRESH_TTL_MS) {
        void fetchWalletBalance(false).catch(() => {});
      }
    }
  }, [expectedKind]);

  const view = useMemo(
    () => resolveChatQuotaView(profile, planRows, walletRows, gateways),
    [profile, planRows, walletRows, gateways],
  );

  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const [panel, setPanel] = useState<{ x: number; y: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const anchor = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return { x: Math.max(276, rect.right + 4), y: rect.top - 6 };
  };

  useEffect(() => {
    if (!panel) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
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

  const handleRefresh = useCallback(async () => {
    if (!view || refreshing) return;
    setRefreshing(true);
    try {
      if (view.kind === "plan") await fetchPlanQuota(true);
      else await fetchWalletBalance(true);
    } catch {
      // 静默忽略，保留当前展示数据
    } finally {
      setRefreshing(false);
    }
  }, [view, refreshing]);

  if (!view) return null;

  const now = Date.now();
  const hideWallet =
    typeof localStorage !== "undefined" && localStorage.getItem("ccode.stats.hideQuota") === "1";

  const isPlan = view.kind === "plan";
  const sameProviderCount = isPlan
    ? planRows.filter((r) => r.provider === view.row.provider).length
    : 1;
  const hasProviderIcon =
    isPlan && (view.row.provider === "agy" || Boolean(vendorForPlanProvider(view.row.provider)));
  const titleText = isPlan
    ? planCapsuleLabel(view.row, sameProviderCount, hasProviderIcon)
    : view.row.gatewayName;
  const levelText = isPlan ? planLevelLabel(view.row.planLevel) : null;

  const walletLabel = !isPlan
    ? hideWallet
      ? formatBalanceAmountMasked(view.row.currency)
      : view.row.remaining != null
        ? formatBalanceAmount(view.row.remaining, view.row.currency)
        : view.row.total != null
          ? formatBalanceAmount(view.row.total, view.row.currency)
          : "不限"
    : "";

  const ariaLabel = isPlan
    ? `${planProviderLabel(view.row.provider)} ${planWindowLabel(view.primary.window)}剩余 ${view.remainPct}%，点开查看全部窗口`
    : `${view.row.gatewayName} 钱包余额 ${walletLabel}，点开查看详情`;

  const resetCardCount =
    isPlan && view.row.resetCardsSupported && view.row.resetCards.ok
      ? view.row.resetCards.fiveHour + view.row.resetCards.weekly + view.row.resetCards.general
      : 0;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-cta"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={Boolean(panel)}
        onClick={() => {
          if (panel) {
            setPanel(null);
            return;
          }
          if (!btnRef.current) return;
          setTip(null);
          setPanel(anchor(btnRef.current));
        }}
        onMouseEnter={(e) => !panel && setTip(anchor(e.currentTarget))}
        onMouseLeave={() => setTip(null)}
      >
        <SingleMicroRing
          remainPct={isPlan ? view.remainPct : (view.remainPct ?? 100)}
          tone={view.tone}
          tinted={isPlan && isWeeklyWindow(view.primary.window)}
        />
        <span className={`text-micro font-normal tabular-nums ${textToneClass(view.tone)}`}>
          {isPlan ? `${view.remainPct}%` : walletLabel}
        </span>
      </button>
      <span aria-hidden="true" className="h-3 w-px shrink-0 bg-hairline" />

      {/* 轻量悬停提示 */}
      {tip &&
        !panel &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-70"
            style={{ left: tip.x, top: tip.y, transform: "translate(-100%, -100%)" }}
          >
            <div
              role="tooltip"
              className="ccode-float-surface w-max max-w-[16.5rem] rounded-lg border border-field px-2.5 py-2 text-xs shadow-lg"
            >
              <div className="flex items-center gap-1.5 font-medium text-l1">
                <span className="truncate">{titleText}</span>
                {levelText && <span className="text-micro font-normal text-l3">· {levelText}</span>}
              </div>
              {isPlan ? (
                <div className="mt-1 space-y-0.5 tabular-nums text-l3">
                  {view.windows.map((w) => {
                    const remain = planResetRemain(w.resetsAt, now);
                    return (
                      <div key={w.window} className="flex items-center justify-between gap-3">
                        <span>{planWindowLabel(w.window)}剩余</span>
                        <span className={w.tone === "ok" ? "text-l2" : textToneClass(w.tone)}>
                          {w.remainPct}%
                          {remain ? <span className="ml-1 text-micro text-l4">· {remain}</span> : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-1 tabular-nums text-l3">
                  {walletAmountCaption(view.row.source)}{" "}
                  <span className="text-l1">{walletLabel}</span>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}

      {/* 点击展开的精致玻璃浮层 */}
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
              aria-label="当前账号余量详情"
              onClick={(e) => e.stopPropagation()}
              className="ccode-float-surface w-[16.5rem] rounded-xl border border-field p-3 text-left text-xs shadow-lg"
            >
              {/* 浮层顶栏：品牌图标 + 名称 + 刷新 */}
              <div className="flex items-center justify-between gap-2 border-b border-hairline pb-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {isPlan &&
                    (view.row.provider === "agy" ? (
                      <AgentIcon agent="agy" label="Antigravity" size={14} />
                    ) : (
                      vendorForPlanProvider(view.row.provider) && (
                        <VendorIcon
                          vendor={vendorForPlanProvider(view.row.provider)}
                          name={planProviderLabel(view.row.provider)}
                          className="h-3.5 w-3.5 shrink-0"
                        />
                      )
                    ))}
                  <span className="truncate font-medium text-l1">{titleText}</span>
                  {levelText && (
                    <span className="shrink-0 rounded-full bg-inset px-1.5 py-px text-micro text-l3">
                      {levelText}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  disabled={refreshing}
                  onClick={() => void handleRefresh()}
                  title="立即刷新余量"
                  aria-label="立即刷新余量"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
                  />
                </button>
              </div>

              {/* 浮层主体：各窗剩余小环明细 或 网关钱包余额 */}
              {isPlan ? (
                <div className="mt-2.5 space-y-2.5">
                  {view.windows.map((w) => {
                    const remain = planResetRemain(w.resetsAt, now);
                    const absPair = planAbsoluteQuotaPair(w.used, w.total);
                    return (
                      <div key={w.window} className="flex items-center gap-2.5">
                        <PopoverMiniRing
                          remainPct={w.remainPct}
                          tone={w.tone}
                          tinted={isWeeklyWindow(w.window)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-l2">{planWindowLabel(w.window)}剩余</span>
                            <span
                              className={`shrink-0 font-medium tabular-nums ${
                                w.tone === "ok" ? "text-l1" : textToneClass(w.tone)
                              }`}
                            >
                              {w.remainPct}%
                            </span>
                          </div>
                          {(remain || absPair) && (
                            <div className="mt-0.5 flex items-center justify-between gap-2 text-micro tabular-nums text-l4">
                              <span className="truncate">{remain ?? ""}</span>
                              {absPair && <span className="shrink-0">已用 {absPair}</span>}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {resetCardCount > 0 && view.remainPct <= 20 && (
                    <div className="rounded-md bg-inset px-2 py-1 text-micro text-l3">
                      还有 {resetCardCount} 张重置卡可用，可在用量页使用
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-l3">{walletAmountCaption(view.row.source)}</span>
                    <span className="text-base font-semibold tabular-nums text-l1">
                      {walletLabel}
                    </span>
                  </div>
                  {view.remainPct != null && (
                    <>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-l1/10">
                        <div
                          className={`h-full rounded-full ${
                            view.tone === "danger"
                              ? "bg-err-text"
                              : view.tone === "warn"
                                ? "bg-caution-text"
                                : "bg-l2"
                          }`}
                          style={{ width: `${view.remainPct}%` }}
                        />
                      </div>
                      <div className="mt-1 text-micro tabular-nums text-l4">
                        剩余 {Math.round(view.remainPct)}%
                      </div>
                    </>
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
