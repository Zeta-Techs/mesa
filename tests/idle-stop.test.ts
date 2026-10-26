import assert from "node:assert/strict";
import test from "node:test";
import { IDLE_STOP_MS, idleEligible, idleStopPass, isPlainChatTab, EXITED_GRACE_MS, exitedCollectPass, isExitedAgentTab } from "../src/idle-stop.ts";

const idle = { running: true, shell: false, attention: "done" as const };

test("只收普通对话：新对话、从列表接回的、没带复用键的；步骤 / 车道 / 阅读 / 自定义运行时不收", () => {
  assert.equal(isPlainChatTab({ id: "a", reuseKey: "quickchat:1" }), true);
  assert.equal(isPlainChatTab({ id: "a", reuseKey: "research:/p:project:1" }), true);
  assert.equal(isPlainChatTab({ id: "a", reuseKey: "resume:claude-code:s1" }), true);
  assert.equal(isPlainChatTab({ id: "a" }), true);
  assert.equal(isPlainChatTab({ id: "a", reuseKey: "ws:/wt" }), false);
  assert.equal(isPlainChatTab({ id: "a", reuseKey: "lane:/wt" }), false);
  assert.equal(isPlainChatTab({ id: "a", reuseKey: "reader:/p/a.pdf" }), false);
  assert.equal(isPlainChatTab({ id: "a", customRuntimeId: "r1" }), false);
  assert.equal(isPlainChatTab({ id: "a", reuseKey: "resume:codex:s1", taskId: "t1" }), false, "归了任务的");
  assert.equal(isPlainChatTab({ id: "a", stepName: "精读" }), false);
});

test("在生成、等你确认、纯终端、没在跑的都不算空闲", () => {
  const tab = { id: "a" };
  assert.equal(idleEligible(tab, idle), true);
  assert.equal(idleEligible(tab, { ...idle, attention: null }), true, "认不出状态当作没在忙");
  assert.equal(idleEligible(tab, { ...idle, attention: "working" }), false);
  assert.equal(idleEligible(tab, { ...idle, attention: "confirm" }), false);
  assert.equal(idleEligible(tab, { ...idle, shell: true }), false, "纯终端可能跑着开发服务");
  assert.equal(idleEligible(tab, { ...idle, running: false }), false);
  assert.equal(idleEligible(tab, undefined), false);
});

test("空闲满 30 分钟才收；正看着的 / 有没发的字的重新计时；忙起来就清掉计时", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const statuses = { a: idle, b: idle, c: idle };
  const t0 = 1_000_000;
  // 第一次看到：从现在开始计
  let pass = idleStopPass({ tabs, statuses, kept: new Set(["c"]), since: {}, now: t0 });
  assert.deepEqual(pass, { since: { a: t0, b: t0 }, stop: [] });
  // 29 分钟：还不收
  pass = idleStopPass({ tabs, statuses, kept: new Set(["c"]), since: pass.since, now: t0 + IDLE_STOP_MS - 60_000 });
  assert.deepEqual(pass.stop, []);
  // b 中途忙了一下：计时清掉
  pass = idleStopPass({
    tabs,
    statuses: { ...statuses, b: { ...idle, attention: "working" } },
    kept: new Set(["c"]),
    since: pass.since,
    now: t0 + IDLE_STOP_MS - 30_000,
  });
  assert.deepEqual(Object.keys(pass.since), ["a"]);
  // 满 30 分钟：只收 a；b 重新开始计，c 正看着不收
  pass = idleStopPass({ tabs, statuses, kept: new Set(["c"]), since: pass.since, now: t0 + IDLE_STOP_MS });
  assert.deepEqual(pass.stop, ["a"]);
  assert.equal(pass.since.b, t0 + IDLE_STOP_MS);
  assert.equal(pass.since.c, undefined);
});

test("Agent 退出、退回 shell 的普通对话才算要收的：纯终端、只看没接、还在跑、步骤都不算", () => {
  const exited = { running: false, shell: true, sessionId: "s1" };
  assert.equal(isExitedAgentTab({ id: "a" }, exited), true);
  assert.equal(isExitedAgentTab({ id: "a" }, { running: false, shell: true, sessionId: null }), false, "纯终端没有会话");
  assert.equal(isExitedAgentTab({ id: "a" }, { running: true, shell: false, sessionId: "s1" }), false, "还在跑");
  assert.equal(isExitedAgentTab({ id: "a" }, { running: false, shell: false, sessionId: "s1" }), false, "没退回 shell（只看没接 / 还没起来）");
  assert.equal(isExitedAgentTab({ id: "a", preview: true }, exited), false);
  assert.equal(isExitedAgentTab({ id: "a", shellOnly: true }, exited), false, "run 脚本");
  assert.equal(isExitedAgentTab({ id: "a", stepName: "精读" }, exited), false, "流水线步骤有自己的收尾");
  assert.equal(isExitedAgentTab({ id: "a" }, null), false);
});

test("退回 shell 满一小会儿、没人看着才收；正看着 / 输入框有字的只计时不收；接回了就从记录里去掉", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const statuses = {
    a: { running: false, shell: true, sessionId: "s1" },
    b: { running: false, shell: true, sessionId: "s2" },
    c: { running: true, shell: false, sessionId: "s3" },
  };
  const first = exitedCollectPass({ tabs, statuses, kept: new Set(["b"]), since: {}, now: 1000 });
  assert.deepEqual(first.since, { a: 1000, b: 1000 });
  assert.deepEqual(first.collect, [], "刚退回 shell：换模型 / 换权限中间那一下，不能当场收");
  const later = exitedCollectPass({ tabs, statuses, kept: new Set(["b"]), since: first.since, now: 1000 + EXITED_GRACE_MS });
  assert.deepEqual(later.collect, ["a"], "b 正看着，不收");
  const resumed = exitedCollectPass({
    tabs,
    statuses: { ...statuses, a: { running: true, shell: false, sessionId: "s1" } },
    kept: new Set(),
    since: later.since,
    now: 1000 + 2 * EXITED_GRACE_MS,
  });
  assert.deepEqual(Object.keys(resumed.since), ["b"], "a 接回了，下次退出重新计时");
});
