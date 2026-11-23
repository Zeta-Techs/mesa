import assert from "node:assert/strict";
import test from "node:test";
import {
  appUpdateActionLabel,
  appUpdateCheckedAtLabel,
  appUpdateProgressLabel,
  appUpdateProgressPct,
  appUpdateRailLabel,
  appUpdateRailTooltip,
  appUpdateStatusHint,
  DEV_UPDATE_PREVIEW_MARKER,
  isDevPreviewUpdate,
  nextPreviewVersion,
  shouldRecheckAppUpdate,
  summarizeUpdateCheckError,
  updaterProxyUrl,
  APP_UPDATE_FOCUS_RECHECK_MS,
  APP_UPDATE_RECHECK_INTERVAL_MS,
} from "../src/app-update.ts";

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

test("appUpdateRailLabel / tooltip：侧栏按钮平时「更新」，安装中显示百分比或段落，悬停写版本与进度", () => {
  const MB = 1024 * 1024;
  assert.equal(appUpdateRailLabel(null, 0, null), "更新");
  assert.equal(appUpdateRailLabel("downloading", 0, null), "下载中");
  assert.equal(appUpdateRailLabel("downloading", 12 * MB, 48 * MB), "25%");
  assert.equal(appUpdateRailLabel("installing", 48 * MB, 48 * MB), "安装中");
  assert.equal(appUpdateRailLabel("restarting", 48 * MB, 48 * MB), "重启中");
  assert.equal(
    appUpdateRailTooltip("0.9.4", null, 0, null),
    "Mesa v0.9.4 可更新 · 点击更新",
  );
  assert.equal(
    appUpdateRailTooltip("0.9.4", "downloading", 12 * MB, 48 * MB),
    "正在更新到 v0.9.4 · 正在下载 12 MB / 48 MB",
  );
  assert.equal(
    appUpdateRailTooltip("0.9.4", "installing", 48 * MB, 48 * MB),
    "正在更新到 v0.9.4 · 下载完成，正在安装…",
  );
});

test("isDevPreviewUpdate / nextPreviewVersion：仅识别带开发预览标记的对象并递增修订号", () => {
  assert.equal(isDevPreviewUpdate(null), false);
  assert.equal(isDevPreviewUpdate({ version: "0.2.3" }), false);
  assert.equal(isDevPreviewUpdate({ [DEV_UPDATE_PREVIEW_MARKER]: true }), true);
  assert.equal(nextPreviewVersion("0.2.2"), "0.2.3");
  assert.equal(nextPreviewVersion("1.4.9-beta.1"), "1.4.10");
  assert.equal(nextPreviewVersion("dev"), "9.9.9");
});

test("appUpdateCheckedAtLabel：当天只写时分，跨天带月日，没查过为空", () => {
  const now = new Date(2026, 10, 16, 15, 30).getTime();
  assert.equal(appUpdateCheckedAtLabel(null, now), "");
  assert.equal(appUpdateCheckedAtLabel(new Date(2026, 10, 16, 9, 5).getTime(), now), "09:05 检查");
  assert.equal(appUpdateCheckedAtLabel(new Date(2026, 10, 15, 23, 59).getTime(), now), "11-15 23:59 检查");
});

test("shouldRecheckAppUpdate：启动那次没开始、开发模式、正在查、正在安装都不发", () => {
  const base = { installing: false, lastCheckAt: 0, now: 10 * APP_UPDATE_RECHECK_INTERVAL_MS, minGapMs: APP_UPDATE_RECHECK_INTERVAL_MS };
  for (const status of ["idle", "dev", "checking"] as const) {
    assert.equal(shouldRecheckAppUpdate({ ...base, status }), false, status);
  }
  assert.equal(shouldRecheckAppUpdate({ ...base, status: "available", installing: true }), false);
});

test("shouldRecheckAppUpdate：已是最新 / 失败 / 已有更新都按间隔重查（可能又出了更新的版本）", () => {
  const now = 1_000_000_000;
  for (const status of ["none", "error", "available"] as const) {
    assert.equal(
      shouldRecheckAppUpdate({ status, installing: false, lastCheckAt: now - APP_UPDATE_FOCUS_RECHECK_MS, now, minGapMs: APP_UPDATE_FOCUS_RECHECK_MS }),
      true,
      status,
    );
    assert.equal(
      shouldRecheckAppUpdate({ status, installing: false, lastCheckAt: now - APP_UPDATE_FOCUS_RECHECK_MS + 1, now, minGapMs: APP_UPDATE_FOCUS_RECHECK_MS }),
      false,
      status,
    );
  }
});
