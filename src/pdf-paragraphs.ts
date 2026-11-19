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
 *
 * 整篇再过一遍（documentParagraphs，2026-11-19 用户：参考文献不用翻）：
 * - 作者单位、通讯作者、邮箱、期刊页眉、DOI / 收稿日期 / 版权这类题录记 meta，参考文献标题起往后记 reference，都不翻不列；
 * - 上一页最后一段没写完、下一页开头接着小写往下写的（双栏论文几乎每页都这样断），并成一段放在上一页，
 *   下一页那截记 continued（of 指回去），译文只出一份。
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

export type PdfParagraphKind = "body" | "heading" | "fragment" | "meta" | "reference" | "continued";

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
  /** 续到后面几页的那几截的外框（documentParagraphs 跨页并段后才有） */
  tail?: { page: number; boxes: PdfFracBox[] }[];
  /** kind = continued：并进了哪一段（id） */
  of?: string;
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
    // 正文字号加粗的编号小节标题（「3.2. Electrocatalytic activity analysis」）字号认不出，按编号认
    const numbered = text.length <= 100 && /^\d+(?:\.\d+)*\.?\s+\p{Lu}/u.test(text) && !SENTENCE_END.test(text) && words >= 1;
    const kind: PdfParagraphKind =
      (minH >= body * 1.15 && text.length <= 200 && (words >= 1 || cjk >= 2)) || numbered
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

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const META_PHRASE =
  /corresponding authors?|contents lists available|journal homepage|article history|cite this:|how to cite:|all rights reserved|creative commons|metrics & more|article recommendations|©|^\s*(?:read online|www[.:]|https?:\/\/|doi:)/i;
const META_DATE = /\b(?:received|accepted|revised|available online|published(?: online)?)\b[^.]{0,80}\b(?:19|20)\d{2}\b/i;
const AFFILIATION = /\b(?:Universit|Institut|College|School of|Laborator|Department|Academy|Centre|Center for|Co\., Ltd)/;
const CAPTION = /^(?:Fig\.?|Figure|Table|Scheme|图|表)\s*S?\d/i;
/** 作者信息、补充材料这类小节：标题到下一个标题之间整块是题录（ACS 的「■ AUTHOR INFORMATION」） */
const META_SECTION = /^(?:author information|associated content|author contributions)\b/i;
/** 一条参考文献的样子：[12] / (12) / 12 / 12. 开头，接「S. Sharma」或「Edwards, P. P.」，后面有年份。
 *  没有「References」标题的排版（Wiley、RSC）靠连着两段都长这样认出参考文献开始 */
const REF_ENTRY =
  /^(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}\.?)\s+(?:a\)\s*)?(?:\p{Lu}\.\s?(?:-?\p{Lu}\.\s?)*\p{Lu}[\p{L}'-]+|\p{Lu}[\p{L}'-]+,\s*\p{Lu}\.).*\b(?:19|20)\d{2}\b/su;
/** 参考文献标题：单独一行，或后面直接跟第一条（[1] / (1) / 1. / 姓, 名缩写.） */
const REF_HEAD = /^(?:\d+\.?\s*)?(?:references(?: and notes)?|bibliography|literature cited|参考文献)(?:\s*$|\s+(?:\[1\]|\(1\)|1\.\s|\p{Lu}[\p{L}'-]+,\s*\p{Lu}\.))/iu;

/** 题录类的段（不值得读译文）：邮箱、通讯作者、期刊页眉、DOI / 收稿日期 / 版权；第 1 页的作者名单与单位块 */
export function isFrontMatter(text: string, page: number): boolean {
  if (text.length > 600) return false;
  if (EMAIL.test(text) || META_PHRASE.test(text) || META_DATE.test(text)) return true;
  if (page !== 1) return false;
  const words = text.match(/\p{L}+/gu) ?? [];
  const commas = (text.match(/,/g) ?? []).length;
  if (words.length < 4) return false;
  // 单位块：逗号密、带单位名，或「Dr. / Prof.」打头列人名
  if (AFFILIATION.test(text) && (commas / words.length >= 0.15 || /\b(?:Dr|Prof)\.\s/.test(text))) return true;
  // 作者名单：逗号密、几乎全是大写开头的词（只夹着 and）
  const lower = words.filter((w) => /^\p{Ll}/u.test(w) && w !== "and").length;
  return commas >= 3 && commas / words.length >= 0.2 && lower / words.length <= 0.1;
}

/** 参考文献标题（去掉 ACS「■」这类前缀符号后比） */
export function isReferenceHeading(text: string): boolean {
  const t = text
    .replace(/^[^\p{L}\d]+/u, "")
    // 字距拉开的标题（「REFER ENCES」）先并回去
    .replace(/^(?:\p{Lu}\s?){5,20}/u, (m) => m.replace(/(\p{Lu})\s(?=\p{Lu})/gu, "$1"));
  return REF_HEAD.test(t);
}

/** 段中间起头的一条（「Soc. 2009, 131, 1862. [2] Y. Liu, …」，按行切出来的参考文献常这样） */
const INLINE_REF = /\[\d{1,3}\]\s+(?:a\)\s*)?\p{Lu}\.\s?(?:-?\p{Lu}\.\s?)*\p{Lu}[\p{L}'-]+.*\b(?:19|20)\d{2}\b/su;

/** 像不像一条参考文献（开头就是一条，或中间起头一条） */
export function looksLikeReference(text: string): boolean {
  return REF_ENTRY.test(text) || INLINE_REF.test(text);
}

/**
 * 整篇的第二遍：题录记 meta、参考文献起往后记 reference、跨页没写完的段并进上一页。输入是逐页 pageParagraphs 的结果
 * （可以只读了前几页，读多少过多少），不改输入。参考文献标题只认后 60% 的页，免得正文里提一句 References 把后面全吞了。
 */
export function documentParagraphs(
  raw: ReadonlyMap<number, readonly PdfParagraph[]>,
  pageCount: number,
): Map<number, PdfParagraph[]> {
  const out = new Map<number, PdfParagraph[]>();
  const sorted = [...raw.keys()].sort((a, b) => a - b);
  const refFrom = Math.max(2, Math.ceil(pageCount * 0.4));
  // 参考文献从哪段开始：「References」标题（单独一行常被记成碎片，也认）；没有标题时，一段像参考文献、
  // 后面三段正文里还有一段也像（Angewandte 一条拆成好几行），再往回带上紧挨着的「[1]」这类编号段
  const flat = sorted.flatMap((n) => raw.get(n) ?? []);
  const text = flat.filter((p) => p.kind !== "fragment");
  let refStart = flat.find((p) => p.page >= refFrom && isReferenceHeading(p.text));
  if (!refStart) {
    let i = text.findIndex(
      (p, k) => p.page >= refFrom && looksLikeReference(p.text) && text.slice(k + 1, k + 4).some((q) => looksLikeReference(q.text)),
    );
    // 往回带：编号开头的、中间起头一条的、带「年, 卷, 页」尾巴的（一条拆成几行时的续行）
    const refLike = (t: string) =>
      looksLikeReference(t) || /^(?:\[\d{1,3}\]|\(\d{1,3}\))\s/.test(t) || /\b(?:19|20)\d{2}\s*,\s*\d{1,4}\s*,\s*\d/.test(t);
    while (i > 0 && text[i - 1].page >= refFrom && refLike(text[i - 1].text)) i--;
    refStart = text[i];
  }
  let inRefs = false;
  let inMetaSection = false;
  for (const n of sorted) {
    out.set(
      n,
      (raw.get(n) ?? []).map((p) => {
        if (p === refStart) inRefs = true;
        if (inRefs) return { ...p, kind: "reference" as const };
        if (p.kind === "heading") inMetaSection = META_SECTION.test(p.text.replace(/^[^\p{L}\d]+/u, ""));
        if ((inMetaSection && !CAPTION.test(p.text)) || (p.kind !== "fragment" && isFrontMatter(p.text, n))) {
          return { ...p, kind: "meta" as const };
        }
        return { ...p };
      }),
    );
  }
  // 跨页并段：上一页最后一段正文没写完，下一页前三段正文里第一段不是大写开头的接上（同页内接续的口径；遇到标题就不找了）
  const byId = new Map<string, PdfParagraph>();
  for (const paras of out.values()) for (const p of paras) byId.set(p.id, p);
  for (const n of sorted) {
    const next = out.get(n + 1);
    if (!next) continue;
    const here = out.get(n) ?? [];
    // 页底常压着图注 / 表注：跳过它们找正文最后一段
    const last = [...here].reverse().find((p) => (p.kind === "body" && !CAPTION.test(p.text)) || p.kind === "continued");
    if (!last) continue;
    const root = last.kind === "continued" && last.of ? byId.get(last.of) : last;
    if (!root || SENTENCE_END.test(last.text)) continue;
    let tries = 0;
    for (const q of next) {
      if (q.kind === "heading" || q.kind === "reference" || tries >= 3) break;
      if (q.kind !== "body") continue;
      tries++;
      if (/^\p{Lu}/u.test(q.text)) continue;
      root.text = joinLines([root.text, q.text]);
      root.hash = paragraphKey(root.text);
      root.tail = [...(root.tail ?? []), { page: q.page, boxes: q.boxes }];
      q.kind = "continued";
      q.of = root.id;
      break;
    }
  }
  return out;
}
