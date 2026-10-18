import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatLogText,
  isCancellationRejection,
  isSoftwareRendererName,
  logClockTime,
  logLevelCounts,
  logLevelLabel,
  logLocalTime,
  webglUsable,
} from "../src/diagnostics.ts";

test("识别常见软件 WebGL renderer", () => {
  assert.ok(isSoftwareRendererName("Google SwiftShader"));
  assert.ok(isSoftwareRendererName("Microsoft Basic Render Driver"));
  assert.ok(isSoftwareRendererName("llvmpipe (LLVM 18.1)"));
  assert.ok(!isSoftwareRendererName("ANGLE (NVIDIA GeForce RTX 4060 Direct3D11)"));
});

test("webglUsable：renderer 不明时仅 Windows 回退 canvas", () => {
  const hardware = {
    supported: true,
    debugRendererInfoAvailable: true,
    renderer: "ANGLE (NVIDIA GeForce RTX 4060 Direct3D11)",
    software: false,
  };
  assert.ok(webglUsable(hardware, true));
  assert.ok(webglUsable(hardware, false));

  const software = { ...hardware, renderer: "Google SwiftShader", software: true };
  assert.ok(!webglUsable(software, true));
  assert.ok(!webglUsable(software, false));

  // 拿不到 debug renderer 信息（probe 把这种情况标成 software=true）：Windows 保守回退，其他平台不误伤
  const unknown = {
    supported: true,
    debugRendererInfoAvailable: false,
    renderer: "",
    software: true,
  };
  assert.ok(!webglUsable(unknown, true));
  assert.ok(webglUsable(unknown, false));

  const noContext = { ...unknown, supported: false };
  assert.ok(!webglUsable(noContext, true));
  assert.ok(!webglUsable(noContext, false));
});

test("monaco CancellationError 视为预期取消", () => {
  const canceled = new Error("Canceled");
  canceled.name = "Canceled";
  assert.ok(isCancellationRejection(canceled));
  assert.ok(isCancellationRejection({ name: "Canceled", message: "Canceled" }));
  assert.ok(!isCancellationRejection(new Error("Canceled")));
  assert.ok(!isCancellationRejection(new Error("boom")));
  assert.ok(
    !isCancellationRejection(
      new DOMException("The operation was aborted", "AbortError"),
    ),
  );
  assert.ok(!isCancellationRejection("Canceled"));
  assert.ok(!isCancellationRejection(undefined));
});

test("monaco 剪贴板 workaround 仍是已知 cancel 形态", () => {
  const src = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../node_modules/monaco-editor/esm/vs/platform/clipboard/browser/clipboardService.js",
    ),
    "utf8",
  );
  assert.ok(src.includes("installWebKitWriteTextWorkaround"));
  assert.ok(src.includes("this.webKitPendingClipboardWritePromise.cancel();"));
});

test("应用日志：UTC 时间转本机显示，解析失败原样回落", () => {
  // 断言形状不断言时区（CI 机器时区不定）
  assert.match(logLocalTime("2026-10-17T12:01:02.000Z"), /^2026-10-1[78] \d{2}:\d{2}:02$/);
  assert.match(logClockTime("2026-10-17T12:01:02.000Z"), /^\d{2}:\d{2}:02$/);
  assert.equal(logLocalTime("坏时间T1Z"), "坏时间 1");
  assert.equal(logClockTime("坏时间"), "坏时间");
});

test("应用日志：只给错误/警告加标，计数与复制文本", () => {
  assert.equal(logLevelLabel("error"), "错误");
  assert.equal(logLevelLabel("warn"), "警告");
  assert.equal(logLevelLabel("info"), null);
  const logs = [
    { ts: "x", level: "info", source: "a", message: "m1" },
    { ts: "x", level: "error", source: "b", message: "m2" },
    { ts: "x", level: "warn", source: "c", message: "m3" },
    { ts: "x", level: "error", source: "d", message: "m4" },
  ];
  assert.deepEqual(logLevelCounts(logs), { error: 2, warn: 1 });
  assert.deepEqual(logLevelCounts([]), { error: 0, warn: 0 });
  assert.equal(formatLogText(logs.slice(0, 2)), "x [info] a: m1\nx [error] b: m2");
});
