/**
 * Markdown 阅读态的页内查找（2026-10-26：编辑态有 Monaco 自带查找、PDF 有自己的查找条，md 阅读态原先什么都没有）。
 * 命中处包成 <mark class="md-find-hit">，当前一处再加 md-find-current；清除时拆回文字并合并相邻文本节点。
 * 跨加粗 / 链接等行内元素的命中也认（按块拼接文字找，再逐个文本节点包起来）。不分大小写，弯引号与直引号视为同一个。
 */

const SKIP = "script, style, .md-code-bar, .katex-mathml, .md-cite, .md-find-skip";
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dt, dd, figcaption, summary, div";

function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

/** 折叠后长度不变（只做一对一替换），偏移可直接对回原文 */
export function findAllOffsets(haystack: string, needle: string): number[] {
  const n = fold(needle);
  if (!n) return [];
  const h = fold(haystack);
  const out: number[] = [];
  let at = h.indexOf(n);
  while (at >= 0) {
    out.push(at);
    at = h.indexOf(n, at + n.length);
  }
  return out;
}

interface Seg {
  node: Text;
  start: number;
}

function textBlocks(host: HTMLElement): Seg[][] {
  const groups = new Map<Element, Seg[]>();
  const order: Seg[][] = [];
  const walker = host.ownerDocument.createTreeWalker(host, 4 /* SHOW_TEXT */);
  let node: Node | null;
  const lens = new Map<Seg[], number>();
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP)) continue;
    const block = parent.closest(BLOCK) ?? host;
    let segs = groups.get(block);
    if (!segs) {
      segs = [];
      groups.set(block, segs);
      order.push(segs);
      lens.set(segs, 0);
    }
    const start = lens.get(segs)!;
    segs.push({ node: node as Text, start });
    lens.set(segs, start + (node.nodeValue?.length ?? 0));
  }
  return order;
}

/** 清掉上一次查找留下的 mark */
export function clearFindMarks(host: HTMLElement): void {
  const marks = Array.from(host.querySelectorAll("mark.md-find-hit"));
  if (!marks.length) return;
  const parents = new Set<Node>();
  for (const m of marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parents.add(parent);
  }
  for (const p of parents) p.normalize();
}

/**
 * 标出全部命中，返回每一处命中的 mark 组（一处命中跨几个文本节点就有几个 mark）。
 * 调用前先 clearFindMarks。
 */
export function markFindHits(host: HTMLElement, query: string): HTMLElement[][] {
  const hits: HTMLElement[][] = [];
  if (!query.trim()) return hits;
  const doc = host.ownerDocument;
  for (const segs of textBlocks(host)) {
    const full = segs.map((s) => s.node.nodeValue ?? "").join("");
    const offsets = findAllOffsets(full, query);
    if (!offsets.length) continue;
    // 每个文本节点上要包的区间（节点内偏移），倒序包，前面的偏移不被打乱
    const perNode = new Map<Text, Array<{ from: number; to: number; hit: number }>>();
    offsets.forEach((at, k) => {
      const end = at + query.length;
      for (const seg of segs) {
        const len = seg.node.nodeValue?.length ?? 0;
        const from = Math.max(at, seg.start);
        const to = Math.min(end, seg.start + len);
        if (from >= to) continue;
        const list = perNode.get(seg.node) ?? [];
        list.push({ from: from - seg.start, to: to - seg.start, hit: hits.length + k });
        perNode.set(seg.node, list);
      }
    });
    const base = hits.length;
    for (let k = 0; k < offsets.length; k++) hits.push([]);
    for (const [node, ranges] of perNode) {
      ranges.sort((a, b) => b.from - a.from);
      for (const r of ranges) {
        const tail = node.splitText(r.from);
        tail.splitText(r.to - r.from);
        const mark = doc.createElement("mark");
        mark.className = "md-find-hit";
        tail.parentNode!.replaceChild(mark, tail);
        mark.appendChild(tail);
        hits[r.hit]!.unshift(mark);
      }
    }
    // 同一节点倒序包导致组内顺序反了：按文档顺序重排
    for (let k = base; k < hits.length; k++) {
      hits[k]!.sort((a, b) =>
        a.compareDocumentPosition(b) & 4 /* FOLLOWING */ ? -1 : 1,
      );
    }
  }
  return hits;
}

/** 把第 index 处标成当前（其余去掉当前色），返回该处第一个 mark 供滚动 */
export function setCurrentHit(hits: HTMLElement[][], index: number): HTMLElement | null {
  hits.forEach((group, k) => {
    for (const m of group) m.classList.toggle("md-find-current", k === index);
  });
  return hits[index]?.[0] ?? null;
}
