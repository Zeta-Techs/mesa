import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Copy, ExternalLink, FolderOpen, FolderTree, History, MoreHorizontal } from "lucide-react";
import { ConfirmDialogHost, confirmDialog } from "../components/ConfirmDialog";
import ContextMenu, { type ContextMenuItem } from "../components/ContextMenu";
import { ghostActionClass, LoadingRows } from "../components/PageFrame";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { pathWithin, revealFolderLabel, samePath } from "../path-utils";
import { neighborFile, type ProjectFilePaneFile } from "../project-file-pane";
import { DEFAULT_THEME_ID, isCustomThemeId, isLightTheme } from "../themes";
import {
  applyCustomThemeVars,
  clearCustomThemeVars,
  DEFAULT_CUSTOM_THEME,
  deriveThemeTokens,
  normalizeCustomTheme,
  type CustomThemeSeeds,
} from "../custom-theme";

// 预览组件按需加载：入口块不静态打包 monaco / pdfjs / mermaid / mammoth / xlsx（entry-guard 守卫）
const ProjectFilePreview = lazy(() => import("../components/ProjectFilePreview"));
const FileVersionsPanel = lazy(() =>
  import("../components/FileVersions").then((m) => ({ default: m.FileVersionsPanel })),
);
const FileSelectionTree = lazy(() =>
  import("../components/FileTree").then((m) => ({ default: m.FileSelectionTree })),
);

export interface FileViewerState {
  projectRoot: string;
  root: string;
  path: string;
  name: string;
  rel?: string;
  list?: ProjectFilePaneFile[];
  line?: number;
  showList?: boolean;
  from?: string;
  nonce: number;
}

interface ViewerSettings {
  theme?: string;
  customTheme?: CustomThemeSeeds | null;
  themeFollowSystem?: boolean;
}

function applyViewerTheme(s: ViewerSettings) {
  const root = document.documentElement;
  clearCustomThemeVars(root);
  if (isCustomThemeId(s.theme ?? "")) {
    const derived = deriveThemeTokens(normalizeCustomTheme(s.customTheme) ?? DEFAULT_CUSTOM_THEME);
    root.dataset.theme = derived.themeId;
    applyCustomThemeVars(root, derived.tokens);
    void getCurrentWebviewWindow()
      .setTheme(derived.light ? "light" : "dark")
      .catch(() => {});
    return;
  }
  const theme = s.theme || DEFAULT_THEME_ID;
  root.dataset.theme = theme;
  const light = isLightTheme(theme);
  void getCurrentWebviewWindow()
    .setTheme(s.themeFollowSystem ? null : light ? "light" : "dark")
    .catch(() => {});
}

function itemTreeRel(item: ProjectFilePaneFile, state: FileViewerState): string {
  if (item.rel) return item.rel.replace(/\\/g, "/");
  const baseRoot = item.root ?? state.root;
  for (const base of [baseRoot, state.projectRoot]) {
    if (base && pathWithin(item.path, base, IS_WINDOWS)) {
      const trimmed = item.path
        .slice(base.replace(/[\\/]+$/, "").length)
        .replace(/^[\\/]+/, "")
        .replace(/\\/g, "/");
      if (trimmed) return trimmed;
    }
  }
  return item.name;
}

export default function FileViewerApp() {
  const [state, setState] = useState<FileViewerState | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const stateRef = useRef<FileViewerState | null>(null);
  stateRef.current = state;

  const syncTheme = useCallback(() => {
    void invoke<ViewerSettings>("get_settings")
      .then((s) => applyViewerTheme(s ?? {}))
      .catch(() => applyViewerTheme({}));
  }, []);

  useEffect(() => {
    syncTheme();
    const onFocus = () => syncTheme();
    const onStorage = () => syncTheme();
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [syncTheme]);

  const confirmLoseDirty = useCallback(async (prompt = "有未保存的改动，切换文件将放弃这些改动，继续？") => {
    if (!dirtyRef.current) return true;
    const ok = await confirmDialog(prompt, { danger: true, confirmText: "放弃" });
    if (ok) dirtyRef.current = false;
    return ok;
  }, []);

  useEffect(() => {
    let stale = false;
    void invoke<FileViewerState | null>("file_viewer_state")
      .then((initial) => {
        if (stale || !initial) return;
        setState(initial);
        if (initial.showList !== undefined) {
          setListOpen(initial.showList);
        } else if ((initial.list?.length ?? 0) > 1) {
          setListOpen(true);
        }
      })
      .catch((reason) => {
        if (!stale) setError(String(reason));
      });
    const unlistenPromise = listen<FileViewerState>("file-viewer:state", async (event) => {
      const incoming = event.payload;
      const cur = stateRef.current;
      if (cur && !samePath(cur.path, incoming.path, IS_WINDOWS) && !(await confirmLoseDirty())) {
        return;
      }
      setError(null);
      setVersionsOpen(false);
      setMoreMenu(null);
      setState(incoming);
      if (incoming.showList !== undefined) {
        setListOpen(incoming.showList);
      }
    });
    return () => {
      stale = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [confirmLoseDirty]);

  useEffect(() => {
    const win = getCurrentWebviewWindow();
    const unlistenPromise = win.onCloseRequested(async (event) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      const ok = await confirmDialog("有未保存的改动，关闭窗口将放弃这些改动，继续？", {
        danger: true,
        confirmText: "放弃并关闭",
      });
      if (ok) {
        dirtyRef.current = false;
        void win.destroy();
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  async function switchFile(next: ProjectFilePaneFile) {
    if (!state) return;
    if (!samePath(next.path, state.path, IS_WINDOWS) && !(await confirmLoseDirty())) return;
    const nextState: FileViewerState = {
      ...state,
      ...next,
      root: next.root ?? state.root,
      line: undefined,
      showList: listOpen,
      nonce: state.nonce + 1,
    };
    setError(null);
    await invoke("file_viewer_open", { state: nextState }).catch((reason) => setError(String(reason)));
  }

  async function step(delta: -1 | 1) {
    if (!state) return;
    const next = neighborFile(state.list, state.path, delta, IS_WINDOWS);
    if (next) await switchFile(next);
  }

  function openExternal() {
    if (!state) return;
    setError(null);
    void invoke("open_in_system", { path: state.path, root: state.root }).catch((reason) =>
      setError(String(reason)),
    );
  }

  if (!state) {
    return (
      <div data-surface="canvas" className="flex h-full w-full flex-col bg-canvas p-5 text-l1">
        {error ? <p className="text-xs text-err-text">{error}</p> : <LoadingRows />}
        <ConfirmDialogHost />
      </div>
    );
  }

  const index = state.list?.findIndex((f) => samePath(f.path, state.path, IS_WINDOWS)) ?? -1;
  const total = state.list?.length ?? 0;
  const inProject = pathWithin(state.path, state.projectRoot, IS_WINDOWS);
  const inRoot = pathWithin(state.path, state.root, IS_WINDOWS);
  const rel = inProject
    ? state.path.slice(state.projectRoot.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "")
    : inRoot
      ? state.path.slice(state.root.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "")
      : state.rel ?? state.path;
  const subtitle = state.from ? `${state.from} · ${rel}` : rel;
  const treePaths = state.list ? state.list.map((item) => itemTreeRel(item, state)) : [];
  const selectedTreeRel = index >= 0 ? treePaths[index] ?? rel.replace(/\\/g, "/") : rel.replace(/\\/g, "/");
  const iconAction = `${ghostActionClass} w-7 px-0`;
  const stepAction = `${ghostActionClass} w-6 px-0`;

  const moreItems: ContextMenuItem[] = [
    {
      label: versionsOpen ? "返回文件预览" : "文件版本",
      icon: History,
      onSelect: async () => {
        if (!versionsOpen && !(await confirmLoseDirty("有未保存的编辑，查看历史将放弃这些编辑，继续？"))) {
          return;
        }
        setVersionsOpen((v) => !v);
      },
    },
    { separator: true },
    {
      label: "用系统默认应用打开",
      icon: ExternalLink,
      onSelect: openExternal,
    },
    {
      label: revealFolderLabel(IS_MAC, IS_WINDOWS),
      icon: FolderOpen,
      onSelect: () => void revealItemInDir(state.path).catch((reason) => setError(String(reason))),
    },
    {
      label: "复制路径",
      icon: Copy,
      onSelect: () => void navigator.clipboard.writeText(state.path).catch(() => setError("复制路径失败")),
    },
  ];

  return (
    <div data-surface="canvas" className="flex h-full w-full flex-col bg-canvas text-l1">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-3.5 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold leading-5 text-l1" title={state.name}>
            {versionsOpen ? `文件版本 · ${state.name}` : state.name}
          </h1>
          {subtitle && (
            <p className="truncate text-micro leading-4 text-l4" title={subtitle}>
              {subtitle}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!versionsOpen && total > 1 && (
            <button
              type="button"
              aria-expanded={listOpen}
              aria-label={listOpen ? "收起文件树" : "展开文件树"}
              className={`${iconAction} ${listOpen ? "bg-seg-sel text-l1" : ""}`}
              onClick={() => setListOpen((v) => !v)}
              title={listOpen ? "收起左侧文件列表，让预览更宽" : "展开左侧文件列表"}
            >
              <FolderTree size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          {!versionsOpen && total > 1 && index >= 0 && (
            <>
              <button
                type="button"
                className={stepAction}
                onClick={() => void step(-1)}
                disabled={index <= 0}
                title="上一个文件"
                aria-label="上一个文件"
              >
                ↑
              </button>
              <button
                type="button"
                className={stepAction}
                onClick={() => void step(1)}
                disabled={index >= total - 1}
                title="下一个文件"
                aria-label="下一个文件"
              >
                ↓
              </button>
              <span className="px-0.5 text-micro tabular-nums text-l4">
                {index + 1}/{total}
              </span>
            </>
          )}
          {versionsOpen && (
            <button
              type="button"
              className={ghostActionClass}
              onClick={() => setVersionsOpen(false)}
            >
              返回文件
            </button>
          )}
          <button
            ref={moreBtnRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreMenu !== null}
            aria-label="更多操作"
            title="更多操作（文件版本、用系统默认应用打开、复制路径…）"
            className={`${iconAction} ${moreMenu ? "bg-hover text-l1" : ""}`}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMoreMenu((cur) => (cur ? null : { x: rect.right, y: rect.bottom + 4 }));
            }}
          >
            <MoreHorizontal size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      </header>
      {error && (
        <p className="shrink-0 break-words border-b border-hairline px-3.5 py-1.5 text-micro text-err-text">{error}</p>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={<div className="px-3.5 py-3"><LoadingRows /></div>}>
          {versionsOpen ? (
            <FileVersionsPanel
              key={`${state.root}|${state.path}`}
              root={state.root}
              path={state.path}
              onClose={() => setVersionsOpen(false)}
            />
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
              {listOpen && total > 1 && (
                <aside className="flex min-h-0 w-44 shrink-0 flex-col border-r border-hairline px-1 py-1">
                  <FileSelectionTree
                    paths={treePaths}
                    selected={selectedTreeRel}
                    label="对照文件树"
                    expandAll
                    onSelect={(pickedRel) => {
                      const picked = state.list?.find((item) => itemTreeRel(item, state) === pickedRel);
                      if (picked) void switchFile(picked);
                    }}
                  />
                </aside>
              )}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <ProjectFilePreview
                  key={state.path}
                  path={state.path}
                  root={state.root}
                  hideFileName
                  revealLine={state.line ?? null}
                  revealNonce={state.nonce}
                  onOpenFile={(absPath) => {
                    const name = absPath.split(/[\\/]/).pop() ?? absPath;
                    const dir = absPath.replace(/[\\/][^\\/]*$/, "") || absPath;
                    const nextRoot = pathWithin(absPath, state.root, IS_WINDOWS)
                      ? state.root
                      : pathWithin(absPath, state.projectRoot, IS_WINDOWS)
                        ? state.projectRoot
                        : dir;
                    void switchFile({ path: absPath, name, root: nextRoot });
                  }}
                  onDirtyChange={(d) => {
                    dirtyRef.current = d;
                  }}
                />
              </div>
            </div>
          )}
        </Suspense>
      </div>
      {moreMenu &&
        createPortal(
          <ContextMenu
            x={moreMenu.x}
            y={moreMenu.y}
            alignRight
            items={moreItems}
            onClose={() => {
              setMoreMenu(null);
              moreBtnRef.current?.focus();
            }}
          />,
          document.body,
        )}
      <ConfirmDialogHost />
    </div>
  );
}
