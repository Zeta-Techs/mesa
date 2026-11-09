import assert from "node:assert/strict";
import test from "node:test";
import {
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

