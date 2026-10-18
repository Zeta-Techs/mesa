import {
  findPdfRefs,
  quoteFromAnnotationText,
  quoteFromTranslationBlock,
  type PdfJumpRef,
} from "./reader-note.ts";

/** 不进链接化的地方：已有链接、代码、公式、已包过的引用 */
const SKIP = "a, code, pre, .md-pdf-ref, .katex, .md-math, .md-code, .md-mermaid";

/**
 * md 阅读视图里把「p.3」「第 3 页」「Fig. 2」「Table 1」包成可点的引用（阅读区笔记栏，点了跳 PDF）。
 * 幂等：已包过的跳过，每次布局后重扫一遍也安全（预览重绘会把正文盖回 marked 原样）。
 * 页码在标注行（「摘句」）或译段引用块里时，顺带记下那段原文，跳过去能闪一下原处。
 */
export function linkifyPdfRefs(host: HTMLElement): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const refs = findPdfRefs(node.data);
    if (refs.length === 0) continue;
    const li = node.parentElement?.closest("li");
    const bq = node.parentElement?.closest("blockquote");
    const quote = li
      ? quoteFromAnnotationText(li.textContent ?? "")
      : bq
        ? quoteFromTranslationBlock(bq.textContent ?? "")
        : "";
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const r of refs) {
      if (r.start > pos) frag.append(document.createTextNode(node.data.slice(pos, r.start)));
      const span = document.createElement("span");
      span.className = "md-pdf-ref";
      span.textContent = node.data.slice(r.start, r.end);
      if (r.page !== undefined) {
        span.dataset.pdfPage = String(r.page);
        if (quote) span.dataset.pdfQuote = quote;
      }
      if (r.figure) span.dataset.pdfFigure = r.figure;
      if (r.table) span.dataset.pdfTable = r.table;
      frag.append(span);
      pos = r.end;
    }
    if (pos < node.data.length) frag.append(document.createTextNode(node.data.slice(pos)));
    node.replaceWith(frag);
  }
}

/** 点中的引用 → 跳转请求；不是引用返回 null */
export function pdfRefFromTarget(target: EventTarget | null): PdfJumpRef | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>(".md-pdf-ref");
  if (!el) return null;
  const page = Number(el.dataset.pdfPage);
  return {
    ...(Number.isInteger(page) && page > 0 ? { page } : {}),
    ...(el.dataset.pdfFigure ? { figure: el.dataset.pdfFigure } : {}),
    ...(el.dataset.pdfTable ? { table: el.dataset.pdfTable } : {}),
    ...(el.dataset.pdfQuote ? { quote: el.dataset.pdfQuote } : {}),
    label: (el.textContent ?? "").trim(),
  };
}

/** 在 md 阅读视图里找到含这段文字的块（列表项/段落/引用/表格格子/标题）滚到中间并闪一下；
 *  找不到返回 false。比对前空白都折成单空格 */
export function focusMdText(host: HTMLElement, text: string): boolean {
  const needle = text.replace(/\s+/g, " ").trim().slice(0, 40);
  if (!needle) return false;
  const blocks = host.querySelectorAll<HTMLElement>("li, p, blockquote, td, h1, h2, h3, h4");
  for (const el of Array.from(blocks)) {
    if (!(el.textContent ?? "").replace(/\s+/g, " ").includes(needle)) continue;
    el.scrollIntoView({ block: "center" });
    el.classList.remove("md-flash");
    // 重挂类名重播动画（同一条连点两次也闪）
    void el.offsetWidth;
    el.classList.add("md-flash");
    setTimeout(() => el.classList.remove("md-flash"), 2500);
    return true;
  }
  return false;
}
