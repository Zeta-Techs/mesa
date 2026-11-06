import assert from "node:assert/strict";
import test from "node:test";
import { loginScreenLabel, runBlocker, type BlockerInput } from "../src/run-blocker.ts";

const base: BlockerInput = {
  running: true,
  shell: false,
  attention: "working",
  isGoal: false,
  trust: null,
  menuQuestion: null,
  hasMenu: false,
  waitTitle: null,
  launchFailureCode: null,
  loginScreen: null,
  connIssue: false,
  stalled: false,
};

test("卡在哪：在干活、没卡住为 null", () => {
  assert.equal(runBlocker(base), null);
  assert.equal(runBlocker({ ...base, running: false }), null);
});

test("卡在哪：按要紧程度只取一个，手机上只有信任能直接点", () => {
  const all = runBlocker({ ...base, trust: { yes: "Yes", no: "No", path: "/x" }, connIssue: true, stalled: true, attention: "confirm" })!;
  assert.equal(all.kind, "trust");
  assert.equal(all.phone, "answer");
  assert.equal(runBlocker({ ...base, launchFailureCode: 127, running: false })!.kind, "launch_failed", "没起来时不在跑也要报");
  assert.equal(runBlocker({ ...base, loginScreen: "Cursor 登录", connIssue: true })!.kind, "login");
  assert.equal(runBlocker({ ...base, connIssue: true, attention: "confirm" })!.kind, "conn");
  assert.match(runBlocker({ ...base, hasMenu: true, menuQuestion: "Do you want to proceed?" })!.text, /Do you want to proceed/);
  assert.equal(runBlocker({ ...base, attention: "confirm" })!.kind, "confirm");
  assert.equal(runBlocker({ ...base, waitTitle: "Press any key" })!.kind, "wait");
  assert.equal(runBlocker({ ...base, stalled: true })!.kind, "stalled");
  assert.equal(runBlocker({ ...base, attention: "done" }), null, "对话说完一轮不算卡");
  assert.equal(runBlocker({ ...base, attention: "done", isGoal: true })!.kind, "idle", "目标说完一轮要人看");
  for (const b of [runBlocker({ ...base, stalled: true })!, runBlocker({ ...base, connIssue: true })!]) assert.equal(b.phone, "notify");
});

test("登录类特殊屏的叫法", () => {
  assert.equal(loginScreenLabel(null, true), "Grok 登录");
  assert.equal(loginScreenLabel({ kind: "cursor-login" }, false), "Cursor 登录");
  assert.equal(loginScreenLabel(null, false), null);
});
