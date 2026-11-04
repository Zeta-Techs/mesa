import test from "node:test";
import assert from "node:assert/strict";
import { answerWithFollowUp, parseSettingLine } from "../src/setting-choices.ts";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

test("短选项画成点选，说明 / 示例照旧输入框", () => {
  assert.deepEqual(parseSettingLine("综述深度：（标准档 / 严格检索档）").options, ["标准档", "严格检索档"]);
  assert.deepEqual(parseSettingLine("去向：（投期刊 / 毕业论文一章 / 课程作业）").options, ["投期刊", "毕业论文一章", "课程作业"]);
  assert.equal(parseSettingLine("目标期刊：（冲高一档 / 求稳妥投；决定字数与格式）").options, null);
  assert.equal(parseSettingLine("学位类型与学校模板：（如 硕士 / 校内 LaTeX 模板）").options, null);
  assert.equal(parseSettingLine("答辩时间：（倒推各章节的截止）").options, null);
  assert.equal(parseSettingLine("答辩时间：（倒推各章节的截止）").q, "答辩时间");
});

test("英文综述：去向排第一，五项都是点选", () => {
  const review = PIPELINE_TEMPLATES.find((t) => t.id === "review")!;
  const fields = review.projectSettings!.map(parseSettingLine);
  assert.equal(fields[0].q, "去向");
  for (const f of fields) assert.ok(f.options, `${f.q} 应是点选`);
});

test("选投期刊才把目标期刊并进答案", () => {
  assert.equal(answerWithFollowUp("去向", "投期刊", "Chemical Reviews"), "投期刊（目标期刊：Chemical Reviews）");
  assert.equal(answerWithFollowUp("去向", "投期刊", "  "), "投期刊");
  assert.equal(answerWithFollowUp("去向", "课程作业", "Chemical Reviews"), "课程作业");
  assert.equal(answerWithFollowUp("综述角度", "领域全景", "x"), "领域全景");
});
