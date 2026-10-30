/**
 * 聊天正文的复制（2026-10-30 用户：消息下的「复制」只给 Markdown 原文，要能只复制文字；表格一键复制、公式复制 LaTeX）。
 * 选中文字时浮出的小条（ChatSelectionBar）与 ⌘C 都走这里：按渲染后的样子取纯文本——公式还原成 $TeX$（KaTeX 排版后
 * 直接复制会出两遍乱码）、表格按制表符分列（贴进 Excel / WPS 自动分好列）、代码块保留原样缩进；
 * 代码块头栏、按钮、图标这些界面字不带。
 */

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER",
  "HEADER", "LI", "MAIN", "NAV", "SECTION", "SUMMARY", "TBODY", "THEAD", "TFOOT", "TR",
]);
/** 前后空一行的块（段落级） */
const PARA_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BLOCKQUOTE", "TABLE", "UL", "OL", "HR"]);

/** 复制时不带的界面元素：按钮（代码块「复制」、消息操作、折叠行）、图标、图片、KaTeX 给读屏的那份 MathML */
function skipped(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === "BUTTON" || tag === "SVG" || tag === "IMG" || tag === "SCRIPT" || tag === "STYLE") return true;
  if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("data-copy-skip")) return true;
  return el.classList.contains("md-code-bar") || el.classList.contains("katex-mathml");
}

/** md-math 占位里的 TeX 源码：renderMathInto 排版前记在 data-tex；没排版（或排版失败）的占位文字本身就是 $..$ 源码 */
export function mathTex(el: Element): { tex: string; display: boolean } {
  const display = el.classList.contains("md-math-display");
  const stored = (el as HTMLElement).dataset?.tex;
  if (stored !== undefined) return { tex: stored, display };
  const raw = (el.textContent ?? "").trim();
  const d = display ? 2 : 1;
  return { tex: raw.slice(d, Math.max(d, raw.length - d)), display };
}

function delimited(tex: string, display: boolean): string {
  return display ? `$$${tex}$$` : `$${tex}$`;
}

class TextOut {
  out = "";
  private pending = 0;
  /** 刚写了列表符号：「• 」后面紧跟的段落（松散列表的 <li><p>）不另起行 */
  private afterMarker = false;
  block(n: number) {
    if (this.afterMarker) return;
    this.pending = Math.max(this.pending, n);
  }
  marker(s: string) {
    this.flush();
    this.out += s;
    this.afterMarker = true;
  }
  private flush() {
    if (this.pending > 0 && this.out) {
      this.out = this.out.replace(/[ \t]+$/, "") + "\n".repeat(this.pending);
    }
    this.pending = 0;
  }
  text(s: string, pre: boolean) {
    if (!s) return;
    if (!pre) {
      s = s.replace(/[ \t\n\r\f]+/g, " ");
      if (this.pending > 0 || this.afterMarker || !this.out || this.out.endsWith("\n")) s = s.replace(/^ +/, "");
      if (!s) return;
    }
    this.flush();
    this.out += s;
    this.afterMarker = false;
  }
  lineBreak() {
    this.afterMarker = false;
    this.flush();
    this.out = this.out.replace(/[ \t]+$/, "") + "\n";
  }
}

function cellText(cell: Element): string {
  return nodePlainText(cell).replace(/[\t\r\n]+/g, " ").trim();
}

/** 表格 → 制表符分列、一行一行（Excel / WPS / Numbers 粘贴都认） */
export function tableToTsv(table: Element): string {
  return Array.from(table.querySelectorAll("tr"))
    .map((tr) => Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH").map(cellText).join("\t"))
    .filter((line) => line.replace(/\t/g, "").trim() !== "")
    .join("\n");
}

function walk(node: Node, out: TextOut, pre: boolean, depth: number): void {
  if (node.nodeType === 3) {
    out.text(node.nodeValue ?? "", pre);
    return;
  }
  if (node.nodeType !== 1 && node.nodeType !== 11) return;
  if (node.nodeType === 11) {
    for (const c of Array.from(node.childNodes)) walk(c, out, pre, depth);
    return;
  }
  const el = node as Element;
  if (skipped(el)) return;
  const tag = el.tagName.toUpperCase();
  if (el.classList.contains("md-math")) {
    const { tex, display } = mathTex(el);
    if (display) out.block(1);
    out.text(delimited(tex, display), true);
    if (display) out.block(1);
    return;
  }
  if (tag === "BR") {
    out.lineBreak();
    return;
  }
  if (tag === "TABLE") {
    out.block(2);
    out.text(tableToTsv(el), true);
    out.block(2);
    return;
  }
  const inList = tag === "UL" || tag === "OL";
  const para = PARA_TAGS.has(tag) && !(inList && depth > 0);
  if (para) out.block(2);
  else if (BLOCK_TAGS.has(tag) || inList) out.block(1);
  if (tag === "LI") {
    const list = el.parentElement;
    let marker = "• ";
    if (list?.tagName.toUpperCase() === "OL") {
      const start = Number(list.getAttribute("start") ?? "1") || 1;
      const index = Array.from(list.children).filter((c) => c.tagName.toUpperCase() === "LI").indexOf(el);
      marker = `${start + Math.max(0, index)}. `;
    }
    out.marker("  ".repeat(Math.max(0, depth - 1)) + marker);
  }
  // 选区只框住表里几格时克隆出来没有 <table>，格与格之间照样补制表符
  if ((tag === "TD" || tag === "TH") && el.previousElementSibling) out.text("\t", true);
  const childPre = pre || tag === "PRE";
  const childDepth = inList ? depth + 1 : depth;
  for (const c of Array.from(el.childNodes)) walk(c, out, childPre, childDepth);
  if (para) out.block(2);
  else if (BLOCK_TAGS.has(tag) || inList) out.block(1);
}

/** 一段 DOM 按渲染后的样子取纯文本；pre=true 表示整段在代码块里（选区落在 <pre> 内部时，克隆出来的片段不带 <pre>） */
export function nodePlainText(node: Node, pre = false): string {
  const out = new TextOut();
  walk(node, out, pre, 0);
  return out.out.replace(/\n{3,}/g, "\n\n").trim();
}

function elementOf(node: Node): Element | null {
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** 选区一头落在公式里时扩到整条公式：半条 KaTeX 排版既取不回源码也没意义 */
export function expandRangeToMath(range: Range): Range {
  const r = range.cloneRange();
  const startMath = elementOf(r.startContainer)?.closest(".md-math");
  const endMath = elementOf(r.endContainer)?.closest(".md-math");
  if (startMath) r.setStartBefore(startMath);
  if (endMath) r.setEndAfter(endMath);
  return r;
}

function rangeFragmentHost(range: Range): { host: HTMLElement; pre: boolean } {
  const r = expandRangeToMath(range);
  const doc = r.startContainer.ownerDocument ?? document;
  const host = doc.createElement("div");
  host.append(r.cloneContents());
  const common = elementOf(r.commonAncestorContainer);
  return { host, pre: Boolean(common?.closest("pre")) };
}

/** 选区 → 纯文本（公式 $TeX$、表格制表符、代码块原样） */
export function rangePlainText(range: Range): string {
  const { host, pre } = rangeFragmentHost(range);
  return nodePlainText(host, pre);
}

/** 选区正好是一条公式（点一下公式就会整条选中）：返回它的 TeX，供「复制 LaTeX」；混着别的字返回 null */
export function rangeSoleFormula(range: Range): string | null {
  const { host } = rangeFragmentHost(range);
  const maths = host.querySelectorAll(".md-math");
  if (maths.length !== 1) return null;
  const { tex, display } = mathTex(maths[0]);
  return nodePlainText(host) === delimited(tex, display) ? tex : null;
}

/** 选区碰到的第一张表（选中表里任意几个字就能整表复制） */
export function rangeTable(range: Range, scope: Element): HTMLTableElement | null {
  const own = elementOf(range.startContainer)?.closest("table") ?? elementOf(range.endContainer)?.closest("table");
  if (own && scope.contains(own)) return own as HTMLTableElement;
  return (Array.from(scope.querySelectorAll("table")).find((t) => range.intersectsNode(t)) as HTMLTableElement | undefined) ?? null;
}

/** 富文本那一份：去掉界面元素与类名，公式换成 $TeX$ 文字（Word 认不了 KaTeX 的 HTML） */
function cleanCopyHtml(host: HTMLElement): string {
  const doc = host.ownerDocument;
  for (const m of Array.from(host.querySelectorAll(".md-math"))) {
    const { tex, display } = mathTex(m);
    m.replaceWith(doc.createTextNode(delimited(tex, display)));
  }
  for (const el of Array.from(host.querySelectorAll("*"))) {
    // host 是脱离文档的克隆，不能用 isConnected 判断；被前面删掉的父元素带走的子元素跳过
    if (!host.contains(el)) continue;
    if (skipped(el)) {
      el.remove();
      continue;
    }
    el.removeAttribute("class");
    el.removeAttribute("style");
    for (const a of Array.from(el.attributes)) if (a.name.startsWith("data-")) el.removeAttribute(a.name);
  }
  return host.innerHTML;
}

export function tableCopyHtml(table: Element): string {
  const host = table.ownerDocument.createElement("div");
  host.append(table.cloneNode(true));
  return cleanCopyHtml(host);
}

export function rangeCopyHtml(range: Range): string {
  const { host, pre } = rangeFragmentHost(range);
  const html = cleanCopyHtml(host);
  return pre ? `<pre>${html}</pre>` : html;
}

/** 写剪贴板：有富文本那份就两份一起写（贴进 Word 保留表格），写不了退回只写文字 */
export async function writeClipboard(text: string, html?: string): Promise<void> {
  if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      // 落到只写文字
    }
  }
  await navigator.clipboard.writeText(text);
}
