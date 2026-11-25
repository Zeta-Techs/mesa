import assert from "node:assert/strict";
import test from "node:test";
import {
  breakdownRequest,
  breakdownSupported,
  categoryLabel,
  contextUsageSupported,
  contextView,
  estimateLocalBreakdown,
  fmtRatio,
  headlessBreakdownSupported,
  localBackendBreakdown,
  longContextHint,
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

test("支持读分类的家：Claude / Qwen 走 /context，Antigravity 走本地日志估算", () => {
  assert.equal(breakdownSupported("claude-code"), true);
  assert.equal(breakdownSupported("qwen"), true);
  assert.equal(breakdownSupported("agy"), true);
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

test("有分类：四大类各一色、固定顺序（不按大小排），小类同灰，再是自动压缩预留与剩余", () => {
  const v = contextView(claude, { used: 300_000, window: 1_000_000 });
  assert.deepEqual(
    v.rows.map((r) => [r.label, r.tokens, r.tone, r.color]),
    [
      ["对话", 272_300, "series", "#3987e5"],
      ["内置工具", 26_400, "series", "#199e70"],
      ["系统提示", 2_200, "series", "#c98500"],
      ["技能", 2_000, "minor", null],
      ["自动压缩预留", 33_000, "reserve", null],
      ["剩余", 664_100, "free", null],
    ],
  );
  // 横条：已占用的各段同序，剩余是底色
  assert.deepEqual(
    v.bar.segments.map((s) => [s.tone, s.color]),
    [
      ["series", "#3987e5"],
      ["series", "#199e70"],
      ["series", "#c98500"],
      ["minor", null],
    ],
  );
  assert.equal(v.bar.segments[0].ratio, 0.2723);
  assert.equal(v.bar.compactAt, 0.967);
  assert.equal(v.untilCompact, 664_100);
});

test("颜色跟着分类走：换主题换一套深浅、MCP 工具有自己的颜色、小到看不见的段不进横条", () => {
  const withMcp: ContextBreakdown = {
    ...claude,
    categories: [{ key: "Memory files", tokens: 346 }, { key: "MCP tools", tokens: 62_100 }, ...claude.categories],
  };
  const v = contextView(withMcp, { used: 1, window: 1 }, true);
  assert.deepEqual(
    v.rows.slice(0, 3).map((r) => [r.label, r.color]),
    [
      ["对话", "#2a78d6"],
      ["MCP 工具", "#eb6834"],
      ["内置工具", "#1baf7a"],
    ],
  );
  assert.ok(v.rows.some((r) => r.label === "记忆文件"), "列表里照列");
  assert.equal(v.bar.segments.length, 5, "记忆文件 346 / 100 万不到 0.2%，横条上略去");
  // Qwen 的内置工具与 Claude 的同色
  const qwen = contextView(
    { window: 200_000, used: 5_000, untilCompact: null, categories: [{ key: "Built-in tools", tokens: 5_000 }] },
    { used: 1, window: 1 },
  );
  assert.equal(qwen.rows.find((r) => r.label === "内置工具")?.color, "#199e70");
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
  assert.deepEqual(v.bar, { segments: [{ ratio: 0.25, tone: "used", color: null }], compactAt: null });
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

test("上下文过 30 万提示回复会变慢、新开对话会快（54 万 token 首字 30 秒起的实测）", () => {
  assert.equal(longContextHint(120_000), null);
  assert.equal(longContextHint(545_023), "对话已有 55 万 token，回复会变慢，新开对话会快");
});

test("逐轮上下文支持表与前后端分类策略：7 家常显、Antigravity 本地后端、Claude/Qwen 按需校准", () => {
  for (const id of ["agy", "claude-code", "codex", "gemini", "kimi", "qwen", "opencode"]) {
    assert.equal(contextUsageSupported(id), true, id);
  }
  for (const id of ["grok", "codebuddy", "cursor", ""]) {
    assert.equal(contextUsageSupported(id), false, id);
  }
  assert.equal(localBackendBreakdown("agy"), true);
  assert.equal(localBackendBreakdown("claude-code"), false);
  assert.equal(headlessBreakdownSupported("claude-code"), true);
  assert.equal(headlessBreakdownSupported("qwen"), true);
  assert.equal(headlessBreakdownSupported("agy"), false);
});

test("estimateLocalBreakdown：按末次压缩切段，估算对话/工具/思考并锚定末轮真实总量", () => {
  const msgs = [
    {
      role: "assistant",
      blocks: [{ kind: "text", text: "旧内容".repeat(500) }],
      usage: { input: 25_000, cacheRead: 15_000, cacheWrite: 0 },
    },
    // 上下文骤降（40K → 10K）记为一次压缩，只统计此后的块
    {
      role: "user",
      blocks: [{ kind: "text", text: "请帮我看下代码" }],
      usage: null,
    },
    {
      role: "assistant",
      blocks: [
        { kind: "thinking", text: "先检查文件结构和接口定义".repeat(20) },
        { kind: "tool_use", toolName: "read_file", text: "src/main.ts" },
        { kind: "tool_result", toolName: "read_file", text: "export const ok = true;\n".repeat(40) },
        { kind: "text", text: "已经检查完毕，接口正常。" },
      ],
      usage: { input: 1_500, cacheRead: 8_000, cacheWrite: 500 },
    },
  ];
  const res = estimateLocalBreakdown(msgs, 10_000, 200_000);
  assert.ok(res);
  assert.equal(res.window, 200_000);
  assert.equal(res.used, 10_000);
  assert.equal(res.compactions, 1);
  assert.equal(res.cacheRead, 8_000);
  assert.equal(res.freshInput, 2_000);
  const sum = res.categories.reduce((acc, c) => acc + c.tokens, 0);
  assert.equal(sum, 10_000, "各分类之和严格等于真实 used");
  assert.deepEqual(
    res.categories.map((c) => c.key),
    ["Messages", "Tool outputs", "Thinking", "System & tools"],
  );
  // 估算超出 used 时按比例缩回，总和仍精确等于 used
  const small = estimateLocalBreakdown(msgs, 100, 200_000);
  assert.ok(small);
  assert.equal(
    small.categories.reduce((acc, c) => acc + c.tokens, 0),
    100,
  );
  assert.equal(estimateLocalBreakdown(msgs, 0, 200_000), null);
});

test("Codex 会话图片过重：8MB 起提醒变慢，13MB 起提醒随时卡住", async () => {
  const { imageWeightNote, IMAGE_SLOW_BYTES, IMAGE_STUCK_BYTES } = await import("../src/context-breakdown.ts");
  assert.equal(imageWeightNote(null), null);
  assert.equal(imageWeightNote(IMAGE_SLOW_BYTES - 1), null);
  assert.equal(imageWeightNote(IMAGE_SLOW_BYTES)?.level, "slow");
  const stuck = imageWeightNote(IMAGE_STUCK_BYTES + 1);
  assert.equal(stuck?.level, "stuck");
  assert.match(stuck?.text ?? "", /13\.0 MB 图片/);
});
