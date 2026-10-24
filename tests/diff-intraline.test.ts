import assert from "node:assert/strict";
import test from "node:test";
import { hunkLabel, intralineRanges, pairIntraline, parseHunkHeader } from "../src/diff-intraline.ts";

test("块头：@@ 原样换成「第 N 行 · 上下文」，纯删除块退回旧行号", () => {
  assert.deepEqual(parseHunkHeader("@@ -339,10 +340,11 @@ Mesa 工作台"), {
    oldStart: 339,
    newStart: 340,
    context: "Mesa 工作台",
  });
  assert.deepEqual(hunkLabel("@@ -339,10 +340,11 @@ Mesa 工作台"), { line: "第 340 行", context: "Mesa 工作台" });
  assert.deepEqual(hunkLabel("@@ -5 +0,0 @@"), { line: "第 5 行", context: "" });
  assert.deepEqual(hunkLabel("不是块头"), { line: "不是块头", context: "" });
});

test("行内：只标改了的那一段；整句重写不标；表情等代理对字符按码点算", () => {
  const r = intralineRanges("打开 Mesa 的首页。左边是你手上正在做的工作", "打开 Mesa 的首页。左边是你正在做的工作")!;
  assert.equal("打开 Mesa 的首页。左边是你手上正在做的工作".slice(...r.old), "手上");
  assert.deepEqual(r.new, [r.new[0], r.new[0]], "新行里是纯删除，区间为空");
  assert.equal(intralineRanges("完全不一样的一句话", "abcdefghijk"), null);
  assert.equal(intralineRanges("同一行", "同一行"), null);
  const e = intralineRanges("看 😀 这里", "看 😀 那里")!;
  assert.equal("看 😀 这里".slice(...e.old), "这");
  assert.equal("看 😀 那里".slice(...e.new), "那");
});

test("配对：连续删紧跟同样条数的加才逐行配，条数不同不配；返回的是去掉前缀后的区间", () => {
  const lines = [" 上下文", "-**待你处理 / 待你验收**", "+**待你处理 / 待你验收 / 定时任务**", " 上下文", "-一", "-二", "+合并"];
  const m = pairIntraline(lines);
  assert.ok(!m.has(1), "旧行是纯插入，没有可标的字");
  assert.equal(lines[2].slice(1).slice(...m.get(2)!), " / 定时任务");
  assert.ok(!m.has(4) && !m.has(5) && !m.has(6), "两删一加不配对");
});
