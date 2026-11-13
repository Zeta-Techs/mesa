//! 审阅里「加过意见的段落」高亮：从意见栏里的「引文」反找正文位置，用 CSS 自定义高亮标出（不改正文 DOM）。
import { createContext } from "react";

/** 当前审阅的意见里引过的文字：file 是意见所属文件名，quote 是引文 */
export interface ReviewQuote {
  file: string;
  quote: string;
}

export const ReviewQuotesContext = createContext<readonly ReviewQuote[]>([]);

/** CSS 自定义高亮的家当（registry + Highlight 构造器）。旧 WebView、Node 测试环境没有这两个全局：
 *  经 globalThis 安全地取，拿不到返回 null——只是不高亮，不能因缺全局抛 ReferenceError。 */
export function highlightPaintbox(): {
  registry: Map<string, unknown>;
  Highlight: new (...ranges: Range[]) => unknown;
} | null {
  const registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, div, figcaption";
const SKIP_SELECTOR = "script, style, .md-code-bar, .katex-mathml";
const isSpace = (ch: string) => /\s/.test(ch);

const highlightOwners = new Map<string, Map<symbol, readonly Range[]>>();

/** 按预览实例登记 CSS 自定义高亮：同屏多份预览（如主栏与放大弹层）互不覆盖、卸载其一不删另一份的高亮 */
export function setReviewHighlight(
  name: "review-done" | "review-pick",
  owner: symbol,
  ranges: readonly Range[],
): void {
  const paintbox = highlightPaintbox();
  let byOwner = highlightOwners.get(name);
  if (ranges.length > 0) {
    if (!byOwner) {
      byOwner = new Map();
      highlightOwners.set(name, byOwner);
    }
    byOwner.set(owner, ranges);
  } else if (byOwner) {
    byOwner.delete(owner);
    if (byOwner.size === 0) highlightOwners.delete(name);
  }
  if (!paintbox) return;
  const merged: Range[] = [];
  const active = highlightOwners.get(name);
  if (active) {
    for (const list of active.values()) {
      for (const r of list) merged.push(r);
    }
  }
  if (merged.length > 0) paintbox.registry.set(name, new paintbox.Highlight(...merged));
  else paintbox.registry.delete(name);
}

/** 在 host 的文字里找 quote（空白折叠后比对），返回对应的 Range；找不到返回 null。
 *  原文里找不到、且引文是「开头…结尾」时，按开头和其后最近的结尾标出整段 */
export function findQuoteRange(host: HTMLElement, quote: string): Range | null {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  const doc = host.ownerDocument;
  let flat = "";
  const map: { node: Text; offset: number }[] = [];
  const walker = doc.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let prevBlock: Element | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest(SKIP_SELECTOR)) continue;
    const text = node.data;
    const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    // 跨块（段落、列表项）补一个空格，和划选时浏览器拼出的文字一致
    if (prevBlock && block !== prevBlock && flat && !flat.endsWith(" ")) {
      flat += " ";
      map.push({ node, offset: 0 });
    }
    prevBlock = block;
    for (let i = 0; i < text.length; i += 1) {
      if (isSpace(text[i])) {
        if (flat && !flat.endsWith(" ")) {
          flat += " ";
          map.push({ node, offset: i });
        }
      } else {
        flat += text[i];
        map.push({ node, offset: i });
      }
    }
  }
  let at = flat.indexOf(needle);
  let end = at + needle.length;
  if (at < 0) {
    const cut = needle.lastIndexOf("…");
    const head = needle.slice(0, cut).trim();
    const tail = needle.slice(cut + 1).trim();
    if (cut < 0 || !head || !tail) return null;
    at = flat.indexOf(head);
    if (at < 0) return null;
    const t = flat.indexOf(tail, at + head.length);
    if (t < 0) return null;
    end = t + tail.length;
  }
  const first = map[at];
  const last = map[end - 1];
  if (!first || !last) return null;
  const range = doc.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}
