import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFetchedCatalog,
  catalogCapabilityNote,
  catalogFetchNotice,
  catalogFetchSlot,
  catalogSlotWalkOrder,
  effectiveSlotUrl,
  fetchedIdsToModels,
  fetchModelsInvokeArgs,
  firstProbeableSlot,
  parseHeaderEnv,
  primaryProbeSlot,
  probeDtoToSummary,
  responsesSlotUrlWarning,
  zhipuOpenAiSlotBillingHint,
  slotsFollowMaster,
} from "../src/gateway-draft.ts";
import { agentForSlot } from "../src/gateway-slot.ts";

const same = {
  anthropic: "https://ent.example.com/v1",
  openai: "https://ent.example.com/v1",
  responses: "https://ent.example.com/v1",
  gemini: "https://ent.example.com/v1",
  cursor: "https://ent.example.com/v1",
};

test("slotsFollowMaster：同址或全空为跟随，混址为否", () => {
  assert.equal(slotsFollowMaster(same, "https://ent.example.com/v1"), true);
  assert.equal(slotsFollowMaster({}, ""), true);
  assert.equal(
    slotsFollowMaster({ responses: "https://ent.example.com/v1" }, "https://ent.example.com/v1"),
    true,
  );
  assert.equal(
    slotsFollowMaster(
      { ...same, responses: "https://other.example.com/v1" },
      "https://ent.example.com/v1",
    ),
    false,
  );
});

test("effectiveSlotUrl：槽空则用主输入", () => {
  assert.equal(
    effectiveSlotUrl({ responses: "" }, "responses", "https://ent.example.com/v1"),
    "https://ent.example.com/v1",
  );
  assert.equal(
    effectiveSlotUrl({ responses: "https://other/v1" }, "responses", "https://ent.example.com/v1"),
    "https://other/v1",
  );
});

test("firstProbeableSlot 跳过 Cursor/Gemini，空槽回落主输入", () => {
  assert.equal(firstProbeableSlot(same, ""), "anthropic");
  assert.equal(
    firstProbeableSlot({ gemini: "https://g", cursor: "https://c" }, ""),
    null,
  );
  assert.equal(
    firstProbeableSlot({ gemini: "https://g" }, "https://ent.example.com/v1"),
    "anthropic",
  );
});

test("catalogSlotWalkOrder 把记住的槽放到最前", () => {
  assert.deepEqual(catalogSlotWalkOrder("responses")[0], "responses");
  assert.equal(catalogSlotWalkOrder()[0], "anthropic");
});

test("primaryProbeSlot 同址时用上次成功的槽，不误打 Anthropic", () => {
  const all = {
    anthropic: "https://ent.example.com/v1",
    openai: "https://ent.example.com/v1",
    responses: "https://ent.example.com/v1",
    gemini: "https://ent.example.com/v1",
    cursor: "https://ent.example.com/v1",
  };
  assert.equal(primaryProbeSlot(all, "https://ent.example.com/v1", "responses"), "responses");
  assert.equal(primaryProbeSlot(all, "https://ent.example.com/v1"), "anthropic");
});

test("catalogFetchSlot 用有效地址（含主输入）挑槽", () => {
  assert.equal(
    catalogFetchSlot({ responses: "https://r/v1" }, "", "responses"),
    "responses",
  );
  assert.equal(catalogFetchSlot({}, "https://ent.example.com/v1"), "anthropic");
  assert.equal(agentForSlot("responses"), "codex");
});

test("parseHeaderEnv 忽略空行和没有等号的行", () => {
  assert.deepEqual(parseHeaderEnv("X-A=FOO\n\nbad\nX-B=BAR"), {
    "X-A": "FOO",
    "X-B": "BAR",
  });
});

test("获取目录参数：无密钥走已存，草稿密钥只用于本次请求", () => {
  assert.deepEqual(
    fetchModelsInvokeArgs({
      baseUrl: "https://ent.example.com/v1",
      apiKey: " sk-new ",
      noAuth: false,
      slot: "responses",
      gatewayId: "gw-1",
    }),
    {
      baseUrl: "https://ent.example.com/v1",
      apiKey: "sk-new",
      agentId: "codex",
      gatewayId: "gw-1",
      force: true,
    },
  );
  assert.equal(
    fetchModelsInvokeArgs({
      baseUrl: "https://x",
      apiKey: "sk",
      noAuth: true,
      slot: "openai",
    }).apiKey,
    null,
  );
});

test("probeDtoToSummary 取基础请求延迟", () => {
  const sum = probeDtoToSummary("responses", {
    ok: true,
    model: "m",
    checks: [
      { status: "passed", message: "基础请求", latencyMs: 4051 },
      { status: "skipped", message: "流式响应：基础请求未通过，跳过", latencyMs: null },
    ],
  });
  assert.equal(sum.slot, "responses");
  assert.equal(sum.lastOk, true);
  assert.equal(sum.lastLatencyMs, 4051);
});

test("applyFetchedCatalog 把目录 id 收成模型行", () => {
  const merged = applyFetchedCatalog(
    [],
    { models: ["a", "b"], fromCache: false, fetchedAt: "t1", capabilityMetadataCount: 0 },
    "responses",
    (local, incoming) => [...local, ...incoming],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.catalogSlot, "responses");
  assert.deepEqual(
    fetchedIdsToModels(["x"], "t", "openai")[0]?.id,
    "x",
  );
});

test("catalogCapabilityNote：纯 id 目录说明去公共库", () => {
  assert.equal(catalogCapabilityNote(0, 0), null);
  assert.match(catalogCapabilityNote(423, 0) ?? "", /只返回模型 ID/);
  assert.match(catalogCapabilityNote(10, 3) ?? "", /3 个带网关能力字段/);
  assert.match(catalogFetchNotice(423, 0, "anthropic"), /anthropic/);
  assert.match(catalogFetchNotice(423, 0), /下载模型能力库/);
});

test("responsesSlotUrlWarning：智谱 paas/v4 无 /responses 才报警", () => {
  const warn = responsesSlotUrlWarning("https://open.bigmodel.cn/api/paas/v4");
  assert.match(warn ?? "", /api\/v1/);
  // 尾斜杠、槽自填同址都命中
  assert.match(
    responsesSlotUrlWarning("https://open.bigmodel.cn/api/paas/v4/") ?? "",
    /404/,
  );
  // 专用端点、其他网关同路径、空值与非法 URL 都不报警
  assert.equal(responsesSlotUrlWarning("https://open.bigmodel.cn/api/v1"), null);
  assert.equal(responsesSlotUrlWarning("https://relay.example.com/api/paas/v4"), null);
  assert.equal(responsesSlotUrlWarning(""), null);
  assert.equal(responsesSlotUrlWarning("not-a-url"), null);
});

test("zhipuOpenAiSlotBillingHint：只对智谱按量 paas/v4 提示，coding 端点与他家不提示", () => {
  const cn = zhipuOpenAiSlotBillingHint("https://open.bigmodel.cn/api/paas/v4/");
  assert.ok(cn?.includes("https://open.bigmodel.cn/api/coding/paas/v4"));
  const intl = zhipuOpenAiSlotBillingHint("https://api.z.ai/api/paas/v4");
  assert.ok(intl?.includes("https://api.z.ai/api/coding/paas/v4"));
  assert.equal(zhipuOpenAiSlotBillingHint("https://open.bigmodel.cn/api/coding/paas/v4"), null);
  assert.equal(zhipuOpenAiSlotBillingHint("https://open.bigmodel.cn/api/anthropic"), null);
  assert.equal(zhipuOpenAiSlotBillingHint("https://relay.example.com/api/paas/v4"), null);
  assert.equal(zhipuOpenAiSlotBillingHint(""), null);
  assert.equal(zhipuOpenAiSlotBillingHint("not-a-url"), null);
});
