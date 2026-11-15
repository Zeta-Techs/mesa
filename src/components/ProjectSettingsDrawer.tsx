import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderMinus, FolderOpen, X } from "lucide-react";
import ResearchRecordPanel from "./ResearchRecordPanel";
import AcceptanceLogList from "./AcceptanceLogList";
import ProjectInjectionPanel from "./ProjectInjectionPanel";
import ProjectMemoryPanel from "./ProjectMemoryPanel";
import ProjectRulesPanel from "./ProjectRulesPanel";
import { confirmDialog } from "./ConfirmDialog";
import {
  SegTabs,
  compactFieldClass,
  ghostActionClass,
  inlineActionClass,
} from "./PageFrame";
import { useExitRender } from "../exit-animation";
import { useAppStore } from "../store";
import { normalizeWorkMode, type WorkMode } from "../work-mode";
import type { AcceptanceLogEntryDto, ProjectConfigReadDto } from "../types";

const WORK_MODE_ITEMS: readonly { id: WorkMode; label: string }[] = [
  { id: "research", label: "科研" },
  { id: "coding", label: "编程" },
  { id: "office", label: "工作" },
];

const rowActionClass =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-field px-2 text-xs text-l2 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-45";

const dangerGhostClass =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-field px-2.5 text-xs text-l3 transition-colors hover:border-err-text/40 hover:bg-hover hover:text-err-text disabled:opacity-45";

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
  /** 头部副题：项目名，让抽屉自己说明服务的是哪个项目。 */
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
    const closeBtn = (
      <button
        type="button"
        className="-mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
        onClick={onClose}
        aria-label={`关闭${title}`}
      >
        <X size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>
    );
    return (
      <>
        {titleIcon ? (
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
            {closeBtn}
          </header>
        ) : fillBody ? (
          <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-3.5 py-2">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="truncate text-sm font-semibold leading-5 text-l1" title={title}>
                {title}
              </h2>
              {subtitle && (
                <p className="truncate text-micro leading-4 text-l4" title={subtitle}>
                  {subtitle}
                </p>
              )}
            </div>
            {headerExtra}
            {closeBtn}
          </header>
        ) : headerActions ? (
          <header className="ccode-drawer-head shrink-0 border-b border-field/75 px-5 pb-3.5 pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2
                  id={titleId}
                  className="line-clamp-2 break-words text-base font-semibold leading-snug tracking-tight text-l1"
                  title={title}
                >
                  {title}
                </h2>
                {subtitle && (
                  <p className="mt-0.5 truncate text-xs text-l3" title={subtitle}>
                    {subtitle}
                  </p>
                )}
              </div>
              {headerExtra}
              {closeBtn}
            </div>
            <div className="mt-3">{headerActions}</div>
          </header>
        ) : (
          <header className="flex h-12 shrink-0 items-center gap-2 px-5">
            <h2 id={titleId} className="min-w-0 shrink truncate text-base font-semibold text-l1">
              {title}
            </h2>
            <span className="min-w-0 flex-1 truncate text-micro text-l4" title={subtitle}>
              {subtitle}
            </span>
            {headerExtra}
            {closeBtn}
          </header>
        )}
        {fillBody ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
        ) : (
          <div className={`min-h-0 flex-1 overflow-auto px-5 pb-6 ${headerActions ? "space-y-4 pt-4" : titleIcon ? "space-y-5 pt-4" : "space-y-5"}`}>
            {children}
          </div>
        )}
        {footer && <div className="shrink-0 border-t border-hairline px-5 pb-4 pt-3">{footer}</div>}
      </>
    );
  }
}

/** 分区一：基本信息（科研 / 编程 / 工作统一具备：项目名就地改、课题主题/项目简介就地改、路径复制+打开文件夹、切换工作方式） */
function SettingsBasicSection({
  projectPath,
  projectName,
  activeMode,
  onNameSaved,
  onModeChanged,
  onSaved,
  onError,
}: {
  projectPath: string;
  projectName: string;
  activeMode: WorkMode;
  onNameSaved: (nextName: string) => void;
  onModeChanged: (nextMode: WorkMode) => void;
  onSaved?: () => void;
  onError?: (message: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(projectName);
  const [nameBusy, setNameBusy] = useState(false);
  const [topic, setTopic] = useState<string>("");
  const [topicLoaded, setTopicLoaded] = useState(false);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [topicBusy, setTopicBusy] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setNameDraft(projectName);
  }, [projectName]);

  useEffect(() => {
    let stale = false;
    setTopicLoaded(false);
    invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath })
      .then((read) => {
        if (stale) return;
        setTopic(read.config.topic?.trim() ?? "");
        setTopicLoaded(true);
      })
      .catch(() => {
        if (!stale) setTopicLoaded(true);
      });
    return () => {
      stale = true;
    };
  }, [projectPath]);

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    const next = nameDraft.trim();
    if (!next || nameBusy) return;
    setNameBusy(true);
    try {
      await invoke("register_project", { path: projectPath, name: next });
      setRenaming(false);
      onNameSaved(next);
      useAppStore.getState().bumpProjectsVersion();
      onSaved?.();
    } catch (reason) {
      onError?.(`重命名项目失败：${String(reason)}`);
    } finally {
      setNameBusy(false);
    }
  }

  async function submitTopic(event: FormEvent) {
    event.preventDefault();
    if (topicBusy) return;
    const next = topicDraft.trim();
    setTopicBusy(true);
    try {
      const latest = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: projectPath,
      });
      await invoke("write_project_config", {
        path: projectPath,
        config: { ...latest.config, topic: next || null },
      });
      setTopic(next);
      setEditingTopic(false);
      useAppStore.getState().bumpProjectsVersion();
      onSaved?.();
    } catch (reason) {
      onError?.(`保存主题失败：${String(reason)}`);
    } finally {
      setTopicBusy(false);
    }
  }

  async function changeWorkMode(next: WorkMode) {
    if (next === activeMode || modeBusy) return;
    setModeBusy(true);
    try {
      await invoke("set_work_mode", { projectRoot: projectPath, mode: next });
      onModeChanged(next);
      useAppStore.getState().bumpProjectsVersion();
      onSaved?.();
    } catch (reason) {
      onError?.(`切换工作方式失败：${String(reason)}`);
    } finally {
      setModeBusy(false);
    }
  }

  function copyPath() {
    navigator.clipboard.writeText(projectPath).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      (reason) => onError?.(`复制项目路径失败：${String(reason)}`),
    );
  }

  const topicLabel = activeMode === "research" ? "课题主题" : "项目简介";
  const topicPlaceholder =
    activeMode === "research"
      ? "一句话说明课题方向（会写入任务书与对话背景）；留空清除"
      : "一句话说明项目定位（会写入新对话背景）；留空清除";

  return (
    <section aria-label="基本信息">
      <h3 className="mb-2 text-xs font-medium text-l3">基本信息</h3>
      <div className="space-y-2.5 rounded-lg ccode-well p-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs text-l3">项目名</span>
          {renaming ? (
            <form onSubmit={submitRename} className="flex min-w-0 flex-1 items-center gap-1">
              <input
                aria-label="项目名输入"
                className={`${compactFieldClass} min-w-0 flex-1`}
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                disabled={nameBusy}
                autoFocus
                required
              />
              <button type="submit" className={inlineActionClass} disabled={nameBusy || !nameDraft.trim()}>
                保存
              </button>
              <button
                type="button"
                className={ghostActionClass}
                disabled={nameBusy}
                onClick={() => {
                  setNameDraft(projectName);
                  setRenaming(false);
                }}
              >
                取消
              </button>
            </form>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-l1" title={projectName}>
                {projectName}
              </span>
              <button
                type="button"
                className={rowActionClass}
                onClick={() => {
                  setNameDraft(projectName);
                  setRenaming(true);
                }}
              >
                重命名
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs text-l3">{topicLabel}</span>
          {editingTopic ? (
            <form onSubmit={submitTopic} className="flex min-w-0 flex-1 items-center gap-1">
              <input
                aria-label={`${topicLabel}输入`}
                className={`${compactFieldClass} min-w-0 flex-1`}
                value={topicDraft}
                placeholder={topicPlaceholder}
                onChange={(event) => setTopicDraft(event.target.value)}
                disabled={topicBusy}
                autoFocus
              />
              <button type="submit" className={inlineActionClass} disabled={topicBusy}>
                保存
              </button>
              <button
                type="button"
                className={ghostActionClass}
                disabled={topicBusy}
                onClick={() => setEditingTopic(false)}
              >
                取消
              </button>
            </form>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-sm text-l2" title={topic || undefined}>
                {topic ? topic : <span className="text-xs text-l4">{topicLoaded ? "未填写" : "读取中…"}</span>}
              </span>
              <button
                type="button"
                className={rowActionClass}
                disabled={!topicLoaded}
                onClick={() => {
                  setTopicDraft(topic);
                  setEditingTopic(true);
                }}
              >
                编辑
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs text-l3">项目路径</span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-micro text-l3"
            title={projectPath}
          >
            {projectPath}
          </span>
          <button type="button" className={rowActionClass} onClick={copyPath}>
            {copied ? "已复制" : "复制"}
          </button>
          <button
            type="button"
            className={rowActionClass}
            title="在访达 / 资源管理器中显示项目目录"
            onClick={() =>
              void revealItemInDir(projectPath).catch((reason) =>
                onError?.(`打开文件夹失败：${String(reason)}`),
              )
            }
          >
            <FolderOpen size={12.5} aria-hidden="true" />
            打开文件夹
          </button>
        </div>

        <div className="flex items-center gap-2 pt-0.5">
          <span className="w-20 shrink-0 text-xs text-l3">工作方式</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
            <SegTabs<WorkMode>
              items={WORK_MODE_ITEMS}
              value={activeMode}
              onChange={(next) => void changeWorkMode(next)}
              variant="boxed"
              size="sm"
            />
            <span className="text-micro text-l4">只切换工作台界面，不改动磁盘文件</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/** 分区二：「AI 规则与项目记忆」——规则 + 项目长期知识 + 新对话附带项目背景，三种工作方式统一口径。 */
export function SettingsRulesSection({
  projectPath,
  projectName,
  workMode,
  onPreviewFile,
  onSaved,
  onError,
}: {
  projectPath: string;
  projectName: string;
  workMode?: string | null;
  onPreviewFile?: (relPath: string) => void;
  onSaved?: () => void;
  onError?: (message: string) => void;
}) {
  return (
    <section aria-label="AI 规则与项目记忆">
      <h3 className="mb-2 text-xs font-medium text-l3">AI 规则与项目记忆</h3>
      <div className="rounded-lg ccode-well p-3">
        <ProjectRulesPanel
          projectPath={projectPath}
          workMode={workMode}
          compact
          defaultOpen
          onPreviewFile={onPreviewFile}
          onSaved={onSaved}
          onError={onError}
        />
      </div>
      <div className="mt-2 rounded-lg ccode-well p-3">
        <ProjectMemoryPanel
          key={`${projectPath}:${normalizeWorkMode(workMode)}`}
          projectPath={projectPath}
          workMode={workMode}
          compact
        />
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

/** 分区四：记录与管理（只读验收账本 + 研究记录与导出 + 低频移除项目注册） */
function SettingsRecordsAndManageSection({
  projectPath,
  projectName,
  onClose,
  onProjectChanged,
  onError,
}: {
  projectPath: string;
  projectName: string;
  onClose: () => void;
  onProjectChanged?: () => void;
  onError?: (message: string) => void;
}) {
  const [acceptLog, setAcceptLog] = useState<AcceptanceLogEntryDto[]>([]);
  const [removing, setRemoving] = useState(false);

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

  async function handleRemove() {
    if (removing) return;
    const ok = await confirmDialog(
      `只移除「${projectName}」的项目注册，不删除本地磁盘目录；项目内工作区保留。继续？`,
      { focusCancel: true },
    );
    if (!ok) return;
    setRemoving(true);
    try {
      await invoke("remove_project", { path: projectPath });
      onClose();
      useAppStore.getState().bumpProjectsVersion();
      onProjectChanged?.();
    } catch (reason) {
      onError?.(`移除项目失败：${String(reason)}`);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <section aria-label="记录与管理">
      <h3 className="mb-2 text-xs font-medium text-l3">记录与管理</h3>
      <div className="space-y-2.5 rounded-lg ccode-well p-3 text-xs">
        <AcceptanceLogList entries={acceptLog} className="" />
        <ResearchRecordPanel projectPath={projectPath} className="" />
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <span className="font-medium text-l2">从 Mesa 移除项目</span>
            <p className="text-micro leading-5 text-l4">
              只从左侧项目列表摘掉，不删除磁盘文件夹与已有成果
            </p>
          </div>
          <button
            type="button"
            className={dangerGhostClass}
            disabled={removing}
            onClick={() => void handleRemove()}
          >
            <FolderMinus size={12.5} aria-hidden="true" />
            {removing ? "移除中…" : "从 Mesa 移除"}
          </button>
        </div>
      </div>
    </section>
  );
}

/** 统一项目设置抽屉（科研 / 编程 / 工作共用）：
 *  1. 基本信息  2. AI 规则与项目记忆  3. 模式专属（children）  4. 记录与管理 */
export default function ProjectSettingsDrawer({
  open,
  onClose,
  projectPath,
  projectName,
  workMode,
  children,
  onSaved,
  onProjectChanged,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  projectName: string;
  workMode?: string | null;
  children?: ReactNode;
  onSaved?: () => void;
  onProjectChanged?: () => void;
  onError?: (message: string) => void;
}) {
  const [liveName, setLiveName] = useState(projectName);
  const [activeMode, setActiveMode] = useState<WorkMode>(() => normalizeWorkMode(workMode));

  useEffect(() => {
    setLiveName(projectName);
  }, [projectName]);

  useEffect(() => {
    setActiveMode(normalizeWorkMode(workMode));
  }, [workMode]);

  function handlePreviewFile(relPath: string) {
    onClose();
    useAppStore.getState().setFilePreviewReq({
      projectRoot: projectPath,
      path: relPath,
      token: Date.now(),
    });
  }

  return (
    <SettingsDrawerShell open={open} onClose={onClose} subtitle={liveName}>
      <SettingsBasicSection
        projectPath={projectPath}
        projectName={liveName}
        activeMode={activeMode}
        onNameSaved={(next) => {
          setLiveName(next);
          onProjectChanged?.();
        }}
        onModeChanged={(next) => {
          setActiveMode(next);
          onProjectChanged?.();
        }}
        onSaved={onSaved}
        onError={onError}
      />
      <SettingsRulesSection
        projectPath={projectPath}
        projectName={liveName}
        workMode={activeMode}
        onPreviewFile={handlePreviewFile}
        onSaved={onSaved}
        onError={onError}
      />
      {children}
      <SettingsRecordsAndManageSection
        projectPath={projectPath}
        projectName={liveName}
        onClose={onClose}
        onProjectChanged={onProjectChanged}
        onError={onError}
      />
    </SettingsDrawerShell>
  );
}
