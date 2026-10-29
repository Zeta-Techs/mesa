import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  notificationPlatformOf,
  notificationSound,
} from "../src/notification-sound.ts";

/**
 * 系统通知的提示音。
 *
 * 三家桌面通知后端都是「不指定声音 = 静音」，而且名字认不得也落成静音（Windows 的
 * toast 库把认不得的名字直接写成 `<audio silent="true"/>`）。所以这里锁两件事：
 * 每个平台给出的名字必须在该平台后端认得的名单里；src/ 里只有 system-notification.ts
 * 一处直接调 sendNotification——别处绕开它发通知，就又回到静音。
 */

/** /System/Library/Sounds 自带的 14 个（各版本 macOS 一致） */
const MAC_SYSTEM_SOUNDS = [
  "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero",
  "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
];

/** tauri-winrt-notification `Sound::from_str` 认得的名字 */
const WINDOWS_TOAST_SOUNDS = /^(Default|IM|Mail|Reminder|SMS|Alarm(?:[2-9]|10)?|Call(?:[2-9]|10)?)$/;

test("macOS 用系统自带的声音名", () => {
  assert.ok(MAC_SYSTEM_SOUNDS.includes(notificationSound("mac")));
});

test("Windows 只能用 toast 库认得的名字，否则静音", () => {
  assert.match(notificationSound("windows"), WINDOWS_TOAST_SOUNDS);
});

test("Linux 给 XDG 音主题名，非空即可", () => {
  assert.ok(notificationSound("linux").length > 0);
});

test("navigator.platform → 通知平台", () => {
  assert.equal(notificationPlatformOf("MacIntel"), "mac");
  assert.equal(notificationPlatformOf("Win32"), "windows");
  assert.equal(notificationPlatformOf("Linux x86_64"), "linux");
  assert.equal(notificationPlatformOf(""), "linux");
});

test("src/ 里只有 system-notification.ts 直接调 sendNotification", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name) || name === "system-notification.ts") continue;
      if (/\bsendNotification\s*\(/.test(readFileSync(full, "utf8"))) offenders.push(full);
    }
  };
  walk(fileURLToPath(new URL("../src", import.meta.url)));
  assert.deepEqual(offenders, []);
});
