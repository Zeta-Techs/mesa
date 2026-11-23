import assert from "node:assert/strict";
import test from "node:test";
import {
  clampEditorFont,
  clampReadingFont,
  EDITOR_FONT_DEFAULT,
  READ_FONT_DEFAULT,
  stepEditorFont,
  stepReadingFont,
} from "../src/editor-font.ts";

test("编辑器字号：一档一像素，夹在 10–22，坏值回默认", () => {
  assert.equal(stepEditorFont(12.5, 1), 13.5);
  assert.equal(stepEditorFont(10, -1), 10);
  assert.equal(stepEditorFont(22, 1), 22);
  assert.equal(clampEditorFont(Number.NaN), EDITOR_FONT_DEFAULT);
  assert.equal(clampEditorFont(13.3), 13.5);
});

test("Markdown 阅读字号：一档一像素，夹在 12–24，坏值回默认 15", () => {
  assert.equal(stepReadingFont(15, 1), 16);
  assert.equal(stepReadingFont(15, -1), 14);
  assert.equal(stepReadingFont(12, -1), 12);
  assert.equal(stepReadingFont(24, 1), 24);
  assert.equal(clampReadingFont(Number.NaN), READ_FONT_DEFAULT);
});
