/**
 * 工作台「拆成几路做」（2026-11-03 用户拍板：协调对话并进工作台）：取项目概况 → 无头调用一次 AI 写方案 → 落盘 `.ccode/split-plan.md`。
 * 连接用项目默认的那个（与批准后各路开工同一个）；那家不支持无头调用时退回设置里「AI 功能」的连接。
 * 只有能一次开几路目标的项目（无流程科研、工作项目）才有这个入口——有流程的科研与编程批不了方案。
 */
import { invoke } from "@tauri-apps/api/core";
import { buildSplitPrompt, readSplitReply, type SplitReply } from "./split-plan";
import { goalDefaultProfile } from "./project-agents";
import { samePath } from "./path-utils";
import { IS_WINDOWS } from "./hotkeys";
import { useAppStore } from "./store";
import type { ProjectConfigReadDto, ProjectDto } from "./types";

export async function splitEligibility(projectPath: string): Promise<{ project: ProjectDto | null; eligible: boolean }> {
  const list = await invoke<ProjectDto[]>("list_projects").catch(() => [] as ProjectDto[]);
  const project = list.find((x) => samePath(x.path, projectPath, IS_WINDOWS)) ?? null;
  if (project?.workMode === "office") return { project, eligible: true };
  if (project?.workMode !== "research") return { project, eligible: false };
  const read = await invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath }).catch(() => null);
  return { project, eligible: Boolean(read && read.config.steps.length === 0 && read.config.pipelineOptOut === true) };
}

/** 项目默认连接（事件里一次性读 store，不是选择器） */
export function projectDefaultProfile(project: ProjectDto | null) {
  const state = useAppStore.getState();
  const hidden = state.settings?.hiddenProfiles ?? [];
  const visible = state.profiles.filter((p) => !hidden.includes(p.id) || p.id === project?.defaultProfiles?.[p.agent]);
  return goalDefaultProfile(visible, project?.defaultAgent, project?.defaultProfiles);
}

export async function draftSplitPlan(input: {
  projectPath: string;
  projectName: string;
  project: ProjectDto | null;
  request: string;
  previous?: string;
  feedback?: string;
}): Promise<SplitReply> {
  const context = await invoke<string>("split_plan_context", { projectRoot: input.projectPath });
  const prompt = buildSplitPrompt({ ...input, context });
  const profileId = projectDefaultProfile(input.project)?.id ?? null;
  let raw: string;
  try {
    raw = await invoke<string>("ai_prompt", { profileId, fnKey: "split-plan", prompt });
  } catch (reason) {
    if (!profileId || !String(reason).includes("不支持无头调用")) throw reason;
    raw = await invoke<string>("ai_prompt", { profileId: null, fnKey: "split-plan", prompt });
  }
  const reply = readSplitReply(raw);
  if (reply.kind === "plan") await invoke("split_plan_write", { projectRoot: input.projectPath, text: reply.text });
  return reply;
}

/** 拒拆 / 没按格式时给人看的一句 */
export function replyNotice(reply: SplitReply): string | null {
  if (reply.kind === "no-split") return `AI 建议不拆：${reply.reason || "这件事按顺序做更好"}`;
  if (reply.kind === "bad") return "AI 没按方案格式回，没存。换个说法再试一次。";
  return null;
}
