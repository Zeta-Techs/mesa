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
import type { ProjectConfigReadDto, ProjectDto, TaskDto, WorkspaceDto } from "./types";

export async function dispatchWorkOrder(input: { order: WorkOrder; projectPath: string; project: ProjectDto | null }): Promise<string> {
  const { order, projectPath, project } = input;
  if (order.target === "step") return dispatchToStep(order, projectPath);
  return dispatchAsGoal(order, projectPath, project);
}

async function dispatchToStep(order: WorkOrder, projectPath: string): Promise<string> {
  const n = order.step ?? 0;
  const read = await invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath });
  const step = read.config.steps[n - 1];
  if (!step) throw new Error(`这个项目没有第 ${n} 步了`);
  const workspaces = await invoke<WorkspaceDto[]>("list_workspaces");
  const ws = workspaces.find(
    (w) => w.status !== "archived" && w.name === step.workspaceName && samePath(w.repoPath, projectPath, IS_WINDOWS),
  );
  if (!ws) throw new Error(`第 ${n} 步还没开工作副本：先在项目页开始这一步，再派活`);
  const message = workOrderMessage(order);
  const { terminalRunInputs, profiles, setPendingTerminal, setPage } = useAppStore.getState();
  // 那一步的 AI 开着（不是回落的 shell）：留话，它空闲、输入框没草稿时送进对话
  const live = terminalRunInputs.find(
    (r) => r.running && !r.shell && !!r.runId && pathWithin(r.cwd, ws.worktreePath, IS_WINDOWS),
  );
  if (live?.runId) {
    await invoke("mail_send", { toRun: live.runId, text: message });
    return `已留话给第 ${n} 步的 AI，它空闲时送到`;
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
  return `已让第 ${n} 步的 AI 接着做，做完照常去评审`;
}

async function dispatchAsGoal(order: WorkOrder, projectPath: string, project: ProjectDto | null): Promise<string> {
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
  return `已记成目标「${task.name}」并开工，做完在待验收里`;
}
