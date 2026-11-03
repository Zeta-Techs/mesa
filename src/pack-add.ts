/**
 * 把「我的任务」加进项目（2026-11-03）：流程编辑器「＋ 从模板追加」、模板库「使用」、新项目的模板选择层、草稿「装进并加到这个项目试跑」
 * 都走这里，不各自拼。先按项目的研究工具设置改步骤（withResearchTools，与内置模板追加同一口径——Zotero / EndNote 等挂载），
 * 包带的项目规则与全局设定也套上工具设置，再交后端（后端只认名字、顺序与包一致的步骤）。
 */
import { invoke } from "@tauri-apps/api/core";
import { researchToolsFromSettings, settingsWithResearchTools, withResearchTools, type ResearchTools } from "./research-tools.ts";
import type { AddPackResultDto, ProjectConfigReadDto, ProjectStepDto, SkillDto, TaskPackDto } from "./types.ts";

/** 加进项目的步骤：每一步带包 id 与参数（取值 = 人填的，没填用默认）；与后端 task_packs.rs steps_for_project 同一口径 */
export function packStepsForProject(pack: Pick<TaskPackDto, "id" | "params" | "steps">, values: Record<string, string>): ProjectStepDto[] {
  const params = pack.params.map((p) => ({ ...p, value: values[p.key] !== undefined ? values[p.key].trim() : p.value }));
  return pack.steps.map((s) => ({ ...s, pack: pack.id, params }));
}

/** 按项目的研究工具设置改步骤与项目设定（纯函数） */
export function adaptPack(
  pack: Pick<TaskPackDto, "id" | "params" | "steps" | "projectSettings">,
  values: Record<string, string>,
  tools: ResearchTools,
  artifactDir: string | undefined,
  litSource: string | undefined,
  providesByName?: Record<string, string[]>,
): { steps: ProjectStepDto[]; projectSettings: string[] } {
  return {
    steps: packStepsForProject(pack, values).map((s) => withResearchTools(s, tools, artifactDir, litSource, providesByName)),
    projectSettings: settingsWithResearchTools(pack.projectSettings ?? [], tools),
  };
}

export async function addPackToProject(opts: {
  projectPath: string;
  pack: TaskPackDto;
  values?: Record<string, string>;
  withTrigger?: boolean;
  strategy?: "append" | "replace";
  /** 导入的包：人已在确认框里看过随包文件（importedScriptsNote） */
  scriptsReviewed?: boolean;
  topic?: string | null;
  /** 新项目选择层里人刚选的工具（项目里还没存）；不给就读项目设置 */
  tools?: ResearchTools;
}): Promise<AddPackResultDto> {
  const { projectPath, pack } = opts;
  const values = opts.values ?? Object.fromEntries(pack.params.map((p) => [p.key, p.value]));
  const read = await invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath });
  const tools = opts.tools ?? researchToolsFromSettings(read.config.settings);
  const provides = await invoke<SkillDto[]>("list_skills")
    .then((lib) => Object.fromEntries(lib.map((s) => [s.name, s.provides ?? []])))
    .catch(() => undefined);
  const { steps, projectSettings } = adaptPack(pack, values, tools, read.config.artifactDir, read.config.litSource, provides);
  return invoke<AddPackResultDto>("add_task_pack_to_project", {
    projectRoot: projectPath,
    id: pack.id,
    values,
    withTrigger: opts.withTrigger ?? false,
    strategy: opts.strategy ?? "append",
    scriptsReviewed: opts.scriptsReviewed ?? false,
    steps,
    projectSettings,
    topic: opts.topic?.trim() || null,
  });
}
