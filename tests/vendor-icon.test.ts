import assert from "node:assert/strict";
import test from "node:test";
import {
  isMonoVendor,
  vendorForGateway,
  vendorForPlanProvider,
  vendorForOfficialAgent,
  vendorForProfile,
  vendorForSlots,
  vendorForUrl,
} from "../src/vendor-icon.ts";

test("官方端点认出厂商，含子域与无协议写法", () => {
  assert.equal(vendorForUrl("https://api.anthropic.com"), "anthropic");
  assert.equal(vendorForUrl("https://api.deepseek.com/anthropic"), "deepseek");
  assert.equal(vendorForUrl("https://open.bigmodel.cn/api/coding/paas/v4"), "zhipu");
  assert.equal(vendorForUrl("https://api.moonshot.cn/v1"), "kimi");
  assert.equal(vendorForUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"), "alibaba");
  assert.equal(vendorForUrl("https://copilot.tencent.com"), "tencent");
  assert.equal(vendorForUrl("https://www.codebuddy.ai"), "tencent");
  assert.equal(vendorForUrl("https://api.x.ai/v1"), "xai");
  assert.equal(vendorForUrl("openrouter.ai/api/v1"), "openrouter");
  assert.equal(vendorForUrl("http://localhost:11434/v1"), "ollama");
});

test("不认第三方中转，也不被冒名域名骗到", () => {
  assert.equal(vendorForUrl("https://relay.example.com/v1"), null);
  assert.equal(vendorForUrl("https://api.openai.com.evil.example/v1"), null);
  assert.equal(vendorForUrl("https://notopenai.com/v1"), null);
  assert.equal(vendorForUrl("https://box.ai/v1"), null);
  assert.equal(vendorForUrl("http://localhost:8080/v1"), null);
  assert.equal(vendorForUrl(""), null);
  assert.equal(vendorForUrl(null), null);
  assert.equal(vendorForUrl("not a url ::"), null);
});

test("网关按槽顺序取第一个认得出的", () => {
  assert.equal(vendorForSlots({ anthropic: "https://relay.example.com", openai: "https://api.deepseek.com/v1" }), "deepseek");
  assert.equal(vendorForSlots({ anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1" }), "anthropic");
  assert.equal(vendorForSlots({}), null);
});

test("单色图标走 mask，彩色走 img；套餐键只认三家", () => {
  for (const v of ["anthropic", "openai", "kimi", "openrouter", "xai", "ollama"] as const) assert.ok(isMonoVendor(v), v);
  for (const v of ["deepseek", "zhipu", "minimax", "alibaba", "tencent", "newapi"] as const) assert.ok(!isMonoVendor(v), v);
  assert.equal(vendorForPlanProvider("zhipu"), "zhipu");
  assert.equal(vendorForPlanProvider("other"), null);
});

test("New API 站：命中钱包站或配了钱包才标，官方厂商域名优先，普通中转不标", () => {
  const relay = { anthropic: "https://relay.example.com/v1" };
  assert.equal(vendorForGateway({ slots: relay }), null);
  assert.equal(vendorForGateway({ slots: relay, walletUserId: "42" }), "newapi");
  assert.equal(vendorForGateway({ slots: relay, walletKeyHint: "…abcd" }), "newapi");
  assert.equal(vendorForGateway({ slots: { openai: "https://api.zetatechs.com/v1" } }), "newapi");
  assert.equal(vendorForGateway({ slots: { openai: "https://api.deepseek.com/v1" }, walletUserId: "1" }), "deepseek");
});

test("连接行：自己的地址优先，认不出再看所属网关", () => {
  const gw = { slots: { openai: "https://relay.example.com/v1" }, walletUserId: "7" };
  assert.equal(vendorForProfile("https://relay.example.com/v1", gw), "newapi");
  assert.equal(vendorForProfile("https://api.openai.com/v1", gw), "openai");
  assert.equal(vendorForProfile(null, null), null);
  assert.equal(vendorForProfile("https://relay.example.com/v1", undefined), null);
});

test("官方账号按 Agent 认厂商，OpenCode 没有", () => {
  assert.equal(vendorForOfficialAgent("claude-code"), "anthropic");
  assert.equal(vendorForOfficialAgent("codex"), "openai");
  assert.equal(vendorForOfficialAgent("gemini"), "gemini");
  assert.equal(vendorForOfficialAgent("grok"), "xai");
  assert.equal(vendorForOfficialAgent("cursor"), "cursor");
  assert.equal(isMonoVendor("cursor"), true);
  assert.equal(vendorForOfficialAgent("opencode"), null);
  assert.equal(vendorForUrl("https://generativelanguage.googleapis.com/v1beta"), "gemini");
});

test("vendorForModel：按模型家族认厂商，认不出给 null", async () => {
  const { vendorForModel } = await import("../src/vendor-icon.ts");
  assert.equal(vendorForModel("gpt-image-1"), "openai");
  assert.equal(vendorForModel("openai/dall-e-3"), "openai");
  assert.equal(vendorForModel("gemini-2.5-flash-image"), "gemini");
  assert.equal(vendorForModel("imagen-4.0-generate"), "gemini");
  assert.equal(vendorForModel("grok-2-image"), "xai");
  assert.equal(vendorForModel("cogview-4"), "zhipu");
  assert.equal(vendorForModel("wanx2.1-t2i-turbo"), "alibaba");
  assert.equal(vendorForModel("qwen-image"), "alibaba");
  assert.equal(vendorForModel("hunyuan-image"), "tencent");
  assert.equal(vendorForModel("doubao-seedream-4-0"), null);
  assert.equal(vendorForModel("flux-1.1-pro"), null);
  assert.equal(vendorForModel(""), null);
  assert.equal(vendorForModel(null), null);
});
