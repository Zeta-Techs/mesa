/**
 * 文献雷达（lit-watch）前端纯逻辑：日分组、周趋势、PDF 直链、精读清单拼接、
 * 已读判定、收件箱候选、快筛解读 prompt/拆节。与 DOM/Tauri 解耦（localStorage 薄层除外），
 * 供 node --test 直接测；组件 LitWatchCard 保持薄。
 * DTO 与 src-tauri/src/lit_watch.rs 的 camelCase 序列化一一对应。
 */
import { LIT_WATCH_SLOT } from "./skill-slots.ts";
import { samePath } from "./path-utils.ts";
import type { LitWatchFilterDto, ScheduleDto } from "./types.ts";

// ===== DTO（对照 lit_watch.rs；新命令的类型在本文件就近声明） =====

/** inbox.md 中的一条文献命中 */
export interface WatchEntryDto {
  /** 标题 + 原注释批次日期的稳定哈希，`w-<hex>`；兼容已有忽略记录 */
  id: string;
  title: string;
  /** 来源行第一段（arxiv / 期刊 / 会议名） */
  source: string;
  authors: string;
  abstractFirst: string;
  keywordsHit: string[];
  /** "推荐" | "相关" | "待确认"（缺漏一律按待确认） */
  relevance: string;
  journal: string | null;
  /** 中文一句话；旧条目为空串 */
  zhSummary: string;
  /** 链接/DOI 段；没有为空串 */
  url: string;
  /** 发表日期（来源行第二段，arXiv 发布日/期刊出版日）；旧条目缺段为 null */
  pubDate: string | null;
  /** 巡检批次日期 YYYY-MM-DD（标准注释或旧版巡检标题）；缺失/无效为 null */
  date: string | null;
  rawLineRange: [number, number];
  /** 期刊指标（JCR2025 + 中科院分区表2025 合并，按期刊名规范化匹配）；未匹配/未装表为 null */
  metrics: JournalMetricsDto | null;
  /** 已落盘的快筛解读（`.ccode/watch-explains.json`）；未解读为 null */
  explain: string | null;
}

/**
 * 分区标签：淡底 + 同色字 + 细边。不用 ok/warn/cta-pill 的实心底——
 * 深色主题那三块近黑，浅色主题铺开也发闷。1 区 / TOP 强调色，2 区通过色，3 区提醒色，其余中性。
 * 定时检索与检索清单共用。
 */
const METRIC_CACHE_KEY = "ccode.journalMetricsByDoi";

function metricCache(): Map<string, JournalMetricsDto | null> {
  try {
    const raw = localStorage.getItem(METRIC_CACHE_KEY);
    if (!raw) return new Map();
    const data = JSON.parse(raw) as Record<string, JournalMetricsDto | null>;
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

/** 这个 DOI 上次查过就返回结果，没查过返回 undefined。null 表示查过但未收录。 */
export function cachedJournalMetric(doi: string): JournalMetricsDto | null | undefined {
  const key = doi.trim().toLowerCase();
  if (!key) return undefined;
  const cache = metricCache();
  return cache.has(key) ? cache.get(key) : undefined;
}

/** 期刊表更新后清掉。旧数字是上一张表对出来的。 */
export function forgetJournalMetrics() {
  localStorage.removeItem(METRIC_CACHE_KEY);
}

export function rememberJournalMetrics(queries: { doi?: string }[], found: (JournalMetricsDto | null)[]) {
  const cache = metricCache();
  queries.forEach((query, index) => {
    const doi = query.doi?.trim().toLowerCase();
    if (doi) cache.set(doi, found[index] ?? null);
  });
  const kept = [...cache.entries()].slice(-800);
  localStorage.setItem(METRIC_CACHE_KEY, JSON.stringify(Object.fromEntries(kept)));
}

export function journalMetricTone(kind: "if" | "quartile" | "top", quartile?: number | null): string {
  if (kind === "top" || quartile === 1) {
    return "border border-cta-pill-text/30 bg-cta-pill-text/15 text-cta-pill-text";
  }
  if (quartile === 2) return "border border-ok-text/30 bg-ok-text/15 text-ok-text";
  if (quartile === 3) return "border border-warn-text/30 bg-warn-text/15 text-warn-text";
  return "border border-field bg-inset text-l2";
}

/** 单条命中的期刊指标（对照 lit_watch.rs 序列化） */
export interface JournalMetricsDto {
  /** JCR2025 IF 原样字符串，如 "29.1"；无数据为 null */
  impactFactor: string | null;
  /** 中科院升级版大类分区 1-4；无数据为 null */
  casQuartile: number | null;
  /** 中科院 Top 期刊 */
  top: boolean;
}

/** journal_metrics_status / download_journal_metrics 返回 */
export interface JournalMetricsStatusDto {
  available: boolean;
  journalCount: number;
  /** 本地表下载时间（RFC3339；两份 CSV 取较新 mtime），未装为 null */
  downloadedAt: string | null;
}

/** check_journal_metrics_update 返回 */
export interface JournalMetricsUpdateDto {
  /** 上游 ShowJCR 数据目录最近 commit 时间（RFC3339） */
  upstreamUpdatedAt: string | null;
  /** 上游比本地表新 */
  hasUpdate: boolean;
}

/** 指标表按钮悬浮说明（纯逻辑）：表名 + 刊数 + 下载时间；上游有新版时改口「点我更新」。
 *  rel 为相对时间函数（组件传 relTime，测试可注入假值） */
export function metricsTooltip(
  status: Pick<JournalMetricsStatusDto, "journalCount" | "downloadedAt">,
  update: Pick<JournalMetricsUpdateDto, "upstreamUpdatedAt" | "hasUpdate"> | null,
  rel: (iso: string | null) => string,
): string {
  const ago = rel(status.downloadedAt);
  const base = `JCR2025 + 中科院分区表 2025 · ${status.journalCount} 种期刊${
    ago ? ` · 下载于 ${ago}` : ""
  }`;
  if (update?.hasUpdate) {
    const up = rel(update.upstreamUpdatedAt);
    return `${base}；上游已有新版${up ? `（${up}）` : ""}，点我更新`;
  }
  return `${base}；出新版时点我重新下载即更新`;
}

// ===== 雷达筛选（与 lit_watch.rs metrics_pass_filter 同口径，改动需双端同步） =====

/** 筛选是否生效（全空 = 不筛选） */
export function litWatchFilterActive(
  f: LitWatchFilterDto | null | undefined,
): boolean {
  return !!f && (f.minIf != null || f.maxCasQuartile != null || !!f.topOnly);
}

/** 条目是否通过筛选。选了条件但查不到对应指标，就不显示。 */
export function entryPassesFilter(
  metrics: WatchEntryDto["metrics"],
  f: LitWatchFilterDto | null | undefined,
): boolean {
  if (!f || !litWatchFilterActive(f)) return true;
  if (!metrics) return false;
  if (f.minIf != null) {
    const v = Number(metrics.impactFactor);
    if (!metrics.impactFactor || !Number.isFinite(v) || metrics.impactFactor.trim() === "" || v < f.minIf) {
      return false;
    }
  }
  if (f.maxCasQuartile != null && (metrics.casQuartile == null || metrics.casQuartile > f.maxCasQuartile)) {
    return false;
  }
  if (f.topOnly && !metrics.top) return false;
  return true;
}

/** 筛选摘要（按钮悬浮/提示行用）：「IF≥10 · 2 区及以上 · 仅 TOP」 */
export function litWatchFilterLabel(
  f: LitWatchFilterDto | null | undefined,
): string {
  if (!f) return "";
  const parts: string[] = [];
  if (f.minIf != null) parts.push(`IF≥${f.minIf}`);
  if (f.maxCasQuartile != null) {
    parts.push(f.maxCasQuartile === 1 ? "仅 1 区" : `${f.maxCasQuartile} 区及以上`);
  }
  if (f.topOnly) parts.push("仅 TOP");
  return parts.join(" · ");
}

/** watch-followup.md 待办（付费墙/无摘要，待人工获取全文） */
export interface WatchFollowupDto {
  title: string;
  url: string;
  note: string;
}

/** list_watch_entries 返回 */
export interface WatchInboxDto {
  entries: WatchEntryDto[];
  followups: WatchFollowupDto[];
}

/** watchlist.md 订阅行（整表读写） */
export interface WatchSubscriptionDto {
  keyword: string;
  /** 来源多选（arxiv/openalex/crossref/web）；空 = 技能缺省口径 */
  sources: string[];
  note: string;
}

/** included.md（流程正典）/ reading-list.md（积累账）清单行，两账行格式同构 */
export interface IncludedEntryDto {
  /** 行内容哈希 id，`i-<hex>`；remove 时原样回传 */
  lineId: string;
  title: string;
  /** 「作者, 年份」整段 */
  authorsYear: string;
  source: string;
  link: string;
  rawLine: string;
}

/** add_included_entry 返回：added=false = 规范化标题已存在（去重） */
export interface AddIncludedResultDto {
  added: boolean;
}

/** download_paper_pdf 返回：落盘绝对路径 + 资源登记名 */
export interface DownloadedPaperDto {
  path: string;
  name: string;
}

// ===== 日分组 =====

/** 相关性排序权重：推荐 > 相关 > 待确认/未知 */
export function relevanceRank(relevance: string): number {
  if (relevance === "推荐") return 0;
  if (relevance === "相关") return 1;
  return 2;
}

export interface DayGroup {
  key: "today" | "yesterday" | "earlier";
  label: string;
  entries: WatchEntryDto[];
}

/** "YYYY-MM-DD" 按本地时区解析（new Date 串解析走 UTC，会偏一天） */
function parseLocalDay(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(0);
  d.setFullYear(year, month, day);
  d.setHours(0, 0, 0, 0);
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day
    ? d
    : null;
}

/** 本地日期串（分桶比较键） */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 按批次日期分「今天 / 昨天 / 更早」三桶（无 date 进「更早」），空桶不返回；
 *  组内按相关性排序（推荐>相关>待确认），同级保持原有先后（稳定序） */
export function groupEntriesByDay(
  entries: readonly WatchEntryDto[],
  now: Date = new Date(),
): DayGroup[] {
  const todayKey = localDayKey(now);
  const yesterdayKey = localDayKey(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
  );
  const buckets: Record<DayGroup["key"], WatchEntryDto[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const entry of entries) {
    const day = entry.date ? parseLocalDay(entry.date) : null;
    const key = day ? localDayKey(day) : null;
    if (key === todayKey) buckets.today.push(entry);
    else if (key === yesterdayKey) buckets.yesterday.push(entry);
    else buckets.earlier.push(entry);
  }
  const byRank = (a: WatchEntryDto, b: WatchEntryDto) =>
    relevanceRank(a.relevance) - relevanceRank(b.relevance);
  return (
    [
      { key: "today", label: "今天", entries: buckets.today },
      { key: "yesterday", label: "昨天", entries: buckets.yesterday },
      { key: "earlier", label: "更早", entries: buckets.earlier },
    ] as DayGroup[]
  )
    .map((g) => ({ ...g, entries: [...g.entries].sort(byRank) }))
    .filter((g) => g.entries.length > 0);
}

// ===== 关键词分组 =====

/** 无命中关键词条目的固定归属组名 */
export const UNCATEGORIZED_KEYWORD = "未分类";

export interface KeywordGroup {
  keyword: string;
  entries: WatchEntryDto[];
}

/** 按关键词分组：每条只归入 keywordsHit 的第一个关键词（多命中不重复出现），
 *  无关键词归「未分类」；组按条目数降序、同数按关键词字母序，「未分类」恒排最后；
 *  组内与日分组同口径（相关性排序 + 同级稳定序）；空组不出现 */
export function groupEntriesByKeyword(
  entries: readonly WatchEntryDto[],
): KeywordGroup[] {
  const buckets = new Map<string, WatchEntryDto[]>();
  for (const entry of entries) {
    const kw = entry.keywordsHit[0]?.trim() || UNCATEGORIZED_KEYWORD;
    const bucket = buckets.get(kw);
    if (bucket) bucket.push(entry);
    else buckets.set(kw, [entry]);
  }
  const byRank = (a: WatchEntryDto, b: WatchEntryDto) =>
    relevanceRank(a.relevance) - relevanceRank(b.relevance);
  return [...buckets.entries()]
    .map(([keyword, list]) => ({
      keyword,
      entries: [...list].sort(byRank),
    }))
    .sort((a, b) => {
      if (a.keyword === UNCATEGORIZED_KEYWORD) return 1;
      if (b.keyword === UNCATEGORIZED_KEYWORD) return -1;
      return (
        b.entries.length - a.entries.length ||
        a.keyword.localeCompare(b.keyword)
      );
    });
}

// ===== 来源展示名 =====

/** 来源 pill 展示名：剥掉末尾出版商括号尾巴（「(Wiley)」「（ACS）」，可多级）省横向空间；
 *  剥完为空视为无尾巴（原文返回）。括号必须成对（半角配半角、全角配全角）——
 *  与匹配侧 journal_metrics.rs strip_trailing_paren 同口径，两处同步 */
export function sourceDisplayName(source: string): string {
  let s = source.trim();
  for (;;) {
    const m =
      /^(.*?)\s*\(([^()]*)\)\s*$/.exec(s) ?? /^(.*?)\s*（([^（）]*)）\s*$/.exec(s);
    if (!m || !m[1].trim()) return s;
    s = m[1].trim();
  }
}

/** 新命中收起态第二行：中文一句话 · 期刊/来源。英文摘要不进这一行。 */
export function watchEntryScanLine(
  entry: Pick<WatchEntryDto, "zhSummary">,
): string {
  return entry.zhSummary.trim();
}

// ===== 周趋势（迷你柱状图） =====

export interface WeekBucket {
  /** 本周周一（本地零点） */
  start: Date;
  /** 「8月3日周」 */
  label: string;
  count: number;
  /** 桶起点 YYYY-MM-DD（点击柱子筛选时间桶的稳定键） */
  key: string;
  /** 其中「推荐」条数（双色堆叠柱的上层） */
  recommendedCount: number;
}

/** 本地周一零点（周一 = 一周起点，中文语境惯例） */
function weekStart(d: Date): Date {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // getDay：周日=0…周六=6；回退到周一
  const back = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - back);
}

/** 近 weeks 周每周命中计数（旧→新，含 0 计数的周；无 date 的条目不知道归哪周，不计） */
export function weeklyBuckets(
  entries: readonly WatchEntryDto[],
  weeks = 8,
  now: Date = new Date(),
): WeekBucket[] {
  const thisWeek = weekStart(now);
  const starts: Date[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    starts.push(
      new Date(
        thisWeek.getFullYear(),
        thisWeek.getMonth(),
        thisWeek.getDate() - i * 7,
      ),
    );
  }
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.date) continue;
    const day = parseLocalDay(entry.date);
    if (!day) continue;
    const key = localDayKey(weekStart(day));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return starts.map((start) => ({
    start,
    label: `${start.getMonth() + 1}月${start.getDate()}日周`,
    count: counts.get(localDayKey(start)) ?? 0,
    key: localDayKey(start),
    recommendedCount: 0,
  }));
}

/** 上海日历日 YYYY-MM-DD。巡检批次只认这个，不用论文发表日期。 */
export function shanghaiDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(t));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const day = `${pick("year")}-${pick("month")}-${pick("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** 成功巡检里，收件箱漏写批次标记的那几次。按完成日去重，旧的在前。 */
export function undatedWatchRuns(
  schedules: readonly { skill: string; history: readonly { status: string; newEntries?: number | null; finishedAt?: string | null; at: string; adopted?: boolean }[] }[],
): { day: string }[] {
  const days = new Set<string>();
  for (const schedule of schedules) {
    if (schedule.skill !== LIT_WATCH_SLOT) continue;
    for (const run of schedule.history) {
      if (run.status !== "ok" || run.adopted === false) continue;
      if ((run.newEntries ?? 0) <= 0) continue;
      const day = shanghaiDay(run.finishedAt ?? run.at);
      if (day) days.add(day);
    }
  }
  return [...days].sort().map((day) => ({ day }));
}

/** 缺日期与确实为零分开呈现；趋势仍统计全部命中，不受忽略/筛选影响。 */
export function weeklyTrend(
  entries: readonly WatchEntryDto[],
  weeks = 8,
  now: Date = new Date(),
): {
  buckets: WeekBucket[];
  undatedCount: number;
  showChart: boolean;
  note: string | null;
} {
  return { ...trendSummary(entries, "week", now), buckets: weeklyBuckets(entries, weeks, now) };
}

// ===== 趋势图多粒度（天/周/月，2026-10-14） =====

export type TrendMode = "day" | "week" | "month";

export const TREND_WINDOW: Record<TrendMode, number> = {
  day: 14,
  week: 8,
  month: 6,
};

/** 月起点：当月 1 日零点 */
function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** 各粒度的桶起点序列（旧→新，最后一桶含 now） */
export function trendStarts(mode: TrendMode, now: Date): Date[] {
  const n = TREND_WINDOW[mode];
  const starts: Date[] = [];
  if (mode === "day") {
    for (let i = n - 1; i >= 0; i--) {
      starts.push(
        new Date(now.getFullYear(), now.getMonth(), now.getDate() - i),
      );
    }
  } else if (mode === "week") {
    const w = weekStart(now);
    for (let i = n - 1; i >= 0; i--) {
      starts.push(
        new Date(w.getFullYear(), w.getMonth(), w.getDate() - i * 7),
      );
    }
  } else {
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      starts.push(d);
    }
  }
  return starts;
}

function bucketKey(mode: TrendMode, day: Date): string {
  const s =
    mode === "day"
      ? day
      : mode === "week"
        ? weekStart(day)
        : monthStart(day);
  return localDayKey(s);
}

function bucketLabel(mode: TrendMode, start: Date): string {
  if (mode === "day") return `${start.getMonth() + 1}/${start.getDate()}`;
  if (mode === "month") return `${start.getMonth() + 1}月`;
  return `${start.getMonth() + 1}月${start.getDate()}日周`;
}

/** 多粒度计数桶（旧→新）；含推荐计数与筛选键 */
export function trendBuckets(
  entries: readonly WatchEntryDto[],
  mode: TrendMode,
  now: Date = new Date(),
): WeekBucket[] {
  const starts = trendStarts(mode, now);
  const counts = new Map<string, number>();
  const recs = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.date) continue;
    const day = parseLocalDay(entry.date);
    if (!day) continue;
    const key = bucketKey(mode, day);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (entry.relevance === "推荐") {
      recs.set(key, (recs.get(key) ?? 0) + 1);
    }
  }
  return starts.map((start) => {
    const key = localDayKey(start);
    return {
      start,
      label: bucketLabel(mode, start),
      count: counts.get(key) ?? 0,
      key,
      recommendedCount: recs.get(key) ?? 0,
    };
  });
}

/** 点击柱子后过滤列表用：条目是否落在指定时间桶里（与 trendBuckets 同口径） */
export function entryInTrendBucket(
  entry: Pick<WatchEntryDto, "date">,
  mode: TrendMode,
  bucketKeyToTest: string,
): boolean {
  if (!entry.date) return false;
  const day = parseLocalDay(entry.date);
  if (!day) return false;
  return bucketKey(mode, day) === bucketKeyToTest;
}

/** trendSummary：粒度通用的 {buckets, undated, showChart, note} */
export function trendSummary(
  entries: readonly WatchEntryDto[],
  mode: TrendMode,
  now: Date = new Date(),
): {
  buckets: WeekBucket[];
  undatedCount: number;
  showChart: boolean;
  note: string | null;
} {
  const undatedCount = entries.filter(
    (e) => !e.date || !parseLocalDay(e.date),
  ).length;
  const showChart = entries.length > undatedCount;
  const note =
    entries.length === 0
      ? "暂无文献命中，巡检后显示趋势"
      : !showChart
        ? `${undatedCount} 条文献缺少有效巡检日期，暂无法统计趋势`
        : undatedCount > 0
          ? `另有 ${undatedCount} 条缺少有效巡检日期，未计入趋势`
          : null;
  return {
    buckets: trendBuckets(entries, mode, now),
    undatedCount,
    showChart,
    note,
  };
}

// ===== PDF 直链 =====

/** 全文 PDF 直链：arXiv abs 页 → pdf 直链；其余 http(s) 原样；非 http(s)（空串/DOI 等）返回 null */
export function pdfUrlFor(url: string): string | null {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return null;
  const abs = /^https?:\/\/(?:www\.)?arxiv\.org\/abs\/([^?#]+)/i.exec(u);
  if (abs) return `https://arxiv.org/pdf/${abs[1]}`;
  return u;
}

// ===== 全文可得性 =====

/** 全文链接分类：pdf = 开放获取直链（可下载）；source = 出版商落地页/DOI（只能打开来源）；none = 无链接 */
export type FulltextLink =
  | { kind: "pdf"; url: string }
  | { kind: "source"; url: string }
  | { kind: "none" };

/** 判定命中的全文可得性，供「↓ 全文 / ↗ 来源」按钮分流：
 *  只有 arXiv abs 页与 .pdf 结尾的 URL 视为可直接下载；DOI、doi.org 及其他 http(s) 落地页
 *  一律当来源页（直链下载也过不了后端 %PDF- 魔数校验），前端直接给「来源」入口，不摆装死的下载钮 */
export function fulltextLinkFor(rawUrl: string): FulltextLink {
  const u = rawUrl.trim();
  if (/^(?:doi:\s*)?10\.\d{4,9}\/\S+$/i.test(u)) {
    return { kind: "source", url: u };
  }
  if (!/^https?:\/\//i.test(u)) return { kind: "none" };
  if (/^https?:\/\/(?:www\.)?arxiv\.org\/abs\//i.test(u)) {
    return { kind: "pdf", url: pdfUrlFor(u)! };
  }
  if (/\.pdf([?#].*)?$/i.test(u)) return { kind: "pdf", url: u };
  return { kind: "source", url: u };
}

// ===== 清单行拼装（included.md 正典与 reading-list.md 积累账同构）=====

/**
 * 命中条目 → add_reading_list_entry（积累账）的参数。
 * authorsYear 口径：作者缺 → 整段「待补」；作者在 → 附年份（取批次日期的年——
 * 雷达条目多为新文献，批次年≈发表年），批次日期也没有就只留作者。
 */
export function includedLineFor(entry: WatchEntryDto): {
  title: string;
  authorsYear: string;
  source: string;
  link: string;
} {
  const authors = entry.authors.trim();
  // 年份优先取发表日期（论文自身）；旧条目缺发表日期回落巡检批次日
  const yearSrc = entry.pubDate?.trim() || entry.date;
  const year = yearSrc ? parseLocalDay(yearSrc)?.getFullYear() : undefined;
  const authorsYear = authors
    ? year
      ? `${authors}, ${year}`
      : authors
    : "待补";
  return {
    title: entry.title,
    authorsYear,
    source: entry.source,
    link: entry.url,
  };
}

// ===== 双台账书标（included.md 正典 + reading-list.md 积累账） =====

/** 清单行 → 规范化标题集合（书标判定 / 抽屉计数的统一口径；空白标题不入集合） */
export function normalizedTitleSet(
  rows: readonly { title: string }[] | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows ?? []) {
    const t = normalizeTitle(r.title);
    if (t) out.add(t);
  }
  return out;
}

export type LedgerMark = "included" | "reading";

/** 行内书标双态：已在正典（included.md）→ "included"；仅在积累账（reading-list.md）→
 *  "reading"；都不在 → null。正典优先。与后端 add_reading_list_at 的去重域同口径：
 *  规范化标题全等（不做包含匹配） */
export function ledgerMarkFor(
  title: string,
  includedTitles: ReadonlySet<string>,
  readingTitles: ReadonlySet<string>,
): LedgerMark | null {
  const t = normalizeTitle(title);
  if (!t) return null;
  if (includedTitles.has(t)) return "included";
  if (readingTitles.has(t)) return "reading";
  return null;
}

// ===== 已读判定（精读条目 × notes/ 笔记文件名） =====

/** 标题规范化：小写、标点/符号折叠为单空格（互相包含比较的统一口径） */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** 精读条目是否已读：规范化标题与任一笔记文件名（去扩展名）互相包含即已读；
 *  无 notes 目录/无笔记（空调用方传空表）→ 全部未读。诚实回落，不做模糊猜测 */
export function isRead(
  entry: { title: string },
  noteFileNames: readonly string[],
): boolean {
  const t = normalizeTitle(entry.title);
  if (!t) return false;
  return noteFileNames.some((name) => {
    const stem = name.replace(/\.[^.]*$/, "");
    const n = normalizeTitle(stem);
    if (n === "" || n === t) return n !== "";
    if (!(n.includes(t) || t.includes(n))) return false;
    // 仅允许较长、多词标题做包含匹配，避免「review」「battery」等短片段
    // 把另一篇论文误判成已读。
    const shorter = n.length < t.length ? n : t;
    return shorter.length >= 20 && shorter.split(" ").filter(Boolean).length >= 4;
  });
}

export interface PaperNoteLink {
  notePath: string;
  noteName: string;
  pdfRel: string | null;
}

function fileStem(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return name.replace(/\.[^.]*$/, "");
}

/** 文献 PDF → 已有笔记：来源行优先，其次文件名规范化互相包含 */
export function noteLinkForPaper(
  pdfPath: string,
  links: readonly PaperNoteLink[],
): PaperNoteLink | null {
  const pdfNorm = pdfPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const pdfFile = pdfNorm.split("/").pop() ?? pdfPath;
  for (const link of links) {
    const rel = link.pdfRel?.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!rel) continue;
    if (
      rel === pdfNorm ||
      rel === pdfFile ||
      pdfNorm.endsWith(`/${rel}`) ||
      rel.endsWith(`/${pdfFile}`)
    ) {
      return link;
    }
  }
  const pdfStem = normalizeTitle(fileStem(pdfPath));
  if (!pdfStem) return null;
  let best: PaperNoteLink | null = null;
  let bestLen = 0;
  for (const link of links) {
    const n = normalizeTitle(fileStem(link.noteName));
    if (!n) continue;
    if (n === pdfStem) return link;
    if (!(n.includes(pdfStem) || pdfStem.includes(n))) continue;
    const shorter = n.length < pdfStem.length ? n : pdfStem;
    if (shorter.length < 12) continue;
    const len = Math.min(n.length, pdfStem.length);
    if (len > bestLen) {
      best = link;
      bestLen = len;
    }
  }
  return best;
}

/** 文献 PDF 是否已在精读清单：文件名 stem 与条目标题规范化互相包含 */
export function paperIsIncluded(
  pdfPath: string,
  included: readonly { title: string }[],
): boolean {
  const n = normalizeTitle(fileStem(pdfPath));
  if (!n) return false;
  return included.some((e) => {
    const t = normalizeTitle(e.title);
    if (!t) return false;
    if (n === t) return true;
    if (!(n.includes(t) || t.includes(n))) return false;
    const shorter = n.length < t.length ? n : t;
    return shorter.length >= 12;
  });
}

/** 精读条目对应的已下载 PDF：登记资源里 type=paper 且文件名与标题规范化互相包含 */
export function paperResourceFor(
  entry: { title: string },
  resources: readonly { path: string; type: string }[],
): string | null {
  const t = normalizeTitle(entry.title);
  if (!t) return null;
  for (const r of resources) {
    if (r.type !== "paper") continue;
    // 后端 discover 出的路径已由 norm_path_key 统一成正斜杠，但配置文件里手写的
    // resources.path 可能是 Windows 反斜杠，取文件名前先归一化，否则整条路径会被当成文件名参与匹配
    const fileName = r.path.replace(/\\/g, "/").split("/").pop() ?? r.path;
    const n = normalizeTitle(fileName.replace(/\.[^.]*$/, ""));
    if (n !== "" && (n.includes(t) || t.includes(n))) return r.path;
  }
  return null;
}

// ===== 收件箱「文献」候选 =====

export interface LitInboxCandidate {
  scheduleId: string;
  projectRoot: string;
  /** 最近一次成功 run 的新命中数 */
  count: number;
  /** 最近运行时间（ISO） */
  at: string;
  runId?: string | null;
  isolationPath?: string | null;
  adopted?: boolean;
}

/** 收件箱候选：最近一次成功 run 有新命中，且最近运行时间在 24h 内（逾期不再打扰） */
export function litInboxCandidates(
  schedules: readonly ScheduleDto[],
  nowMs: number = Date.now(),
  windowMs: number = 24 * 3600 * 1000,
): LitInboxCandidate[] {
  const out: LitInboxCandidate[] = [];
  for (const s of schedules) {
    if (s.skill !== LIT_WATCH_SLOT) continue;
    if (s.lastStatus !== "ok") continue;
    const lastOk = s.history.find((r) => r.status === "ok");
    if (!lastOk) continue;
    const at = Date.parse(lastOk.at);
    if (Number.isNaN(at) || nowMs - at >= windowMs || nowMs - at < 0) continue;
    const count = lastOk?.newEntries ?? 0;
    if (count <= 0) continue;
    out.push({
      scheduleId: s.id,
      projectRoot: s.projectRoot,
      count,
      at: lastOk.at,
      runId: lastOk.runId ?? null,
      isolationPath: lastOk.isolationPath ?? null,
      adopted: Boolean(lastOk.adopted),
    });
  }
  return out;
}

// ===== 雷达快筛解读（标题+摘要，不是精读笔记） =====

/** 解读输出的固定小标题；改 prompt 时同步 parseWatchExplain */
export const WATCH_EXPLAIN_HEADINGS = [
  "问题与动机",
  "做法与对象",
  "摘要声称的结果",
  "局限与未写明",
  "对本课题的用处",
  "适用研究方向",
] as const;

/** 快筛解读 prompt：学术书面语、五节、禁止编造。有课题时末节对准课题。 */
export function watchExplainPrompt(
  entry: Pick<
    WatchEntryDto,
    "title" | "authors" | "source" | "journal" | "abstractFirst"
  >,
  topic: string | null | undefined,
): string {
  const topicText = topic?.trim() ?? "";
  const lastHeading = topicText ? "对本课题的用处" : "适用研究方向";
  const journal = entry.journal?.trim() ?? "";
  const abs = entry.abstractFirst.trim() || "（无摘要）";
  const authors = entry.authors.trim() || "（未提供）";
  const source = entry.source.trim() || "（未提供）";
  return `你是科研文献快筛助手。根据下面给出的题录写解读，供课题组扫读，不是精读笔记，不要装成读过全文。

要求：
- 中文学术书面语；不用「新路径」「高度有前景」「填补空白」这类空话
- 只依据给定材料，不编造数据、机理细节、页码或参考文献
- 摘要没写的写「摘要未写明」，不要脑补
- 严格按下面五个小标题输出，标题单独成行，每节 2–4 句，不要开场白、不要编号、不要 Markdown

问题与动机
做法与对象
摘要声称的结果
局限与未写明
${lastHeading}

标题：${entry.title}
作者：${authors}
来源：${source}${journal ? `\n期刊：${journal}` : ""}
摘要：${abs}${topicText ? `\n本课题：${topicText}` : ""}`;
}

/** 把模型输出拆成小标题 + 正文。对不上五个小标题则返回 null，调用方整段展示。 */
export function parseWatchExplain(
  text: string,
): { heading: string; body: string }[] | null {
  const headingSet = new Set<string>(WATCH_EXPLAIN_HEADINGS);
  const sections: { heading: string; body: string }[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const t = line.trim();
    if (headingSet.has(t)) {
      if (current) {
        const body = current.lines.join("\n").trim();
        if (body) sections.push({ heading: current.heading, body });
      }
      current = { heading: t, lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) {
    const body = current.lines.join("\n").trim();
    if (body) sections.push({ heading: current.heading, body });
  }
  return sections.length >= 3 ? sections : null;
}

/** 收件箱只对还在注册表里的项目出文献条目。已删/已移除的项目 schedules 可能还在，不能拿文件夹名继续提示。 */
export function litInboxForRegisteredProjects(
  candidates: readonly LitInboxCandidate[],
  projectPaths: readonly string[],
  isWindows = false,
): LitInboxCandidate[] {
  return candidates.filter((c) =>
    projectPaths.some((p) => samePath(c.projectRoot, p, isWindows)),
  );
}

/** 收件箱按篇展开：取 inbox 末尾 count 条（新命中追加在后），每项目最多 maxPer 篇。 */
export function papersForLitCandidate(
  candidate: LitInboxCandidate,
  entries: readonly WatchEntryDto[],
  maxPer = 5,
): WatchEntryDto[] {
  const n = Math.min(Math.max(candidate.count, 0), maxPer, entries.length);
  if (n <= 0) return [];
  return entries.slice(-n).reverse();
}

// ===== 条目忽略（dismiss） =====

/** 过滤掉已忽略的命中条目（id 是内容哈希，忽略即永久；内容变了 id 变，自然复现） */
export function filterLitDismissed<T extends { id: string }>(
  entries: readonly T[],
  dismissed: ReadonlySet<string>,
): T[] {
  return entries.filter((e) => !dismissed.has(e.id));
}

/** 两篇是不是同一篇。规范化后互相包含，短边至少 12；
 *  两边都到 24 个字符时，开头 24 个相同也算（巡检常把标题写断）。 */
export function titlesLookSame(a: string, b: string): boolean {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) {
    const shorter = left.length < right.length ? left : right;
    return shorter.length >= 12;
  }
  const head = 24;
  return left.length >= head && right.length >= head && left.slice(0, head) === right.slice(0, head);
}

/** 待获取：这次命中里 papers/ 还没有 PDF 的，加上跟进队列里对不上任何命中的。
 *  已有 PDF 的不出现。忽略的命中和跟它对上的跟进行都不出现。
 *  不看巡检有没有把跟进队列写全。 */
export function pendingDownloads(
  hits: readonly { id: string; title: string; url: string }[],
  followups: readonly { title: string; url: string; note: string }[],
  savedIds: ReadonlySet<string>,
  dismissed: ReadonlySet<string>,
): { key: string; title: string; url: string; note: string; entryId: string | null }[] {
  const open = hits.filter((hit) => !dismissed.has(hit.id));
  // 显式行类型：跟进待办没有命中条目 id（null），不能让首段 map 把 rows 推窄成 string
  const rows: { key: string; title: string; url: string; note: string; entryId: string | null }[] = open
    .filter((hit) => !savedIds.has(hit.id))
    .map((hit) => {
      const note = followups.find((item) => titlesLookSame(item.title, hit.title));
      return {
        key: hit.id,
        title: hit.title,
        url: hit.url || note?.url || "",
        note: note?.note ?? "",
        entryId: hit.id,
      };
    });
  for (const item of followups) {
    const same = hits.find((hit) => titlesLookSame(item.title, hit.title));
    if (same) continue;
    if (followupMatchesDismissed(item.title, hits, dismissed)) continue;
    rows.push({
      key: `f:${normalizeTitle(item.title)}`,
      title: item.title,
      url: item.url,
      note: item.note,
      entryId: null,
    });
  }
  return rows;
}

/** 待人工下载与上面的命中是同一篇时，忽略后下面也消失。 */
export function followupMatchesDismissed(
  followupTitle: string,
  hits: readonly { id: string; title: string }[],
  dismissed: ReadonlySet<string>,
): boolean {
  return hits.some(
    (hit) => dismissed.has(hit.id) && titlesLookSame(followupTitle, hit.title),
  );
}

// ---- localStorage 薄层（以下依赖 DOM，不进 node 测试） ----

/** 雷达卡片展开：按项目记住，切换项目不默认打开。 */
export function litWatchBodyOpenKey(projectRoot: string): string {
  return `ccode.litWatch.bodyOpen.${projectRoot.replace(/[\\/]+$/, "")}`;
}

export function parseLitWatchBodyOpen(raw: string | null | undefined): boolean {
  return raw === "1";
}

export function readLitWatchBodyOpen(projectRoot: string): boolean {
  try {
    return parseLitWatchBodyOpen(
      localStorage.getItem(litWatchBodyOpenKey(projectRoot)),
    );
  } catch {
    return false;
  }
}

export function writeLitWatchBodyOpen(projectRoot: string, open: boolean): void {
  try {
    localStorage.setItem(litWatchBodyOpenKey(projectRoot), open ? "1" : "0");
  } catch {
    /* 隐私模式写不进就只靠本次 */
  }
}

/** 命中条目忽略表的 localStorage 键：字符串数组（内容哈希 id） */
export const LIT_DISMISSED_KEY = "ccode.litDismissed";

export function loadLitDismissed(): Set<string> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(LIT_DISMISSED_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

/** 记录忽略并返回新表；写入失败静默（隐私模式） */
export function dismissLitEntry(
  cur: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(cur).add(id);
  try {
    localStorage.setItem(LIT_DISMISSED_KEY, JSON.stringify([...next]));
  } catch {
    /* 写不进就只靠本次内存态 */
  }
  return next;
}
