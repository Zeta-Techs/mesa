import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff, RefreshCw, Wallet } from "lucide-react";
import { useAppStore } from "../store";
import type { GatewayBalanceDto, PlanQuotaDto } from "../types";
import {
  profileQuotaKind,
  resolveChatQuotaView,
  shortWindowTag,
  type ChatQuotaTone,
} from "../chat-quota";
import {
  planCapsuleLabel,
  planLevelLabel,
  planProviderLabel,
  planRemainingQuotaPair,
  planResetClock,
  planResetRemain,
  planWindowLabel,
} from "../plan-quota";
import {
  formatBalanceAmount,
  formatBalanceAmountMasked,
  walletAmountCaption,
  walletKeyAmountLine,
  walletPopoverDetail,
  walletUpdatedAgo,
} from "../gateway-balance";
import AgentIcon from "./AgentIcon";
import VendorIcon from "./VendorIcon";
import { MicroRing } from "./ContextRing";
import { vendorForPlanProvider } from "../vendor-icon";

const PLAN_CACHE_KEY = "ccode.stats.planRowsCache";
const WALLET_CACHE_KEY = "ccode.stats.walletRowsCache";
const FRESH_TTL_MS = 120_000;
/** 底栏钱包只显示图标、不写金额（本机偏好，对所有钱包网关生效；订阅百分比不受影响） */
const WALLET_ICON_ONLY_KEY = "ccode.chat.walletIconOnly";
const WALLET_ICON_ONLY_EVENT = "ccode-wallet-icon-only";

function readWalletIconOnly(): boolean {
  try {
    return localStorage.getItem(WALLET_ICON_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

function writeWalletIconOnly(on: boolean) {
  try {
    if (on) localStorage.setItem(WALLET_ICON_ONLY_KEY, "1");
    else localStorage.removeItem(WALLET_ICON_ONLY_KEY);
  } catch {
    // 存不住就只在本次生效
  }
  // 多个聊天标签各有一颗芯片，一起切
  window.dispatchEvent(new CustomEvent(WALLET_ICON_ONLY_EVENT, { detail: on }));
}

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

/** 浮层横条：正常档用主强调色（与用量页订阅卡同色），警示 / 危急换语义色 */
function barToneClass(tone: ChatQuotaTone): string {
  if (tone === "danger") return "bg-err-text";
  if (tone === "warn") return "bg-caution-text";
  return "bg-cta";
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
  const [walletIconOnly, setWalletIconOnly] = useState(readWalletIconOnly);
  useEffect(() => {
    const sync = (e: Event) => setWalletIconOnly(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener(WALLET_ICON_ONLY_EVENT, sync);
    return () => window.removeEventListener(WALLET_ICON_ONLY_EVENT, sync);
  }, []);

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

  const walletDetail = !isPlan ? walletPopoverDetail(view.row, now, hideWallet) : null;
  const updatedText = walletUpdatedAgo(view.row.queriedAt, now);

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
        {/* 用量数字前写最紧窗口（5h / 7d），与左边不带标签的上下文圆环区分；标签比数字淡一档 */}
        {isPlan && shortWindowTag(view.primary.window) && (
          <span className="text-micro font-normal tabular-nums opacity-60">{shortWindowTag(view.primary.window)}</span>
        )}
        {/* 钱包可切成只留图标（余额低时图标照样变黄 / 红，金额在浮层里看） */}
        {(isPlan || !walletIconOnly) && (
          <span className="text-micro font-normal tabular-nums">
            {isPlan ? `${view.usedPct}%` : walletLabel}
          </span>
        )}
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
                  {/* 钱包写站点域名：网关名常和 Agent 同名（如「Codex」），读不出是哪个站 */}
                  {walletDetail?.host && (
                    <span
                      className="min-w-0 truncate rounded-full bg-inset px-1.5 py-px text-micro text-l3"
                      title={view.kind === "wallet" ? view.row.origin : undefined}
                    >
                      {walletDetail.host}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                {!isPlan && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = !walletIconOnly;
                      setWalletIconOnly(next);
                      writeWalletIconOnly(next);
                    }}
                    title={walletIconOnly ? "底栏显示金额" : "底栏不显示金额"}
                    aria-label={walletIconOnly ? "底栏显示金额" : "底栏不显示金额"}
                    aria-pressed={walletIconOnly}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
                  >
                    {walletIconOnly ? (
                      <EyeOff aria-hidden="true" className="h-3 w-3" />
                    ) : (
                      <Eye aria-hidden="true" className="h-3 w-3" />
                    )}
                  </button>
                )}
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
              </div>

              {/* 浮层主体：各窗「标签 · 重置时刻 · 已用%」+ 已用横条（倒计时放悬停） 或 网关钱包余额 */}
              {isPlan ? (
                <div className="mt-2.5 space-y-3">
                  {view.windows.map((w) => {
                    const usedPct = 100 - w.remainPct;
                    const resetAt = planResetClock(w.resetsAt, now);
                    const remain = planResetRemain(w.resetsAt, now);
                    const remPair = planRemainingQuotaPair(w.used, w.total);
                    return (
                      <div key={w.window}>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-l2">{planWindowLabel(w.window)}已用</span>
                          <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                            {resetAt && (
                              <span
                                className="text-micro text-l4"
                                title={remain && remain !== resetAt ? remain : undefined}
                              >
                                {resetAt}
                              </span>
                            )}
                            <span
                              className={`font-medium ${w.tone === "ok" ? "text-l1" : textToneClass(w.tone)}`}
                            >
                              {usedPct}%
                            </span>
                          </span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-l1/10">
                          <div
                            className={`h-full rounded-full ${barToneClass(w.tone)}`}
                            style={{ width: `${Math.max(usedPct > 0 ? 2 : 0, Math.min(100, usedPct))}%` }}
                          />
                        </div>
                        {remPair && (
                          <div className="mt-1 text-micro tabular-nums text-l4">剩余 {remPair}</div>
                        )}
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
                <div className="mt-2.5 space-y-3">
                  {/* 主行：余额（或这把密钥的额度）；余额低才着色，平时不上色 */}
                  <div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-l2">{walletAmountCaption(view.row.source)}</span>
                      <span
                        className={`shrink-0 text-base font-semibold tabular-nums ${
                          view.tone === "ok" ? "text-l1" : textToneClass(view.tone)
                        }`}
                      >
                        {walletLabel}
                      </span>
                    </div>
                    {view.ringUsedPct != null && (
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-l1/10">
                        <div
                          className={`h-full rounded-full ${barToneClass(view.tone)}`}
                          style={{ width: `${view.ringUsedPct}%` }}
                        />
                      </div>
                    )}
                    {walletDetail?.spentLine ? (
                      <div className="mt-1 text-micro tabular-nums text-l4">{walletDetail.spentLine}</div>
                    ) : (
                      view.ringUsedPct != null && (
                        <div className="mt-1 text-micro tabular-nums text-l4">
                          已用 {walletKeyAmountLine(false, view.row.used, view.row.total, view.row.currency, hideWallet) || `${view.ringUsedPct}%`}
                        </div>
                      )
                    )}
                  </div>
                  {/* 账户钱包下再列这把推理密钥自己的额度（同一钱包可挂多把密钥，限额的会先用完） */}
                  {walletDetail?.key && (
                    <div title={walletDetail.key.title ? `令牌：${walletDetail.key.title}` : undefined}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-l2">密钥额度</span>
                        <span
                          className={`shrink-0 text-micro tabular-nums ${
                            walletDetail.key.tone === "ok" ? "text-l3" : textToneClass(walletDetail.key.tone)
                          }`}
                        >
                          {walletDetail.key.amount}
                        </span>
                      </div>
                      {walletDetail.key.usedPct != null && (
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-l1/10">
                          <div
                            className={`h-full rounded-full ${barToneClass(walletDetail.key.tone)}`}
                            style={{ width: `${Math.max(walletDetail.key.usedPct > 0 ? 2 : 0, walletDetail.key.usedPct)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {walletDetail?.expiry && (
                    <div className="rounded-md bg-inset px-2 py-1 text-micro text-caution-text">
                      {walletDetail.expiry}，到站点续期
                    </div>
                  )}
                </div>
              )}

              {/* 数据时间（两种浮层同一处）：点右上角刷新可重查 */}
              {updatedText && (
                <div className="mt-3 border-t border-hairline pt-2 text-micro text-l4">{updatedText}</div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
