import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyPricingRow,
  parsePricingFile,
  priceLabel,
  pricingRowProblem,
  serializePricingRows,
} from "../src/pricing-rows.ts";

test("老格式 [输入, 输出] 原样往返，_rate 不丢", () => {
  const raw = JSON.stringify({ _rate: 7.1, "kimi-k3": [3, 15] }, null, 2);
  const { rows, rate } = parsePricingFile(raw);
  assert.equal(rate, 7.1);
  assert.deepEqual(rows, [{ ...emptyPricingRow("kimi-k3"), input: "3", output: "15" }]);
  assert.equal(serializePricingRows(rows, rate), raw);
});

test("填了缓存价或人民币的写对象，没填的缓存价不出现", () => {
  const rows = [
    { ...emptyPricingRow("glm-5.3"), currency: "CNY" as const, input: "4", output: "16" },
    { ...emptyPricingRow("relay-a"), input: "2", output: "8", cacheRead: "0.5", cacheWrite: "" },
    { ...emptyPricingRow("  "), input: "1", output: "1" },
  ];
  const obj = JSON.parse(serializePricingRows(rows, null));
  assert.deepEqual(obj, {
    "glm-5.3": { input: 4, output: 16, currency: "CNY" },
    "relay-a": { input: 2, output: 8, cacheRead: 0.5 },
  });
  assert.deepEqual(parsePricingFile(JSON.stringify(obj)).rows[0], { ...rows[0] });
});

test("全空写空串（后端据此删掉自定义价）", () => {
  assert.equal(serializePricingRows([emptyPricingRow()], null), "");
});

test("行内校验：必填两价、缓存价可空，空前缀不报", () => {
  assert.equal(pricingRowProblem(emptyPricingRow()), null);
  assert.ok(pricingRowProblem({ ...emptyPricingRow("m"), input: "1" }));
  assert.ok(pricingRowProblem({ ...emptyPricingRow("m"), input: "1", output: "-2" }));
  assert.ok(pricingRowProblem({ ...emptyPricingRow("m"), input: "1", output: "2", cacheRead: "x" }));
  assert.equal(pricingRowProblem({ ...emptyPricingRow("m"), input: "1", output: "2" }), null);
});

test("价格显示去掉多余的 0", () => {
  assert.equal(priceLabel(3), "3");
  assert.equal(priceLabel(0.125), "0.125");
  assert.equal(priceLabel(1 / 3), "0.3333");
});
