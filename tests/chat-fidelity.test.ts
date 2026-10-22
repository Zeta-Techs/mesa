import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_FIDELITY, chatFidelity, parseVersion, verifiedVersion, versionTrust } from "../src/chat-fidelity.ts";

test("九家都写了聊天层能做到哪一步", () => {
  const nine = ["claude-code", "codex", "gemini", "qwen", "opencode", "kimi", "codebuddy", "cursor", "grok"];
  for (const id of nine) {
    const f = chatFidelity(id);
    assert.ok(f, `${id} 缺一行`);
    assert.ok(f.source && f.terminalOnly);
  }
  assert.deepEqual(Object.keys(CHAT_FIDELITY).sort(), [...nine].sort());
  assert.equal(chatFidelity(null), null);
  assert.equal(chatFidelity("custom"), null);
});

test("版本串里取 x.y.z", () => {
  assert.deepEqual(parseVersion("2.1.306 (Claude Code)"), [2, 1, 306]);
  assert.deepEqual(parseVersion("codex-cli 0.163.0"), [0, 163, 0]);
  assert.deepEqual(parseVersion("grok 1.0.67 (2fe064390d07)"), [1, 0, 67]);
  assert.equal(parseVersion("unknown"), null);
});

test("已核对版本：先取本平台，没有就取别的平台里最新的", () => {
  const table = { win32: { "claude-code": "2.1.306", kimi: "2.2.0" }, darwin: { "claude-code": "2.1.300", kimi: "2.3.1" } };
  assert.equal(verifiedVersion(table, "darwin", "claude-code"), "2.1.300");
  assert.equal(verifiedVersion(table, "linux", "kimi"), "2.3.1");
  assert.equal(verifiedVersion({ win32: { codex: "0.163.0" } }, "darwin", "codex"), "0.163.0");
  assert.equal(verifiedVersion(table, "darwin", "cursor"), null);
});

test("比核对过的新才算没核对过；读不到版本不降级", () => {
  assert.equal(versionTrust("2.1.307 (Claude Code)", "2.1.306"), "newer");
  assert.equal(versionTrust("2.1.306 (Claude Code)", "2.1.306"), "verified");
  assert.equal(versionTrust("2.0.9", "2.1.306"), "verified");
  assert.equal(versionTrust(null, "2.1.306"), "unknown");
  assert.equal(versionTrust("2.1.400", null), "unknown");
});

test("小标签：还在测试写「测试版」，第三四档写「简化」，摘了测试版的不标、但 CLI 更新时标「未核对」", async () => {
  const { fidelityBadge } = await import("../src/chat-fidelity.ts");
  const t1 = { tier: 1 as const, beta: true, source: "s", terminalOnly: "t" };
  assert.equal(fidelityBadge(t1, false), "测试版");
  assert.equal(fidelityBadge({ ...t1, beta: false }, false), null);
  assert.equal(fidelityBadge({ ...t1, beta: false }, true), "未核对");
  assert.equal(fidelityBadge({ ...t1, tier: 3, beta: false }, false), "简化");
  assert.equal(fidelityBadge(null, false), null);
  assert.equal(fidelityBadge(chatFidelity("cursor"), false), "简化");
  assert.equal(fidelityBadge(chatFidelity("codex"), false), "测试版");
});
