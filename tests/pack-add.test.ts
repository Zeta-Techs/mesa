import assert from "node:assert/strict";
import test from "node:test";
import { adaptPack, packStepsForProject } from "../src/pack-add.ts";
import { DEFAULT_RESEARCH_TOOLS, researchToolsFromSettings } from "../src/research-tools.ts";
import { basedOnFor } from "../src/pack-builtin.ts";
import { settingsForTemplateApply, PIPELINE_TEMPLATES, pipelineStepsForTemplate } from "../src/pipeline-presets.ts";
import { withResearchTools } from "../src/research-tools.ts";
import type { TaskPackDto } from "../src/types.ts";

const review = basedOnFor("review")!;
const pack = {
  id: "pk-1",
  params: [{ key: "j", label: "期刊", value: "Nature", help: "", options: [] }],
  steps: review.steps,
  projectSettings: settingsForTemplateApply(PIPELINE_TEMPLATES.find((t) => t.id === "review")!),
} as Pick<TaskPackDto, "id" | "params" | "steps" | "projectSettings">;

test("加进项目的步骤带包 id 与参数取值，没填用默认", () => {
  const steps = packStepsForProject(pack, {});
  assert.equal(steps[0].pack, "pk-1");
  assert.equal(steps[0].params?.[0].value, "Nature");
  assert.equal(packStepsForProject(pack, { j: " Cell " })[1].params?.[0].value, "Cell");
});

test("按项目的研究工具设置改步骤，与内置模板追加同一结果；项目设定带上工具行", () => {
  const tools = { ...DEFAULT_RESEARCH_TOOLS, libraryExport: "zotero" } as typeof DEFAULT_RESEARCH_TOOLS;
  const { steps, projectSettings } = adaptPack(pack, {}, tools, "artifacts", "search");
  const builtin = pipelineStepsForTemplate(PIPELINE_TEMPLATES.find((t) => t.id === "review")!).map((s) => withResearchTools(s, tools, "artifacts", "search"));
  assert.deepEqual(steps.map((s) => s.skills), builtin.map((s) => s.skills));
  assert.ok(steps.some((s) => s.skills.includes("zotero-sync")), "Zotero 挂上了");
  assert.deepEqual(researchToolsFromSettings(projectSettings), tools);
  for (const line of pack.projectSettings) assert.ok(projectSettings.includes(line), line);
});
