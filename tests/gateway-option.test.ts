import assert from "node:assert/strict";
import test from "node:test";
import {
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
