import assert from "node:assert/strict";
import test from "node:test";
import { stepperStatusText } from "../src/stepper-status.ts";

test("步进器状态小字：待开始与检查中不写，其余写出状态", () => {
  assert.equal(stepperStatusText("pending"), null);
  assert.equal(stepperStatusText("checking"), null);
  assert.equal(stepperStatusText("pending", { archived: true })?.text, "已归档");
  assert.equal(stepperStatusText("review")?.text, "待评审");
  assert.equal(stepperStatusText("blocked")?.text, "有冲突");
  assert.equal(stepperStatusText("done")?.text, "已完成");
});

test("步进器状态小字：进行中按终端注意力细分要你出场的两种", () => {
  assert.equal(stepperStatusText("active")?.text, "进行中");
  assert.equal(stepperStatusText("active", { attention: "working" })?.text, "进行中");
  assert.equal(stepperStatusText("active", { attention: "confirm" })?.text, "等你确认");
  assert.equal(stepperStatusText("active", { attention: "done" })?.text, "等你查看");
  // 注意力只细分进行中：待评审时终端说完了也还是待评审
  assert.equal(stepperStatusText("review", { attention: "done" })?.text, "待评审");
});
