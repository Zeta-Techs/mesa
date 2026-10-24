import assert from "node:assert/strict";
import test from "node:test";
import {
  addMark,
  appendMarkRef,
  arrowHead,
  badgeGeometry,
  circledNumber,
  cropOf,
  exportFormat,
  markLineWidth,
  markTooSmall,
  nextMarkNumber,
  outputFrame,
  paintMarkup,
  rectFromPoints,
  type Markup,
  type MarkupCanvas,
} from "../src/image-markup.ts";

test("线宽跟图走：长边 / 500，夹在 2–12", () => {
  assert.equal(markLineWidth(400, 300), 2);
  assert.equal(markLineWidth(1920, 1080), 4);
  assert.equal(markLineWidth(12000, 9000), 12);
});

test("两点拉矩形：往哪个方向拖都得到正宽高", () => {
  assert.deepEqual(rectFromPoints({ x: 50, y: 80 }, { x: 10, y: 20 }), { x: 10, y: 20, w: 40, h: 60 });
});

test("太小的框、太短的箭头、只点一下的画笔当误点", () => {
  assert.equal(markTooSmall({ kind: "box", n: 1, x: 0, y: 0, w: 5, h: 40 }, 2), true);
  assert.equal(markTooSmall({ kind: "box", n: 1, x: 0, y: 0, w: 6, h: 6 }, 2), false);
  assert.equal(markTooSmall({ kind: "arrow", x1: 0, y1: 0, x2: 7, y2: 0 }, 2), true);
  assert.equal(markTooSmall({ kind: "pen", points: [1, 1] }, 2), true);
});

test("裁剪框只留最后一个；导出范围取整并夹在图内", () => {
  let marks = addMark([], { kind: "crop", x: 0, y: 0, w: 10, h: 10 });
  marks = addMark(marks, { kind: "mask", x: 1, y: 1, w: 5, h: 5 });
  marks = addMark(marks, { kind: "crop", x: 10.4, y: 20.6, w: 500, h: 30.2 });
  assert.equal(marks.filter((m) => m.kind === "crop").length, 1);
  assert.deepEqual(cropOf(marks), { x: 10.4, y: 20.6, w: 500, h: 30.2 });
  assert.deepEqual(outputFrame({ width: 200, height: 100, marks }), { x: 10, y: 20, w: 190, h: 31 });
  assert.deepEqual(outputFrame({ width: 200, height: 100, marks: [] }), { x: 0, y: 0, w: 200, h: 100 });
});

test("编号徽标贴边时往里收，整圈留在图内", () => {
  const g = badgeGeometry({ x: 0, y: 0, w: 50, h: 50 }, 4, 300, 200);
  assert.equal(g.r, 18);
  assert.deepEqual([g.cx, g.cy], [18, 18]);
});

test("箭头头部：尖在终点，两翼在终点后方对称", () => {
  const [a, tip, b] = arrowHead(0, 0, 100, 0, 10);
  assert.deepEqual(tip, [100, 0]);
  assert.ok(a[0] < 100 && b[0] < 100);
  assert.ok(Math.abs(a[1] + b[1]) < 1e-9, "两翼上下对称");
});

test("编号：几张图连着编、撤销掉的号不回收；消息里另起一行写圈码", () => {
  const one: Markup = { width: 10, height: 10, marks: [{ kind: "box", n: 1, x: 0, y: 0, w: 5, h: 5 }] };
  const two: Markup = { width: 10, height: 10, marks: [{ kind: "box", n: 3, x: 0, y: 0, w: 5, h: 5 }] };
  assert.equal(nextMarkNumber([one, undefined, two]), 4);
  assert.equal(nextMarkNumber([one], 5), 6, "已经发出过 ⑤（后来撤销了）就从 ⑥ 起");
  assert.equal(circledNumber(1), "①");
  assert.equal(circledNumber(20), "⑳");
  assert.equal(circledNumber(21), "(21)");
  assert.equal(appendMarkRef("", 1), "① ");
  assert.equal(appendMarkRef("这张图：  ", 2), "这张图：\n② ");
  assert.equal(appendMarkRef("第一行\n", 3), "第一行\n③ ");
});

test("导出格式跟原图：jpg 仍是 jpg，其余 png", () => {
  assert.deepEqual(exportFormat("/a/b.JPEG"), { mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(exportFormat("/a/b.webp"), { mime: "image/png", ext: "png" });
});

test("导出绘制：按裁剪框平移，打码先画、编号压最上", () => {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return (...args: unknown[]) => calls.push(`${key}(${args.filter((a) => typeof a !== "object").join(",")})`);
    },
    set(target, key, value) {
      target[key as string] = value;
      return true;
    },
  }) as unknown as MarkupCanvas;
  paintMarkup(ctx, {}, {
    width: 1000,
    height: 500,
    marks: [
      { kind: "box", n: 1, x: 100, y: 100, w: 200, h: 100 },
      { kind: "mask", x: 400, y: 50, w: 100, h: 40 },
      { kind: "crop", x: 50, y: 40, w: 600, h: 300 },
    ],
  });
  assert.equal(calls[1], "translate(-50,-40)");
  assert.equal(calls[2], "drawImage(0,0,1000,500)");
  const mask = calls.indexOf("fillRect(400,50,100,40)");
  const box = calls.indexOf("rect(100,100,200,100)");
  const badge = calls.findIndex((c) => c.startsWith("fillText(1,100,"));
  assert.ok(mask > 2 && box > mask && badge > box, calls.join(" "));
});
