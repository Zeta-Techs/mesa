import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CheckCheck,
  CircleDot,
  AlarmClock,
  Files,
  Inbox,
  Moon,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { useAppStore, runInboxAction, visibleInboxItems } from "../store";
import { usePhoneDropStore } from "../phone-drop-store";
import { phonePendingCount } from "../phone-drop";
import { bulkReadableItems, inboxCategoryOf } from "../inbox";
import { pathWithin, samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { useClientOpen } from "../components/ClientOpenDialog";
import { alertDialog } from "../components/ConfirmDialog";
import { AGENTS } from "../types";
import type {
  CodingOverviewDto,
  ConversationPageDto,
  ProjectConfigReadDto,
  ProjectDto,
  ProjectStepDto,
  RepoDto,
  RunDto,
  ScheduleDto,
  SessionUsageDto,
  TaskDto,
  WorkspaceDto,
} from "../types";
import { isWorkbenchActiveRun } from "../run-model";
import { visibleDeclaredTasks } from "../project-tasks";
import {
  continueWorkbenchTarget,
  resolveWorkbenchDestination,
  goalCaptureTargets,
  inboxItemProjectRoot,
  lastUserInstruction,
  latestProjectSession,
  openStepProgress,
  pickWorkbenchHero,
  pickWorkbenchNow,
  stepProgressLabel,
  workbenchNowSubtitle,
  workbenchRecentRows,
  type WorkbenchDestination,
  type WorkbenchNowSeed,
} from "../workbench-hero";
import {
  CODING_KIND_LABEL,
  WORK_MODE_LABEL,
  deriveCodingKind,
  isOfficeInProgress,
  normalizeWorkMode,
} from "../work-mode";
import {
  EmptyState,
  LoadingRows,
  PageFrame,
  fieldClass,
  ghostActionClass,
  hoverRevealClass,
  primaryActionClass,
  rowActionClass,
  secondaryActionClass,
} from "../components/PageFrame";
import { dismissToast, toast } from "../toast";
import { caretOfAttention, withUnread } from "../run-caret";
import { unreadKeyOf } from "../chat-unread";
import WorkbenchApprovalPanel from "../components/WorkbenchApprovalPanel";
import WorkbenchProjectGroup from "../components/WorkbenchProjectGroup";
import WorkbenchTaskPanel, { type TaskPanelAction } from "../components/WorkbenchTaskPanel";
import {
  awaySummary,
  buildProjectCard,
  cardIsActive,
  durationLabel,
  filterCards,
  liveActivityLine,
  orderLikeSidebar,
  scheduleOverview,
  type ScheduleOverviewRow,
  turnElapsedMs,
  type CardFilter,
  type CardLiveRun,
  type CardTask,
  type ProjectCard,
  type CardProjectInput,
  type CardRunInput,
} from "../workbench-cards";
import {
  approvalChoices,
  approvalTitle,
  displayCommand,
  type ChatChannelSnapshot,
} from "../chat-channel";
import {
  QUEUE_TIER_LABEL,
  QUEUE_UNDO_MS,
  buildDecisionQueue,
  approvalHiddenKey,
  createDeferred,
  moveSelection,
  pruneHidden,
  queueKeyAction,
  resolveSelection,
  type QueueApproval,
  type QueueRow,
} from "../workbench-queue";
import { pollEvery } from "../polling";
import { sidebarChatTitle } from "../sidebar-chats";
import { isScratchCwd } from "../quick-chat";
import { PROJECT_ORDER_KEY, PROJECT_PINS_KEY, parsePins } from "../project-tree";
import WorkbenchSchedules from "../components/WorkbenchSchedules";
import { fmtCost } from "../stats-insight";

const iconClass = "shrink-0 text-l4";

/** 不参与工作台「需要你」判定的自动登记任务类（见 nowSeeds 里的过滤注释） */
const WORKBENCH_AUTO_TASK_KINDS = new Set(["pipeline_step", "coding_lane", "watch"]);

/** 「上次停在」缓存：会话没更新就不重读尾页（键含 updatedAt，会话一动自然失效） */
type LastSaid = {
  text: string;
  full: string;
  timestamp: string | null;
  agent: string;
  sessionId: string;
};
const lastSaidCache = new Map<string, LastSaid | null>();

/** 上次看着工作台的时刻（离开期间摘要从这之后数） */
const WORKBENCH_LAST_SEEN_KEY = "ccode.workbenchLastSeen";
/** 拍板队列默认列几行，其余折叠 */
const QUEUE_VISIBLE = 6;
const QUEUE_KEY_HINT = "J / K 移动 · 回车 去处理 · A 允许 · R 拒绝 · E 收起";
/** 撤销窗口挂在模块上：点完马上离开工作台，送出照常发生 */
const queueDeferred = createDeferred({
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (handle) => window.clearTimeout(handle as number),
});

function agentLabel(id: string | null): string | null {
  if (!id) return null;
  return AGENTS.find((a) => a.id === id)?.label ?? id;
}

function SectionHeading({
  icon: Icon,
  title,
  action,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-2 px-1">
      <Icon size={14} strokeWidth={1.8} className={iconClass} aria-hidden="true" />
      <h2 className="text-base font-semibold text-l1">{title}</h2>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function WorkbenchPage({ visible }: { visible?: boolean }) {
  const setPage = useAppStore((s) => s.setPage);
  const contextLabel = useAppStore((s) => s.contextLabel);
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  const unreadChats = useAppStore((s) => s.unreadChats);
  const rawInboxItems = useAppStore((s) => s.inboxItems);
  const appUpdate = useAppStore((s) => s.appUpdate);
  const inboxDismissed = useAppStore((s) => s.inboxDismissed);
  const phonePending = usePhoneDropStore((s) => (s.open ? 0 : phonePendingCount(s.items)));
  const inboxItems = visibleInboxItems(
    rawInboxItems,
    appUpdate
      ? { version: appUpdate.version, currentVersion: appUpdate.currentVersion }
      : null,
    inboxDismissed,
    phonePending,
  );
  const bulkInboxItems = bulkReadableItems(inboxItems);
  const dismissInboxBulk = useAppStore((s) => s.dismissInboxBulk);
  const sessions = useAppStore((s) => s.sessions);
  const recentRepos = useAppStore((s) => s.recentRepos);
  const loadRecentRepos = useAppStore((s) => s.loadRecentRepos);
  const setEnterCwdReq = useAppStore((s) => s.setEnterCwdReq);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const setTaskReviewReq = useAppStore((s) => s.setTaskReviewReq);
  const setFocusTabReq = useAppStore((s) => s.setFocusTabReq);
  const setProjectFocusReq = useAppStore((s) => s.setProjectFocusReq);
  const setWorkspaceReviewRequest = useAppStore((s) => s.setWorkspaceReviewRequest);

  function openRun(runId: string, tabId?: string) {
    if (tabId && terminalRunInputs.some((run) => run.tabId === tabId)) {
      setFocusTabReq(tabId);
      setPage("terminal");
      return;
    }
    // 统一走收件箱的 Run 入口：活标签直接聚焦，失效标签回查 run_get；
    // Custom Runtime 由该入口明确分流为「新 Run」，不误触发普通 CLI 恢复。
    runInboxAction({
      key: `run:${runId}`,
      dot: "bg-warn-text",
      text: "运行",
      actionLabel: "打开",
      action: { type: "run", runId },
    });
  }

  const [projects, setProjects] = useState<ProjectDto[]>([]);
  /** 首轮项目列表回来之前不画空态（否则每次冷启动先闪「从一个项目开始」） */
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [codingByPath, setCodingByPath] = useState<
    Record<string, CodingOverviewDto>
  >({});
  const [researchCfg, setResearchCfg] = useState<
    Record<string, { steps: ProjectStepDto[]; pipelineOptOut: boolean }>
  >({});
  const [reads, setReads] = useState<Record<string, { label: string; lastSuccess: number | null; failed: boolean }>>({});
  const recordRead = useCallback((key: string, label: string, ok: boolean) => {
    setReads((current) => ({
      ...current,
      [key]: { label, failed: !ok, lastSuccess: ok ? Date.now() : current[key]?.lastSuccess ?? null },
    }));
  }, []);
  const [reloadToken, setReloadToken] = useState(0);
  const [allRuns, setAllRuns] = useState<RunDto[]>([]);
  const [taskProjectById, setTaskProjectById] = useState<Record<string, string>>(
    {},
  );
  const [userTasks, setUserTasks] = useState<TaskDto[]>([]);
  /** 定时任务全集（list_schedules）：工作台「定时任务」摘要的数据源，筛选口径在 schedule-tasks.ts */
  const [schedules, setSchedules] = useState<ScheduleDto[]>([]);
  /** 「待你处理」默认只列 5 条，展开后全列出（页内展开，不跳收件箱浮层） */
  const [inboxExpanded, setInboxExpanded] = useState(false);
  const [noticesExpanded, setNoticesExpanded] = useState(false);
  const [openApprovalKey, setOpenApprovalKey] = useState<string | null>(null);
  const [lastSaid, setLastSaid] = useState<Record<string, LastSaid | null>>({});
  const [goalDraft, setGoalDraft] = useState("");
  const [goalProject, setGoalProject] = useState("");
  const [goalBusy, setGoalBusy] = useState(false);
  /** 「记下目标」默认收成一行文字入口，点开才是输入框（常驻输入框像全局搜索，抢主卡的戏） */
  const [goalOpen, setGoalOpen] = useState(false);

  useEffect(() => {
    if (!visible) return;
    void loadRecentRepos().catch(() => {
      toast("最近项目加载失败，可稍后重试", "warning");
    });
  }, [loadRecentRepos, visible]);

  const runCwdSig = terminalRunInputs
    .filter((item) => item.running || item.attention === "confirm")
    .map((item) => item.cwd)
    .join("\n");
  // 有运行刚跑完（done）才需要重读编程/流程状态；开始/待确认只影响轻量列表
  const runDoneSig = terminalRunInputs
    .filter((item) => item.attention === "done")
    .map((item) => item.cwd)
    .sort()
    .join("\n");

  // 轻量三件：项目注册表 / 工作区 / Run 账本。随运行启停重拉（都是单次本地查询）
  useEffect(() => {
    if (!visible) return;
    let stale = false;
    invoke<ProjectDto[]>("list_projects")
      .then((list) => { if (!stale) { setProjects(list); recordRead("projects", "项目列表", true); } })
      .catch(() => { if (!stale) recordRead("projects", "项目列表", false); })
      .finally(() => { if (!stale) setProjectsLoaded(true); });
    invoke<WorkspaceDto[]>("list_workspaces")
      .then((list) => { if (!stale) { setWorkspaces(list); recordRead("workspaces", "工作副本状态", true); } })
      .catch(() => { if (!stale) recordRead("workspaces", "工作副本状态", false); });
    // 全量 Run：归属与恢复共用；失败保留旧快照，并点名提示受影响范围。
    invoke<RunDto[]>("run_list", { projectRoot: null })
      .then((list) => { if (!stale) { setAllRuns(list); recordRead("runs", "对话运行记录", true); } })
      .catch(() => { if (!stale) recordRead("runs", "对话运行记录", false); });
    return () => { stale = true; };
  }, [visible, runCwdSig, reloadToken, recordRead]);

  // 定时任务摘要：可见时拉一次；拉起 / 跑完 / 采纳时重拉；每分钟刷一次让「接下来」滚动
  useEffect(() => {
    if (!visible) return;
    let stale = false;
    const load = () => {
      invoke<ScheduleDto[]>("list_schedules")
        .then((list) => {
          if (!stale) { setSchedules(list); setNowMs(Date.now()); recordRead("schedules", "定时任务", true); }
        })
        .catch(() => {
          if (!stale) recordRead("schedules", "定时任务", false);
        });
    };
    load();
    const unpoll = pollEvery(load, 60_000);
    const unlisteners: Array<() => void> = [];
    for (const event of ["scheduler-run-started", "scheduler-run-done", "watch-run-adopted"]) {
      listen(event, load)
        .then((u) => {
          if (stale) u();
          else unlisteners.push(u);
        })
        .catch(() => {});
    }
    return () => {
      stale = true;
      unpoll();
      unlisteners.forEach((u) => u());
    };
  }, [visible, reloadToken, recordRead]);

  // 逐项目的重活（编程项目跑 git、科研项目读档案卡）：只在项目集合变化、有运行跑完、
  // 回到本页或点重试时拉；失败按类合成一条提示，不再一个项目弹一条
  const projectsSig = projects
    .map((p) => `${p.path}\t${normalizeWorkMode(p.workMode)}`)
    .join("\n");
  useEffect(() => {
    if (!visible || projects.length === 0) return;
    let cancelled = false;
    const coding = projects.filter(
      (p) => normalizeWorkMode(p.workMode) === "coding",
    );
    const research = projects.filter(
      (p) => normalizeWorkMode(p.workMode) === "research",
    );
    void Promise.all(
      coding.map((p) =>
        invoke<CodingOverviewDto>("coding_overview", { repoPath: p.path })
          .then((ov) => ({ path: p.path, name: p.name, ov }))
          .catch(() => ({ path: p.path, name: p.name, ov: null })),
      ),
    ).then((rows) => {
      if (cancelled) return;
      setCodingByPath((current) => {
        const next = { ...current };
        for (const row of rows) if (row.ov) next[row.path] = row.ov;
        return next;
      });
      for (const row of rows) recordRead(`coding:${row.path}`, `${row.name} · 编程状态`, !!row.ov);
    });
    void Promise.all(
      research.map((p) =>
        invoke<ProjectConfigReadDto>("read_project_config", { path: p.path })
          .then((read) => ({ path: p.path, name: p.name, config: read.config }))
          .catch(() => ({ path: p.path, name: p.name, config: null })),
      ),
    ).then((rows) => {
      if (cancelled) return;
      setResearchCfg((current) => {
        const next = { ...current };
        for (const row of rows) {
          if (!row.config) continue;
          next[row.path] = { steps: row.config.steps ?? [], pipelineOptOut: !!row.config.pipelineOptOut };
        }
        return next;
      });
      for (const row of rows) recordRead(`research:${row.path}`, `${row.name} · 流程配置`, !!row.config);
    });
    return () => {
      cancelled = true;
    };
    // projects 由 projectsSig 代表：轻量重拉换了数组引用但内容没变时不重跑 git
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, projectsSig, runDoneSig, reloadToken, recordRead]);

  const nowSeeds = useMemo((): WorkbenchNowSeed[] => {
    // 「活着」只算真有交互活的运行：白名单（登录/定时巡检/无头不算）之上，
    // 空闲挂着的任务/工作区老标签也不算——否则会把无交互的项目顶上「正在进行」
    const live = terminalRunInputs.filter((r) => isWorkbenchActiveRun(r));
    return projects.map((p) => {
      const mode = normalizeWorkMode(p.workMode);
      const mineWs = workspaces.filter(
        (w) =>
          w.status !== "archived" && samePath(w.repoPath, p.path, IS_WINDOWS),
      );
      const extraRoots = [
        ...mineWs.map((w) => w.worktreePath),
        ...(codingByPath[p.path]?.worktrees.map((w) => w.path) ?? []),
      ];
      let subtitle: string | null = null;
      let needsYou = false;
      const mineTasks = userTasks.filter(
        (task) =>
          samePath(task.projectRoot ?? "", p.path, IS_WINDOWS) &&
          // 自动登记的三类任务（流程步骤/编程车道/定时雷达）不进「需要你」判定：
          // 它们的 stopped/failed 是历史轮次残留，状态由步进器/工作区卡/收件箱表达；
          // 工作台只列交互活（2026-10-13 实证：13 条老 stopped 步骤任务把纯定时课题顶上工作台）
          !WORKBENCH_AUTO_TASK_KINDS.has(task.kind),
      );
      if (mode === "research") {
        // 流程只读本项目自己的；读取失败就是无步骤，不跨项目回落
        const st = researchCfg[p.path]?.steps ?? [];
        subtitle = stepProgressLabel(openStepProgress(st, mineWs));
        needsYou = mineWs.some((w) => w.status === "active" && !w.mergedAt);
      } else if (mode === "coding") {
        const ov = codingByPath[p.path];
        if (ov) {
          const rows = [
            ...ov.worktrees.map((w) => ({
              name: w.branch || "工作树",
              kind: deriveCodingKind({
                isBase: w.isBase,
                isPrimary: w.isPrimary,
                dirty: w.dirty,
                ahead: w.ahead,
                behind: w.behind,
                hasWorktree: true,
              }),
            })),
            ...ov.branches
              .filter((b) => !b.worktreePath)
              .map((b) => ({
                name: b.name,
                kind: deriveCodingKind({
                  isBase: b.isBase,
                  isPrimary: b.isPrimary,
                  dirty: b.dirty,
                  ahead: b.ahead,
                  behind: b.behind,
                  hasWorktree: false,
                }),
              })),
          ];
          const top =
            rows.find((x) => x.kind === "sync") ??
            rows.find((x) => x.kind === "ready") ??
            rows.find((x) => x.kind === "dev");
          if (top) {
            subtitle = `${top.name} ${CODING_KIND_LABEL[top.kind]}`;
            needsYou = true;
          }
        }
      } else {
        const lastSession =
          sessions
            .filter((s) => samePath(s.projectPath, p.path, IS_WINDOWS))
            .map((s) => s.updatedAt)
            .filter((x): x is string => !!x)
            .sort()
            .pop() ?? null;
        const hasLive = live.some((r) =>
          extraRoots
            .concat(p.path)
            .some((root) => pathWithin(r.cwd, root, IS_WINDOWS)),
        );
        needsYou = isOfficeInProgress({
          hasLiveTab: hasLive,
          lastSessionAt: lastSession,
          lastOpenedAt: null,
        });
        subtitle = lastSession ? "最近有文档对话" : null;
      }
      const goalLine = workbenchNowSubtitle({
        tasks: mineTasks,
        fallback: subtitle,
      });
      subtitle = goalLine.subtitle;
      if (goalLine.needsYou) needsYou = true;
      const hasLive = live.some((r) =>
        extraRoots
          .concat(p.path)
          .some((root) => pathWithin(r.cwd, root, IS_WINDOWS)),
      );
      return {
        path: p.path,
        name: p.name,
        registered: true,
        workMode: mode,
        subtitle,
        needsYou: needsYou || hasLive,
        extraRoots,
      };
    });
  }, [
    projects,
    workspaces,
    codingByPath,
    researchCfg,
    sessions,
    terminalRunInputs,
    userTasks,
  ]);

  // 归属表：runId / taskId → 项目根（隔离目标副本按稳定身份归回真实项目，不按 cwd 拆卡）
  const runAttribution = useMemo(() => {
    const runProjects: Record<string, string> = {};
    for (const r of allRuns) {
      if (r.projectRoot) runProjects[r.id] = r.projectRoot;
    }
    return { runProjects, taskProjects: taskProjectById };
  }, [allRuns, taskProjectById]);

  const nowItems = useMemo(
    () =>
      pickWorkbenchNow({
        seeds: nowSeeds,
        runs: terminalRunInputs,
        attribution: runAttribution,
        isWindows: IS_WINDOWS,
      }),
    [nowSeeds, terminalRunInputs, runAttribution],
  );

  const wbProjects = useMemo(
    () =>
      projects.map((p) => ({
        path: p.path,
        name: p.name,
        workMode: normalizeWorkMode(p.workMode),
        lastOpenedAt: p.lastOpenedAt,
        createdAt: p.createdAt,
      })),
    [projects],
  );

  const hero = useMemo(() => {
    if (nowItems[0]) return nowItems[0];
    return pickWorkbenchHero({
      projects: wbProjects,
      recentRepos,
      workspaces,
      runs: terminalRunInputs,
      contextName: contextLabel?.project ?? null,
      contextPath: contextLabel?.projectPath ?? null,
      attribution: runAttribution,
      isWindows: IS_WINDOWS,
    });
  }, [nowItems, wbProjects, recentRepos, workspaces, terminalRunInputs, contextLabel, runAttribution]);

  // 「最近项目」的交互口径：项目路径 → 最近一次用户会话时间（内部会话不算——
  // 定时雷达/无头只产生自动活动，纯雷达项目不进「最近」）
  const interactiveLast = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      if (s.internal || !s.projectPath || !s.updatedAt) continue;
      const prev = map.get(s.projectPath);
      if (!prev || prev < s.updatedAt) map.set(s.projectPath, s.updatedAt);
    }
    return map;
  }, [sessions]);
  const recentRows = useMemo(
    () =>
      workbenchRecentRows({
        recentRepos,
        projects: wbProjects,
        isWindows: IS_WINDOWS,
        interactiveLast,
      }),
    [recentRepos, wbProjects, interactiveLast],
  );

  useEffect(() => {
    if (!visible || projects.length === 0) {
      setUserTasks([]);
      setTaskProjectById({});
      return;
    }
    let cancelled = false;
    // 一次取全量再按已添加项目过滤（原先每个项目各查一次）
    invoke<TaskDto[]>("task_list", { projectRoot: null })
      .then((list) => {
        if (cancelled) return;
        recordRead("tasks", "目标列表", true);
        const all = list.filter((task) =>
          projects.some((project) =>
            samePath(task.projectRoot ?? "", project.path, IS_WINDOWS),
          ),
        );
        // 归属表用未过滤全集（含会话自动登记的任务），展示列表仍只留人声明的
        const byId: Record<string, string> = {};
        for (const task of all) {
          if (task.projectRoot) byId[task.id] = task.projectRoot;
        }
        setTaskProjectById(byId);
        setUserTasks(
          visibleDeclaredTasks(all, new Set(["office_doc", "free_research"])),
        );
      })
      .catch(() => { if (!cancelled) recordRead("tasks", "目标列表", false); });
    return () => {
      cancelled = true;
    };
  }, [projects, visible, reloadToken, recordRead]);

  // 「上次停在」：主卡与紧凑行各取本项目最近一次对话的最后一句人话（尾页，Rust 层已脱敏）
  const lastSaidTargets = useMemo(() => {
    const paths = [
      ...(hero ? [hero.path] : []),
      ...nowItems.slice(1).map((item) => item.path),
    ];
    const out: {
      path: string;
      key: string;
      agent: string;
      sessionId: string;
      filePath: string;
    }[] = [];
    for (const path of paths) {
      if (out.some((row) => samePath(row.path, path, IS_WINDOWS))) continue;
      const session = latestProjectSession(sessions, path, IS_WINDOWS);
      if (!session) continue;
      out.push({
        path,
        key: `${session.agent}:${session.sessionId}:${session.updatedAt}`,
        agent: session.agent,
        sessionId: session.sessionId,
        filePath: session.filePath,
      });
    }
    return out;
  }, [hero, nowItems, sessions]);
  const lastSaidSig = lastSaidTargets.map((t) => `${t.path}=${t.key}`).join("\n");
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void Promise.all(
      lastSaidTargets.map(async (target) => {
        if (lastSaidCache.has(target.key)) {
          return [target.path, lastSaidCache.get(target.key) ?? null] as const;
        }
        try {
          const page = await invoke<ConversationPageDto>(
            "get_session_conversation_page",
            { agent: target.agent, filePath: target.filePath, before: null, around: null },
          );
          const hit = lastUserInstruction(page.messages);
          const value: LastSaid | null = hit
            ? { ...hit, agent: target.agent, sessionId: target.sessionId }
            : null;
          lastSaidCache.set(target.key, value);
          return [target.path, value] as const;
        } catch {
          // 读不到就不显示这一行，不弹提示：它只是辅助线索
          return [target.path, null] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setLastSaid(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, lastSaidSig]);
  function lastSaidFor(path: string): LastSaid | null {
    for (const [key, value] of Object.entries(lastSaid)) {
      if (samePath(key, path, IS_WINDOWS)) return value;
    }
    return null;
  }

  // 「记下一个目标」：只记不开工，落到项目页目标列表，开工仍由人在项目页点
  const goalTargets = useMemo(
    () =>
      goalCaptureTargets(
        wbProjects,
        Object.fromEntries(
          Object.entries(researchCfg).map(([path, cfg]) => [
            path,
            { stepCount: cfg.steps.length, pipelineOptOut: cfg.pipelineOptOut },
          ]),
        ),
      ),
    [wbProjects, researchCfg],
  );
  // 默认落点：用户选过的 > 主卡项目 > 最近交互过的可记项目 > 列表第一个
  const goalTarget =
    goalTargets.find((t) => samePath(t.path, goalProject, IS_WINDOWS)) ??
    (hero && goalTargets.find((t) => samePath(t.path, hero.path, IS_WINDOWS))) ??
    recentRows
      .map((row) => goalTargets.find((t) => samePath(t.path, row.path, IS_WINDOWS)))
      .find((t) => t !== undefined) ??
    goalTargets[0] ??
    null;
  async function captureGoal(event: FormEvent) {
    event.preventDefault();
    const name = goalDraft.trim();
    if (!name || !goalTarget || goalBusy) return;
    setGoalBusy(true);
    try {
      // 与项目页「新建目标 → 记下」同一组默认：整个项目当资料、验收后写回、Agent 开工时再选
      await invoke<TaskDto>("task_create", {
        input: {
          projectRoot: goalTarget.path,
          kind: goalTarget.goalKind,
          name,
          description: name,
          inputPaths: ["."],
          outputPaths: ["."],
          permission: "write_tree",
          agent: null,
          profileId: null,
          model: null,
          skills: [],
        },
      });
      setGoalDraft("");
      setGoalOpen(false);
      setReloadToken((n) => n + 1);
      toast(`已记到「${goalTarget.name}」，去项目页开始`, "success");
    } catch (reason) {
      toast(`记下目标失败：${String(reason)}`, "error");
    } finally {
      setGoalBusy(false);
    }
  }

  async function enterRepo(repo: RepoDto) {
    const registered = projects.find((p) =>
      samePath(p.path, repo.path, IS_WINDOWS),
    );
    if (registered) {
      setSelectProjectReq(registered.path);
      setPage("workspaces");
      return;
    }
    try {
      await invoke("list_dir", { path: repo.path, showHidden: false });
    } catch {
      await alertDialog(`目录不存在或已移动：${repo.path}`);
      return;
    }
    setEnterCwdReq(repo.path);
    setPage("terminal");
  }

  // 项目级：只能打开目录、不能定位到某条对话；多个客户端时先问用哪个
  const clientOpen = useClientOpen(visible !== false);
  const showClientJump = clientOpen.projectClients.length > 0;
  const clientJumpLabel =
    clientOpen.projectClients.length === 1
      ? `在 ${clientOpen.projectClients[0].display}打开`
      : "在客户端打开";

  /** 项目头的文字和点击共用解析后的落点，避免看着「继续」却打开另一类页面。 */
  async function openContinueTarget(target: WorkbenchDestination) {
    if (target.kind === "conversation") {
      if (target.runId) openRun(target.runId, target.tabId);
      else if (target.tabId) {
        setFocusTabReq(target.tabId);
        setPage("terminal");
      }
      return;
    }
    if (target.kind === "project") {
      setSelectProjectReq(target.path);
      setPage("workspaces");
      return;
    }
    const repo = recentRepos.find((r) => samePath(r.path, target.path, IS_WINDOWS));
    if (repo) {
      await enterRepo(repo);
      return;
    }
    try {
      await invoke("list_dir", { path: target.path, showHidden: false });
    } catch {
      await alertDialog(`目录不存在或已移动：${target.path}`);
      return;
    }
    setEnterCwdReq(target.path);
    setPage("terminal");
  }

  /** 「正在进行」列表：有活的项目逐行列；都没活时列最近在做的那一个（原大卡的回落口径，不再单独画大卡） */
  const nowRows = useMemo(() => (nowItems.length ? nowItems : hero ? [hero] : []), [nowItems, hero]);

  function openProjectSchedules(root: string) {
    setSelectProjectReq(root);
    setProjectFocusReq({ projectRoot: root, focus: "schedule", token: Date.now() });
    setPage("workspaces");
  }
  const tabCwds = Object.fromEntries(
    terminalRunInputs.map((run) => [run.tabId, run.cwd]),
  );
  function inboxProjectName(item: (typeof inboxItems)[number]): string | null {
    const root = inboxItemProjectRoot(item.action, {
      projectPaths: projects.map((p) => p.path),
      workspaces,
      runProjects: runAttribution.runProjects,
      tabCwds,
      sessions,
      isWindows: IS_WINDOWS,
    });
    const name = root
      ? projects.find((p) => samePath(p.path, root, IS_WINDOWS))?.name?.trim()
      : null;
    // 条目正文已带项目名（如「某课题 · 待确认」）就不再重复
    if (!name || item.text.includes(name)) return null;
    return name;
  }

  // ===== 等你拍板（workbench-queue.ts）=====
  // 待确认条目背后的标签：旁路能经 CLI 官方通道回复的（Codex / Qwen / OpenCode），行内给允许 / 拒绝
  const confirmTabs = useMemo(() => {
    const out: Record<string, string> = {};
    for (const item of inboxItems) {
      if (!item.key.startsWith("confirm:") || item.action.type !== "run") continue;
      const { runId, tabId } = item.action;
      const tab = tabId ?? terminalRunInputs.find((r) => runId && r.runId === runId)?.tabId;
      if (tab) out[item.key] = tab;
    }
    return out;
  }, [inboxItems, terminalRunInputs]);
  // 要看旁路快照的标签：待确认的（行内答审批）+ 开着干活的（项目卡上写此刻在做什么）
  const confirmTabSig = [
    ...new Set([
      ...Object.values(confirmTabs),
      ...terminalRunInputs.filter((r) => isWorkbenchActiveRun(r)).map((r) => r.tabId),
    ]),
  ]
    .sort()
    .join("\n");
  const [channelSnaps, setChannelSnaps] = useState<Record<string, ChatChannelSnapshot | null>>({});
  useEffect(() => {
    if (!visible || !confirmTabSig) return;
    let stale = false;
    const unlisteners: Array<() => void> = [];
    for (const tabId of confirmTabSig.split("\n")) {
      const put = (snap: ChatChannelSnapshot | null) => {
        if (!stale) setChannelSnaps((cur) => ({ ...cur, [tabId]: snap }));
      };
      void invoke<ChatChannelSnapshot | null>("chat_channel_snapshot", { tabId })
        .then(put)
        .catch(() => put(null));
      listen<ChatChannelSnapshot | null>(`chat-channel-${tabId}`, (e) => put(e.payload))
        .then((u) => {
          if (stale) u();
          else unlisteners.push(u);
        })
        .catch(() => {});
    }
    return () => {
      stale = true;
      unlisteners.forEach((u) => u());
    };
  }, [visible, confirmTabSig]);
  const approvals = useMemo(() => {
    const out: Record<string, QueueApproval> = {};
    for (const [key, tabId] of Object.entries(confirmTabs)) {
      const snap = channelSnaps[tabId];
      const a = snap?.approval;
      if (!snap || !a || !a.requestId || snap.turn?.status !== "awaiting_approval") continue;
      const choices = approvalChoices(a, snap.agent);
      const allow = choices.find((c) => c.decision === "allow");
      const deny = choices.find((c) => c.decision === "deny");
      if (!allow || !deny) continue;
      out[key] = {
        tabId,
        requestId: a.requestId,
        title: approvalTitle(a, agentLabel(snap.agent) ?? snap.agent),
        detail: a.command ? displayCommand(a.command) : a.path,
        allowLabel: allow.label,
        denyLabel: deny.label,
        request: a,
        agent: agentLabel(snap.agent) ?? snap.agent,
        conversationCwd: terminalRunInputs.find((run) => run.tabId === tabId)?.cwd ?? null,
      };
    }
    return out;
  }, [confirmTabs, channelSnaps, terminalRunInputs]);

  /** 已处理的行（撤销窗口内、或已送出还没从收件箱消失）先藏起来 */
  const [queueHidden, setQueueHidden] = useState<Set<string>>(() => new Set());
  const reviewTasks = userTasks.filter((task) => task.status === "pending_review");
  const queueRows = useMemo(
    () =>
      buildDecisionQueue({
        inbox: inboxItems,
        reviews: reviewTasks.map((task) => ({
          id: task.id,
          label: task.name,
          projectName: task.projectRoot
            ? (projects.find((p) => samePath(p.path, task.projectRoot!, IS_WINDOWS))?.name ?? null)
            : null,
        })),
        projectOf: inboxProjectName,
        approvals,
        hidden: queueHidden,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inboxItems, userTasks, projects, approvals, queueHidden, workspaces, sessions, runAttribution],
  );
  // 条目从收件箱消失（送出后 Agent 接着干了）就不必再藏
  const queuePresentSig = [...inboxItems.map((i) => i.key), ...reviewTasks.map((t) => `review:${t.id}`)].join("\n");
  useEffect(() => {
    setQueueHidden((cur) => {
      if (cur.size === 0) return cur;
      const next = pruneHidden(cur, queuePresentSig ? queuePresentSig.split("\n") : []);
      return next.size === cur.size ? cur : next;
    });
  }, [queuePresentSig]);

  /** 键盘选中的那一行（全页导航键：q:<队列键> / t:<项目路径>\n<任务 id> / s:<定时任务行 id>）；null = 还没动过，默认停在第一行 */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const lastSelectedIndex = useRef(0);
  const decisionRows = queueRows.filter((row) => row.tier !== "notice");
  const noticeRows = queueRows.filter((row) => row.tier === "notice");
  const navigableQueueRows = noticesExpanded ? [...decisionRows, ...noticeRows] : decisionRows;
  const showTierHeads = new Set(decisionRows.map((row) => row.tier)).size > 1;

  function hideRow(key: string, hidden: boolean) {
    setQueueHidden((cur) => {
      const next = new Set(cur);
      if (hidden) next.add(key);
      else next.delete(key);
      return next;
    });
  }
  /** 处理一行：先藏起来、提示里给撤销，QUEUE_UNDO_MS 后才真的做 */
  function deferRow(key: string, message: string, commit: () => Promise<void> | void) {
    const id = `wbq:${key}`;
    hideRow(key, true);
    queueDeferred.schedule(
      id,
      () => {
        dismissToast(id);
        void Promise.resolve()
          .then(commit)
          .catch(() => hideRow(key, false));
      },
      QUEUE_UNDO_MS,
    );
    toast(message, "info", {
      key: id,
      sticky: true,
      actions: [
        {
          label: "撤销",
          onClick: () => {
            if (queueDeferred.cancel(id)) hideRow(key, false);
          },
        },
      ],
    });
  }
  function answerApproval(row: QueueRow<(typeof inboxItems)[number]>, decision: "allow" | "deny") {
    const approval = row.kind === "inbox" ? row.approval : null;
    if (!approval) return;
    deferRow(
      approvalHiddenKey(row.key, approval.requestId),
      `将在 5 秒后${decision === "allow" ? "允许一次" : "拒绝"}，仍可撤销：${approval.title}`,
      async () => {
        try {
          await invoke("chat_channel_reply", {
            tabId: approval.tabId,
            requestId: approval.requestId,
            decision,
          });
          toast(`已发送${decision === "allow" ? "允许一次" : "拒绝"}：${approval.title}`, "success");
        } catch (reason) {
          toast(`没能送到：${String(reason)}，可以回到对话里回答`, "error");
          throw reason;
        }
      },
    );
    setOpenApprovalKey(null);
    focusAfterQueueChange(row.key);
  }
  function dismissRow(row: QueueRow<(typeof inboxItems)[number]>) {
    if (row.kind !== "inbox" || !row.dismissible) return;
    const item = row.item;
    deferRow(row.key, `已收起：${row.text}`, () => useAppStore.getState().dismissInbox(item));
    focusAfterQueueChange(row.key);
  }
  function openRow(row: QueueRow<(typeof inboxItems)[number]>) {
    if (row.kind === "inbox") {
      if (row.approval) {
        setOpenApprovalKey(row.key);
        return;
      }
      runInboxAction(row.item);
      return;
    }
    const task = userTasks.find((t) => t.id === row.taskId);
    if (task?.projectRoot) {
      setSelectProjectReq(task.projectRoot);
      setTaskReviewReq({ projectRoot: task.projectRoot, taskId: task.id });
    }
    setPage("workspaces");
  }


  /** 「现在」：时长、离开摘要、定时任务下次时间都按它算；有活标签时 15 秒一刷，回到工作台时对准 */
  const [nowMs, setNowMs] = useState(() => Date.now());

  // ===== 项目分组与任务面板（workbench-cards.ts，第二批）=====
  const cardRuns = useMemo(
    (): CardRunInput[] =>
      terminalRunInputs
        .filter((r) => isWorkbenchActiveRun(r))
        .map((r) => ({
          tabId: r.tabId,
          runId: r.runId,
          taskId: r.taskId,
          agentId: r.agentId,
          cwd: r.cwd,
          // 自动起名的「1027|功能|」前缀与侧栏同口径省掉
          title: sidebarChatTitle(r.title),
          running: r.running,
          attention: r.attention,
        })),
    [terminalRunInputs],
  );
  const queueKeySig = queueRows.map((r) => r.key).join("\n");
  /** 某个目录里最后一次对话活动（任务行「最后一次动它」）；内部对话不算 */
  function touchedAtRoot(root: string): string | null {
    let best: string | null = null;
    for (const sess of sessions) {
      if (sess.internal || !sess.updatedAt || !sess.projectPath) continue;
      if (!pathWithin(sess.projectPath, root, IS_WINDOWS)) continue;
      if (!best || sess.updatedAt > best) best = sess.updatedAt;
    }
    return best;
  }
  const cards = useMemo(() => {
    const queueKeys = new Set(queueKeySig ? queueKeySig.split("\n") : []);
    const inputs: CardProjectInput[] = [
      ...projects.map((p) => ({ path: p.path, name: p.name, registered: true, workMode: normalizeWorkMode(p.workMode) })),
      // 没添加的目录只在「正在进行」里有活时出卡（只有对话行）
      ...nowRows
        .filter((row) => !row.registered)
        // 随手聊目录不写文件夹名「scratch」
        .map((row) => ({
          path: row.path,
          name: isScratchCwd(row.path, IS_WINDOWS) ? "随手聊" : row.name,
          registered: false,
          workMode: null,
        })),
    ];
    return inputs.map((project) => {
      const cfg = Object.entries(researchCfg).find(([path]) => samePath(path, project.path, IS_WINDOWS))?.[1];
      const coding = Object.entries(codingByPath).find(([path]) => samePath(path, project.path, IS_WINDOWS))?.[1];
      return buildProjectCard({
        project,
        workspaces,
        steps: cfg?.steps ?? null,
        pipelineOptOut: cfg?.pipelineOptOut ?? false,
        coding: coding ?? null,
        goals: userTasks,
        runs: cardRuns,
        queueKeys,
        touchedAt: touchedAtRoot,
        isWindows: IS_WINDOWS,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, nowRows, researchCfg, codingByPath, workspaces, userTasks, cardRuns, queueKeySig, sessions]);
  /** 项目最后一次活动：项目根与它的工作副本 / 工作树里的对话，加分支最近提交，取最新 */
  const lastActiveByPath = useMemo(() => {
    const out = new Map<string, string>();
    for (const card of cards) {
      const roots = [
        card.path,
        ...workspaces.filter((w) => samePath(w.repoPath, card.path, IS_WINDOWS)).map((w) => w.worktreePath),
        ...(Object.entries(codingByPath).find(([path]) => samePath(path, card.path, IS_WINDOWS))?.[1].worktrees ?? []).map((w) => w.path),
      ];
      let best: string | null = null;
      for (const sess of sessions) {
        if (sess.internal || !sess.updatedAt || !sess.projectPath) continue;
        if (!roots.some((root) => pathWithin(sess.projectPath, root, IS_WINDOWS))) continue;
        if (!best || sess.updatedAt > best) best = sess.updatedAt;
      }
      for (const w of Object.entries(codingByPath).find(([path]) => samePath(path, card.path, IS_WINDOWS))?.[1].worktrees ?? []) {
        if (w.isBase && w.isPrimary) continue;
        if (w.lastCommitAt && (!best || Date.parse(w.lastCommitAt) > Date.parse(best))) best = w.lastCommitAt;
      }
      if (best) out.set(card.path, best);
    }
    return out;
  }, [cards, sessions, workspaces, codingByPath]);
  const lastActiveOf = (path: string) =>
    [...lastActiveByPath.entries()].find(([p]) => samePath(p, path, IS_WINDOWS))?.[1] ?? null;
  // 有活的（cardIsActive）：此刻有事，或手上在做且 7 天内动过；只是分支落后基准、目标记下没开工的不算。
  // 「正在进行」原有的排序（确认 > 正在跑 > 其余）在前，其余按最近活动；一个都没有时留最近在做的那一个
  const activeCardPaths = useMemo(() => {
    const now = Date.now();
    const active = cards.filter((card) => {
      const at = lastActiveOf(card.path);
      return cardIsActive(card, at ? Date.parse(at) : null, now);
    });
    const rank = (path: string) => {
      const i = nowRows.findIndex((row) => samePath(row.path, path, IS_WINDOWS));
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const out = active
      .sort((a, b) => rank(a.path) - rank(b.path) || (lastActiveOf(b.path) ?? "").localeCompare(lastActiveOf(a.path) ?? ""))
      .map((card) => card.path);
    if (out.length === 0 && hero) out.push(hero.path);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, nowRows, hero, lastActiveByPath])
  const [cardFilter, setCardFilter] = useState<CardFilter>("active");
  // 顺序跟侧栏（置顶 > 拖动排序 > 其余按最近活动），和左边项目树对得上（2026-10-27）
  function orderLikeSidebarSafe<T extends ProjectCard>(list: readonly T[]): T[] {
    const byRecent = [...list].sort((a, b) => (lastActiveOf(b.path) ?? "").localeCompare(lastActiveOf(a.path) ?? ""));
    let pins: string[] = [];
    let order: string[] = [];
    try {
      pins = parsePins(localStorage.getItem(PROJECT_PINS_KEY));
      order = parsePins(localStorage.getItem(PROJECT_ORDER_KEY));
    } catch {
      /* 读不到就按最近活动 */
    }
    return orderLikeSidebar(byRecent, pins, order, IS_WINDOWS);
  }
  const shownCards = orderLikeSidebarSafe(filterCards(cards, activeCardPaths, cardFilter, IS_WINDOWS));
  // 安静的项目收成一行（2026-10-27 精修）：「有活的」里不出现的、以及其余筛选下手上什么都没有的，
  // 不再各画一整组（空组里只剩一行「记下一个目标」）；分组只给有事可看的
  const groupCards = cardFilter === "active" ? shownCards : shownCards.filter((card) => card.tasks.length > 0);
  const quietCards = (cardFilter === "active"
    ? orderLikeSidebarSafe(cards.filter((card) => card.registered && !activeCardPaths.some((p) => samePath(p, card.path, IS_WINDOWS))))
    : shownCards.filter((card) => card.tasks.length === 0)
  ).filter((card) => card.registered);
  const cardFilterOptions: { id: CardFilter; label: string }[] = [
    // 「进行中」：此刻有事或手上在做的项目（2026-10-27 用户：「有活的」看着随意）；区块标题因此改叫「项目」，不写两遍进行中
    { id: "active", label: `进行中 ${activeCardPaths.length}` },
    { id: "all", label: "全部" },
    ...(["research", "coding", "office"] as const)
      .filter((mode) => cards.some((c) => c.workMode === mode))
      .map((mode) => ({ id: mode, label: WORK_MODE_LABEL[mode] })),
  ];

  const [openTask, setOpenTask] = useState<{ path: string; taskId: string } | null>(null);
  const openCard = openTask ? (cards.find((c) => samePath(c.path, openTask.path, IS_WINDOWS)) ?? null) : null;
  // ===== 定时任务总览（跨项目；项目分组里不再列定时任务）=====
  const scheduleRows = useMemo(
    () => scheduleOverview(schedules, projects, new Set(queueKeySig ? queueKeySig.split("\n") : []), new Date(nowMs), IS_WINDOWS),
    [schedules, projects, queueKeySig, nowMs],
  );
  const scheduleBusy = useRef(new Set<string>());
  async function runScheduleAction(row: ScheduleOverviewRow) {
    if (!row.action || row.task.ref.kind !== "schedule") return;
    const id = row.task.ref.scheduleId;
    if (scheduleBusy.current.has(id)) return;
    scheduleBusy.current.add(id);
    try {
      if (row.action === "cancel") await invoke("cancel_schedule_run", { id });
      else if (row.action === "reopen") await invoke("update_schedule", { id, patch: { enabled: true } });
      else await invoke("run_schedule_now", { id });
      toast(
        row.action === "cancel"
          ? `已停止「${row.task.name}」`
          : row.action === "reopen"
            ? `已重新打开「${row.task.name}」`
            : `「${row.task.name}」开始跑了`,
        "success",
      );
      // 只重读定时任务（整页重拉会把每个编程项目的 git 状态也跑一遍）；跑完的结果另有 scheduler-run-done 事件刷新
      void invoke<ScheduleDto[]>("list_schedules")
        .then((list) => { setSchedules(list); setNowMs(Date.now()); recordRead("schedules", "定时任务", true); })
        .catch(() => recordRead("schedules", "定时任务", false));
    } catch (reason) {
      toast(`「${row.task.name}」没能${row.action === "cancel" ? "停止" : row.action === "reopen" ? "重新打开" : "开始"}：${String(reason)}`, "error");
    } finally {
      scheduleBusy.current.delete(id);
    }
  }
  function openScheduleQueue(row: ScheduleOverviewRow) {
    if (row.task.ref.kind !== "schedule") return;
    const id = row.task.ref.scheduleId;
    const queued = queueRows.find((item) => item.key === `sched:paused:${id}` || item.key.startsWith(`sched:review:${id}:`));
    if (!queued) { openProjectSchedules(row.projectRoot); return; }
    setSelectedKey(`q:${queued.key}`);
    requestAnimationFrame(() => {
      const element = document.getElementById(`wbq-${queued.key}`);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "nearest" });
    });
  }
  function openScheduleRow(row: ScheduleOverviewRow) {
    if (row.task.queued) { openScheduleQueue(row); return; }
    setSelectedKey(`s:${row.task.id}`);
    setOpenTask({ path: row.projectRoot, taskId: row.task.id });
  }
  const openCardTask =
    openCard?.tasks.find((t) => t.id === openTask?.taskId) ??
    (openTask?.taskId.startsWith("schedule:")
      ? (scheduleRows.find((r) => r.task.id === openTask.taskId)?.task ?? null)
      : null);
  const panelData = useMemo(() => {
    const ref = openCardTask?.ref;
    if (!openCard || !ref) return null;
    const cfg = Object.entries(researchCfg).find(([path]) => samePath(path, openCard.path, IS_WINDOWS))?.[1];
    const coding = Object.entries(codingByPath).find(([path]) => samePath(path, openCard.path, IS_WINDOWS))?.[1];
    const step = ref.kind === "step" ? (cfg?.steps[ref.stepIndex] ?? null) : null;
    const goal = ref.kind === "goal" ? (userTasks.find((t) => t.id === ref.taskId) ?? null) : null;
    const branch = ref.kind === "branch" ? (coding?.worktrees.find((w) => samePath(w.path, ref.path, IS_WINDOWS)) ?? null) : null;
    const schedule = ref.kind === "schedule" ? (schedules.find((x) => x.id === ref.scheduleId) ?? null) : null;
    const root =
      ref.kind === "step" ? ref.worktreePath : ref.kind === "branch" ? ref.path : null;
    const pastRuns = allRuns.filter((run) => {
      if (run.internal) return false;
      if (ref.kind === "goal") return run.taskId === ref.taskId;
      if (ref.kind === "chat") return !!openCardTask?.live?.runId && run.id === openCardTask.live.runId;
      return !!root && pathWithin(run.isolationPath, root, IS_WINDOWS);
    });
    return { step, goal, branch, schedule, pastRuns, baseBranch: coding?.baseBranch ?? null };
  }, [openCard, openCardTask, researchCfg, codingByPath, userTasks, schedules, allRuns]);
  function closeTaskPanel() {
    setOpenTask(null);
  }
  const panelActions: TaskPanelAction[] = [];
  if (openCard && openCardTask && panelData) {
    const ref = openCardTask.ref;
    const live = openCardTask.live;
    const act = (label: string, run: () => void) =>
      panelActions.push({
        label,
        onClick: () => {
          closeTaskPanel();
          run();
        },
      });
    if (live) {
      act("回到对话", () => {
        if (live.runId) openRun(live.runId, live.tabId);
        else {
          setFocusTabReq(live.tabId);
          setPage("terminal");
        }
      });
    } else if (ref.kind !== "schedule" && panelData.pastRuns[0]) {
      const last = panelData.pastRuns[0];
      act("接着上次的对话", () => openRun(last.id));
    }
    if (ref.kind === "goal" && ref.status === "pending_review") {
      act("去验收", () => {
        setSelectProjectReq(openCard.path);
        setTaskReviewReq({ projectRoot: openCard.path, taskId: ref.taskId });
        setPage("workspaces");
      });
    }
    const reviewPath = ref.kind === "step" ? ref.worktreePath : ref.kind === "branch" ? ref.path : null;
    if (reviewPath) {
      act("看改动", () => {
        setWorkspaceReviewRequest({
          worktreePath: reviewPath,
          runId: panelData.pastRuns[0]?.id ?? null,
          requestId: crypto.randomUUID(),
        });
        setPage("terminal");
      });
    }
    if (ref.kind === "schedule") act("去定时任务页", () => openProjectSchedules(openCard.path));
    if (openCard.registered) {
      act(ref.kind === "goal" && ref.status !== "pending_review" && !live ? "去项目页开始" : "在项目页打开", () => {
        setSelectProjectReq(openCard.path);
        setPage("workspaces");
      });
    }
  }
  // ===== 任务行实时状态与详情花费 =====
  const anyLive = cardRuns.length > 0;
  useEffect(() => {
    if (!visible || !anyLive) return;
    // 时长按分钟写，15 秒刷一次足够；不在跑就不刷
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    setNowMs(Date.now());
    return () => window.clearInterval(timer);
  }, [visible, anyLive]);
  /** 标签 → 会话：标签自己报的优先，没有就查它那次运行的账 */
  function sessionOfTab(tabId: string, runId?: string): { agent: string; sessionId: string } | null {
    const tab = terminalRunInputs.find((r) => r.tabId === tabId);
    if (tab?.sessionId) return { agent: tab.agentId, sessionId: tab.sessionId };
    const run = runId ? allRuns.find((r) => r.id === runId) : undefined;
    return run?.sessionId ? { agent: run.agent, sessionId: run.sessionId } : null;
  }
  const usageKey = (agent: string, sessionId: string) => `${agent}\n${sessionId}`;
  const [usages, setUsages] = useState<Record<string, SessionUsageDto>>({});
  // 花费只在详情展示：只拉当前任务的会话与历次运行，按会话去重。
  const usageWantSig = [
    openCardTask?.live ? sessionOfTab(openCardTask.live.tabId, openCardTask.live.runId) : null,
    ...(panelData?.pastRuns ?? []).map((r) => (r.sessionId ? { agent: r.agent, sessionId: r.sessionId } : null)),
  ]
    .filter((x): x is { agent: string; sessionId: string } => !!x)
    .map((x) => usageKey(x.agent, x.sessionId))
    .filter((k, i, all) => all.indexOf(k) === i)
    .sort()
    .join("\t");
  useEffect(() => {
    if (!visible || !usageWantSig) return;
    let stale = false;
    const pull = () => {
      for (const key of usageWantSig.split("\t")) {
        const [agent, sessionId] = key.split("\n");
        invoke<SessionUsageDto>("session_usage", { agent, sessionId })
          .then((u) => {
            if (!stale) setUsages((cur) => ({ ...cur, [key]: u }));
          })
          .catch(() => {
            /* 花费是附加信息：读不到就不写 */
          });
      }
    };
    pull();
    // 与终端状态栏同一节奏：60 秒追一次新
    const unpoll = pollEvery(pull, 60_000);
    return () => {
      stale = true;
      unpoll();
    };
  }, [visible, usageWantSig]);
  function costText(keys: readonly string[]): string | null {
    const rows = keys.map((k) => usages[k]).filter((u): u is SessionUsageDto => !!u);
    if (!rows.length || !rows.some((u) => u.priced)) return null;
    const total = rows.reduce((n, u) => n + (u.priced ? u.costUsd : 0), 0);
    return fmtCost(total, "$", 1, rows.length < keys.length || rows.some((u) => !u.priced));
  }
  function liveMeta(live: CardLiveRun): { activity: string | null; elapsed: string | null } {
    const snap = channelSnaps[live.tabId];
    const tab = terminalRunInputs.find((r) => r.tabId === live.tabId);
    const ms = turnElapsedMs(snap, nowMs);
    return {
      activity: liveActivityLine(snap, tab?.cwd ?? null, IS_WINDOWS),
      elapsed: ms === null ? null : durationLabel(ms),
    };
  }
  const panelLive = (() => {
    const live = openCardTask?.live;
    const pastKeys = (panelData?.pastRuns ?? [])
      .filter((r) => r.sessionId)
      .map((r) => usageKey(r.agent, r.sessionId!));
    const liveSession = live ? sessionOfTab(live.tabId, live.runId) : null;
    const total = costText([...new Set([...pastKeys, ...(liveSession ? [usageKey(liveSession.agent, liveSession.sessionId)] : [])])]);
    const meta = live ? liveMeta(live) : null;
    if (!meta?.activity && !meta?.elapsed && !total) return null;
    return (
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg ccode-well p-3 text-sm">
        {meta?.activity && (
          <>
            <dt className="text-l3">此刻</dt>
            <dd className="min-w-0 truncate text-l1" title={meta.activity}>{meta.activity}</dd>
          </>
        )}
        {meta?.elapsed && (
          <>
            <dt className="text-l3">这一轮</dt>
            <dd className="text-l1">已跑 {meta.elapsed}</dd>
          </>
        )}
        {total && (
          <>
            <dt className="text-l3">花费</dt>
            <dd className="text-l1" title="这件事历次对话按会话去重合计；≥ 表示部分数据未读到或模型未计价，仅列已知花费">
              {total}
            </dd>
          </>
        )}
      </dl>
    );
  })();

  // ===== 第三批：离开期间摘要 =====
  const [awaySince, setAwaySince] = useState<number | null>(null);
  const [awayDismissed, setAwayDismissed] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let prev: number | null = null;
    try {
      prev = Number(localStorage.getItem(WORKBENCH_LAST_SEEN_KEY)) || null;
    } catch {
      /* 读不到就当第一次来 */
    }
    setAwaySince(prev);
    setAwayDismissed(false);
    // 页面常驻挂着，回来时先把「现在」对准，摘要和时长才不按上次的钟算
    setNowMs(Date.now());
    // 看着工作台的时间都算「在」：进来记一次、每分钟记一次、离开 / 关窗再记一次
    const mark = () => {
      try {
        localStorage.setItem(WORKBENCH_LAST_SEEN_KEY, String(Date.now()));
      } catch {
        /* 写不进就只是下次不出摘要 */
      }
    };
    mark();
    const timer = window.setInterval(mark, 60_000);
    window.addEventListener("beforeunload", mark);
    return () => {
      mark();
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", mark);
    };
  }, [visible]);
  const away = awayDismissed
    ? null
    : awaySummary({ sinceMs: awaySince, nowMs, runs: allRuns, schedules, waiting: queueRows.length });

  const taskPanel = (
    <WorkbenchTaskPanel
      open={!!openCardTask}
      onClose={closeTaskPanel}
      card={openCard}
      task={openCardTask}
      step={panelData?.step ?? null}
      goal={panelData?.goal ?? null}
      branch={panelData?.branch ?? null}
      baseBranch={panelData?.baseBranch ?? null}
      schedule={panelData?.schedule ?? null}
      pastRuns={panelData?.pastRuns ?? []}
      agentLabel={agentLabel}
      live={panelLive}
      actions={panelActions}
    />
  );

  // ===== 键盘：J/K 从拍板队列一路走到项目分组的任务行、再到定时任务；回车去处理 / 开任务面板 =====
  type NavItem = { key: string; queue?: (typeof queueRows)[number]; card?: (typeof cards)[number]; task?: CardTask; schedule?: ScheduleOverviewRow };
  const navItems: NavItem[] = [
    ...navigableQueueRows.map((row) => ({ key: `q:${row.key}`, queue: row })),
    ...groupCards.flatMap((card) => card.tasks.map((task) => ({ key: `t:${card.path}\n${task.id}`, card, task }))),
    ...scheduleRows.map((row) => ({ key: `s:${row.task.id}`, schedule: row })),
  ];
  const navIndex = resolveSelection(navItems, selectedKey, lastSelectedIndex.current);
  if (navIndex >= 0) lastSelectedIndex.current = navIndex;
  // 只有真按过键 / 点过才高亮项目分组与定时任务里的行；默认只高亮队列第一行（同原口径）
  const navSelected = selectedKey !== null && navIndex >= 0 ? navItems[navIndex] : null;
  // 队列里的选中行：没动过时默认第一行（同原口径）；选到项目分组 / 定时任务时队列里不亮
  const selectedRow = selectedKey === null ? (decisionRows[0] ?? null) : (navSelected?.queue ?? null);
  const selectedIndex = selectedRow ? decisionRows.indexOf(selectedRow) : -1;
  // 键盘选到折叠的部分就展开，选中行总在眼前
  const shownQueueRows =
    inboxExpanded || selectedIndex >= QUEUE_VISIBLE ? decisionRows : decisionRows.slice(0, QUEUE_VISIBLE);
  function focusNavItem(item: NavItem) {
    setSelectedKey(item.key);
    const id = item.queue ? `wbq-${item.queue.key}` : item.task && item.card ? `wbt-${item.card.path}\n${item.task.id}` : `wbs-${item.schedule?.task.id}`;
    requestAnimationFrame(() => {
      const element = document.getElementById(id);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "nearest" });
    });
  }
  function focusAfterQueueChange(key: string) {
    const index = navItems.findIndex((item) => item.key === `q:${key}`);
    const next = navItems[index + 1] ?? navItems[index - 1];
    if (next) focusNavItem(next);
    else requestAnimationFrame(() => document.getElementById("workbench-title")?.focus());
  }
  const queueKeyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  queueKeyRef.current = (event) => {
    const target = event.target as HTMLElement | null;
    if (event.defaultPrevented || event.isComposing) return;
    // 焦点在侧栏（⌘0 后 ↑↓ 选对话）、顶栏或输入框里时不接管：只认焦点在页面空白处或工作台的列表里
    if (target && target !== document.body && !target.closest("[data-workbench-queue]")) return;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (document.querySelector("[role='dialog'], [aria-modal='true']")) return;
    // 焦点在别的按钮上时回车留给那个按钮
    if (event.key === "Enter" && target?.closest("button, a, summary")) return;
    if (navItems.length === 0) return;
    const focusKey = target?.closest<HTMLElement>("[data-workbench-nav]")?.dataset.workbenchNav;
    const focused = navItems.find((item) => item.key === focusKey);
    const current = focused ?? (selectedKey === null ? (navItems[0] ?? null) : navIndex >= 0 ? navItems[navIndex] : null);
    const action = queueKeyAction(event, current?.queue ?? null);
    if (!action) {
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey && current && !current.queue) {
        event.preventDefault();
        if (current.task && current.card) setOpenTask({ path: current.card.path, taskId: current.task.id });
        else if (current.schedule) openScheduleRow(current.schedule);
      }
      return;
    }
    event.preventDefault();
    if (action === "next" || action === "prev") {
      // 没动过时：队列第一行本来就亮着，从它往下走；队列空着（什么都没亮）第一下停在第一行
      const from = focused ? navItems.indexOf(focused) : selectedKey === null ? (decisionRows.length ? 0 : -1) : navIndex;
      const next = navItems[moveSelection(navItems.length, from, action === "next" ? 1 : -1)];
      if (!next) return;
      focusNavItem(next);
      return;
    }
    const row = current?.queue;
    if (!row) return;
    if (action === "open") openRow(row);
    else if (action === "allow" || action === "deny") answerApproval(row, action);
    else if (action === "dismiss") dismissRow(row);
  };
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => queueKeyRef.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  const runningBadge = nowItems.reduce((n, item) => n + item.runningCount, 0)
    || (hero?.runningCount ?? 0);
  /** 这个标签上跑完了没看（chat-unread.ts）：行尾光标换蓝色 */
  function runUnread(tabId: string): boolean {
    const run = terminalRunInputs.find((x) => x.tabId === tabId);
    return run != null && unreadChats.includes(unreadKeyOf(run));
  }

  const openApprovalRow = queueRows.find((row) => row.key === openApprovalKey && row.kind === "inbox" && row.approval) ?? null;
  const activeReadKeys = new Set([
    "projects", "workspaces", "runs", "schedules", ...(projects.length ? ["tasks"] : []),
    ...projects.flatMap((project) => {
      const mode = normalizeWorkMode(project.workMode);
      return mode === "coding" ? [`coding:${project.path}`] : mode === "research" ? [`research:${project.path}`] : [];
    }),
  ]);
  const readFailures = Object.entries(reads).filter(([key, read]) => activeReadKeys.has(key) && read.failed);

  function renderQueueList(rows: typeof queueRows, label: string) {
    return (
      <ul className="ccode-workbench-list overflow-hidden rounded-lg border border-hairline" aria-label={label}>
        {rows.map((row, index) => {
          const tierHead = showTierHeads && row.tier !== "notice" && (index === 0 || rows[index - 1].tier !== row.tier);
          const selected = row === selectedRow;
          const approval = row.kind === "inbox" ? row.approval : null;
          const category = row.kind === "inbox" ? inboxCategoryOf(row.key) : "ready";
          const Symbol = category === "conflict" ? Files : category === "schedule" ? AlarmClock : row.tier === "blocking" ? TriangleAlert : row.tier === "notice" ? Inbox : CheckCheck;
          const symbolColor = row.dot === "bg-err-text" ? "text-err-text" : row.dot === "bg-ok-text" ? "text-ok-text" : row.tier === "notice" ? "text-l3" : "text-warn-text";
          return (
            <li key={row.key} id={`wbq-${row.key}`} data-workbench-nav={`q:${row.key}`} tabIndex={-1}
              className={`group relative border-t border-hairline first:border-t-0 ${selected ? "bg-hover shadow-[inset_2px_0_0_var(--color-nav-accent)]" : "hover:bg-hover"}`}
              onFocusCapture={() => setSelectedKey(`q:${row.key}`)}>
              {tierHead && <p className="px-3.5 pb-0.5 pt-2 text-micro text-l3">{QUEUE_TIER_LABEL[row.tier]}</p>}
              <div className="ccode-workbench-queue-row">
                <span aria-hidden="true" className={`ccode-workbench-queue-symbol flex shrink-0 items-center justify-center border border-hairline ${symbolColor}`}><Symbol size={14} strokeWidth={1.6} /></span>
                <button type="button" className="ccode-workbench-queue-content min-w-0 flex-1 text-left" aria-haspopup={approval ? "dialog" : undefined} onClick={() => openRow(row)}>
                  <span className="block break-words text-sm font-medium text-l1">{approval?.title ?? row.text}</span>
                  {(row.project || approval) && (
                    <span className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs text-l3">
                      {approval && <span>{row.text}</span>}
                      {row.project && <span>{approval ? `· ${row.project}` : row.project}</span>}
                      {approval?.detail && <span className="min-w-0 truncate font-mono" title={approval.detail}>· {approval.detail}</span>}
                    </span>
                  )}
                </button>
                <span className="ccode-workbench-queue-actions flex shrink-0 flex-wrap items-center gap-1.5">
                  {approval ? (
                    <>
                      <button type="button" className={rowActionClass} aria-haspopup="dialog" onClick={() => setOpenApprovalKey(row.key)}>详情</button>
                      <button type="button" className={rowActionClass} title="拒绝这一问（R）：5 秒内可撤销" onClick={() => answerApproval(row, "deny")}>{approval.denyLabel}</button>
                      <button type="button" className={rowActionClass} title="允许这一次（A）：5 秒内可撤销；更多权限选项在原对话里选择" onClick={() => answerApproval(row, "allow")}>允许一次</button>
                    </>
                  ) : (
                    <>
                      {row.kind === "inbox" && row.dismissible && (
                        <button type="button" className={`${rowActionClass} ${selected ? "" : hoverRevealClass} text-l3`} title="收起这条通知（E）：5 秒内可撤销；状态一变它还会回来" onClick={() => dismissRow(row)}>收起</button>
                      )}
                      <button type="button" className={rowActionClass} onClick={() => openRow(row)}>{row.kind === "inbox" ? row.item.actionLabel : "去验收"}</button>
                    </>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <PageFrame width="wide" className="pb-12 pt-6">
      <div className="ccode-workbench min-w-0">
      {/* 首页不放页面大标题（2026-10-24 用户）：侧栏「工作台」已高亮，大字只重复一遍、还占掉最显眼的一行；
          标题只留给屏幕阅读器，顶上 pt-6 留白免得「最近在做」贴着窗口顶边。其他页的标题照旧。
          「新对话」不在这里放（2026-10-23 侧栏挂对话第一期）：侧栏「新对话」就在左边，两个按钮一模一样 */}
      <h1 id="workbench-title" tabIndex={-1} className="sr-only">工作台</h1>
      {readFailures.length > 0 && (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn-text">
          <div>
            <p>以下内容未能更新，已读到的旧状态会保留。</p>
            <ul className="mt-1 space-y-0.5">
              {readFailures.map(([key, read]) => (
                <li key={key} title={read.lastSuccess ? new Date(read.lastSuccess).toLocaleString("zh-CN", { hour12: false }) : undefined}>
                  {read.label}：{read.lastSuccess ? `状态截至 ${new Date(read.lastSuccess).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "尚未成功读取"}
                </li>
              ))}
            </ul>
          </div>
          <button type="button" className={secondaryActionClass} onClick={() => setReloadToken((n) => n + 1)}>重试</button>
        </div>
      )}

      {/* 单栏自上而下：等你拍板 → 正在进行 → 记下目标 → 定时任务（2026-10-27 设计稿第一批：
          拍板队列提到最上面；「继续工作」大卡与最近对话删掉——侧栏点对话就能接着聊，最近对话就是侧栏那一份） */}
      {away && (
        <div className="mb-5 flex min-w-0 items-center gap-2 px-1 text-sm text-l3">
          <Moon size={13} strokeWidth={1.8} className="shrink-0 text-l4" aria-hidden="true" />
          <span className="min-w-0 truncate">
            {away.lead}：{away.parts.join(" · ")}
          </span>
          <button
            type="button"
            className="ml-auto shrink-0 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
            onClick={() => setAwayDismissed(true)}
          >
            知道了
          </button>
        </div>
      )}
      {queueRows.length > 0 && (
        <section className="mb-7 min-w-0" data-workbench-queue="">
          <SectionHeading
            icon={Inbox}
            title={decisionRows.length ? "等你拍板" : "通知"}
            action={
              <span className="flex flex-wrap items-center justify-end gap-2">
                <span className="hidden text-micro text-l3 lg:inline" aria-hidden="true">{QUEUE_KEY_HINT}</span>
                {noticeRows.length > 0 && (
                  <button type="button" className={ghostActionClass} aria-expanded={noticesExpanded} aria-controls="workbench-notices" onClick={() => setNoticesExpanded((value) => !value)}>
                    {decisionRows.length ? "通知" : noticesExpanded ? "收起" : "展开"} {noticeRows.length}
                  </button>
                )}
                {bulkInboxItems.length > 0 && (
                  <button type="button" className="rounded-full p-1 text-l3 hover:bg-hover hover:text-l1" title="全部已读：收起信息类通报；冲突、待确认等需要拍板的事不受影响" aria-label="全部已读（仅信息类）" onClick={() => dismissInboxBulk(bulkInboxItems)}>
                    <CheckCheck size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
                {decisionRows.length > 1 && <span className="rounded-full bg-warn px-2 py-0.5 text-micro text-warn-text">{decisionRows.length}</span>}
              </span>
            }
          />
          {shownQueueRows.length > 0 && renderQueueList(shownQueueRows, "等你拍板")}
          {decisionRows.length > QUEUE_VISIBLE && (
            <button type="button" className={`${rowActionClass} mt-1 w-full justify-start px-3.5 text-l3`} aria-expanded={inboxExpanded} onClick={() => setInboxExpanded((value) => !value)}>
              {inboxExpanded ? "收起" : `还有 ${decisionRows.length - QUEUE_VISIBLE} 条`}
            </button>
          )}
          <div id="workbench-notices" hidden={!noticesExpanded} className="mt-2">
            {noticesExpanded && renderQueueList(noticeRows, "信息通知")}
          </div>
        </section>
      )}

      <section className="min-w-0">
          <div className="mb-2.5 flex flex-wrap items-center gap-2 px-1">
            {/* 三块的标题同一个样子（同 SectionHeading）：原先这里是 micro 灰字，夹在两个 base 粗体标题之间 */}
            <CircleDot size={14} strokeWidth={1.8} className={iconClass} aria-hidden="true" />
            <h2 className="text-base font-semibold text-l1">
              项目
            </h2>
            {runningBadge > 0 && (
              // 运行计数是数字不是状态：行尾光标已表达「在跑」，计数回落灰底芯片（同技能页计数口径）
              <span className="rounded-full bg-inset px-2 py-0.5 text-micro text-l3">
                {runningBadge} 个运行中
              </span>
            )}
            {cardFilterOptions.length > 2 && (
              <div className="ml-auto flex flex-wrap items-center gap-1" role="group" aria-label="筛选项目">
                {cardFilterOptions.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={cardFilter === opt.id}
                    className={`rounded-full px-2 py-0.5 ${
                      cardFilter === opt.id ? "bg-seg-sel text-l1" : "text-l3 hover:bg-hover hover:text-l1"
                    }`}
                    onClick={() => setCardFilter(opt.id)}
                  >
                    <span className="text-micro">{opt.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {nowRows.length > 0 ? (
            groupCards.length > 0 || quietCards.length > 0 ? (
              <div className="ccode-workbench-list overflow-hidden rounded-lg border border-hairline" data-workbench-queue="">
                {groupCards.map((card) => {
                  const item = nowRows.find((row) => samePath(row.path, card.path, IS_WINDOWS)) ?? null;
                  const said = lastSaidFor(card.path);
                  const destination = resolveWorkbenchDestination(
                    item ? continueWorkbenchTarget(item) : { kind: card.registered ? "project" : "enter-cwd", path: card.path },
                    allRuns,
                    IS_WINDOWS,
                  );
                  const canGoal = goalTargets.some((t) => samePath(t.path, card.path, IS_WINDOWS));
                  return (
                    <WorkbenchProjectGroup
                      key={card.path}
                      card={card}
                      openTaskId={openTask && samePath(openTask.path, card.path, IS_WINDOWS) ? openTask.taskId : null}
                      selectedTaskId={navSelected?.card === card ? (navSelected.task?.id ?? null) : null}
                      onOpenTask={(task) => {
                        setSelectedKey(`t:${card.path}\n${task.id}`);
                        setOpenTask({ path: card.path, taskId: task.id });
                      }}
                      onOpenProject={
                        card.registered
                          ? () => {
                              setSelectProjectReq(card.path);
                              setPage("workspaces");
                            }
                          : null
                      }
                      onContinue={() => void openContinueTarget(destination)}
                      continueLabel={destination.label}
                      continueTip={said ? `${destination.label}\n上次停在：${said.full}` : destination.label}
                      lastActive={lastActiveOf(card.path)}
                      liveMeta={liveMeta}
                      agentLabel={agentLabel}
                      caretFor={(live) => withUnread(caretOfAttention(live.attention), runUnread(live.tabId)) ?? "idle"}
                      clientJump={
                        showClientJump
                          ? { label: clientJumpLabel, onClick: () => clientOpen.openProject(card.path) }
                          : null
                      }
                      footer={
                        canGoal && goalOpen && goalTarget && samePath(goalTarget.path, card.path, IS_WINDOWS) ? (
                          // 想到就记：只记下不开工，落到该项目的目标列表；开工、选 Agent 仍在项目页由人来
                          <form
                            className="flex w-full items-center gap-1.5 py-0.5"
                            onSubmit={(event) => void captureGoal(event)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape" && !goalBusy) setGoalOpen(false);
                            }}
                          >
                            <input
                              className={`${fieldClass} h-7 min-w-0 flex-1 py-0`}
                              value={goalDraft}
                              onChange={(event) => setGoalDraft(event.target.value)}
                              placeholder={
                                goalTarget.goalKind === "office_doc"
                                  ? "要完成什么，例如：按公司模板写本周周报"
                                  : "要完成什么，例如：根据项目里的文献写一篇综述"
                              }
                              aria-label={`给「${card.name}」记下一个目标`}
                              maxLength={500}
                              autoFocus
                            />
                            <button type="button" className={ghostActionClass} disabled={goalBusy} onClick={() => setGoalOpen(false)}>
                              取消
                            </button>
                            <button type="submit" className={secondaryActionClass} disabled={goalBusy || !goalDraft.trim()}>
                              {goalBusy ? "记下…" : "记下"}
                            </button>
                          </form>
                        ) : canGoal ? (
                          <button
                            type="button"
                            className={`${ghostActionClass} h-7 gap-1.5 px-2`}
                            title="只记下不开工：记进这个项目的目标列表，之后在项目页选 Agent 再开始"
                            onClick={() => {
                              setGoalProject(card.path);
                              setGoalOpen(true);
                            }}
                          >
                            <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
                            <span className="text-micro">记下一个目标</span>
                          </button>
                        ) : null
                      }
                    />
                  );
                })}
                {quietCards.length > 0 && (
                  <p
                    className={`flex flex-wrap items-baseline gap-x-1.5 gap-y-1 px-4 py-2.5 text-xs text-l3 ${groupCards.length ? "border-t border-hairline" : ""}`}
                  >
                    <span>
                      {cardFilter === "active" ? "其他" : "另有"} {quietCards.length} 个项目没有进行中的事：
                    </span>
                    {quietCards.map((card, i) => (
                      <span key={card.path} className="inline-flex items-baseline gap-1.5">
                        <button
                          type="button"
                          className="text-l2 hover:text-l1 hover:underline"
                          title={`去项目页：${card.path}`}
                          onClick={() => {
                            setSelectProjectReq(card.path);
                            setPage("workspaces");
                          }}
                        >
                          {card.name}
                        </button>
                        {i < quietCards.length - 1 && <span aria-hidden="true">·</span>}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            ) : (
              <p className="px-1 py-3 text-sm text-l3">这一类没有项目。</p>
            )
          ) : reads.projects?.failed ? (
            <p className="px-1 py-3 text-sm text-l3">项目暂时无法读取，请重试。</p>
          ) : !projectsLoaded ? (
            <LoadingRows />
          ) : (
            <EmptyState
              compact
              title="从一个项目开始"
              detail="添加项目后，Mesa 会从上次停下的地方继续。"
              action={
                <button
                  type="button"
                  className={primaryActionClass}
                  onClick={() => setPage("workspaces")}
                >
                  添加项目
                </button>
              }
            />
          )}
      </section>


      <WorkbenchSchedules
        rows={scheduleRows}
        nowMs={nowMs}
        openTaskId={openTask?.taskId.startsWith("schedule:") ? openTask.taskId : null}
        selectedTaskId={navSelected?.schedule?.task.id ?? null}
        onOpen={openScheduleRow}
        onQueue={openScheduleQueue}
        onAction={(row) => void runScheduleAction(row)}
      />
      </div>

      {taskPanel}
      <WorkbenchApprovalPanel
        approval={openApprovalRow?.kind === "inbox" ? openApprovalRow.approval : null}
        project={openApprovalRow?.project ?? null}
        onClose={() => setOpenApprovalKey(null)}
        onAnswer={(decision) => { if (openApprovalRow) answerApproval(openApprovalRow, decision); }}
        onConversation={() => {
          if (openApprovalRow?.kind === "inbox") runInboxAction(openApprovalRow.item);
          setOpenApprovalKey(null);
        }}
      />
      {clientOpen.dialog}
    </PageFrame>
  );
}

export default WorkbenchPage;
