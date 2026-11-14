import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ExternalLink } from "lucide-react";
import { ConfirmDialogHost, confirmDialog } from "../components/ConfirmDialog";
import { ghostActionClass, LoadingRows } from "../components/PageFrame";
import { IS_WINDOWS } from "../hotkeys";
import { pathWithin, samePath } from "../path-utils";
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

  return (
    <div data-surface="canvas" className="flex h-full w-full flex-col bg-canvas text-l1">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <h1 className="shrink truncate text-sm font-semibold text-l1">{state.name}</h1>
        <span className="min-w-0 flex-1 truncate text-micro text-l4" title={subtitle}>
          {subtitle}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {total > 1 && (
            <button
              type="button"
              aria-expanded={listOpen}
              className={`${ghostActionClass} ${listOpen ? "bg-seg-sel text-l1" : ""}`}
              onClick={() => setListOpen((v) => !v)}
              title={listOpen ? "收起左侧文件列表，让预览更宽" : "展开左侧文件列表"}
            >
              文件树
            </button>
          )}
          {total > 1 && index >= 0 && (
            <>
              <button
                type="button"
                className={iconAction}
                onClick={() => void step(-1)}
                disabled={index <= 0}
                title="上一个文件"
                aria-label="上一个文件"
              >
                ↑
              </button>
              <button
                type="button"
                className={iconAction}
                onClick={() => void step(1)}
                disabled={index >= total - 1}
                title="下一个文件"
                aria-label="下一个文件"
              >
                ↓
              </button>
              <span className="px-1 text-micro tabular-nums text-l4">
                {index + 1}/{total}
              </span>
            </>
          )}
          <button
            type="button"
            className={iconAction}
            onClick={openExternal}
            title="外部打开：用系统默认应用打开"
            aria-label="外部打开"
          >
            <ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      </header>
      {error && <p className="shrink-0 break-words px-4 pt-2 text-micro text-err-text">{error}</p>}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden px-3 pb-3 pt-2">
        <Suspense fallback={<LoadingRows />}>
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {listOpen && total > 1 && (
              <aside className="flex min-h-0 w-44 shrink-0 flex-col border-r border-hairline pr-1.5">
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
        </Suspense>
      </div>
      <ConfirmDialogHost />
    </div>
  );
}
