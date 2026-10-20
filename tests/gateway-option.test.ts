import assert from "node:assert/strict";
import test from "node:test";
import {
  addConnectionDefaults,
  endpointHost,
  gatewayFilledSlots,
  gatewayHosts,
  gatewayPickerRows,
} from "../src/gateway-option.ts";
import type { Gateway } from "../src/types.ts";

const gw = (partial: Partial<Gateway> & Pick<Gateway, "id" | "name">): Gateway => ({
  noAuth: false,
  keyHint: null,
  slots: {},
  headerEnv: {},
  models: [],
  catalogFetchedAt: null,
  catalogFromSlot: null,
  lastProbe: [],
  ...partial,
});

test("endpointHost 取主机名", () => {
  assert.equal(endpointHost("https://ent.zetatechs.com/v1"), "ent.zetatechs.com");
  assert.equal(endpointHost("https://api.example.com:8080/path"), "api.example.com:8080");
  assert.equal(endpointHost(""), "");
});

test("gatewayHosts 去重，gatewayFilledSlots 只列已填槽", () => {
  const slots = {
    anthropic: "https://ent.zetatechs.com/v1",
    openai: "https://ent.zetatechs.com/v1",
    responses: "https://ent.zetatechs.com/v1",
    gemini: "",
    cursor: "https://other.example.com",
  };
  assert.deepEqual(gatewayHosts(slots), ["ent.zetatechs.com", "other.example.com"]);
  assert.deepEqual(gatewayFilledSlots(slots), [
    "Anthropic",
    "OpenAI",
    "Responses",
    "Cursor",
  ]);
});

test("gatewayPickerRows 用主机和槽区分，不用密钥尾号当主识别", () => {
  const rows = gatewayPickerRows([
    gw({
      id: "a",
      name: "Zeta-22",
      keyHint: "···OHLQ",
      slots: { responses: "https://ent.zetatechs.com/v1" },
      models: [
        {
          id: "m1",
          source: "fetched",
          status: "available",
          temperature: null,
          topP: null,
          maxOutputTokens: null,
          reasoningEffort: null,
        },
      ],
    }),
    gw({
      id: "b",
      name: "Zeta",
      keyHint: "···5G5n",
      slots: { anthropic: "https://api.deepseek.com" },
    }),
    gw({ id: "c", name: "空", keyHint: "···AAAA", slots: {} }),
  ]);
  assert.equal(rows[0]?.name, "Zeta-22");
  assert.equal(rows[0]?.detail, "ent.zetatechs.com · Responses · 1 个模型");
  assert.equal(rows[1]?.detail, "api.deepseek.com · Anthropic");
  assert.equal(rows[2]?.detail, "未填端点");
  assert.ok(!rows.some((row) => row.detail.includes("OHLQ")));
});

test("gatewayPickerRows 同名同址才补密钥尾号", () => {
  const rows = gatewayPickerRows([
    gw({
      id: "a",
      name: "Zeta",
      keyHint: "···AAA",
      slots: { openai: "https://same.example.com/v1" },
    }),
    gw({
      id: "b",
      name: "Zeta",
      keyHint: "···BBB",
      slots: { openai: "https://same.example.com/v1" },
    }),
  ]);
  assert.ok(rows[0]?.detail.includes("···AAA"));
  assert.ok(rows[1]?.detail.includes("···BBB"));
});

test("gatewayPickerRows 协议槽超过 3 种时收成「前两种 等 N 种协议」", () => {
  const rows = gatewayPickerRows([
    gw({
      id: "a",
      name: "GLM",
      slots: {
        anthropic: "https://open.bigmodel.cn/api/anthropic",
        openai: "https://open.bigmodel.cn/api/paas/v4",
        responses: "https://open.bigmodel.cn/api/paas/v4",
        gemini: "https://open.bigmodel.cn/api/gemini",
      },
    }),
  ]);
  assert.equal(rows[0]?.detail, "open.bigmodel.cn · Anthropic、OpenAI 等 4 种协议");
});

test("addConnectionDefaults：没有连接在用的网关默认选中（取最后建的），已绑的不选", () => {
  const gateways = [
    gw({ id: "a", name: "旧网关", slots: { anthropic: "https://a.example.com" } }),
    gw({ id: "b", name: "新网关", slots: { anthropic: "https://b.example.com" } }),
  ];
  assert.deepEqual(
    addConnectionDefaults({ gateways, boundGatewayIds: [], installed: ["claude-code"] }),
    { gatewayId: "b", agent: "claude-code" },
  );
  assert.equal(
    addConnectionDefaults({ gateways, boundGatewayIds: ["b", null], installed: [] }).gatewayId,
    "a",
  );
  assert.equal(
    addConnectionDefaults({ gateways, boundGatewayIds: ["a", "b"], installed: [] }).gatewayId,
    null,
  );
});

test("addConnectionDefaults：Agent 先挑装好、且网关填了它协议槽的；有 Claude Code 先选它", () => {
  const openaiOnly = [gw({ id: "g", name: "g", slots: { openai: "https://x.example.com/v1" } })];
  // 只填 OpenAI 槽：Claude Code 接不上，挑装好的 OpenCode
  assert.equal(
    addConnectionDefaults({
      gateways: openaiOnly,
      boundGatewayIds: [],
      installed: ["claude-code", "opencode"],
    }).agent,
    "opencode",
  );
  // qwen / kimi 两种协议都认
  const anthropicOnly = [gw({ id: "g", name: "g", slots: { anthropic: "https://x.example.com" } })];
  assert.equal(
    addConnectionDefaults({ gateways: anthropicOnly, boundGatewayIds: [], installed: ["qwen"] }).agent,
    "qwen",
  );
  // 都接不上：退回装好的第一家，不瞎猜没装的
  assert.equal(
    addConnectionDefaults({ gateways: openaiOnly, boundGatewayIds: [], installed: ["codex"] }).agent,
    "codex",
  );
  // 没网关可选：装好的里有 Claude Code 先选它，什么都没装回落 Claude Code
  assert.deepEqual(
    addConnectionDefaults({ gateways: [], boundGatewayIds: [], installed: ["codex", "claude-code"] }),
    { gatewayId: null, agent: "claude-code" },
  );
  assert.equal(
    addConnectionDefaults({ gateways: [], boundGatewayIds: [], installed: [] }).agent,
    "claude-code",
  );
  // 从某家 Agent 组发起：预选那家优先
  assert.equal(
    addConnectionDefaults({
      gateways: openaiOnly,
      boundGatewayIds: [],
      installed: ["opencode"],
      presetAgent: "gemini",
    }).agent,
    "gemini",
  );
});
