import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import type { ProjectConfigDto, SkillDto } from "../src/types.ts";

const bundle = await build({
  stdin: {
    contents: `export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Panel} from './src/components/ProjectRulesPanel';`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
});

const skills = [
  { id: "search", name: "lit-search", description: "文献检索与筛选规范" },
  { id: "notes", name: "lit-notes", description: "精读文献并整理笔记" },
  { id: "deploy", name: "netlify-deploy", description: "Deploy web projects to Netlify" },
] as SkillDto[];

async function renderPanel(options: {
  config?: Partial<ProjectConfigDto>;
  library?: SkillDto[] | Promise<SkillDto[]>;
  libraryError?: boolean;
  saveError?: boolean;
  picked?: string[] | null;
  entries?: { name: string; isDir: boolean }[];
  onPreviewFile?: (relPath: string) => void;
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
  let disk: ProjectConfigDto = {
    artifactDir: "output",
    resources: [],
    steps: [],
    workMode: "research",
    rulesOwned: true,
    settings: ["保留用户规则"],
    protectedPaths: [],
    skills: [],
    ...options.config,
  };
  const writes: ProjectConfigDto[] = [];
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { config?: ProjectConfigDto }) => {
        if (command === "read_project_config") return { config: disk };
        if (command === "list_dir") return options.entries ?? [
          { name: "papers", isDir: true },
          { name: "notes", isDir: true },
          { name: "source.pdf", isDir: false },
        ];
        if (command === "list_skills") {
          if (options.libraryError) throw new Error("技能库不可读");
          return options.library ?? skills;
        }
        if (command === "write_project_config") {
          if (options.saveError) throw new Error("只读项目");
          disk = structuredClone(args.config!);
          writes.push(disk);
          return;
        }
        if (command === "plugin:dialog|open") return options.picked ?? null;
        throw new Error(`Unexpected IPC: ${command}`);
      },
    },
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url), compiled, compiled.exports,
  );
  const { createElement: h, act, createRoot, Panel } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  await act(async () => root.render(h(Panel, {
    projectPath: "/project", workMode: disk.workMode, defaultOpen: true, compact: true,
    onPreviewFile: options.onPreviewFile,
  })));
  const button = (label: string) => {
    const found = Array.from(host.querySelectorAll("button")).find((item) =>
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
    );
    assert.ok(found, `缺少按钮：${label}`);
    return found;
  };
  const click = async (label: string) => act(async () => button(label).click());
  const search = async (value: string) => {
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    assert.ok(input, "搜索框应已展开");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const close = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { dom, host, act, button, click, search, close, writes };
}

test("项目技能：名称/描述搜索、分行呈现、增删只改项目绑定", async () => {
  const panel = await renderPanel({ config: { protectedPaths: ["papers"] } });
  const { host, click, search, writes } = panel;
  try {
    await click("技能未添加");
    await click("从技能库添加");
    assert.equal(host.ownerDocument.activeElement, host.querySelector('input[type="search"]'));
    await search(" LIT-SEARCH ");
    const add = panel.button("添加技能 lit-search");
    assert.equal(host.querySelectorAll('[aria-label="可添加的技能"] button').length, 1);
    assert.equal(add.querySelector(".font-medium")!.textContent, "lit-search");
    assert.equal(add.querySelector(".line-clamp-2")!.textContent, "文献检索与筛选规范");
    await search("精读");
    panel.button("添加技能 lit-notes");
    await search("not-found");
    assert.match(host.querySelector('[role="status"]')!.textContent!, /没有找到匹配/);
    await search("检索");
    await click("添加技能 lit-search");
    assert.equal(host.querySelector('input[type="search"]'), null);
    assert.equal(host.ownerDocument.activeElement, panel.button("从技能库添加"));
    assert.deepEqual(writes.at(-1)!.skills, ["lit-search"]);
    assert.deepEqual(writes.at(-1)!.protectedPaths, ["papers"]);
    assert.deepEqual(writes.at(-1)!.settings, ["保留用户规则"]);
    assert.match(host.querySelector('[aria-label="已添加的技能"]')!.textContent!, /lit-search/);
    await click("从技能库添加");
    assert.ok(!host.querySelector('[aria-label="添加技能 lit-search"]'), "已添加项不再重复列出");
    await click("移出 lit-search");
    assert.deepEqual(writes.at(-1)!.skills, []);
    assert.ok(host.querySelector('[aria-label="添加技能 lit-search"]'), "移出项目后仍可从库中重新添加");
  } finally {
    await panel.close();
  }
});

test("项目技能：Esc 收起搜索并返回添加按钮，不触发外层关闭", async () => {
  const panel = await renderPanel();
  try {
    await panel.click("技能未添加");
    await panel.click("从技能库添加");
    await panel.search("筛选");
    let escaped = false;
    panel.dom.window.document.addEventListener("keydown", () => { escaped = true; });
    await panel.act(async () => panel.host.querySelector("input")!.dispatchEvent(
      new panel.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ));
    assert.equal(escaped, false);
    assert.equal(panel.host.querySelector('input[type="search"]'), null);
    assert.equal(panel.host.ownerDocument.activeElement, panel.button("从技能库添加"));
    assert.equal(panel.writes.length, 0);
    await panel.click("从技能库添加");
    assert.equal(panel.host.querySelector<HTMLInputElement>('input[type="search"]')!.value, "");
  } finally {
    await panel.close();
  }
});

test("写回跳过：整行勾选、展开其余目录、添加子目录文件立即可见且排除项目外文件", async () => {
  const panel = await renderPanel({
    entries: [{ name: "data", isDir: true }, { name: "papers", isDir: true }],
    config: { skills: ["lit-notes"] },
    picked: ["/project/papers/source.pdf", "/elsewhere/private.pdf"],
  });
  try {
    await panel.click("写回时跳过未设置");
    assert.equal(panel.host.querySelectorAll("label").length, 1, "建议目录优先，不自动全选");
    await panel.act(async () => panel.host.querySelector("label")!.click());
    assert.deepEqual(panel.writes.at(-1)!.protectedPaths, ["data"]);
    panel.button("写回时跳过已选 1 项");
    await panel.click("显示其余 1 个文件夹");
    assert.equal(panel.host.querySelectorAll("label").length, 2);
    await panel.click("添加文件");
    assert.deepEqual(panel.writes.at(-1)!.protectedPaths, ["data", "papers/source.pdf"]);
    assert.deepEqual(panel.writes.at(-1)!.skills, ["lit-notes"]);
    const file = panel.host.querySelector<HTMLLabelElement>('[aria-label="写回时跳过的文件"] label')!;
    assert.equal(file.textContent!.replace("✓", ""), "papers/source.pdf");
    assert.ok(file.querySelector("input")!.checked);
    await panel.act(async () => file.click());
    assert.deepEqual(panel.writes.at(-1)!.protectedPaths, ["data"]);
    assert.equal(panel.host.querySelector('[aria-label="写回时跳过的文件"]'), null);
  } finally {
    await panel.close();
  }
});

test("项目设置：空目录、空技能库、技能全部添加与读取失败均有明确状态", async () => {
  for (const variant of ["empty", "all", "error"] as const) {
    const panel = await renderPanel({
      entries: [],
      library: variant === "empty" ? [] : skills,
      libraryError: variant === "error",
      config: { skills: variant === "all" ? skills.map((skill) => skill.name) : [] },
    });
    try {
      await panel.click("写回时跳过未设置");
      assert.match(panel.host.textContent!, /还没有可勾选/);
      await panel.click("添加文件");
      assert.equal(panel.writes.length, 0, "取消文件选择不保存");
      await panel.click(variant === "all" ? "技能已添加 3 个" : "技能未添加");
      if (variant === "empty") assert.match(panel.host.textContent!, /技能库为空/);
      if (variant === "all") assert.ok(panel.button("技能库中的技能已全部添加").disabled);
      if (variant === "error") assert.match(panel.host.querySelector('[role="alert"]')!.textContent!, /读取技能库失败/);
    } finally {
      await panel.close();
    }
  }
});

test("项目设置：保留研究流程/编程分流与保存失败反馈", async () => {
  for (const mode of ["research", "coding", "office"] as const) {
    const panel = await renderPanel({
      config: { workMode: mode, steps: mode === "research" ? [{ name: "精读" } as ProjectConfigDto["steps"][number]] : [] },
      saveError: mode === "office",
    });
    try {
      const text = panel.host.textContent!;
      if (mode === "research") {
        assert.ok(!text.includes("写回时跳过"));
        assert.ok(!text.includes("技能"));
      } else if (mode === "coding") {
        assert.ok(!text.includes("写回时跳过"));
        assert.ok(!text.includes("技能"));
      } else {
        await panel.click("技能未添加");
        await panel.click("从技能库添加");
        await panel.click("添加技能 lit-search");
        assert.match(panel.host.textContent!, /保存项目规则失败.*只读项目/);
        assert.ok(!panel.host.textContent!.includes("已保存"));
        assert.equal(panel.writes.length, 0);
      }
    } finally {
      await panel.close();
    }
  }
});


test("项目技能：读取中不冒充空库，完成后展示真实内容", async () => {
  let finish!: (value: SkillDto[]) => void;
  const library = new Promise<SkillDto[]>((resolve) => { finish = resolve; });
  const panel = await renderPanel({ library });
  try {
    await panel.click("技能未添加");
    assert.match(panel.host.querySelector('[role="status"]')!.textContent!, /正在读取技能库/);
    assert.ok(!panel.host.textContent!.includes("技能库为空"));
    await panel.act(async () => finish(skills));
    assert.equal(panel.host.querySelector('[role="status"]'), null);
    await panel.click("从技能库添加");
    assert.equal(panel.host.querySelectorAll('[aria-label="可添加的技能"] button').length, skills.length);
  } finally {
    await panel.close();
  }
});

test("写回跳过：已有子目录文件可见，尾斜线和 Windows 分隔符不产生重复文件夹行", async () => {
  const panel = await renderPanel({ config: { protectedPaths: ["papers/", "notes\\source.pdf"] } });
  try {
    await panel.click("写回时跳过已选 2 项");
    const fileRows = panel.host.querySelectorAll('[aria-label="写回时跳过的文件"] label');
    assert.equal(fileRows.length, 1);
    assert.equal(fileRows[0].textContent!.replace("✓", ""), "notes\\source.pdf");
    assert.equal(panel.host.querySelectorAll('[aria-label="写回时跳过的文件夹"] label').length, 2);
    await panel.act(async () => (fileRows[0] as HTMLLabelElement).click());
    assert.deepEqual(panel.writes.at(-1)!.protectedPaths, ["papers/"]);
  } finally {
    await panel.close();
  }
});

test("项目规则：待定占位拆分为独立填写行、保留科研工具隐藏键、检测仓库 AGENTS.md", async () => {
  const previewed: string[] = [];
  const panel = await renderPanel({
    config: {
      workMode: "coding",
      settings: ["目标期刊：（待填）", "科研工具/manuscript：word", "遵循既有风格"],
    },
    entries: [
      { name: "AGENTS.md", isDir: false },
      { name: "src", isDir: true },
    ],
    onPreviewFile: (rel) => previewed.push(rel),
  });
  try {
    assert.match(panel.host.textContent!, /检测到仓库自带 AGENTS\.md/);
    await panel.click("查看 AGENTS.md");
    assert.deepEqual(previewed, ["AGENTS.md"]);

    const textarea = panel.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="项目规则"]')!;
    assert.equal(textarea.value, "遵循既有风格", "机器键与待填项不混进自由文本框");

    const slotInput = panel.host.querySelector<HTMLInputElement>('input[aria-label="设定项 目标期刊"]')!;
    assert.ok(slotInput);
    await panel.act(async () => {
      Object.getOwnPropertyDescriptor(panel.dom.window.HTMLInputElement.prototype, "value")!.set!.call(slotInput, "Nature Catalysis");
      slotInput.dispatchEvent(new panel.dom.window.Event("input", { bubbles: true }));
    });
    await panel.act(async () => {
      slotInput.focus();
      slotInput.blur();
    });
    assert.deepEqual(panel.writes.at(-1)!.settings, [
      "目标期刊：Nature Catalysis",
      "遵循既有风格",
      "科研工具/manuscript：word",
    ]);
  } finally {
    await panel.close();
  }
});
