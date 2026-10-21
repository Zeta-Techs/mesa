import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";
import {
  findBlockMathStart,
  findInlineMathStart,
  matchBlockMath,
  matchInlineMath,
} from "../src/md-math.ts";

// ===== 纯逻辑：matchInlineMath =====

test("行内公式 $a+b$ 命中，tex 去定界符", () => {
  assert.deepEqual(matchInlineMath("$a+b$"), { raw: "$a+b$", tex: "a+b", display: false });
});

test("行内公式后紧跟正文不粘连：只吃到配对 $", () => {
  const m = matchInlineMath("$x^2$ 是平方");
  assert.equal(m?.raw, "$x^2$");
});

test("行内 $$x$$ 视为展示模式", () => {
  assert.deepEqual(matchInlineMath("$$x^2$$"), { raw: "$$x^2$$", tex: "x^2", display: true });
});

test("货币 $5 不误判：闭合 $ 左侧是空白", () => {
  assert.equal(matchInlineMath("$5 and $10 each"), undefined);
});

test("货币 $5 单独出现：没有闭合 $", () => {
  assert.equal(matchInlineMath("$5."), undefined);
});

test("闭合 $ 后紧跟数字不收（$x$2 按货币口径拒）", () => {
  assert.equal(matchInlineMath("$x$2"), undefined);
});

test("左 $ 右侧是空白不收：$ x$ 非公式", () => {
  assert.equal(matchInlineMath("$ x$"), undefined);
});

test("未闭合 $ 不吞段落", () => {
  assert.equal(matchInlineMath("$a+b 没有闭合"), undefined);
  assert.equal(matchInlineMath("$$a+b 没有闭合"), undefined);
});

test("行内公式不跨行", () => {
  assert.equal(matchInlineMath("$a\nb$"), undefined);
});

test("非 $ 开头直接拒", () => {
  assert.equal(matchInlineMath("x$a$"), undefined);
});

// ===== 纯逻辑：matchBlockMath =====

test("块级公式单行与多行都命中", () => {
  assert.deepEqual(matchBlockMath("$$x^2$$"), { raw: "$$x^2$$", tex: "x^2", display: true });
  const m = matchBlockMath("$$\n\\frac{a}{b}\n$$\n");
  assert.equal(m?.tex, "\\frac{a}{b}");
  assert.equal(m?.display, true);
});

test("块级公式允许 0-3 空格缩进，4 空格（代码块）不碰", () => {
  assert.equal(matchBlockMath("   $$x$$")?.tex, "x");
  assert.equal(matchBlockMath("    $$x$$"), undefined);
});

test("块级公式含空行不吞（两段正文之间误写的 $$）", () => {
  assert.equal(matchBlockMath("$$\n第一段\n\n第二段\n$$"), undefined);
});

test("块级公式空内容拒收", () => {
  assert.equal(matchBlockMath("$$  $$"), undefined);
});

test("块级闭合 $$ 后同行还有正文不当块（留走路内径）", () => {
  assert.equal(matchBlockMath("$$x$$ 尾巴"), undefined);
});

// ===== 纯逻辑：start 定位函数 =====

test("findInlineMathStart 跳过 \\$ 转义", () => {
  assert.equal(findInlineMathStart("价格 \\$5 而 $x$"), 9);
  assert.equal(findInlineMathStart("没有公式"), undefined);
});

test("findBlockMathStart 只认行首 $$", () => {
  assert.equal(findBlockMathStart("前文\n$$x$$"), 3);
  assert.equal(findBlockMathStart("前文 $x$"), undefined);
});

// ===== 端到端：marked.parse（模块作用域已注册扩展） =====

function parse(text: string): string {
  return marked.parse(text, { gfm: true, breaks: false, async: false });
}

test("端到端：行内公式渲染为占位 span，占位文本是原始源码", () => {
  const html = parse("质能方程 $E=mc^2$ 很有名");
  assert.match(html, /<span class="md-math">\$E=mc\^2\$<\/span>/);
});

test("端到端：块级公式渲染为占位 div", () => {
  const html = parse("$$\nE=mc^2\n$$\n");
  assert.match(html, /<div class="md-math md-math-display">\$\$E=mc\^2\$\$<\/div>/);
});

test("端到端： fenced 代码块里的 $ 不渲染", () => {
  const html = parse("```\n$x$ 和 $$y$$\n```\n");
  assert.ok(!html.includes("md-math"), `代码块不应命中公式: ${html}`);
});

test("端到端：行内代码里的 $ 不渲染", () => {
  const html = parse("命令 `$a$` 是占位符");
  assert.ok(!html.includes("md-math"), `行内代码不应命中公式: ${html}`);
  assert.match(html, /<code>\$a\$<\/code>/);
});

test("端到端：货币与未闭合 $ 原样通过", () => {
  const html = parse("苹果 $5 一斤，香蕉 $10 一把");
  assert.ok(!html.includes("md-math"), `货币不应命中公式: ${html}`);
  const open = parse("他说 $x 但是没写完");
  assert.ok(!open.includes("md-math"));
});

test("端到端：\\$ 转义不作定界符", () => {
  const html = parse("价格 \\$5 成交");
  assert.ok(!html.includes("md-math"), `转义不应命中公式: ${html}`);
});

test("端到端：公式内 < & 等字符按文本转义", () => {
  const html = parse("$a < b$");
  assert.match(html, /<span class="md-math">\$a &lt; b\$<\/span>/);
});

test("端到端：段落后紧跟块级公式（无空行）也成块", () => {
  const html = parse("引言如下\n$$x^2$$\n");
  assert.match(html, /<div class="md-math md-math-display">/);
});

// ===== 聊天专用：\( \) / \[ \]（模型回复常用这两种定界符；笔记不开） =====

import { Marked } from "marked";
import { chatMathExtensions, matchBlockBracketMath, matchInlineParenMath } from "../src/md-math.ts";

const chatParse = (src: string) => {
  const m = new Marked({ gfm: true, breaks: true, async: false });
  m.use({ extensions: chatMathExtensions });
  return m.parse(src) as string;
};

test("聊天：\\( \\) 行内、\\[ \\] 块级都渲染成占位（占位写成 $ 形式）", () => {
  assert.deepEqual(matchInlineParenMath("\\(a^2+b^2\\) 是"), { raw: "\\(a^2+b^2\\)", tex: "a^2+b^2", display: false });
  assert.equal(matchBlockBracketMath("\\[\n\\int_0^1 x\\,dx\n\\]")?.tex, "\\int_0^1 x\\,dx");
  const inline = chatParse("勾股定理 \\(a^2+b^2=c^2\\) 成立");
  assert.ok(inline.includes('<span class="md-math">$a^2+b^2=c^2$</span>'), inline);
  const block = chatParse("如下：\n\n\\[\nE = mc^2\n\\]\n\n完");
  assert.ok(block.includes('<div class="md-math md-math-display">$$E = mc^2$$</div>'), block);
  // $ 写法在聊天里照旧
  assert.ok(chatParse("$x_1$").includes('<span class="md-math">$x_1$</span>'));
});

test("聊天：转义方括号 \\[1\\] 不当公式；代码里的 \\( 不碰；笔记的全局实例不认 \\( \\)", () => {
  assert.equal(matchInlineParenMath("\\[1\\]"), undefined);
  assert.ok(!chatParse("见 \\[1\\] 与 \\[2\\]").includes("md-math"));
  assert.ok(!chatParse("`\\(x\\)`").includes("md-math"));
  assert.ok(!(marked.parse("勾股 \\(a^2\\)") as string).includes("md-math"));
});
