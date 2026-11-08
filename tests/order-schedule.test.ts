import assert from "node:assert/strict";
import test from "node:test";
import { cadenceLabel, parseOrderCadence } from "../src/order-schedule.ts";

test("parseOrderCadence：常见说法认成定时任务的周期", () => {
  assert.deepEqual(parseOrderCadence("每周五 17:00"), {
    frequency: "weekly",
    weekday: 5,
    intervalHours: null,
    hour: 17,
    minute: 0,
    guessed: false,
  });
  assert.equal(cadenceLabel(parseOrderCadence("每周日晚上 8 点半")), "每周日 20:30");
  assert.equal(cadenceLabel(parseOrderCadence("每天早上九点")), "每天 09:00");
  assert.equal(cadenceLabel(parseOrderCadence("工作日 18:30")), "工作日 18:30");
  assert.equal(cadenceLabel(parseOrderCadence("每 4 小时")), "每 4 小时");
  assert.equal(cadenceLabel(parseOrderCadence("每小时")), "每小时");
  assert.equal(cadenceLabel(parseOrderCadence("每星期三 下午3点")), "每周三 15:00");
});

test("parseOrderCadence：认不出、或小时间隔不在可选值里，回落每周一 9:00 并标 guessed", () => {
  const g = parseOrderCadence("每月第一个周一");
  assert.equal(g.guessed, true);
  assert.equal(cadenceLabel(g), "每周一 09:00");
  assert.equal(parseOrderCadence("每 5 小时").guessed, true);
  assert.equal(parseOrderCadence("").guessed, true);
});
