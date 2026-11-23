import test from "node:test";
import assert from "node:assert/strict";
import {
  answerWithFollowUp,
  customPlaceholderFor,
  isSettingOptionHidden,
  parseSettingLine,
} from "../src/setting-choices.ts";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

test("短选项画成点选，说明 / 示例照旧输入框", () => {
  assert.deepEqual(parseSettingLine("综述深度：（标准档 / 严格检索档）").options, ["标准档", "严格检索档"]);
  assert.deepEqual(parseSettingLine("去向：（投期刊 / 毕业论文一章 / 课程作业）").options, ["投期刊", "毕业论文一章", "课程作业"]);
  assert.equal(parseSettingLine("目标期刊：（冲高一档 / 求稳妥投；决定字数与格式）").options, null);
  assert.equal(parseSettingLine("学位类型与学校模板：（如 硕士 / 校内 LaTeX 模板）").options, null);
  assert.equal(parseSettingLine("答辩时间：（倒推各章节的截止）").options, null);
  assert.equal(parseSettingLine("答辩时间：（倒推各章节的截止）").q, "答辩时间");
});

test("英文综述：去向排第一，六项都是点选，读者档面向科研综述", () => {
  const review = PIPELINE_TEMPLATES.find((t) => t.id === "review")!;
  const fields = review.projectSettings!.map(parseSettingLine);
  assert.equal(fields.length, 6);
  assert.equal(fields[0].q, "去向");
  for (const f of fields) assert.ok(f.options, `${f.q} 应是点选`);
  const audience = fields.find((f) => f.q === "读者与文风")!;
  assert.deepEqual(audience.options, ["偏同行专家", "跨领域与入门读者"]);
});

test("追问只在命中对应选项且有内容时并进答案", () => {
  assert.equal(answerWithFollowUp("去向", "投期刊", "Chemical Reviews"), "投期刊（目标期刊：Chemical Reviews）");
  assert.equal(answerWithFollowUp("去向", "投期刊", "  "), "投期刊");
  assert.equal(answerWithFollowUp("去向", "课程作业", "Chemical Reviews"), "课程作业");
  assert.equal(
    answerWithFollowUp("综述角度", "聚焦某个子问题", "酸性介质下非贵金属催化剂稳定性"),
    "聚焦某个子问题（具体：酸性介质下非贵金属催化剂稳定性）",
  );
  assert.equal(answerWithFollowUp("综述角度", "聚焦某个子问题", " "), "聚焦某个子问题");
  assert.equal(answerWithFollowUp("综述角度", "领域全景", "x"), "领域全景");
});

test("非期刊去向隐藏目标篇幅的「按期刊要求」", () => {
  assert.equal(isSettingOptionHidden("目标篇幅", "按期刊要求", { 去向: "" }), false);
  assert.equal(isSettingOptionHidden("目标篇幅", "按期刊要求", { 去向: "投期刊" }), false);
  assert.equal(isSettingOptionHidden("目标篇幅", "按期刊要求", { 去向: "毕业论文一章" }), true);
  assert.equal(isSettingOptionHidden("目标篇幅", "按期刊要求", { 去向: "课程作业" }), true);
  assert.equal(isSettingOptionHidden("目标篇幅", "约 4000 词", { 去向: "课程作业" }), false);
});

test("自定义输入框按题给针对性提示，未配置时回落默认提示", () => {
  assert.match(customPlaceholderFor("文献数据抽取表"), /催化剂/);
  assert.match(customPlaceholderFor("综述角度"), /原位表征/);
  assert.equal(customPlaceholderFor("未知题"), "写你自己的答案");
});
