import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import AcceptanceLogList from "./AcceptanceLogList";
import ProjectMemoryPanel from "./ProjectMemoryPanel";
import ProjectRulesPanel from "./ProjectRulesPanel";
import { inlineActionClass } from "./PageFrame";
import { useExitRender } from "../exit-animation";
import type { AcceptanceLogEntryDto } from "../types";

/** 项目低频项：规则、验收记录，以及调用方追加的定时等。 */
export default function ProjectSettingsDrawer({
  open,
  onClose,
  projectPath,
  workMode,
  children,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  workMode?: string | null;
  children?: ReactNode;
  onError?: (message: string) => void;
}) {
  const [acceptLog, setAcceptLog] = useState<AcceptanceLogEntryDto[]>([]);
  const { render, exiting } = useExitRender(open);
  useEffect(() => {
    if (!open) return;
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
  }, [open, projectPath]);
  if (!render) return null;
  return (
    <div
      className={`fixed inset-0 z-40 flex justify-end bg-black/40 ccode-fade${exiting ? " ccode-exiting" : ""}`}
      onClick={onClose}
    >
      <aside
        data-surface="canvas"
        className={`ccode-sheet-right flex h-full w-[34rem] max-w-[92vw] flex-col bg-canvas${exiting ? " ccode-exiting" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-12 shrink-0 items-center gap-2 px-5">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-l1">
            项目设置
          </h2>
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
          <section>
            <h3 className="mb-2 text-xs font-medium text-l3">规则与验收</h3>
            <div className="rounded-lg ccode-well p-3">
              <ProjectRulesPanel
                projectPath={projectPath}
                workMode={workMode}
                compact
                defaultOpen
                onError={onError}
              />
              <AcceptanceLogList entries={acceptLog} />
            </div>
          </section>
          <ProjectMemoryPanel key={projectPath} projectPath={projectPath} />
          {children}
        </div>
      </aside>
    </div>
  );
}
