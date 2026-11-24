import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build, type Plugin } from "esbuild";
import { JSDOM } from "jsdom";

const stubHeavyPlugin: Plugin = {
  name: "stub-heavy",
  setup(b) {
    // 静态资源、Vite worker/url 查询与重型浏览器库在单测里不需要真实加载
    b.onResolve({ filter: /(\.(css|svg|ttf|woff2?|png|webp)(\?.*)?$|\?(url|worker)$|^pdfjs-dist|^monaco-editor)/ }, (args) => ({
      path: args.path,
      namespace: "stub-asset",
    }));
    b.onLoad({ filter: /.*/, namespace: "stub-asset" }, () => ({
      contents: "export default {}; export const GlobalWorkerOptions = {}; export const getDocument = () => ({ promise: Promise.resolve({}) }); export const editor = {}; export const languages = {};",
      loader: "js",
    }));
    // WorkspacesPage 的子视图（文件树、编辑器、步骤流等）与本项目选择逻辑无关，替换为空组件避免拉入 monaco/pdfjs
    const stubComponents = new Set([
      "../components/ProjectGroup",
      "../components/ProjectCodingView",
      "../components/ProjectAgentsView",
      "../components/ProjectSchedulesView",
      "../components/ProjectUserTasksView",
      "../components/ProjectFilePaneHost",
      "../components/ProjectFilePreview",
      "../components/ProjectSettingsDrawer",
      "../components/WorkspaceReviewView",
      "../components/WorkspaceFilesModal",
      "../components/AddProjectModal",
      "../components/TemplatePickModal",
      "../components/InboxDrawer",
    ]);
    b.onResolve({ filter: /^\.\.\/components\// }, (args) =>
      stubComponents.has(args.path) ? { path: args.path, namespace: "stub-comp" } : null,
    );
    b.onLoad({ filter: /.*/, namespace: "stub-comp" }, () => ({
      contents: "export default function Stub() { return null; } export function ProjectFilePaneHost() { return null; }",
      loader: "js",
    }));
  },
};

async function harness() {
  const result = await build({
    stdin: {
      contents: `
        export { createElement, act } from 'react';
        export { createRoot } from 'react-dom/client';
        export { default as WorkspacesPage, workspaceState } from './src/pages/WorkspacesPage';
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
    plugins: [stubHeavyPlugin],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const raf = (cb: FrameRequestCallback) => Number(setTimeout(() => cb(Date.now()), 0));
  const saved: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: raf,
    cancelAnimationFrame: clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  })) {
    saved.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", result.outputFiles[0].text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  const root = mod.exports.createRoot(dom.window.document.getElementById("root"));
  return {
    ...mod.exports,
    root,
    dom,
    host: dom.window.document.getElementById("root")!,
    close: async () => {
      await mod.exports.act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("首次点无工作区项目时，即使有工作区的项目先返回也不会跳到后者", async () => {
  const ui = await harness();
  const projectsDef = deferred<any[]>();
  const herPath = "/tmp/her-review";
  const otherPath = "/tmp/other-project";
  const workspaces = [
    {
      id: "ws-her-1",
      name: "lit-search",
      repoPath: herPath,
      repoName: "HER催化综述",
      worktreePath: "/tmp/her-review/.worktrees/lit-search",
      branch: "ccode/lit-search",
      baseBranch: "main",
      status: "active",
      createdAt: "2026-11-01T00:00:00Z",
    },
  ];
  const projects = [
    { id: "p1", name: "HER催化综述", path: herPath, workMode: "research", lastOpened: "2026-11-20T10:00:00Z" },
    { id: "p2", name: "另一个项目", path: otherPath, workMode: "research", lastOpened: "2026-11-19T10:00:00Z" },
  ];

  Object.assign(ui.dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        if (cmd === "list_workspaces") return workspaces;
        if (cmd === "list_projects") return projectsDef.promise;
        if (cmd === "home_dir") return "/tmp";
        if (cmd === "list_schedules") return [];
        if (cmd === "list_help_requests") return [];
        if (cmd === "pending_artifact_checks") return [];
        if (cmd === "read_project_config") return { config: { steps: [], resources: [], settings: [] }, warnings: [] };
        if (cmd === "workspace_drift") return { ahead: 0, behind: 0, dirty: 0 };
        if (cmd === "workspace_health") return { state: "clean" };
        if (cmd === "workspace_settings") return { setup: [], teardown: [], run: [], env: [] };
        return [];
      },
    },
  });

  try {
    // 模拟首次从侧栏点击「另一个项目」，此时 list_workspaces 先返回 HER催化综述，list_projects 晚到
    ui.useAppStore.setState({ page: "workspaces", selectProjectReq: otherPath });
    await ui.act(async () => {
      ui.root.render(ui.createElement(ui.WorkspacesPage, { visible: true }));
    });
    assert.equal(ui.useAppStore.getState().selectProjectReq, otherPath);

    // list_projects 返回后应准确选中「另一个项目」，不跳到 HER催化综述
    await ui.act(async () => {
      projectsDef.resolve(projects);
      await projectsDef.promise;
    });
    assert.equal(ui.useAppStore.getState().selectProjectReq, null);
    assert.equal(ui.useAppStore.getState().contextLabel?.projectPath, otherPath);
    assert.equal(ui.useAppStore.getState().contextLabel?.project, "另一个项目");
  } finally {
    await ui.close();
  }
});

test("已有项目列表时点击刚新建的项目，会自动补拉一轮再选中而不是跳回第一个项目", async () => {
  const ui = await harness();
  const herPath = "/tmp/her-review";
  const freshPath = "/tmp/fresh-project";
  let projList = [
    { id: "p1", name: "HER催化综述", path: herPath, workMode: "research", lastOpened: "2026-11-20T10:00:00Z" },
  ];

  Object.assign(ui.dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        if (cmd === "list_workspaces") return [];
        if (cmd === "list_projects") return projList;
        if (cmd === "home_dir") return "/tmp";
        if (cmd === "list_schedules") return [];
        if (cmd === "list_help_requests") return [];
        if (cmd === "pending_artifact_checks") return [];
        if (cmd === "read_project_config") return { config: { steps: [], resources: [], settings: [] }, warnings: [] };
        return [];
      },
    },
  });

  try {
    ui.useAppStore.setState({ page: "workspaces", selectProjectReq: null });
    await ui.act(async () => {
      ui.root.render(ui.createElement(ui.WorkspacesPage, { visible: true }));
    });
    assert.equal(ui.useAppStore.getState().contextLabel?.projectPath, herPath);

    // 后端新增项目，但 WorkspacesPage 内存还是旧表；用户立即点新项目
    projList = [
      ...projList,
      { id: "p3", name: "新建课题", path: freshPath, workMode: "research", lastOpened: "2026-11-20T10:05:00Z" },
    ];
    await ui.act(async () => {
      ui.useAppStore.getState().setSelectProjectReq(freshPath);
    });
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(ui.useAppStore.getState().selectProjectReq, null);
    assert.equal(ui.useAppStore.getState().contextLabel?.projectPath, freshPath);
    assert.equal(ui.useAppStore.getState().contextLabel?.project, "新建课题");
  } finally {
    await ui.close();
  }
});

test("确实不存在的项目路径在补拉一轮后静默清空，不会死循环刷新", async () => {
  const ui = await harness();
  const herPath = "/tmp/her-review";
  let listCalls = 0;

  Object.assign(ui.dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        if (cmd === "list_workspaces") return [];
        if (cmd === "list_projects") {
          listCalls += 1;
          return [{ id: "p1", name: "HER催化综述", path: herPath, workMode: "research" }];
        }
        if (cmd === "home_dir") return "/tmp";
        if (cmd === "list_schedules") return [];
        if (cmd === "list_help_requests") return [];
        if (cmd === "pending_artifact_checks") return [];
        if (cmd === "read_project_config") return { config: { steps: [], resources: [], settings: [] }, warnings: [] };
        return [];
      },
    },
  });

  try {
    ui.useAppStore.setState({ page: "workspaces", selectProjectReq: null });
    await ui.act(async () => {
      ui.root.render(ui.createElement(ui.WorkspacesPage, { visible: true }));
    });
    const before = listCalls;
    await ui.act(async () => {
      ui.useAppStore.getState().setSelectProjectReq("/tmp/deleted-project");
    });
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.equal(ui.useAppStore.getState().selectProjectReq, null);
    assert.equal(listCalls, before + 1);
  } finally {
    await ui.close();
  }
});

test("多活跃工作区刷新时限制 drift 与 health 并发上限，并把健康检查失败原因放进状态详情", async () => {
  const ui = await harness();
  const repoPath = "/tmp/boride-her";
  const workspaces = Array.from({ length: 8 }, (_, i) => ({
    id: `ws-${i + 1}`,
    name: `step-${i + 1}`,
    repoPath,
    repoName: "硼化物析氢",
    worktreePath: `/tmp/wt/step-${i + 1}`,
    branch: `ccode/step-${i + 1}`,
    baseBranch: "master",
    portBase: 4000 + i * 10,
    status: "active",
    createdAt: "2026-11-20T00:00:00Z",
  }));
  let driftInFlight = 0;
  let maxDrift = 0;
  let driftDone = 0;
  let healthInFlight = 0;
  let maxHealth = 0;
  let healthDone = 0;

  Object.assign(ui.dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        if (cmd === "list_workspaces") return workspaces;
        if (cmd === "list_projects") {
          return [{ id: "p1", name: "硼化物析氢", path: repoPath, workMode: "research" }];
        }
        if (cmd === "home_dir") return "/tmp";
        if (cmd === "list_schedules") return [];
        if (cmd === "list_help_requests") return [];
        if (cmd === "pending_artifact_checks") return [];
        if (cmd === "read_project_config") return { config: { steps: [], resources: [], settings: [] }, warnings: [] };
        if (cmd === "workspace_settings") return { setup: [], teardown: [], run: [], env: [] };
        if (cmd === "workspace_drift") {
          driftInFlight += 1;
          maxDrift = Math.max(maxDrift, driftInFlight);
          await new Promise((r) => setTimeout(r, 5));
          driftInFlight -= 1;
          driftDone += 1;
          return { healthy: true, canRemount: false, canRelocate: false, canMarkArchived: false, canCleanRecord: true, canResolveMerge: false, issues: [] };
        }
        if (cmd === "workspace_health") {
          healthInFlight += 1;
          maxHealth = Math.max(maxHealth, healthInFlight);
          await new Promise((r) => setTimeout(r, 5));
          healthInFlight -= 1;
          healthDone += 1;
          return { uncommitted: false, ahead: 0, behind: 0, conflict: false, conflictFiles: [], mainOffBase: false, mainDirty: false, staleBase: false, readyToMerge: false, gitdirDetached: false, ledgerPending: false, staleLock: false, mainBranch: "master" };
        }
        return [];
      },
    },
  });

  try {
    ui.useAppStore.setState({ page: "workspaces", selectProjectReq: null });
    await ui.act(async () => {
      ui.root.render(ui.createElement(ui.WorkspacesPage, { visible: true }));
    });
    for (let i = 0; i < 40 && healthDone < workspaces.length; i += 1) {
      await ui.act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    assert.equal(driftDone, workspaces.length);
    assert.equal(healthDone, workspaces.length);
    assert.ok(maxDrift > 0 && maxDrift <= 4, `workspace_drift 并发应不超过 4，实际 ${maxDrift}`);
    assert.ok(maxHealth > 0 && maxHealth <= 3, `workspace_health 并发应不超过 3，实际 ${maxHealth}`);

    const failedState = ui.workspaceState(
      workspaces[0],
      undefined,
      { healthy: true, canRemount: false, canRelocate: false, canMarkArchived: false, canCleanRecord: true, canResolveMerge: false, issues: [] },
      "启动进程失败: Too many open files (os error 24)",
      false,
    );
    assert.equal(failedState.label, "检查失败");
    assert.ok(
      failedState.details.some((d: string) => d.includes("Too many open files")),
      `失败详情应包含具体错误原因，实际：${failedState.details.join(" | ")}`,
    );
  } finally {
    await ui.close();
  }
});
