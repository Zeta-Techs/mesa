import assert from "node:assert/strict";
import test from "node:test";
import { REVEAL_HORIZON_MS, revealStep, safeCut, shownAfterRetarget } from "../src/text-reveal.ts";

test("每帧放出积压的一部分：积压大追得快，至少一个字，不超过积压", () => {
  assert.equal(revealStep(0, 16), 0);
  assert.equal(revealStep(5, 0), 0);
  assert.equal(revealStep(1, 16), 1, "尾巴总能放完");
  const small = revealStep(20, 16);
  const big = revealStep(2000, 16);
  assert.ok(small >= 1 && small < 20);
  assert.ok(big > small * 10, "来一大块就追得快");
  assert.equal(revealStep(300, REVEAL_HORIZON_MS * 2), 300, "一帧拖得很久（封顶后仍超过时间常数）就放完");
  assert.equal(revealStep(300, 10_000), revealStep(300, 250), "后台回来不按真实时长跳一大截");
});

test("一块到达后，几帧之内平滑放完，不在下一块到来前停住太久", () => {
  let shown = 0;
  const target = 400;
  let frames = 0;
  while (shown < target && frames < 200) {
    shown += revealStep(target - shown, 1000 / 60);
    frames += 1;
  }
  assert.equal(shown, target);
  // 第一帧不会一下贴出大半
  assert.ok(revealStep(400, 1000 / 60) < 100);
});

test("接着原文往后长才匀速放；第一次见、换了一段都整段显示；不在生成一次放完", () => {
  assert.equal(shownAfterRetarget("", 0, "你好，世界", true), 5, "第一次见到整段显示");
  assert.equal(shownAfterRetarget("你好，世界", 5, "你好，世界。今天", true), 5, "后面接着长：已显示的不动，新的匀速放");
  assert.equal(shownAfterRetarget("你好，世界", 3, "你好，世界。今天", true), 3, "上一块还没放完又来一块：接着放");
  assert.equal(shownAfterRetarget("你好，世界", 5, "另一段文字", true), 5, "预览被会话文件追上换了一段：整段");
  assert.equal(shownAfterRetarget("abc", 1, "abcdef", false), 6, "不在生成：一次放完");
});

test("切口不切开代理对、组合符和连起来的表情", () => {
  const emoji = "a😀b";
  assert.equal(safeCut(emoji, 2), 3, "不停在代理对中间");
  const family = "x👨‍👩‍👧y";
  const cut = safeCut(family, 3);
  assert.equal(family.slice(0, cut), "x👨‍👩‍👧", "零宽连接的表情整个出来");
  assert.equal(safeCut("e\u0301z", 1), 2, "组合重音跟着前一个字");
  assert.equal(safeCut("中文", 1), 1);
  assert.equal(safeCut("abc", 99), 3);
});

test("组件里：第一次整段，接着长的匀速放出，不在生成一次放完", async () => {
  const { build } = await import("esbuild");
  const { createRequire } = await import("node:module");
  const { JSDOM } = await import("jsdom");
  const built = await build({
    stdin: {
      contents: `import {createElement as h} from 'react'; import {useRevealedText} from './src/text-reveal';
        export {createElement} from 'react'; export {createRoot} from 'react-dom/client'; export {flushSync} from 'react-dom';
        export function Probe(p){ return h('p', null, useRevealedText(p.t, p.a)); }`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], define: { "process.env.NODE_ENV": '"development"' },
  });
  // 不走 act：act 会把帧里的更新攒到作用域结束才一起渲染，看不出逐帧放字
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", built.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { createElement: h, createRoot, flushSync, Probe } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const render = (t: string, a: boolean) => flushSync(() => root.render(h(Probe, { t, a })));
  try {
    render("第一段", true);
    assert.equal(host.textContent, "第一段", "第一次见到整段显示");
    const long = "第一段" + "后面接着写出来的一大块字。".repeat(30);
    render(long, true);
    const right = host.textContent!.length;
    assert.ok(right < long.length / 2, `新来的一大块不一下贴出来（${right}/${long.length}）`);
    // 不对时长下断言（CI 调度不可控）：只看每次看到的都是原文前缀、只增不减，最后放完（宽松兜底 10 秒）
    let seen = right;
    for (let i = 0; i < 200 && host.textContent!.length < long.length; i++) {
      await wait(50);
      const now = host.textContent!;
      assert.ok(long.startsWith(now), "显示的是原文前缀");
      assert.ok(now.length >= seen, "只增不减");
      seen = now.length;
    }
    assert.equal(host.textContent, long, "积压放完");
    const more = long + "最后一句。".repeat(20);
    render(more, false);
    assert.equal(host.textContent, more, "不在生成：一次放完");
  } finally {
    flushSync(() => root.unmount());
    // React 的调度器在卸载后还会跑一拍：等它跑完再收 window
    await wait(50);
    dom.window.close();
    for (const [key, d] of restore) {
      if (d) Object.defineProperty(globalThis, key, d);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
