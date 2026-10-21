import assert from "node:assert/strict";
import test from "node:test";
import { agentForSlot, firstFilledCatalogSlot, slotForAgent } from "../src/gateway-slot.ts";

test("slotForAgent 与后端槽表一致", () => {
  assert.equal(slotForAgent("claude-code"), "anthropic");
  assert.equal(slotForAgent("codex"), "responses");
  assert.equal(slotForAgent("gemini"), "gemini");
  assert.equal(slotForAgent("cursor"), "cursor");
  assert.equal(slotForAgent("grok"), "openai");
  assert.equal(slotForAgent("opencode"), "openai");
  assert.equal(slotForAgent("kimi", "anthropic"), "anthropic");
  assert.equal(slotForAgent("kimi", "kimi"), "openai");
  assert.equal(slotForAgent("qwen"), "openai");
  assert.equal(slotForAgent("codebuddy"), "openai");
});

test("firstFilledCatalogSlot：优先记住的槽，否则 Anthropic 先于 OpenAI", () => {
  const mixed = {
    anthropic: "https://a",
    openai: "https://o",
    responses: "",
    gemini: "",
  };
  assert.equal(firstFilledCatalogSlot(mixed, "openai"), "openai");
  assert.equal(firstFilledCatalogSlot(mixed), "anthropic");
  assert.equal(
    firstFilledCatalogSlot({ openai: "https://o", anthropic: "" }),
    "openai",
  );
  assert.equal(firstFilledCatalogSlot({ cursor: "https://c" }), null);
});

test("agentForSlot 与后端探针 Agent 一致", () => {
  assert.equal(agentForSlot("anthropic"), "claude-code");
  assert.equal(agentForSlot("openai"), "opencode");
  assert.equal(agentForSlot("responses"), "codex");
  assert.equal(agentForSlot("gemini"), "gemini");
  assert.equal(agentForSlot("cursor"), "cursor");
});
