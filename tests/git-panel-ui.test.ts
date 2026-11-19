import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      export { createElement, act } from 'react';
      export { createRoot } from 'react-dom/client';
      export { default as GitPanel } from './src/components/GitPanel';
      export { useAppStore } from './src/store';
    `,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom/client", "react/jsx-runtime"],
});

const REPO = "/Users/u/project";

interface HarnessOpts {
  status?: {
    isRepo: boolean;
    branch: string;
    ahead: number;
    behind: number;
    files: { path: string; status: string; additions: number | null; deletions: number | null }[];
    totalAdd: number;
    totalDel: number;
  };
  inWorkspace?: boolean;
  hunks?: { index: number; header: string; patch: string }[];
  staged?: boolean;
  onOpenFile?: (absPath: string) => void;
}

async function mountGitPanel(opts: HarnessOpts = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  let currentStatus = opts.status ?? {
    isRepo: true,
    branch: "main",
    ahead: 0,
    behind: 0,
    files: [{ path: "src/a.ts", status: "M", additions: 2, deletions: 1 }],
    totalAdd: 2,
    totalDel: 1,
  };
  let currentHunks = opts.hunks ?? [
    {
      index: 0,
      header: "@@ -1,2 +1,3 @@",
      patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n a\n-b\n+b2\n+c\n",
    },
  ];
  let currentStaged = opts.staged ?? false;
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let cb = 1;

  Object.assign(dom.window, {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    __TAURI_INTERNALS__: {
      transformCallback: () => cb++,
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "git_status") return currentStatus;
        if (command === "workspace_diff") {
          return opts.inWorkspace
            ? {
                inWorkspace: true,
                workspaceId: "ws1",
                workspaceName: "task",
                branch: "ccode/task",
                worktreePath: REPO,
                baseBranch: "main",
                mergeBase: "1234567",
                files: currentStatus.files,
                totalAdd: currentStatus.totalAdd,
                totalDel: currentStatus.totalDel,
              }
            : { inWorkspace: false };
        }
        if (command === "read_artifacts_manifest") return [];
        if (command === "git_file_hunks") {
          return { hunks: currentHunks, staged: currentStaged };
        }
        if (command === "git_file_diff") {
          return { text: "@@ -1 +1 @@\n-old\n+new\n", binary: false, truncated: false };
        }
        if (command === "git_unstage_file") {
          currentStaged = false;
          return currentStatus;
        }
        if (command === "git_commit") {
          return {
            committed: true,
            pushed: Boolean(args.push),
            failedPhase: null,
            message: "已提交",
            output: "[main abc1234] msg",
          };
        }
        if (command === "git_push") {
          currentStatus = { ...currentStatus, ahead: 0 };
          return "ok";
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
    },
  });

  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  const { createElement: h, act, createRoot, GitPanel, useAppStore } = mod.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const onTotals = () => {};

  const render = async (props: { visible?: boolean; cwd?: string } = {}) => {
    await act(async () => {
      root.render(
        h(GitPanel, {
          cwd: props.cwd ?? REPO,
          visible: props.visible ?? true,
          onTotals,
          onOpenFile: opts.onOpenFile,
        }),
      );
    });
  };
  const settle = () => act(async () => new Promise((r) => setTimeout(r, 10)));

  await render({ visible: true });
  await settle();

  return {
    dom,
    host,
    act,
    calls,
    render,
    settle,
    useAppStore,
    setStaged(v: boolean) {
      currentStaged = v;
    },
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of restore) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("中文输入法组词期按 Enter 不误触发提交", async () => {
  const view = await mountGitPanel();
  try {
    // 先全选文件让提交按钮可用
    const selectAll = Array.from(view.host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "全选",
    );
    assert.ok(selectAll, "存在全选按钮");
    await view.act(async () => selectAll!.click());

    const input = view.host.querySelector<HTMLInputElement>('input[placeholder="说明（可空）"]')!;
    assert.ok(input);

    // 模拟 IME 组合输入期间敲 Enter
    await view.act(async () => {
      input.dispatchEvent(new view.dom.window.CompositionEvent("compositionstart", { bubbles: true }));
      const ev = new view.dom.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(ev);
    });
    await view.settle();
    assert.equal(
      view.calls.filter((c) => c.command === "git_commit").length,
      0,
      "IME 组词期间 Enter 不得触发提交",
    );
  } finally {
    await view.close();
  }
});

test("切页（visible 变 false 再回 true）保留已勾选文件与展开的 diff", async () => {
  const view = await mountGitPanel();
  try {
    const selectAll = Array.from(view.host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "全选",
    )!;
    await view.act(async () => selectAll.click());

    const fileBtn = Array.from(view.host.querySelectorAll("button")).find((b) =>
      b.getAttribute("title")?.includes("src/a.ts 的 diff"),
    )!;
    await view.act(async () => fileBtn.click());
    await view.settle();
    assert.ok(view.host.textContent?.includes("第 1 行"), "diff 已展开");

    await view.render({ visible: false });
    await view.render({ visible: true });
    await view.settle();

    assert.ok(view.host.textContent?.includes("1 / 1"), "勾选计数保留");
    assert.ok(view.host.textContent?.includes("第 1 行"), "展开的 diff 保留");
  } finally {
    await view.close();
  }
});

test("工作区干净但有未推送提交（ahead > 0）时提供独立推送按钮", async () => {
  const view = await mountGitPanel({
    status: {
      isRepo: true,
      branch: "main",
      ahead: 2,
      behind: 0,
      files: [],
      totalAdd: 0,
      totalDel: 0,
    },
  });
  try {
    const pushBtn = Array.from(view.host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("推送 ↑2"),
    );
    assert.ok(pushBtn, "显示独立推送按钮");
    await view.act(async () => pushBtn!.click());
    await view.settle();
    assert.equal(view.calls.filter((c) => c.command === "git_push").length, 1);
  } finally {
    await view.close();
  }
});

test("部分暂存文件提供取消暂存入口，工作区模式隐藏暂存按钮", async () => {
  const view = await mountGitPanel({ staged: true });
  try {
    const fileBtn = Array.from(view.host.querySelectorAll("button")).find((b) =>
      b.getAttribute("title")?.includes("src/a.ts 的 diff"),
    )!;
    await view.act(async () => fileBtn.click());
    await view.settle();
    const unstageBtn = Array.from(view.host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "取消暂存",
    );
    assert.ok(unstageBtn, "普通仓库部分暂存时展示取消暂存按钮");
    await view.act(async () => unstageBtn!.click());
    await view.settle();
    assert.equal(view.calls.filter((c) => c.command === "git_unstage_file").length, 1);
  } finally {
    await view.close();
  }

  const wsView = await mountGitPanel({ inWorkspace: true });
  try {
    const fileBtn = Array.from(wsView.host.querySelectorAll("button")).find((b) =>
      b.getAttribute("title")?.includes("src/a.ts 的 diff"),
    )!;
    await wsView.act(async () => fileBtn.click());
    await wsView.settle();
    const stageBtn = Array.from(wsView.host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "暂存",
    );
    assert.equal(stageBtn, undefined, "工作区模式全量提交，不展示误导性的块级暂存按钮");
  } finally {
    await wsView.close();
  }
});
