import type { Token, Tokens } from "marked";
// md-render 先注册公式 / 脚注扩展并给出文档模式 lexer：lexer 与渲染走同一套 tokenizer，
// $$ 块、脚注定义才不会在 token 流里退化成 paragraph、与渲染 DOM 对不上
import { lexMarkdownDocument } from "./md-render.ts";

/**
 * md 渲染块 → 源码行映射（2026-10-14 拍板：阅读态双击段落跳编辑态定位源码行）。
 *
 * marked 18 的 token 只有 raw、没有行号/位置字段，行号靠「raw 前缀累积」自算；
 * 标记不烘进 HTML（DOMPurify 白名单会剥掉自造 data-*，document-html.ts），
 * 而是「上屏后 DOM 配对」：.md-body 顶层元素子节点 ↔ 块 token 顺序对齐。
 * 配对在双击时惰性执行（不用常驻 Map）：decorateMdCodeBlocks 会把 pre 包进
 * div.md-code、MermaidDiagrams 会 replaceWith 换节点，常驻映射会留死键。
 *
 * 配对失败返回 null，调用方回落为纯切编辑态——失败模式是光标不定位，无数据风险。
 */

export interface MdBlockInfo {
  /** 块起始行（1 起） */
  line: number;
  /** 渲染后期望的顶层元素归一化标签；"*"=任意（raw html 块）；null=不产出顶层元素（space/def） */
  tag: string | "*" | null;
}

function tagOfToken(tok: Token): string | "*" | null {
  switch (tok.type) {
    case "heading":
      return "h" + (tok as Tokens.Heading).depth;
    case "paragraph":
      return "p";
    case "code":
      return "pre";
    case "list":
      return (tok as Tokens.List).ordered ? "ol" : "ul";
    case "blockquote":
      return "blockquote";
    case "table":
      return "table";
    case "hr":
      return "hr";
    case "html":
      return "*";
    case "mathBlock":
      return "math";
    default:
      return null;
  }
}

function countNewlines(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * 顶层块 token 序列及各自起始行。输入须与渲染同一份字符串
 * （FilePreviewEditor 的 ⚠️ U+FE0F→U+FE0E 替换在先）。
 */
export function mdBlocks(srcRaw: string): MdBlockInfo[] {
  // Lexer 入口把 \r\n/\r 归一成 \n（token.raw 里没有 \r），源文做同款归一偏移才能
  // 与 raw 对上；归一不改行数，行号对原文件（含 \r\n）仍成立
  const src = srcRaw.replace(/\r\n?/g, "\n");
  // 文档模式 lexer（内部无参调用 marked.lexer：带 options 对象会整体替换 defaults，丢掉
  // marked.use 注册的全局扩展，实测 $$ 块退化成 paragraph）；与 renderMarkdownDocument 同口径
  const tokens = lexMarkdownDocument(src);
  const out: MdBlockInfo[] = [];
  let pos = 0;
  let line = 1;
  for (const tok of tokens) {
    const raw = tok.raw ?? "";
    let start = pos;
    let crossed = 0;
    if (raw && !src.startsWith(raw, pos)) {
      // 重同步：如重复链接定义会被 Lexer 消费但不进 token 流，raw 拼接短于源文
      const at = src.indexOf(raw, pos);
      if (at < 0) continue;
      crossed = countNewlines(src, pos, at);
      start = at;
    }
    const startLine = line + crossed;
    out.push({ line: startLine, tag: tagOfToken(tok) });
    line = startLine + countNewlines(src, start, start + raw.length);
    pos = start + raw.length;
  }
  return out;
}

/**
 * .md-body 顶层子元素的归一化标签：装饰链会改写顶层节点形态，配对前先归一——
 * div.md-code（decorateMdCodeBlocks 的包装层）与 div.md-mermaid（MermaidDiagrams
 * 替换层）都还原成 pre；div.md-math（md-math 块级公式）标记为 math。
 */
export function mdChildTagOf(tagName: string, className: string): string {
  const tag = tagName.toLowerCase();
  if (tag !== "div") return tag;
  const cls = (match: string) =>
    new RegExp(`(?:^|\\s)${match}(?:\\s|$)`).test(className);
  if (cls("md-code") || cls("md-mermaid")) return "pre";
  if (cls("md-math")) return "math";
  return "div";
}

/**
 * 双击命中的第 targetIndex 个顶层子元素 → 源码行。子节点标签序列与块 token
 * 顺序贪心对齐：跳过不产出元素的 token（null）；一枚「有产出但被清洗剥掉」的
 * token 允许跳过自愈（越过 null 后下一枚匹配即视为当前枚未产出）；raw html（"*"）
 * 是最低优先匹配——下一枚真实 token 能接住当前标签时视为 html 块零产出
 * （注释/script/style 被清洗整块剥掉的场景），避免把后续元素绑到 html 块行号。
 * 对不齐返回 null。
 */
export function mdLineForChild(
  blocks: MdBlockInfo[],
  childTags: string[],
  targetIndex: number,
): number | null {
  if (targetIndex < 0 || targetIndex >= childTags.length) return null;
  // 从 from 起下一个非 null-tag 块的下标（不存在为 -1）
  const nextVisible = (from: number) => {
    let i = from;
    while (i < blocks.length && blocks[i].tag === null) i++;
    return i < blocks.length ? i : -1;
  };
  let ti = 0;
  for (let ci = 0; ci <= targetIndex; ci++) {
    ti = nextVisible(ti);
    if (ti < 0) return null;
    const want = childTags[ci];
    const cur = blocks[ti];
    const matches = (b: MdBlockInfo) => b.tag === want || b.tag === "*";
    if (!matches(cur)) {
      // 跳一枚自愈（当前块的 DOM 被清洗剥掉）；下一枚还接不住则放弃
      const ni = nextVisible(ti + 1);
      if (ni < 0 || !matches(blocks[ni])) return null;
      ti = ni;
    } else if (cur.tag === "*") {
      // html 通配让位：下一枚真实 token 恰好匹配时，视为本 html 块零产出
      const ni = nextVisible(ti + 1);
      if (ni >= 0 && blocks[ni].tag === want) ti = ni;
    }
    if (ci === targetIndex) return blocks[ti].line;
    ti++;
  }
  return null;
}
