import assert from "node:assert/strict";
import test from "node:test";
import {
  continueListItem,
  toggleInlineMark,
  toggleLinePrefix,
  wrapAsLink,
} from "../src/md-edit.ts";

test("toggleInlineMark：空选区插入成对标记、光标居中", () => {
  assert.deepEqual(toggleInlineMark("ab", 1, 1, "**"), {
    text: "a****b",
    selStart: 3,
    selEnd: 3,
  });
});

test("toggleInlineMark：包裹选区、选区首尾空白留在标记外", () => {
  assert.deepEqual(toggleInlineMark("a 词 b", 1, 4, "**"), {
    text: "a **词** b",
    selStart: 4,
    selEnd: 5,
  });
});

test("toggleInlineMark：已包裹 → 解除", () => {
  assert.deepEqual(toggleInlineMark("a **词** b", 4, 5, "**"), {
    text: "a 词 b",
    selStart: 2,
    selEnd: 3,
  });
});

test("toggleInlineMark：多行选区整体包裹", () => {
  const r = toggleInlineMark("x\n第一行\n第二行\ny", 2, 9, "`");
  assert.equal(r.text, "x\n`第一行\n第二行`\ny");
  assert.deepEqual([r.selStart, r.selEnd], [3, 10]);
});

test("toggleLinePrefix：加前缀（多行整组）、选区覆盖整块", () => {
  const r = toggleLinePrefix("甲\n乙\n丙", 0, 4, "- ");
  assert.equal(r.text, "- 甲\n- 乙\n丙");
  assert.deepEqual([r.selStart, r.selEnd], [0, 7]);
});

test("toggleLinePrefix：全部已有前缀 → 整组去掉", () => {
  const r = toggleLinePrefix("- 甲\n- 乙", 0, 7, "- ");
  assert.equal(r.text, "甲\n乙");
  assert.deepEqual([r.selStart, r.selEnd], [0, 3]);
});

test("toggleLinePrefix：任务清单与引用同口径", () => {
  assert.equal(toggleLinePrefix("待办", 0, 0, "- [ ] ").text, "- [ ] 待办");
  assert.equal(toggleLinePrefix("> 引用", 4, 6, "> ").text, "引用");
});

test("toggleLinePrefix：换标记不叠层（•↔☑ 互切、已勾选变回未勾选、有序转无序）", () => {
  assert.equal(toggleLinePrefix("- 甲\n乙", 0, 5, "- [ ] ").text, "- [ ] 甲\n- [ ] 乙");
  assert.equal(toggleLinePrefix("- [x] 做完的事", 0, 0, "- [ ] ").text, "- [ ] 做完的事");
  assert.equal(toggleLinePrefix("1. 甲", 0, 0, "- ").text, "- 甲");
  assert.equal(toggleLinePrefix("- [ ] 待办", 0, 0, "- ").text, "- 待办");
});

test("continueListItem：无序列表续、有序递增、缩进继承", () => {
  assert.deepEqual(continueListItem("- 甲"), { kind: "continue", prefix: "- " });
  assert.deepEqual(continueListItem("  3. 甲"), { kind: "continue", prefix: "  4. " });
  assert.deepEqual(continueListItem("* [x] 做完"), {
    kind: "continue",
    prefix: "* [ ] ",
  });
});

test("continueListItem：空项回车退出列表（保缩进）；非列表行不续", () => {
  assert.deepEqual(continueListItem("- "), { kind: "exit", clean: "" });
  assert.deepEqual(continueListItem("  - [ ] "), { kind: "exit", clean: "  " });
  assert.deepEqual(continueListItem("普通段落"), { kind: "none" });
  // 无空格的连字符（表格分隔线/破折号）不是列表项
  assert.deepEqual(continueListItem("---"), { kind: "none" });
});

test("wrapAsLink：非空选区包 [文本](url) 并选中 url", () => {
  const r = wrapAsLink("见 资料 参考", 2, 4);
  assert.equal(r.text, "见 [资料](url) 参考");
  assert.deepEqual([r.selStart, r.selEnd], [7, 10]);
});

test("wrapAsLink：空选区插入 [](url) 光标在方括号内", () => {
  assert.deepEqual(wrapAsLink("ab", 1, 1), {
    text: "a[](url)b",
    selStart: 2,
    selEnd: 2,
  });
});
