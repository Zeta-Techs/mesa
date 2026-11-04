import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogVendors,
  modelVendor,
  modelVersion,
  planAutoConfig,
  rowModels,
  rowRoleModels,
  vendorPicks,
} from "../src/gateway-autoconfig.ts";
import { PROVIDER_PRESETS } from "../src/presets.ts";
import type { GatewayModel } from "../src/types.ts";

const cat = (...ids: string[]): GatewayModel[] =>
  ids.map((id) => ({
    id,
    source: "fetched",
    temperature: null,
    topP: null,
    maxOutputTokens: null,
    reasoningEffort: null,
  }));

const allSlots = (url: string) => ({ anthropic: url, openai: `${url}/v1`, responses: `${url}/v1`, gemini: url, cursor: url });

test("modelVersion 取型号版本，日期与参数量不算", () => {
  assert.deepEqual(modelVersion("claude-opus-4-7-20260101"), [4, 7]);
  assert.deepEqual(modelVersion("claude-3-5-sonnet-20241022"), [3, 5]);
  assert.deepEqual(modelVersion("gpt-5.6-sol"), [5, 6]);
  assert.deepEqual(modelVersion("kimi-k2.5"), [2, 5]);
  assert.deepEqual(modelVersion("kimi-k2-0905-preview"), [2]);
  assert.deepEqual(modelVersion("qwen2.5-72b-instruct"), [2, 5]);
  assert.deepEqual(modelVersion("qwen3-coder-480b-a35b"), [3]);
  assert.deepEqual(modelVersion("gemini-2.5-flash-preview-05-20"), [2, 5]);
  assert.deepEqual(modelVersion("anthropic/claude-sonnet-4.5"), [4, 5]);
  assert.deepEqual(modelVersion("deepseek-chat"), []);
  // 年月日、上下文长度不算版本（2026-11-04 用户 Zeta 网关实例）
  assert.deepEqual(modelVersion("qwen-plus-2025-09-11"), []);
  assert.deepEqual(modelVersion("doubao-pro-32k-241215"), []);
  assert.deepEqual(modelVersion("doubao-seed-2-0-pro-260215"), [2, 0]);
  assert.deepEqual(modelVersion("grok-4.20-0309-reasoning"), [4, 20]);
});

test("用户 Zeta 网关真实目录片段：各家都挑到最新", () => {
  const c = cat(
    "qwen-plus-2025-09-11", "qwen3.7-max", "qwen3.8-max", "qwen3.7-max-2026-05-17",
    "grok-4.20-0309-reasoning", "grok-4.5", "grok-4.7", "grok-3-mini",
    "doubao-pro-32k-241215", "doubao-seed-2-0-pro-260215", "doubao-seed-1-8-251228",
    "gpt-5.5", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.4-mini",
    "claude-opus-4-8", "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
  );
  assert.equal(vendorPicks(c, "qwen").flagships[0], "qwen3.8-max");
  assert.equal(vendorPicks(c, "grok").flagships[0], "grok-4.7", "4.20 按小数是 4.2，旧于 4.7");
  assert.equal(vendorPicks(c, "doubao").flagships[0], "doubao-seed-2-0-pro-260215");
  assert.equal(vendorPicks(c, "gpt").flagships[0], "gpt-6.1-sol");
  assert.deepEqual(
    { top: vendorPicks(c, "claude").flagships[0], light: vendorPicks(c, "claude").light },
    { top: "claude-opus-5-5", light: "claude-haiku-5-5" },
  );
});

test("modelVendor 认厂商，带前缀与方括号标签也认", () => {
  assert.equal(modelVendor("anthropic/claude-opus-4.7"), "claude");
  assert.equal(modelVendor("[特价]gpt-5.5"), "gpt");
  assert.equal(modelVendor("o3-pro"), "gpt");
  assert.equal(modelVendor("deepseek-r1-distill-qwen-32b"), "deepseek");
  assert.equal(modelVendor("MiniMax-M3"), "minimax");
  assert.equal(modelVendor("moonshot-v1-128k"), "kimi");
  assert.equal(modelVendor("llama-4"), null);
});

test("vendorPicks：最新旗舰在前，轻量另取；搜索、语音、出图变体不选", () => {
  const c = cat(
    "claude-sonnet-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7-20260101",
    "claude-opus-4-7",
    "claude-opus-4-7-thinking",
    "claude-haiku-4-5",
    "claude-3-5-haiku-20241022",
  );
  const p = vendorPicks(c, "claude");
  assert.equal(p.flagships[0], "claude-opus-4-7");
  assert.equal(p.light, "claude-haiku-4-5");

  const g = vendorPicks(cat("gpt-5.5-search", "gpt-5.5", "gpt-5.5-pro", "gpt-5.5-mini", "gpt-image-2", "gpt-4o-audio-preview"), "gpt");
  assert.equal(g.flagships[0], "gpt-5.5", "-pro 不当日常旗舰，-search 不选");
  assert.ok(!g.flagships.includes("gpt-5.5-search"));
  assert.ok(!g.flagships.includes("gpt-image-2"));
  assert.equal(g.light, "gpt-5.5-mini");

  // 只有轻量型号的厂商：轻量的顶旗舰
  const f = vendorPicks(cat("glm-5.3-flash"), "glm");
  assert.deepEqual(f, { flagships: ["glm-5.3-flash"], light: null });
});

test("聚合网关：原厂 CLI 配原厂模型，没有这家的不拿别家顶", () => {
  const gw = {
    id: "g1",
    slots: allSlots("https://relay.example.com"),
    models: cat("gpt-5.6", "gpt-5.6-mini", "claude-opus-4-7", "claude-haiku-4-5", "gemini-3-pro", "gemini-3-flash"),
  };
  const rows = planAutoConfig({
    gateway: gw,
    installed: ["claude-code", "codex", "gemini", "grok", "opencode", "cursor"],
    profiles: [],
    presets: PROVIDER_PRESETS,
  });
  const by = Object.fromEntries(rows.map((r) => [r.agent, r]));
  assert.equal(by["claude-code"].defaultModel, "claude-opus-4-7");
  assert.deepEqual(rowModels(by["claude-code"], "claude-opus-4-7"), ["claude-opus-4-7", "claude-haiku-4-5"]);
  assert.deepEqual(rowRoleModels(by["claude-code"], "claude-opus-4-7"), {
    small: "claude-haiku-4-5",
    subagent: null,
    slots: {},
  });
  assert.equal(by.codex.defaultModel, "gpt-5.6");
  assert.equal(by.codex.slot, "responses");
  assert.equal(by.gemini.defaultModel, "gemini-3-pro");
  assert.match(by.grok.skip ?? "", /没有 Grok/);
  assert.match(by.cursor.skip ?? "", /Cursor/);
  // 多厂商 CLI：各家旗舰按目录出现顺序，默认不预选
  assert.equal(by.opencode.multi, true);
  assert.deepEqual(by.opencode.options, ["gpt-5.6", "claude-opus-4-7", "gemini-3-pro"]);
  assert.equal(by.opencode.defaultModel, null);
  assert.deepEqual(rowModels(by.opencode, "claude-opus-4-7"), [
    "claude-opus-4-7",
    "gpt-5.6",
    "gemini-3-pro",
    "claude-haiku-4-5",
  ]);
  assert.equal(rowRoleModels(by.opencode, "claude-opus-4-7").small, "claude-haiku-4-5");
});

test("单厂商网关：每个 CLI 都配这家；Kimi 按预设走官方协议", () => {
  const zhipu = {
    id: "z",
    slots: {
      anthropic: "https://open.bigmodel.cn/api/anthropic",
      openai: "https://open.bigmodel.cn/api/coding/paas/v4",
      responses: "https://open.bigmodel.cn/api/v1",
    },
    models: cat("glm-4.6", "glm-5.3", "glm-5.3-flash", "glm-5"),
  };
  const rows = planAutoConfig({
    gateway: zhipu,
    installed: ["claude-code", "codex", "gemini", "opencode", "qwen"],
    profiles: [],
    presets: PROVIDER_PRESETS,
  });
  const by = Object.fromEntries(rows.map((r) => [r.agent, r]));
  assert.equal(by["claude-code"].defaultModel, "glm-5.3");
  assert.equal(by.codex.defaultModel, "glm-5.3");
  assert.match(by.gemini.skip ?? "", /Gemini 协议地址/);
  assert.equal(by.opencode.multi, false);
  assert.deepEqual(rowModels(by.opencode, "glm-5.3"), ["glm-5.3", "glm-5.3-flash"]);
  assert.equal(by.qwen.protocol, "openai");

  const kimi = {
    id: "k",
    slots: { openai: "https://api.moonshot.cn/v1", responses: "https://api.moonshot.cn/v1" },
    models: cat("kimi-k2.5", "kimi-k3", "moonshot-v1-8k"),
  };
  const [k] = planAutoConfig({ gateway: kimi, installed: ["kimi"], profiles: [], presets: PROVIDER_PRESETS });
  assert.equal(k.protocol, "kimi");
  assert.equal(k.defaultModel, "kimi-k3");
});

test("已有一模一样的连接时标出来（后端会拒绝重复建）", () => {
  const gw = { id: "g1", slots: allSlots("https://r.example"), models: cat("claude-opus-4-7", "claude-haiku-4-5") };
  const [row] = planAutoConfig({
    gateway: gw,
    installed: ["claude-code"],
    profiles: [
      {
        agent: "claude-code",
        gatewayId: "g1",
        protocol: null,
        models: ["claude-opus-4-7", "claude-haiku-4-5"],
        extraEnv: {},
        name: "老连接",
      },
    ],
    presets: PROVIDER_PRESETS,
  });
  assert.equal(row.duplicateOf, "老连接");
});

test("catalogVendors 不排名次，按目录出现顺序", () => {
  assert.deepEqual(catalogVendors(cat("qwen3.7-plus", "glm-5.3", "qwen3-coder-plus", "embedding-3")), ["qwen", "glm"]);
});
