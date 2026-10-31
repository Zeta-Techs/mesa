/** 用量页「活跃度」热力图纯逻辑：去年同月滚动网格、四分位分档、连续天数、窗口统计。
 *  日期串 YYYY-MM-DD 全部按 UTC 定宽解析做字符串日历算术（stats-insight 先例），
 *  禁 new Date(day)——本地午夜偏移会把格子错位；day 串本身已是后端本机时区归日结果。
 *  口径：着色/活跃/streak 恒只算非 internal 用量（official 订阅计入）；着色量=四类合计。 */

import type { UsageActivityDayDto } from "./types";

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

const DAY_MS = 86_400_000;

export function utcDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function shiftDay(iso: string, days: number): string {
  const t = utcDay(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

/** 周一=0 … 周日=6（ISO 8601，热力图行序） */
export function weekdayIndex(iso: string): number {
  return (new Date(utcDay(iso)).getUTCDay() + 6) % 7;
}

/** 着色量 = 四类合计（非 internal）：缓存读常是大头，只看输入输出会把重缓存日算成低活跃 */
export function mainTokens(d: UsageActivityDayDto): number {
  return d.input + d.output + d.cacheRead + d.cacheWrite;
}

/** 活跃日集合：当天存在 ≥1 条非 internal 用量行（sessions≥1；官方订阅计入）。
 *  internal 日永不进活跃口径（不撑格子着色与连续天数）。 */
export function activeMainDays(days: UsageActivityDayDto[]): Set<string> {
  const set = new Set<string>();
  for (const d of days) if (d.sessions >= 1) set.add(d.day);
  return set;
}

/** 热力图窗口：去年同一个月的 1 日到今天。今天是 2026-10-15 时即 2025-10-01…2026-10-15。
 *  右边停在今天，不补到年末，也不补完本月剩下的日子。 */
export function rollingBounds(today: string): { start: string; end: string } {
  const y = Number(today.slice(0, 4));
  const m = today.slice(5, 7);
  return { start: `${String(y - 1).padStart(4, "0")}-${m}-01`, end: today };
}

export interface YearHeatGrid {
  /** 7 行（周一…周日）× N 周列；null = 窗口首对齐 pad（不渲染，空 td 保列几何） */
  weeks: ({ day: string } | null)[][];
  /** 月份标签：锚该月第一周、span=该月连续周数；相邻首列间隔 <2 跳过后者（防重叠） */
  monthMarks: { weekIndex: number; span: number; label: string }[];
  /** 窗口内总天数（供 aria 总述） */
  dayCount: number;
}

/** 去年同月 1 日到今天。首列按周一对齐（窗口开始前的日子是 null，不画格）。
 *  最后一列停在今天所在的星期，今天之后的日子不画。月份按出现顺序标注，
 *  所以头尾两个 10 月都会标出来。 */
export function buildRollingGrid(today: string): YearHeatGrid {
  const { start, end } = rollingBounds(today);
  const startMs = utcDay(start) - weekdayIndex(start) * DAY_MS;
  const endMs = utcDay(end);
  const weeks: ({ day: string } | null)[][] = [];
  let dayCount = 0;
  for (let w = startMs; w <= endMs; w += 7 * DAY_MS) {
    const col: ({ day: string } | null)[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(w + i * DAY_MS).toISOString().slice(0, 10);
      if (day >= start && day <= end) {
        col.push({ day });
        dayCount++;
      } else {
        col.push(null);
      }
    }
    weeks.push(col);
  }
  const own = weeks.map((col) => {
    for (const g of col) if (g) return g.day.slice(0, 7);
    return "";
  });
  const monthMarks: { weekIndex: number; span: number; label: string }[] = [];
  let lastAnchor = -9;
  let i = 0;
  while (i < own.length) {
    const key = own[i];
    if (!key) {
      i++;
      continue;
    }
    const first = i;
    let span = 0;
    while (i < own.length && own[i] === key) {
      span++;
      i++;
    }
    if (span >= 2 && first - lastAnchor >= 2) {
      monthMarks.push({
        weekIndex: first,
        span,
        label: `${Number(key.slice(5, 7))}月`,
      });
      lastAnchor = first;
    }
  }
  return { weeks, monthMarks, dayCount };
}

/** 非零天四分位（GitHub ContributionLevel 同构）：t_k = 升序 v[ceil(k·n/4)-1]。
 *  全同值时三阈值相等 → 全部落 1 档（GitHub 单 commit 日即最浅档）；0 不进分位。 */
export function levelThresholds(values: number[]): [number, number, number] {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return [1, 2, 3];
  const q = (k: number) => v[Math.ceil((k * n) / 4) - 1];
  return [q(1), q(2), q(3)];
}

export function levelOf(v: number, t: [number, number, number]): HeatLevel {
  if (v <= 0) return 0;
  if (v <= t[0]) return 1;
  if (v <= t[1]) return 2;
  if (v <= t[2]) return 3;
  return 4;
}

export interface StreakInfo {
  current: number;
  longest: number;
  longestFrom: string | null;
  longestTo: string | null;
}

/** 连续活跃天数。今天宽限：今天尚无活动不清零，从昨天前推（社区 streak-stats 通行
 *  规则）——展示「截至今日或昨日」的口径。最长连续全历史单遍扫描，跨年不断档。 */
export function streaks(active: ReadonlySet<string>, today: string): StreakInfo {
  const has = (iso: string) => active.has(iso);
  let current = 0;
  const anchor = has(today) ? today : has(shiftDay(today, -1)) ? shiftDay(today, -1) : null;
  if (anchor !== null) {
    for (let d = anchor; has(d); d = shiftDay(d, -1)) current++;
  }
  const sorted = [...active].sort();
  let longest = 0;
  let run = 0;
  let longestFrom: string | null = null;
  let longestTo: string | null = null;
  let runFrom: string | null = null;
  let prev: string | null = null;
  for (const day of sorted) {
    if (prev !== null && utcDay(day) - utcDay(prev) === DAY_MS) {
      run++;
    } else {
      run = 1;
      runFrom = day;
    }
    if (run > longest) {
      longest = run;
      longestFrom = runFrom;
      longestTo = day;
    }
    prev = day;
  }
  return { current, longest, longestFrom, longestTo };
}

export interface YearActivityStats {
  activeDays: number;
  peakTokens: number;
  peakDay: string | null;
}

/** 窗口内统计：活跃天数与单日峰值按所选年；连续天数另走 streaks（全历史口径） */
export function yearStats(
  days: UsageActivityDayDto[],
  start: string,
  end: string,
): YearActivityStats {
  let activeDays = 0;
  let peakTokens = 0;
  let peakDay: string | null = null;
  for (const d of days) {
    if (d.day < start || d.day > end) continue;
    if (d.sessions >= 1) activeDays++;
    const v = mainTokens(d);
    if (v > peakTokens) {
      peakTokens = v;
      peakDay = d.day;
    }
  }
  return { activeDays, peakTokens, peakDay };
}

/** tooltip / aria 的中文日期短语：10月12日 周一（今天） */
export function activityDatePhrase(day: string, today: string): string {
  const wd = "一二三四五六日"[weekdayIndex(day)];
  const todayNote = day === today ? "（今天）" : "";
  return `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日 周${wd}${todayNote}`;
}

/** 热力图布局常量：与 App.css `.ccode-heat*` 同步。改一处必须改另一处。 */
/** 星期列 16px + 两侧 border-spacing 各一档（列数 = 周数 + 1，间距有 周数 + 2 道）。
 *  旧值 20 漏了 2px，表格实际比算出的宽 2px，格子刚好吃满时多出一条横向滚动条 */
export const HEAT_LABEL_PX = 22;
export const HEAT_GAP_PX = 3;
/** 格子下限（2026-10-31 用户拍板 11 → 9）：窗口铺满去年同月 1 日到今天最多 57 周，11px 要约 820px，
 *  分屏 / 窄窗下卡片放不下就出横向滚动条；9px 仍是圆角正方形，形状、圆角比例、3px 间距都不变 */
export const HEAT_CELL_MIN_PX = 9;
/** 格子边长上限（2026-10-16 单模布局拍板：胶囊全上卡头、主区无左栏，格子吃满卡宽，
 *  16 → 28 两轮上调）。当前用量页 1440 限宽下实际最大 ~21–22px；28 只是放开限宽前的
 *  地砖闸，不得再抬。到顶后主区收成内容宽、卡片保持列宽。 */
export const HEAT_CELL_MAX_PX = 28;
/** 活跃度卡 `p-4` 左右合计。哨兵量的是卡外满宽，算格子前要扣掉。 */
export const HEAT_WELL_PAD_PX = 32;

/** 格子边长：可用宽度能放下的最大整数 px，夹在 9–28。 */
export function heatCellPx(avail: number, weeks: number): number {
  const w = Math.max(1, weeks);
  const raw = Math.floor((avail - HEAT_LABEL_PX) / w) - HEAT_GAP_PX;
  return Math.max(HEAT_CELL_MIN_PX, Math.min(HEAT_CELL_MAX_PX, raw));
}
