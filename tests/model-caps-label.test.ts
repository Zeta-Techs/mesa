import assert from "node:assert/strict";
import test from "node:test";
import { contextLabel, modelCapsLabel } from "../src/model-caps-label.ts";

test("模型菜单能力灰字：上下文窗口 · 思考 · 看图", () => {
  assert.equal(contextLabel(200_000), "200K");
  assert.equal(contextLabel(1_000_000), "1M");
  assert.equal(contextLabel(1_048_576), "1.0M");
  assert.equal(contextLabel(0), null);
  assert.equal(modelCapsLabel({ context: 200_000, thinking: true, vision: null }), "200K · 思考");
  assert.equal(modelCapsLabel({ context: 128_000, thinking: false, vision: true }), "128K · 看图");
  assert.equal(modelCapsLabel({ context: 0, thinking: false, vision: false }), "");
  // 不知道上下文窗口（null）就不写，不拿 128K 保守值冒充（2026-10-21 gemini-4-argon 显示 131K）
  assert.equal(modelCapsLabel({ context: null, thinking: true, vision: null }), "思考");
});
