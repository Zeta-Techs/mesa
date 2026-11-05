/**
 * 对照窗第二期（2026-11-05 用户：「第二期也做了吧」）：点 Fig. N 时自动只框出那张图。
 * 纯逻辑，不碰 DOM / pdf.js 实例（tests/pdf-figure-crop.test.ts）：
 * ① graphicBoxesFromOps：从页的绘图指令（getOperatorList 的 fnArray / argsArray）里跟踪当前变换矩阵，
 *    取出每张图片（单位方块经矩阵）与每条路径（pdf.js 已算好的 minMax）在 PDF 用户坐标里的外框；
 * ② cropFigureRegion：在页坐标（左上为原点、y 向下，单位 pt）里，从图注往上（表格往下）把挨着的图形聚成一块，
 *    再并进块里 / 块边上的短文字（坐标轴标注、(a)(b) 子图字母），返回页内 0–1 区域；认不出就 null（退回整页）。
 * 只是启发式：认错了用户在对照窗里「重新框」，按篇 + 图号记住。
 */

/** pdf.js 的几个绘图指令号（与 pdfjs-dist OPS 一致，v6.2） */
export const PDF_OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageMaskXObject: 83,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageXObjectRepeat: 88,
  paintSolidColorImageMask: 90,
  constructPath: 91,
} as const;

/** [x0, y0, x1, y1]，x0 ≤ x1、y0 ≤ y1 */
export type Rect = [number, number, number, number];
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix, n: readonly number[]): Matrix {
  // 先 n 后 m（PDF 的 cm：新矩阵 = n × 当前）
  return [
    n[0] * m[0] + n[1] * m[2],
    n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2],
    n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4],
    n[4] * m[1] + n[5] * m[3] + m[5],
  ];
}

function applyRect(m: Matrix, r: readonly number[]): Rect {
  const pts = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[0], r[3]],
    [r[2], r[3]],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** 绘图指令 → 图片 / 路径外框（PDF 用户坐标，y 向上）。kind 区分图片与线条：线条多是坐标轴、表格横线 */
export function graphicBoxesFromOps(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
): { rect: Rect; kind: "image" | "path" }[] {
  const out: { rect: Rect; kind: "image" | "path" }[] = [];
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null | undefined;
    switch (fn) {
      case PDF_OPS.save:
        stack.push(ctm);
        break;
      case PDF_OPS.restore:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case PDF_OPS.transform:
        if (args && args.length >= 6) ctm = mul(ctm, args as number[]);
        break;
      case PDF_OPS.paintFormXObjectBegin: {
        stack.push(ctm);
        const m = args?.[0];
        if (Array.isArray(m) && m.length >= 6) ctm = mul(ctm, m as number[]);
        break;
      }
      case PDF_OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case PDF_OPS.paintImageXObject:
      case PDF_OPS.paintInlineImageXObject:
      case PDF_OPS.paintImageMaskXObject:
      case PDF_OPS.paintImageXObjectRepeat:
      case PDF_OPS.paintSolidColorImageMask:
        out.push({ rect: applyRect(ctm, [0, 0, 1, 1]), kind: "image" });
        break;
      case PDF_OPS.constructPath: {
        const mm = args?.[2] as ArrayLike<number> | null | undefined;
        if (mm && mm.length >= 4 && [0, 1, 2, 3].every((k) => Number.isFinite(mm[k]))) {
          // 没画东西的空路径 pdf.js 给 [Inf, Inf, -Inf, -Inf]，上面已滤掉
          out.push({ rect: applyRect(ctm, [mm[0], mm[1], mm[2], mm[3]]), kind: "path" });
        }
        break;
      }
    }
  }
  return out;
}

export interface CropInput {
  /** 页尺寸（pt） */
  page: { w: number; h: number };
  /** 图注第一行的外框（页坐标：左上原点，y 向下） */
  caption: Rect;
  /** 图形外框（页坐标） */
  graphics: readonly { rect: Rect; kind: "image" | "path" }[];
  /** 文字项外框（页坐标） */
  texts: readonly Rect[];
  kind: "figure" | "table";
}

const w = (r: Rect) => r[2] - r[0];
const h = (r: Rect) => r[3] - r[1];
const overlapX = (a: Rect, b: Rect, pad = 0) => a[0] - pad < b[2] && b[0] - pad < a[2];
const union = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

/** 自动框图：返回页内 0–1 区域，认不出返回 null */
export function cropFigureRegion(input: CropInput): { x: number; y: number; w: number; h: number } | null {
  const { page, caption, kind } = input;
  if (page.w <= 0 || page.h <= 0) return null;
  // 去掉整页底色、页眉页脚通栏细线这类装饰
  const graphics = input.graphics.filter(({ rect }) => {
    if (w(rect) <= 0 && h(rect) <= 0) return false;
    if (w(rect) * h(rect) > page.w * page.h * 0.85) return false;
    const rule = h(rect) < page.h * 0.004 && w(rect) > page.w * 0.6;
    const nearEdge = rect[3] < page.h * 0.1 || rect[1] > page.h * 0.9;
    return !(rule && nearEdge);
  });
  let region: Rect | null = kind === "figure" ? figureBlock(input, graphics) : tableBlock(input, graphics);
  if (!region) return null;
  // 并进块里 / 块边上的短文字（坐标轴数字、单位、(a)(b)）；整行正文不并
  const near = [region[0] - page.w * 0.03, region[1] - page.h * 0.012, region[2] + page.w * 0.03, region[3] + page.h * 0.012];
  for (const t of input.texts) {
    const inside = t[0] >= region[0] && t[2] <= region[2] && t[1] >= region[1] && t[3] <= region[3];
    const short = w(t) < page.w * 0.25;
    const touches = t[0] < near[2] && t[2] > near[0] && t[1] < near[3] && t[3] > near[1];
    // 图注本身不并进图（表格的图注在块里，已算过）
    const isCaption = t[1] >= caption[1] - 1 && t[3] <= caption[3] + 1 && overlapX(t, caption);
    if (kind === "figure" && isCaption) continue;
    if (inside || (short && touches)) region = union(region, t);
  }
  const padX = page.w * 0.01;
  const padY = page.h * 0.006;
  const x0 = Math.max(0, region[0] - padX);
  const y0 = Math.max(0, region[1] - padY);
  const x1 = Math.min(page.w, region[2] + padX);
  const y1 = Math.min(page.h, region[3] + padY);
  if (x1 - x0 < page.w * 0.1 || y1 - y0 < page.h * 0.05) return null;
  return { x: x0 / page.w, y: y0 / page.h, w: (x1 - x0) / page.w, h: (y1 - y0) / page.h };
}

/** 图：图注往上，从离图注最近的图形起，把上下相距不到 3% 页高、横向相交（或同一行并排）的图形一块块并进来 */
function figureBlock(input: CropInput, graphics: CropInput["graphics"]): Rect | null {
  const { page, caption } = input;
  const gap = page.h * 0.03;
  const band: Rect = [caption[0] - page.w * 0.05, 0, caption[2] + page.w * 0.05, caption[1] + page.h * 0.01];
  const above = graphics
    .map((g) => g.rect)
    .filter((r) => r[3] <= band[3] && overlapX(r, band))
    .sort((a, b) => b[3] - a[3]);
  const first = above[0];
  if (!first || caption[1] - first[3] > page.h * 0.12) return null;
  let region: Rect = first;
  const used = new Set<number>([0]);
  for (let changed = true; changed; ) {
    changed = false;
    above.forEach((r, i) => {
      if (used.has(i)) return;
      const vertical = r[3] >= region[1] - gap && r[1] <= region[3] + gap;
      // 并排的子图（同一行，横向隔着空白）：上下大半重叠就算一块，不看横向距离（都已在图注那一栏里）
      const sameRow = Math.min(r[3], region[3]) - Math.max(r[1], region[1]) >= Math.min(h(r), h(region)) * 0.5;
      if (vertical && (sameRow || overlapX(r, region, page.w * 0.03))) {
        region = union(region, r);
        used.add(i);
        changed = true;
      }
    });
  }
  return region;
}

/** 表：图注在上，往下找横线（三线表的顶线 / 中线 / 底线），相邻横线隔不到四分之一页高就算同一张表 */
function tableBlock(input: CropInput, graphics: CropInput["graphics"]): Rect | null {
  const { page, caption } = input;
  const rules = graphics
    .map((g) => g.rect)
    .filter((r) => h(r) < page.h * 0.006 && w(r) > page.w * 0.15 && r[1] >= caption[1] && overlapX(r, caption, page.w * 0.05))
    .sort((a, b) => a[1] - b[1]);
  if (rules.length === 0 || rules[0][1] - caption[3] > page.h * 0.08) return null;
  let region: Rect = union(caption, rules[0]);
  for (const r of rules.slice(1)) {
    if (r[1] - region[3] > page.h * 0.25) break;
    region = union(region, r);
  }
  return region;
}
