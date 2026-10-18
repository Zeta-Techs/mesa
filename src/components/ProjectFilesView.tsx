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
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  Locate,
  Maximize2,
  MessageSquare,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import { beginAskAi } from "./AskAiModal";
import type { DirEntryDto, SearchResultDto } from "./FileTree";
import {
  ghostActionClass,
  iconActionClass,
  projectWellClass,
  rowActionClass,
  searchFieldClass,
} from "./PageFrame";
import FileKindFilters from "./FileKindFilters";
import ContextMenu from "./ContextMenu";
import { confirmDialog, confirmDialogOpen } from "./ConfirmDialog";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { pathWithin, revealFolderLabel, samePath } from "../path-utils";
import { absTime, relTime } from "../rel-time";
import {
  ancestorDirsToReveal,
  fileMatchesProjectFilter,
  flattenVisibleFiles,
  inTypingContext,
  neighborFile,
  projectFilePreviewKind,
  supportsImmersiveReader,
  type ProjectFileFilter,
} from "../project-files";
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
import { Modal } from "./Modal";

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
      x.modified !== y.modified
    ) {
      return false;
    }
  }
  return true;
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
  const setEnterCwdReq = useAppStore((s) => s.setEnterCwdReq);
  const [cache, setCache] = useState<EntryCache>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<DirEntryDto | null>(null);
  const [windowed, setWindowed] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectFileFilter>("all");
  const [officeDocs, setOfficeDocs] = useState<OfficeDocDto[]>([]);
  const [searchHits, setSearchHits] = useState<SearchResultDto[] | null>(null);
  const [goalMarks, setGoalMarks] = useState<
    { relative: string; goalName: string; pending: boolean }[]
  >([]);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    path: string;
    isDir: boolean;
  } | null>(null);
  const [newFolderFor, setNewFolderFor] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  /** 命中 2000 项展示上限的目录（点名提示；低于上限的重载解除） */
  const [truncDir, setTruncDir] = useState<string | null>(null);
  const pendingMark = goalReviewCopy(workMode).fileMark;
  const listRef = useRef<HTMLDivElement>(null);
  /** 当前预览的未保存编辑（编辑器上报；换/关预览经 confirmLoseDirty 确认） */
  const dirtyRef = useRef(false);

  /** quiet=true 给监听器的后台重载用：失败不弹错（目录多半已被 agent 删/改名），
   *  并把该目录从展开集合与缓存里收掉——否则每轮 fs 事件都重拉死路径、反复报错 */
  const load = useCallback(
    async (path: string, quiet = false) => {
      try {
        const entries = await invoke<DirEntryDto[]>("list_dir", {
          path,
          showHidden: false,
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

  useEffect(() => {
    setCache({});
    setExpanded(new Set());
    setPreview(null);
    setWindowed(false);
    setQuery("");
    setFilter("all");
    setSearchHits(null);
    // 截断提示/右键菜单/新建输入也是项目局部状态，切课题一起清；
    // 脏标志不清会带着旧项目的「没保存修改」去误拦新项目
    setTruncDir(null);
    setMenu(null);
    setNewFolderFor(null);
    setNewFolderName("");
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
  }, [load, projectPath, reloadOffice, workMode]);

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
        });
      } catch {
        // 目录不可读等：静默退回手动刷新
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      if (watchId) invoke("unwatch_dir", { id: watchId }).catch(() => {});
    };
  }, [projectPath, load, reloadOffice]);

  /** 刷新 = 根目录 + 已展开目录全部重拉（旧实现只重载根，子目录永远停在第一次展开） */
  function refresh() {
    for (const p of [projectPath, ...expandedRef.current]) void load(p);
    reloadOffice(projectPath);
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

  async function pickFile(entry: DirEntryDto) {
    if (preview && samePath(preview.path, entry.path, IS_WINDOWS)) {
      setWindowed(false);
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

  async function submitNewFolder() {
    const parent = newFolderFor;
    const name = newFolderName.trim();
    setNewFolderFor(null);
    setNewFolderName("");
    if (!parent || !name) return;
    try {
      await invoke("fs_create_dir", { root: parent, name });
      // 新夹落在被右键的目录里：展开它才看得见
      setExpanded((prev) => new Set(prev).add(parent));
      refresh();
    } catch (reason) {
      onError(`新建文件夹失败：${String(reason)}`);
    }
  }

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
      return (
        <li key={entry.path}>
          <div
            className={`group relative flex min-h-9 items-center gap-2 rounded-md px-2 ${
              selected ? "bg-hover" : "hover:bg-hover"
            }`}
            style={{ paddingLeft: 8 + depth * 16 }}
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
                <span className="truncate">{entry.name}</span>
              </button>
            ) : (
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-l2 outline-none focus:outline-none focus-visible:outline-none"
                data-file-path={entry.path}
                onClick={() => void pickFile(entry)}
                title={entry.path}
              >
                <span className="w-[13px] shrink-0" />
                <FileTypeMark path={entry.path} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {goalMarkFor(entry.path) && (
                  <span className="shrink-0 text-micro text-warn-text">{pendingMark}</span>
                )}
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
                    setEnterCwdReq(entry.path);
                    setPage("terminal");
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
              {supportsImmersiveReader(entry.name) && (
                <button
                  type="button"
                  className={iconActionClass}
                  title={
                    /\.pdf$/i.test(entry.name)
                      ? "沉浸阅读"
                      : "沉浸阅读（自动配对本篇 PDF；无配对时进不去）"
                  }
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
                preview?.path === file.path ? "bg-hover" : "hover:bg-hover"
              }`}
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
                onClick={() => void pickFile(asFileEntry(file))}
                title={file.path}
              >
                <FileTypeMark path={file.path} />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                {goalMarkFor(file.path) && (
                  <span className="shrink-0 text-micro text-warn-text">{pendingMark}</span>
                )}
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
                {supportsImmersiveReader(file.name) && (
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
        <button
          type="button"
          className={`${rowActionClass} gap-1`}
          onClick={() => {
            // 开窗同样重挂编辑器（侧栏实例卸载、Modal 挂新实例）：脏编辑先过确认
            void (async () => {
              if (!(await confirmLoseDirty())) return;
              setWindowed(true);
            })();
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
            {newFolderFor && (
              <div className="flex items-center gap-1">
                <span className="shrink-0 text-xs text-l4">
                  新建于 {newFolderFor.split(/[\\/]/).pop()}:
                </span>
                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(event) => setNewFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submitNewFolder();
                    if (event.key === "Escape") {
                      setNewFolderFor(null);
                      setNewFolderName("");
                    }
                  }}
                  onBlur={() => void submitNewFolder()}
                  placeholder="文件夹名称"
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
            className="ccode-file-list min-h-0 flex-1 overflow-y-auto outline-none"
            aria-label="项目文件列表"
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
        {preview && !windowed && (
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
                onDirtyChange={(d) => {
                  dirtyRef.current = d;
                }}
              />
            </div>
          </section>
        )}
      </div>
      {preview && !windowed && (
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
            // 关窗会退回侧栏预览（重挂载、重读盘）：脏编辑先经确认
            void (async () => {
              if (!(await confirmLoseDirty())) return;
              setWindowed(false);
            })();
          }}
          overflow="hidden"
          size={windowXl ? "xl" : "lg"}
          panelClassName={
            windowXl
              ? "h-[min(88vh,920px)] max-w-[min(96vw,1280px)]"
              : "h-[80vh] max-w-4xl"
          }
          contentClassName="flex min-h-0 flex-1 flex-col overflow-hidden overscroll-none"
        >
          <div className="mb-2 flex shrink-0 items-center gap-1">
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
            onDirtyChange={(d) => {
              dirtyRef.current = d;
            }}
          />
        </Modal>
      )}
      {menu && (
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
                    onSelect: () => {
                      setEnterCwdReq(menu.path);
                      setPage("terminal");
                    },
                  },
                  {
                    label: "新建文件夹",
                    icon: FolderPlus,
                    onSelect: () => setNewFolderFor(menu.path),
                  },
                  { separator: true },
                ]
              : []),
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
            {
              icon: Trash2,
              label: menu.isDir ? "删除文件夹" : "删除文件",
              danger: true,
              onSelect: () => void deleteMenuTarget(menu),
            },
          ]}
        />
      )}
    </>
  );
}
