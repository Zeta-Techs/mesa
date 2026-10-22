import assert from "node:assert/strict";
import test from "node:test";
import { fmtTokensZh } from "../src/token-format.ts";

test("token 数按中文读法：千分位 / 万 / 亿", () => {
  assert.equal(fmtTokensZh(0), "0");
  assert.equal(fmtTokensZh(3400), "3,400");
  assert.equal(fmtTokensZh(78_000), "7.8 万");
  assert.equal(fmtTokensZh(120_000), "12 万");
  assert.equal(fmtTokensZh(250_000_000), "2.5 亿");
});

test("对话用量合计算上读写缓存；悬停拆分", async () => {
  const { usageTotal, usageTitle } = await import("../src/token-format.ts");
  // 本机一段 Claude 对话的真实量级：新输入 4 万、输出 54 万、读缓存 1.87 亿
  const u = { input: 40_418, output: 543_412, cacheRead: 187_323_919, cacheWrite: 7_672_329, costUsd: 120.5, priced: true };
  assert.equal(usageTotal(u), 195_580_078);
  assert.equal(fmtTokensZh(usageTotal(u)), "2 亿");
  const title = usageTitle(u, fmtTokensZh);
  assert.match(title, /读缓存 1\.9 亿 · 新输入 4 万 · 写缓存 767\.2 万 · 输出 54\.3 万/);
  assert.match(title, /按定价表估算 \$120\.500/);
  // 没有缓存的家不写缓存项、不写那句解释
  const plain = usageTitle({ input: 3400, output: 200, costUsd: 0, priced: false }, fmtTokensZh);
  assert.doesNotMatch(plain, /缓存/);
});
