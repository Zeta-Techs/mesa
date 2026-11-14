import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";
import type { HumanTaskStateDto, WorkspaceDto } from "../src/types.ts";

// 2026-11-14 HER 润色实测：逐条裁决走完后 CLI 停在提示符（runStatus="active", agentAttention=null），
// 后续三项（更换引用样式 → 换原图与申请转载许可 → 填作者、单位与投稿声明）不能发灰，且逐步引导连贯、勾完即收起。
test("定稿步逐条裁决走完后：后续三项不发灰、行内逐步引导连贯、勾完自动收起选项", async () => {
  const step = PIPELINE_TEMPLATES.find((t) => t.id === "review")!.steps.find((s) => s.workspaceName === "polish")!;
  let taskStates: HumanTaskStateDto[] = (step.humanTasks ?? []).map((h, idx) => ({
    step: step.name,
    title: h.title,
    guidance: h.guidance,
    target: h.target,
    timing: h.timing,
    optional: h.optional,
    detected: idx < 2,
    hitCount: h.target ? 1 : undefined,
    completion: h.completion,
    manual: false,
    explicitCancel: false,
    // 前两项（审查报告 + 逐条裁决）已走完，轮到更换引用样式
    done: idx < 2,
  }));

  const compiled = await build({
    stdin: {
      contents: `export { createElement, act, useState } from 'react'; export { createRoot } from 'react-dom/client'; export { default as StepFlow } from './src/components/StepFlow';`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    loader: { ".css": "empty" },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [
      {
        name: "host-boundaries",
        setup(b) {
          const stubs: Record<string, string> = {
            asset: 'export default "data:text/javascript,";',
            webviewWindow: "export const getCurrentWebviewWindow=()=>({onDragDropEvent:async()=>()=>{}});",
            store:
              "const state={terminalRunInputs:[],helpPending:{},settings:{},humanTasksTick:0,setPendingTerminal(){},setWorkspaceReviewRequest(){},setPage(){},setPreviewReq(){},setHelpViewReq(){}}; export const useAppStore=Object.assign(fn=>fn(state),{getState:()=>state,setState(){},subscribe(){}});",
            "../pipeline-start": "export const buildWorkspaceTerminalRequest=async(_ws,prompt)=>({initialPrompt:prompt});",
            "../md-math": "export const renderMathInto=async()=>{};",
          };
          b.onResolve({ filter: /.*/ }, (args) => {
            if (/\?(worker|url)$/.test(args.path)) return { path: "asset", namespace: "host-stub" };
            if (args.path === "@tauri-apps/api/webviewWindow") return { path: "webviewWindow", namespace: "host-stub" };
            if (args.path === "../store" || args.path === "./store") return { path: "store", namespace: "host-stub" };
            if (args.path === "../md-math" || args.path === "./md-math") return { path: "../md-math", namespace: "host-stub" };
            if (!(args.path in stubs)) return undefined;
            return args.importer.replaceAll("\\", "/").endsWith("/StepFlow.tsx")
              ? { path: args.path, namespace: "host-stub" }
              : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: "host-stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
        },
      },
    ],
  });

  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    DOMMatrix: class {
      multiplySelf() { return this; }
      preMultiplySelf() { return this; }
      invertSelf() { return this; }
      translateSelf() { return this; }
      scaleSelf() { return this; }
      multiply() { return this; }
      inverse() { return this; }
    },
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, payload?: Record<string, unknown>) => {
        if (command === "list_skills") return [];
        if (command === "list_human_task_states") return taskStates.map((row) => ({ ...row }));
        if (command === "set_human_task_check") {
          const title = String(payload?.title ?? "");
          const checked = Boolean(payload?.checked);
          taskStates = taskStates.map((row) =>
            row.title === title ? { ...row, manual: checked, explicitCancel: !checked, done: checked } : row,
          );
          return null;
        }
        if (command === "read_file_preview") {
          const p = String(payload?.path ?? "");
          if (p.endsWith("figure-permissions.md")) {
            return {
              text: [
                "| 图 | 原文 | 原图 | 出版社 | 许可 | 要不要申请 | 图注出处 | 状态 |",
                "|---|---|---|---|---|---|---|---|",
                "| fig1 (a) | @Su2025 https://doi.org/10.1002/adma.202500001 | Fig. 2a | Wiley | 版权保留 | 要申请 | Adapted with permission | 待申请 |",
              ].join("\n"),
              revision: "r1",
            };
          }
          if (p.endsWith("declarations.md")) {
            return {
              text: "## 1. Authors\n\n待填\n\n## 2. Funding\n\n待填\n",
              revision: "r2",
            };
          }
          throw new Error("not found");
        }
        if (command === "save_file_preview") return "r-next";
        if (command === "read_task_draft") return { relPath: ".ccode/drafts/polish.md", text: "" };
        return null;
      },
    },
  });

  const module = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  const { createElement: h, act, createRoot, StepFlow } = module.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);

  const ws: WorkspaceDto = {
    name: "polish",
    branch: "ccode/polish",
    worktreePath: "/ccode/workspaces/her/polish",
    projectPath: "/research/her",
    stepName: step.name,
    ahead: 2,
    behind: 0,
    dirty: 0,
    status: "active",
    createdAt: "2026-11-14T00:00:00Z",
  };

  const buttonByText = (label: string) =>
    Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  const rowOf = (key: string) => host.querySelector<HTMLElement>(`li[data-node-key="${key}"]`);

  try {
    await act(async () => {
      root.render(
        h(StepFlow, {
          projectPath: "/research/her",
          step,
          runStatus: "active",
          agentAttention: null,
          hasDraft: true,
          ws,
          draft: { relPath: ".ccode/drafts/polish.md", exists: true, text: "# polish" },
          onStart() {},
        }),
      );
    });
    // 等 list_human_task_states 微任务落地
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const citeRow = rowOf("human:更换引用样式")!;
    const permRow = rowOf("human:换原图与申请转载许可")!;
    const declRow = rowOf("human:填作者、单位与投稿声明")!;
    const reviewRow = rowOf("review")!;

    // 1. 三项都不再压暗 opacity-45；当前竖线在「更换引用样式」
    for (const r of [citeRow, permRow, declRow]) {
      assert.ok(!r.className.includes("opacity-45"), `${r.dataset.nodeKey} 不应发灰`);
    }
    assert.ok(citeRow.className.includes("after:bg-cta"), "当前节点应在更换引用样式");
    assert.ok(buttonByText("保持当前，不换"), "更换引用样式应给直达跳过按钮");
    assert.ok(permRow.textContent?.includes("打开清单"), "未轮到的许可行右缘给打开清单");
    assert.ok(declRow.textContent?.includes("打开填写"), "未轮到的声明行右缘给打开填写");

    // 2. 点「保持当前，不换」：更换引用样式勾上并收起胶囊，当前节点推进到「换原图与申请转载许可」
    await act(async () => {
      buttonByText("保持当前，不换")!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(!citeRow.textContent?.includes("作者-年"), "更换引用样式完成后应把胶囊收起");
    assert.ok(permRow.className.includes("after:bg-cta"), "当前节点应推进到换原图与申请转载许可");
    assert.ok(buttonByText("清单改好了，交给 AI"), "当前行下方应出现清单改好了，交给 AI");
    assert.ok(buttonByText("暂不处理，跳过"), "当前行下方应出现暂不处理，跳过");

    // 3. 展开清单再点「暂不处理，跳过」：当前节点推进到「填作者、单位与投稿声明」
    await act(async () => {
      Array.from(permRow.querySelectorAll("button")).find((b) => b.textContent?.trim() === "打开清单")!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(permRow.textContent?.includes("Wiley"), "打开清单应就地展开许可条目");
    await act(async () => {
      buttonByText("暂不处理，跳过")!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(!permRow.textContent?.includes("Wiley"), "跳过后清单应自动收起");
    assert.ok(declRow.className.includes("after:bg-cta"), "当前节点应推进到填作者、单位与投稿声明");
    assert.ok(buttonByText("填好了，交给 AI"), "声明行下方应出现填好了，交给 AI");
    assert.ok(buttonByText("暂不填写，跳过"), "声明行下方应出现暂不填写，跳过");

    // 4. 打开填写后直接点左侧复选框：收起表单、给出未交回提醒，且当前节点推进到「保存进项目」
    await act(async () => {
      Array.from(declRow.querySelectorAll("button")).find((b) => b.textContent?.trim() === "打开填写")!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(declRow.textContent?.includes("1. Authors"), "打开填写应展开分节表单");
    const declCheckbox = declRow.querySelector<HTMLElement>('input[type="checkbox"], [role="checkbox"]')!;
    await act(async () => {
      declCheckbox.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(declRow.textContent?.includes("需交给 AI 才会写进成稿"), "直接勾选应提示尚未交给 AI 更新成稿");
    assert.ok(reviewRow.className.includes("after:bg-cta"), "三项处理完后当前节点应落到去评审");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
