import assert from "node:assert/strict";
import test from "node:test";
import {
  canAttemptFulltext,
  DEFAULT_INST_LOGIN_URL,
  fulltextViaLabel,
  instActiveFrom,
  instBrowserLoginFresh,
  instLoginOpenUrl,
  INST_BROWSER_LOGIN_TTL_MS,
  instOpenTarget,
  instMorePanelDefaultOpen,
  instSessionLabel,
  isCustomInstLoginUrl,
} from "../src/inst-access.ts";

test("instActiveFrom: 前缀或会话任一即通道可用", () => {
  assert.equal(instActiveFrom(null), false);
  assert.equal(
    instActiveFrom({
      prefixConfigured: false,
      prefixHost: "",
      loginUrlSaved: false,
      sessionPresent: false,
      updatedAt: null,
      cookieCount: 0,
      domains: [],
    }),
    false,
  );
  assert.equal(
    instActiveFrom({
      prefixConfigured: true,
      prefixHost: "proxy.uni.edu",
      loginUrlSaved: true,
      sessionPresent: false,
      updatedAt: null,
      cookieCount: 0,
      domains: [],
    }),
    true,
  );
  assert.equal(
    instActiveFrom({
      prefixConfigured: false,
      prefixHost: "",
      loginUrlSaved: false,
      sessionPresent: true,
      updatedAt: "2026-09-16T08:00:00.000Z",
      cookieCount: 3,
      domains: ["proxy.uni.edu"],
    }),
    true,
  );
});

test("canAttemptFulltext: DOI 必给、落地页仅机构通道可用时给", () => {
  // 裸 DOI / doi.org：离线也能查开放副本，恒可试
  assert.equal(canAttemptFulltext("10.1038/s41586-024-1", false), true);
  assert.equal(canAttemptFulltext("doi: 10.1002/adma.202304268", false), true);
  assert.equal(
    canAttemptFulltext("https://doi.org/10.1016/j.nano.2023.07.011", false),
    true,
  );
  // 普通落地页：无机构通道不摆装死钮
  assert.equal(
    canAttemptFulltext("https://www.sciencedirect.com/science/article/pii/X", false),
    false,
  );
  assert.equal(
    canAttemptFulltext("https://www.sciencedirect.com/science/article/pii/X", true),
    true,
  );
  // 空串/非链接：不给
  assert.equal(canAttemptFulltext("", true), false);
  assert.equal(canAttemptFulltext("无链接", true), false);
});

test("fulltextViaLabel: 渠道文案三分", () => {
  assert.equal(fulltextViaLabel("direct"), "已下载：");
  assert.equal(fulltextViaLabel("oa"), "已获取（开放副本）：");
  assert.equal(fulltextViaLabel("institutional"), "已获取（机构通道）：");
  assert.equal(fulltextViaLabel("weird"), "已下载：");
});

test("instOpenTarget：裸 DOI 补 doi.org，http(s) 原样", () => {
  assert.equal(instOpenTarget("10.1002/adma.202304268"), "https://doi.org/10.1002/adma.202304268");
  assert.equal(instOpenTarget("doi: 10.1038/x"), "https://doi.org/10.1038/x");
  assert.equal(
    instOpenTarget("https://onlinelibrary.wiley.com/doi/10.1/x"),
    "https://onlinelibrary.wiley.com/doi/10.1/x",
  );
});

test("instSessionLabel: 未保存/已保存两态", () => {
  assert.equal(instSessionLabel(null), "未保存会话");
  const label = instSessionLabel({
    prefixConfigured: true,
    prefixHost: "proxy.uni.edu",
    loginUrlSaved: true,
    sessionPresent: true,
    updatedAt: "2026-09-16T08:05:00.000Z",
    cookieCount: 4,
    domains: ["idp.uni.edu", "proxy.uni.edu", "a.com", "b.com", "c.com"],
  });
  assert.match(label, /已保存 4 条会话/);
  assert.match(label, /等 5 个域/);
});


test("instActiveFrom: 只有入口页会话（sessionCredible=false）不算通道可用（2026-09-17 审计）", () => {
  const preAuth = {
    prefixConfigured: false,
    prefixHost: "",
    loginUrlSaved: true,
    sessionPresent: true,
    sessionCredible: false,
    updatedAt: "2026-09-17T00:00:00Z",
    cookieCount: 3,
    domains: ["carsi.edu.cn"],
  };
  assert.equal(instActiveFrom(preAuth), false);
  assert.equal(instActiveFrom({ ...preAuth, sessionCredible: true }), true);
  // 旧后端没有该字段：按可信处理（不回归既有保存态）
  assert.equal(instActiveFrom({ ...preAuth, sessionCredible: undefined }), true);
});

test("instSessionLabel: 入口页会话如实标注「尚未确认机构登录」", () => {
  const label = instSessionLabel({
    prefixConfigured: false,
    prefixHost: "",
    loginUrlSaved: true,
    sessionPresent: true,
    sessionCredible: false,
    updatedAt: "2026-09-17T08:30:00Z",
    cookieCount: 3,
    domains: ["carsi.edu.cn"],
  });
  assert.ok(label.includes("尚未确认机构登录"), label);
  assert.ok(!label.startsWith("已保存"), label);
  const credibleLabel = instSessionLabel({
    prefixConfigured: false,
    prefixHost: "",
    loginUrlSaved: true,
    sessionPresent: true,
    sessionCredible: true,
    updatedAt: "2026-09-17T08:30:00Z",
    cookieCount: 9,
    domains: ["wiley.com"],
  });
  assert.ok(credibleLabel.startsWith("已保存"), credibleLabel);
});

test("isCustomInstLoginUrl: 空和 CARSI 不算自定义", () => {
  assert.equal(isCustomInstLoginUrl(""), false);
  assert.equal(isCustomInstLoginUrl("  "), false);
  assert.equal(isCustomInstLoginUrl(DEFAULT_INST_LOGIN_URL), false);
  assert.equal(isCustomInstLoginUrl("https://www.carsi.edu.cn"), false);
  assert.equal(isCustomInstLoginUrl("https://www.carsi.edu.cn/"), false);
  assert.equal(isCustomInstLoginUrl("https://lib.uni.edu.cn/login"), true);
});

test("instMorePanelDefaultOpen: 填过前缀/自定义入口/有存量会话才默认展开", () => {
  const base = { prefix: "", loginUrl: "", sessionPresent: false };
  assert.equal(instMorePanelDefaultOpen(base), false);
  assert.equal(instMorePanelDefaultOpen({ ...base, prefix: "  " }), false);
  assert.equal(instMorePanelDefaultOpen({ ...base, loginUrl: DEFAULT_INST_LOGIN_URL }), false);
  assert.equal(instMorePanelDefaultOpen({ ...base, prefix: "https://proxy.uni.edu/login?url=" }), true);
  assert.equal(instMorePanelDefaultOpen({ ...base, prefixInvalid: true }), true);
  assert.equal(instMorePanelDefaultOpen({ ...base, loginUrl: "https://lib.uni.edu.cn/" }), true);
  assert.equal(instMorePanelDefaultOpen({ ...base, sessionPresent: true }), true);
});

test("instLoginOpenUrl: 登录入口 > 前缀 > 默认 CARSI", () => {
  assert.equal(instLoginOpenUrl("", ""), DEFAULT_INST_LOGIN_URL);
  assert.equal(instLoginOpenUrl(null, undefined), DEFAULT_INST_LOGIN_URL);
  assert.equal(instLoginOpenUrl("  ", "https://proxy.x.edu.cn/login?url="), "https://proxy.x.edu.cn/login?url=");
  assert.equal(instLoginOpenUrl("https://lib.x.edu.cn/", "https://proxy.x.edu.cn/login?url="), "https://lib.x.edu.cn/");
});

test("instBrowserLoginFresh: 点过「登录好了」一周内算已登录，过期或没点不算", () => {
  const now = 1_800_000_000_000;
  assert.equal(instBrowserLoginFresh(null, now), false);
  assert.equal(instBrowserLoginFresh(now - 1000, now), true);
  assert.equal(instBrowserLoginFresh(now - INST_BROWSER_LOGIN_TTL_MS + 1, now), true);
  assert.equal(instBrowserLoginFresh(now - INST_BROWSER_LOGIN_TTL_MS, now), false);
  // 系统时间被往回调过：未来的标记不当真
  assert.equal(instBrowserLoginFresh(now + 60_000, now), false);
});
