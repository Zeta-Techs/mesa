import assert from "node:assert/strict";
import test from "node:test";
import { VEIL_MAX_MS, VEIL_QUIET_MS, veilClass, veilDecision } from "../src/chat-veil.ts";

test("尺寸停下 90ms 才露出；还在变就等", () => {
  assert.equal(veilDecision({ elapsedMs: 200, quietMs: VEIL_QUIET_MS - 1, loadingOlder: false }), "wait");
  assert.equal(veilDecision({ elapsedMs: 200, quietMs: VEIL_QUIET_MS, loadingOlder: false }), "reveal");
});

test("正在接更早一页时多等；最多等 400ms，到点无论如何露出", () => {
  assert.equal(veilDecision({ elapsedMs: 300, quietMs: 300, loadingOlder: true }), "wait");
  assert.equal(veilDecision({ elapsedMs: VEIL_MAX_MS, quietMs: 0, loadingOlder: true }), "reveal");
});

test("遮着只改透明度不动排版；露出淡入，减弱动态效果时不过渡", () => {
  assert.equal(veilClass(true), "opacity-0");
  assert.match(veilClass(false), /transition-opacity/);
  assert.match(veilClass(false), /motion-reduce:transition-none/);
  assert.doesNotMatch(veilClass(true), /hidden|invisible/);
});

test("聊天层：人刚发的第一句不遮（等回复中，或只有人说的话）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/components/ChatSurface.tsx", import.meta.url), "utf8");
  assert.match(src, /loading \|\| shownMessages\.every\(\(m\) => m\.role === "user"\)/);
});
