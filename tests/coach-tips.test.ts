import assert from "node:assert/strict";
import test from "node:test";
import { noteChatOpen, noteRepeat, noteSingleAct, type ChatOpen } from "../src/coach-tips.ts";

test("多选提醒：1 分钟内同一件事做到第 2 次才提醒，过期的不算、别的事不算（2026-10-27）", () => {
  let r = noteSingleAct([], "archive", 0);
  assert.equal(r.nudge, false);
  r = noteSingleAct(r.acts, "pin", 1000);
  assert.equal(r.nudge, false, "置顶不和归档凑数");
  r = noteSingleAct(r.acts, "archive", 30_000);
  assert.equal(r.nudge, true);
  r = noteSingleAct([{ kind: "archive", at: 0 }], "archive", 60_000);
  assert.equal(r.nudge, false, "满 1 分钟的不算");
  assert.deepEqual(r.acts, [{ kind: "archive", at: 60_000 }]);
});

test("用鼠标关对话：时间窗里第 2 次才算（2026-10-27）", () => {
  let r = noteRepeat([], 0, 1000);
  assert.equal(r.hit, false);
  r = noteRepeat(r.at, 500, 1000);
  assert.equal(r.hit, true);
  assert.equal(noteRepeat([0], 1000, 1000).hit, false, "满窗口的不算");
  // 聊天 ↔ 终端：去、回还不算，再去才算
  assert.equal(noteRepeat([0], 10, 1000, 3).hit, false);
  assert.equal(noteRepeat([0, 10], 20, 1000, 3).hit, true);
});

test("来回点两段对话：A → B → A → B 时报出刚离开的那段，别的走法不报（2026-10-27）", () => {
  const run = (keys: string[], step = 1000) => {
    let opens: ChatOpen[] = [];
    let other: string | null = null;
    keys.forEach((k, i) => {
      ({ opens, other } = noteChatOpen(opens, k, i * step));
    });
    return other;
  };
  assert.equal(run(["a", "b", "a"]), null, "只回来一次还不算");
  assert.equal(run(["a", "b", "a", "b"]), "a");
  assert.equal(run(["x", "a", "b", "a", "b"]), "a", "只看最近 4 次");
  assert.equal(run(["a", "b", "c", "b"]), null);
  assert.equal(run(["a", "b", "b", "a", "b"]), "a", "再点正看着的那段不算一次");
  assert.equal(run(["a", "b", "a", "b"], 60_000), null, "2 分钟以前的不算");
});
