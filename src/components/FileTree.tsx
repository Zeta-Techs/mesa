import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BookOpen,
  Copy,
  File,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import { FoldMark, LoadingRows } from "./PageFrame";
import { isScratchCwd } from "../quick-chat";
import {
  hasChangedInside,
  normSep,
  normalizeStatusKeys,
  parentDir,
  pathWithin,
  revealFolderLabel,
} from "../path-utils";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { directoryErrorMessage } from "../terminal-cwd";

export interface SearchResultDto {
  path: string;
  name: string;
  isDir: boolean;
  /** 相对搜索根的路径（后端算好，直接展示） */
  rel: string;
  /** 最近修改时间（ISO） */
  modified?: string | null;
}

export interface DirEntryDto {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: string | null;
  /** 家目录直下的系统目录（macOS Library 等）：置灰降噪，交互不受影响 */
  isSystem?: boolean;
}

/** git 状态字母配色（M 改 / A·?? 增 / D 删 / R 改名） */
const STATUS_COLOR: Record<string, string> = {
  M: "text-warn-text",
  A: "text-ok-text",
  "??": "text-ok-text",
  D: "text-err-text",
  R: "text-l3",
};

/** git 状态字母的悬停白话说明（双层呈现：字母徽标供程序员扫读，悬浮给不懂 git 的用户） */
const STATUS_WORD: Record<string, string> = {
  M: "有未保存的改动",
  A: "新文件（待提交）",
  "??": "新文件",
  D: "已删除",
  R: "已重命名",
  U: "未合并（冲突）",
};

function basenameOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 搜索结果是否落在隐藏目录/文件上（`.ccode` 本来就显示，不算） */
function relNeedsHidden(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => seg.startsWith(".") && seg !== "." && seg !== ".." && seg !== ".ccode");
}

/** FileTreeNode 的下传上下文：父组件需保证这些回调/引用稳定，memo 才有效 */
interface TreeNodeCtx {
  root: string;
  expanded: Set<string>;
  cache: Record<string, DirEntryDto[]>;
  /** 键已 normalizeStatusKeys 归一（/ 分隔） */
  gitMap: Record<string, string>;
  highlight: string | null;
  load: (path: string) => Promise<void>;
  toggle: (path: string) => void;
  visibleFiles: DirEntryDto[];
  onOpenFile: (path: string, name: string, root: string, files: DirEntryDto[]) => void;
  onOpenTerminal: (path: string) => void;
  onMenu: (menu: { x: number; y: number; path: string; isDir: boolean }) => void;
}

/**
 * 树节点（模块级 + memo）：定义在 FileTree 外的稳定组件类型，
 * 父组件因搜索框输入等无关状态重渲染时不会整树 remount / 重渲染。
 */
const FileTreeNode = memo(function FileTreeNode({
  entry,
  depth,
  ctx,
}: {
  entry: DirEntryDto;
  depth: number;
  ctx: TreeNodeCtx;
}) {
  const { expanded, cache, gitMap, highlight, root, load, toggle } = ctx;
  const rowRef = useRef<HTMLDivElement>(null);
  // 搜索定位到这一项：滚进可视区（树已逐级展开）
  useEffect(() => {
    if (highlight === entry.path) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlight, entry.path]);
  const isOpen = expanded.has(entry.path);
  const children = cache[entry.path];
  const gitStatus = entry.isDir ? undefined : gitMap[normSep(entry.path)];
  const dirtyDir = entry.isDir && hasChangedInside(gitMap, entry.path);
  // 展开才读取子目录（懒加载）
  useEffect(() => {
    if (entry.isDir && isOpen && !children) void load(entry.path);
  }, [isOpen, entry.isDir, entry.path, children, load]);
  return (
    <>
      <div
        ref={rowRef}
        onClick={() =>
          entry.isDir
            ? toggle(entry.path)
            : ctx.onOpenFile(entry.path, entry.name, root, ctx.visibleFiles)
        }
        onContextMenu={(e) => {
          e.preventDefault();
          ctx.onMenu({ x: e.clientX, y: e.clientY, path: entry.path, isDir: entry.isDir });
        }}
        title={`${entry.isDir ? `${entry.path}\n单击展开或收起；右键可在这里打开终端、新建文件夹` : `${entry.path}\n单击在右边预览；右键看更多操作`}${entry.isSystem ? "\n系统目录" : ""}`}
        className={`group flex cursor-pointer items-center gap-1 py-0.5 pr-2 text-xs hover:bg-hover ${
          highlight === entry.path ? "bg-white/10" : ""
        } ${entry.isSystem ? "opacity-50" : ""}`}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <span className="inline-flex w-7 shrink-0 justify-center">
          {entry.isDir ? (
            <button
              type="button"
              aria-label={isOpen ? `收起 ${entry.name}` : `展开 ${entry.name}`}
              onClick={(e) => {
                e.stopPropagation();
                toggle(entry.path);
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1"
            >
              <FoldMark open={isOpen} />
            </button>
          ) : null}
        </span>
        {entry.isDir ? (
          isOpen ? (
            <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-folder" />
          ) : (
            <FolderClosed aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-folder" />
          )
        ) : (
          <File aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l4" />
        )}
        <span className="truncate text-l3">{entry.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {gitStatus && (
            <span
              className={`font-mono text-micro opacity-75 ${STATUS_COLOR[gitStatus] ?? "text-l3"}`}
              title={STATUS_WORD[gitStatus] ?? gitStatus}
            >
              {gitStatus === "??" ? "?" : gitStatus}
            </span>
          )}
          {dirtyDir && (
            <span className="text-l4" title="里面有未保存的改动">
              ●
            </span>
          )}
        </span>
      </div>
      {entry.isDir && isOpen && !children && (
        <div
          className="py-1"
          style={{ paddingLeft: 6 + (depth + 1) * 12 }}
        >
          <span className="block h-1.5 w-16 animate-pulse rounded-sm bg-inset" />
        </div>
      )}
      {entry.isDir &&
        isOpen &&
        children?.map((c) => (
          <FileTreeNode key={c.path} entry={c} depth={depth + 1} ctx={ctx} />
        ))}
    </>
  );
});

/** 路径归属（workspaces::path_context）：根目录落在主仓库还是工作区分支 */
interface PathContext {
  kind: "worktree" | "main" | "other";
  workspaceName: string | null;
  branch: string | null;
}

/** 栏头写的目录名：随手聊目录写「随手聊」，主目录写「主目录」，其余写文件夹名 */
function rootLabel(root: string): string {
  const p = root.trim();
  if (!p || p === "~") return "主目录";
  if (isScratchCwd(p, IS_WINDOWS)) return "随手聊";
  return basenameOf(p);
}

/**
 * 文件树（借鉴 VS Code Explorer 的懒加载）：根就是正看着的这段对话的目录，跟着对话走
 * （2026-10-24 用户：「左侧的这个上下文重新做一下，没必要的就删了」）。栏头一行写目录名（在工作区分支里标「分支」）+ 动作，
 * 下面搜索框和树。单击目录 = 原地展开 / 收起；单击文件 = 右边预览；右键 = 在此打开新终端 / 新建文件夹 / 沉浸阅读 /
 * 在访达中显示 / 复制路径 / 删除。搜索命中后在树里逐级展开到那一项并亮一下，不另换根。
 * 同日撤掉：「最近项目」⌄ 下拉与「进行中的项目」区（切项目、切对话归侧栏项目树）、悬停「进入」钻取与「← 上一级」
 * （浏览出了对话目录，树就和对话对不上）、主项目 ⇄ 分支互切（一段对话只属于一个目录）、悬停 ↗（右键里有）。
 */
function FileTree({
  cwd,
  showHidden,
  refreshKey,
  onOpenFile,
  onOpenTerminal,
  onOpenReader,
  onFsEvent,
  onRootChange,
  onRootNavigated,
  onRecoverDirectory,
  onShowHidden,
  actions,
}: {
  cwd: string;
  showHidden: boolean;
  /** 定位到隐藏路径时自动打开「显示隐藏文件」 */
  onShowHidden?: (show: boolean) => void;
  refreshKey: number;
  onOpenFile: (path: string, name: string, root: string, files: DirEntryDto[]) => void;
  onOpenTerminal: (path: string) => void;
  /** PDF/md 右键「⛶ 沉浸阅读」（批次 B1 阅读区入口；v3.98 起 md 笔记走 reader_for_note 配对 PDF）；
      不给则不显示该菜单项 */
  onOpenReader?: (path: string, name: string, root: string) => void;
  /** 文件系统变化回调（fs-changed 防抖后触发，供 GitPanel 等联动刷新） */
  onFsEvent?: () => void;
  /** 根目录切换前通知；返回/resolve false 时保留当前根（用于保护未保存预览，确认框为异步）。 */
  onRootChange?: (path: string) => boolean | Promise<boolean>;
  /** 根目录切换成功后通知（供改动面板等跟随树根；与 onRootChange 守卫配对，只在真切换后触发） */
  onRootNavigated?: (path: string) => void;
  /** 当前根不可用时，打开终端的目录选择器 */
  onRecoverDirectory?: () => void;
  /** 栏头行尾的按钮（显示隐藏文件 / 刷新 / 收起，由运行页给） */
  actions?: ReactNode;
}) {
  // 根跟着正看着的那段对话的目录；切到别的对话时换根（未保存的预览可以拦下）
  const [root, setRoot] = useState(cwd);
  const rootRef = useRef(root);
  rootRef.current = root;
  const onRootChangeRef = useRef(onRootChange);
  onRootChangeRef.current = onRootChange;
  const onRootNavigatedRef = useRef(onRootNavigated);
  onRootNavigatedRef.current = onRootNavigated;
  const [cache, setCache] = useState<Record<string, DirEntryDto[]>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [error, setError] = useState<string | null>(null);
  const [errorPath, setErrorPath] = useState<string | null>(null);
  const errorPathRef = useRef<string | null>(null);
  errorPathRef.current = errorPath;
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const [gitMap, setGitMap] = useState<Record<string, string>>({});
  // 当前根的路径归属（主仓库/工作区分支）；other 或查询失败不显示徽标
  const [ctx, setCtx] = useState<PathContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<PathContext>("path_context", { path: root })
      .then((c) => {
        if (!cancelled) setCtx(c.kind === "other" ? null : c);
      })
      .catch(() => {
        if (!cancelled) setCtx(null);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  // 切换对话（cwd 变化）时换根
  useEffect(() => {
    if (cwd === rootRef.current) return;
    void (async () => {
      if ((await onRootChangeRef.current?.(cwd)) === false) return;
      setRoot(cwd);
      onRootNavigatedRef.current?.(cwd);
    })();
  }, [cwd]);

  const load = useCallback(
    async (path: string) => {
      const treeRootAtStart = rootRef.current;
      try {
        const entries = await invoke<DirEntryDto[]>("list_dir", { path, showHidden });
        setCache((prev) => ({ ...prev, [path]: entries }));
        if (entries.length >= 2000 && treeRootAtStart === rootRef.current) {
          setError("此目录达到 2000 项展示上限，部分文件未列出。请用搜索查找。");
          setErrorPath(path);
          return;
        }
        if (
          treeRootAtStart === rootRef.current &&
          (path === treeRootAtStart || errorPathRef.current === path)
        ) {
          setError(null);
          setErrorPath(null);
        }
      } catch (e) {
        // 根目录切换后，旧树请求的迟到错误不能污染当前目录；
        // 当前树的根/子目录都显示同一套可恢复的人话。
        if (treeRootAtStart !== rootRef.current) return;
        setError(directoryErrorMessage(e, path));
        setErrorPath(path);
      }
    },
    [showHidden],
  );

  // git 装饰：变更文件状态表（非仓库 → 空）
  // Windows 下后端键是混合分隔符的 join 路径，归一成 / 后与 entry.path 同口径匹配
  const loadGitMap = useCallback(async () => {
    try {
      setGitMap(
        normalizeStatusKeys(
          await invoke<Record<string, string>>("git_status_map", { cwd: root }),
        ),
      );
    } catch {
      setGitMap({});
    }
  }, [root]);
  useEffect(() => {
    void loadGitMap();
  }, [loadGitMap, refreshKey]);

  // 文件监听（P4）：根目录变化时重挂 watcher；fs-changed → 缓存失效 + git 装饰刷新
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let watchId: string | null = null;
    void (async () => {
      try {
        watchId = await invoke<string>("watch_dir", { path: root });
        if (cancelled) {
          invoke("unwatch_dir", { id: watchId }).catch(() => {});
          return;
        }
        unlisten = await listen(`fs-changed-${watchId}`, () => {
          // 就地重载根与已展开目录（不清缓存，旧内容保持显示直到新数据到达，避免闪烁）
          for (const p of [root, ...expandedRef.current]) void load(p);
          void loadGitMap();
          onFsEvent?.();
        });
      } catch {
        // 监听失败（目录不可读等）退回手动刷新
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      if (watchId) invoke("unwatch_dir", { id: watchId }).catch(() => {});
    };
  }, [root, load, loadGitMap, onFsEvent]);

  // 换根：清空缓存与展开状态
  useEffect(() => {
    setCache({});
    setExpanded(new Set());
    setError(null);
    setErrorPath(null);
  }, [root]);

  // 显隐切换只清缓存：已展开的目录保持打开并按新口径重载
  useEffect(() => {
    setCache({});
  }, [showHidden]);

  // 手动刷新：只清缓存，展开状态保留（展开的节点会自动重载）
  useEffect(() => {
    if (refreshKey > 0) setCache({});
  }, [refreshKey]);

  // 根目录缓存缺失时加载
  useEffect(() => {
    if (!cache[root]) void load(root);
  }, [cache, root, load]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultDto[] | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 卸载时清掉高亮定时器，避免组件销毁后 setState
  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    [],
  );
  const [newFolderFor, setNewFolderFor] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");

  async function submitNewFolder() {
    const parent = newFolderFor;
    const name = newFolderName.trim();
    setNewFolderFor(null);
    setNewFolderName("");
    if (!parent || !name) return;
    try {
      await invoke("fs_create_dir", { root: parent, name });
      for (const p of [root, ...expandedRef.current]) void load(p);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 搜索结果定位：在树里从根逐级展开到那一项所在的文件夹，亮一下（不打开预览、不换根） */
  async function locate(r: SearchResultDto) {
    if (relNeedsHidden(r.rel) && !showHidden) onShowHidden?.(true);
    const target = r.isDir ? r.path : parentDir(r.path);
    const chain: string[] = [];
    for (let p = target, i = 0; p && i < 64; p = parentDir(p), i++) {
      if (!pathWithin(p, root, IS_WINDOWS) || normSep(p) === normSep(root)) break;
      chain.unshift(p);
    }
    for (const dir of chain) if (!cacheRef.current[dir]) await load(dir);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const dir of chain) next.add(dir);
      return next;
    });
    setResults(null);
    setQuery("");
    setHighlight(r.path);
    // 连续定位先清旧定时器，避免旧计时提前熄灭新高亮
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlight(null), 2000);
  }

  // 搜索防抖：300ms 后在这段对话的目录内按文件名查找
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      invoke<SearchResultDto[]>("search_files", { root, query: q, showHidden })
        .then(setResults)
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query, root, showHidden]);
  const children = cache[root];
  const visibleFiles = useMemo(() => {
    const result: DirEntryDto[] = [];
    const walk = (entries: DirEntryDto[] | undefined) => {
      for (const entry of entries ?? []) {
        if (entry.isDir) {
          if (expanded.has(entry.path)) walk(cache[entry.path]);
        } else result.push(entry);
      }
    };
    walk(children);
    return result;
  }, [cache, children, expanded]);
  // 树节点上下文：useMemo 保持身份稳定，搜索输入等无关状态变化时令 memo 节点跳过重渲染
  const nodeCtx = useMemo<TreeNodeCtx>(
    () => ({
      root,
      expanded,
      cache,
      gitMap,
      highlight,
      load,
      toggle,
      visibleFiles,
      onOpenFile,
      onOpenTerminal,
      onMenu: setMenu,
    }),
    [root, expanded, cache, gitMap, highlight, load, toggle, visibleFiles, onOpenFile, onOpenTerminal],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 栏头：这段对话的目录（在工作区分支里时标「分支」；主仓库是常态，不标——没事不画点）+ 行尾动作 */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 pl-2.5 pr-1" title={root}>
        <span className="min-w-0 truncate text-xs font-medium text-l2">{rootLabel(root)}</span>
        {ctx?.kind === "worktree" && (
          <span
            className="flex shrink-0 items-center gap-1 text-micro text-l3"
            title={`工作区「${ctx.workspaceName}」的工作树，改动属于分支 ${ctx.branch}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ok-text" />
            分支
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center">{actions}</span>
      </div>
      {/* 文件名搜索（无描边，底色分层） */}
      <div className="shrink-0 px-2 pb-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          placeholder="搜文件名或后缀（pdf / .docx）"
          aria-label="搜这个目录里的文件"
          className="w-full rounded-md bg-inset px-2 py-1 text-xs text-l2 outline-none transition-colors placeholder:text-l4 focus:bg-raised"
        />
      </div>
      {newFolderFor && (
        <div className="flex shrink-0 items-center gap-1 px-2 py-1">
          <span className="shrink-0 text-xs text-l4">新建于 {basenameOf(newFolderFor)}:</span>
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNewFolder();
              if (e.key === "Escape") setNewFolderFor(null);
            }}
            onBlur={() => void submitNewFolder()}
            placeholder="文件夹名称"
            className="min-w-0 flex-1 rounded-sm border border-field bg-inset px-1.5 py-0.5 text-xs text-l2 outline-none"
          />
        </div>
      )}
      {error && (
        <div className="mx-2 my-1 shrink-0 rounded-md border border-field ccode-well px-2 py-1.5 text-xs">
          <p className="text-warn-text">{error}</p>
          {errorPath === root && onRecoverDirectory && (
            <button
              type="button"
              onClick={onRecoverDirectory}
              className="mt-1 rounded-sm border border-field bg-inset px-1.5 py-0.5 text-micro text-l2 hover:bg-hover"
            >
              选择新目录
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto pb-1">
        {results !== null ? (
          results.length === 0 ? (
            <p className="px-2 py-1 text-xs text-l4">无匹配文件</p>
          ) : (
            results.map((r) => (
              <div
                key={r.path}
                onClick={() => void locate(r)}
                title={`${r.path}\n点一下在树里找到它`}
                className="cursor-pointer truncate px-2 py-0.5 text-xs text-l2 hover:bg-hover"
              >
                {r.isDir ? (
                  <FolderClosed
                    aria-hidden="true"
                    className="mr-1 inline-block h-3.5 w-3.5 text-folder"
                  />
                ) : (
                  <File
                    aria-hidden="true"
                    className="mr-1 inline-block h-3.5 w-3.5 text-l4"
                  />
                )}
                {r.rel}
              </div>
            ))
          )
        ) : !children ? (
          <div className="px-2">
            <LoadingRows compact />
          </div>
        ) : children.length === 0 ? (
          <p className="px-2 py-1 text-xs text-l4">空目录</p>
        ) : (
          children.map((c) => <FileTreeNode key={c.path} entry={c} depth={0} ctx={nodeCtx} />)
        )}
      </div>

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
                    onSelect: () => onOpenTerminal(menu.path),
                  },
                  {
                    label: "新建文件夹",
                    icon: FolderPlus,
                    onSelect: async () => {
                      setNewFolderFor(menu.path);
                    },
                  },
                ]
              : []),
            ...(!menu.isDir && /\.(pdf|md)$/i.test(menu.path) && onOpenReader
              ? [
                  {
                    label: "沉浸阅读",
                    icon: BookOpen,
                    onSelect: () =>
                      onOpenReader(menu.path, basenameOf(menu.path), root),
                  },
                ]
              : []),
            { separator: true },
            {
              label: revealFolderLabel(IS_MAC, IS_WINDOWS),
              icon: FolderOpen,
              onSelect: () => {
                void revealItemInDir(menu.path).catch((e) =>
                  setError(String(e)),
                );
              },
            },
            {
              label: "复制路径",
              icon: Copy,
              onSelect: () => {
                void navigator.clipboard
                  .writeText(menu.path)
                  .catch(() => setError("复制路径失败"));
              },
            },
            {
              icon: Trash2,
              danger: true,
              label: menu.isDir ? "删除目录" : "删除文件",
              onSelect: async () => {
                if (
                  !(await confirmDialog(
                    `删除「${menu.path}」${menu.isDir ? "（含全部内容）" : ""}？将移入系统回收站。`,
                    { danger: true },
                  ))
                )
                  return;
                try {
                  await invoke("fs_delete_path", { path: menu.path, root });
                  for (const p of [root, ...expandedRef.current]) void load(p);
                } catch (e) {
                  setError(String(e));
                }
              },
            },
          ]}
        />
      )}
    </div>
  );
}

/** memo：父级重渲染（启动栏状态变化等）不级联到文件树 */
export default memo(FileTree);
