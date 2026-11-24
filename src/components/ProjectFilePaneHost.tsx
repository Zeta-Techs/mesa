import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import { pathWithin, revealFolderLabel, samePath } from "../path-utils";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { supportsImmersiveReader } from "../project-files";
import { popOutFileToWindow } from "../file-window-open";
import {
  clampFilePaneWidth,
  dockedFilePaneWidth,
  dockOccupant,
  FILE_PANE_WIDTH_KEY,
  filePaneShouldClose,
  neighborFile,
  type DockFront,
  type ProjectFilePaneFile,
  type ProjectFilePaneReq,
} from "../project-file-pane";
import { SettingsDrawerShell } from "./ProjectSettingsDrawer";
import {
  confirmDiscardProjectFile as confirmDiscard,
  setProjectFilePaneDirty,
  showProjectFile,
} from "../project-file-open";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import {
  AppWindow,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  FolderTree,
  History,
  MessageSquare,
  MoreHorizontal,
} from "lucide-react";
import { ghostActionClass, LoadingRows } from "./PageFrame";

// 预览按需加载：App 启动包不能静态带上 pdfjs（entry-guard 守着）
const ProjectFilePreview = lazy(() => import("./ProjectFilePreview"));
const FileVersionsPanel = lazy(() => import("./FileVersions").then((module) => ({ default: module.FileVersionsPanel })));
const FileSelectionTree = lazy(() => import("./FileTree").then((module) => ({ default: module.FileSelectionTree })));

function itemTreeRel(item: ProjectFilePaneFile, pane: ProjectFilePaneReq): string {
  if (item.rel) return item.rel.replace(/\\/g, "/");
  const baseRoot = item.root ?? pane.root;
  for (const base of [baseRoot, pane.projectRoot]) {
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

/** 停靠位两样都开着时，标题行里的「项目助手 / 文件」轮流切换（同一位置，不并排） */
export function DockSwitch({ front, onSwitch }: { front: DockFront; onSwitch: (front: DockFront) => void }) {
  const item = (key: DockFront, label: string) => (
    <button
      type="button"
      aria-pressed={front === key}
      onClick={() => front !== key && onSwitch(key)}
      className={`inline-flex h-6 items-center rounded-md px-2 text-micro transition-colors ${
        front === key ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="右侧显示" className="flex shrink-0 items-center gap-0.5 rounded-lg bg-inset p-0.5">
      {item("assistant", "项目助手")}
      {item("file", "文件")}
    </div>
  );
}

function savedWidth(): number {
  try {
    const raw = localStorage.getItem(FILE_PANE_WIDTH_KEY);
    return clampFilePaneWidth(raw ? Number(raw) : -1);
  } catch {
    return clampFilePaneWidth(-1);
  }
}

/**
 * 项目页文件栏的宿主（App 挂一份）：够宽时放进主区右边的 #ccode-assistant-dock，与项目助手同一位置轮流
 * （后叫出来的在前，关了退回另一个）；不够宽是浮层抽屉。离开项目页只藏起来，回来还在；在项目页换到别的项目才收。
 */
export default function ProjectFilePaneHost() {
  const pane = useAppStore((s) => s.projectFilePane);
  const closePane = useAppStore((s) => s.closeProjectFile);
  const assistantOpen = useAppStore((s) => !!s.assistantReq);
  const front = useAppStore((s) => s.dockFront);
  const setDockFront = useAppStore((s) => s.setDockFront);
  const page = useAppStore((s) => s.page);
  const viewingProject = useAppStore((s) => s.contextLabel?.projectPath ?? null);
  const setReaderReq = useAppStore((s) => s.setReaderReq);
  const setPage = useAppStore((s) => s.setPage);
  const setFilePreviewReq = useAppStore((s) => s.setFilePreviewReq);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const versionsPathRef = useRef<string | null>(null);

  useEffect(() => {
    setError(null);
    setMoreMenu(null);
    versionsPathRef.current = null;
  }, [pane?.path]);
  useEffect(() => {
    if (!pane) {
      setProjectFilePaneDirty(false);
      setDirty(false);
      setListOpen(false);
      setMoreMenu(null);
    }
  }, [pane]);
  useEffect(() => {
    if (pane && pane.showList !== undefined) {
      setListOpen(pane.showList);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane?.nonce]);

  // 在项目页换到别的项目：文件栏收起（有没保存的改动不收）
  const lastProject = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const before = lastProject.current;
    lastProject.current = viewingProject;
    if (!pane) return;
    if (
      filePaneShouldClose({
        paneRoot: pane.projectRoot,
        page,
        prevProject: before,
        project: viewingProject,
        dirty,
        isWindows: IS_WINDOWS,
      })
    ) {
      closePane();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingProject]);

  const [width, setWidth] = useState(savedWidth);
  const widthRef = useRef(width);
  widthRef.current = width;
  const [dockEl, setDockEl] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? document.getElementById("ccode-assistant-dock") : null,
  );
  const [dockWidth, setDockWidth] = useState<number | null>(null);
  useEffect(() => {
    const dock = document.getElementById("ccode-assistant-dock");
    const main = document.querySelector<HTMLElement>(".ccode-app-main");
    setDockEl(dock);
    if (!dock || !main || typeof ResizeObserver === "undefined") return;
    const measure = () => setDockWidth(dockedFilePaneWidth(main.clientWidth + dock.clientWidth, width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    ro.observe(dock);
    return () => ro.disconnect();
  }, [width]);

  const onPage = page === "workspaces";
  const occupant = dockOccupant(front, assistantOpen, !!pane && onPage);
  const visible = !!pane && occupant === "file";
  const docked = !!pane && dockWidth !== null && !!dockEl;

  async function close() {
    if (await confirmDiscard()) closePane();
  }

  async function popOutToWindow() {
    if (!pane) return;
    if (pane.versions) {
      // 版本视图：拆出当前选中的那份文件，新窗口直接停在「文件版本」
      const path = versionsPathRef.current ?? pane.path;
      await popOutFileToWindow({
        projectRoot: pane.projectRoot,
        root: pane.versions.root,
        path,
        list: pane.list,
        versionsView: true,
        onBeforeOpen: closePane,
      }).catch((reason) => setError(String(reason)));
      return;
    }
    const snapshot = { ...pane, showList: listOpen };
    const wasDirty = dirty;
    await popOutFileToWindow({
      ...snapshot,
      dirty: wasDirty,
      onBeforeOpen: () => {
        setProjectFilePaneDirty(false);
        setDirty(false);
        closePane();
      },
    }).catch((reason) => setError(String(reason)));
  }

  async function step(delta: -1 | 1) {
    if (!pane) return;
    const next = neighborFile(pane.list, pane.path, delta, IS_WINDOWS);
    if (next) {
      await showProjectFile({
        ...pane,
        ...next,
        root: next.root ?? pane.root,
        line: undefined,
        showList: undefined,
      });
    }
  }

  async function openImmersive() {
    if (!pane) return;
    if (/\.pdf$/i.test(pane.name)) {
      setReaderReq({ pdfPath: pane.path, projectRoot: pane.projectRoot });
      setPage("terminal");
      return;
    }
    try {
      const r = await invoke<{ projectRoot: string; pdfPath: string; notePath: string }>("reader_for_note", {
        notePath: pane.path,
      });
      setReaderReq({ pdfPath: r.pdfPath, projectRoot: r.projectRoot, notePath: r.notePath });
      setPage("terminal");
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function revealInFilesTab() {
    if (!pane || !(await confirmDiscard())) return;
    setFilePreviewReq({ projectRoot: pane.projectRoot, path: pane.path, token: Date.now() });
    closePane();
  }

  function openExternal() {
    if (!pane) return;
    setError(null);
    void invoke("open_in_system", { path: pane.path, root: pane.root }).catch((reason) => setError(String(reason)));
  }

  if (!pane) return null;
  const index = pane.list?.findIndex((f) => samePath(f.path, pane.path, IS_WINDOWS)) ?? -1;
  const total = pane.list?.length ?? 0;
  const inProject = pathWithin(pane.path, pane.projectRoot, IS_WINDOWS);
  const inRoot = pathWithin(pane.path, pane.root, IS_WINDOWS);
  const rel = inProject
    ? pane.path.slice(pane.projectRoot.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "")
    : inRoot
      ? pane.path.slice(pane.root.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "")
      : pane.rel ?? pane.path;
  const treePaths = pane.list ? pane.list.map((item) => itemTreeRel(item, pane)) : [];
  const selectedTreeRel = index >= 0 ? treePaths[index] ?? rel.replace(/\\/g, "/") : rel.replace(/\\/g, "/");

  // 标题栏只保留高频导航与拆窗图标，次级操作收进 ⋯ 更多菜单，给左侧两行文件名与路径留足宽度
  const iconAction = `${ghostActionClass} w-7 px-0`;
  const stepAction = `${ghostActionClass} w-6 px-0`;
  // 当有清单且非步骤级版本树时，由宿主统一提供文件树与上下切换（预览态与版本态共用，切到文件版本不丢文件树）；
  // 否则（步骤级版本或单文件）由 FileVersionsPanel 内置文件树接管并默认定位到当前文件
  const useHostTree = total > 1 && !pane.versions?.workspaceId;
  const openVersionsMode = () => {
    const scope = pane.versionsScope ?? { root: pane.root };
    void showProjectFile({
      projectRoot: pane.projectRoot,
      root: pane.root,
      path: pane.path,
      list: pane.list,
      versions: scope,
      versionsScope: scope,
      from: pane.from,
      askAi: pane.askAi,
    });
  };
  const closeVersionsMode = (currentPath?: string, filePaths?: string[]) => {
    const targetPath = currentPath ?? pane.path;
    const nextList: ProjectFilePaneFile[] | undefined =
      pane.list && pane.list.length > 0
        ? pane.list
        : filePaths && filePaths.length > 1
          ? filePaths.map((p) => ({
              path: p,
              name: p.split(/[\\/]/).pop() ?? p,
              root: pane.root,
            }))
          : undefined;
    void showProjectFile({
      projectRoot: pane.projectRoot,
      root: pane.root,
      path: targetPath,
      list: nextList,
      versionsScope: pane.versions ?? pane.versionsScope,
      from: pane.from === "文件版本" ? undefined : pane.from,
      askAi: pane.askAi,
    });
  };
  const moreItems: ContextMenuItem[] = !pane.versions?.workspaceId
    ? [
        {
          label: "在新窗口打开",
          icon: AppWindow,
          onSelect: () => void popOutToWindow(),
        },
        ...(!pane.versions && pane.askAi
          ? [
              {
                label: "问 AI",
                icon: MessageSquare,
                onSelect: () => pane.askAi?.(pane.path),
              },
            ]
          : []),
        ...(!pane.versions && supportsImmersiveReader(pane.name)
          ? [
              {
                label: "沉浸阅读",
                icon: BookOpen,
                onSelect: () => void openImmersive(),
              },
            ]
          : []),
        {
          label: pane.versions ? "返回文件预览" : "文件版本",
          icon: History,
          onSelect: () => (pane.versions ? closeVersionsMode() : openVersionsMode()),
        },
        ...(inProject
          ? [
              {
                label: "在「文件」页签中查看",
                icon: FolderSearch,
                onSelect: () => void revealInFilesTab(),
              },
            ]
          : []),
        { separator: true },
        {
          label: "用系统默认应用打开",
          icon: ExternalLink,
          onSelect: openExternal,
        },
        {
          label: revealFolderLabel(IS_MAC, IS_WINDOWS),
          icon: FolderOpen,
          onSelect: () => void revealItemInDir(pane.path).catch((reason) => setError(String(reason))),
        },
        {
          label: "复制路径",
          icon: Copy,
          onSelect: () => void navigator.clipboard.writeText(pane.path).catch(() => setError("复制路径失败")),
        },
      ]
    : [];

  const actions = (
    <div className="flex shrink-0 items-center gap-0.5">
      {useHostTree && (
        <button
          type="button"
          aria-expanded={listOpen}
          aria-label={listOpen ? "收起文件树" : "展开文件树"}
          className={`${iconAction} ${listOpen ? "bg-seg-sel text-l1" : ""}`}
          onClick={() => setListOpen((v) => !v)}
          title={listOpen ? "收起左侧文件列表，让预览更宽" : "展开文件列表，在栏内切换文件"}
        >
          <FolderTree size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      {useHostTree && index >= 0 && (
        <>
          <button
            type="button"
            className={stepAction}
            onClick={() => void step(-1)}
            disabled={index <= 0}
            title="上一个文件"
            aria-label="上一个文件"
          >
            <ChevronUp size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={stepAction}
            onClick={() => void step(1)}
            disabled={index >= total - 1}
            title="下一个文件"
            aria-label="下一个文件"
          >
            <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <span className="px-0.5 text-micro tabular-nums text-l4">
            {index + 1}/{total}
          </span>
        </>
      )}
      <button
        type="button"
        className={iconAction}
        onClick={() => void popOutToWindow()}
        title={
          pane.versions
            ? "在新窗口打开：拆成独立系统窗口查看这份文件的版本"
            : "在新窗口打开：拆成独立系统窗口对照查看，主窗口保留全宽看意见；点意见里的行号会同步定位"
        }
        aria-label="在新窗口打开"
      >
        <AppWindow size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {!pane.versions?.workspaceId && (
        <button
          ref={moreBtnRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={moreMenu !== null}
          aria-label="更多操作"
          title="更多操作（沉浸阅读、文件版本、用系统默认应用打开、复制路径…）"
          className={`${iconAction} ${moreMenu ? "bg-hover text-l1" : ""}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMoreMenu((cur) => (cur ? null : { x: rect.right, y: rect.bottom + 4 }));
          }}
        >
          <MoreHorizontal size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      {assistantOpen && <DockSwitch front="file" onSwitch={setDockFront} />}
    </div>
  );

  const panel = (
    <SettingsDrawerShell
      open={docked ? true : visible}
      onClose={() => void close()}
      title={pane.versions?.workspaceId ? "文件版本" : pane.name}
      subtitle={pane.versions?.workspaceId ? undefined : pane.from ? `${pane.from} · ${rel}` : rel}
      headerExtra={actions}
      fillBody
      docked={
        docked && dockWidth !== null
          ? {
              width: dockWidth,
              onResize: (w) => setWidth(clampFilePaneWidth(w)),
              onResizeEnd: () => {
                try {
                  localStorage.setItem(FILE_PANE_WIDTH_KEY, String(widthRef.current));
                } catch {
                  /* 存不下只是下次回默认宽 */
                }
              },
            }
          : null
      }
    >
      {error && (
        <p className="shrink-0 break-words border-b border-hairline px-3.5 py-1.5 text-micro text-err-text">{error}</p>
      )}
      <Suspense fallback={<div className="px-3.5 py-3"><LoadingRows /></div>}>
      {pane.versions && !useHostTree ? <FileVersionsPanel
        key={`${pane.versions.root}|${pane.versions.workspaceId ?? "project"}`}
        root={pane.versions.root}
        initialPath={pane.path}
        workspaceId={pane.versions.workspaceId}
        onClose={closeVersionsMode}
        onChosenChange={(currentPath) => {
          versionsPathRef.current = currentPath;
        }}
      /> : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {listOpen && useHostTree && (
            <aside className="flex min-h-0 w-44 shrink-0 flex-col border-r border-hairline px-1 py-1">
              <FileSelectionTree
                paths={treePaths}
                selected={selectedTreeRel}
                label="对照文件树"
                expandAll
                onSelect={(pickedRel) => {
                  const picked = pane.list?.find((item) => itemTreeRel(item, pane) === pickedRel);
                  if (picked) {
                    void showProjectFile({
                      ...pane,
                      ...picked,
                      root: picked.root ?? pane.root,
                      line: undefined,
                      showList: undefined,
                    });
                  }
                }}
              />
            </aside>
          )}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {pane.versions ? (
              <FileVersionsPanel
                key={`${pane.versions.root}|${pane.path}`}
                root={pane.versions.root}
                path={pane.path}
                onClose={closeVersionsMode}
                onChosenChange={(currentPath) => {
                  versionsPathRef.current = currentPath;
                }}
              />
            ) : (
              <ProjectFilePreview
                key={pane.path}
                path={pane.path}
                root={pane.root}
                hideFileName
                revealLine={pane.line ?? null}
                revealNonce={pane.nonce}
                onOpenVersions={openVersionsMode}
                onOpenFile={(p) =>
                  void showProjectFile({
                    projectRoot: pane.projectRoot,
                    root: pane.root,
                    path: p,
                    list: pane.list,
                    versionsScope: pane.versionsScope,
                    from: pane.from,
                    askAi: pane.askAi,
                  })
                }
                onOpenReader={supportsImmersiveReader(pane.name) ? () => void openImmersive() : undefined}
                onDirtyChange={(d) => {
                  setProjectFilePaneDirty(d);
                  if (d !== dirty) setDirty(d);
                }}
              />
            )}
          </div>
        </div>
      )}
      </Suspense>
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
    </SettingsDrawerShell>
  );
  // 始终经同一 Portal 挂进 #ccode-assistant-dock（缩放切换常驻 ↔ 浮层时不卸载，未保存编辑与状态都在）
  return dockEl
    ? createPortal(<div className={docked && !visible ? "hidden" : "contents"}>{panel}</div>, dockEl)
    : panel;
}
