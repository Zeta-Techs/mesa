import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AlarmClock,
  CheckCheck,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  Inbox,
  MessageSquare,
  MessagesSquare,
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
  firstOpenStepName,
  goalCaptureTargets,
  heroStatusLine,
  inboxItemProjectRoot,
  lastUserInstruction,
  latestProjectSession,
  namedSessionTitle,
  pickWorkbenchHero,
  pickWorkbenchNow,
  workbenchLoadFailureMessage,
  workbenchNowSectionTitle,
  workbenchNowSubtitle,
  workbenchRecentRows,
  workbenchRecentSessions,
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
  PageHeader,
  fieldClass,
  ghostActionClass,
  hoverRevealClass,
  primaryActionClass,
  rowActionClass,
  secondaryActionClass,
} from "../components/PageFrame";
import { toast } from "../toast";
import { workbenchScheduleRows } from "../schedule-tasks";

const iconClass = "shrink-0 text-l4";
/** 工作方式标签：描边不铺底（铺 bg-strip 在 well 上看不出边界，像一段错位的字） */
const modeChipClass =
  "inline-block shrink-0 rounded-full border border-hairline px-1.5 py-px text-micro leading-tight text-l3";
/** 区块标题行的「查看全部」：文字链级别，不能比区块标题还醒目。
 *  字号不能写在按钮上（全站 button { font: inherit } 会吞掉），由内层 sectionLinkTextClass 承担 */
const sectionLinkClass = `${ghostActionClass} h-6 px-1.5 text-l3 hover:text-l1`;
const sectionLinkTextClass = "text-micro";

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

function WorkbenchPage({
  visible,
  onQuickChat,
}: {
  visible?: boolean;
  onQuickChat: () => void;
}) {
  const setPage = useAppStore((s) => s.setPage);
  const contextLabel = useAppStore((s) => s.contextLabel);
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
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
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
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
    const timer = window.setInterval(load, 60_000);
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
      window.clearInterval(timer);
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
        subtitle = firstOpenStepName(st, mineWs);
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
    const out: { path: string; key: string; agent: string; sessionId: string; filePath: string }[] = [];
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
  function openLastSaid(said: LastSaid) {
    setOpenSessionReq({ agent: said.agent, sessionId: said.sessionId });
    setPage("sessions");
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

  async function continueWork() {
    if (!hero) return;
    await openContinueTarget(continueWorkbenchTarget(hero));
  }

  const stepName = useMemo(() => {
    if (nowItems[0]?.subtitle) return nowItems[0].subtitle;
    if (!hero?.registered) return null;
    const mine = workspaces.filter((w) =>
      samePath(w.repoPath, hero.path, IS_WINDOWS),
    );
    const cfg = Object.entries(researchCfg).find(([path]) =>
      samePath(path, hero.path, IS_WINDOWS),
    )?.[1];
    return firstOpenStepName(cfg?.steps ?? [], mine);
  }, [hero, researchCfg, workspaces, nowItems]);

  const recentSessions = useMemo(() => {
    return workbenchRecentSessions(sessions).map((session) => ({
      agent: session.agent,
      sessionId: session.sessionId,
      title: namedSessionTitle(session) ?? "",
      updatedAt: session.updatedAt,
      // 已添加项目写注册名；随手聊 / 外部目录不写（行尾不放路径）
      projectName: session.projectPath
        ? (projects.find((p) => samePath(p.path, session.projectPath, IS_WINDOWS))?.name ?? null)
        : null,
    }));
  }, [sessions, projects]);

  const hasInbox = inboxItems.length > 0;
  const reviewTasks = userTasks.filter((task) => task.status === "pending_review");
  // 定时任务摘要：在跑 / 上次失败 / 24 小时内要跑的；暂停与待评审已在「待你处理」里，不重复
  const scheduleRows = workbenchScheduleRows(schedules, projects, new Date(), IS_WINDOWS);
  /** 右栏「等你的事」：待你处理 + 待你验收 + 定时任务，有一样就分两栏 */
  const hasSide = hasInbox || reviewTasks.length > 0 || scheduleRows.length > 0;
  function openProjectSchedules(root: string) {
    setSelectProjectReq(root);
    setProjectFocusReq({ projectRoot: root, focus: "schedule", token: Date.now() });
    setPage("workspaces");
  }
  // 信息类（可一键已读）之外的条目要人拍板：按钮常驻，不靠悬停才现
  const bulkKeys = new Set(bulkInboxItems.map((item) => item.key));
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
  const statusText = hero
    ? heroStatusLine({
        runningCount: hero.runningCount,
        agentLabel: agentLabel(hero.agentId),
        attention: hero.attention,
      })
    : "";
  const statusDot =
    hero?.attention === "confirm"
      ? "bg-warn-text"
      : hero && hero.runningCount > 0
        ? "bg-ok-text"
        : "";
  const runningBadge = nowItems.reduce((n, item) => n + item.runningCount, 0)
    || (hero?.runningCount ?? 0);
  function itemDot(item: {
    attention: "confirm" | "working" | "done" | null;
    runningCount: number;
  }): string {
    if (item.attention === "confirm") return "bg-warn-text";
    if (item.runningCount > 0) return "bg-ok-text";
    return "bg-transparent";
  }
  const heroSaid = hero ? lastSaidFor(hero.path) : null;

  return (
    <PageFrame width="fluid" className="pb-12">
      {/* 页头不带副标题：当前步骤已在主卡里说过，同一事实只说一次 */}
      <PageHeader
        title="工作台"
        actions={
          <button type="button" className={secondaryActionClass} onClick={onQuickChat}>
            新对话
          </button>
        }
      />
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

      <div
        className={
          hasSide
            ? "grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.42fr)]"
            : undefined
        }
      >
        <section className="min-w-0">
          <div className="mb-2.5 flex items-center gap-2 px-1">
            <CircleDot size={14} strokeWidth={1.8} className="text-nav-accent" aria-hidden="true" />
            <h2 className="text-micro font-medium text-l2">
              {workbenchNowSectionTitle(runningBadge)}
            </h2>
            {runningBadge > 0 && (
              // 运行计数是数字不是状态：行首绿点已表达「在跑」，计数回落灰底芯片（同技能页计数口径）
              <span className="rounded-full bg-inset px-2 py-0.5 text-micro text-l3">
                {runningBadge} 个运行中
              </span>
            )}
          </div>

          {hero ? (
            <div className="space-y-2">
            <div className="rounded-lg ccode-well p-5 shadow-[0_1px_0_rgb(255_255_255_/_.02)]">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div className="min-w-0">
                  {/* 方式标签与项目名同行、描边：well 上的 bg-strip 几乎看不见，单独一行像错位缩进的字 */}
                  <div className="flex min-w-0 items-center gap-2">
                    <p
                      className="truncate text-xl font-medium tracking-tight text-l1"
                      title={hero.path}
                    >
                      {hero.name}
                    </p>
                    {hero.workMode ? (
                      <span className={modeChipClass}>
                        {WORK_MODE_LABEL[hero.workMode]}
                      </span>
                    ) : null}
                  </div>
                  {stepName && (
                    <p className="mt-1 text-sm text-l3">{stepName}</p>
                  )}
                </div>
                <button
                  type="button"
                  className={primaryActionClass}
                  onClick={() => void continueWork()}
                >
                  继续工作
                </button>
              </div>
              {heroSaid && (
                // 继续之前先知道停在哪：最近一次对话里你说的最后一句，点开看整段对话
                <button
                  type="button"
                  className="mt-3 flex w-full min-w-0 items-baseline gap-2 rounded-md text-left text-l3 hover:text-l1"
                  title={`上次停在：${heroSaid.full}\n点开查看这段对话`}
                  onClick={() => openLastSaid(heroSaid)}
                >
                  <span className="shrink-0 text-micro text-l3">上次停在</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{heroSaid.text}</span>
                  {heroSaid.timestamp && (
                    <span
                      className="shrink-0 text-micro text-l3"
                      title={absTime(heroSaid.timestamp)}
                    >
                      {relTime(heroSaid.timestamp)}
                    </span>
                  )}
                </button>
              )}
              {/* 有 Agent 在跑 / 等确认才报状态；空闲时只剩「在客户端打开」，也没有就整行不出（没事不画点） */}
              {(statusText || showClientJump) && (
              <div className="mt-4 flex items-center gap-2 border-t border-hairline pt-3 text-micro text-l3">
                {statusText ? (
                  <>
                    <span className={`size-1.5 rounded-full ${statusDot}`} />
                    <span className="min-w-0 flex-1 truncate">{statusText}</span>
                  </>
                ) : (
                  <span className="flex-1" />
                )}
                {showClientJump && (
                  <button
                    type="button"
                    className={`${rowActionClass} shrink-0 gap-1`}
                    title={clientJumpTitle}
                    onClick={() => clientOpen.openProject(hero.path)}
                  >
                    {clientJumpLabel}
                    <SquareArrowOutUpRight size={12} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
              </div>
              )}
              {hero.runs.length > 1 && (
                <ul className="mt-2 space-y-0.5">
                  {hero.runs.map((r) => (
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
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${
                            r.attention === "confirm"
                              ? "bg-warn-text"
                              : r.live === false
                                ? "bg-l4"
                                : "bg-ok-text"
                          }`}
                        />
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
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {nowItems.length > 1 && (
            <div className="divide-y divide-hairline overflow-hidden rounded-lg ccode-well">
            {nowItems.slice(1).map((item) => {
              const said = lastSaidFor(item.path);
              return (
              <div
                key={item.path}
                className="group flex min-h-10 w-full items-center gap-3 px-4 py-2 hover:bg-hover"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  title={said ? `继续：${item.name}\n上次停在：${said.full}` : `继续：${item.name}`}
                  onClick={() =>
                    void openContinueTarget(continueWorkbenchTarget(item))
                  }
                >
                  {/* 没事不画点（同侧栏口径）：灰点不表达任何状态，留位保持对齐 */}
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${itemDot(item)}`}
                  />
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
                    // 运行计数不上语义色：行首状态点已表达「在跑」，文字保持中性（设计系统「命中计数用 text-l4，不用绿字」同口径）
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
                  {/* 整行可点即「继续」，不再每行常驻同一个「继续」字 */}
                  <ChevronRight
                    size={14}
                    strokeWidth={1.8}
                    className={`text-l4 ${hoverRevealClass}`}
                    aria-hidden="true"
                  />
                </button>
                {showClientJump && (
                  <button
                    type="button"
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                    title={clientJumpTitle}
                    aria-label={clientJumpLabel}
                    onClick={() => clientOpen.openProject(item.path)}
                  >
                    <SquareArrowOutUpRight size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
              </div>
              );
            })}
            </div>
            )}
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

        {hasSide && (
        <div className="min-w-0 space-y-8">
        {hasInbox && (
        <section className="min-w-0">
          <SectionHeading
            icon={Inbox}
            title="待你处理"
            action={
              <span className="flex items-center gap-2">
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
                <span className="rounded-full bg-warn px-2 py-0.5 text-micro text-warn-text">
                  {inboxItems.length}
                </span>
              </span>
            }
          />
          <div className="space-y-0.5">
            {(inboxExpanded ? inboxItems : inboxItems.slice(0, 5)).map((item) => {
              const projectName = inboxProjectName(item);
              return (
              <div
                key={item.key}
                className="group flex min-h-10 items-center gap-2 rounded-md px-2.5 transition-colors hover:bg-hover"
              >
                <span className={`size-1.5 shrink-0 rounded-full ${item.dot}`} />
                <span className="min-w-0 flex-1 truncate text-sm text-l2" title={item.text}>
                  {item.text}
                </span>
                {projectName && (
                  <span className="max-w-[8rem] shrink-0 truncate text-micro text-l3">
                    {projectName}
                  </span>
                )}
                <button
                  type="button"
                  className={
                    bulkKeys.has(item.key)
                      ? `${rowActionClass} ${hoverRevealClass}`
                      : rowActionClass
                  }
                  onClick={() => runInboxAction(item)}
                >
                  {item.actionLabel}
                </button>
              </div>
              );
            })}
            {inboxItems.length > 5 && (
              // 截断必须留出口：早先只挂个「6」的数字徽标，用户看不到第 6 条是什么、
              // 也不知道去哪找。展开控制在页内，不跳到标题栏的收件箱浮层。
              <button
                type="button"
                className={`${rowActionClass} mt-0.5 w-full justify-start px-2.5 text-l3`}
                aria-expanded={inboxExpanded}
                onClick={() => setInboxExpanded((v) => !v)}
              >
                {inboxExpanded
                  ? "收起"
                  : `还有 ${inboxItems.length - 5} 条`}
              </button>
            )}
          </div>
        </section>
        )}

        {reviewTasks.length > 0 && (
        <section className="min-w-0">
          <SectionHeading
            icon={ClipboardCheck}
            title="待你验收"
            action={
              // 计数中性：紧迫感由「待你处理」的黄芯片承担，这里不再并排第二个黄块
              <span className="rounded-full bg-inset px-2 py-0.5 text-micro text-l3">
                {reviewTasks.length}
              </span>
            }
          />
          <div className="space-y-2">
            {reviewTasks.map((task) => {
              const project = task.projectRoot
                ? projects.find((item) =>
                    samePath(item.path, task.projectRoot!, IS_WINDOWS),
                  )
                : undefined;
              return (
                <button
                  key={task.id}
                  type="button"
                  className="flex w-full min-w-0 items-center gap-3 rounded-lg ccode-well px-3 py-2.5 text-left hover:bg-hover"
                  onClick={() => {
                    if (task.projectRoot) {
                      setSelectProjectReq(task.projectRoot);
                      setTaskReviewReq({
                        projectRoot: task.projectRoot,
                        taskId: task.id,
                      });
                    }
                    setPage("workspaces");
                  }}
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-warn-text" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-l1">
                      {workbenchNowSubtitle({
                        tasks: [task],
                        fallback: task.name,
                      }).subtitle ?? task.name}
                    </span>
                    {project?.name ? (
                      <span className="mt-0.5 block truncate text-micro text-l3">
                        {project.name}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight size={14} className="shrink-0 text-l4" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>
        )}

        {scheduleRows.length > 0 && (
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
        )}
        </div>
        )}
      </div>

      {/* 「最近项目」栏已删（2026-10-22 审查）：侧栏项目树与上面的「最近在做」已经列了项目，一屏三处重复；
          它带来的「哪些项目最近在动」改由对话行尾的项目名承担 */}
      <div className="mt-10">
        <section className="min-w-0">
          <SectionHeading
            icon={MessagesSquare}
            title="最近对话"
            action={
              <button type="button" className={sectionLinkClass} onClick={() => setPage("sessions")}>
                <span className={sectionLinkTextClass}>查看全部</span>
              </button>
            }
          />
          {recentSessions.length === 0 ? (
            <p className="py-5 text-sm text-l3">最近对话会显示在这里。</p>
          ) : (
            <div className="space-y-0.5">
              {recentSessions.map((session) => (
                <button
                  key={`${session.agent}:${session.sessionId}`}
                  type="button"
                  className="group flex min-h-9 w-full items-center gap-3 rounded-md px-2.5 text-left transition-colors hover:bg-hover"
                  onClick={() => {
                    setOpenSessionReq({
                      agent: session.agent,
                      sessionId: session.sessionId,
                    });
                    setPage("sessions");
                  }}
                >
                  <MessageSquare size={15} strokeWidth={1.8} className={iconClass} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm text-l2">{session.title}</span>
                  {session.projectName && (
                    <span className="max-w-[12rem] shrink-0 truncate text-micro text-l3">
                      {session.projectName}
                    </span>
                  )}
                  <span
                    className="shrink-0 text-micro text-l3"
                    title={absTime(session.updatedAt)}
                  >
                    {relTime(session.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {clientOpen.dialog}
    </PageFrame>
  );
}

export default WorkbenchPage;
