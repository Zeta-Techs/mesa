import assert from "node:assert/strict";
import test from "node:test";
import { createImeLock, imeBlocksEnter } from "../src/ime-guard.ts";

test("组词中：isComposing 或 keyCode 229 都拦 Enter", () => {
  assert.equal(
    imeBlocksEnter({ isComposing: true, keyCode: 13, composingLock: false }),
    true,
  );
  assert.equal(
    imeBlocksEnter({ isComposing: false, keyCode: 229, composingLock: false }),
    true,
  );
});

test("compositionend 后一帧的锁：拦 Safari 那次确认候选的 Enter", () => {
  assert.equal(
    imeBlocksEnter({ isComposing: false, keyCode: 13, composingLock: true }),
    true,
  );
});

test("组词已结束且无锁：普通 Enter 放行", () => {
  assert.equal(
    imeBlocksEnter({ isComposing: false, keyCode: 13, composingLock: false }),
    false,
  );
});

test("createImeLock：compositionend 当帧仍拦 Enter/Esc，下一帧解锁；dispose 立即清锁", () => {
  let flush: (() => void) | null = null;
  const ime = createImeLock((unlock) => {
    flush = unlock;
    return () => {
      flush = null;
    };
  });
  assert.equal(ime.locked, false);
  assert.equal(ime.blocksKey({ isComposing: false, keyCode: 13 }), false);

  ime.onCompositionStart();
  assert.equal(ime.locked, true);
  assert.equal(ime.blocksKey({ isComposing: false, keyCode: 27 }), true);

  ime.onCompositionEnd();
  // WKWebView 紧跟在 compositionend 之后的 keydown（isComposing 已是 false）仍被拦住
  assert.equal(ime.locked, true);
  assert.equal(ime.blocksKey({ nativeEvent: { isComposing: false, keyCode: 13 } }), true);
  assert.equal(ime.blocksKey({ isComposing: false, keyCode: 27 }), true);

  flush?.();
  assert.equal(ime.locked, false);
  assert.equal(ime.blocksKey({ isComposing: false, keyCode: 13 }), false);

  ime.onCompositionStart();
  ime.dispose();
  assert.equal(ime.locked, false);
});
