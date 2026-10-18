import assert from "node:assert/strict";
import test from "node:test";
import { noticeDurationMs, splitNoticeText } from "../src/notice-text.ts";

test("splitNoticeText：首句当标题，其余按句拆说明行（网关库实例）", () => {
  const { headline, details } = splitNoticeText(
    "已获取 424 个模型（openai）。网关只返回模型 ID，没有上下文/视觉/推理。能力声明用连接页 ⋯「下载模型能力库」。绑定里已勾选的名单不会自动改，编辑连接时再勾选新模型。",
  );
  assert.equal(headline, "已获取 424 个模型（openai）");
  assert.deepEqual(details, [
    "网关只返回模型 ID，没有上下文/视觉/推理。",
    "能力声明用连接页 ⋯「下载模型能力库」。",
    "绑定里已勾选的名单不会自动改，编辑连接时再勾选新模型。",
  ]);
});

test("splitNoticeText：单句、首句过长、自带换行、半角句点", () => {
  assert.deepEqual(splitNoticeText("已保存"), { headline: "已保存", details: [] });
  const long = "这一句非常长".repeat(10) + "。第二句。";
  assert.deepEqual(splitNoticeText(long), { headline: long, details: [] });
  assert.deepEqual(splitNoticeText("已导出\n路径：/tmp/a.md"), {
    headline: "已导出",
    details: ["路径：/tmp/a.md"],
  });
  assert.deepEqual(splitNoticeText("已更新到 v1.2.3 版本"), {
    headline: "已更新到 v1.2.3 版本",
    details: [],
  });
});

test("noticeDurationMs：长句延长、有上限", () => {
  assert.equal(noticeDurationMs("已保存", "success"), 3200);
  assert.equal(noticeDurationMs("失败", "error"), 6000);
  assert.ok(noticeDurationMs("字".repeat(80), "info") > 6000);
  assert.equal(noticeDurationMs("字".repeat(500), "info"), 12000);
});
