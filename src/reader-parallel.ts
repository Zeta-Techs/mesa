/**
 * 阅读区「双语」对照的纯逻辑（2026-11-19）：按什么顺序翻、怎么分批、两边滚动怎么对上、鼠标指的是哪一段。
 * 段落来自 pdf-paragraphs.ts（按内容流顺序）；译文按段落哈希记，同一段原文只翻一次。
 */
import type { PdfParagraph } from "./pdf-paragraphs.ts";

export type ParaStatus = "idle" | "queued" | "loading" | "done" | "failed";

export interface ParaState {
  status: ParaStatus;
  zh?: string;
  error?: string;
}

/** 一批最多多少字原文（一段比这长就单独一批，不切段） */
export const PARALLEL_BATCH_CHARS = 2500;

/** 要送翻译、在译文栏列出的段：只有正文和标题（碎片、题录、参考文献不翻；跨页续写的那截并进了上一页那段） */
export function translatable(p: PdfParagraph): boolean {
  return p.kind === "body" || p.kind === "heading";
}

/** 跨页续写的那截 → 它并进去的那段（在前一页或更前） */
export function resolveParagraph(
  pages: ReadonlyMap<number, readonly PdfParagraph[]>,
  p: PdfParagraph,
): PdfParagraph | null {
  if (p.kind !== "continued") return p;
  if (!p.of) return null;
  const page = Number(p.of.split(":")[0]);
  return pages.get(page)?.find((q) => q.id === p.of) ?? null;
}

/** 打开文献就在后台翻全文：从当前页往后翻到底，再回头翻前面的页 */
export function translationOrder(current: number, pageCount: number): number[] {
  if (pageCount < 1) return [];
  const start = Math.min(Math.max(1, current), pageCount);
  const out: number[] = [];
  for (let n = start; n <= pageCount; n++) out.push(n);
  for (let n = 1; n < start; n++) out.push(n);
  return out;
}

export interface ParallelBatch {
  page: number;
  paras: PdfParagraph[];
}

/** 按页序给还没翻（idle）的段分批：一批不跨页、不超过 maxChars；同一哈希只排一次（同一段原文在别处出现过就复用） */
export function planBatches(
  pages: ReadonlyMap<number, readonly PdfParagraph[]>,
  want: readonly number[],
  stateOf: (hash: string) => ParaStatus,
  maxChars = PARALLEL_BATCH_CHARS,
): ParallelBatch[] {
  const out: ParallelBatch[] = [];
  const taken = new Set<string>();
  for (const n of want) {
    const paras = pages.get(n);
    if (!paras) continue;
    let cur: PdfParagraph[] = [];
    let chars = 0;
    const flush = () => {
      if (cur.length > 0) out.push({ page: n, paras: cur });
      cur = [];
      chars = 0;
    };
    for (const p of paras) {
      if (!translatable(p) || taken.has(p.hash) || stateOf(p.hash) !== "idle") continue;
      taken.add(p.hash);
      if (cur.length > 0 && chars + p.text.length > maxChars) flush();
      cur.push(p);
      chars += p.text.length;
    }
    flush();
  }
  return out;
}

/** 一批前后的原文（只作参考）：全文按页序拍平后，这批第一段之前那段的末尾、最后一段之后那段的开头 */
export function batchNeighbors(
  pages: ReadonlyMap<number, readonly PdfParagraph[]>,
  batch: ParallelBatch,
  beforeChars = 400,
  afterChars = 300,
): { before: string; after: string } {
  const flat: PdfParagraph[] = [];
  for (const n of [...pages.keys()].sort((a, b) => a - b)) {
    for (const p of pages.get(n) ?? []) if (translatable(p)) flat.push(p);
  }
  const first = flat.findIndex((p) => p.id === batch.paras[0]?.id);
  const lastId = batch.paras[batch.paras.length - 1]?.id;
  const last = flat.findIndex((p) => p.id === lastId);
  const prev = first > 0 ? flat[first - 1].text : "";
  const next = last >= 0 && last + 1 < flat.length ? flat[last + 1].text : "";
  return { before: prev.slice(-beforeChars), after: next.slice(0, afterChars) };
}

/** PDF 视口顶部（第 page 页、页内 frac 处）对应对照栏的哪一段：这一页里第一段底边在 frac 以下的；
 *  这页没有就往后找下一页的第一段，再没有取最后一段。双栏页按内容流顺序，对齐的是左栏 */
export function anchorForViewport(
  pages: ReadonlyMap<number, readonly PdfParagraph[]>,
  page: number,
  frac: number,
): PdfParagraph | null {
  const sorted = [...pages.keys()].sort((a, b) => a - b);
  let last: PdfParagraph | null = null;
  for (const n of sorted) {
    // 跨页续写的那截算它上一页那段：视口顶落在续写处时译文栏停在那段
    const paras = (pages.get(n) ?? []).filter((p) => translatable(p) || p.kind === "continued");
    if (paras.length === 0) continue;
    if (n < page) {
      last = paras[paras.length - 1];
      continue;
    }
    if (n > page) return resolveParagraph(pages, paras[0]);
    const hit = paras.find((p) => p.boxes.some((b) => b.y + b.h > frac));
    if (hit) return resolveParagraph(pages, hit);
    last = paras[paras.length - 1];
  }
  return last && resolveParagraph(pages, last);
}

/** 鼠标在第 page 页的 (fx, fy)（页内 0–1）指着哪一段（外框放宽半个百分点；指着续写的那截算它并进去的那段） */
export function paragraphAt(
  pages: ReadonlyMap<number, readonly PdfParagraph[]>,
  page: number,
  fx: number,
  fy: number,
): PdfParagraph | null {
  const pad = 0.005;
  const hit = pages
    .get(page)
    ?.find(
      (p) =>
        (translatable(p) || p.kind === "continued") &&
        p.boxes.some((b) => fx >= b.x - pad && fx <= b.x + b.w + pad && fy >= b.y - pad && fy <= b.y + b.h + pad),
    );
  return hit ? resolveParagraph(pages, hit) : null;
}

/** 已译 / 要翻的段数（进度用；碎片不计） */
export function parallelProgress(
  pages: ReadonlyMap<number, readonly PdfParagraph[]>,
  stateOf: (hash: string) => ParaStatus,
): { done: number; total: number; failed: number; busy: number } {
  const seen = new Set<string>();
  let done = 0;
  let failed = 0;
  let busy = 0;
  for (const paras of pages.values()) {
    for (const p of paras) {
      if (!translatable(p) || seen.has(p.hash)) continue;
      seen.add(p.hash);
      const s = stateOf(p.hash);
      if (s === "done") done++;
      else if (s === "failed") failed++;
      else if (s === "queued" || s === "loading") busy++;
    }
  }
  return { done, total: seen.size, failed, busy };
}
