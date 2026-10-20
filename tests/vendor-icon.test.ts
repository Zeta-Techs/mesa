import assert from "node:assert/strict";
import test from "node:test";
import { isMonoVendor, vendorForPlanProvider, vendorForSlots, vendorForUrl } from "../src/vendor-icon.ts";

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
  for (const v of ["deepseek", "zhipu", "minimax", "alibaba", "tencent"] as const) assert.ok(!isMonoVendor(v), v);
  assert.equal(vendorForPlanProvider("zhipu"), "zhipu");
  assert.equal(vendorForPlanProvider("other"), null);
});
