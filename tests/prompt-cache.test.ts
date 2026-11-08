import assert from "node:assert/strict";
import test from "node:test";
import { cacheTtlMs, coldCacheAt, coldCacheHint, idleLabel, lastMessageAt } from "../src/prompt-cache.ts";

const T0 = Date.parse("2026-11-08T10:00:00Z");

test("缓存时长：API 密钥约 5 分钟，官方订阅与没有连接约 1 小时", () => {
  assert.equal(cacheTtlMs("api"), 5 * 60_000);
  assert.equal(cacheTtlMs("official"), 60 * 60_000);
  assert.equal(cacheTtlMs(null), 60 * 60_000);
});

test("最后一条带时间戳的消息：跳过没时间戳的和读不懂的", () => {
  assert.equal(lastMessageAt([]), null);
  assert.equal(
    lastMessageAt([{ timestamp: "2026-11-08T10:00:00Z" }, { timestamp: null }, { timestamp: "乱写" }]),
    T0,
  );
});

test("该提醒：Claude、够长、过了缓存时长", () => {
  const base = { agentId: "claude", accountType: "api" as const, lastAt: T0, tokens: 120_000 };
  assert.equal(coldCacheHint({ ...base, now: T0 + 4 * 60_000 }), null, "5 分钟内缓存还在");
  const hint = coldCacheHint({ ...base, now: T0 + 7 * 60_000 });
  assert.deepEqual(hint, { tokens: 120_000, idleMinutes: 7, key: `${T0}|120000` });
  assert.equal(coldCacheAt(base), T0 + 5 * 60_000);
});

test("不提醒：订阅一小时内、对话太短、别家、缺数据", () => {
  const now = T0 + 30 * 60_000;
  assert.equal(coldCacheHint({ agentId: "claude", accountType: "official", lastAt: T0, tokens: 120_000, now }), null);
  assert.equal(coldCacheHint({ agentId: "claude", accountType: "api", lastAt: T0, tokens: 20_000, now }), null);
  assert.equal(coldCacheHint({ agentId: "codex", accountType: "api", lastAt: T0, tokens: 120_000, now }), null);
  assert.equal(coldCacheHint({ agentId: "claude", accountType: "api", lastAt: null, tokens: 120_000, now }), null);
  assert.equal(coldCacheAt({ agentId: "codex", accountType: "api", lastAt: T0, tokens: 120_000 }), null);
});

test("离开多久写成人话", () => {
  assert.equal(idleLabel(7), "7 分钟");
  assert.equal(idleLabel(130), "2 小时");
  assert.equal(idleLabel(60 * 50), "2 天");
});
