// 对抗复现：验证「Word/LaTeX 载体下 journal-format/rebuttal-rN 简报占位无占据者」是否属实
import { PIPELINE_TEMPLATES, pipelineStepsForTemplate } from "../src/pipeline-presets.ts";
import { DEFAULT_RESEARCH_TOOLS, withResearchTools, type ResearchTools } from "../src/research-tools.ts";
import { resolveSkillRefs } from "../src/skill-slots.ts";
import type { ProjectStepDto } from "../src/types.ts";

const tpl = PIPELINE_TEMPLATES.find((t) => t.id === "submission-rebuttal");
if (!tpl) throw new Error("submission-rebuttal 模板不存在");

function check(label: string, steps: ProjectStepDto[], manuscript: string) {
  for (const step of steps) {
    const withTools = withResearchTools(step, { ...DEFAULT_RESEARCH_TOOLS, manuscript } as ResearchTools);
    const r = resolveSkillRefs(withTools.brief, withTools.skills, undefined);
    if (r.unresolved.length > 0) {
      console.log(`[${label}] 步骤「${step.name}」 skills=[${withTools.skills.join(", ")}]`);
      console.log(`  未解析占位: ${[...new Set(r.unresolved)].join(", ")}`);
      const sample = r.text.match(/[^\n]{0,30}\{skill:[a-z0-9-]+\}[^\n]{0,30}/g) ?? [];
      for (const s of sample) console.log(`  TASK.md 中残留: …${s}…`);
    }
  }
}

// 首投分支（journal-format 步）
for (const manuscript of ["markdown", "word", "latex"] as const) {
  check(`initial/${manuscript}`, pipelineStepsForTemplate(tpl, "initial", 1), manuscript);
}
// 返修分支（rebuttal-rN 步）
for (const manuscript of ["markdown", "word", "latex"] as const) {
  check(`revision-r2/${manuscript}`, pipelineStepsForTemplate(tpl, "revision", 2), manuscript);
}
console.log("done");
