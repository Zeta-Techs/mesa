import { marked, type Token, type TokenizerAndRendererExtension } from "marked";
// 公式扩展先注册（模块作用域 marked.use），文档渲染与 lexer 才走同一套 tokenizer
import "./md-math.ts";
import { splitSkillFrontmatter, type SkillFrontField } from "./skill-preview.ts";

/**
 * 文档版 Markdown 渲染（文件预览 / 办公弹层；2026-10-26 用户「文件预览的问题全部修」）：
 * - 开头的 YAML 头（`---` … `---`，qmd / SKILL.md / Quarto 稿件都有）不交给 marked——原先渲染成
 *   一条横线 + 一个大号二级标题（`---` 被当成 setext 标题下划线）。拆出来由调用方画成一张小卡。
 * - 脚注 `[^1]` / `[^1]: …`：正文里成上标编号，定义收到文末「脚注」一节。
 *
 * 脚注扩展注册在全局 marked 上，但只在「文档模式」里生效（withDocMode 包住的那一次 parse / lex）：
 * 聊天、任务书等别的地方照旧把 `[^1]: …` 当普通段落，不会因为收集了却没人输出而把字吞掉。
 */

export interface MdFrontmatter {
  fields: SkillFrontField[];
}

/** 拆 YAML 头：front 为 null 表示没有；lineOffset = 正文第一行之前被拆掉的行数（双击跳源码行要加回去） */
export function splitMdFrontmatter(text: string): {
  front: MdFrontmatter | null;
  body: string;
  lineOffset: number;
} {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(normalized);
  // 至少有一行顶格的 `key:` 才算 YAML 头：文首一条分隔线 + 一段正文 + 又一条分隔线不是元数据
  if (!m || !/^[A-Za-z0-9_-]+:/m.test(m[1] ?? "")) {
    return { front: null, body: text, lineOffset: 0 };
  }
  const rest = normalized.slice(m[0].length);
  const lead = /^\n*/.exec(rest)?.[0] ?? "";
  const consumed = m[0] + lead;
  const lineOffset = (consumed.match(/\n/g) ?? []).length;
  const { fields } = splitSkillFrontmatter(normalized.slice(0, m[0].length));
  return { front: { fields }, body: rest.slice(lead.length), lineOffset };
}

// ---------- 脚注 ----------

interface DocState {
  /** 首次被引用的顺序 → 编号 */
  order: string[];
  defs: Map<string, string>;
}

let doc: DocState | null = null;

/** 在文档模式下跑 fn（脚注扩展只在这里生效）；可嵌套，内层沿用外层状态 */
export function withDocMode<T>(fn: () => T): T {
  if (doc) return fn();
  doc = { order: [], defs: new Map() };
  try {
    return fn();
  } finally {
    doc = null;
  }
}

const ID = String.raw`[^\]\s^]+`;
const DEF_HEAD = new RegExp(String.raw`^\[\^(${ID})\]:[ \t]*`);

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** 脚注定义：`[^id]: 正文`，续行须缩进（与 Pandoc / GFM 同口径） */
export function matchFootnoteDef(src: string): { raw: string; id: string; text: string } | undefined {
  const head = DEF_HEAD.exec(src);
  if (!head) return undefined;
  const lines = src.split("\n");
  const first = lines[0]!.slice(head[0].length);
  const body = [first];
  let rawLines = 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^(?: {2,}|\t)\S/.test(line)) {
      body.push(line.replace(/^(?: {1,4}|\t)/, ""));
      rawLines = i + 1;
      continue;
    }
    // 空行后接缩进行仍属本条（多段脚注）
    if (!line.trim() && /^(?: {2,}|\t)\S/.test(lines[i + 1] ?? "")) {
      body.push("");
      continue;
    }
    break;
  }
  const raw = lines.slice(0, rawLines).join("\n") + (rawLines < lines.length ? "\n" : "");
  return { raw, id: head[1]!, text: body.join("\n").trim() };
}

const footnoteExtensions: TokenizerAndRendererExtension[] = [
  {
    name: "footnoteDef",
    level: "block",
    start(src) {
      if (!doc) return undefined;
      const m = /^\[\^[^\]\s^]+\]:/m.exec(src);
      return m?.index;
    },
    tokenizer(src) {
      if (!doc) return undefined;
      const m = matchFootnoteDef(src);
      if (!m) return undefined;
      const token = { type: "footnoteDef", raw: m.raw, id: m.id, text: m.text, tokens: [] as Token[] };
      this.lexer.inline(m.text, token.tokens);
      return token;
    },
    renderer(token) {
      const t = token as unknown as { id: string; tokens: Token[] };
      if (!doc) return "";
      if (!doc.defs.has(t.id)) doc.defs.set(t.id, this.parser.parseInline(t.tokens));
      return "";
    },
  },
  {
    name: "footnoteRef",
    level: "inline",
    start(src) {
      if (!doc) return undefined;
      const at = src.indexOf("[^");
      return at < 0 ? undefined : at;
    },
    tokenizer(src) {
      if (!doc) return undefined;
      const m = new RegExp(String.raw`^\[\^(${ID})\](?!:)`).exec(src);
      if (!m) return undefined;
      return { type: "footnoteRef", raw: m[0], id: m[1] };
    },
    renderer(token) {
      const id = (token as unknown as { id: string }).id;
      if (!doc) return `[^${escapeAttr(id)}]`;
      let n = doc.order.indexOf(id) + 1;
      if (n === 0) {
        doc.order.push(id);
        n = doc.order.length;
      }
      const safe = escapeAttr(id);
      return `<sup class="md-fn-ref"><a href="#fn-${safe}" id="fnref-${safe}">${n}</a></sup>`;
    },
  },
];

marked.use({ extensions: footnoteExtensions });

function footnotesSection(state: DocState): string {
  // 被引用的按引用顺序；定义了却没引用的排在后面，免得写了的内容看不见
  const ids = [...state.order.filter((id) => state.defs.has(id))];
  for (const id of state.defs.keys()) if (!ids.includes(id)) ids.push(id);
  if (!ids.length) return "";
  const items = ids
    .map((id) => {
      const safe = escapeAttr(id);
      const back = state.order.includes(id)
        ? ` <a href="#fnref-${safe}" class="md-fn-back">↩</a>`
        : "";
      return `<li id="fn-${safe}">${state.defs.get(id)}${back}</li>`;
    })
    .join("");
  return `<div class="md-footnotes"><hr><ol>${items}</ol></div>`;
}

/** 文档正文（已拆掉 YAML 头）→ HTML（未清洗，调用方照旧过 sanitizeDocumentHtml） */
export function renderMarkdownDocument(body: string): string {
  return withDocMode(() => {
    const html = marked.parse(body, { gfm: true, breaks: false, async: false }) as string;
    return html + footnotesSection(doc!);
  });
}

/** 与 renderMarkdownDocument 同口径的块 token（双击跳源码行的映射用） */
export function lexMarkdownDocument(src: string): Token[] {
  // 无参调用：带 options 会整体替换 defaults、丢掉全局扩展（md-block-map 头注释）
  return withDocMode(() => marked.lexer(src));
}

