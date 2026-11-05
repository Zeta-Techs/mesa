import assert from "node:assert/strict";
import test from "node:test";
import { bestTemplateMatch, normalizedTemplate, pipelineUpgradeCandidates, templateUpdateNotice } from "../src/pipeline-upgrade.ts";
import type { PipelineTemplateDef } from "../src/pipeline-presets.ts";
import type { ProjectStepDto } from "../src/types.ts";

const step = (name: string, ws: string, brief = "b"): ProjectStepDto =>
  ({ name, workspaceName: ws, brief, role: "both", skills: [], expectedArtifacts: [], inputs: [], run: [], humanTasks: [] }) as unknown as ProjectStepDto;
const tpl = (id: string, steps: ProjectStepDto[]) => ({ id, name: id, steps }) as unknown as PipelineTemplateDef;

test("bestTemplateMatch：步骤名 + 工作区名对上最多的那套，至少两步", () => {
  const review = tpl("review", [step("检索", "s"), step("精读", "n"), step("大纲", "o")]);
  const paper = tpl("paper", [step("检索", "s"), step("实验", "e")]);
  assert.equal(bestTemplateMatch([step("检索", "s"), step("精读", "n")], [paper, review])?.id, "review");
  assert.equal(bestTemplateMatch([step("检索", "s")], [paper, review]), null);
  assert.equal(bestTemplateMatch([step("检索", "x"), step("精读", "y")], [review]), null);
});

test("templateUpdateNotice：有差异才提示；按项目换算后一致的不报；同一批更新签名稳定", () => {
  const review = tpl("review", [step("检索", "s", "新"), step("精读", "n", "新"), step("大纲", "o", "旧")]);
  const current = [step("检索", "s", "旧"), step("精读", "n", "新"), step("大纲", "o", "旧")];
  const notice = templateUpdateNotice(current, [review]);
  assert.deepEqual(notice?.steps, ["检索"]);
  assert.equal(notice?.signature, templateUpdateNotice(current, [review])?.signature);
  // 项目里的步骤是模板按研究工具换算后保存的：换算后一致就不报
  const saved = [step("检索", "s", "新+工具"), step("精读", "n", "新"), step("大纲", "o", "旧")];
  const normalize = (s: ProjectStepDto) => (s.name === "检索" ? { ...s, brief: `${s.brief}+工具` } : s);
  assert.equal(templateUpdateNotice(saved, [review], normalize), null);
  // 换算抛错时按原样比，不挡
  assert.ok(templateUpdateNotice(current, [review], () => { throw new Error("x"); }));
});

test("normalizedTemplate：编辑器的「检查更新」与提示同一口径——换算后一致的步骤不列差异", () => {
  const review = tpl("review", [step("检索", "s", "新"), step("精读", "n", "新")]);
  const saved = [step("检索", "s", "新+工具"), step("精读", "n", "新")];
  const normalize = (s: ProjectStepDto) => (s.name === "检索" ? { ...s, brief: `${s.brief}+工具` } : s);
  assert.equal(pipelineUpgradeCandidates(saved, review).length, 1);
  assert.equal(pipelineUpgradeCandidates(saved, normalizedTemplate(review, normalize)).length, 0);
  assert.equal(normalizedTemplate(review), review);
});
