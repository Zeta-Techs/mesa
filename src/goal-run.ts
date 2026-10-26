/** 普通目标/「验收后写入」开聊的共享启动链（审计 §4.10）：
 * 拼上下文 → task_prepare_run（开工即冻结基线与上下文快照）→ 终端请求公共字段。
 * 页面只负责挑 profile 和补自己的终端字段（model、预览等），不再各写一遍流程。 */
import { invoke } from "@tauri-apps/api/core";
import type { RunDto, TaskDto } from "./types";
import type { PendingTerminal } from "./store";
import { loadProjectContextPack } from "./project-context-load";
import { composeLaunchPrompt } from "./project-context";
import { continueGoalPrompt } from "./project-tasks";

export interface GoalRunInput {
  projectName: string;
  projectPath: string;
  workMode?: string | null;
  task: TaskDto;
  agent: string;
  profileId: string;
  reuseIsolation?: boolean;
  feedback?: string;
  /** 目标行覆盖；缺省 = continueGoalPrompt（「验收后写入」开聊传 ""）。 */
  goalLine?: string;
  /** Context Pack 的目标字段覆盖；传 null = 不带目标（无明确目标的对话）。 */
  packGoal?: string | null;
}

/** 先拼上下文再开工：开工一刻的 contextText 就是实际下发文本（冻结凭证）。 */
export async function prepareGoalRun(
  input: GoalRunInput,
): Promise<{ run: RunDto; prompt: string }> {
  if (!input.reuseIsolation) {
    const estimate = await invoke<{ files: number; bytes: number; allowed: boolean }>("task_input_estimate", { taskId: input.task.id });
    if (!estimate.allowed) throw new Error(`资料 ${estimate.files} 个文件、${(estimate.bytes / 1024 / 1024).toFixed(1)} MB，超过隔离输入预算，尚未复制或启动。还没开始过的目标可在「详情 → 编辑」里改成指定资料再开始。`);
  }
  const goal = input.task.description?.trim() || input.task.name;
  const pack = await loadProjectContextPack({
    name: input.projectName,
    path: input.projectPath,
    workMode: input.workMode,
    goal: input.packGoal === null ? undefined : (input.packGoal ?? goal),
    writeReview: input.task.reviewRequired,
    feedback: input.feedback,
    goalSkills: input.task.skills ?? [],
    kind: "goal",
  });
  const prompt = composeLaunchPrompt(
    pack,
    input.goalLine ?? continueGoalPrompt(goal, input.feedback ?? ""),
  );
  const run = await invoke<RunDto>("task_prepare_run", {
    input: {
      taskId: input.task.id,
      agent: input.agent,
      profileId: input.profileId,
      reuseIsolation: input.reuseIsolation ?? false,
      feedback: input.feedback ?? null,
      contextText: prompt,
    },
  });
  return { run, prompt };
}

/** 目标 Run 拉起终端的公共字段；页面在此之上补 model/预览等自己的字段。 */
export function goalRunTerminalFields(
  task: TaskDto,
  run: RunDto,
  prompt: string,
): Partial<PendingTerminal> & Pick<PendingTerminal, "cwd"> {
  return {
    cwd: run.isolationPath,
    autoStart: true,
    permission: task.reviewRequired ? "write_tree" : "discuss",
    // 不验收的目标：只讨论是约定，计划模式写完方案也不在这里开工（store.PendingTerminal.discussOnly）
    discussOnly: task.reviewRequired ? undefined : true,
    initialPrompt: prompt,
    reuseKey: `task:${task.id}`,
    runId: run.id,
    taskId: task.id,
  };
}
