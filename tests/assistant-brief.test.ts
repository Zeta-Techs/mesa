import { test } from "node:test";
import assert from "node:assert/strict";
import { briefLines, quickAsks, reviewPrereadFocus, type BriefInput } from "../src/assistant-brief.ts";

const base: BriefInput = { hasFlow: true, steps: [], goals: [], since: null };

test("没有要看的事、也没有变化：不出卡", () => {
  assert.deepEqual(briefLines({ ...base, steps: [{ n: 1, name: "检索", state: "saved", mergedAt: "2026-11-01T00:00:00Z", needsHuman: 0 }] }), []);
});

test("出错、等确认、待评审、目标待验收都列出，并带跳转或追问", () => {
  const lines = briefLines({
    ...base,
    steps: [
      { n: 1, name: "检索", state: "failed", failure: "未找到命令（退出码 127）", needsHuman: 0 },
      { n: 2, name: "精读", state: "confirm", needsHuman: 0 },
      { n: 3, name: "大纲", state: "review", needsHuman: 2 },
    ],
    goals: [{ name: "组会汇报", status: "pending_review", updatedAt: "2026-11-08T00:00:00Z" }],
  });
  assert.equal(lines[0].text, "第 1 步「检索」出错了：未找到命令（退出码 127）");
  assert.equal(lines[0].ask?.question, "第 1 步「检索」为什么出错？我该怎么办？");
  assert.equal(lines[1].action?.kind, "step");
  assert.equal(lines[2].action?.kind, "review");
  // 同一步的「核验待判断」与「待评审」指向同一处评审，只留一行
  assert.equal(lines.filter((l) => l.action?.kind === "review" && l.action.step === 3).length, 1);
  assert.ok(lines.some((l) => l.text === "目标「组会汇报」做完了，等你验收"));
});

test("「上次打开以来」只列 since 之后保存 / 完成的；第一次打开不列变化", () => {
  const input: BriefInput = {
    ...base,
    since: "2026-11-05T00:00:00Z",
    steps: [
      { n: 1, name: "检索", state: "saved", mergedAt: "2026-11-06T00:00:00Z", needsHuman: 0 },
      { n: 2, name: "精读", state: "saved", mergedAt: "2026-11-01T00:00:00Z", needsHuman: 0 },
    ],
    goals: [{ name: "周报", status: "completed", updatedAt: "2026-11-07T00:00:00Z" }],
  };
  assert.deepEqual(briefLines(input).map((l) => l.text), ["第 1 步「检索」已保存进项目", "目标「周报」已验收完成"]);
  assert.deepEqual(briefLines({ ...input, since: null }), []);
});

test("常用问题按状态换：出错与待评审排前，评审那句带只读重点", () => {
  const asks = quickAsks({ ...base, steps: [{ n: 2, name: "精读", state: "failed", needsHuman: 0 }, { n: 3, name: "大纲", state: "review", needsHuman: 0 }] });
  assert.equal(asks.length, 3);
  assert.equal(asks[0].q, "第 2 步「精读」为什么出错？");
  assert.equal(asks[1].q, "第 3 步交的东西，我评审时该重点看哪几处？");
  assert.deepEqual(asks[1].focus, reviewPrereadFocus(3, "大纲"));
  assert.match(asks[1].focus!.detail, /不判断能不能通过/);
});

test("没流程没目标的新项目问「想做什么」，不问「到哪了」", () => {
  const asks = quickAsks({ ...base, hasFlow: false });
  assert.ok(!asks.some((a) => a.q === "现在到哪了？"));
  assert.ok(asks.some((a) => a.q === "我想做一件事，帮我理清怎么做"));
  assert.equal(quickAsks({ ...base, hasFlow: false, goals: [{ name: "x", status: "running", updatedAt: "" }] })[0].q, "目标都做到哪了？");
  assert.equal(quickAsks(base)[0].q, "现在到哪了？");
});

test("项目知识还是空的：卡上提议起草几条，按「项目」类问、带只读重点，不编", async () => {
  const { KNOWLEDGE_DRAFT_QUESTION } = await import("../src/assistant-brief.ts");
  const lines = briefLines({ ...base, knowledgeEmpty: true });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "knowledge-draft");
  assert.equal(lines[0].ask?.question, KNOWLEDGE_DRAFT_QUESTION);
  assert.equal(lines[0].ask?.label, "起草几条");
  assert.equal(lines[0].ask?.intent, "project");
  assert.match(lines[0].ask!.focus.detail, /最多五块/);
  assert.match(lines[0].ask!.focus.detail, /不要编/);
  assert.deepEqual(briefLines({ ...base, knowledgeEmpty: false }), []);
});

test("聊够十轮才提议整理；派活进展不算；整理或「不用」以后重新数", async () => {
  const { summaryDue, summaryFocus } = await import("../src/assistant-brief.ts");
  const turns = Array.from({ length: 12 }, (_, i) => ({ at: `2026-11-08T00:${String(i).padStart(2, "0")}:00Z`, question: `问${i}`, answer: `答${i}\n:::记下\nx\n:::` }));
  assert.equal(summaryDue(turns.slice(0, 9), null), false);
  assert.equal(summaryDue([...turns.slice(0, 9), { at: "2026-11-08T01:00:00Z", echoOf: "x" }], null), false);
  assert.equal(summaryDue(turns, null), true);
  assert.equal(summaryDue(turns, turns[5].at), false, "上次整理之后只有 6 轮");
  const f = summaryFocus(turns, turns[1].at);
  assert.match(f.detail, /最近 10 轮/);
  assert.ok(!f.detail.includes(":::记下\nx"), "旧回答里的标记块不带进去");
});
