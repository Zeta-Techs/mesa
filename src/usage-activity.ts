/** 用量页「活跃度」热力图纯逻辑：年份网格、四分位分档、连续天数、年度统计。
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

/** 年份窗口：当年 [1/1, today]（今天之后的格子不存在），往年 [1/1, 12/31] */
export function yearBounds(
  year: number,
  today: string,
): { start: string; end: string } {
  const cy = Number(today.slice(0, 4));
  return { start: `${year}-01-01`, end: year >= cy ? today : `${year}-12-31` };
}

/** 热力图窗口：去年同一个月的 1 日到今天。今天是 2026-10-15 时即 2025-10-01…2026-10-15。
 *  右边停在今天，不补到年末，也不补完本月剩下的日子。 */
export function rollingBounds(today: string): { start: string; end: string } {
  const y = Number(today.slice(0, 4));
  const m = today.slice(5, 7);
  return { start: `${String(y - 1).padStart(4, "0")}-${m}-01`, end: today };
}

export interface YearHeatGrid {
  /** 7 行（周一…周日）× N 周列；null = 年首对齐 pad（不渲染，空 td 保列几何） */
  weeks: ({ day: string; future: boolean } | null)[][];
  /** 月份标签：锚该月第一周、span=该月连续周数；相邻首列间隔 <2 跳过后者（防重叠）；
   *  当年「整月都在今天之后」的月份不标（12 月不悬空） */
  monthMarks: { weekIndex: number; span: number; label: string }[];
  /** 年内总天数（供 aria 总述；含未来日） */
  dayCount: number;
}

/** 周一开头、整年（1/1–12/31）网格：当年与往年列数一致，翻年时网格宽度不跳变；
 *  未来日（> today）标记 future，组件渲染成无内容空格。月份归属按「每周第一个
 *  窗口内日的月份」，跨月共周不会丢标签。 */
export function buildYearGrid(year: number, today: string): YearHeatGrid {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const startMs = utcDay(start) - weekdayIndex(start) * DAY_MS;
  const endMs = utcDay(end);
  const weeks: ({ day: string; future: boolean } | null)[][] = [];
  let dayCount = 0;
  for (let w = startMs; w <= endMs; w += 7 * DAY_MS) {
    const col: ({ day: string; future: boolean } | null)[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(w + i * DAY_MS).toISOString().slice(0, 10);
      if (day >= start && day <= end) {
        col.push({ day, future: day > today });
        dayCount++;
      } else {
        col.push(null);
      }
    }
    weeks.push(col);
  }
  // 全部格子都在今天的月份不标（当年年末的未来月）
  const monthHasPast = new Set<number>();
  for (const col of weeks) {
    for (const g of col) {
      if (g && !g.future) monthHasPast.add(Number(g.day.slice(5, 7)));
    }
  }
  const own = weeks.map((col) => {
    for (const g of col) if (g) return Number(g.day.slice(5, 7));
    return 0;
  });
  const monthMarks: { weekIndex: number; span: number; label: string }[] = [];
  let lastAnchor = -9;
  for (let m = 1; m <= 12; m++) {
    if (!monthHasPast.has(m)) continue;
    let first = -1;
    let span = 0;
    for (let i = 0; i < own.length; i++) {
      if (own[i] === m) {
        if (first < 0) first = i;
        span++;
      } else if (first >= 0) break;
    }
    if (first >= 0 && span >= 2 && first - lastAnchor >= 2) {
      monthMarks.push({ weekIndex: first, span, label: `${m}月` });
      lastAnchor = first;
    }
  }
  return { weeks, monthMarks, dayCount };
}

/** 去年同月 1 日到今天。首列按周一对齐（窗口开始前的日子是 null，不画格）。
 *  最后一列停在今天所在的星期，今天之后的日子不画。月份按出现顺序标注，
 *  所以头尾两个 10 月都会标出来。 */
export function buildRollingGrid(today: string): YearHeatGrid {
  const { start, end } = rollingBounds(today);
  const startMs = utcDay(start) - weekdayIndex(start) * DAY_MS;
  const endMs = utcDay(end);
  const weeks: ({ day: string; future: boolean } | null)[][] = [];
  let dayCount = 0;
  for (let w = startMs; w <= endMs; w += 7 * DAY_MS) {
    const col: ({ day: string; future: boolean } | null)[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(w + i * DAY_MS).toISOString().slice(0, 10);
      if (day >= start && day <= end) {
        col.push({ day, future: false });
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
export const HEAT_LABEL_PX = 20;
export const HEAT_GAP_PX = 3;
export const HEAT_CELL_MIN_PX = 11;
/** 格子边长上限。再大就是已否决的「地砖」；到顶后主区收成内容宽、卡片保持列宽，不再把格子拉大。 */
export const HEAT_CELL_MAX_PX = 16;
export const HEAT_RAIL_AT = 1020;
export const HEAT_CHIP_COL_PX = 256;
export const HEAT_MAIN_GAP_PX = 24;
export const HEAT_WIDE_REMAINDER_PX = 220;
export const HEAT_WIDE_EXIT_PX = 180;
/** 活跃度卡 `p-4` 左右合计。哨兵量的是卡外满宽，算格子前要扣掉。 */
export const HEAT_WELL_PAD_PX = 32;

/** 格子边长：可用宽度能放下的最大整数 px，夹在 11–16。16 是地砖禁令，不得再抬。 */
export function heatCellPx(avail: number, weeks: number): number {
  const w = Math.max(1, weeks);
  const raw = Math.floor((avail - HEAT_LABEL_PX) / w) - HEAT_GAP_PX;
  return Math.max(HEAT_CELL_MIN_PX, Math.min(HEAT_CELL_MAX_PX, raw));
}

export function heatRailLeft(mainWidth: number): boolean {
  return mainWidth >= HEAT_RAIL_AT;
}

/** 超宽档：卡内容宽按 16px 网格算完左栏后还剩 ≥220px 才把统计挂到右侧。
 *  进出用 40px 回差，避免卡在门槛上抖动。传入的宽度必须是页面满宽哨兵
 *  （扣掉卡内边距），禁止用 `width: max-content` 之后的主区宽度来判断。 */
export function heatWideAside(
  mainWidth: number,
  weeks: number,
  hasChips: boolean,
  currentlyWide: boolean,
): boolean {
  if (!heatRailLeft(mainWidth)) return false;
  const chips = hasChips ? HEAT_CHIP_COL_PX + HEAT_MAIN_GAP_PX : 0;
  const w = Math.max(1, weeks);
  const gridAtMax =
    HEAT_LABEL_PX + (HEAT_CELL_MAX_PX + HEAT_GAP_PX) * w;
  const leftover = mainWidth - chips - gridAtMax;
  return leftover >= (currentlyWide ? HEAT_WIDE_EXIT_PX : HEAT_WIDE_REMAINDER_PX);
}
