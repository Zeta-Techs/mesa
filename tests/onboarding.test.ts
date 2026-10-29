import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ONBOARDING,
  ONBOARDING_STEPS,
  completionNotice,
  connectStage,
  decideInitialStatus,
  doneStepIds,
  isStepDone,
  newlyDone,
  officialShortcutLabel,
  onboardingProgress,
  parseOnboarding,
  serializeOnboarding,
  tipsNotice,
  type OnboardingFacts,
} from "../src/onboarding.ts";

const blank: OnboardingFacts = {
  installedAgents: [],
  gatewayCount: 0,
  profileCount: 0,
  userSessionCount: 0,
  projectCount: 0,
};

test("步骤表：三步、顺序固定、文案不空", () => {
  assert.deepEqual(
    ONBOARDING_STEPS.map((s) => s.id),
    ["connect", "chat", "project"],
  );
  for (const step of ONBOARDING_STEPS) {
    assert.ok(step.title && step.headline && step.summary, step.id);
  }
});

test("新装：什么都没有，当前步是接上 AI", () => {
  const p = onboardingProgress(blank);
  assert.equal(p.doneCount, 0);
  assert.equal(p.total, 3);
  assert.equal(p.current, "connect");
});

test("完成判定全由数据推导，可以跳着做", () => {
  const p = onboardingProgress({ ...blank, projectCount: 1 });
  assert.deepEqual(doneStepIds(p), ["project"]);
  assert.equal(p.current, "connect");
  assert.equal(isStepDone("connect", { ...blank, installedAgents: ["codex"] }), false);
  assert.equal(isStepDone("connect", { ...blank, profileCount: 1 }), true);
  assert.equal(isStepDone("chat", { ...blank, userSessionCount: 1 }), true);
});

test("接上 AI 一屏的子阶段：没装 → 先装；装了没连 → 选连接方式；有连接 → 做完", () => {
  assert.equal(connectStage(blank), "install");
  assert.equal(connectStage({ ...blank, installedAgents: ["codex"] }), "choose");
  assert.equal(connectStage({ ...blank, installedAgents: ["codex"], profileCount: 1 }), "done");
  // 没装但有连接（比如别处建的）也算接通
  assert.equal(connectStage({ ...blank, profileCount: 1 }), "done");
});

test("newlyDone：只返回两次快照之间新完成的，按步骤顺序", () => {
  assert.deepEqual(newlyDone([], ["connect"]), ["connect"]);
  assert.deepEqual(newlyDone(["connect"], ["connect", "project", "chat"]), ["chat", "project"]);
  assert.deepEqual(newlyDone(["connect"], ["connect"]), []);
});

test("首次判定：已有连接是老用户，引导直接收起；其余当新用户", () => {
  assert.equal(decideInitialStatus(blank), "active");
  assert.equal(decideInitialStatus({ ...blank, installedAgents: ["codex"] }), "active");
  assert.equal(decideInitialStatus({ ...blank, profileCount: 1 }), "dismissed");
});

test("完成提示：首行是结果，后面是下一步；全做完是「上手完成」", () => {
  const n = completionNotice("connect", "chat", { installedLabel: "Claude Code" });
  assert.ok(n.text.startsWith("Claude Code 已接通\n"));
  assert.ok(n.text.includes("新对话"));
  assert.equal(n.tone, "success");
  assert.ok(completionNotice("connect", "chat").text.startsWith("连接已添加\n"));
  assert.ok(completionNotice("chat", "project").text.startsWith("第一段对话开始了\n"));
  const done = completionNotice("project", null);
  assert.ok(done.text.startsWith("上手完成\n"));
  assert.ok(done.text.includes("帮助"));
});

test("一键接入官方账号的按钮文案", () => {
  assert.equal(officialShortcutLabel("Claude Code"), "用 Claude Code 官方账号");
});

test("小提示：终端与标题合成一条，讲过的不再讲，都讲过就不弹", () => {
  const both = tipsNotice({});
  assert.ok(both?.startsWith("两个小提示\n"));
  assert.ok(both?.includes("终端") && both?.includes("标题"));
  const onlyNaming = tipsNotice({ terminal: true });
  assert.ok(onlyNaming && !onlyNaming.includes(">_") && onlyNaming.includes("标题"));
  assert.equal(tipsNotice({ terminal: true, naming: true }), null);
});

test("存档：往返一致；损坏、空、未知状态当没判定过", () => {
  const state = { status: "active" as const, welcomed: true, acks: { terminal: true as const } };
  assert.deepEqual(parseOnboarding(serializeOnboarding(state)), state);
  assert.deepEqual(parseOnboarding(null), DEFAULT_ONBOARDING);
  assert.deepEqual(parseOnboarding("{坏了"), DEFAULT_ONBOARDING);
  assert.equal(parseOnboarding(JSON.stringify({ status: "weird" })).status, "unset");
});

test("旧存档（七步时代）：终端 / 标题确认沿用为小提示已知，网关确认与未知键丢弃，不丢状态", () => {
  const old = JSON.stringify({
    status: "active",
    welcomed: true,
    acks: { gateway: true, terminal: true, naming: true, bogus: true },
  });
  assert.deepEqual(parseOnboarding(old), {
    status: "active",
    welcomed: true,
    acks: { terminal: true, naming: true },
  });
});
