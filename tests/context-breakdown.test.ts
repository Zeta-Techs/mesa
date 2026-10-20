import assert from "node:assert/strict";
import test from "node:test";
import {
  breakdownRequest,
  breakdownSupported,
  categoryLabel,
  contextView,
  fmtRatio,
  type ContextBreakdown,
} from "../src/context-breakdown.ts";

const status = {
  agentId: "claude-code",
  profileId: "p1",
  cwd: "/w",
  sessionId: "s1",
  launchModel: null,
  model: "glm-5.3",
};

test("只有能在后台跑 /context 的家才去读分类", () => {
  assert.equal(breakdownSupported("claude-code"), true);
  assert.equal(breakdownSupported("qwen"), true);
  assert.equal(breakdownSupported("codex"), false);
  assert.equal(breakdownSupported("codebuddy"), false, "无头模式把 /context 当普通提问发给模型");
  assert.deepEqual(breakdownRequest(status), {
    agentId: "claude-code",
    profileId: "p1",
    cwd: "/w",
    model: "glm-5.3",
    sessionId: "s1",
  });
  assert.equal(breakdownRequest({ ...status, launchModel: "glm-5.2" })?.model, "glm-5.2", "按启动时的模型");
  assert.equal(breakdownRequest({ ...status, sessionId: null }), null);
  assert.equal(breakdownRequest({ ...status, agentId: "codex" }), null);
  assert.equal(breakdownRequest(null), null);
});

// 2026-10-20 Claude Code 实录换算（context_breakdown.rs 测试同一份）
const claude: ContextBreakdown = {
  window: 1_000_000,
  used: 302_900,
  untilCompact: 664_100,
  categories: [
    { key: "System prompt", tokens: 2_200 },
    { key: "System tools", tokens: 26_400 },
    { key: "Skills", tokens: 2_000 },
    { key: "Messages", tokens: 272_300 },
  ],
};

test("有分类：对话打头，固定开销按大小排，再是自动压缩预留与剩余", () => {
  const v = contextView(claude, { used: 300_000, window: 1_000_000 });
  assert.deepEqual(
    v.rows.map((r) => [r.label, r.tokens, r.tone]),
    [
      ["对话", 272_300, "conversation"],
      ["内置工具", 26_400, "overhead"],
      ["系统提示", 2_200, "overhead"],
      ["技能", 2_000, "overhead"],
      ["自动压缩预留", 33_000, "reserve"],
      ["剩余", 664_100, "free"],
    ],
  );
  assert.equal(v.bar.conversation, 0.2723);
  assert.equal(Math.round(v.bar.overhead * 10000), 306);
  assert.equal(v.bar.compactAt, 0.967);
  assert.equal(v.untilCompact, 664_100);
});

test("没有分类：只有已用 / 剩余，横条一段，不画压缩线", () => {
  const v = contextView(null, { used: 50_000, window: 200_000 });
  assert.deepEqual(
    v.rows.map((r) => [r.label, r.tokens, r.tone]),
    [
      ["已用", 50_000, "used"],
      ["剩余", 150_000, "free"],
    ],
  );
  assert.deepEqual(v.bar, { conversation: 0.25, overhead: 0, compactAt: null });
  assert.equal(v.untilCompact, null);
});

test("CLI 没给压缩点：剩余 = 窗口 − 已用，没有预留行", () => {
  const v = contextView({ ...claude, untilCompact: null }, { used: 1, window: 1 });
  assert.equal(v.rows.at(-1)?.tokens, 697_100);
  assert.ok(!v.rows.some((r) => r.tone === "reserve"));
  assert.equal(v.bar.compactAt, null);
});

test("分类名与百分比", () => {
  assert.equal(categoryLabel("Built-in tools"), "内置工具");
  assert.equal(categoryLabel("Something new"), "Something new", "认不得的照原文");
  assert.equal(fmtRatio(0.2723), "27.2%");
  assert.equal(fmtRatio(0.0002), "<0.1%");
  assert.equal(fmtRatio(0), "0.0%");
});
