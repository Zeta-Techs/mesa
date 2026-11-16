import assert from "node:assert/strict";
import test from "node:test";
import {
  appUpdateActionLabel,
  appUpdateCheckedAtLabel,
  appUpdateInboxFields,
  appUpdateProgressLabel,
  appUpdateProgressPct,
  appUpdateStatusHint,
  mergeAppUpdateInbox,
  summarizeUpdateCheckError,
  updaterProxyUrl,
} from "../src/app-update.ts";
import { filterDismissed, inboxSignature } from "../src/inbox.ts";

test("appUpdateInboxFields：无更新 / 空版本 → null", () => {
  assert.equal(appUpdateInboxFields(null), null);
  assert.equal(appUpdateInboxFields({ version: "", currentVersion: "0.1.0" }), null);
});

test("appUpdateInboxFields：key 带版本，文案含新旧版本", () => {
  assert.deepEqual(
    appUpdateInboxFields({ version: "0.1.1", currentVersion: "0.1.0" }),
    {
      key: "update:0.1.1",
      text: "Mesa v0.1.1 可更新（当前 v0.1.0）",
    },
  );
});

test("mergeAppUpdateInbox：无更新摘掉旧条目，有更新替换不重复", () => {
  const items = [
    { key: "dep:git" },
    { key: "update:0.1.0" },
    { key: "ready:ws-1" },
  ];
  assert.deepEqual(
    mergeAppUpdateInbox(items, null).map((it) => it.key),
    ["dep:git", "ready:ws-1"],
  );
  assert.deepEqual(
    mergeAppUpdateInbox(items, { key: "update:0.1.1" }).map((it) => it.key),
    ["dep:git", "ready:ws-1", "update:0.1.1"],
  );
});

test("updaterProxyUrl：只放行 http(s)，空串与 socks5 不传", () => {
  assert.equal(updaterProxyUrl(null), undefined);
  assert.equal(updaterProxyUrl(""), undefined);
  assert.equal(updaterProxyUrl("  "), undefined);
  assert.equal(updaterProxyUrl("socks5://127.0.0.1:7890"), undefined);
  assert.equal(updaterProxyUrl("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(
    updaterProxyUrl(" https://proxy.example:8443 "),
    "https://proxy.example:8443",
  );
});

test("summarizeUpdateCheckError：网络/超时/签名/清单 收成中文，不回原文", () => {
  assert.equal(
    summarizeUpdateCheckError("error sending request for url"),
    "无法连接更新源：请检查网络，或在设置 → 网络填出网代理后重试",
  );
  assert.equal(
    summarizeUpdateCheckError("operation timed out"),
    "检查超时，请检查网络后重试",
  );
  assert.equal(
    summarizeUpdateCheckError("minisign signature mismatch"),
    "更新包签名校验失败",
  );
  assert.equal(
    summarizeUpdateCheckError("Could not fetch a valid release JSON from the remote"),
    "未读到有效的更新清单，请稍后重试",
  );
  // 插件原文：the platform `darwin-x86_64` was not found in the response `platforms` object
  // （Intel Mac 自构建版每次启动都会撞上，不能归成「失败」吓用户）
  assert.equal(
    summarizeUpdateCheckError(
      "the platform `darwin-x86_64` was not found in the response `platforms` object",
    ),
    "这台电脑的平台没有对应的更新包（如自行构建的版本），不会收到应用内更新，请到发布页下载安装包",
  );
  assert.equal(
    summarizeUpdateCheckError(
      "None of the fallback platforms `[\"a\", \"b\"]` were found in the response `platforms` object",
    ),
    "这台电脑的平台没有对应的更新包（如自行构建的版本），不会收到应用内更新，请到发布页下载安装包",
  );
  assert.equal(summarizeUpdateCheckError("weird plugin panic"), "检查更新失败，请稍后重试");
});

test("appUpdateStatusHint：检查中与开发模式不伪装成已是最新", () => {
  assert.equal(appUpdateStatusHint("checking"), "正在检查更新…");
  assert.equal(appUpdateStatusHint("idle"), "正在检查更新…");
  assert.ok(appUpdateStatusHint("dev").includes("开发模式"));
  assert.equal(appUpdateStatusHint("none"), "已是最新版本");
  assert.equal(appUpdateStatusHint("error"), "检查更新失败");
});

test("忽略当前版本后换新版本会复现", () => {
  const v1 = {
    key: "update:0.1.1",
    text: "Mesa v0.1.1 可更新（当前 v0.1.0）",
    actionLabel: "去安装",
  };
  const dismissed = { [v1.key]: inboxSignature(v1) };
  assert.equal(filterDismissed([v1], dismissed).length, 0);
  const v2 = {
    key: "update:0.1.2",
    text: "Mesa v0.1.2 可更新（当前 v0.1.0）",
    actionLabel: "去安装",
  };
  assert.equal(
    filterDismissed(mergeAppUpdateInbox([v1], v2), dismissed).length,
    1,
  );
});

test("appUpdateProgressLabel / pct：下载时写已下 / 总大小（百分比另算），下完写在哪一段", () => {
  const MB = 1024 * 1024;
  assert.equal(appUpdateProgressLabel("downloading", 12 * MB, 48 * MB), "正在下载 12 MB / 48 MB");
  // 下载量偶尔比声明的总量多几个字节，不写出「49 MB / 48 MB」
  assert.equal(appUpdateProgressLabel("downloading", 49 * MB, 48 * MB), "正在下载 48 MB / 48 MB");
  assert.equal(appUpdateProgressPct(50, 100), 50);
  assert.equal(appUpdateProgressPct(1, 0), null);
  assert.equal(appUpdateProgressLabel("downloading", 2048, null), "正在下载 · 已下 2.0 KB");
  assert.equal(appUpdateProgressLabel("downloading", 0, null), "正在下载…");
  assert.equal(appUpdateProgressLabel("installing", 48 * MB, 48 * MB), "下载完成，正在安装…");
  assert.equal(appUpdateProgressLabel("restarting", 0, null), "安装完成，正在重启…");
});

test("appUpdateActionLabel：按钮随段落换字，没在装时是「下载并安装」", () => {
  assert.equal(appUpdateActionLabel(null), "下载并安装");
  assert.equal(appUpdateActionLabel("downloading"), "下载中…");
  assert.equal(appUpdateActionLabel("installing"), "安装中…");
  assert.equal(appUpdateActionLabel("restarting"), "正在重启…");
});

test("appUpdateCheckedAtLabel：当天只写时分，跨天带月日，没查过为空", () => {
  const now = new Date(2026, 10, 16, 15, 30).getTime();
  assert.equal(appUpdateCheckedAtLabel(null, now), "");
  assert.equal(appUpdateCheckedAtLabel(new Date(2026, 10, 16, 9, 5).getTime(), now), "09:05 检查");
  assert.equal(appUpdateCheckedAtLabel(new Date(2026, 10, 15, 23, 59).getTime(), now), "11-15 23:59 检查");
});
