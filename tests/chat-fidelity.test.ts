import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_FIDELITY, baselineKey, chatFidelity, nativeFidelityNote, nativeModeAllowed, nativeModeAvailable, nativeRuntime, nativeStopViaChannel, newerVersion, parseVersion, verifiedVersion, versionTrust } from "../src/chat-fidelity.ts";

test("十家都写了聊天层能做到哪一步", () => {
  const ten = ["claude-code", "codex", "gemini", "qwen", "opencode", "kimi", "codebuddy", "cursor", "grok", "agy"];
  for (const id of ten) {
    const f = chatFidelity(id);
    assert.ok(f, `${id} 缺一行`);
    assert.ok(f.source && f.terminalOnly);
  }
  assert.deepEqual(Object.keys(CHAT_FIDELITY).sort(), [...ten].sort());
  assert.equal(chatFidelity(null), null);
  assert.equal(chatFidelity("custom"), null);
});

test("Windows 上 Grok、Kimi、Antigravity CLI 没有程序状态旁路，降到读画面那一档；其余家两平台一样", () => {
  assert.equal(chatFidelity("kimi")?.tier, 2);
  assert.equal(chatFidelity("kimi", true)?.tier, 3);
  assert.equal(chatFidelity("grok")?.tier, 2);
  assert.equal(chatFidelity("agy")?.tier, 2);
  assert.equal(chatFidelity("agy", true)?.tier, 3);
  const win = chatFidelity("grok", true);
  assert.equal(win?.tier, 3);
  assert.equal(win?.beta, false);
  assert.match(win?.source ?? "", /读终端画面/);
  assert.equal(chatFidelity("codex", true), chatFidelity("codex"));
  assert.equal(chatFidelity("custom", true), null);
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

test("OpenCode 2.x 比自己那份基线（opencode2），1.x 与别家照旧", () => {
  assert.equal(baselineKey("opencode", "opencode v2.2.5"), "opencode2");
  assert.equal(baselineKey("opencode", "1.19.5"), "opencode");
  assert.equal(baselineKey("opencode", null), "opencode", "读不到版本按 1.x");
  assert.equal(baselineKey("codex", "2.0.0"), "codex");
  const table = { darwin: { opencode: "1.19.5", opencode2: "2.2.5" } };
  assert.equal(versionTrust("opencode v2.2.5", verifiedVersion(table, "darwin", baselineKey("opencode", "opencode v2.2.5"))), "verified");
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
  // 原生模式已摘掉「测试版」标，仅 CLI 比核对过的新时标「未核对」；兼容模式仍保留「测试版」
  assert.equal(fidelityBadge(chatFidelity("claude-code"), false, true), null);
  assert.equal(fidelityBadge(chatFidelity("claude-code"), true, true), "未核对");
  assert.equal(fidelityBadge(chatFidelity("claude-code"), false, false), "测试版");
});

test("联网前移的核对版本与随包的取较新，一边读不出取另一边", () => {
  assert.equal(newerVersion("2.1.316", "2.1.320"), "2.1.320");
  assert.equal(newerVersion("2.1.316", "2.1.300"), "2.1.316");
  assert.equal(newerVersion(null, "2.1.320"), "2.1.320");
  assert.equal(newerVersion("2.1.316", null), "2.1.316");
  assert.equal(newerVersion(null, null), null);
});

test("原生模式十家全部点亮：按连接资格闸门控制（Claude 仅非官方，agy 仅官方），Qwen 停止仍走终端", () => {
  for (const id of ["codex", "kimi", "claude-code", "qwen", "opencode", "agy", "gemini", "codebuddy", "grok", "cursor"]) {
    assert.equal(nativeModeAvailable(id), true, id);
  }
  assert.equal(nativeModeAvailable("custom"), false);
  // Qwen 只有发话经通道，停止仍按 Esc；其余九家停止都走通道
  assert.equal(nativeStopViaChannel("qwen"), false);
  for (const id of ["codex", "kimi", "claude-code", "opencode", "agy", "gemini", "codebuddy", "grok", "cursor"]) {
    assert.equal(nativeStopViaChannel(id), true, id);
  }
  // 纯协议运行时（stdio 桥）vs 双客户端
  for (const id of ["kimi", "claude-code", "agy", "gemini", "codebuddy", "grok", "cursor"]) {
    assert.equal(nativeRuntime(id), true, id);
  }
  for (const id of ["codex", "qwen", "opencode"]) {
    assert.equal(nativeRuntime(id), false, id);
  }
  // Claude 只对 API 密钥 / 中转网关连接开放；agy 只对官方登录账号开放
  assert.equal(nativeModeAllowed("claude-code", "official"), false);
  assert.equal(nativeModeAllowed("claude-code", "gateway"), true);
  assert.equal(nativeModeAllowed("agy", "official"), true);
  assert.equal(nativeModeAllowed("agy", "gateway"), false);
  assert.equal(nativeModeAllowed("agy", "api_key"), false);
  assert.equal(nativeModeAllowed("codex", "official"), true);
  assert.equal(nativeModeAllowed("gemini", "gateway"), true);
  assert.equal(nativeModeAllowed("grok", "gateway"), true);
  assert.equal(nativeModeAvailable(null), false);
});

test("原生模式下没有终端界面的家，说明页换成官方协议的说法；双客户端的家照旧", () => {
  for (const id of ["kimi", "claude-code", "agy", "gemini", "codebuddy", "grok", "cursor"]) {
    assert.match(nativeFidelityNote(id)?.source ?? "", /原生模式/, id);
  }
  assert.match(nativeFidelityNote("claude-code")?.terminalOnly ?? "", /终端面板/);
  assert.equal(nativeFidelityNote("codex"), null);
  assert.equal(nativeFidelityNote(null), null);
});
