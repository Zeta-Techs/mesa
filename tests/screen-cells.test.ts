import assert from "node:assert/strict";
import test from "node:test";
import { terminalHasInputBox } from "../src/live-reply.ts";
import {
  activeScreenCells,
  activeScreenLines,
  italicLine,
  lineCells,
  type BufferLineSource,
  type ScreenCell,
} from "../src/screen-cells.ts";
import { waitScreenOf } from "../src/terminal-wait.ts";

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

function fakeBufferLine(text: string, dim = false): BufferLineSource {
  const chars = [...text];
  return {
    length: chars.length,
    translateToString: (trimRight) => (trimRight ? text.trimEnd() : text),
    getCell: (x) =>
      x < chars.length
        ? {
            getChars: () => chars[x],
            getWidth: () => 1,
            isDim: () => (dim ? 1 : 0),
            isInverse: () => 0,
            isBgDefault: () => true,
          }
        : undefined,
  };
}

test("activeScreenLines / activeScreenCells：读 baseY 当前屏，不跟停在回滚历史里的 viewportY 走", () => {
  const rule = "─".repeat(60);
  // 2026-11-14 agy 恢复会话实录：content-visibility: hidden 期间 viewportY 卡在旧轮次（第 2 行），
  // 当前屏（baseY = 6，4 行高）已经画出了空闲输入框。
  const all = [
    "上一轮正文",
    rule,
    "> 再来一段",
    "",
    "  好的，再来一段包含长段落、流式表格和嵌套结构的测试内容：",
    "本次流式输出测试结束。",
    rule,
    "> ",
    rule,
    "? for shortcuts                                  mesa/gemini-4-carbon",
  ];
  const term = {
    rows: 4,
    buffer: {
      active: {
        baseY: 6,
        viewportY: 2,
        getLine: (y: number) => (y < all.length ? fakeBufferLine(all[y], y === 9) : undefined),
      },
    },
  };

  // 若错读 viewportY（2..5），既认不出输入框，又会把旧回复冒号结尾行当成「终端在等你」标题
  const staleViewport = all.slice(2, 6);
  assert.equal(terminalHasInputBox(staleViewport, "agy"), false);
  assert.equal(
    waitScreenOf(staleViewport)?.title,
    "好的，再来一段包含长段落、流式表格和嵌套结构的测试内容：",
  );

  // activeScreenLines 恒读 baseY（6..9），认出空闲输入框，不会误报「终端在等你」
  const live = activeScreenLines(term);
  assert.deepEqual(live, [
    rule,
    ">",
    rule,
    "? for shortcuts                                  mesa/gemini-4-carbon",
  ]);
  assert.equal(terminalHasInputBox(live, "agy"), true);
  assert.equal(activeScreenCells(term, 3)[0]?.dim, true);
  assert.deepEqual(activeScreenLines(null), []);
  assert.deepEqual(activeScreenCells(undefined, 0), []);
});

test("lineCells：支持粗体 / 下划线 / 删除线属性读取", () => {
  const mk = (ch: string, opts: { bold?: number; underline?: number; strike?: number }) => ({
    getChars: () => ch,
    getWidth: () => 1,
    isDim: () => 0,
    isInverse: () => 0,
    isBgDefault: () => true,
    isBold: () => opts.bold ?? 0,
    isUnderline: () => opts.underline ?? 0,
    isStrikethrough: () => opts.strike ?? 0,
  });
  const cells = lineCells({
    length: 3,
    getCell: (x) => [mk("A", { bold: 1 }), mk("B", { underline: 1 }), mk("C", { strike: 1 })][x],
  });
  assert.equal(cells[0].bold, true);
  assert.equal(cells[0].underline, false);
  assert.equal(cells[1].underline, true);
  assert.equal(cells[2].strike, true);
});
