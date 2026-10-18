import assert from "node:assert/strict";
import test from "node:test";
import {
  filterSlashCommands,
  slashCommandsFor,
  slashQueryOf,
} from "../src/slash-commands.ts";

test("已知 agent 返回各自清单，未知 agent 只有 /help", () => {
  assert.ok(slashCommandsFor("claude").length > 3);
  // 真实 agent id 是 claude-code（面板原先只剩 /help）
  assert.ok(slashCommandsFor("claude-code").some((c) => c.cmd === "/compact"));
  assert.deepEqual(
    slashCommandsFor("cursor").map((c) => c.cmd),
    ["/help"],
  );
  assert.deepEqual(
    slashCommandsFor("grok").map((c) => c.cmd),
    ["/help"],
  );
  assert.ok(slashCommandsFor("opencode").some((c) => c.cmd === "/models"));
  assert.ok(slashCommandsFor("codebuddy").some((c) => c.cmd === "/login"));
  assert.deepEqual(slashCommandsFor(null).map((c) => c.cmd), ["/help"]);
});

test("前缀过滤保持表内顺序", () => {
  const list = slashCommandsFor("codex");
  assert.deepEqual(
    filterSlashCommands(list, "re").map((c) => c.cmd),
    ["/review"],
  );
  assert.deepEqual(
    filterSlashCommands(list, "").map((c) => c.cmd),
    list.map((c) => c.cmd),
    "空前缀 = 全量",
  );
  assert.deepEqual(filterSlashCommands(list, "zzz"), []);
});

test("slashQueryOf：/ 开头且无空格无换行才算输入中", () => {
  assert.equal(slashQueryOf("/mod"), "mod");
  assert.equal(slashQueryOf("/"), "");
  assert.equal(slashQueryOf("/model gpt"), null);
  assert.equal(slashQueryOf("/model\nxx"), null);
  assert.equal(slashQueryOf("hello"), null);
  assert.equal(slashQueryOf(""), null);
});
