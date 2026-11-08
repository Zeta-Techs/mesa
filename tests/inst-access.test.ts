import assert from "node:assert/strict";
import test from "node:test";
import {
  canAttemptFulltext,
  fulltextViaLabel,
  instActiveFrom,
  instOpenTarget,
  instSessionLabel,
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

