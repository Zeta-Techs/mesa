import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
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
  Clock,
  Download,
  ExternalLink,
  ListFilter,
  Play,
  RefreshCw,
  Rss,
} from "lucide-react";
import { LIT_WATCH_SLOT, resolveSkillSlot, useSkillProvides } from "../skill-slots.ts";
import ContextMenu from "./ContextMenu";
import { Modal } from "./Modal";

// monaco 体积大，与终端页同款懒加载，避免拖慢工作区页首屏
const FilePreviewEditor = lazy(() => import("./FilePreviewEditor"));
import { HoverTip } from "./HoverTip";
import {
  FoldMark,
  LoadingRows,
  SegTabs,
  fieldClass,
  ghostActionClass,
  iconActionClass,
  inlineActionClass,
  projectWellClass,
  searchFieldClass,
} from "./PageFrame";
import { LIST_PREVIEW_CAP } from "../lit-list";
import { instOpenTarget } from "../inst-access";
import { ListPreviewToggle } from "./FolderGroupedList";
import { toFetchPaperRel } from "../step-flow";
import { useAppStore } from "../store";
import { relTime } from "../rel-time";
import { schedulesForProject } from "../schedule-tasks";
import {
  dismissLitEntry,
  filterLitDismissed,
  followupMatchesDismissed,
  paperResourceFor,
  groupEntriesByDay,
  groupEntriesByKeyword,
  includedLineFor,
  loadLitDismissed,
  readLitWatchBodyOpen,
  writeLitWatchBodyOpen,
  entryPassesFilter,
  litWatchFilterActive,
  litWatchFilterLabel,
  journalMetricTone,
  metricsTooltip,
  weeklyTrend,
  undatedWatchRuns,
  normalizeTitle,
  parseWatchExplain,
  watchExplainPrompt,
  watchEntryScanLine,
  sourceDisplayName,
} from "../lit-watch";
import type {
  AddIncludedResultDto,
  DownloadedPaperDto,
  IncludedEntryDto,
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
  SchedulerRunDonePayload,
} from "../types";

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


/** 近 8 周命中迷你趋势（手绘 SVG 柱，不引图表库）；悬停出 HoverTip（禁原生 title） */
function TrendChart({
  trend,
  repairDays,
  repairing,
  onRepair,
}: {
  trend: ReturnType<typeof weeklyTrend>;
  /** 成功巡检漏写批次标记、可以按完成日补上的日期 */
  repairDays: string[];
  repairing: boolean;
  onRepair: () => void;
}) {
  const { buckets, showChart, note } = trend;
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(
    null,
  );
  // 滚动/缩放即关（与 useHoverTip 同口径；SVG 柱子用不了 hook 的 ref 绑定，这里自管定位）
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
  const BAR_W = 12;
  const GAP = 8;
  const H = 40;
  const W = buckets.length * (BAR_W + GAP) - GAP;
  return (
    <div className="mt-1 px-2">
      <p className="mb-1 text-micro text-l3">近 8 周新命中</p>
      {showChart && (
        <svg
          width={W}
          height={H}
          className="block"
          role="img"
          aria-label="近 8 周每周新命中数"
        >
          {buckets.map((b, i) => {
            const h =
              b.count === 0 ? 2 : Math.max(4, Math.round((b.count / max) * (H - 6)));
            return (
              <rect
                key={b.label}
                x={i * (BAR_W + GAP)}
                y={H - h}
                width={BAR_W}
                height={h}
                rx={2}
                fill={
                  b.count > 0 ? "var(--color-cta)" : "var(--color-hairline)"
                }
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTip({
                    x: Math.min(
                      Math.max(r.left + r.width / 2, 150),
                      window.innerWidth - 150,
                    ),
                    y: r.top - 8,
                    text: `${b.count} 篇 · ${b.label}`,
                  });
                }}
                onMouseLeave={() => setTip(null)}
              />
            );
          })}
        </svg>
      )}
      {note && (
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
      )}
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

function RelevancePills({ entry }: { entry: WatchEntryDto }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {entry.relevance === "推荐" ? (
        <span className="rounded-full bg-cta-pill px-1.5 py-px text-micro text-cta-pill-text">
          推荐
        </span>
      ) : (
        <span className="rounded-full border border-field bg-canvas px-1.5 py-px text-micro text-l3">
          {entry.relevance}
        </span>
      )}
      {entry.metrics?.impactFactor && (
        <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("if")}`}>
          IF {entry.metrics.impactFactor}
        </span>
      )}
      {entry.metrics?.casQuartile != null && (
        <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("quartile", entry.metrics.casQuartile)}`}>
          {entry.metrics.casQuartile}区
        </span>
      )}
      {entry.metrics?.top && (
        <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("top")}`}>
          TOP
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
  onAddIncluded,
  onExplain,
  onCloseExplain,
  onRerun,
  onOpenSource,
  onAttach,
  onDismiss,
  included,
  startOpen,
}: {
  entry: WatchEntryDto;
  explain: ExplainState | null;
  onAddIncluded: () => void;
  onExplain: () => void;
  onCloseExplain: () => void;
  onRerun: () => void;
  /** 打开来源页：有机构会话时开进机构登录窗（带会话能过反爬墙），否则系统浏览器 */
  onOpenSource: () => void;
  onAttach: () => void;
  onDismiss: () => void;
  included: boolean;
  startOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(!!startOpen);
  useEffect(() => {
    if (startOpen) setExpanded(true);
  }, [startOpen]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const open = expanded || !!explain;
  const scan = watchEntryScanLine(entry);
  const source = sourceDisplayName((entry.journal ?? entry.source).trim());
  const when = entry.date ? relTime(entry.date) : "";
  const zh = entry.zhSummary.trim();
  const abs = entry.abstractFirst.trim();
  const authors = entry.authors.trim();
  const expandedMeta = [authors, source, when].filter(Boolean).join(" · ");
  return (
    <li className="group rounded-md px-2 py-1.5 hover:bg-hover">
      <button
        type="button"
        className={`block w-full text-left text-sm leading-5 text-l2 ${
          expanded ? "whitespace-normal" : "truncate"
        }`}
        onClick={() => setExpanded((v) => !v)}
        title={entry.title}
      >
        {entry.title}
      </button>
      <div className="mt-0.5 flex min-w-0 items-center gap-2">
        {scan && !expanded ? (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-micro text-l4"
            onClick={() => setExpanded(true)}
          >
            {scan}
          </button>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <RelevancePills entry={entry} />
        {when && !expanded && (
          <span className="shrink-0 text-micro text-l4">{when}</span>
        )}
        <span className="flex shrink-0 items-center">
          <span
            className={`items-center ${
              open ? "flex" : "hidden group-hover:flex group-focus-within:flex"
            }`}
          >
            <button
              type="button"
              className={iconActionClass}
              title={explain ? "收起解读" : "解读"}
              aria-label={explain ? "收起解读" : "解读"}
              onClick={explain ? onCloseExplain : onExplain}
            >
              ◈
            </button>
            {entry.url.trim() && (
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
          </span>
          <button
            type="button"
            className={iconActionClass}
            disabled={included}
            title={included ? "已在精读清单" : "加入精读"}
            aria-label={included ? "已在精读清单" : "加入精读"}
            onClick={onAddIncluded}
          >
            {included ? (
              <Bookmark size={13} strokeWidth={1.8} />
            ) : (
              <BookmarkPlus size={13} strokeWidth={1.8} />
            )}
          </button>
        </span>
      </div>
      {expanded && (zh || abs || expandedMeta) && (
        <div className="mt-1 space-y-1">
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
              label: "打开来源",
              disabled: !entry.url.trim(),
              title: entry.url.trim() ? entry.url : "这条命中没有链接",
              // 与工具栏同一条链（2026-09-17 审计：旧口径直开 URL，绕过收货
              // 登记与机构前缀改写——菜单打开后下载的 PDF 不会被收进 papers/）
              onSelect: onOpenSource,
            },
            {
              label: "关联本地 PDF…",
              title: "已手动下载全文？选中文件，自动复制进 papers/ 并登记",
              onSelect: onAttach,
            },
            { label: "忽略这条", onSelect: onDismiss },
            {
              label: "复制标题",
              onSelect: () =>
                void navigator.clipboard.writeText(entry.title).catch(() => {}),
            },
          ]}
        />
      )}
    </li>
  );
}

/** 订阅弹层（w-[36rem] 富表单档）：表格化编辑 watchlist.md（关键词 + 来源多选 + 备注） */
function SubscriptionsModal({
  projectRoot,
  initial,
  onClose,
  onSaved,
}: {
  projectRoot: string;
  initial: WatchSubscriptionDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<WatchSubscriptionDto[]>(
    initial.length > 0
      ? initial.map((s) => ({ ...s, sources: [...s.sources] }))
      : [{ keyword: "", sources: [], note: "" }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 原地编辑源文件：不跳终端页，弹层内嵌 FilePreviewEditor
  const [sourceOpen, setSourceOpen] = useState(false);
  const SOURCES = ["arxiv", "openalex", "crossref"] as const;

  // 源文件可能被用户手改过：关掉编辑器后重读清单刷新表格（读失败保留当前编辑内容）
  async function reloadRows() {
    try {
      const subs = await invoke<WatchSubscriptionDto[]>(
        "list_watch_subscriptions",
        { projectRoot },
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
      await invoke("save_watch_subscriptions", { projectRoot, subs });
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
        title="追踪关键词"
        onClose={onClose}
        size="lg"
        description="雷达按这些关键词定期检索，新命中进「新命中」列表。"
      >
      <form onSubmit={(e) => void submit(e)}>
        <div className="max-h-72 space-y-2 overflow-auto">
          {rows.map((row, i) => (
            <div key={i} className="flex min-w-0 items-center gap-2">
              <input
                className={`${fieldClass} min-w-0 flex-1`}
                value={row.keyword}
                onChange={(e) => patchRow(i, { keyword: e.target.value })}
                placeholder="关键词，如 mixture-of-experts"
              />
              <span className="flex shrink-0 items-center gap-1">
                {SOURCES.map((src) => {
                  const on = row.sources.includes(src);
                  return (
                    <button
                      key={src}
                      type="button"
                      onClick={() =>
                        patchRow(i, {
                          sources: on
                            ? row.sources.filter((s) => s !== src)
                            : [...row.sources, src],
                        })
                      }
                      className={`flex h-6 items-center rounded-full px-2 text-xs transition-colors ${
                        on ? "bg-seg-sel text-l1" : "bg-inset text-l3 hover:text-l1"
                      }`}
                    >
                      {src}
                    </button>
                  );
                })}
              </span>
              {/* 备注固定 9rem：fieldClass 自带 w-full，须用外层 span 约束，否则挤死关键词列 */}
              <span className="w-36 shrink-0">
                <input
                  className={fieldClass}
                  value={row.note}
                  onChange={(e) => patchRow(i, { note: e.target.value })}
                  placeholder="备注（可选）"
                />
              </span>
              <button
                type="button"
                aria-label="删除该行"
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
        {error && <p className="mt-2 text-sm text-err-text">{error}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            className="mr-auto rounded-sm px-3 py-1.5 text-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
            onClick={() => {
              // 先把已保存的订阅落盘再原地打开——文件不存在时直接预览只会看到「文件不存在」；
              // 刻意写 initial 而非当前编辑中的 rows，保住「取消」的语义
              setBusy(true);
              setError(null);
              invoke("save_watch_subscriptions", {
                projectRoot,
                subs: initial,
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
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
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
              <span className="text-micro text-l4">papers/ · 保存后下次巡检生效</span>
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
                  path={`${projectRoot}/papers/watchlist.md`}
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

/** 筛选弹层：按期刊指标过滤「新命中」与推送计数（存 project.toml 的 litWatchFilter）。
 *  全条件清空 = 不筛选（后端归一为 None）；指标未知的条目放行不误伤 */
function FilterModal({
  projectRoot,
  initial,
  metricsAvailable,
  onClose,
  onSaved,
}: {
  projectRoot: string;
  initial: LitWatchFilterDto | null | undefined;
  metricsAvailable: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [minIf, setMinIf] = useState(
    initial?.minIf != null ? String(initial.minIf) : "",
  );
  const [maxQuartile, setMaxQuartile] = useState<number | null>(
    initial?.maxCasQuartile ?? null,
  );
  const [topOnly, setTopOnly] = useState(!!initial?.topOnly);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const QUARTILES: { v: number | null; label: string }[] = [
    { v: null, label: "不限" },
    { v: 1, label: "仅 1 区" },
    { v: 2, label: "2 区及以上" },
    { v: 3, label: "3 区及以上" },
  ];

  async function save(filter: LitWatchFilterDto | null) {
    setBusy(true);
    setError(null);
    try {
      await invoke("update_lit_watch_filter", { projectRoot, filter });
      onSaved();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = minIf.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      setError("IF 门槛要是非负数字");
      return;
    }
    void save({ minIf: parsed, maxCasQuartile: maxQuartile, topOnly });
  }

  return (
    <Modal
      open
      title="筛选新命中"
      onClose={onClose}
      size="md"
      description="按期刊指标过滤「新命中」列表与定时巡检的推送计数；查不到指标的条目照常显示（不误伤），精读清单不受影响。"
    >
      <form onSubmit={submit}>
        {!metricsAvailable && (
          <p className="mb-3 text-xs text-warn-text">
            期刊指标表还没装：筛选保存后暂不生效，点卡头「↓ 期刊指标表」装表即生效。
          </p>
        )}
        <label className="mb-1 block text-xs text-l2">影响因子 IF 至少</label>
        <input
          className={fieldClass}
          value={minIf}
          onChange={(e) => setMinIf(e.target.value)}
          placeholder="不限，如填 10 表示只看 IF≥10"
          inputMode="decimal"
        />
        <label className="mb-1 mt-3 block text-xs text-l2">中科院大类分区</label>
        <div className="flex items-center gap-1">
          {QUARTILES.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => setMaxQuartile(q.v)}
              className={`flex h-6 items-center rounded-full px-2 text-xs transition-colors ${
                maxQuartile === q.v
                  ? "bg-seg-sel text-l1"
                  : "bg-inset text-l3 hover:text-l1"
              }`}
            >
              {q.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setTopOnly((v) => !v)}
          className="mt-3 flex items-center gap-2 text-xs text-l2 hover:text-l1"
          aria-pressed={topOnly}
        >
          <span
            className={`flex h-4 w-4 items-center justify-center rounded-xs border text-micro ${
              topOnly
                ? "border-cta-bd bg-cta text-cta-text"
                : "border-field bg-inset text-transparent"
            }`}
          >
            ✓
          </span>
          仅中科院 TOP 期刊
        </button>
        {error && <p className="mt-2 text-sm text-err-text">{error}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          {litWatchFilterActive(initial) && (
            <button
              type="button"
              disabled={busy}
              className="mr-auto rounded-sm px-3 py-1.5 text-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
              onClick={() => void save(null)}
            >
              清除筛选
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "保存中…" : "保存筛选"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 科研任务「现在」：定时巡检推来的新文献。默认收起；有新命中头上写篇数。
 * 精读清单在文件页，这里只处理新命中。订阅/筛选/定时入口仍在卡头（定时滚到项目设置）。
 */
export default function LitWatchCard({
  projectRoot,
  cfg,
  onOpenSchedules,
  onConfigChanged,
  focusToken,
  focusEntryId,
  preferCollapsed = false,
}: {
  projectRoot: string;
  cfg: ProjectConfigDto;
  /** 「◔ 定时」：打开项目设置抽屉并滚到定时任务区块 */
  onOpenSchedules: () => void;
  /** 下载 PDF 会登记进 project.toml 资源清单：通知父级重读档案卡 */
  onConfigChanged: () => void;
  /** 收件箱跳转：展开雷达并滚到这一条。 */
  focusToken?: number | null;
  /** 有进行中/待验收目标时默认收起，把「项目现在」让出来。 */
  preferCollapsed?: boolean;
  /** 收件箱点的那一篇：展开这一条 */
  focusEntryId?: string | null;
}) {
  const skillProvides = useSkillProvides();
  const [entries, setEntries] = useState<WatchEntryDto[] | null>(null);
  const [followups, setFollowups] = useState<WatchFollowupDto[]>([]);
  const [subs, setSubs] = useState<WatchSubscriptionDto[] | null>(null);
  const [included, setIncluded] = useState<IncludedEntryDto[] | null>(null);
  const [schedules, setSchedules] = useState<ScheduleDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 「新命中」页签内的分组视图：按日期（默认）/ 按关键词 */
  const [groupBy, setGroupBy] = useState<"day" | "keyword">("day");
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
  /** 筛选弹层；showFilteredOut = 临时查看全部被筛掉的条目 */
  const [filterOpen, setFilterOpen] = useState(false);
  const [showFilteredOut, setShowFilteredOut] = useState(false);
  const [followupsOpen, setFollowupsOpen] = useState(false);
  const [browserOpenedAt, setBrowserOpenedAt] = useState<Record<string, number>>({});
  const [browserSpotlight, setBrowserSpotlight] = useState<string | null>(null);
  const browserSpotlightAway = useRef(false);
  const [running, setRunning] = useState(false);
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
  const setProjectSurfaceReq = useAppStore((s) => s.setProjectSurfaceReq);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const [runMenu, setRunMenu] = useState<{ x: number; y: number } | null>(null);
  const [bodyOpen, setBodyOpen] = useState(() =>
    preferCollapsed ? false : readLitWatchBodyOpen(projectRoot),
  );
  const [hitQuery, setHitQuery] = useState("");
  const [showAllHits, setShowAllHits] = useState(false);
  // 待人工下载对照 papers/：文件名 → 已存。和检索步待获取共用 to_fetch_progress。
  const [followupSaved, setFollowupSaved] = useState<Record<string, string>>({});
  const [followupBusy, setFollowupBusy] = useState<Record<string, string>>({});
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
    if (focusEntryId) setExpandedId(focusEntryId);
  }, [focusToken, focusEntryId, setRadarOpen]);

  async function load() {
    const [inbox, subList, includedList, scheduleList] =
      await Promise.all([
        invoke<WatchInboxDto>("list_watch_entries", { projectRoot }).catch(
          (reason) => {
            setError(String(reason));
            setEntries([]);
            return null;
          },
        ),
        invoke<WatchSubscriptionDto[]>("list_watch_subscriptions", {
          projectRoot,
        }).catch(() => null),
        invoke<IncludedEntryDto[]>("list_included_entries", {
          projectRoot,
        }).catch(() => null),
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
    if (subList) setSubs(subList);
    if (includedList) setIncluded(includedList);
    if (scheduleList)
      setSchedules(schedulesForProject(scheduleList, projectRoot));
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
    listen<SchedulerRunDonePayload>("scheduler-run-done", () => {
      setRunning(false);
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

  /** 最近一次成功 run（卡头时间 / 立即跑 / 漂移提醒共用） */
  // 文献雷达位：自建巡检技能声明 provides: lit-watch 即点亮本卡（名字精确匹配兜底）
  const radarSchedules = (schedules ?? []).filter((s) => resolveSkillSlot(LIT_WATCH_SLOT, [s.skill], skillProvides) !== null);
  const lastOkRun = (s: ScheduleDto) => s.history.find((r) => r.status === "ok");
  const latestRadarRun = radarSchedules
    .map((s) => ({ schedule: s, run: lastOkRun(s) }))
    .filter((x): x is { schedule: ScheduleDto; run: NonNullable<ReturnType<typeof lastOkRun>> } => !!x.run)
    .sort((a, b) => Date.parse(b.run.at) - Date.parse(a.run.at))[0]?.run ?? null;
  /** 隔离树已有新命中、尚未采纳进主仓：待评审提示是列表区的唯一答案（pendingRow），
   *  采纳前列表为空是预期——不再另出空态文案，计数微行也不重复「新增 N 条」 */
  const pendingAdoption =
    latestRadarRun?.isolationPath &&
    !latestRadarRun.adopted &&
    (latestRadarRun.newEntries ?? 0) > 0
      ? latestRadarRun
      : null;
  /** 待采纳提示：正文 + 「去评审」收进内容井列表区（用户视线所在）；无订阅时不渲染
   *  内容井，但入口不能丢——单独出这一行 */
  const pendingRow = pendingAdoption ? (
    <p className="mt-1 mb-2 flex flex-wrap items-center gap-2 px-2 text-xs text-warn-text">
      <span>
        隔离树有 {pendingAdoption.newEntries} 条新命中，尚未采纳进主仓
      </span>
      <button
        type="button"
        className={ghostActionClass}
        onClick={() => {
          setWorkspaceReviewRequest({
            worktreePath: pendingAdoption.isolationPath!,
            runId: pendingAdoption.runId ?? null,
            requestId: crypto.randomUUID(),
          });
          setPage("terminal");
        }}
      >
        去评审
      </button>
    </p>
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

  async function runNow() {
    const s = radarSchedules.find((x) => x.enabled) ?? radarSchedules[0];
    if (!s) return;
    setRunning(true);
    setError(null);
    try {
      await invoke("run_schedule_now", { id: s.id });
      // 成功拉起后结果走 scheduler-run-done 事件（监听里清 running 并重拉）
    } catch (reason) {
      setRunning(false);
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

  /** ◈ 解读：快筛五节；已落盘的直接展开。ai_prompt 不传功能键（走自动回落链）。 */
  async function explain(entry: WatchEntryDto) {
    setExplainOpen((cur) => new Set(cur).add(entry.id));
    setExplains((cur) => ({ ...cur, [entry.id]: { status: "loading" } }));
    const prompt = watchExplainPrompt(entry, cfg.topic);
    try {
      const text = (await invoke<string>("ai_prompt", {
        profileId: null,
        fnKey: null,
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

  async function addToIncluded(entry: WatchEntryDto) {
    try {
      const res = await invoke<AddIncludedResultDto>("add_included_entry", {
        projectRoot,
        ...includedLineFor(entry),
      });
      void invoke<IncludedEntryDto[]>("list_included_entries", { projectRoot })
        .then((rows) => setIncluded(rows))
        .catch(() => {});
      const names = await invoke<(string | null)[]>("to_fetch_progress", {
        projectRoot,
        items: [{ title: entry.title, url: entry.url }],
      }).catch(() => null);
      const saved = names?.[0] ?? null;
      let rel = saved ? toFetchPaperRel(saved) : "";
      if (!rel) {
        const read = await invoke<{
          config: { resources: { path: string; type: string; name: string; readonly: boolean; note: string }[] };
        }>("read_project_config", { path: projectRoot }).catch(() => null);
        rel =
          paperResourceFor(
            { title: entry.title },
            read?.config.resources ?? [],
          ) ?? "";
      }
      if (rel) {
        const root = projectRoot.replace(/[\\/]+$/, "");
        const abs = /^([a-zA-Z]:[\\/]|\/)/.test(rel) ? rel : `${root}/${rel}`;
        setReaderReq({ pdfPath: abs, projectRoot });
        setPage("terminal");
        showToast(res.added ? "已加入精读，正在打开全文" : "已在精读清单，正在打开全文");
        return;
      }
      showToast(
        res.added
          ? "已加入精读清单。全文还没有，先用打开来源或关联 PDF"
          : "已在精读清单。全文还没有，先用打开来源或关联 PDF",
      );
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

  const followupProbeRef = useRef(followups);
  followupProbeRef.current = followups;
  const refreshFollowupSaved = useCallback(() => {
    const items = followupProbeRef.current;
    if (!items.length) {
      setFollowupSaved({});
      return;
    }
    invoke<(string | null)[]>("to_fetch_progress", {
      projectRoot,
      items: items.map((it) => ({ title: it.title, url: it.url })),
    })
      .then((names) => {
        const map: Record<string, string> = {};
        names?.forEach((name, i) => {
          const it = items[i];
          if (name && it) map[`${it.title}-${i}`] = name;
        });
        setFollowupSaved(map);
        setBrowserOpenedAt((cur) => {
          let changed = false;
          const next = { ...cur };
          items.forEach((it, i) => {
            const key = it.url.trim();
            if (map[`${it.title}-${i}`] && key && next[key]) {
              delete next[key];
              changed = true;
            }
          });
          return changed ? next : cur;
        });
      })
      .catch(() => {});
  }, [projectRoot]);
  useEffect(() => {
    if (!followupsOpen) return;
    refreshFollowupSaved();
    const timer = window.setInterval(refreshFollowupSaved, 2000);
    return () => window.clearInterval(timer);
  }, [followupsOpen, followups, refreshFollowupSaved]);

  function openSavedPdf(fileName: string) {
    const rel = toFetchPaperRel(fileName);
    if (!rel) return;
    setProjectSurfaceReq("files");
    setFilePreviewReq({
      projectRoot,
      path: `${projectRoot.replace(/[\\/]+$/, "")}/${rel}`,
      token: Date.now(),
    });
  }

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

  // 雷达筛选（存 project.toml）：只过滤新命中；指标未知的条目放行不误伤
  const filter = cfg.litWatchFilter;
  const filterOn = litWatchFilterActive(filter);
  const undismissed = filterLitDismissed(entries ?? [], dismissed);
  const applyingFilter = filterOn && !showFilteredOut;
  const visibleEntries = applyingFilter
    ? undismissed.filter((e) => entryPassesFilter(e.metrics, filter))
    : undismissed;
  const hiddenByFilter = applyingFilter
    ? undismissed.length - visibleEntries.length
    : 0;
  const qHit = hitQuery.trim().toLowerCase();
  const searchedHits = qHit
    ? visibleEntries.filter(
        (e) =>
          e.title.toLowerCase().includes(qHit) ||
          (e.zhSummary ?? "").toLowerCase().includes(qHit) ||
          e.source.toLowerCase().includes(qHit),
      )
    : visibleEntries;
  const listedHits =
    qHit || showAllHits
      ? searchedHits
      : searchedHits.slice(0, LIST_PREVIEW_CAP);
  const includedTitles = new Set(
    (included ?? []).map((item) => normalizeTitle(item.title)),
  );
  const trend = weeklyTrend(entries ?? []);
  // 「新命中」两种分组视图统一成同构组列表，下方渲染不分支；关键词组头要显眼（prominent）
  const entryGroups: {
    key: string;
    label: string;
    entries: WatchEntryDto[];
    prominent: boolean;
  }[] =
    groupBy === "day"
      ? groupEntriesByDay(listedHits).map((g) => ({ ...g, prominent: false }))
      : groupEntriesByKeyword(listedHits).map((g) => ({
          key: g.keyword,
          label: g.keyword,
          entries: g.entries,
          prominent: true,
        }));
  const hasSubs = (subs ?? []).length > 0;

  if (subs !== null && !hasSubs) {
    return (
      <>
      <div className="mb-4 flex items-center gap-2 px-1">
        <span className="text-xs text-l4">文献雷达 · 还没订阅读</span>
        <button
          type="button"
          className={ghostActionClass}
          onClick={() => setSubsOpen(true)}
        >
          添加
        </button>
      </div>
      {subsOpen && (
        <SubscriptionsModal
          projectRoot={projectRoot}
          initial={subs}
          onClose={() => setSubsOpen(false)}
          onSaved={() => {
            setSubsOpen(false);
            void load();
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
        {bodyOpen && (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {metricsStatus && (
            <HeadIcon
              label={
                metricsDownloading
                  ? "正在下载期刊指标表"
                  : metricsStatus.available
                    ? metricsTooltip(metricsStatus, metricsUpdate, relTime)
                    : "下载期刊指标表"
              }
              disabled={metricsDownloading}
              mark={!!metricsUpdate?.hasUpdate}
              onClick={() => void downloadMetrics()}
            >
              {metricsStatus.available ? (
                <RefreshCw size={13} strokeWidth={1.8} />
              ) : (
                <Download size={13} strokeWidth={1.8} />
              )}
            </HeadIcon>
          )}
          {radarSchedules.length > 0 && (
            <HeadIcon
              label={running ? "运行中…" : "立即跑"}
              disabled={running}
              onClick={(event) => {
                if (radarSchedules.length === 1) void runNow();
                else {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setRunMenu({ x: rect.right, y: rect.bottom + 4 });
                }
              }}
            >
              <Play size={13} strokeWidth={1.8} />
            </HeadIcon>
          )}
          <HeadIcon label="订阅" onClick={() => setSubsOpen(true)}>
            <Rss size={13} strokeWidth={1.8} />
          </HeadIcon>
          <HeadIcon
            label={
              filterOn
                ? `当前筛选：${litWatchFilterLabel(filter)}（点我修改）`
                : "按期刊指标筛选新命中"
            }
            mark={filterOn}
            onClick={() => setFilterOpen(true)}
          >
            <ListFilter size={13} strokeWidth={1.8} />
          </HeadIcon>
          <HeadIcon label="定时巡检" onClick={onOpenSchedules}>
            <Clock size={13} strokeWidth={1.8} />
          </HeadIcon>
        </div>
        )}
      </div>
      {error && <p className="mb-2 text-xs text-err-text">{error}</p>}

      {bodyOpen && (subs !== null && !hasSubs ? pendingRow : (
        <div className={projectWellClass}>
            {entries === null ? (
              <LoadingRows compact />
            ) : (
              <>
                <TrendChart
                  trend={trend}
                  repairDays={
                    trend.showChart
                      ? []
                      : undatedWatchRuns(radarSchedules).map((run) => run.day)
                  }
                  repairing={repairingDates}
                  onRepair={() => void repairWatchDates()}
                />
                {/* 计数只说一遍：待采纳批次的「新增 N 条」由待评审行承担，微行只补未忽略数 */}
                {latestRadarRun && !pendingAdoption && (
                  <p className="mt-1 px-2 text-micro text-l4">
                    最近一次成功巡检新增 {latestRadarRun.newEntries ?? "未知"} 条 · 未忽略 {undismissed.length} 条
                  </p>
                )}
                {pendingAdoption && undismissed.length > 0 && (
                  <p className="mt-1 px-2 text-micro text-l4">
                    未忽略 {undismissed.length} 条
                  </p>
                )}
                {pendingRow}
                {filterOn && metricsStatus && !metricsStatus.available && (
                  /* 表未装时筛选实际不生效（指标未知一律放行）：明说，不让用户以为已生效 */
                  <p className="mt-1 px-2 text-micro text-warn-text">
                    筛选（{litWatchFilterLabel(filter)}）需要期刊指标表，装表后才生效
                  </p>
                )}
                {filterOn && !showFilteredOut && hiddenByFilter > 0 && (
                  <p className="mt-1 px-2 text-micro text-l4">
                    筛选（{litWatchFilterLabel(filter)}）隐藏 {hiddenByFilter} 条 ·{" "}
                    <button
                      type="button"
                      className="underline hover:text-l1"
                      onClick={() => setShowFilteredOut(true)}
                    >
                      查看全部
                    </button>
                  </p>
                )}
                {filterOn && showFilteredOut && (
                  <p className="mt-1 px-2 text-micro text-l4">
                    正在显示全部 {undismissed.length} 条（含不符合筛选的） ·{" "}
                    <button
                      type="button"
                      className="underline hover:text-l1"
                      onClick={() => setShowFilteredOut(false)}
                    >
                      恢复筛选
                    </button>
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {searchedHits.length > 0 && (
                    <SegTabs
                      items={[
                        { id: "day" as const, label: "按日期" },
                        { id: "keyword" as const, label: "按关键词" },
                      ]}
                      value={groupBy}
                      onChange={setGroupBy}
                    />
                  )}
                  <input
                    type="search"
                    value={hitQuery}
                    onChange={(e) => setHitQuery(e.target.value)}
                    placeholder="搜索"
                    className={`${searchFieldClass} ml-auto w-36`}
                    aria-label="搜索新命中"
                  />
                </div>
                {searchedHits.length === 0 && (qHit || !pendingAdoption) && (
                  <p className="mt-2 text-xs text-l4">
                    {qHit ? "没有匹配" : "暂无新命中"}
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
                    ) : (
                      <p className="px-2 text-micro text-l4">{group.label}</p>
                    )}
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
                          onAddIncluded={() => void addToIncluded(entry)}
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
                          onAttach={() => void attachPdf(entry.title)}
                          onDismiss={() =>
                            setDismissed((cur) => dismissLitEntry(cur, entry.id))
                          }
                          included={includedTitles.has(normalizeTitle(entry.title))}
                          startOpen={entry.id === expandedId}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
                {!qHit && searchedHits.length > LIST_PREVIEW_CAP && (
                  <ListPreviewToggle
                    className="mt-2"
                    open={showAllHits}
                    hidden={searchedHits.length - LIST_PREVIEW_CAP}
                    unit="条"
                    onToggle={() => setShowAllHits((v) => !v)}
                  />
                )}
                {followups.some(
                  (f) => !followupMatchesDismissed(f.title, entries ?? [], dismissed),
                ) && (
                  <div className="mt-2">
                    <button
                      type="button"
                      className="flex items-center gap-1 px-2 text-xs text-l3 hover:text-l1"
                      onClick={() => setFollowupsOpen((v) => !v)}
                      aria-expanded={followupsOpen}
                    >
                      <FoldMark open={followupsOpen} />
                      待人工下载（{
                        followups.filter(
                          (f) =>
                            !followupMatchesDismissed(f.title, entries ?? [], dismissed),
                        ).length
                      }）
                    </button>
                    {followupsOpen && (
                      <>
                      <ul className="mt-1 space-y-0.5 px-0.5 py-px">
                        {followups.map((f, i) => {
                          if (followupMatchesDismissed(f.title, entries ?? [], dismissed)) {
                            return null;
                          }
                          const fkey = `${f.title}-${i}`;
                          const savedName = followupSaved[fkey];
                          const waiting =
                            !!f.url.trim() &&
                            !!browserOpenedAt[f.url.trim()] &&
                            Date.now() - browserOpenedAt[f.url.trim()] < 95000;
                          const meta = [f.note, followupBusy[fkey]]
                            .filter(Boolean)
                            .join(" · ");
                          return (
                          <li
                            key={fkey}
                            data-lit-open-url={f.url.trim()}
                            className={`flex min-w-0 flex-wrap items-center gap-1 rounded-md px-1 py-0.5 ${
                              browserSpotlight === f.url.trim()
                                ? "bg-cta/10 ring-1 ring-inset ring-cta-bd"
                                : "hover:bg-hover"
                            }`}
                          >
                            <button
                              type="button"
                              className={`min-w-0 flex-1 truncate text-left text-xs ${
                                savedName
                                  ? "text-l4 line-through hover:text-l2"
                                  : "text-l2 hover:text-l1"
                              }`}
                              title={
                                savedName
                                  ? `在文件页打开 papers/${savedName}`
                                  : f.url
                                    ? "用右侧「官网」打开这篇的出版商页面"
                                    : f.title
                              }
                              onClick={() => {
                                if (savedName) openSavedPdf(savedName);
                              }}
                            >
                              {f.title}
                            </button>
                            {meta && (
                              <span className="max-w-[14rem] shrink-0 truncate text-micro text-l4" title={meta}>
                                {meta}
                              </span>
                            )}
                            {savedName ? (
                              <span
                                className="shrink-0 text-micro text-done"
                                title={`点标题打开 papers/${savedName}`}
                              >
                                ✓ 已存
                              </span>
                            ) : (
                              <span className="flex shrink-0 items-center">
                                {f.url.trim() && (
                                  <button
                                    type="button"
                                    className={`${inlineActionClass} shrink-0`}
                                    title="去出版商官网打开这篇；点站方下载，90 秒内落下的 PDF 会收进 papers/。没收到用「关联」"
                                    onClick={() => openWithSession(f.url, f.title)}
                                  >
                                    {waiting ? "等待收货…" : "官网"}
                                  </button>
                                )}
                                {waiting && (
                                  <button
                                    type="button"
                                    className={`${ghostActionClass} shrink-0`}
                                    title="这篇不下载了。收货等待取消，之后的 PDF 不会挂到这一行。"
                                    onClick={() => {
                                      setBrowserOpenedAt((cur) => {
                                        const next = { ...cur };
                                        delete next[f.url.trim()];
                                        return next;
                                      });
                                      setBrowserSpotlight((cur) =>
                                        cur === f.url.trim() ? null : cur,
                                      );
                                      void invoke("inst_browser_cancel", {
                                        projectRoot,
                                        title: f.title,
                                        doi: f.url,
                                      }).catch(() => {});
                                    }}
                                  >
                                    取消
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className={`${ghostActionClass} shrink-0`}
                                  disabled={followupBusy[fkey] === "关联中…"}
                                  title="选一个已下载的 PDF，按本行标题复制进 papers/（文件名随意）"
                                  onClick={() => {
                                    setFollowupBusy((cur) => ({ ...cur, [fkey]: "关联中…" }));
                                    void attachPdf(f.title).finally(() => {
                                      setFollowupBusy((cur) => {
                                        const next = { ...cur };
                                        delete next[fkey];
                                        return next;
                                      });
                                      refreshFollowupSaved();
                                    });
                                  }}
                                >
                                  {followupBusy[fkey] === "关联中…" ? "关联中…" : "关联"}
                                </button>
                              </span>
                            )}
                          </li>
                          );
                        })}
                      </ul>
                      <div className="mt-1 flex min-w-0 items-center gap-2 px-1">
                        <button
                          type="button"
                          className={`${ghostActionClass} shrink-0`}
                          title="打开课题的 papers/。PDF 在这里，拖进 Zotero 或 EndNote"
                          onClick={() => {
                            void invoke("zotero_open_papers", { projectRoot }).catch((reason) =>
                              setError(String(reason)),
                            );
                          }}
                        >
                          打开 papers/
                        </button>
                      </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
        </div>
      ))}

      {subsOpen && subs !== null && (
        <SubscriptionsModal
          projectRoot={projectRoot}
          initial={subs}
          onClose={() => setSubsOpen(false)}
          onSaved={() => {
            setSubsOpen(false);
            void load();
          }}
        />
      )}
      {filterOpen && (
        <FilterModal
          projectRoot={projectRoot}
          initial={filter}
          metricsAvailable={metricsStatus?.available ?? false}
          onClose={() => setFilterOpen(false)}
          onSaved={() => {
            // 保存后重读档案卡（cfg.litWatchFilter 随 prop 更新），并退出「查看全部」临时态
            setFilterOpen(false);
            setShowFilteredOut(false);
            onConfigChanged();
          }}
        />
      )}
      {runMenu && (
        <ContextMenu
          x={runMenu.x}
          y={runMenu.y}
          alignRight
          onClose={() => setRunMenu(null)}
          items={radarSchedules.map((s) => ({
            label: `${s.name} · ${s.frequency === "weekly" ? "每周" : "每天"}`,
            title: "立即运行这条文献雷达任务",
            onSelect: () => {
              setRunMenu(null);
              setRunning(true);
              setError(null);
              void invoke("run_schedule_now", { id: s.id }).catch((reason) => {
                setRunning(false);
                setError(String(reason));
              });
            },
          }))}
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
