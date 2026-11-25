import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Wallet } from "lucide-react";
import { useAppStore } from "../store";
import type { GatewayBalanceDto, PlanQuotaDto } from "../types";
import {
  profileQuotaKind,
  resolveChatQuotaView,
  type ChatQuotaTone,
} from "../chat-quota";
import {
  planCapsuleLabel,
  planLevelLabel,
  planProviderLabel,
  planRemainingQuotaPair,
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
import { MicroRing } from "./ContextRing";
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

function textToneClass(tone: ChatQuotaTone): string {
  if (tone === "danger") return "text-err-text";
  if (tone === "warn") return "text-caution-text";
  return "text-l3";
}

/**
 * 聊天底栏「订阅用量 / 网关余额」静默单环（2026-11-25 用户拍板 A 方案，与上下文圆环同形同色）：
 * - 套餐写已用：圆环与数字都是最紧窗口的已用比例，越满越接近上限；平时灰，警示 / 危急才着色；
 * - 账户钱包写余额、不画比例环（total 是累计充值，不是上限），用同尺寸钱包图标；只有限额密钥才画已用环；
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
  const pinnedRef = useRef(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [panel, setPanel] = useState<{ x: number; y: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const anchor = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return { x: Math.max(276, rect.right + 4), y: rect.top };
  };

  const clearHoverTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const openPanel = useCallback(
    (pin: boolean) => {
      clearHoverTimers();
      if (!btnRef.current) return;
      if (pin) pinnedRef.current = true;
      setPanel(anchor(btnRef.current));
    },
    [clearHoverTimers],
  );

  const closePanel = useCallback(() => {
    clearHoverTimers();
    pinnedRef.current = false;
    setPanel(null);
  }, [clearHoverTimers]);

  const handleTriggerEnter = useCallback(() => {
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
  }, [panel, openPanel]);

  const handleLeave = useCallback(() => {
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
  }, [closePanel]);

  const handlePanelEnter = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearHoverTimers(), [clearHoverTimers]);

  useEffect(() => {
    if (!panel) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
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
  }, [panel, closePanel]);

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
    ? `${planProviderLabel(view.row.provider)} ${planWindowLabel(view.primary.window)}已用 ${view.usedPct}%`
    : `${view.row.gatewayName} 钱包余额 ${walletLabel}`;

  const resetCardCount =
    isPlan && view.row.resetCardsSupported && view.row.resetCards.ok
      ? view.row.resetCards.fiveHour + view.row.resetCards.weekly + view.row.resetCards.general
      : 0;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`-ml-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-cta ${textToneClass(view.tone)}`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={Boolean(panel)}
        onClick={() => {
          if (panel && pinnedRef.current) {
            closePanel();
            return;
          }
          openPanel(true);
        }}
        onMouseEnter={handleTriggerEnter}
        onMouseLeave={handleLeave}
      >
        {isPlan ? (
          <MicroRing ratio={view.usedPct / 100} />
        ) : view.ringUsedPct != null ? (
          <MicroRing ratio={view.ringUsedPct / 100} />
        ) : (
          <Wallet aria-hidden="true" strokeWidth={2.2} className="size-3.5 shrink-0" />
        )}
        <span className="text-micro font-normal tabular-nums">
          {isPlan ? `${view.usedPct}%` : walletLabel}
        </span>
      </button>

      {/* 悬停直出详情浮层（点击可固定展开；外层 pb-1.5 形成隐形悬停桥） */}
      {panel &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed z-70 pb-1.5"
            style={{ left: panel.x, top: panel.y, transform: "translate(-100%, -100%)" }}
            onMouseEnter={handlePanelEnter}
            onMouseLeave={handleLeave}
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
                    const remPair = planRemainingQuotaPair(w.used, w.total);
                    return (
                      <div key={w.window} className="flex items-center gap-2.5">
                        <MicroRing
                          size="md"
                          ratio={(100 - w.remainPct) / 100}
                          className={w.tone === "ok" ? "text-l2" : textToneClass(w.tone)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-l2">{planWindowLabel(w.window)}已用</span>
                            <span
                              className={`shrink-0 font-medium tabular-nums ${
                                w.tone === "ok" ? "text-l1" : textToneClass(w.tone)
                              }`}
                            >
                              {100 - w.remainPct}%
                            </span>
                          </div>
                          {(remain || remPair) && (
                            <div className="mt-0.5 flex items-center justify-between gap-2 text-micro tabular-nums text-l4">
                              <span className="truncate">{remain ?? ""}</span>
                              {remPair && <span className="shrink-0">剩余 {remPair}</span>}
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
                  {view.ringUsedPct != null && (
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
                          style={{ width: `${view.ringUsedPct}%` }}
                        />
                      </div>
                      <div className="mt-1 text-micro tabular-nums text-l4">
                        已用 {view.ringUsedPct}%
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
