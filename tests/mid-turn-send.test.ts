import assert from "node:assert/strict";
import test from "node:test";
import { midTurnSpec, queueSendHint, queuedNote, runningPlaceholder, stopTitle } from "../src/mid-turn-send.ts";

// 2026-10-22 本机假网关逐家实测（chat-capture.py QUEUE_* 一幕）：回车发出去的那句落在哪个请求里、哪个键能让它马上处理
test("下一步就交的几家：Claude / Codex / CodeBuddy 按 Esc 立即发送；Qwen / OpenCode 没有立即发送", () => {
  for (const id of ["claude-code", "codex", "codebuddy"]) {
    const s = midTurnSpec(id, { csiU: false });
    assert.equal(s.delivery, "next_step", id);
    assert.equal(s.sendNow?.keys, "\x1b", id);
    assert.equal(s.sendNow?.label, "立即发送");
  }
  for (const id of ["qwen", "opencode"]) {
    assert.deepEqual(midTurnSpec(id, { csiU: false }), { delivery: "next_step", sendNow: null }, id);
  }
});

test("这一轮说完才交的几家：Gemini 按 Esc、Grok 再按回车立即发送；Kimi 的 Ctrl+S 是插进这一轮、按 kitty 写法", () => {
  assert.equal(midTurnSpec("gemini", { csiU: false }).sendNow?.keys, "\x1b");
  const grok = midTurnSpec("grok", { csiU: false });
  assert.equal(grok.delivery, "after_turn");
  assert.equal(grok.sendNow?.keys, "\r");
  const kimi = midTurnSpec("kimi", { csiU: true });
  assert.equal(kimi.delivery, "after_turn");
  assert.equal(kimi.sendNow?.keys, "\x1b[115;5u");
  assert.equal(kimi.sendNow?.label, "插进这一轮");
  assert.equal(midTurnSpec("kimi", { csiU: false }).sendNow?.keys, "\x13");
});

test("没核实过的家不给立即发送；气泡与占位字按真实行为写，不再一律「这一轮结束后处理」", () => {
  const cursor = midTurnSpec("cursor", { csiU: false });
  assert.deepEqual(cursor, { delivery: "unknown", sendNow: null });
  assert.equal(queuedNote(midTurnSpec("codex", { csiU: false })).text, "下一步时交给它");
  assert.equal(queuedNote(midTurnSpec("gemini", { csiU: false })).text, "排队中 · 这一轮结束后处理");
  assert.equal(
    runningPlaceholder(midTurnSpec("claude-code", { csiU: false }), "⌘"),
    "还在回复；现在发的话它下一步就会看到，⌘↩ 立即发送",
  );
  assert.equal(
    runningPlaceholder(midTurnSpec("qwen", { csiU: false }), "Ctrl+"),
    "还在回复；现在发的话它下一步就会看到",
  );
  // 输入框不认快捷键时不写
  assert.equal(
    runningPlaceholder(midTurnSpec("codex", { csiU: false }), null),
    "还在回复；现在发的话它下一步就会看到",
  );
  assert.equal(
    runningPlaceholder(midTurnSpec("kimi", { csiU: true }), "Ctrl+"),
    "还在回复；现在发的话会排队，这一轮结束后处理，Ctrl+↩ 插进这一轮",
  );
});

test("输入框发送区：下一步就交的家写「下一步交给它」；按 Esc 的家，停止钮说明写明排着的话会马上处理", () => {
  assert.equal(queueSendHint(midTurnSpec("claude-code", { csiU: false })).label, "下一步交给它");
  assert.equal(queueSendHint(midTurnSpec("gemini", { csiU: false })).label, "排队");
  assert.match(queueSendHint(midTurnSpec("kimi", { csiU: true })).title, /这一轮结束后处理/);
  assert.match(stopTitle(midTurnSpec("codex", { csiU: false })), /有排着的话时，它会马上处理那句/);
  // Kimi 的 Ctrl+S、Qwen 没有立即发送：停止说明不乱许诺
  assert.doesNotMatch(stopTitle(midTurnSpec("kimi", { csiU: true })), /排着/);
  assert.doesNotMatch(stopTitle(midTurnSpec("qwen", { csiU: false })), /排着/);
});
