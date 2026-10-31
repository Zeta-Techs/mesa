import assert from "node:assert/strict";
import test from "node:test";
import { gatewayMissingSlot, probeHint, saveBlocker } from "../src/connection-form.ts";

test("失败下一步提示按状态码给", () => {
  assert.match(probeHint("HTTP 401 unauthorized"), /密钥/);
  assert.match(probeHint("HTTP 404"), /地址和模型名/);
  assert.match(probeHint("HTTP 503 No available channel"), /换一个模型/);
  assert.equal(probeHint("connection refused"), "");
});

test("网关能不能给这家 Agent 用：按协议槽判，Qwen / Kimi 两种协议任一", () => {
  assert.equal(gatewayMissingSlot({ openai: "https://x/v1" }, "codex"), "Responses（Codex）");
  assert.equal(gatewayMissingSlot({ anthropic: "https://x" }, "claude-code"), null);
  assert.equal(gatewayMissingSlot({ anthropic: "https://x" }, "qwen"), null);
  assert.match(gatewayMissingSlot({ gemini: "https://g" }, "kimi") ?? "", /OpenAI 兼容或 Anthropic/);
});

test("保存前缺什么：按表单顺序报第一样", () => {
  const base = { accountType: "api" as const, usesExisting: false, gatewayPicked: false, newGateway: true, baseUrl: "", name: "" };
  assert.equal(saveBlocker(base), "先填地址", "没填地址时不报「起名字」（自动名为空是因为没地址）");
  assert.equal(saveBlocker({ ...base, usesExisting: true, newGateway: false }), "先选一个网关");
  assert.equal(saveBlocker({ ...base, baseUrl: "https://x" }), "先给这条连接起个名字");
  assert.equal(saveBlocker({ ...base, baseUrl: "https://x", name: "GLM" }), null);
  assert.equal(saveBlocker({ ...base, accountType: "official", newGateway: false, name: "官方账号" }), null);
});
