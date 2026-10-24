import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ONBOARDING,
  ONBOARDING_STEPS,
  completionNotice,
  decideInitialStatus,
  doneStepIds,
  isStepDone,
  newlyDone,
  onboardingProgress,
  parseOnboarding,
  serializeOnboarding,
  type OnboardingFacts,
  type OnboardingState,
} from "../src/onboarding.ts";

const blank: OnboardingFacts = {
  installedAgents: [],
  gatewayCount: 0,
  profileCount: 0,
  userSessionCount: 0,
  projectCount: 0,
};
const active: OnboardingState = { status: "active", welcomed: true, acks: {} };

test("步骤表：七步、顺序固定、文案不空", () => {
  assert.deepEqual(
    ONBOARDING_STEPS.map((s) => s.id),
    ["install", "gateway", "connection", "chat", "terminal", "naming", "project"],
  );
  for (const step of ONBOARDING_STEPS) {
    assert.ok(step.title && step.summary && step.how.length > 0, step.id);
  }
});

test("新装：什么都没有，当前步是装 Agent", () => {
  const p = onboardingProgress(blank, active);
  assert.equal(p.doneCount, 0);
  assert.equal(p.total, 7);
  assert.equal(p.current, "install");
});

test("完成判定全由数据推导，可以跳着做", () => {
  const facts = { ...blank, installedAgents: ["codex"], projectCount: 1 };
  const p = onboardingProgress(facts, active);
  assert.deepEqual(doneStepIds(p), ["install", "project"]);
  assert.equal(p.current, "gateway");
});

test("网关：建了网关、已有连接（官方账号不需要网关）、人工跳过，三种都算做完", () => {
  assert.equal(isStepDone("gateway", { ...blank, gatewayCount: 1 }, active), true);
  assert.equal(isStepDone("gateway", { ...blank, profileCount: 1 }, active), true);
  assert.equal(
    isStepDone("gateway", blank, { ...active, acks: { gateway: true } }),
    true,
  );
  assert.equal(isStepDone("gateway", blank, active), false);
});

test("切到终端、对话标题两步只认确认（真切过一次终端也记确认）", () => {
  const facts = { ...blank, userSessionCount: 3 };
  assert.equal(isStepDone("terminal", facts, active), false);
  assert.equal(isStepDone("terminal", facts, { ...active, acks: { terminal: true } }), true);
  assert.equal(isStepDone("naming", facts, active), false);
  assert.equal(isStepDone("naming", facts, { ...active, acks: { naming: true } }), true);
});

test("全部做完：current 为 null", () => {
  const facts: OnboardingFacts = {
    installedAgents: ["claude-code"],
    gatewayCount: 1,
    profileCount: 1,
    userSessionCount: 1,
    projectCount: 1,
  };
  const half = onboardingProgress(facts, { ...active, acks: { naming: true } });
  assert.equal(half.current, "terminal");
  const p = onboardingProgress(facts, { ...active, acks: { naming: true, terminal: true } });
  assert.equal(p.doneCount, 7);
  assert.equal(p.current, null);
});

test("newlyDone：只报新完成的，按步骤顺序", () => {
  assert.deepEqual(newlyDone(["install"], ["install", "gateway", "connection"]), [
    "gateway",
    "connection",
  ]);
  assert.deepEqual(newlyDone(["install", "gateway"], ["install"]), []);
  assert.deepEqual(newlyDone([], ["project", "install"]), ["install", "project"]);
});

test("首次判定：已有连接的老用户收起，其余当新用户", () => {
  assert.equal(decideInitialStatus(blank), "active");
  assert.equal(decideInitialStatus({ ...blank, installedAgents: ["codex"], gatewayCount: 2 }), "active");
  assert.equal(decideInitialStatus({ ...blank, profileCount: 1 }), "dismissed");
});

test("完成提示：有结果句的首行是结果，第二行起是下一步", () => {
  const n = completionNotice("install", "gateway", { installedLabel: "Claude Code" });
  assert.equal(n.tone, "success");
  assert.ok(n.text.startsWith("Claude Code 装好了\n下一步：新建网关"));
  assert.ok(completionNotice("connection", "chat").text.startsWith("连接已添加\n"));
});

test("完成提示：网关不重复「已保存」（网关库自己会说），直接说下一步", () => {
  const n = completionNotice("gateway", "connection");
  assert.equal(n.tone, "info");
  assert.ok(n.text.startsWith("下一步：添加连接"));
  assert.ok(n.text.includes("Agent 配置"));
  const official = completionNotice("gateway", "connection", { officialPath: true });
  assert.ok(official.text.includes("官方账号"));
  assert.ok(!official.text.includes("Agent 配置"));
});

test("完成提示：第一段对话开始时提示可以切到终端看", () => {
  const n = completionNotice("chat", "terminal");
  assert.ok(n.text.startsWith("第一段对话开始了\n对话可以切到终端看\n"));
  assert.ok(n.text.includes("看这段对话的终端"), "说的是现在按钮上的字");
  assert.ok(n.text.includes("不会打断 AI"));
});

test("完成提示：切过终端之后讲对话标题与怎么改名（没有结果句，首行就是标题）", () => {
  const n = completionNotice("terminal", "naming");
  assert.equal(n.tone, "info");
  assert.ok(n.text.startsWith("对话会自动起标题\n"));
  assert.ok(n.text.includes("月日|类型|主题"));
  assert.ok(n.text.includes("编辑标题与标签"));
  // 2026-10-24 侧栏改版：项目页没有「对话」页签了，改名先指侧栏右键
  assert.ok(n.text.includes("侧栏") && n.text.includes("重命名"));
  assert.ok(!n.text.includes("页签"));
});

test("完成提示：全部做完给收尾句", () => {
  const n = completionNotice("project", null);
  assert.equal(n.tone, "success");
  assert.ok(n.text.startsWith("上手完成"));
  assert.ok(n.text.includes("帮助"));
});

test("本地存档：往返一致；损坏、旧格式、未知字段都安全回落", () => {
  const state: OnboardingState = {
    status: "active",
    welcomed: true,
    acks: { naming: true, gateway: true, terminal: true },
  };
  assert.deepEqual(parseOnboarding(serializeOnboarding(state)), state);
  assert.deepEqual(parseOnboarding(null), DEFAULT_ONBOARDING);
  assert.deepEqual(parseOnboarding("{oops"), DEFAULT_ONBOARDING);
  assert.deepEqual(
    parseOnboarding(JSON.stringify({ status: "weird", welcomed: "yes", acks: { naming: 1, bogus: true } })),
    DEFAULT_ONBOARDING,
  );
});
