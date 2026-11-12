import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { pathWithin, samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { canDockAssistant } from "../assistant-dock";
import { supportsImmersiveReader } from "../project-files";
import {
  clampFilePaneWidth,
  dockOccupant,
  FILE_PANE_WIDTH_KEY,
  filePaneShouldClose,
  neighborFile,
  type DockFront,
} from "../project-file-pane";
import { SettingsDrawerShell } from "./ProjectSettingsDrawer";
import { confirmDiscardProjectFile as confirmDiscard, setProjectFilePaneDirty, showProjectFile } from "../project-file-open";
import { BookOpen, ExternalLink, FolderSearch } from "lucide-react";
import { ghostActionClass, LoadingRows } from "./PageFrame";

// 预览按需加载：App 启动包不能静态带上 pdfjs（entry-guard 守着）
const ProjectFilePreview = lazy(() => import("./ProjectFilePreview"));
const FileVersionsPanel = lazy(() => import("./FileVersions").then((module) => ({ default: module.FileVersionsPanel })));

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

  useEffect(() => {
    setError(null);
  }, [pane?.path]);
  useEffect(() => {
    if (!pane) {
      setProjectFilePaneDirty(false);
      setDirty(false);
    }
  }, [pane]);

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
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const [roomy, setRoomy] = useState(false);
  useEffect(() => {
    const dock = document.getElementById("ccode-assistant-dock");
    const main = document.querySelector<HTMLElement>(".ccode-app-main");
    setDockEl(dock);
    if (!dock || !main || typeof ResizeObserver === "undefined") return;
    const measure = () => setRoomy(canDockAssistant(main.clientWidth + dock.clientWidth, width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    ro.observe(dock);
    return () => ro.disconnect();
  }, [width]);

  const onPage = page === "workspaces";
  const occupant = dockOccupant(front, assistantOpen, !!pane && onPage);
  const visible = !!pane && occupant === "file";
  const docked = !!pane && roomy && !!dockEl;

  async function close() {
    if (await confirmDiscard()) closePane();
  }

  async function step(delta: -1 | 1) {
    if (!pane) return;
    const next = neighborFile(pane.list, pane.path, delta, IS_WINDOWS);
    if (next) await showProjectFile({ ...pane, ...next });
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
  const rel = inProject
    ? pane.path.slice(pane.projectRoot.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "")
    : pane.path;

  // 一行放进标题行（2026-11-11 用户：「这一行是不是可以放在顶部」）：文件名 · 来处 · ↑↓ · 图标动作 · 切换 · ✕
  const iconAction = `${ghostActionClass} w-7 px-0`;
  const actions = (
    <div className="flex shrink-0 items-center gap-0.5">
      {!pane.versions && total > 1 && index >= 0 && (
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
      {!pane.versions && pane.askAi && (
        <button type="button" className={ghostActionClass} onClick={() => pane.askAi?.(pane.path)}>
          问 AI
        </button>
      )}
      {!pane.versions && <button
        type="button"
        className={iconAction}
        onClick={openExternal}
        title="外部打开：用系统默认应用打开（PDF 阅读器、Word、Excel、图片查看器）"
        aria-label="外部打开"
      >
        <ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>}
      {!pane.versions && supportsImmersiveReader(pane.name) && (
        <button
          type="button"
          className={iconAction}
          onClick={() => void openImmersive()}
          title="沉浸阅读：PDF 与笔记左右对照着读"
          aria-label="沉浸阅读"
        >
          <BookOpen size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      {!pane.versions && inProject && (
        <button
          type="button"
          className={iconAction}
          onClick={() => void revealInFilesTab()}
          title="在文件页签里看：切到项目的「文件」页签，在目录里找到它"
          aria-label="在文件页签里看"
        >
          <FolderSearch size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      {assistantOpen && <DockSwitch front="file" onSwitch={setDockFront} />}
    </div>
  );

  const panel = (
    <SettingsDrawerShell
      open={docked ? true : visible}
      onClose={() => void close()}
      title={pane.versions ? "文件版本" : pane.name}
      subtitle={pane.versions ? undefined : pane.from ? `${pane.from} · ${rel}` : rel}
      headerExtra={actions}
      fillBody
      docked={
        docked
          ? {
              width,
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
      {error && <p className="mb-2 shrink-0 break-words px-2 text-micro text-err-text">{error}</p>}
      <Suspense fallback={<LoadingRows />}>
      {pane.versions ? <FileVersionsPanel
        key={`${pane.versions.root}|${pane.versions.workspaceId ?? pane.path}`}
        root={pane.versions.root}
        path={pane.versions.workspaceId ? undefined : pane.path}
        workspaceId={pane.versions.workspaceId}
        onClose={(currentPath) => void showProjectFile({ projectRoot: pane.projectRoot, root: pane.root, path: currentPath ?? pane.path, list: pane.list })}
      /> : <ProjectFilePreview
        key={pane.path}
        path={pane.path}
        root={pane.root}
        onOpenFile={(p) =>
          void showProjectFile({ projectRoot: pane.projectRoot, root: pane.root, path: p })
        }
        onOpenReader={supportsImmersiveReader(pane.name) ? () => void openImmersive() : undefined}
        onDirtyChange={(d) => {
          setProjectFilePaneDirty(d);
          if (d !== dirty) setDirty(d);
        }}
      />}
      </Suspense>
    </SettingsDrawerShell>
  );
  // 常驻时轮到项目助手 / 离开项目页只藏起来（不卸载，没保存的改动还在）
  return docked && dockEl
    ? createPortal(<div className={visible ? "contents" : "hidden"}>{panel}</div>, dockEl)
    : panel;
}
