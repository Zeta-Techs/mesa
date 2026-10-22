import assert from "node:assert/strict";
import test from "node:test";
import { launchSurface, openSurfaceDefault } from "../src/tab-surface.ts";

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

test("登录、更新、run 脚本永远落终端", () => {
  assert.equal(launchSurface({ shellOnly: true, reused: false, setting: "chat" }), "terminal");
  assert.equal(launchSurface({ prefillCommand: "claude update", surface: "chat", reused: true, setting: "chat" }), "terminal");
});
