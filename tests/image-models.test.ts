import assert from "node:assert/strict";
import test from "node:test";
import {
  compareImageModels,
  estimateSeconds,
  familyOf,
  groupImageModels,
  progressAt,
  pushRecent,
  recommendedImageModels,
  recordDuration,
  versionOf,
} from "../src/image-models.ts";

// 用户截图里 Zeta-22 网关的出图目录（2026-10-24）
const ZETA = [
  "gemini-2.5-flash-image", "gemini-3-pro-image", "gemini-3-pro-image-preview", "gemini-3.1-flash-image",
  "gemini-3.1-flash-image-preview", "gemini-3.1-flash-lite-image", "gemini-nano-banana-2.1",
  "gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2", "gpt-image-2.5", "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst", "grok-imagine-image", "grok-imagine-image-quality", "qwen-image", "qwen-image-2.0",
  "qwen-image-2.0-2026-03-03", "qwen-image-2.0-pro", "qwen-image-2.0-pro-2026-03-03", "qwen-image-max",
  "qwen-image-max-2025-12-30", "qwen-image-plus", "qwen-image-plus-2026-01-09", "wan2.2-t2i-flash",
  "wan2.2-t2i-plus", "wan2.5-t2i-preview", "wan2.6-image", "wan2.6-t2i", "wanx-v1", "wanx2.1-t2i-turbo",
  "doubao-seedream-3-0-t2i-250415", "doubao-seedream-4-0-250828",
].map((model) => ({ gatewayId: "gw", gatewayName: "Zeta-22", model }));

test("版本号去掉日期快照再取：4-0 读成 4.0，没版本号记 0", () => {
  assert.equal(versionOf("gpt-image-2.5-flare"), 2.5);
  assert.equal(versionOf("doubao-seedream-4-0-250828"), 4);
  assert.equal(versionOf("qwen-image-2.0-pro-2026-03-03"), 2);
  assert.equal(versionOf("grok-imagine-image"), 0);
});

test("同一家里最新的正式版在前：快照、预览、轻量版靠后", () => {
  const gpt = ["gpt-image-1", "gpt-image-2.5-flare", "gpt-image-1-mini", "gpt-image-2.5", "gpt-image-2"];
  assert.deepEqual([...gpt].sort(compareImageModels), [
    "gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2", "gpt-image-1", "gpt-image-1-mini",
  ]);
  const qwen = ["qwen-image-2.0-pro-2026-03-03", "qwen-image", "qwen-image-2.0-pro", "qwen-image-2.0"];
  assert.equal([...qwen].sort(compareImageModels)[0], "qwen-image-2.0-pro");
  assert.equal(["grok-imagine-image", "grok-imagine-image-quality"].sort(compareImageModels)[0], "grok-imagine-image-quality");
});

test("分组按常用度：GPT Image、Gemini、豆包在前；筛选按模型名、网关、家族名都能命中", () => {
  const groups = groupImageModels(ZETA);
  assert.deepEqual(groups.slice(0, 3).map((g) => g.key), ["gpt-image", "gemini", "seedream"]);
  assert.equal(familyOf("wanx-v1").key, "wan");
  assert.equal(groupImageModels(ZETA, "万相")[0].key, "wan");
  assert.deepEqual(groupImageModels(ZETA, "grok").flatMap((g) => g.items.map((i) => i.model)), [
    "grok-imagine-image-quality", "grok-imagine-image",
  ]);
});

test("推荐 = 每家最新的那个，34 个缩成 6 个", () => {
  assert.deepEqual(recommendedImageModels(ZETA).map((i) => i.model), [
    "gpt-image-2.5", "gemini-3.1-flash-image", "doubao-seedream-4-0-250828",
    "grok-imagine-image-quality", "qwen-image-2.0-pro", "wan2.6-image",
  ]);
});

test("估计耗时：有记录取中位数，没有用家族默认；进度不到结果不满格", () => {
  assert.equal(estimateSeconds("gpt-image-2.5", undefined), 90);
  assert.equal(estimateSeconds("grok-imagine-image", [20000, 30000, 26000]), 26);
  assert.equal(progressAt(0, 60), 0);
  assert.ok(Math.abs(progressAt(30, 60) - 0.45) < 1e-9);
  assert.ok(progressAt(600, 60) < 1 && progressAt(600, 60) > 0.98);
  let d: Record<string, number[]> = {};
  for (let i = 1; i <= 7; i++) d = recordDuration(d, "m", i);
  assert.deepEqual(d.m, [3, 4, 5, 6, 7]);
  assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
});
