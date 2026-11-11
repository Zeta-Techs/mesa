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

test("步进器状态小字：最近一次运行出错、此刻没人在干活时写「出错了」，原因放悬停", () => {
  const failed = stepperStatusText("active", { failure: "PTY 启动失败" });
  assert.equal(failed?.text, "出错了");
  assert.equal(failed?.tone, "text-err-text");
  assert.match(failed?.title ?? "", /PTY 启动失败/);
  assert.equal(stepperStatusText("active", { failure: "x", attention: "working" })?.text, "进行中");
  assert.equal(stepperStatusText("active", { failure: "x", attention: "confirm" })?.text, "等你确认");
  // 待评审 / 已完成有更要紧的下一步，不盖掉
  assert.equal(stepperStatusText("review", { failure: "x" })?.text, "待评审");
  assert.equal(stepperStatusText("done", { failure: "x" })?.text, "已完成");
});

test("步进器「出错了」：AI 在对话里自己说的，悬停写明是它说的", () => {
  const said = stepperStatusText("active", { failure: "有 3 个测试失败了", failureFromAi: true, attention: "done" });
  assert.equal(said?.text, "出错了");
  assert.equal(said?.title, "这一步的 AI 在对话里说：有 3 个测试失败了");
  assert.equal(stepperStatusText("active", { failure: "x", failureFromAi: true, attention: "working" })?.text, "进行中");
});

test("已完成之后上游又保存过：写「待跟进」并在悬停里点名上游；没有就仍是已完成", () => {
  const t = stepperStatusText("done", { staleUpstream: "文献检索与筛选" });
  assert.equal(t?.text, "待跟进");
  assert.match(t?.title ?? "", /「文献检索与筛选」/);
  assert.equal(stepperStatusText("done", { staleUpstream: null })?.text, "已完成");
  // 进行中的步骤上游变了不改状态字（点「继续」时本来就会并进来）；待评审的 2026-11-11 起也写待跟进，见下一条
  assert.equal(stepperStatusText("active", { staleUpstream: "x" })?.text, "进行中");
});

test("等补料：待评审 / 进行中且没在干活时写等补料；AI 在干活或等确认照旧", async () => {
  const { stepperStatusText } = await import("../src/stepper-status.ts");
  assert.equal(stepperStatusText("review", { awaitingRework: true })?.text, "等补料");
  assert.equal(stepperStatusText("active", { awaitingRework: true })?.text, "等补料");
  assert.equal(stepperStatusText("active", { awaitingRework: true, attention: "working" })?.text, "进行中");
  assert.equal(stepperStatusText("active", { awaitingRework: true, attention: "confirm" })?.text, "等你确认");
  assert.equal(stepperStatusText("done", { awaitingRework: true })?.text, "已完成");
});

test("待评审但上游有这一版没用上的新内容：写待跟进；等补料优先", async () => {
  const { stepperStatusText } = await import("../src/stepper-status.ts");
  assert.equal(stepperStatusText("review", { staleUpstream: "文献精读与笔记" })?.text, "待跟进");
  assert.equal(stepperStatusText("review", {})?.text, "待评审");
  assert.equal(stepperStatusText("review", { staleUpstream: "精读", awaitingRework: true })?.text, "等补料");
});
