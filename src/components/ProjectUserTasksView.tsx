import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Archive, Play, Plus, RotateCw, Square } from "lucide-react";
import { runInboxAction, selectHiddenProfiles, useAppStore } from "../store";
import {
  AGENTS,
  type ProjectDto,
  type ProjectStepDto,
  type RunDto,
  type RunEventDto,
  type TaskDto,
  type TaskContextDto,
  type TaskOutputChangeDto,
  type TaskReviewDto,
} from "../types";
import {
  Checkbox,
  EmptyState,
  FoldMark,
  ghostActionClass,
  iconActionClass,
  primaryActionClass,
  projectWellClass,
  rowActionClass,
  secondaryActionClass,
  SegTabs,
  InlineNotice,
} from "./PageFrame";
import { Modal } from "./Modal";
import { agentBrand } from "../agent-colors";
import { goalBoundLaunch, goalDefaultProfile, resolveTaskModel } from "../project-agents";
import { toast } from "../toast";

import { confirmDialog } from "./ConfirmDialog";
import ResearchReproductionPanel from "./ResearchReproductionPanel";
import ResearchAcceptancePanel from "./ResearchAcceptancePanel";
import ProjectSettingsDrawer from "./ProjectSettingsDrawer";
import {
  acceptedGoalOutputs,
  canSaveDeclaredGoal,
  canSubmitDeclaredTask,
  declaredTaskKindsForMode,
  GOAL_BUCKET_LABEL,
  GOAL_BUCKET_ORDER,
  goalTimeline,
  groupGoalsByBucket,
  goalDisplayName,
  goalFullText,
  goalShortTitle,
  isTaskMaterialNoise,
  joinRunPath,
  parseReviewNote,
  pathCoveredBySelection,
  pathIsProtected,
  relativeProjectPath,
  scopeFromInputPaths,
  selectedChangePaths,
  taskChangeKindLabel,
  taskPathsForScope,
  taskInputLabel,
  taskStatusLabel,
  toggleTaskMaterialPath,
  visibleDeclaredTasks,
  archivedDeclaredTasks,
  type TaskMaterialScope,
  type TaskPermission,
} from "../project-tasks";
import type { DirEntryDto } from "./FileTree";
import FileTypeMark from "./FileTypeMark";
import OfficePreviewModal from "./OfficePreviewModal";
import GoalStorageModal from "./GoalStorageModal";
import { goalRunTerminalFields, prepareGoalRun } from "../goal-run";

import {
  goalReviewCopy,
  goalReviewFacts,
  companionPdfPath,
  resultReadinessLabel,
  groupReviewChanges,
} from "../goal-review";
import {
  goalCardMeta,
  goalsNeedAttention,
} from "../project-status";
import { absTime, relTime } from "../rel-time";
import { usePolling } from "../polling";

function agentLabel(id: string): string {
  return AGENTS.find((agent) => agent.id === id)?.label ?? id;
}

function timelineRow(item: { kind: string; text: string }): { label: string; body: string } {
  if (item.kind === "feedback") {
    return { label: "意见", body: item.text.replace(/^意见：/, "") };
  }
  return { label: item.text, body: "" };
}

function continueRun(run: RunDto) {
  runInboxAction({
    key: `run:${run.id}`,
    dot: "bg-ok-text",
    text: "运行",
    actionLabel: "打开",
    action: { type: "run", runId: run.id },
  });
}

/** 目标详情里的「设置」：资料、权限、点名技能、谁来做——卡面不展开这些，记下后也要能核对。 */
function goalSettingLines(
  task: TaskDto,
  project: ProjectDto,
  profiles: { id: string; agent: string; name: string }[],
): string[] {
  const writeLabel = goalReviewCopy(project.workMode).writeTab;
  const lines = [
    `资料：${taskInputLabel(task.inputPaths)}`,
    `权限：${task.reviewRequired ? writeLabel : "只讨论"}`,
    `技能：${task.skills?.length ? task.skills.join("、") : "不点名"}`,
  ];
  if (task.profileId) {
    const profile = profiles.find((item) => item.id === task.profileId);
    lines.push(
      `Agent：${[agentLabel(task.agent ?? profile?.agent ?? ""), profile?.name ?? "连接已删除", task.model].filter(Boolean).join(" / ")}`,
    );
  } else {
    lines.push("Agent：跟随项目默认（开始时按 Agents 页的项目默认）");
  }
  return lines;
}

export default function ProjectUserTasksView({
  project,
  embed = false,
  chromeReq,
  onChromeConsumed,
  onUrgentGoals,
}: {
  project: ProjectDto;
  /** 嵌进无流程科研左栏：不重复项目名、不另开对话栏。 */
  embed?: boolean;
  chromeReq?: { action: string; token: number } | null;
  onChromeConsumed?: () => void;
  onUrgentGoals?: (urgent: boolean) => void;
}) {
  const profiles = useAppStore((state) => state.profiles);
  const hiddenProfiles = useAppStore(selectHiddenProfiles);
  const setPage = useAppStore((state) => state.setPage);
  const setPendingTerminal = useAppStore((state) => state.setPendingTerminal);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<TaskDto[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [detailsTaskId, setDetailsTaskId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const chromeConsumed = useRef<number | null>(null);
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [events, setEvents] = useState<RunEventDto[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTask, setEditTask] = useState<TaskDto | null>(null);
  const [reviewTask, setReviewTask] = useState<TaskDto | null>(null);
  const [storageTaskId, setStorageTaskId] = useState<string | null>(null);
  const taskReviewReq = useAppStore((state) => state.taskReviewReq);
  const setTaskReviewReq = useAppStore((state) => state.setTaskReviewReq);
  // 两类提示分开：读取失败随下一次成功读取消失；操作失败（启动/归档/恢复）留到下一次操作，
  // 否则 2.5s 轮询会把「启动目标失败」这类提示刚显示就抹掉
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [purgingId, setPurgingId] = useState<string | null>(null);
  const [configReady, setConfigReady] = useState(
    embed || project.workMode !== "research",
  );
  const [freeResearch, setFreeResearch] = useState(embed);

  const eligible =
    project.workMode === "office" ||
    embed ||
    (project.workMode === "research" && freeResearch);

  const load = useCallback(async () => {
    if (!eligible) return;
    try {
      const kinds = declaredTaskKindsForMode(project.workMode);
      const [nextTasks, nextRuns, nextEvents] = await Promise.all([
        invoke<TaskDto[]>("task_list", {
          projectRoot: project.path,
          includeArchived: true,
        }),
        invoke<RunDto[]>("run_list", { projectRoot: project.path }),
        invoke<RunEventDto[]>("task_goal_events", { projectRoot: project.path }),
      ]);
      setTasks(visibleDeclaredTasks(nextTasks, kinds));
      setArchivedTasks(archivedDeclaredTasks(nextTasks, kinds));
      setRuns(nextRuns);
      setEvents(nextEvents);
      setLoadError(null);
    } catch (reason) {
      setLoadError(`目标读取失败：${String(reason)}`);
    } finally {
      setLoaded(true);
    }
  }, [eligible, project.path, project.workMode]);

  useEffect(() => {
    if (embed || !chromeReq) return;
    if (chromeConsumed.current === chromeReq.token) return;
    if (chromeReq.action !== "settings") return;
    chromeConsumed.current = chromeReq.token;
    setSettingsOpen(true);
    onChromeConsumed?.();
  }, [chromeReq, embed, onChromeConsumed]);

  useEffect(() => {
    if (project.workMode !== "research") {
      setConfigReady(true);
      setFreeResearch(false);
      return;
    }
    let stale = false;
    invoke<{ config: { steps: unknown[]; pipelineOptOut?: boolean } }>(
      "read_project_config",
      { path: project.path },
    )
      .then((read) => {
        if (stale) return;
        setFreeResearch(
          read.config.steps.length === 0 && read.config.pipelineOptOut === true,
        );
        setConfigReady(true);
      })
      .catch(() => {
        if (!stale) setConfigReady(true);
      });
    return () => {
      stale = true;
    };
  }, [project.path, project.workMode]);

  useEffect(() => {
    setLoaded(false);
    setArchiveOpen(false);
    setDetailsTaskId(null);
    void load();
  }, [eligible, load]);
  usePolling(() => load(), eligible ? 2500 : null);

  // 待验收提升是后端事件（goal-review-ready）：立即刷新，不等 2.5s 轮询
  useEffect(() => {
    if (!eligible) return;
    let unlisten: (() => void) | undefined;
    listen<{ projectRoot: string }>("goal-review-ready", (e) => {
      if (e.payload.projectRoot === project.path) void load();
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, [eligible, load, project.path]);

  useEffect(() => {
    if (!taskReviewReq || !eligible) return;
    if (taskReviewReq.projectRoot !== project.path) return;
    const match = tasks.find((task) => task.id === taskReviewReq.taskId);
    if (match) {
      setReviewTask(match);
      setTaskReviewReq(null);
    }
  }, [eligible, project.path, setTaskReviewReq, taskReviewReq, tasks]);

  const latestRunByTask = useMemo(() => {
    const map = new Map<string, RunDto>();
    for (const run of runs) {
      if (!map.has(run.taskId)) map.set(run.taskId, run);
    }
    return map;
  }, [runs]);
  const buckets = useMemo(() => groupGoalsByBucket(tasks), [tasks]);
  const reviewCopy = goalReviewCopy(project.workMode);
  const visibleBuckets = GOAL_BUCKET_ORDER.filter((bucket) => buckets[bucket].length > 0);
  const primaryTaskId = GOAL_BUCKET_ORDER.flatMap((bucket) => buckets[bucket]).find(
    (task) => ["pending", "failed", "stopped"].includes(task.status) ||
      (["pending_review", "running"].includes(task.status) && latestRunByTask.has(task.id)),
  )?.id;
  const urgentGoals = useMemo(() => goalsNeedAttention(tasks), [tasks]);

  useEffect(() => {
    onUrgentGoals?.(urgentGoals);
  }, [onUrgentGoals, urgentGoals]);

  const visibleProfiles = useMemo(
    () =>
      profiles.filter(
        (profile) =>
          !hiddenProfiles.includes(profile.id) ||
          profile.id === project.defaultProfiles?.[profile.agent],
      ),
    [hiddenProfiles, profiles, project.defaultProfiles],
  );

  if (!configReady || !eligible) {
    return null;
  }

  async function startTask(
    task: TaskDto,
    opts?: { reuseIsolation?: boolean; feedback?: string },
  ) {
    setError(null);
    const preferredAgent = task.agent ?? project.defaultAgent;
    // W1（拍板①A）：显式绑定在全量 profiles 里解析——停用照用（显式绑定尊重停用
    // 项，与 Agents 页换绑侧同向）；连接真被删才 fail-loud 引导重绑，不再静默滑到
    // 「同家第一条 → claude-code → 任意」——那会把长跑目标悄悄换供应商换模型。
    const bound = goalBoundLaunch({
      profiles,
      hiddenProfiles,
      profileId: task.profileId,
      model: task.model,
    });
    if (bound?.kind === "missing") {
      setError(
        "这条目标绑定的连接已删除，启动已停：去 Agents 页这条目标的行内重绑，或清掉绑定跟随项目默认。",
      );
      return;
    }
    let launchModel: string | undefined;
    if (bound?.kind === "bound") {
      for (const note of bound.notes) toast(note, "info");
      launchModel = bound.model;
    }
    const profile = bound?.kind === "bound"
      ? profiles.find((item) => item.id === bound.profileId)
      : goalDefaultProfile(visibleProfiles, preferredAgent, project.defaultProfiles);
    if (!profile) {
      setError("还没有可用连接，先到连接页配一个。");
      setPage("profiles");
      return;
    }
    setStartingId(task.id);
    try {
      // 重试（失败/已停止）且有上一版：复用上次的隔离副本，并尽量恢复上次会话——
      // 「重试」的产品语义是接着干，不是从零复制一份重跑
      if (task.storageCleanupPending) throw new Error("请先继续未完成的副本清理");
      if (task.workspaceCleared && !await confirmDialog("旧工作副本已清理。将从当前项目复制资料重新开始，不恢复旧会话；已写入成果和接受记录保留。继续？", { focusCancel: true, confirmText: "重新开始" })) return;
      const previousRun = task.workspaceCleared ? undefined : latestRunByTask.get(task.id);
      const retrying =
        (task.status === "failed" || task.status === "stopped") && previousRun
          ? previousRun
          : null;
      const { run, prompt } = await prepareGoalRun({
        projectName: project.name,
        projectPath: project.path,
        workMode: project.workMode,
        task,
        agent: profile.agent,
        profileId: profile.id,
        reuseIsolation: task.workspaceCleared ? false : opts?.reuseIsolation ?? Boolean(retrying),
        feedback: opts?.feedback,
      });
      setPendingTerminal({
        extraEnv: {},
        title: task.name,
        agentId: profile.agent,
        profileId: profile.id,
        model: launchModel ??
          resolveTaskModel({
            models: profile.models,
            taskModel: task.model,
            profileId: profile.id,
            defaultProfileId: project.defaultProfiles?.[profile.agent],
            defaultModel: project.defaultModels?.[profile.agent],
          }),
        resume:
          retrying?.sessionId && retrying.agent === profile.agent
            ? { agentId: retrying.agent, sessionId: retrying.sessionId }
            : undefined,
        ...goalRunTerminalFields(task, run, prompt),
      });
      setPage("terminal");
    } catch (reason) {
      setError(`启动目标失败：${String(reason)}`);
    } finally {
      setStartingId(null);
      void load();
    }
  }

  /** 进行中的目标就地停下（2026-10-26，原先只能去终端关标签）：交互运行杀这条 Run 的终端进程，无头运行发取消；
   *  后端按「用户主动停止」收尾，有可审成果的照旧进待验收，没有的变「已停止」可重试接着做 */
  async function stopGoal(task: TaskDto, run: RunDto) {
    const ok = await confirmDialog(
      `停止目标「${goalDisplayName(task)}」正在跑的 Agent？\n\n正在做的这一步会被打断。已经写下的文件留在工作副本里：之后点「重试」接着做，有成果的也可以先去验收。`,
      { danger: true, confirmText: "停止" },
    );
    if (!ok) return;
    setStoppingId(task.id);
    try {
      if (run.runtime === "headless") {
        await invoke("run_cancel", { id: run.id });
      } else {
        const ptyId = await invoke<string | null>("pty_id_for_run", { runId: run.id });
        if (!ptyId) {
          // 进程不在这个 Mesa 里（另一个 Mesa 开着、或正在启动）：不替它收尾，免得把别处还在跑的标成已停止
          setError("这个目标的 Agent 不在当前窗口里运行。点「继续」打开它，再在对话里停止。");
          return;
        }
        await invoke("pty_kill", { ptyId });
      }
      setError(null);
      await load();
    } catch (reason) {
      setError(`停止目标失败：${String(reason)}`);
    } finally {
      setStoppingId(null);
    }
  }

  async function deleteGoal(task: TaskDto) {
    const name = goalDisplayName(task);
    const reviewNote = task.status === "pending_review"
      ? "这份目标还在待验收。归档后主列表不再提醒验收，可从已归档恢复再验收。\n\n"
      : "";
    const ok = await confirmDialog(
      `归档目标「${name}」？它会从列表收起；产出文件、会话和验收记录全部保留，之后可在下方「已归档」里恢复。\n\n${reviewNote}归档不等于清理。内部副本不会因归档而删除，仍占磁盘；要腾空间请另点「释放副本空间」。`,
      {
        danger: true,
        confirmText: "归档",
      },
    );
    if (!ok) return;
    setDeletingId(task.id);
    try {
      await invoke("task_delete", { id: task.id });
      if (reviewTask?.id === task.id) setReviewTask(null);
      setError(null);
      await load();
    } catch (reason) {
      setError(`归档目标失败：${String(reason)}`);
    } finally {
      setDeletingId(null);
    }
  }

  async function purgeGoal(task: TaskDto) {
    const name = goalDisplayName(task);
    const ok = await confirmDialog(
      `删除归档目标「${name}」？它会从已归档里消失，不能恢复。项目里已经接受的文件还在。如果还有内部副本，请先释放副本空间。`,
      { danger: true, confirmText: "删除" },
    );
    if (!ok) return;
    setPurgingId(task.id);
    try {
      await invoke("task_purge_archived", { id: task.id });
      setError(null);
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPurgingId(null);
    }
  }

  async function restoreGoal(task: TaskDto) {
    setRestoringId(task.id);
    try {
      await invoke("task_unarchive", { id: task.id });
      setError(null);
      await load();
    } catch (reason) {
      setError(`恢复目标失败：${String(reason)}`);
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <>
    <div className="mb-4">
      <section className="min-w-0" aria-label="项目目标">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h2 className="text-sm font-medium text-l1">目标</h2>
            {loaded && tasks.length > 0 && (
              <span className="text-xs text-l3">{tasks.length} 个</span>
            )}
          </div>
          {loaded && tasks.length > 0 && (
            <button
              type="button"
              className={`${primaryTaskId ? secondaryActionClass : primaryActionClass} gap-1.5`}
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={13} aria-hidden="true" />
              新建目标
            </button>
          )}
          <button
            type="button"
            className={iconActionClass}
            onClick={() => void load()}
            title="刷新目标"
            aria-label="刷新目标"
          >
            <RotateCw size={14} aria-hidden="true" />
          </button>
        </div>
        {loadError && <InlineNotice tone="err" className="mb-2">{loadError}</InlineNotice>}
        {error && <InlineNotice tone="err" className="mb-2">{error}</InlineNotice>}
        {!loaded ? (
          <p role="status" className={`${projectWellClass} text-xs text-l3`}>正在读取目标…</p>
        ) : tasks.length === 0 ? (
          !loadError && <EmptyState
            compact
            title={archivedTasks.length ? "当前没有目标" : "这次想完成什么？"}
            detail={archivedTasks.length ? "可以新建目标，或从已归档中恢复。" : "写清要交付的成果，再选择资料和 Agent。"}
            action={
              <button
                type="button"
                className={`${primaryActionClass} gap-1.5`}
                onClick={() => setCreateOpen(true)}
              >
                <Plus size={13} aria-hidden="true" />
                新建目标
              </button>
            }
          />
        ) : (
          <div className="space-y-4">
            {visibleBuckets.map((bucket) => {
              const rows = buckets[bucket];
              const label = bucket === "review" ? reviewCopy.bucketReview : GOAL_BUCKET_LABEL[bucket];
              return (
                <div key={bucket}>
                  {visibleBuckets.length > 1 && (
                    <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-l3">
                      {label}
                      <span className="text-micro font-normal text-l4">{rows.length}</span>
                    </h3>
                  )}
                  <ul aria-label={label} className="space-y-2">
                    {rows.map((task) => {
                      const run = latestRunByTask.get(task.id);
                      const running = task.status === "running";
                      const name = goalDisplayName(task);
                      const taskRuns = runs.filter(
                        (item) => item.taskId === task.id && !item.internal,
                      );
                      const timeline = goalTimeline({
                        status: task.status,
                        runs: taskRuns,
                        events: events.filter((event) =>
                          taskRuns.some((item) => item.id === event.runId),
                        ),
                        acceptedLabel: reviewCopy.timelineAccepted,
                      });
                      const meta = goalCardMeta({
                        agentLabel: agentLabel(task.agent ?? run?.agent ?? project.defaultAgent ?? "") || "跟随项目默认",
                        outputPaths: task.outputPaths,
                        adoptedPaths: task.adoptedPaths,
                        reviewRequired: task.reviewRequired,
                        workMode: project.workMode,
                      });
                      const cleanupPending = !!task.storageCleanupPending;
                      const recoveryPending = !!task.pendingApplyRunId || cleanupPending;
                      const canStart = !recoveryPending && ["pending", "failed", "stopped"].includes(task.status);
                      const showStatus = visibleBuckets.length === 1 || bucket === "stuck";
                      const detailsOpen = detailsTaskId === task.id;
                      const fullGoal = goalFullText(task);
                      const outputPaths = [...new Set(acceptedGoalOutputs(task.outputPaths, task.adoptedPaths))];
                      const hasAdoptedFiles = acceptedGoalOutputs([], task.adoptedPaths).length > 0;
                      const extraRequirement = fullGoal !== name;
                      // 记下了还没跑过：资料还没复制、上下文还没冻结，要求和设置都还能改
                      const editable = task.status === "pending" && taskRuns.length === 0 && !recoveryPending;
                      const actionClass = `${task.id === primaryTaskId ? primaryActionClass : secondaryActionClass} gap-1.5`;
                      return (
                        <li key={task.id} aria-label={`目标：${name}`} className={projectWellClass}>
                          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                            <div className="min-w-0 flex-[1_1_18rem]">
                              <h4
                                className={`${detailsOpen ? "" : "line-clamp-2"} break-words text-sm font-medium leading-5 text-l1 [overflow-wrap:anywhere]`}
                                aria-label={detailsOpen && !extraRequirement ? `目标完整要求：${name}` : undefined}
                              >{name}</h4>
                              <p className="mt-1.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs text-l3">
                                {showStatus && (
                                  <>
                                    <span className={`shrink-0 ${task.status === "failed" ? "text-err-text" : ""}`}>{taskStatusLabel(task.status)}</span>
                                    <span aria-hidden="true">·</span>
                                  </>
                                )}
                                <span className="min-w-0 break-words">{meta}</span>
                              </p>
                            </div>
                            <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1 text-xs">
                              {cleanupPending && <button type="button" className={primaryActionClass} onClick={() => setStorageTaskId(task.id)}>继续清理副本</button>}
                              {!cleanupPending && task.pendingApplyRunId && <button type="button" className={primaryActionClass} onClick={() => setReviewTask(task)}>处理未完成接受</button>}
                              {!recoveryPending && running && run && (
                                <button type="button" className={actionClass} onClick={() => continueRun(run)}>
                                  继续
                                </button>
                              )}
                              {!recoveryPending && running && run && (
                                <button
                                  type="button"
                                  className={`${ghostActionClass} gap-1.5`}
                                  aria-label={`停止目标：${name}`}
                                  disabled={stoppingId === task.id}
                                  title="停下正在跑的 Agent；已写的文件留在工作副本里，之后可重试或验收"
                                  onClick={() => void stopGoal(task, run)}
                                >
                                  <Square size={11} strokeWidth={0} fill="currentColor" aria-hidden="true" />
                                  {stoppingId === task.id ? "停止中…" : "停止"}
                                </button>
                              )}
                              {canStart && (
                                <button
                                  type="button"
                                  className={actionClass}
                                  disabled={startingId === task.id}
                                  onClick={() => void startTask(task)}
                                >
                                  <Play size={13} aria-hidden="true" />
                                  {startingId === task.id ? "准备中…" : run ? "重试" : "开始"}
                                </button>
                              )}
                              {!recoveryPending && task.status === "completed" && run && (
                                <button type="button" className={ghostActionClass} onClick={() => task.workspaceCleared ? void startTask(task) : setReviewTask(task)}>
                                  {task.workspaceCleared ? "从项目重新开始" : "再来一版"}
                                </button>
                              )}
                              {!recoveryPending && task.status === "pending_review" && run && (
                                <button type="button" className={actionClass} onClick={() => setReviewTask(task)}>
                                  {reviewCopy.cardAction}
                                </button>
                              )}
                              <button
                                type="button"
                                className={`${ghostActionClass} gap-1`}
                                aria-label={`目标详情：${name}`}
                                aria-expanded={detailsOpen}
                                aria-controls={`goal-details-${task.id}`}
                                onClick={() => setDetailsTaskId(detailsOpen ? null : task.id)}
                              >
                                <FoldMark open={detailsOpen} />
                                详情
                              </button>
                            </div>
                          </div>
                          {(running || task.status === "pending_review") && !run && (
                            <p className="mt-2 text-xs text-l3">运行记录暂不可用，请刷新后重试。</p>
                          )}
                          {detailsOpen && (
                            <section id={`goal-details-${task.id}`} aria-label={`目标详情内容：${name}`} className="mt-3 space-y-4 border-t border-hairline pt-3">
                              {extraRequirement && (
                                <div>
                                  <h5 className="text-micro font-medium text-l3">要求</h5>
                                  <p aria-label={`目标完整要求：${name}`} className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-6 text-l1 [overflow-wrap:anywhere]">{fullGoal}</p>
                                </div>
                              )}
                              {task.reviewRequired && outputPaths.length > 0 && (
                                <div>
                                  <h5 className="text-micro font-medium text-l3">{hasAdoptedFiles ? "已写入项目" : "输出范围"} · {outputPaths.length}</h5>
                                  <ul aria-label={hasAdoptedFiles ? "已写入项目的文件" : "声明的输出范围"} className="mt-1.5 space-y-1 font-mono text-xs text-l2">
                                    {outputPaths.map((path) => <li key={path} className="break-all">{path}</li>)}
                                  </ul>
                                </div>
                              )}
                              {timeline.length > 1 && (
                                <div>
                                  <h5 className="text-micro font-medium text-l3">历程</h5>
                                  <ol aria-label={`目标历程详情：${name}`} className="mt-1.5 space-y-3 border-l border-hairline pl-3">
                                    {timeline.map((item, index) => {
                                      const row = timelineRow(item);
                                      return (
                                        <li key={index}>
                                          <p className="flex items-baseline gap-2 text-xs text-l3">
                                            <span>{row.label}</span>
                                            {item.at && (
                                              <span className="text-micro text-l4" title={absTime(item.at)}>
                                                {relTime(item.at)}
                                              </span>
                                            )}
                                          </p>
                                          {row.body ? (
                                            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-l2 [overflow-wrap:anywhere]">{row.body}</p>
                                          ) : null}
                                        </li>
                                      );
                                    })}
                                  </ol>
                                </div>
                              )}
                              <div>
                                <h5 className="text-micro font-medium text-l3">设置</h5>
                                <ul aria-label={`目标设置：${name}`} className="mt-1.5 space-y-0.5 text-xs text-l2">
                                  {goalSettingLines(task, project, profiles).map((line) => (
                                    <li key={line} className="break-words [overflow-wrap:anywhere]">{line}</li>
                                  ))}
                                </ul>
                              </div>
                              {task.workspaceCleared && (
                                <p className="text-xs text-l3">工作副本已清理，不能从旧副本续跑。{task.reviewCleared ? "历史版本也已清理；目标与接受记录保留。" : "历史冻结版本仍保留。"}</p>
                              )}
                              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline pt-3">
                                {editable && (
                                  <button type="button" className={secondaryActionClass} aria-label={`编辑目标：${name}`} onClick={() => setEditTask(task)}>编辑</button>
                                )}
                                {(taskRuns.length > 0 || cleanupPending) && (
                                  <button type="button" className={secondaryActionClass} onClick={() => setStorageTaskId(task.id)}>释放副本空间</button>
                                )}
                                <button
                                  type="button"
                                  className={`${ghostActionClass} gap-1.5`}
                                  aria-label={`归档目标：${name}`}
                                  disabled={deletingId === task.id || running || recoveryPending}
                                  title={task.pendingApplyRunId
                                    ? "请先处理未完成的接受，再归档"
                                    : cleanupPending
                                      ? "请先继续未完成的副本清理，再归档"
                                      : running
                                        ? "先点「停止」停掉正在跑的 Agent，再归档"
                                        : deletingId === task.id ? "归档中…" : "归档目标（记录都保留，副本仍占磁盘）"}
                                  onClick={() => void deleteGoal(task)}
                                >
                                  <Archive size={14} aria-hidden="true" />
                                  归档目标
                                </button>
                              </div>
                            </section>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        {loaded && archivedTasks.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              className="mb-2 flex min-h-7 items-center gap-1 text-xs font-medium text-l3 hover:text-l2"
              onClick={() => setArchiveOpen((open) => !open)}
              aria-expanded={archiveOpen}
            >
              <FoldMark open={archiveOpen} />
              已归档 {archivedTasks.length}
            </button>
            {archiveOpen && (
              <ul className="space-y-2">
                {archivedTasks.map((task) => (
                  <li key={task.id} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-2 hover:bg-hover">
                    <span className="min-w-0 flex-1">
                      <span className="break-words text-sm text-l2 [overflow-wrap:anywhere]">{goalDisplayName(task)}</span>
                      <span
                        className="mt-1 block text-micro text-l4"
                        title={absTime(task.archivedAt)}
                      >
                        {relTime(task.archivedAt)} · 已归档 · {taskStatusLabel(task.status)}
                      </span>
                    </span>
                    <button type="button" className={ghostActionClass} onClick={() => setStorageTaskId(task.id)}>{task.storageCleanupPending ? "继续清理副本" : "释放副本空间"}</button>
                    <button
                      type="button"
                      className={secondaryActionClass}
                      disabled={restoringId === task.id || task.storageCleanupPending}
                      title={task.storageCleanupPending ? "请先继续未完成的副本清理，再恢复" : undefined}
                      onClick={() => void restoreGoal(task)}
                    >
                      {restoringId === task.id ? "恢复中…" : "恢复"}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center rounded-md px-2 text-xs text-err-text hover:bg-hover disabled:opacity-50"
                      disabled={purgingId === task.id || task.storageCleanupPending}
                      title={task.storageCleanupPending ? "请先继续未完成的副本清理，再删除" : "从已归档里删除，项目里已接受的文件保留"}
                      onClick={() => void purgeGoal(task)}
                    >
                      {purgingId === task.id ? "删除中…" : "删除"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
    {!embed && (
      <ProjectSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        projectPath={project.path}
        projectName={project.name}
        workMode={project.workMode}
        onError={setError}
      />
    )}
      {(createOpen || editTask) && (
        <CreateTaskModal
          key={editTask?.id ?? "new"}
          project={project}
          profiles={visibleProfiles}
          editing={editTask}
          onClose={() => {
            setCreateOpen(false);
            setEditTask(null);
          }}
          onSaved={async (task, start) => {
            setCreateOpen(false);
            setEditTask(null);
            await load();
            if (start) await startTask(task);
          }}
          onError={setError}
        />
      )}
      {storageTaskId && <GoalStorageModal taskId={storageTaskId} onClose={() => setStorageTaskId(null)} onChanged={() => void load()} />}
      {reviewTask && (
        <ReviewOutputsModal
          workMode={project.workMode}
          task={tasks.find((task) => task.id === reviewTask.id) ?? reviewTask}
          run={runs.find((run) => run.id === (tasks.find((task) => task.id === reviewTask.id)?.pendingApplyRunId ?? reviewTask.pendingApplyRunId)) ?? latestRunByTask.get(reviewTask.id) ?? null}
          runCount={
            runs.filter((item) => item.taskId === reviewTask.id && !item.internal).length
          }
          previousFeedback={parseReviewNote(
            events.filter(
              (event) =>
                event.eventType === "task.review_notes" &&
                runs.some(
                  (item) => item.id === event.runId && item.taskId === reviewTask.id,
                ),
            ).slice(-1)[0]?.payload,
          )}
          onClose={() => setReviewTask(null)}
          onAdopted={() => {
            setReviewTask(null);
            void load();
          }}
          onContinue={async (feedback) => {
            const current = tasks.find((item) => item.id === reviewTask.id) ?? reviewTask;
            setReviewTask(null);
            await startTask(current, { reuseIsolation: true, feedback });
          }}
          onError={setError}
        />
      )}
    </>
  );
}

const MATERIAL_SCOPES: { id: TaskMaterialScope; label: string }[] = [
  { id: "whole", label: "整个项目" },
  { id: "selected", label: "指定资料" },
  { id: "none", label: "不带入" },
];

function materialScopeLabel(scope: TaskMaterialScope, selected: readonly string[]): string {
  if (scope === "whole") return "整个项目";
  if (scope === "none") return "不带入资料";
  return selected.length ? `指定资料 ${selected.length} 项` : "指定资料（未勾选）";
}

/** 新建 / 编辑目标同一张表。编辑只给「记下了还没开始」的目标（后端 task_update 同口径拒改跑过的）。 */
function CreateTaskModal({
  project,
  profiles,
  editing,
  onClose,
  onSaved,
  onError,
}: {
  project: ProjectDto;
  profiles: ReturnType<typeof useAppStore.getState>["profiles"];
  editing?: TaskDto | null;
  onClose: () => void;
  onSaved: (task: TaskDto, start: boolean) => Promise<void>;
  onError: (message: string) => void;
}) {
  const initialScope = editing
    ? scopeFromInputPaths(editing.inputPaths)
    : { scope: "whole" as TaskMaterialScope, selected: [] as string[] };
  const [text, setText] = useState(editing ? goalFullText(editing) : "");
  const [permission, setPermission] = useState<TaskPermission>(
    editing && !editing.reviewRequired ? "discuss" : "write_tree",
  );
  const [scope, setScope] = useState<TaskMaterialScope>(initialScope.scope);
  const [selectedPaths, setSelectedPaths] = useState<string[]>(initialScope.selected);
  const [poolSkills, setPoolSkills] = useState<string[]>([]);
  const [pickedSkills, setPickedSkills] = useState<string[]>(editing?.skills ?? []);
  useEffect(() => {
    let stale = false;
    invoke<{ config: { skills?: string[] } }>("read_project_config", {
      path: project.path,
    })
      .then((read) => {
        if (!stale) setPoolSkills(read.config.skills ?? []);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [project.path]);
  const configuredAgents = AGENTS.filter((agent) =>
    profiles.some((profile) => profile.agent === agent.id),
  );
  // 没点过 Agent / 连接 / 模型 = 跟随项目默认：存空，开工时按项目默认解析（与工作台「记下一个目标」同口径），
  // 之后在 Agents 页改项目默认它也跟着走；点过才把这条目标钉在所选连接上。
  const followAgent = editing?.agent ?? project.defaultAgent;
  const fallback = goalDefaultProfile(profiles, followAgent, project.defaultProfiles);
  const [launchPinned, setLaunchPinned] = useState(Boolean(editing?.profileId));
  const [taskAgent, setTaskAgent] = useState(
    editing?.profileId ? editing.agent ?? "" : fallback?.agent ?? configuredAgents[0]?.id ?? "",
  );
  const detectedAgents = useAppStore((s) => s.agents);
  const agentProfiles = profiles.filter((profile) => profile.agent === taskAgent);
  const [taskProfile, setTaskProfile] = useState(
    editing?.profileId ?? fallback?.id ?? agentProfiles[0]?.id ?? "",
  );
  // B2 目标级模型：随连接换档重置（旧模型的名单属于旧连接）
  const taskProfileObj = agentProfiles.find((profile) => profile.id === taskProfile);
  const [taskModel, setTaskModel] = useState(editing?.profileId ? editing.model ?? "" : "");
  useEffect(() => {
    setTaskModel((cur) =>
      taskProfileObj?.models.includes(cur) ? cur : "",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskProfile]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const setPage = useAppStore((s) => s.setPage);
  useEffect(() => {
    if (!taskAgent && configuredAgents[0]) setTaskAgent(configuredAgents[0].id);
  }, [configuredAgents, taskAgent]);
  useEffect(() => {
    if (!agentProfiles.some((profile) => profile.id === taskProfile)) {
      setTaskProfile(project.defaultProfiles?.[taskAgent] ?? agentProfiles[0]?.id ?? "");
    }
  }, [agentProfiles, project.defaultProfiles, taskAgent, taskProfile]);

  const effectiveProfile = launchPinned ? taskProfileObj : fallback;
  const effectiveAgent = effectiveProfile?.agent ?? taskAgent;
  const effectiveModel = effectiveProfile
    ? resolveTaskModel({
        models: effectiveProfile.models,
        taskModel: launchPinned ? taskModel : undefined,
        profileId: effectiveProfile.id,
        defaultProfileId: project.defaultProfiles?.[effectiveProfile.agent],
        defaultModel: project.defaultModels?.[effectiveProfile.agent],
      })
    : "";
  const discussUnsupported = permission === "discuss" && !detectedAgents.find((a) => a.id === effectiveAgent)?.readonlySupported;

  function pin(next: () => void) {
    if (!launchPinned) {
      setLaunchPinned(true);
      if (fallback) {
        setTaskAgent(fallback.agent);
        setTaskProfile(fallback.id);
      }
    }
    next();
  }
  function followDefault() {
    setLaunchPinned(false);
    if (fallback) {
      setTaskAgent(fallback.agent);
      setTaskProfile(fallback.id);
    }
    setTaskModel("");
  }

  const copy = goalReviewCopy(project.workMode);
  const summary = [
    materialScopeLabel(scope, selectedPaths),
    permission === "write_tree" ? copy.writeTab : "只讨论",
    pickedSkills.length ? `点名技能 ${pickedSkills.length} 个` : null,
    effectiveProfile
      ? [agentLabel(effectiveProfile.agent), effectiveProfile.name, effectiveModel].filter(Boolean).join(" / ") +
        (launchPinned ? "" : "（项目默认）")
      : "还没有可用连接",
  ].filter(Boolean).join(" · ");
  const name = goalShortTitle(text);
  const canSave = canSaveDeclaredGoal({
    name,
    scope,
    selectedPaths,
    permission,
  });
  const canSubmit = canSubmitDeclaredTask({
    name,
    scope,
    selectedPaths,
    profileId: effectiveProfile?.id ?? "",
    permission,
  });

  async function saveGoal(start: boolean) {
    const paths = taskPathsForScope(scope, selectedPaths, permission);
    if (paths.error) {
      setFormError(paths.error);
      setMoreOpen(true);
      return;
    }
    if (start && discussUnsupported) { setFormError("所选 Agent 不支持只读/计划模式，请更换 Agent 或明确选择可写权限。"); setMoreOpen(true); return; }
    if (start && !effectiveProfile) {
      setFormError("开始前请选择 Agent 和连接。");
      setMoreOpen(true);
      return;
    }
    const launch = launchPinned
      ? { agent: taskAgent || null, profileId: taskProfile || null, model: taskModel || null }
      : { agent: null, profileId: null, model: null };
    const fields = {
      name,
      description: text.trim(),
      inputPaths: paths.inputPaths,
      outputPaths: paths.outputPaths,
      permission,
      ...launch,
      skills: pickedSkills,
    };
    setBusy(true);
    setFormError(null);
    try {
      const task = editing
        ? await invoke<TaskDto>("task_update", { input: { id: editing.id, ...fields } })
        : await invoke<TaskDto>("task_create", {
            input: {
              projectRoot: project.path,
              kind: project.workMode === "office" ? "office_doc" : "free_research",
              ...fields,
            },
          });
      await onSaved(task, start);
    } catch (reason) {
      const message = `${editing ? "保存目标失败" : "新建目标失败"}：${String(reason)}`;
      setFormError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await saveGoal(true);
  }

  const chipClass = (on: boolean) =>
    `inline-flex h-7 items-center rounded-full px-2.5 text-xs ${
      on ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
    }`;

  return (
    <Modal open title={editing ? "编辑目标" : "新建目标"} onClose={onClose} size={moreOpen ? "lg" : "md"}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-xs text-l3">
          要完成什么
          <textarea
            className="mt-1 min-h-20 w-full rounded-md border border-field bg-canvas px-2 py-1.5 text-sm text-l1 outline-none placeholder:text-l4 focus:border-l4"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              project.workMode === "office"
                ? "例如：按公司模板写本周周报，保存到文档/周报.md"
                : "例如：根据项目里的文献，写一篇综述并保存到论文/综述.md"
            }
            required
            autoFocus
          />
        </label>
        <button
          type="button"
          className="flex w-full min-w-0 items-baseline gap-1.5 text-left text-xs text-l3 hover:text-l1"
          onClick={() => setMoreOpen((open) => !open)}
          aria-expanded={moreOpen}
        >
          <FoldMark open={moreOpen} />
          <span className="shrink-0">资料和 Agent</span>
          {!moreOpen && (
            <span aria-label="本次设置" className="min-w-0 truncate text-micro text-l4" title={summary}>{summary}</span>
          )}
        </button>
        {moreOpen && (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs text-l3">资料</p>
              <SegTabs items={MATERIAL_SCOPES} value={scope} onChange={setScope} />
              {scope === "selected" && (
                <TaskMaterialsPicker
                  projectPath={project.path}
                  selected={selectedPaths}
                  onChange={setSelectedPaths}
                />
              )}
            </div>
            <div>
              <p className="mb-1 text-xs text-l3">
                技能
                <span className="ml-1 font-normal text-micro text-l4">
                  本次点名才按其规范执行；不点就是不用
                </span>
              </p>
              {poolSkills.length === 0 ? (
                <p className="text-xs text-l4">
                  还没有技能。到规则里从技能库添加。
                </p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {poolSkills.map((skill) => {
                    const on = pickedSkills.includes(skill);
                    return (
                      <button
                        key={skill}
                        type="button"
                        aria-pressed={on}
                        className={chipClass(on)}
                        onClick={() =>
                          setPickedSkills(
                            on
                              ? pickedSkills.filter((item) => item !== skill)
                              : [...pickedSkills, skill],
                          )
                        }
                      >
                        {skill}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs text-l3">权限</p>
              {discussUnsupported && <InlineNotice tone="warn" className="mb-2">所选 Agent 不支持只读/计划模式，不能以“只讨论”启动。</InlineNotice>}
              <SegTabs
                items={[
                  { id: "write_tree" as const, label: copy.writeTab },
                  { id: "discuss" as const, label: "只讨论" },
                ]}
                value={permission}
                onChange={setPermission}
              />
            </div>
            <div>
              <p className="mb-1 flex items-baseline gap-2 text-xs text-l3">
                Agent
                {configuredAgents.length > 0 && (launchPinned ? (
                  <button
                    type="button"
                    className="text-micro text-l4 hover:text-l1 hover:underline"
                    onClick={followDefault}
                  >
                    改回跟随项目默认
                  </button>
                ) : (
                  <span className="text-micro font-normal text-l4">跟随项目默认；点选即只给这个目标指定</span>
                ))}
              </p>
              {configuredAgents.length === 0 ? (
                <p className="text-xs text-l4">
                  还没有可用连接。
                  <button
                    type="button"
                    className="ml-1 text-l2 hover:text-l1 hover:underline"
                    onClick={() => {
                      onClose();
                      setPage("profiles");
                    }}
                  >
                    去连接页
                  </button>
                </p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {configuredAgents.map((agent) => {
                    const on = effectiveAgent === agent.id;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        className={`${chipClass(on)} gap-1.5`}
                        onClick={() => pin(() => setTaskAgent(agent.id))}
                      >
                        <span
                          aria-hidden="true"
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ background: agentBrand(agent.id) }}
                        />
                        {agent.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {configuredAgents.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-l3">连接</p>
                {agentProfiles.length === 0 ? (
                  <p className="text-xs text-l4">
                    这家还没有连接。
                    <button
                      type="button"
                      className="ml-1 text-l2 hover:text-l1 hover:underline"
                      onClick={() => {
                        onClose();
                        setPage("profiles");
                      }}
                    >
                      去连接页
                    </button>
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {agentProfiles.map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        className={chipClass(effectiveProfile?.id === profile.id)}
                        onClick={() => pin(() => setTaskProfile(profile.id))}
                      >
                        {profile.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {configuredAgents.length > 0 &&
              effectiveProfile &&
              effectiveProfile.models.length > 0 && (
                <div>
                  <p className="mb-1 text-xs text-l3">模型</p>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className={chipClass(!launchPinned || taskModel === "")}
                      onClick={() => pin(() => setTaskModel(""))}
                    >
                      默认{effectiveModel && (!launchPinned || taskModel === "") ? `（${effectiveModel}）` : ""}
                    </button>
                    {effectiveProfile.models.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={chipClass(launchPinned && taskModel === m)}
                        onClick={() => pin(() => setTaskModel(m))}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}
          </div>
        )}
        {formError && <InlineNotice tone="err">{formError}</InlineNotice>}
        <div className="flex justify-end gap-2">
          <button type="button" className={rowActionClass} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={secondaryActionClass}
            disabled={busy || !canSave}
            onClick={() => void saveGoal(false)}
          >
            {editing ? (busy ? "保存中…" : "保存") : busy ? "记下…" : "记下"}
          </button>
          <button
            type="submit"
            className={primaryActionClass}
            disabled={busy || !canSubmit}
          >
            {busy ? "正在准备…" : editing ? "保存并开始" : "开始"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TaskMaterialsPicker({
  projectPath,
  selected,
  onChange,
}: {
  projectPath: string;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [cache, setCache] = useState<Record<string, DirEntryDto[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([projectPath]));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (path: string) => {
      try {
        const entries = await invoke<DirEntryDto[]>("list_dir", {
          path,
          showHidden: false,
        });
        setCache((current) => ({
          ...current,
          [path]: entries.filter((entry) => !isTaskMaterialNoise(entry.name, entry.isSystem)),
        }));
        setError(null);
      } catch (reason) {
        setError(`读取项目文件失败：${String(reason)}`);
      }
    },
    [],
  );

  useEffect(() => {
    setCache({});
    setExpanded(new Set([projectPath]));
    void load(projectPath);
  }, [load, projectPath]);

  async function toggleDir(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (!cache[path]) await load(path);
    }
    setExpanded(next);
  }

  function toggleRelative(relative: string, checked: boolean) {
    onChange(toggleTaskMaterialPath(selected, relative, checked));
  }

  function renderEntries(root: string, depth: number): ReactNode {
    return (cache[root] ?? []).map((entry) => {
      const relative = relativeProjectPath(projectPath, entry.path);
      if (!relative) return null;
      const implied = pathCoveredBySelection(relative, selected) && !selected.includes(relative);
      const checked = selected.includes(relative) || implied;
      const open = expanded.has(entry.path);
      return (
        <li key={entry.path}>
          <div
            className="flex min-h-8 items-center gap-1.5 rounded-md px-1 hover:bg-hover"
            style={{ paddingLeft: 4 + depth * 14 }}
          >
            <Checkbox
              checked={checked}
              disabled={implied}
              onChange={(next) => toggleRelative(relative, next)}
            />
            {entry.isDir ? (
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs text-l2"
                onClick={() => void toggleDir(entry.path)}
                aria-expanded={open}
              >
                <FoldMark open={open} />
                <span className="truncate">{entry.name}</span>
              </button>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-l2">
                <FileTypeMark path={entry.path} />
                <span className="truncate">{entry.name}</span>
              </span>
            )}
          </div>
          {entry.isDir && open && <ul>{renderEntries(entry.path, depth + 1)}</ul>}
        </li>
      );
    });
  }

  return (
    <div className="mt-2">
      {selected.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {selected.map((path) => (
            <button
              key={path}
              type="button"
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-micro text-l2 hover:bg-inset"
              onClick={() => toggleRelative(path, false)}
              title="移出"
            >
              <span className="truncate">{path}</span>
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      {error && <InlineNotice tone="err" size="micro" className="mb-1">{error}</InlineNotice>}
      <div className="max-h-56 overflow-auto rounded-md border border-hairline bg-canvas py-1">
        {cache[projectPath] ? (
          <ul>{renderEntries(projectPath, 0)}</ul>
        ) : (
          <p className="px-2 py-2 text-micro text-l4">读取项目文件…</p>
        )}
      </div>
    </div>
  );
}

function ReviewOutputsModal({
  workMode,
  task,
  run,
  runCount,
  previousFeedback,
  onClose,
  onAdopted,
  onContinue,
  onError,
}: {
  workMode?: string | null;
  task: TaskDto;
  run: RunDto | null;
  runCount: number;
  previousFeedback?: string | null;
  onClose: () => void;
  onAdopted: () => void;
  onContinue: (feedback: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const copy = goalReviewCopy(workMode);
  const runId = run?.id;
  const projectRoot = task.projectRoot;
  const [changes, setChanges] = useState<TaskOutputChangeDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [memorize, setMemorize] = useState(false);
  const [protectedPaths, setProtectedPaths] = useState<string[]>([]);
  const [frozen, setFrozen] = useState(true);
  const [freezeRequired, setFreezeRequired] = useState(false);
  const [readiness, setReadiness] = useState<TaskReviewDto["readiness"]>();
  const [pendingApply, setPendingApply] = useState<TaskReviewDto["pendingApply"]>(null);
  const [payloadDir, setPayloadDir] = useState<string | null>(null);
  const [reviewSeq, setReviewSeq] = useState<number | null>(null);
  const [contextSnapshot, setContextSnapshot] = useState<TaskContextDto | null>(null);
  const [researchRunId, setResearchRunId] = useState<string | null>(null);
  const [showResearch, setShowResearch] = useState(false);
  const researchStep: ProjectStepDto = { name: task.name, workspaceName: task.id, brief: task.description, expectedArtifacts: changes.filter((c) => /\.(md|txt|py)$/i.test(c.path)).map((c) => c.path), skills: [], run: [] };
  useEffect(() => {
    if (!previewPath) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPreviewPath(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [previewPath]);

  // 打开后固定本次所审版本；列表轮询会创建新的 Run 对象，但不应重载评审或替换勾选。
  // 规则、上下文和清单一起就绪，避免分批渲染撑开居中的弹窗。
  useEffect(() => {
    if (!runId) {
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    setLoadError(null);
    setPreviewPath(null);
    const readProtectedPaths = projectRoot
      ? invoke<{ config: { protectedPaths?: string[] } }>("read_project_config", { path: projectRoot })
        .then((read) => read.config.protectedPaths ?? [])
        .catch(() => [] as string[])
      : Promise.resolve<string[]>([]);
    Promise.all([
      invoke<TaskReviewDto>("task_output_changes", { runId }),
      invoke<TaskContextDto | null>("task_run_context", { runId }).catch(() => null),
      readProtectedPaths,
    ])
      .then(([review, context, protectedPaths]) => {
        if (stale) return;
        // 版本错位防线：后端旧版返回的是数组而不是 TaskReviewDto，
        // 直接把 review.changes 当数组用会在渲染期炸进错误边界
        const rows = Array.isArray(review?.changes) ? review.changes : [];
        setContextSnapshot(context);
        setProtectedPaths(protectedPaths);
        setFrozen(review?.frozen === true);
        setFreezeRequired(review?.freezeRequired === true);
        setReadiness(review.readiness);
        setPendingApply(review.pendingApply ?? null);
        setPayloadDir(review?.payloadDir ?? null);
        setReviewSeq(review?.seq ?? null);
        setChanges(rows);
        setSelected(new Set(rows
          .filter((row) => row.kind !== "deleted" && !row.tooLarge && !pathIsProtected(row.path, protectedPaths))
          .map((row) => row.path)));
      })
      .catch((reason) => {
        if (stale) return;
        const message = `读取变更失败：${String(reason)}`;
        setLoadError(message);
        onError(message);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [onError, projectRoot, runId]);

  async function freezeLarge() {
    if (!run || (reviewSeq == null && !freezeRequired) || busy || pendingApply) return;
    const ok = await confirmDialog("将为这次运行启用扩展冻结：单文件最多 1 GB、每版合计最多 4 GB。会额外占用磁盘，之后仍按版本人工验收；不会直接写进项目。超过上限请先拆分或归档文件。继续？", { focusCancel: true, confirmText: "确认冻结大文件" });
    if (!ok) return;
    setBusy(true);
    try {
      const review = await invoke<TaskReviewDto>("task_freeze_large_outputs", { runId: run.id, expectSeq: reviewSeq ?? 0, confirmed: true });
      setChanges(review.changes); setReviewSeq(review.seq ?? null); setPayloadDir(review.payloadDir); setFrozen(review.frozen); setFreezeRequired(review.freezeRequired === true); setReadiness(review.readiness); setSelected(new Set()); setPreviewPath(null);
    } catch (error) { onError(`冻结大文件失败：${String(error)}`); }
    finally { setBusy(false); }
  }

  async function adopt() {
    if (!run) return;
    setBusy(true);
    try {
      await invoke("task_adopt_outputs", {
        runId: run.id,
        paths: selectedChangePaths(changes, selected).filter(
          (path) => !pathIsProtected(path, protectedPaths) && !changes.find((c) => c.path === path)?.tooLarge,
        ),
        note: feedback.trim() || null,
        expectSeq: reviewSeq,
        memorize,
      });
      onAdopted();
    } catch (reason) {
      onError(`采纳输出失败：${String(reason)}`);
      try {
        const review = await invoke<TaskReviewDto>("task_output_changes", { runId: run.id });
        setPendingApply(review.pendingApply ?? null); setReadiness(review.readiness);
        if (review.pendingApply) { setChanges(review.changes); setPayloadDir(review.payloadDir); }
      } catch { /* 原错误仍显示；无法读取恢复单时不谎报成功。 */ }
    } finally {
      setBusy(false);
    }
  }

  async function recover(action: "continue" | "rollback") {
    if (!run || !pendingApply || busy) return;
    if (action === "rollback" && !await confirmDialog("恢复本次接受之前的项目文件？只恢复仍等于本次写入内容的文件；后来被修改的文件不会强制覆盖。已记账的接受不可从此撤销。", { confirmText: "恢复原文件", focusCancel: true })) return;
    setBusy(true);
    try {
      await invoke("task_recover_outputs", { runId: run.id, operationId: pendingApply.id, action });
      onAdopted();
    } catch (error) {
      onError(`处理接受恢复失败：${String(error)}`);
      try {
        const review = await invoke<TaskReviewDto>("task_output_changes", { runId: run.id });
        setPendingApply(review.pendingApply ?? null);
      } catch { /* 保留原错误，不把恢复单读失败当成完成。 */ }
    }
    finally { setBusy(false); }
  }

  const selectable = changes.filter(
    (change) => change.kind !== "deleted" && !change.tooLarge && !pathIsProtected(change.path, protectedPaths),
  );
  const selectedCount = selected.size;
  const previewBase = payloadDir ?? run?.isolationPath ?? null;
  const previewAbs = previewPath && previewBase ? joinRunPath(previewBase, previewPath) : null;
  const groups = groupReviewChanges(workMode, changes);
  const previewChanges = changes.filter((change) => change.kind !== "deleted" && !change.tooLarge);
  const previewIndex = previewPath
    ? previewChanges.findIndex((change) => change.path === previewPath)
    : -1;

  return (
    <>
    <Modal
      open title={`${copy.modalTitle} · ${task.name}`} onClose={onClose} size="md"
      overflow="hidden"
      panelClassName="h-[min(48rem,calc(100dvh-24px))]"
      contentClassName="flex flex-1 flex-col"
    >
      <div
        role="region" aria-label="验收内容" aria-busy={loading}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] text-xs"
      >
        {loading ? (
          <p role="status" className="text-l4">读取这版的变更…</p>
        ) : loadError ? (
          <p role="alert" className="text-err-text">{loadError}。请关闭后重新打开验收。</p>
        ) : (
        <>
        <ul className="space-y-0.5 text-l3">
          {goalReviewFacts({
            workMode,
            agentLabel: agentLabel(run?.agent ?? task.agent ?? ""),
            runCount,
            resultSeq: reviewSeq,
            changes,
            feedback: previousFeedback,
          }).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {pendingApply && <section aria-label="未完成的接受操作" className="rounded border border-field p-3 text-xs">
          <h3 className="font-medium text-warn-text">有一次接受操作尚未完成</h3>
          <p className="mt-1 break-all">原版本 {pendingApply.versionId} · {pendingApply.paths.length} 个文件 · {pendingApply.phase === "prepared" ? "准备或部分写入" : pendingApply.phase === "files_applied" ? "文件已写入，待记账" : pendingApply.phase === "rolling_back" ? "恢复原文件尚未完成" : "接受已记账，待补状态"}</p>
          {pendingApply.note && <p className="mt-1">原意见：{pendingApply.note}</p>}
          <p className="mt-1 text-l3">继续只处理原版本，不带入后来生成的成果；请先完成恢复，再返修。</p>
          <div className="mt-2 flex gap-2"><button type="button" className={primaryActionClass} disabled={busy || pendingApply.phase === "rolling_back"} onClick={() => void recover("continue")}>继续未完成的接受</button><button type="button" className={secondaryActionClass} disabled={busy || pendingApply.phase === "recorded"} onClick={() => void recover("rollback")}>恢复原文件</button></div>
        </section>}
        {!loading && readiness && <p className="text-micro text-l3">{resultReadinessLabel(readiness)}</p>}
        {!loading && run && (run.status === "failed" || run.status === "stopped") && (
          <p className="ccode-well rounded-md px-2 py-1.5 text-micro text-l3">
            这次运行未正常完成（{run.status === "stopped" ? "已停止" : "失败"}）：
            下面是它留下的部分成果，已在收尾时冻结。请确认过程没有半途而废，再决定采纳还是写意见再出一版。
          </p>
        )}
        {!loading && freezeRequired && <p className="text-warn-text">本次冻结未成功，不能按实时目录采纳。请确认扩展预算后重新冻结，或让 Agent 缩小输出范围。</p>}
        {!loading && !frozen && !freezeRequired && (
          <p className="ccode-well rounded-md px-2 py-1.5 text-micro text-l3">
            这版结果没有冻结证据（旧版本生成或收尾时冻结失败）：下面按目录当前内容现算，
            如果项目在这期间被你改过，采纳不会逐文件提醒，请先自行核对。
          </p>
        )}
        {!!changes.some((change) => change.tooLarge) && <div className="rounded border border-field p-2 text-warn-text">
          <p>超出预算的文件尚未冻结，不可预览或采纳。可明确确认扩展预算，或让 Agent 拆分文件；其它已冻结文件可单独验收。</p>
          <button type="button" className={`${secondaryActionClass} mt-1`} disabled={busy || (reviewSeq == null && !freezeRequired)} onClick={() => void freezeLarge()}>确认范围并冻结大文件</button>
        </div>}
        {contextSnapshot && (
          <details className="rounded-md border border-field px-2 py-1.5 text-micro text-l3">
            <summary className="cursor-pointer select-none">
              本次工作环境（开工时冻结，可核对这版成果基于什么材料）
            </summary>
            {contextSnapshot.environment && <div className="mt-2 space-y-1 break-all">
              <p>执行：{contextSnapshot.environment.agent} · 权限：{contextSnapshot.environment.permission}</p>
              <p>资料：{contextSnapshot.environment.files.length} 项 · 输入：{contextSnapshot.environment.inputPaths.join("、")} · 产出：{contextSnapshot.environment.outputPaths.join("、")}</p>
              {contextSnapshot.environment.skills.map((skill) => <p key={skill.name}>技能 {skill.name} · 库 {skill.libraryDigest} · Agent {skill.runtimeDigest ?? "未核对"}</p>)}
              {contextSnapshot.environment.warnings.map((warning) => <p className="text-warn-text" key={warning}>{warning}</p>)}
            </div>}
            <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap text-l4">
              {contextSnapshot.text}
            </pre>
          </details>
        )}
        {changes.length === 0 ? (
          <p className="text-l3">{copy.empty}</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-l2">
                <span className="font-medium">{copy.pickLabel}</span>
                <span className="ml-1.5 font-normal text-l4">{copy.hint}</span>
              </p>
              <button
                type="button"
                className={rowActionClass}
                disabled={!!pendingApply}
                onClick={() =>
                  setSelected(
                    selectedCount === selectable.length
                      ? new Set()
                      : new Set(selectable.map((change) => change.path)),
                  )
                }
              >
                {selectedCount === selectable.length ? "全不选" : "全选"}
              </button>
            </div>
            <div className="max-h-72 space-y-3 overflow-auto">
              {groups.map((group) => (
                <div key={group.id}>
                  <p className="mb-1 text-micro font-medium text-l4">
                    {group.label}
                    <span className="ml-1 font-normal">{group.items.length}</span>
                  </p>
                  <ul className="space-y-1">
                    {group.items.map((change) => (
                      <li key={change.path} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-hover">
                        <Checkbox
                          checked={selected.has(change.path)}
                          disabled={
                            !!pendingApply || change.kind === "deleted" || change.tooLarge === true ||
                            pathIsProtected(change.path, protectedPaths)
                          }
                          onChange={(checked) => {
                            if (pendingApply || change.tooLarge || pathIsProtected(change.path, protectedPaths)) return;
                            const next = new Set(selected);
                            if (checked) next.add(change.path);
                            else next.delete(change.path);
                            setSelected(next);
                          }}
                        />
                        <FileTypeMark path={change.path} />
                        {change.kind === "deleted" ? (
                          <span
                            className="min-w-0 flex-1 truncate text-l3 line-through"
                            title={change.path}
                          >
                            {change.path}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left text-l2 hover:underline"
                            disabled={change.tooLarge === true}
                            onClick={() => setPreviewPath(change.path)}
                            title={change.path}
                          >
                            {change.path}
                          </button>
                        )}
                        <span className="shrink-0 text-micro text-l4">
                          {change.kind === "deleted"
                            ? taskChangeKindLabel(change.kind)
                            : change.tooLarge ? "未冻结 · 超出单文件预算"
                            : pathIsProtected(change.path, protectedPaths)
                              ? "跳过"
                              : taskChangeKindLabel(change.kind)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}
        {workMode === "research" && run && task.projectRoot && <details className="rounded border border-field p-2" onToggle={(event) => setShowResearch(event.currentTarget.open)}>
          <summary className="cursor-pointer">科研复现与结论验收（不等于文件采纳）</summary>
          {showResearch && <><ResearchReproductionPanel workspace={{ id: task.id, repoPath: task.projectRoot, worktreePath: run.isolationPath, status: "active" }} step={researchStep} sourceRunId={run.id} onLaunched={onClose} onRun={(r) => setResearchRunId(r.id)} />
          <ResearchAcceptancePanel workspace={{ id: task.id, repoPath: task.projectRoot, worktreePath: run.isolationPath, status: "active" }} step={researchStep} sourceRunId={run.id} runId={researchRunId} /></>}
        </details>}
        <label className="block text-xs text-l2">
          <span className="font-medium">意见</span>
          <span className="ml-1.5 font-normal text-l4">不满意再出一版</span>
          <textarea
            className="mt-1 min-h-16 w-full rounded-md border border-field bg-canvas px-2 py-1.5 text-sm text-l1 outline-none placeholder:text-l4 focus:border-l4"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder={copy.continuePlaceholder}
          />
        </label>
        <Checkbox
          checked={memorize}
          onChange={setMemorize}
          disabled={!feedback.trim()}
          label={
            <span className="text-xs text-l3">
              接受后把这条意见沉淀进项目长期知识
              <span className="text-l4">（下次开工带给 Agent；只有这里确认过的才进）</span>
            </span>
          }
        />
        {selectedCount > 0 && (
          <p className="text-micro text-l4">{copy.rememberLine}</p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={rowActionClass} onClick={onClose}>
            稍后
          </button>
          <button
            type="button"
            className={secondaryActionClass}
            disabled={busy || loading || !run || !feedback.trim() || !!pendingApply}
            onClick={() => void onContinue(feedback.trim())}
          >
            {copy.continueLabel}
          </button>
          {task.status !== "completed" && (
          <button
            type="button"
            className={primaryActionClass}
            disabled={busy || loading || !run || freezeRequired || !!pendingApply}
            onClick={() => void adopt()}
          >
            {busy
              ? "写入中…"
              : changes.length === 0 || selectedCount === 0
                ? copy.acceptEmpty
                : copy.acceptSome(selectedCount)}
          </button>
          )}
        </div>
        </>
        )}
      </div>
    </Modal>
      {previewAbs && previewBase && run && (
        <OfficePreviewModal
          path={previewAbs}
          root={previewBase}
          companionPdf={previewPath && companionPdfPath(previewPath, changes) ? joinRunPath(previewBase, companionPdfPath(previewPath, changes)!) : null}
          onClose={() => setPreviewPath(null)}
          hasPrevious={previewIndex > 0}
          hasNext={previewIndex >= 0 && previewIndex < previewChanges.length - 1}
          onPrevious={() => {
            if (previewIndex > 0) setPreviewPath(previewChanges[previewIndex - 1].path);
          }}
          onNext={() => {
            if (previewIndex >= 0 && previewIndex < previewChanges.length - 1) {
              setPreviewPath(previewChanges[previewIndex + 1].path);
            }
          }}
        />
      )}
    </>
  );
}
