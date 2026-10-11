// 全量扫描：默认工具（markdown/none/python/none）下所有模板步骤的占位可解析性
import { PIPELINE_TEMPLATES, pipelineStepsForTemplate } from "../src/pipeline-presets.ts";
import { DEFAULT_RESEARCH_TOOLS, withResearchTools } from "../src/research-tools.ts";
import { resolveSkillRefs } from "../src/skill-slots.ts";

let total = 0;
let bad = 0;
for (const tpl of PIPELINE_TEMPLATES) {
  const modes: Array<[string, number]> = tpl.id === "submission-rebuttal"
    ? [["initial", 1], ["revision", 1], ["revision", 3]]
    : [["initial", 1]];
  for (const [mode, round] of modes) {
    const steps = pipelineStepsForTemplate(tpl, mode as "initial", round);
    for (const step of steps) {
      total++;
      const withTools = withResearchTools(step, DEFAULT_RESEARCH_TOOLS);
      const r = resolveSkillRefs(withTools.brief, withTools.skills, undefined);
      if (r.unresolved.length > 0) {
        bad++;
        console.log(`模板 ${tpl.id} [${mode}r${round}] 步骤「${step.name}」: 未解析 ${[...new Set(r.unresolved)].join(", ")} / skills=[${withTools.skills.join(", ")}]`);
      }
    }
  }
}
console.log(`默认工具下共 ${total} 步，${bad} 步存在未解析占位`);
