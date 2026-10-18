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
});
