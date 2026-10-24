import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_SWITCH,
  launchModelNote,
  looksLikeModelId,
  modelOnProfileSwitch,
  officialModelAllowed,
  runtimeModelSwitch,
} from "../src/model-switch.ts";
import { AGENTS } from "../src/types.ts";

test("能力表只收录真实 agent id", () => {
  const ids = new Set(AGENTS.map((a) => a.id));
  for (const id of Object.keys(MODEL_SWITCH))
    assert.ok(ids.has(id), `${id} 不是已知 agent`);
});

test("单模型 CLI 一律给「只认一个模型」提示", () => {
  for (const id of ["gemini", "qwen", "kimi"])
    assert.match(launchModelNote(id, 1) ?? "", /只认一个模型/, id);
});

test("Grok 支持启动时列出并运行中切换多个模型", () => {
  assert.equal(launchModelNote("grok", 3), null);
  assert.match(MODEL_SWITCH.grok.hint, /\/model|切换/);
});

test("codex 与 cursor 给各自的重启/参数提示", () => {
  assert.match(launchModelNote("codex", 3) ?? "", /停下 AI 再接着聊/);
  assert.match(launchModelNote("cursor", 3) ?? "", /启动参数|不能在会话/);
});

test("claude-code 超过选择器上限才提示", () => {
  assert.equal(launchModelNote("claude-code", 5), null);
  assert.match(launchModelNote("claude-code", 6) ?? "", /第 6 个起/);
});

test("未知 agent 与不限量 CLI 不啰嗦", () => {
  assert.equal(launchModelNote("不存在的-agent", 3), null);
  assert.equal(launchModelNote("opencode", 9), null);
});

test("模型名软校验放得松（中转模型名千奇百怪，宁可漏报）", () => {
  for (const ok of [
    "gpt-4o",
    "claude-opus-4-8",
    "deepseek/deepseek-chat",
    "glm-4.6",
    "o3",
    "qwen:7b",
  ])
    assert.ok(looksLikeModelId(ok), ok);
  // 只有纯字母且无分隔符才判为「不像」
  assert.ok(!looksLikeModelId("随便写的"));
  assert.ok(!looksLikeModelId("模型"));
  assert.ok(!looksLikeModelId(""));
});

test("换 profile 不再静默清掉手填的模型", () => {
  // 手填值不在两边表里 → 保留 + 打 kept 标记（界面据此给一行说明）
  assert.deepEqual(
    modelOnProfileSwitch("my-custom-model-1", ["a-1"], ["b-1", "b-2"]),
    { model: "my-custom-model-1", kept: true },
  );
  // 值本来就是旧 profile 的预设 → 跟着换到新 profile 的默认
  assert.deepEqual(modelOnProfileSwitch("a-1", ["a-1"], ["b-1", "b-2"]), {
    model: "b-1",
    kept: false,
  });
  // 新表里已有同名 → 原样留着
  assert.deepEqual(modelOnProfileSwitch("b-2", ["a-1"], ["b-1", "b-2"]), {
    model: "b-2",
    kept: false,
  });
  // 空值 → 落新 profile 首个
  assert.deepEqual(modelOnProfileSwitch("", ["a-1"], ["b-1"]), {
    model: "b-1",
    kept: false,
  });
  // 新 profile 没配模型：空着（后端会回落 profile.models.first()，即不注入）
  assert.deepEqual(modelOnProfileSwitch("a-1", ["a-1"], []), {
    model: "",
    kept: false,
  });
});

test("官方账号不接受中转 DeepSeek 等模型名", () => {
  assert.equal(officialModelAllowed("codex", "deepseek-v4-flash-0731"), false);
  assert.equal(officialModelAllowed("codex", "gpt-5.1"), true);
  assert.equal(officialModelAllowed("codex", "gpt-5-codex"), true);
  assert.equal(officialModelAllowed("claude-code", "deepseek-chat"), false);
  assert.equal(officialModelAllowed("claude-code", "claude-sonnet-4"), true);
  assert.equal(officialModelAllowed("codex", ""), false);
  assert.equal(officialModelAllowed("claude-code", "kimi-code/k3"), false);
  assert.equal(officialModelAllowed("kimi", "kimi-code/k3"), true);
  assert.equal(officialModelAllowed("kimi", "kimi-k3"), true);
  assert.equal(officialModelAllowed("kimi", "deepseek-chat"), false);
});

test("Kimi 用接口连接启动时运行中不能用命令切模型（只认配置文件里的别名），官方账号照常", () => {
  const ms = { kind: "direct" as const, command: "/model {model}" };
  assert.equal(runtimeModelSwitch(ms, "kimi", "api"), null);
  assert.equal(runtimeModelSwitch(ms, "kimi", "official"), ms);
  assert.equal(runtimeModelSwitch(ms, "claude-code", "api"), ms);
});
