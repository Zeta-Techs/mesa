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
