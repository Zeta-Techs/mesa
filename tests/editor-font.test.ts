import assert from "node:assert/strict";
import test from "node:test";
import { clampEditorFont, EDITOR_FONT_DEFAULT, stepEditorFont } from "../src/editor-font.ts";

test("编辑器字号：一档一像素，夹在 10–22，坏值回默认", () => {
  assert.equal(stepEditorFont(12.5, 1), 13.5);
  assert.equal(stepEditorFont(10, -1), 10);
  assert.equal(stepEditorFont(22, 1), 22);
  assert.equal(clampEditorFont(Number.NaN), EDITOR_FONT_DEFAULT);
  assert.equal(clampEditorFont(13.3), 13.5);
});
