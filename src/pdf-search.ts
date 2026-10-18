/**
 * PDF 文本检索的纯逻辑：阅读区「查找」、标注高亮重定位、笔记里「Fig. 2」跳转共用一套归一口径。
 *
 * pdf.js 文本层每个文本项一个 span[role=presentation]（空串不出 span），行尾项后跟一个
 * br[role=presentation]。页文本按「文本项原样拼接、行尾补一个空格」组装：项与项之间不补空格
 * （同一行被拆成多项的词不能被拆开），行尾以连字符结尾且前面是字母时去掉连字符直接接下一行
 * （断词复原）。页级计数（getTextContent 的文本项）与页内高亮（textLayer DOM）走同一套组装，
 * 第 k 个命中在两边指的是同一处。
 */

/** 一个文本项：原文 + 是否行尾（getTextContent 的 hasEOL；DOM 侧 = 后面紧跟 br） */
export interface PdfTextPiece {
  text: string;
  eol: boolean;
}

/** 归一后的页文本。text 已小写、空白折叠；piece/start/end 是每个字符的来源：
 *  第几个文本项、在该项原文里的 UTF-16 起止下标。行尾补的空格 piece = -1 */
export interface PdfSearchStream {
  text: string;
  piece: number[];
  start: number[];
  end: number[];
}

const INVISIBLE = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/;
const SPACE = /\s/;
const LETTER = /\p{L}/u;

/** 单字符归一：大小写不敏感；弯引号、各式短横线归到键盘字符（输入 ' " - 能命中排版字符） */
function foldChar(ch: string): string {
  switch (ch) {
    case "\u2018":
    case "\u2019":
    case "\u2032":
      return "'";
    case "\u201C":
    case "\u201D":
    case "\u2033":
      return '"';
    case "\u2010":
    case "\u2011":
    case "\u2012":
    case "\u2013":
    case "\u2014":
    case "\u2212":
      return "-";
    case "\uFB00":
      return "ff";
    case "\uFB01":
      return "fi";
    case "\uFB02":
      return "fl";
    case "\uFB03":
      return "ffi";
    case "\uFB04":
      return "ffl";
    default: {
      const lower = ch.toLowerCase();
      return lower.length === 1 ? lower : ch;
    }
  }
}

/** 行尾断词用的连字符（不含 en/em dash：「1–\n5」是范围，不能并成 15） */
function isBreakHyphen(ch: string): boolean {
  return ch === "-" || ch === "\u2010";
}

/** 文本项序列 → 归一页文本（见文件头口径） */
export function buildSearchStream(pieces: readonly PdfTextPiece[]): PdfSearchStream {
  const chars: string[] = [];
  const piece: number[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let lastSpace = true; // 开头不补空格
  let lastHyphen = false; // 最后落下的字符是断词连字符
  const push = (c: string, p: number, s: number, e: number) => {
    // 连字（ﬁ 等）展开成多个字符时共用同一段来源
    for (const x of c) {
      chars.push(x);
      piece.push(p);
      start.push(s);
      end.push(e);
    }
  };
  pieces.forEach((pc, p) => {
    let i = 0;
    for (const ch of pc.text) {
      const at = i;
      i += ch.length;
      if (INVISIBLE.test(ch)) continue;
      if (SPACE.test(ch)) {
        if (!lastSpace) push(" ", p, at, i);
        lastSpace = true;
        lastHyphen = false;
        continue;
      }
      push(foldChar(ch), p, at, i);
      lastSpace = false;
      lastHyphen = isBreakHyphen(ch);
    }
    if (!pc.eol) return;
    const n = chars.length;
    if (lastHyphen && n >= 2 && LETTER.test(chars[n - 2])) {
      // 断词：去掉行尾连字符，下一行直接接上
      chars.pop();
      piece.pop();
      start.pop();
      end.pop();
      lastSpace = false;
      lastHyphen = false;
      return;
    }
    if (!lastSpace) {
      chars.push(" ");
      piece.push(-1);
      start.push(0);
      end.push(0);
      lastSpace = true;
    }
    lastHyphen = false;
  });
  return { text: chars.join(""), piece, start, end };
}

/** 查询词 / 选段原文 → 与页文本同口径的归一串（换行按行尾处理：选段跨行的断词同样复原） */
export function normalizeSearchQuery(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const pieces = lines.map((text, i) => ({ text, eol: i < lines.length - 1 }));
  return buildSearchStream(pieces).text.trim();
}

/** 在归一文本里找全部命中（不重叠，返回起点下标） */
export function findAllIn(text: string, query: string): number[] {
  if (!query) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(query, from);
    if (i < 0) break;
    out.push(i);
    from = i + query.length;
  }
  return out;
}

export function findAllInStream(stream: PdfSearchStream, query: string): number[] {
  return findAllIn(stream.text, query);
}

/** 一处命中落到文本项上的若干段（每段 = 某个文本项原文里的 [from, to)；行尾补的空格不算） */
export interface PdfMatchSegment {
  piece: number;
  from: number;
  to: number;
}

export function matchSegments(
  stream: PdfSearchStream,
  at: number,
  length: number,
): PdfMatchSegment[] {
  const out: PdfMatchSegment[] = [];
  for (let i = at; i < at + length && i < stream.text.length; i++) {
    const p = stream.piece[i];
    if (p < 0) continue;
    const last = out[out.length - 1];
    if (last && last.piece === p) {
      last.from = Math.min(last.from, stream.start[i]);
      last.to = Math.max(last.to, stream.end[i]);
    } else {
      out.push({ piece: p, from: stream.start[i], to: stream.end[i] });
    }
  }
  return out;
}

/** 高亮矩形（页内百分比坐标） */
export interface PdfMarkRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 同一行的碎矩形并成一条：WebKit 的 range.getClientRects() 对一个文本片会同时给出边框盒
 *  与字形盒，跨 span 的命中也会一片一个盒——垂直重叠过半且横向相接（容差 = 行高的 0.6）
 *  的合并为外包矩形，免得半透明高亮叠出深浅不一的块 */
export function mergeLineRects(rects: readonly PdfMarkRect[]): PdfMarkRect[] {
  const sorted = rects
    .filter((r) => r.w > 0 && r.h > 0)
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const out: PdfMarkRect[] = [];
  for (const r of sorted) {
    const hit = out.find((o) => {
      const overlapY = Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y);
      if (overlapY < Math.min(o.h, r.h) * 0.5) return false;
      const gap = Math.max(o.x, r.x) - Math.min(o.x + o.w, r.x + r.w);
      return gap <= Math.min(o.h, r.h) * 0.6;
    });
    if (!hit) {
      out.push({ ...r });
      continue;
    }
    const x = Math.min(hit.x, r.x);
    const y = Math.min(hit.y, r.y);
    hit.w = Math.max(hit.x + hit.w, r.x + r.w) - x;
    hit.h = Math.max(hit.y + hit.h, r.y + r.h) - y;
    hit.x = x;
    hit.y = y;
  }
  return out;
}

/** 一页的命中计数用的页文本（getTextContent 文本项直接组装） */
export function pageSearchText(
  items: readonly { str?: string; hasEOL?: boolean }[],
): string {
  return buildSearchStream(
    items
      .filter((it) => typeof it.str === "string")
      .map((it) => ({ text: it.str ?? "", eol: Boolean(it.hasEOL) })),
  ).text;
}

/** 一页的行（图注定位用：图注编号在行首）。行 = 行尾之间的文本项拼接后归一 */
export function pageSearchLines(
  items: readonly { str?: string; hasEOL?: boolean }[],
): string[] {
  const lines: string[] = [];
  let cur: PdfTextPiece[] = [];
  const flush = () => {
    const t = buildSearchStream(cur).text.trim();
    if (t) lines.push(t);
    cur = [];
  };
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    cur.push({ text: it.str, eol: false });
    if (it.hasEOL) flush();
  }
  flush();
  return lines;
}

export type PdfFigureKind = "figure" | "table";

function figurePrefix(kind: PdfFigureKind): string {
  return kind === "figure" ? "(?:fig(?:ure)?s?\\.?|图)" : "(?:tables?|tab\\.|表)";
}

/** 图表定位：先找图注（编号在行首，如「Fig. 2. Cycling…」「Table 1 |」），再找第一次被提到的页。
 *  label 是编号（「2」「2a」「IV」）；子图字母只按主编号定位。返回页号与可在该页重定位的一段原文
 *  （图注取行首 60 字——同页正文里也提到「Fig. 2」时不会高亮错地方） */
export function locateFigure(
  pages: readonly (readonly string[])[],
  kind: PdfFigureKind,
  label: string,
): { page: number; quote: string } | null {
  const num = label.trim().toLowerCase().replace(/^(\d+)[a-z]$/, "$1");
  if (!num) return null;
  const esc = num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^${figurePrefix(kind)}\\s?${esc}(?![0-9a-z])`);
  const any = new RegExp(`${figurePrefix(kind)}\\s?${esc}(?![0-9])`);
  for (let p = 0; p < pages.length; p++) {
    for (const line of pages[p]) {
      if (head.test(line)) return { page: p + 1, quote: line.slice(0, 60).trim() };
    }
  }
  for (let p = 0; p < pages.length; p++) {
    for (const line of pages[p]) {
      const m = any.exec(line);
      if (m) return { page: p + 1, quote: m[0] };
    }
  }
  return null;
}

/** 目录条目（pdf.js getOutline 的树拍平：depth 0 起，dest 原样留给跳转时解析） */
export interface PdfOutlineEntry {
  title: string;
  depth: number;
  dest: unknown;
}

interface RawOutlineNode {
  title?: string;
  dest?: unknown;
  items?: readonly RawOutlineNode[];
}

/** 目录树拍平：最多三层、300 条（期刊 PDF 偶有把每个参考文献都做成书签的），空标题跳过 */
export function flattenPdfOutline(
  nodes: readonly RawOutlineNode[] | null | undefined,
  maxDepth = 3,
  maxItems = 300,
): PdfOutlineEntry[] {
  const out: PdfOutlineEntry[] = [];
  const walk = (list: readonly RawOutlineNode[], depth: number) => {
    for (const n of list) {
      if (out.length >= maxItems) return;
      const title = (n.title ?? "").replace(/\s+/g, " ").trim();
      if (title && n.dest != null) out.push({ title, depth, dest: n.dest });
      if (n.items?.length && depth + 1 < maxDepth) walk(n.items, depth + 1);
    }
  };
  walk(nodes ?? [], 0);
  return out;
}

/** 显式目标里的落点高度（PDF 坐标，原点在页底）：XYZ 取第 4 项、FitH/FitBH 取第 3 项、FitR 取上边；
 *  其余（Fit/FitB/FitV）没有高度，返回 null = 跳到页首 */
export function pdfDestTop(explicit: readonly unknown[]): number | null {
  const kind = (explicit[1] as { name?: string } | null | undefined)?.name;
  const v =
    kind === "XYZ"
      ? explicit[3]
      : kind === "FitH" || kind === "FitBH"
        ? explicit[2]
        : kind === "FitR"
          ? explicit[5]
          : null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 摘句在页内重定位的候选写法，依次试：原样 → 去掉词内连字符（摘句保留了行尾断开处的连字符，
 *  页文本按断词复原成一个词）→ 两者各取前 60 字（跨页摘句只找得到本页这一截）。
 *  查找（exact）只用原样：第 k 处要与页级计数对齐 */
export function quoteSearchCandidates(raw: string, exact = false): string[] {
  const q = normalizeSearchQuery(raw);
  if (!q) return [];
  if (exact) return [q];
  const joined = q.replace(/(\p{L})-(?=\p{L})/gu, "$1");
  const out = [q, joined, q.slice(0, 60).trim(), joined.slice(0, 60).trim()];
  return [...new Set(out.filter(Boolean))];
}
