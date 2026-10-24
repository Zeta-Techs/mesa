import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const PERMS = `# 换原图与转载许可

| 图 | 原文 | 原图 | 出版社 | 许可 | 要不要申请 | 图注出处 | 状态 |
|---|---|---|---|---|---|---|---|
| 1(a) | Zhang et al., 2020, *ChemCatChem* 12 — T [DOI](https://doi.org/10.1/a) | Fig. 4(a) | Wiley | 非开放获取 | 要申请 | Adapted with permission. | 待申请 |
| 1(b) | Zhang et al., 2020, *ChemCatChem* 12 — T [DOI](https://doi.org/10.1/a) | Fig. 4(b) | Wiley | 非开放获取 | 要申请 | Adapted with permission. | 待申请 |
| 5(a) | Zhai et al., 2022 — S [DOI](https://doi.org/10.1/b) | Fig. 4 | Wiley | CC BY 4.0 | 不用申请 | Adapted from. | 无需申请 |
`;

const DECL = `# Declarations

## Authors

待填（作者姓名、单位、通讯作者邮箱；一行一位作者）

## Funding

待填
`;

test("许可清单一篇一行、下拉改状态即存；声明一节一框、离开就存（2026-10-24 用户：打开清单 / 填写不方便）", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {FigurePermissionsPanel, DeclarationsForm} from './src/components/HandbackPanels';`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime", "@tauri-apps/api/core"],
    plugins: [
      {
        name: "opener-stub",
        setup(b) {
          b.onResolve({ filter: /^@tauri-apps\/plugin-opener$/ }, () => ({ path: "opener", namespace: "stub" }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: "export const openUrl = async () => {}; export const revealItemInDir = async () => {};",
            loader: "js",
          }));
        },
      },
    ],
  });
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const files: Record<string, string> = {
    "submission/figure-permissions.md": PERMS,
    "submission/declarations.md": DECL,
  };
  const keyOf = (path: string) => Object.keys(files).find((k) => path.replace(/\\/g, "/").endsWith(k))!;
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { path: string; text?: string }) => {
        if (command === "read_file_preview") return { text: files[keyOf(args.path)], truncated: false, revision: "r1" };
        if (command === "save_file_preview") {
          files[keyOf(args.path)] = args.text ?? "";
          return "r2";
        }
        throw new Error(command);
      },
    },
  });
  const mod = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { createElement: h, act, createRoot, FigurePermissionsPanel, DeclarationsForm } = mod.exports as {
    createElement: typeof import("react").createElement;
    act: (fn: () => Promise<void>) => Promise<void>;
    createRoot: typeof import("react-dom/client").createRoot;
    FigurePermissionsPanel: typeof import("../src/components/HandbackPanels").FigurePermissionsPanel;
    DeclarationsForm: typeof import("../src/components/HandbackPanels").DeclarationsForm;
  };
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(h(FigurePermissionsPanel, { root: "/wt", rel: "submission/figure-permissions.md", projectRoot: "/proj" }));
    });
    // 同一篇两块合成一行
    assert.match(host.textContent ?? "", /2 篇 · 待申请 1 篇/);
    assert.match(host.textContent ?? "", /图 1\(a\)、1\(b\)/);
    const select = host.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "已申请";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal((files["submission/figure-permissions.md"].match(/\| 已申请 \|/g) ?? []).length, 2);

    await act(async () => {
      root.render(h(DeclarationsForm, { root: "/wt", rel: "submission/declarations.md" }));
    });
    const boxes = host.querySelectorAll<HTMLTextAreaElement>("textarea");
    assert.equal(boxes.length, 2);
    assert.match(boxes[0].placeholder, /通讯作者邮箱/);
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(boxes[1], "NSFC 21902127");
      boxes[1].dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      boxes[1].dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
    });
    assert.match(files["submission/declarations.md"], /## Funding\n\nNSFC 21902127/);
    assert.match(files["submission/declarations.md"], /## Authors\n\n待填（作者姓名、单位、通讯作者邮箱；一行一位作者）/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
