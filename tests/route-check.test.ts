import assert from "node:assert/strict";
import test from "node:test";
import {
  pickRouteFix,
  preflightBlockMessage,
  preflightFixMessage,
  preflightReviewNote,
  proxyHeaderSummary,
  proxySourceText,
  routeCheckTargets,
  routeFixLabel,
  routeInboxFields,
  routeProxyKey,
  runningOfficialTargets,
  exitTypeText,
  formatNoProxyLines,
  nativeText,
  noRegionProbeNote,
  normalizeNoProxyInput,
  serviceConfirmText,
  serviceConfirmTip,
  routeRowMain,
  latencyText,
  shortOrg,
  checkedAgoText,
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
  serviceSays: null,
  checkedAt: 0,
};

test("代理来源四种说法，shell 带进来的要点明不是 Mesa 设的", () => {
  assert.equal(proxySourceText(base), "出网代理 http://127.0.0.1:7897");
  assert.match(proxySourceText({ proxySource: "shell", proxy: "http://127.0.0.1:7897" }), /没在 Mesa 里设/);
  assert.match(proxySourceText({ proxySource: "connection", proxy: null }), /清空.*直连/);
  assert.equal(proxySourceText({ proxySource: "none", proxy: null }), "直连");
});

test("体检卡只列有探测点、且配了官方账号的那几家；同家多号配不同代理时分别测", () => {
  const profiles = [
    { id: "a", agent: "claude-code", accountType: "api" as const },
    { id: "b", agent: "claude-code", accountType: "official" as const, name: "主号" },
    { id: "c", agent: "claude-code", accountType: "official" as const, name: "同代理副号" },
    { id: "d", agent: "kimi", accountType: "official" as const },
  ];
  assert.deepEqual(routeCheckTargets(profiles, ["claude-code", "codex"]), [{ agent: "claude-code", profileId: "b" }]);

  const withCustomProxy = [
    ...profiles,
    {
      id: "e",
      agent: "claude-code",
      accountType: "official" as const,
      name: "独立代理号",
      extraEnv: { HTTPS_PROXY: "http://10.0.0.2:3128" },
    },
  ];
  assert.deepEqual(routeCheckTargets(withCustomProxy, ["claude-code"]), [
    { agent: "claude-code", profileId: "b", profileName: "主号" },
    { agent: "claude-code", profileId: "e", profileName: "独立代理号" },
  ]);
});

test("顶部代理汇总：全部一致照常显示，部分连接单独覆盖时标明并支持行内区分", () => {
  const same = proxyHeaderSummary([
    { proxySource: "settings", proxy: "http://127.0.0.1:7897" },
    { proxySource: "settings", proxy: "http://127.0.0.1:7897" },
  ]);
  assert.equal(same.text, "出网代理 http://127.0.0.1:7897");
  assert.equal(same.baseKey, routeProxyKey({ proxySource: "settings", proxy: "http://127.0.0.1:7897" }));

  const mixed = proxyHeaderSummary([
    { proxySource: "connection", proxy: "http://10.0.0.2:3128" },
    { proxySource: "settings", proxy: "http://127.0.0.1:7897" },
    { proxySource: "settings", proxy: "http://127.0.0.1:7897" },
  ]);
  assert.equal(mixed.text, "出网代理 http://127.0.0.1:7897（部分连接单独配置）");
  assert.equal(mixed.baseKey, routeProxyKey({ proxySource: "settings", proxy: "http://127.0.0.1:7897" }));

  const allConn = proxyHeaderSummary([
    { proxySource: "connection", proxy: "http://10.0.0.2:3128" },
    { proxySource: "connection", proxy: null },
  ]);
  assert.equal(allConn.text, "各连接代理不同");
  assert.equal(allConn.baseKey, null);
});

test("拦下时确认框首行是标题、带原因；通过不提示、待你判断才提示", () => {
  const blocked: RouteCheck = { ...base, verdict: "block", stage: "proxy", reason: "代理 127.0.0.1:7888 没开" };
  const msg = preflightBlockMessage(blocked, "Claude Code");
  assert.equal(msg.split("\n")[0], "Claude Code 官方账号可能用不了");
  assert.match(msg, /7888/);
  assert.equal(preflightReviewNote(base, "Claude Code"), null);
  assert.equal(
    preflightReviewNote({ ...base, verdict: "review", reason: "美国（常用英国）" }, "Claude Code"),
    "Claude Code：美国（常用英国）",
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
  const blocked = routeInboxFields({ ...base, verdict: "block", reason: "经代理连不上 claude.ai（超时）" }, "Claude Code");
  assert.deepEqual(blocked, { key: "net:claude-code", text: "Claude Code 线路不通：经代理连不上 claude.ai（超时）", warn: false });
  const moved = routeInboxFields({ ...base, verdict: "review", regionChanged: true, reason: "美国（常用英国）" }, "Claude Code");
  assert.equal(moved?.text, "Claude Code 换了出口：美国（常用英国）");
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
  assert.deepEqual(pickRouteFix(dead, [], []), { kind: "clearProxy" }, "既无在跑代理也无已知软件时（如纯 TUN）兜底清空代理改直连");
  assert.equal(routeFixLabel({ kind: "clearProxy" }), "清空代理改直连");
  assert.match(preflightFixMessage({ ...base, verdict: "block", reason: "代理 127.0.0.1:7888 没开" }, "Claude Code", { kind: "clearProxy" }), /TUN/);
  assert.deepEqual(pickRouteFix({ ...dead, proxySource: "shell" }, cands, apps)?.kind, "openApp", "shell 带进来的代理不替你改设置");
  assert.equal(pickRouteFix({ ...dead, proxySource: "shell" }, [], []), null, "shell 带进来的代理不给清空设置");
  assert.equal(pickRouteFix({ ...dead, stage: "reach" }, cands, apps), null, "连不上服务不是本机代理的问题，不乱修");
  const msg = preflightFixMessage({ ...base, verdict: "block", reason: "代理 127.0.0.1:7888 没开" }, "Claude Code", sw!);
  assert.match(msg, /7897 在运行/);
  const noReg = { registeredCountry: null, registeredCountryName: null, native: null };
  assert.equal(exitTypeText({ kind: "residential", label: "住宅", org: "AS2856 British Telecommunications Limited", ...noReg }), "住宅 · British Telecommunications");
});

test("服务方确认可用才标「Claude 支持这个地区」；没这项检查或没答复不标", () => {
  assert.equal(serviceConfirmText({ ...base, serviceSays: "allowed" }), "Claude 支持这个地区");
  assert.equal(serviceConfirmText({ ...base, agent: "codex", serviceSays: "allowed" }), "OpenAI 支持这个地区");
  assert.match(serviceConfirmTip(base), /不代表账号不会被风控/);
  assert.equal(serviceConfirmText({ ...base, serviceSays: "unknown" }), null);
  assert.equal(serviceConfirmText({ ...base, serviceSays: null }), null);
  assert.equal(serviceConfirmText({ ...base, verdict: "block", serviceSays: "blocked" }), null);
  assert.equal(
    serviceConfirmText({ ...base, verdict: "review", serviceSays: "allowed", reason: "香港（接口出口不同）" }),
    null,
    "网页与接口分流出口不同时不并排显示绿盾「支持这个地区」",
  );
});

test("体检卡一行：通过只写地区，用时单列；网络名收短；测过多久", () => {
  assert.equal(routeRowMain({ verdict: "pass", reason: "英国 · 1.2 秒", exitRegionName: "英国" }), "英国");
  assert.equal(routeRowMain({ verdict: "pass", reason: "可连通 · 1.6 秒", exitRegionName: null }), "可连通");
  assert.equal(routeRowMain({ verdict: "review", reason: "连得上，没拿到地区 · 0.9 秒", exitRegionName: null }), "连得上，没拿到地区");
  assert.equal(routeRowMain({ verdict: "block", reason: "代理 127.0.0.1:7888 没开", exitRegionName: null }), "代理 127.0.0.1:7888 没开");
  assert.deepEqual(
    noRegionProbeNote({ verdict: "pass", exitRegion: null, probeHost: "cloudcode-pa.googleapis.com" })?.host,
    "cloudcode-pa.googleapis.com",
  );
  assert.equal(
    noRegionProbeNote({ verdict: "pass", exitRegion: null, probeHost: "api2.cursor.sh" })?.hint,
    "服务不回出口地区",
  );
  assert.equal(noRegionProbeNote({ verdict: "pass", exitRegion: "GB", probeHost: "claude.ai" }), null);
  assert.equal(noRegionProbeNote({ verdict: "block", exitRegion: null, probeHost: "api2.cursor.sh" }), null);
  assert.equal(noRegionProbeNote({ verdict: "review", exitRegion: null, probeHost: "claude.ai" }), null);
  assert.equal(latencyText(1234), "1.2 秒");
  assert.equal(latencyText(null), "");
  assert.equal(shortOrg("AS2856 British Telecommunications Limited"), "British Telecommunications");
  assert.equal(shortOrg("AS26383 Baxet Group Inc."), "Baxet Group");
  assert.equal(shortOrg("AS31898 Oracle Corporation"), "Oracle");
  assert.equal(shortOrg("AS3462 Data Communication Business Group"), "Data Communication Business Group");
  assert.equal(checkedAgoText(1000, 1030), "刚刚测过");
  assert.equal(checkedAgoText(1000, 1000 + 180), "3 分钟前测过");
});

test("原生 IP：注册国家与所在地相同写「原生 IP」，不同点明注册在哪，判不出不写", () => {
  assert.equal(nativeText({ native: true, registeredCountryName: "英国" }), "原生 IP");
  assert.equal(nativeText({ native: false, registeredCountryName: "美国" }), "非原生（注册在美国）");
  assert.equal(nativeText({ native: null, registeredCountryName: null }), null);
});

test("不走代理列表：展示拆成每行一条，保存自动规整为标准英文逗号串并保序去重", () => {
  assert.equal(formatNoProxyLines(null), "");
  assert.equal(formatNoProxyLines(""), "");
  assert.equal(formatNoProxyLines("localhost, 127.0.0.1, ::1"), "localhost\n127.0.0.1\n::1");
  assert.equal(
    normalizeNoProxyInput(" localhost \n127.0.0.1，::1;localhost\n\n.local "),
    "localhost,127.0.0.1,::1,.local",
  );
  assert.equal(normalizeNoProxyInput("   \n , \n "), "");
});
