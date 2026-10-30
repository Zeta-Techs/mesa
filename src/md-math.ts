import { marked, type TokenizerAndRendererExtension } from "marked";

/**
 * md 阅读版式公式渲染（批次 E）：$...$ 行内 / $$...$$ 块级。
 *
 * 结构分两层：
 * 1. marked 扩展（本文件模块作用域 marked.use 注册一次，全局生效）：
 *    把公式段渲染成 <span/div class="md-math">原始 $...$ 源码</span> 占位——
 *    没有 katex 升级的地方（任务书预览等）看到的仍是原文，与接入前完全一致；
 * 2. renderMathInto(host)：阅读视图在 HTML 上屏后调用，动态 import katex + CSS
 *    （懒加载，进 FilePreviewEditor 的 chunk 链，不进主包）把占位换成排版结果；
 *    语法错误回落保留原始源码，不炸页面。
 *
 * 切分口径（Pandoc 风格，防货币/未闭合误判）：
 * - 行内 $...$：左 $ 右侧非空白非 $，右 $ 左侧非空白、右侧不紧跟数字，内容不跨行不含 $；
 * - 行内 $$...$$：同上但不限「右侧非数字」，仍不跨行；
 * - 块级 $$...$$：块边界起步（允许 0-3 空格缩进，4+ 是代码块不碰），内容可跨行但不含空行
 *   （含空行说明更可能是两段正文之间误写了 $$，不吞）；
 * - 反斜杠转义 \$ 不作定界符（start 函数跳过）；代码块/行内代码天然不命中——
 *   marked 的 fence/codespan tokenizer 起始位置总在其中的 $ 之前，先于本扩展消费。
 */

export interface MathMatch {
  /** 命中的原始源码（含定界符） */
  raw: string;
  /** 去掉定界符的 TeX 源码 */
  tex: string;
  /** true = 展示模式（$$），false = 行内（$） */
  display: boolean;
}

/** 块级公式：^$$...$$（0-3 空格缩进），闭合 $$ 后只允许空白到行尾/文末 */
export function matchBlockMath(src: string): MathMatch | undefined {
  const m = /^ {0,3}\$\$[ \t]*\n?([\s\S]*?)\$\$[ \t]*(?=\n|$)/.exec(src);
  if (!m) return undefined;
  const tex = m[1].trim();
  if (!tex) return undefined;
  // 内容含空行 = 多半是两段正文之间误写的 $$，不当公式吞掉整段
  if (/\n[ \t]*\n/.test(m[1])) return undefined;
  return { raw: m[0], tex, display: true };
}

/** 行内公式：^$$...$$ 或 ^$...$（Pandoc 口径见文件头注释） */
export function matchInlineMath(src: string): MathMatch | undefined {
  if (!src.startsWith("$")) return undefined;
  if (src.startsWith("$$")) {
    const m = /^\$\$([^ \t\n$][^\n]*?)\$\$(?!\d)/.exec(src);
    if (!m) return undefined;
    const tex = m[1].trim();
    if (!tex) return undefined;
    return { raw: m[0], tex, display: true };
  }
  const m = /^\$([^ \t\n$](?:[^$\n]*[^ \t\n$])?)\$(?!\d)/.exec(src);
  if (!m) return undefined;
  return { raw: m[0], tex: m[1], display: false };
}

/** marked startBlock：src 是剩余源码去掉首字符；返回下一个块级公式起点（首个 $ 的下标） */
export function findBlockMathStart(src: string): number | undefined {
  const m = /\n( {0,3})\$\$/.exec(src);
  return m ? m.index + 1 + m[1].length : undefined;
}

/** marked startInline：下一个未转义 $ 的下标（\$ 转义跳过） */
export function findInlineMathStart(src: string): number | undefined {
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "$" && (i === 0 || src[i - 1] !== "\\")) return i;
  }
  return undefined;
}

/** 占位 HTML 的文本内容会被原样取回当 TeX 源（textContent 往返），只需文本级转义 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 块级 \[ ... \]（聊天专用）：块边界起步，内容可跨行但不含空行；内容里要有像公式的字符（\ ^ _ = { }），
 *  不然多半是转义方括号「\[1\]」 */
export function matchBlockBracketMath(src: string): MathMatch | undefined {
  const m = /^ {0,3}\\\[[ \t]*\n?([\s\S]*?)\\\][ \t]*(?=\n|$)/.exec(src);
  if (!m) return undefined;
  const tex = m[1].trim();
  if (!tex || /\n[ \t]*\n/.test(m[1]) || !looksLikeTex(tex)) return undefined;
  return { raw: m[0], tex, display: true };
}

/** 行内 \( ... \) 与 \[ ... \]（聊天专用：模型回复常用这两种定界符）；不跨空行 */
export function matchInlineParenMath(src: string): MathMatch | undefined {
  const paren = /^\\\(([\s\S]+?)\\\)/.exec(src);
  if (paren) {
    const tex = paren[1].trim();
    if (!tex || /\n[ \t]*\n/.test(paren[1])) return undefined;
    return { raw: paren[0], tex, display: false };
  }
  const bracket = /^\\\[([\s\S]+?)\\\]/.exec(src);
  if (!bracket) return undefined;
  const tex = bracket[1].trim();
  if (!tex || /\n[ \t]*\n/.test(bracket[1]) || !looksLikeTex(tex)) return undefined;
  return { raw: bracket[0], tex, display: true };
}

function looksLikeTex(tex: string): boolean {
  return /[\\^_={}]/.test(tex);
}

/** 下一个 \( / \[ 的下标 */
export function findInlineParenMathStart(src: string): number | undefined {
  const i = src.search(/\\[([]/);
  return i < 0 ? undefined : i;
}

/** marked startBlock：下一个独占行首的 \[ */
export function findBlockBracketMathStart(src: string): number | undefined {
  const m = /\n( {0,3})\\\[/.exec(src);
  return m ? m.index + 1 + m[1].length : undefined;
}

/** 占位一律写成 $ / $$ 形式（renderMathInto 按定界符长度取 TeX；\( \) 来源也这么存） */
function blockPlaceholder(tex: string): string {
  return `<div class="md-math md-math-display">$$${escapeHtml(tex)}$$</div>\n`;
}
function inlinePlaceholder(tex: string, display: boolean): string {
  const d = display ? "$$" : "$";
  return `<span class="md-math${display ? " md-math-display" : ""}">${d}${escapeHtml(tex)}${d}</span>`;
}

/** $ / $$ 两种定界符（笔记、任务书、聊天共用） */
export const mathExtensions: TokenizerAndRendererExtension[] = [
  {
    name: "mathBlock",
    level: "block",
    start: findBlockMathStart,
    tokenizer(src: string) {
      const m = matchBlockMath(src);
      if (!m) return undefined;
      return { type: "mathBlock", raw: m.raw, tex: m.tex };
    },
    renderer(token) {
      return blockPlaceholder((token as unknown as { tex: string }).tex);
    },
  },
  {
    name: "mathInline",
    level: "inline",
    start: findInlineMathStart,
    tokenizer(src: string) {
      const m = matchInlineMath(src);
      if (!m) return undefined;
      return { type: "mathInline", raw: m.raw, tex: m.tex, display: m.display };
    },
    renderer(token) {
      const t = token as unknown as { tex: string; display: boolean };
      return inlinePlaceholder(t.tex, t.display);
    },
  },
];

/** 聊天额外认 \( \) / \[ \]（模型回复常用；笔记里不开，免得改变已有笔记里转义括号的显示） */
export const chatMathExtensions: TokenizerAndRendererExtension[] = [
  ...mathExtensions,
  {
    name: "mathBlockBracket",
    level: "block",
    start: findBlockBracketMathStart,
    tokenizer(src: string) {
      const m = matchBlockBracketMath(src);
      if (!m) return undefined;
      return { type: "mathBlockBracket", raw: m.raw, tex: m.tex };
    },
    renderer(token) {
      return blockPlaceholder((token as unknown as { tex: string }).tex);
    },
  },
  {
    name: "mathInlineParen",
    level: "inline",
    start: findInlineParenMathStart,
    tokenizer(src: string) {
      const m = matchInlineParenMath(src);
      if (!m) return undefined;
      return { type: "mathInlineParen", raw: m.raw, tex: m.tex, display: m.display };
    },
    renderer(token) {
      const t = token as unknown as { tex: string; display: boolean };
      return inlinePlaceholder(t.tex, t.display);
    },
  },
];

// marked 扩展注册（全局单例）：占位文本 = 原始 $...$ 源码，未升级处观感与接入前一致
marked.use({ extensions: mathExtensions });

/**
 * 把 host 内的 .md-math 占位升级为 KaTeX 排版（无公式直接返回，不触发 katex 加载）。
 * katex 与其 CSS 均动态 import：仅在真有公式时才拉取对应 chunk。
 * 渲染失败（语法错误）保留原始源码并标记 md-math-failed，页面不受影响。
 * 占位与 TeX 源码在 await 前快照：并发重跑（StrictMode 双跑/阅读⇄编辑重挂）时，
 * 后跑者若 await 后才读 textContent，读到的已是前者的排版结果，会误判 md-math-failed；
 * 快照后重跑只是用同一源码再渲染一遍（katex.render 原地覆盖，幂等）。
 */
export async function renderMathInto(host: HTMLElement): Promise<void> {
  const jobs = Array.from(host.querySelectorAll<HTMLElement>(".md-math")).map(
    (el) => {
      const display = el.classList.contains("md-math-display");
      const raw = el.textContent ?? "";
      return {
        el,
        display,
        tex: el.dataset.tex ?? raw.slice(display ? 2 : 1, raw.length - (display ? 2 : 1)),
      };
    },
  );
  if (jobs.length === 0) return;
  const katex = (await import("katex")).default;
  await import("katex/dist/katex.min.css");
  for (const { el, display, tex } of jobs) {
    if (!el.isConnected) continue;
    // 排版后占位文字就没了：源码记在 data-tex，复制时还原成 $TeX$（chat-copy.ts）
    el.dataset.tex = tex;
    try {
      katex.render(tex, el, { displayMode: display, throwOnError: true });
    } catch {
      el.classList.add("md-math-failed");
    }
  }
}
