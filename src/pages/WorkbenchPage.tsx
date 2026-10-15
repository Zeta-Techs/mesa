import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ChevronRight,
  CircleDot,
  FolderOpen,
  MessageSquare,
  MessagesSquare,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useAppStore, runInboxAction, visibleInboxItems } from "../store";
import { pathWithin, samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import {
  canOpenCodexClient,
  codexNewThreadDeeplink,
} from "../codex-client";
import { absTime, relTime } from "../rel-time";
import { alertDialog } from "../components/ConfirmDialog";
import { AGENTS } from "../types";
import type {
  CodingOverviewDto,
  ProjectConfigReadDto,
  ProjectDto,
  ProjectStepDto,
  RepoDto,
  RunDto,
  TaskDto,
  WorkspaceDto,
} from "../types";
import { pickRecoverableRun, isWorkbenchActiveRun } from "../run-model";
import { visibleDeclaredTasks } from "../project-tasks";
import {
  continueWorkbenchTarget,
  firstOpenStepName,
  heroStatusLine,
  namedSessionTitle,
  pickWorkbenchHero,
  pickWorkbenchNow,
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
  PageFrame,
  PageHeader,
  ghostActionClass,
  hoverRevealClass,
  primaryActionClass,
  rowActionClass,
  secondaryActionClass,
} from "../components/PageFrame";
import { toast } from "../toast";

const iconClass = "shrink-0 text-l4";

/** 不参与工作台「需要你」判定的自动登记任务类（见 nowSeeds 里的过滤注释） */
const WORKBENCH_AUTO_TASK_KINDS = new Set(["pipeline_step", "coding_lane", "watch"]);

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
      <h2 className="text-xs font-medium text-l2">{title}</h2>
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
  const inboxItems = visibleInboxItems(
    rawInboxItems,
    appUpdate
      ? { version: appUpdate.version, currentVersion: appUpdate.currentVersion }
      : null,
    inboxDismissed,
  );
  const sessions = useAppStore((s) => s.sessions);
  const recentRepos = useAppStore((s) => s.recentRepos);
  const loadRecentRepos = useAppStore((s) => s.loadRecentRepos);
  const setEnterCwdReq = useAppStore((s) => s.setEnterCwdReq);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const setTaskReviewReq = useAppStore((s) => s.setTaskReviewReq);
  const setFocusTabReq = useAppStore((s) => s.setFocusTabReq);

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
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [steps, setSteps] = useState<ProjectStepDto[]>([]);
  const [codingByPath, setCodingByPath] = useState<
    Record<string, CodingOverviewDto>
  >({});
  const [researchSteps, setResearchSteps] = useState<
    Record<string, ProjectStepDto[]>
  >({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [allRuns, setAllRuns] = useState<RunDto[]>([]);
  const [taskProjectById, setTaskProjectById] = useState<Record<string, string>>(
    {},
  );
  const [userTasks, setUserTasks] = useState<TaskDto[]>([]);
  /** 「待你处理」默认只列 5 条，展开后全列出（页内展开，不跳收件箱浮层） */
  const [inboxExpanded, setInboxExpanded] = useState(false);

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

  useEffect(() => {
    if (!visible) return;
    setLoadError(null);
    invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        setProjects(list);
        const coding = list.filter(
          (p) => normalizeWorkMode(p.workMode) === "coding",
        );
        const research = list.filter(
          (p) => normalizeWorkMode(p.workMode) === "research",
        );
        void Promise.all(
          coding.map((p) =>
            invoke<CodingOverviewDto>("coding_overview", { repoPath: p.path })
              .then((ov) => [p.path, ov] as const)
              .catch(() => {
                toast(`项目「${p.name}」的编程状态未检测到`, "warning");
                return null;
              }),
          ),
        ).then((rows) => {
          const next: Record<string, CodingOverviewDto> = {};
          for (const row of rows) {
            if (row) next[row[0]] = row[1];
          }
          setCodingByPath(next);
        });
        void Promise.all(
          research.map((p) =>
            invoke<ProjectConfigReadDto>("read_project_config", { path: p.path })
              .then((read) => [p.path, read.config.steps ?? []] as const)
              .catch(() => {
                toast(`项目「${p.name}」的流程配置未检测到`, "warning");
                return null;
              }),
          ),
        ).then((rows) => {
          const next: Record<string, ProjectStepDto[]> = {};
          for (const row of rows) {
            if (row) next[row[0]] = row[1];
          }
          setResearchSteps(next);
        });
      })
      .catch(() => {
        setProjects([]);
        setLoadError("项目数据加载失败，可重试；其他工作台内容仍可继续使用。");
      });
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
        // 流程只读本项目自己的；读取失败就是无步骤，不跨项目回落到主卡 steps
        const st = researchSteps[p.path] ?? [];
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
    researchSteps,
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
    if (!visible || !hero?.registered) {
      setSteps([]);
      return;
    }
    let cancelled = false;
    invoke<ProjectConfigReadDto>("read_project_config", { path: hero.path })
      .then((read) => {
        if (!cancelled) setSteps(read.config.steps ?? []);
      })
      .catch(() => {
        if (!cancelled) setSteps([]);
        if (!cancelled) toast("当前项目流程读取失败，可重试", "warning");
      });
    return () => {
      cancelled = true;
    };
  }, [visible, hero?.registered, hero?.path]);

  useEffect(() => {
    if (!visible || projects.length === 0) {
      setUserTasks([]);
      setTaskProjectById({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      projects.map((project) =>
        invoke<TaskDto[]>("task_list", { projectRoot: project.path }).catch(
          () => [] as TaskDto[],
        ),
      ),
    ).then((lists) => {
      if (cancelled) return;
      const all = lists.flat();
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
  }, [projects, visible]);

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

  async function openInCodex(absPath: string) {
    try {
      await openUrl(codexNewThreadDeeplink(absPath));
    } catch (e) {
      await alertDialog(`唤起 Codex 客户端失败：${e}`);
    }
  }

  const showCodexJump = canOpenCodexClient();

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
    return firstOpenStepName(steps, mine);
  }, [hero, steps, workspaces, nowItems]);

  const recentSessions = useMemo(() => {
    return workbenchRecentSessions(sessions).map((session) => ({
      agent: session.agent,
      sessionId: session.sessionId,
      title: namedSessionTitle(session) ?? "",
      updatedAt: session.updatedAt,
    }));
  }, [sessions]);

  const hasInbox = inboxItems.length > 0;
  const reviewTasks = userTasks.filter((task) => task.status === "pending_review");
  const statusText = hero
    ? heroStatusLine({
        runningCount: hero.runningCount,
        agentLabel: agentLabel(hero.agentId),
        attention: hero.attention,
        registered: hero.registered,
      })
    : "";
  const statusDot =
    hero?.attention === "confirm"
      ? "bg-warn-text"
      : hero && hero.runningCount > 0
        ? "bg-ok-text"
        : "bg-l4";
  const runningBadge = nowItems.reduce((n, item) => n + item.runningCount, 0)
    || (hero?.runningCount ?? 0);
  function itemDot(item: {
    attention: "confirm" | "working" | "done" | null;
    runningCount: number;
  }): string {
    if (item.attention === "confirm") return "bg-warn-text";
    if (item.runningCount > 0) return "bg-ok-text";
    return "bg-l4";
  }

  return (
    <PageFrame width="fluid" className="pb-12">
      <PageHeader
        title="工作台"
        meta={stepName ?? "从当前工作开始"}
        actions={
          <button type="button" className={secondaryActionClass} onClick={onQuickChat}>
            快速开聊
          </button>
        }
      />
      {loadError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn-text">
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
          hasInbox
            ? "grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.42fr)]"
            : undefined
        }
      >
        <section className="min-w-0">
          <div className="mb-2.5 flex items-center gap-2 px-1">
            <CircleDot size={14} strokeWidth={1.8} className="text-nav-accent" aria-hidden="true" />
            <h2 className="text-xs font-medium text-l2">
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
                  <p
                    className="truncate text-xl font-medium tracking-tight text-l1"
                    title={hero.path}
                  >
                    {hero.name}
                  </p>
                  {hero.workMode ? (
                    <span className="mt-1 inline-block rounded-full bg-strip px-2 py-0.5 text-micro text-l3">
                      {WORK_MODE_LABEL[hero.workMode]}
                    </span>
                  ) : null}
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
              <div className="mt-4 flex items-center gap-2 border-t border-hairline pt-3 text-xs text-l4">
                <span className={`size-1.5 rounded-full ${statusDot}`} />
                <span className="min-w-0 flex-1 truncate">{statusText}</span>
                {showCodexJump && (
                  <button
                    type="button"
                    className={`${ghostActionClass} h-auto shrink-0 px-1.5 py-0.5 text-micro text-l4 hover:text-l2`}
                    title="在 Codex 客户端打开这个目录"
                    onClick={() => void openInCodex(hero.path)}
                  >
                    在 Codex 打开
                  </button>
                )}
              </div>
              {hero.runs.length > 1 && (
                <ul className="mt-2 space-y-0.5">
                  {hero.runs.map((r) => (
                    <li key={r.runId ?? r.tabId}>
                      <button
                        type="button"
                        className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-left text-xs text-l3 hover:bg-hover hover:text-l2"
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
                            <span className="ml-1.5 text-l4">
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
            {nowItems.slice(1).map((item) => (
              <div
                key={item.path}
                className="group flex min-h-10 w-full items-center gap-3 rounded-lg ccode-well px-4 py-2.5 hover:bg-hover"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() =>
                    void openContinueTarget(continueWorkbenchTarget(item))
                  }
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${itemDot(item)}`}
                  />
                  <span className="shrink-0 rounded-full bg-strip px-2 py-0.5 text-micro text-l3">
                    {item.workMode ? WORK_MODE_LABEL[item.workMode] : "项目"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-l2">
                    {item.name}
                    {item.subtitle ? (
                      <span className="ml-2 text-l4">{item.subtitle}</span>
                    ) : null}
                  </span>
                  {item.runningCount > 1 ? (
                    // 运行计数不上语义色：行首状态点已表达「在跑」，文字保持中性（设计系统「命中计数用 text-l4，不用绿字」同口径）
                    <span className="shrink-0 text-micro text-l3">
                      {item.runningCount} 个运行中
                    </span>
                  ) : item.runs[0]?.taskLabel ? (
                    <span className="max-w-[9rem] shrink-0 truncate text-micro text-l4">
                      {item.runs[0].taskLabel}
                    </span>
                  ) : item.runningCount > 0 ? (
                    <span className="shrink-0 text-micro text-l3">
                      运行中
                    </span>
                  ) : null}
                  <span className="shrink-0 text-micro text-l4">继续</span>
                </button>
                {showCodexJump && (
                  <button
                    type="button"
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                    title="在 Codex 客户端打开这个目录"
                    aria-label="在 Codex 客户端打开"
                    onClick={() => void openInCodex(item.path)}
                  >
                    <SquareArrowOutUpRight size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
            </div>
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

        {hasInbox && (
        <section className="min-w-0">
          <SectionHeading
            icon={CircleDot}
            title="待你处理"
            action={
              <span className="rounded-full bg-warn px-2 py-0.5 text-micro text-warn-text">
                {inboxItems.length}
              </span>
            }
          />
          <div className="space-y-0.5">
            {(inboxExpanded ? inboxItems : inboxItems.slice(0, 5)).map((item) => (
              <div
                key={item.key}
                className="group flex min-h-10 items-center gap-2 rounded-md px-2.5 transition-colors hover:bg-hover"
              >
                <span className={`size-1.5 shrink-0 rounded-full ${item.dot}`} />
                <span className="min-w-0 flex-1 truncate text-xs text-l2">
                  {item.text}
                </span>
                <button
                  type="button"
                  className={`${rowActionClass} ${hoverRevealClass}`}
                  onClick={() => runInboxAction(item)}
                >
                  {item.actionLabel}
                </button>
              </div>
            ))}
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
      </div>

      {reviewTasks.length > 0 && (
        <section className="mt-8">
          <SectionHeading
            icon={CircleDot}
            title="待你验收"
            action={
              <span className="rounded-full bg-warn px-2 py-0.5 text-micro text-warn-text">
                {reviewTasks.length}
              </span>
            }
          />
          <div className="grid gap-2 md:grid-cols-2">
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
                  className="flex min-w-0 items-center gap-3 rounded-lg ccode-well px-3 py-2.5 text-left hover:bg-hover"
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
                      <span className="mt-0.5 block truncate text-micro text-l4">
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

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <section className="min-w-0">
          <SectionHeading
            icon={FolderOpen}
            title="最近项目"
            action={
              <button type="button" className={rowActionClass} onClick={() => setPage("workspaces")}>
                查看全部
              </button>
            }
          />
          {recentRows.length === 0 ? (
            <p className="py-5 text-sm text-l3">最近打开的项目会显示在这里。</p>
          ) : (
            <div className="space-y-0.5">
              {recentRows.map((row) => (
                <div
                  key={row.path}
                  className="group flex min-h-9 w-full items-center gap-3 rounded-md px-2.5 transition-colors hover:bg-hover"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    title={
                      row.registered
                        ? row.path
                        : "还没添加到 Mesa，点开会进运行页"
                    }
                    onClick={() =>
                      void enterRepo({
                        path: row.path,
                        name: row.name,
                        lastActive: row.lastActive,
                      })
                    }
                  >
                    <FolderOpen size={15} strokeWidth={1.8} className={iconClass} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm text-l2">
                      {row.name}
                    </span>
                  </button>
                  {!row.registered && (
                    <span className="shrink-0 text-micro text-l4">未添加</span>
                  )}
                  <span
                    className="shrink-0 text-micro text-l4"
                    title={absTime(row.lastActive)}
                  >
                    {relTime(row.lastActive)}
                  </span>
                  {showCodexJump && (
                    <button
                      type="button"
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                      title="在 Codex 客户端打开这个目录"
                      aria-label="在 Codex 客户端打开"
                      onClick={() => void openInCodex(row.path)}
                    >
                      <SquareArrowOutUpRight size={14} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  )}
                  <ChevronRight
                    size={14}
                    strokeWidth={1.8}
                    className={`text-l4 ${hoverRevealClass}`}
                    aria-hidden="true"
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="min-w-0">
          <SectionHeading
            icon={MessagesSquare}
            title="最近对话"
            action={
              <button type="button" className={rowActionClass} onClick={() => setPage("sessions")}>
                查看全部
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
                  <span
                    className="shrink-0 text-micro text-l4"
                    title={absTime(session.updatedAt)}
                  >
                    {relTime(session.updatedAt)}
                  </span>
                  <ChevronRight
                    size={14}
                    strokeWidth={1.8}
                    className={`text-l4 ${hoverRevealClass}`}
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

    </PageFrame>
  );
}

export default WorkbenchPage;
