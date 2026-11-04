import assert from "node:assert/strict";
import test from "node:test";
import { buddyDayPart, buddyMood } from "../src/buddy-time.ts";
import { splitAnswerLead } from "../src/project-assistant.ts";

test("小桌按钟点分早上 / 白天 / 傍晚 / 夜深", () => {
  assert.equal(buddyDayPart(5), "night");
  assert.equal(buddyDayPart(6), "morning");
  assert.equal(buddyDayPart(10), "morning");
  assert.equal(buddyDayPart(11), "day");
  assert.equal(buddyDayPart(17), "day");
  assert.equal(buddyDayPart(18), "evening");
  assert.equal(buddyDayPart(21), "evening");
  assert.equal(buddyDayPart(22), "night");
  assert.equal(buddyDayPart(0), "night");
});

test("夜深睡着、早上一杯咖啡、傍晚一盏台灯、白天挥手", () => {
  assert.deepEqual(
    (["morning", "day", "evening", "night"] as const).map((p) => [buddyMood(p).greetPose, buddyMood(p).restPose, buddyMood(p).prop]),
    [
      ["idle", "idle", "coffee"],
      ["wave", "idle", null],
      ["idle", "idle", "lamp"],
      ["sleep", "sleep", null],
    ],
  );
  assert.match(buddyMood("night").greeting, /问我就醒/);
});

test("回答的第一句结论单独拎出来，长段、列表不拎", () => {
  assert.deepEqual(splitAnswerLead("这是 Mesa 的问题。\n\n第 3 步……"), { lead: "这是 Mesa 的问题。", rest: "第 3 步……" });
  assert.deepEqual(splitAnswerLead("**是环境的问题。**\n\n缺 Git"), { lead: "是环境的问题。", rest: "缺 Git" });
  assert.equal(splitAnswerLead("- 第一条\n\n- 第二条").lead, null);
  assert.equal(splitAnswerLead("x".repeat(200)).lead, null);
  assert.deepEqual(splitAnswerLead("只有一句"), { lead: "只有一句", rest: "" });
});
