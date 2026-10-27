import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AlarmClock,
  CheckCheck,
  ArrowRight,
  CircleDot,
  Inbox,
  Plus,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useAppStore, runInboxAction, visibleInboxItems } from "../store";
import { usePhoneDropStore } from "../phone-drop-store";
import { phonePendingCount } from "../phone-drop";
import { bulkReadableItems } from "../inbox";
import { pathWithin, samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { useClientOpen } from "../components/ClientOpenDialog";
import { absTime, relTime } from "../rel-time";
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
  TaskDto,
  WorkspaceDto,
} from "../types";
import { pickRecoverableRun, isWorkbenchActiveRun } from "../run-model";
import { visibleDeclaredTasks } from "../project-tasks";
import {
  continueWorkbenchTarget,
  goalCaptureTargets,
  inboxItemProjectRoot,
  lastUserInstruction,
  latestProjectSession,
  openStepProgress,
  pickWorkbenchHero,
  pickWorkbenchNow,
  stepProgressLabel,
  workbenchLoadFailureMessage,
  workbenchNowSectionTitle,
  workbenchNowSubtitle,
  workbenchRecentRows,
  type WorkbenchContinue,
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
  MenuSelect,
  PageFrame,
  fieldClass,
  ghostActionClass,
  hoverRevealClass,
  primaryActionClass,
  rowActionClass,
  secondaryActionClass,
} from "../components/PageFrame";
import { dismissToast, toast } from "../toast";
import RunCaret from "../components/RunCaret";
import { caretOfAttention, withUnread, type RunCaretState } from "../run-caret";
import { unreadKeyOf } from "../chat-unread";
import { workbenchScheduleRows } from "../schedule-tasks";
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
  createDeferred,
  moveSelection,
  pruneHidden,
  queueKeyAction,
  resolveSelection,
  type QueueApproval,
  type QueueRow,
} from "../workbench-queue";
import { pollEvery } from "../polling";

const iconClass = "shrink-0 text-l4";
/** 工作方式标签：描边不铺底（铺 bg-strip 在 well 上看不出边界，像一段错位的字） */
const modeChipClass =
  "inline-block shrink-0 rounded-full border border-hairline px-1.5 py-px text-micro leading-tight text-l3";

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
    <div className="mb-2.5 flex items-center gap-2 px-1">
      <Icon size={14} strokeWidth={1.8} className={iconClass} aria-hidden="true" />
      {/* Mac 根字号 14px 下 text-xs 只有 10.5px，比旁边 11px 的「查看全部」还小：标题用 micro，靠字重与字色分层 */}
      <h2 className="text-micro font-medium text-l2">{title}</h2>
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
  const [loadError, setLoadError] = useState<string | null>(null);
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
    setLoadError(null);
    invoke<ProjectDto[]>("list_projects")
      .then(setProjects)
      .catch(() => {
        setProjects([]);
        setLoadError("项目数据加载失败，可重试；其他工作台内容仍可继续使用。");
      })
      .finally(() => setProjectsLoaded(true));
    invoke<WorkspaceDto[]>("list_workspaces")
      .then(setWorkspaces)
      .catch(() => {
        setWorkspaces([]);
        setLoadError((current) =>
          current ?? "工作区状态加载失败，可重试；其他工作台内容仍可继续使用。",
        );
      });
    // 全量 Run（created_at 降序 500 条）：工作台归属（runId→项目）与「继续」按 runId 找回共用
    invoke<RunDto[]>("run_list", { projectRoot: null })
      .then(setAllRuns)
      .catch(() => setAllRuns([]));
  }, [visible, runCwdSig, reloadToken]);

  // 定时任务摘要：可见时拉一次；拉起 / 跑完 / 采纳时重拉；每分钟刷一次让「接下来」滚动
  useEffect(() => {
    if (!visible) return;
    let stale = false;
    const load = () => {
      invoke<ScheduleDto[]>("list_schedules")
        .then((list) => {
          if (!stale) setSchedules(list);
        })
        .catch(() => {
          /* 摘要是附加信息：读不到就不显示，下轮再试 */
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
  }, [visible, reloadToken]);

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
      const next: Record<string, CodingOverviewDto> = {};
      for (const row of rows) if (row.ov) next[row.path] = row.ov;
      setCodingByPath(next);
      const failed = workbenchLoadFailureMessage(
        rows.filter((row) => !row.ov).map((row) => row.name),
        "编程状态",
      );
      if (failed) toast(failed, "warning");
    });
    void Promise.all(
      research.map((p) =>
        invoke<ProjectConfigReadDto>("read_project_config", { path: p.path })
          .then((read) => ({ path: p.path, name: p.name, config: read.config }))
          .catch(() => ({ path: p.path, name: p.name, config: null })),
      ),
    ).then((rows) => {
      if (cancelled) return;
      const next: Record<string, { steps: ProjectStepDto[]; pipelineOptOut: boolean }> = {};
      for (const row of rows) {
        if (!row.config) continue;
        next[row.path] = {
          steps: row.config.steps ?? [],
          pipelineOptOut: !!row.config.pipelineOptOut,
        };
      }
      setResearchCfg(next);
      const failed = workbenchLoadFailureMessage(
        rows.filter((row) => !row.config).map((row) => row.name),
        "流程配置",
      );
      if (failed) toast(failed, "warning");
    });
    return () => {
      cancelled = true;
    };
    // projects 由 projectsSig 代表：轻量重拉换了数组引用但内容没变时不重跑 git
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, projectsSig, runDoneSig, reloadToken]);

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
      .catch(() => [] as TaskDto[])
      .then((list) => {
        if (cancelled) return;
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
      });
    return () => {
      cancelled = true;
    };
  }, [projects, visible, reloadToken]);

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
      /** 这个项目最后一次对话活动，紧凑行行尾的时间 */
      updatedAt: string | null;
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
        updatedAt: session.updatedAt,
      });
    }
    return out;
  }, [hero, nowItems, sessions]);
  function lastTargetFor(path: string) {
    return lastSaidTargets.find((t) => samePath(t.path, path, IS_WINDOWS)) ?? null;
  }
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
  const clientJumpTitle = `${clientJumpLabel}这个目录（只打开项目，不会定位到某条对话）`;

  /** 「继续」统一入口：主卡 / 紧凑行 / 未添加目录都先按 runId 找回原 Run，找不到再回落项目页或真进入。 */
  async function openContinueTarget(target: WorkbenchContinue) {
    if (target.kind === "terminal") {
      if (target.runId) openRun(target.runId, target.tabId);
      else {
        setFocusTabReq(target.tabId);
        setPage("terminal");
      }
      return;
    }
    const recovered = pickRecoverableRun(allRuns, target.path, IS_WINDOWS);
    if (recovered) {
      openRun(recovered.id);
      return;
    }
    if (target.kind === "project") {
      setSelectProjectReq(target.path);
      setPage("workspaces");
      return;
    }
    const repo = recentRepos.find((r) =>
      samePath(r.path, target.path, IS_WINDOWS),
    );
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

  // 定时任务摘要：在跑 / 上次失败 / 24 小时内要跑的；暂停与待评审已在「等你拍板」里，不重复
  const scheduleRows = workbenchScheduleRows(schedules, projects, new Date(), IS_WINDOWS);
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
  const confirmTabSig = Object.values(confirmTabs).sort().join("\n");
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
      };
    }
    return out;
  }, [confirmTabs, channelSnaps]);

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

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const lastSelectedIndex = useRef(0);
  const selectedIndex = resolveSelection(queueRows, selectedKey, lastSelectedIndex.current);
  if (selectedIndex >= 0) lastSelectedIndex.current = selectedIndex;
  const selectedRow = selectedIndex >= 0 ? queueRows[selectedIndex] : null;
  // 键盘选到折叠的部分就展开，选中行总在眼前
  const shownQueueRows =
    inboxExpanded || selectedIndex >= QUEUE_VISIBLE ? queueRows : queueRows.slice(0, QUEUE_VISIBLE);
  const showTierHeads = new Set(queueRows.map((row) => row.tier)).size > 1;

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
      row.key,
      `${decision === "allow" ? "已允许" : "已拒绝"}：${approval.title}`,
      async () => {
        try {
          await invoke("chat_channel_reply", {
            tabId: approval.tabId,
            requestId: approval.requestId,
            decision,
          });
        } catch (reason) {
          toast(`没能送到：${String(reason)}，可以回到对话里回答`, "error");
          throw reason;
        }
      },
    );
  }
  function dismissRow(row: QueueRow<(typeof inboxItems)[number]>) {
    if (row.kind !== "inbox" || !row.dismissible) return;
    const item = row.item;
    deferRow(row.key, `已收起：${row.text}`, () => useAppStore.getState().dismissInbox(item));
  }
  function openRow(row: QueueRow<(typeof inboxItems)[number]>) {
    if (row.kind === "inbox") {
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

  // 键盘：只在工作台可见、焦点不在输入框、没有弹层时接管；当前行做不了的键不吞
  const queueKeyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  queueKeyRef.current = (event) => {
    const target = event.target as HTMLElement | null;
    // 焦点在侧栏（⌘0 后 ↑↓ 选对话）、顶栏或输入框里时不接管：只认焦点在页面空白处或队列里
    if (target && target !== document.body && !target.closest("[data-workbench-queue]")) return;
    if (document.querySelector("[role='dialog'], [aria-modal='true']")) return;
    // 焦点在别的按钮上时回车留给那个按钮
    if (event.key === "Enter" && target?.closest("button, a")) return;
    const action = queueKeyAction(event, selectedRow);
    if (!action || queueRows.length === 0) return;
    event.preventDefault();
    if (action === "next" || action === "prev") {
      const next = moveSelection(queueRows.length, selectedIndex, action === "next" ? 1 : -1);
      setSelectedKey(queueRows[next]?.key ?? null);
      document.getElementById(`wbq-${queueRows[next]?.key}`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (!selectedRow) return;
    if (action === "open") openRow(selectedRow);
    else if (action === "allow" || action === "deny") answerApproval(selectedRow, action);
    else if (action === "dismiss") dismissRow(selectedRow);
  };
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => queueKeyRef.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  const runningBadge = nowItems.reduce((n, item) => n + item.runningCount, 0)
    || (hero?.runningCount ?? 0);
  /** 运行状态光标（run-caret.ts，2026-10-24 取代绿点 / 黄点）：等确认 / 在干活照注意力，开着闲着淡灰，没开着不画 */
  function itemCaret(item: {
    attention: "confirm" | "working" | "done" | null;
    runningCount: number;
  }): RunCaretState | null {
    if (item.attention === "confirm" || item.attention === "working") return item.attention;
    return item.runningCount > 0 ? "idle" : null;
  }
  /** 这个标签上跑完了没看（chat-unread.ts）：行尾光标换蓝色 */
  function runUnread(tabId: string): boolean {
    const run = terminalRunInputs.find((x) => x.tabId === tabId);
    return run != null && unreadChats.includes(unreadKeyOf(run));
  }

  return (
    <PageFrame width="fluid" className="pb-12 pt-6">
      {/* 首页不放页面大标题（2026-10-24 用户）：侧栏「工作台」已高亮，大字只重复一遍、还占掉最显眼的一行；
          标题只留给屏幕阅读器，顶上 pt-6 留白免得「最近在做」贴着窗口顶边。其他页的标题照旧。
          「新对话」不在这里放（2026-10-23 侧栏挂对话第一期）：侧栏「新对话」就在左边，两个按钮一模一样 */}
      <h1 className="sr-only">工作台</h1>
      {loadError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn-text">
          <span>{loadError}</span>
          <button
            type="button"
            className={secondaryActionClass}
            onClick={() => setReloadToken((n) => n + 1)}
          >
            重试
          </button>
        </div>
      )}

      {/* 单栏自上而下：等你拍板 → 正在进行 → 记下目标 → 定时任务（2026-10-27 设计稿第一批：
          拍板队列提到最上面；「继续工作」大卡与最近对话删掉——侧栏点对话就能接着聊，最近对话就是侧栏那一份） */}
      {queueRows.length > 0 && (
        <section className="mb-7 min-w-0" data-workbench-queue="">
          <SectionHeading
            icon={Inbox}
            title="等你拍板"
            action={
              <span className="flex items-center gap-2">
                <span className="hidden text-micro text-l3 lg:inline" aria-hidden="true">
                  {QUEUE_KEY_HINT}
                </span>
                {bulkInboxItems.length > 0 && (
                  <button
                    type="button"
                    className="rounded-full p-1 text-l3 hover:bg-hover hover:text-l1"
                    title="全部已读：一键收起信息类通报（文献 / 可合并 / 待核验 / 待发送 / 技能）；冲突、待确认这类要你拍板的不受影响，被收起的条目状态一变还会回来"
                    aria-label="全部已读（仅信息类）"
                    onClick={() => dismissInboxBulk(bulkInboxItems)}
                  >
                    <CheckCheck size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
                {/* 只剩一条时数字和那一行说的是同一件事，不再挂；有要拍板的才用黄底，全是通知用中性色 */}
                {queueRows.length > 1 && (
                  <span
                    className={
                      queueRows.some((row) => row.tier !== "notice")
                        ? "rounded-full bg-warn px-2 py-0.5 text-micro text-warn-text"
                        : "rounded-full bg-inset px-2 py-0.5 text-micro text-l3"
                    }
                  >
                    {queueRows.length}
                  </span>
                )}
              </span>
            }
          />
          <div
            className="overflow-hidden rounded-lg border border-hairline"
            role="listbox"
            aria-label="等你拍板"
            aria-activedescendant={selectedRow ? `wbq-${selectedRow.key}` : undefined}
          >
            {shownQueueRows.map((row, index) => {
              const tierHead =
                showTierHeads && (index === 0 || shownQueueRows[index - 1].tier !== row.tier);
              const selected = index === selectedIndex;
              const approval = row.kind === "inbox" ? row.approval : null;
              return (
                <div key={row.key}>
                  {tierHead && (
                    <div className="border-t border-hairline px-3.5 pb-0.5 pt-2 text-micro text-l3 first:border-t-0">
                      {QUEUE_TIER_LABEL[row.tier]}
                    </div>
                  )}
                  <div
                    id={`wbq-${row.key}`}
                    role="option"
                    aria-selected={selected}
                    className={`group relative flex min-h-11 items-center gap-3 px-3.5 py-2 ${
                      tierHead ? "" : "border-t border-hairline first:border-t-0"
                    } ${selected ? "bg-hover" : "hover:bg-hover"}`}
                    onClick={() => setSelectedKey(row.key)}
                  >
                    {selected && (
                      <span className="absolute inset-y-0 left-0 w-0.5 bg-nav-accent" aria-hidden="true" />
                    )}
                    <span className={`size-1.5 shrink-0 rounded-full ${row.dot}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-l1" title={approval?.title ?? row.text}>
                        {approval?.title ?? row.text}
                      </span>
                      {(row.project || approval) && (
                        <span className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-micro text-l3">
                          {approval && <span className="shrink-0">{row.text}</span>}
                          {row.project && (
                            <span className="shrink-0">{approval ? `· ${row.project}` : row.project}</span>
                          )}
                          {approval?.detail && (
                            <span className="min-w-0 truncate font-mono" title={approval.detail}>
                              · {approval.detail}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {approval ? (
                        <>
                          <button
                            type="button"
                            className={rowActionClass}
                            title="拒绝这一问（R）：几秒内可撤销"
                            onClick={(event) => {
                              event.stopPropagation();
                              answerApproval(row, "deny");
                            }}
                          >
                            {approval.denyLabel}
                          </button>
                          <button
                            type="button"
                            className={rowActionClass}
                            title="允许这一次（A）：几秒内可撤销。要选「这次会话都允许」回对话里选"
                            onClick={(event) => {
                              event.stopPropagation();
                              answerApproval(row, "allow");
                            }}
                          >
                            {approval.allowLabel}
                          </button>
                        </>
                      ) : (
                        <>
                          {row.kind === "inbox" && row.dismissible && (
                            <button
                              type="button"
                              className={`${rowActionClass} ${selected ? "" : hoverRevealClass} text-l3`}
                              title="收起这条通知（E）：几秒内可撤销；状态一变它还会回来"
                              onClick={(event) => {
                                event.stopPropagation();
                                dismissRow(row);
                              }}
                            >
                              收起
                            </button>
                          )}
                          <button
                            type="button"
                            className={rowActionClass}
                            onClick={(event) => {
                              event.stopPropagation();
                              openRow(row);
                            }}
                          >
                            {row.kind === "inbox" ? row.item.actionLabel : "去验收"}
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          {queueRows.length > QUEUE_VISIBLE && (
            // 截断必须留出口：展开在页内，不跳到标题栏的收件箱浮层
            <button
              type="button"
              className={`${rowActionClass} mt-1 w-full justify-start px-3.5 text-l3`}
              aria-expanded={inboxExpanded}
              onClick={() => setInboxExpanded((v) => !v)}
            >
              {inboxExpanded ? "收起" : `还有 ${queueRows.length - QUEUE_VISIBLE} 条`}
            </button>
          )}
        </section>
      )}

      <section className="min-w-0">
          <div className="mb-2.5 flex items-center gap-2 px-1">
            <CircleDot size={14} strokeWidth={1.8} className="text-nav-accent" aria-hidden="true" />
            <h2 className="text-micro font-medium text-l2">
              {workbenchNowSectionTitle(runningBadge)}
            </h2>
            {runningBadge > 0 && (
              // 运行计数是数字不是状态：行尾光标已表达「在跑」，计数回落灰底芯片（同技能页计数口径）
              <span className="rounded-full bg-inset px-2 py-0.5 text-micro text-l3">
                {runningBadge} 个运行中
              </span>
            )}
          </div>

          {nowRows.length > 0 ? (
            <div className="divide-y divide-hairline overflow-hidden rounded-lg ccode-well">
            {nowRows.map((item) => {
              const said = lastSaidFor(item.path);
              const lastAt = lastTargetFor(item.path)?.updatedAt ?? null;
              return (
              <div key={item.path}>
              <div className="group flex min-h-10 w-full items-center gap-3 px-4 py-2 hover:bg-hover">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  title={said ? `继续：${item.name}\n上次停在：${said.full}` : `继续：${item.name}`}
                  onClick={() =>
                    void openContinueTarget(continueWorkbenchTarget(item))
                  }
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-l2">
                    {item.name}
                    {item.workMode ? (
                      <span className={`ml-2 align-[1px] ${modeChipClass}`}>
                        {WORK_MODE_LABEL[item.workMode]}
                      </span>
                    ) : null}
                    {item.subtitle ? (
                      <span className="ml-2 text-l3">{item.subtitle}</span>
                    ) : null}
                  </span>
                  {item.runningCount > 1 ? (
                    // 运行计数不上语义色：行尾光标已表达「在跑」，文字保持中性
                    <span className="shrink-0 text-micro text-l3">
                      {item.runningCount} 个运行中
                    </span>
                  ) : item.runs[0]?.taskLabel ? (
                    <span className="max-w-[9rem] shrink-0 truncate text-micro text-l3">
                      {item.runs[0].taskLabel}
                    </span>
                  ) : item.runningCount > 0 ? (
                    <span className="shrink-0 text-micro text-l3">
                      运行中
                    </span>
                  ) : null}
                  {/* 运行状态光标跟在状态字后面、竖着居中（同侧栏口径，没事不画）。不贴在课题名后面：
                      夹在名字和「科研」之间读成破折号（2026-10-24 光标改居中时看出来的） */}
                  {itemCaret(item) && <RunCaret state={itemCaret(item)!} decorative className="-ml-2 text-micro" />}
                  {/* 多久没动：悬停时让位给「继续 →」 */}
                  {lastAt && (
                    <span
                      className="shrink-0 text-micro text-l3 group-hover:hidden group-focus-within:hidden"
                      title={absTime(lastAt)}
                    >
                      {relTime(lastAt)}
                    </span>
                  )}
                  {/* 整行可点即「继续」，悬停时行尾出「继续 →」（单个 › 读作「展开」，2026-10-25 用户） */}
                  <span
                    className="hidden shrink-0 items-center gap-1 text-micro text-l3 group-hover:flex group-focus-within:flex"
                    aria-hidden="true"
                  >
                    继续
                    <ArrowRight size={12} strokeWidth={1.8} />
                  </span>
                </button>
                {showClientJump && (
                  <button
                    type="button"
                    className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1 group-hover:flex group-focus-within:flex"
                    title={clientJumpTitle}
                    aria-label={clientJumpLabel}
                    onClick={() => clientOpen.openProject(item.path)}
                  >
                    <SquareArrowOutUpRight size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
              </div>
              {item.runs.length > 1 && (
                // 同一项目上的多次运行逐条列出（agent-workbench.md §3.1）：点哪条回哪条
                <ul className="space-y-0.5 px-3 pb-2">
                  {item.runs.map((r) => (
                    <li key={r.runId ?? r.tabId}>
                      <button
                        type="button"
                        className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-left text-sm text-l3 hover:bg-hover hover:text-l2"
                        onClick={() => {
                          if (r.runId) openRun(r.runId, r.tabId);
                          else {
                            setFocusTabReq(r.tabId);
                            setPage("terminal");
                          }
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {r.taskLabel}
                          {r.agentId ? (
                            <span className="ml-1.5 text-l3">
                              {agentLabel(r.agentId)}
                            </span>
                          ) : null}
                        </span>
                        {r.attention === "confirm" ? (
                          <span className="shrink-0 text-micro text-warn-text">
                            待确认
                          </span>
                        ) : null}
                        {/* 已经停了的（live === false）不画；还开着的按注意力 */}
                        {r.live !== false && (
                          <RunCaret state={withUnread(caretOfAttention(r.attention), runUnread(r.tabId)) ?? "idle"} className="mr-1" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              </div>
              );
            })}
            </div>
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
          {goalTarget &&
            (goalOpen ? (
              // 想到就记：只记下不开工，落到该项目的目标列表；开工、选 Agent 仍在项目页由人来
              <form
                className="mt-3 flex flex-wrap items-center gap-2"
                onSubmit={(event) => void captureGoal(event)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !goalBusy) setGoalOpen(false);
                }}
              >
                <input
                  className={`${fieldClass} h-8 min-w-[12rem] flex-1 py-0`}
                  value={goalDraft}
                  onChange={(event) => setGoalDraft(event.target.value)}
                  placeholder={
                    goalTarget.goalKind === "office_doc"
                      ? "要完成什么，例如：按公司模板写本周周报"
                      : "要完成什么，例如：根据项目里的文献写一篇综述"
                  }
                  aria-label="记下一个目标"
                  maxLength={500}
                  autoFocus
                />
                {goalTargets.length > 1 ? (
                  <div className="w-40 shrink-0">
                    <MenuSelect
                      value={goalTarget.path}
                      onChange={setGoalProject}
                      options={goalTargets.map((t) => ({ value: t.path, label: t.name }))}
                      aria-label="记到哪个项目"
                    />
                  </div>
                ) : (
                  <span className="max-w-[11rem] shrink-0 truncate text-micro text-l3" title={goalTarget.path}>
                    记到「{goalTarget.name}」
                  </span>
                )}
                <button
                  type="button"
                  className={ghostActionClass}
                  disabled={goalBusy}
                  onClick={() => setGoalOpen(false)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className={secondaryActionClass}
                  disabled={goalBusy || !goalDraft.trim()}
                >
                  {goalBusy ? "记下…" : "记下"}
                </button>
              </form>
            ) : (
              <button
                type="button"
                className={`${ghostActionClass} mt-2 gap-1.5`}
                title="只记下不开工：记进项目的目标列表，之后在项目页选 Agent 再开始"
                onClick={() => setGoalOpen(true)}
              >
                <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
                记下一个目标
              </button>
            ))}
      </section>

        {scheduleRows.length > 0 && (
        <div className="mt-7 min-w-0">
        <section className="min-w-0">
          <SectionHeading icon={AlarmClock} title="定时任务" />
          <div className="space-y-0.5">
            {scheduleRows.map((row) => (
              <button
                key={row.scheduleId}
                type="button"
                className="group flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 text-left transition-colors hover:bg-hover"
                title={
                  row.kind === "failing"
                    ? `${row.remaining != null ? `再失败 ${row.remaining} 次会自动暂停。` : ""}点进去看历史和过程`
                    : "去这个项目的定时任务页"
                }
                onClick={() => openProjectSchedules(row.projectRoot)}
              >
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    row.kind === "running"
                      ? "bg-ok-text"
                      : row.kind === "failing"
                        ? "bg-err-text"
                        : "bg-transparent"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-l2">{row.name}</span>
                <span className="max-w-[8rem] shrink-0 truncate text-micro text-l3">
                  {row.projectName}
                </span>
                <span
                  className={`max-w-[12rem] shrink-0 truncate text-micro ${
                    row.kind === "failing" ? "text-err-text" : "text-l3"
                  }`}
                >
                  {row.detail}
                </span>
              </button>
            ))}
          </div>
        </section>
        </div>
        )}

      {clientOpen.dialog}
    </PageFrame>
  );
}

export default WorkbenchPage;
