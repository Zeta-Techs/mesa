import assert from "node:assert/strict";
import test from "node:test";
import { echoInboxItems, echoText, stepDispatchStatus, type OpenDispatch } from "../src/assistant-echo.ts";

const goal = { target: "goal", step: null, title: "组会汇报", mode: "goal" } as const;
const step = { target: "step", step: 2, title: "修列名", mode: "mail" } as const;

test("回音文字：做完 / 失败 / 停了各一句，带去处按钮；已验收不说", () => {
  assert.match(echoText(goal, "review"), /派出去的「组会汇报」做完了，在项目页的待验收里等你验收。\[\[项目页\]\]/);
  assert.match(echoText(step, "review"), /派给第 2 步的「修列名」做完了，等你评审、保存进项目。\[\[去评审:2\]\]/);
  assert.match(echoText(goal, "failed"), /没做成.*为什么失败了/);
  assert.match(echoText(goal, "stopped"), /停下了/);
  assert.equal(echoText(goal, "accepted"), "");
});

test("收件箱：只收补过回音、没看过的；打开过那个项目的项目助手就算看过", () => {
  const rec = (title: string, echoed: string | null, echoedAt: string | null) => ({
    at: "2026-11-05T09:00:00+08:00",
    target: "goal",
    step: null,
    title,
    mode: "goal",
    note: "",
    echoed,
    echoedAt,
  });
  const open: OpenDispatch[] = [
    { projectRoot: "/p/a", turnAt: "t1", record: rec("组会汇报", "review", "2026-11-05T10:00:00+08:00") },
    { projectRoot: "/p/a", turnAt: "t2", record: rec("周报", "failed", "2026-11-05T08:00:00+08:00") },
    { projectRoot: "/p/b", turnAt: "t3", record: rec("规划", null, null) },
    { projectRoot: "/p/b", turnAt: "t4", record: rec("老的", "accepted", "2026-11-05T10:00:00+08:00") },
  ];
  const items = echoInboxItems(open, { "/p/a": "2026-11-05T09:30:00+08:00" }, (r) => (r === "/p/a" ? "课题 A" : "课题 B"));
  assert.deepEqual(items.map((i) => i.key), ["asst:/p/a:t1:review"], "看过之前的失败回音不再列，没补回音的、已验收的不列");
  assert.equal(items[0].text, "课题 A · 项目助手派的「组会汇报」做完了");
  assert.deepEqual(items[0].action, { type: "assistant", projectRoot: "/p/a" });
  assert.equal(echoInboxItems(open, {}, () => "x").length, 2);
});

test("步骤派活进度判定：派出前已有的领先提交不提前报做完，新增提交或保存后再提交才报评审", () => {
  const at = "2026-11-14T10:00:00+08:00";
  // 派出前工作副本已有 2 个没保存的提交：不提前报 review
  assert.equal(stepDispatchStatus({ dispatchedAt: at, baseAhead: 2, ahead: 2, mergedAt: null, liveOpen: true }).phase, undefined);
  assert.equal(stepDispatchStatus({ dispatchedAt: at, baseAhead: 2, ahead: 2, mergedAt: null, liveOpen: true }).text, "这一轮说完了，等你看");
  // AI 又交了新提交（ahead = 3 > baseAhead = 2）：报 review
  assert.equal(stepDispatchStatus({ dispatchedAt: at, baseAhead: 2, ahead: 3, mergedAt: null, liveOpen: false }).phase, "review");
  // 派出后保存进项目（ahead 归 0）：报 accepted
  assert.equal(
    stepDispatchStatus({ dispatchedAt: at, baseAhead: 2, ahead: 0, mergedAt: "2026-11-14T10:30:00+08:00", liveOpen: false }).phase,
    "accepted",
  );
  // 派出后保存过一次，接着又交了 1 个新提交（ahead = 1）：基线归零，仍报 review
  assert.equal(
    stepDispatchStatus({ dispatchedAt: at, baseAhead: 2, ahead: 1, mergedAt: "2026-11-14T10:30:00+08:00", liveOpen: false }).phase,
    "review",
  );
  // 旧记录没记 baseAhead：默认按 0
  assert.equal(stepDispatchStatus({ dispatchedAt: at, ahead: 1, mergedAt: null, liveOpen: false }).phase, "review");
});
