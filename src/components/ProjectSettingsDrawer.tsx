import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import ResearchRecordPanel from "./ResearchRecordPanel";
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
  title = "项目设置",
  headerActions,
  titleIcon,
  footer,
  className = "",
  backdropClassName = "",
  docked = null,
  headerExtra,
  fillBody = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** 抽屉标题；工作台任务面板借这个外壳时传任务名（2026-10-27） */
  title?: string;
  /** 头部副题：项目名，让抽屉自己说明服务的是哪个项目（编程 / 工作抽屉没有「基本」分区）。 */
  subtitle?: string;
  /** 固定在标题下的操作区；任务 / 审批详情复用，其他设置抽屉不传。 */
  headerActions?: ReactNode;
  /** 标题前的形象（项目助手的 Mesa 图标，2026-11-04）；其他抽屉不传 */
  titleIcon?: ReactNode;
  /** 钉在底部、不随内容滚动的一栏（项目助手的输入框）；其他抽屉不传 */
  footer?: ReactNode;
  className?: string;
  backdropClassName?: string;
  /** 常驻在页面右侧（项目助手，2026-11-05 用户拍板「右侧常驻侧栏」）：不压暗、不锁滚动、不困住焦点，页面照常能点；
   *  宽度由宿主给，左缘可拖。不给就是原来的浮层抽屉 */
  docked?: { width: number; onResize: (width: number) => void; onResizeEnd?: () => void } | null;
  /** 标题行里、关闭钮前面的小控件（停靠位「项目助手 / 文件」轮流切换，2026-11-11）；其他抽屉不传 */
  headerExtra?: ReactNode;
  /** 内容区交给子元素撑满（文件栏的预览自己滚动）：不加段间距、不在外层滚 */
  fillBody?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const { render, exiting } = useExitRender(open);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || docked) return;
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
      ).filter((element) => !element.closest("[hidden], [inert]"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
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
    // docked 只看有没有，宽度变不重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!docked]);

  if (!render) return null;
  // 常驻侧栏关掉就收，不等退场动画（它不是从右边滑进来的浮层）
  if (docked && !open) return null;
  const inner = renderInner();
  if (docked) {
    // 常驻侧栏：页面让出宽度（宿主放在主区右边的同一行里），左缘一条拖动条调宽窄；Esc 只在焦点在侧栏里时关
    return (
      <aside
        ref={panelRef}
        data-surface="canvas"
        role="complementary"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ width: docked.width }}
        className={`ccode-docked-panel relative flex h-full shrink-0 flex-col bg-canvas outline-none ${className}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整宽度"
          title="拖动调整宽度，双击恢复默认"
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-hairline"
          onPointerDown={(event) => {
            event.preventDefault();
            const startX = event.clientX;
            const startW = docked.width;
            const move = (e: PointerEvent) => docked.onResize(startW + (startX - e.clientX));
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
              document.body.style.cursor = "";
              docked.onResizeEnd?.();
            };
            document.body.style.cursor = "col-resize";
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
          onDoubleClick={() => {
            docked.onResize(-1);
            docked.onResizeEnd?.();
          }}
        />
        {/* 圆角在外层，内容在这里裁圆；拖动条留在外层，能伸进与主区之间的缝 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">{inner}</div>
      </aside>
    );
  }
  return (
    <div
      className={`fixed inset-0 z-40 flex justify-end bg-black/40 ccode-fade ${backdropClassName}${exiting ? " ccode-exiting" : ""}`}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside
        ref={panelRef}
        data-surface="canvas"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`ccode-sheet-right flex h-full w-[34rem] max-w-[92vw] flex-col bg-canvas outline-none ${className}${exiting ? " ccode-exiting" : ""}`}
      >
        {inner}
      </aside>
    </div>
  );

  function renderInner() {
    return (
      <>
        {titleIcon ? (
          // 带形象的抽屉（项目助手）：形象 + 标题，项目名在标题下一行；头与内容靠留白分开，不画线（2026-11-08）
          <header className="flex shrink-0 items-center gap-3 px-5 pb-2 pt-3">
            {titleIcon}
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="truncate text-base font-semibold leading-5 text-l1">
                {title}
              </h2>
              {subtitle && (
                <p className="truncate text-xs text-l3" title={subtitle}>
                  {subtitle}
                </p>
              )}
            </div>
            {headerExtra}
            <button type="button" className={inlineActionClass} onClick={onClose} aria-label={`关闭${title}`}>
              ✕
            </button>
          </header>
        ) : (
        <header className={`flex shrink-0 items-center gap-2 px-5 ${headerActions ? "min-h-12 flex-wrap py-3" : "h-12"}`}>
          <h2
            id={titleId}
            className={`min-w-0 text-base font-semibold text-l1 ${headerActions ? "line-clamp-2 flex-1 break-words" : "shrink truncate"}`}
            title={headerActions ? title : undefined}
          >
            {title}
          </h2>
          {!headerActions && (
            <span className="min-w-0 flex-1 truncate text-micro text-l4" title={subtitle}>
              {subtitle}
            </span>
          )}
          {headerExtra}
          <button
            type="button"
            className={inlineActionClass}
            onClick={onClose}
            aria-label={`关闭${title}`}
          >
            ✕
          </button>
          {headerActions && subtitle && <p className="w-full break-words text-xs text-l3">{subtitle}</p>}
        </header>
        )}
        {headerActions && <div className="shrink-0 border-b border-hairline px-5 pb-3">{headerActions}</div>}
        {fillBody ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-3 pt-2">{children}</div>
        ) : (
          <div className={`min-h-0 flex-1 space-y-5 overflow-auto px-5 pb-6 ${headerActions || titleIcon ? "pt-4" : ""}`}>
            {children}
          </div>
        )}
        {footer && <div className="shrink-0 border-t border-hairline px-5 pb-4 pt-3">{footer}</div>}
      </>
    );
  }
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
        <ResearchRecordPanel projectPath={projectPath} />
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
