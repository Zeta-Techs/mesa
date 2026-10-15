import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AGENTS } from "../types";
import { useAppStore } from "../store";
import type {
  GatewayBalanceDto,
  GatewayUsageRow,
  PlanQuotaDto,
  PlanQuotaWindowDto,
  UsageStatsDto,
  UsageTopSessionDto,
  UsageTrendDto,
} from "../types";
import { axisLabels } from "../stats-trend";
import {
  cacheHitRate,
  compact,
  fmtCost,
  sessionDisplayTitle,
  weekOverWeek,
} from "../stats-insight";
import ActivityHeatmap from "../components/ActivityHeatmap";
import {
  formatPlanTimestamp,
  formatResetPoint,
  planAbsoluteQuotaPair,
  planWindowUnused,
  planProviderLabel,
  planQuotaDataAt,
  planResetCardHighlight,
  planResetRemain,
  planTabLabel,
  planWindowCaption,
  planWindowLabel,
  planWindowsByTightness,
  gatewayHasPlanQuota,
  planGatewayNameVisible,
  planLevelLabel,
  quotaTone,
  resetCardExpiryNote,
} from "../plan-quota";
import {
  formatBalanceAmount,
  formatBalanceAmountMasked,
  gatewayHasWallet,
  groupWalletAccounts,
  splitBalanceAmount,
  walletAccountTitle,
  walletAmountCaption,
  walletBalanceBar,
  walletExpirySoon,
  walletKeyAmountLine,
  walletKindLabel,
  walletMissingHint,
  walletSpendTone,
  walletTokenQuota,
  walletUnlimitedFill,
  walletUrl,
  walletUsedPercent,
} from "../gateway-balance";
import { confirmDialog } from "../components/ConfirmDialog";
import { agentBrand } from "../agent-colors";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import zhipuIcon from "../assets/plan-icons/zhipu.svg";
import kimiIcon from "../assets/plan-icons/kimi.svg";
import minimaxIcon from "../assets/plan-icons/minimax.svg";

// 各家官方图标（SVG，取自 cc-switch 提取的官方 logo，仅用于标识对应平台）
const PLAN_PROVIDER_ICON: Record<string, string | undefined> = {
  zhipu: zhipuIcon,
  kimi: kimiIcon,
  minimax: minimaxIcon,
};
import {
  Checkbox,
  EmptyState,
  FoldMark,
  LoadingRows,
  PageFrame,
  PageHeader,
  PageToolbar,
  compactPrimaryActionClass,
  ghostActionClass,
  rowActionClass,
  SegTabs,
} from "../components/PageFrame";
import type { WeekOverWeek } from "../stats-insight";

type Range = "today" | "week" | "month" | "all";
type DistView = "sessions" | "agent" | "project" | "gateway" | "task";
type ChartMetric = "cost" | "tokens";

const DIST: { id: DistView; label: string }[] = [
  { id: "sessions", label: "最贵" },
  { id: "agent", label: "Agent" },
  { id: "project", label: "项目" },
  { id: "gateway", label: "网关" },
  { id: "task", label: "任务" },
];

const CHART_METRICS: { id: ChartMetric; label: string }[] = [
  { id: "cost", label: "花费" },
  { id: "tokens", label: "用量" },
];

const RANGES: { id: Range; label: string }[] = [
  { id: "today", label: "今日" },
  { id: "week", label: "近 7 天" },
  { id: "month", label: "近 30 天" },
  { id: "all", label: "全部" },
];

/** 明细表费用列保持单行；金额过长时省略，完整值仍可通过悬浮查看。 */
function CostText({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block max-w-full truncate whitespace-nowrap" title={typeof children === "string" ? children : undefined}>
      {children}
    </span>
  );
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 次级用量条：订阅余量的次窗（「5 小时已用」）和网关卡的密钥行共用。
 *  跟着这一行把名称和尾部数字之间的空档填满，百分比贴在条尾。
 *  不再卡 16rem——卡死之后宽卡片右边会空出一大截。窄窗允许这条先收缩，
 *  不把倒计时顶出卡片。高度仍细于上面的通栏主条。 */
function SecondaryUsageTrack({ fill, bar }: { fill: number; bar: string }) {
  const width = Math.min(100, Math.max(0, fill));
  return (
    <span className="min-w-0 flex-1">
      <span className="block h-1.5 overflow-hidden rounded bg-l4/20">
        <span
          className={`block h-full rounded ${width > 0 ? bar : ""}`}
          style={{ width: `${width}%` }}
        />
      </span>
    </span>
  );
}

/** 不限额度没有配额槽。实色淡出、右端留白，避免读成「已经用完百分之几」。 */
function UnlimitedUsageTrack({ fill }: { fill: number }) {
  const width = Math.min(100, Math.max(0, fill));
  return (
    <span
      className="min-w-0 flex-1"
      title="不限额度。长度只比这张卡上各密钥已花掉的多少，末端留白表示额度还开着"
    >
      <span className="relative block h-1.5">
        <span
          className="absolute inset-y-0 left-0 rounded-l"
          style={{
            width: `${width}%`,
            backgroundImage:
              "linear-gradient(90deg, color-mix(in srgb, var(--color-cta) 70%, transparent) 55%, transparent)",
          }}
        />
      </span>
    </span>
  );
}

function WalletKeyRow({
  name,
  title,
  usedPct,
  used,
  total,
  currency,
  unlimited,
  hideAmount,
  empty,
  peers,
}: {
  name: string;
  title?: string;
  usedPct: number | null;
  used: number | null;
  total: number | null;
  currency: string;
  unlimited?: boolean;
  hideAmount?: boolean;
  empty?: string;
  /** 这张卡上各密钥的已用，给不限额度的开口条做相对长短 */
  peers?: readonly (number | null | undefined)[];
}) {
  const tone = walletSpendTone(usedPct ?? 0);
  const limited = !unlimited && !empty;
  const amount = empty
    ? ""
    : walletKeyAmountLine(!!unlimited, used, total, currency, hideAmount);
  const exhausted = limited && usedPct != null && Math.round(usedPct) >= 100;
  const status = limited && usedPct != null ? `${usedPct.toFixed(0)}%` : "";
  const openFill = unlimited ? walletUnlimitedFill(used, peers ?? []) : null;
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-24 max-w-24 shrink-0 truncate text-xs text-l2" title={title || name}>
        {name}
      </span>
      {empty ? (
        <span className="min-w-0 truncate text-xs text-l4">{empty}</span>
      ) : unlimited ? (
        <>
          {openFill != null ? (
            <UnlimitedUsageTrack fill={openFill} />
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          <span
            className="min-w-10 shrink-0 whitespace-nowrap text-xs text-l3"
          >
            不限
          </span>
          {amount && (
            <span className="w-44 shrink-0 truncate font-mono text-micro tabular-nums text-l4">
              {amount}
            </span>
          )}
        </>
      ) : (
        <>
          <SecondaryUsageTrack fill={usedPct ?? 0} bar={tone.bar} />
          <span
            className={`min-w-10 shrink-0 whitespace-nowrap text-xs tabular-nums ${exhausted ? "text-err-text" : tone.text}`}
          >
            {exhausted && <span className="mr-1 text-micro">已用尽</span>}
            {status}
          </span>
          {amount && (
            <span className="w-44 shrink-0 truncate font-mono text-micro tabular-nums text-l4">
              {amount}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** 窗口块：主窗口（最紧的那个）走大字号 + 通栏条；其余窗口收成一行读数。
 *  `planWindowsByTightness` 已经把最紧的挑到首位，这里让它真的占主位——
 *  否则排序只存在于 DOM 顺序里，两窗等权并列时看不出该管哪个。 */
function PlanWindowBlock({
  win,
  now,
  lastReset,
  primary = false,
}: {
  win: PlanQuotaWindowDto;
  now: number;
  lastReset: string | null;
  primary?: boolean;
}) {
  const { bar, text } = quotaTone(win.usedPercent);
  const abs = planAbsoluteQuotaPair(win.used, win.total);
  const remain = planResetRemain(win.resetsAt, now);
  const point = formatResetPoint(win.resetsAt, now);
  const remainTitle = remain
    ? [point, lastReset ? `上次重置：${lastReset}` : null].filter(Boolean).join(" · ")
    : "这家没有给出这个窗口的重置时间";
  const fill = Math.min(100, Math.max(0, win.usedPercent));
  const caption = planWindowCaption(win.window);

  if (!primary) {
    // 次级窗口：一行说完「哪个窗口 / 用了多少 / 何时重置」。
    // 条与密钥行共用 SecondaryUsageTrack，倒计时跟在用量后面，不把空档留在行尾。
    return (
      <div className="flex items-center gap-2.5">
        <span className="w-24 max-w-24 shrink-0 truncate text-xs text-l3">{caption}</span>
        <SecondaryUsageTrack fill={fill} bar={bar} />
        <span className={`min-w-8 shrink-0 whitespace-nowrap text-xs tabular-nums ${text}`}>
          {win.usedPercent.toFixed(0)}%
        </span>
        {/* 可截断：窄窗下「140,000 / 140,000」不许把整行顶出去 */}
        {abs && <span className="min-w-0 truncate text-micro tabular-nums text-l4">{abs}</span>}
        <span
          className={`shrink-0 text-micro ${remain ? "text-l3" : "text-l4"}`}
          title={remainTitle}
        >
          {remain ?? "暂无重置时间"}
        </span>
      </div>
    );
  }

  return (
    <div>
      <div className="text-xs font-medium tracking-wider text-l4">{caption}</div>
      <div className="mt-0.5 flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span className={`text-2xl font-semibold tracking-tight tabular-nums ${text}`}>
            {win.usedPercent.toFixed(0)}
            <span className="ml-1 text-base font-medium tracking-normal text-l3">%</span>
          </span>
          {abs && <span className="text-xs tabular-nums text-l3">{abs}</span>}
        </div>
        <div className="h-2 overflow-hidden rounded bg-l4/20">
          <div
            className={`h-full rounded ${fill > 0 ? bar : ""}`}
            style={{ width: `${fill}%` }}
          />
        </div>
        {/* 倒计时描述的是这条的重置时间，贴着条走——原 ml-auto 把它顶到卡右缘，
            和条之间隔半个屏幕 */}
        <div
          className={`text-micro ${remain ? "text-l3" : "text-l4"}`}
          title={remainTitle}
        >
          {remain ?? "暂无重置时间"}
        </div>
      </div>
    </div>
  );
}

/** 官方账号（订阅制）行的费用格：不按量计费，固定显示「订阅」并注明口径 */
function SubscriptionCost() {
  return (
    <span title="官方账号登录，不按量计费；token 数仍为实际统计">订阅</span>
  );
}

const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

/** agent 进度条色相：v3.94 起走品牌色 AGENT_BRAND（与对话页胶囊同一出处，
    共享自 src/agent-colors.ts；原令牌色 AGENT_COLORS 仅剩其它用途时保留） */

function wowLabel(
  wow: WeekOverWeek | null,
  currency: "$" | "¥",
  rate: number,
): { text: string; tone: "up" | "down" | "flat" } | null {
  if (!wow) return null;
  const amount = fmtCost(wow.thisWeek, currency, rate, false);
  if (wow.percent == null) return { text: `本周 ${amount}`, tone: "flat" };
  if (wow.percent === 0)
    return { text: `本周 ${amount} · 与上周持平`, tone: "flat" };
  const arrow = wow.percent > 0 ? "▲" : "▼";
  return {
    text: `本周 ${amount} · 较上周 ${arrow}${Math.abs(wow.percent)}%`,
    tone: wow.percent > 0 ? "up" : "down",
  };
}

type ChartPt = { day: string; value: number; tip: string };

/** 花费/用量共用折线（手绘 SVG）。日期轴常驻，悬停才出当日数字。 */
function UsageChart({ pts, aria }: { pts: ChartPt[]; aria: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(0.01, ...pts.map((d) => d.value));
  const W = 720;
  const H = 96;
  const PAD = 6;
  const stepX = W / Math.max(1, pts.length - 1);
  const coords = pts.map((d, i) => {
    return [i * stepX, H - PAD - (d.value / peak) * (H - PAD * 2)] as const;
  });
  const line = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const labels = axisLabels(pts.map((d) => d.day));
  const last = Math.max(1, pts.length - 1);

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(frac * last));
  }

  const hd = hover !== null ? pts[hover] : null;
  const hx = hover !== null ? (coords[hover][0] / W) * 100 : 0;
  const hy = hover !== null ? (coords[hover][1] / H) * 100 : 0;

  return (
    <div>
      <div
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-24 w-full"
          role="img"
          aria-label={aria}
        >
          <defs>
            <linearGradient id="usageChartFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--color-cta)" stopOpacity="0.15" />
              <stop offset="1" stopColor="var(--color-cta)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#usageChartFill)" />
          <path
            d={line}
            className="stroke-cta"
            strokeWidth={1.5}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {hd && (
          <>
            <div
              className="pointer-events-none absolute bottom-0 top-0 w-px bg-cta/40"
              style={{ left: `${hx}%` }}
            />
            <div
              className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cta ring-2 ring-strip"
              style={{ left: `${hx}%`, top: `${hy}%` }}
            />
            <div
              className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-md border border-field px-2 py-1 text-micro text-l2 ccode-float-surface"
              style={{
                left: `${Math.min(85, Math.max(15, hx))}%`,
                transform: "translateX(-50%)",
              }}
            >
              {hd.day} · {hd.tip}
            </div>
          </>
        )}
      </div>
      <div className="relative mt-1 h-4 text-micro text-l4">
        {labels.map((l) => (
          <span
            key={l.index}
            className="absolute whitespace-nowrap"
            style={{
              left: `${(l.index / last) * 100}%`,
              transform:
                l.index === 0
                  ? "none"
                  : l.index === last
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
            }}
          >
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function StatsPage({ visible }: { visible: boolean }) {
  const setPage = useAppStore((s) => s.setPage);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const sessions = useAppStore((s) => s.sessions);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const [range, setRange] = useState<Range>("week");
  const [view, setView] = useState<DistView>(() =>
    sessionStorage.getItem("ccode.statsGateway") ? "gateway" : "sessions",
  );
  const [chartMetric, setChartMetric] = useState<ChartMetric>(
    () =>
      (localStorage.getItem("ccode.stats.chartMetric") as ChartMetric) || "cost",
  );
  const [modelsOpen, setModelsOpen] = useState(
    () => localStorage.getItem("ccode.stats.modelsOpen") === "1",
  );
  const [gatewayRows, setGatewayRows] = useState<GatewayUsageRow[]>([]);
  const [focusGateway, setFocusGateway] = useState<string | null>(() => {
    const v = sessionStorage.getItem("ccode.statsGateway");
    if (v) sessionStorage.removeItem("ccode.statsGateway");
    return v;
  });
  const [currency, setCurrency] = useState<"$" | "¥">(
    () => (localStorage.getItem("ccode.statsCurrency") as "$" | "¥") || "$",
  );
  const [stats, setStats] = useState<UsageStatsDto | null>(null);
  const [trend, setTrend] = useState<UsageTrendDto | null>(null);
  const [topSessions, setTopSessions] = useState<UsageTopSessionDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [partialError, setPartialError] = useState<string | null>(null);
  const [sessionsLoadError, setSessionsLoadError] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [showInternal, setShowInternal] = useState(
    () => localStorage.getItem("ccode.stats.showInternal") === "1",
  );
  /** 活跃度区块的独立刷新信号：页级「刷新」重建索引后一并重拉（与 range 无关，不进 load） */
  const [activityRefresh, setActivityRefresh] = useState(0);

  // 订阅余量卡（智谱/Kimi/MiniMax 一张卡切换）：进页查 + 可见期 2 分钟自动轮询，手动刷新才 force
  const [planRows, setPlanRows] = useState<PlanQuotaDto[]>([]);
  const [planActive, setPlanActive] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planUsing, setPlanUsing] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const planSeq = useRef(0);
  const gateways = useAppStore((s2) => s2.gateways);
  const hasPlanGateway = useMemo(
    () => gateways.some((g) => gatewayHasPlanQuota(g)),
    [gateways],
  );

  // 网关余额卡（New API 钱包，与订阅余量并列）：进页查 + 可见期 2 分钟轮询
  const [walletRows, setWalletRows] = useState<GatewayBalanceDto[]>([]);
  const [walletActive, setWalletActive] = useState<string | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [hideQuota, setHideQuota] = useState(
    () => localStorage.getItem("ccode.stats.hideQuota") === "1",
  );
  const walletSeq = useRef(0);
  const hasWalletGateway = useMemo(
    () => gateways.some((g) => gatewayHasWallet(g)),
    [gateways],
  );
  /** 按当前网关列表收敛：网关删掉后旧行不得留在卡上；网关列表还没加载出来时不过滤（别把好数据滤没） */
  const walletRowsShown = useMemo(() => {
    if (gateways.length === 0) return walletRows;
    const known = new Set(gateways.map((g) => g.id));
    return walletRows.filter((r) => known.has(r.gatewayId));
  }, [walletRows, gateways]);
  /**
   * 同站同账户合并成一张卡：几个网关共用同一个系统访问令牌时，钱包余额本来就是同一个数字，
   * 逐个摆成标签页会出现「三个标签页一模一样」。合并后钱包数字只出现一次，密钥额度按网关列明细。
   */
  const walletGroups = useMemo(
    () => groupWalletAccounts(walletRowsShown),
    [walletRowsShown],
  );

  async function loadWallets(force: boolean) {
    const seq = ++walletSeq.current;
    setWalletLoading(true);
    try {
      const rows = await invoke<GatewayBalanceDto[]>("gateway_balance_overview", {
        force,
      });
      if (seq !== walletSeq.current) return;
      setWalletRows(rows);
      setWalletError(null);
    } catch (e) {
      if (seq === walletSeq.current) setWalletError(String(e));
    } finally {
      if (seq === walletSeq.current) setWalletLoading(false);
    }
  }

  async function loadPlans(force: boolean) {
    const seq = ++planSeq.current;
    setPlanLoading(true);
    try {
      const rows = await invoke<PlanQuotaDto[]>("plan_quota_overview", { force });
      if (seq !== planSeq.current) return;
      setPlanRows(rows);
      setPlanError(null);
    } catch (e) {
      if (seq === planSeq.current) setPlanError(String(e));
    } finally {
      if (seq === planSeq.current) setPlanLoading(false);
    }
  }

  /** 用一张重置卡：消费性写操作，先确认再触发；成功后整行换成刷新后的余量 */
  async function useResetCard(row: PlanQuotaDto, type: "five_hour" | "weekly") {
    const label = planWindowLabel(type);
    const expiry =
      type === "five_hour"
        ? row.resetCards.fiveHourExpiresAt
        : row.resetCards.weeklyExpiresAt;
    const expiryAt = expiry != null ? formatPlanTimestamp(expiry, Date.now()) : null;
    // 把「这个窗口现在用了多少」写进确认文案：这是不可撤销的消费，
    // 确认前该看到自己按的是哪个数。**0% 时明说会白费但不拦**（2026-09-21 用户：「看着劝退吧 不拦截」）
    const used = row.windows.find((w) => w.window === type)?.usedPercent;
    const usedNote =
      used == null
        ? ""
        : used <= 0
          ? `该窗口当前已用 0%，重置不会腾出任何额度，这张卡会白费。`
          : `该窗口当前已用 ${used.toFixed(0)}%。`;
    const ok = await confirmDialog(
      `立即重置「${label}」窗口的额度？${usedNote}将消耗一张重置卡，消费后不可撤销。${
        expiryAt ? `将优先使用最早过期的一张（${expiryAt} 过期）。` : "将优先使用最早过期的一张。"
      }`,
      { danger: true, confirmText: used != null && used <= 0 ? "仍要用" : "重置", focusCancel: true },
    );
    if (!ok) return;
    setPlanUsing(row.gatewayId + type);
    try {
      const fresh = await invoke<PlanQuotaDto>("plan_use_reset_card", {
        gatewayId: row.gatewayId,
        resetType: type,
      });
      setPlanRows((cur) =>
        cur.map((r) => (r.gatewayId === fresh.gatewayId ? fresh : r)),
      );
      setPlanError(null);
    } catch (e) {
      setPlanError(String(e));
    } finally {
      setPlanUsing(null);
    }
  }

  function openPlanConsole(provider: string) {
    void invoke<string>("plan_quota_console_url", { provider })
      .then((url) => openUrl(url))
      .catch(() => setPlanError("无法打开外部链接"));
  }

  // 并发守卫：快速切换范围时旧响应不得覆盖新范围
  const loadSeq = useRef(0);

  async function load(r: Range) {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const [res, gw, tr, top] = await Promise.all([
        invoke<UsageStatsDto>("get_usage_stats", { range: r }),
        invoke<GatewayUsageRow[]>("usage_by_gateway", { range: r })
          .then((value) => ({ value, failed: false }))
          .catch(() => ({ value: [] as GatewayUsageRow[], failed: true })),
        invoke<UsageTrendDto>("usage_trend", { range: r })
          .then((value) => ({ value, failed: false }))
          .catch(() => ({ value: null, failed: true })),
        invoke<UsageTopSessionDto[]>("top_sessions", { range: r })
          .then((value) => ({ value, failed: false }))
          .catch(() => ({ value: [] as UsageTopSessionDto[], failed: true })),
      ]);
      if (seq !== loadSeq.current) return;
      setStats(res);
      setGatewayRows(gw.value);
      setTrend(tr.value);
      setTopSessions(top.value);
      setError(null);
      const failed = [
        gw.failed && "网关",
        tr.failed && "趋势",
        top.failed && "高费用会话",
      ].filter(Boolean) as string[];
      setPartialError(
        failed.length > 0
          ? `部分统计加载失败（${failed.join("、")}），当前数据可能不完整。`
          : null,
      );
    } catch (e) {
      if (seq === loadSeq.current) {
        setError(String(e));
        setPartialError(null);
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  // 订阅余量 / 网关余额自动轮询：页面开着每 2 分钟刷一次（与后端缓存 TTL 对齐）；不可见即停
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => {
      void loadPlans(false);
      void loadWallets(false);
    }, 120_000);
    return () => clearInterval(timer);
  }, [visible]);

  useEffect(() => {
    if (visible) {
      void load(range);
      void loadPlans(false);
      void loadWallets(false);
      setSessionsLoadError(null);
      void loadSessions().catch((reason) => {
        setSessionsLoadError(`会话明细加载失败：${String(reason)}`);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, range]);

  /** 重建用量索引后再拉取统计；顺带强制重查两张余额卡——页级「刷新」不该只刷费用 */
  async function onRebuild() {
    setRebuilding(true);
    setNotice(null);
    try {
      const res = await invoke<{ sessionsIndexed: number; rows: number }>(
        "rebuild_usage_index",
      );
      setNotice(`已索引 ${res.sessionsIndexed} 个对话`);
      setTimeout(() => setNotice(null), 4000);
      setError(null);
      await load(range);
      setActivityRefresh((k) => k + 1);
      void loadPlans(true);
      void loadWallets(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setRebuilding(false);
    }
  }

  const empty =
    stats !== null &&
    stats.byAgent.length === 0 &&
    stats.byProject.length === 0 &&
    stats.byModel.length === 0 &&
    stats.cards.sessions === 0;
  const totalAgentTokens = Math.max(
    1,
    stats?.byAgent.reduce((s, a) => s + a.tokens, 0) ?? 1,
  );
  const rate = stats?.rateUsdCny ?? 7.2;
  const totalTokens = (stats?.cards.input ?? 0) + (stats?.cards.output ?? 0);
  // 分布区表头：caps 式小字加字距（同 SkillsPage 表头规格），弱化只作列定位
  const th = "px-2 py-1.5 text-left text-micro font-normal tracking-wider text-l4";

  const projectRows = useMemo(() => {
    if (!stats || showInternal) return stats?.byProject ?? [];
    const normal = stats.byProject.filter((p) => !p.internal);
    const internal = stats.byProject.filter((p) => p.internal);
    if (internal.length === 0) return normal;
    return [
      ...normal,
      {
        projectPath: "Mesa 内部 AI 任务",
        tokens: internal.reduce((n, p) => n + p.tokens, 0),
        sessions: internal.reduce((n, p) => n + p.sessions, 0),
        costUsd: internal.some((p) => p.costUsd != null)
          ? internal.reduce((n, p) => n + (p.costUsd ?? 0), 0)
          : null,
        costPartial: internal.some((p) => p.costPartial || p.costUsd == null),
        source: "ccode-ai",
        internal: true,
        official: false,
      },
    ].sort((a, b) => b.tokens - a.tokens);
  }, [showInternal, stats]);

  const modelRows = useMemo(() => {
    if (!stats || showInternal) return stats?.byModel ?? [];
    const normal = stats.byModel.filter((m) => !m.internal);
    const internal = stats.byModel.filter((m) => m.internal);
    if (internal.length === 0) return normal;
    return [
      ...normal,
      {
        model: "Mesa 内部 / 未识别模型",
        input: internal.reduce((n, m) => n + m.input, 0),
        output: internal.reduce((n, m) => n + m.output, 0),
        costUsd: internal.some((m) => m.costUsd != null)
          ? internal.reduce((n, m) => n + (m.costUsd ?? 0), 0)
          : null,
        costPartial: internal.some((m) => m.costPartial || m.costUsd == null),
        source: "ccode-ai",
        internal: true,
      },
    ].sort((a, b) => b.input + b.output - (a.input + a.output));
  }, [showInternal, stats]);

  // 任务成本：与项目排行同一开关口径——默认隐藏 internal 行，打开「显示内部活动」才展示
  const workspaceRows = useMemo(() => {
    const rows = stats?.byWorkspace ?? [];
    return showInternal ? rows : rows.filter((w) => !w.internal);
  }, [showInternal, stats]);

  const hit = stats
    ? cacheHitRate(stats.cards.input, stats.cards.cacheRead)
    : null;
  const trendLive = Boolean(trend?.days.some((d) => d.hasUsage));
  const wow =
    trendLive && trend && trend.days.length > 0
      ? weekOverWeek(
          trend.days.map((d) => ({
            day: d.day,
            costUsd: d.costUsd,
            hasUsage: d.hasUsage,
          })),
          trend.days[trend.days.length - 1].day,
        )
      : null;
  const badge = wowLabel(wow, currency, rate);
  const inShare =
    totalTokens > 0 && stats
      ? Math.round((stats.cards.input / totalTokens) * 100)
      : 0;
  const perChat =
    stats && stats.cards.sessions > 0 && stats.cards.costUsd != null
      ? stats.cards.costUsd / stats.cards.sessions
      : null;
  const distItems = DIST.filter((item) => {
    if (item.id === "sessions") return topSessions.length > 0;
    if (item.id === "agent") return (stats?.byAgent.length ?? 0) > 0;
    if (item.id === "project") return projectRows.length > 0;
    if (item.id === "gateway") return gatewayRows.length > 0;
    return workspaceRows.length > 0;
  });
  const dist: DistView = distItems.some((item) => item.id === view)
    ? view
    : (distItems[0]?.id ?? "agent");
  const rangeLabel = RANGES.find((item) => item.id === range)?.label ?? "";
  const costPts: ChartPt[] = (trend?.days ?? []).map((d) => ({
    day: d.day,
    value: d.costUsd ?? 0,
    tip: fmtCost(d.costUsd, currency, rate, d.costPartial),
  }));
  const tokenPts: ChartPt[] = (stats?.daily ?? []).map((d) => ({
    day: d.day,
    value: d.input + d.output,
    tip: `${compact(d.input + d.output)} tokens · ${fmtCost(d.costUsd, currency, rate, d.costPartial)}`,
  }));
  const canCost = trendLive && costPts.length > 1;
  const canTokens = tokenPts.length > 1;
  const metric: ChartMetric =
    chartMetric === "cost" && canCost ? "cost" : canTokens ? "tokens" : "cost";
  const chartPts = metric === "cost" ? costPts : tokenPts;

  function toggleCurrency() {
    const next = currency === "$" ? "¥" : "$";
    setCurrency(next);
    localStorage.setItem("ccode.statsCurrency", next);
  }

  return (
    <PageFrame width="wide">
      <PageHeader
        title="用量"
        meta="只计经 Mesa 记下归属的会话。费用按公开价估算，≥ 含未计价，~ 无价格。"
      />
      <PageToolbar>
        <SegTabs items={RANGES} value={range} onChange={setRange} />
        <div className="flex items-center gap-1">
          <Checkbox
            checked={showInternal}
            onChange={(checked) => {
              setShowInternal(checked);
              localStorage.setItem(
                "ccode.stats.showInternal",
                checked ? "1" : "0",
              );
            }}
            label="显示内部活动"
            className="rounded-sm px-2 py-0.5 text-xs text-l3 hover:bg-hover"
          />
          <button
            type="button"
            onClick={toggleCurrency}
            title="切换货币（$ 美元 / ¥ 人民币）"
            className="w-7 rounded-sm px-1 py-1 text-xs text-l3 hover:text-l1"
          >
            {currency}
          </button>
          <button
            type="button"
            onClick={() => void onRebuild()}
            disabled={rebuilding}
            className={rowActionClass}
          >
            {rebuilding ? "索引中…" : "刷新"}
          </button>
          {/* 切换范围时保留旧数据，仅局部提示加载，骨架只用于首载 */}
          {loading && stats !== null && (
            <span className="px-1 text-xs text-l4">加载中…</span>
          )}
        </div>
      </PageToolbar>
      {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
      {partialError && (
        <p className="mb-3 text-xs text-warn-text">{partialError}</p>
      )}
      {sessionsLoadError && (
        <p className="mb-3 text-xs text-warn-text">{sessionsLoadError}</p>
      )}
      {notice && <p className="mb-3 text-xs text-ok-text">{notice}</p>}

      {(planRows.length > 0 || (planLoading && hasPlanGateway)) && (
        <div className="mb-6 rounded-lg ccode-well p-4">
          {planRows.length === 0 ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium tracking-wider text-l4">订阅余量</span>
                <button
                  type="button"
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                  disabled={planLoading}
                  title="强制重查"
                  onClick={() => void loadPlans(true)}
                >
                  <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${planLoading ? "animate-spin" : ""}`} />
                </button>
              </div>
              {planError && (
                <p className="mt-2 text-xs text-err-text">{planError}</p>
              )}
              <div className="mt-3 space-y-2">
                <div className="h-3 w-3/4 animate-pulse rounded bg-l4/50" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-l4/50" />
              </div>
            </>
          ) : (
            (() => {
            const active =
              planRows.find((r) => r.gatewayId === planActive) ?? planRows[0];
            const providerCounts = planRows.reduce<Record<string, number>>(
              (acc, r) => ({ ...acc, [r.provider]: (acc[r.provider] ?? 0) + 1 }),
              {},
            );
            const row = active;
            const dataAt = planQuotaDataAt(row.queriedAt, row.fromCache);
            const now = Date.now();
            const windows = planWindowsByTightness(row.windows);
            return (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium tracking-wider text-l4">订阅余量</span>
                  {planGatewayNameVisible(row.gatewayName, row.provider) && (
                    <span className="text-xs text-l2">{row.gatewayName}</span>
                  )}
                  <span className="flex items-center gap-1.5 text-xs text-l2">
                    {PLAN_PROVIDER_ICON[row.provider] && (
                      <img
                        src={PLAN_PROVIDER_ICON[row.provider]}
                        alt=""
                        className="h-3.5 w-3.5 rounded-[3px]"
                      />
                    )}
                    {planProviderLabel(row.provider)}
                  </span>
                  {planLevelLabel(row.planLevel) && (
                    <span className="flex h-4 items-center justify-center rounded-sm bg-hover px-1 text-micro leading-none text-l2">
                      <span className="-translate-y-px">{planLevelLabel(row.planLevel)}</span>
                    </span>
                  )}
                  {dataAt && <span className="text-micro text-l4">{dataAt}</span>}
                  <div className="ml-auto flex items-center">
                    <button
                      type="button"
                      className="flex h-6 w-6 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                      disabled={planLoading}
                      title="强制重查"
                      onClick={() => void loadPlans(true)}
                    >
                      <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${planLoading ? "animate-spin" : ""}`} />
                    </button>
                    <button
                      type="button"
                      className={ghostActionClass}
                      onClick={() => openPlanConsole(row.provider)}
                      title="在系统浏览器打开这家平台的控制台"
                    >
                      去控制台 ↗
                    </button>
                  </div>
                </div>
                {planError && (
                  <p className="mt-2 text-xs text-err-text">{planError}</p>
                )}
                {planRows.length > 1 && (
                  <div className="mt-2">
                    <SegTabs
                      items={planRows.map((r) => ({
                        id: r.gatewayId,
                        label: planTabLabel(r, providerCounts[r.provider] ?? 1),
                      }))}
                      value={row.gatewayId}
                      onChange={setPlanActive}
                    />
                  </div>
                )}
                <div key={row.gatewayId} className="mt-3">
                  {row.error && !row.ok && (
                    <p className="text-xs text-err-text">{row.error}</p>
                  )}
                  <div className="space-y-3">
                    {windows.map((w, i) => (
                      <PlanWindowBlock
                        key={w.window}
                        win={w}
                        now={now}
                        primary={i === 0}
                        lastReset={
                          w.window === "weekly"
                            ? row.resetCards.lastWeekResetAt
                            : w.window === "five_hour"
                              ? row.resetCards.lastFiveHourResetAt
                              : null
                        }
                      />
                    ))}
                  </div>
                  {row.resetCardsSupported && row.resetCards.ok && (
                    row.resetCards.fiveHour + row.resetCards.weekly === 0 ? (
                      <p className="mt-5 text-xs text-l3">重置卡无可用（已用完或套餐不含）</p>
                    ) : (
                      <div
                        className="mt-5 grid gap-x-6 gap-y-3"
                        style={{
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(min(16rem, 100%), 1fr))",
                        }}
                      >
                        {(
                          [
                            {
                              key: "five_hour" as const,
                              label: "5 小时重置卡",
                              count: row.resetCards.fiveHour,
                              expiresAt: row.resetCards.fiveHourExpiresAt,
                            },
                            {
                              key: "weekly" as const,
                              label: "周重置卡",
                              count: row.resetCards.weekly,
                              expiresAt: row.resetCards.weeklyExpiresAt,
                            },
                          ] as const
                        ).map((c) => {
                          const soon = resetCardExpiryNote(c.expiresAt, now);
                          const idle = planWindowUnused(row.windows, c.key);
                          const highlight = planResetCardHighlight(row.windows, c.key);
                          const cardTitle = [
                            soon?.title,
                            idle
                              ? `${planWindowLabel(c.key)}窗口一点没用（0%），现在用卡不会腾出任何额度`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ");
                          return (
                            <div
                              key={c.key}
                              className="flex items-center gap-3"
                              title={cardTitle || undefined}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs text-l2">{c.label}</span>
                                  <span className="rounded-sm bg-hover px-1 py-px text-micro tabular-nums text-l3">
                                    ×{c.count}
                                  </span>
                                </div>
                                {c.count > 0 && (
                                  <span
                                    className={`tabular-nums text-micro ${soon?.urgent ? "text-warn-text" : "text-l4"}`}
                                  >
                                    {soon?.text ?? "无期限数据"}
                                  </span>
                                )}
                              </div>
                              {c.count > 0 && (
                                <button
                                  type="button"
                                  className={
                                    highlight
                                      ? compactPrimaryActionClass
                                      : `${ghostActionClass} h-7 border border-field px-2 text-l2`
                                  }
                                  disabled={planUsing != null}
                                  onClick={() => void useResetCard(row, c.key)}
                                >
                                  {planUsing === row.gatewayId + c.key
                                    ? "使用中…"
                                    : "用一张"}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )
                  )}
                  {row.resetCardsSupported && !row.resetCards.ok && row.resetCards.error && (
                    <p className="mt-5 text-micro text-l4" title={row.resetCards.error}>
                      重置卡查询失败
                    </p>
                  )}
                </div>
              </>
            );
            })()
          )}
        </div>
      )}

      {hasWalletGateway &&
        (walletRowsShown.length > 0 || walletLoading) && (
        <div className="mb-6 rounded-lg ccode-well p-4">
          {walletGroups.length === 0 ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium tracking-wider text-l4">网关余额</span>
                <div className="ml-auto flex items-center">
                  <button
                    type="button"
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1"
                    title={hideQuota ? "显示额度" : "隐藏额度"}
                    onClick={() => {
                      setHideQuota((v) => {
                        const next = !v;
                        localStorage.setItem("ccode.stats.hideQuota", next ? "1" : "0");
                        return next;
                      });
                    }}
                  >
                    {hideQuota ? (
                      <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : (
                      <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                    disabled={walletLoading}
                    title="强制重查"
                    onClick={() => void loadWallets(true)}
                  >
                    <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${walletLoading ? "animate-spin" : ""}`} />
                  </button>
                </div>
              </div>
              {walletError && (
                <p className="mt-2 text-xs text-err-text">{walletError}</p>
              )}
              <div className="mt-3 space-y-2">
                <div className="h-3 w-3/4 animate-pulse rounded bg-l4/50" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-l4/50" />
              </div>
            </>
          ) : (
            (() => {
              const group =
                walletGroups.find((g) => g.key === walletActive) ?? walletGroups[0];
              const row = group.head;
              const dataAt = planQuotaDataAt(row.queriedAt, row.fromCache);
              const usedPct = walletUsedPercent(row.used, row.total);
              const hasAmount = row.remaining != null || row.total != null;
              const amount = splitBalanceAmount(row.remaining ?? row.total ?? NaN, row.currency);
              // 条画剩余（与大数字同向，满条 = 钱还多）；告警档仍按已消耗判
              const balanceBar = walletBalanceBar(row.used, row.total);
              const walletAbs =
                row.used != null && row.total != null
                  ? hideQuota
                    ? `${formatBalanceAmountMasked(row.currency)} / ${formatBalanceAmountMasked(row.currency)}`
                    : `${formatBalanceAmount(row.used, row.currency)} / ${formatBalanceAmount(row.total, row.currency)}`
                  : null;
              const multi = group.members.length > 1;
              const expiringSoon = group.members.filter((m) =>
                walletExpirySoon(m.expiresAt, Date.now()),
              );
              const hintOf = (id: string) =>
                gateways.find((g) => g.id === id)?.keyHint ?? null;
              return (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium tracking-wider text-l4">网关余额</span>
                    {walletGroups.length === 1 && (
                      <span className="text-xs text-l2" title={walletKindLabel(row.kind)}>
                        {walletAccountTitle(group)}
                      </span>
                    )}
                    {dataAt && <span className="text-micro text-l4">{dataAt}</span>}
                    <div className="ml-auto flex items-center">
                      <button
                        type="button"
                        className="flex h-6 w-6 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1"
                        title={hideQuota ? "显示额度" : "隐藏额度"}
                        onClick={() => {
                          setHideQuota((v) => {
                            const next = !v;
                            localStorage.setItem("ccode.stats.hideQuota", next ? "1" : "0");
                            return next;
                          });
                        }}
                      >
                        {hideQuota ? (
                          <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                        ) : (
                          <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="flex h-6 w-6 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                        disabled={walletLoading}
                        title="强制重查"
                        onClick={() => void loadWallets(true)}
                      >
                        <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${walletLoading ? "animate-spin" : ""}`} />
                      </button>
                      <button
                        type="button"
                        className={ghostActionClass}
                        onClick={() => {
                          void openUrl(walletUrl(row.origin)).catch(() =>
                            setWalletError("无法打开外部链接"),
                          );
                        }}
                        title="在系统浏览器打开这个网关的钱包页"
                      >
                        去钱包 ↗
                      </button>
                    </div>
                  </div>
                  {walletError && (
                    <p className="mt-2 text-xs text-err-text">{walletError}</p>
                  )}
                  {walletGroups.length > 1 && (
                    <div className="mt-2">
                      <SegTabs
                        items={walletGroups.map((g) => ({
                          id: g.key,
                          label: walletAccountTitle(g, true),
                        }))}
                        value={group.key}
                        onChange={setWalletActive}
                      />
                    </div>
                  )}
                  <div key={group.key} className="mt-3">
                    {row.error && (
                      <p className={`text-xs ${row.ok ? "text-l4" : "text-err-text"}`}>
                        {row.error}
                      </p>
                    )}
                    <div className="text-xs font-medium tracking-wider text-l4">
                      {walletAmountCaption(row.source)}
                    </div>
                    <div className="mt-0.5 flex items-baseline gap-2">
                      <div className="text-2xl font-semibold tracking-tight tabular-nums text-l1">
                        {hideQuota ? (
                          formatBalanceAmountMasked(row.currency)
                        ) : hasAmount ? (
                          <>
                            {amount.prefix && (
                              <span className="text-base text-l3">{amount.prefix}</span>
                            )}
                            {amount.number}
                            {amount.unit && (
                              <span className="ml-1 text-sm text-l3">{amount.unit}</span>
                            )}
                          </>
                        ) : row.tokenUnlimited || row.unlimited ? (
                          "不限"
                        ) : (
                          "—"
                        )}
                      </div>
                      {row.source === "wallet" && walletAbs && (
                        <span className="font-mono text-xs tabular-nums text-l4">{walletAbs}</span>
                      )}
                    </div>
                    {row.source === "wallet" && balanceBar && (
                      <>
                        <div className="mt-2 h-2 overflow-hidden rounded bg-l4/20">
                          <div
                            className={`h-full rounded ${balanceBar.bar}`}
                            style={{ width: `${Math.min(100, Math.max(0, balanceBar.remainPct))}%` }}
                          />
                        </div>
                        {/* 「已消耗」是事实不是告警——条已经用颜色说话了，这里不上色说第二遍 */}
                        {usedPct != null && (
                          <div className="mt-1 text-micro tabular-nums text-l4">
                            已消耗 {usedPct.toFixed(0)}%
                          </div>
                        )}
                      </>
                    )}
                    {group.members.length > 0 && (
                      <div className="mt-5">
                        <div className="text-xs font-medium tracking-wider text-l4">
                          密钥额度
                        </div>
                        <div className="mt-3 space-y-2">
                          {group.members.map((member) => {
                            const quota = walletTokenQuota(member);
                            const peers = group.members.map(
                              (m) => walletTokenQuota(m)?.used ?? null,
                            );
                            const keyHint = hintOf(member.gatewayId);
                            const note = [
                              member.gatewayName,
                              member.tokenName && member.tokenName !== member.gatewayName
                                ? `站点令牌 ${member.tokenName}`
                                : null,
                              keyHint ? `尾号 ${keyHint}` : null,
                              member.expiresAt != null
                                ? `${formatPlanTimestamp(member.expiresAt, Date.now())} 到期`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ");
                            if (!quota) {
                              return (
                                <WalletKeyRow
                                  key={member.gatewayId}
                                  name={member.gatewayName}
                                  title={note}
                                  usedPct={null}
                                  used={null}
                                  total={null}
                                  currency={member.currency}
                                  empty={member.error ?? "无数据"}
                                  peers={peers}
                                />
                              );
                            }
                            return (
                              <WalletKeyRow
                                key={member.gatewayId}
                                name={member.gatewayName}
                                title={note}
                                unlimited={quota.unlimited}
                                usedPct={quota.pct}
                                used={quota.used}
                                total={quota.total}
                                currency={member.currency}
                                hideAmount={hideQuota}
                                peers={peers}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {expiringSoon.length > 0 && (
                      <p className="mt-2 text-micro text-warn-text">
                        {expiringSoon
                          .map(
                            (m) =>
                              `${multi ? m.gatewayName : "密钥"} ${
                                m.expiresAt == null
                                  ? ""
                                  : formatPlanTimestamp(m.expiresAt, Date.now())
                              } 到期`,
                          )
                          .join("；")}
                      </p>
                    )}
                    {row.source === "token" && (
                      <p className="mt-2 text-xs text-l3">
                        {walletMissingHint(row.hasWalletToken)}
                      </p>
                    )}
                  </div>
                </>
              );
            })()
          )}
        </div>
      )}

      {!stats ? (
        <LoadingRows />
      ) : empty ? (
        <EmptyState
          title="还没有用量记录"
          detail="跑几个 agent 会话后，这里会按天汇总 token 和费用。"
        />
      ) : (
        <div className="mb-6 rounded-lg ccode-well p-4">
            <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
              <div>
                <div className="text-xs font-medium tracking-wider text-l4">
                  费用
                </div>
                <div className="mt-0.5 text-3xl font-semibold tracking-tight tabular-nums text-l1">
                  {fmtCost(
                    stats.cards.costUsd,
                    currency,
                    rate,
                    stats.cards.costPartial,
                  )}
                </div>
                {badge && (
                  <div
                    className={`mt-1 text-xs tabular-nums ${
                      badge.tone === "up"
                        ? "text-warn-text"
                        : badge.tone === "down"
                          ? "text-ok-text"
                          : "text-l3"
                    }`}
                  >
                    {badge.text}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs font-medium tracking-wider text-l4">
                  tokens
                </div>
                <div className="mt-0.5 text-3xl font-semibold tracking-tight tabular-nums text-l1">
                  {compact(totalTokens)}
                </div>
                <div className="mt-1 text-micro text-l4">
                  输入 {inShare}% · 输出 {100 - inShare}%
                </div>
              </div>
            </div>
            <p className="mt-3 text-xs text-l3">
              {stats.cards.sessions} 次对话
              {perChat != null && (
                <>
                  {" "}
                  · 场均 {fmtCost(perChat, currency, rate, stats.cards.costPartial)}
                </>
              )}
              {hit != null && (
                <>
                  {" "}
                  · 缓存 {(hit * 100).toFixed(0)}%
                  {stats.cards.cacheSavingsUsd != null &&
                    stats.cards.costUsd != null && (
                      <>
                        {" "}
                        · 若无缓存约{" "}
                        {fmtCost(
                          stats.cards.costUsd + stats.cards.cacheSavingsUsd,
                          currency,
                          rate,
                          stats.cards.costPartial,
                        )}
                      </>
                    )}
                </>
              )}
              {(stats.cards.officialTokens > 0 || stats.cards.internalTokens > 0) && (
                <>
                  {" "}
                  · 另有{" "}
                  {[
                    stats.cards.officialTokens > 0 &&
                      `订阅 ${compact(stats.cards.officialTokens)}`,
                    stats.cards.internalTokens > 0 &&
                      `内部 ${compact(stats.cards.internalTokens)}`,
                  ]
                    .filter(Boolean)
                    .join(" / ")}{" "}
                  tokens 不计入费用
                </>
              )}
            </p>
            {chartPts.length > 1 && (
              <div className="mt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  {canCost && canTokens ? (
                    <SegTabs
                      items={CHART_METRICS}
                      value={metric}
                      onChange={(id) => {
                        setChartMetric(id);
                        localStorage.setItem("ccode.stats.chartMetric", id);
                      }}
                    />
                  ) : (
                    <span className="text-xs text-l3">
                      {metric === "cost"
                        ? `${rangeLabel}花费`
                        : `${rangeLabel}用量`}
                    </span>
                  )}
                  {canCost && canTokens && (
                    <span className="text-micro text-l4">{rangeLabel}</span>
                  )}
                </div>
                <UsageChart
                  pts={chartPts}
                  aria={
                    metric === "cost"
                      ? `${rangeLabel}花费折线`
                      : `${rangeLabel}用量折线`
                  }
                />
              </div>
            )}
          </div>
      )}

      {/* 活跃度区块挂在 empty 三元之外：页面空态是 range 口径，历史有数据的用户
          恰恰要在空 range 下看到这张图；位置稳定也避免分支切换时组件重挂载 */}
      <ActivityHeatmap
        visible={visible}
        currency={currency}
        rate={rate}
        showInternal={showInternal}
        refreshKey={activityRefresh}
      />

      {stats && !empty && (
        <>
          {distItems.length > 0 && (
          <div className="mb-6 rounded-lg ccode-well p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <SegTabs items={distItems} value={dist} onChange={setView} />
              {dist === "gateway" && focusGateway && (
                <button
                  type="button"
                  className={rowActionClass}
                  onClick={() => setFocusGateway(null)}
                >
                  查看全部
                </button>
              )}
            </div>
          {dist === "sessions" && (
            <ul className="space-y-0.5">
              {topSessions.map((s) => {
                const scanned = sessions.find(
                  (x) => x.agent === s.agent && x.sessionId === s.sessionId,
                );
                const title = sessionDisplayTitle({
                  customTitle: s.title,
                  scannedTitle: scanned?.customTitle ?? scanned?.title,
                  sessionId: s.sessionId,
                });
                return (
                  <li key={`${s.agent}-${s.sessionId}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenSessionReq({
                          agent: s.agent,
                          sessionId: s.sessionId,
                        });
                        setPage("sessions");
                      }}
                      className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-hover"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-l2">
                        {title}
                      </span>
                      <span className="max-w-[7rem] shrink-0 truncate text-micro text-l4">
                        {basename(s.projectPath)}
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-l2">
                        {fmtCost(s.costUsd, currency, rate, s.costPartial)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {dist === "gateway" && (
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>网关</th>
                    <th className={`${th} text-right`}>会话</th>
                    <th className={`${th} text-right`}>tokens</th>
                    <th className={`${th} w-24 text-right`}>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayRows.map((g) => {
                    const tokens = g.tokensIn + g.tokensOut;
                    const focused = focusGateway && g.gatewayId === focusGateway;
                    const official = g.bucket === "official";
                    return (
                      <tr
                        key={`${g.bucket}-${g.gatewayId}`}
                        className={`border-b border-hairline ${focused ? "bg-hover/60" : ""}`}
                      >
                        <td className="max-w-0 truncate px-2 py-2 text-l2" title={g.gatewayName}>
                          {g.gatewayName}
                          <span className="ml-1 text-micro text-l4">{g.agents.join("、")}</span>
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                          {g.sessionCount}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l2">
                          {compact(tokens)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                          {official ? (
                            <SubscriptionCost />
                          ) : (
                            fmtCost(g.costUsd, currency, rate, g.costPartial)
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
          )}

          {dist === "agent" && (
              <ul className="space-y-1">
                {stats.byAgent.map((a) => {
                  const share = a.tokens / totalAgentTokens;
                  return (
                    <li
                      key={`${a.agent}-${a.official}`}
                      className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-hover"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: agentBrand(a.agent) }}
                      />
                      <span className="w-24 shrink-0">
                        <span className="block text-l2">
                          {agentLabel(a.agent)}
                        </span>
                        <span
                          className="block text-micro text-l4"
                          title={`统计范围内使用了 ${a.modelCount} 个不同模型`}
                        >
                          {a.modelCount} 个模型
                        </span>
                      </span>
                      {/* 轨道：inset 底（浅色≈近白浅槽/深色=微亮槽）全圆角；
                          前景与圆点同绑品牌色（v3.94 起，与对话页胶囊同 AGENT_BRAND 口径） */}
                      <span className="h-2 min-w-0 flex-1 rounded-full bg-inset">
                        <span
                          className="block h-2 rounded-full"
                          style={{
                            width: `${Math.max(1.5, share * 100)}%`,
                            backgroundColor: agentBrand(a.agent),
                          }}
                        />
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-l2">
                        {compact(a.tokens)}
                      </span>
                      <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-l4">
                        {(share * 100).toFixed(1)}%
                      </span>
                      <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-l3">
                        {a.official ? (
                          <SubscriptionCost />
                        ) : (
                          fmtCost(a.costUsd, currency, rate, a.costPartial)
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
          )}

          {dist === "project" && (
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>项目</th>
                    <th className={`${th} text-right`}>对话数</th>
                    <th className={`${th} text-right`}>tokens</th>
                    <th className={`${th} w-24 text-right`}>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {projectRows.slice(0, 20).map((p) => {
                    const canJumpToProject = Boolean(p.projectPath) && !p.internal;
                    return (
                      <tr
                        key={`${p.internal}-${p.official}-${p.source}-${p.projectPath}`}
                        className="border-b border-hairline"
                      >
                      <td className="max-w-0 truncate px-2 py-2 text-l2" title={p.projectPath}>
                        {canJumpToProject ? (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectProjectReq(p.projectPath);
                              setPage("workspaces");
                            }}
                            className="inline-flex max-w-full items-center truncate text-left hover:text-l1"
                            title="跳转到项目页"
                          >
                            {basename(p.projectPath)}
                            <span aria-hidden="true" className="ml-1 text-micro text-l4">
                              ↗
                            </span>
                          </button>
                        ) : (
                          <span className="truncate">{basename(p.projectPath)}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        {p.sessions}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l2">
                        {compact(p.tokens)}
                      </td>
                      <td className="w-24 max-w-24 overflow-hidden px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        {p.official ? (
                          <CostText><SubscriptionCost /></CostText>
                        ) : (
                          <CostText>{fmtCost(p.costUsd, currency, rate, p.costPartial)}</CostText>
                        )}
                      </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
          )}

          {dist === "task" && (
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>任务</th>
                    <th className={`${th} text-right`}>tokens</th>
                    <th className={`${th} w-24 text-right`}>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {workspaceRows.map((w) => (
                    <tr
                      key={`${w.internal}-${w.official}-${w.repoName}-${w.workspaceName}`}
                      className="border-b border-hairline"
                    >
                      <td className="max-w-0 truncate px-2 py-2 text-l2">
                        <span className="font-mono">{w.workspaceName}</span>
                        <span className="ml-2 text-xs text-l4">
                          {w.repoName}
                        </span>
                      </td>
                      <td
                        className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l2"
                        title={`输入 ${compact(w.tokensIn)} / 输出 ${compact(
                          w.tokensOut,
                        )}，${w.models} 个模型`}
                      >
                        {compact(w.tokensIn + w.tokensOut)}
                      </td>
                      <td className="w-24 max-w-24 overflow-hidden px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        {w.official ? (
                          <CostText><SubscriptionCost /></CostText>
                        ) : (
                          <CostText>{fmtCost(w.cost, currency, rate, w.costPartial)}</CostText>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
          )}
          </div>
          )}

          {modelRows.length > 0 && (
            <section className="mb-2">
              <button
                type="button"
                onClick={() => {
                  const next = !modelsOpen;
                  setModelsOpen(next);
                  localStorage.setItem(
                    "ccode.stats.modelsOpen",
                    next ? "1" : "0",
                  );
                }}
                aria-expanded={modelsOpen}
                className="flex h-9 w-full items-center gap-2 rounded-md px-1 text-left text-sm font-medium text-l1 hover:bg-hover"
              >
                <FoldMark open={modelsOpen} boxed />
                按模型
                <span className="text-micro font-normal text-l4">
                  {modelRows.length}
                </span>
              </button>
              {modelsOpen && (
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>模型</th>
                    <th className={`${th} text-right`}>输入</th>
                    <th className={`${th} text-right`}>输出</th>
                    <th className={`${th} w-24 text-right`}>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {modelRows.map((m) => (
                    <tr
                      key={`${m.internal}-${m.source}-${m.model}`}
                      className="border-b border-hairline"
                    >
                      <td
                        className="max-w-0 truncate px-2 py-2 text-l2"
                        title={m.model}
                      >
                        {m.model || "（未知）"}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        {compact(m.input)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        {compact(m.output)}
                      </td>
                      <td className="w-24 max-w-24 overflow-hidden px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        <CostText>{fmtCost(m.costUsd, currency, rate, m.costPartial)}</CostText>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              )}
            </section>
          )}
        </>
      )}
    </PageFrame>
  );
}
