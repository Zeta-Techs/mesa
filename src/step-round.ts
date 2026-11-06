/**
 * 在某一步「开一轮」的共同编排（2026-11-06 流程贯通，design-flow-weave.md）：找工作副本 → 收起了就恢复 →
 * 拦在忙的 / 有没保存产出的 → 并入项目最新内容 → 开对话 → 记轮次。步骤卡上的「退回上一步补料…」「跟进上游的新增」、
 * 项目助手的补料单、补料链自动往下跟进都走这里，不各写一套。调 invoke，无单测（纯逻辑在 step-loop.ts）。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store";
import { IS_WINDOWS } from "./hotkeys";
import { samePath } from "./path-utils";
import { buildWorkspaceTerminalRequest } from "./pipeline-start";
import { stepSlotKey, taskBindingLaunch } from "./project-agents";
import { stepFillsAnySlot, type SkillProvides } from "./skill-slots";
import { bringLatest, stepBusy, type ConfirmFn } from "./step-latest";
import { reworkPrompt, withLatestNote, type ReworkDto } from "./step-loop";
import type { ProjectStepDto, WorkspaceDto, WorkspaceHealthDto } from "./types";

export type Launch = { agentId: string; profileId: string; model: string };

/** 这一步的工作副本：正在用的优先；保存过又归档的也认（回路与「几轮」要找得到它） */
export function pickStepWorkspace(workspaces: readonly WorkspaceDto[], projectPath: string, step: Pick<ProjectStepDto, "workspaceName">): WorkspaceDto | undefined {
  if (!step.workspaceName) return undefined;
  const mine = workspaces.filter((w) => w.name === step.workspaceName && samePath(w.repoPath, projectPath, IS_WINDOWS));
  return mine.find((w) => w.status === "active") ?? mine[0];
}

export async function findStepWorkspace(projectPath: string, step: Pick<ProjectStepDto, "workspaceName">): Promise<WorkspaceDto | undefined> {
  return pickStepWorkspace(await invoke<WorkspaceDto[]>("list_workspaces"), projectPath, step);
}

/** 归档了的先恢复（不清保存时间，恢复后仍算已完成），返回恢复后的工作区 */
export async function ensureActive(ws: WorkspaceDto, stepName: string): Promise<WorkspaceDto> {
  if (ws.status === "active") return ws;
  await invoke("restore_workspace", { id: ws.id });
  const list = await invoke<WorkspaceDto[]>("list_workspaces");
  const back = list.find((w) => w.id === ws.id && w.status === "active");
  if (!back) throw new Error(`「${stepName}」的工作副本恢复后没找到，刷新页面再试。`);
  return back;
}

/** 开一轮之前的共同检查：AI 正在干活 / 等确认、有没保存的产出都不叠一轮。
 *  只是开着、停在提示符上的标签不拦：新一轮按工作区复用键就地换掉它 */
export async function assertRoundable(ws: WorkspaceDto, stepName: string): Promise<void> {
  if (stepBusy(ws)) {
    throw new Error(`「${stepName}」的 AI 正在干活或等你确认：等它这一轮做完（或在侧栏那段对话的 ⋯ 里停下这一步），再开这一轮。`);
  }
  const h = await invoke<WorkspaceHealthDto>("workspace_health", { id: ws.id });
  if (h.ahead > 0) {
    throw new Error(`「${stepName}」还有没保存进项目的产出：先去那一步评审，保存或退回修改后再开这一轮。`);
  }
}

/** 这一步在 Agent 分工里绑的连接；没绑返回 null（开对话时按这个工作区上次用的预填） */
export async function boundStepLaunch(projectPath: string, stepName: string): Promise<Launch | null> {
  try {
    const b = await invoke<{ profile: string; model?: string | null } | null>("get_project_agent_binding", {
      projectRoot: projectPath,
      slot: stepSlotKey(stepName),
    });
    return taskBindingLaunch(useAppStore.getState().profiles, b);
  } catch {
    return null;
  }
}

/** 在工作副本里另开一段对话（不 resume），开场就是 prompt。同一步只有一个终端标签：闲着的旧标签就地换成新一轮 */
export async function launchRound(ws: WorkspaceDto, title: string, prompt: string, launch: Launch | null): Promise<void> {
  const req = await buildWorkspaceTerminalRequest(ws, prompt, { autoStart: true, stepLaunch: launch });
  const { setPendingTerminal, setPage } = useAppStore.getState();
  setPendingTerminal(
    launch
      ? {
          cwd: req.cwd,
          extraEnv: req.extraEnv,
          title: req.title || title,
          reuseKey: req.reuseKey,
          agentId: launch.agentId,
          profileId: launch.profileId,
          model: launch.model,
          initialPrompt: prompt,
          autoStart: true,
        }
      : { ...req, title: req.title || title, resume: undefined, focusSession: undefined, initialPrompt: prompt },
  );
  setPage("terminal");
}

/** 记一轮（补料 / 跟进 / 新开一轮 / 跟进确认无事）；真开了新一轮时清掉这一步手动打的勾，回到按落点检测 */
export async function recordRound(
  projectPath: string,
  ws: WorkspaceDto,
  step: string,
  kind: "rework" | "followup" | "fresh" | "ack",
  reworkId?: string,
): Promise<void> {
  const clear =
    kind === "ack" ? Promise.resolve() : invoke("clear_human_task_checks", { projectRoot: projectPath, step }).catch(() => undefined);
  await Promise.all([
    clear,
    invoke("step_round_record", {
      root: projectPath,
      entry: { workspaceId: ws.id, step, kind, reworkId: reworkId ?? null, at: "" },
    }).catch(() => undefined),
  ]);
}

/** 退回目标是找文献 / 读文献的步骤吗（按技能槽认，引擎不认模板）：决定开场指令是「补料」还是「修改」 */
export function litKind(step: Pick<ProjectStepDto, "skills">, provides: SkillProvides): { isSearch: boolean; isNotes: boolean } {
  return {
    isSearch: stepFillsAnySlot(step.skills, ["lit-search"], provides),
    isNotes: stepFillsAnySlot(step.skills, ["lit-notes"], provides),
  };
}

export interface ReworkSend {
  projectPath: string;
  fromStep: string;
  target: ProjectStepDto;
  topics: string[];
  reason: string;
  clues: string;
  scale: number | null;
  provides: SkillProvides;
  /** 解析不到绑定时用的连接（步骤卡传它那条链）；null 也行，按工作区上次用的预填 */
  launch: Launch | null;
  confirm: ConfirmFn;
}

/**
 * 退回上一步补料 / 修改（design-review-loop §4 + 流程贯通 §3）：恢复 → 拦 → 并入项目最新 → 写补料单 → 在上游另开一段对话 → 记轮次。
 * 返回补料单；人在并入前取消返回 null。restored 回调：恢复了工作副本但后面失败时，调用方好说清楚。
 */
export async function sendReworkRound(input: ReworkSend, onRestored?: () => void): Promise<ReworkDto | null> {
  const { target, projectPath } = input;
  const found = await findStepWorkspace(projectPath, target);
  if (!found) throw new Error(`「${target.name}」还没开过工，没有可以补的工作副本。`);
  const launch = input.launch ?? (await boundStepLaunch(projectPath, target.name));
  if (found.status !== "active") onRestored?.();
  const ws = await ensureActive(found, target.name);
  await assertRoundable(ws, target.name);
  const incoming = await bringLatest(ws, target.name, input.confirm);
  if (incoming === null) return null;
  const rework = await invoke<ReworkDto>("rework_create", {
    root: projectPath,
    draft: {
      fromStep: input.fromStep,
      toStep: target.name,
      toWorkspaceId: ws.id,
      toWorkspaceName: ws.name,
      topics: input.topics,
      reason: input.reason,
      clues: input.clues,
      scale: input.scale,
    },
  });
  const d = new Date();
  const prompt = withLatestNote(
    reworkPrompt(rework, {
      ...litKind(target, input.provides),
      projectRoot: projectPath,
      date: `${d.getMonth() + 1}-${d.getDate()}`,
    }),
    incoming,
  );
  await launchRound(ws, target.name, prompt, launch);
  await recordRound(projectPath, ws, target.name, "rework", rework.id);
  return rework;
}
