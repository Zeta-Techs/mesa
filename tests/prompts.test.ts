import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPrompt, filterPrompts, moveId, promptLabel, promptPreview, type PromptItem } from "../src/prompts.ts";

const p = (id: string, title: string, body: string): PromptItem => ({ id, title, body, updatedAt: 0 });

test("promptLabel / promptPreview：没起名拿第一行当名字，预览从下一行起", () => {
  assert.equal(promptLabel(p("1", " 润色 ", "帮我润色")), "润色");
  assert.equal(promptLabel(p("1", "", "\n  先读 TASK.md\n再动手")), "先读 TASK.md");
  assert.equal(promptLabel(p("1", "", "一".repeat(30))), `${"一".repeat(24)}…`);
  assert.equal(promptPreview(p("1", "", "先读 TASK.md\n 再动手 \n\n最后汇报")), "再动手 最后汇报");
  assert.equal(promptPreview(p("1", "读任务书", "先读 TASK.md\n再动手")), "先读 TASK.md 再动手");
});

test("filterPrompts：名称前缀在前，再是名称或正文包含，组内保持原顺序", () => {
  const list = [p("a", "代码审查", "看看有没有 bug"), p("b", "润色", "帮我把这段审查意见写顺"), p("c", "审查清单", "逐条")];
  assert.deepEqual(filterPrompts(list, "审查").map((x) => x.id), ["c", "a", "b"]);
  assert.deepEqual(filterPrompts(list, "BUG").map((x) => x.id), ["a"]);
  assert.deepEqual(filterPrompts(list, "").map((x) => x.id), ["a", "b", "c"]);
  assert.equal(filterPrompts(list, "", 2).length, 2);
  assert.deepEqual(filterPrompts(list, "没有这个"), []);
});

test("applyPrompt：斜杠时整段替换，菜单时空框直接填、有字另起一行", () => {
  assert.equal(applyPrompt("/审查", "正文", true), "正文");
  assert.equal(applyPrompt("", "正文", false), "正文");
  assert.equal(applyPrompt("  \n", "正文", false), "正文");
  assert.equal(applyPrompt("先说一句  \n", "正文", false), "先说一句\n正文");
});

test("moveId：上下移一位，越界不动", () => {
  assert.deepEqual(moveId(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveId(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.deepEqual(moveId(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
  assert.deepEqual(moveId(["a", "b", "c"], "x", 1), ["a", "b", "c"]);
});
