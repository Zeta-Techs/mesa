import assert from "node:assert/strict";
import test from "node:test";
import { REPLAY_HEAD, REPLAY_TAIL, terminalReplayText } from "../src/terminal-replay.ts";

test("回放只留最后若干行", () => {
  const lines = Array.from({ length: 5 }, (_, i) => `L${i}`);
  assert.equal(terminalReplayText(lines, 2), "L3\nL4");
});
test("回放后没点恢复又重启：提示行不叠、尾部空行不涨", () => {
  const first = terminalReplayText(["$ claude", "  Interrupted", ""]);
  // 回放进 xterm 后的缓冲：头提示 + 旧画面 + 空行 + 尾提示，30 秒快照照这个再存
  const buffer = [REPLAY_HEAD, ...first.split("\n"), "", REPLAY_TAIL, ""];
  const second = terminalReplayText(buffer);
  assert.equal(second, first);
  assert.equal(terminalReplayText([REPLAY_HEAD, ...second.split("\n"), "", REPLAY_TAIL]), first);
});
