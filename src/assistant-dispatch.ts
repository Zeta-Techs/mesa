/**
 * 项目助手派活单的执行（2026-11-04 用户拍板「它起草、你点一下就派」）：人点「派出去」后按去处开工，
 * 全走已有入口，不另起一套：
 * - 交给第 N 步：那一步的 AI 开着 → 留话（mail_send，它空闲时送进对话）；没开着 → 接回那一步上次的对话、带上派活单自动开跑
 *   （与评审「退回修改」同一条 buildWorkspaceTerminalRequest，步骤绑定优先）；
 * - 新目标：记成一条目标，用项目默认 Agent 在隔离副本里开工（与「拆成几路做」批准后开一路同一条 prepareGoalRun），做完进待验收。
 * 返回给人看的一句；开不了的抛错，原因写成人话。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store";
import { pathWithin, samePath } from "./path-utils";
import { IS_WINDOWS } from "./hotkeys";
import { buildWorkspaceTerminalRequest } from "./pipeline-start";
import { stepSlotKey, taskBindingLaunch, resolveTaskModel } from "./project-agents";
import { taskPathsForScope } from "./project-tasks";
import { goalRunTerminalFields, prepareGoalRun } from "./goal-run";
import { projectDefaultProfile } from "./split-draft";
import { openTerminalInTurn } from "./terminal-queue";
import { workOrderGoalText, workOrderMessage, type WorkOrder } from "./project-assistant";
import type { ProjectConfigReadDto, ProjectDto, ProjectMailDto, TaskDto, WorkspaceDto } from "./types";

export interface DispatchResult {
  note: string;
  mode: "mail" | "resume" | "goal";
  mailId?: string;
  taskId?: string;
  worktreePath?: string;
}

export async function dispatchWorkOrder(input: { order: WorkOrder; projectPath: string; project: ProjectDto | null }): Promise<DispatchResult> {
  const { order, projectPath, project } = input;
  if (order.target === "step") return dispatchToStep(order, projectPath);
  return dispatchAsGoal(order, projectPath, project);
}

/** 第 n 步（从 1 数）和它开着的工作副本；没有就抛人话 */
export async function stepWorkspace(projectPath: string, n: number) {
  const read = await invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath });
  const step = read.config.steps[n - 1];
  if (!step) throw new Error(`这个项目没有第 ${n} 步了`);
  const workspaces = await invoke<WorkspaceDto[]>("list_workspaces");
  const ws = workspaces.find(
    (w) => w.status !== "archived" && w.name === step.workspaceName && samePath(w.repoPath, projectPath, IS_WINDOWS),
  );
  if (!ws) throw new Error(`第 ${n} 步还没开工作副本：先在项目页开始这一步`);
  return { step, ws };
}

/** 那个目录里开着、正在干活或等着的 AI（不是回落的 shell）的运行 id */
export function liveRunIn(worktreePath: string): string | null {
  const live = useAppStore
    .getState()
    .terminalRunInputs.find((r) => r.running && !r.shell && !!r.runId && pathWithin(r.cwd, worktreePath, IS_WINDOWS));
  return live?.runId ?? null;
}

async function dispatchToStep(order: WorkOrder, projectPath: string): Promise<DispatchResult> {
  const n = order.step ?? 0;
  const { step, ws } = await stepWorkspace(projectPath, n);
  const message = workOrderMessage(order);
  const { profiles, setPendingTerminal, setPage } = useAppStore.getState();
  // 那一步的 AI 开着（不是回落的 shell）：留话，它空闲、输入框没草稿时送进对话
  const liveRun = liveRunIn(ws.worktreePath);
  if (liveRun) {
    const mailId = await invoke<string>("mail_send", { toRun: liveRun, text: message });
    return { note: `已留话给第 ${n} 步的 AI，它空闲时送到`, mode: "mail", mailId, worktreePath: ws.worktreePath };
  }
  // 没开着：接回那一步上次的对话，带上派活单自动开跑；步骤绑定的连接优先（读不到按没绑）
  const binding = await invoke<{ profile: string; model?: string | null } | null>("get_project_agent_binding", {
    projectRoot: projectPath,
    slot: stepSlotKey(step.name),
  }).catch(() => null);
  setPendingTerminal(
    await buildWorkspaceTerminalRequest(ws, message, {
      autoStart: true,
      resumeSession: true,
      stepLaunch: taskBindingLaunch(profiles, binding) ?? undefined,
    }),
  );
  setPage("terminal");
  return { note: `已让第 ${n} 步的 AI 接着做，做完照常去评审`, mode: "resume", worktreePath: ws.worktreePath };
}

async function dispatchAsGoal(order: WorkOrder, projectPath: string, project: ProjectDto | null): Promise<DispatchResult> {
  if (!project) throw new Error("这个目录还没添加成项目，记不了目标");
  if (project.workMode === "coding") throw new Error("编程项目按分支开工：到项目页从基准开一条分支来做");
  const profile = projectDefaultProfile(project);
  if (!profile) throw new Error("还没有可用连接：先到连接页配一个，或在项目的 Agent 分工里定默认");
  const paths = taskPathsForScope("whole", [], "write_tree");
  const task = await invoke<TaskDto>("task_create", {
    input: {
      projectRoot: projectPath,
      kind: project.workMode === "office" ? "office_doc" : "free_research",
      name: order.title,
      description: workOrderGoalText(order),
      inputPaths: paths.inputPaths,
      outputPaths: paths.outputPaths,
      permission: "write_tree",
    },
  });
  // 终端页先挂上，才收得下开工请求
  useAppStore.getState().setPage("terminal");
  try {
    const { run, prompt } = await prepareGoalRun({
      projectName: project.name,
      projectPath,
      workMode: project.workMode,
      task,
      agent: profile.agent,
      profileId: profile.id,
    });
    const taken = await openTerminalInTurn({
      extraEnv: {},
      title: task.name,
      agentId: profile.agent,
      profileId: profile.id,
      model: resolveTaskModel({
        models: profile.models,
        taskModel: task.model,
        profileId: profile.id,
        defaultProfileId: project.defaultProfiles?.[profile.agent],
        defaultModel: project.defaultModels?.[profile.agent],
      }),
      ...goalRunTerminalFields(task, run, prompt),
    });
      if (!taken) throw new Error("终端页没收下开工请求");
  } catch (reason) {
    throw new Error(`目标「${task.name}」已记下，但没开起来：${String(reason)}。可以在项目里点「开始」重试`);
  }
  return { note: `已记成目标「${task.name}」并开工，做完在待验收里`, mode: "goal", taskId: task.id };
}

/** 派活记录（存在问答记录那一轮上，后端 DispatchRecordDto） */
export interface DispatchRecord {
  at: string;
  target: "step" | "goal" | string;
  step?: number | null;
  title: string;
  mode: "mail" | "resume" | "goal" | string;
  mailId?: string | null;
  taskId?: string | null;
  worktreePath?: string | null;
  note: string;
}

export type DispatchTone = "wait" | "live" | "done" | "fail" | "idle";

/** 派出去的活现在怎样（卡片上实时一行、项目快照里一行）：等送达 / 在做 / 做完待评审 / 做完待验收… */
export async function dispatchStatus(rec: DispatchRecord, projectPath: string): Promise<{ text: string; tone: DispatchTone }> {
  if (rec.mode === "goal" && rec.taskId) {
    const task = await invoke<TaskDto | null>("task_get", { id: rec.taskId }).catch(() => null);
    if (!task) return { text: "目标找不到了（可能删了）", tone: "idle" };
    const map: Record<string, { text: string; tone: DispatchTone }> = {
      pending: { text: "记下了，还没开工", tone: "wait" },
      queued: { text: "排队中", tone: "wait" },
      running: { text: "在做", tone: "live" },
      pending_review: { text: "做完了，等你验收", tone: "done" },
      completed: { text: "已验收", tone: "idle" },
      failed: { text: "上次失败，需要处理", tone: "fail" },
      stopped: { text: "停了，需要处理", tone: "wait" },
    };
    return map[task.status] ?? { text: task.status, tone: "idle" };
  }
  if (rec.mode === "mail" && rec.mailId) {
    const mails = await invoke<ProjectMailDto[]>("mail_list", { projectRoot: projectPath }).catch(() => [] as ProjectMailDto[]);
    const mail = mails.find((m) => m.id === rec.mailId);
    if (mail?.status === "withdrawn") return { text: "留话撤回了", tone: "idle" };
    if (mail?.status === "pending") {
      const target = useAppStore.getState().terminalRunInputs.find((r) => r.runId === mail.toRun);
      if (!mail.toOpen || !target) return { text: "还没送到：那段对话关了，接回来才送得到", tone: "fail" };
      if (target.attention === "confirm") return { text: "还没送到：它停在等你确认，确认完才送得到", tone: "wait" };
      return { text: "还没送到：它空闲、你没在它输入框里打字时送到", tone: "wait" };
    }
  }
  // 已送到 / 接回对话开跑的：看那一步的工作副本此刻怎样
  const path = rec.worktreePath;
  if (!path) return { text: rec.note, tone: "idle" };
  const live = useAppStore.getState().terminalRunInputs.find((r) => r.running && !r.shell && pathWithin(r.cwd, path, IS_WINDOWS));
  if (live?.attention === "working") return { text: "在做", tone: "live" };
  if (live?.attention === "confirm") return { text: "在做，停在等你确认", tone: "wait" };
  const ws = (await invoke<WorkspaceDto[]>("list_workspaces").catch(() => [] as WorkspaceDto[])).find((w) => samePath(w.worktreePath, path, IS_WINDOWS));
  if (!ws) return { text: "工作副本不在了（可能已保存进项目并归档）", tone: "idle" };
  const health = await invoke<{ ahead: number; uncommitted: boolean }>("workspace_health", { id: ws.id }).catch(() => null);
  if (health && health.ahead > 0) return { text: "做完了，等你评审、保存进项目", tone: "done" };
  if (ws.mergedAt && health?.ahead === 0) return { text: "已保存进项目", tone: "idle" };
  return { text: live ? "这一轮说完了，等你看" : "停下了，没看到新的改动", tone: "idle" };
}
