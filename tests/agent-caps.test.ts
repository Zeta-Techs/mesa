import assert from "node:assert/strict";
import test from "node:test";
import {
  escInterruptSafe,
  headlessWriteBlocked,
  headlessWriteCaution,
  headlessWriteNote,
} from "../src/agent-caps.ts";

test("headlessWriteBlocked：不支持才禁选", () => {
  assert.equal(headlessWriteBlocked(undefined), null);
  assert.equal(headlessWriteBlocked({ supported: true }), null);
  assert.equal(
    headlessWriteBlocked({ supported: false, reason: "无头写盘未验证，定时任务请换别家" }),
    "无头写盘未验证，定时任务请换别家",
  );
  assert.equal(headlessWriteBlocked({ supported: false }), "不能用于定时任务");
});

test("headlessWriteNote：支持时仍可附注无沙箱", () => {
  assert.equal(headlessWriteNote({ supported: true }), null);
  assert.equal(
    headlessWriteNote({ supported: true, reason: "无沙箱（--yolo 全放行）" }),
    "无沙箱（--yolo 全放行）",
  );
  assert.equal(
    headlessWriteNote({ supported: false, reason: "无头写盘未验证" }),
    null,
  );
  assert.equal(
    headlessWriteCaution({ supported: true, reason: "权限未实测" }),
    "权限未实测",
  );
});

test("escInterruptSafe：Grok 非 prompt 态 Esc 退整进程，不进白名单", () => {
  assert.equal(escInterruptSafe("grok"), false);
  assert.equal(escInterruptSafe("codex"), true);
  assert.equal(escInterruptSafe("claude-code"), true);
  assert.equal(escInterruptSafe("agy"), true);
  assert.equal(escInterruptSafe(null), false);
  assert.equal(escInterruptSafe(undefined), false);
  assert.equal(escInterruptSafe(""), false);
});
