// 端到端：renderTaskMd 落盘内容检查（走真实拼装函数，非手搓模拟）
import { PIPELINE_TEMPLATES, pipelineStepsForTemplate } from "../src/pipeline-presets.ts";
import { DEFAULT_RESEARCH_TOOLS, withResearchTools } from "../src/research-tools.ts";
import { renderTaskMd } from "../src/task-md.ts";
import type { ProjectConfigDto, ProjectStepDto } from "../src/types.ts";

const cfg = {
  topic: "测试课题",
  settings: [],
  workMode: "both",
  rulesOwned: [],
  resources: [],
  litSource: "search",
  artifactDir: "artifacts",
  steps: [],
} as unknown as ProjectConfigDto;

const tpl = PIPELINE_TEMPLATES.find((t) => t.id === "submission-rebuttal")!;

function run(label: string, step: ProjectStepDto, manuscript: string) {
  const s = withResearchTools(step, { ...DEFAULT_RESEARCH_TOOLS, manuscript } as never);
  const md = renderTaskMd(s, cfg, "/tmp/proj");
  const tokens = [...new Set(md.match(/\{skill:[a-z0-9-]+\}/g) ?? [])];
  console.log(`[${label}] 本步骤技能: ${s.skills.join(", ")}`);
  console.log(`  TASK.md 残留字面占位: ${tokens.length ? tokens.join(" ") : "（无）"}`);
  const line = md.split("\n").find((l) => l.includes("{skill:"));
  if (line) console.log(`  残留行: ${line.slice(0, 90)}…`);
}

// Word 载体 journal-format（finding 的主场景）
const jf = pipelineStepsForTemplate(tpl, "initial", 1).find((s) => s.workspaceName === "journal-format")!;
run("word/期刊格式适配", jf, "word");
run("latex/期刊格式适配", jf, "latex");
run("markdown/期刊格式适配（默认对照）", jf, "markdown");
// markdown 默认下 rebuttal（finding 称零回归的反例）
const rb = pipelineStepsForTemplate(tpl, "revision", 1)[0]!;
run("markdown/审稿意见回复r1", rb, "markdown");
