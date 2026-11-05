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
