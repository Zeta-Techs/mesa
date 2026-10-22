import assert from "node:assert/strict";
import test from "node:test";
import { claudeInputRow, readPromptSuggestion } from "../src/prompt-suggestion.ts";
import { lineCells, type ScreenCell } from "../src/screen-cells.ts";

// Claude Code 2.1.306 实录（假网关 + CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1，126×29，2026-10-22；横线截短）：
// 第二轮做完，输入框里出现灰字「再运行一次看看输出」，第一个字反色当光标，「❯」后面是 U+00A0
const RULE = "─".repeat(60);
type Style = "plain" | "dim" | "inverse";

function cells(parts: [string, Style][]): ScreenCell[] {
  return parts.flatMap(([text, style]) =>
    [...text].map((ch) => ({ ch, dim: style === "dim", inverse: style === "inverse", bg: false })),
  );
}

function screen(rows: [string, Style][][]) {
  const lines = [
    "✻ Worked for 6s · done 12:24 PM",
    "",
    RULE,
    ...rows.map((r) => r.map(([t]) => t).join("")),
    RULE,
    "  e2e-picked | work | 6 tok | 0% ctx",
  ];
  const styled = rows.map(cells);
  return { lines, cellsOf: (row: number) => styled[row - 3] ?? [] };
}

test("灰字建议：第一个字反色（终端有焦点）或整句灰（失焦）都认", () => {
  const focused = screen([[["❯ ", "plain"], ["再", "inverse"], ["运行一次看看输出", "dim"]]]);
  assert.equal(claudeInputRow(focused.lines), 3);
  assert.equal(readPromptSuggestion(focused.lines, focused.cellsOf), "再运行一次看看输出");
  const blurred = screen([[["❯ ", "plain"], ["run the tests again", "dim"]]]);
  assert.equal(readPromptSuggestion(blurred.lines, blurred.cellsOf), "run the tests again");
});

test("自己打的字、空输入框、固定提示都不是建议", () => {
  const typed = screen([[["❯ ", "plain"], ["再运行一次", "plain"], [" ", "inverse"]]]);
  assert.equal(readPromptSuggestion(typed.lines, typed.cellsOf), null);
  // 一半灰一半不灰：不认
  const mixed = screen([[["❯ ", "plain"], ["再", "inverse"], ["运行", "dim"], ["一次", "plain"]]]);
  assert.equal(readPromptSuggestion(mixed.lines, mixed.cellsOf), null);
  const empty = screen([[["❯ ", "plain"], [" ", "inverse"]]]);
  assert.equal(readPromptSuggestion(empty.lines, empty.cellsOf), null);
  for (const fixed of ['Try "fix lint errors"', "Press up to edit queued messages", "Message @reviewer…"]) {
    const s = screen([[["❯ ", "plain"], [fixed[0], "inverse"], [fixed.slice(1), "dim"]]]);
    assert.equal(readPromptSuggestion(s.lines, s.cellsOf), null, fixed);
  }
});

test("长建议折到第二行接起来；对话里的「❯」回显（上面不贴横线）不当输入框", () => {
  const wrapped = screen([
    [["❯ ", "plain"], ["r", "inverse"], ["un the full test suite and", "dim"]],
    [["  ", "plain"], ["commit", "dim"]],
  ]);
  assert.equal(readPromptSuggestion(wrapped.lines, wrapped.cellsOf), "run the full test suite and commit");
  assert.equal(claudeInputRow(["❯ TRIGGER_SLOW 讲一段", "⏺ 好的", "", "❯ 再运行一次"]), -1);
});

test("xterm 一行转成字的样子：宽字符的第二格不算", () => {
  const raw = [
    { ch: "❯", w: 1, dim: 0, inv: 0, bg: true },
    { ch: "再", w: 2, dim: 0, inv: 1, bg: true },
    { ch: "", w: 0, dim: 0, inv: 1, bg: true },
    { ch: "运", w: 2, dim: 1, inv: 0, bg: false },
    { ch: "", w: 0, dim: 1, inv: 0, bg: false },
    { ch: "", w: 1, dim: 0, inv: 0, bg: true },
  ];
  const line = {
    length: raw.length,
    getCell: (x: number) => {
      const c = raw[x];
      return {
        getChars: () => c.ch,
        getWidth: () => c.w,
        isDim: () => c.dim,
        isInverse: () => c.inv,
        isBgDefault: () => c.bg,
      };
    },
  };
  assert.deepEqual(lineCells(line), [
    { ch: "❯", dim: false, inverse: false, bg: false },
    { ch: "再", dim: false, inverse: true, bg: false },
    { ch: "运", dim: true, inverse: false, bg: true },
    { ch: " ", dim: false, inverse: false, bg: false },
  ]);
  assert.deepEqual(lineCells(undefined), []);
});
