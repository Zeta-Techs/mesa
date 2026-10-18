import assert from "node:assert/strict";
import test from "node:test";
import {
  formatStorageBytes,
  internalCleanupConfirmText,
} from "../src/internal-sessions.ts";

test("internalCleanupConfirmText：标题 + 删除/保留对照 + 注意", () => {
  const text = internalCleanupConfirmText({
    total: 1787,
    totalBytes: 151_830_455,
    oldest: null,
    eligible: 681,
    eligibleBytes: 24_802_704,
    retentionDays: 30,
    autoClean: true,
    lastCleanAt: null,
  });
  assert.match(text, /^清理 681 条内部对话？\n\n/);
  assert.match(text, /删除：30 天前.*（24 MB）/);
  assert.match(text, /保留：你项目里的对话/);
  assert.match(text, /注意：直接删除，不进回收站。$/);
});

test("formatStorageBytes", () => {
  assert.equal(formatStorageBytes(512), "512 B");
  assert.equal(formatStorageBytes(1536), "1.5 KB");
  assert.equal(formatStorageBytes(151_830_455), "145 MB");
});
