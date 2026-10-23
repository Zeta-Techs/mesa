import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const REPORT = `## 严重问题

R001 位置：manuscript/draft.md:4
问题：摘要把 12% 写成 21%。

R002 位置：manuscript/draft.md:18
问题：转场是空话。
`;

test("审查条目逐条点，点完最后一条也不自己跳去对话", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as List} from './src/components/ReviewDecisionList';`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime", "@tauri-apps/api/core"],
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
  let saved = REPORT;
  let continued = 0;
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { path?: string; text?: string }) => {
        if (command === "read_file_preview") {
          return { text: saved, truncated: false, revision: "r1" };
        }
        if (command === "save_file_preview") {
          saved = args.text ?? saved;
          assert.match(saved, /决定：接受/);
          return "r2";
        }
        throw new Error(command);
      },
    },
  });
  const mod = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  const { createElement: h, act, createRoot, List } = mod.exports as {
    createElement: typeof import("react").createElement;
    act: (fn: () => Promise<void>) => Promise<void>;
    createRoot: typeof import("react-dom/client").createRoot;
    List: typeof import("../src/components/ReviewDecisionList").default;
  };
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        h(List, {
          projectRoot: "/proj",
          target: "manuscript/review-report.md",
          kind: "report",
          onAllDecided: () => {
            continued += 1;
          },
        }),
      );
    });
    assert.match(host.textContent ?? "", /R001/);
    assert.match(host.textContent ?? "", /R002/);
    assert.ok([...host.querySelectorAll("button")].some((button) => button.textContent === "全部接受"));
    const accept = [...host.querySelectorAll("button")].find((button) => button.textContent === "接受");
    assert.ok(accept);
    await act(async () => {
      accept.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(continued, 0);
    assert.match(host.textContent ?? "", /R002/);
    assert.doesNotMatch(host.textContent ?? "", /让 Agent 按决定继续/);
    const acceptLeft = [...host.querySelectorAll("button")].find((button) => button.textContent === "接受");
    assert.ok(acceptLeft);
    await act(async () => {
      acceptLeft.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(continued, 0);
    assert.match(host.textContent ?? "", /让 Agent 按决定继续/);
    const go = [...host.querySelectorAll("button")].find((button) => button.textContent === "让 Agent 按决定继续");
    assert.ok(go);
    await act(async () => {
      go.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(continued, 1);
    assert.match(saved, /R001[\s\S]*决定：接受/);
    assert.match(saved, /R002[\s\S]*决定：接受/);
    // 待核实清单的「接受」= 人对过原文、去掉标记：不给一键全部接受
    saved = "- V001 | 位置：manuscript/review-final.md:3 | 原文摘要：过电位 30 mV | 来源：[@a] | 裁决：待裁决 | 依据：\n";
    await act(async () => {
      root.render(
        h(List, {
          projectRoot: "/proj",
          target: "manuscript/verification-decisions.md",
          kind: "verify",
          onAllDecided: () => {},
        }),
      );
    });
    assert.match(host.textContent ?? "", /V001/);
    assert.match(host.textContent ?? "", /去掉「待核实」/);
    assert.equal([...host.querySelectorAll("button")].some((button) => button.textContent === "全部接受"), false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
