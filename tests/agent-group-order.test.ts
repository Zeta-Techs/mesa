import assert from "node:assert/strict";
import test from "node:test";
import {
  loadProfileOrder,
  moveWithinVisible,
  orderAgentIds,
  PROFILE_ORDER_KEY,
  saveProfileOrder,
} from "../src/agent-group-order.ts";

const DEFAULTS = ["claude-code", "codex", "gemini", "qwen", "opencode"];

test("存下的顺序优先，新 Agent 接在后面，不认识的与重复的丢掉", () => {
  assert.deepEqual(orderAgentIds(DEFAULTS, null), DEFAULTS);
  assert.deepEqual(orderAgentIds(DEFAULTS, ["codex", "gone", "codex", "claude-code"]), [
    "codex",
    "claude-code",
    "gemini",
    "qwen",
    "opencode",
  ]);
});

test("只在看得见的组之间挪，隐藏的组原位不动", () => {
  // 看得见 codex / qwen / opencode（gemini、claude-code 被筛掉），把 opencode 拖到最前
  const full = ["claude-code", "codex", "gemini", "qwen", "opencode"];
  const visible = ["codex", "qwen", "opencode"];
  assert.deepEqual(moveWithinVisible(full, visible, 2, 0), ["claude-code", "opencode", "gemini", "codex", "qwen"]);
  // 往后拖
  assert.deepEqual(moveWithinVisible(full, full, 0, 3), ["codex", "gemini", "qwen", "claude-code", "opencode"]);
  // 越界与原地不变
  assert.deepEqual(moveWithinVisible(full, visible, 1, 1), full);
  assert.deepEqual(moveWithinVisible(full, visible, 0, 9), full);
});

test("组内连接顺序按 Agent 分存，读回时丢掉坏值", () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  assert.deepEqual(loadProfileOrder(), {});
  saveProfileOrder({ codex: ["b", "a"], gemini: ["x"] });
  assert.deepEqual(loadProfileOrder(), { codex: ["b", "a"], gemini: ["x"] });
  store.set(PROFILE_ORDER_KEY, JSON.stringify({ codex: ["b", 3, "a"], qwen: "bad" }));
  assert.deepEqual(loadProfileOrder(), { codex: ["b", "a"] });
  store.set(PROFILE_ORDER_KEY, "[1,2]");
  assert.deepEqual(loadProfileOrder(), {});
  // 新加的连接接在排过的后面
  assert.deepEqual(orderAgentIds(["a", "b", "c"], ["c", "a"]), ["c", "a", "b"]);
});
