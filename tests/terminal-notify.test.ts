import assert from "node:assert/strict";
import test from "node:test";
import {
  notificationTitle,
  takeTerminalNotifications,
} from "../src/terminal-notify.ts";

test("OSC 9 和 OSC 777 抽出标题，不留在画面文字里", () => {
  const taken = takeTerminalNotifications("前\x1b]9;做完了\x07后\x1b]777;notify;标题\x1b\\");
  // 777 先抽、OSC 9 后抽（实现顺序），标题集合不变
  assert.deepEqual(taken.titles, ["标题", "做完了"]);
  assert.equal(taken.text, "前后");
  assert.deepEqual(takeTerminalNotifications("普通输出").titles, []);
});

test("OSC 9;4 进度序列不是通知（kimi/grok/codebuddy 高频发送），静默吞掉", () => {
  const taken = takeTerminalNotifications(
    "跑\x1b]9;4;3\x07\x1b]9;4;1;-1\x07\x1b]9;4;0;0\x07完",
  );
  assert.deepEqual(taken.titles, []);
  assert.equal(taken.text, "跑完");
  assert.deepEqual(taken.progress, { state: 0, progress: 0 });
  assert.equal(notificationTitle("4;3"), null);
  // 畸形形态（状态非数字）也属于进度家族：吞掉，绝不漏成标题「4;x」
  assert.equal(notificationTitle("4;x"), null);
  assert.deepEqual(takeTerminalNotifications("\x1b]9;4;x\x07t").titles, []);
});

test("OSC 777 三段式取标题段；非 notify 子命令（如 currentdirectory）静默吞掉", () => {
  const grok = takeTerminalNotifications("\x1b]777;notify;Grok;任务完成\x07");
  assert.deepEqual(grok.titles, ["Grok"]);
  assert.deepEqual(takeTerminalNotifications("\x1b]777;notify;;任务完成\x07").titles, ["任务完成"]);
  const cwd = takeTerminalNotifications("\x1b]777;currentdirectory;/tmp\x07ok");
  assert.deepEqual(cwd.titles, []);
  assert.equal(cwd.text, "ok");
});
