import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isImageGenModel, modelKind, nonChatReason, splitChatModels } from "../src/model-kinds.ts";

type Case = { id: string; kind: string; gen: boolean };
const cases: Case[] = JSON.parse(readFileSync("tests/fixtures/model-kinds.json", "utf8"));

test("与后端 image_gen.rs 共读样例：类别与能否直接出图逐条一致", () => {
  assert.ok(cases.length > 40);
  for (const c of cases) {
    assert.equal(modelKind(c.id), c.kind, `${c.id} 的类别`);
    assert.equal(isImageGenModel(c.id), c.gen, `${c.id} 能否直接出图`);
  }
});

test("非对话模型给出置灰说明，出图模型指向设置入口", () => {
  assert.equal(nonChatReason("gpt-6-astra"), null);
  assert.match(nonChatReason("gpt-image-2.5")!, /出图模型，不能用来对话.*出图模型/);
  assert.equal(nonChatReason("text-embedding-3-large"), "向量模型，不能用来对话");
});

test("目录拆成能对话的与隐藏的，顺序不变", () => {
  const { chat, hidden } = splitChatModels(["gpt-6-astra", "gpt-image-2.5", "deepseek-v4", "sora-2", "whisper-1"]);
  assert.deepEqual(chat, ["gpt-6-astra", "deepseek-v4"]);
  assert.deepEqual(hidden, ["gpt-image-2.5", "sora-2", "whisper-1"]);
});
