import assert from "node:assert/strict";
import test from "node:test";
import {
  inSessionPermissionSwitch,
  inSessionSwitchCommand,
  inSessionSwitchMidTurn,
  kimiEffortPickLevel,
  switchByRelaunch,
  switchPersists,
} from "../src/switch-strategy.ts";

test("会写回全局配置的切换改走重开接回；写不回去的照旧中途切", () => {
  assert.equal(switchByRelaunch("claude-code", "model", true), true);
  assert.equal(switchByRelaunch("claude-code", "effort", true), true);
  assert.equal(switchByRelaunch("codex", "model", true), true);
  assert.equal(switchByRelaunch("agy", "model", true), true);
  assert.equal(switchByRelaunch("agy", "effort", true), true);
  assert.equal(switchByRelaunch("grok", "model", true), true);
  assert.equal(switchByRelaunch("grok", "effort", true), false, "Grok /effort 不写配置，照旧中途切");
  assert.equal(switchByRelaunch("gemini", "model", true), false, "Gemini /model set 只管这一段");
  // 启动时注不进思考档：只能退回命令（菜单写明会存成默认）
  assert.equal(switchByRelaunch("qwen", "effort", false), false);
  assert.equal(switchPersists("qwen", "effort"), true);
});

test("Codex 0.164 起会话内带参切模型 / 思考档、不写 config.toml：不再重开接回", () => {
  assert.equal(inSessionSwitchCommand("codex", "model", "codex-cli 0.166.0"), "/model {model}");
  assert.equal(inSessionSwitchCommand("codex", "effort", "codex-cli 0.164.0"), "/model --reasoning {level}");
  assert.equal(inSessionSwitchCommand("codex", "model", "codex-cli 0.163.0"), null);
  assert.equal(inSessionSwitchCommand("codex", "model", null), null, "读不到版本按老版本走重开");
  assert.equal(inSessionSwitchCommand("claude-code", "model", "2.1.316"), null);
  assert.equal(switchByRelaunch("codex", "model", true, "codex-cli 0.166.0"), false);
  assert.equal(switchByRelaunch("codex", "effort", true, "codex-cli 0.166.0"), false);
  assert.equal(switchByRelaunch("codex", "model", true, "codex-cli 0.163.0"), true);
  assert.equal(switchPersists("codex", "effort", "codex-cli 0.166.0"), false);
});

test("会话里直接换权限只开给实测过的三家，带版本门槛；只能轮着换档的家不开", () => {
  const kimi = inSessionPermissionSwitch("kimi", "2.5.3");
  assert.equal(kimi?.command, "/permission");
  // Kimi 的 auto 是 Never Ask：完全访问要选 Never Ask，帮我批准是 Ask When Needed
  assert.deepEqual(kimi?.picker?.tiers, { ask: "Always Ask", auto: "Ask When Needed", full: "Never Ask" });
  assert.equal(kimi?.midTurn, "now");
  assert.equal(inSessionPermissionSwitch("kimi", "2.4.1"), null);
  const codex = inSessionPermissionSwitch("codex", "0.167.1");
  assert.equal(codex?.picker?.fullConfirm?.pick, "Yes, continue anyway");
  assert.equal(codex?.midTurn, "next");
  assert.equal(inSessionPermissionSwitch("codex", "0.163.0"), null);
  assert.deepEqual(inSessionPermissionSwitch("qwen", "0.26.7")?.args, { ask: "default", auto: "auto", full: "yolo" });
  assert.equal(inSessionPermissionSwitch("qwen", null), null, "读不到版本按老版本");
  for (const id of ["claude-code", "gemini", "grok", "codebuddy", "opencode", "cursor", "agy"]) {
    assert.equal(inSessionPermissionSwitch(id, "99.0.0"), null, id);
  }
});

test("Kimi 2.5.3 思考档会话内切（走选择器 Alt+S，不写配置），2.4 及以下照旧重开；Codex 0.166+ 与 Kimi 生成中也能切", () => {
  assert.equal(inSessionSwitchCommand("kimi", "effort", "2.5.3"), "/effort {level}");
  assert.equal(inSessionSwitchCommand("kimi", "model", "2.5.3"), null, "Kimi 中途换模型只认配置别名，不开");
  assert.equal(switchPersists("kimi", "effort", "2.5.3"), false);
  assert.equal(switchPersists("kimi", "effort", "2.4.1"), true);
  assert.equal(kimiEffortPickLevel("kimi", "2.5.3", "/effort off"), "off");
  assert.equal(kimiEffortPickLevel("kimi", "2.4.1", "/effort off"), null);
  assert.equal(kimiEffortPickLevel("kimi", "2.5.3", "/model k3"), null);
  assert.equal(inSessionSwitchMidTurn("codex", "0.167.1"), true);
  assert.equal(inSessionSwitchMidTurn("codex", "0.164.0"), false);
  assert.equal(inSessionSwitchMidTurn("kimi", "2.5.3"), true);
  assert.equal(inSessionSwitchMidTurn("claude-code", "9.9.9"), false);
});
