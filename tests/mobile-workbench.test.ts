import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TAILSCALE_HTTPS_PORT,
  formatPairingCountdown,
  mobileWorkbenchSummary,
  tailscaleServeCommand,
  tailscaleStateLabel,
  validateCustomBaseUrl,
  validateTailscalePort,
  type MobileWorkbenchStatusDto,
  type TailscaleInfoDto,
} from "../src/mobile-workbench.ts";

function makeTs(patch: Partial<TailscaleInfoDto> = {}): TailscaleInfoDto {
  return {
    installed: true,
    binaryPath: "/usr/local/bin/tailscale",
    backendState: "Running",
    dnsName: "mac.tail123.ts.net",
    tailscaleIps: ["100.64.1.2"],
    httpsReady: true,
    serveActive: false,
    serveUrl: null,
    hint: "",
    ...patch,
  };
}

function makeStatus(patch: Partial<MobileWorkbenchStatusDto> = {}): MobileWorkbenchStatusDto {
  return {
    enabled: true,
    running: true,
    port: 17590,
    localUrl: "http://127.0.0.1:17590",
    tunnelMode: "tailscale",
    tailscaleHttpsPort: DEFAULT_TAILSCALE_HTTPS_PORT,
    customBaseUrl: "",
    publicUrl: null,
    devices: [],
    pairingUrl: null,
    pairingQrSvg: null,
    pairingLeftSecs: 0,
    tailscale: makeTs(),
    lastError: null,
    ...patch,
  };
}

test("tailscaleServeCommand 始终显式指定 127.0.0.1 回环与安全端口", () => {
  assert.equal(tailscaleServeCommand(8443, 52100), "tailscale serve --bg --https=8443 127.0.0.1:52100");
  assert.equal(tailscaleServeCommand(443, 19000), "tailscale serve --bg --https=443 127.0.0.1:19000");
  assert.equal(tailscaleServeCommand(80, 19000), "tailscale serve --bg --https=8443 127.0.0.1:19000");
});

test("validateTailscalePort 接受 443 与 1024-65535，拒绝非法值", () => {
  assert.deepEqual(validateTailscalePort(""), { port: 8443, error: null });
  assert.deepEqual(validateTailscalePort("443"), { port: 443, error: null });
  assert.deepEqual(validateTailscalePort("8443"), { port: 8443, error: null });
  assert.ok(validateTailscalePort("80").error);
  assert.ok(validateTailscalePort("abc").error);
  assert.ok(validateTailscalePort("70000").error);
});

test("validateCustomBaseUrl 只允许干净的 https:// 基址", () => {
  assert.equal(validateCustomBaseUrl(""), null);
  assert.equal(validateCustomBaseUrl("https://mesa.example.com"), null);
  assert.equal(validateCustomBaseUrl("https://mesa.example.com:8443/"), null);
  assert.ok(validateCustomBaseUrl("http://192.168.1.10:8080"));
  assert.ok(validateCustomBaseUrl("https://mesa.example.com?token=1"));
  assert.ok(validateCustomBaseUrl("https://mesa.example.com#hash"));
});

test("tailscaleStateLabel 准确区分未装、未登录、未开 HTTPS、就绪与已开启", () => {
  assert.equal(tailscaleStateLabel(makeTs({ installed: false })).tone, "muted");
  assert.equal(tailscaleStateLabel(makeTs({ backendState: "NeedsLogin", httpsReady: false })).tone, "warn");
  assert.equal(tailscaleStateLabel(makeTs({ httpsReady: false })).tone, "warn");
  assert.equal(tailscaleStateLabel(makeTs({ httpsReady: true, serveActive: false })).tone, "ok");
  assert.equal(tailscaleStateLabel(makeTs({ serveActive: true })).text, "HTTPS 通道已开启");
});

test("formatPairingCountdown 与 mobileWorkbenchSummary 输出符合预期", () => {
  assert.equal(formatPairingCountdown(300), "5:00");
  assert.equal(formatPairingCountdown(65), "1:05");
  assert.equal(formatPairingCountdown(-5), "0:00");

  assert.equal(mobileWorkbenchSummary(makeStatus({ enabled: false })), "未开启");
  assert.ok(mobileWorkbenchSummary(makeStatus({ publicUrl: "https://mac.tail123.ts.net:8443" })).includes("https://mac.tail123.ts.net:8443"));
  assert.ok(mobileWorkbenchSummary(makeStatus({ publicUrl: null })).includes("127.0.0.1:17590"));
});
