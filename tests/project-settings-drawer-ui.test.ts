import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type { ProjectConfigDto } from "../src/types.ts";

test("统一项目设置抽屉：四段式结构、就地重命名与改简介、打开文件夹、切换工作方式、背景开关与从列表移除", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement, act} from 'react';
        export {createRoot} from 'react-dom/client';
        export {default as Drawer} from './src/components/ProjectSettingsDrawer';
        export {ConfirmDialogHost} from './src/components/ConfirmDialog';`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    plugins: [
      {
        name: "drawer-test-stubs",
        setup(b) {
          b.onResolve(
            { filter: /^(\.\.\/store|@tauri-apps\/plugin-opener)$/ },
            ({ path }) => ({ path, namespace: "drawer-stub" }),
          );
          b.onLoad({ filter: /.*/, namespace: "drawer-stub" }, ({ path }) => ({
            loader: "js",
            contents:
              path === "../store"
                ? `export const useAppStore = (sel) => sel(globalThis.__drawerTest.store);
                   useAppStore.getState = () => globalThis.__drawerTest.store;`
                : `export const revealItemInDir = async (p) => { globalThis.__drawerTest.revealed.push(p); };`,
          }));
        },
      },
    ],
  });

  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const revealed: string[] = [];
  let bumped = 0;
  const previewReqs: Array<{ projectRoot: string; path: string }> = [];
  const store = {
    bumpProjectsVersion() { bumped += 1; },
    setFilePreviewReq(req: { projectRoot: string; path: string }) { previewReqs.push(req); },
  };
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn: FrameRequestCallback) => { fn(0); return 0; },
    cancelAnimationFrame: () => {},
    __drawerTest: { store, revealed },
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  let disk: ProjectConfigDto = {
    artifactDir: "output",
    resources: [],
    steps: [],
    workMode: "coding",
    topic: "统一 CLI 控制台",
    rulesOwned: true,
    settings: ["保持零警告"],
    protectedPaths: [],
    skills: [],
    sessionInjectionMode: "auto",
    sessionInjectionTemplate: "",
  };
  const ipcCalls: Array<{ cmd: string; args: any }> = [];

  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: any = {}) => {
        ipcCalls.push({ cmd, args });
        if (cmd === "read_project_config") return { config: disk, warnings: [] };
        if (cmd === "write_project_config") { disk = structuredClone(args.config); return; }
        if (cmd === "register_project") return;
        if (cmd === "set_work_mode") { disk = { ...disk, workMode: args.mode }; return; }
        if (cmd === "project_set_session_injection") {
          disk = { ...disk, sessionInjectionMode: args.mode, sessionInjectionTemplate: args.template };
          return;
        }
        if (cmd === "list_dir") return [{ name: "src", isDir: true }];
        if (cmd === "list_skills") return [];
        if (cmd === "project_memory_read") return { revision: "v1", legacyText: "", entries: [] };
        if (cmd === "project_memory_for_ai") return { included: 0, omitted: 0, stale: 0, omittedIds: [], lines: [] };
        if (cmd === "read_acceptance_log") return [];
        if (cmd === "research_record_read") return { runs: [] };
        if (cmd === "run_list") return [];
        if (cmd === "list_tasks") return [];
        if (cmd === "research_profile_for_ai") return "";
        if (cmd === "remove_project") return;
        throw new Error(`Unexpected IPC: ${cmd}`);
      },
    },
  });

  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url), mod, mod.exports,
  );
  const { createElement: h, act, createRoot, Drawer, ConfirmDialogHost } = mod.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  let closed = 0;

  const buttonByText = (label: string) => {
    const found = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
    );
    assert.ok(found, `缺少按钮：${label}`);
    return found as HTMLButtonElement;
  };
  const setInput = async (el: HTMLInputElement, val: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(el, val);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });

  try {
    await act(async () =>
      root.render(
        h(
          "div",
          null,
          h(Drawer, {
            open: true,
            onClose: () => { closed += 1; },
            projectPath: "/Users/me/mesa",
            projectName: "Mesa",
            workMode: "coding",
          }),
          h(ConfirmDialogHost),
        ),
      ),
    );

    // 四大分区齐全（编程项目以往缺失基本信息，现在具备项目名/项目简介/路径/工作方式）
    assert.ok(host.querySelector('[aria-label="基本信息"]'));
    assert.ok(host.querySelector('[aria-label="AI 规则与项目记忆"]'));
    assert.ok(host.querySelector('[aria-label="记录与管理"]'));
    assert.match(host.textContent!, /项目简介/);
    assert.match(host.textContent!, /统一 CLI 控制台/);

    // 1. 抽屉内就地重命名（不关闭抽屉）
    await act(async () => buttonByText("重命名").click());
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="项目名输入"]')!, "Mesa Desktop");
    await act(async () => buttonByText("保存").click());
    assert.equal(closed, 0, "就地重命名不关抽屉");
    assert.ok(ipcCalls.some((c) => c.cmd === "register_project" && c.args.name === "Mesa Desktop"));
    assert.match(host.textContent!, /Mesa Desktop/);

    // 2. 抽屉内就地改项目简介
    await act(async () => buttonByText("编辑").click());
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="项目简介输入"]')!, "AI 科研与编程工作台");
    await act(async () => buttonByText("保存").click());
    assert.equal(disk.topic, "AI 科研与编程工作台");

    // 3. 打开文件夹
    await act(async () => buttonByText("打开文件夹").click());
    assert.deepEqual(revealed, ["/Users/me/mesa"]);

    // 4. 切换工作方式（编程 -> 科研，标签同步变为「课题主题」）
    await act(async () => buttonByText("科研").click());
    assert.ok(ipcCalls.some((c) => c.cmd === "set_work_mode" && c.args.mode === "research"));
    assert.match(host.textContent!, /课题主题/);
    assert.ok(bumped >= 3);

    // 5. 新对话附带项目背景：单开关 + 预览全文
    await act(async () =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("新对话附带项目背景"))!.click(),
    );
    const toggle = buttonByText("新对话自动附带项目背景");
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    await act(async () =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("预览 AI 拿到的全文"))!.click(),
    );
    assert.match(host.textContent!, /你正在项目「Mesa Desktop」中工作/);
    await act(async () => toggle.click());
    assert.equal(disk.sessionInjectionMode, "off");
    assert.match(host.textContent!, /已关闭：新建对话只发送你输入的内容/);

    // 6. 底部从 Mesa 移除（带二次确认）
    await act(async () => buttonByText("从 Mesa 移除").click());
    const confirmBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "确定" || b.textContent === "确认",
    )!;
    await act(async () => confirmBtn.click());
    assert.ok(ipcCalls.some((c) => c.cmd === "remove_project" && c.args.path === "/Users/me/mesa"));
    assert.equal(closed, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
