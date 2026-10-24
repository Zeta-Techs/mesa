import assert from "node:assert/strict";
import test from "node:test";
import { nextUnread, type UnreadRun } from "../src/chat-unread.ts";

const run = (over: Partial<UnreadRun>): UnreadRun => ({
  tabId: "t1",
  agentId: "claude-code",
  sessionId: "s1",
  attention: "working",
  ...over,
});

test("没看着的那段这一轮做完了：记一笔；正看着的不记", () => {
  const before = [run({}), run({ tabId: "t2", sessionId: "s2" })];
  const now = [run({ attention: "done" }), run({ tabId: "t2", sessionId: "s2", attention: "done" })];
  assert.deepEqual(nextUnread({ prev: [], before, now, viewingTabId: "t2" }), ["claude-code\ns1"]);
  // Mesa 不在前台（viewing 为 null）：正开着的那段也算没看
  assert.deepEqual(nextUnread({ prev: [], before, now, viewingTabId: null }).sort(), ["claude-code\ns1", "claude-code\ns2"]);
});

test("等确认、还在干活、本来就闲着的不记", () => {
  assert.deepEqual(nextUnread({ prev: [], before: [run({})], now: [run({ attention: "confirm" })], viewingTabId: null }), []);
  assert.deepEqual(nextUnread({ prev: [], before: [run({})], now: [run({})], viewingTabId: null }), []);
  assert.deepEqual(
    nextUnread({ prev: [], before: [run({ attention: "done" })], now: [run({ attention: "done" })], viewingTabId: null }),
    [],
  );
});

test("看到就消；标签收掉了按会话记的还留着，按标签记的丢掉", () => {
  const prev = ["claude-code\ns1"];
  assert.deepEqual(nextUnread({ prev, before: [], now: [run({ attention: "done" })], viewingTabId: "t1" }), []);
  // 标签因空闲被收：会话那一笔留着，侧栏那一行照旧亮
  assert.deepEqual(nextUnread({ prev, before: [run({})], now: [], viewingTabId: null }), prev);
  assert.deepEqual(nextUnread({ prev: ["tab:t9"], before: [], now: [], viewingTabId: null }), []);
});

test("还没认出会话的先记在标签上，认出来后挪到会话上", () => {
  const first = nextUnread({
    prev: [],
    before: [run({ sessionId: null })],
    now: [run({ sessionId: null, attention: "done" })],
    viewingTabId: null,
  });
  assert.deepEqual(first, ["tab:t1"]);
  assert.deepEqual(
    nextUnread({
      prev: first,
      before: [run({ sessionId: null, attention: "done" })],
      now: [run({ attention: "done" })],
      viewingTabId: null,
    }),
    ["claude-code\ns1"],
  );
});
