import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SESSION_TEMPLATE } from "../src/project-context.ts";
import {
  BASICS_BLOCK,
  SECTION_KEYS,
  coerceSimpleTemplate,
  parseSimpleTemplate,
  sectionSummary,
  serializeSimpleTemplate,
} from "../src/session-template-blocks.ts";

test("默认模板 = 基本信息 + 八段全勾 + 无补充，拼回与原文一致", () => {
  const simple = parseSimpleTemplate(DEFAULT_SESSION_TEMPLATE);
  assert.deepEqual(simple, { basics: true, sections: [...SECTION_KEYS], extra: "" });
  assert.equal(serializeSimpleTemplate(simple!), DEFAULT_SESSION_TEMPLATE);
});

test("取消勾选与补充一段话：内容段按标准顺序写出，补充放最后", () => {
  const text = serializeSimpleTemplate({
    basics: true,
    sections: ["项目规则", "课题主题"],
    extra: "回答用中文；改代码前先列计划。\n\n项目叫 {{项目名}}。",
  });
  assert.equal(
    text,
    `${BASICS_BLOCK}\n\n{{课题主题}}\n\n{{项目规则}}\n\n回答用中文；改代码前先列计划。\n\n项目叫 {{项目名}}。`,
  );
  assert.deepEqual(parseSimpleTemplate(text), {
    basics: true,
    sections: ["课题主题", "项目规则"],
    extra: "回答用中文；改代码前先列计划。\n\n项目叫 {{项目名}}。",
  });
  assert.equal(serializeSimpleTemplate({ basics: false, sections: [], extra: "  " }), "");
  assert.deepEqual(parseSimpleTemplate(""), { basics: false, sections: [], extra: "" });
  // 只写补充话（不带任何项目信息）也能来回
  assert.deepEqual(parseSimpleTemplate("只说这一句。"), { basics: false, sections: [], extra: "只说这一句。" });
});

test("放不进勾选形状的手工模板返回 null；硬转只丢顺序不丢字", () => {
  for (const template of [
    "{{项目规则}}\n\n{{课题主题}}", // 顺序打乱
    "开头的话\n\n{{项目规则}}", // 文字在内容段前面
    "{{项目规则}}\n\n中间一句\n\n{{已验收}}", // 文字夹在中间
    "{{项目规则}}\n\n{{项目规则}}", // 重复
  ]) {
    assert.equal(parseSimpleTemplate(template), null, template);
  }
  assert.deepEqual(coerceSimpleTemplate("开头的话\n\n{{已验收}}\n\n中间一句\n\n{{课题主题}}"), {
    basics: false,
    sections: ["课题主题", "已验收"],
    extra: "开头的话\n\n中间一句",
  });
  assert.deepEqual(coerceSimpleTemplate(`{{项目规则}}\n\n${BASICS_BLOCK}`), {
    basics: true,
    sections: ["项目规则"],
    extra: "",
  });
});

test("内容段摘要：去段头和列表符号，空段说明会省略", () => {
  assert.deepEqual(sectionSummary("项目规则：\n1. 不要虚构文献。\n2. 引用要能追溯。"), {
    text: "2 条：不要虚构文献。 · 引用要能追溯。",
    empty: false,
  });
  assert.deepEqual(sectionSummary("课题主题：\nHER硼化物"), { text: "HER硼化物", empty: false });
  assert.deepEqual(sectionSummary("技能纪律：按用户这次说的做。", "技能纪律"), { text: "按用户这次说的做。", empty: false });
  assert.deepEqual(sectionSummary(""), { text: "当前为空，开对话时省略", empty: true });
});
