import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import type { ProjectAgentProfile, ProjectAgentTaskRef } from "../src/project-agents.ts";
import type { ProjectDto } from "../src/types.ts";

const bundle = await build({
  stdin: {
    contents: `export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as View} from './src/components/ProjectAgentsView';`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [{ name: "store-boundary", setup(b) {
    b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: "store", namespace: "test-store" }));
    b.onLoad({ filter: /.*/, namespace: "test-store" }, () => ({
      contents: "export const useAppStore = selector => selector(window.__projectAgentsStore);",
      loader: "js",
    }));
  } }],
});

const profiles: ProjectAgentProfile[] = [
  { id: "codex-a", agent: "codex", name: "Codex-GPT-6", models: ["gpt-6-astra"] },
  { id: "codex-b", agent: "codex", name: "科研 · 精读", models: ["gpt-6-astra-review"] },
  { id: "gemini-a", agent: "gemini", name: "Zeta", models: ["deepseek-v4-flash-0731"] },
  { id: "qwen-a", agent: "qwen", name: "CLI", models: [] },
  { id: "open-a", agent: "opencode", name: "Zeta-1", models: ["kimi-k3"] },
  { id: "kimi-a", agent: "kimi", name: "Zeta-1", models: ["kimi-k3"] },
  { id: "grok-a", agent: "grok", name: "Zeta-1", models: ["kimi-k3"] },
];

async function renderView(options: {
  profiles?: ProjectAgentProfile[];
  project?: Partial<ProjectDto>;
  tasks?: ProjectAgentTaskRef[];
  write?: (command: string) => Promise<void>;
} = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const calls: Array<{ command: string; args: unknown }> = [];
  const changes: ProjectDto[] = [];
  const errors: string[] = [];
  const pages: string[] = [];
  let openGoals = 0;
  Object.assign(dom.window, {
    __projectAgentsStore: {
      profiles: options.profiles ?? profiles,
      settings: { hiddenProfiles: [] },
      setPage: (page: string) => pages.push(page),
    },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => {
        calls.push({ command, args });
        if (command === "task_list") return options.tasks ?? [];
        // B1 流程步骤组：挂载读一次步骤清单（组件 catch 降级，这里正常回）
        if (command === "read_project_config") {
          return { config: { steps: options.pipelineSteps ?? [] }, warnings: [] };
        }
        if (["set_project_default_agent", "set_project_default_profile"].includes(command)) {
          await options.write?.(command);
          return;
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
    },
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url), compiled, compiled.exports,
  );
  const { createElement: h, act, createRoot, View } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  await act(async () => root.render(h(View, {
    project: {
      path: "/project", workMode: "coding", defaultAgent: "codex",
      defaultProfiles: { codex: "codex-a", gemini: "gemini-a" }, ...options.project,
    },
    onProjectChanged: (project: ProjectDto) => changes.push(project),
    onError: (message: string) => errors.push(message),
    onOpenGoals: () => { openGoals++; },
  })));
  // 挂载期的 read_project_config 不算交互：清零后既有断言（展示不写配置等）语义不变
  calls.length = 0;
  const button = (label: string) => {
    const found = Array.from(host.querySelectorAll("button")).find((item) =>
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
    );
    assert.ok(found, `缺少按钮：${label}`);
    return found;
  };
  return {
    dom, host, act, button, calls, changes, errors, pages,
    get openGoals() { return openGoals; },
    click: async (label: string) => act(async () => button(label).click()),
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

test("Agents 名册保留两列断点，默认操作常驻，连接名与模型分行", async () => {
  const view = await renderView();
  try {
    const list = view.host.querySelector('[aria-label="项目 Agent 名册"]')!;
    assert.ok(list.classList.contains("md:grid-cols-2"));
    assert.ok(list.classList.contains("grid-cols-1"));
    assert.equal(list.children.length, 6);
    for (const row of Array.from(list.children)) {
      assert.ok(row.classList.contains("min-w-0"));
      const action = row.querySelector('[aria-pressed]')!;
      assert.ok(!action.className.includes("opacity-0"), "默认操作不再依赖悬停");
    }
    assert.ok(list.children[0].classList.contains("bg-seg-sel"));
    const connection = view.button("更换 Codex 的项目连接");
    assert.equal(connection.querySelector(".font-medium")!.textContent, "Codex-GPT-6");
    assert.equal(connection.querySelector(".text-l3")!.textContent, "gpt-6-astra");
    assert.ok(connection.querySelectorAll(".block.truncate").length === 2);
    assert.match(view.button("更换 Qwen Code 的项目连接").textContent!, /CLI 默认/);
    assert.match(view.host.textContent!, /默认选择仅对本项目生效。/);
    assert.ok(!view.host.textContent!.includes("在工作树里选谁开工"));
    assert.equal(view.calls.length, 0, "展示名册不写配置，编程页不轮询声明目标");
    await view.click("管理连接");
    assert.deepEqual(view.pages, ["profiles"]);
  } finally {
    await view.close();
  }
});

test("默认 Agent 的设置和取消仅调用项目接口，不改变各家的连接", async () => {
  const view = await renderView();
  try {
    await view.click("将 Gemini CLI 设为项目默认");
    assert.deepEqual(view.calls, [{
      command: "set_project_default_agent", args: { projectRoot: "/project", agent: "gemini" },
    }]);
    assert.equal(view.host.querySelectorAll('[aria-pressed="true"]').length, 1);
    assert.equal(view.button("取消 Gemini CLI 的项目默认").textContent, "项目默认");
    assert.deepEqual(view.changes.at(-1)!.defaultProfiles, { codex: "codex-a", gemini: "gemini-a" });
    await view.click("取消 Gemini CLI 的项目默认");
    assert.equal(view.host.querySelectorAll('[aria-pressed="true"]').length, 0);
    assert.deepEqual(view.calls.at(-1), {
      command: "set_project_default_agent", args: { projectRoot: "/project", agent: null },
    });
    assert.equal(view.changes.at(-1)!.defaultAgent, null);
  } finally {
    await view.close();
  }
});

test("连接菜单分行显示并保持原有选择、回退和保存范围", async () => {
  const view = await renderView({ project: { defaultProfiles: { gemini: "gemini-a" } } });
  try {
    const trigger = view.button("更换 Codex 的项目连接");
    assert.match(trigger.textContent!, /Codex-GPT-6/, "未绑定时仍展示第一条连接");
    await view.click("更换 Codex 的项目连接");
    const menu = view.host.querySelector('[role="listbox"]')!;
    assert.ok(menu.classList.contains("max-h-64"));
    assert.ok(menu.classList.contains("inset-x-0"));
    assert.ok(menu.classList.contains("z-50"));
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    assert.equal(items[0].getAttribute("aria-selected"), "true");
    assert.equal(items[1].querySelector(".font-medium")!.textContent, "科研 · 精读");
    assert.equal(items[1].querySelector(".text-l3")!.textContent, "gpt-6-astra-review");
    await view.act(async () => items[1].click());
    assert.equal(view.host.querySelector('[role="listbox"]'), null);
    assert.equal(trigger.querySelector(".font-medium")!.textContent, "科研 · 精读");
    assert.deepEqual(view.calls, [{
      command: "set_project_default_profile",
      args: {
        projectRoot: "/project",
        agent: "codex",
        profileId: "codex-b",
        model: "gpt-6-astra-review",
      },
    }]);
    assert.equal(view.changes.at(-1)!.defaultAgent, "codex");
    assert.deepEqual(view.changes.at(-1)!.defaultProfiles, { codex: "codex-b", gemini: "gemini-a" });
    assert.deepEqual(view.changes.at(-1)!.defaultModels, { codex: "gpt-6-astra-review" });
    await view.click("更换 Gemini CLI 的项目连接");
    assert.equal(view.host.querySelectorAll('[role="option"]').length, 1, "单连接仍能打开菜单");
    await view.click("去连接页添加");
    assert.deepEqual(view.pages, ["profiles"]);
    assert.equal(view.calls.length, 1);
  } finally {
    await view.close();
  }
});

test("同一条连接的其他模型可以点选，不再只留第一个", async () => {
  const view = await renderView({
    profiles: profiles.map((profile) =>
      profile.id === "grok-a"
        ? { ...profile, name: "Test", models: ["deepseek-v4-flash-0731", "deepseek-v4.1-flash"] }
        : profile,
    ),
    project: { defaultProfiles: { grok: "grok-a" }, defaultModels: { grok: "deepseek-v4-flash-0731" } },
  });
  try {
    const trigger = view.button("更换 Grok Build 的项目连接");
    assert.match(trigger.textContent!, /deepseek-v4-flash-0731/);
    await view.click("更换 Grok Build 的项目连接");
    const items = Array.from(view.host.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    assert.deepEqual(items.map((item) => item.querySelector(".text-l3")!.textContent), [
      "deepseek-v4-flash-0731",
      "deepseek-v4.1-flash",
    ]);
    assert.equal(items[0].getAttribute("aria-selected"), "true");
    assert.equal(items[1].getAttribute("aria-selected"), "false");
    await view.act(async () => items[1].click());
    assert.equal(trigger.querySelector(".text-l3")!.textContent, "deepseek-v4.1-flash");
    assert.deepEqual(view.calls, [{
      command: "set_project_default_profile",
      args: {
        projectRoot: "/project",
        agent: "grok",
        profileId: "grok-a",
        model: "deepseek-v4.1-flash",
      },
    }]);
    assert.deepEqual(view.changes.at(-1)!.defaultModels, { grok: "deepseek-v4.1-flash" });
  } finally {
    await view.close();
  }
});

test("连接菜单支持 Escape 归还焦点与点击外部关闭", async () => {
  const view = await renderView();
  try {
    await view.click("更换 Codex 的项目连接");
    await view.act(async () => {
      const option = view.host.querySelector<HTMLButtonElement>('[role="option"]')!;
      option.focus();
      option.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(view.host.querySelector('[role="listbox"]'), null);
    assert.equal(view.dom.window.document.activeElement, view.button("更换 Codex 的项目连接"));
    await view.click("更换 Codex 的项目连接");
    await view.act(async () => view.host.dispatchEvent(new view.dom.window.MouseEvent("mousedown", { bubbles: true })));
    assert.equal(view.host.querySelector('[role="listbox"]'), null);
    assert.equal(view.calls.length, 0);
  } finally {
    await view.close();
  }
});

test("保存中的默认操作和已打开菜单都禁用，失败不冒充成功", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const view = await renderView({ write: () => pending });
  try {
    await view.click("更换 Codex 的项目连接");
    await view.click("将 Gemini CLI 设为项目默认");
    assert.ok(view.button("更换 Codex 的项目连接").disabled);
    assert.ok(view.button("将 Gemini CLI 设为项目默认").disabled);
    const option = view.host.querySelector<HTMLButtonElement>('[role="option"]')!;
    assert.ok(option.disabled);
    await view.act(async () => option.click());
    assert.equal(view.calls.length, 1);
    await view.act(async () => finish());
    assert.ok(!view.button("更换 Codex 的项目连接").disabled);
  } finally {
    finish();
    await view.close();
  }
  for (const type of ["agent", "profile"]) {
    const failed = await renderView({ write: async () => { throw new Error("只读项目"); } });
    try {
      if (type === "agent") await failed.click("将 Gemini CLI 设为项目默认");
      else {
        await failed.click("更换 Codex 的项目连接");
        await failed.act(async () => failed.host.querySelectorAll<HTMLButtonElement>('[role="option"]')[1].click());
      }
      assert.equal(failed.changes.length, 0);
      assert.match(failed.errors[0], /失败.*只读项目/);
      assert.equal(failed.button("取消 Codex 的项目默认").getAttribute("aria-pressed"), "true");
      assert.match(failed.button("更换 Codex 的项目连接").textContent!, /Codex-GPT-6/);
    } finally {
      await failed.close();
    }
  }
});

test("空名册保持连接入口，只有真实关联目标才在 Agent 下显示", async () => {
  const empty = await renderView({ profiles: [], project: { defaultAgent: null, defaultProfiles: {} } });
  try {
    assert.match(empty.host.textContent!, /还没有可用连接/);
    await empty.click("去连接页");
    assert.deepEqual(empty.pages, ["profiles"]);
  } finally {
    await empty.close();
  }
  const tasks: ProjectAgentTaskRef[] = [
    { id: "declared", name: "整理文献", status: "running", kind: "free_research", agent: "gemini", inputPaths: [], declared: true },
    { id: "unassigned", name: "起草提纲", status: "pending", kind: "free_research", agent: null, inputPaths: [], declared: true },
    { id: "internal", name: "内部运行", status: "running", kind: "free_research", agent: "codex", inputPaths: [], declared: false },
  ];
  const assigned = await renderView({ profiles: [], tasks, project: { workMode: "research", defaultAgent: null } });
  try {
    assert.match(assigned.host.textContent!, /Gemini CLI/);
    assert.match(assigned.host.textContent!, /还没有连接/);
    assert.match(assigned.host.textContent!, /整理文献进行中/);
    assert.ok(!assigned.host.textContent!.includes("内部运行"));
    assert.match(assigned.host.textContent!, /还没指定 Agent 的目标起草提纲/);
    await assigned.click("整理文献");
    assert.equal(assigned.openGoals, 1);
    assert.ok(assigned.calls.every(({ command }) => command === "task_list"));
  } finally {
    await assigned.close();
  }
});
