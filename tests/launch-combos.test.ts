import assert from "node:assert/strict";
import test from "node:test";
import { comboDirKey, recordComboIn, rememberCombo, type LaunchCombo } from "../src/launch-combos.ts";

const c = (agentId: string, model = "", effort = "", profileId = `${agentId}-p`): LaunchCombo => ({
  agentId,
  profileId,
  model,
  effort,
});

test("搭配：新的放最前，同样的一套只留一条，最多 3 套", () => {
  let list: LaunchCombo[] = [];
  list = rememberCombo(list, c("claude-code", "glm-5.3", "high"));
  list = rememberCombo(list, c("codex", "gpt-5.5"));
  list = rememberCombo(list, c("claude-code", "glm-5.3", "high"));
  assert.deepEqual(list.map((x) => x.agentId), ["claude-code", "codex"]);
  list = rememberCombo(list, c("kimi"));
  list = rememberCombo(list, c("grok"));
  assert.deepEqual(list.map((x) => x.agentId), ["grok", "kimi", "claude-code"]);
  // 思考档不同算另一套
  assert.equal(rememberCombo([c("codex", "m", "low")], c("codex", "m", "high")).length, 2);
});

test("目录键：去掉末尾分隔符；Windows 统一反斜杠、不分大小写", () => {
  assert.equal(comboDirKey("/Users/a/proj/"), "/Users/a/proj");
  assert.equal(comboDirKey("C:/Work/Proj\\", true), "c:\\work\\proj");
  assert.equal(comboDirKey("/"), "/");
});

test("存储：按目录分开，超过上限丢最久没用的目录", () => {
  let store = {};
  for (let i = 0; i < 45; i++) store = recordComboIn(store, `/p${i}`, c("codex"), i);
  const dirs = Object.keys(store);
  assert.equal(dirs.length, 40);
  assert.ok(!dirs.includes("/p0") && dirs.includes("/p44"));
});
