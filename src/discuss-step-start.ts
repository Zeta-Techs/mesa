/**
 * 商量任务书的对话 → 回那一步点「开始」（2026-11-12 用户：AI 说「可以在 Mesa 点「开始」」，点这个字直接去开工）。
 * 商量对话的标签复用键是 `discuss:<项目根>:<任务书相对路径>`（StepFlow 开聊时写，随标签持久化），
 * 从它认出是哪个项目、哪份任务书；步骤名优先用标签上记着的，重启后没有了就按任务书路径反查。
 * 跳过去只是打开开工确认弹层（和步骤卡上的「开始」同一条路），不替人开工。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store";
import { toast } from "./toast";
import type { ProjectConfigReadDto } from "./types";
import { parseDiscussReuseKey } from "./discuss-prompt";

/** 按任务书路径找步骤：标签记着的步骤名还在就用它，否则逐步问后端它的任务书在哪 */
async function findStep(projectRoot: string, relPath: string, hint: string | null): Promise<{ name: string; index: number } | null> {
  const cfg = await invoke<ProjectConfigReadDto>("read_project_config", { path: projectRoot }).catch(() => null);
  const steps = cfg?.config.steps ?? [];
  const byHint = hint ? steps.findIndex((s) => s.name === hint) : -1;
  if (byHint >= 0) return { name: steps[byHint].name, index: byHint };
  for (let index = 0; index < steps.length; index++) {
    const d = await invoke<{ relPath: string }>("read_task_draft", { projectRoot, stepName: steps[index].name }).catch(() => null);
    if (d?.relPath === relPath) return { name: steps[index].name, index };
  }
  return null;
}

export async function goStartDiscussedStep(input: { reuseKey: string; stepName?: string | null }): Promise<void> {
  const parsed = parseDiscussReuseKey(input.reuseKey);
  if (!parsed) return;
  const step = await findStep(parsed.projectRoot, parsed.relPath, input.stepName ?? null);
  if (!step) {
    toast("项目里找不到这份任务书对应的步骤了，到项目页自己点「开始」吧", "warning");
    return;
  }
  const s = useAppStore.getState();
  const token = Date.now();
  s.setStepStartReq({ projectRoot: parsed.projectRoot, stepName: step.name, token });
  s.setSelectProjectReq(parsed.projectRoot);
  s.setProjectFocusReq({ projectRoot: parsed.projectRoot, focus: "step", stepIndex: step.index, token });
  s.setPage("workspaces");
}
