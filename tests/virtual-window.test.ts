import assert from "node:assert/strict";
import test from "node:test";
import {
  tailWindow,
  estimateSegmentHeight,
  initialWindow,
  planWindow,
  remapWindow,
  windowCovers,
} from "../src/virtual-window.ts";

const h100 = () => 100;

test("刚摆出来画末尾约 3000px；有要钉住的就画它附近", () => {
  const w = initialWindow(200, h100);
  assert.equal(w.end, 200);
  assert.equal(w.start, 170);
  assert.equal(w.topPad, 17000);
  const p = initialWindow(200, h100, 50);
  assert.ok(p.start <= 50 && p.end > 50);
  assert.equal(p.topPad, p.start * 100);
  assert.deepEqual(initialWindow(0, h100), { start: 0, end: 0, topPad: 0 });
});

test("视野往上移：多画上面几段，占位先不动（画完按实高一次扣）；往下收掉上面几段时占位加实高", () => {
  const win = { start: 170, end: 200, topPad: 17000 };
  const next = planWindow({ count: 200, win, height: h100, viewTop: 15000, viewBottom: 16000, over: 800, pin: -1 });
  assert.equal(next.start, 142); // 15000 - 800 = 14200 → 第 142 段
  assert.equal(next.topPad, 17000, "先不扣，免得内容先变矮把滚动位置压回去");
  assert.ok(next.end <= 169);
  const down = planWindow({ count: 200, win: { start: 100, end: 200, topPad: 10000 }, height: h100, viewTop: 18000, viewBottom: 19000, over: 800, pin: -1 });
  assert.equal(down.start, 172);
  assert.equal(down.topPad, 17200);
});

test("钉住的那一段一定画出来", () => {
  const win = { start: 170, end: 200, topPad: 17000 };
  const next = planWindow({ count: 200, win, height: h100, viewTop: 19000, viewBottom: 20000, over: 800, pin: 10 });
  assert.ok(next.start <= 10 && next.end > 10);
});

test("现有窗口还盖得住视野上下各半个余量就不换", () => {
  const win = { start: 100, end: 160, topPad: 10000 };
  assert.equal(windowCovers({ count: 200, win, renderedHeight: 6000, viewTop: 11000, viewBottom: 12000, over: 800 }), true);
  assert.equal(windowCovers({ count: 200, win, renderedHeight: 6000, viewTop: 10200, viewBottom: 11200, over: 800 }), false);
  assert.equal(windowCovers({ count: 200, win, renderedHeight: 6000, viewTop: 15500, viewBottom: 16500, over: 800 }), false);
});

test("接上更早的（前插）：窗口跟着 key 挪，占位加上新冒出来的估高；在末尾的继续画到末尾", () => {
  const oldKeys = Array.from({ length: 100 }, (_, i) => `k${i + 50}`);
  const newKeys = [...Array.from({ length: 50 }, (_, i) => `k${i}`), ...oldKeys, "k150"];
  const win = { start: 70, end: 100, topPad: 7000 };
  const next = remapWindow(oldKeys, newKeys, win, h100, () => 100);
  assert.equal(next.start, 120);
  assert.equal(next.end, 151);
  assert.equal(next.topPad, 12000);
  // 对不上：从末尾重来
  const fresh = remapWindow(oldKeys, ["x", "y"], win, h100, () => 100);
  assert.deepEqual(fresh, { start: 0, end: 2, topPad: 0 });
});

test("估高：越长越高，用户长消息封顶，过程轮带回答", () => {
  const msg = (role: string, text: string) => ({
    kind: "message" as const,
    index: 0,
    message: { role, blocks: [{ kind: "text" as const, text, toolName: null }], timestamp: null, usage: null },
  });
  assert.ok(estimateSegmentHeight(msg("assistant", "x".repeat(500))) > estimateSegmentHeight(msg("assistant", "x")));
  assert.equal(estimateSegmentHeight(msg("user", "x".repeat(5000))), estimateSegmentHeight(msg("user", "x".repeat(9000))));
});

test("换了一页（搜索跳到别处）：要钉住的那一段不在窗口里就围着它重来", () => {
  const oldKeys = Array.from({ length: 100 }, (_, i) => `a${i}`);
  const newKeys = Array.from({ length: 100 }, (_, i) => `b${i}`);
  const next = remapWindow(oldKeys, newKeys, { start: 70, end: 100, topPad: 7000 }, h100, () => 100, 20);
  assert.ok(next.start <= 20 && next.end > 20);
});

test("跟着底部：窗口钉在末尾，往上画够要求的高度，上方全是占位", () => {
  const h = (i: number) => (i % 2 ? 100 : 300);
  // 末尾往上：99(100) 98(300) 97(100) 96(300) = 800 够了
  assert.deepEqual(tailWindow(100, h, 800), { start: 96, end: 100, topPad: 48 * 400 });
  // 不够一屏的对话整段画
  assert.deepEqual(tailWindow(3, h, 5000), { start: 0, end: 3, topPad: 0 });
  assert.deepEqual(tailWindow(0, h, 800), { start: 0, end: 0, topPad: 0 });
});
