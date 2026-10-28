import assert from "node:assert/strict";
import test from "node:test";
import { officialModelLabel } from "../src/official-model-names.ts";

test("Claude 别名显示完整型号，悬停说明启动传简称", () => {
  const l = officialModelLabel("claude-code", "opus");
  assert.equal(l.text, "claude-opus-5-5");
  assert.match(l.tip, /简称 opus/);
  assert.equal(officialModelLabel("claude-code", "default").text, "CLI 默认");
});

test("没收录的原样显示", () => {
  assert.deepEqual(officialModelLabel("claude-code", "claude-fable-5-1[1m]"), {
    text: "claude-fable-5-1[1m]",
    tip: "claude-fable-5-1[1m]",
  });
  assert.equal(officialModelLabel("codex", "gpt-6-luna").text, "gpt-6-luna");
});
