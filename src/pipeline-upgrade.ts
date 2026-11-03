import type { PipelineTemplateDef } from "./pipeline-presets";
import type { ProjectStepDto } from "./types";

/** 匹配仅用于提出更新候选，不自动改写已有项目。名称与工作区必须同时一致。 */
export function pipelineUpgradeCandidates(current: ProjectStepDto[], template: PipelineTemplateDef) {
  return current.flatMap((step, index) => {
    const proposed = template.steps.find((s) => s.name === step.name && s.workspaceName === step.workspaceName);
    if (!proposed) return [];
    const fields = (["brief", "expectedArtifacts", "inputs", "optionalInputs", "anyOfInputs", "acceptanceCriteria", "run", "skills", "requiredSkills", "humanTasks", "decisionMode", "decisions", "fanOut"] as const)
      .filter((key) => JSON.stringify(step[key] ?? null) !== JSON.stringify(proposed[key] ?? null));
    return fields.length ? [{ index, current: step, proposed, fields }] : [];
  });
}
