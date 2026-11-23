import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Maximize2, Pencil, RotateCcw, Search, X } from "lucide-react";
import { readResearchFile } from "../research-report-load";
import { researchAbsolutePath } from "../research-report";
import { IS_MAC } from "../hotkeys";
import {
  applyReportVerdict,
  applyVerifyVerdict,
  clearReviewVerdict,
  countReviewVerdicts,
  decisionCandidatePaths,
  inlineDecisionLine,
  itemSuggestion,
  parseReviewItems,
  REVIEW_SEVERITY_LABEL,
  reviewItemDisplayBody,
  reviewItemMatchesQuery,
  reviewItemSourceTag,
  tokenizeDecisionSummary,
  type ReviewItem,
  type ReviewItemKind,
  type ReviewSeverity,
  type ReviewVerdict,
} from "../review-decisions";
import type { ProjectFilePaneFile } from "../project-file-pane";
import { InlineNotice } from "./PageFrame";
import { usePolling } from "../polling";

export interface ReviewDecisionOpenFileReq {
  path: string;
  root: string;
  name: string;
  rel: string;
  line?: number;
  showList?: boolean;
  list: ProjectFilePaneFile[];
}

export interface ReviewDecisionMeta {
  total: number;
  open: number;
  decided: number;
  accepted: number;
  modified: number;
  rejected: number;
  missing: boolean;
  fileList: ProjectFilePaneFile[];
  fileRoot: string;
}

interface ResolvedDecisionFile {
  path: string;
  root: string;
  name: string;
  rel: string;
}

async function resolveExistingInRoots(
  roots: string[],
  candidates: string[],
): Promise<Map<string, { abs: string; root: string }>> {
  const hit = new Map<string, { abs: string; root: string }>();
  let remaining = candidates;
  for (const root of roots) {
    if (remaining.length === 0) break;
    try {
      const found = await invoke<Array<{ path: string; abs: string }>>("existing_files", {
        cwd: root,
        paths: remaining,
      });
      for (const entry of found) {
        if (!hit.has(entry.path)) hit.set(entry.path, { abs: entry.abs, root });
      }
      remaining = remaining.filter((c) => !hit.has(c));
    } catch {
      /* 测试桩或根目录暂不可读时跳过，不阻塞清单渲染 */
    }
  }
  return hit;
}

async function readFirst(roots: string[], rel: string) {
  for (const root of roots) {
    try {
      const file = await readResearchFile(root, rel);
      if (!file.truncated) return { root, file };
    } catch {
      /* 试下一处 */
    }
  }
  return null;
}

type StatusTab = "open" | "decided" | "all";
const SEVERITY_ORDER: ReviewSeverity[] = ["severe", "general", "suggestion"];

function severityPillClass(severity: ReviewSeverity): string {
  if (severity === "severe") return "bg-err text-err-text";
  if (severity === "general") return "bg-warn text-warn-text";
  return "bg-raised text-l3";
}

function verdictPillClass(verdict: ReviewVerdict): string {
  if (verdict === "接受") return "bg-ok text-ok-text";
  if (verdict === "修改") return "bg-cta-pill text-cta-pill-text";
  return "bg-inset text-l3";
}

function verdictLabel(verdict: ReviewVerdict): string {
  if (verdict === "接受") return "已接受";
  if (verdict === "修改") return "已修改";
  return "已拒绝";
}

interface ReviewDecisionCacheEntry {
  items: ReviewItem[];
  missing: boolean;
  fileRoot: string;
  text: string;
  revision: string | null;
  resolvedByRaw: Map<string, ResolvedDecisionFile>;
  fileList: ProjectFilePaneFile[];
}

/** 切步骤时 StepFlow 按 key 重挂，保留已读过的裁决条目与对照文件解析结果，避免先闪「加载条目…」再撑开。 */
const reviewDecisionCache = new Map<string, ReviewDecisionCacheEntry>();

export default function ReviewDecisionList({
  worktreePath,
  projectRoot,
  target,
  kind,
  fill = false,
  readOnlyView = false,
  hideFileActions = false,
  hideContinueAction = false,
  onAllDecided,
  onOpenCount,
  onMeta,
  onOpenFile,
  onOpenFileInWindow,
  onEnlarge,
  refreshKey,
}: {
  worktreePath?: string | null;
  projectRoot: string;
  target: string;
  kind: ReviewItemKind;
  /** 大窗弹层里占满剩余高度，不截成小框。 */
  fill?: boolean;
  /** 已勾完事项的回看模式：默认看全部、只读不改文件。 */
  readOnlyView?: boolean;
  /** 宿主（如大窗顶栏）已经摆了「对照原稿 / 新窗口打开」时，不在清单工具条重复摆第二套。 */
  hideFileActions?: boolean;
  /** 宿主（如大窗页脚）已经摆了「让 Agent 按决定继续」主按钮时，不在清单工具条重复摆。 */
  hideContinueAction?: boolean;
  /** 每条都已决定后，人再点「让 Agent 按决定继续」。 */
  onAllDecided?: () => void;
  /** 还没决定的条数。0 表示可以勾上这一行。 */
  onOpenCount?: (count: number) => void;
  /** 同步条目计数与关联文件给宿主（行头进度、大窗分栏与页脚）。 */
  onMeta?: (meta: ReviewDecisionMeta) => void;
  /** 打开对照文件（行内走项目右侧抽屉，大窗内走右栏分屏预览）。 */
  onOpenFile?: (req: ReviewDecisionOpenFileReq) => void;
  /** 在独立系统窗口打开对照文件（笔记本窄屏或双屏并排看意见）。 */
  onOpenFileInWindow?: (req: ReviewDecisionOpenFileReq) => void;
  /** 在行内显示「放大」按钮，点击打开大窗工作台。 */
  onEnlarge?: () => void;
  /** 变了就重读文件（步骤的运行状态 / Agent 注意力 / 大窗同步）。 */
  refreshKey?: string;
}) {
  const roots = [...new Set([worktreePath, projectRoot].filter((p): p is string => Boolean(p)))];
  const rel = target.trim();
  const cacheKey = `${roots.join("\n")}\n${rel}\n${kind}`;
  const cached = reviewDecisionCache.get(cacheKey);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(() => cached?.missing ?? false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [items, setItems] = useState<ReviewItem[] | null>(() => cached?.items ?? null);
  const [fileRoot, setFileRoot] = useState(() => cached?.fileRoot ?? projectRoot);
  const [text, setText] = useState(() => cached?.text ?? "");
  const [revision, setRevision] = useState<string | null>(() => cached?.revision ?? null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [revisingIds, setRevisingIds] = useState<Set<string>>(() => new Set());
  /** 本次打开期间刚拍过板的条目：在「待处理」标签下原地留位压暗并给撤销/改判，防止列表上蹿误点。 */
  const [settledIds, setSettledIds] = useState<Set<string>>(() => new Set());
  const [tab, setTab] = useState<StatusTab>(() =>
    readOnlyView || (cached && cached.items.length > 0 && cached.items.every((item) => item.verdict != null))
      ? "all"
      : "open",
  );
  const [query, setQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<"all" | ReviewSeverity>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [acceptingBatch, setAcceptingBatch] = useState(false);
  const [resolvedByRaw, setResolvedByRaw] = useState<Map<string, ResolvedDecisionFile>>(
    () => new Map(cached?.resolvedByRaw ?? []),
  );
  const [fileList, setFileList] = useState<ProjectFilePaneFile[]>(() => cached?.fileList ?? []);
  const onOpenCountRef = useRef(onOpenCount);
  onOpenCountRef.current = onOpenCount;
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;

  async function refreshResolvedFiles(parsed: ReviewItem[], currentRoot: string): Promise<ProjectFilePaneFile[]> {
    const cleanTarget = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    const { orderedRaws, candidatesByRaw } = decisionCandidatePaths(parsed, kind, cleanTarget);
    const allCandidates = [...new Set([...candidatesByRaw.values()].flat())];
    const searchRoots = [...new Set([currentRoot, ...roots])];
    const existing = allCandidates.length > 0 ? await resolveExistingInRoots(searchRoots, allCandidates) : new Map();
    if (cleanTarget && !existing.has(cleanTarget)) {
      existing.set(cleanTarget, { abs: researchAbsolutePath(currentRoot, cleanTarget), root: currentRoot });
    }
    const nextByRaw = new Map<string, ResolvedDecisionFile>();
    const nextList: ProjectFilePaneFile[] = [];
    const seenAbs = new Set<string>();
    for (const raw of orderedRaws) {
      const candidates = candidatesByRaw.get(raw) ?? [raw];
      for (const candidate of candidates) {
        const hit = existing.get(candidate);
        if (!hit) continue;
        const name = candidate.split("/").pop() ?? candidate;
        const resolved: ResolvedDecisionFile = {
          path: hit.abs,
          root: hit.root,
          name,
          rel: candidate,
        };
        nextByRaw.set(raw, resolved);
        const dedupKey = hit.abs.replace(/\\/g, "/");
        if (!seenAbs.has(dedupKey)) {
          seenAbs.add(dedupKey);
          nextList.push({ path: hit.abs, root: hit.root, name, rel: candidate });
        }
        break;
      }
    }
    setResolvedByRaw(nextByRaw);
    setFileList(nextList);
    return nextList;
  }

  async function load() {
    setError(null);
    setSettledIds(new Set());
    setRevisingIds(new Set());
    setEditingId(null);
    if (!rel) {
      setItems([]);
      setMissing(false);
      onOpenCountRef.current?.(1);
      setError("这一条没有落点文件。");
      return;
    }
    const found = await readFirst(roots, rel);
    if (!found) {
      // 还没写出来不等于没有条目：不放行勾选（2026-10-24 HER 润色：第一轮后就挂上这一行，
      // 读不到清单显示「没有待核实，勾上跳过」，第二轮写出 9 条后也没再读）
      setItems([]);
      setMissing(true);
      setFileList([]);
      onOpenCountRef.current?.(1);
      return;
    }
    setMissing(false);
    setFileRoot(found.root);
    setText(found.file.text);
    setRevision(found.file.revision);
    const parsed = parseReviewItems(found.file.text, kind);
    setItems(parsed);
    const openN = parsed.filter((item) => item.verdict == null).length;
    onOpenCountRef.current?.(openN);
    if (readOnlyView || (parsed.length > 0 && openN === 0)) {
      setTab("all");
    }
    void refreshResolvedFiles(parsed, found.root);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreePath, projectRoot, rel, kind, refreshKey, readOnlyView]);

  useEffect(() => {
    if (items == null) return;
    reviewDecisionCache.set(cacheKey, {
      items,
      missing,
      fileRoot,
      text,
      revision,
      resolvedByRaw,
      fileList,
    });
  }, [cacheKey, items, missing, fileRoot, text, revision, resolvedByRaw, fileList]);

  // 文件还没写出来时隔几秒再看一眼，写出来就停
  usePolling(() => load(), missing ? 5000 : null);

  const counts = useMemo(() => countReviewVerdicts(items ?? []), [items]);

  useEffect(() => {
    if (items == null) return;
    onMetaRef.current?.({
      ...counts,
      open: missing ? 1 : counts.open,
      missing,
      fileList,
      fileRoot,
    });
  }, [items, counts, missing, fileList, fileRoot]);

  const severityCounts = useMemo(() => {
    const map: Record<ReviewSeverity, number> = { severe: 0, general: 0, suggestion: 0 };
    for (const item of items ?? []) {
      if (item.section) map[item.section] += 1;
    }
    return map;
  }, [items]);

  const activeSeverities = useMemo(
    () => SEVERITY_ORDER.filter((sev) => severityCounts[sev] > 0),
    [severityCounts],
  );

  const sourceCounts = useMemo(() => {
    if (kind !== "verify") return [] as Array<{ tag: string; count: number }>;
    const map = new Map<string, number>();
    for (const item of items ?? []) {
      const tag = reviewItemSourceTag(item, kind);
      if (!tag) continue;
      map.set(tag, (map.get(tag) ?? 0) + 1);
    }
    return [...map.entries()].map(([tag, count]) => ({ tag, count }));
  }, [items, kind]);

  async function persist(nextText: string, settledAdd: string[] = [], settledRemove: string[] = []) {
    if (!revision) return false;
    const nextRevision = await invoke<string>("save_file_preview", {
      path: researchAbsolutePath(fileRoot, rel),
      root: fileRoot,
      text: nextText,
      expectedRevision: revision,
    });
    setText(nextText);
    setRevision(nextRevision);
    const parsed = parseReviewItems(nextText, kind);
    setItems(parsed);
    const openN = parsed.filter((item) => item.verdict == null).length;
    onOpenCountRef.current?.(openN);
    if (settledAdd.length > 0 || settledRemove.length > 0) {
      setSettledIds((prev) => {
        const next = new Set(prev);
        for (const id of settledAdd) next.add(id);
        for (const id of settledRemove) next.delete(id);
        return next;
      });
    }
    return true;
  }

  async function choose(item: ReviewItem, verdict: ReviewVerdict, explicitNote?: string) {
    if (!revision) return;
    const note =
      verdict === "修改"
        ? (explicitNote ?? drafts[item.id] ?? item.note).trim()
        : "";
    if (verdict === "修改" && !note) {
      setError(`${item.id} 选了修改，先写一句要改成什么样。`);
      return;
    }
    setBusyId(item.id);
    setError(null);
    try {
      const next =
        kind === "verify"
          ? applyVerifyVerdict(text, item.id, verdict, note)
          : applyReportVerdict(text, item.id, verdict, note);
      await persist(next, [item.id], []);
      if (verdict === "修改") {
        setDrafts((prev) => ({ ...prev, [item.id]: note }));
      }
      setEditingId((cur) => (cur === item.id ? null : cur));
      setRevisingIds((prev) => {
        if (!prev.has(item.id)) return prev;
        const copy = new Set(prev);
        copy.delete(item.id);
        return copy;
      });
    } catch (reason) {
      // AI 还在写这份清单时点了决定：版本对不上就重读，不卡在「请重新打开清单」（2026-11-05 排查）
      if (String(reason).includes("已被 Agent 或其他程序修改")) {
        await load();
        setError("清单刚被 AI 改过，已重新读取，请再点一次。");
      } else {
        setError(String(reason));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function undo(item: ReviewItem) {
    if (!revision) return;
    setBusyId(item.id);
    setError(null);
    try {
      const next = clearReviewVerdict(text, item.id, kind);
      await persist(next, [], [item.id]);
      setEditingId((cur) => (cur === item.id ? null : cur));
      setRevisingIds((prev) => {
        if (!prev.has(item.id)) return prev;
        const copy = new Set(prev);
        copy.delete(item.id);
        return copy;
      });
    } catch (reason) {
      if (String(reason).includes("已被 Agent 或其他程序修改")) {
        await load();
        setError("清单刚被 AI 改过，已重新读取，请再点一次。");
      } else {
        setError(String(reason));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function acceptBatch(targets: ReviewItem[]) {
    if (!revision || !items || targets.length === 0) return;
    setAcceptingBatch(true);
    setError(null);
    try {
      let next = text;
      for (const item of targets) {
        next =
          kind === "verify"
            ? applyVerifyVerdict(next, item.id, "接受")
            : applyReportVerdict(next, item.id, "接受");
      }
      await persist(
        next,
        targets.map((item) => item.id),
        [],
      );
      setEditingId(null);
      setRevisingIds(new Set());
    } catch (reason) {
      if (String(reason).includes("已被 Agent 或其他程序修改")) {
        await load();
        setError("清单刚被 AI 改过，已重新读取，请再点一次。");
      } else {
        setError(String(reason));
      }
    } finally {
      setAcceptingBatch(false);
    }
  }

  function openNoteEditor(item: ReviewItem) {
    const suggestion = itemSuggestion(item, kind);
    setError(null);
    setDrafts((prev) => {
      if (prev[item.id] != null && prev[item.id] !== "") return prev;
      const seed = item.note || suggestion;
      return seed ? { ...prev, [item.id]: seed } : prev;
    });
    setEditingId(item.id);
  }

  function renderTokens(source: string) {
    const tokens = tokenizeDecisionSummary(source);
    return tokens.map((tok, tIdx) => {
      if (tok.kind === "text") return <span key={tIdx}>{tok.text}</span>;
      if (tok.kind === "code") {
        return (
          <code key={tIdx} className="rounded-sm bg-inset px-1 font-mono text-micro text-l2">
            {tok.text}
          </code>
        );
      }
      const normRaw = tok.path.replace(/\\/g, "/").replace(/^\.\//, "");
      const resolved = onOpenFile ? resolvedByRaw.get(normRaw) : undefined;
      if (!onOpenFile || !resolved) {
        return tok.code ? (
          <code key={tIdx} className="rounded-sm bg-inset px-1 font-mono text-micro text-l2">
            {tok.raw}
          </code>
        ) : (
          <span key={tIdx}>{tok.raw}</span>
        );
      }
      return (
        <span key={tIdx}>
          {tok.jumps.map((jump, jIdx) => (
            <span key={`${tIdx}-${jIdx}`}>
              {jump.sep}
              <button
                type="button"
                onClick={() =>
                  onOpenFile({
                    path: resolved.path,
                    root: resolved.root,
                    name: resolved.name,
                    rel: resolved.rel,
                    line: jump.line,
                    list: fileList,
                  })
                }
                title={
                  jump.line
                    ? `定位到 ${resolved.rel}（第 ${jump.line} 行）`
                    : `打开 ${resolved.rel}`
                }
                className="rounded-sm bg-inset px-1 font-mono text-micro text-cta underline decoration-dotted underline-offset-2 hover:opacity-80"
              >
                {jump.label}
              </button>
            </span>
          ))}
        </span>
      );
    });
  }

  if (items == null) return <p className="text-micro text-l4">加载条目…</p>;
  if (items.length === 0) {
    return (
      <p className="text-micro text-l4">
        {error ?? inlineDecisionLine(kind, missing ? "missing" : "empty")}
      </p>
    );
  }

  const busy = acceptingBatch || busyId != null;
  const filtering =
    query.trim().length > 0 || severityFilter !== "all" || sourceFilter !== "all";

  const matchesFacet = (item: ReviewItem) => {
    if (severityFilter !== "all" && item.section !== severityFilter) return false;
    if (sourceFilter !== "all" && reviewItemSourceTag(item, kind) !== sourceFilter) return false;
    return reviewItemMatchesQuery(item, kind, query);
  };

  const facetItems = items.filter(matchesFacet);
  const filteredOpen = facetItems.filter((item) => item.verdict == null);
  const visibleItems = facetItems.filter((item) => {
    if (tab === "all") return true;
    if (tab === "decided") return item.verdict != null;
    // 「待处理」下让本次刚点过的条目原地留位，防止下面的条目瞬间顶上来造成误点
    return item.verdict == null || settledIds.has(item.id);
  });

  const pct = counts.total > 0 ? Math.min(100, Math.round((counts.decided / counts.total) * 100)) : 0;
  const modKeyLabel = IS_MAC ? "⌘↵" : "Ctrl+↵";
  const showSeverityRow = kind === "report" && activeSeverities.length > 0;
  const showSourceRow = kind === "verify" && sourceCounts.length > 1;
  const showBatchAccept = kind !== "verify" && !readOnlyView && filteredOpen.length > 0;

  return (
    <div className={fill ? "flex min-h-0 flex-1 flex-col" : "mt-1.5 rounded-lg bg-canvas/45 px-2.5 py-2"}>
      {/* 顶部固定工具栏（物理在滚动区外，杜绝吸顶透字） */}
      <div className="mb-2 shrink-0 space-y-1.5 border-b border-hairline pb-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-micro text-l3">
          <span className="shrink-0 tabular-nums">
            已决 {counts.decided} / {counts.total}
          </span>
          <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-inset" aria-hidden="true">
            <div className="h-full rounded-full bg-done transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <div
            role="tablist"
            aria-label="按决定状态切换"
            className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-inset/75 p-0.5"
          >
            {(
              [
                ["open", `待处理 ${counts.open}`],
                ["decided", `已决定 ${counts.decided}`],
                ["all", `全部 ${counts.total}`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => {
                  setTab(id);
                  setSettledIds(new Set());
                }}
                className={`rounded-sm px-1.5 py-0.5 text-micro transition-colors ${
                  tab === id
                    ? "bg-seg-sel font-medium text-l1"
                    : "text-l3 hover:text-l1"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="ccode-search-shell ml-auto flex h-7 min-w-[9rem] max-w-[15rem] flex-1 items-center gap-1.5 rounded-md border border-field bg-inset/60 px-2 transition-colors focus-within:border-l3">
            <Search size={12} strokeWidth={1.8} className="shrink-0 text-l4" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜编号 / 内容 / 文件 / 引文…"
              aria-label="搜索条目"
              className="min-w-0 flex-1 bg-transparent text-micro text-l1 outline-none placeholder:text-l4 focus:outline-none focus-visible:outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => setQuery("")}
                className="shrink-0 text-l4 hover:text-l1"
              >
                <X size={11} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!hideFileActions && onOpenFile && fileList.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const primary = fileList[0]!;
                  onOpenFile({
                    path: primary.path,
                    root: primary.root ?? fileRoot,
                    name: primary.name,
                    rel: primary.rel ?? primary.name,
                    showList: true,
                    list: fileList,
                  });
                }}
                title="在右侧文件栏列出本批意见涉及的全部文件，边对照原稿边逐条决定"
                className="rounded-sm border border-field bg-strip px-1.5 py-0.5 text-micro text-l2 transition-colors hover:bg-hover hover:text-l1"
              >
                {fileList.length > 1 ? `对照文件（${fileList.length}）` : "对照文件"}
              </button>
            )}
            {!hideFileActions && onOpenFileInWindow && fileList.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const primary = fileList[0]!;
                  onOpenFileInWindow({
                    path: primary.path,
                    root: primary.root ?? fileRoot,
                    name: primary.name,
                    rel: primary.rel ?? primary.name,
                    showList: true,
                    list: fileList,
                  });
                }}
                title="拆成独立新窗口打开对照文件：主窗口保留全宽看意见，点意见里的行号会在新窗口同步定位"
                className="rounded-sm border border-field bg-strip px-1.5 py-0.5 text-micro text-l2 transition-colors hover:bg-hover hover:text-l1"
              >
                新窗口打开
              </button>
            )}
            {!fill && onEnlarge && (
              <button
                type="button"
                onClick={onEnlarge}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-l3 transition-colors hover:bg-hover hover:text-l1"
                title="在大窗口里展开完整清单并支持左右分栏对照原稿"
              >
                <Maximize2 size={11} strokeWidth={1.8} aria-hidden="true" />
                <span>放大</span>
              </button>
            )}
          </div>
        </div>

        {(showSeverityRow || showSourceRow || showBatchAccept || filtering) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {showSeverityRow && (
              <>
                {activeSeverities.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setSeverityFilter("all")}
                    className={`rounded-full border px-2 py-0.5 text-micro transition-colors ${
                      severityFilter === "all"
                        ? "border-cta-bd bg-cta-pill font-medium text-cta-pill-text"
                        : "border-hairline bg-inset/60 text-l3 hover:border-field hover:text-l1"
                    }`}
                  >
                    全部级别
                  </button>
                )}
                {activeSeverities.map((sev) => {
                  const active = severityFilter === sev;
                  return (
                    <button
                      key={sev}
                      type="button"
                      onClick={() => setSeverityFilter(active ? "all" : sev)}
                      className={`rounded-full border px-2 py-0.5 text-micro transition-colors ${
                        active
                          ? "border-cta-bd bg-cta-pill font-medium text-cta-pill-text"
                          : "border-hairline bg-inset/60 text-l3 hover:border-field hover:text-l1"
                      }`}
                    >
                      {REVIEW_SEVERITY_LABEL[sev]} {severityCounts[sev]}
                    </button>
                  );
                })}
              </>
            )}
            {showSourceRow && (
              <>
                <button
                  type="button"
                  onClick={() => setSourceFilter("all")}
                  className={`rounded-full border px-2 py-0.5 text-micro transition-colors ${
                    sourceFilter === "all"
                      ? "border-cta-bd bg-cta-pill font-medium text-cta-pill-text"
                      : "border-hairline bg-inset/60 text-l3 hover:border-field hover:text-l1"
                  }`}
                >
                  全部来源
                </button>
                {sourceCounts.map(({ tag, count }) => {
                  const active = sourceFilter === tag;
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setSourceFilter(active ? "all" : tag)}
                      className={`rounded-full border px-2 py-0.5 font-mono text-micro transition-colors ${
                        active
                          ? "border-cta-bd bg-cta-pill font-medium text-cta-pill-text"
                          : "border-hairline bg-inset/60 text-l3 hover:border-field hover:text-l1"
                      }`}
                    >
                      {tag} {count}
                    </button>
                  );
                })}
              </>
            )}
            {filtering && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setSeverityFilter("all");
                  setSourceFilter("all");
                }}
                className="text-micro text-l4 underline decoration-dotted underline-offset-2 hover:text-l1"
              >
                重置筛选
              </button>
            )}
            {/* 待核实的「接受」= 人对过原文、AI 去掉标记：绝不提供一键全部接受（2026-10-24） */}
            {showBatchAccept && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void acceptBatch(filteredOpen)}
                title={
                  filteredOpen.length === counts.open
                    ? `把其余 ${counts.open} 条未决定条目全部标记为接受`
                    : `只把当前筛选结果里的 ${filteredOpen.length} 条未决定条目标记为接受`
                }
                className="ml-auto shrink-0 rounded-sm border border-field bg-strip px-2 py-0.5 text-micro text-l2 transition-colors hover:border-cta-bd hover:bg-cta-pill hover:text-cta-pill-text disabled:opacity-50"
              >
                {acceptingBatch
                  ? "接受中…"
                  : filteredOpen.length === counts.open
                    ? "全部接受"
                    : `接受当前筛选 ${filteredOpen.length} 条`}
              </button>
            )}
          </div>
        )}

        {counts.open === 0 ? (
          <div
            className={`flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 text-micro ${
              readOnlyView
                ? "bg-inset/50 text-l3"
                : "border border-cta-bd/35 bg-cta-pill/40 text-l1"
            }`}
          >
            <span>
              {readOnlyView
                ? `已完成（接受 ${counts.accepted} · 修改 ${counts.modified} · 拒绝 ${counts.rejected}）；如需改判，请先取消本项勾选。`
                : `全部 ${counts.total} 条已决定（接受 ${counts.accepted} · 修改 ${counts.modified} · 拒绝 ${counts.rejected}），可在下方复核或撤销。`}
            </span>
            {!readOnlyView && !hideContinueAction && onAllDecided && (
              <button
                type="button"
                onClick={() => onAllDecided()}
                className="shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-micro font-medium text-cta-text transition-[filter] hover:brightness-110"
              >
                让 Agent 按决定继续
              </button>
            )}
          </div>
        ) : (
          <p className="text-micro leading-5 text-l4">{inlineDecisionLine(kind, "open")}</p>
        )}

        {error && (
          <InlineNotice tone="err" size="micro" onDismiss={() => setError(null)}>
            {error}
          </InlineNotice>
        )}
      </div>

      {/* 条目滚动区 */}
      {visibleItems.length === 0 ? (
        <div className="py-4 text-center text-micro text-l4">
          {filtering ? (
            <>
              没有匹配当前筛选条件的条目。
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setSeverityFilter("all");
                  setSourceFilter("all");
                }}
                className="ml-1.5 underline decoration-dotted underline-offset-2 hover:text-l1"
              >
                显示全部
              </button>
            </>
          ) : tab === "open" ? (
            <>
              当前没有待处理条目。
              <button
                type="button"
                onClick={() => setTab("all")}
                className="ml-1.5 underline decoration-dotted underline-offset-2 hover:text-l1"
              >
                查看全部 {counts.total} 条
              </button>
            </>
          ) : (
            "还没有已决定的条目。"
          )}
        </div>
      ) : (
        <ul
          className={`${fill ? "min-h-0 flex-1" : "max-h-80"} space-y-2.5 overflow-y-auto overflow-x-hidden pr-1`}
        >
          {visibleItems.map((item) => {
            const isDecided = item.verdict != null;
            const isRevising = revisingIds.has(item.id);
            const isEditing = editingId === item.id;
            const settledHere = tab === "open" && isDecided && settledIds.has(item.id) && !isRevising;
            const suggestion = itemSuggestion(item, kind);
            const draft = drafts[item.id] ?? "";
            const showDecisionControls = !readOnlyView && (!isDecided || isRevising);
            const itemBusy = busyId === item.id;

            return (
              <li
                key={item.id}
                data-decision-id={item.id}
                className={`border-t border-hairline pt-2.5 first:border-t-0 first:pt-0 transition-opacity ${
                  settledHere ? "opacity-75" : ""
                }`}
              >
                {/* 编号 + 级别 + 类别 + 当前裁决状态 */}
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-micro font-medium text-l3">{item.id}</span>
                  {item.section && (
                    <span
                      className={`rounded-sm px-1.5 py-px text-micro font-medium ${severityPillClass(item.section)}`}
                      title={item.sectionTitle}
                    >
                      {REVIEW_SEVERITY_LABEL[item.section]}
                    </span>
                  )}
                  {item.category && (
                    <span className="rounded-sm bg-inset px-1.5 py-px text-micro text-l4">
                      {item.category}
                    </span>
                  )}
                  {isDecided && !isRevising && item.verdict && (
                    <span
                      className={`inline-flex items-center gap-0.5 rounded-sm px-1.5 py-px text-micro font-medium ${verdictPillClass(item.verdict)}`}
                    >
                      {item.verdict === "接受" && <Check size={10} strokeWidth={2.4} aria-hidden="true" />}
                      {verdictLabel(item.verdict)}
                    </span>
                  )}
                </div>

                {/* 正文与可点行号跳转 */}
                <p className="text-xs leading-5 text-l1">
                  {renderTokens(reviewItemDisplayBody(item, kind))}
                </p>

                {/* AI 建议改法：完整换行展示，不再截在单行框里 */}
                {suggestion && (!isDecided || isRevising) && (
                  <div className="mt-1.5 flex items-start gap-2 rounded-md border border-hairline/80 bg-inset/50 px-2 py-1.5 text-micro leading-5 text-l3">
                    <div className="min-w-0 flex-1">
                      <span className="font-medium text-l2">建议改法：</span>
                      {renderTokens(suggestion)}
                    </div>
                    {!readOnlyView && !isEditing && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void choose(item, "修改", suggestion)}
                        title="直接按这条建议写入「修改」"
                        className="shrink-0 rounded-sm border border-field bg-surface px-1.5 py-0.5 text-micro text-l2 transition-colors hover:border-cta-bd hover:bg-cta-pill hover:text-cta-pill-text disabled:opacity-50"
                      >
                        {itemBusy ? "保存中…" : "按建议修改"}
                      </button>
                    )}
                  </div>
                )}

                {/* 已保存的修改说明 */}
                {isDecided && !isRevising && item.verdict === "修改" && item.note && (
                  <p className="mt-1.5 rounded-sm bg-inset/45 px-2 py-1 text-micro leading-5 text-l2">
                    <span className="text-l4">修改说明：</span>
                    {item.note}
                  </p>
                )}

                {/* 已决定态：改判 / 撤销 */}
                {isDecided && !isRevising && !readOnlyView && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setRevisingIds((prev) => new Set(prev).add(item.id));
                        if (item.verdict === "修改") {
                          setDrafts((prev) => ({ ...prev, [item.id]: item.note }));
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-sm border border-field px-1.5 py-0.5 text-micro text-l3 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50"
                    >
                      <Pencil size={10} strokeWidth={1.8} aria-hidden="true" />
                      改判
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void undo(item)}
                      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-micro text-l4 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50"
                    >
                      <RotateCcw size={10} strokeWidth={1.8} aria-hidden="true" />
                      {itemBusy ? "撤销中…" : "撤销"}
                    </button>
                  </div>
                )}

                {/* 未决 / 改判态：三态按钮 + 按需展开的多行修改框 */}
                {showDecisionControls && (
                  <div className="mt-1.5 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void choose(item, "接受")}
                        className={`rounded-sm border px-2 py-0.5 text-micro transition-colors disabled:opacity-50 ${
                          isRevising && item.verdict === "接受"
                            ? "border-done/50 bg-ok font-medium text-ok-text"
                            : "border-field bg-strip text-l1 hover:border-cta-bd hover:bg-cta-pill hover:text-cta-pill-text"
                        }`}
                      >
                        接受
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void choose(item, "拒绝")}
                        className={`rounded-sm border px-2 py-0.5 text-micro transition-colors disabled:opacity-50 ${
                          isRevising && item.verdict === "拒绝"
                            ? "border-l4 bg-raised font-medium text-l1"
                            : "border-field bg-strip text-l2 hover:bg-hover hover:text-l1"
                        }`}
                      >
                        拒绝
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (isEditing) setEditingId(null);
                          else openNoteEditor(item);
                        }}
                        aria-expanded={isEditing}
                        className={`rounded-sm border px-2 py-0.5 text-micro transition-colors disabled:opacity-50 ${
                          isEditing || (isRevising && item.verdict === "修改")
                            ? "border-cta-bd bg-cta-pill font-medium text-cta-pill-text"
                            : "border-field bg-strip text-l2 hover:bg-hover hover:text-l1"
                        }`}
                      >
                        修改
                      </button>
                      {isRevising && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEditingId((cur) => (cur === item.id ? null : cur));
                            setRevisingIds((prev) => {
                              const copy = new Set(prev);
                              copy.delete(item.id);
                              return copy;
                            });
                          }}
                          className="rounded-sm px-1.5 py-0.5 text-micro text-l4 hover:bg-hover hover:text-l1"
                        >
                          取消
                        </button>
                      )}
                    </div>

                    {isEditing && (
                      <div className="space-y-1.5 rounded-md border border-field/80 bg-canvas/80 p-2">
                        <textarea
                          autoFocus
                          rows={Math.min(6, Math.max(2, Math.ceil((draft.length || 60) / 52)))}
                          value={draft}
                          aria-label={`${item.id} 修改说明`}
                          onChange={(event) =>
                            setDrafts((prev) => ({ ...prev, [item.id]: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                              event.preventDefault();
                              if (draft.trim() && !busy) void choose(item, "修改", draft);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              event.nativeEvent.stopPropagation();
                              setEditingId(null);
                            }
                          }}
                          placeholder={
                            kind === "verify"
                              ? "写明怎么改；核不了可写「改成摘要级表述」或「保留待核实」"
                              : "写明具体修改要求"
                          }
                          className="w-full resize-y rounded-sm border border-field bg-canvas px-2 py-1.5 text-xs leading-5 text-l1 outline-none placeholder:text-l4 focus:border-cta-bd"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-micro text-l4">{modKeyLabel} 保存</span>
                          {suggestion && draft.trim() !== suggestion && (
                            <button
                              type="button"
                              onClick={() =>
                                setDrafts((prev) => ({ ...prev, [item.id]: suggestion }))
                              }
                              className="rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                            >
                              填入建议
                            </button>
                          )}
                          <div className="ml-auto flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="rounded-sm px-2 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              disabled={busy || !draft.trim()}
                              onClick={() => void choose(item, "修改", draft)}
                              className="rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-micro font-medium text-cta-text transition-[filter] hover:brightness-110 disabled:opacity-50"
                            >
                              {itemBusy ? "保存中…" : "保存修改"}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
