import assert from "node:assert/strict";
import test from "node:test";
import { echoInboxItems, echoText, type OpenDispatch } from "../src/assistant-echo.ts";

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
