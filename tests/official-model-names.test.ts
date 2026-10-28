import assert from "node:assert/strict";
import test from "node:test";
import { officialModelLabel } from "../src/official-model-names.ts";

const table = { "claude-code": { opus: "claude-opus-5-5" } };

test("实测过的别名显示完整型号，悬停说明启动传简称", () => {
  const l = officialModelLabel("claude-code", "opus", table);
  assert.equal(l.text, "claude-opus-5-5");
  assert.match(l.tip, /简称 opus/);
  assert.equal(officialModelLabel("claude-code", "default", table).text, "CLI 默认");
});

test("没测出来的别名、完整名原样显示", () => {
  assert.equal(officialModelLabel("claude-code", "sonnet", table).text, "sonnet");
  assert.equal(officialModelLabel("claude-code", "opus", {}).text, "opus");
  assert.deepEqual(officialModelLabel("codex", "gpt-6-luna", table), { text: "gpt-6-luna", tip: "gpt-6-luna" });
});
