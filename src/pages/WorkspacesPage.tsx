import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import {
  appUpdateInboxEntry,
  runInboxAction,
  useAppStore,
  type InboxItem,
} from "../store";
import { absTime, relTime } from "../rel-time";
import {
  groupInbox,
  helpNotifyKeys,
  helpPreview,
  helpSignature,
  inboxTaskLabel,
  inboxTaskLine,
  isHelpDismissed,
  filterDismissed,
} from "../inbox";
import ContextMenu from "../components/ContextMenu";
import { confirmDialog } from "../components/ConfirmDialog";
import ProjectGroup from "../components/ProjectGroup";
import ArtifactChecklist from "../components/ArtifactChecklist";
import { REVIEW_SAVE } from "../review-save-copy";
import ProjectAgentsView from "../components/ProjectAgentsView";
import ProjectFilesView from "../components/ProjectFilesView";
import {
  slotPrefs,
  DISCUSS_BINDING_SLOT,
} from "../project-agents";
import ProjectSurfaceTabs from "../components/ProjectSurfaceTabs";
import ProjectIdentityHeader, {
  type ProjectChromeAction,
} from "../components/ProjectIdentityHeader";
import ProjectUserTasksView from "../components/ProjectUserTasksView";
import TemplatePickModal from "../components/TemplatePickModal";
import { Modal } from "../components/Modal";
import { filterWorkspacesByFocus } from "../workspace-visibility";
import { buildWorkspaceTerminalRequest, resolveStepLaunchByWorkspace } from "../pipeline-start";
import {
  EmptyState,
  fieldClass,
  inlineActionClass,
  NoticeBar,
  PageFrame,
  primaryActionClass,
  rowActionClass,
  hoverRevealClass,
  secondaryActionClass,
} from "../components/PageFrame";
import {
  attributeToProject,
  buildRunOverview,
  projectRailStatus,
  runIdForPath,
  workspaceAgentBusy,
  workspaceReviewInboxEligible,
} from "../run-overview";
import { depInboxItem, type DepCheckDto } from "../dep-check";
import {
  litInboxCandidates,
  litInboxForRegisteredProjects,
  papersForLitCandidate,
  type LitInboxCandidate,
  type WatchEntryDto,
  type WatchInboxDto,
} from "../lit-watch";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import type {
  HelpRequestDto,
  PendingArtifactDto,
  DiscoveredResourceDto,
  ProjectConfigReadDto,
  ProjectDto,
  RunScriptDto,
  ScheduleDto,
  SchedulerRunDonePayload,
  WorkspaceDto,
  WorkspaceDriftDto,
  WorkspaceHealthDto,
  WsSettingsDto,
} from "../types";
import CodingProjectView, {
  prefetchCodingOverview,
} from "../components/CodingProjectView";
import {
  WORK_MODE_HINT,
  WORK_MODE_LABEL,
  WORK_MODES,
  RAIL_WORK_MODE_LABEL,
  groupByWorkMode,
  lockWorkModeFromConfig,
  normalizeWorkMode,
  projectSwitchRows,
  type WorkMode,
} from "../work-mode";
import { sortWorkspacesByAttention } from "../project-status";
import { samePath as samePathKey } from "../path-utils";
import { toast } from "../toast";
import {
  DEFAULT_PROJECT_SURFACE_TAB,
  projectSurfaceStorageKey,
  projectSurfaceTabsForMode,
  readProjectSurfaceTab,
  type ProjectSurfaceTab,
} from "../project-surface";
import ProjectChatsView from "../components/ProjectChatsView";
import ProjectSchedulesView from "../components/ProjectSchedulesView";

/** 保留工作区的合并已完成，且分支尚未产生新的待合并提交。 */
function isMerged(
  ws: WorkspaceDto,
  health: WorkspaceHealthDto | undefined,
): boolean {
  return ws.status === "active" && !!ws.mergedAt && health?.ahead === 0;
}

/** 与后端 sanitize 一致：非 [A-Za-z0-9-] → -，去掉首尾 - */
function sanitizeBranch(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

/** 项目注册路径与工作区路径来自不同后端来源；按平台统一分隔符、大小写和 verbatim 前缀。 */
function samePath(a: string, b: string): boolean {
  return samePathKey(a, b, IS_WINDOWS);
}

function pathBaseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

const PROJECT_RAIL_COLLAPSED_KEY = "ccode.projectRailCollapsed";

/** 人工请求新来源的系统通知：macOS 首次发送前必须显式申请权限（系统级弹窗，仅首次）；
    被拒则静默跳过。复用「长任务 OS 通知」设置开关，不新增设置项。 */
async function fireHelpNotification(sourceCount: number) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return;
  sendNotification({
    title: "人工请求",
    body: `${sourceCount} 个来源有人工请求`,
  });
}

/** 添加项目：选目录后填名称并选工作方式（科研 / 编程 / 工作） */
function AddProjectModal({
  path,
  existingMode,
  onClose,
  onRegistered,
}: {
  path: string;
  /** 已注册项目的工作方式；有值则禁止改选（终身一张主界面） */
  existingMode: WorkMode | null;
  onClose: () => void;
  onRegistered: (
    project: ProjectDto,
    scan: { added: number; total: number },
    mode: WorkMode,
    skipTemplate: boolean,
  ) => void;
}) {
  const depCheck = useAppStore((s) => s.depCheck);
  const [name, setName] = useState(pathBaseName(path));
  const [mode, setMode] = useState<WorkMode>(existingMode ?? "research");
  const [modeLocked, setModeLocked] = useState(existingMode != null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<ProjectConfigReadDto>("read_project_config", { path })
      .then((read) => {
        if (cancelled) return;
        const lock = lockWorkModeFromConfig({
          existingMode,
          fileMode: read.config.workMode,
          stepCount: read.config.steps?.length ?? 0,
          pipelineOptOut: !!read.config.pipelineOptOut,
        });
        if (lock.locked) {
          setMode(lock.mode);
          setModeLocked(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast("项目配置未检测到，将使用默认工作方式", "warning");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, existingMode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // 提交时再读一遍档案卡：弹窗打开后立刻点添加时，预填 effect 可能还没回来，
      // 不能把已是编程/工作的项目静默写回科研。
      let chosen = mode;
      let skipTemplate = modeLocked;
      try {
        const probe = await invoke<ProjectConfigReadDto>("read_project_config", {
          path,
        });
        const lock = lockWorkModeFromConfig({
          existingMode,
          fileMode: probe.config.workMode,
          stepCount: probe.config.steps?.length ?? 0,
          pipelineOptOut: !!probe.config.pipelineOptOut,
        });
        if (lock.locked) {
          chosen = lock.mode;
          skipTemplate = true;
          setMode(lock.mode);
          setModeLocked(true);
        }
      } catch {
        /* 尚无档案卡：用弹窗里选的 */
      }
      if (chosen === "coding") {
        let dep = depCheck;
        if (!dep) {
          try {
            dep = await invoke<DepCheckDto>("check_dependencies");
          } catch {
            setError(
              "无法检测 Git 是否可用。请到设置页「诊断」里检查依赖后再添加。",
            );
            setBusy(false);
            return;
          }
        }
        if (dep.git.status === "clt_stub") {
          setError(
            "需要先安装 Xcode 命令行工具才能使用 Git。请到设置页「诊断」里安装。",
          );
          setBusy(false);
          return;
        }
        const isRepo = await invoke<boolean>("git_is_repo", { path });
        if (!isRepo) {
          const ok = await confirmDialog(
            "这个文件夹还不是 git 仓库。继续会在其中创建 .git，并写入一份编程用的 .gitignore（不含科研那套忽略 PDF 的规则）。之后才能用工作树和分支台。",
            { confirmText: "初始化 git 并继续" },
          );
          if (!ok) {
            setBusy(false);
            return;
          }
          await invoke("ensure_git_repo", { path, workMode: "coding" });
        }
      }
      const project = await invoke<ProjectDto>("register_project", {
        path,
        name: name.trim(),
      });
      let autoAdded = 0;
      let totalResources = 0;
      try {
        const read = await invoke<ProjectConfigReadDto>("read_project_config", {
          path,
        });
        const found =
          chosen === "research"
            ? await invoke<DiscoveredResourceDto[]>("discover_resources", {
                path,
              })
            : [];
        const fresh = found.filter((d) => !d.exists);
        const next = {
          ...read.config,
          workMode: chosen,
          resources: [
            ...read.config.resources,
            ...fresh.map((d) => ({
              name: d.path.split(/[\\/]/).pop() ?? d.path,
              path: d.path,
              type: d.type,
              readonly: false,
              note: "",
            })),
          ],
        };
        autoAdded = fresh.length;
        totalResources = next.resources.length;
        await invoke("write_project_config", { path, config: next });
      } catch (reason) {
        try {
          await invoke("set_work_mode", { projectRoot: path, mode: chosen });
        } catch {
          /* 注册已成功 */
        }
        setError(
          `项目已注册，但写入 project.toml 失败：${String(reason)}`,
        );
        return;
      }
      onRegistered(
        project,
        { added: autoAdded, total: totalResources },
        chosen,
        skipTemplate,
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="添加项目" onClose={onClose} size="md">
      <form onSubmit={submit}>
        <h2 className="sr-only">添加项目</h2>
        <p
          className="mb-3 truncate font-mono text-xs text-l3"
          title={path}
        >
          {path}
        </p>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">项目名</span>
          <input
            className={fieldClass}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        <p className="mb-1 text-xs text-l3">工作方式</p>
        <div
          className="mb-4 grid gap-1.5"
          role="radiogroup"
          aria-label="工作方式"
        >
          {WORK_MODES.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              disabled={modeLocked && mode !== id}
              onClick={() => {
                if (!modeLocked) setMode(id);
              }}
              className={`rounded-md border px-3 py-2 text-left ${
                mode === id
                  ? "border-cta-bd bg-cta/15"
                  : "border-field hover:bg-hover"
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <span className="block text-sm text-l1">{WORK_MODE_LABEL[id]}</span>
              <span className="block text-xs text-l2">
                {WORK_MODE_HINT[id]}
                {modeLocked && mode === id ? "（已选定，不可更改）" : ""}
              </span>
            </button>
          ))}
        </div>
        {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "添加中…" : "添加"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 重命名项目弹窗（项目导航行右键「重命名项目」）：register_project 是幂等 upsert，同名改不改都行 */
function RenameProjectModal({
  path,
  initialName,
  onClose,
  onRenamed,
}: {
  path: string;
  initialName: string;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await invoke("register_project", { path, name: name.trim() });
      onRenamed();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="重命名项目" onClose={onClose} size="md">
      <form onSubmit={submit}>
        <h2 className="sr-only">重命名项目</h2>
        <p className="mb-3 truncate font-mono text-xs text-l3" title={path}>
          {path}
        </p>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">项目名</span>
          <input
            className={fieldClass}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 工作区 → 终端的交接：取端口段 env，交给终端页开新标签；预填该目录上次使用的配置（W3-C）。
 *  initialPrompt：一键开步的首条指令，启动时注入 CLI（一次性） */
function useOpenInTerminal() {
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  // 交接构造单一出处在 pipeline-start.ts（reuseKey 找回同工作区标签 + 无 prompt 时 resume 最近会话）
  return async (
    ws: WorkspaceDto,
    initialPrompt?: string,
    opts?: Parameters<typeof buildWorkspaceTerminalRequest>[2],
  ) => {
    setPendingTerminal(
      await buildWorkspaceTerminalRequest(ws, initialPrompt, opts),
    );
    setPage("terminal");
  };
}

/** 新建工作区（入口收进项目分组的工作区列表头部）：仓库固定为发起分组的路径，
 *  弹窗只剩任务名 + 分支预览，不再提供仓库下拉/自定义路径（避免建错项目） */
function NewWorkspaceModal({
  repoPath,
  onClose,
  onCreated,
}: {
  /** 发起分组的仓库路径（项目注册路径或未注册分组的 repo 路径），弹窗内不可改 */
  repoPath: string;
  onClose: () => void;
  onCreated: (ws: WorkspaceDto) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const branch = `ccode/${sanitizeBranch(name)}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const ws = await invoke<WorkspaceDto>("create_workspace", {
        repoPath,
        name: name.trim(),
      });
      onCreated(ws);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal open title="新建工作区" onClose={onClose} size="md">
      <form onSubmit={submit}>
        <h2 className="sr-only">新建工作区</h2>
        <p className="mb-3 truncate font-mono text-xs text-l3" title={repoPath}>
          {repoPath}
        </p>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">任务名</span>
          <input
            className={fieldClass}
            required
            autoFocus
            placeholder="如 fix-login"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {name.trim() && (
            <span className="mt-1 block font-mono text-xs text-l4">
              分支：{branch}
            </span>
          )}
        </label>
        {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={creating || !name.trim()}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {creating ? "创建中…" : "创建"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

type WorkspaceState = {
  label: string;
  dotClass: string;
  textClass: string;
  details: string[];
};

function workspaceState(
  workspace: WorkspaceDto,
  health: WorkspaceHealthDto | undefined,
  drift: WorkspaceDriftDto | undefined,
  healthFailed = false,
  agentBusy = false,
): WorkspaceState {
  if (workspace.status === "creating") {
    return {
      label: "创建未完成",
      dotClass: "bg-warn-text",
      textClass: "text-warn-text",
      details: ["工作区创建流程尚未完成，请在更多操作中修复或清理记录。"],
    };
  }
  // 未完成 merge 是可继续的冲突流程，不应被泛化成“需要修复”而藏进更多菜单。
  if (drift?.canResolveMerge) {
    return {
      label: "有冲突",
      dotClass: "bg-err-text",
      textClass: "text-l2",
      details:
        health?.conflictFiles.length
          ? [`冲突文件：${health.conflictFiles.join("、")}`]
          : drift.issues.map((issue) => issue.message),
    };
  }
  if (drift && !drift.healthy) {
    return {
      label: "需要修复",
      dotClass: "bg-warn-text",
      textClass: "text-warn-text",
      details: drift.issues.map((issue) => issue.message),
    };
  }
  if (workspace.status === "archived") {
    return {
      label: "已归档",
      dotClass: "bg-l4",
      textClass: "text-l3",
      details: ["工作树已移除，分支仍保留，可恢复后继续工作。"],
    };
  }
  if (!health) {
    if (healthFailed) {
      return {
        label: "检查失败",
        dotClass: "bg-warn-text",
        textClass: "text-warn-text",
        details: ["无法读取工作区与主仓库状态，请重试。"],
      };
    }
    return {
      label: "检查中",
      dotClass: "bg-l4",
      textClass: "text-l3",
      details: ["正在读取工作区与主仓库状态。"],
    };
  }
  // 冲突判定优先于主仓脏/偏离：行内主按钮按冲突展示，pill 不能把它掩盖成「需要处理」
  if (health.conflict === true) {
    return {
      label: "有冲突",
      dotClass: "bg-err-text",
      textClass: "text-l2",
      details: [
        ...(health.conflictFiles.length
          ? [`冲突文件：${health.conflictFiles.join("、")}`]
          : [`与 ${workspace.baseBranch} 改了同一处内容，进入评审后选一边保留。`]),
        // 基准已前进＝这轮是在跟「之后的主仓」撞：多半是旧轮被重跑取代，明说可选删除
        ...(health.behind > 0
          ? [
              `主仓已前进 ${health.behind} 个提交：这一轮的产物和主仓的新版本改了同一批文件。若这一轮已被后面的重跑取代，直接删除工作区即可，不必解决冲突。`,
            ]
          : []),
        // 主仓问题与冲突并存时一并列出，避免漏掉合并阻塞项
        ...(health.mainDirty
          ? ["主文件夹里还有没保存的改动，提交保存后才能合并。"]
          : []),
        ...(health.mainOffBase
          ? [`主文件夹当前不在 ${workspace.baseBranch} 分支上。`]
          : []),
      ],
    };
  }
  // 正在出字时不把主仓脏 / 待提交 / 可评审当成「要你现在处理」
  if (agentBusy) {
    return {
      label: "进行中",
      dotClass: "bg-ok-text",
      textClass: "text-l3",
      details: [
        "Agent 正在这个任务里工作。",
        ...(health.mainDirty
          ? ["主文件夹里还有没保存的改动，保存进历史后才能合并。"]
          : []),
        ...(health.mainOffBase
          ? [`主文件夹当前不在 ${workspace.baseBranch} 分支上。`]
          : []),
      ],
    };
  }
  if (health.mainDirty || health.mainOffBase) {
    return {
      label: "需要处理",
      dotClass: "bg-warn-text",
      textClass: "text-warn-text",
      details: [
        ...(health.mainDirty
          ? ["主文件夹里还有没保存的改动，提交保存后才能合并。"]
          : []),
        ...(health.mainOffBase
          ? [`主文件夹当前不在 ${workspace.baseBranch} 分支上。`]
          : []),
      ],
    };
  }
  if (health.uncommitted) {
    return {
      label: "待提交",
      dotClass: "bg-warn-text",
      textClass: "text-l2",
      details: ["任务里还有没保存的改动，进入评审后可提交。"],
    };
  }
  if (health.readyToMerge) {
    return {
      label: "可评审",
      dotClass: "bg-ok-text",
      textClass: "text-l2",
      details: [REVIEW_SAVE.workspaceReady],
    };
  }
  if (isMerged(workspace, health)) {
    return {
      label: REVIEW_SAVE.done,
      dotClass: "bg-ok-text",
      textClass: "text-ok-text",
      details: [REVIEW_SAVE.workspaceDone],
    };
  }
  return {
    label: "进行中",
    dotClass: "bg-ok-text",
    textClass: "text-l3",
    details: [REVIEW_SAVE.workspaceIdle],
  };
}

function WorkspaceDetailsPopover({
  x,
  y,
  workspace,
  health,
  state,
  diagFailed,
  onRetry,
  onClose,
}: {
  x: number;
  y: number;
  workspace: WorkspaceDto;
  health: WorkspaceHealthDto | undefined;
  state: WorkspaceState;
  /** 漂移诊断/健康检查失败：行内不再放重试按钮，收进本详情层 */
  diagFailed: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  // 每行可带白话悬浮 title：↑↓ 等技术记号 hover 时给「保存点」解释（双层呈现，不删技术信息）
  const rows: [string, string, string?][] = [
    ["分支", `${workspace.branch} → ${workspace.baseBranch}`],
    ["工作树", workspace.worktreePath],
    ["端口", `${workspace.portBase}–${workspace.portBase + 9}`],
    ...(health
      ? ([
          [
            "提交",
            `↑${health.ahead} ↓${health.behind}`,
            `比主分支多出 ${health.ahead} 个保存点；主分支新增 ${health.behind} 个保存点`,
          ],
        ] as [string, string, string][])
      : []),
  ];
  const panelRef = useRef<HTMLElement>(null);
  const [pos, setPos] = useState(() => ({
    left: Math.max(8, Math.min(x, window.innerWidth - 328)),
    top: y,
  }));
  // 与 ContextMenu 一致：Escape / 任意滚动即关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);
  // 详情长度不固定，按实测尺寸钳制，避免锚点靠下时溢出屏幕底部
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y, state, health]);
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <section
        ref={panelRef}
        className="absolute w-80 rounded-sm border border-field ccode-float-surface p-3 text-xs"
        style={pos}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className={`size-2 rounded-full ${state.dotClass}`} />
          <span className={`font-medium ${state.textClass}`}>
            {state.label}
          </span>
        </div>
        {/* 上游漂移提醒（启发式，只提醒不阻断）：上游步骤晚于本步最后推进时间合并 */}
        {workspace.staleUpstream && (
          <p className="mb-2 text-warn-text">
            上游「{workspace.staleUpstream}」有更新，产物可能过期
          </p>
        )}
        <dl className="space-y-1.5 border-t border-hairline pt-2 text-l3">
          {rows.map(([label, value, hint]) => (
            <div
              key={label}
              className="grid grid-cols-[42px_minmax(0,1fr)] gap-2"
            >
              <dt className="text-l4">{label}</dt>
              <dd className="truncate font-mono text-l2" title={hint ?? value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {state.details.length > 0 && (
          <ul className="mt-2 space-y-1 border-t border-hairline pt-2 text-l3">
            {state.details.map((detail) => (
              <li key={detail}>• {detail}</li>
            ))}
          </ul>
        )}
        {diagFailed && (
          <div className="mt-2 border-t border-hairline pt-2">
            <button
              type="button"
              onClick={() => {
                onClose();
                onRetry();
              }}
              className="inline-flex h-7 items-center rounded-md px-2 text-xs text-warn-text hover:bg-hover"
            >
              诊断失败 · 重新检查
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default function WorkspacesPage({ visible }: { visible: boolean }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [settings, setSettings] = useState<Record<string, WsSettingsDto>>({});
  const [health, setHealth] = useState<Record<string, WorkspaceHealthDto>>({});
  const [drift, setDrift] = useState<Record<string, WorkspaceDriftDto>>({});
  // 逐工作区记录诊断/健康检查失败：失败时降级展示并给出重试入口，不静默吞掉
  const [driftFailed, setDriftFailed] = useState<Record<string, boolean>>({});
  const [healthFailed, setHealthFailed] = useState<Record<string, boolean>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  // 一般操作成功提示（清除 Mesa 痕迹等）：10s 自动消退
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 10_000);
    return () => clearTimeout(t);
  }, [notice]);
  // 新建工作区弹窗：携带发起分组的仓库路径（入口在各分组的工作区列表头部）
  const [newWsRepoPath, setNewWsRepoPath] = useState<string | null>(null);
  // 注册成功后的研究流程模板选择层（不使用/稍后再选 = 直接关闭不追加）
  const [templatePick, setTemplatePick] = useState<{
    path: string;
    name: string;
  } | null>(null);
  // 项目导航行右键菜单（重命名/复制路径/移除注册）与改名弹窗
  const [railMenu, setRailMenu] = useState<{
    x: number;
    y: number;
    groupKey: string;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    path: string;
    name: string;
  } | null>(null);
  // rail 头部 + 菜单（添加项目 / 创建示例课题）
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(
    null,
  );  const [created, setCreated] = useState<WorkspaceDto | null>(null);
  // 收起态课题名下拉（切换项目）：锚点来自 ProjectIdentityHeader 报回的按钮矩形
  const [switchMenu, setSwitchMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  // 创建成功横幅是瞬态反馈：10s 自动消退（setup 失败除外——失败详情要人看，不自动收）
  useEffect(() => {
    if (!created || (created.setupResult && !created.setupResult.ok)) return;
    const t = setTimeout(() => setCreated(null), 10_000);
    return () => clearTimeout(t);
  }, [created]);
  // P1b 项目分组：注册项目列表 + 每次刷新自增的令牌（触发各分组重读 project.toml）
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [homeDir, setHomeDir] = useState("");
  useEffect(() => {
    invoke<string>("home_dir")
      .then(setHomeDir)
      .catch(() => toast("无法读取主目录，部分路径提示可能不完整", "warning"));
  }, []);
  const [addProjectPath, setAddProjectPath] = useState<string | null>(null);
  // 刚注册的项目路径：对应分组显示一次性 git 初始化引导
  const [freshProjectPath, setFreshProjectPath] = useState<string | null>(null);
  /** 注册时自动扫到的资源条数：注册后立刻弹模板选择层会盖住页面顶部的 notice，
   *  所以先存着，等模板层关掉（选了/跳过/不用流程都算）再连同结果一起报 */
  const [justScanned, setJustScanned] = useState<{
    added: number;
    total: number;
  } | null>(null);

  /** 注册时的扫描结果拼成一句话，接在模板层关闭后的提示里（消费一次即清）。
   *  0 条也要说——用户得知道「扫过了、确实没有」，而不是以为系统什么都没做 */
  function scanSuffix(): string {
    const v = justScanned;
    if (v === null) return "";
    setJustScanned(null);
    // total = 该项目当前登记的资源总数，added = 本次新登记的。
    // 只看 added 会在「重复添加已有项目」时报「没扫到」，而资源面板明明有一堆——
    // 与项目内的「已自动扫描：N」自相矛盾（v3.88 修）
    if (v.total > 0)
      return v.added > 0
        ? `；扫到并登记了 ${v.added} 个文献/数据文件`
        : `；已有 ${v.total} 个文献/数据文件`;
    return "；没扫到 PDF / 数据 / 引文，可在「文献与数据」导入";
  }

  const [workspaceMenu, setWorkspaceMenu] = useState<{
    x: number;
    y: number;
    ws: WorkspaceDto;
  } | null>(null);
  const [detailsPopover, setDetailsPopover] = useState<{
    x: number;
    y: number;
    ws: WorkspaceDto;
  } | null>(null);
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [projectSurfaceTabs, setProjectSurfaceTabs] = useState<
    Record<string, ProjectSurfaceTab>
  >({});
  const [projectRailCollapsed, setProjectRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem(PROJECT_RAIL_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  // 任务行产物清单手风琴：按工作区 id 记忆展开态，切项目时清空
  const [artifactsOpen, setArtifactsOpen] = useState<Set<string>>(new Set());
  const openInTerminal = useOpenInTerminal();
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const setPage = useAppStore((s) => s.setPage);
  const setSessionsQuery = useAppStore((s) => s.setSessionsQuery);
  const runningScripts = useAppStore((s) => s.runningScripts);
  // 终端标签运行状态镜像（TerminalPage 写入，首页「待你处理」用）；跳转派发统一走 runInboxAction
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  // 收件箱条目数镜像给侧栏「工作区」徽标 + 标题栏收件箱（本页唯一写入方，签名变更才写）
  const setInboxItems = useAppStore((s) => s.setInboxItems);
  // 「◈ 提炼接力」后台任务（store）：ready 未消费 → 收件箱「待发送」
  const digestJob = useAppStore((s) => s.digestJob);
  // profile 三层验证失败镜像（ProfilesPage 写入），收件箱只读；已删除的 profile 惰性剔除
  const profileIssues = useAppStore((s) => s.profileIssues);
  const profiles = useAppStore((s) => s.profiles);
  // 依赖体检镜像（store，启动时探测一次）：git 非 ok → 收件箱常驻「依赖」条目
  const depCheck = useAppStore((s) => s.depCheck);
  const appUpdate = useAppStore((s) => s.appUpdate);
  // 收件箱「去核验」一次性请求：选中该工作区所属项目并展开其任务行的产物清单
  const artifactCheckReq = useAppStore((s) => s.artifactCheckReq);
  const setArtifactCheckReq = useAppStore((s) => s.setArtifactCheckReq);
  // 对话页卡片 chip → 选中对应项目的一次性请求（项目根路径）
  const selectProjectReq = useAppStore((s) => s.selectProjectReq);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const projectFocusReq = useAppStore((s) => s.projectFocusReq);
  const setProjectFocusReq = useAppStore((s) => s.setProjectFocusReq);
  const inboxDismissed = useAppStore((s) => s.inboxDismissed);
  // 产物待核验（后端只读检查，随 refresh 同频次拉取）：绑定步骤的预期产物全部产出且够新
  const [artifactReady, setArtifactReady] = useState<PendingArtifactDto[]>([]);
  // agent 人工请求（.ccode/help-wanted.md，随 refresh 同频次拉取；失败静默下轮重试）
  const [helpRequests, setHelpRequests] = useState<HelpRequestDto[]>([]);
  // 文献雷达新命中（收件箱「文献」胶囊）：随 refresh 同频次拉 schedules，判定纯逻辑在 lit-watch.ts
  const [litCandidates, setLitCandidates] = useState<LitInboxCandidate[]>([]);
  const [litEntriesByRoot, setLitEntriesByRoot] = useState<
    Record<string, WatchEntryDto[]>
  >({});

  async function loadLitInbox() {
    try {
      const list = await invoke<ScheduleDto[]>("list_schedules");
      const cands = litInboxCandidates(list);
      setLitCandidates(cands);
      const roots = [...new Set(cands.map((c) => c.projectRoot))];
      const entries: Record<string, WatchEntryDto[]> = {};
      await Promise.all(
        roots.map(async (root) => {
          try {
            const inbox = await invoke<WatchInboxDto>("list_watch_entries", {
              projectRoot: root,
            });
            entries[root] = inbox.entries;
          } catch {
            entries[root] = [];
          }
        }),
      );
      setLitEntriesByRoot(entries);
    } catch {
      /* 下轮重试 */
    }
  }
  // help: 条目屏蔽表（store 镜像 localStorage）：签名一致不生成条目，内容变了自动复现
  const helpDismissed = useAppStore((s) => s.helpDismissed);
  const dismissHelpRequest = useAppStore((s) => s.dismissHelpRequest);
  const dismissInbox = useAppStore((s) => s.dismissInbox);
  // 人工请求「去查看」的完整内容层（v3.97）：strip 行只有 40 字截断预览，
  // 「选中项目」单独作为动作反馈太弱（已选中时像没反应）——弹出该来源的全部请求全文
  const helpViewReq = useAppStore((s) => s.helpViewReq);
  const setHelpViewReq = useAppStore((s) => s.setHelpViewReq);
  const [helpView, setHelpView] = useState<HelpRequestDto | null>(null);
  useEffect(() => {
    if (!helpViewReq) return;
    setHelpView(helpRequests.find((h) => h.root === helpViewReq) ?? null);
    setHelpViewReq(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helpViewReq, helpRequests]);
  // 会话清单（启动即加载）：外部 live 会话的收件箱入口
  const sessions = useAppStore((s) => s.sessions);
  // 外部 live 会话（无终端标签可跳）的尾部注意力：后端直查 session_tail_state，
  // 补齐收件箱在终端页未挂载时的盲区；只查 live 且非内部的少量会话（上限 10 条）
  const [liveTail, setLiveTail] = useState<Record<string, string>>({});
  const liveSig = sessions
    .filter((s) => s.live && !s.internal)
    .map((s) => `${s.agent}:${s.sessionId}`)
    .join("\n");
  useEffect(() => {
    if (!visible) return;
    const targets = sessions
      .filter((s) => s.live && !s.internal)
      .slice(0, 10);
    let cancelled = false;
    void Promise.all(
      targets.map(async (s) => {
        try {
          const state = await invoke<string>("session_tail_state", {
            agent: s.agent,
            filePath: s.filePath,
          });
          return [`${s.agent}:${s.sessionId}`, state] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const e of entries) if (e) map[e[0]] = e[1];
      setLiveTail(map);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, liveSig]);

  async function refresh() {
    try {
      const list = await invoke<WorkspaceDto[]>("list_workspaces");
      setWorkspaces(list);
      // 项目注册表：失败不阻断工作区列表，分组退化为仅按 repo 归组
      invoke<ProjectDto[]>("list_projects")
        .then((list) => {
          setProjects(list);
          useAppStore.getState().setProjectPaths(list.map((p) => p.path));
          for (const p of list) {
            if (normalizeWorkMode(p.workMode) === "coding") {
              prefetchCodingOverview(p.path);
            }
          }
        })
        .catch(() => toast("项目注册表读取失败，已按工作区列表继续显示", "warning"));
      setRefreshToken((t) => t + 1);
      const driftFailures: Record<string, boolean> = {};
      const driftEntries = await Promise.all(
        list.map(async (workspace) => {
          try {
            return [
              workspace.id,
              await invoke<WorkspaceDriftDto>("workspace_drift", {
                id: workspace.id,
              }),
            ] as const;
          } catch {
            driftFailures[workspace.id] = true;
            return null;
          }
        }),
      );
      setDrift(
        Object.fromEntries(driftEntries.filter((entry) => entry !== null)),
      );
      setDriftFailed(driftFailures);
      // 活跃工作区所在仓库的 settings（按 repoPath 缓存，不重复拉取）
      const repos = [
        ...new Set(
          list.filter((w) => w.status === "active").map((w) => w.repoPath),
        ),
      ];
      const settingsFailures: string[] = [];
      const entries = await Promise.all(
        repos.map(async (r) => {
          try {
            return [
              r,
              await invoke<WsSettingsDto>("workspace_settings", {
                repoPath: r,
              }),
            ] as const;
          } catch {
            settingsFailures.push(r);
            return null; // 无 settings.toml 仍允许工作区列表继续展示
          }
        }),
      );
      setSettings((prev) => {
        const next = { ...prev };
        for (const e of entries) {
          // 每次刷新无条件覆盖：settings.toml 新建/修改后回到本页即生效
          if (e) next[e[0]] = e[1];
        }
        return next;
      });
      // 活跃工作区的健康度（每次刷新覆盖，ReadyToMerge 判定随提交/合并变化）
      const activeIds = list
        .filter((w) => w.status === "active")
        .map((w) => w.id);
      const healthFailures: Record<string, boolean> = {};
      const healthEntries = await Promise.all(
        activeIds.map(async (id) => {
          try {
            return [
              id,
              await invoke<WorkspaceHealthDto>("workspace_health", { id }),
            ] as const;
          } catch {
            healthFailures[id] = true;
            return null;
          }
        }),
      );
      setHealth((prev) => {
        const next = { ...prev };
        for (const e of healthEntries) {
          if (e) next[e[0]] = e[1];
        }
        return next;
      });
      setHealthFailed(healthFailures);
      // 产物待核验：与健康度同频次（页可见刷新/事件驱动），失败静默（下轮重试）
      invoke<PendingArtifactDto[]>("pending_artifact_checks")
        .then(setArtifactReady)
        .catch(() => toast("产物核验状态未检测到，刷新后可重试", "warning"));
      // agent 人工请求（.ccode/help-wanted.md）：同频次拉取，失败静默（下轮重试）
      invoke<HelpRequestDto[]>("list_help_requests")
        .then(setHelpRequests)
        .catch(() => toast("人工请求未检测到，刷新后可重试", "warning"));
      // 文献雷达新命中（收件箱「文献」胶囊）：同频次拉取，失败静默（下轮重试）
      void loadLitInbox();
      setError(
        settingsFailures.length > 0
          ? `部分工作区设置加载失败：${settingsFailures
              .map(pathBaseName)
              .join("、")}。请刷新后重试。`
          : null,
      );
    } catch (e) {
      setError(String(e));
    }
  }

  /** run 脚本：开 shell 标签并立即执行命令；wsId 用于 nonconcurrent 互斥 */
  async function runScript(ws: WorkspaceDto, script: RunScriptDto) {
    try {
      const pairs = await invoke<[string, string][]>("workspace_env_for", {
        worktreePath: ws.worktreePath,
      });
      setPendingTerminal({
        cwd: ws.worktreePath,
        extraEnv: Object.fromEntries(pairs),
        title: `run: ${script.name}`,
        prefillCommand: script.command,
        shellOnly: true,
        wsId: ws.id,
      });
      setPage("terminal");
    } catch (e) {
      setError(`无法启动脚本「${script.name}」：${String(e)}`);
    }
  }

  useEffect(() => {
    if (!visible) return;
    void refresh();
  }, [visible]);

  // 「agent 已跑完」跃迁触发一次 refresh（v3.97）：步骤状态只从 git 派生，agent 干完若已提交，
  // 不重拉 health 就永远停在「进行中」。terminalRunInputs 是 TerminalPage 镜像进 store 的既有信号，
  // 这里只认「上次非 done → 本次 done」的跃迁（按 cwd 记已触发，回落后再 done 可再触发），不轮询。
  const doneSeenRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (!visible) return;
    let hit = false;
    for (const input of terminalRunInputs) {
      const cwd = input.cwd;
      const isDone = input.attention === "done";
      if (isDone && !doneSeenRef.current[cwd]) hit = true;
      doneSeenRef.current[cwd] = isDone;
    }
    if (hit) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, terminalRunInputs]);

  // 定时巡检跑完：重拉 schedules 刷新收件箱「文献」胶囊（ScheduleSection 同款监听模式；
  // 全局 OS 通知在 App.tsx 另行监听，这里只管收件箱条目）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const reloadLit = () => {
      void loadLitInbox();
    };
    listen<SchedulerRunDonePayload>("scheduler-run-done", reloadLit)
      .then((u) => (unlisten = u))
      .catch(() => toast("定时任务完成事件监听失败，收件箱可能不会自动刷新", "warning"));
    let unlistenAdopt: (() => void) | undefined;
    listen("watch-run-adopted", reloadLit)
      .then((u) => (unlistenAdopt = u))
      .catch(() => {});
    return () => {
      unlisten?.();
      unlistenAdopt?.();
    };
  }, []);

  async function onRestore(ws: WorkspaceDto) {
    try {
      await invoke("restore_workspace", { id: ws.id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDelete(ws: WorkspaceDto) {
    if (
      !(await confirmDialog(
        `将删除 worktree、分支 ${ws.branch} 和元数据，不可恢复。继续？`,
        { danger: true },
      ))
    )
      return;
    try {
      await invoke("delete_workspace", { id: ws.id });
      // 清掉指向该工作区的「已创建」横幅，避免删除后残留
      setCreated((c) => (c?.id === ws.id ? null : c));
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRepairRemount(ws: WorkspaceDto) {
    try {
      await invoke<WorkspaceDto>("workspace_repair_remount", { id: ws.id });
      await refresh();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function onRelocate(ws: WorkspaceDto) {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    try {
      await invoke<WorkspaceDto>("workspace_relocate_repo", {
        id: ws.id,
        newRepoPath: selected,
      });
      await refresh();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function onMarkArchived(ws: WorkspaceDto) {
    if (!(await confirmDialog("仅把 Mesa 记录标记为已归档，不删除分支。继续？")))
      return;
    try {
      await invoke("workspace_mark_archived", { id: ws.id });
      await refresh();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function onCleanRecord(ws: WorkspaceDto) {
    if (
      !(await confirmDialog(
        `只清理 Mesa 中「${ws.name}」的记录并释放端口，不删除磁盘目录或 Git 分支。继续？`,
      ))
    )
      return;
    try {
      await invoke("workspace_clean_record", { id: ws.id });
      setCreated((current) => (current?.id === ws.id ? null : current));
      await refresh();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  const active = workspaces.filter(
    (workspace) => workspace.status === "active",
  );
  // 分组 = 注册项目（last_opened 降序）∪ 未注册的工作区 repo 组；注册项目没有工作区也显示
  const repoPaths = [...new Set(workspaces.map((w) => w.repoPath))];
  const groups: {
    key: string;
    project: ProjectDto | null;
    repoPath: string;
    repoName: string;
    list: WorkspaceDto[];
  }[] = [
    ...projects.map((project) => ({
      key: `p:${project.path}`,
      project,
      repoPath: project.path,
      repoName: project.name,
      list: workspaces.filter(
        (w) =>
          (project.id && w.projectId === project.id) ||
          samePath(w.repoPath, project.path),
      ),
    })),
    ...repoPaths
      .filter((rp) => !projects.some((p) => samePath(p.path, rp)))
      .map((repoPath) => ({
        key: `r:${repoPath}`,
        project: null,
        repoPath,
        repoName: workspaces.find((w) => w.repoPath === repoPath)!.repoName,
        list: workspaces.filter((w) => w.repoPath === repoPath),
      })),
  ];
  // 栏内按工作方式分段；groups 本身仍是 last_opened 序，默认选中最近打开的那一项
  const railSections = groupByWorkMode(groups, (g) =>
    g.project ? g.project.workMode : "unregistered",
  );
  const selectedGroup =
    groups.find((group) => group.key === selectedGroupKey) ?? groups[0] ?? null;
  const selectedProjectPath = selectedGroup?.project?.path ?? null;
  const selectedSurfaceTab: ProjectSurfaceTab =
    selectedProjectPath && selectedGroup?.project
      ? (() => {
          const tabs = projectSurfaceTabsForMode(selectedGroup.project.workMode);
          const stored =
            projectSurfaceTabs[selectedProjectPath] ??
            readProjectSurfaceTab(
              selectedProjectPath,
              undefined,
              selectedGroup.project.workMode,
            );
          return tabs.includes(stored) ? stored : DEFAULT_PROJECT_SURFACE_TAB;
        })()
      : DEFAULT_PROJECT_SURFACE_TAB;
  const selectedWorkMode = selectedGroup?.project
    ? normalizeWorkMode(selectedGroup.project.workMode)
    : null;
  const [identityChrome, setIdentityChrome] = useState<{
    action: ProjectChromeAction;
    token: number;
  } | null>(null);
  useEffect(() => {
    setIdentityChrome(null);
  }, [selectedGroupKey]);
  useEffect(() => {
    if (visible) return;
    setIdentityChrome(null);
  }, [visible]);
  function requestIdentityChrome(action: ProjectChromeAction) {
    if (action !== "rename" && action !== "topic") selectProjectSurface("tasks");
    setIdentityChrome({ action, token: Date.now() });
  }
  function consumeIdentityChrome() {
    setIdentityChrome(null);
  }
  const projectSurfaceReq = useAppStore((s) => s.projectSurfaceReq);
  const setProjectSurfaceReq = useAppStore((s) => s.setProjectSurfaceReq);
  const filePreviewReq = useAppStore((s) => s.filePreviewReq);
  const setFilePreviewReq = useAppStore((s) => s.setFilePreviewReq);
  useEffect(() => {
    if (!projectSurfaceReq || !selectedProjectPath) return;
    try {
      localStorage.setItem(
        projectSurfaceStorageKey(selectedProjectPath),
        projectSurfaceReq,
      );
    } catch {
      /* 存储不可用只影响本次页签 */
    }
    setProjectSurfaceTabs((current) => ({
      ...current,
      [selectedProjectPath]: projectSurfaceReq,
    }));
    setProjectSurfaceReq(null);
  }, [projectSurfaceReq, selectedProjectPath, setProjectSurfaceReq]);
  function selectProjectSurface(tab: ProjectSurfaceTab) {
    if (!selectedProjectPath) return;
    try {
      localStorage.setItem(projectSurfaceStorageKey(selectedProjectPath), tab);
    } catch {
      /* 隐私模式或存储不可用时仍保持本次页面状态 */
    }
    setProjectSurfaceTabs((current) => ({
      ...current,
      [selectedProjectPath]: tab,
    }));
  }
  useEffect(() => {
    if (!filePreviewReq || !selectedProjectPath) return;
    if (!samePath(filePreviewReq.projectRoot, selectedProjectPath)) return;
    selectProjectSurface("files");
  }, [filePreviewReq, selectedProjectPath]);
  // 顶栏上下文镜像（v3.88）：本页是唯一写入方，顶栏跨页只读消费，不新增任何请求
  const setContextLabel = useAppStore((s) => s.setContextLabel);
  const contextProject = selectedGroup
    ? (selectedGroup.project?.name ?? pathBaseName(selectedGroup.repoPath))
    : null;
  const contextProjectPath = selectedGroup
    ? (selectedGroup.project?.path ?? selectedGroup.repoPath)
    : null;
  useEffect(() => {
    setContextLabel(
      contextProject
        ? { project: contextProject, projectPath: contextProjectPath, step: null }
        : null,
    );
  }, [contextProject, contextProjectPath, setContextLabel]);
  const groupKeySignature = groups.map((group) => group.key).join("\n");
  useEffect(() => {
    if (groups.length === 0) {
      if (selectedGroupKey !== null) setSelectedGroupKey(null);
      return;
    }
    if (!groups.some((group) => group.key === selectedGroupKey)) {
      setSelectedGroupKey(groups[0].key);
    }
  }, [groupKeySignature, selectedGroupKey]);
  // 切项目（含分组表重算后的被动切换）时收起所有产物清单
  const shownGroupKey = selectedGroup?.key ?? null;
  useEffect(() => {
    setArtifactsOpen(new Set());
  }, [shownGroupKey]);

  function toggleProjectRail() {
    setProjectRailCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        localStorage.setItem(PROJECT_RAIL_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // 本地存储失败不应阻断界面切换。
      }
      return next;
    });
  }

  // 课题状态（rail 行与收起态切换菜单同口径）：
  // 待处理 = 工作区冲突/可合并 + 归属本项目的终端待确认/外部 live 待确认；
  // 绿点只认此刻还在跑的 Agent，未归档工作区本身不亮。
  function groupRailStatus(group: (typeof groups)[number]) {
    const needsAttention =
      group.list.filter((workspace) => {
        const state = health[workspace.id];
        return state?.conflict || state?.readyToMerge;
      }).length + (navAttention.get(group.key) ?? 0);
    const railDot = projectRailStatus({
      needsAttention,
      roots: [
        group.repoPath,
        ...group.list.map((workspace) => workspace.worktreePath),
      ],
      runs: terminalRunInputs,
    });
    return { needsAttention, railDot };
  }

  function toggleArtifacts(wsId: string) {
    setArtifactsOpen((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  }
  const actionBtn = inlineActionClass;
  // hover 才现的低频操作：键盘 Tab 聚焦（focus-visible）同样显示，保持可达
  const hoverReveal = hoverRevealClass;
  // 行内唯一实心主动作：普通评审 cta 实心；冲突场景 warn 色实心
  const reviewCta =
    "inline-flex h-7 items-center justify-center rounded-md border border-cta-bd bg-cta px-2 text-xs text-cta-text hover:brightness-110";
  const reviewWarn =
    "inline-flex h-7 items-center justify-center rounded-md border border-warn-text/40 bg-warn px-2 text-xs text-warn-text hover:brightness-110";

  function openReview(
    workspace: WorkspaceDto,
    action?: "pr" | "archive" | "resolve-conflict",
  ) {
    setWorkspaceReviewRequest({
      worktreePath: workspace.worktreePath,
      runId: runIdForPath(terminalRunInputs, workspace.worktreePath),
      action,
      requestId: crypto.randomUUID(),
    });
    setPage("terminal");
  }

  // 「待你处理」首页聚合（v3.39）：打开应用第一眼看到要拍板的事——
  // 工作区冲突/可合并（health 随页加载）+ 终端标签待确认（store 镜像，跨页可读）。
  // 排序：冲突 > 待确认 > 可合并；为空时整个区块不渲染（零噪音）。
  // 「已回复」不进收件箱——回合结束每轮都发生、不阻塞决策（同口径：标签/项目区/通知均不打点）。
  const runItems = buildRunOverview(terminalRunInputs).items;

  // 收件箱条目为可序列化数据（action 描述而非闭包）：镜像进 store 供 App 标题栏收件箱共用，
  // 点击统一走 store.ts 的 runInboxAction 派发
  const depItem = depInboxItem(depCheck);
  const updateItem = appUpdateInboxEntry(
    appUpdate
      ? { version: appUpdate.version, currentVersion: appUpdate.currentVersion }
      : null,
  );
  const inboxItems = [
    ...active
      .filter((w) => health[w.id]?.conflict)
      .map((w) => ({
        key: `conflict:${w.id}`,
        dot: "bg-warn-text",
        // 基准已前进：继续按旧两侧选边是在解过期冲突，必须先重新同步
        text: health[w.id]?.staleBase
          ? inboxTaskLine(w.name, "需重新同步")
          : inboxTaskLine(w.name, "有冲突"),
        actionLabel: health[w.id]?.staleBase ? "重新同步" : "解决冲突",
        action: {
          type: "review" as const,
          worktreePath: w.worktreePath,
          runId: runIdForPath(terminalRunInputs, w.worktreePath),
          intent: "resolve-conflict" as const,
        },
      })),
    ...runItems
      .filter((it) => it.attention === "confirm")
      .map((it) => ({
        key: `confirm:${it.runId ?? it.tabId}`,
        dot: "bg-warn-text",
        text: inboxTaskLine(
          inboxTaskLabel({ title: it.title, cwdLabel: it.cwdLabel }),
          "待确认",
        ),
        actionLabel: "去处理",
        action: it.runId
          ? { type: "run" as const, runId: it.runId }
          : { type: "run" as const, tabId: it.tabId },
      })),
    // 外部运行（无终端标签）的会话：后端直查尾部状态，待确认时进收件箱
    ...sessions
      .filter(
        (s) =>
          s.live &&
          !s.internal &&
          liveTail[`${s.agent}:${s.sessionId}`] === "confirm",
      )
      .map((s) => ({
        key: `live:${s.agent}:${s.sessionId}`,
        dot: "bg-warn-text",
        text: inboxTaskLine(
          inboxTaskLabel({
            title: s.customTitle ?? s.title,
            cwdLabel: pathBaseName(s.projectPath),
          }),
          "待确认",
        ),
        actionLabel: "去查看",
        action: {
          type: "session" as const,
          agent: s.agent,
          sessionId: s.sessionId,
        },
      })),
    // 文献雷达新命中（lit:<scheduleId>:<lastRunAt>；24h 窗口与 newEntries 判定在
    // lit-watch.ts 的 litInboxCandidates）：点击经 selectProjectReq 跳该项目详情。
    // 已删项目的定时任务可能还在 schedules.json，不能拿文件夹名继续提示。
    ...litInboxForRegisteredProjects(
      litCandidates,
      projects.map((p) => p.path),
      IS_WINDOWS,
    ).flatMap((c): InboxItem[] => {
      const projectName =
        projects.find((p) => samePath(p.path, c.projectRoot))?.name ??
        pathBaseName(c.projectRoot);
      if (c.isolationPath && !c.adopted) {
        return [
          {
            key: `lit:${c.scheduleId}:${c.at}`,
            dot: "bg-ok-text",
            text: inboxTaskLine(projectName, `有${c.count}条新命中待评审`),
            actionLabel: "去评审",
            action: {
              type: "review" as const,
              worktreePath: c.isolationPath,
              runId: c.runId ?? null,
            },
          },
        ];
      }
      const papers = papersForLitCandidate(
        c,
        litEntriesByRoot[c.projectRoot] ?? [],
      );
      if (papers.length === 0) {
        return [
          {
            key: `lit:${c.scheduleId}:${c.at}`,
            dot: "bg-ok-text",
            text: inboxTaskLine(projectName, `有${c.count}条新命中`),
            actionLabel: "去看看",
            action: { type: "litWatch" as const, projectRoot: c.projectRoot },
          },
        ];
      }
      return papers.map((paper) => ({
        key: `lit:${c.scheduleId}:${paper.id}`,
        dot: "bg-ok-text",
        text: paper.zhSummary || paper.title,
        actionLabel: "开读",
        action: {
          type: "litWatch" as const,
          projectRoot: c.projectRoot,
          entryId: paper.id,
          title: paper.title,
          url: paper.url,
        },
      }));
    }),
    ...active
      .filter((w) =>
        workspaceReviewInboxEligible({
          readyToMerge: health[w.id]?.readyToMerge,
          conflict: health[w.id]?.conflict,
          agentBusy: workspaceAgentBusy(
            w.worktreePath,
            terminalRunInputs,
          ),
        }),
      )
      .map((w) => ({
        key: `ready:${w.id}`,
        dot: "bg-ok-text",
        text: inboxTaskLine(w.name, "待评审"),
        actionLabel: "去评审",
        action: {
          type: "review" as const,
          worktreePath: w.worktreePath,
          runId: runIdForPath(terminalRunInputs, w.worktreePath),
        },
      })),
    // 产物待核验：预期产物已全部产出但尚无提交（可合并/冲突已覆盖的情形不重复报）——
    // 产物多为 gitignore 的文件（*.pdf 等），git 状态永远看不见，不提醒就是黑洞
    ...artifactReady
      .filter((a) => {
        const h = health[a.workspaceId];
        return !h?.readyToMerge && !h?.conflict;
      })
      .map((a) => ({
        key: `artifacts:${a.workspaceId}`,
        dot: "bg-ok-text",
        text: inboxTaskLine(a.workspaceName, "待核验"),
        actionLabel: "去核验",
        action: { type: "artifacts" as const, workspaceId: a.workspaceId },
      })),
    // agent 人工请求（.ccode/help-wanted.md）：插在可合并/待核验之后；
    // dismiss 后签名一致不生成，文件内容变了（签名不同）自动复现
    ...helpRequests
      .filter((h) => h.items.length > 0)
      .filter(
        (h) => !isHelpDismissed(helpDismissed, h.root, helpSignature(h.items)),
      )
      .map((h) => ({
        key: `help:${h.root}`,
        dot: "bg-warn-text",
        text: inboxTaskLine(
          h.workspaceName ?? "主仓",
          `有人工请求：${helpPreview(h.items[0])}`,
        ),
        actionLabel: "去查看",
        dismissSignature: helpSignature(h.items),
        action: { type: "help" as const, projectRoot: h.root },
      })),
    // 接力简报已生成待发送：提炼在后台完成，交接链断在人这里
    ...(digestJob && digestJob.status === "ready" && !digestJob.consumed
      ? [
          {
            key: "digest",
            dot: "bg-ok-text",
            text: inboxTaskLine(digestJob.title || "对话", "待发送"),
            actionLabel: "去发送",
            action: { type: "digest" as const },
          },
        ]
      : []),
    // profile 验证失败：agent 起不来 = 停工；只镜像用户触发的验证结果，不新增后台轮询
    ...Object.entries(profileIssues)
      .filter(([id]) => profiles.some((p) => p.id === id))
      .map(([id, issue]) => ({
        key: `profile:${id}`,
        dot: "bg-warn-text",
        text: `配置「${issue.name}」验证失败：${issue.reason}`,
        actionLabel: "去修复",
        action: { type: "profiles" as const },
      })),
    // 缺 git 的常驻提醒（node 缺失不进收件箱——它只是 npm 渠道依赖，装 CLI 时才提示）：
    // 装好后 depCheck 刷新为 ok，条目自动消失；dismiss 走现成签名机制
    ...(depItem
      ? [
          {
            key: depItem.key,
            dot: "bg-warn-text",
            text: depItem.text,
            actionLabel: "去处理",
            action: { type: "settings" as const, section: "diag" },
          },
        ]
      : []),
    ...(updateItem ? [updateItem] : []),
  ] as InboxItem[];

  // 项目导航行的「待处理」分布（收件箱同款口径按项目摊开）：终端待确认 +
  // 外部 live 待确认，cwd 经最长前缀归属项目根/工作树（attributeToProject 纯逻辑）
  const projectRoots = groups.map((g) => ({
    key: g.key,
    roots: [g.repoPath, ...g.list.map((w) => w.worktreePath)],
  }));
  const navAttention = new Map<string, number>();
  const bumpAttention = (path: string) => {
    const key = attributeToProject(path, projectRoots);
    if (key) navAttention.set(key, (navAttention.get(key) ?? 0) + 1);
  };
  for (const it of runItems) {
    if (it.attention === "confirm") bumpAttention(it.cwd);
  }
  for (const s of sessions) {
    if (
      s.live &&
      !s.internal &&
      liveTail[`${s.agent}:${s.sessionId}`] === "confirm"
    )
      bumpAttention(s.projectPath);
  }

  // 收件箱条目镜像进 store（本页常驻挂载，签名变更才写，防每 render 抖动订阅方）
  const inboxSig = inboxItems.map((it) => `${it.key}=${it.text}`).join("|");
  useEffect(() => {
    setInboxItems(filterDismissed(inboxItems, useAppStore.getState().inboxDismissed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxSig, setInboxItems]);

  // 收件箱「去核验」一次性请求：选中该工作区所属项目并展开其任务行的产物清单；
  // v3.97 补强——原实现只改选中态，已选中/已展开时毫无视觉反馈（用户实测「点了没反应」）：
  // ① 聚焦切到该工作区所属步骤（否则聚焦过滤会把目标行藏掉）② 行滚动进视野 + 短暂高亮
  const [focusStepReq, setFocusStepReq] = useState<{
    wsName: string;
    token: number;
  } | null>(null);
  const [flashWsId, setFlashWsId] = useState<string | null>(null);
  useEffect(() => {
    if (!artifactCheckReq) return;
    const g = groups.find((gr) =>
      gr.list.some((w) => w.id === artifactCheckReq),
    );
    if (g) {
      const ws = g.list.find((w) => w.id === artifactCheckReq)!;
      setSelectedGroupKey(g.key);
      setArtifactsOpen((prev) => new Set(prev).add(artifactCheckReq));
      setFocusStepReq({ wsName: ws.name, token: Date.now() });
      setFlashWsId(ws.id);
    }
    setArtifactCheckReq(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactCheckReq, groups]);

  // 高亮闪烁 2.5s 自动消退（与「文献与数据」进料口 ring 口径一致）；渲染后滚动进视野
  useEffect(() => {
    if (!flashWsId) return;
    const t = window.setTimeout(() => setFlashWsId(null), 2500);
    // 等聚焦切换+手风琴展开渲染完再滚
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-ws-row="${CSS.escape(flashWsId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.clearTimeout(t);
  }, [flashWsId]);

  // 对话页卡片 chip / 收件箱「去查看」的一次性跳转：按项目根或工作树根选中分组
  //（无对应分组静默忽略，与 focusTabReq 同口径）
  useEffect(() => {
    if (!selectProjectReq) return;
    const g = groups.find(
      (gr) =>
        samePath(gr.repoPath, selectProjectReq) ||
        gr.list.some((w) => samePath(w.worktreePath, selectProjectReq)),
    );
    if (!g) {
      // 页面刚切入时项目列表可能仍在加载；保留请求到下一次 groups 更新，
      // 避免收件箱点击在空列表首帧被静默吞掉。
      if (groups.length === 0) return;
      setSelectProjectReq(null);
      return;
    }
    setSelectedGroupKey(g.key);
    setSelectProjectReq(null);
    // 工作台「待你验收」同行还派了 taskReviewReq：消费它的 ProjectUserTasksView
    // 只在「任务」页签挂载——若该项目上次停在「文件/Agents」，请求会永远无人消费。
    // 这里一并把该项目切到任务页（写持久键 + 内存态，与 selectProjectSurface 同口径）
    const reviewReq = useAppStore.getState().taskReviewReq;
    const focusReq = useAppStore.getState().projectFocusReq;
    let tab: ProjectSurfaceTab | null = null;
    if (reviewReq && g.project && samePath(reviewReq.projectRoot, g.repoPath)) {
      tab = "tasks";
    } else if (
      focusReq &&
      g.project &&
      samePath(focusReq.projectRoot, g.repoPath) &&
      (focusReq.focus === "lit" || focusReq.focus === "schedule")
    ) {
      tab = "schedules";
    }
    if (tab) {
      try {
        localStorage.setItem(projectSurfaceStorageKey(g.repoPath), tab);
      } catch {
        /* 存储不可用只影响下次进来时的页签记忆 */
      }
      setProjectSurfaceTabs((current) => ({
        ...current,
        [g.repoPath]: tab,
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectProjectReq, groups]);

  // Windows/Linux 页内收件箱：与标题栏同一套「待处理 N」单入口，点开列出全部分组
  const [inboxOpen, setInboxOpen] = useState(false);
  const inboxGroups = groupInbox(filterDismissed(inboxItems, inboxDismissed));
  useEffect(() => {
    if (inboxOpen && inboxGroups.length === 0) setInboxOpen(false);
  }, [inboxGroups, inboxOpen]);
  useEffect(() => {
    if (!inboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInboxOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inboxOpen]);

  // 人工请求 OS 通知（复用「长任务 OS 通知」开关，不新增设置项）：help 条目集合出现新
  // 来源（edge-trigger，对比上一轮 key 集合）且窗口隐藏时发一条系统通知；同一来源 30s
  // 去抖。判定纯逻辑在 inbox.ts（helpNotifyKeys），首轮刷新只建基线不通知。
  const notificationsEnabled = useAppStore(
    (s) => s.settings?.notificationsEnabled ?? true,
  );
  const helpPrevKeysRef = useRef<Set<string> | null>(null);
  const helpNotifySentRef = useRef(new Map<string, number>());
  const helpKeys = inboxItems
    .filter((it) => it.key.startsWith("help:"))
    .map((it) => it.key);
  const helpKeysSig = helpKeys.join("\n");
  useEffect(() => {
    // 已消失来源的清掉去抖记录，防 root 复用时沿用旧时间
    for (const key of [...helpNotifySentRef.current.keys()]) {
      if (!helpKeys.includes(key)) helpNotifySentRef.current.delete(key);
    }
    const prev = helpPrevKeysRef.current;
    helpPrevKeysRef.current = new Set(helpKeys);
    if (!notificationsEnabled) return;
    if (!document.hidden) return;
    const now = Date.now();
    const fresh = helpNotifyKeys(prev, helpKeys, helpNotifySentRef.current, now);
    if (fresh.length === 0) return;
    for (const key of fresh) helpNotifySentRef.current.set(key, now);
    void fireHelpNotification(fresh.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helpKeysSig, notificationsEnabled]);

  function workspaceMenuItems(workspace: WorkspaceDto) {
    const workspaceHealth = health[workspace.id];
    const workspaceDrift = drift[workspace.id];
    // drift 诊断失败时降级按 healthy 处理，行内另有「诊断失败」提示与重试
    const healthy =
      workspaceDrift?.healthy === true || !!driftFailed[workspace.id];
    const healthUnknown =
      !!healthFailed[workspace.id] && !workspaceHealth;
    const conflict =
      workspaceDrift?.canResolveMerge === true || workspaceHealth?.conflict === true;
    const canOpenWorkspace =
      workspace.status === "active" &&
      (workspaceDrift?.healthy === true ||
        conflict ||
        !!driftFailed[workspace.id]);
    const merged = isMerged(workspace, workspaceHealth);
    const items: {
      label: string;
      onSelect?: () => void;
      disabled?: boolean;
      title?: string;
    }[] = [];

    // 普通评审收进更多；正在发生的冲突保留行内直达入口。
    if (canOpenWorkspace && !merged && !conflict) {
      items.push({
        label: "评审",
        onSelect: () => openReview(workspace),
      });
    }

    if (workspace.status === "active" && healthy) {
      const workspaceSettings = settings[workspace.repoPath];
      const scripts = workspaceSettings?.run ?? [];
      const scriptsBlocked =
        workspaceSettings?.runMode === "nonconcurrent" &&
        !!runningScripts[workspace.id];
      if (scriptsBlocked) {
        // nonconcurrent 互斥时渲染禁用项并说明原因，不静默消失
        items.push(
          ...scripts.map((script) => ({
            label: `运行：${script.name}`,
            disabled: true,
            title: "已有运行中的脚本（nonconcurrent 模式）",
          })),
        );
      } else {
        items.push(
          ...scripts.map((script) => ({
            label: `运行：${script.name}`,
            onSelect: () => void runScript(workspace, script),
          })),
        );
      }
      // 健康检查失败导致 ahead 未知时也保留入口，由评审视图按实际状态处理
      if ((workspaceHealth?.ahead ?? 0) > 0 || healthUnknown) {
        items.push({
          label: "在评审中创建 PR",
          onSelect: () => openReview(workspace, "pr"),
        });
      }
      if (!workspaceHealth?.conflict) {
        items.push({
          label: "在评审中归档",
          onSelect: () => openReview(workspace, "archive"),
        });
      }
    }

    if (workspaceDrift && !workspaceDrift.healthy) {
      if (workspaceDrift.canRemount) {
        items.push({
          label: "重新挂载工作树",
          onSelect: () => void onRepairRemount(workspace),
        });
      }
      if (workspaceDrift.canRelocate) {
        items.push({
          label: "重新定位仓库",
          onSelect: () => void onRelocate(workspace),
        });
      }
      if (workspaceDrift.canMarkArchived) {
        items.push({
          label: "标记为已归档",
          onSelect: () => void onMarkArchived(workspace),
        });
      }
      if (workspaceDrift.canCleanRecord) {
        items.push({
          label: "清理 Mesa 记录",
          onSelect: () => void onCleanRecord(workspace),
        });
      }
    }

    if (workspace.status === "archived" && healthy) {
      items.push({
        label: "恢复",
        onSelect: () => void onRestore(workspace),
      });
    }

    items.push(
      {
        label: "查看对话",
        onSelect: () => {
          setSessionsQuery(workspace.name);
          setPage("sessions");
        },
      },
      {
        label: "复制工作树路径",
        onSelect: () => {
          void navigator.clipboard
            .writeText(workspace.worktreePath)
            .catch(() => {
              setError("复制工作树路径失败");
            });
        },
      },
    );
    if (healthy) {
      items.push({
        label: "删除工作区",
        onSelect: () => void onDelete(workspace),
      });
    }
    return items;
  }

  /** 添加项目主操作：系统对话框选目录 → 弹窗内联命名 → register_project */
  async function onAddProject() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    setAddProjectPath(selected);
  }

  const [demoBusy, setDemoBusy] = useState(false);
  /** 空态次入口：一键创建带演示数据的示例课题（后端幂等，重复点不重复建） */
  async function onCreateDemo() {
    setDemoBusy(true);
    try {
      const project = await invoke<ProjectDto>("create_demo_project");
      // 先落项目列表再选中分组：分组表由 projects 派生，反了会被空表 effect 重置
      const list = await invoke<ProjectDto[]>("list_projects");
      setProjects(list);
      useAppStore.getState().setProjectPaths(list.map((p) => p.path));
      setSelectedGroupKey(`p:${project.path}`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDemoBusy(false);
    }
  }

  /** 项目导航行右键菜单项：重命名/复制路径/移除注册/删除目录（后两者互斥粒度不同，删除目录对未注册分组也可用） */
  function railMenuItems(group: (typeof groups)[number]) {
    return [
      {
        label: "重命名项目",
        disabled: !group.project,
        title: group.project ? undefined : "这个文件夹还没添加到 Mesa",
        onSelect: () =>
          group.project &&
          setRenameTarget({ path: group.repoPath, name: group.project.name }),
      },
      {
        label: "复制项目路径",
        onSelect: () => {
          void navigator.clipboard
            .writeText(group.repoPath)
            .catch(() => setError("复制项目路径失败"));
        },
      },
      {
        label: "从 Mesa 移除",
        disabled: !group.project,
        title: group.project ? undefined : "这个文件夹还没添加到 Mesa",
        onSelect: () => group.project && void removeRegistration(group),
      },
      {
        label: "清除 Mesa 痕迹（保留文件夹）…",
        danger: true,
        title: "保留文件夹与你的全部文件；清掉工作区、.ccode 与注册记录",
        onSelect: () => void purgeTraces(group),
      },
      {
        label: "删除项目目录…",
        danger: true,
        onSelect: () => void deleteProjectDir(group),
      },
    ];
  }

  /** 清除 Mesa 痕迹（中间档）：文件夹与用户文件保留；工作区/分支彻底删，.ccode 入回收站，注册摘除 */
  async function purgeTraces(group: (typeof groups)[number]) {
    const name = group.project?.name ?? group.repoName;
    if (
      !(await confirmDialog(
        `清除「${name}」的 Mesa 痕迹？\n\n` +
          `文件夹与你的文件：保留\n` +
          `.ccode/（档案卡、任务卡、各步骤 TASK.md 内容）：移入回收站（可找回）\n` +
          `工作区 worktree 与分支、注册记录：彻底删除\n\n` +
          `注意：如果 .ccode 曾被 git 跟踪，改动面板会显示对应删除，需要你自行提交。请先关闭该项目内正在运行的终端标签。`,
        { danger: true },
      ))
    )
      return;
    try {
      const msg = await invoke<string>("purge_project_traces", {
        path: group.repoPath,
      });
      setNotice(msg);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 删除项目：工作区（彻底删）+ 主目录（移入回收站）+ 注册记录（未注册分组同样可用） */
  async function deleteProjectDir(group: (typeof groups)[number]) {
    const name = group.project?.name ?? group.repoName;
    if (
      !(await confirmDialog(
        `删除项目「${name}」？\n\n目录：${group.repoPath}\n工作区：${group.list.length} 个\n\n目录将移入系统回收站（可找回）；工作区的 worktree 与分支将彻底删除、不可恢复。请先关闭该项目内正在运行的终端标签。`,
        { danger: true },
      ))
    )
      return;
    try {
      await invoke<string>("delete_project_dir", { path: group.repoPath });
      // 删掉的是当前选中分组时，selectedGroupKey 回落由分组表 effect 处理
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 移除项目注册（只删注册记录，不动磁盘目录与工作区） */
  async function removeRegistration(group: (typeof groups)[number]) {
    const name = group.project?.name ?? group.repoName;
    if (
      !(await confirmDialog(
        `只移除「${name}」的项目注册，不删除磁盘目录；项目内工作区保留。继续？`,
      ))
    )
      return;
    try {
      await invoke("remove_project", { path: group.repoPath });
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <div className="relative flex h-full flex-col bg-rail2">
      {/* 待你处理（全局收件箱）：文档流单行 strip（只占 32px，不顶开工作台）；
          全空不渲染。按类别拆胶囊，点胶囊展开该类明细（悬浮下拉，遮罩/Esc 关闭）。
          macOS 上收件箱收进自绘标题栏（Ghostty 式），页内 strip 不渲染（Windows/Linux 保留本 strip） */}
      {!IS_MAC && inboxOpen && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => setInboxOpen(false)}
        />
      )}
      {!IS_MAC && inboxItems.length > 0 && (
        <section className="relative z-20 shrink-0 px-6 pt-2">
          <div className="relative mx-auto w-full">
            <button
              type="button"
              onClick={() => setInboxOpen((v) => !v)}
              aria-expanded={inboxOpen}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-micro text-l3 hover:bg-hover hover:text-l1"
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${inboxGroups[0]?.items[0]?.dot ?? "bg-l4"}`}
              />
              待处理 {inboxItems.length}
              <span className="text-l4">{inboxOpen ? "▴" : "▾"}</span>
            </button>
            {inboxOpen && (
              <ul className="absolute left-0 top-full z-20 mt-1 max-h-80 w-[360px] max-w-[80vw] space-y-2 overflow-auto rounded-md border border-field ccode-float-surface p-1">
                {inboxGroups.map((group) => (
                  <li key={group.category}>
                    <div className="px-2.5 py-1 text-micro text-l4">
                      {group.label} {group.items.length}
                    </div>
                    {group.items.map((item) => (
                      <div
                        key={item.key}
                        className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-xs hover:bg-hover"
                      >
                        <span
                          className={`size-2 shrink-0 rounded-full ${item.dot}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-l2">
                          {item.text}
                        </span>
                        <button
                          type="button"
                          title="忽略（状态变化后会重新出现）"
                          onClick={() =>
                            item.key.startsWith("help:")
                              ? dismissHelpRequest(
                                  item.key.slice("help:".length),
                                  item.dismissSignature ?? "",
                                )
                              : dismissInbox(item)
                          }
                          className="shrink-0 text-l4 hover:text-l1"
                        >
                          ✕
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setInboxOpen(false);
                            runInboxAction(item);
                          }}
                          className={rowActionClass}
                        >
                          {item.actionLabel}
                        </button>
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      <div className="flex min-h-0 flex-1">
      <aside
        className={`flex shrink-0 flex-col transition-[width,background-color,border-color] duration-150 ${
          projectRailCollapsed
            ? "w-0 overflow-hidden border-r-0 bg-transparent"
            : "ccode-workspaces-rail ccode-project-rail-open w-[208px] border-r border-hairline bg-rail2"
        }`}
      >
        {!projectRailCollapsed && (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 px-3">
              <span className="text-sm font-medium text-l1">项目</span>
              <span className="text-xs text-l4">{groups.length}</span>
              {/* 添加项目收进 rail 头部 + 菜单（含示例课题常驻入口）；页头实心 CTA 不变 */}
              <button
                type="button"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setAddMenu({ x: rect.right - 176, y: rect.bottom + 4 });
                }}
                title="添加项目 / 创建示例课题"
                aria-label="添加项目 / 创建示例课题"
                className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-sm text-l3 hover:bg-hover hover:text-l1"
              >
                +
              </button>
              <button
                type="button"
                onClick={toggleProjectRail}
                title="隐藏项目列表"
                aria-label="隐藏项目列表"
                className="flex h-7 w-7 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
              >
                <PanelLeftClose aria-hidden="true" size={16} strokeWidth={1.8} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1.5">
              {railSections.map((section, sectionIndex) => (
                <section
                  key={section.mode}
                  aria-label={RAIL_WORK_MODE_LABEL[section.mode]}
                >
                  <p
                    className={`px-4 text-micro text-l4 ${
                      sectionIndex === 0 ? "pb-0.5 pt-0.5" : "pb-0.5 pt-2.5"
                    }`}
                  >
                    {RAIL_WORK_MODE_LABEL[section.mode]}
                  </p>
                  {section.items.map((group) => {
                    const { needsAttention, railDot } = groupRailStatus(group);
                    const selected = selectedGroup?.key === group.key;
                    return (
                      <button
                        key={group.key}
                        type="button"
                        onClick={() => setSelectedGroupKey(group.key)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setRailMenu({
                            x: e.clientX,
                            y: e.clientY,
                            groupKey: group.key,
                          });
                        }}
                        title={group.repoPath}
                        className={`mx-1.5 mb-0.5 flex w-[calc(100%-12px)] items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                          selected
                            ? "bg-rail-sel text-l1"
                            : "text-l3 hover:bg-hover hover:text-l2"
                        }`}
                      >
                        {/* 状态点只在「有话说」时出现：待处理=黄 / 此刻 Agent 在跑=绿；
                            未归档工作区、闲置都不渲染（设计系统「无状态不渲染状态点」），占位保行对齐 */}
                        {railDot ? (
                          <span
                            className={`mt-1 size-2 shrink-0 rounded-full ${
                              railDot === "warn" ? "bg-warn-text" : "bg-ok-text"
                            }`}
                            title={railDot === "warn" ? "待处理" : "运行中"}
                          />
                        ) : (
                          <span className="mt-1 size-2 shrink-0" aria-hidden="true" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {group.project?.name ?? group.repoName}
                          </span>
                          {/* 副行只留「待处理」（与收件箱同口径）；类型已在组头，不逐行重复 */}
                          {needsAttention > 0 && (
                            <span className="mt-0.5 block truncate text-xs text-l4">
                              {needsAttention} 个待处理
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </section>
              ))}
              {groups.length === 0 && (
                <p className="px-3 py-4 text-xs text-l4">还没有项目</p>
              )}
            </div>
          </>
        )}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <PageFrame width="fluid" surface="workspace" fill>
      {selectedGroup && (
        <ProjectIdentityHeader
          project={selectedGroup.project}
          repoPath={selectedGroup.repoPath}
          repoName={selectedGroup.repoName}
          homeDir={homeDir}
          refreshToken={refreshToken}
          chromeReq={identityChrome}
          leading={
            projectRailCollapsed ? (
              <button
                type="button"
                onClick={toggleProjectRail}
                title="显示项目列表"
                aria-label="显示项目列表"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
              >
                <PanelLeftOpen aria-hidden="true" size={16} strokeWidth={1.8} />
              </button>
            ) : undefined
          }
          onOpenProjectSwitch={projectRailCollapsed ? setSwitchMenu : undefined}
          onRegisterProject={setAddProjectPath}
          onRefresh={refresh}
          onError={setError}
          onChromeAction={requestIdentityChrome}
        />
      )}
      {error && <p role="alert" className="mb-4 text-sm text-err-text">{error}</p>}
      {notice && (
        <NoticeBar className="mb-4" onDismiss={() => setNotice(null)}>
          {notice}
        </NoticeBar>
      )}
      {created && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md ccode-well px-3 py-2.5 text-xs text-l2">
          <span>
            <span className="mr-1 text-ok-text">✓</span>
            工作区「{created.name}」已创建 · 分支 {created.branch}
          </span>
          {created.setupResult?.ok && (
            <span className="text-l3">setup 脚本执行成功</span>
          )}
          {created.setupResult && !created.setupResult.ok && (
            <details className="text-err-text">
              <summary className="cursor-pointer">setup 脚本失败</summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-l3">
                {created.setupResult.outputTail}
              </pre>
            </details>
          )}
          <button
            type="button"
            onClick={() => {
              const workspace = created;
              setCreated(null);
              void openInTerminal(workspace);
            }}
            className="ml-auto inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-cta-bd bg-cta px-2 text-xs text-cta-text hover:brightness-110"
          >
            打开终端
          </button>
          <button
            type="button"
            onClick={() => setCreated(null)}
            aria-label="关闭"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1"
          >
            ×
          </button>
        </div>
      )}
      {groups.length === 0 ? (
        <EmptyState
          title="从一个项目文件夹开始"
          detail="选一个文件夹添加进来，并选择科研、编程或工作。"
          action={
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => void onAddProject()}
                className={primaryActionClass}
              >
                添加项目
              </button>
              <button
                type="button"
                disabled={demoBusy}
                onClick={() => void onCreateDemo()}
                title="带演示数据和完整研究流程，随时可以删"
                className={secondaryActionClass}
              >
                {demoBusy ? "正在创建…" : "✦ 创建示例课题"}
              </button>
            </div>
          }
        />
      ) : selectedGroup ? (
        <ProjectSurfaceTabs
          project={selectedGroup.project}
          active={selectedSurfaceTab}
          onChange={selectProjectSurface}
          taskPanel={
            selectedGroup.project && selectedWorkMode === "office" ? (
              <ProjectUserTasksView
                project={selectedGroup.project}
                chromeReq={identityChrome}
                onChromeConsumed={consumeIdentityChrome}
              />
            ) : undefined
          }
        >
        {selectedGroup.project && selectedSurfaceTab === "chats" ? (
          <ProjectChatsView
            project={selectedGroup.project}
            extraRoots={selectedGroup.list.map((item) => item.worktreePath)}
            onError={setError}
          />
        ) : selectedGroup.project && selectedSurfaceTab === "schedules" ? (
          <ProjectSchedulesView
            project={selectedGroup.project}
            focusToken={
              projectFocusReq?.focus === "lit" ? projectFocusReq.token : null
            }
            focusEntryId={
              projectFocusReq?.focus === "lit" ? projectFocusReq.entryId : null
            }
            onError={setError}
            onFocusHandled={() => setProjectFocusReq(null)}
          />
        ) : selectedGroup.project && selectedSurfaceTab === "files" ? (
          <ProjectFilesView
            projectPath={selectedGroup.repoPath}
            workMode={selectedGroup.project.workMode}
            {...slotPrefs(profiles, selectedGroup.project, DISCUSS_BINDING_SLOT)}
            onError={setError}
            focusPath={
              filePreviewReq &&
              samePath(filePreviewReq.projectRoot, selectedGroup.repoPath)
                ? filePreviewReq.path
                : null
            }
            focusToken={
              filePreviewReq &&
              samePath(filePreviewReq.projectRoot, selectedGroup.repoPath)
                ? filePreviewReq.token
                : null
            }
            onFocusHandled={() => setFilePreviewReq(null)}
          />
        ) : selectedGroup.project && selectedSurfaceTab === "agents" ? (
          <ProjectAgentsView
            project={selectedGroup.project}
            onProjectChanged={(next) =>
              setProjects((current) =>
                current.map((item) =>
                  samePath(item.path, next.path) ? next : item,
                ),
              )
            }
            onOpenGoals={() => selectProjectSurface("tasks")}
            onError={setError}
          />
        ) : selectedWorkMode === "coding" ? (
          <CodingProjectView
            project={selectedGroup.project}
            repoPath={selectedGroup.repoPath}
            homeDir={homeDir}
            chromeReq={identityChrome}
            onChromeConsumed={consumeIdentityChrome}
            onError={setError}
            onNotice={setNotice}
          />
        ) : selectedWorkMode === "office" ? null : (
          <ProjectGroup
            key={selectedGroup.key}
            project={selectedGroup.project}
            repoPath={selectedGroup.repoPath}
            repoName={selectedGroup.repoName}
            workspaces={selectedGroup.list}
            health={health}
            drift={drift}
            refreshToken={refreshToken}
          focusStepReq={focusStepReq}
            pageVisible={visible}
            freshGitGuide={
              !!selectedGroup.project &&
              !!freshProjectPath &&
              samePath(selectedGroup.project.path, freshProjectPath)
            }
            onDismissGitGuide={() => setFreshProjectPath(null)}
            onRefresh={refresh}
            onOpenTerminal={(ws, initialPrompt, opts) =>
              void openInTerminal(ws, initialPrompt, opts)
            }
            onError={setError}
            chromeReq={identityChrome}
            onIdentityAction={requestIdentityChrome}
            onOpenAgents={() => selectProjectSurface("agents")}
            onChromeConsumed={consumeIdentityChrome}
          >
            {(wsView) => {
            // 聚焦步骤可见性（纯逻辑 src/workspace-visibility.ts）：聚焦 = 绑定该步骤的工作区
            // + 不匹配任何步骤的手动工作区（手动建的任何东西都不能被默认视图藏掉）
            const focusStepName = wsView.focusStepName;
            const wsList = sortWorkspacesByAttention(
              filterWorkspacesByFocus(
                selectedGroup.list,
                wsView.steps,
                focusStepName,
              ),
              (workspace) => ({
                ahead: health[workspace.id]?.ahead,
                conflict: health[workspace.id]?.conflict,
                canResolveMerge: drift[workspace.id]?.canResolveMerge,
                readyToMerge: health[workspace.id]?.readyToMerge,
              }),
            );
            return (
            <>
            {/* 列表头部行始终渲染（标题）；「新建工作区」按钮只在已有工作区时出现在行尾——
                空列表时由下方虚线引导卡承载同一入口，同一视野不摆两个相同按钮（v3.92）；
                无步骤项目与未注册分组同样适用（空态卡按钮对它们照常可用）。
                有研究步骤时列表恒跟随聚焦步骤（v3.81 起无「全部」切换） */}
            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs text-l3">
                {focusStepName
                  ? `${focusStepName} · 工作区（${wsList.length}）`
                  : `工作区（${wsList.length}）`}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {wsList.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setNewWsRepoPath(selectedGroup.repoPath)}
                    className={`${actionBtn} shrink-0`}
                  >
                    新建工作区
                  </button>
                )}
              </div>
            </div>
            {wsList.length === 0 ? (
              /* 空状态改虚线引导卡（v3.92 走查）：纯文字行看起来像「没加载完」，
                 虚线框 + 内嵌动作既填补视觉空白又直接给出下一步 */
              <div className="mt-2 flex flex-col items-center gap-2 rounded-lg border border-dashed border-field px-4 py-6 text-center">
                <p className="text-xs text-l3">
                  {selectedGroup.list.length === 0
                    ? wsView.steps.length > 0
                      ? "该项目还没有工作区。从上方研究步骤点「开始」一键开步，或直接新建一个："
                      : "该项目还没有工作区。"
                    : "该步骤还没有工作区。点流程线里的「开始」一键开步，或直接新建一个："}
                </p>
                <button
                  type="button"
                  onClick={() => setNewWsRepoPath(selectedGroup.repoPath)}
                  className={`${actionBtn} border border-field`}
                >
                  ＋ 新建工作区
                </button>
              </div>
            ) : (
            /* 工作区列表改卡片（去线条化，v3.85）：原 divide-y 细行叠成一串横线，
               是「界面很线条化」的主要来源之一。改为统一内容井底色的独立卡 + 卡间留白，
               靠底色差成块、不靠分隔线；对象少时保留连续画布不铺满 */
            <ul className="mt-2 flex flex-col gap-2">
              {wsList.map((workspace) => {
                const workspaceHealth = health[workspace.id];
                const workspaceDrift = drift[workspace.id];
                const isDriftFailed = !!driftFailed[workspace.id];
                const isHealthFailed = !!healthFailed[workspace.id];
                const state = workspaceState(
                  workspace,
                  workspaceHealth,
                  workspaceDrift,
                  isHealthFailed,
                  workspaceAgentBusy(
                    workspace.worktreePath,
                    terminalRunInputs,
                  ),
                );
                const canResolveConflict =
                  workspace.status === "active" &&
                  workspaceDrift?.canResolveMerge === true;
                const merged = isMerged(workspace, workspaceHealth);
                // drift 诊断失败时降级按健康处理，行内操作不整体消失
                const canOpenWorkspace =
                  workspace.status === "active" &&
                  (workspaceDrift?.healthy === true ||
                    canResolveConflict ||
                    isDriftFailed);
                // 还没保存进项目时，终端入口在上面的步骤卡（继续 / 去终端看看），
                // 这一行不再重复。已经保存进项目后，步骤卡不再提供回终端，
                // 工作区还留着，这里要能继续改，改完再评审。
                const stepOwnsTerminal =
                  !merged &&
                  !!focusStepName &&
                  wsView.steps.some(
                    (step) =>
                      step.name === focusStepName &&
                      step.workspaceName === workspace.name,
                  );
                return (
                  <li
                    key={workspace.id}
                    data-ws-row={workspace.id}
                    className={`ccode-well group rounded-lg p-3 ${flashWsId === workspace.id ? "ring-2 ring-cta" : ""}`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-l1">
                            {workspace.name}
                          </span>
                          {merged ? (
                            // 「已保存进项目」是终态提示：行内小字 + ok 色小点，不占按钮位；
                            // 有新提交（ahead > 0）后恢复状态 pill 与评审入口
                            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-l4">
                              <span className="size-2 rounded-full bg-ok-text" />
                              {REVIEW_SAVE.done}
                            </span>
                          ) : (
                          <button
                            type="button"
                            onClick={(event) => {
                              const rect =
                                event.currentTarget.getBoundingClientRect();
                              setDetailsPopover({
                                x: rect.left,
                                y: rect.bottom + 4,
                                ws: workspace,
                              });
                            }}
                            className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-raised px-2 text-xs ${state.textClass} hover:bg-seg-sel`}
                            title={
                              isDriftFailed || isHealthFailed
                                ? "状态诊断失败，点开查看详情并重试"
                                : "查看状态详情"
                            }
                          >
                            <span
                              className={`size-2 rounded-full ${state.dotClass}`}
                            />
                            {state.label}
                            {(isDriftFailed || isHealthFailed) && (
                              <span className="text-warn-text">!</span>
                            )}
                          </button>
                          )}
                        </div>
                        {/* 副行：相对时间主显；分支默认就是 ccode/同名，重复列只添杂——
                            只有与名字不一致的自建工作区才亮分支，完整路径与绝对时间都在悬浮 */}
                        <p
                          className="mt-0.5 truncate text-micro text-l4"
                          title={`${workspace.branch}\n${workspace.worktreePath}\n创建于 ${absTime(workspace.createdAt)}`}
                        >
                          {workspace.branch === `ccode/${workspace.name}`
                            ? `创建于 ${relTime(workspace.createdAt)}`
                            : `${workspace.branch} · ${relTime(workspace.createdAt)}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {canOpenWorkspace && (
                          <>
                            {!stepOwnsTerminal && (
                              <button
                                type="button"
                                onClick={() => void openInTerminal(workspace)}
                                className={rowActionClass}
                              >
                                继续
                              </button>
                            )}
                            {(canResolveConflict || workspaceHealth?.conflict) && !merged && (
                              <button
                                type="button"
                                onClick={() =>
                                  openReview(
                                    workspace,
                                    canResolveConflict || workspaceHealth?.conflict
                                      ? "resolve-conflict"
                                      : undefined,
                                  )
                                }
                                title={
                                  canResolveConflict || workspaceHealth?.conflict
                                    ? "两边改了同一个地方，需要你逐个文件选一边"
                                    : "审阅任务改动并合并回主文件夹"
                                }
                                className={
                                  canResolveConflict || workspaceHealth?.conflict
                                    ? reviewWarn
                                    : reviewCta
                                }
                              >
                                {canResolveConflict || workspaceHealth?.conflict
                                  ? "解决冲突"
                                  : "评审"}
                              </button>
                            )}
                          </>
                        )}
                        {/* 本步文件：活跃工作区常驻，行内手风琴就地展开 */}
                        {workspace.status === "active" && (
                          <button
                            type="button"
                            onClick={() => toggleArtifacts(workspace.id)}
                            aria-expanded={artifactsOpen.has(workspace.id)}
                            title="打开这一步已经写出的文件"
                            className={`${actionBtn} ${
                              artifactsOpen.has(workspace.id) ? "text-l1" : ""
                            }`}
                          >
                            {artifactsOpen.has(workspace.id) ? "收起文件" : "本步文件"}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(event) => {
                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            setWorkspaceMenu({
                              x: rect.right,
                              y: rect.bottom + 4,
                              ws: workspace,
                            });
                          }}
                          title="更多操作"
                          aria-label={`更多操作：${workspace.name}`}
                          className={`flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1 ${hoverReveal}`}
                        >
                          ⋯
                        </button>
                      </div>
                    </div>
                    {/* 产物清单：已合并读项目根（main），其余读工作树 */}
                    {artifactsOpen.has(workspace.id) &&
                      workspace.status === "active" && (
                        <ArtifactChecklist
                          projectPath={selectedGroup.repoPath}
                          workspaceName={workspace.name}
                          root={
                            merged
                              ? selectedGroup.repoPath
                              : workspace.worktreePath
                          }
                          rootLabel={merged ? REVIEW_SAVE.artifactRootMerged : "工作区"}
                        />
                      )}
                  </li>
                );
              })}
            </ul>
            )}
            </>
            );
            }}
          </ProjectGroup>
        )}
        </ProjectSurfaceTabs>
      ) : null}
      {addProjectPath && (
        <AddProjectModal
          path={addProjectPath}
          onClose={() => setAddProjectPath(null)}
          existingMode={
            projects.find((p) => samePath(p.path, addProjectPath))
              ? normalizeWorkMode(
                  projects.find((p) => samePath(p.path, addProjectPath))
                    ?.workMode,
                )
              : null
          }
          onRegistered={(project, scan, mode, skipTemplate) => {
            setAddProjectPath(null);
            setFreshProjectPath(project.path);
            setJustScanned(scan);
            // 先落进列表再选中：分组表由 projects 派生，反了会被空表 effect
            // 重置成原来的第一项（示例课题创建已经踩过同一坑）
            const next = { ...project, workMode: mode };
            setProjects((prev) => [
              next,
              ...prev.filter((p) => !samePath(p.path, next.path)),
            ]);
            useAppStore.getState().setProjectPaths(
              [
                next.path,
                ...useAppStore
                  .getState()
                  .projectPaths.filter((p) => !samePath(p, next.path)),
              ],
            );
            setSelectedGroupKey(`p:${next.path}`);
            if (mode === "research" && !skipTemplate) {
              setTemplatePick({ path: next.path, name: next.name });
            } else {
              const tail = scan.added
                ? `；扫到并登记了 ${scan.added} 个文献/数据文件`
                : "";
              setNotice(
                skipTemplate
                  ? `已更新「${project.name}」${tail}`
                  : `已添加为${WORK_MODE_LABEL[mode]}项目${tail}`,
              );
              setJustScanned(null);
            }
            void refresh();
          }}
        />
      )}
      {templatePick && (
        <TemplatePickModal
          projectPath={templatePick.path}
          projectName={templatePick.name}
          onClose={() => {
            setTemplatePick(null);
            const tail = scanSuffix();
            if (tail) setNotice(`项目已注册${tail}`);
          }}
          onOptOut={() => {
            // 「不使用研究流程」标记已落盘：刷新让分组重读 project.toml（隐藏模板引导）
            setTemplatePick(null);
            setNotice(`已记住「不使用研究流程」${scanSuffix()}`);
            void refresh();
          }}
          onApplied={(result, templateName) => {
            setTemplatePick(null);
            // 全部同名跳过 = 项目本来就有这套流程（多为重复添加已有项目），
            // 报「追加 0 个步骤；跳过 5 步（同名）」既像出错又没信息量
            const base =
              result.appended === 0
                ? `项目已有「${templateName}」的全部步骤，没有重复添加`
                : result.skipped.length > 0
                  ? `已添加 ${result.appended} 个步骤；${result.skipped.length} 个同名的跳过了`
                  : `已按「${templateName}」添加 ${result.appended} 个研究步骤`;
            const renamed =
              result.renamed?.length > 0
                ? `；${result.renamed.length} 个工作区名冲突，已自动改名`
                : "";
            setNotice(`${base}${renamed}${scanSuffix()}`);
            void refresh();
          }}
        />
      )}
      {addMenu && (
        <ContextMenu
          x={addMenu.x}
          y={addMenu.y}
          onClose={() => setAddMenu(null)}
          items={[
            { label: "添加项目…", onSelect: () => void onAddProject() },
            {
              label: demoBusy ? "正在创建…" : "✦ 创建示例课题（演示）",
              disabled: demoBusy,
              title: "在 文档/Mesa 示例课题 生成带演示数据的完整研究流程项目。以前建在「Ccode 示例课题」里的，再点仍打开那一份",
              onSelect: () => void onCreateDemo(),
            },
          ]}
        />
      )}
      {railMenu &&
        (() => {          const group = groups.find((g) => g.key === railMenu.groupKey);
          if (!group) return null;
          return (
            <ContextMenu
              x={railMenu.x}
              y={railMenu.y}
              onClose={() => setRailMenu(null)}
              items={railMenuItems(group)}
            />
          );
        })()}
      {/* 收起态课题名下拉：镜像左栏——同分段同序（段头组头同款）、状态点同口径、
          当前课题 checked（行尾勾+行底），选中即切（列表保持收起） */}
      {switchMenu &&
        (() => {
          const statusByKey = new Map(
            groups.map((group) => [group.key, groupRailStatus(group)]),
          );
          const items = projectSwitchRows(
            railSections.map((section) => ({
              label: RAIL_WORK_MODE_LABEL[section.mode],
              items: section.items.map((group) => ({
                key: group.key,
                name: group.project?.name ?? group.repoName,
                repoPath: group.repoPath,
              })),
            })),
            selectedGroup?.key ?? null,
          ).flatMap((row) => {
            const dot = statusByKey.get(row.key)?.railDot;
            const item = {
              label: row.label,
              title: row.repoPath,
              checked: row.current,
              mark: dot === "warn" || dot === "running" ? dot : undefined,
              onSelect: () => setSelectedGroupKey(row.key),
            };
            return row.sectionLabelBefore
              ? [{ header: row.sectionLabelBefore }, item]
              : [item];
          });
          if (items.length === 0) return null;
          return (
            <ContextMenu
              x={switchMenu.x}
              y={switchMenu.y}
              onClose={() => setSwitchMenu(null)}
              items={items}
            />
          );
        })()}
      {renameTarget && (
        <RenameProjectModal
          path={renameTarget.path}
          initialName={renameTarget.name}
          onClose={() => setRenameTarget(null)}
          onRenamed={() => {
            setRenameTarget(null);
            void refresh();
          }}
        />
      )}
      {newWsRepoPath && (
        <NewWorkspaceModal
          repoPath={newWsRepoPath}
          onClose={() => setNewWsRepoPath(null)}
          onCreated={(workspace) => {
            setNewWsRepoPath(null);
            setCreated(workspace);
            void refresh();
          }}
        />
      )}
      {workspaceMenu && (
        <ContextMenu
          x={workspaceMenu.x}
          y={workspaceMenu.y}
          alignRight
          onClose={() => setWorkspaceMenu(null)}
          items={workspaceMenuItems(workspaceMenu.ws)}
        />
      )}
      {detailsPopover && (
        <WorkspaceDetailsPopover
          x={detailsPopover.x}
          y={detailsPopover.y}
          workspace={detailsPopover.ws}
          health={health[detailsPopover.ws.id]}
          state={workspaceState(
            detailsPopover.ws,
            health[detailsPopover.ws.id],
            drift[detailsPopover.ws.id],
            !!healthFailed[detailsPopover.ws.id],
            workspaceAgentBusy(
              detailsPopover.ws.worktreePath,
              terminalRunInputs,
            ),
          )}
          diagFailed={
            !!driftFailed[detailsPopover.ws.id] ||
            !!healthFailed[detailsPopover.ws.id]
          }
          onRetry={() => void refresh()}
          onClose={() => setDetailsPopover(null)}
        />
      )}
      {/* 人工请求完整内容层（v3.97）：收件箱行只放 40 字预览，全文在这里看。
          主动作是跳到对应终端回答；不回它会按每条自带的兜底方案继续，不停工 */}
      {helpView && (
        <div
          className="ccode-fade fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setHelpView(null)}
        >
          <div
            className="ccode-float-surface flex max-h-[70vh] w-full max-w-lg flex-col rounded-md border border-field p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 shrink-0 text-base font-semibold text-l1">
              人工请求 · {helpView.repoName}
              {helpView.workspaceName ? ` / ${helpView.workspaceName}` : ""}
            </h2>
            <p className="mb-3 shrink-0 text-xs text-l4">
              Agent 干到一半需要你拍板。去对应终端直接告诉它；它还在干活时先打断再回答。不回它会按每条兜底继续。
            </p>
            <ol className="min-h-0 flex-1 list-decimal space-y-2 overflow-auto pl-5">
              {helpView.items.map((item, i) => (
                <li
                  key={i}
                  className="whitespace-pre-wrap text-sm leading-6 text-l1"
                >
                  {item}
                </li>
              ))}
            </ol>
            <div className="mt-4 flex shrink-0 items-center justify-end gap-2">
              <button
                type="button"
                title="忽略此来源（请求内容变化后会重新出现）"
                onClick={() => {
                  dismissHelpRequest(helpView.root, helpSignature(helpView.items));
                  setHelpView(null);
                }}
                className="rounded-sm px-3 py-1.5 text-sm text-l4 hover:bg-hover hover:text-l2"
              >
                忽略此来源
              </button>
              <button
                type="button"
                title="打开该步骤终端，直接回答这些请求"
                onClick={() => {
                  const view = helpView;
                  setHelpView(null);
                  const ws =
                    workspaces.find((w) => w.id === view.workspaceId) ??
                    workspaces.find((w) => w.worktreePath === view.root);
                  if (ws) {
                    // B1：help-wanted 也是步骤工作区语境——步骤槽绑定作预填
                    //（该入口 resume 优先，绑定只在无会话回落时生效）
                    const profilesNow = useAppStore.getState().profiles;
                    void resolveStepLaunchByWorkspace(ws, profilesNow)
                      .then((stepL) =>
                        buildWorkspaceTerminalRequest(ws, undefined, {
                          stepLaunch: stepL ?? undefined,
                        }),
                      )
                      .then((req) => {
                        setPendingTerminal(req);
                        setPage("terminal");
                      });
                    return;
                  }
                  setPendingTerminal({
                    cwd: view.root,
                    extraEnv: {},
                    title: view.workspaceName ?? view.repoName,
                  });
                  setPage("terminal");
                }}
                className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110"
              >
                去终端回答
              </button>
            </div>
          </div>
        </div>
      )}
        </PageFrame>
      </div>
      </div>
    </div>
  );
}
