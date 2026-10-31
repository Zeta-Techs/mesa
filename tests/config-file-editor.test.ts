import test from "node:test";
import assert from "node:assert/strict";
import { dirtyTags, fileHint, formatJsonText, type ConfigFileDto } from "../src/config-file-editor.ts";

const file = (over: Partial<ConfigFileDto> = {}): ConfigFileDto => ({
  tag: "settings.json",
  path: "~/.claude/settings.json",
  exists: true,
  language: "json",
  content: "{}",
  revision: "r",
  hiddenSecrets: 0,
  error: null,
  ...over,
});

test("格式化只认严格 JSON，失败不动原文", () => {
  assert.deepEqual(formatJsonText('{"a":1}'), { ok: true, text: '{\n  "a": 1\n}\n' });
  const bad = formatJsonText("{ // c\n}");
  assert.equal(bad.ok, false);
});

test("说明行：不存在、隐藏了密钥、读不出", () => {
  assert.match(fileHint(file({ exists: false })), /保存后新建/);
  assert.match(fileHint(file({ hiddenSecrets: 2 })), /2 处密钥/);
  assert.match(fileHint(file()), /撤销上次写入/);
  assert.equal(fileHint(file({ error: "读取失败：x" })), "读取失败：x");
});

test("没保存的改动按文件列出", () => {
  const files = [file(), file({ tag: "models.json", content: "[]" })];
  assert.deepEqual(dirtyTags(files, { "settings.json": "{}", "models.json": "[1]" }), ["models.json"]);
  assert.deepEqual(dirtyTags(files, {}), []);
});
