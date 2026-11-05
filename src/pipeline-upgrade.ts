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

/** 项目像哪套内置模板：按「步骤名 + 工作区名」都一致的步数取最多的，至少两步对上才算（项目不记模板 id）。 */
export function bestTemplateMatch(current: ProjectStepDto[], templates: PipelineTemplateDef[]): PipelineTemplateDef | null {
  let best: PipelineTemplateDef | null = null;
  let bestHits = 1;
  for (const t of templates) {
    const hits = current.filter((s) => t.steps.some((p) => p.name === s.name && p.workspaceName === s.workspaceName)).length;
    if (hits > bestHits) {
      best = t;
      bestHits = hits;
    }
  }
  return best;
}

/** 已有项目的「内置模板有更新」提示（综述回路三期 §13-6：提示升级，人点了才改）。
 *  normalize 把模板步骤按本项目的研究工具设置换算成保存时的样子（编辑器保存前都过 withResearchTools），
 *  否则每个项目都会被误报。signature 用于「不用了」之后同一批更新不再提示。 */
export function templateUpdateNotice(
  current: ProjectStepDto[],
  templates: PipelineTemplateDef[],
  normalize?: (step: ProjectStepDto) => ProjectStepDto,
): { templateId: string; templateName: string; steps: string[]; signature: string } | null {
  const t = bestTemplateMatch(current, templates);
  if (!t) return null;
  const steps = normalize
    ? t.steps.map((s) => {
        try {
          return normalize(s);
        } catch {
          return s;
        }
      })
    : t.steps;
  const changes = pipelineUpgradeCandidates(current, { ...t, steps });
  if (changes.length === 0) return null;
  const text = JSON.stringify(changes.map((c) => [c.current.name, c.proposed]));
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return {
    templateId: t.id,
    templateName: t.name,
    steps: changes.map((c) => c.current.name),
    signature: `${t.id}:${h.toString(36)}`,
  };
}
