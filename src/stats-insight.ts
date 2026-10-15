/** 统计页「花得快不快 / 钱花在哪 / 缓存省了多少」纯逻辑。
 *  环比、命中率、会话标题回落都走这里；SVG 与跳转留在 StatsPage。 */

export interface TrendDay {
  day: string;
  /** 已计价且非官方账号的花费；当天无 API 用量为 0 */
  costUsd: number | null;
  /** 当天是否有任意用量行（含官方账号 / 未计价） */
  hasUsage: boolean;
}

export interface WeekOverWeek {
  thisWeek: number;
  lastWeek: number;
  /** 上周花费为 0 时无法算百分比（避免除零），只展示本周金额 */
  percent: number | null;
}

function utcDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function shiftDay(iso: string, days: number): string {
  const t = utcDay(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

function sumCost(days: TrendDay[], from: string, to: string): { sum: number; hasUsage: boolean } {
  let sum = 0;
  let hasUsage = false;
  for (const d of days) {
    if (d.day < from || d.day > to) continue;
    if (d.hasUsage) hasUsage = true;
    sum += d.costUsd ?? 0;
  }
  return { sum, hasUsage };
}

/** 本周 = 含 today 的近 7 天，上周 = 再往前 7 天。
 *  上周窗口没有任何用量行 → 不出徽章（返回 null）。 */
export function weekOverWeek(days: TrendDay[], today: string): WeekOverWeek | null {
  if (!today || Number.isNaN(utcDay(today))) return null;
  const thisFrom = shiftDay(today, -6);
  const lastTo = shiftDay(today, -7);
  const lastFrom = shiftDay(today, -13);
  const thisW = sumCost(days, thisFrom, today);
  const lastW = sumCost(days, lastFrom, lastTo);
  if (!lastW.hasUsage) return null;
  const percent =
    lastW.sum > 0
      ? Math.round(((thisW.sum - lastW.sum) / lastW.sum) * 100)
      : null;
  return { thisWeek: thisW.sum, lastWeek: lastW.sum, percent };
}

/** 命中率 = cache_read / (input + cache_read)。分母为 0 则无故事。 */
export function cacheHitRate(input: number, cacheRead: number): number | null {
  const den = input + cacheRead;
  if (den <= 0) return null;
  return cacheRead / den;
}

export function shortSessionId(id: string): string {
  const compact = id.replace(/-/g, "");
  if (compact.length <= 8) return compact || id;
  return compact.slice(-8);
}

/** 标题优先级：自定义名 → 会话扫描标题 → 短 id */
export function sessionDisplayTitle(opts: {
  customTitle?: string | null;
  scannedTitle?: string | null;
  sessionId: string;
}): string {
  const custom = opts.customTitle?.trim();
  if (custom) return custom;
  const scanned = opts.scannedTitle?.trim();
  if (scanned) return scanned;
  return shortSessionId(opts.sessionId);
}

/** 紧凑数字：1234567 → 1.2M，12345 → 12K（统计页统一数字方言） */
export function compact(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

/** 费用展示：~ 无价格、≥ 含未计价模型、$ / ¥ 按 rate 换算 */
export function fmtCost(
  c: number | null,
  currency: "$" | "¥",
  rate: number,
  partial: boolean,
): string {
  if (c == null) return "~";
  const prefix = partial ? "≥" : "";
  return currency === "¥"
    ? `${prefix}¥${(c * rate).toFixed(2)}`
    : `${prefix}$${c.toFixed(2)}`;
}
