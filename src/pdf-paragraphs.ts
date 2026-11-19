/**
 * PDF 页 → 段落（阅读区「对照」模式的切段，2026-11-19）。纯逻辑，输入是 getTextContent 文本项换到
 * scale=1 视口坐标后的样子（左上原点），输出按 PDF 内容流顺序的段落——出版社排版的双栏论文内容流就是阅读顺序。
 *
 * 切法：文本项先并成视觉行（同一基线、上下标算同一行），再按下面任一条断段：
 * - 字号变了一成以上（标题、图注与正文分开）；
 * - 往上跳（换栏）或空出一行以上；
 * - 横向跳到别的栏；
 * - 上一行以句末标点结尾且明显没写满、或本行首行缩进。
 * 上一行没写完（不以句末标点结尾）、本行又不是大写开头时，同一句还没完：换栏、字号变了（ACS 首行放大）都接着算同一段。
 * 页眉页脚（页面最上 8% / 最下 7% 内的短行）与旋转的字（页边下载水印）不进段落。
 * 太短、不像句子的碎片（图里的轴标、图例、表格格子）记成 fragment：显示原文，不送翻译。
 */

/** 一个文本项（scale=1 视口坐标，左上原点；y 是基线离页顶的距离） */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  eol: boolean;
  /** false = 旋转 / 竖排的字（页边「Downloaded from…」水印之类），不进段落 */
  upright?: boolean;
}

/** 页内 0–1 的矩形（左上原点） */
export interface PdfFracBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PdfParagraphKind = "body" | "heading" | "fragment";

export interface PdfParagraph {
  /** 页内序号，`页:序号`（同一版式下稳定，换了切法就变——缓存认 hash 不认 id） */
  id: string;
  page: number;
  text: string;
  kind: PdfParagraphKind;
  /** 原文归一后的哈希：译文缓存的键，同一段原文永远只翻一次 */
  hash: string;
  /** 每一栏一块的外框（跨栏续写的段有两块），对照时高亮与对齐用 */
  boxes: PdfFracBox[];
}

interface Line {
  text: string;
  x0: number;
  x1: number;
  /** 基线 */
  y: number;
  h: number;
}

const LIGATURES: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
};
const INVISIBLE = /[​‌‍⁠﻿­]/g;
const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;
/** 句末：标点结尾，后面可以跟上标引用号（化学期刊常见的「….5−7」「…synthesis.25」） */
const SENTENCE_END = /[.!?:;。！？：；)）\]”"'](?:\s?\d{1,3}(?:\s?[,–−-]\s?\d{1,3})*)?$/;

function cleanText(s: string): string {
  return s.replace(INVISIBLE, "").replace(/[ﬀ-ﬄ]/g, (c) => LIGATURES[c] ?? c);
}

/** 文本项 → 视觉行：上一项行尾、或基线差超过半个字高就换行 */
export function groupLines(items: readonly PdfTextItem[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  let breakNext = false;
  for (const it of items) {
    if (it.upright === false) continue;
    const str = cleanText(it.str);
    if (!str.trim()) {
      if (it.eol) breakNext = true;
      else if (cur && str) cur.text += " ";
      continue;
    }
    const h = Math.max(it.h, 0.1);
    const sameLine =
      cur !== null &&
      !breakNext &&
      Math.abs(it.y - cur.y) <= 0.5 * Math.max(h, cur.h) &&
      it.x >= cur.x1 - 2 * Math.max(h, cur.h);
    if (cur && sameLine) {
      cur.text += str;
      cur.x0 = Math.min(cur.x0, it.x);
      cur.x1 = Math.max(cur.x1, it.x + it.w);
      // 上下标比正文矮：行高取正文（较高者），基线跟最高那项
      if (h > cur.h) {
        cur.h = h;
        cur.y = it.y;
      }
    } else {
      cur = { text: str, x0: it.x, x1: it.x + it.w, y: it.y, h };
      lines.push(cur);
    }
    breakNext = it.eol;
  }
  for (const l of lines) l.text = l.text.replace(/\s+/g, " ").trim();
  return lines.filter((l) => l.text);
}

/** 行接成段：行尾「字母-」接小写字母开头 = 断词，去掉连字符；其余连字符保留不加空格；中文与中文之间不加空格 */
export function joinLines(texts: readonly string[]): string {
  let out = "";
  for (const t of texts) {
    if (!out) {
      out = t;
      continue;
    }
    if (/\p{L}-$/u.test(out)) {
      out = /^\p{Ll}/u.test(t) ? out.slice(0, -1) + t : out + t;
    } else if (CJK.test(out[out.length - 1]) && CJK.test(t[0])) {
      out += t;
    } else {
      out += ` ${t}`;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/** 字数加权的正文字高（取出现最多字符的那档） */
function bodyHeight(lines: readonly Line[]): number {
  const tally = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.h * 2) / 2;
    tally.set(k, (tally.get(k) ?? 0) + l.text.length);
  }
  let best = 10;
  let bestN = -1;
  for (const [k, n] of tally) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/** cyrb53：53 位字符串哈希（译文缓存键，不做安全用途） */
export function textHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 缓存键用的归一：空白折叠 */
export function paragraphKey(text: string): string {
  return textHash(text.replace(/\s+/g, " ").trim());
}

/** 页眉页脚：基线在页面最上 8% 或最下 7% 以内的短行 */
function isMargin(l: Line, pageH: number): boolean {
  return (l.y < pageH * 0.08 || l.y - l.h > pageH * 0.93) && l.text.length < 120;
}

export function pageParagraphs(
  items: readonly PdfTextItem[],
  pageW: number,
  pageH: number,
  page: number,
): PdfParagraph[] {
  if (pageW <= 0 || pageH <= 0) return [];
  const lines = groupLines(items).filter((l) => !isMargin(l, pageH));
  if (lines.length === 0) return [];
  const body = bodyHeight(lines);
  type Group = { lines: Line[]; cols: Line[][] };
  const groups: Group[] = [];
  let g: Group | null = null;
  for (const l of lines) {
    if (!g) {
      g = { lines: [l], cols: [[l]] };
      groups.push(g);
      continue;
    }
    const prev = g.lines[g.lines.length - 1];
    const col = g.cols[g.cols.length - 1];
    const colX0 = Math.min(...col.map((c) => c.x0));
    // 满行宽度取整段最宽的一行（刚换到新栏、栏里只有一行时也量得出这行没写满）
    const fullW = Math.max(...g.lines.map((c) => c.x1 - c.x0));
    const h = Math.max(prev.h, l.h);
    const sizeChange = Math.abs(l.h - prev.h) > 0.1 * Math.max(l.h, prev.h);
    const dy = l.y - prev.y;
    const newColumn = dy < -0.5 * h || Math.abs(l.x0 - colX0) > Math.max(0.25 * pageW, 6 * h);
    const blank = dy > 1.75 * h;
    const prevEnded = SENTENCE_END.test(prev.text);
    const prevShort = prev.x1 - colX0 < fullW - 3 * h;
    const indent = l.x0 > colX0 + 0.8 * h && l.x0 < colX0 + 6 * h;
    // 上一行没写完、本行不是大写开头（小写、数字、括号…）：同一句还没完，字号变了（ACS 首行放大）、换栏也接着
    const continues = !prevEnded && !/^\p{Lu}/u.test(l.text);
    let split = (sizeChange && !continues) || blank || (prevEnded && (prevShort || indent));
    let switchCol = false;
    if (!split && newColumn) {
      if (continues) switchCol = true;
      else split = true;
    }
    if (split) {
      g = { lines: [l], cols: [[l]] };
      groups.push(g);
    } else {
      g.lines.push(l);
      if (switchCol) g.cols.push([l]);
      else col.push(l);
    }
  }
  return groups.map((gr, i) => {
    const text = joinLines(gr.lines.map((l) => l.text));
    // 标题看最小字号（首行放大的正文段不算标题），图里小字看最大字号
    const minH = Math.min(...gr.lines.map((l) => l.h));
    const h = Math.max(...gr.lines.map((l) => l.h));
    const words = (text.match(/\p{L}{3,}/gu) ?? []).length;
    const cjk = (text.match(new RegExp(CJK.source, "g")) ?? []).length;
    // 图里的轴标、图例：比正文小一号、短、不成句
    const figureLabel = h < body * 0.9 && text.length < 60 && !SENTENCE_END.test(text);
    const kind: PdfParagraphKind =
      minH >= body * 1.15 && text.length <= 200 && (words >= 1 || cjk >= 2)
        ? "heading"
        : text.length < 20 || (words < 3 && cjk < 6) || figureLabel
          ? "fragment"
          : "body";
    const boxes = gr.cols.map((c) => {
      const x0 = Math.min(...c.map((l) => l.x0));
      const x1 = Math.max(...c.map((l) => l.x1));
      const top = Math.min(...c.map((l) => l.y - l.h));
      const bottom = Math.max(...c.map((l) => l.y + 0.25 * l.h));
      return { x: x0 / pageW, y: Math.max(0, top / pageH), w: (x1 - x0) / pageW, h: (bottom - top) / pageH };
    });
    return { id: `${page}:${i}`, page, text, kind, hash: paragraphKey(text), boxes };
  });
}
