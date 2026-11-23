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
  let missingFile = false;
  let openCount = -1;
  const openedFiles: Array<Record<string, unknown>> = [];
  const openedWindows: Array<Record<string, unknown>> = [];
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { path?: string; text?: string; cwd?: string; paths?: string[] }) => {
        if (command === "read_file_preview") {
          if (missingFile) throw new Error("文件不存在");
          return { text: saved, truncated: false, revision: "r1" };
        }
        if (command === "save_file_preview") {
          saved = args.text ?? saved;
          if (args.path?.endsWith("review-report.md")) assert.match(saved, /决定：接受/);
          return "r2";
        }
        if (command === "existing_files") {
          return (args.paths ?? []).map((p) => ({ path: p, abs: `${args.cwd ?? "/proj"}/${p}` }));
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
          onOpenFile: (req: unknown) => {
            openedFiles.push(req as Record<string, unknown>);
          },
          onOpenFileInWindow: (req: unknown) => {
            openedWindows.push(req as Record<string, unknown>);
          },
          onAllDecided: () => {
            continued += 1;
          },
        }),
      );
    });
    assert.match(host.textContent ?? "", /R001/);
    assert.match(host.textContent ?? "", /R002/);
    assert.ok([...host.querySelectorAll("button")].some((button) => button.textContent === "全部接受"));
    const openDrawerBtn = [...host.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").startsWith("对照文件"),
    );
    assert.ok(openDrawerBtn);
    assert.equal(openDrawerBtn.textContent, "对照文件（2）");
    await act(async () => {
      openDrawerBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(openedFiles.length, 1);
    assert.equal(openedFiles[0]?.showList, true);
    assert.equal(openedFiles[0]?.path, "/proj/manuscript/draft.md");
    const openWinBtn = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "新窗口打开",
    );
    assert.ok(openWinBtn);
    await act(async () => {
      openWinBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(openedWindows.length, 1);
    assert.equal(openedWindows[0]?.showList, true);
    assert.equal(openedWindows[0]?.path, "/proj/manuscript/draft.md");
    const lineBtn = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "manuscript/draft.md:18",
    );
    assert.ok(lineBtn);
    await act(async () => {
      lineBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(openedFiles[1]?.line, 18);
    assert.equal(openedFiles[1]?.path, "/proj/manuscript/draft.md");
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
    // 第一轮后这一行就挂上了，清单第二轮才写：读不到时不说「勾上跳过」、不放行勾选；
    // 步骤状态一变（refreshKey）就重读（2026-10-24 HER 润色实证）
    const verifyText = saved;
    missingFile = true;
    const renderVerify = (refreshKey: string) =>
      h(List, {
        projectRoot: "/proj2",
        target: "manuscript/verification-decisions.md",
        kind: "verify",
        refreshKey,
        onOpenCount: (n: number) => {
          openCount = n;
        },
        onAllDecided: () => {},
      });
    await act(async () => {
      root.render(renderVerify("working"));
    });
    assert.match(host.textContent ?? "", /还没写出来/);
    assert.doesNotMatch(host.textContent ?? "", /勾上跳过/);
    assert.equal(openCount, 1);
    missingFile = false;
    saved = verifyText;
    await act(async () => {
      root.render(renderVerify("done"));
    });
    assert.match(host.textContent ?? "", /V001/);
    // 条目自带建议：完整展示建议改法，点「修改」展开多行编辑框并预填建议，支持一键「按建议修改」与撤销
    saved = "- V001 | 位置：review-final.md:51 | 原文摘要：方向矛盾 | 来源：[@a] | 建议：写明原文两处说法相反，去掉待核实 | 裁决：待裁决 | 依据：\n";
    await act(async () => {
      root.render(renderVerify("suggest"));
    });
    assert.match(host.textContent ?? "", /建议改法：/);
    assert.match(host.textContent ?? "", /写明原文两处说法相反/);
    const editBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "修改");
    assert.ok(editBtn);
    await act(async () => {
      editBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    const box = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="V001 修改说明"]')!;
    assert.ok(box);
    assert.equal(box.value, "写明原文两处说法相反，去掉待核实");
    const saveEditBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "保存修改");
    assert.ok(saveEditBtn);
    await act(async () => {
      saveEditBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.match(saved, /裁决：改正为写明原文两处说法相反，去掉待核实/);
    assert.match(host.textContent ?? "", /已修改/);
    // 撤销恢复为待裁决
    const undoBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("撤销"));
    assert.ok(undoBtn);
    await act(async () => {
      undoBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.match(saved, /裁决：待裁决/);
    // 一键「按建议修改」
    const quickSuggestBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "按建议修改");
    assert.ok(quickSuggestBtn);
    await act(async () => {
      quickSuggestBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.match(saved, /裁决：改正为写明原文两处说法相反，去掉待核实/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("审查报告支持按严重度筛选与按当前筛选批量接受，不误伤严重问题", async () => {
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
  let saved = `## 严重问题

R001 位置：manuscript/draft.md:4。问题：核心数字有误。类别：数据。

## 建议

R002 位置：manuscript/draft.md:20。问题：标题可更简洁。类别：写作。
`;
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { text?: string; cwd?: string; paths?: string[] }) => {
        if (command === "read_file_preview") return { text: saved, truncated: false, revision: "r1" };
        if (command === "save_file_preview") {
          saved = args.text ?? saved;
          return "r2";
        }
        if (command === "existing_files") {
          return (args.paths ?? []).map((p) => ({ path: p, abs: `${args.cwd ?? "/proj"}/${p}` }));
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
        }),
      );
    });
    const sugChip = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "建议 1");
    assert.ok(sugChip, "应露出按严重度筛选的胶囊");
    await act(async () => {
      sugChip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.doesNotMatch(host.textContent ?? "", /R001/);
    assert.match(host.textContent ?? "", /R002/);
    const batchBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "接受当前筛选 1 条",
    );
    assert.ok(batchBtn, "筛选后批量按钮应只针对当前筛选条目");
    await act(async () => {
      batchBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.doesNotMatch(saved, /R001[^\n]*\n决定：接受/);
    assert.match(saved, /R002[\s\S]*决定：接受/);

    // 全部已决定且 handoffState="handed" 时不显示「让 Agent 按决定继续」主按钮，仅在「changed」时重新提示按新决定继续
    saved = saved.replace("R001 位置：manuscript/draft.md:4。问题：核心数字有误。类别：数据。", "R001 位置：manuscript/draft.md:4。问题：核心数字有误。类别：数据。\n决定：接受");
    await act(async () => {
      root.render(
        h(List, {
          projectRoot: "/proj",
          target: "manuscript/review-report.md",
          kind: "report",
          handoffState: "handed",
          refreshKey: "handed-check",
          onAllDecided: () => {},
        }),
      );
    });
    assert.match(host.textContent ?? "", /已交给 Agent 处理/);
    assert.doesNotMatch(host.textContent ?? "", /让 Agent 按决定继续/);
    assert.ok([...host.querySelectorAll("button")].some((b) => b.textContent === "重新发给 Agent"));

    await act(async () => {
      root.render(
        h(List, {
          projectRoot: "/proj",
          target: "manuscript/review-report.md",
          kind: "report",
          handoffState: "changed",
          refreshKey: "changed-check",
          onAllDecided: () => {},
        }),
      );
    });
    assert.match(host.textContent ?? "", /决定已有变动/);
    assert.ok([...host.querySelectorAll("button")].some((b) => b.textContent === "让 Agent 按新决定继续"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
