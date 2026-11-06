import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

/** 编辑器「内置模板更新」（2026-11-06 重做）：中文字段名、按字段列差异，不再是英文字段名 + 两栏 JSON；
 *  写法差异（验收条件拆分、决策暂停缺省）不列；全选 → 换成新版 → 交回模板原样，并提示保存才生效 */
test("模板更新面板：只列真差异、中文字段名、全选换成新版", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement, act} from 'react';
        export {createRoot} from 'react-dom/client';
        export {default as Panel} from './src/components/TemplateUpgradePanel';
        export {PIPELINE_TEMPLATES} from './src/pipeline-presets';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    plugins: [{
      name: "upgrade-host",
      setup(b) {
        b.onResolve({ filter: /^\.\/ConfirmDialog$/ }, ({ path }) => ({ path, namespace: "upgrade-stub" }));
        b.onLoad({ filter: /.*/, namespace: "upgrade-stub" }, () => ({
          loader: "js",
          contents: `export const confirmDialog = async (text) => { globalThis.__upgradeHost.confirmations.push(text); return true; };`,
        }));
      },
    }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  const host = { confirmations: [] as string[] };
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true, __upgradeHost: host,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url), compiled, compiled.exports,
  );
  const { createElement: h, act, createRoot, Panel, PIPELINE_TEMPLATES } = compiled.exports;
  const review = PIPELINE_TEMPLATES.find((t: { id: string }) => t.id === "review");
  // 项目里存的样子：编辑器保存过（验收条件按分号拆开、补了决策暂停缺省），谁来做 / 分路被旧编辑器丢了
  const steps = review.steps.map((s: Record<string, any>) => {
    const { role: _r, fanOut: _f, ...rest } = s;
    return {
      ...rest,
      decisionMode: "auto_continue",
      acceptanceCriteria: (s.acceptanceCriteria ?? []).flatMap((c: string) => c.split(/[；;]/).map((x) => x.trim()).filter(Boolean)),
    };
  });
  const loaded: { index: number; step: Record<string, any> }[][] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  const text = () => dom.window.document.body.textContent ?? "";
  const button = (label: string) =>
    [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!;
  try {
    await act(async () => root.render(h(Panel, {
      steps, normalize: (s: unknown) => s, initialTemplate: "review",
      onLoad: (p: { index: number; step: Record<string, any> }[]) => loaded.push(p),
    })));
    assert.match(text(), /5 步可以换成新版/);
    assert.match(text(), /文献精读与笔记改了 分路精读、谁来做/);
    assert.doesNotMatch(text(), /decisionMode|acceptanceCriteria|验收条件|决策暂停策略/, "写法差异不算更新，也不露英文字段名");
    assert.equal(dom.window.document.querySelectorAll("pre").length, 0, "不再是两栏 JSON");
    await act(async () => button("看差异").click());
    assert.match(text(), /主要交给 AI→你和 AI 一起定/);
    assert.ok(button("步换成新版").disabled, "没勾不能换");
    const all = dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => all.click());
    assert.match(button("步换成新版").textContent!, /把勾选的 5 步换成新版/);
    await act(async () => button("步换成新版").click());
    assert.equal(host.confirmations.length, 1);
    assert.equal(loaded[0].length, 5);
    assert.equal(loaded[0][1].step, review.steps[1], "换进去的是模板原样（带分路）");
    assert.ok(loaded[0][1].step.fanOut);
    assert.match(text(), /已换进草稿：文献检索与筛选、文献精读与笔记、综述大纲、综述初稿、润色与定稿。点右上角「保存」才写进项目/);
  } finally {
    await act(async () => root.unmount());
    for (const [key, desc] of restore) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
