import assert from "node:assert/strict";
import test from "node:test";
import {
  pickRouteFix,
  preflightBlockMessage,
  preflightFixMessage,
  preflightReviewNote,
  proxySourceText,
  routeCheckTargets,
  routeFixLabel,
  routeInboxFields,
  runningOfficialTargets,
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
  usualRegion: null,
  usualRegionName: null,
  regionChanged: false,
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

test("后台复查只认在跑的官方账号会话，每家一条", () => {
  const profiles = [
    { id: "o1", agent: "claude-code", accountType: "official" as const },
    { id: "a1", agent: "claude-code", accountType: "api" as const },
    { id: "o2", agent: "codex", accountType: "official" as const },
  ];
  const runs = [
    { running: true, agentId: "claude-code", profileId: "a1" },
    { running: true, agentId: "claude-code", profileId: "o1" },
    { running: true, agentId: "claude-code", profileId: "o1" },
    { running: false, agentId: "codex", profileId: "o2" },
    { running: true, agentId: "kimi", profileId: "o1" },
  ];
  assert.deepEqual(runningOfficialTargets(runs, profiles, ["claude-code", "codex"]), [
    { agent: "claude-code", profileId: "o1" },
  ]);
});

test("收件箱只收拦下和换了出口地区；文案不带延迟，复查不会冒成新条目", () => {
  assert.equal(routeInboxFields(base, "Claude Code"), null);
  const blocked = routeInboxFields({ ...base, verdict: "block", reason: "经出网代理访问 claude.ai 超时" }, "Claude Code");
  assert.deepEqual(blocked, { key: "net:claude-code", text: "Claude Code 的线路不通：经出网代理访问 claude.ai 超时", warn: false });
  const moved = routeInboxFields({ ...base, verdict: "review", regionChanged: true, reason: "这次从美国出去" }, "Claude Code");
  assert.equal(moved?.warn, true);
  assert.equal(routeInboxFields({ ...base, verdict: "review", regionChanged: false, reason: "没拿到出口地区" }, "Claude Code"), null);
});

test("修复只在代理没在运行时给：设置里的代理优先换成在跑的，否则打开代理软件", () => {
  const dead = { stage: "proxy" as const, proxySource: "settings" as const, proxy: "http://127.0.0.1:7888" };
  const cands = [
    { url: "http://127.0.0.1:7888", source: "设置", alive: false },
    { url: "http://127.0.0.1:7897", source: "Clash Verge 默认混合端口", alive: true },
  ];
  const apps = [{ name: "Clash Verge", path: "/Applications/Clash Verge.app" }];
  const sw = pickRouteFix(dead, cands, apps);
  assert.deepEqual(sw, { kind: "switchProxy", url: "http://127.0.0.1:7897", source: "Clash Verge 默认混合端口" });
  assert.equal(routeFixLabel(sw!), "换成 http://127.0.0.1:7897");
  assert.deepEqual(pickRouteFix(dead, [], apps), { kind: "openApp", name: "Clash Verge", path: "/Applications/Clash Verge.app" });
  assert.deepEqual(pickRouteFix({ ...dead, proxySource: "shell" }, cands, apps)?.kind, "openApp", "shell 带进来的代理不替你改设置");
  assert.equal(pickRouteFix({ ...dead, stage: "reach" }, cands, apps), null, "连不上服务不是本机代理的问题，不乱修");
  const msg = preflightFixMessage({ ...base, verdict: "block", reason: "设置里的出网代理 127.0.0.1:7888 没有在运行" }, "Claude Code", sw!);
  assert.match(msg, /7897.*在运行/);
});
