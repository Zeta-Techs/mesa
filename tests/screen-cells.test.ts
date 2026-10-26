import assert from "node:assert/strict";
import test from "node:test";
import { italicLine, lineCells, type ScreenCell } from "../src/screen-cells.ts";

const cell = (ch: string, italic?: boolean): ScreenCell => ({ ch, dim: false, inverse: false, bg: false, ...(italic === undefined ? {} : { italic }) });
const row = (text: string, italic?: boolean) => [...text].map((ch) => cell(ch, ch === " " ? false : italic));

test("italicLine：整行的字都是斜体才算，行首状态点「●」不算；空行、给不出斜体的来源都不算", () => {
  // Kimi 收起的思考：● 单独上色不带斜体，后面的字全是斜体
  assert.equal(italicLine([cell(" "), cell("●", false), cell(" "), ...row("想一想", true)]), true);
  assert.equal(italicLine(row("   续行也是斜体", true)), true);
  // 回复正文：不是斜体；混了一个正体字也不算
  assert.equal(italicLine([cell("●", false), cell(" "), ...row("今天晴", false)]), false);
  assert.equal(italicLine([...row("一半斜体", true), cell("字", false)]), false);
  assert.equal(italicLine(row("    ")), false);
  assert.equal(italicLine(row("没有斜体信息")), false);
  assert.equal(italicLine([cell("●", false)]), false);
});

test("lineCells：来源给得出斜体时带上 italic", () => {
  const src = (ch: string, italic: number) => ({
    getChars: () => ch,
    getWidth: () => 1,
    isDim: () => 0,
    isInverse: () => 0,
    isBgDefault: () => true,
    isItalic: () => italic,
  });
  const line = { length: 2, getCell: (x: number) => [src("a", 1), src("b", 0)][x] };
  assert.deepEqual(
    lineCells(line).map((c) => c.italic),
    [true, false],
  );
});
