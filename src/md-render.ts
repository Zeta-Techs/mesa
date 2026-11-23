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

// ---------- 脚注与 Pandoc / Quarto 学术文档排版 ----------

interface DocState {
  /** 首次被引用的顺序 → 编号 */
  order: string[];
  defs: Map<string, string>;
  /** Quarto 章节 {#sec-id} → 自动层级编号（如 "1"、"2.1"） */
  sections: Map<string, string>;
  /** Quarto 图 {#fig-id} → 图号（如 "1"） */
  figures: Map<string, string>;
  /** Quarto 表题 {#tbl-id} → 表号（如 "1"） */
  tables: Map<string, string>;
}

let doc: DocState | null = null;

/** 在文档模式下跑 fn（脚注与 Pandoc/Quarto 扩展只在这里生效）；可嵌套，内层沿用外层状态 */
export function withDocMode<T>(fn: () => T): T {
  if (doc) return fn();
  doc = {
    order: [],
    defs: new Map(),
    sections: new Map(),
    figures: new Map(),
    tables: new Map(),
  };
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

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapePandocScript(s: string): string {
  return s.replace(/\\([*~^ \\])/g, "$1");
}

function findUnescapedChar(src: string, ch: string): number | undefined {
  for (let i = 0; i < src.length; i++) {
    if (src[i] === ch && (i === 0 || src[i - 1] !== "\\")) return i;
  }
  return undefined;
}

const PANDOC_ATTR_TAIL_RE = /[ \t]*\{([^{}\n]+)\}[ \t]*$/;

export interface PandocAttrs {
  hasAttrs: boolean;
  clean: string;
  id: string | null;
  unnumbered: boolean;
}

/** 解析标题、表题或图块末尾的 Pandoc/Quarto 属性块（如 `{#sec-intro .unnumbered}`、`{#tbl-1}`） */
export function parsePandocAttrs(text: string): PandocAttrs {
  const m = PANDOC_ATTR_TAIL_RE.exec(text);
  if (!m) {
    return { hasAttrs: false, clean: text, id: null, unnumbered: false };
  }
  const tokens = m[1]!.trim().split(/\s+/).filter(Boolean);
  // 至少含一个 #id、.class、- 或 key=val，避免误吞普通花括号（如数学集合 `{1, 2, 3}`）
  const looksLikeAttr =
    tokens.length > 0 &&
    tokens.some((tok) => tok === "-" || /^[#.][A-Za-z0-9_:-]+$/.test(tok)) &&
    tokens.every(
      (tok) =>
        tok === "-" ||
        /^[#.][A-Za-z0-9_:-]+$/.test(tok) ||
        /^[A-Za-z0-9_:-]+=(?:"[^"]*"|'[^']*'|[^\s}]+)$/.test(tok),
    );
  if (!looksLikeAttr) {
    return { hasAttrs: false, clean: text, id: null, unnumbered: false };
  }
  const idTok = tokens.find((tok) => tok.startsWith("#") && tok.length > 1);
  const unnumbered = tokens.includes("-") || tokens.includes(".unnumbered");
  return {
    hasAttrs: true,
    clean: text.slice(0, m.index).trimEnd(),
    id: idTok ? idTok.slice(1) : null,
    unnumbered,
  };
}

/** 预扫描 Quarto 章节/图表锚点编号（供前向 `@sec-xxx` / `@fig-N` / `@tbl-N` 交叉引用与章节号使用） */
function populateDocTargets(state: DocState, src: string): void {
  if (state.sections.size > 0 || state.figures.size > 0 || state.tables.size > 0) return;
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const numbers = [0, 0, 0, 0, 0, 0];
  let figNo = 0;
  let tblNo = 0;
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of lines) {
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fm) {
      const ch = fm[1]![0]!;
      const len = fm[1]!.length;
      if (!fenceChar) {
        fenceChar = ch;
        fenceLen = len;
      } else if (ch === fenceChar && len >= fenceLen && /^ {0,3}[`~]+[ \t]*$/.test(line)) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }
    if (fenceChar) continue;

    const hm = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (hm) {
      const level = hm[1]!.length;
      const attr = parsePandocAttrs(hm[2]!);
      if (attr.hasAttrs && !attr.unnumbered && attr.id && /^sec-/i.test(attr.id)) {
        numbers[level - 1]! += 1;
        for (let d = level; d < 6; d++) numbers[d] = 0;
        const secNo = numbers
          .slice(0, level)
          .filter((n) => n > 0)
          .join(".");
        if (secNo && !state.sections.has(attr.id)) {
          state.sections.set(attr.id, secNo);
        }
      }
      continue;
    }

    if (/^ {0,3}:[ \t]+/.test(line)) {
      const attr = parsePandocAttrs(line);
      if (attr.hasAttrs && attr.id && /^tbl-/i.test(attr.id)) {
        tblNo += 1;
        const explicit = /^tbl-(\d+[A-Za-z]?)$/i.exec(attr.id)?.[1];
        if (!state.tables.has(attr.id)) {
          state.tables.set(attr.id, explicit ?? String(tblNo));
        }
      }
      continue;
    }

    if (line.includes("![")) {
      for (const m of line.matchAll(/\{[^{}\n]*#(fig-[A-Za-z0-9_:-]+)[^{}\n]*\}/g)) {
        const figId = m[1]!;
        figNo += 1;
        const explicit = /^fig-(\d+[A-Za-z]?)$/i.exec(figId)?.[1];
        if (!state.figures.has(figId)) {
          state.figures.set(figId, explicit ?? String(figNo));
        }
      }
    }
  }
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

const PANDOC_SUB_RE = /^~(?!~|\/)((?:[^\s~\\]|\\[*~^ \\])+?)~(?!~)/;
const PANDOC_SUP_RE = /^\^(?!\^)((?:[^\s^\\[\]]|\\[*~^ \\])+?)\^(?!\^)/;
const QUARTO_FIG_PARA_RE =
  /^!\[([\s\S]*)\]\(([^()\s]+)(?:[ \t]+"([^"]*)")?\)(?:[ \t]*(\{[^{}\n]+\}))?[ \t]*$/;

const docExtensions: TokenizerAndRendererExtension[] = [
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
    name: "quartoFenceDiv",
    level: "block",
    start(src) {
      if (!doc) return undefined;
      const m = /^ {0,3}:{3,}(?:[ \t]*\{[^{}\n]*\})?[ \t]*(?=\n|$)/m.exec(src);
      return m?.index;
    },
    tokenizer(src) {
      if (!doc) return undefined;
      const m = /^ {0,3}:{3,}(?:[ \t]*\{[^{}\n]*\})?[ \t]*(?:\n|$)/.exec(src);
      if (!m) return undefined;
      return { type: "quartoFenceDiv", raw: m[0] };
    },
    renderer() {
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
  {
    name: "pandocSub",
    level: "inline",
    start(src) {
      if (!doc) return undefined;
      return findUnescapedChar(src, "~");
    },
    tokenizer(src) {
      if (!doc) return undefined;
      const m = PANDOC_SUB_RE.exec(src);
      if (!m) return undefined;
      return { type: "pandocSub", raw: m[0], text: unescapePandocScript(m[1]!) };
    },
    renderer(token) {
      const text = (token as unknown as { text: string }).text;
      return `<sub>${escapeHtmlText(text)}</sub>`;
    },
  },
  {
    name: "pandocSup",
    level: "inline",
    start(src) {
      if (!doc) return undefined;
      return findUnescapedChar(src, "^");
    },
    tokenizer(src) {
      if (!doc) return undefined;
      const m = PANDOC_SUP_RE.exec(src);
      if (!m) return undefined;
      return { type: "pandocSup", raw: m[0], text: unescapePandocScript(m[1]!) };
    },
    renderer(token) {
      const text = (token as unknown as { text: string }).text;
      return `<sup>${escapeHtmlText(text)}</sup>`;
    },
  },
  {
    name: "quartoXref",
    level: "inline",
    start(src) {
      if (!doc) return undefined;
      const m = /(?<![A-Za-z0-9_.\\])@(?:fig|tbl|sec|eq|lst)-[A-Za-z0-9_:-]+/i.exec(src);
      return m?.index;
    },
    tokenizer(src, tokens) {
      if (!doc) return undefined;
      const prev = tokens[tokens.length - 1];
      if (
        prev &&
        "raw" in prev &&
        typeof prev.raw === "string" &&
        /[A-Za-z0-9_.\\]$/.test(prev.raw)
      ) {
        return undefined;
      }
      const m = /^@((fig|tbl|sec|eq|lst)-[A-Za-z0-9_:-]+?)(?=[.,;:!?)}\]\s–—/]|$)/i.exec(src);
      if (!m) return undefined;
      const prevText =
        prev && "text" in prev && typeof prev.text === "string" ? prev.text : "";
      const bareNumber =
        /(?:^|[\s([–—])(?:Sections?|Secs?\.|Figures?|Figs?\.|Tables?|Tabs?\.|Equations?|Eqs?\.|Listings?|§+|图|表|第)[ \t]*$/i.test(
          prevText,
        );
      return {
        type: "quartoXref",
        raw: m[0],
        targetId: m[1]!,
        kind: m[2]!.toLowerCase(),
        bareNumber,
      };
    },
    renderer(token) {
      const { targetId, kind, bareNumber } = token as unknown as {
        targetId: string;
        kind: string;
        bareNumber: boolean;
      };
      let label: string;
      if (kind === "sec") {
        const num =
          doc?.sections.get(targetId) ??
          (/^sec-(\d+(?:[.-]\d+)*)$/i.exec(targetId)?.[1]?.replace(/-/g, ".") ??
            targetId.replace(/^sec-/i, ""));
        label = bareNumber ? num : /^\d/.test(num) ? `Section ${num}` : `§${num}`;
      } else if (kind === "fig") {
        const num =
          doc?.figures.get(targetId) ??
          (/^fig-(\d+[A-Za-z]?)$/i.exec(targetId)?.[1] ?? targetId.replace(/^fig-/i, ""));
        label = bareNumber ? num : `Figure ${num}`;
      } else if (kind === "tbl") {
        const num =
          doc?.tables.get(targetId) ??
          (/^tbl-(\d+[A-Za-z]?)$/i.exec(targetId)?.[1] ?? targetId.replace(/^tbl-/i, ""));
        label = bareNumber ? num : `Table ${num}`;
      } else if (kind === "eq") {
        const num =
          /^eq-(\d+[A-Za-z]?)$/i.exec(targetId)?.[1] ?? targetId.replace(/^eq-/i, "");
        label = bareNumber ? num : `Eq. ${num}`;
      } else {
        const num = targetId.replace(/^lst-/i, "");
        label = bareNumber ? num : `Listing ${num}`;
      }
      return `<a href="#${escapeAttr(targetId)}" class="md-xref">${escapeHtmlText(label)}</a>`;
    },
  },
];

marked.use({
  extensions: docExtensions,
  tokenizer: {
    del(src) {
      // 文档模式下单波浪号 ~...~ 留给 Pandoc 下标与近似号 ~10，删除线只认双波浪号 ~~...~~
      if (doc && !src.startsWith("~~")) return undefined;
      return false;
    },
  },
  renderer: {
    heading({ depth, text }) {
      if (!doc) return false;
      const attr = parsePandocAttrs(text);
      if (!attr.hasAttrs) return false;
      const inlineTokens = marked.Lexer.lexInline(attr.clean, this.options);
      const innerHtml = this.parser.parseInline(inlineTokens);
      const idAttr = attr.id ? ` id="${escapeAttr(attr.id)}"` : "";
      const secNum =
        attr.id && !attr.unnumbered && !/^\d+[.)\s]/.test(attr.clean)
          ? doc.sections.get(attr.id)
          : undefined;
      const numAttr = secNum ? ` data-sec-num="${escapeAttr(secNum)}"` : "";
      return `<h${depth}${idAttr}${numAttr}>${innerHtml}</h${depth}>\n`;
    },
    paragraph({ text }) {
      if (!doc) return false;
      const trimmed = text.trim();
      // 1. Quarto 管道表表题：`: 表题正文 {#tbl-1}`
      const capMatch = /^:[ \t]+([\s\S]+)$/.exec(trimmed);
      if (capMatch) {
        const attr = parsePandocAttrs(capMatch[1]!);
        const cleanCap = attr.hasAttrs ? attr.clean : capMatch[1]!;
        const id = attr.id;
        const idAttr = id ? ` id="${escapeAttr(id)}"` : "";
        let labelHtml = "";
        if (id && /^tbl-/i.test(id) && !/^(?:Tables?|Tabs?\.|表)\s*\d/i.test(cleanCap)) {
          const num =
            doc.tables.get(id) ??
            (/^tbl-(\d+[A-Za-z]?)$/i.exec(id)?.[1] ?? id.replace(/^tbl-/i, ""));
          labelHtml = `<span class="md-caption-label">Table ${escapeHtmlText(num)}.</span> `;
        }
        const capTokens = marked.Lexer.lexInline(cleanCap, this.options);
        const capHtml = this.parser.parseInline(capTokens);
        return `<p class="md-table-caption"${idAttr}>${labelHtml}${capHtml}</p>\n`;
      }
      // 2. Quarto 独立图块：`![图注（可含 [@cite] / [FTIR] / 上下标）](path){#fig-1 out-width="100%"}`
      const figMatch = QUARTO_FIG_PARA_RE.exec(trimmed);
      if (figMatch) {
        const rawCaption = figMatch[1]!.trim();
        const href = figMatch[2]!;
        const title = figMatch[3];
        const rawAttr = figMatch[4];
        const attr = rawAttr
          ? parsePandocAttrs(rawAttr)
          : { hasAttrs: false, clean: "", id: null, unnumbered: false };
        const hasNestedBrackets = /[\[\]]/.test(rawCaption);
        if (attr.hasAttrs || hasNestedBrackets) {
          const id = attr.id;
          const idAttr = id ? ` id="${escapeAttr(id)}"` : "";
          const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
          const plainAlt = rawCaption
            .replace(/\\([@|*~^[\]()])/g, "$1")
            .replace(/[~^]/g, "");
          let captionBlock = "";
          if (rawCaption && (attr.hasAttrs || hasNestedBrackets)) {
            let labelHtml = "";
            if (id && /^fig-/i.test(id) && !/^(?:Figures?|Figs?\.|图)\s*\d/i.test(rawCaption)) {
              const num =
                doc.figures.get(id) ??
                (/^fig-(\d+[A-Za-z]?)$/i.exec(id)?.[1] ?? id.replace(/^fig-/i, ""));
              labelHtml = `<span class="md-caption-label">Figure ${escapeHtmlText(num)}.</span> `;
            }
            const capTokens = marked.Lexer.lexInline(rawCaption, this.options);
            const capHtml = this.parser.parseInline(capTokens);
            captionBlock = `<span class="md-fig-caption">${labelHtml}${capHtml}</span>`;
          }
          return `<p class="md-figure"${idAttr}><img src="${escapeAttr(href)}" alt="${escapeAttr(plainAlt)}"${titleAttr}>${captionBlock}</p>\n`;
        }
      }
      return false;
    },
  },
});

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
    populateDocTargets(doc!, body);
    const html = marked.parse(body, { gfm: true, breaks: false, async: false }) as string;
    return html + footnotesSection(doc!);
  });
}

/** 与 renderMarkdownDocument 同口径的块 token（双击跳源码行的映射用） */
export function lexMarkdownDocument(src: string): Token[] {
  // 无参调用：带 options 会整体替换 defaults、丢掉全局扩展（md-block-map 头注释）
  return withDocMode(() => {
    populateDocTargets(doc!, src);
    return marked.lexer(src);
  });
}

