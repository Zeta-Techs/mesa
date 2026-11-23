import assert from "node:assert/strict";
import test from "node:test";
import { isAppCrashClose, latestRunFailure, runFailureReason } from "../src/run-failure.ts";

const base = {
  isolationPath: "/w/step1",
  internal: false,
  closedAt: "2026-11-04T10:05:00Z",
  exitCode: null as number | null,
  closeReason: null as string | null,
};

test("出错原因：退出码白话 + 关闭原因，不重复通用原因", () => {
  assert.equal(runFailureReason({ exitCode: 127, closeReason: "进程以非零退出码结束" }), "未找到命令（退出码 127）");
  assert.equal(runFailureReason({ exitCode: 1, closeReason: "进程以非零退出码结束" }), "异常退出（退出码 1）");
  assert.equal(runFailureReason({ exitCode: null, closeReason: "PTY 启动失败" }), "PTY 启动失败");
  assert.equal(runFailureReason({ exitCode: null, closeReason: null }), "出错退出，没有留下原因");
  assert.equal(runFailureReason({ exitCode: 1, closeReason: "评审基线写入失败" }), "异常退出（退出码 1） · 评审基线写入失败");
});

test("只看这一步最近一次运行；应用异常退出不算这一步出错", () => {
  const runs = [
    { ...base, id: "a", createdAt: "2026-11-04T09:00:00Z", status: "failed", closeReason: "PTY 启动失败" },
    { ...base, id: "b", createdAt: "2026-11-04T10:00:00Z", status: "completed", exitCode: 0 },
  ];
  assert.equal(latestRunFailure(runs, "/w/step1"), null, "后来又跑成功了");
  const failed = latestRunFailure([...runs, { ...base, id: "c", createdAt: "2026-11-04T11:00:00Z", status: "failed", closeReason: "PTY 启动失败" }], "/w/step1");
  assert.equal(failed?.run.id, "c");
  assert.equal(failed?.reason, "PTY 启动失败");
  const crash = { ...base, id: "d", createdAt: "2026-11-04T12:00:00Z", status: "failed", closeReason: "应用上次异常退出，Run 未能正常收尾" };
  assert.ok(isAppCrashClose(crash));
  assert.equal(latestRunFailure([crash], "/w/step1"), null);
  assert.equal(latestRunFailure([{ ...crash, isolationPath: "/w/other", closeReason: "x" }], "/w/step1"), null);
  assert.equal(latestRunFailure([{ ...crash, internal: true, closeReason: "x" }], "/w/step1"), null);
});

test("AI 自己说出了错：失败 / 报错 / Traceback 算，「没有报错」「全部通过」不算", async () => {
  const { aiReportsFailure } = await import("../src/run-failure.ts");
  assert.equal(aiReportsFailure("跑了 pytest，有 3 个测试失败了，见下面。"), true);
  assert.equal(aiReportsFailure("渲染报错：Traceback (most recent call last) ..."), true);
  assert.equal(aiReportsFailure("quarto render failed with exit code 1"), true);
  assert.equal(aiReportsFailure("脚本跑完了，没有报错，输出在 output/。"), false);
  assert.equal(aiReportsFailure("测试全部通过，0 failed。"), false);
  assert.equal(aiReportsFailure("综述大纲写好了，等你评审。"), false);
  // 复盘建议或统计里引号内的词条名与零计数不误报（2026-11-22 lit-search 补料实证）
  assert.equal(aiReportsFailure("分别输出「无合规直链」「下载失败」「停止后未尝试」，校验通过。"), false);
  assert.equal(aiReportsFailure("校验通过：0 处错误，下载失败 0。"), false);
});

test("latestStepSessionRun：最新 Run 尚无 sessionId 时绝不跨代倒退读几天前的旧会话", async () => {
  const { latestStepSessionRun } = await import("../src/run-failure.ts");
  const runs = [
    { id: "old", internal: false, isolationPath: "/w/lit-search", createdAt: "2026-11-20T16:00:00Z", sessionId: "old-sess" },
    { id: "new", internal: false, isolationPath: "/w/lit-search", createdAt: "2026-11-22T09:59:00Z", sessionId: null },
  ];
  assert.equal(latestStepSessionRun(runs, "/w/lit-search", false), null);
  const bound = [runs[0], { ...runs[1], sessionId: "new-sess" }];
  assert.equal(latestStepSessionRun(bound, "/w/lit-search", false)?.id, "new");
});
