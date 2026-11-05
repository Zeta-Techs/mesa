import assert from "node:assert/strict";
import test from "node:test";
import { PDF_OPS, cropFigureRegion, graphicBoxesFromOps, type Rect } from "../src/pdf-figure-crop.ts";

test("graphicBoxesFromOps：跟踪 cm / save / restore / 表单矩阵，图片取单位方块、路径取 minMax", () => {
  const O = PDF_OPS;
  const boxes = graphicBoxesFromOps(
    [O.save, O.transform, O.paintImageXObject, O.restore, O.paintFormXObjectBegin, O.constructPath, O.paintFormXObjectEnd, O.constructPath],
    [
      null,
      [200, 0, 0, 100, 50, 300], // 图片放到 (50,300) 宽 200 高 100
      ["img1"],
      null,
      [[1, 0, 0, 1, 10, 20], [0, 0, 100, 100]], // 表单平移 (10,20)
      [0, [], [0, 0, 30, 5]],
      null,
      [0, [], [Infinity, Infinity, -Infinity, -Infinity]], // 空路径丢掉
    ],
  );
  assert.deepEqual(boxes, [
    { rect: [50, 300, 250, 400], kind: "image" },
    { rect: [10, 20, 40, 25], kind: "path" },
  ]);
});

// 页 600×800（页坐标：左上原点、y 向下）
const page = { w: 600, h: 800 };

test("cropFigureRegion：图注上方挨着的图片 / 坐标轴聚成一块，并进轴标与子图字母，正文和上一张图不并", () => {
  const caption: Rect = [50, 500, 550, 512];
  const graphics = [
    { rect: [60, 300, 290, 480] as Rect, kind: "image" as const }, // (a) 子图
    { rect: [310, 300, 540, 480] as Rect, kind: "path" as const }, // (b) 曲线框
    { rect: [60, 120, 540, 200] as Rect, kind: "image" as const }, // 上面另一张图，中间隔着它的图注和正文
    { rect: [0, 30, 600, 31] as Rect, kind: "path" as const }, // 页眉通栏细线
  ];
  const texts: Rect[] = [
    [50, 290, 62, 300], // (a) 字母贴在左上角
    [150, 482, 200, 492], // x 轴标注
    [50, 230, 550, 242], // 正文整行
    [50, 500, 550, 512], // 图注本身
  ];
  const r = cropFigureRegion({ page, caption, graphics, texts, kind: "figure" })!;
  const px = [r.x * 600, r.y * 800, (r.x + r.w) * 600, (r.y + r.h) * 800].map(Math.round);
  // 左到 (a) 字母、右到曲线框，上到 (a)，下到轴标注；不含正文（y 230）和图注（y 500）
  assert.ok(px[0] <= 50 && px[0] >= 40, `${px}`);
  assert.ok(px[2] >= 540 && px[2] <= 550, `${px}`);
  assert.ok(px[1] <= 290 && px[1] >= 280, `${px}`);
  assert.ok(px[3] >= 492 && px[3] < 500, `${px}`);
});

test("cropFigureRegion：图注上方隔得远 / 没有图形 → null（退回整页）；表格按图注下方的横线框", () => {
  const caption: Rect = [50, 500, 550, 512];
  assert.equal(cropFigureRegion({ page, caption, graphics: [{ rect: [60, 100, 540, 200], kind: "image" }], texts: [], kind: "figure" }), null);
  assert.equal(cropFigureRegion({ page, caption, graphics: [], texts: [], kind: "figure" }), null);
  const table = cropFigureRegion({
    page,
    caption: [50, 100, 400, 112],
    graphics: [
      { rect: [50, 118, 550, 119], kind: "path" }, // 顶线
      { rect: [50, 140, 550, 141], kind: "path" }, // 中线
      { rect: [50, 320, 550, 321], kind: "path" }, // 底线
      { rect: [50, 700, 550, 701], kind: "path" }, // 下一张表，隔得远不并
    ],
    texts: [],
    kind: "table",
  })!;
  assert.ok(Math.abs(table.y * 800 - (100 - 4.8)) < 1);
  assert.ok(Math.abs((table.y + table.h) * 800 - (321 + 4.8)) < 1);
});
