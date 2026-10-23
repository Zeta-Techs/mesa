import assert from "node:assert/strict";
import test from "node:test";
import { figureVisionNotice } from "../src/figure-vision.ts";

test("拼图步骤的看图提醒：能看图不提示，不能 / 不知道才提示，不拼图的步骤不提示", () => {
  assert.equal(figureVisionNotice(["review-figures"], "claude-opus", true), null);
  assert.match(figureVisionNotice(["review-writing", "review-figures"], "glm-5.3", false) ?? "", /「glm-5\.3」不能看图/);
  assert.match(figureVisionNotice(["review-figures"], "x-model", null) ?? "", /能不能看图不确定/);
  assert.match(figureVisionNotice(["review-figures"], "", null) ?? "", /默认模型/);
  assert.equal(figureVisionNotice(["review-writing"], "glm-5.3", false), null);
});
