import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BookOpen,
  BookmarkPlus,
  ChevronRight,
  Columns2,
  Copy,
  CopyPlus,
  FilePlus,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Locate,
  Maximize2,
  MessageSquare,
  Pencil,
  RefreshCw,
  SquareCheck,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import { beginAskAi } from "./AskAiModal";
import type { DirEntryDto, SearchResultDto } from "./FileTree";
import {
  ghostActionClass,
  iconActionClass,
  inlineActionClass,
  projectWellClass,
  rowActionClass,
  searchFieldClass,
} from "./PageFrame";
import FileKindFilters from "./FileKindFilters";
import ContextMenu from "./ContextMenu";
import { confirmDialog, confirmDialogOpen } from "./ConfirmDialog";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { parentDir, pathWithin, revealFolderLabel, samePath } from "../path-utils";
import { absTime, relTime } from "../rel-time";
import {
  ancestorDirsToReveal,
  batchAskPrompt,
  fileMatchesProjectFilter,
  flattenVisibleFiles,
  folderCountLabel,
  inTypingContext,
  neighborFile,
  projectFilePreviewKind,
  rangeSelect,
  supportsImmersiveReader,
  type ProjectFileFilter,
} from "../project-files";
import { displayFileTitle, LIT_STATE_LABELS, pdfLitState, type LitReadState } from "../lit-list";
import type { PaperNoteLink } from "../lit-watch";
import { toast } from "../toast";
import { officeKindCounts } from "../project-status";
import type { OfficeDocDto, RunDto, TaskDto, TaskReviewDto } from "../types";
import {
  declaredTaskKindsForMode,
  markForProjectFile,
  relativeProjectPath,
  visibleDeclaredTasks,
} from "../project-tasks";
import { goalReviewCopy } from "../goal-review";
import FileTypeMark from "./FileTypeMark";
import ProjectFilePreview from "./ProjectFilePreview";
import { cachedNotePaired, checkNotePaired, isMarkdownNote } from "../note-pdf-pair";
import { Modal } from "./Modal";
import { armDraftHandoff } from "../file-draft-handoff";
import { organizePdfExcerpt } from "../pdf-organize";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import {
  dropTargetAt,
  duplicatePath,
  importDropped,
  nameDraftPrompt,
  pickAndMove,
  pickMoveTarget,
  stemSelection,
  submitNameDraft as submitNameDraftCmd,
  type NameDraft,
} from "../file-ops";

type EntryCache = Record<string, DirEntryDto[]>;

/** 目录重载的短路比较：字段级一致就当没变（name 由 path 派生，不重复比） */
function sameEntries(a: DirEntryDto[], b: DirEntryDto[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.path !== y.path ||
      x.isDir !== y.isDir ||
      x.size !== y.size ||
      x.modified !== y.modified ||
      x.childCount !== y.childCount
    ) {
      return false;
    }
  }
  return true;
}

/** 宽屏（Tailwind lg）判定；测试环境没有 matchMedia 时按宽屏 */
function wideQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 1024px)") : null;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function modifiedLabel(iso: string | null | undefined): string {
  return relTime(iso ?? null);
}

/** 修改时间：行悬停时让位给行内图标（图标排在行尾、不再浮层压在上面——
 *  悬停底色是半透明的，压上去时间会从图标底下透出来，2026-10-17 用户截图） */
function FileModified({ iso }: { iso: string | null | undefined }) {
  const label = modifiedLabel(iso);
  if (!label) return null;
  return (
    <span
      className="shrink-0 text-micro text-l4 group-hover:hidden group-focus-within:hidden"
      title={absTime(iso ?? null) || undefined}
    >
      {label}
    </span>
  );
}

/** 文件夹行尾：里面有几项（与文件的修改时间同一位置，悬停同样让位给行内图标） */
function FolderCount({ count }: { count: number | undefined }) {
  const label = folderCountLabel(count);
  if (!label) return null;
  return (
    <span className="shrink-0 text-micro text-l4 group-hover:hidden group-focus-within:hidden">
      {label}
    </span>
  );
}

/** PDF 行的阅读状态（与资源列表同一套词与样式；未读不写） */
const LIT_PILL: Record<Exclude<LitReadState, "unread">, string> = {
  read: "bg-inset text-l3",
  queued: "border border-field bg-canvas text-l2",
  accumulated: "bg-canvas text-l4",
};
function LitPill({ state }: { state: LitReadState }) {
  if (state === "unread") return null;
  return (
    <span className={`inline-flex shrink-0 rounded-full px-1.5 py-px text-micro ${LIT_PILL[state]}`}>
      {LIT_STATE_LABELS[state]}
    </span>
  );
}

type LitFacts = {
  notes: PaperNoteLink[];
  included: { title: string }[];
  readingList: { title: string }[];
};
const NO_LIT_FACTS: LitFacts = { notes: [], included: [], readingList: [] };

function asFileEntry(file: {
  path: string;
  name: string;
  size?: number;
  modified?: string | null;
}): DirEntryDto {
  return {
    path: file.path,
    name: file.name,
    isDir: false,
    size: file.size ?? 0,
    modified: file.modified ?? null,
  };
}

export default function ProjectFilesView({
  projectPath,
  workMode,
  preferredAgent,
  preferredProfile,
  preferredModel,
  onError,
  focusPath,
  focusToken,
  onFocusHandled,
}: {
  projectPath: string;
  workMode?: string | null;
  preferredAgent?: string | null;
  preferredProfile?: string | null;
  preferredModel?: string | null;
  onError: (message: string) => void;
  /** 从待获取清单跳过来：展开父目录并打开这篇 */
  focusPath?: string | null;
  focusToken?: number | null;
  onFocusHandled?: () => void;
}) {
  const setPage = useAppStore((s) => s.setPage);
  const setReaderReq = useAppStore((s) => s.setReaderReq);
  /** 在这个目录开一个纯终端（shell）：侧栏所属文件夹下多一行「终端」（2026-10-24 起不再借「进入目录」改正在聊的那段） */
  const openShellAt = (path: string) => {
    const st = useAppStore.getState();
    st.setPendingTerminal({ cwd: path, extraEnv: {}, title: path.split(/[\\/]/).filter(Boolean).pop() ?? path, shellOnly: true });
    st.setPage("terminal");
  };
  const [cache, setCache] = useState<EntryCache>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<DirEntryDto | null>(null);
  /** 「对照」钉在左边的那份文件（宽屏与窗口预览里并排看两份；2026-10-26） */
  const [compare, setCompare] = useState<DirEntryDto | null>(null);
  const compareDirtyRef = useRef(false);
  const [windowed, setWindowed] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectFileFilter>("all");
  const [officeDocs, setOfficeDocs] = useState<OfficeDocDto[]>([]);
  const [searchHits, setSearchHits] = useState<SearchResultDto[] | null>(null);
  const [goalMarks, setGoalMarks] = useState<
    { relative: string; goalName: string; pending: boolean }[]
  >([]);
  // 文件行的「沉浸阅读」：PDF 永远有；md 笔记要配得上本篇 PDF 才有（note-pdf-pair.ts）。悬停 / 聚焦到这一行时才去问，
  // 问到了加一刷新这一列（2026-10-25 用户：没有 PDF 的文件也挂「沉浸阅读」有歧义）
  const [, setPairTick] = useState(0);
  function probeNotePair(path: string) {
    if (!isMarkdownNote(path) || cachedNotePaired(path) !== undefined) return;
    void checkNotePaired(path).then((ok) => {
      if (ok) setPairTick((n) => n + 1);
    });
  }
  function rowHasReader(path: string, name: string): boolean {
    return supportsImmersiveReader(name) && (!isMarkdownNote(name) || cachedNotePaired(path) === true);
  }
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    path: string;
    isDir: boolean;
  } | null>(null);
  /** 顶上名字输入行：新建文件 / 新建文件夹 / 重命名（file-ops.ts） */
  const [nameDraft, setNameDraft] = useState<NameDraft | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  /** 从访达拖进来时正悬停的落点文件夹（高亮用） */
  const [dropDir, setDropDir] = useState<string | null>(null);
  /** 命中 2000 项展示上限的目录（点名提示；低于上限的重载解除） */
  const [truncDir, setTruncDir] = useState<string | null>(null);
  /** 多选（只选文件）：⌘ / Ctrl 点加减、Shift 点连选；有选中时列表上方出批量操作条 */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const pickAnchorRef = useRef<string | null>(null);
  /** PDF 行阅读状态的三份事实（笔记配对 / 精读清单 / 积累清单），项目切换与文件变化后重读 */
  const [litFacts, setLitFacts] = useState<LitFacts>(NO_LIT_FACTS);
  const pendingMark = goalReviewCopy(workMode).fileMark;
  const listRef = useRef<HTMLDivElement>(null);
  /** 当前预览的未保存编辑（编辑器上报；换/关预览经 confirmLoseDirty 确认） */
  const dirtyRef = useRef(false);
  // 侧栏预览（宽屏）与列表下方预览（窄屏）只挂一份：原先两份同时挂着、靠 CSS 藏一份，
  // 同一文件两个编辑器各自读盘监听。窗口宽窄切换时没保存的修改跟过去（file-draft-handoff）
  const [wide, setWide] = useState(() => wideQuery()?.matches ?? true);
  useEffect(() => {
    const mq = wideQuery();
    if (!mq) return;
    const onChange = () => {
      const path = previewPathRef.current;
      if (path && dirtyRef.current) armDraftHandoff(path);
      setWide(mq.matches);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /** quiet=true 给监听器的后台重载用：失败不弹错（目录多半已被 agent 删/改名），
   *  并把该目录从展开集合与缓存里收掉——否则每轮 fs 事件都重拉死路径、反复报错 */
  const load = useCallback(
    async (path: string, quiet = false) => {
      try {
        const entries = await invoke<DirEntryDto[]>("list_dir", {
          path,
          showHidden: false,
          withCounts: true,
        });
        setCache((current) => {
          // 内容没变就保留旧引用：agent 持续写盘期间监听器每轮重载，
          // 不短路的话每 500ms 全树重渲一次
          const old = current[path];
          if (old && sameEntries(old, entries)) return current;
          return { ...current, [path]: entries };
        });
        setTruncDir((cur) =>
          entries.length >= 2000 ? path : cur === path ? null : cur,
        );
        return entries;
      } catch (reason) {
        if (quiet) {
          setExpanded((cur) => {
            if (!cur.has(path)) return cur;
            const next = new Set(cur);
            next.delete(path);
            return next;
          });
          setCache((cur) => {
            if (!(path in cur)) return cur;
            const next = { ...cur };
            delete next[path];
            return next;
          });
        } else {
          onError(`读取项目文件失败：${String(reason)}`);
        }
        return [] as DirEntryDto[];
      }
    },
    [onError],
  );

  /** 办公类清单（类型计数 + 「最近」视图的数据源，后端按修改时间降序） */
  const reloadOffice = useCallback((root: string) => {
    void invoke<OfficeDocDto[]>("list_office_docs", { root })
      .then(setOfficeDocs)
      .catch(() => setOfficeDocs([]));
  }, []);

  /** 读不到（非科研项目、没有 papers/）就当三份都空：PDF 行不标状态 */
  const reloadLitFacts = useCallback((root: string) => {
    void Promise.all([
      invoke<PaperNoteLink[]>("list_paper_notes", { projectRoot: root }).catch(() => []),
      invoke<{ title: string }[]>("list_included_entries", { projectRoot: root }).catch(() => []),
      invoke<{ title: string }[]>("list_reading_list_entries", { projectRoot: root }).catch(() => []),
    ]).then(([notes, included, readingList]) =>
      setLitFacts({ notes: notes ?? [], included: included ?? [], readingList: readingList ?? [] }),
    );
  }, []);

  useEffect(() => {
    setCache({});
    setExpanded(new Set());
    setPicked(new Set());
    pickAnchorRef.current = null;
    setLitFacts(NO_LIT_FACTS);
    reloadLitFacts(projectPath);
    setPreview(null);
    setCompare(null);
    compareDirtyRef.current = false;
    setWindowed(false);
    setQuery("");
    setFilter("all");
    setSearchHits(null);
    // 截断提示/右键菜单/新建输入也是项目局部状态，切课题一起清；
    // 脏标志不清会带着旧项目的「没保存修改」去误拦新项目
    setTruncDir(null);
    setMenu(null);
    setNameDraft(null);
    dirtyRef.current = false;
    setLoading(true);
    void load(projectPath).finally(() => setLoading(false));
    reloadOffice(projectPath);
    const kinds = declaredTaskKindsForMode(workMode);
    if (kinds.size === 0) {
      setGoalMarks([]);
    } else {
      void Promise.all([
        invoke<TaskDto[]>("task_list", { projectRoot: projectPath }),
        invoke<RunDto[]>("run_list", { projectRoot: projectPath }),
      ])
        .then(async ([tasks, runs]) => {
          const declared = visibleDeclaredTasks(tasks, kinds);
          const latest = new Map<string, RunDto>();
          for (const run of runs) {
            if (!latest.has(run.taskId)) latest.set(run.taskId, run);
          }
          const marks: { relative: string; goalName: string; pending: boolean }[] = [];
          for (const task of declared) {
            if (task.status !== "pending_review") continue;
            const run = latest.get(task.id);
            if (!run || run.status !== "completed") continue;
            try {
              const review = await invoke<TaskReviewDto>("task_output_changes", {
                runId: run.id,
              });
              for (const change of review.changes) {
                if (change.kind === "deleted") continue;
                marks.push({
                  relative: change.path,
                  goalName: task.name,
                  pending: true,
                });
              }
            } catch {
              /* 读不到变更时不标 */
            }
          }
          setGoalMarks(marks);
        })
        .catch(() => setGoalMarks([]));
    }
  }, [load, projectPath, reloadOffice, reloadLitFacts, workMode]);

  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const onFocusHandledRef = useRef(onFocusHandled);
  onFocusHandledRef.current = onFocusHandled;

  // 文件监听（与终端树同一套 watch_dir/fs-changed，后端 500ms 防抖）：
  // Agent 写完的产物自动出现；监听失败退回手动刷新
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let watchId: string | null = null;
    // Agent 连续写盘时每 500ms 来一次事件：阅读状态要读三份清单，攒 1.5 秒再读一次
    let litTimer: number | undefined;
    void (async () => {
      try {
        watchId = await invoke<string>("watch_dir", { path: projectPath });
        if (cancelled) {
          invoke("unwatch_dir", { id: watchId }).catch(() => {});
          return;
        }
        unlisten = await listen(`fs-changed-${watchId}`, () => {
          for (const p of [projectPath, ...expandedRef.current])
            void load(p, true);
          reloadOffice(projectPath);
          window.clearTimeout(litTimer);
          litTimer = window.setTimeout(() => reloadLitFacts(projectPath), 1500);
        });
      } catch {
        // 目录不可读等：静默退回手动刷新
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(litTimer);
      unlisten?.();
      if (watchId) invoke("unwatch_dir", { id: watchId }).catch(() => {});
    };
  }, [projectPath, load, reloadOffice, reloadLitFacts]);

  /** 刷新 = 根目录 + 已展开目录全部重拉（旧实现只重载根，子目录永远停在第一次展开） */
  function refresh() {
    for (const p of [projectPath, ...expandedRef.current]) void load(p);
    reloadOffice(projectPath);
    reloadLitFacts(projectPath);
  }

  useEffect(() => {
    if (!focusPath || focusToken == null || loading) return;
    let cancelled = false;
    void (async () => {
      // 当前预览有未保存编辑且用户拒绝丢弃：不替换预览，深链照常消费掉
      if (!(await confirmLoseDirty())) {
        onFocusHandledRef.current?.();
        return;
      }
      const dirs = ancestorDirsToReveal(projectPath, focusPath, IS_WINDOWS);
      const nextExpanded = new Set(expandedRef.current);
      let listing = cacheRef.current[projectPath] ?? [];
      for (const dir of dirs) {
        if (cancelled) return;
        const name = dir.split(/[\\/]/).pop() ?? dir;
        const hit = listing.find(
          (entry) =>
            entry.isDir &&
            (samePath(entry.path, dir, IS_WINDOWS) || entry.name === name),
        );
        const dirPath = hit?.path ?? dir;
        nextExpanded.add(dirPath);
        listing = cacheRef.current[dirPath] ?? (await load(dirPath));
      }
      if (cancelled) return;
      const focusName = focusPath.split(/[\\/]/).pop() ?? focusPath;
      const dirHit = listing.find(
        (entry) =>
          entry.isDir &&
          (samePath(entry.path, focusPath, IS_WINDOWS) ||
            entry.name === focusName),
      );
      if (dirHit) {
        nextExpanded.add(dirHit.path);
        setExpanded(nextExpanded);
        await load(dirHit.path);
        if (cancelled) return;
        setPreview(null);
        setFilter("all");
        setQuery("");
        setWindowed(false);
        requestAnimationFrame(() => {
          const el = listRef.current?.querySelector(
            `[data-file-path="${CSS.escape(dirHit.path)}"]`,
          );
          el?.scrollIntoView({ block: "nearest" });
        });
        onFocusHandledRef.current?.();
        return;
      }
      setExpanded(nextExpanded);
      const file = listing.find(
        (entry) =>
          !entry.isDir &&
          (samePath(entry.path, focusPath, IS_WINDOWS) ||
            entry.name === focusName),
      );
      if (file) setPreview(file);
      else if (/\.[A-Za-z0-9]+$/.test(focusName)) void openPath(focusPath);
      setFilter("all");
      setQuery("");
      setWindowed(false);
      requestAnimationFrame(() => {
        const target = file?.path ?? focusPath;
        const el = listRef.current?.querySelector(
          `[data-file-path="${CSS.escape(target)}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
      });
      onFocusHandledRef.current?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [focusPath, focusToken, loading, projectPath, load]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchHits(null);
      return;
    }
    const timer = window.setTimeout(() => {
      invoke<SearchResultDto[]>("search_files", {
        root: projectPath,
        query: q,
        showHidden: false,
      })
        .then(setSearchHits)
        .catch(() => setSearchHits([]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [projectPath, query]);

  const filtering = filter !== "all" || !!query.trim();
  const kindCounts = useMemo(
    () => officeKindCounts(officeDocs.map((doc) => doc.path)),
    [officeDocs],
  );

  const filteredFiles = useMemo(() => {
    if (searchHits) {
      return searchHits.filter(
        (hit) => !hit.isDir && fileMatchesProjectFilter(hit.path, filter),
      );
    }
    if (filter === "all") return [];
    const q = query.trim().toLowerCase();
    return officeDocs.filter((doc) => {
      if (filter !== "recent" && !fileMatchesProjectFilter(doc.path, filter))
        return false;
      if (!q) return true;
      return (
        doc.name.toLowerCase().includes(q) || doc.rel.toLowerCase().includes(q)
      );
    });
  }, [filter, officeDocs, query, searchHits]);

  const visibleFiles = useMemo(() => {
    if (filtering) {
      return filteredFiles.map((file) => asFileEntry(file));
    }
    return flattenVisibleFiles(cache, projectPath, expanded);
  }, [cache, expanded, filteredFiles, filtering, projectPath]);

  const prevFile = neighborFile(visibleFiles, preview?.path, -1);
  const nextFile = neighborFile(visibleFiles, preview?.path, 1);

  async function toggle(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (!cache[path]) await load(path);
    }
    setExpanded(next);
  }

  /** 有未保存编辑时先经确认再换/关预览（终端页预览页签与终端树切根同款保护）。
   *  确认「继续」即视为丢弃已拍板：清掉脏标志，后续换文件不再重复问 */
  async function confirmLoseDirty(): Promise<boolean> {
    if (!dirtyRef.current) return true;
    const ok = await confirmDialog(
      "当前预览有没保存的修改，继续就会丢掉这些修改。仍要继续？",
      { danger: true, confirmText: "继续" },
    );
    if (ok) dirtyRef.current = false;
    return ok;
  }

  /** keepWindow=true 只换文件不动窗口态：窗口预览里 ↑/↓ 步进、点 md 链接
   *  跳转时大窗保持打开（旧行为；收窗口只发生在点列表行与关预览） */
  function applyPreview(entry: DirEntryDto | null, keepWindow = false) {
    dirtyRef.current = false;
    setPreview(entry);
    if (!keepWindow) setWindowed(false);
  }

  /** 侧栏 ⇄ 窗口预览：编辑器会换一个实例，先 arm 让没保存的修改跟过去（不再要人确认丢掉） */
  function moveHost(toWindow: boolean) {
    if (!preview || windowed === toWindow) return;
    if (dirtyRef.current) armDraftHandoff(preview.path);
    if (compare && compareDirtyRef.current) armDraftHandoff(compare.path);
    setWindowed(toWindow);
  }

  async function pickFile(entry: DirEntryDto) {
    if (preview && samePath(preview.path, entry.path, IS_WINDOWS)) {
      moveHost(false);
      return;
    }
    if (!(await confirmLoseDirty())) return;
    applyPreview(entry);
  }

  const visibleFilesRef = useRef(visibleFiles);
  visibleFilesRef.current = visibleFiles;
  const previewPathRef = useRef(preview?.path);
  previewPathRef.current = preview?.path;

  async function openPath(absPath: string) {
    if (preview && samePath(preview.path, absPath, IS_WINDOWS)) return;
    if (!(await confirmLoseDirty())) return;
    applyPreview(
      {
        path: absPath,
        name: absPath.split(/[\\/]/).pop() ?? absPath,
        isDir: false,
        size: 0,
        modified: null,
      },
      true,
    );
  }

  async function closePreview() {
    if (!(await confirmLoseDirty())) return;
    applyPreview(null);
    // 预览关了，对照也一起收（对照栏有没保存的修改时 closeCompare 会再问）
    if (compare) await closeCompare();
  }

  async function stepPreview(delta: -1 | 1) {
    const next = neighborFile(
      visibleFilesRef.current,
      previewPathRef.current,
      delta,
    );
    if (!next) return;
    if (!(await confirmLoseDirty())) return;
    applyPreview(asFileEntry(next), true);
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("[data-file-path]")) {
      active.blur();
    }
  }

  function askAi(entry: DirEntryDto) {
    beginAskAi({
      path: entry.path,
      name: entry.name,
      cwd: projectPath,
      root: projectPath,
      reuseKey: `project-file:${projectPath}:${entry.path}`,
      preferredAgent,
      preferredProfile,
      preferredModel,
    });
  }

  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const pickedList = useMemo(() => [...picked], [picked]);
  const pickedPdfs = pickedList.filter((p) => /\.pdf$/i.test(p));

  function clearPicked() {
    setPicked(new Set());
    pickAnchorRef.current = null;
  }

  // 换筛选 / 改搜索词后列表换了一批，留着看不见的选中容易误删：一起清掉
  useEffect(() => {
    clearPicked();
  }, [filter, query]);

  /** 点文件行：⌘（Windows / Linux 上 Ctrl）点加减选中，Shift 点从上次点的那行连选；
   *  普通点照旧预览，并清掉多选。正在预览的那份算「已经点过的」（Finder 同款：先点一份，再 ⌘ / Shift 点另一份） */
  function clickFile(event: React.MouseEvent, entry: DirEntryDto) {
    const additive = IS_MAC ? event.metaKey : event.ctrlKey;
    if (additive || event.shiftKey) {
      event.preventDefault();
      const order = visibleFilesRef.current.map((f) => f.path);
      const current = previewPathRef.current;
      const seed = current && order.includes(current) ? current : null;
      const anchor = pickAnchorRef.current ?? seed;
      setPicked((cur) => {
        const next = new Set(cur);
        if (next.size === 0 && seed) next.add(seed);
        if (event.shiftKey) {
          for (const p of rangeSelect(order, anchor, entry.path)) next.add(p);
        } else if (next.has(entry.path)) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
        }
        return next;
      });
      if (!event.shiftKey || !anchor) pickAnchorRef.current = entry.path;
      return;
    }
    if (pickedRef.current.size) setPicked(new Set());
    pickAnchorRef.current = entry.path;
    void pickFile(entry);
  }

  /** 右键菜单「选择」：不知道快捷键也能开始多选 */
  function addToPicked(path: string) {
    setPicked((cur) => new Set(cur).add(path));
    pickAnchorRef.current = path;
  }

  function askAiPicked() {
    const paths = pickedList;
    if (paths.length === 0) return;
    if (paths.length === 1) {
      askAi(asFileEntry({ path: paths[0], name: baseName(paths[0]) }));
      return;
    }
    beginAskAi({
      path: paths[0],
      name: `${paths.length} 个文件`,
      cwd: projectPath,
      root: projectPath,
      reuseKey: `project-files:${projectPath}:${[...paths].sort().join("|")}`,
      prompt: batchAskPrompt(paths),
      preferredAgent,
      preferredProfile,
      preferredModel,
    });
  }

  /** 选中的 PDF 一起进积累清单：题名先按项目题录找真名（与阅读区顶栏同一个查法），找不到用文件名 */
  async function accumulatePicked() {
    const pdfs = pickedPdfs;
    let added = 0;
    let already = 0;
    let firstError = "";
    for (const pdf of pdfs) {
      try {
        const known = await invoke<string | null>("reader_paper_title", {
          projectRoot: projectPath,
          pdfPath: pdf,
        }).catch(() => null);
        const res = await invoke<{ added: boolean }>("add_reading_list_entry", {
          projectRoot: projectPath,
          title: known?.trim() || displayFileTitle(baseName(pdf)),
          authorsYear: "",
          source: "",
          link: "",
        });
        if (res.added) added += 1;
        else already += 1;
      } catch (reason) {
        if (!firstError) firstError = String(reason);
      }
    }
    reloadLitFacts(projectPath);
    const failed = pdfs.length - added - already;
    const parts = [added ? `已加入积累 ${added} 篇` : "没有新加入的"];
    if (already) parts.push(`${already} 篇本来就在清单里`);
    if (failed) parts.push(`${failed} 篇没加上：${firstError}`);
    toast(parts.join("，"), failed && !added ? "error" : "info");
  }

  async function movePicked() {
    const paths = pickedList;
    if (paths.length === 0) return;
    const touchesPreview =
      preview && paths.some((p) => samePath(preview.path, p, IS_WINDOWS));
    if (touchesPreview && !(await confirmLoseDirty())) return;
    let dest: string | null;
    try {
      dest = await pickMoveTarget(parentDir(paths[0]) ?? projectPath, projectPath, IS_WINDOWS);
    } catch (reason) {
      onError(`移动失败：${String(reason)}`);
      return;
    }
    if (!dest) return;
    const failures: string[] = [];
    for (const path of paths) {
      try {
        const next = await invoke<string>("fs_move_path", { path, destDir: dest, root: projectPath });
        followCompare(path, next);
        if (preview && samePath(preview.path, path, IS_WINDOWS)) followMoved(preview.path, path, next);
      } catch (reason) {
        failures.push(`${baseName(path)}：${String(reason)}`);
      }
    }
    clearPicked();
    setExpanded((prev) => new Set(prev).add(dest));
    refresh();
    if (failures.length) onError(`有 ${failures.length} 个没移过去——${failures.join("；")}`);
  }

  async function deletePicked() {
    const paths = pickedList;
    if (paths.length === 0) return;
    const names = paths.map(baseName);
    const shown = names.slice(0, 5).join("、") + (names.length > 5 ? ` 等 ${names.length} 个` : "");
    if (
      !(await confirmDialog(`删除这 ${paths.length} 个文件（${shown}）？将移入系统回收站。`, {
        danger: true,
      }))
    )
      return;
    const failures: string[] = [];
    for (const path of paths) {
      try {
        await invoke("fs_delete_path", { path, root: projectPath });
        if (compare && samePath(compare.path, path, IS_WINDOWS)) {
          compareDirtyRef.current = false;
          setCompare(null);
        }
        if (preview && samePath(preview.path, path, IS_WINDOWS)) {
          dirtyRef.current = false;
          setPreview(null);
          setWindowed(false);
        }
      } catch (reason) {
        failures.push(`${baseName(path)}：${String(reason)}`);
      }
    }
    clearPicked();
    refresh();
    if (failures.length) onError(`有 ${failures.length} 个没删掉——${failures.join("；")}`);
  }

  // 有选中时 Esc 先取消选择（不关预览）；打字控件、菜单、弹窗里的 Esc 归它们自己
  useEffect(() => {
    if (picked.size === 0) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (inTypingContext(target) || menu || confirmDialogOpen()) return;
      if (document.querySelector(".ccode-modal-backdrop")) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      clearPicked();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [picked, menu]);

  /** 每篇 PDF 的阅读状态，按三份事实算一次缓存住（行渲染时直接取） */
  const litStateOf = useMemo(() => {
    const memo = new Map<string, LitReadState>();
    return (path: string): LitReadState => {
      let state = memo.get(path);
      if (state === undefined) {
        state = pdfLitState(path, litFacts);
        memo.set(path, state);
      }
      return state;
    };
  }, [litFacts]);

  function readPdf(entry: DirEntryDto) {
    setReaderReq({ pdfPath: entry.path, projectRoot: projectPath });
    setPage("terminal");
  }

  /** md 笔记「⛶ 沉浸阅读」（与 ArtifactChecklist 同链路）：reader_for_note 一次给齐
   *  归属项目根 + 配对 PDF + 实际笔记路径；无配对 PDF（仅摘要笔记）/未合并等工作区
   *  场景的失败原因直接透出给用户 */
  async function readNote(entry: { path: string }) {
    try {
      const r = await invoke<{
        projectRoot: string;
        pdfPath: string;
        notePath: string;
      }>("reader_for_note", { notePath: entry.path });
      setReaderReq({
        pdfPath: r.pdfPath,
        projectRoot: r.projectRoot,
        notePath: r.notePath,
      });
      setPage("terminal");
    } catch (reason) {
      onError(String(reason));
    }
  }

  /** 行悬停/预览工具条共用的 ⺆ 入口分发：PDF 直接进；md 笔记经配对进 */
  function openImmersive(entry: DirEntryDto) {
    if (/\.pdf$/i.test(entry.name)) readPdf(entry);
    else void readNote(entry);
  }

  /** 搜索/筛选平铺里丢掉了目录上下文：定位 = 展开父链、退回树视图、滚到这一行。
   *  预览不换文件，未保存编辑不受影响 */
  async function locateInTree(absPath: string) {
    const dirs = ancestorDirsToReveal(projectPath, absPath, IS_WINDOWS);
    let listing = cacheRef.current[projectPath] ?? [];
    for (const dir of dirs) {
      const name = dir.split(/[\\/]/).pop() ?? dir;
      const hit = listing.find(
        (entry) =>
          entry.isDir &&
          (samePath(entry.path, dir, IS_WINDOWS) || entry.name === name),
      );
      if (!hit) break;
      // 必须用 load 的返回值：await 后 cacheRef 要到下一次渲染才刷新，
      // 立刻读会拿到旧缓存，父链连续两层未缓存时定位静默失败
      listing = cacheRef.current[hit.path] ?? (await load(hit.path));
      setExpanded((prev) => new Set(prev).add(hit.path));
    }
    setFilter("all");
    setQuery("");
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(
        `[data-file-path="${CSS.escape(absPath)}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  /** 右键删除：确认后走系统回收站（fs_delete_path 后端有保护路径/根目录护栏） */
  async function deleteMenuTarget(m: { path: string; isDir: boolean }) {
    const name = m.path.split(/[\\/]/).pop() ?? m.path;
    if (
      !(await confirmDialog(
        `删除「${name}」${m.isDir ? "（含全部内容）" : ""}？将移入系统回收站。`,
        { danger: true },
      ))
    )
      return;
    try {
      await invoke("fs_delete_path", { path: m.path, root: projectPath });
      // 把被删路径（含其下的展开项）从展开集合与缓存里收掉，
      // 否则 refresh 与后续 fs 事件还会重拉死路径、弹出成功删除却报错的提示
      setExpanded((cur) => {
        const next = new Set<string>();
        for (const p of cur) {
          if (p === m.path || pathWithin(p, m.path, IS_WINDOWS)) continue;
          next.add(p);
        }
        return next;
      });
      setCache((cur) => {
        const next: EntryCache = {};
        for (const [k, v] of Object.entries(cur)) {
          if (k === m.path || pathWithin(k, m.path, IS_WINDOWS)) continue;
          next[k] = v;
        }
        return next;
      });
      if (
        compare &&
        (samePath(compare.path, m.path, IS_WINDOWS) || pathWithin(compare.path, m.path, IS_WINDOWS))
      ) {
        compareDirtyRef.current = false;
        setCompare(null);
      }
      // 删的就是当前预览（或其所在目录）：直接关掉，不存在丢编辑的问题
      if (
        preview &&
        (samePath(preview.path, m.path, IS_WINDOWS) ||
          pathWithin(preview.path, m.path, IS_WINDOWS))
      ) {
        dirtyRef.current = false;
        setPreview(null);
        setWindowed(false);
      }
      refresh();
    } catch (reason) {
      onError(`删除失败：${String(reason)}`);
    }
  }

  /** 提交顶上的名字输入：新建文件夹 / 新建文件 / 重命名 */
  async function submitNameDraft() {
    const d = nameDraft;
    setNameDraft(null);
    if (!d || !d.value.trim()) return;
    const verb = d.kind === "folder" ? "新建文件夹" : d.kind === "file" ? "新建文件" : "重命名";
    try {
      if (d.kind === "rename") {
        const renamingPreview =
          preview &&
          (samePath(preview.path, d.path, IS_WINDOWS) || pathWithin(preview.path, d.path, IS_WINDOWS));
        // 改的是正在预览（或它所在文件夹）的文件：先过未保存确认，改完预览跟到新路径
        if (renamingPreview && !(await confirmLoseDirty())) return;
        const next = await submitNameDraftCmd(d, projectPath);
        forgetPath(d.path);
        followCompare(d.path, next);
        if (renamingPreview && preview) followMoved(preview.path, d.path, next);
      } else {
        const created = await submitNameDraftCmd(d, projectPath);
        // 新东西落在被右键的目录里：展开它才看得见；新建的文件直接打开
        setExpanded((prev) => new Set(prev).add(d.dir));
        if (d.kind === "file" && (await confirmLoseDirty())) {
          applyPreview(asFileEntry({ path: created, name: baseName(created) }));
        }
      }
      refresh();
    } catch (reason) {
      onError(`${verb}失败：${String(reason)}`);
    }
  }

  /** 对照栏里的文件被改名 / 移走：跟到新路径 */
  function followCompare(from: string, to: string) {
    setCompare((c) => {
      if (!c) return c;
      if (!samePath(c.path, from, IS_WINDOWS) && !pathWithin(c.path, from, IS_WINDOWS)) return c;
      const moved = samePath(c.path, from, IS_WINDOWS) ? to : to + c.path.slice(from.length);
      return asFileEntry({ path: moved, name: baseName(moved) });
    });
  }

  /** 关对照栏：有没保存的修改先问 */
  async function closeCompare() {
    if (
      compareDirtyRef.current &&
      !(await confirmDialog("对照栏里的文件有没保存的修改，关掉就会丢掉。仍要关？", {
        danger: true,
        confirmText: "关掉",
      }))
    )
      return;
    compareDirtyRef.current = false;
    setCompare(null);
  }

  /** 预览中的文件（或它所在文件夹）被改名 / 移走：预览跟到新路径 */
  function followMoved(previewPath: string, from: string, to: string) {
    const moved = samePath(previewPath, from, IS_WINDOWS) ? to : to + previewPath.slice(from.length);
    applyPreview(asFileEntry({ path: moved, name: baseName(moved) }), true);
  }

  const menuIsDirRef = useRef(false);
  function startNameDraft(d: NameDraft) {
    setNameDraft(d);
    requestAnimationFrame(() => {
      const input = nameInputRef.current;
      if (!input) return;
      input.focus();
      if (d.kind === "rename") {
        const [a, b] = stemSelection(d.value, menuIsDirRef.current);
        input.setSelectionRange(a, b);
      }
    });
  }

  /** 路径被改名 / 移走后，把它（及其下）从展开集合与缓存里收掉，免得重拉死路径 */
  function forgetPath(path: string) {
    setExpanded((cur) => {
      const next = new Set<string>();
      for (const p of cur) {
        if (p === path || pathWithin(p, path, IS_WINDOWS)) continue;
        next.add(p);
      }
      return next;
    });
    setCache((cur) => {
      const next: EntryCache = {};
      for (const [k, v] of Object.entries(cur)) {
        if (k === path || pathWithin(k, path, IS_WINDOWS)) continue;
        next[k] = v;
      }
      return next;
    });
  }

  async function moveMenuTarget(m: { path: string; isDir: boolean }) {
    const affectsPreview =
      preview && (samePath(preview.path, m.path, IS_WINDOWS) || pathWithin(preview.path, m.path, IS_WINDOWS));
    if (affectsPreview && !(await confirmLoseDirty())) return;
    try {
      const next = await pickAndMove(m.path, projectPath, IS_WINDOWS);
      if (!next) return;
      forgetPath(m.path);
      followCompare(m.path, next);
      if (affectsPreview && preview) followMoved(preview.path, m.path, next);
      refresh();
    } catch (reason) {
      onError(`移动失败：${String(reason)}`);
    }
  }

  async function duplicateMenuTarget(m: { path: string }) {
    try {
      await duplicatePath(m.path, projectPath);
      refresh();
    } catch (reason) {
      onError(`复制失败：${String(reason)}`);
    }
  }

  // 从访达 / 资源管理器拖进来：落在文件夹行上放进那个文件夹，落在文件行上放进它所在的文件夹，
  // 落在列表空白处放进项目根。只复制，不移动原文件
  useEffect(() => {
    let unlisten: Promise<() => void>;
    try {
      unlisten = getCurrentWebviewWindow().onDragDropEvent(onDrop);
    } catch {
      return; // 没有窗口（测试环境）：不接拖放
    }
    return () => {
      void unlisten.then((fn) => fn());
    };
    function onDrop(event: { payload: DragDropEvent }) {
      const p = event.payload;
      if (p.type === "leave") {
        setDropDir(null);
        return;
      }
      if (p.type !== "over" && p.type !== "drop") return;
      const hit = dropTargetAt(p.position.x, p.position.y, "[data-drop-dir], [data-files-drop-zone]");
      const dir = hit ? (hit.getAttribute("data-drop-dir") ?? projectPath) : null;
      if (p.type === "over") {
        setDropDir(dir);
        return;
      }
      setDropDir(null);
      if (!dir || !p.paths.length) return;
      void importDropped(p.paths, dir, projectPath)
        .then((made) => {
          setExpanded((prev) => new Set(prev).add(dir));
          refresh();
          const one = made.length === 1 ? made[0] : null;
          if (one) {
            requestAnimationFrame(() =>
              listRef.current
                ?.querySelector(`[data-file-path="${CSS.escape(one)}"]`)
                ?.scrollIntoView({ block: "nearest" }),
            );
          }
        })
        .catch((reason) => onError(`放进项目失败：${String(reason)}`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  useEffect(() => {
    if (!preview) return;
    const node = listRef.current?.querySelector(
      `[data-file-path="${CSS.escape(preview.path)}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [preview]);

  useEffect(() => {
    if (!preview) return;
    function onKey(event: KeyboardEvent) {
      if (event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        // 打字焦点（Monaco/输入框）与组合键不接管（会话列表「仅非打字焦点」同口径）；
        // 右键菜单、全局确认框开着时不换文件。别的 Modal（问 AI 等）打开时让位，
        // 但窗口预览是自己的 Modal——大窗里 ↑/↓ 步进正是它的用法，放行
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (inTypingContext(target) || menu || confirmDialogOpen()) return;
        if (!windowed && document.querySelector(".ccode-modal-backdrop")) return;
        const next = neighborFile(
          visibleFilesRef.current,
          previewPathRef.current,
          event.key === "ArrowUp" ? -1 : 1,
        );
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void (async () => {
          if (!(await confirmLoseDirty())) return;
          applyPreview(asFileEntry(next), true);
          const active = document.activeElement;
          if (
            active instanceof HTMLElement &&
            active.closest("[data-file-path]")
          ) {
            active.blur();
          }
        })();
      } else if (event.key === "Escape") {
        // 打字控件（搜索框/新建文件夹输入/Monaco）各自处理自己的 Esc；
        // 预览内、窗口态、右键菜单、全局确认框与任何 Modal 打开时都不接管
        if (
          pickedRef.current.size > 0 ||
          inTypingContext(target) ||
          windowed ||
          menu ||
          confirmDialogOpen() ||
          document.querySelector(".ccode-modal-backdrop") ||
          target?.closest("[data-project-file-preview]")
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        void closePreview();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [preview, menu, windowed]);

  function goalMarkFor(absPath: string) {
    return markForProjectFile(relativeProjectPath(projectPath, absPath), goalMarks);
  }

  function renderEntries(root: string, depth: number): ReactNode {
    const entries = cache[root] ?? [];
    return entries.map((entry) => {
      const open = expanded.has(entry.path);
      const selected = !entry.isDir && preview?.path === entry.path;
      const isPicked = !entry.isDir && picked.has(entry.path);
      return (
        <li key={entry.path}>
          <div
            className={`group relative flex min-h-9 items-center gap-2 rounded-md px-2 ${
              isPicked ? "bg-seg-sel" : selected ? "bg-hover" : "hover:bg-hover"
            } ${entry.isDir && dropDir === entry.path ? "ring-1 ring-cta-bd" : ""}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            data-drop-dir={entry.isDir ? entry.path : (parentDir(entry.path) ?? projectPath)}
            onPointerEnter={entry.isDir ? undefined : () => probeNotePair(entry.path)}
            onFocus={entry.isDir ? undefined : () => probeNotePair(entry.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                path: entry.path,
                isDir: entry.isDir,
              });
            }}
          >
            {entry.isDir ? (
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-l2"
                onClick={() => void toggle(entry.path)}
                aria-expanded={open}
              >
                <ChevronRight
                  size={13}
                  className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
                  aria-hidden="true"
                />
                {open ? (
                  <FolderOpen size={14} className="shrink-0 text-folder" />
                ) : (
                  <Folder size={14} className="shrink-0 text-folder" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {!open && <FolderCount count={entry.childCount} />}
              </button>
            ) : (
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-l2 outline-none focus:outline-none focus-visible:outline-none"
                data-file-path={entry.path}
                aria-pressed={isPicked || undefined}
                onClick={(event) => clickFile(event, entry)}
                title={entry.path}
              >
                <span className="w-[13px] shrink-0" />
                <FileTypeMark path={entry.path} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {goalMarkFor(entry.path) && (
                  <span className="shrink-0 text-micro text-warn-text">{pendingMark}</span>
                )}
                <LitPill state={litStateOf(entry.path)} />
                <FileModified iso={entry.modified} />
              </button>
            )}
            <span className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
              <button
                type="button"
                className={iconActionClass}
                title={entry.isDir ? "打开终端" : "问 AI"}
                aria-label={entry.isDir ? "打开终端" : "问 AI"}
                onClick={() => {
                  if (entry.isDir) {
                    openShellAt(entry.path);
                  } else {
                    askAi(entry);
                  }
                }}
              >
                {entry.isDir ? (
                  <SquareTerminal size={13} strokeWidth={1.8} />
                ) : (
                  <MessageSquare size={13} strokeWidth={1.8} />
                )}
              </button>
              {!entry.isDir && rowHasReader(entry.path, entry.name) && (
                <button
                  type="button"
                  className={iconActionClass}
                  title={/\.pdf$/i.test(entry.name) ? "沉浸阅读" : "沉浸阅读（笔记对照本篇 PDF）"}
                  aria-label="沉浸阅读"
                  onClick={() => openImmersive(entry)}
                >
                  <BookOpen size={13} strokeWidth={1.8} />
                </button>
              )}
              <button
                type="button"
                className={iconActionClass}
                title="显示"
                aria-label="显示"
                onClick={() =>
                  void revealItemInDir(entry.path).catch((reason) =>
                    onError(`无法定位文件：${String(reason)}`),
                  )
                }
              >
                <FolderOpen size={13} strokeWidth={1.8} />
              </button>
            </span>
          </div>
          {entry.isDir &&
            open &&
            pathWithin(entry.path, projectPath, IS_WINDOWS) &&
            renderEntries(entry.path, depth + 1)}
        </li>
      );
    });
  }

  function renderFlat(
    files: { path: string; name: string; rel?: string; modified?: string | null }[],
  ) {
    if (files.length === 0) {
      return <p className="px-2 py-3 text-xs text-l4">{query.trim() ? "没有匹配" : "没有这类文件"}</p>;
    }
    return (
      <ul className="space-y-0.5">
        {files.map((file) => (
          <li key={file.path}>
            <div
              className={`group relative flex min-h-9 items-center gap-2 rounded-md px-2 ${
                picked.has(file.path)
                  ? "bg-seg-sel"
                  : preview?.path === file.path
                    ? "bg-hover"
                    : "hover:bg-hover"
              }`}
              data-drop-dir={parentDir(file.path) ?? projectPath}
              onPointerEnter={() => probeNotePair(file.path)}
              onFocus={() => probeNotePair(file.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  path: file.path,
                  isDir: false,
                });
              }}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-l2 outline-none focus:outline-none focus-visible:outline-none"
                data-file-path={file.path}
                aria-pressed={picked.has(file.path) || undefined}
                onClick={(event) => clickFile(event, asFileEntry(file))}
                title={file.path}
              >
                <FileTypeMark path={file.path} />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                {goalMarkFor(file.path) && (
                  <span className="shrink-0 text-micro text-warn-text">{pendingMark}</span>
                )}
                <LitPill state={litStateOf(file.path)} />
                {file.rel && file.rel !== file.name && (
                  <span className="max-w-[40%] truncate font-mono text-micro text-l4">
                    {file.rel}
                  </span>
                )}
                <FileModified iso={file.modified} />
              </button>
              <span className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
                <button
                  type="button"
                  className={iconActionClass}
                  title="问 AI"
                  aria-label="问 AI"
                  onClick={() => askAi(asFileEntry(file))}
                >
                  <MessageSquare size={13} strokeWidth={1.8} />
                </button>
                {rowHasReader(file.path, file.name) && (
                  <button
                    type="button"
                    className={iconActionClass}
                    title="沉浸阅读"
                    aria-label="沉浸阅读"
                    onClick={() => openImmersive(asFileEntry(file))}
                  >
                    <BookOpen size={13} strokeWidth={1.8} />
                  </button>
                )}
                <button
                  type="button"
                  className={iconActionClass}
                  title="显示"
                  aria-label="显示"
                  onClick={() =>
                    void revealItemInDir(file.path).catch((reason) =>
                      onError(`无法定位文件：${String(reason)}`),
                    )
                  }
                >
                  <FolderOpen size={13} strokeWidth={1.8} />
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  const windowKind = preview ? projectFilePreviewKind(preview.path) : "text";
  const windowXl = windowKind === "xlsx" || windowKind === "pdf";

  /** PDF 选段「整理为笔记」（与运行页同一套，pdf-organize.ts）：精读步在跑时预填终端并跳到运行页 */
  function organizeFor(pdfPath: string) {
    return (text: string, page: number, fileName: string) =>
      organizePdfExcerpt({ pdfPath, text, page, fileName, onLaunch: () => setPage("terminal") });
  }

  /** 对照栏：左边钉住的那份（只在宽屏侧栏与窗口预览里出现） */
  function comparePane(extraClass = "") {
    if (!compare) return null;
    return (
      <section
        data-project-file-preview=""
        className={`flex h-full min-h-0 min-w-0 flex-1 flex-col ${extraClass}`}
      >
        <div className="mb-2 flex shrink-0 items-center gap-2">
          <FileTypeMark path={compare.path} />
          <span className="min-w-0 flex-1 truncate text-sm text-l1" title={compare.path}>
            {compare.name}
          </span>
          <span className="shrink-0 text-micro text-l4">对照</span>
          <button
            type="button"
            className={ghostActionClass}
            onClick={() => void closeCompare()}
            aria-label="关掉对照"
            title="关掉对照"
          >
            ×
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden overscroll-none">
          <ProjectFilePreview
            key={`cmp:${compare.path}`}
            path={compare.path}
            root={projectPath}
            onOrganize={organizeFor(compare.path)}
            onDirtyChange={(d) => {
              compareDirtyRef.current = d;
            }}
          />
        </div>
      </section>
    );
  }

  function previewChrome() {
    if (!preview) return null;
    return (
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <FileTypeMark path={preview.path} />
        <span className="min-w-0 flex-1 truncate text-sm text-l1" title={preview.path}>
          {preview.name}
        </span>
        <button
          type="button"
          className={rowActionClass}
          onClick={() => void stepPreview(-1)}
          disabled={!prevFile}
          title="上一个文件（↑）"
        >
          ↑
        </button>
        <button
          type="button"
          className={rowActionClass}
          onClick={() => void stepPreview(1)}
          disabled={!nextFile}
          title="下一个文件（↓）"
        >
          ↓
        </button>
        {filtering && (
          <button
            type="button"
            className={`${rowActionClass} gap-1`}
            onClick={() => void locateInTree(preview.path)}
            title="在目录树中显示（展开所在文件夹并退回目录视图）"
          >
            <Locate size={12} aria-hidden="true" />
            定位
          </button>
        )}
        {(wide || windowed) && !compare && (
          <button
            type="button"
            className={`${rowActionClass} gap-1`}
            onClick={() => setCompare(preview)}
            title="把这份钉在左边，再点列表里另一份文件，两份并排对照"
          >
            <Columns2 size={12} aria-hidden="true" />
            对照
          </button>
        )}
        <button
          type="button"
          className={`${rowActionClass} gap-1`}
          onClick={() => {
            // 开窗重挂编辑器（侧栏实例卸载、Modal 挂新实例）：没保存的修改寄存过去接着改（file-draft-handoff）
            moveHost(true);
          }}
        >
          <Maximize2 size={12} aria-hidden="true" />
          窗口预览
        </button>
        <button
          type="button"
          className={ghostActionClass}
          onClick={() => void closePreview()}
          aria-label="关闭预览"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full min-h-0 overflow-hidden">
        <section
          className={`flex h-full min-h-0 shrink-0 flex-col ${
            preview ? "w-full lg:w-[22rem] lg:pr-6" : "w-full"
          }`}
        >
          <div className="mb-2 flex shrink-0 flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <FileKindFilters
                filter={filter}
                counts={kindCounts}
                onChange={setFilter}
                recent={filter === "recent"}
                onToggleRecent={() =>
                  setFilter(filter === "recent" ? "all" : "recent")
                }
              />
              <button
                type="button"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
                title="刷新"
                aria-label="刷新"
                onClick={() => refresh()}
              >
                <RefreshCw size={13} strokeWidth={1.8} />
              </button>
            </div>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
              }}
              placeholder="搜索文件名或后缀（pdf / .docx）"
              className={`${searchFieldClass} w-full`}
              aria-label="搜索文件"
            />
            {picked.size > 0 && (
              <div
                className="flex flex-wrap items-center gap-1 rounded-md bg-seg-sel py-0.5 pl-2.5 pr-1"
                role="toolbar"
                aria-label="批量操作"
              >
                <span className="mr-auto text-xs text-l1">
                  已选 {picked.size} 个文件
                  <span className="ml-2 text-micro text-l4">
                    {IS_MAC ? "⌘" : "Ctrl"} 点加选，Shift 点连选
                  </span>
                </span>
                <button type="button" className={`${inlineActionClass} gap-1`} onClick={askAiPicked}>
                  <MessageSquare size={12} strokeWidth={1.8} aria-hidden="true" />
                  问 AI
                </button>
                {pickedPdfs.length > 0 && (
                  <button
                    type="button"
                    className={`${inlineActionClass} gap-1`}
                    onClick={() => void accumulatePicked()}
                  >
                    <BookmarkPlus size={12} strokeWidth={1.8} aria-hidden="true" />
                    加入积累
                  </button>
                )}
                <button
                  type="button"
                  className={`${inlineActionClass} gap-1`}
                  onClick={() => void movePicked()}
                >
                  <FolderInput size={12} strokeWidth={1.8} aria-hidden="true" />
                  移动到…
                </button>
                <button
                  type="button"
                  className={`${inlineActionClass} gap-1 hover:text-err-text`}
                  onClick={() => void deletePicked()}
                >
                  <Trash2 size={12} strokeWidth={1.8} aria-hidden="true" />
                  删除
                </button>
                <button
                  type="button"
                  className={iconActionClass}
                  aria-label="取消选择"
                  onClick={clearPicked}
                >
                  <X size={13} strokeWidth={1.8} />
                </button>
              </div>
            )}
            {nameDraft && (
              <div className="flex items-center gap-1">
                <span className="max-w-[45%] shrink-0 truncate text-xs text-l4">
                  {nameDraftPrompt(nameDraft).label}
                </span>
                <input
                  ref={nameInputRef}
                  value={nameDraft.value}
                  onChange={(event) =>
                    setNameDraft((d) => (d ? { ...d, value: event.target.value } : d))
                  }
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === "Enter") void submitNameDraft();
                    if (event.key === "Escape") setNameDraft(null);
                  }}
                  onBlur={() => void submitNameDraft()}
                  placeholder={nameDraftPrompt(nameDraft).placeholder}
                  className="min-w-0 flex-1 rounded-sm border border-field bg-inset px-1.5 py-0.5 text-xs text-l2 outline-none"
                />
              </div>
            )}
            {truncDir && (
              <p
                className="truncate px-1 text-micro text-warn-text"
                title={truncDir}
              >
                这个目录有 2000 项展示上限，部分文件没列出；用搜索查找，或进入更小的子目录。
              </p>
            )}
            {filtering && !searchHits && officeDocs.length >= 400 && (
              <p className="px-1 text-micro text-l4">
                文件较多，只列出最新 400 个。
              </p>
            )}
          </div>
          <div
            ref={listRef}
            className={`ccode-file-list min-h-0 flex-1 overflow-y-auto rounded-md outline-none ${
              dropDir && samePath(dropDir, projectPath, IS_WINDOWS) ? "ring-1 ring-cta-bd" : ""
            }`}
            aria-label="项目文件列表"
            data-files-drop-zone=""
            onContextMenu={(e) => {
              // 列表空白处右键 = 对项目根操作（新建文件 / 文件夹、打开终端）；行上的右键各自处理
              if ((e.target as HTMLElement).closest("[data-drop-dir]")) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, path: projectPath, isDir: true });
            }}
          >
            {loading ? (
              <p className="px-2 py-3 text-xs text-l4">读取文件…</p>
            ) : filtering ? (
              renderFlat(filteredFiles)
            ) : cache[projectPath]?.length ? (
              <ul className="space-y-0.5">{renderEntries(projectPath, 0)}</ul>
            ) : (
              <p className="px-2 py-3 text-xs text-l4">项目目录为空</p>
            )}
          </div>
        </section>
        {preview && !windowed && wide && compare && comparePane(`mr-3 ${projectWellClass}`)}
        {preview && !windowed && wide && (
          <section
            data-project-file-preview=""
            className={`ml-0 hidden h-full min-h-0 min-w-0 flex-1 flex-col lg:flex ${projectWellClass}`}
          >
            {previewChrome()}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden overscroll-none">
              <ProjectFilePreview
                key={preview.path}
                path={preview.path}
                root={projectPath}
                onOpenFile={(p) => void openPath(p)}
                onOpenReader={
                  supportsImmersiveReader(preview.name)
                    ? () => openImmersive(preview)
                    : undefined
                }
                onOrganize={organizeFor(preview.path)}
                onDirtyChange={(d) => {
                  dirtyRef.current = d;
                }}
              />
            </div>
          </section>
        )}
      </div>
      {preview && !windowed && !wide && (
        <section
          data-project-file-preview=""
          className={`mt-4 lg:hidden ${projectWellClass}`}
        >
          {previewChrome()}
          <div className="flex h-[70vh] min-h-0 flex-col overflow-hidden overscroll-none">
            <ProjectFilePreview
              key={preview.path}
              path={preview.path}
              root={projectPath}
              onOpenFile={(p) => void openPath(p)}
              onOpenReader={
                supportsImmersiveReader(preview.name)
                  ? () => openImmersive(preview)
                  : undefined
              }
              onOrganize={organizeFor(preview.path)}
              onDirtyChange={(d) => {
                dirtyRef.current = d;
              }}
            />
          </div>
        </section>
      )}
      {preview && windowed && (
        <Modal
          open
          title={preview.name}
          onClose={() => {
            // 关窗退回侧栏预览（重挂载）：没保存的修改一起带回来
            moveHost(false);
          }}
          overflow="hidden"
          size={windowXl || compare ? "xl" : "lg"}
          panelClassName={
            windowXl || compare
              ? "h-[min(88vh,920px)] max-w-[min(96vw,1280px)]"
              : "h-[80vh] max-w-4xl"
          }
          contentClassName="flex min-h-0 flex-1 flex-row gap-3 overflow-hidden overscroll-none"
        >
          {compare && comparePane()}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="mb-2 flex shrink-0 items-center gap-1">
            {!compare && (
              <button
                type="button"
                className={`${rowActionClass} gap-1`}
                onClick={() => setCompare(preview)}
                title="把这份钉在左边，再按 ↑ / ↓ 或点列表换另一份，两份并排对照"
              >
                <Columns2 size={12} aria-hidden="true" />
                对照
              </button>
            )}
            <button
              type="button"
              className={`${rowActionClass} ml-auto`}
              onClick={() => void stepPreview(-1)}
              disabled={!prevFile}
              title="上一个文件（↑）"
            >
              ↑
            </button>
            <button
              type="button"
              className={rowActionClass}
              onClick={() => void stepPreview(1)}
              disabled={!nextFile}
              title="下一个文件（↓）"
            >
              ↓
            </button>
          </div>
          <ProjectFilePreview
            key={preview.path}
            path={preview.path}
            root={projectPath}
            onOpenFile={(p) => void openPath(p)}
            onOpenReader={
              supportsImmersiveReader(preview.name)
                ? () => openImmersive(preview)
                : undefined
            }
            onOrganize={organizeFor(preview.path)}
            onDirtyChange={(d) => {
              dirtyRef.current = d;
            }}
          />
          </div>
        </Modal>
      )}
      {menu && !menu.isDir && picked.has(menu.path) && picked.size > 1 && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: `问 AI（${picked.size} 个文件）`,
              icon: MessageSquare,
              onSelect: askAiPicked,
            },
            ...(pickedPdfs.length
              ? [
                  {
                    label: `加入积累（${pickedPdfs.length} 篇 PDF）`,
                    icon: BookmarkPlus,
                    onSelect: () => void accumulatePicked(),
                  },
                ]
              : []),
            { label: "移动到…", icon: FolderInput, onSelect: () => void movePicked() },
            { label: "取消选择", icon: X, onSelect: clearPicked },
            { separator: true },
            {
              icon: Trash2,
              label: `删除 ${picked.size} 个文件`,
              danger: true,
              onSelect: () => void deletePicked(),
            },
          ]}
        />
      )}
      {menu && !(!menu.isDir && picked.has(menu.path) && picked.size > 1) && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(menu.isDir
              ? [
                  {
                    label: "在此打开新终端",
                    icon: SquareTerminal,
                    onSelect: () => openShellAt(menu.path),
                  },
                  {
                    label: "新建文件",
                    icon: FilePlus,
                    onSelect: () => startNameDraft({ kind: "file", dir: menu.path, value: "" }),
                  },
                  {
                    label: "新建文件夹",
                    icon: FolderPlus,
                    onSelect: () => startNameDraft({ kind: "folder", dir: menu.path, value: "" }),
                  },
                  { separator: true },
                ]
              : []),
            ...(samePath(menu.path, projectPath, IS_WINDOWS)
              ? []
              : [
                  {
                    label: "重命名",
                    icon: Pencil,
                    onSelect: () => {
                      menuIsDirRef.current = menu.isDir;
                      startNameDraft({ kind: "rename", path: menu.path, value: baseName(menu.path) });
                    },
                  },
                  {
                    label: "复制一份",
                    icon: CopyPlus,
                    onSelect: () => void duplicateMenuTarget(menu),
                  },
                  {
                    label: "移动到…",
                    icon: FolderInput,
                    onSelect: () => void moveMenuTarget(menu),
                  },
                  ...(menu.isDir
                    ? []
                    : [
                        {
                          label: `选择（${IS_MAC ? "⌘" : "Ctrl"} 点加选）`,
                          icon: SquareCheck,
                          onSelect: () => addToPicked(menu.path),
                        },
                      ]),
                  { separator: true },
                ]),
            {
              label: revealFolderLabel(IS_MAC, IS_WINDOWS),
              icon: FolderOpen,
              onSelect: () => {
                void revealItemInDir(menu.path).catch((e) =>
                  onError(String(e)),
                );
              },
            },
            {
              label: "复制路径",
              icon: Copy,
              onSelect: () => {
                void navigator.clipboard
                  .writeText(menu.path)
                  .catch(() => onError("复制路径失败"));
              },
            },
            ...(samePath(menu.path, projectPath, IS_WINDOWS)
              ? []
              : [
                  {
                    icon: Trash2,
                    label: menu.isDir ? "删除文件夹" : "删除文件",
                    danger: true,
                    onSelect: () => void deleteMenuTarget(menu),
                  },
                ]),
          ]}
        />
      )}
    </>
  );
}
