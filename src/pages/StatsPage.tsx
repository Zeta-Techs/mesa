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
  planSwipeTarget,
  planWheelStep,
  PLAN_WHEEL_IDLE,
  PLAN_SWIPE_THRESHOLD,
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
import { ChevronRight, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { toast } from "../toast";
import {
  barWidthPct,
  DIST_PREVIEW,
  shareOf,
  sharePctLabel,
  toTsv,
  visibleDistRows,
} from "../usage-dist";
import VendorIcon from "../components/VendorIcon";
import { vendorForPlanProvider } from "../vendor-icon";
import {
  EmptyState,
  FoldMark,
  LoadingRows,
  PageFrame,
  PageHeader,
  PageToolbar,
  paneOutlineButtonClass,
  compactPrimaryActionClass,
  ghostActionClass,
  SegTabs,
  Toggle,
  NoticeBar,
  InlineNotice,
} from "../components/PageFrame";
import type { WeekOverWeek } from "../stats-insight";
import { pollEvery } from "../polling";

type Range = "today" | "week" | "month" | "all";
type DistView = "sessions" | "agent" | "project" | "gateway" | "task" | "model";
type ChartMetric = "cost" | "tokens";

const DIST: { id: DistView; label: string }[] = [
  { id: "sessions", label: "最贵" },
  { id: "agent", label: "Agent" },
  { id: "project", label: "项目" },
  { id: "gateway", label: "网关" },
  { id: "task", label: "任务" },
  // 原「按模型」是页底单独一块折叠表，和上面五个分布同一类东西却换了一种长相——并成第六个页签
  { id: "model", label: "模型" },
];

/** 分布区统一行：六个页签都映射成这一形状，渲染只有一份（DistList） */
interface DistRowData {
  key: string;
  name: ReactNode;
  /** 名称悬停全称（截断时） */
  nameTitle?: string;
  /** 名称下方一行弱化说明（对话数、模型数、所属项目…） */
  meta?: string;
  /** 行首色点（Agent 品牌色）；不给就不画 */
  dot?: string;
  share: number;
  tokens: number;
  cost: ReactNode;
  /** 复制表格用的纯文本费用 */
  costText: string;
  highlight?: boolean;
  onOpen?: () => void;
  openTitle?: string;
}

const CHART_METRICS: { id: ChartMetric; label: string }[] = [
  { id: "cost", label: "花费" },
  // 页面就叫「用量」，这一格指 tokens，写明（2026-10-23 审查）
  { id: "tokens", label: "tokens" },
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
      <div className="text-xs font-medium tracking-wider text-l3">{caption}</div>
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

type ChartPt = {
  day: string;
  value: number;
  tip: string;
  /** 峰值参考线上写的短数（只写这一样，不带日期与次要信息） */
  short: string;
};

/** 花费/用量共用折线（手绘 SVG）。日期轴常驻，悬停才出当日数字；峰值处常驻一根虚线参考线写出最高值
 *  （2026-10-23 审查：只有日期没有任何数值，看不出起伏有多大） */
function UsageChart({ pts, aria }: { pts: ChartPt[]; aria: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(0.01, ...pts.map((d) => d.value));
  const peakIdx = pts.findIndex((d) => d.value === peak);
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
          {peakIdx >= 0 && (
            <line
              x1={0}
              x2={W}
              y1={PAD}
              y2={PAD}
              className="stroke-l4"
              strokeWidth={1}
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <path
            d={line}
            className="stroke-cta"
            strokeWidth={1.5}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {peakIdx >= 0 && !hd && (
          <>
            <div
              className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cta"
              style={{ left: `${(coords[peakIdx][0] / W) * 100}%`, top: `${(PAD / H) * 100}%` }}
            />
          </>
        )}
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
      <div className="relative mt-1 h-4 text-micro text-l3">
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

/** 余量 / 余额卡的收起钮（默认收起，记在本机） */
function QuotaFold({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? `收起${label}` : `展开${label}`}
      className="-ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1"
    >
      <FoldMark open={open} />
    </button>
  );
}

type QuotaTone = "warn" | "err" | null;

/** 收起态的小圆环：订阅画已用比例，网关余额画剩余比例（与展开后的余额条同向，满圈 = 钱还多）；颜色走告警档 */
function QuotaRing({ pct, tone, label }: { pct: number; tone: QuotaTone; label: string }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  const p = Math.min(100, Math.max(0, pct));
  return (
    <svg viewBox="0 0 36 36" role="img" aria-label={label} className="size-9 shrink-0 -rotate-90">
      <circle cx="18" cy="18" r={r} fill="none" strokeWidth="4" stroke="currentColor" className="text-l1/10" />
      {/* 0% 不画弧：圆头描边在长度 0 时也会点出一个点 */}
      {p > 0 && (
        <circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={`${(c * p) / 100} ${c}`}
          className={tone === "err" ? "text-err-text" : tone === "warn" ? "text-warn-text" : "text-cta"}
        />
      )}
    </svg>
  );
}

/** 余量 / 余额卡收起时的一行：只给最要紧的几个数（订阅：5 小时 / 本周已用；网关：当前余额），各带一个小圆环，点一下展开 */
function QuotaSummary({
  items,
  empty,
  onOpen,
}: {
  items: { label: string; value: string; tone: QuotaTone; ring: { pct: number; tone: QuotaTone; label: string } | null }[];
  empty: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-3 flex w-full flex-wrap items-center gap-x-8 gap-y-3 rounded-md text-left"
      title="展开看详情"
    >
      {items.length === 0 ? (
        <span className="text-sm text-l3">{empty}</span>
      ) : (
        items.map((it) => (
          <span key={it.label} className="flex min-w-0 items-center gap-2.5">
            {it.ring && <QuotaRing {...it.ring} />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs text-l3">{it.label}</span>
              <span
                className={`text-lg font-semibold leading-6 tabular-nums ${
                  it.tone === "err" ? "text-err-text" : it.tone === "warn" ? "text-warn-text" : "text-l1"
                }`}
              >
                {it.value}
              </span>
            </span>
          </span>
        ))
      )}
    </button>
  );
}

function StatLine({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  // 概览卡的一行明细：左名右值（2026-10-29 参考 Claude 客户端用量页）
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-l2">{label}</dt>
      <dd className={`tabular-nums ${valueClass ?? "text-l1"}`}>{value}</dd>
    </div>
  );
}

/** 分布区统一列表：名称（+说明）· 占比条 · tokens · 占比 · 费用；可下钻的行整行可点。
 *  不画表格分隔线（设计系统「块内密集行用间距 + hover，不画线」）；先露 10 行，其余「显示全部」。 */
function DistList({
  rows,
  expanded,
  onToggle,
  shareLabel,
}: {
  rows: DistRowData[];
  expanded: boolean;
  onToggle: () => void;
  shareLabel: string;
}) {
  const { shown, hidden } = visibleDistRows(rows, expanded);
  return (
    <>
      <div className="flex items-center gap-3 px-2 pb-1 text-micro text-l3">
        <span className="min-w-0 flex-1">名称</span>
        <span className="hidden w-[28%] sm:block">{shareLabel}</span>
        <span className="w-16 text-right">tokens</span>
        <span className="w-12 text-right">占比</span>
        <span className="w-20 text-right">费用</span>
      </div>
      <ul className="space-y-0.5">
        {shown.map((r) => {
          const inner = (
            <>
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                {r.dot && (
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: r.dot }}
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0">
                  <span
                    className="flex items-center gap-1 truncate text-sm text-l1"
                    title={r.nameTitle}
                  >
                    <span className="truncate">{r.name}</span>
                    {r.onOpen && (
                      <ChevronRight
                        size={13}
                        strokeWidth={1.8}
                        aria-hidden="true"
                        className="shrink-0 text-l4 opacity-0 transition-opacity group-hover:opacity-100"
                      />
                    )}
                  </span>
                  {r.meta && (
                    <span className="block truncate text-micro text-l3">
                      {r.meta}
                    </span>
                  )}
                </span>
              </span>
              {/* 轨道 inset 底全圆角；前景有品牌色用品牌色（Agent / 对话），否则走强调色 */}
              <span className="hidden h-1.5 w-[28%] shrink-0 rounded-full bg-inset sm:block">
                <span
                  className="block h-1.5 rounded-full"
                  style={{
                    width: `${barWidthPct(r.share)}%`,
                    backgroundColor: r.dot ?? "var(--color-cta)",
                  }}
                />
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-l2">
                {compact(r.tokens)}
              </span>
              <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-l3">
                {sharePctLabel(r.share)}
              </span>
              <span className="w-20 max-w-20 shrink-0 overflow-hidden text-right font-mono text-xs tabular-nums text-l2">
                {r.cost}
              </span>
            </>
          );
          const rowClass = `group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left ${
            r.highlight ? "bg-hover" : ""
          }`;
          return (
            <li key={r.key}>
              {r.onOpen ? (
                <button
                  type="button"
                  onClick={r.onOpen}
                  title={r.openTitle}
                  className={`${rowClass} hover:bg-hover`}
                >
                  {inner}
                </button>
              ) : (
                <div className={rowClass}>{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
      {(hidden > 0 || expanded) && rows.length > DIST_PREVIEW + 2 && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-1 w-full rounded-md py-1.5 text-center text-xs text-l3 hover:bg-hover hover:text-l1"
        >
          {expanded ? "收起" : `显示全部 ${rows.length} 项（还有 ${hidden} 项）`}
        </button>
      )}
    </>
  );
}

export default function StatsPage({ visible }: { visible: boolean }) {
  const setPage = useAppStore((s) => s.setPage);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const setSessionScopeReq = useAppStore((s) => s.setSessionScopeReq);
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
  // 分布区「显示全部」只对当前页签生效：记下展开的是哪个页签，换页签自然回到先露 10 行
  const [distExpanded, setDistExpanded] = useState<DistView | null>(null);
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

  // 订阅余量卡（智谱/Kimi/MiniMax 网关 + Claude/Codex 官方账号，一张卡切换）：进页查 + 可见期 2 分钟自动轮询，手动刷新才 force
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
  // 余量 / 余额卡默认收起（2026-10-29 用户：信息太多），各自记在本机
  const [planOpen, setPlanOpen] = useState(() => localStorage.getItem("ccode.stats.planOpen") === "1");
  const [walletOpen, setWalletOpen] = useState(() => localStorage.getItem("ccode.stats.walletOpen") === "1");
  // 收起态左右滑动切换供应商：触控板横向轻扫（wheel，按一次手势判定，见 plan-quota planWheelStep）或按住拖动；
  // 滑过之后吞掉随之而来的那次点击（否则会顺手展开）
  const planSwipe = useRef({ wheel: PLAN_WHEEL_IDLE, startX: null as number | null, swipedAt: 0 });
  const planStep = (dir: 1 | -1) => {
    const next = planSwipeTarget(planRows.map((r) => r.gatewayId), planActive ?? planRows[0]?.gatewayId ?? null, dir);
    if (next) setPlanActive(next);
  };
  const onPlanWheel = (e: React.WheelEvent) => {
    if (planRows.length < 2) return;
    // 行 / 页单位（外接鼠标横滚）折成像素
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const st = planSwipe.current;
    const r = planWheelStep(st.wheel, e.deltaX * unit, e.deltaY * unit, e.timeStamp);
    st.wheel = r.state;
    if (r.step) {
      planStep(r.step);
      st.swipedAt = performance.now();
    }
  };
  const onPlanPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (planRows.length < 2 || e.button !== 0) return;
    planSwipe.current.startX = e.clientX;
    // 捕获指针：在卡外松手也收得到 pointerup，不留半截状态让下一次点击误切
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPlanPointerUp = (e: React.PointerEvent) => {
    const st = planSwipe.current;
    if (st.startX == null) return;
    const dx = e.clientX - st.startX;
    st.startX = null;
    if (Math.abs(dx) >= PLAN_SWIPE_THRESHOLD) {
      planStep(dx < 0 ? 1 : -1);
      st.swipedAt = performance.now();
    }
  };
  const onPlanSummaryOpen = () => {
    if (performance.now() - planSwipe.current.swipedAt < 300) return;
    togglePlanOpen();
  };
  const togglePlanOpen = () =>
    setPlanOpen((v) => {
      localStorage.setItem("ccode.stats.planOpen", v ? "0" : "1");
      return !v;
    });
  const toggleWalletOpen = () =>
    setWalletOpen((v) => {
      localStorage.setItem("ccode.stats.walletOpen", v ? "0" : "1");
      return !v;
    });
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

  function openPlanConsole(url: string) {
    void openUrl(url).catch(() => setPlanError("无法打开外部链接"));
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
    return pollEvery(() => {
      void loadPlans(false);
      void loadWallets(false);
    }, 120_000);
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
  const distItems = DIST.filter((item) => {
    if (item.id === "sessions") return topSessions.length > 0;
    if (item.id === "agent") return (stats?.byAgent.length ?? 0) > 0;
    if (item.id === "project") return projectRows.length > 0;
    if (item.id === "gateway") return gatewayRows.length > 0;
    if (item.id === "model") return modelRows.length > 0;
    return workspaceRows.length > 0;
  });
  const dist: DistView = distItems.some((item) => item.id === view)
    ? view
    : (distItems[0]?.id ?? "agent");
  const costCell = (
    official: boolean,
    cost: number | null,
    partial: boolean,
  ): { cost: ReactNode; costText: string } =>
    official
      ? { cost: <SubscriptionCost />, costText: "订阅" }
      : (() => {
          const t = fmtCost(cost, currency, rate, partial);
          return { cost: <CostText>{t}</CostText>, costText: t };
        })();
  /** 当前页签的统一行。占比：「最贵」按费用占本区间总花费，其余按 tokens 占本页签合计 */
  const distRows: DistRowData[] = (() => {
    if (!stats) return [];
    if (dist === "sessions") {
      const total = stats.cards.costUsd ?? 0;
      return topSessions.map((s) => {
        const scanned = sessions.find(
          (x) => x.agent === s.agent && x.sessionId === s.sessionId,
        );
        const title = sessionDisplayTitle({
          customTitle: s.title,
          scannedTitle: scanned?.customTitle ?? scanned?.title,
          sessionId: s.sessionId,
        });
        return {
          key: `${s.agent}-${s.sessionId}`,
          name: title,
          nameTitle: title,
          meta: `${agentLabel(s.agent)} · ${basename(s.projectPath)}`,
          dot: agentBrand(s.agent),
          share: shareOf(s.costUsd ?? 0, total),
          tokens: s.tokens,
          ...costCell(false, s.costUsd, s.costPartial),
          onOpen: () => {
            setOpenSessionReq({ agent: s.agent, sessionId: s.sessionId });
            setPage("sessions");
          },
          openTitle: "打开这段对话的回放",
        };
      });
    }
    if (dist === "agent") {
      return stats.byAgent.map((a) => ({
        key: `${a.agent}-${a.official}`,
        name: agentLabel(a.agent),
        meta: `${a.modelCount} 个模型${a.official ? " · 订阅" : ""}`,
        dot: agentBrand(a.agent),
        share: shareOf(a.tokens, totalAgentTokens),
        tokens: a.tokens,
        ...costCell(a.official, a.costUsd, a.costPartial),
        onOpen: () => {
          setSessionScopeReq({
            kind: "agent",
            value: a.agent,
            label: agentLabel(a.agent),
          });
          setPage("sessions");
        },
        openTitle: `在对话页只看 ${agentLabel(a.agent)} 的对话`,
      }));
    }
    if (dist === "project") {
      const total = projectRows.reduce((n, p) => n + p.tokens, 0);
      return projectRows.map((p) => {
        const canJump = Boolean(p.projectPath) && !p.internal;
        return {
          key: `${p.internal}-${p.official}-${p.source}-${p.projectPath}`,
          name: basename(p.projectPath),
          nameTitle: p.projectPath,
          meta: `${p.sessions} 次对话`,
          share: shareOf(p.tokens, total),
          tokens: p.tokens,
          ...costCell(p.official, p.costUsd, p.costPartial),
          onOpen: canJump
            ? () => {
                setSelectProjectReq(p.projectPath);
                setPage("workspaces");
              }
            : undefined,
          openTitle: canJump ? "打开这个项目" : undefined,
        };
      });
    }
    if (dist === "gateway") {
      const total = gatewayRows.reduce((n, g) => n + g.tokensIn + g.tokensOut, 0);
      return gatewayRows.map((g) => ({
        key: `${g.bucket}-${g.gatewayId}`,
        name: g.gatewayName,
        nameTitle: g.gatewayName,
        meta: `${g.sessionCount} 次对话 · ${g.agents.join("、")}`,
        share: shareOf(g.tokensIn + g.tokensOut, total),
        tokens: g.tokensIn + g.tokensOut,
        ...costCell(g.bucket === "official", g.costUsd, g.costPartial),
        highlight: Boolean(focusGateway && g.gatewayId === focusGateway),
      }));
    }
    if (dist === "task") {
      const total = workspaceRows.reduce((n, w) => n + w.tokensIn + w.tokensOut, 0);
      return workspaceRows.map((w) => ({
        key: `${w.internal}-${w.official}-${w.repoName}-${w.workspaceName}`,
        name: <span className="font-mono">{w.workspaceName}</span>,
        nameTitle: w.workspaceName,
        meta: `${w.repoName} · ${w.models} 个模型`,
        share: shareOf(w.tokensIn + w.tokensOut, total),
        tokens: w.tokensIn + w.tokensOut,
        ...costCell(w.official, w.cost, w.costPartial),
      }));
    }
    const total = modelRows.reduce((n, m) => n + m.input + m.output, 0);
    return modelRows.map((m) => ({
      key: `${m.internal}-${m.source}-${m.model}`,
      name: m.model || "（未知）",
      nameTitle: m.model,
      meta: `输入 ${compact(m.input)} · 输出 ${compact(m.output)}`,
      share: shareOf(m.input + m.output, total),
      tokens: m.input + m.output,
      ...costCell(false, m.costUsd, m.costPartial),
    }));
  })();
  const distLabel = DIST.find((d) => d.id === dist)?.label ?? "";
  async function copyDistTable() {
    const tsv = toTsv(
      [distLabel, "说明", "tokens", "占比", "费用"],
      distRows.map((r) => [
        r.nameTitle ?? (typeof r.name === "string" ? r.name : ""),
        r.meta ?? "",
        String(r.tokens),
        sharePctLabel(r.share),
        r.costText,
      ]),
    );
    try {
      await navigator.clipboard.writeText(tsv);
      toast(`已复制 ${distRows.length} 行，可直接粘进表格`, "success");
    } catch (e) {
      toast(`复制失败：${String(e)}`, "error");
    }
  }
  const rangeLabel = RANGES.find((item) => item.id === range)?.label ?? "";
  const costPts: ChartPt[] = (trend?.days ?? []).map((d) => ({
    day: d.day,
    value: d.costUsd ?? 0,
    tip: fmtCost(d.costUsd, currency, rate, d.costPartial),
    short: fmtCost(d.costUsd, currency, rate, d.costPartial),
  }));
  const tokenPts: ChartPt[] = (stats?.daily ?? []).map((d) => ({
    day: d.day,
    value: d.input + d.output,
    tip: `${compact(d.input + d.output)} tokens · ${fmtCost(d.costUsd, currency, rate, d.costPartial)}`,
    short: `${compact(d.input + d.output)} tokens`,
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

  // 2026-10-29：页头与宽度维持原样（PageFrame wide）；工具条用分段控件 / 开关 / 细边按钮；
  // 下面一律卡片（参考 Claude 客户端用量页）：余量 / 余额两张可收起的卡并排，概览两张卡（花费、tokens）并排，再是趋势、活跃度、分布三张卡
  return (
    <PageFrame width="wide">
      <PageHeader
        title="用量"
        meta="只计经 Mesa 记下归属的会话。费用按公开价估算，≥ 含未计价，~ 无价格。"
      />
      <PageToolbar>
        <SegTabs variant="boxed" items={RANGES} value={range} onChange={setRange} />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {/* 切换范围时保留旧数据，仅局部提示加载，骨架只用于首载 */}
          {loading && stats !== null && (
            <span className="text-xs text-l4">加载中…</span>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-xs text-l3">
            显示内部活动
            <Toggle
              label="显示内部活动"
              checked={showInternal}
              onChange={(checked) => {
                setShowInternal(checked);
                localStorage.setItem(
                  "ccode.stats.showInternal",
                  checked ? "1" : "0",
                );
              }}
            />
          </label>
          {/* 币种：两格分段切换（原先一颗裸「¥」，不悬停看不出能点；2026-10-23 审查） */}
          <div
            role="group"
            aria-label="货币"
            className="ccode-seg-boxed is-sm inline-flex items-center"
          >
            {(["$", "¥"] as const).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={currency === c}
                title={c === "$" ? "按美元显示" : "按人民币显示"}
                onClick={() => {
                  if (currency !== c) toggleCurrency();
                }}
                className="ccode-seg-boxed-item flex items-center text-xs tabular-nums"
              >
                {c}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void onRebuild()}
            disabled={rebuilding}
            className={paneOutlineButtonClass}
          >
            {rebuilding ? "索引中…" : "刷新"}
          </button>
        </div>
      </PageToolbar>
      {error && <NoticeBar tone="err" className="mb-3" onDismiss={() => setError(null)}>{error}</NoticeBar>}
      {partialError && (
        <InlineNotice tone="warn" className="mb-3">{partialError}</InlineNotice>
      )}
      {sessionsLoadError && (
        <InlineNotice tone="warn" className="mb-3">{sessionsLoadError}</InlineNotice>
      )}
      {notice && <NoticeBar className="mb-3" onDismiss={() => setNotice(null)}>{notice}</NoticeBar>}

      {((planRows.length > 0 || (planLoading && hasPlanGateway)) ||
        (hasWalletGateway && (walletRowsShown.length > 0 || walletLoading))) && (
      <div className="mb-4 grid items-start gap-4 lg:grid-cols-2">
      {(planRows.length > 0 || (planLoading && hasPlanGateway)) && (
        <section className="ccode-well ccode-card p-4" aria-label="订阅余量">
          {planRows.length === 0 ? (
            <>
              <div className="flex min-h-8 items-center gap-2">
                <h2 className="text-base font-medium text-l1">订阅余量</h2>
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
                <InlineNotice tone="err" className="mt-2">{planError}</InlineNotice>
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
                {/* 卡头恒一行，与网关余额卡同口径：网关名可截断，其余不缩 */}
                <div className="flex min-h-8 items-center gap-2">
                  <QuotaFold open={planOpen} onToggle={togglePlanOpen} label="订阅余量" />
                  <h2 className="shrink-0 text-base font-medium text-l1">订阅余量</h2>
                  {planGatewayNameVisible(row.gatewayName, row.provider) && (
                    <span className="min-w-0 truncate text-xs text-l2" title={row.gatewayName}>{row.gatewayName}</span>
                  )}
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-l2">
                    {vendorForPlanProvider(row.provider) && (
                      <VendorIcon
                        vendor={vendorForPlanProvider(row.provider)}
                        name={planProviderLabel(row.provider)}
                        className="h-3.5 w-3.5"
                      />
                    )}
                    {planProviderLabel(row.provider)}
                  </span>
                  {planLevelLabel(row.planLevel) && (
                    <span className="flex h-4 shrink-0 items-center justify-center rounded-sm bg-hover px-1 text-micro leading-none text-l2">
                      <span className="-translate-y-px">{planLevelLabel(row.planLevel)}</span>
                    </span>
                  )}
                  {dataAt && <span className="shrink-0 whitespace-nowrap text-micro text-l4">{dataAt}</span>}
                  <div className="ml-auto flex shrink-0 items-center">
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
                      onClick={() => openPlanConsole(row.consoleUrl)}
                      title="在系统浏览器打开这家平台的控制台"
                    >
                      去控制台 ↗
                    </button>
                  </div>
                </div>
                {planError && (
                  <InlineNotice tone="err" className="mt-2">{planError}</InlineNotice>
                )}
                {/* 收起时只看各窗已用（5 小时 / 本周…），多家时左右滑动切换、不放标签（2026-10-31 用户）；
                    展开才有大数字、进度条、重置卡、多家切换标签 */}
                {!planOpen ? (
                  <div
                    className="select-none"
                    onWheel={onPlanWheel}
                    onPointerDown={onPlanPointerDown}
                    onPointerUp={onPlanPointerUp}
                    onPointerCancel={() => (planSwipe.current.startX = null)}
                    onKeyDown={(e) => {
                      if (planRows.length < 2) return;
                      if (e.key === "ArrowRight") planStep(1);
                      else if (e.key === "ArrowLeft") planStep(-1);
                    }}
                    title={planRows.length > 1 ? `左右滑动切换（${planRows.findIndex((r) => r.gatewayId === row.gatewayId) + 1} / ${planRows.length}）` : undefined}
                  >
                  <QuotaSummary
                    items={row.windows.map((w) => {
                      const tone: QuotaTone = w.usedPercent >= 90 ? "err" : w.usedPercent >= 70 ? "warn" : null;
                      const label = `${planWindowLabel(w.window)}已用`;
                      return {
                        label,
                        value: `${Math.round(w.usedPercent)}%`,
                        tone,
                        ring: { pct: w.usedPercent, tone, label: `${label} ${Math.round(w.usedPercent)}%` },
                      };
                    })}
                    empty={row.error && !row.ok ? row.error : "暂无数据"}
                    onOpen={onPlanSummaryOpen}
                  />
                  </div>
                ) : (
                <>
                {planRows.length > 1 && (
                  <div className="mt-3">
                    <SegTabs
                      variant="boxed"
                      size="sm"
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
                )}
              </>
            );
            })()
          )}
        </section>
      )}

      {hasWalletGateway &&
        (walletRowsShown.length > 0 || walletLoading) && (
        <section className="ccode-well ccode-card p-4" aria-label="网关余额">
          {walletGroups.length === 0 ? (
            <>
              <div className="flex min-h-8 items-center gap-2">
                <h2 className="text-base font-medium text-l1">网关余额</h2>
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
                <InlineNotice tone="err" className="mt-2">{walletError}</InlineNotice>
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
                  {/* 卡头恒一行（2026-10-31 用户：窗口一窄按钮掉到第二行、卡片变高）：站点名可截断，其余不缩 */}
                  <div className="flex min-h-8 items-center gap-2">
                    <QuotaFold open={walletOpen} onToggle={toggleWalletOpen} label="网关余额" />
                    <h2 className="shrink-0 text-base font-medium text-l1">网关余额</h2>
                    {walletGroups.length === 1 && (
                      <span
                        className="min-w-0 truncate text-xs text-l2"
                        title={`${walletAccountTitle(group)} · ${walletKindLabel(row.kind)}`}
                      >
                        {walletAccountTitle(group)}
                      </span>
                    )}
                    {dataAt && <span className="shrink-0 whitespace-nowrap text-micro text-l4">{dataAt}</span>}
                    <div className="ml-auto flex shrink-0 items-center">
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
                    <InlineNotice tone="err" className="mt-2">{walletError}</InlineNotice>
                  )}
                  {/* 收起时只看当前余额（同一站多个账户各一行），展开才有进度条、密钥额度、多账户切换 */}
                  {!walletOpen ? (
                    <QuotaSummary
                      items={walletGroups.map((g) => {
                        // 圆环画剩余比例；没有总量（不限额度 / 缺数据）就不画，不拿空圈冒充
                        const usedPct = walletUsedPercent(g.head.used, g.head.total);
                        const label = walletGroups.length > 1 ? walletAccountTitle(g, true) : walletAmountCaption(g.head.source);
                        return {
                          label,
                          ring:
                            usedPct == null
                              ? null
                              : {
                                  pct: 100 - usedPct,
                                  tone: (usedPct >= 90 ? "err" : usedPct >= 80 ? "warn" : null) as QuotaTone,
                                  label: `${label}：剩余 ${Math.round(100 - usedPct)}%`,
                                },
                          value: hideQuota
                            ? formatBalanceAmountMasked(g.head.currency)
                            : g.head.remaining != null || g.head.total != null
                              ? formatBalanceAmount(g.head.remaining ?? g.head.total ?? NaN, g.head.currency)
                              : g.head.tokenUnlimited || g.head.unlimited
                                ? "不限"
                                : "—",
                          tone: null,
                        };
                      })}
                      empty="暂无数据"
                      onOpen={toggleWalletOpen}
                    />
                  ) : (
                  <>
                  {walletGroups.length > 1 && (
                    <div className="mt-3">
                      <SegTabs
                        variant="boxed"
                        size="sm"
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
                    <div className="text-xs font-medium tracking-wider text-l3">
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
                        <div className="text-xs font-medium tracking-wider text-l3">
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
                  )}
                </>
              );
            })()
          )}
        </section>
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
        <>
          {/* 概览两张卡（参考 Claude 客户端用量页）：大数字一行，下面左名右值的明细行，脚注一句口径。
              次要指标只留对话次数与不计费（2026-10-23 用户「没用的不要」）；tokens 明细给全数（不缩写），方便对账 */}
          <div className="mb-4 grid gap-4 md:grid-cols-2">
            <section className="ccode-well ccode-card flex flex-col p-4" aria-label="花费">
              <h2 className="text-base font-medium text-l1">花费</h2>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
                <span className="text-2xl font-semibold tracking-tight tabular-nums text-l1">
                  {fmtCost(stats.cards.costUsd, currency, rate, stats.cards.costPartial)}
                </span>
                <span className="text-sm text-l3">按公开价估算</span>
              </div>
              <dl className="mt-3 space-y-1 text-sm">
                {badge && (
                  <StatLine
                    label="周环比"
                    value={badge.text}
                    valueClass={badge.tone === "up" ? "text-warn-text" : badge.tone === "down" ? "text-ok-text" : undefined}
                  />
                )}
                <StatLine label="对话" value={`${stats.cards.sessions.toLocaleString("en-US")} 次`} />
                {stats.cards.officialTokens > 0 && (
                  <StatLine label="订阅（不计费）" value={`${compact(stats.cards.officialTokens)} tokens`} />
                )}
                {stats.cards.internalTokens > 0 && (
                  <StatLine label="Mesa 内部（不计费）" value={`${compact(stats.cards.internalTokens)} tokens`} />
                )}
              </dl>
              {/* 脚注贴卡底：两张卡明细行数不一样，脚注对齐成一条线 */}
              <p className="mt-auto pt-3 text-xs text-l4">
                官方订阅与 Mesa 内部 AI 的 tokens 统计在内，但不算进费用；≥ 表示含未计价模型。
              </p>
            </section>
            <section className="ccode-well ccode-card flex flex-col p-4" aria-label="tokens">
              <h2 className="text-base font-medium text-l1">tokens</h2>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
                <span className="text-2xl font-semibold tracking-tight tabular-nums text-l1">
                  {compact(totalTokens)}
                </span>
                <span className="text-sm text-l3">输入 + 输出</span>
              </div>
              <dl className="mt-3 space-y-1 text-sm">
                <StatLine label="输入" value={stats.cards.input.toLocaleString("en-US")} />
                <StatLine label="输出" value={stats.cards.output.toLocaleString("en-US")} />
                <StatLine label="缓存读" value={stats.cards.cacheRead.toLocaleString("en-US")} />
                <StatLine label="缓存写" value={stats.cards.cacheWrite.toLocaleString("en-US")} />
              </dl>
              <p className="mt-auto pt-3 text-xs text-l4">
                输入 {inShare}% · 输出 {100 - inShare}%；缓存读写不计入上面的大数字。
              </p>
            </section>
          </div>
            {chartPts.length > 1 && (
              <section className="mb-4 ccode-well ccode-card p-4" aria-label="走势">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-base font-medium text-l1">
                      {metric === "cost" ? "每天花费" : "每天 tokens"}
                    </h2>
                    <p className="mt-0.5 text-sm text-l3">{rangeLabel}，按天合计</p>
                  </div>
                  <div className="flex items-center gap-3">
                  {/* 右上写峰值（与图里那根虚线对应） */}
                  {(() => {
                    const top = chartPts.reduce((a, b) => (b.value > a.value ? b : a), chartPts[0]);
                    return top.value > 0 ? (
                      <span className="text-xs tabular-nums text-l3" title={`${top.day} 最高`}>
                        最高 {top.short} · {top.day.slice(5)}
                      </span>
                    ) : null;
                  })()}
                  {canCost && canTokens && (
                    <SegTabs
                      variant="boxed"
                      size="sm"
                      items={CHART_METRICS}
                      value={metric}
                      onChange={(id) => {
                        setChartMetric(id);
                        localStorage.setItem("ccode.stats.chartMetric", id);
                      }}
                    />
                  )}
                  </div>
                </div>
                <UsageChart
                  pts={chartPts}
                  aria={
                    metric === "cost"
                      ? `${rangeLabel}花费折线`
                      : `${rangeLabel}用量折线`
                  }
                />
              </section>
            )}
        </>
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

      {stats && !empty && distItems.length > 0 && (
        <section className="mb-4 ccode-well ccode-card p-4" aria-label="分布">
          <div className="mb-2 flex min-h-8 flex-wrap items-center gap-2">
            <h2 className="text-base font-medium text-l1">分布</h2>
            <div className="ml-auto flex flex-wrap items-center gap-2">
            <SegTabs variant="boxed" size="sm" items={distItems} value={dist} onChange={setView} />
              {dist === "gateway" && focusGateway && (
                <button
                  type="button"
                  className={ghostActionClass}
                  onClick={() => setFocusGateway(null)}
                >
                  取消高亮
                </button>
              )}
              <button
                type="button"
                className={ghostActionClass}
                onClick={() => void copyDistTable()}
                title="复制当前页签为表格（制表符分隔），可直接粘进 Excel / Numbers"
              >
                <Copy size={13} strokeWidth={1.8} className="mr-1" aria-hidden="true" />
                复制表格
              </button>
            </div>
          </div>
          <div className="border-t border-hairline pt-2">
          <DistList
            rows={distRows}
            expanded={distExpanded === dist}
            onToggle={() =>
              setDistExpanded((cur) => (cur === dist ? null : dist))
            }
            shareLabel={dist === "sessions" ? "占花费" : "占用量"}
          />
          </div>
        </section>
      )}
    </PageFrame>
  );
}
