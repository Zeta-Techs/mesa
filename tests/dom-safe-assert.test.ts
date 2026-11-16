import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// 先看 npm test 有没有经 --import 预先装好，再引入（引入本身也会装，单跑这个文件照样能测行为）
const preloaded = Boolean((globalThis as Record<symbol, unknown>)[Symbol.for("mesa.domSafeAssert")]);
const { describeDomValue } = await import("./dom-safe-assert.ts");

test("npm test 预加载了 dom-safe-assert（package.json 的 --import 别丢）", () => {
  if (process.env.npm_lifecycle_event !== "test") return;
  assert.equal(preloaded, true);
});

test("断言里出现 DOM 节点：比不上时只给一行描述，不展开整个对象图", () => {
  const dom = new JSDOM('<button id="go" aria-label="开始">开始做</button><p>别的</p>');
  const doc = dom.window.document;
  const button = doc.getElementById("go")!;
  const p = doc.querySelector("p")!;
  try {
    assert.equal(button, button);
    assert.strictEqual(button, button);
    assert.notEqual(button, p);
    assert.equal(doc.querySelector("section"), null);

    const started = Date.now();
    let message = "";
    try {
      assert.equal(button, null);
    } catch (error) {
      assert.ok(error instanceof assert.AssertionError);
      message = error.message;
    }
    assert.ok(Date.now() - started < 1000, "失败信息要立刻生成");
    assert.match(message, /<button id="go" aria-label="开始"> "开始做"/);
    assert.ok(message.length < 300, `失败信息应是短描述：${message.length} 字`);

    assert.throws(() => assert.equal(p, button, "焦点没回到按钮"), /焦点没回到按钮\n实际 <p> "别的"，期望 <button/);
    assert.throws(() => assert.notEqual(button, button), /不应相同/);
    assert.equal(describeDomValue(doc.createTextNode("  一段  字 ")), '#text "一段 字"');
  } finally {
    dom.window.close();
  }
});

test("不涉及 DOM 节点的断言照原样", () => {
  assert.throws(() => assert.equal(1, 2), (error: Error) => /Expected values to be strictly equal/.test(error.message));
  assert.equal("a", "a");
  assert.notEqual({}, {});
});
