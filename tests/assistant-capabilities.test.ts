import assert from "node:assert/strict";
import test from "node:test";
import { TRIGGER_CATALOG_LINES, workerCapabilityLines } from "../src/assistant-capabilities.ts";

const base = {
  worker: { agent: "Codex", profile: "我的中转", model: "gpt-5.5" },
  headlessWrite: { supported: true },
  vision: true as boolean | null,
  imageGen: { model: "gpt-image-2", helperReady: true },
  tier: { level: 1 as const, note: "" },
};

test("干活的连接：都能做时逐项写能", () => {
  const text = workerCapabilityLines(base).join("\n");
  assert.match(text, /Codex · 我的中转 · gpt-5\.5/);
  assert.match(text, /一等支持/);
  assert.match(text, /看图：能/);
  assert.match(text, /出图.*能，用设置里选的出图模型 gpt-image-2/);
  assert.match(text, /可以用来建定时任务/);
});

test("干活的连接：做不到的写清缺什么，查不到的说不确定", () => {
  const text = workerCapabilityLines({
    ...base,
    vision: false,
    imageGen: { model: null, helperReady: true },
    headlessWrite: { supported: false, reason: "未验证无头写盘" },
    tier: { level: 2, note: "能启动、能看会话" },
  }).join("\n");
  assert.match(text, /维护级（能启动、能看会话）/);
  assert.match(text, /看图：不能。.*请用户给文字版或数据文件/);
  assert.match(text, /设置里没选出图模型.*数据图照样能用脚本画/);
  assert.match(text, /不能在后台写文件（未验证无头写盘），定时任务选不了它/);
  const unknown = workerCapabilityLines({ ...base, vision: null, headlessWrite: null, imageGen: { model: "x", helperReady: false }, tier: null }).join("\n");
  assert.match(unknown, /看图：不确定/);
  assert.match(unknown, /出图工具没找到/);
  assert.match(unknown, /查不到这家能不能在后台写文件/);
  assert.ok(!/支持程度/.test(unknown));
});

test("没有可用连接：一句话说派不出去；定时与事件只说明不建", () => {
  const none = workerCapabilityLines({ ...base, worker: null });
  assert.equal(none.length, 1);
  assert.match(none[0], /派不出去/);
  assert.match(TRIGGER_CATALOG_LINES[0], /你不建/);
  assert.match(TRIGGER_CATALOG_LINES.join("\n"), /新建默认只记录/);
});

test("各步单独绑定的干活连接：列在默认连接下面，没设默认连接时也保留可派步骤说明", () => {
  const withSteps = workerCapabilityLines({
    ...base,
    stepBindings: [
      { n: 2, name: "文献精读", agent: "Claude Code", profile: "Anthropic 官方", model: "claude-sonnet-4-6", vision: true },
      { n: 4, name: "数据分析", agent: "Kimi Code", profile: "月之暗面", model: "kimi-k2", vision: false },
    ],
  }).join("\n");
  assert.match(withSteps, /各步单独绑定的干活连接（交给那一步时以它为准）/);
  assert.match(withSteps, /第 2 步「文献精读」：Claude Code · Anthropic 官方 · claude-sonnet-4-6，能看图/);
  assert.match(withSteps, /第 4 步「数据分析」：Kimi Code · 月之暗面 · kimi-k2，不能看图/);

  const noDefaultWithStep = workerCapabilityLines({
    ...base,
    worker: null,
    stepBindings: [{ n: 1, name: "检索", agent: "Codex", profile: "中转", model: "gpt-5.4", vision: null }],
  }).join("\n");
  assert.match(noDefaultWithStep, /交给这几步照常能派/);
  assert.match(noDefaultWithStep, /第 1 步「检索」：Codex · 中转 · gpt-5\.4$/m);
});
