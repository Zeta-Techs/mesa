import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codexResumeKind,
  codexResumeKindLabel,
  codexSessionChannelChip,
  pickResumeProfile,
  skipDisconnectedOfficial,
} from "../src/resume-profile.ts";

const api = (id: string, baseUrl = "https://relay.example.com/v1") => ({
  id,
  agent: "codex",
  baseUrl,
  accountType: "api" as const,
});
const official = (id: string) => ({
  id,
  agent: "codex",
  baseUrl: null,
  accountType: "official" as const,
});

test("provider=ccode-<短id>：只在匹配网关的绑定里挑", () => {
  const gid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const profiles = [
    { id: "p-old", agent: "codex", baseUrl: "https://a.example", gatewayId: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    { id: "p-new", agent: "codex", baseUrl: "https://b.example", gatewayId: gid },
  ];
  const pick = pickResumeProfile(profiles, "codex", "ccode-a1b2c3d4", null);
  assert.equal(pick?.id, "p-new");
});

test("provider=ccode：跳过官方账号型，挑带 Base URL 的配置", () => {
  const profiles = [official("p-official"), api("p-api")];
  const pick = pickResumeProfile(profiles, "codex", "ccode", null);
  assert.equal(pick?.id, "p-api");
});

test("provider=ccode：期望 id 不带 Base URL 时落到首个兼容配置", () => {
  const profiles = [official("p-official"), api("p-api")];
  const pick = pickResumeProfile(profiles, "codex", "ccode", "p-official");
  assert.equal(pick?.id, "p-api");
});

test("provider=ccode：期望 id 兼容时优先用它", () => {
  const profiles = [api("p-a"), api("p-b", "https://other.example.com")];
  const pick = pickResumeProfile(profiles, "codex", "ccode", "p-b");
  assert.equal(pick?.id, "p-b");
});

test("provider=openai：ChatGPT 渠道挑官方账号", () => {
  const profiles = [official("p-official"), api("p-api")];
  assert.equal(
    pickResumeProfile(profiles, "codex", "openai", null)?.id,
    "p-official",
  );
  assert.equal(
    pickResumeProfile(profiles, "codex", undefined, "p-api")?.id,
    "p-api",
  );
});

test("provider=openai 且官方未登录：改挑网关，避免 401 Missing bearer", () => {
  const profiles = [official("p-official"), api("p-api")];
  assert.equal(
    pickResumeProfile(profiles, "codex", "openai", null, undefined, {
      officialConnected: false,
    })?.id,
    "p-api",
  );
});

test("provider=custom：客户端/磁盘渠道只挑网关，不掉进官方", () => {
  const profiles = [official("p-official"), api("p-api")];
  assert.equal(
    pickResumeProfile(profiles, "codex", "custom", null)?.id,
    "p-api",
  );
  assert.equal(
    pickResumeProfile(profiles, "codex", "custom", "p-official")?.id,
    "p-api",
  );
});

test("Codex 无记录：未确认官方已登录时跳过官方", () => {
  const profiles = [official("p-official"), api("p-api")];
  assert.equal(pickResumeProfile(profiles, "codex", null, null)?.id, "p-api");
  assert.equal(
    pickResumeProfile(profiles, "codex", null, "p-official", undefined, {
      officialConnected: true,
    })?.id,
    "p-official",
  );
});

test("codexResumeKind / 文案", () => {
  assert.equal(codexResumeKind("ccode-a1b2c3d4"), "gateway");
  assert.equal(codexResumeKind("openai"), "chatgpt");
  assert.equal(codexResumeKind("custom"), "disk");
  assert.equal(codexResumeKind(null), "unknown");
  assert.equal(codexResumeKindLabel("gateway"), "Mesa 网关");
  assert.equal(codexResumeKindLabel("chatgpt"), "ChatGPT 官方");
  assert.equal(codexResumeKindLabel("disk", "custom"), "Codex 客户端 · custom");
  assert.equal(codexResumeKindLabel("unknown"), "");
  assert.equal(codexSessionChannelChip(null), null);
  assert.equal(codexSessionChannelChip("ccode")?.label, "Mesa 网关");
  assert.equal(
    codexSessionChannelChip("custom")?.label,
    "Codex 客户端 · custom",
  );
});

test("skipDisconnectedOfficial：未登录跳过官方，没有网关才回落", () => {
  const profiles = [official("p-official"), api("p-api")];
  assert.deepEqual(
    skipDisconnectedOfficial(profiles, false).map((p) => p.id),
    ["p-api"],
  );
  assert.deepEqual(
    skipDisconnectedOfficial(profiles, true).map((p) => p.id),
    ["p-official", "p-api"],
  );
  assert.deepEqual(
    skipDisconnectedOfficial([official("p-official")], false).map((p) => p.id),
    ["p-official"],
  );
});

test("兼容池为空（配置被删过）：回落全池，不拦死", () => {
  const profiles = [official("p-official")];
  const pick = pickResumeProfile(profiles, "codex", "ccode", null);
  assert.equal(pick?.id, "p-official");
});

test("该 Agent 没有任何配置：null", () => {
  assert.equal(pickResumeProfile([api("p-a")], "kimi", null, null), null);
  assert.equal(pickResumeProfile([], "codex", "ccode", null), null);
});

test("软停用：自动挑选跳过停用项，wishedId 指向停用项同样跳过", () => {
  const profiles = [api("p-a"), api("p-b", "https://other.example.com")];
  // 首个被停用 → 落到下一个
  assert.equal(
    pickResumeProfile(profiles, "codex", "ccode", null, ["p-a"])?.id,
    "p-b",
  );
  // wishedId 是「上次使用」的记忆而非当下显式选择，指向停用项也跳过
  assert.equal(
    pickResumeProfile(profiles, "codex", "ccode", "p-a", ["p-a"])?.id,
    "p-b",
  );
  // 停用项与兼容过滤叠加：唯一兼容项被停用 → 回落全池（含停用项）
  assert.equal(
    pickResumeProfile([official("p-official"), api("p-api")], "codex", "ccode", null, [
      "p-api",
    ])?.id,
    "p-api",
  );
});

test("软停用：全被停用时回落含停用项的池，不拦死", () => {
  const profiles = [api("p-a"), api("p-b", "https://other.example.com")];
  assert.equal(
    pickResumeProfile(profiles, "codex", "ccode", null, ["p-a", "p-b"])?.id,
    "p-a",
  );
  // 回落池里 wishedId 仍被尊重
  assert.equal(
    pickResumeProfile(profiles, "codex", "ccode", "p-b", ["p-a", "p-b"])?.id,
    "p-b",
  );
});
