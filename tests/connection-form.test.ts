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

test("网关库行状态：缺密钥优先，其次失败、通过、未测", async () => {
  const { gatewayHealth } = await import("../src/connection-form.ts");
  assert.equal(gatewayHealth({ noAuth: false, keyHint: null }).label, "缺密钥");
  assert.equal(gatewayHealth({ noAuth: true, slotProbes: [{ lastOk: true }, { lastOk: false }] }).label, "测试失败");
  assert.equal(gatewayHealth({ noAuth: false, keyHint: "…ab", slotProbes: [{ lastOk: true }] }).label, "测试通过");
  assert.equal(gatewayHealth({ noAuth: false, keyHint: "…ab", slotProbes: [{ lastOk: null }] }).label, "未测");
});

test("手填模型：空、带空格、重复都拦", async () => {
  const { manualModelError, modelHasPolicy } = await import("../src/connection-form.ts");
  assert.equal(manualModelError(" glm-5.3 ", ["glm-5.2"]), null);
  assert.equal(manualModelError("", []), "填模型名");
  assert.equal(manualModelError("a b", []), "模型名里不能有空格");
  assert.equal(manualModelError("glm-5.2", ["glm-5.2"]), "目录里已经有这个模型");
  assert.equal(modelHasPolicy({ temperature: null, topP: null, maxOutputTokens: null, reasoningEffort: "high" }), true);
  assert.equal(modelHasPolicy({ temperature: null, topP: null, maxOutputTokens: null, reasoningEffort: null }), false);
});
