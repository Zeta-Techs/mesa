import assert from "node:assert/strict";
import test from "node:test";
import { switchByRelaunch, switchPersists } from "../src/switch-strategy.ts";

test("会写回全局配置的切换改走重开接回；写不回去的照旧中途切", () => {
  assert.equal(switchByRelaunch("claude-code", "model", true), true);
  assert.equal(switchByRelaunch("claude-code", "effort", true), true);
  assert.equal(switchByRelaunch("codex", "model", true), true);
  assert.equal(switchByRelaunch("grok", "model", true), true);
  assert.equal(switchByRelaunch("grok", "effort", true), false, "Grok /effort 不写配置，照旧中途切");
  assert.equal(switchByRelaunch("gemini", "model", true), false, "Gemini /model set 只管这一段");
  // 启动时注不进思考档：只能退回命令（菜单写明会存成默认）
  assert.equal(switchByRelaunch("qwen", "effort", false), false);
  assert.equal(switchPersists("qwen", "effort"), true);
});
