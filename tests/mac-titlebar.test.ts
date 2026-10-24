import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  FULLSCREEN_ANIM_HOLD_MS,
  FULLSCREEN_TARGET_TIMEOUT_MS,
  FULLSCREEN_WILL_CHANGE_EVENT,
  MAC_TRAFFIC_PAD,
  macOverlayPadClass,
  resolveFullscreen,
} from "../src/mac-titlebar.ts";

test("窗口态 Mac 给红绿灯让位；全屏或非 Mac 用闲时边距", () => {
  assert.equal(macOverlayPadClass(true, false, "pl-3"), MAC_TRAFFIC_PAD);
  assert.equal(macOverlayPadClass(true, true, "pl-3"), "pl-3");
  assert.equal(macOverlayPadClass(false, false, "pl-3"), "pl-3");
  assert.equal(macOverlayPadClass(false, true, "pl-2"), "pl-2");
});

/* 退全屏时 tao 要等缩回动画放完才把 isFullscreen 翻成 false；原生预告「将退出」后，
   动画中途的 onResized 查询还会报 true，不能被它拽回实心底。 */
test("预告未被查询追上前听预告，追上或超时后回到查询值", () => {
  assert.deepEqual(resolveFullscreen(true, null, 0), { fullscreen: true, keepTarget: false });
  assert.deepEqual(resolveFullscreen(true, false, 300), { fullscreen: false, keepTarget: true });
  assert.deepEqual(resolveFullscreen(false, false, 300), { fullscreen: false, keepTarget: false });
  assert.deepEqual(
    resolveFullscreen(false, true, FULLSCREEN_TARGET_TIMEOUT_MS),
    { fullscreen: false, keepTarget: false },
    "进全屏被系统拒绝：超时后按真实状态",
  );
});

test("过渡标记只在全屏动画期间挂 transition，事件名与 Rust 一致", () => {
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  const anim = /\.ccode-app-shell\[data-fullscreen-anim\]\s*\{[^}]*\}/.exec(css);
  assert.ok(anim, "找不到全屏过渡规则");
  assert.match(anim[0], /transition:\s*background-color/);
  const base = /\.ccode-app-shell\s*\{[^}]*\}/.exec(css);
  assert.ok(base && !/transition/.test(base[0]), "壳常驻 transition 会让换主题时慢半拍");

  const rs = readFileSync(new URL("../src-tauri/src/mac_fullscreen.rs", import.meta.url), "utf8");
  assert.ok(rs.includes(`"${FULLSCREEN_WILL_CHANGE_EVENT}"`), "前后端事件名不一致");
  assert.ok(FULLSCREEN_ANIM_HOLD_MS < FULLSCREEN_TARGET_TIMEOUT_MS);
  // 红绿灯让位进出都一步到位：退全屏滑动会被先出现的红绿灯压住项目芯片（2026-10-23 用户截图），
  // 进全屏滑动是动画套动画（同日用户拍板）
  assert.ok(!/\[data-fullscreen-anim[^\]]*\][^{]*\.ccode-titlebar/.test(css), "全屏过渡不该给标题栏让位挂过渡");
});
