import assert from "node:assert/strict";
import test from "node:test";
import {
  HANDOFF_REASONS,
  HANDOFF_REASON_LABEL,
  confirmHandoffReason,
  decisionKind,
  handoffTotals,
  isAutoHandoff,
  shouldRecordHandoff,
} from "../src/chat-handoff-log.ts";
import { readFileSync } from "node:fs";

test("原因闭集与后端 REASONS 同名同序", () => {
  const rs = readFileSync(new URL("../src-tauri/src/chat_handoff_log.rs", import.meta.url), "utf8");
  const block = rs.slice(rs.indexOf("pub(crate) const REASONS"), rs.indexOf("];"));
  const backend = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(backend, [...HANDOFF_REASONS]);
  for (const r of HANDOFF_REASONS) assert.ok(HANDOFF_REASON_LABEL[r]);
});

test("自动 / 手动之分看 user_ 前缀", () => {
  assert.equal(isAutoHandoff("confirm_unrecognized"), true);
  assert.equal(isAutoHandoff("picker"), true);
  assert.equal(isAutoHandoff("user_live"), false);
});

test("等确认：有精确状态没认出菜单，和没有精确状态分开记", () => {
  assert.equal(confirmHandoffReason("hooks_confirm"), "confirm_unrecognized");
  assert.equal(confirmHandoffReason("no_hooks_confirm"), "confirm_no_state");
});

test("确认卡种类取 key 前缀，不让屏上文字混进细分", () => {
  assert.equal(decisionKind("approval:Bash rm -rf"), "approval");
  assert.equal(decisionKind("tui-panel"), "tui-panel");
  assert.equal(decisionKind("ask:要不要继续？"), "ask");
  assert.equal(decisionKind("奇怪:x"), "");
});

test("同一家同一原因 3 秒内只记一次", () => {
  const last = new Map<string, number>();
  assert.equal(shouldRecordHandoff(last, "codex", "picker", 1000), true);
  assert.equal(shouldRecordHandoff(last, "codex", "picker", 2500), false);
  assert.equal(shouldRecordHandoff(last, "codex", "user_live", 2500), true);
  assert.equal(shouldRecordHandoff(last, "qwen", "picker", 2500), true);
  assert.equal(shouldRecordHandoff(last, "codex", "picker", 4001), true);
});

test("合计与自动露出次数", () => {
  const row = (reason: string, count: number) => ({
    agent: "claude-code",
    reason,
    detail: "",
    count,
    lastDay: "2026-10-22",
    versions: [],
  });
  assert.deepEqual(handoffTotals([row("confirm_no_state", 3), row("user_switch", 2)]), {
    total: 5,
    auto: 3,
  });
});
