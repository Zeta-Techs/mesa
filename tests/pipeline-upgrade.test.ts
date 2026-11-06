import assert from "node:assert/strict";
import test from "node:test";
import { bestTemplateMatch, describeUpgradeField, normalizedTemplate, pipelineUpgradeCandidates, templateUpdateNotice, UPGRADE_FIELD_LABELS } from "../src/pipeline-upgrade.ts";
import { canonicalStep } from "../src/pipeline-step-draft.ts";
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

test("pipelineUpgradeCandidates：两边按保存口径比——验收条件拆分、人工事项空落点、决策暂停缺省不算更新（2026-11-06 HER 实证）", () => {
  const tplStep = {
    ...step("检索", "s"),
    acceptanceCriteria: ["产物非空；此为交付检查", "人工验收；G1 只写摘要"],
    humanTasks: [{ title: "配 MCP", guidance: "g", timing: "before", optional: true, completion: "manual" }],
  } as unknown as ProjectStepDto;
  // 项目里存的是编辑器保存过的样子
  const saved = {
    ...step("检索", "s"),
    decisionMode: "auto_continue",
    decisions: [],
    acceptanceCriteria: ["产物非空", "此为交付检查", "人工验收", "G1 只写摘要"],
    humanTasks: [{ title: "配 MCP", guidance: "g", target: "", timing: "before", optional: true, completion: "manual" }],
  } as unknown as ProjectStepDto;
  assert.deepEqual(pipelineUpgradeCandidates([saved], tpl("review", [tplStep, step("精读", "n")])), []);
});

test("pipelineUpgradeCandidates：保存时丢掉的谁来做 / 分路算真差异，换回去的是模板原样", () => {
  const fanOut = { items: "papers/included.json", filter: "decision=included", key: "id", label: "title", per: 8, max: 4, own: "o", merge: "m" };
  const tplStep = { ...step("精读", "n"), role: "both", fanOut } as unknown as ProjectStepDto;
  const saved = { ...step("精读", "n"), role: undefined } as unknown as ProjectStepDto;
  const [c] = pipelineUpgradeCandidates([saved], tpl("review", [tplStep]));
  assert.deepEqual(c.fields, ["fanOut", "role"]);
  assert.equal(c.template, tplStep);
  assert.equal(describeUpgradeField("role", c.current, c.proposed).kind, "value");
  assert.deepEqual(describeUpgradeField("role", c.current, c.proposed), {
    field: "role", label: "谁来做", kind: "value", before: "主要交给 AI", after: "你和 AI 一起定",
  });
  const f = describeUpgradeField("fanOut", c.current, c.proposed);
  assert.ok(f.kind === "value" && f.before === "不分路" && f.after.includes("每路 8 篇，最多 4 路"));
});

test("canonicalStep：编辑器来回一趟不丢谁来做 / 分路（以前一保存就丢）", () => {
  const fanOut = { items: "a.json", filter: "", key: "id", label: "title", per: 5, max: 3, own: "o", merge: "m" };
  const s = { ...step("精读", "n"), role: "you", fanOut } as unknown as ProjectStepDto;
  const back = canonicalStep(s);
  assert.equal(back.role, "you");
  assert.deepEqual(back.fanOut, fanOut);
  const plain = canonicalStep({ ...step("x", "x"), role: "" } as unknown as ProjectStepDto);
  assert.equal("role" in plain, false);
  assert.equal("fanOut" in plain, false);
});

test("describeUpgradeField：清单列去掉 / 新增，简报只列改了的行带一行上下文", () => {
  const a = { ...step("x", "x", "一\n二\n三\n四\n五\n六"), expectedArtifacts: ["a.md", "b.md"] } as unknown as ProjectStepDto;
  const b = { ...step("x", "x", "一\n二\n三\n四改\n五\n六"), expectedArtifacts: ["b.md", "c.md"] } as unknown as ProjectStepDto;
  const list = describeUpgradeField("expectedArtifacts", a, b);
  assert.ok(list.kind === "list");
  assert.deepEqual([list.removed, list.added], [["a.md"], ["c.md"]]);
  const text = describeUpgradeField("brief", a, b);
  assert.ok(text.kind === "text");
  assert.deepEqual(
    text.lines.map((l) => `${l.kind}:${l.text}`),
    ["gap:", "same:三", "del:四", "add:四改", "same:五", "gap:"],
  );
  assert.equal(UPGRADE_FIELD_LABELS.acceptanceCriteria, "验收条件");
});
