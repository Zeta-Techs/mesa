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
import { workOrderGoalText, workOrderMessage, type OrderTextOptions, type WorkOrder } from "./project-assistant";
import { builtinTaskMethod, findBuiltinTask } from "./builtin-tasks";
import { goalTextFromPack } from "./task-packs";
import { bringLatest, incomingFor, stepBusy, type ConfirmFn } from "./step-latest";
import { withLatestNote } from "./step-loop";
import { confirmDialog } from "./components/ConfirmDialog";
import type { ProjectConfigReadDto, ProjectDto, ProjectMailDto, RunDto, SkillDto, TaskDto, TaskPackDto, WorkspaceDto } from "./types";

export interface DispatchResult {
  note: string;
  mode: "mail" | "resume" | "goal";
  mailId?: string;
  taskId?: string;
  worktreePath?: string;
}

export async function dispatchWorkOrder(input: {
  order: WorkOrder;
  projectPath: string;
  project: ProjectDto | null;
  /** 并入前工作副本有没提交的文件时怎么问；null = 不问、不派（手机上派时，确认只在桌面） */
  confirm?: ConfirmFn | null;
}): Promise<DispatchResult> {
  const { order, projectPath, project } = input;
  const based = await resolveBasedOn(order.basedOn);
  const opts: OrderTextOptions = { research: project?.workMode === "research", method: based?.method ?? null };
  if (order.target === "step") return dispatchToStep(order, projectPath, opts, input.confirm === undefined ? confirmDialog : input.confirm);
  return dispatchAsGoal(order, projectPath, project, opts, based?.skills ?? []);
}

/** 「按任务」写的是内置任务还是我的任务：取出做法与它点名的技能；都对不上就只在单子里写一句「按 X 的做法」 */
async function resolveBasedOn(name: string | undefined): Promise<{ method: string; skills: string[] } | null> {
  if (!name) return null;
  const builtin = findBuiltinTask(name);
  if (builtin) return { method: builtinTaskMethod(builtin), skills: builtin.skills };
  const key = name.replace(/[「」\s]/g, "").replace(/^我的任务/, "");
  const packs = await invoke<TaskPackDto[]>("list_task_packs").catch(() => [] as TaskPackDto[]);
  const pack = packs.find((p) => p.name.replace(/\s/g, "") === key);
  if (!pack) return null;
  return {
    method: `按我的任务「${pack.name}」的做法：\n${goalTextFromPack(pack, {})}`,
    skills: [...new Set(pack.steps.flatMap((st) => st.skills ?? []))],
  };
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

async function dispatchToStep(order: WorkOrder, projectPath: string, opts: OrderTextOptions, confirm: ConfirmFn | null): Promise<DispatchResult> {
  const n = order.step ?? 0;
  const { step, ws } = await stepWorkspace(projectPath, n);
  const sent = await sendToWorkspace(projectPath, ws, step.name, workOrderMessage(order, opts), { latest: true, confirm });
  return sent.mode === "mail"
    ? { note: `已留话给第 ${n} 步的 AI，它空闲时送到`, mode: "mail", mailId: sent.mailId, worktreePath: ws.worktreePath }
    : { note: `已让第 ${n} 步的 AI 接着做，做完照常去评审`, mode: "resume", worktreePath: ws.worktreePath };
}

/**
 * 把一段话送进某个工作副本里的那段对话（派活单交给第 N 步、调度台转达你的回复共用，2026-11-06）：
 * AI 开着（不是回落的 shell）→ 留话，它空闲、输入框没草稿时送进对话；没开着 → 接回那一步上次的对话、带上这段话自动开跑（步骤绑定的连接优先）。
 * latest（派活单用）：送之前先把项目最新内容并进来（同日流程贯通 §3）；AI 正在干活或等确认时不并，留话里写明还没并入、
 * 等它停下在 Mesa 里点「继续」。转达回答（调度台）不并：那是答它刚问的，不该趁机改它手下的文件。
 */
export async function sendToWorkspace(
  projectPath: string,
  ws: WorkspaceDto,
  stepName: string | null,
  message: string,
  opts: { latest?: boolean; confirm?: ConfirmFn | null } = {},
): Promise<{ mode: "mail" | "resume"; mailId?: string }> {
  const label = stepName ?? ws.name;
  const confirm: ConfirmFn = opts.confirm === undefined ? confirmDialog : (opts.confirm ?? (async () => false));
  const refused = opts.confirm === null
    ? `没派出去：「${label}」的工作副本里有没提交的文件，要在桌面的 Mesa 里确认一起提交后才能并入新内容`
    : "没派出去：工作副本里有没提交的文件，你选了先不提交";
  const liveRun = liveRunIn(ws.worktreePath);
  if (liveRun) {
    let text = message;
    if (!opts.latest) {
      // 转达回答：原样送
    } else if (stepBusy(ws)) {
      const pending = await incomingFor(ws).catch(() => null);
      if (pending && pending.length > 0) {
        text +=
          "\n\n注意：项目里有这一步还没用上的新内容（别的步骤保存的，例如清单、笔记、大纲），你正在干活，Mesa 没有并进你的工作副本。" +
          "这件活要用到它们的话，先把手上这一轮做完停下，我在 Mesa 里点「继续」会先并进来。";
      }
    } else {
      const got = await bringLatest(ws, label, confirm, "接着做");
      if (got === null) throw new Error(refused);
      text = withLatestNote(text, got);
    }
    const mailId = await invoke<string>("mail_send", { toRun: liveRun, text });
    return { mode: "mail", mailId };
  }
  if (opts.latest) {
    const got = await bringLatest(ws, label, confirm, "接着做");
    if (got === null) throw new Error(refused);
    message = withLatestNote(message, got);
  }
  const { profiles, setPendingTerminal, setPage } = useAppStore.getState();
  const binding = stepName
    ? await invoke<{ profile: string; model?: string | null } | null>("get_project_agent_binding", {
        projectRoot: projectPath,
        slot: stepSlotKey(stepName),
      }).catch(() => null)
    : null;
  setPendingTerminal(
    await buildWorkspaceTerminalRequest(ws, message, {
      autoStart: true,
      resumeSession: true,
      stepLaunch: taskBindingLaunch(profiles, binding) ?? undefined,
    }),
  );
  setPage("terminal");
  return { mode: "resume" };
}

async function dispatchAsGoal(
  order: WorkOrder,
  projectPath: string,
  project: ProjectDto | null,
  opts: OrderTextOptions,
  taskSkills: readonly string[],
): Promise<DispatchResult> {
  if (!project) throw new Error("这个目录还没添加成项目，记不了目标");
  if (project.workMode === "coding") throw new Error("编程项目按分支开工：到项目页从基准开一条分支来做");
  const profile = projectDefaultProfile(project);
  if (!profile) throw new Error("还没有可用连接：先到连接页配一个，或在项目的 Agent 分工里定默认");
  // 单子写了依据材料就只带这些进隔离副本（省时省预算）；没写带整个项目
  const paths = order.inputs?.length
    ? taskPathsForScope("selected", order.inputs, "write_tree")
    : taskPathsForScope("whole", [], "write_tree");
  if (paths.error) throw new Error(paths.error);
  // 点名的技能只留技能库里有的（没装的点名会让开工直接失败），没装的写进提示
  const wanted = [...new Set([...(order.skills ?? []), ...taskSkills])];
  const installed = wanted.length
    ? new Set((await invoke<SkillDto[]>("list_skills").catch(() => [] as SkillDto[])).map((sk) => sk.name))
    : new Set<string>();
  const skills = wanted.filter((name) => installed.has(name));
  const missing = wanted.filter((name) => !installed.has(name));
  const task = await invoke<TaskDto>("task_create", {
    input: {
      projectRoot: projectPath,
      kind: project.workMode === "office" ? "office_doc" : "free_research",
      name: order.title,
      description: workOrderGoalText(order, opts),
      inputPaths: paths.inputPaths,
      outputPaths: paths.outputPaths,
      permission: "write_tree",
      skills,
    },
  });
  const skipped = missing.length ? `；技能库里没有 ${missing.join("、")}，这次没带` : "";
  let fallback = "";
  try {
    const { run, prompt } = await prepareGoalRun({
      projectName: project.name,
      projectPath,
      workMode: project.workMode,
      task,
      agent: profile.agent,
      profileId: profile.id,
    });
    // 根源一（2026-11-06）：派出去的目标在后台无头跑完，不开交互终端——没人盯着时不会卡在信任菜单、终端确认上；
    // 这家做不了无头写盘（或起不来）时退回终端，同一条 Run
    const headless = await runHeadless(run.id, prompt);
    if (headless === true) {
      return { note: `已记成目标「${task.name}」，在后台开工（不开终端），做完在待验收里${skipped}`, mode: "goal", taskId: task.id };
    }
    fallback = `（${headless}，改在终端里跑，没人盯着时可能停在确认上）`;
    // 终端页先挂上，才收得下开工请求
    useAppStore.getState().setPage("terminal");
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
  return { note: `已记成目标「${task.name}」并开工，做完在待验收里${skipped}${fallback}`, mode: "goal", taskId: task.id };
}

/** 后台无头跑一条刚开出来的目标 Run：成了返回 true，做不了返回原因（调用方退回终端） */
async function runHeadless(runId: string, prompt: string): Promise<true | string> {
  try {
    await invoke("task_run_headless", { runId, prompt });
    return true;
  } catch (reason) {
    return String(reason).replace(/^Error:\s*/, "");
  }
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
  /** 派活回音补到哪个阶段了（后端 assistant_echo 记） */
  echoed?: string | null;
  echoedAt?: string | null;
}

export type DispatchTone = "wait" | "live" | "done" | "fail" | "idle";
/** 值得补一句回音的阶段（2026-11-05）：做完等评审 / 验收、失败、停了；已验收只记不说 */
export type DispatchPhase = "review" | "failed" | "stopped" | "accepted";

/** 派出去的活现在怎样（卡片上实时一行、项目快照里一行）：等送达 / 在做 / 做完待评审 / 做完待验收… */
export async function dispatchStatus(
  rec: DispatchRecord,
  projectPath: string,
): Promise<{ text: string; tone: DispatchTone; phase?: DispatchPhase }> {
  if (rec.mode === "goal" && rec.taskId) {
    const task = await invoke<TaskDto | null>("task_get", { id: rec.taskId }).catch(() => null);
    if (!task) return { text: "目标找不到了（可能删了）", tone: "idle" };
    const map: Record<string, { text: string; tone: DispatchTone; phase?: DispatchPhase }> = {
      pending: { text: "记下了，还没开工", tone: "wait" },
      queued: { text: "排队中", tone: "wait" },
      running: { text: "在做", tone: "live" },
      pending_review: { text: "做完了，等你验收", tone: "done", phase: "review" },
      completed: { text: "已验收", tone: "idle", phase: "accepted" },
      failed: { text: "上次失败，需要处理", tone: "fail", phase: "failed" },
      stopped: { text: "停了，需要处理", tone: "wait", phase: "stopped" },
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
  if (health && health.ahead > 0) return { text: "做完了，等你评审、保存进项目", tone: "done", phase: "review" };
  // 派出之后又保存过才算（接回的是已保存的步骤时，旧的保存时间不能当成这件活做完了，2026-11-06）
  const savedAfter = !!ws.mergedAt && Date.parse(ws.mergedAt) > Date.parse(rec.at);
  if (savedAfter && health?.ahead === 0) return { text: "已保存进项目", tone: "idle", phase: "accepted" };
  return { text: live ? "这一轮说完了，等你看" : "停下了，没看到新的改动", tone: "idle" };
}

/**
 * 派出去的目标停了 / 失败了，接着做（2026-11-06 用户在手机上回「让他接着做」，项目助手却谎称派出去了）：
 * 同项目任务页「重试」——复用上次的隔离副本、尽量接回上次那段对话（同一家 Agent 时），不从零复制一份重跑。
 * 只接经项目助手派出去、还没清理副本的目标；这是人点的那一下（按钮或明说「接着做」）。
 */
export async function resumeDispatchedGoal(projectPath: string, project: ProjectDto | null, taskId: string): Promise<string> {
  if (!project) throw new Error("这个目录还没添加成项目");
  const task = await invoke<TaskDto | null>("task_get", { id: taskId });
  if (!task) throw new Error("那条目标找不到了（可能删了）");
  if (task.status !== "stopped" && task.status !== "failed") {
    throw new Error(task.status === "running" ? "它还在做，不用接" : `它现在的状态是「${task.status}」，接不了`);
  }
  if (task.workspaceCleared || task.storageCleanupPending) throw new Error("上次的工作副本已经清理，接不回去了：到项目页从头开始");
  const profile = (task.profileId && useAppStore.getState().profiles.find((p) => p.id === task.profileId)) || projectDefaultProfile(project);
  if (!profile) throw new Error("还没有可用连接：先到连接页配一个");
  const runs = await invoke<RunDto[]>("run_list", { projectRoot: projectPath }).catch(() => [] as RunDto[]);
  const previous = runs.filter((r) => r.taskId === task.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const { run, prompt } = await prepareGoalRun({
    projectName: project.name,
    projectPath,
    workMode: project.workMode,
    task,
    agent: profile.agent,
    profileId: profile.id,
    reuseIsolation: true,
  });
  // 同派出：先在后台无头接着做（同一个隔离副本，新开一段会话、带着上次的产物），做不了才退回终端接回上次对话
  const headless = await runHeadless(run.id, prompt);
  if (headless === true) return `已让「${task.name}」在后台接着做（接回上次的隔离副本，不开终端），做完在待验收里`;
  useAppStore.getState().setPage("terminal");
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
    resume: previous?.sessionId && previous.agent === profile.agent ? { agentId: previous.agent, sessionId: previous.sessionId } : undefined,
    ...goalRunTerminalFields(task, run, prompt),
  });
  if (!taken) throw new Error("终端页没收下开工请求，到项目页点「重试」");
  return `已让「${task.name}」接着做（接回上次的隔离副本${previous?.sessionId ? "和对话" : ""}），做完在待验收里`;
}
