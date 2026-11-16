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
      contents: "export const useAppStore = selector => selector(window.__projectAgentsStore); export const selectHiddenProfiles = s => s.settings?.hiddenProfiles ?? [];",
      loader: "js",
    }));
    // AgentIcon 的厂商图标以 ?raw 内联，测试里桩成空 svg 字符串
    b.onResolve({ filter: /\.svg\?raw$/ }, (args) => ({ path: args.path, namespace: "svg-raw" }));
    b.onLoad({ filter: /.*/, namespace: "svg-raw" }, () => ({ contents: `export default "<svg></svg>";`, loader: "js" }));
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
  pipelineSteps?: { name: string; skills?: string[] }[];
  combo?: { injectEffortAllowed?: boolean; effortLevels?: string[] };
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
        if (command === "list_schedules") return [];
        if (command === "agent_capabilities") return [];
        if (command === "coding_overview") return { worktrees: [] };
        // B1 流程步骤组：挂载读一次步骤清单（组件 catch 降级，这里正常回）
        if (command === "read_project_config") {
          return { config: { steps: options.pipelineSteps ?? [] }, warnings: [] };
        }
        if (command === "combo_surface") {
          return options.combo ?? { injectEffortAllowed: true, effortLevels: ["low", "medium", "high"] };
        }
        if (command === "model_capabilities") {
          return [];
        }
        if (
          [
            "set_project_default_agent",
            "set_project_default_profile",
            "set_project_agent_binding",
          ].includes(command)
        ) {
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

test("本项目默认聚光灯卡置顶展示当前连接与模型，其余家收为快速切换胶囊", async () => {
  const view = await renderView();
  try {
    const spotlight = view.host.querySelector('[aria-label="项目 Agent 名册"]')!;
    assert.ok(spotlight.classList.contains("ccode-well"));
    assert.match(spotlight.textContent!, /Codex/);
    assert.match(spotlight.textContent!, /Codex-GPT-6 \/ gpt-6-astra/);
    assert.match(spotlight.textContent!, /切换默认到：/);
    assert.equal(view.button("更换 Codex 的项目连接").textContent?.trim(), "换默认模型");
    assert.equal(view.button("取消 Codex 的项目默认").getAttribute("aria-pressed"), "true");
    // 其余 ≤5 家收在底部单行精简胶囊：胶囊内只写 Agent 名（不再塞模型串造成杂乱），连接与模型放在悬停说明
    assert.equal(view.button("将 Qwen Code 设为项目默认").textContent?.trim(), "Qwen Code");
    assert.match(view.button("将 Qwen Code 设为项目默认").getAttribute("title") ?? "", /CLI \/ CLI 默认/);
    assert.equal(view.button("将 Gemini CLI 设为项目默认").textContent?.trim(), "Gemini CLI");
    assert.match(view.button("将 Gemini CLI 设为项目默认").getAttribute("title") ?? "", /Zeta \/ deepseek-v4-flash-0731/);
    assert.match(view.host.textContent!, /默认选择仅对本项目生效。/);
    assert.ok(!view.host.textContent!.includes("在工作树里选谁开工"));
    assert.equal(view.calls.length, 0, "展示名册不写配置，编程页不轮询声明目标");
    await view.click("管理连接");
    assert.deepEqual(view.pages, ["profiles"]);
  } finally {
    await view.close();
  }

  // 十家全配齐（其余 9 家 > 5）：底栏只露前 4 家常用一等 CLI +「更多 5 家」菜单，不铺成两排杂乱胶囊
  const tenProfiles: ProjectAgentProfile[] = [
    { id: "cc-1", agent: "claude-code", name: "GLM", models: ["glm-5.3"] },
    { id: "cx-1", agent: "codex", name: "GLM", models: ["glm-5.3"] },
    { id: "gm-1", agent: "gemini", name: "G", models: ["gemini-4-argon"] },
    { id: "qw-1", agent: "qwen", name: "GLM", models: ["glm-5.3"] },
    { id: "oc-1", agent: "opencode", name: "CLI", models: [] },
    { id: "km-1", agent: "kimi", name: "GLM", models: ["glm-5.3"] },
    { id: "cb-1", agent: "codebuddy", name: "GLM", models: ["glm-5.3"] },
    { id: "cu-1", agent: "cursor", name: "Auto", models: ["auto"] },
    { id: "gk-1", agent: "grok", name: "GLM", models: ["glm-5.3"] },
    { id: "ag-1", agent: "agy", name: "G", models: ["gemini-4-carbon"] },
  ];
  const full = await renderView({
    profiles: tenProfiles,
    project: { defaultAgent: "claude-code", defaultProfiles: { "claude-code": "cc-1" } },
  });
  try {
    assert.ok(full.button("展开其余 5 家 Agent").textContent?.includes("更多 5 家"));
    assert.equal(full.host.querySelector('[role="menu"]'), null);
    await full.click("展开其余 5 家 Agent");
    const menu = full.host.querySelector('[role="menu"][aria-label="其余可用 Agent"]')!;
    assert.ok(menu);
    assert.match(menu.textContent!, /Grok Build/);
    await full.click("将 Grok Build 设为项目默认");
    assert.equal(full.host.querySelector('[role="menu"]'), null);
    assert.deepEqual(full.calls.at(-1), {
      command: "set_project_default_agent",
      args: { projectRoot: "/project", agent: "grok" },
    });
  } finally {
    await full.close();
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
    const spotlight = view.host.querySelector('[aria-label="项目 Agent 名册"]')!;
    assert.match(spotlight.textContent!, /Codex-GPT-6 \/ gpt-6-astra/, "未绑定时仍展示第一条连接");
    await view.click("更换 Codex 的项目连接");
    const menu = view.host.querySelector('[role="listbox"]')!;
    assert.ok(menu.classList.contains("max-h-64"));
    assert.ok(menu.classList.contains("right-0"));
    assert.ok(menu.classList.contains("z-50"));
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    assert.equal(items[0].getAttribute("aria-selected"), "true");
    assert.equal(items[1].querySelector(".font-medium")!.textContent, "科研 · 精读");
    assert.equal(items[1].querySelector(".text-l3")!.textContent, "gpt-6-astra-review");
    await view.act(async () => items[1].click());
    assert.equal(view.host.querySelector('[role="listbox"]'), null);
    assert.match(spotlight.textContent!, /科研 · 精读 \/ gpt-6-astra-review/);
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
    await view.click("将 Gemini CLI 设为项目默认");
    await view.click("更换 Gemini CLI 的项目连接");
    assert.equal(view.host.querySelectorAll('[role="option"]').length, 1, "单连接仍能打开菜单");
    await view.click("去连接页添加");
    assert.deepEqual(view.pages, ["profiles"]);
    assert.equal(view.calls.length, 2);
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
    project: {
      defaultAgent: "grok",
      defaultProfiles: { grok: "grok-a" },
      defaultModels: { grok: "deepseek-v4-flash-0731" },
    },
  });
  try {
    const spotlight = view.host.querySelector('[aria-label="项目 Agent 名册"]')!;
    assert.match(spotlight.textContent!, /Test \/ deepseek-v4-flash-0731/);
    await view.click("更换 Grok Build 的项目连接");
    const items = Array.from(view.host.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    assert.deepEqual(items.map((item) => item.querySelector(".text-l3")!.textContent), [
      "deepseek-v4-flash-0731",
      "deepseek-v4.1-flash",
    ]);
    assert.equal(items[0].getAttribute("aria-selected"), "true");
    assert.equal(items[1].getAttribute("aria-selected"), "false");
    await view.act(async () => items[1].click());
    assert.match(spotlight.textContent!, /Test \/ deepseek-v4\.1-flash/);
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
    assert.ok(!view.button("更换 Gemini CLI 的项目连接").disabled);
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
      assert.match(failed.host.querySelector('[aria-label="项目 Agent 名册"]')!.textContent!, /Codex-GPT-6/);
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


test("目标绑定连接已删：卡片如实标「已失效」，不再显示伪当前", async () => {
  const tasks: ProjectAgentTaskRef[] = [
    { id: "g1", name: "整理周报", status: "pending", kind: "office_doc", agent: "gemini", profileId: "ghost-profile", inputPaths: [], declared: true },
  ];
  const view = await renderView({
    tasks,
    project: { workMode: "office", defaultAgent: null },
  });
  try {
    assert.match(view.host.textContent!, /整理周报/);
    assert.match(view.host.textContent!, /已失效/);
    assert.match(view.host.textContent!, /连接已删除，可清除或换绑/);
    assert.ok(!view.host.textContent!.includes("已指定"), "死引用不再显示「已指定」伪状态");
  } finally {
    await view.close();
  }
});

test("没设默认时如实说开始时再选；跟随项目默认只说一次；设了默认的那家置顶聚光灯展示", async () => {
  const none = await renderView({ project: { workMode: "research", defaultAgent: null, defaultProfiles: {} } });
  try {
    assert.match(none.host.textContent!, /还没设默认：点「开始」或开对话时再选/);
    assert.match(none.host.textContent!, /还没设项目默认/);
    assert.ok(!none.host.textContent!.includes("跟随默认"), "卡片右上角不再挂「跟随默认」");
  } finally {
    await none.close();
  }
  const gem = await renderView({ project: { defaultAgent: "gemini" } });
  try {
    const spotlight = gem.host.querySelector('[aria-label="项目 Agent 名册"]')!;
    assert.match(spotlight.querySelector("h3")!.textContent!, /Gemini CLI/);
    assert.ok(spotlight.classList.contains("ccode-well"));
    assert.match(gem.host.textContent!, /默认选择仅对本项目生效。/);
  } finally {
    await gem.close();
  }
});

test("专属绑定筛选面板：按 Agent→连接→模型分层选择，并支持提前预设思考强度与权限档位", async () => {
  const view = await renderView({
    project: {
      workMode: "research",
      defaultAgent: "codex",
      defaultProfiles: { codex: "codex-a" },
    },
    pipelineSteps: [{ name: "综述大纲", skills: ["review-framework"] }],
  });
  try {
    // 1. 打开「项目对话」专属绑定筛选面板
    await view.click("更换 项目对话 的项目连接");
    const dialog = view.host.querySelector('[role="dialog"][aria-label="项目对话 的项目连接"]')!;
    assert.ok(dialog, "应打开专属绑定分层筛选面板");
    assert.match(dialog.textContent!, /筛选 Agent/);
    assert.match(dialog.textContent!, /思考强度预设/);
    assert.match(dialog.textContent!, /权限预设/);

    // 2. 同家（Codex）有两条连接时显示切换胶囊，点选「科研 · 精读」立即绑定
    const connBtn = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "科研 · 精读",
    )!;
    assert.ok(connBtn, "应显示同家连接胶囊「科研 · 精读」");
    await view.act(async () => connBtn.click());

    // 3. 预设思考强度 high + 权限「帮我批准」（auto）
    const highBtn = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "high",
    )!;
    await view.act(async () => highBtn.click());

    const autoBtn = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes("帮我批准"),
    )!;
    await view.act(async () => autoBtn.click());

    const saveCalls = view.calls.filter((c) => c.command === "set_project_agent_binding");
    assert.deepEqual(saveCalls.at(-1)?.args, {
      projectRoot: "/project",
      slot: "chat",
      profileId: "codex-b",
      model: "gpt-6-astra-review",
      effort: "high",
      permissionTier: "auto",
    });

    // 卡片触发器第二行展示微标胶囊（权限 + 思考强度）
    const chatTrigger = view.button("更换 项目对话 的项目连接");
    assert.match(chatTrigger.textContent!, /Codex · 科研 · 精读/);
    assert.match(chatTrigger.textContent!, /gpt-6-astra-review/);
    const presetChips = Array.from(chatTrigger.querySelectorAll(".ccode-preset-chip")).map((el) =>
      el.textContent?.trim(),
    );
    assert.deepEqual(presetChips, ["帮我批准", "high"]);

    // 4. 点首行「跟随项目默认」清空绑定与预设
    const clearBtn = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes("跟随项目默认"),
    )!;
    await view.act(async () => clearBtn.click());
    assert.equal(view.host.querySelector('[role="dialog"][aria-label="项目对话 的项目连接"]'), null);
    assert.deepEqual(view.calls.at(-1)?.args, {
      projectRoot: "/project",
      slot: "chat",
      profileId: null,
      model: null,
      effort: null,
      permissionTier: null,
    });

    // 5. 「问 AI / 聊想法」与「项目助手」只显示只读提示，不画写权限按钮；「科研步骤」显示 3 档写权限（不含先出方案）
    await view.click("更换 问 AI / 聊想法 的项目连接");
    const discussDialog = view.host.querySelector('[role="dialog"][aria-label="问 AI / 聊想法 的项目连接"]')!;
    assert.match(discussDialog.textContent!, /思考强度预设/);
    assert.match(discussDialog.textContent!, /固定只读讨论/);
    assert.ok(!discussDialog.textContent!.includes("帮我批准"));

    await view.click("更换 项目助手 的项目连接");
    const assistantDialog = view.host.querySelector('[role="dialog"][aria-label="项目助手 的项目连接"]')!;
    assert.match(assistantDialog.textContent!, /固定只读核查/);
    assert.ok(!assistantDialog.textContent!.includes("思考强度预设"));

    await view.click("更换 综述大纲 的项目连接");
    const stepDialog = view.host.querySelector('[role="dialog"][aria-label="综述大纲 的项目连接"]')!;
    assert.match(stepDialog.textContent!, /请求批准/);
    assert.match(stepDialog.textContent!, /帮我批准/);
    assert.match(stepDialog.textContent!, /完全访问/);
    assert.ok(!stepDialog.textContent!.includes("先出方案"), "科研步骤不提供先出方案档");
  } finally {
    await view.close();
  }
});
