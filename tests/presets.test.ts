import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_PRESETS, presetsForAgent } from "../src/presets.ts";
import { slotForAgent } from "../src/gateway-slot.ts";

const openAiAgents = ["codex", "qwen", "kimi", "opencode", "grok"];

test("OpenAI 兼容 agent 都有 Moonshot 与百炼快速预设", () => {
  for (const agent of openAiAgents) {
    const list = presetsForAgent(agent);
    const moonshot = list.find((p) => p.name === "Moonshot 月之暗面");
    assert.ok(moonshot, `${agent} 缺少 Moonshot 预设`);
    assert.equal(moonshot.baseUrl, "https://api.moonshot.cn/v1");
    const bailian = list.find((p) => p.name === "阿里云百炼（兼容模式）");
    assert.ok(bailian, `${agent} 缺少百炼预设`);
    assert.equal(
      bailian.baseUrl,
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
  }
});

test("Qwen 与 Kimi 的兼容预设选 openai 协议；kimi 对 Moonshot 走官方 kimi 协议", () => {
  for (const agent of ["qwen", "kimi"]) {
    const bailian = presetsForAgent(agent).find(
      (p) => p.name === "阿里云百炼（兼容模式）",
    );
    assert.equal(bailian?.protocol, "openai", agent);
  }
  const kimiMoonshot = presetsForAgent("kimi").find(
    (p) => p.name === "Moonshot 月之暗面",
  );
  assert.equal(kimiMoonshot?.protocol, "kimi");
  // kimi 官方协议仍用 openai 槽地址
  assert.equal(kimiMoonshot?.baseUrl, "https://api.moonshot.cn/v1");
});

test("智谱分槽：Codex 走 Responses 专用端点 api/v1，其余按计费方式分端点", () => {
  for (const name of ["智谱 GLM Coding Plan（套餐）", "智谱 GLM（按量付费）"]) {
    const glmCodex = presetsForAgent("codex").find((p) => p.name === name);
    assert.equal(glmCodex?.baseUrl, "https://open.bigmodel.cn/api/v1", name);
    assert.equal(glmCodex?.wireApi, "responses", name);
  }
  // 套餐 key 打 /api/paas/v4 报 1113 余额不足（2026-10-20 实测），套餐必须走 coding 端点
  const plan = presetsForAgent("grok").find((p) => p.name === "智谱 GLM Coding Plan（套餐）");
  assert.equal(plan?.baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");
  const payg = presetsForAgent("qwen").find((p) => p.name === "智谱 GLM（按量付费）");
  assert.equal(payg?.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
});

test("Claude 走 Anthropic 兼容端点，CodeBuddy 走 OpenAI 端点", () => {
  const claude = presetsForAgent("claude-code").find((p) => p.name === "DeepSeek");
  assert.equal(claude?.baseUrl, "https://api.deepseek.com/anthropic");
  // CodeBuddy 把 base 原样拼 /chat/completions（2.171 源码），给 Anthropic 地址只得空回复
  const cb = presetsForAgent("codebuddy").find((p) => p.name === "DeepSeek");
  assert.equal(cb?.baseUrl, "https://api.deepseek.com/v1");
  const own = presetsForAgent("codebuddy").find((p) => p.name === "腾讯 CodeBuddy 国际站");
  assert.equal(own?.baseUrl, "https://www.codebuddy.ai/v2");
});

test("gemini/cursor 没有任何预设", () => {
  assert.equal(presetsForAgent("gemini").length, 0);
  assert.equal(presetsForAgent("cursor").length, 0);
});

test("推荐模型精选不超过 3 个、不重复；每条预设至少填一个槽", () => {
  for (const p of PROVIDER_PRESETS) {
    assert.ok(
      Object.values(p.slots).some((v) => !!v),
      `${p.name} 没有任何槽端点`,
    );
    assert.ok(!p.models || p.models.length <= 3, `${p.name} 推荐模型超过 3 个`);
    if (p.models) {
      assert.equal(
        new Set(p.models).size,
        p.models.length,
        `${p.name} 推荐模型重复`,
      );
    }
  }
});

test("派生条目的 baseUrl 必落在该 Agent 的协议槽上（防槽位映射漂移）", () => {
  for (const agent of [
    "claude-code",
    "codebuddy",
    "codex",
    "qwen",
    "kimi",
    "opencode",
    "grok",
    "gemini",
    "cursor",
  ]) {
    for (const preset of presetsForAgent(agent)) {
      const slot = slotForAgent(agent, preset.protocol ?? null);
      assert.equal(
        preset.provider.slots[slot],
        preset.baseUrl,
        `${agent}/${preset.name} 地址没落在 ${slot} 槽`,
      );
    }
  }
});

test("商业中转不进开源默认预设（2026-10-12 拍板，恢复 §10 2026-09-20 口径）", () => {
  // ZetaTechs 预设 2026-10-08 曾短暂收录后移除：开源仓库不内置自家商业端点
  // 与运营措辞，用户要用在连接页手填。钉住防止再滑回去。
  assert.ok(
    !PROVIDER_PRESETS.some((p) => p.name.includes("ZetaTechs")),
    "商业中转预设不得回到开源默认表",
  );
});
