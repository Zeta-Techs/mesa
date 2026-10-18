import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import AcceptanceLogList from "./AcceptanceLogList";
import ProjectInjectionPanel from "./ProjectInjectionPanel";
import ProjectMemoryPanel from "./ProjectMemoryPanel";
import ProjectRulesPanel from "./ProjectRulesPanel";
import { inlineActionClass } from "./PageFrame";
import { useExitRender } from "../exit-animation";
import type { AcceptanceLogEntryDto } from "../types";

/** 项目设置抽屉外壳：三种工作方式共用同一套右侧滑出 / 退场 / Esc / 焦点口径
 *  （与 Modal 侧滑 sheet 同款）；内容列 space-y-5，分区一律 h3 小标 + ccode-well。 */
export function SettingsDrawerShell({
  open,
  onClose,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** 头部副题：项目名，让抽屉自己说明服务的是哪个项目（编程 / 工作抽屉没有「基本」分区）。 */
  subtitle?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const { render, exiting } = useExitRender(open);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const frame = requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [open]);

  if (!render) return null;
  return (
    <div
      className={`fixed inset-0 z-40 flex justify-end bg-black/40 ccode-fade${exiting ? " ccode-exiting" : ""}`}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside
        ref={panelRef}
        data-surface="canvas"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`ccode-sheet-right flex h-full w-[34rem] max-w-[92vw] flex-col bg-canvas outline-none${exiting ? " ccode-exiting" : ""}`}
      >
        <header className="flex h-12 shrink-0 items-center gap-2 px-5">
          <h2
            id={titleId}
            className="min-w-0 shrink-0 text-base font-semibold text-l1"
          >
            项目设置
          </h2>
          <span
            className="min-w-0 flex-1 truncate text-micro text-l4"
            title={subtitle}
          >
            {subtitle}
          </span>
          <button
            type="button"
            className={inlineActionClass}
            onClick={onClose}
            aria-label="关闭项目设置"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-auto px-5 pb-6">
          {children}
        </div>
      </aside>
    </div>
  );
}

/** 「规则与验收」分区：规则 + 验收记录 + 对话注入，三种工作方式同一份
 *  （科研也走这里，不再叠进「基本」）。验收账本由本分区自取，宿主不再各备一份 state。 */
export function SettingsRulesSection({
  projectPath,
  projectName,
  workMode,
  onSaved,
  onError,
}: {
  projectPath: string;
  projectName: string;
  workMode?: string | null;
  onSaved?: () => void;
  onError?: (message: string) => void;
}) {
  const [acceptLog, setAcceptLog] = useState<AcceptanceLogEntryDto[]>([]);
  useEffect(() => {
    let stale = false;
    invoke<AcceptanceLogEntryDto[]>("read_acceptance_log", { path: projectPath })
      .then((rows) => {
        if (!stale) setAcceptLog(rows);
      })
      .catch(() => {
        if (!stale) setAcceptLog([]);
      });
    return () => {
      stale = true;
    };
  }, [projectPath]);
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-l3">规则与验收</h3>
      <div className="rounded-lg ccode-well p-3">
        <ProjectRulesPanel
          projectPath={projectPath}
          workMode={workMode}
          compact
          defaultOpen
          onSaved={onSaved}
          onError={onError}
        />
        <AcceptanceLogList entries={acceptLog} />
      </div>
      <div className="mt-2 rounded-lg ccode-well p-3">
        <ProjectInjectionPanel
          projectPath={projectPath}
          projectName={projectName}
          workMode={workMode}
          compact
          onSaved={onSaved}
          onError={onError}
        />
      </div>
    </section>
  );
}

/** 项目低频项（编程 / 工作）：规则与验收、长期知识，以及调用方追加的定时等。 */
export default function ProjectSettingsDrawer({
  open,
  onClose,
  projectPath,
  projectName,
  workMode,
  children,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  projectName: string;
  workMode?: string | null;
  children?: ReactNode;
  onError?: (message: string) => void;
}) {
  return (
    <SettingsDrawerShell open={open} onClose={onClose} subtitle={projectName}>
      <SettingsRulesSection
        projectPath={projectPath}
        projectName={projectName}
        workMode={workMode}
        onError={onError}
      />
      <ProjectMemoryPanel key={projectPath} projectPath={projectPath} />
      {children}
    </SettingsDrawerShell>
  );
}
