import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { DEFAULT_SESSION_TEMPLATE } from "../src/project-context.ts";

test("对话注入勾选编辑：点标签去掉一段、补充一段话，手工版式给出两条出路", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Editor} from './src/components/SessionTemplateEditor';`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(createRequire(import.meta.url), mod, mod.exports);
  const { createElement: h, act, createRoot, Editor } = mod.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const emits: { text: string; commit: boolean }[] = [];
  let sourceAsked = 0;
  const values = { 课题主题: "课题主题：\nHER硼化物", 人的决定: "" };
  let value = DEFAULT_SESSION_TEMPLATE;
  const render = () =>
    act(async () => root.render(h(Editor, {
      value, values,
      onChange: (text: string, commit: boolean) => { emits.push({ text, commit }); value = text; },
      onEditSource: () => { sourceAsked += 1; },
    })));
  const chip = (label: string) =>
    [...host.querySelectorAll("button[aria-pressed]")].find((b) => b.textContent?.replace("（空）", "") === label) as HTMLButtonElement;
  try {
    await render();
    assert.equal(host.querySelectorAll("button[aria-pressed]").length, 9, "项目基本信息 + 八段");
    assert.ok([...host.querySelectorAll("button[aria-pressed]")].every((b) => b.getAttribute("aria-pressed") === "true"), "默认全勾");
    assert.match(chip("课题主题").title, /现在：HER硼化物/, "悬停看这个项目现在的内容");
    assert.match(host.textContent!, /人的决定（空）/, "勾着但当前为空的段标出来");
    // 点「人的决定」：从模板里去掉，立即要求保存
    await act(async () => chip("人的决定").click());
    assert.deepEqual(emits.at(-1), { text: DEFAULT_SESSION_TEMPLATE.replace("\n\n{{人的决定}}", ""), commit: true });
    await render();
    assert.equal(chip("人的决定").getAttribute("aria-pressed"), "false");
    // 写补充：打字只同步草稿，失焦才保存；补充放最后
    const extra = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="我的补充"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(extra, "回答用中文。");
      extra.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(emits.at(-1)!.commit, false);
    assert.ok(emits.at(-1)!.text.endsWith("{{已验收}}\n\n回答用中文。"));
    await act(async () => { extra.focus(); extra.blur(); });
    assert.equal(emits.at(-1)!.commit, true);
    // 手工版式（顺序打乱）：勾选改不了，给「编辑源文本 / 改用勾选」
    value = "{{项目规则}}\n\n{{课题主题}}";
    await render();
    assert.match(host.textContent!, /用勾选改不了/);
    await act(async () => ([...host.querySelectorAll("button")].find((b) => b.textContent === "编辑源文本") as HTMLButtonElement).click());
    assert.equal(sourceAsked, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, d] of restore) {
      if (d) Object.defineProperty(globalThis, key, d);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
