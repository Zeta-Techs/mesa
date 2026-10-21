import assert from "node:assert/strict";
import test from "node:test";
import { apiKindOf, copyTargets } from "../src/profile-copy.ts";

test("apiKindOf 协议族归类与后端同口径", () => {
  assert.equal(apiKindOf("claude-code", null), "anthropic");
  assert.equal(apiKindOf("codebuddy", null), "openai");
  assert.equal(apiKindOf("gemini", null), "gemini");
  assert.equal(apiKindOf("cursor", null), "cursor");
  assert.equal(apiKindOf("codex", null), "openai");
  assert.equal(apiKindOf("opencode", null), "openai");
  assert.equal(apiKindOf("grok", null), "openai");
  assert.equal(apiKindOf("qwen", "anthropic"), "anthropic");
  assert.equal(apiKindOf("qwen", "openai"), "openai");
  assert.equal(apiKindOf("kimi", "kimi"), "openai");
});

test("copyTargets 排除自身并禁用不同协议族", () => {
  const fromClaude = copyTargets("claude-code", null);
  assert.ok(!fromClaude.some((t) => t.id === "claude-code"));
  const byId = Object.fromEntries(fromClaude.map((t) => [t.id, t]));
  // anthropic 族：qwen/kimi（多协议可选 anthropic）可用
  assert.equal(byId["qwen"].compatible, true);
  assert.equal(byId["kimi"].compatible, true);
  // openai/gemini/cursor 族禁用并带原因（codebuddy 走 OpenAI chat/completions，2026-10-21）
  for (const id of ["codebuddy", "codex", "opencode", "gemini", "cursor", "grok"]) {
    assert.equal(byId[id].compatible, false, id);
    assert.ok(byId[id].reason?.includes("协议不兼容"), id);
  }

  const fromCodex = copyTargets("codex", null);
  const byId2 = Object.fromEntries(fromCodex.map((t) => [t.id, t]));
  assert.equal(byId2["opencode"].compatible, true);
  assert.equal(byId2["grok"].compatible, true);
  assert.equal(byId2["qwen"].compatible, true);
  assert.equal(byId2["claude-code"].compatible, false);
  assert.equal(byId2["cursor"].compatible, false);

  // cursor 专有协议：谁都不兼容
  const fromCursor = copyTargets("cursor", null);
  assert.ok(fromCursor.every((t) => !t.compatible));
});
