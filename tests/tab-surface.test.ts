import assert from "node:assert/strict";
import test from "node:test";
import { launchSurface, openSurfaceDefault, stripAnsiLog, topBarModeSpec } from "../src/tab-surface.ts";

test("设置只认 terminal，缺省与乱值都是聊天", () => {
  assert.equal(openSurfaceDefault(undefined), "chat");
  assert.equal(openSurfaceDefault(null), "chat");
  assert.equal(openSurfaceDefault("chat"), "chat");
  assert.equal(openSurfaceDefault("terminal"), "terminal");
  assert.equal(openSurfaceDefault("split"), "chat");
});

test("新开的对话标签跟设置走", () => {
  assert.equal(launchSurface({ reused: false, setting: undefined }), "chat");
  assert.equal(launchSurface({ reused: false, setting: "terminal" }), "terminal");
});

test("切回已开着的标签不改它当前的显示", () => {
  assert.equal(launchSurface({ reused: true, setting: "terminal" }), null);
  assert.equal(launchSurface({ reused: true, setting: "chat" }), null);
});

test("入口写死的照写：新对话固定聊天，MCP 登录这类固定终端，复用时也一样", () => {
  assert.equal(launchSurface({ surface: "chat", reused: false, setting: "terminal" }), "chat");
  assert.equal(launchSurface({ surface: "terminal", reused: true, setting: "chat" }), "terminal");
});

test("登录、更新、run 脚本永远落终端；纯协议原生运行中点「去终端回答」改落聊天页", () => {
  assert.equal(launchSurface({ shellOnly: true, reused: false, setting: "chat" }), "terminal");
  assert.equal(launchSurface({ prefillCommand: "claude update", surface: "chat", reused: true, setting: "chat" }), "terminal");
  assert.equal(
    launchSurface({ surface: "terminal", reused: true, setting: "terminal", nativeRuntime: true }),
    "chat",
  );
  assert.equal(
    launchSurface({ shellOnly: true, surface: "terminal", reused: false, setting: "chat", nativeRuntime: true }),
    "terminal",
  );
});

test("顶栏三路分流：纯协议原生→运行日志、双客户端→隐藏 >_、兼容模式→保留终端、终端模式→去回聊天与侧边提问", () => {
  // 纯协议原生运行中：原 >_ 位置换成「运行日志」，⋯ 改用终端模式（需重启接回）
  assert.deepEqual(
    topBarModeSpec({
      surface: "chat",
      terminalOnly: false,
      actualNativeRuntime: true,
      plannedNativeRuntime: true,
      dualClientNative: false,
      hasPty: true,
    }),
    {
      primaryButton: "logs",
      menuSwitch: { label: "改用终端模式打开", targetSurface: "terminal", switchNative: true },
      showAsideButton: true,
    },
  );
  // 纯协议原生未启动前不亮空日志按钮
  assert.equal(
    topBarModeSpec({
      surface: "chat",
      terminalOnly: false,
      actualNativeRuntime: false,
      plannedNativeRuntime: true,
      dualClientNative: false,
      hasPty: false,
    }).primaryButton,
    "none",
  );
  // 双客户端（Codex / Qwen / OpenCode）：不显示 >_，⋯ 同进程当场切换
  assert.deepEqual(
    topBarModeSpec({
      surface: "chat",
      terminalOnly: false,
      actualNativeRuntime: false,
      plannedNativeRuntime: false,
      dualClientNative: true,
      hasPty: true,
    }),
    {
      primaryButton: "none",
      menuSwitch: { label: "改用终端模式打开", targetSurface: "terminal", switchNative: false },
      showAsideButton: true,
    },
  );
  // 兼容模式（Claude 官方订阅 / agy 网关 / 自动回落）：保留 >_ 终端入口
  assert.deepEqual(
    topBarModeSpec({
      surface: "chat",
      terminalOnly: false,
      actualNativeRuntime: false,
      plannedNativeRuntime: false,
      dualClientNative: false,
      hasPty: true,
    }),
    {
      primaryButton: "terminal",
      menuSwitch: { label: "改用终端模式打开", targetSurface: "terminal", switchNative: false },
      showAsideButton: true,
    },
  );
  // 终端模式：去掉「回聊天」与侧边提问钮，⋯ 放「改用聊天模式打开」
  assert.deepEqual(
    topBarModeSpec({
      surface: "terminal",
      terminalOnly: false,
      actualNativeRuntime: false,
      plannedNativeRuntime: false,
      dualClientNative: false,
      hasPty: true,
    }),
    {
      primaryButton: "none",
      menuSwitch: { label: "改用聊天模式打开", targetSurface: "chat", switchNative: true },
      showAsideButton: false,
    },
  );
  // 纯 shell / 自定义运行时：不给模式切换
  assert.deepEqual(
    topBarModeSpec({
      surface: "terminal",
      terminalOnly: true,
      actualNativeRuntime: false,
      plannedNativeRuntime: false,
      dualClientNative: false,
      hasPty: true,
    }),
    { primaryButton: "none", menuSwitch: null, showAsideButton: false },
  );
});

test("stripAnsiLog 剥除 CSI/OSC 控制序列并统一换行为 LF", () => {
  assert.equal(stripAnsiLog("\x1b[32mhello\x1b[0m\r\n\x1b]0;title\x07world\r"), "hello\nworld\n");
});
