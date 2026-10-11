// 验证：按 StepSkillsChips 提醒把 quarto-render 挂回后，下次改工具是否触发硬错误
import { PIPELINE_TEMPLATES, pipelineStepsForTemplate } from "../src/pipeline-presets.ts";
import { DEFAULT_RESEARCH_TOOLS, withResearchTools } from "../src/research-tools.ts";

const tpl = PIPELINE_TEMPLATES.find((t) => t.id === "submission-rebuttal")!;
const jf = pipelineStepsForTemplate(tpl, "initial", 1).find((s) => s.workspaceName === "journal-format")!;

// 第一次应用工具合同（word）
const applied = withResearchTools(jf, { ...DEFAULT_RESEARCH_TOOLS, manuscript: "word" } as never);
// 用户按弹层提醒挂回 quarto-render（StepSkillsChips onChange → update_step_skills）
const remounted = { ...applied, skills: [...applied.skills, "quarto-render"] };
// 之后用户改任一工具字段（如 plotting）→ setResearchTool → withResearchTools 重跑
try {
  withResearchTools(remounted, { ...DEFAULT_RESEARCH_TOOLS, manuscript: "word", plotting: "origin" } as never);
  console.log("重跑成功，无异常");
} catch (e) {
  console.log(`重跑抛错: ${String(e).slice(0, 80)}`);
}
