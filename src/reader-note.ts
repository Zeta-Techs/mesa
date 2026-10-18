/**
 * 沉浸阅读区「笔记 ↔ PDF」的纯逻辑：笔记「## 标注」小节的格式契约（与 reader.rs 双端镜像，改动需同步）、
 * 新笔记是否还空着（「让 AI 起草」入口的显隐）、笔记正文里的页码/图表引用识别（点击跳 PDF）。
 */

/** 机管小节名：高亮与批注都记在这里（一行一条，见 formatNoteAnnotation） */
export const NOTE_ANNOT_SECTION = "标注";

/** 精读八小节（lit-notes 技能口径；新笔记模板同序） */
export const NOTE_DRAFT_SECTIONS = [
  "一句话总结",
  "研究问题",
  "方法",
  "主要结果",
  "局限",
  "可引用点",
  "与本课题的关系",
  "疑问与待跟进",
] as const;

/** 摘句上限（字符）：选一整页进来也只记开头，重定位靠前半段足够唯一 */
export const NOTE_ANNOT_QUOTE_MAX = 500;

export interface NoteAnnotation {
  page: number;
  /** 归一后的原文摘句（见 normalizeAnnotationQuote） */
  quote: string;
  /** 批注（纯高亮为空串） */
  comment: string;
  /** 在笔记里的行号（1 起） */
  line: number;
}

/** 选段原文 → 落盘摘句：行尾「字母-换行」接回同一行（连字符保留：断词还是复合词分不清，
 *  留着照原样读；页内重定位另试去掉连字符的写法）、空白折成单空格、「」换成“”（行格式靠「」定界）、
 *  截到上限。与 reader.rs annotation_quote 同口径 */
export function normalizeAnnotationQuote(raw: string): string {
  const joined = raw
    .replace(/(\p{L})-\r?\n\s*/gu, "$1-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/「/g, "“")
    .replace(/」/g, "”");
  const chars = Array.from(joined);
  return chars.length > NOTE_ANNOT_QUOTE_MAX
    ? chars.slice(0, NOTE_ANNOT_QUOTE_MAX).join("")
    : joined;
}

/** 一条标注的行格式：`- p.3 「摘句」` 或 `- p.3 「摘句」 —— 批注`（批注里的换行折成空格） */
export function formatNoteAnnotation(page: number, quote: string, comment = ""): string {
  const c = comment.replace(/\s+/g, " ").trim();
  return `- p.${page} 「${normalizeAnnotationQuote(quote)}」${c ? ` —— ${c}` : ""}`;
}

const ANNOT_LINE = /^\s*[-*]\s+p\.?\s*(\d{1,5})\s*「(.+?)」(?=\s*(?:——|$))(?:\s*——\s*(.*))?\s*$/;

/** 读「## 标注」小节里的条目（小节外的同形行不算；坏行跳过） */
export function parseNoteAnnotations(text: string): NoteAnnotation[] {
  const out: NoteAnnotation[] = [];
  const lines = text.split(/\r?\n/);
  let inSection = false;
  lines.forEach((line, i) => {
    if (/^##\s/.test(line)) {
      inSection = line.replace(/^##\s+/, "").trim() === NOTE_ANNOT_SECTION;
      return;
    }
    if (!inSection) return;
    const m = ANNOT_LINE.exec(line);
    if (!m) return;
    const page = Number(m[1]);
    const quote = m[2].trim();
    if (!page || !quote) return;
    out.push({ page, quote, comment: (m[3] ?? "").trim(), line: i + 1 });
  });
  return out;
}

/** 八小节是否全空（新建档的模板笔记、或只记了译段/想法）：笔记里出现过至少一个八小节标题，
 *  且出现过的都没有正文。lit-notes 写过的笔记、自由格式的笔记都返回 false */
export function noteDraftEmpty(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const wanted = new Set<string>(NOTE_DRAFT_SECTIONS);
  let seen = 0;
  let current: string | null = null;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      const name = line.replace(/^#{1,6}\s+/, "").trim();
      current = /^##\s/.test(line) && wanted.has(name) ? name : null;
      if (current) seen++;
      continue;
    }
    if (current && line.trim()) return false;
  }
  return seen > 0;
}

/** 「让 AI 起草」直发给阅读会话的一句话（按 lit-notes 精读写法，原地补全，机管小节不碰） */
export function buildNoteDraftPrompt(pdfPath: string, notePath: string): string {
  return `请按 lit-notes 技能的精读写法起草这篇笔记：通读 PDF 全文 ${pdfPath}，把八个小节写进 ${notePath}（直接编辑这个文件）。标题下的来源行、「${NOTE_ANNOT_SECTION}」「译段」「我的想法」三节和里面已有的内容原样保留，不要改动。页码和图表编号以 PDF 为准，读不清的写「原文未核清」。写完用一两句告诉我哪些地方还不确定。`;
}

/** 笔记正文里一处可点的 PDF 引用：页码，或图/表编号 */
export interface PdfRefMatch {
  start: number;
  end: number;
  page?: number;
  figure?: string;
  table?: string;
}

const PDF_REF =
  /(?<![A-Za-z])pp?\.\s?(\d{1,4})(?:\s?[-–]\s?\d{1,4})?|第\s*(\d{1,4})\s*页|(?<![A-Za-z])[Pp]age\s+(\d{1,4})(?![0-9])|(?<![A-Za-z])[Ff]ig(?:ure)?s?\.?\s?(\d{1,3}[a-z]?|S\d{1,3})(?![0-9])|图\s?(\d{1,3}[a-z]?)(?![0-9])|(?<![A-Za-z])(?:[Tt]ables?|[Tt]ab\.)\s?(\d{1,3}|[IVX]{1,5}|S\d{1,3})(?![0-9A-Za-z])|表\s?(\d{1,3})(?![0-9])/g;

/** 找出一段文字里的页码/图表引用（p.3、pp.3–5、第 3 页、page 3、Fig. 2、Figure 2a、图 2、Table 1、表 1） */
export function findPdfRefs(text: string): PdfRefMatch[] {
  const out: PdfRefMatch[] = [];
  PDF_REF.lastIndex = 0;
  for (let m = PDF_REF.exec(text); m !== null; m = PDF_REF.exec(text)) {
    const base = { start: m.index, end: m.index + m[0].length };
    const page = m[1] ?? m[2] ?? m[3];
    if (page) out.push({ ...base, page: Number(page) });
    else if (m[4] ?? m[5]) out.push({ ...base, figure: m[4] ?? m[5] });
    else if (m[6] ?? m[7]) out.push({ ...base, table: m[6] ?? m[7] });
  }
  return out.filter((r) => r.page === undefined || r.page > 0);
}

/** 标注落笔记成功的 toast 口径（同 translationSavedToast：笔记栏编辑态有未保存改动时不回显，明说） */
export function annotationSavedToast(noteDirty: boolean, withComment: boolean): string {
  const base = withComment ? "批注已记进笔记「标注」" : "已高亮，记在笔记「标注」里";
  return noteDirty ? `${base}（笔记栏有未保存改动，保存后可见）` : base;
}

/** 笔记 → PDF 的一次跳转：页码（可带摘句，点译段/标注里的页码时顺带闪一下原文），或图/表编号 */
export interface PdfJumpRef {
  page?: number;
  figure?: string;
  table?: string;
  quote?: string;
  /** 用户点的原文（找不到时提示用） */
  label: string;
}

/** 笔记 → PDF 的一次跳转请求（nonce 每次递增，同一处再点也生效） */
export interface PdfJumpReq extends PdfJumpRef {
  nonce: number;
}

/** 阅读区 PDF 栏用到的标注（页内按摘句重定位） */
export interface PdfAnnotation {
  page: number;
  quote: string;
  comment: string;
}

/** 译段引用块的原文（去掉末尾「（第 N 页）」）：点页码时顺带闪一下这段 */
export function quoteFromTranslationBlock(text: string): string {
  return text
    .replace(/（第\s*\d+\s*页）\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 标注行里的摘句（「」之间）；没有返回空串 */
export function quoteFromAnnotationText(text: string): string {
  const m = /「(.+?)」/.exec(text);
  return m ? m[1].trim() : "";
}
