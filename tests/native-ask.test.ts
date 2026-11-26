import assert from "node:assert/strict";
import test from "node:test";
import { applyNativeAsk, initialNativeAsk, nativeAskForm, parseNativeQuestions } from "../src/native-ask.ts";

const color = {
  question: "红、绿、蓝三种颜色里，你更喜欢哪一种？",
  header: "颜色",
  multiSelect: false,
  options: [
    { label: "红", description: "选择红色" },
    { label: "绿", description: "选择绿色" },
    { label: "蓝", description: "选择蓝色" },
  ],
};
const fruit = {
  question: "下面这些水果你平时会吃哪些？",
  header: "水果",
  multiSelect: true,
  options: [{ label: "苹果" }, { label: "香蕉" }, { label: "葡萄" }],
};

test("原生提问表单：AskUserQuestion 的题目原样认出，认不出的跳过", () => {
  const qs = parseNativeQuestions([color, { header: "空" }, "坏的", fruit]);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].options[1].label, "绿");
  assert.equal(qs[1].multiSelect, true);
  assert.equal(qs[1].options[0].description, null);
  assert.deepEqual(parseNativeQuestions(null), []);
});

test("只有一道单选题：选了就交，答案按题目原文作键", () => {
  const qs = parseNativeQuestions([color]);
  const st = initialNativeAsk(qs);
  const form = nativeAskForm(qs, st);
  assert.equal(form.kind, "question");
  assert.ok(form.kind === "question" && form.options.every((o) => o.checked === null));
  const r = applyNativeAsk(qs, st, { kind: "pick", index: 1 });
  assert.deepEqual(r.result, { kind: "submit", answers: { [color.question]: "绿" } });
  // 自己写答案同样一写就交
  const r2 = applyNativeAsk(qs, st, { kind: "text", text: "紫色" });
  assert.deepEqual(r2.result, { kind: "submit", answers: { [color.question]: "紫色" } });
});

test("多题 + 多选：勾选不交，选好到下一题，确认页提交；多选答案按勾选顺序连起来", () => {
  const qs = parseNativeQuestions([color, fruit]);
  let st = initialNativeAsk(qs);
  let r = applyNativeAsk(qs, st, { kind: "pick", index: 2 });
  assert.equal(r.result, null, "多题时选了先到下一题");
  st = r.state;
  assert.equal(st.current, 1);
  st = applyNativeAsk(qs, st, { kind: "pick", index: 1 }).state;
  st = applyNativeAsk(qs, st, { kind: "pick", index: 0 }).state;
  st = applyNativeAsk(qs, st, { kind: "pick", index: 1 }).state; // 取消香蕉
  st = applyNativeAsk(qs, st, { kind: "pick", index: 1 }).state; // 再勾上
  const form = nativeAskForm(qs, st);
  assert.ok(form.kind === "question" && form.options[0].checked === true && form.rows.some((x) => x.kind === "submit"));
  st = applyNativeAsk(qs, st, { kind: "submit" }).state;
  const review = nativeAskForm(qs, st);
  assert.equal(review.kind, "review");
  assert.ok(review.kind === "review" && review.warning === null && review.answers[1].answer === "苹果, 香蕉");
  r = applyNativeAsk(qs, st, { kind: "confirm" });
  assert.deepEqual(r.result, { kind: "submit", answers: { [color.question]: "蓝", [fruit.question]: "苹果, 香蕉" } });
});

test("确认页提示没答完的题；整组不答 / 先聊聊 = 取消", () => {
  const qs = parseNativeQuestions([color, fruit]);
  const st = { ...initialNativeAsk(qs), current: 2 };
  const review = nativeAskForm(qs, st);
  assert.ok(review.kind === "review" && review.warning === "还有题没答");
  assert.deepEqual(applyNativeAsk(qs, st, { kind: "cancel" }).result, { kind: "cancel" });
  assert.deepEqual(applyNativeAsk(qs, initialNativeAsk(qs), { kind: "chat" }).result, { kind: "cancel" });
  assert.equal(applyNativeAsk(qs, st, { kind: "tab", index: 0 }).state.current, 0, "能切回去改");
});
