import assert from "node:assert/strict";
import test from "node:test";
import {
  preflightBlockMessage,
  preflightReviewNote,
  proxySourceText,
  routeCheckTargets,
  type RouteCheck,
} from "../src/route-check.ts";

const base: RouteCheck = {
  agent: "claude-code",
  verdict: "pass",
  stage: null,
  reason: "从英国出去，1030 毫秒",
  proxySource: "settings",
  proxy: "http://127.0.0.1:7897",
  probeHost: "claude.ai",
  exitRegion: "GB",
  exitRegionName: "英国",
  latencyMs: 1030,
  checkedAt: 0,
};

test("代理来源四种说法，shell 带进来的要点明不是 Mesa 设的", () => {
  assert.equal(proxySourceText(base), "设置里的出网代理：http://127.0.0.1:7897");
  assert.match(proxySourceText({ proxySource: "shell", proxy: "http://127.0.0.1:7897" }), /没在 Mesa 里设/);
  assert.match(proxySourceText({ proxySource: "connection", proxy: null }), /清空.*直连/);
  assert.equal(proxySourceText({ proxySource: "none", proxy: null }), "没有代理，直连");
});

test("体检卡只列有探测点、且配了官方账号的那几家，每家取第一条官方连接", () => {
  const profiles = [
    { id: "a", agent: "claude-code", accountType: "api" as const },
    { id: "b", agent: "claude-code", accountType: "official" as const },
    { id: "c", agent: "claude-code", accountType: "official" as const },
    { id: "d", agent: "kimi", accountType: "official" as const },
  ];
  assert.deepEqual(routeCheckTargets(profiles, ["claude-code", "codex"]), [{ agent: "claude-code", profileId: "b" }]);
});

test("拦下时确认框首行是标题、带原因；通过不提示、待你判断才提示", () => {
  const blocked: RouteCheck = { ...base, verdict: "block", stage: "proxy", reason: "设置里的出网代理 127.0.0.1:7888 没有在运行" };
  const msg = preflightBlockMessage(blocked, "Claude Code");
  assert.equal(msg.split("\n")[0], "Claude Code 的官方账号可能用不了");
  assert.match(msg, /7888/);
  assert.equal(preflightReviewNote(base, "Claude Code"), null);
  assert.equal(
    preflightReviewNote({ ...base, verdict: "review", reason: "claude.ai 能连上，但没拿到出口地区" }, "Claude Code"),
    "Claude Code 线路体检：claude.ai 能连上，但没拿到出口地区",
  );
});
