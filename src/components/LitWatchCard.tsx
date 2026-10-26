import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  Bookmark,
  BookmarkPlus,
  Copy,
  Download,
  ExternalLink,
  EyeOff,
  FileText,
  ListFilter,
  Paperclip,
  Rss,
  Table2,
} from "lucide-react";
import { LIT_WATCH_SLOT, resolveSkillSlot, useSkillProvides } from "../skill-slots.ts";
import ContextMenu from "./ContextMenu";
import { Modal } from "./Modal";

// monaco 体积大，与终端页同款懒加载，避免拖慢工作区页首屏
const FilePreviewEditor = lazy(() => import("./FilePreviewEditor"));
import { HoverTip } from "./HoverTip";
import {
  fieldClass,
  FoldMark,
  ghostActionClass,
  iconActionClass,
  LoadingRows,
  primaryActionClass,
  projectWellClass,
  secondaryActionClass,
  SegTabs,
  InlineNotice,
  NoticeBar,
} from "./PageFrame";
import { LIST_PREVIEW_CAP } from "../lit-list";
import { instOpenTarget } from "../inst-access";
import { samePath } from "../path-utils";
import { ListPreviewToggle } from "./FolderGroupedList";
import { useAppStore } from "../store";
import { relTime } from "../rel-time";
import { schedulesForProject } from "../schedule-tasks";
import { IS_WINDOWS } from "../hotkeys";
import {
  dismissLitEntry,
  filterLitDismissed,
  groupEntriesByDay,
  includedLineFor,
  loadLitDismissed,
  readLitWatchBodyOpen,
  watchKeywordLabel,
  writeLitWatchBodyOpen,
  entryPassesFilter,
  ledgerMarkFor,
  normalizeTitle,
  normalizedTitleSet,
  litWatchFilterActive,
  litWatchFilterLabel,
  journalMetricTone,
  metricsTooltip,
  entryInTrendBucket,
  compactPubDate,
  trendSummary,
  trendSparseLine,
  trendTickLabel,
  type TrendMode,
  undatedWatchRuns,
  parseWatchExplain,
  watchExplainPrompt,
  watchEntryScanLine,
  sourceDisplayName,
  noteLinkForPaper,
} from "../lit-watch";
import type {
  AddIncludedResultDto,
  DownloadedPaperDto,
  IncludedEntryDto,
  LedgerMark,
  PaperNoteLink,
  JournalMetricsStatusDto,
  JournalMetricsUpdateDto,
  WatchEntryDto,
  WatchFollowupDto,
  WatchInboxDto,
  WatchSubscriptionDto,
} from "../lit-watch";
import type {
  ProjectConfigDto,
  LitWatchFilterDto,
  ScheduleDto,
} from "../types";
import { usePolling } from "../polling";

function HeadIcon({
  label,
  disabled,
  mark,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  mark?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="relative flex h-7 w-7 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-50"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      {mark && (
        <span className="absolute right-1 top-1 size-1.5 rounded-full bg-cta" />
      )}
    </button>
  );
}


/** 选中桶的可读标签（胶囊用）；找不到回落 key 本身 */
function selectedBucketLabel(
  trend: ReturnType<typeof trendSummary>,
  key: string,
): string {
  return trend.buckets.find((b) => b.key === key)?.label ?? key;
}

/** 命中迷你趋势（手绘细柱，不引图表库）：天/周/月三粒度切换，
 *  首尾起点标签定时间轴，巡检统计挂右端同排；悬停出 HoverTip（禁原生 title） */
function TrendChart({
  trend,
  mode,
  onMode,
  selectedKey,
  onSelectKey,
  repairDays,
  repairing,
  onRepair,
  stats,
}: {
  trend: ReturnType<typeof trendSummary>;
  mode: TrendMode;
  onMode: (m: TrendMode) => void;
  /** 点柱筛选：当前选中的时间桶 key；null 未选 */
  selectedKey: string | null;
  onSelectKey: (key: string | null) => void;
  /** 成功巡检漏写批次标记、可以按完成日补上的日期 */
  repairDays: string[];
  repairing: boolean;
  onRepair: () => void;
  /** 右端统计行（最近巡检/推荐/未忽略）；null 不占位 */
  stats: ReactNode;
}) {
  const { buckets, showChart, note } = trend;
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(
    null,
  );
  // 稀疏（有数桶 ≤3，即 4 周以下有数）时默认压成一行文字，点开才出图；选中了柱子就保持展开，免得筛选状态看不见
  const sparseLine = showChart ? trendSparseLine(buckets, mode) : null;
  const [chartOpen, setChartOpen] = useState(false);
  const compact = sparseLine !== null && !chartOpen && selectedKey === null;
  // 滚动/缩放即关（与 useHoverTip 同口径）
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [tip]);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const titleText =
    mode === "day" ? "近 14 天" : mode === "month" ? "近 6 月" : "近 8 周";
  const unit = mode === "day" ? "每天" : mode === "month" ? "每月" : "每周";
  // 日模式 14 列刻度太密：只在第 1/4/7/10/14 桶和选中桶出标签，挂列内不会错位
  const tickIdx = new Set([0, 3, 6, 9, buckets.length - 1]);
  // note（缺日期说明 + 按巡检日补记入口）两条路径都要渲染——compact 分支早期 return
  // 曾把它整个吞掉，稀疏模式下补记按钮跟着消失（2026-10-16 修）
  const noteNode = note && (
    <p className="mt-1 text-micro text-l4">
      {note}
      {repairDays.length > 0 && (
        <>
          {" "}
          <button
            type="button"
            className="underline hover:text-l1 disabled:opacity-50"
            disabled={repairing}
            title={`按巡检完成日 ${repairDays.join("、")} 补上批次标记。不改已有日期，也不用论文发表日期。`}
            onClick={onRepair}
          >
            {repairing ? "补记中…" : "按巡检日补记"}
          </button>
        </>
      )}
    </p>
  );
  if (compact) {
    return (
      <div className="mt-1 px-2">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            className="min-w-0 truncate text-left text-micro text-l3 hover:text-l1"
            aria-expanded={false}
            title="展开趋势图"
            onClick={() => setChartOpen(true)}
          >
            {sparseLine}
            <span className="ml-1 text-l4">· 展开图</span>
          </button>
          {stats && (
            <p className="shrink-0 text-right text-micro leading-4 text-l4">{stats}</p>
          )}
        </div>
        {noteNode}
      </div>
    );
  }
  return (
    <div className="mt-1 px-2">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-micro text-l3">{titleText}新命中</p>
          <SegTabs
            items={[
              { id: "day" as const, label: "日" },
              { id: "week" as const, label: "周" },
              { id: "month" as const, label: "月" },
            ]}
            value={mode}
            onChange={(m) => onMode(m)}
          />
          {/* 时间桶选中态标在图头上（2026-10-16 定位拍板）：柱子是时间筛，选中态跟着图走，
              不挤进下面的关键词胶囊行；选中恒展开，标题行必在 */}
          {selectedKey != null && (
            <button
              type="button"
              className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-seg-sel px-2 text-micro text-l1"
              title="只看这个时间桶里的命中；点一下取消"
              onClick={() => onSelectKey(null)}
            >
              {selectedBucketLabel(trend, selectedKey)} ×
            </button>
          )}
          {sparseLine !== null && selectedKey === null && (
            <button
              type="button"
              className="text-micro text-l4 hover:text-l1"
              aria-expanded
              onClick={() => setChartOpen(false)}
            >
              收起
            </button>
          )}
        </div>
        {stats && (
          <p className="shrink-0 text-right text-micro leading-4 text-l4">
            {stats}
          </p>
        )}
      </div>
      {showChart && (
        // 通栏等分列：整列是悬停/点击热区（细柱难瞄准），刻度挂在列内根治错位
        <div
          className="grid w-full"
          style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))` }}
          role="img"
          aria-label={`${titleText}新命中数`}
        >
          {buckets.map((b, i) => {
            const totalPx =
              b.count === 0 ? 0 : Math.max(8, Math.round((b.count / max) * 36));
            const recPx =
              b.recommendedCount > 0
                ? Math.max(3, Math.round((totalPx * b.recommendedCount) / b.count))
                : 0;
            const normalPx = Math.max(b.count - b.recommendedCount > 0 ? 3 : 0, totalPx - recPx);
            const selected = selectedKey === b.key;
            const tick =
              mode !== "day" ||
              tickIdx.has(i) ||
              selected ||
              b.count > 0;
            return (
              <button
                key={b.key}
                type="button"
                data-trend-col={b.key}
                disabled={b.count === 0}
                aria-label={`${b.label}${unit === "每天" ? "" : `（${unit}）`} ${b.count} 篇${b.recommendedCount ? `，推荐 ${b.recommendedCount}` : ""}${b.count === 0 ? "（无命中）" : selected ? "，已选中" : ""}`}
                className={`flex min-w-0 cursor-pointer flex-col items-center rounded-sm px-0.5 text-micro leading-3 transition-colors ${
                  b.count === 0
                    ? "cursor-default"
                    : selected
                      ? "bg-cta/12"
                      : "hover:bg-hover"
                }`}
                onClick={() => b.count > 0 && onSelectKey(selected ? null : b.key)}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTip({
                    x: Math.min(
                      Math.max(r.left + r.width / 2, 150),
                      window.innerWidth - 150,
                    ),
                    y: r.top - 8,
                    text: `${b.count} 篇${b.recommendedCount ? `（推荐 ${b.recommendedCount}）` : ""} · ${b.label}`,
                  });
                }}
                onMouseLeave={() => setTip(null)}
              >
                <span className="flex h-11 w-full items-end justify-center">
                  {b.count === 0 ? (
                    // 0 值胶囊底座：一排整齐的待机位，替代原先的细虚线
                    <span className={`w-3/5 max-w-4 ${mode === "day" ? "h-[3px]" : "h-[3px]"} bg-field`} />
                  ) : (
                    <span
                      className={`flex w-3/5 max-w-4 flex-col justify-end overflow-hidden rounded-t-sm`}
                      style={{ height: totalPx }}
                    >
                      {normalPx > 0 && (
                        <span className="w-full bg-cta/30" style={{ height: normalPx }} />
                      )}
                      {recPx > 0 && (
                        <span className="w-full bg-cta" style={{ height: recPx }} />
                      )}
                    </span>
                  )}
                </span>
                <span
                  className={`mt-1 truncate ${selected ? "font-medium text-l1" : "text-l4"}`}
                >
                  {tick ? trendTickLabel(mode, b.start) : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {noteNode}
      <HoverTip tip={tip} text={tip?.text ?? ""} up />
    </div>
  );
}

type ExplainState =
  | { status: "loading" }
  | { status: "ok"; text: string }
  | { status: "error"; error: string };

function WatchExplainBody({
  text,
  onRerun,
}: {
  text: string;
  onRerun: () => void;
}) {
  const sections = parseWatchExplain(text);
  return (
    <div className="space-y-2">
      {sections ? (
        sections.map((s) => (
          <div key={s.heading}>
            <p className="text-micro font-medium text-l3">{s.heading}</p>
            <p className="whitespace-pre-line">{s.body}</p>
          </div>
        ))
      ) : (
        <p className="whitespace-pre-line">{text}</p>
      )}
      <button
        type="button"
        className="text-micro text-l4 hover:text-l2"
        onClick={onRerun}
      >
        重跑
      </button>
    </div>
  );
}

/** 第一行右端的徽章组（2026-10-14 方案 A）：
 *  相关性只有 推荐/待确认 才挂胶囊（「相关」占多数，挂了反而挑不出推荐）；
 *  期刊指标合成一颗复合胶囊（1区 TOP · IF 16.6），色调随分区。 */
function EntryBadges({ entry }: { entry: WatchEntryDto }) {
  const m = entry.metrics;
  const metricParts = [
    m?.casQuartile != null ? `${m.casQuartile}区` : null,
    m?.top ? "TOP" : null,
    m?.impactFactor ? `IF ${m.impactFactor}` : null,
  ].filter(Boolean);
  return (
    <span className="flex shrink-0 items-center gap-1">
      {(entry.relevance === "推荐" || entry.relevance === "待确认") && (
        <span
          className={
            entry.relevance === "推荐"
              ? "rounded-full bg-cta-pill px-1.5 py-px text-micro text-cta-pill-text"
              : "rounded-full border border-field bg-canvas px-1.5 py-px text-micro text-l3"
          }
        >
          {entry.relevance}
        </span>
      )}
      {metricParts.length > 0 && (
        <span
          className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone(
            m?.top ? "top" : "quartile",
            m?.casQuartile,
          )}`}
        >
          {metricParts.join(" · ")}
        </span>
      )}
    </span>
  );
}

/** 新命中固定两行：标题独占一行；徽章、日期和操作在第二行。
 *  免费全文由巡检结束时收下，这里不再放「获取全文」。英文摘要点开才见。 */
function WatchEntryRow({
  entry,
  explain,
  onExplain,
  onCloseExplain,
  onRerun,
  onOpenSource,
  onCancelCollect,
  collecting,
  onAttach,
  onDismiss,
  onOpenPdf,
  savedPdf,
  ledger,
  onBookmarkClick,
}: {
  entry: WatchEntryDto;
  explain: ExplainState | null;
  /** 书标点击的统一出口：ledger=reading 时是移出积累，否则加入（父级判定） */
  onBookmarkClick: () => void;
  onExplain: () => void;
  onCloseExplain: () => void;
  onRerun: () => void;
  /** 打开来源页：有机构会话时开进机构登录窗（带会话能过反爬墙），否则系统浏览器 */
  onOpenSource: () => void;
  /** 收货等待中的取消（原「待获取全文」区块的取消口径，区块移除后收回行内） */
  onCancelCollect: () => void;
  collecting: boolean;
  onAttach: () => void;
  onDismiss: () => void;
  /** papers/ 里已存这篇的 PDF：标题变强调色、点击直接打开（对照检索步已存条目） */
  onOpenPdf: () => void;
  savedPdf: string | null;
  /** 书标双态：已在正典（included.md）/ 已在积累（reading-list.md）/ 都不在（null） */
  ledger: LedgerMark | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const open = expanded || !!explain;
  const scan = watchEntryScanLine(entry);
  const source = sourceDisplayName((entry.journal ?? entry.source).trim());
  const zh = entry.zhSummary.trim();
  const abs = entry.abstractFirst.trim();
  const authors = entry.authors.trim();
  const pub = entry.pubDate?.trim();
  const expandedMeta = [authors, source, pub].filter(Boolean).join(" · ");
  // 展开的价值＝被截断的完整摘要＋英文摘要＋作者。三者皆无时展开是空操作，
  // 标题/摘要不再可点（点了没反馈比点不动更糊弄人）
  const hasMore = Boolean(abs) || Boolean(authors) || zh.length > 40;
  // 行内四个操作（收起态悬停出、展开态常驻右对齐），两处复用
  const rowActions = (
    <>
      <button
        type="button"
        className={iconActionClass}
        title={explain ? "收起解读" : "解读"}
        aria-label={explain ? "收起解读" : "解读"}
        onClick={explain ? onCloseExplain : onExplain}
      >
        ◈
      </button>
      {/* 书标：都不在两账 → 加入积累；已在积累 → 点击在「积累」抽屉里定位这一篇
          （移出只走抽屉里的 ✕，行内不放第二个动词）；已在正典 → 只报状态不写；
          精读/全文入口统一在卡头「积累」抽屉 */}
      <button
        type="button"
        className={iconActionClass}
        title={
          ledger === "included"
            ? "这篇已在流程的文献清单 papers/included.md（检索/人审纳入的），不在你的积累清单；点击打开已存全文，纳入/移出在文件页"
            : ledger === "reading"
              ? "已在积累 papers/reading-list.md；点击在「积累」抽屉里定位这一篇（移出在抽屉里）"
              : "存入项目积累清单 papers/reading-list.md；进行中的流程不受影响，下一轮检索步开工时自动作为进料口"
        }
        aria-label={
          ledger === "included"
            ? `已在清单：${entry.title}`
            : ledger === "reading"
              ? `定位积累：${entry.title}`
              : `加入积累：${entry.title}`
        }
        onClick={onBookmarkClick}
      >
        {ledger ? <Bookmark size={13} strokeWidth={1.8} /> : <BookmarkPlus size={13} strokeWidth={1.8} />}
      </button>
      {entry.url.trim() && !collecting && (
        <button
          type="button"
          className={iconActionClass}
          title="在系统浏览器里打开来源（有机构前缀时自动改写带代理）；浏览器里点站方下载，90 秒内落下的 PDF 由 Mesa 自动收进 papers/"
          aria-label="打开来源"
          onClick={onOpenSource}
        >
          <ExternalLink size={13} strokeWidth={1.8} />
        </button>
      )}
      {entry.url.trim() && collecting && (
        // 收货等待态（原「待获取全文」的等待/取消收进行内）：点 ✕ 取消等待
        <span className="flex shrink-0 items-center gap-0.5">
          <span className="text-micro text-l4" title="浏览器已打开；90 秒内落下的 PDF 会自动收进 papers/">
            收货中
          </span>
          <button
            type="button"
            className={iconActionClass}
            title="这篇不下载了：取消收货等待，之后落下的 PDF 不再挂到这一条"
            aria-label="取消收货等待"
            onClick={onCancelCollect}
          >
            ✕
          </button>
        </span>
      )}
      <button
        type="button"
        className={iconActionClass}
        aria-label={`更多操作：${entry.title}`}
        title="更多"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.right, y: rect.bottom + 4 });
        }}
      >
        ⋯
      </button>
    </>
  );
  return (
    <li
      className="group rounded-md px-2 py-1.5 hover:bg-hover"
      data-lit-open-url={entry.url.trim() || undefined}
    >
      {/* 第一行：标题（可截断/展开换行；已存 PDF 时前置文件图标、点击打开） + 复合胶囊。
          标题不用强调色：强调色留给「推荐」与待采纳主按钮，一屏一处重点 */}
      <div className="flex items-start gap-2">
        {savedPdf ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm leading-5 text-l2 hover:text-l1 hover:underline"
            onClick={onOpenPdf}
            title={`已存全文，点击打开 papers/${savedPdf}`}
          >
            <FileText
              size={13}
              strokeWidth={1.8}
              className="shrink-0 text-l3"
              aria-label="已存全文"
            />
            <span className="min-w-0 truncate">{entry.title}</span>
          </button>
        ) : hasMore || expanded ? (
          <button
            type="button"
            className={`min-w-0 flex-1 text-left text-sm leading-5 text-l2 ${
              expanded ? "whitespace-normal" : "truncate"
            }`}
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "收起" : entry.title}
          >
            {entry.title}
          </button>
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-sm leading-5 text-l2"
            title={entry.title}
          >
            {entry.title}
          </span>
        )}
        <EntryBadges entry={entry} />
        {/* 展开/解读态：操作按钮上收标题行右端（与胶囊并排），
            不再单独占一行——独立操作条视觉上就是一条空行（2026-10-14 两轮实证） */}
        {open && (
          <span className="flex shrink-0 items-center">{rowActions}</span>
        )}
      </div>
      {/* 收起态才有第二行（摘要截断 + 右端期刊·日期/悬停操作）。
          展开/解读态这行整个去掉 */}
      {!open && (
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          {scan ? (
            hasMore ? (
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-micro text-l4"
                onClick={() => setExpanded(true)}
              >
                {scan}
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate text-micro text-l4">
                {scan}
              </span>
            )
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          {/* 第二行右端固定槽：平时「期刊 · 日期」，悬停原位换成操作按钮。
              两层同格叠放（grid 同 cell）且都常驻占位（invisible 而非 hidden）——
              槽宽恒为两层较大值，悬停零位移；淡出层同时关 pointer-events，不挡按钮 */}
          <span className="relative grid shrink-0 justify-items-end">
            <span
              className="col-start-1 row-start-1 flex w-max max-w-64 items-center gap-1 text-micro leading-4 text-l3 transition-opacity group-hover:pointer-events-none group-hover:opacity-0"
              title={[entry.journal?.trim() || source, pub].filter(Boolean).join(" · ")}
            >
              {source && <span className="min-w-0 truncate">{source}</span>}
              {pub && <span className="shrink-0 font-mono">{compactPubDate(pub)}</span>}
            </span>
            <span className="col-start-1 row-start-1 flex items-center invisible group-hover:visible group-focus-within:visible">
              {rowActions}
            </span>
          </span>
        </div>
      )}
      {expanded && (zh || abs || expandedMeta) && (
        // 点摘要区同样收起：只让点标题收起，展开后大半行都是「点不动的内容」
        <div
          className="mt-1 cursor-pointer space-y-1"
          onClick={() => setExpanded(false)}
          title="收起"
        >
          {zh && <p className="text-xs leading-5 text-l3">{zh}</p>}
          {abs && <p className="text-xs leading-5 text-l3">{abs}</p>}
          {expandedMeta && (
            <p className="text-micro text-l4">{expandedMeta}</p>
          )}
        </div>
      )}
      {explain && (
        <div className="mt-1 rounded-md ccode-well p-2 text-xs leading-5 text-l2">
          {explain.status === "loading" && (
            <div
              className="flex items-center gap-2 py-1 text-l3"
              role="status"
              aria-live="polite"
            >
              <span className="flex items-center gap-1" aria-hidden="true">
                <span className="size-1.5 animate-pulse rounded-full bg-l3" />
                <span className="size-1.5 animate-pulse rounded-full bg-l3 [animation-delay:120ms]" />
                <span className="size-1.5 animate-pulse rounded-full bg-l3 [animation-delay:240ms]" />
              </span>
              解读进行中…
            </div>
          )}
          {explain.status === "error" && (
            <p className="break-words text-err-text">
              解读失败：{explain.error}{" "}
              <button
                type="button"
                className="underline hover:text-l1"
                onClick={onRerun}
              >
                重试
              </button>
            </p>
          )}
          {explain.status === "ok" && (
            <WatchExplainBody text={explain.text} onRerun={onRerun} />
          )}
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          onClose={() => setMenu(null)}
          items={[
            {
              icon: ExternalLink,
              label: "打开来源",
              disabled: !entry.url.trim(),
              title: entry.url.trim() ? entry.url : "这条命中没有链接",
              // 与工具栏同一条链（2026-09-17 审计：旧口径直开 URL，绕过收货
              // 登记与机构前缀改写——菜单打开后下载的 PDF 不会被收进 papers/）
              onSelect: onOpenSource,
            },
            {
              icon: Paperclip,
              label: "关联本地 PDF…",
              title: "已手动下载全文？选中文件，自动复制进 papers/ 并登记",
              onSelect: onAttach,
            },
            {
              icon: Copy,
              label: "复制标题",
              onSelect: () =>
                void navigator.clipboard.writeText(entry.title).catch(() => {}),
            },
            { separator: true },
            {
              icon: EyeOff,
              label: "忽略这条",
              title: "从新命中里收起，不再提醒",
              onSelect: onDismiss,
            },
          ]}
        />
      )}
    </li>
  );
}

/** 一条巡检自己的订阅。scheduleId 指向 .ccode/watch/<id>/watchlist.md。 */
export function SubscriptionsModal({
  projectRoot,
  scheduleId,
  scheduleName,
  initial,
  onClose,
  onSaved,
}: {
  projectRoot: string;
  scheduleId: string;
  scheduleName?: string;
  initial: WatchSubscriptionDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<WatchSubscriptionDto[]>(
    initial.length > 0
      ? initial.map((s) => ({ ...s, sources: [...s.sources] }))
      : [{ keyword: "", sources: [], note: "" }],
  );
  // 调用方没带上现有订阅时（巡检行直接打开），自己按任务读一次
  useEffect(() => {
    if (initial.length > 0 || !scheduleId) return;
    let stale = false;
    invoke<WatchSubscriptionDto[]>("list_watch_subscriptions", {
      projectRoot,
      scheduleId,
    })
      .then((subs) => {
        if (stale || subs.length === 0) return;
        setRows(subs.map((s) => ({ ...s, sources: [...s.sources] })));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // 只在打开时读一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 原地编辑源文件：不跳终端页，弹层内嵌 FilePreviewEditor
  const [sourceOpen, setSourceOpen] = useState(false);

  // 源文件可能被用户手改过：关掉编辑器后重读清单刷新表格（读失败保留当前编辑内容）
  async function reloadRows() {
    try {
      const subs = await invoke<WatchSubscriptionDto[]>(
        "list_watch_subscriptions",
        { projectRoot, scheduleId },
      );
      setRows(
        subs.length > 0
          ? subs.map((s) => ({ ...s, sources: [...s.sources] }))
          : [{ keyword: "", sources: [], note: "" }],
      );
    } catch {
      /* 保留当前编辑内容 */
    }
  }

  function patchRow(i: number, patch: Partial<WatchSubscriptionDto>) {
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const subs = rows
      .map((r) => ({
        keyword: r.keyword.trim(),
        sources: r.sources,
        note: r.note.trim(),
      }))
      .filter((r) => r.keyword !== "");
    setBusy(true);
    setError(null);
    try {
      await invoke("save_watch_subscriptions", { projectRoot, scheduleId, subs });
      onSaved();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal
        open
        title={scheduleName ? `${scheduleName} · 关键词` : "追踪关键词"}
        onClose={onClose}
        size="lg"
        description="只给这一条巡检用。arXiv、OpenAlex、Crossref 三个库都会查，每次回看最近 7 天（已见过的自动去重）。"
      >
      <form onSubmit={(e) => void submit(e)}>
        <div className="max-h-80 space-y-2 overflow-auto">
          {rows.map((row, i) => (
            <div key={i} className="rounded-md bg-inset/60 px-2.5 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <input
                  className={`${fieldClass} min-w-0 flex-1`}
                  value={row.keyword}
                  onChange={(e) => patchRow(i, { keyword: e.target.value })}
                  placeholder="关键词，如 mixture-of-experts"
                  aria-label={`第 ${i + 1} 条关键词`}
                />
                <button
                  type="button"
                  aria-label={`删除第 ${i + 1} 条`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1"
                  onClick={() =>
                    setRows((cur) =>
                      cur.length > 1 ? cur.filter((_, j) => j !== i) : cur,
                    )
                  }
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={`${ghostActionClass} mt-2`}
          onClick={() =>
            setRows((cur) => [...cur, { keyword: "", sources: [], note: "" }])
          }
        >
          ＋ 加一行
        </button>
        {error && <NoticeBar tone="err" className="mt-2">{error}</NoticeBar>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            className="mr-auto rounded-sm px-3 py-1.5 text-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
            onClick={() => {
              // 文件不存在时直接预览只会看到「文件不存在」：先保证文件在，已有内容一个字节不动。
              // 不能拿 initial 写回——从巡检行打开时 initial 是空的（弹层自己异步读），
              // 一点就把已有关键词清光（2026-10-17 实证：综述项目雷达整块「没了」）
              setBusy(true);
              setError(null);
              invoke("ensure_watch_subscriptions_file", {
                projectRoot,
                scheduleId,
              })
                .then(() => setSourceOpen(true))
                .catch((reason) => setError(String(reason)))
                .finally(() => setBusy(false));
            }}
          >
            编辑源文件
          </button>
          <button
            type="button"
            onClick={onClose}
            className={secondaryActionClass}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy}
            className={primaryActionClass}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
      </Modal>
      {/* 源文件原地编辑层：monaco 懒加载；关闭后重读清单同步表格 */}
      {sourceOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 ccode-fade"
          onClick={() => {
            setSourceOpen(false);
            void reloadRows();
          }}
        >
          <div
            className="flex h-[70vh] w-[48rem] max-w-[92vw] flex-col overflow-hidden rounded-md ccode-float-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-10 shrink-0 items-center gap-2 px-3">
              <span className="text-sm text-l1">watchlist.md</span>
              <span className="text-micro text-l4">.ccode/watch/ · 这条巡检自己的清单，保存后下次巡检生效</span>
              <button
                type="button"
                className={`${ghostActionClass} ml-auto`}
                onClick={() => {
                  setSourceOpen(false);
                  void reloadRows();
                }}
              >
                × 关闭
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <Suspense
                fallback={
                  <p className="p-4 text-xs text-l4">编辑器加载中…</p>
                }
              >
                <FilePreviewEditor
                  path={`${projectRoot}/.ccode/watch/${scheduleId}/watchlist.md`}
                  root={projectRoot}
                />
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


/**
 * 科研任务「现在」：定时巡检推来的新文献。默认收起；有新命中头上写篇数。
 * 行内「加入积累」由人逐篇挑，存 papers/reading-list.md（积累账）；正典 included.md 在文件页。
 * 订阅/筛选/积累清单入口在卡头，定时入口在项目设置。
 */
export default function LitWatchCard({
  projectRoot,
  cfg,
  onConfigChanged,
  onSubscriptionsChanged,
  focusToken,
  preferCollapsed = false,
  schedulesVersion = 0,
}: {
  projectRoot: string;
  cfg: ProjectConfigDto;
  /** 下载 PDF 会登记进 project.toml 资源清单：通知父级重读档案卡 */
  onConfigChanged: () => void;
  /** 订阅保存后：巡检行的「立即运行」要跟着能点 */
  onSubscriptionsChanged?: () => void;
  /** 收件箱/跑完通知跳转：展开雷达。 */
  focusToken?: number | null;
  /** 有进行中/待验收目标时默认收起，把「项目现在」让出来。 */
  preferCollapsed?: boolean;
  /** 同页任务列表增删改（含启停）的版本号：任务集变了空态行/立即跑要跟着变。
   *  新建/删除任务不发 scheduler-run-done（那只管跑完），靠这个 props 桥刷新。 */
  schedulesVersion?: number;
}) {
  const skillProvides = useSkillProvides();
  const [entries, setEntries] = useState<WatchEntryDto[] | null>(null);
  const [, setFollowups] = useState<WatchFollowupDto[]>([]);
  const [subs, setSubs] = useState<WatchSubscriptionDto[] | null>(null);
  /** 每条巡检自己的关键词。空态和弹层按任务取，不再用项目级一份 */
  const [subsBySchedule, setSubsBySchedule] = useState<
    Record<string, WatchSubscriptionDto[]>
  >({});
  const [included, setIncluded] = useState<IncludedEntryDto[] | null>(null);
  /** 积累账 papers/reading-list.md 的行；与正典 included.md 并行拉，供书标双态与「积累」抽屉 */
  const [readingList, setReadingList] = useState<IncludedEntryDto[] | null>(null);
  const [schedules, setSchedules] = useState<ScheduleDto[] | null>(null);
  /** list_schedules 失败才乐观出卡；加载中不出，避免没建巡检时卡片闪一下再消失 */
  const [schedulesFailed, setSchedulesFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 「新命中」页签内的分组视图：按日期（默认）/ 按关键词 */
  /** 「新命中」列表已无分组切换（2026-10-16 定稿）：恒按日期分段，关键词收窄走胶囊行 */
  /** 期刊指标表状态；null = 未取到（命令缺失/失败，入口不显示） */
  const [metricsStatus, setMetricsStatus] =
    useState<JournalMetricsStatusDto | null>(null);
  const [metricsDownloading, setMetricsDownloading] = useState(false);
  /** 上游是否有新版指标表；null = 未查/查询失败（静默） */
  const [metricsUpdate, setMetricsUpdate] =
    useState<JournalMetricsUpdateDto | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    loadLitDismissed(),
  );
  const [subsOpen, setSubsOpen] = useState(false);
  /** 卡头筛选行开关 */
  const [filterOpen, setFilterOpen] = useState(false);
  /** 卡头「积累」抽屉开关 */
  const [readingOpen, setReadingOpen] = useState(false);
  /** 书标定位：点已积累的书标 → 展开抽屉并高亮这一篇（token 重触发，同篇再点再闪） */
  const [readingFocus, setReadingFocus] = useState<{ lineId: string; token: number } | null>(null);
  const [readingFlash, setReadingFlash] = useState<string | null>(null);
  const [browserOpenedAt, setBrowserOpenedAt] = useState<Record<string, number>>({});
  const [browserSpotlight, setBrowserSpotlight] = useState<string | null>(null);
  const browserSpotlightAway = useRef(false);
  const [explains, setExplains] = useState<Record<string, ExplainState>>({});
  /** 解读展开态与结果缓存分离：收起不丢缓存，再展开直接复用（不重复调 AI） */
  const [explainOpen, setExplainOpen] = useState<Set<string>>(new Set());
  // 成功 toast（同 GitPanel 口径：CTA 绿底右下角 2.5s 自收）
  const [toast, setToast] = useState<{ text: string; hiding: boolean } | null>(
    null,
  );
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setPage = useAppStore((s) => s.setPage);
  const setReaderReq = useAppStore((s) => s.setReaderReq);
  const setFilePreviewReq = useAppStore((s) => s.setFilePreviewReq);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const [bodyOpen, setBodyOpen] = useState(() =>
    preferCollapsed ? false : readLitWatchBodyOpen(projectRoot),
  );
  const [hitQuery, setHitQuery] = useState("");
  const [showAllHits, setShowAllHits] = useState(false);
  // 待人工下载对照 papers/：文件名 → 已存。和检索步待获取共用 to_fetch_progress。
  /** 命中里 papers/ 已有 PDF 的 id。待获取 = 没有 PDF 的命中 */
  const [, setSavedHitIds] = useState<Set<string>>(new Set());
  /** papers/ 已存 PDF 的命中 → 文件名（标题强调色点击开全文） */
  const [savedPdfBy, setSavedPdfBy] = useState<Record<string, string>>({});
  /** 积累抽屉行 → 已存 PDF 文件名（开读按钮） */
  const [readingPdfBy, setReadingPdfBy] = useState<Record<string, string>>({});
  /** notes/ 笔记配对（list_paper_notes）：抽屉「精读」按钮有笔记时显示「继续精读」 */
  const [noteLinks, setNoteLinks] = useState<PaperNoteLink[] | null>(null);
  const [repairingDates, setRepairingDates] = useState(false);

  function showToast(text: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ text, hiding: false });
    toastTimerRef.current = setTimeout(() => {
      setToast((t) => (t ? { ...t, hiding: true } : t));
      toastTimerRef.current = setTimeout(() => setToast(null), 300);
    }, 2200);
  }

  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const setRadarOpen = useCallback((open: boolean) => {
    setBodyOpen(open);
    writeLitWatchBodyOpen(projectRoot, open);
  }, [projectRoot]);

  useEffect(() => {
    setBodyOpen(preferCollapsed ? false : readLitWatchBodyOpen(projectRoot));
  }, [projectRoot, preferCollapsed]);

  useEffect(() => {
    if (focusToken == null) return;
    setRadarOpen(true);
  }, [focusToken, setRadarOpen]);

  async function load() {
    const [inbox, includedList, readingRows, noteLinkRows, scheduleList] =
      await Promise.all([
        invoke<WatchInboxDto>("list_watch_entries", { projectRoot }).catch(
          (reason) => {
            setError(String(reason));
            setEntries([]);
            return null;
          },
        ),
        invoke<IncludedEntryDto[]>("list_included_entries", {
          projectRoot,
        }).catch(() => null),
        invoke<IncludedEntryDto[]>("list_reading_list_entries", {
          projectRoot,
        }).catch(() => null),
        invoke<PaperNoteLink[]>("list_paper_notes", { projectRoot }).catch(
          () => null,
        ),
        invoke<ScheduleDto[]>("list_schedules").catch(() => null),
      ]);
    if (inbox) {
      setEntries(inbox.entries);
      setFollowups(inbox.followups);
      setError(null);
      setExplains((cur) => {
        const next = { ...cur };
        for (const e of inbox.entries) {
          const text = e.explain?.trim();
          if (!text) continue;
          const prev = next[e.id];
          if (prev?.status === "loading" || prev?.status === "error") continue;
          next[e.id] = { status: "ok", text };
        }
        return next;
      });
    }
    if (includedList) setIncluded(includedList);
    if (readingRows) setReadingList(readingRows);
    if (noteLinkRows) setNoteLinks(noteLinkRows);
    if (scheduleList) {
      setSchedules(schedulesForProject(scheduleList, projectRoot, IS_WINDOWS));
      setSchedulesFailed(false);
    } else {
      setSchedulesFailed(true);
    }
  }

  useEffect(() => {
    let stale = false;
    const reload = () => {
      if (!stale) void load();
    };
    reload();
    // 指标表缺失时卡头才出下载入口；失败（命令缺失等）静默，不打扰卡片主功能
    invoke<JournalMetricsStatusDto>("journal_metrics_status")
      .then((s) => {
        if (stale) return;
        setMetricsStatus(s);
        // 已装表才顺带查上游有没有新版；本机访问 GitHub 慢，失败同样静默
        if (s.available) {
          invoke<JournalMetricsUpdateDto>("check_journal_metrics_update")
            .then((u) => {
              if (!stale) setMetricsUpdate(u);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    let unlisten: (() => void) | undefined;
    listen("scheduler-run-done", () => {
      reload();
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    let unlistenAdopt: (() => void) | undefined;
    listen("watch-run-adopted", () => {
      reload();
    })
      .then((u) => (unlistenAdopt = u))
      .catch(() => {});
    // 扩展「存到 Mesa」经 helper 落盘后的广播（主程序回执监听发出）：命中行
    // 「✓ 已有全文」/待办状态要跟着 papers/ 变化翻新，不再等下次巡检
    let unlistenPapers: (() => void) | undefined;
    listen<{ projectRoot?: string }>("inst-papers-changed", (e) => {
      if (e.payload?.projectRoot && e.payload.projectRoot !== projectRoot) return;
      setBrowserOpenedAt({});
      reload();
    })
      .then((u) => (unlistenPapers = u))
      .catch(() => {});
    return () => {
      stale = true;
      unlisten?.();
      unlistenAdopt?.();
      unlistenPapers?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  // 同页任务列表增删改的桥（见 props 注释）：任务集变化就地刷新空态行与「立即跑」，
  // 不用切页回来才看到。0 是初值不触发，挂载那轮已由上面的 effect 拉过。
  useEffect(() => {
    if (!schedulesVersion) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedulesVersion]);

  /** 笔记配对重拉：抽屉每次展开刷一次（笔记可能在沉浸阅读/流程里被写过），建档后也调 */
  const refreshNoteLinks = useCallback(() => {
    invoke<PaperNoteLink[]>("list_paper_notes", { projectRoot })
      .then((rows) => setNoteLinks(rows))
      .catch(() => {});
  }, [projectRoot]);
  useEffect(() => {
    if (readingOpen) refreshNoteLinks();
  }, [readingOpen, refreshNoteLinks]);

  // 书标定位落地：同批 setState 提交后抽屉行才渲染完，这里找得到节点。不走 CSS.escape
  // （jsdom 无 CSS 全局），lineId 是后端哈希，按属性值直接比对即可
  useEffect(() => {
    if (!readingFocus) return;
    const el = [
      ...document.querySelectorAll<HTMLElement>("[data-reading-line]"),
    ].find((node) => node.getAttribute("data-reading-line") === readingFocus.lineId);
    el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    setReadingFlash(readingFocus.lineId);
    const timer = window.setTimeout(() => setReadingFlash(null), 1800);
    return () => window.clearTimeout(timer);
  }, [readingFocus]);

  // 文献雷达位：自建巡检技能声明 provides: lit-watch 即点亮本卡（名字精确匹配兜底）。
  // 已知不对称（复审记录）：后端的专用 prompt / new_entries 计数 / 待采纳评审仍只认
  // 内置技能名 "lit-watch"——provides 点亮的卡能跑能「立即跑」，但没有计数与采纳行
  const radarSchedules = (schedules ?? []).filter((s) =>
    resolveSkillSlot(LIT_WATCH_SLOT, [s.skill], skillProvides) !== null,
  );
  const radarKey = radarSchedules.map((s) => s.id).join("\n");

  // 每条巡检自己的关键词。空表 = 一条都没有；null = 还没拉到。
  useEffect(() => {
    const ids = radarKey ? radarKey.split("\n") : [];
    if (ids.length === 0) {
      setSubs([]);
      return;
    }
    let stale = false;
    Promise.all(
      ids.map((id) =>
        invoke<WatchSubscriptionDto[]>("list_watch_subscriptions", {
          projectRoot,
          scheduleId: id,
        }).then((list) => [id, list] as const),
      ),
    )
      .then((pairs) => {
        if (stale) return;
        const next: Record<string, WatchSubscriptionDto[]> = {};
        for (const [id, list] of pairs) next[id] = list;
        setSubsBySchedule(next);
        setSubs(pairs.flatMap(([, list]) => list));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [projectRoot, radarKey, schedulesVersion]);

  /** 最近一次成功 run（卡头时间 / 立即跑 / 漂移提醒共用） */
  const lastOkRun = (s: ScheduleDto) => s.history.find((r) => r.status === "ok");
  const latestRadarRun = radarSchedules
    .map((s) => ({ schedule: s, run: lastOkRun(s) }))
    .filter((x): x is { schedule: ScheduleDto; run: NonNullable<ReturnType<typeof lastOkRun>> } => !!x.run)
    .sort((a, b) => Date.parse(b.run.at) - Date.parse(a.run.at))[0]?.run ?? null;
  /** 隔离树已有新命中、尚未采纳进主仓的最近一次运行：待评审提示是列表区的唯一答案（pendingRow）。
   *  不取 latestRadarRun——同一天后跑的 0 命中轮不该遮住前一轮未采纳的命中
   *  （2026-10-16 实证：10-34 轮 1 篇待采纳被 11-23 轮 0 命中盖掉，卡上无任何提示）。
   *  采纳前列表为空是预期——不再另出空态文案，计数微行也不重复「新增 N 条」 */
  const pendingAdoption =
    radarSchedules
      .map((s) =>
        s.history.find(
          (r) => r.status === "ok" && !r.adopted && (r.newEntries ?? 0) > 0,
        ),
      )
      .filter((r): r is NonNullable<ReturnType<typeof lastOkRun>> => !!r)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  /** 待采纳提示：正文 + 「去评审」收进内容井列表区（用户视线所在）；无订阅时不渲染
   *  内容井，但入口不能丢——单独出这一行 */
  const pendingRow = pendingAdoption ? (
    <div className="mt-2 mb-2 flex flex-wrap items-center gap-3 rounded-md border border-warn-text/25 bg-warn-text/10 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-l1">
          {pendingAdoption.newEntries} 篇新命中待采纳
        </p>
        <p className="mt-0.5 text-micro text-l3">
          还在这次巡检的隔离目录里，核对后才会进课题文件夹
        </p>
      </div>
      <button
        type="button"
        className={`${primaryActionClass} shrink-0`}
        onClick={() => {
          setWorkspaceReviewRequest({
            worktreePath: pendingAdoption.isolationPath!,
            runId: pendingAdoption.runId ?? null,
            requestId: crypto.randomUUID(),
            returnTo: { projectRoot, surface: "schedules" },
          });
          setPage("terminal");
        }}
      >
        去评审
      </button>
    </div>
  ) : null;
  async function repairWatchDates() {
    const days = undatedWatchRuns(radarSchedules).map((run) => run.day);
    const day = days[days.length - 1];
    if (!day) return;
    setRepairingDates(true);
    setError(null);
    try {
      const wrote = await invoke<boolean>("repair_watch_batch_dates", {
        projectRoot,
        day,
      });
      if (wrote) showToast(`已按 ${day} 补上巡检日期`);
      else showToast("这些条目已经有巡检日期");
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRepairingDates(false);
    }
  }

  const lastRunAt = radarSchedules
    .map((s) => lastOkRun(s)?.at ?? null)
    .filter((v): v is string => v !== null)
    .sort()
    .pop();

  async function saveFilter(next: LitWatchFilterDto | null) {
    setError(null);
    try {
      await invoke("update_lit_watch_filter", { projectRoot, filter: next });
      onConfigChanged();
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 下载期刊指标表（可能耗时 1-4 分钟）：成功后就绪提示 + 重拉条目让徽章出现 */
  async function downloadMetrics() {
    setMetricsDownloading(true);
    setError(null);
    try {
      const status =
        await invoke<JournalMetricsStatusDto>("download_journal_metrics");
      setMetricsStatus(status);
      // 刚下完就是最新，清掉「有新表」标记
      setMetricsUpdate(null);
      showToast(`期刊指标表已就绪（${status.journalCount} 种期刊）`);
      void load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setMetricsDownloading(false);
    }
  }

  /** ◈ 解读：快筛五节；已落盘的直接展开。ai_prompt 传功能键 watch-explain（设置页「雷达解读」行可配专属连接+模型，未配走自动回落链）。 */
  async function explain(entry: WatchEntryDto) {
    setExplainOpen((cur) => new Set(cur).add(entry.id));
    setExplains((cur) => ({ ...cur, [entry.id]: { status: "loading" } }));
    const prompt = watchExplainPrompt(entry, cfg.topic);
    try {
      const text = (await invoke<string>("ai_prompt", {
        profileId: null,
        fnKey: "watch-explain",
        prompt,
      })).trim();
      if (!text) throw new Error("AI 返回为空");
      setExplains((cur) => ({
        ...cur,
        [entry.id]: { status: "ok", text },
      }));
      setEntries((cur) =>
        cur
          ? cur.map((e) => (e.id === entry.id ? { ...e, explain: text } : e))
          : cur,
      );
      try {
        await invoke("save_watch_explain", {
          projectRoot,
          title: entry.title,
          text,
        });
      } catch (reason) {
        showToast(`解读已出，但没写进项目：${String(reason)}`);
      }
    } catch (reason) {
      setExplains((cur) => ({
        ...cur,
        [entry.id]: { status: "error", error: String(reason) },
      }));
    }
  }

  /** 「加入积累」：只写账不打断——不跳精读、不开全文（2026-10-14 用户拍板：
   *  精读与笔记入口统一收进积累抽屉，行内书标只负责进账与定位）。
   *  全文状态由轮询 + inst-papers-changed 即时回执翻新 */
  async function addToReading(entry: WatchEntryDto) {
    try {
      const res = await invoke<AddIncludedResultDto>("add_reading_list_entry", {
        projectRoot,
        ...includedLineFor(entry),
      });
      const rows = await invoke<IncludedEntryDto[]>(
        "list_reading_list_entries",
        { projectRoot },
      ).catch(() => null);
      if (rows) setReadingList(rows);
      refreshFollowupSaved();
      showToast(res.added ? "已加入积累清单，点书标在「积累」里定位开读" : "已在积累清单（正典或积累账其一）");
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 书标统一出口：都不在 → 加入积累；已在积累 → 展开「积累」抽屉并定位这一篇
   *  （移出只走抽屉里的 ✕，行内不放第二个动词）；仅在正典 → 这篇归流程管、抽屉里
   *  没有它——已存全文直接打开（与标题点击同一动作），没有全文才说明去处 */
  async function bookmarkToggle(entry: WatchEntryDto) {
    const mark = ledgerMarkFor(entry.title, includedTitles, readingTitles);
    if (mark === "included") {
      const pdf = savedPdfBy[entry.id];
      if (pdf) {
        openSavedPdf(pdf);
        showToast("这篇已在流程的文献清单里；打开已存全文");
      } else {
        showToast("这篇已在流程的文献清单里，不加重复积累；全文和移出都在文件页");
      }
      return;
    }
    if (mark === "reading") {
      // 与书标判定（ledgerMarkFor/normalizedTitleSet）同一把尺子：规范化标题精确相等
      const et = normalizeTitle(entry.title);
      const locate = (rows: readonly IncludedEntryDto[] | null) => {
        const row = (rows ?? []).find((r) => normalizeTitle(r.title) === et);
        if (!row) return false;
        setRadarOpen(true);
        setReadingOpen(true);
        setReadingFocus({ lineId: row.lineId, token: Date.now() });
        return true;
      };
      if (locate(readingList)) return;
      // 状态里没找到先重拉一次再判（清单可能刚被别处改过），还不在这篇才说明
      const rows2 = await invoke<IncludedEntryDto[]>("list_reading_list_entries", { projectRoot }).catch(() => null);
      if (rows2) setReadingList(rows2);
      if (!locate(rows2)) showToast("积累清单里没有找到这篇（可能刚被移除）");
      return;
    }
    await addToReading(entry);
  }

  /** 积累抽屉「精读」：建档（已有笔记则配对复用）后进沉浸阅读——笔记接续由
   *  reader 侧既有机制保证（来源锚点/标题配对 + lit-notes §1a 接续口径） */
  async function openReaderFor(fileName: string) {
    const name = fileName.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
    if (!name) return;
    const rel = `papers/${name}`;
    const root = projectRoot.replace(/[\\/]+$/, "");
    const abs = /^([a-zA-Z]:[\\/]|\/)/.test(rel) ? rel : `${root}/${rel}`;
    try {
      const note = await invoke<{ path: string; created: boolean }>(
        "ensure_paper_note",
        { projectRoot, pdfPath: abs },
      );
      refreshNoteLinks();
      setReaderReq({ pdfPath: abs, projectRoot, notePath: note.path });
      setPage("terminal");
    } catch (reason) {
      // 建档被拒（未登记只读资源等）：仍给预览兜底，错误照实说
      setError(String(reason));
      openSavedPdf(fileName);
    }
  }

  /** 积累抽屉「笔记」：按 PDF 找/建精读笔记（ensure_paper_note：已存在复用路径、
   *  新建给八段骨架），文件页打开这份笔记；建不出来给出原因 */
  async function openNoteFor(fileName: string) {
    const name = fileName.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
    if (!name) return;
    const rel = `papers/${name}`;
    const root = projectRoot.replace(/[\\/]+$/, "");
    const abs = /^([a-zA-Z]:[\\/]|\/)/.test(rel) ? rel : `${root}/${rel}`;
    try {
      const note = await invoke<{ path: string; created: boolean }>(
        "ensure_paper_note",
        { projectRoot, pdfPath: abs },
      );
      refreshNoteLinks();
      setFilePreviewReq({ projectRoot, path: note.path, token: Date.now() });
      if (note.created) {
        showToast("笔记已建档（八段骨架）；精读时在沉浸阅读里接着写");
      }
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** papers/ 已存的 PDF：文件页预览打开。fileName 来自 to_fetch_progress/关联结果 */
  function openSavedPdf(fileName: string) {
    const name = fileName.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
    if (!name) return;
    const rel = `papers/${name}`;
    const root = projectRoot.replace(/[\\/]+$/, "");
    const abs = /^([a-zA-Z]:[\\/]|\/)/.test(rel) ? rel : `${root}/${rel}`;
    setFilePreviewReq({ projectRoot, path: abs, token: Date.now() });
  }

  /** 抽屉里移除一条积累：删 reading-list.md 对应行并重拉清单（不动正典 included.md） */
  async function removeReading(lineId: string) {
    try {
      await invoke("remove_reading_list_entry", { projectRoot, lineId });
      const rows = await invoke<IncludedEntryDto[]>(
        "list_reading_list_entries",
        { projectRoot },
      );
      setReadingList(rows);
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 打开来源页：在系统浏览器里打开（真实浏览器会话，出版商不拦截）——浏览器里
   *  点站方下载，落下的 PDF 由 Mesa 收货通道自动收进本项目 papers/（时间窗+标题
   *  归属匹配）；内嵌机构窗保留作回落 */
  /** 「浏览器打开」进行中状态（90 秒窗可见性，终检补：toast 之外待办行按钮
   *  也要有等待态——StepFlow 同款口径） */
  const [, tickBrowserOpened] = useState(0);
  useEffect(() => {
    if (!Object.keys(browserOpenedAt).length) return;
    const t = window.setInterval(() => {
      // 到期剪掉（终检二轮：只增不删会让雷达卡每秒全量重渲染直至卸载）
      const now = Date.now();
      setBrowserOpenedAt((cur) => {
        const next = Object.fromEntries(
          Object.entries(cur).filter(([, at]) => now - at < 95000),
        );
        return Object.keys(next).length === Object.keys(cur).length ? cur : next;
      });
      tickBrowserOpened((v) => v + 1);
    }, 1000);
    return () => window.clearInterval(t);
  }, [browserOpenedAt]);
  useEffect(() => {
    if (browserSpotlight == null) return;
    const onHide = () => {
      browserSpotlightAway.current = true;
    };
    const onBack = () => {
      if (!browserSpotlightAway.current) return;
      browserSpotlightAway.current = false;
      const el = document.querySelector(
        `[data-lit-open-url="${CSS.escape(browserSpotlight)}"]`,
      );
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") onHide();
      else onBack();
    };
    window.addEventListener("blur", onHide);
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", onHide);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [browserSpotlight]);

  const hitProbeRef = useRef(entries);
  hitProbeRef.current = entries;
  // 轮询 papers/ 已存状态：命中行的书标/开读分流靠 savedHitIds；命中标题开全文靠
  // savedPdfBy；积累抽屉的开读按钮靠 readingPdfBy（probes = 命中行 + 积累行，先命中后积累）
  const readingProbeRef = useRef<IncludedEntryDto[] | null>(null);
  readingProbeRef.current = readingList;
  const refreshFollowupSaved = useCallback(() => {
    const hits = hitProbeRef.current ?? [];
    const rows = readingProbeRef.current ?? [];
    const probes = [
      ...hits.map((hit) => ({ title: hit.title, url: hit.url })),
      ...rows.map((row) => ({ title: row.title, url: row.link })),
    ];
    if (!probes.length) {
      setSavedHitIds(new Set());
      setSavedPdfBy({});
      setReadingPdfBy({});
      return;
    }
    invoke<(string | null)[]>("to_fetch_progress", {
      projectRoot,
      items: probes,
    })
      .then((names) => {
        const saved = new Set<string>();
        const byId: Record<string, string> = {};
        names?.forEach((name, i) => {
          const hit = hits[i];
          if (name && hit) {
            saved.add(hit.id);
            byId[hit.id] = name;
          }
        });
        setSavedHitIds(saved);
        setSavedPdfBy(byId);
        const byLine: Record<string, string> = {};
        names?.forEach((name, i) => {
          const row = rows[i - hits.length];
          if (name && row && i >= hits.length) {
            byLine[row.lineId] = name;
          }
        });
        // to_fetch_progress 有「一个 PDF 只挂一行」的 taken 保护：同一篇论文
        // 同时在命中行和积累行时，命中行先占、积累行恒空（2026-10-14 实证）。
        // 同题不是重复挂——把命中行的匹配补给积累行（normalizeTitle 同一把尺子）
        for (const row of rows) {
          if (byLine[row.lineId]) continue;
          const rt = normalizeTitle(row.title);
          if (!rt) continue;
          const fromHit = Object.entries(byId).find(([id]) => {
            const hit = hits.find((h) => h.id === id);
            return hit ? normalizeTitle(hit.title) === rt : false;
          });
          if (fromHit) byLine[row.lineId] = fromHit[1];
        }
        setReadingPdfBy(byLine);
      })
      .catch(() => {});
  }, [projectRoot]);
  useEffect(() => {
    refreshFollowupSaved();
  }, [entries, readingList, refreshFollowupSaved]);
  usePolling(() => refreshFollowupSaved(), 4000);
  // 收货/关联落盘即时回执（与检索步同款事件）：不等 4 秒轮询，标题/书标当场翻
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    listen<{ projectRoot?: string }>("inst-papers-changed", (e) => {
      if (e.payload?.projectRoot && !samePath(e.payload.projectRoot, projectRoot, IS_WINDOWS)) return;
      refreshFollowupSaved();
    })
      .then((u) => {
        if (cancelled) u();
        else un = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      un?.();
    };
  }, [projectRoot, refreshFollowupSaved]);


  function openWithSession(rawUrl: string, title?: string) {
    if (!rawUrl.trim()) return;
    invoke("inst_browser_open", {
      url: instOpenTarget(rawUrl),
      projectRoot,
      title: title ?? rawUrl.trim().slice(0, 60),
      doi: rawUrl,
    })
      .then(() => {
        // 90 秒窗可见性（2026-09-17 审计）：打开后给一句交代，用户才知道
        // 「接下来在浏览器里点下载就行，Mesa 会自动接住」
        browserSpotlightAway.current = false;
        setBrowserSpotlight(rawUrl.trim());
        setBrowserOpenedAt((cur) => ({ ...cur, [rawUrl.trim()]: Date.now() }));
        showToast("已打开浏览器——在里面点站方下载，90 秒内落下的 PDF 会自动收进 papers/");
      })
      .catch((e) => setError(`打开浏览器失败：${String(e)}`));
  }

  /** 关联本地 PDF（命中条目 / 精读条目共用 ⋯ 菜单）：文件对话框选 PDF，
   *  后端复制进 papers/ 并按标题登记 project.toml，父级重读后精读行主按钮变「开读」 */
  async function attachPdf(title: string): Promise<boolean> {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof selected !== "string") return false; // 取消或异常形态
    try {
      const res = await invoke<DownloadedPaperDto>("attach_paper_pdf", {
        projectRoot,
        sourcePath: selected,
        title,
      });
      showToast(`已关联：${res.name}`);
      onConfigChanged();
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    }
  }

  // 雷达筛选（存 project.toml）：只过滤新命中；设了条件而指标未知的条目不显示。
  // 趋势柱点选是第三层过滤（时间桶），与指标筛选、搜索叠加
  const filter = cfg.litWatchFilter;
  const filterOn = litWatchFilterActive(filter);
  const [trendMode, setTrendMode] = useState<TrendMode>("week");
  // 点趋势柱选中的时间桶（key=桶起点 YYYY-MM-DD）；切粒度/再点同柱清除
  const [selectedBucketKey, setSelectedBucketKey] = useState<string | null>(null);
  // 关键词筛选（2026-10-16 定稿）：关键词是用户自己的心智模型，做成列表上方常驻胶囊行（截图样式：
  // 竖条+粗体+计数）；时间收窄只走趋势图点柱（唯一的视觉时间筛），不再另设时间控件
  const [kwFilter, setKwFilter] = useState<string | null>(null);
  const undismissed = filterLitDismissed(entries ?? [], dismissed);
  const filteredEntries = filterOn
    ? undismissed.filter((e) => entryPassesFilter(e.metrics, filter))
    : undismissed;
  const recTotal = undismissed.filter((e) => e.relevance === "推荐").length;
  const bucketFiltered =
    selectedBucketKey != null
      ? filteredEntries.filter((e) =>
          entryInTrendBucket(e, trendMode, selectedBucketKey),
        )
      : filteredEntries;
  const visibleEntries = bucketFiltered;
  // 卡头篇数 = 筛选/选柱后的可见数；两者不等时微行补一句藏了多少，相等就不重复。
  // 不写「共 N 篇」：稀疏趋势那句已带「共 N 篇」，同一行出现两次（2026-10-17 用户截图）
  const hiddenCount = undismissed.length - visibleEntries.length;
  const hiddenTotalNote =
    hiddenCount > 0
      ? filterOn && selectedBucketKey == null
        ? `筛掉 ${hiddenCount} 篇`
        : `另有 ${hiddenCount} 篇未显示`
      : null;
  const qHit = hitQuery.trim().toLowerCase();
  const searchedHits = qHit
    ? visibleEntries.filter(
        (e) =>
          e.title.toLowerCase().includes(qHit) ||
          (e.zhSummary ?? "").toLowerCase().includes(qHit) ||
          e.source.toLowerCase().includes(qHit),
      )
    : visibleEntries;
  // 双维筛选的选项与生效值：生效值在选项消失时回落 null（防陈旧筛选卡死空列表）
  // 关键词页签 = 订阅词在前（含 0 命中，用户加的词要看得见）+ 条目里的额外词在后（关联推荐/未分类）
  const kwTabs = (() => {
    const counts = new Map<string, number>();
    for (const e of searchedHits)
      for (const k of e.keywordsHit) counts.set(k, (counts.get(k) ?? 0) + 1);
    const seen = new Set<string>();
    const tabs: { key: string; label: string; n: number }[] = [];
    const push = (k: string) => {
      const key = k.trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      tabs.push({ key, label: watchKeywordLabel(key), n: counts.get(key) ?? 0 });
    };
    for (const s of radarSchedules)
      for (const sub of subsBySchedule[s.id] ?? []) push(sub.keyword);
    for (const [k] of [...counts.entries()].sort((a, b) => b[1] - a[1])) push(k);
    return tabs;
  })();
  // 关键词筛选：胶囊行永远可见（不随视图切换），生效值在选项消失时回落 null 防陈旧卡死
  const activeKw =
    kwFilter != null && kwTabs.some((o) => o.key === kwFilter) ? kwFilter : null;
  const filteredHits =
    activeKw == null
      ? searchedHits
      : searchedHits.filter((e) => e.keywordsHit.includes(activeKw));
  const listedFilteredHits =
    qHit || showAllHits
      ? filteredHits
      : filteredHits.slice(0, LIST_PREVIEW_CAP);
  // 书标双态的两张规范化标题表：正典 included.md 与积累账 reading-list.md
  const includedTitles = normalizedTitleSet(included);
  const readingTitles = normalizedTitleSet(readingList);
  const trend = useMemo(
    () => trendSummary(entries ?? [], trendMode),
    [entries, trendMode],
  );
  // 「新命中」恒按日期分段（2026-10-16 定稿，分组切换已撤）：选关键词只收窄分段里的内容
  const entryGroups: {
    key: string;
    label: string;
    entries: WatchEntryDto[];
    prominent: boolean;
  }[] = groupEntriesByDay(listedFilteredHits).map((g) => ({
    ...g,
    prominent: false,
  }));
  const hasSubs = radarSchedules.some((s) => (subsBySchedule[s.id] ?? []).length > 0);
  const unsubscribed = radarSchedules.filter(
    (s) => subsBySchedule[s.id] && subsBySchedule[s.id].length === 0,
  );

  if (schedules === null && !schedulesFailed) return null;

  // 关键词清空了但雷达已经攒下命中：照常出整张卡（另起一行提示补关键词）——
  // 收成一行「还没订阅读」会把攒下的上百篇一起藏掉，看起来像「雷达没了」（2026-10-17 用户实测）
  const accumulated = entries === null || entries.length > 0;
  if (subs !== null && !hasSubs && !accumulated) {
    // 订阅在没有定时任务时毫无效果（「立即跑」也只认有任务的卡，新命中只来自巡检）：
    // 还没建雷达巡检时不摆这个入口，定时任务页只留「＋ 定时巡检」一条主路，
    // 免得「添加」被当成加任务、订完关键词又永远不跑。
    // schedules 未落定/拉取失败时不判「没有任务」（与本条件里 subs !== null 的判空对称）：
    // list_schedules 静默吞错，失败时按乐观出这行，事件/桥会再翻新
    if (schedules !== null && radarSchedules.length === 0) return null;
    return (
      <>
      <div className="mb-4 flex items-center gap-2 px-1">
        <span className="text-xs text-l4">文献雷达 · 还没订阅读</span>
        <button
          type="button"
          className={ghostActionClass}
          onClick={() => setSubsOpen(true)}
        >
          订阅关键词
        </button>
      </div>
      {/* 无订阅时不渲染内容井，但待采纳入口不能丢（同主渲染的口径） */}
      {pendingRow}
      {subsOpen && (
        <SubscriptionsModal
          projectRoot={projectRoot}
          scheduleId={unsubscribed[0]?.id ?? radarSchedules[0]?.id ?? ""}
          scheduleName={unsubscribed[0]?.name ?? radarSchedules[0]?.name}
          initial={subsBySchedule[unsubscribed[0]?.id ?? ""] ?? []}
          onClose={() => setSubsOpen(false)}
          onSaved={() => {
            setSubsOpen(false);
            void load();
            onSubscriptionsChanged?.();
          }}
        />
      )}
      </>
    );
  }

  return (
    <section>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 text-left"
          onClick={() => setRadarOpen(!bodyOpen)}
          aria-expanded={bodyOpen}
        >
          <FoldMark open={bodyOpen} boxed />
          <h2 className="text-xs font-medium text-l2">
            {visibleEntries.length > 0
              ? `文献雷达 · ${visibleEntries.length} 篇`
              : lastRunAt
                ? `文献雷达 · 上次巡检 ${relTime(lastRunAt)}`
                : "文献雷达"}
          </h2>
        </button>
        {visibleEntries.length > 0 && lastRunAt && (
          <span className="text-micro text-l4">
            上次巡检 {relTime(lastRunAt)}
          </span>
        )}
        {/* 巡检全停用时卡头说清：列表还在，但不会再长新命中（停用开关在下面的任务行） */}
        {radarSchedules.length > 0 && radarSchedules.every((s) => !s.enabled) && (
          <span
            className="text-micro text-warn-text"
            title="雷达巡检已停用，不会再有新命中；在下方定时任务行重新启用"
          >
            已暂停
          </span>
        )}
        {bodyOpen && (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {metricsStatus && (
            <button
              type="button"
              className={`flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro hover:bg-hover ${
                metricsDownloading ? "cursor-wait text-l4" : "text-l3 hover:text-l1"
              }`}
              title={
                metricsDownloading
                  ? "正在下载期刊指标表"
                  : metricsStatus.available
                    ? metricsTooltip(metricsStatus, metricsUpdate, relTime)
                    : "下载期刊指标表"
              }
              disabled={metricsDownloading}
              onClick={() => void downloadMetrics()}
            >
              {metricsStatus.available ? (
                <>
                  <Table2 size={13} strokeWidth={1.8} />
                  表格
                  {metricsUpdate?.hasUpdate && (
                    <span className="ml-0.5 size-1.5 shrink-0 rounded-full bg-cta" />
                  )}
                </>
              ) : (
                <>
                  <Download size={13} strokeWidth={1.8} />
                  下载表格
                </>
              )}
            </button>
          )}
          {radarSchedules.length <= 1 && (
            <button
              type="button"
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
              title="管理订阅"
              onClick={() => setSubsOpen(true)}
            >
              <Rss size={13} strokeWidth={1.8} />
              订阅
            </button>
          )}
          {/* 积累清单入口：条数为 0 也显示，让「攒候选」这条路径常驻可见 */}
          <button
            type="button"
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
            title="项目积累清单 papers/reading-list.md：雷达里「加入积累」的候选都攒在这里。不进 git、不影响进行中的流程，下一轮检索步开工时自动作为进料口"
            aria-expanded={readingOpen}
            onClick={() => setReadingOpen((v) => !v)}
          >
            <Bookmark size={13} strokeWidth={1.8} />
            积累 {readingList?.length ?? 0}
          </button>
          {filterOn ? (
            /* 筛选生效时换成带字状态：藏掉多少条一眼可见，不必悬停 */
            <button
              type="button"
              className="flex h-7 min-w-0 max-w-[14rem] shrink items-center gap-1 rounded-md px-1.5 text-micro text-cta hover:bg-hover"
              title={`当前筛选：${litWatchFilterLabel(filter)}（点我修改）`}
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((v) => !v)}
            >
              <ListFilter size={13} strokeWidth={1.8} className="shrink-0" />
              <span className="min-w-0 truncate">筛选：{litWatchFilterLabel(filter)}</span>
            </button>
          ) : (
            <HeadIcon
              label="按期刊指标筛选新命中（查不到指标的条目开了筛选不显示）"
              onClick={() => setFilterOpen((v) => !v)}
            >
              <ListFilter size={13} strokeWidth={1.8} />
            </HeadIcon>
          )}
        </div>
        )}
        {bodyOpen && filterOpen && (
          <div className="mt-2 flex flex-wrap items-center gap-1 px-1">
            {(
              [
                { label: "不限", filter: null },
                { label: "IF≥5", filter: { minIf: 5, maxCasQuartile: null, topOnly: false } },
                { label: "IF≥10", filter: { minIf: 10, maxCasQuartile: null, topOnly: false } },
                { label: "仅 1 区", filter: { minIf: null, maxCasQuartile: 1, topOnly: false } },
                { label: "仅 TOP", filter: { minIf: null, maxCasQuartile: null, topOnly: true } },
              ] as const
            ).map((item) => {
              const current =
                item.filter == null
                  ? !filterOn
                  : filter?.minIf === item.filter.minIf &&
                    filter?.maxCasQuartile === item.filter.maxCasQuartile &&
                    !!filter?.topOnly === item.filter.topOnly;
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    void saveFilter(current ? null : item.filter);
                    setFilterOpen(false);
                  }}
                  className={`flex h-6 items-center rounded-full px-2 text-xs ${
                    current ? "bg-seg-sel text-l1" : "bg-inset text-l3 hover:text-l1"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        )}
        {/* 积累清单抽屉：展开方式与筛选行一致。内容三层——定位说明 / 条目行（含开读） / 去向说明 */}
        {bodyOpen && readingOpen && (
          <div className="mt-2 w-full px-1">
            <p
              className="mb-2 text-micro leading-snug text-l4"
              title="记在 papers/reading-list.md，不进 git，不影响进行中的流程"
            >
              你攒下的精读候选。下次开科研流程时会一起带进检索。
            </p>
            {readingList !== null && readingList.length === 0 && (
              <p className="text-xs text-l4">
                还没有积累。雷达里点『加入积累』攒你自己的精读候选；配了全文的可以直接开读。
              </p>
            )}
            {readingList !== null && readingList.length > 0 && (
              <ul className="max-h-64 divide-y divide-border/30 overflow-auto">
                {readingList.map((row) => {
                  const pdf = readingPdfBy[row.lineId];
                  // 有笔记 → 「继续精读」：接续铁律在入口上可见（配对口径与文件页
                  // 精读状态同源：list_paper_notes + noteLinkForPaper）
                  const hasNote = !!pdf && !!noteLinkForPaper(`papers/${pdf}`, noteLinks ?? []);
                  return (
                  <li
                    key={row.lineId}
                    data-reading-line={row.lineId}
                    className={`group flex items-start gap-2 py-2 hover:bg-hover/50${
                      readingFlash === row.lineId ? " bg-inset" : ""
                    }`}
                  >
                    <div className="min-w-0 flex-1 px-1">
                      <p className="truncate text-xs leading-snug text-l2" title={row.title}>
                        {row.title}
                      </p>
                      {/* 题录字段缺失时积累账写「待补」占位：不展示占位，全缺就不出这一行 */}
                      {[row.authorsYear, row.source].some((v) => v && v.trim() !== "待补") && (
                        <p className="mt-0.5 truncate text-micro text-l4">
                          {[row.authorsYear, row.source]
                            .filter((v) => v && v.trim() !== "待补")
                            .join(" · ")}
                        </p>
                      )}
                    </div>
                    {pdf ? (
                      <span className="flex shrink-0 items-center gap-1 pr-1">
                        <button
                          type="button"
                          className="shrink-0 rounded-sm px-1.5 py-0.5 text-micro text-ok-text hover:bg-ok-text/10"
                          title={
                            hasNote
                              ? "继续精读：进沉浸阅读（三栏），笔记接着已写的内容补全"
                              : "精读：进沉浸阅读（三栏），先建八段骨架笔记"
                          }
                          aria-label={`${hasNote ? "继续精读" : "精读"}：${row.title}`}
                          onClick={() => void openReaderFor(pdf)}
                        >
                          {hasNote ? "继续精读" : "精读"}
                        </button>
                        <span className="flex items-center gap-0.5">
                          <button
                            type="button"
                            className="shrink-0 rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                            title="打开这篇的精读笔记（notes/）；还没有就先精读建档"
                            aria-label={`笔记：${row.title}`}
                            onClick={() => void openNoteFor(pdf)}
                          >
                            笔记
                          </button>
                          <button
                            type="button"
                            className="shrink-0 rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                            title={`预览全文 papers/${pdf}`}
                            aria-label={`预览全文：${row.title}`}
                            onClick={() => openSavedPdf(pdf)}
                          >
                            全文
                          </button>
                        </span>
                        <button
                          type="button"
                          className="shrink-0 rounded-sm px-1 py-0.5 text-xs text-l4 opacity-0 hover:bg-hover hover:text-l1 focus-visible:opacity-100 group-hover:opacity-100"
                          aria-label={`从积累清单移除：${row.title}`}
                          title="从积累清单移除（只动 papers/reading-list.md，不影响流程正典）"
                          onClick={() => void removeReading(row.lineId)}
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="shrink-0 rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                          title="papers/ 里还没有这篇的全文：选一个已下载的 PDF 关联进来（复制进 papers/ 并登记）"
                          aria-label={`关联本地 PDF：${row.title}`}
                          onClick={() => void attachPdf(row.title)}
                        >
                          关联
                        </button>
                        <button
                          type="button"
                          className="shrink-0 rounded-sm px-1 py-0.5 text-xs text-l4 opacity-0 hover:bg-hover hover:text-l1 focus-visible:opacity-100 group-hover:opacity-100"
                          aria-label={`从积累清单移除：${row.title}`}
                          title="从积累清单移除（只动 papers/reading-list.md，不影响流程正典）"
                          onClick={() => void removeReading(row.lineId)}
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </li>
                  );
                })}
              </ul>
            )}

          </div>
        )}
      </div>
      {unsubscribed.length > 0 && hasSubs && (
        <p className="mb-2 px-1 text-xs text-l4">
          {unsubscribed.map((s) => s.name).join("、")} 还没有关键词，在下面的巡检行点「关键词」添加。
        </p>
      )}
      {subs !== null && !hasSubs && radarSchedules.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
          <span className="text-xs text-warn-text">
            还没有订阅关键词：下面是以前攒下的命中，巡检不会再有新命中。
          </span>
          <button
            type="button"
            className={ghostActionClass}
            onClick={() => setSubsOpen(true)}
          >
            订阅关键词
          </button>
        </div>
      )}

      {error && <InlineNotice tone="err" className="mb-2">{error}</InlineNotice>}

      {/* 无订阅的早返回分支已带 pendingRow，这里恒走内容井（原三元永远取不到左支） */}
      {bodyOpen && (
        <div className={projectWellClass}>
            {entries === null ? (
              <LoadingRows compact />
            ) : (
              <>
                {(trend.showChart ||
                  (!pendingAdoption && trend.note)) && (
                  <TrendChart
                    trend={trend}
                    mode={trendMode}
                    onMode={(m) => {
                      // 切粒度自动复位时间桶筛选（旧粒度的 key 对新粒度无意义）
                      setSelectedBucketKey(null);
                      setTrendMode(m);
                    }}
                    selectedKey={selectedBucketKey}
                    onSelectKey={setSelectedBucketKey}
                    repairDays={
                      trend.showChart
                        ? []
                        : undatedWatchRuns(radarSchedules).map((run) => run.day)
                    }
                    repairing={repairingDates}
                    onRepair={() => void repairWatchDates()}
                    stats={
                      // 计数只说一遍：总篇数在卡头，待采纳批次的「新增 N 篇」由待评审行承担；
                      // 微行只补卡头没有的——最近新增、推荐，以及筛选/选柱后藏掉的总数
                      latestRadarRun && !pendingAdoption ? (
                        <>
                          最近一次巡检新增 {latestRadarRun.newEntries ?? "未知"} 篇
                          {recTotal > 0 && (
                            <span title="收件箱里标「推荐」的篇数（全部命中，不只最近一次）">
                              {" "}· 收件箱里推荐 <span className="text-cta">{recTotal}</span> 篇
                            </span>
                          )}
                          {hiddenTotalNote && <> · {hiddenTotalNote}</>}
                        </>
                      ) : hiddenTotalNote ? (
                        <>{hiddenTotalNote}</>
                      ) : null
                    }
                  />
                )}
                {/* 趋势块不出现（无命中且有待采纳）时的统计兜底行：只在卡头篇数不是总数时补 */}
                {!(trend.showChart || (!pendingAdoption && trend.note)) &&
                  pendingAdoption &&
                  hiddenTotalNote && (
                  <p className="mt-1 px-2 text-micro text-l4">{hiddenTotalNote}</p>
                )}
                {pendingRow}
                {filterOn && metricsStatus && !metricsStatus.available && (
                  /* 表未装时筛选实际不生效（指标未知一律放行）：明说，不让用户以为已生效 */
                  <p className="mt-1 px-2 text-micro text-warn-text">
                    筛选（{litWatchFilterLabel(filter)}）需要期刊指标表，装表后才生效
                  </p>
                )}

                {(searchedHits.length > 0 || qHit || selectedBucketKey != null) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {/* 关键词胶囊（2026-10-16 截图定稿）：竖条+粗体+计数的可点胶囊，与
                    搜索同一行收纳；订阅词全列出（0 命中也显示——用户加的词要看得见），
                    条目额外词（关联推荐）在后；激活态走 bg-seg-sel（筛选不是主操作，禁 CTA 粉填充） */}
                  {searchedHits.length > 0 && (
                    <>
                    <button
                      type="button"
                      className={
                        activeKw == null
                          ? "flex items-center gap-1.5 rounded-full bg-seg-sel px-2 py-1 text-micro text-l1"
                          : "flex items-center gap-1.5 rounded-full bg-hover px-2 py-1 text-micro text-l3 hover:text-l2"
                      }
                      title="看全部命中"
                      onClick={() => setKwFilter(null)}
                    >
                      全部 {searchedHits.length}
                    </button>
                    {kwTabs.map((o) => (
                      <button
                        key={o.key}
                        type="button"
                        className={
                          activeKw === o.key
                            ? "flex items-center gap-1.5 rounded-full bg-seg-sel px-2 py-1 text-micro text-l1"
                            : "flex items-center gap-1.5 rounded-full bg-hover px-2 py-1 text-micro text-l3 hover:text-l2"
                        }
                        title={`只看「${o.label}」命中的文献；再点一下取消`}
                        onClick={() => setKwFilter((c) => (c === o.key ? null : o.key))}
                      >
                        <span className="h-3 w-0.5 rounded-full bg-cta" />
                        <span className="font-semibold">{o.label}</span>
                        <span className="opacity-70">{o.n}</span>
                      </button>
                    ))}
                    </>
                  )}
                  <input
                    type="search"
                    value={hitQuery}
                    onChange={(e) => setHitQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setHitQuery("")}
                    placeholder="搜索"
                    className="ml-auto h-7 w-32 shrink-0 rounded-full border border-field bg-canvas px-3 text-xs text-l2 outline-none transition-colors placeholder:text-l4 focus:border-l3"
                    aria-label="搜索新命中"
                  />
                </div>
                )}
                {searchedHits.length === 0 && (qHit || !pendingAdoption || selectedBucketKey != null) && (
                  <p className="mt-2 text-xs text-l4">
                    {qHit
                      ? "没有匹配"
                      : selectedBucketKey != null
                        ? "这个时间桶里没有可显示的命中（可能被指标筛选或忽略藏起来了）。"
                        : filterOn && undismissed.length > 0
                          ? `筛选隐藏了全部 ${undismissed.length} 篇命中；指标未收录的条目开了筛选不显示，点「不限」看全部`
                          : "暂无新命中"}
                  </p>
                )}
                {entryGroups.map((group) => (
                  <div key={group.key} className="mt-2">
                    {group.prominent ? (
                      /* 关键词组头：强调色竖条 + 粗体 + 条数（对照 Stork 关键词分区头） */
                      <p className="flex items-center gap-1.5 px-2 pt-1 text-sm font-semibold text-l1">
                        <span className="h-3.5 w-0.5 rounded-full bg-cta" />
                        {group.label}
                        <span className="text-xs font-normal text-l4">
                          {group.entries.length}
                        </span>
                      </p>
                    ) : entryGroups.length > 1 ? (
                      /* 只有一组时（常见：全是「更早」）组头不带任何信息，不画 */
                      <p className="px-2 text-micro text-l4">{group.label}</p>
                    ) : null}
                    <ul className="space-y-0.5">
                      {group.entries.map((entry) => (
                        <WatchEntryRow
                          key={entry.id}
                          entry={entry}
                          explain={
                            explainOpen.has(entry.id)
                              ? (explains[entry.id] ?? { status: "loading" as const })
                              : null
                          }
                          onBookmarkClick={() => void bookmarkToggle(entry)}
                          onExplain={() => {
                            const cur = explains[entry.id];
                            if (cur?.status === "loading") {
                              setExplainOpen((c) => new Set(c).add(entry.id));
                              return;
                            }
                            const saved =
                              (cur?.status === "ok" ? cur.text : null) ||
                              entry.explain;
                            if (saved && cur?.status !== "error") {
                              setExplainOpen((c) => new Set(c).add(entry.id));
                              if (cur?.status !== "ok") {
                                setExplains((c) => ({
                                  ...c,
                                  [entry.id]: { status: "ok", text: saved },
                                }));
                              }
                              return;
                            }
                            void explain(entry);
                          }}
                          onCloseExplain={() =>
                            setExplainOpen((cur) => {
                              const next = new Set(cur);
                              next.delete(entry.id);
                              return next;
                            })
                          }
                          onRerun={() => void explain(entry)}
                          onOpenSource={() => openWithSession(entry.url, entry.title)}
                          collecting={
                            !!entry.url.trim() &&
                            !!browserOpenedAt[entry.url.trim()] &&
                            Date.now() - browserOpenedAt[entry.url.trim()] < 95000
                          }
                          onCancelCollect={() => {
                            const key = entry.url.trim();
                            setBrowserOpenedAt((cur) => {
                              const next = { ...cur };
                              delete next[key];
                              return next;
                            });
                            setBrowserSpotlight((cur) => (cur === key ? null : cur));
                            void invoke("inst_browser_cancel", {
                              projectRoot,
                              title: entry.title,
                              doi: entry.url,
                            }).catch(() => {});
                          }}
                          onAttach={() => void attachPdf(entry.title)}
                          onDismiss={() =>
                            setDismissed((cur) => dismissLitEntry(cur, entry.id))
                          }
                          savedPdf={savedPdfBy[entry.id] ?? null}
                          onOpenPdf={() => openSavedPdf(savedPdfBy[entry.id] ?? "")}
                          ledger={ledgerMarkFor(entry.title, includedTitles, readingTitles)}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
                {!qHit && filteredHits.length > LIST_PREVIEW_CAP && (
                  <ListPreviewToggle
                    className="mt-2"
                    open={showAllHits}
                    hidden={filteredHits.length - LIST_PREVIEW_CAP}
                    unit="篇"
                    onToggle={() => setShowAllHits((v) => !v)}
                  />
                )}
                {/* 关键词空态放底部：胶囊行原地保留可切换，说明沉到列表该在的位置（2026-10-16 用户拍板） */}
                {searchedHits.length > 0 && filteredHits.length === 0 && (
                  <p className="mt-2 px-2 text-xs text-l4">
                    这个关键词窗口内还没有命中；点「全部」或换一枚胶囊。
                  </p>
                )}
              </>
            )}
        </div>
      )}

      {subsOpen && subs !== null && (
        <SubscriptionsModal
          projectRoot={projectRoot}
          scheduleId={radarSchedules[0]?.id ?? ""}
          scheduleName={radarSchedules[0]?.name}
          initial={subsBySchedule[radarSchedules[0]?.id ?? ""] ?? []}
          onClose={() => setSubsOpen(false)}
          onSaved={() => {
            setSubsOpen(false);
            void load();
            onSubscriptionsChanged?.();
          }}
        />
      )}

      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-md border border-cta-bd bg-cta px-3 py-2 text-sm text-cta-text transition-all duration-300 ${
            toast.hiding ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100"
          }`}
        >
          <span>✓</span>
          <span>{toast.text}</span>
        </div>
      )}
    </section>
  );
}
