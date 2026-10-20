import assert from "node:assert/strict";
import test from "node:test";
import {
  extraBindTargets,
  gatewayDraftSlots,
  intersectCatalog,
  sameModelList,
} from "../src/preset-flow.ts";
import { PROVIDER_PRESETS } from "../src/presets.ts";

test("intersectCatalog 保推荐顺序、按目录过滤；交集空返回空", () => {
  assert.deepEqual(
    intersectCatalog(
      ["glm-5.3", "deepseek-v4-flash", "kimi-k3"],
      ["kimi-k3", "glm-5.3"],
    ),
    ["glm-5.3", "kimi-k3"],
  );
  assert.deepEqual(intersectCatalog(["a"], ["b"]), []);
  // 目录有而推荐没有的不自动加（整目录预填红线）
  assert.deepEqual(intersectCatalog([], ["x", "y"]), []);
});

test("sameModelList 识别用户是否动过名单", () => {
  assert.ok(sameModelList(["a", "b"], ["a", "b"]));
  assert.ok(!sameModelList(["a", "b"], ["b", "a"]));
  assert.ok(!sameModelList(["a"], ["a", "a"]));
  assert.ok(!sameModelList([], ["a"]));
});

test("extraBindTargets：Anthropic 族内可绑 codebuddy/qwen(anthropic)/kimi(anthropic)", () => {
  const by = Object.fromEntries(
    extraBindTargets("claude-code", null, [
      "codebuddy",
      "codex",
      "qwen",
      "kimi",
      "gemini",
      "cursor",
      "opencode",
      "grok",
    ]).map((t) => [t.agent, t]),
  );
  assert.equal(by.codebuddy.ok, true);
  assert.equal(by.codebuddy.protocol, null);
  assert.equal(by.qwen.ok, true);
  assert.equal(by.qwen.protocol, "anthropic");
  assert.equal(by.kimi.ok, true);
  assert.equal(by.kimi.protocol, "anthropic");
  // codex 走 responses 槽，Anthropic 端点接不上
  assert.equal(by.codex.ok, false);
  assert.ok(by.codex.reason);
  assert.equal(by.gemini.ok, false);
  assert.equal(by.cursor.ok, false);
});

test("extraBindTargets：OpenAI 族内 kimi 优先 openai 协议（第三方端点最稳）", () => {
  const by = Object.fromEntries(
    extraBindTargets("opencode", null, [
      "claude-code",
      "codex",
      "qwen",
      "kimi",
      "gemini",
      "cursor",
    ]).map((t) => [t.agent, t]),
  );
  assert.equal(by.codex.ok, true);
  assert.equal(by.codex.protocol, null);
  assert.equal(by.qwen.ok, true);
  assert.equal(by.qwen.protocol, "openai");
  assert.equal(by.kimi.ok, true);
  assert.equal(by.kimi.protocol, "openai");
  assert.equal(by["claude-code"].ok, false);
  assert.equal(by.cursor.ok, false);
});

test("extraBindTargets 排除来源 Agent 自身", () => {
  const targets = extraBindTargets("claude-code", null, [
    "claude-code",
    "codex",
  ]);
  assert.deepEqual(
    targets.map((t) => t.agent),
    ["codex"],
  );
});

test("gatewayDraftSlots：主槽 = 表单地址，额外 Agent 缺省同址回落", () => {
  const slots = gatewayDraftSlots(
    { agent: "qwen", protocol: "openai", baseUrl: "https://relay.example/v1" },
    [
      { agent: "codex", protocol: null },
      { agent: "kimi", protocol: "openai" },
    ],
    null,
  );
  assert.equal(slots.openai, "https://relay.example/v1");
  // codex 的 responses 槽回落同一地址（中转同址惯例）
  assert.equal(slots.responses, "https://relay.example/v1");
  assert.equal(slots.anthropic, undefined);
});

test("gatewayDraftSlots：智谱分槽端点以预设值为准，不被同址回落盖掉", () => {
  const glm = PROVIDER_PRESETS.find((p) => p.name === "智谱 GLM（按量付费）")!;
  const slots = gatewayDraftSlots(
    {
      agent: "qwen",
      protocol: "openai",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    },
    [{ agent: "codex", protocol: null }],
    glm,
  );
  assert.equal(slots.openai, "https://open.bigmodel.cn/api/paas/v4");
  // 主槽跟随表单地址；responses 槽用预设专用端点（paas/v4 打 /responses 会 404）
  assert.equal(slots.responses, "https://open.bigmodel.cn/api/v1");
  assert.equal(slots.anthropic, "https://open.bigmodel.cn/api/anthropic");
});

test("gatewayDraftSlots：主槽永远跟随表单地址，预设不覆盖", () => {
  const ds = PROVIDER_PRESETS.find((p) => p.name === "DeepSeek")!;
  const slots = gatewayDraftSlots(
    { agent: "qwen", protocol: "openai", baseUrl: "https://my-relay.example/v1" },
    [],
    ds,
  );
  assert.equal(slots.openai, "https://my-relay.example/v1");
  assert.equal(slots.anthropic, "https://api.deepseek.com/anthropic");
});
