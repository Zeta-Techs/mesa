import assert from "node:assert/strict";
import test from "node:test";
import type { ScreenCell } from "../src/screen-cells.ts";
import { askAfter, askAnswerKeys, askFinishes, askMenu, parseClaudeAsk } from "../src/tui-ask.ts";
import { parseTuiMenu, sameTuiMenu } from "../src/tui-menu.ts";

// Claude Code 2.1.306 实录（假网关回 AskUserQuestion，126×29，2026-10-22；横线截短）
const RULE = "─".repeat(60);
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";

const SINGLE = [
  "✻ Worked for 6s · done 12:24 PM",
  "",
  "❯ TRIGGER_ASK 问我一个问题",
  "",
  RULE,
  " ☐ 颜色",
  "",
  "红、绿、蓝三种颜色里，你更喜欢哪一种？",
  "",
  "❯ 1. 红",
  "     选择红色",
  "  2. 绿",
  "     选择绿色",
  "  3. 蓝",
  "     选择蓝色",
  "  4. Type something.",
  RULE,
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

// 两题的第二题（多选），光标停在「Submit」那行，苹果勾上了、「自己写」里写了西瓜
const MULTI_TABS = "←  ☒ 颜色  ☐ 水果  ✔ Submit  →";
const MULTI = [
  "❯ TRIGGER_ASK2 问我两个问题",
  "",
  RULE,
  MULTI_TABS,
  "",
  "下面这些水果你平时会吃哪些？",
  "",
  "  1. [✔] 苹果",
  "         脆甜，一年四季都有",
  "  2. [ ] 香蕉",
  "         软糯，适合当早餐",
  "  3. [ ] 葡萄",
  "         一串一串，夏天最多",
  "  4. [✔] 西瓜",
  "❯    Submit",
  RULE,
  "  5. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];

/** 题签行的样子：当前那题连两边空格铺底色（实录：「← ⟦底色⟧ ☐ 颜色 ⟦⟧ ☐ 水果  ✔ Submit  →」） */
function tabCells(line: string, current: string): ScreenCell[] {
  const at = line.indexOf(current);
  return [...line].map((ch, i) => ({ ch, dim: false, inverse: false, bg: i >= at - 1 && i <= at + current.length }));
}

test("一题单选：题签、问句、选项与说明分开，「自己写」和「先聊聊」单列", () => {
  const ask = parseClaudeAsk(SINGLE);
  assert.ok(ask && ask.kind === "question");
  assert.deepEqual(ask.tabs, [{ label: "颜色", answered: false }]);
  assert.equal(ask.current, 0);
  assert.equal(ask.question, "红、绿、蓝三种颜色里，你更喜欢哪一种？");
  assert.equal(ask.multiSelect, false);
  assert.deepEqual(ask.options, [
    { label: "红", description: "选择红色", checked: null },
    { label: "绿", description: "选择绿色", checked: null },
    { label: "蓝", description: "选择蓝色", checked: null },
  ]);
  assert.equal(ask.freeText, null);
  assert.deepEqual(
    ask.rows.map((r) => r.kind),
    ["option", "option", "option", "free", "chat"],
  );
  assert.equal(ask.cursor, 0);
  // 通用读法把说明并进选项名、题签当说明——这正是原先卡片上「红 选择红色」「□ 颜色」的来历
  const generic = parseTuiMenu(SINGLE);
  assert.deepEqual(generic?.options, ["红 选择红色", "绿 选择绿色", "蓝 选择蓝色", "Type something."]);
});

test("单选的按键：选第三项、自己写（写完回车就交）、先不答", () => {
  const ask = parseClaudeAsk(SINGLE)!;
  assert.deepEqual(askAnswerKeys(ask, { kind: "pick", index: 2 }), [DOWN, DOWN, ENTER]);
  assert.deepEqual(askAnswerKeys(ask, { kind: "pick", index: 0 }), [ENTER]);
  assert.deepEqual(askAnswerKeys(ask, { kind: "text", text: " 紫色\n要深一点 " }), [DOWN, DOWN, DOWN, "紫色 要深一点", ENTER]);
  assert.deepEqual(askAnswerKeys(ask, { kind: "text", text: "  " }), null);
  assert.deepEqual(askAnswerKeys(ask, { kind: "chat" }), [DOWN, DOWN, DOWN, DOWN, ENTER]);
  // 一题没有确认页，也不能切题
  assert.equal(askAnswerKeys(ask, { kind: "confirm" }), null);
  assert.equal(askAnswerKeys(ask, { kind: "tab", index: 1 }), null);
});

test("「自己写」里已经打了字：读出来，再写先删掉原来的", () => {
  const typed = SINGLE.map((l) => (l === "  4. Type something." ? "  4. 紫色" : l));
  const ask = parseClaudeAsk(typed)!;
  assert.ok(ask.kind === "question");
  assert.equal(ask.freeText, "紫色");
  assert.deepEqual(askAnswerKeys(ask, { kind: "text", text: "青" }), [DOWN, DOWN, DOWN, "\x7f", "\x7f", "青", ENTER]);
});

test("两题的多选题：勾选状态、光标在 Submit、当前题靠题签底色认", () => {
  const ask = parseClaudeAsk(MULTI, (row) => (MULTI[row] === MULTI_TABS ? tabCells(MULTI_TABS, "☐ 水果") : []));
  assert.ok(ask && ask.kind === "question");
  assert.deepEqual(ask.tabs, [
    { label: "颜色", answered: true },
    { label: "水果", answered: false },
  ]);
  assert.equal(ask.current, 1);
  assert.equal(ask.multiSelect, true);
  assert.deepEqual(
    ask.options.map((o) => [o.label, o.checked]),
    [
      ["苹果", true],
      ["香蕉", false],
      ["葡萄", false],
    ],
  );
  assert.equal(ask.freeText, "西瓜");
  assert.equal(ask.freeChecked, true);
  assert.deepEqual(
    ask.rows.map((r) => r.kind),
    ["option", "option", "option", "free", "submit", "chat"],
  );
  assert.equal(ask.cursor, 4);
  // 多选：回车是勾 / 取消，光标从 Submit 往上走
  assert.deepEqual(askAnswerKeys(ask, { kind: "pick", index: 1 }), [UP, UP, UP, ENTER]);
  assert.deepEqual(askAnswerKeys(ask, { kind: "submit" }), [ENTER]);
  // 多选里写字自动勾上，不按回车（回车会取消勾）；从输入框发来的要顺手交这一题
  assert.deepEqual(askAnswerKeys(ask, { kind: "text", text: "梨" }), [UP, "\x7f", "\x7f", "梨"]);
  assert.deepEqual(askAnswerKeys(ask, { kind: "text", text: "梨", submit: true }), [UP, "\x7f", "\x7f", "梨", DOWN, ENTER]);
  // 切题：←→；第三个签是确认页
  assert.deepEqual(askAnswerKeys(ask, { kind: "tab", index: 0 }), ["\x1b[D"]);
  assert.deepEqual(askAnswerKeys(ask, { kind: "tab", index: 2 }), ["\x1b[C"]);
  // 认不出当前题（没给样子）就不给切
  const blind = parseClaudeAsk(MULTI)!;
  assert.equal(blind.current, null);
  assert.equal(askAnswerKeys(blind, { kind: "tab", index: 0 }), null);
  // 通用读法在光标停在 Submit 时整张认不出（原先这时卡片消失）
  assert.equal(parseTuiMenu(MULTI), null);
});

test("多选先照按键结果画：勾一项光标跟过去，写字自动勾上；会换题的动作不预测", () => {
  const ask = parseClaudeAsk(MULTI)!;
  const after = askAfter(ask, { kind: "pick", index: 1 });
  assert.ok(after && after.kind === "question");
  assert.equal(after.cursor, 1);
  assert.deepEqual(after.options.map((o) => o.checked), [true, true, false]);
  // 接着从新位置算键
  assert.deepEqual(askAnswerKeys(after, { kind: "pick", index: 0 }), [UP, ENTER]);
  const typed = askAfter(ask, { kind: "text", text: "梨" });
  assert.ok(typed && typed.kind === "question");
  assert.equal(typed.freeText, "梨");
  assert.equal(typed.cursor, 3);
  assert.equal(askAfter(ask, { kind: "submit" }), null);
  assert.equal(askAfter(parseClaudeAsk(SINGLE)!, { kind: "pick", index: 1 }), null);
});

test("确认页：每题的答案、提交 / 整组不答", () => {
  const ask = parseClaudeAsk([
    RULE,
    "←  ☒ 颜色  ☒ 水果  ✔ Submit  →",
    "",
    "Review your answers",
    "",
    " ● 红、绿、蓝三种颜色里，你更喜欢哪一种？",
    "   → 红",
    " ● 下面这些水果你平时会吃哪些？",
    "   → 苹果",
    "",
    "Ready to submit your answers?",
    "",
    "❯ 1. Submit answers",
    "  2. Cancel",
  ]);
  assert.ok(ask && ask.kind === "review");
  assert.deepEqual(ask.answers, [
    { question: "红、绿、蓝三种颜色里，你更喜欢哪一种？", answer: "红" },
    { question: "下面这些水果你平时会吃哪些？", answer: "苹果" },
  ]);
  assert.equal(ask.warning, null);
  assert.equal(ask.current, 2);
  assert.deepEqual(askAnswerKeys(ask, { kind: "confirm" }), [ENTER]);
  assert.deepEqual(askAnswerKeys(ask, { kind: "cancel" }), [DOWN, ENTER]);
  assert.equal(askAnswerKeys(ask, { kind: "pick", index: 0 }), null);
  assert.deepEqual(askMenu(ask).options, ["Submit answers", "Cancel"]);
});

test("没答完就切到确认页：带提醒，没有答案列表", () => {
  const ask = parseClaudeAsk([
    RULE,
    "←  ☐ 颜色  ☐ 水果  ✔ Submit  →",
    "",
    "Review your answers",
    "",
    "⚠ You have not answered all questions",
    "",
    "Ready to submit your answers?",
    "",
    "❯ 1. Submit answers",
    "  2. Cancel",
  ]);
  assert.ok(ask && ask.kind === "review");
  assert.equal(ask.warning, "You have not answered all questions");
  assert.deepEqual(ask.answers, []);
});

test("不是提问表单：对话里的「☐」行、表单开头滚出屏、底部没收口", () => {
  assert.equal(parseClaudeAsk(["⏺ 待办：", " ☐ 买菜", "  1. 去超市", "  2. 回家"]), null);
  // 题签不在屏上（表单比屏高）
  assert.equal(parseClaudeAsk(SINGLE.slice(6)), null);
  // 底下那条横线还没画出来
  assert.equal(parseClaudeAsk(SINGLE.slice(0, 15)), null);
  // 光标不在任何一行上（画到一半）
  assert.equal(parseClaudeAsk(SINGLE.map((l) => l.replace(/^❯ 1\./, "  1."))), null);
});

test("给通用流程的摘要：问句 + 选项名；按过键待刷新的卡与新扫到的不算同一张", () => {
  const ask = parseClaudeAsk(SINGLE)!;
  const menu = askMenu(ask);
  assert.equal(menu.question, "红、绿、蓝三种颜色里，你更喜欢哪一种？");
  assert.deepEqual(menu.options, ["红", "绿", "蓝", "Type something."]);
  assert.equal(sameTuiMenu(menu, askMenu(parseClaudeAsk(SINGLE)!)), true);
  assert.equal(sameTuiMenu({ ...menu, pending: true }, menu), false);
  // 光标挪了也算变了（按键要从新位置算）
  const moved = askMenu(parseClaudeAsk(SINGLE.map((l) => (l === "❯ 1. 红" ? "  1. 红" : l === "  2. 绿" ? "❯ 2. 绿" : l)))!);
  assert.equal(sameTuiMenu(menu, moved), false);
});

test("哪一下算交卷：卡片当场收起、到确认页替人按 Submit answers", () => {
  const single = parseClaudeAsk(SINGLE)!;
  assert.equal(askFinishes(single, { kind: "pick", index: 1 }), true);
  assert.equal(askFinishes(single, { kind: "text", text: "紫色" }), true);
  assert.equal(askFinishes(single, { kind: "chat" }), true);
  // 只有一道多选题（2026-10-22 用户截图：交了还要过确认页）：勾一项不算，交这一题 / 从输入框写了答案交才算
  const onlyMulti = parseClaudeAsk([
    RULE,
    "←  ☒ 水果  ✔ Submit  →",
    "下面这些水果你平时会吃哪些？",
    "  1. [✔] 苹果",
    "         脆甜，一年四季都有",
    "  2. [ ] 香蕉",
    "         软糯，适合当早餐",
    "  3. [ ] Type something",
    "❯    Submit",
    RULE,
    "  4. Chat about this",
  ])!;
  assert.ok(onlyMulti.kind === "question" && onlyMulti.tabs.length === 1 && onlyMulti.multiSelect);
  assert.equal(askFinishes(onlyMulti, { kind: "pick", index: 1 }), false);
  assert.equal(askFinishes(onlyMulti, { kind: "text", text: "梨" }), false);
  assert.equal(askFinishes(onlyMulti, { kind: "text", text: "梨", submit: true }), true);
  assert.equal(askFinishes(onlyMulti, { kind: "submit" }), true);
  // 两题：第一题答过、正在第二题 → 交这一题就是交卷；认不出当前题时不当交卷（按钮停用等屏上换）
  const lastOfTwo = parseClaudeAsk(MULTI, (row) => (MULTI[row] === MULTI_TABS ? tabCells(MULTI_TABS, "☐ 水果") : []))!;
  assert.equal(askFinishes(lastOfTwo, { kind: "submit" }), true);
  assert.equal(askFinishes(lastOfTwo, { kind: "tab", index: 0 }), false);
  assert.equal(askFinishes(parseClaudeAsk(MULTI)!, { kind: "submit" }), false);
  // 两题都还没答、在第一题：选了只是换到下一题
  const tabs = "←  ☐ 颜色  ☐ 水果  ✔ Submit  →";
  const first = SINGLE.map((l) => (l === " ☐ 颜色" ? tabs : l));
  const firstOfTwo = parseClaudeAsk(first, (row) => (first[row] === tabs ? tabCells(tabs, "☐ 颜色") : []))!;
  assert.equal(firstOfTwo.current, 0);
  assert.equal(askFinishes(firstOfTwo, { kind: "pick", index: 0 }), false);
});
