import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import type { SessionMetaDto } from "../src/types.ts";

// 侧栏项目树挂对话（2026-10-23 第一期）：真组件 + 桩掉 store / 开对话入口，看列什么、点了交给谁
const bundle = await build({
  stdin: {
    contents: `export {createElement} from 'react'; export {act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Tree} from './src/components/ProjectTree';`,
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
      name: "boundaries",
      setup(b) {
        b.onResolve({ filter: /^\.\.?\/store$/ }, () => ({ path: "store", namespace: "stub" }));
        b.onResolve({ filter: /quick-chat-launch$/ }, () => ({ path: "launch", namespace: "stub" }));
        b.onResolve({ filter: /\/AskAiModal$/ }, () => ({ path: "askai", namespace: "stub" }));
        b.onResolve({ filter: /\/ConfirmDialog$/ }, () => ({ path: "confirm", namespace: "stub" }));
        b.onLoad({ filter: /^confirm$/, namespace: "stub" }, () => ({
          contents: `
            export const confirmDialog = async (...a) => { window.__calls.push(["confirmDialog", ...a]); return true; };
            export const alertDialog = async () => {};
            export const confirmDialogOpen = () => false;
            export const ConfirmDialogHost = () => null;`,
          loader: "js",
        }));
        b.onLoad({ filter: /^store$/, namespace: "stub" }, () => ({
          contents: `
            const st = () => window.__treeStore;
            export const useAppStore = Object.assign((sel) => sel(st()), {
              getState: st,
              setState: (p) => Object.assign(st(), typeof p === "function" ? p(st()) : p),
            });`,
          loader: "js",
        }));
        b.onLoad({ filter: /^launch$/, namespace: "stub" }, () => ({
          contents: `
            export const openConversation = (...a) => window.__calls.push(["openConversation", ...a]);
            export const openQuickChat = () => window.__calls.push(["openQuickChat"]);
            export const prefetchConversation = () => {};`,
          loader: "js",
        }));
        b.onLoad({ filter: /^askai$/, namespace: "stub" }, () => ({
          contents: `export const startProjectChat = (...a) => window.__calls.push(["startProjectChat", ...a]);`,
          loader: "js",
        }));
      },
    },
  ],
});

function session(over: Partial<SessionMetaDto>): SessionMetaDto {
  return {
    agent: "claude-code",
    sessionId: "s",
    projectPath: "/work/review",
    title: null,
    createdAt: null,
    updatedAt: null,
    filePath: "/f",
    tokenUsage: null,
    cliVersion: null,
    pinned: false,
    archived: false,
    customTitle: null,
    tags: [],
    alive: true,
    chainCount: 1,
    workspace: null,
    stepName: null,
    summary: null,
    live: false,
    source: "cli",
    internal: false,
    handoffFromAgent: null,
    handoffFromSession: null,
    taskId: null,
    taskName: null,
    ...over,
  };
}

const PROJECT = {
  path: "/work/review",
  name: "综述流程测试",
  workMode: "research",
  defaultAgent: "codex",
  defaultProfiles: { codex: "p-codex" },
};

const reviewChats = Array.from({ length: 6 }, (_, i) =>
  session({
    sessionId: `r${i}`,
    agent: i === 1 ? "codex" : "claude-code",
    customTitle: `09${20 + i}|研究|镁硫电池第${i}篇精读`,
    updatedAt: `2026-10-2${i}T00:00:00Z`,
  }),
);

async function renderTree(
  store: Record<string, unknown> = {},
  /** 换掉 list_workspaces 的返回（第几次调用 → 结果）；不给 = 一直空 */
  workspaces?: (call: number) => unknown[],
  opts: { liftCurrent?: boolean } = {},
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const calls: unknown[][] = [];
  let wsCalls = 0;
  const pages: string[] = [];
  const reqs: Record<string, unknown> = {};
  Object.assign(dom.window, {
    __calls: calls,
    __treeStore: {
      projectsVersion: 0,
      projectPaths: [PROJECT.path, "/work/code"],
      terminalRunInputs: [
        {
          tabId: "t1",
          title: "",
          agentId: "claude-code",
          model: "",
          cwd: PROJECT.path,
          running: true,
          shell: false,
          attention: "confirm",
          sessionId: "r5",
        },
      ],
      terminalActiveTabId: "t1",
      page: "terminal",
      sessions: [
        ...reviewChats,
        session({ sessionId: "sc1", projectPath: "/Users/u/ccode/scratch", customTitle: "1023|探索|截图区块内容询问" }),
        session({ sessionId: "gone", alive: false, customTitle: "源文件不在了" }),
      ],
      profiles: [{ id: "p-codex", agent: "codex", models: [] }],
      loadSessions: async () => [],
      setPage: (p: string) => pages.push(p),
      setSessionsProjectPathReq: (p: string) => {
        reqs.projectPath = p;
      },
      setSessionsScratchReq: (on: boolean) => {
        reqs.scratch = on;
      },
      setOpenSessionReq: (r: unknown) => {
        reqs.openSession = r;
      },
      ...store,
    },
    __TAURI_INTERNALS__: {
      transformCallback: () => 0,
      invoke: async (command: string, args?: unknown) => {
        if (command === "set_session_meta") {
          calls.push(["set_session_meta", args]);
          return null;
        }
        if (command === "list_projects") return [PROJECT, { path: "/work/code", name: "Ccode", workMode: "coding" }];
        if (command === "list_workspaces") {
          wsCalls += 1;
          return workspaces ? workspaces(wsCalls) : [];
        }
        throw new Error(`Unexpected IPC: ${command}`);
      },
    },
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
  );
  const { createElement: h, act, createRoot, Tree } = compiled.exports;
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  await act(async () => {
    root.render(h(Tree, { selectedRoot: null, active: false, liftCurrent: opts.liftCurrent, onSelect: (p: string) => pages.push(`project:${p}`) }));
  });
  // 等 list_projects 回来再渲一遍
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const button = (label: string) => {
    const found = Array.from(host.querySelectorAll("button")).find(
      (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === label,
    );
    assert.ok(found, `缺少按钮：${label}`);
    return found!;
  };
  const chatGroup = (name: string) => host.querySelector(`[aria-label="${name} 的对话"]`);
  return {
    host,
    act,
    calls,
    pages,
    reqs,
    button,
    chatGroup,
    wsCalls: () => wsCalls,
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

test("正在聊的项目默认展开：量不到侧栏高度时列 5 段 + 「还有 N 段」，标题去掉日期类型前缀，等确认的那段行尾是琥珀光标", async () => {
  const view = await renderTree();
  try {
    const group = view.chatGroup("综述流程测试");
    assert.ok(group, "当前标签所在的项目应默认展开");
    // 每段后面还有一个只有图标的 ⋯，取有字的按钮
    const rows = Array.from(group!.querySelectorAll("button"))
      .map((b) => b.textContent?.trim())
      .filter(Boolean);
    assert.deepEqual(rows, [
      "镁硫电池第5篇精读",
      "镁硫电池第4篇精读",
      "镁硫电池第3篇精读",
      "镁硫电池第2篇精读",
      "镁硫电池第1篇精读",
      "还有 1 段",
    ]);
    const first = view.button("镁硫电池第5篇精读");
    // 光标在行尾单独那一列，不在标题按钮里（右边这一列不让标题进来）
    assert.equal(first.querySelector(".ccode-run-caret"), null, "标题按钮里不放状态光标");
    const caret = first.parentElement?.querySelector("[data-run-slot] .ccode-run-caret");
    assert.equal(caret?.getAttribute("data-state"), "confirm", "等你确认的那段行尾是琥珀光标（不再是黄点）");
    assert.equal(caret?.getAttribute("aria-label"), "等你确认");
    assert.equal(first.getAttribute("aria-current"), "true", "正看着的这段铺选中底");
    assert.match(first.title, /0925\|研究\|镁硫电池第5篇精读/, "完整标题在悬停里");
    // 随手聊没在聊，收着
    assert.equal(view.chatGroup("随手聊"), null);
  } finally {
    await view.close();
  }
});

test("点一段对话交给 openConversation，项目给这家设的连接一并带上；源文件不在的不列", async () => {
  const view = await renderTree();
  try {
    await view.act(async () => view.button("镁硫电池第1篇精读").click());
    const call = view.calls.find((c) => c[0] === "openConversation")!;
    assert.equal((call[1] as SessionMetaDto).sessionId, "r1");
    const opts = call[2] as { preferredProfileId?: string; onSkipped?: () => void };
    assert.equal(opts.preferredProfileId, "p-codex");
    // 点下去这一行当场亮，不等切过去；没切成（确认框里取消）就收回
    const row = () => view.button("镁硫电池第1篇精读");
    assert.equal(row().getAttribute("aria-current"), "true");
    await view.act(async () => opts.onSkipped?.());
    assert.equal(row().getAttribute("aria-current"), null);
    assert.ok(!view.host.textContent?.includes("源文件不在了"));
  } finally {
    await view.close();
  }
});

test("「还有 N 段」在原地多列、列完了出「收起」；节头 ⋯ 能去对话页看全部；随手聊点开才列，展开记下来", async () => {
  const view = await renderTree();
  try {
    await view.act(async () => view.button("还有 1 段").click());
    const group = view.chatGroup("综述流程测试")!;
    assert.ok(group.textContent?.includes("镁硫电池第0篇精读"), "第 6 段列出来了");
    assert.ok(!group.textContent?.includes("还有"), "列完了不再有「还有 N 段」");
    await view.act(async () => view.button("收起").click());
    assert.ok(!view.chatGroup("综述流程测试")!.textContent?.includes("镁硫电池第0篇精读"));
    await view.act(async () => view.button("综述流程测试 的更多操作").click());
    await view.act(async () => view.button("在对话页看全部对话").click());
    assert.equal(view.reqs.projectPath, PROJECT.path);
    assert.ok(view.pages.includes("sessions"));
    await view.act(async () => view.button("展开「随手聊」的对话").click());
    const scratch = view.chatGroup("随手聊");
    assert.ok(scratch);
    assert.equal(scratch!.textContent?.trim(), "截图区块内容询问");
    assert.equal(
      JSON.parse(globalThis.localStorage.getItem("ccode.projectTreeChats") ?? "{}").scratch,
      true,
    );
  } finally {
    await view.close();
  }
});

test("行尾 ＋：项目里开新对话走 startProjectChat，随手聊走 openQuickChat；点项目名进项目页并展开它的对话", async () => {
  const view = await renderTree();
  try {
    await view.act(async () => view.button("在「综述流程测试」里开新对话").click());
    const start = view.calls.find((c) => c[0] === "startProjectChat")!;
    assert.equal((start[1] as { path: string }).path, PROJECT.path);
    assert.equal(start.length, 2, "不再有 ⌘ 点先选 Agent 的参数：Agent 在输入框里选");
    await view.act(async () => view.button("开一段新的随手聊").click());
    assert.ok(view.calls.some((c) => c[0] === "openQuickChat"));
    await view.act(async () => view.button("综述流程测试").click());
    assert.ok(view.pages.includes(`project:${PROJECT.path}`));
    // 收着的项目：点名字进项目页的同时展开（2026-10-24 用户），记进展开偏好
    assert.equal(view.chatGroup("Ccode"), null);
    await view.act(async () => view.button("Ccode").click());
    assert.ok(view.pages.includes("project:/work/code"));
    assert.ok(view.chatGroup("Ccode"), "点名字后它的对话展开了");
    assert.equal(
      JSON.parse(globalThis.localStorage.getItem("ccode.projectTreeChats") ?? "{}")["/work/code"],
      true,
    );
    // 再点名字不收起（收起只走箭头）
    await view.act(async () => view.button("Ccode").click());
    assert.ok(view.chatGroup("Ccode"));
  } finally {
    await view.close();
  }
});

test("收起正在聊的项目：人手关过的不再自动展开", async () => {
  const view = await renderTree();
  try {
    await view.act(async () => view.button("收起「综述流程测试」的对话").click());
    assert.equal(view.chatGroup("综述流程测试"), null);
    assert.equal(
      JSON.parse(globalThis.localStorage.getItem("ccode.projectTreeChats") ?? "{}")[PROJECT.path],
      false,
    );
  } finally {
    await view.close();
  }
});

test("不再按科研 / 编程 / 工作分组：课题平铺成节，没在聊的收着；课题名前是文件夹图标（点它开合），课题名是小号灰字分组标题、对话不缩进", async () => {
  const view = await renderTree();
  try {
    const text = view.host.textContent ?? "";
    for (const group of ["科研", "编程", "工作", "未添加"]) {
      assert.ok(!text.includes(group), `不该有「${group}」分组头`);
    }
    // 没在聊的课题只剩节头；名字前的图标格就是开合钮（2026-10-24 用户：分不清项目和对话 → 课题带文件夹图标、对话缩进）
    assert.equal(view.chatGroup("Ccode"), null);
    const chevron = view.button("展开「Ccode」的对话");
    assert.ok(chevron.querySelector("svg"), "图标格里有文件夹图标");
    const head = chevron.parentElement!;
    assert.equal(head.children[0], chevron, "图标在名字前面");
    const chatRow = view.button("镁硫电池第5篇精读");
    assert.match(chatRow.className, /\bpl-2\b/, "对话不缩进，左缘对齐课题行图标（2026-10-25）");
    assert.ok(view.button("Ccode").querySelector(".text-xs"), "课题名是 12px 的分组标题");
    // 名字右边的空白也能开合（2026-10-24 用户：点那里没反应）；点名字是进项目页
    const blank = head.children[2] as HTMLElement;
    await view.act(async () => blank.click());
    assert.ok(view.chatGroup("Ccode"), "点空白展开");
    await view.act(async () => blank.click());
    assert.equal(view.chatGroup("Ccode"), null, "再点收起");
    await view.act(async () => chevron.click());
    assert.ok(view.chatGroup("Ccode"));
    assert.equal(view.chatGroup("Ccode")!.textContent?.trim(), "还没有对话");
  } finally {
    await view.close();
  }
});

test("每段对话行尾有 ⋯：和右键同一份菜单（重命名 / 归档 / 在对话页查看）", async () => {
  const view = await renderTree();
  try {
    await view.act(async () => view.button("「镁硫电池第3篇精读」的更多操作").click());
    for (const item of ["重命名", "归档", "在对话页查看"]) view.button(item);
    await view.act(async () => view.button("在对话页查看").click());
    assert.deepEqual(view.reqs.openSession, { agent: "claude-code", sessionId: "r3" });
    assert.ok(view.pages.includes("sessions"));
  } finally {
    await view.close();
  }
});

test("开着、列表里还没有的挂在文件夹最上面（新对话 / 终端），点了切过去，× 交给运行页关", async () => {
  const closed: string[] = [];
  const focused: string[] = [];
  const view = await renderTree({
    terminalRunInputs: [
      {
        tabId: "t1",
        title: "",
        agentId: "claude-code",
        model: "",
        cwd: PROJECT.path,
        running: true,
        shell: false,
        attention: "confirm",
        sessionId: "r5",
      },
      {
        tabId: "t-new",
        title: "综述流程测试",
        agentId: "codex",
        model: "",
        cwd: PROJECT.path,
        running: false,
        shell: false,
        attention: null,
        sessionId: null,
      },
      {
        tabId: "t-sh",
        title: "zsh",
        agentId: "",
        model: "",
        cwd: "/Users/u/elsewhere",
        running: false,
        shell: true,
        attention: null,
        sessionId: null,
      },
    ],
    terminalActiveTabId: "t-new",
    requestCloseTab: (id: string) => closed.push(id),
    focusTab: (id: string) => focused.push(id),
  });
  try {
    const group = view.chatGroup("综述流程测试")!;
    const labels = Array.from(group.querySelectorAll("button"))
      .map((b) => b.textContent?.trim())
      .filter(Boolean);
    assert.equal(labels[0], "新对话", "正看着的空白新对话排在这个项目最上面");
    assert.equal(view.button("新对话").getAttribute("aria-current"), "true");
    // 不在任何项目里的终端：单列「其他打开的」
    const orphan = view.host.querySelector('[aria-label="其他打开的"]');
    assert.ok(orphan?.textContent?.includes("zsh"));
    await view.act(async () => view.button("关掉「zsh」").click());
    assert.deepEqual(closed, ["t-sh"]);
    // 点开着的那行：切过去
    await view.act(async () => view.button("zsh").click());
    assert.deepEqual(focused, ["t-sh"]);
    assert.ok(view.pages.includes("terminal"));
  } finally {
    await view.close();
  }
});

test("对话 ⋯ 里能在右侧分屏打开；开着的能关掉（行尾 × 与菜单同一条路）", async () => {
  const closed: string[] = [];
  const view = await renderTree({ requestCloseTab: (id: string) => closed.push(id) });
  try {
    await view.act(async () => view.button("关掉「镁硫电池第5篇精读」").click());
    assert.deepEqual(closed, ["t1"]);
    await view.act(async () => view.button("「镁硫电池第5篇精读」的更多操作").click());
    await view.act(async () => view.button("关掉这段对话").click());
    assert.deepEqual(closed, ["t1", "t1"]);
    assert.equal(view.host.querySelector('[aria-label="关掉「镁硫电池第2篇精读」"]'), null, "没开着的行没有 ×");
    await view.act(async () => view.button("「镁硫电池第2篇精读」的更多操作").click());
    assert.ok(
      !Array.from(view.host.ownerDocument.querySelectorAll("button")).some((b) => b.textContent?.trim() === "关掉这段对话"),
      "没开着的不给关",
    );
    await view.act(async () => view.button("在右侧分屏打开").click());
    const call = view.calls.find((c) => c[0] === "openConversation")!;
    assert.equal((call[1] as SessionMetaDto).sessionId, "r2");
    assert.deepEqual(call[2], { preferredProfileId: undefined, split: true });
  } finally {
    await view.close();
  }
});

test("Agent 已退出、标签还开着的行：没有光标就没有 ×，⋯ 里也不给关（Mesa 自己收）", async () => {
  const run = (tabId: string, sessionId: string, running: boolean) => ({
    tabId,
    title: "",
    agentId: "claude-code",
    model: "",
    cwd: PROJECT.path,
    running,
    shell: !running,
    attention: running ? ("done" as const) : null,
    sessionId,
  });
  const view = await renderTree({ terminalRunInputs: [run("t1", "r5", true), run("t2", "r2", false)] });
  try {
    assert.ok(view.host.querySelector('[aria-label="关掉「镁硫电池第5篇精读」"]'), "在跑的照旧有 ×");
    const row = view.button("镁硫电池第2篇精读");
    assert.equal(row.parentElement?.querySelector("[data-run-slot]"), null, "退出了的不留光标那一格");
    assert.equal(view.host.querySelector('[aria-label="关掉「镁硫电池第2篇精读」"]'), null);
    await view.act(async () => view.button("「镁硫电池第2篇精读」的更多操作").click());
    assert.ok(
      !Array.from(view.host.ownerDocument.querySelectorAll("button")).some((b) => b.textContent?.trim() === "关掉这段对话"),
    );
  } finally {
    await view.close();
  }
});

test("对话 ⋯ 置顶：挪到最上面「置顶」一节、原课题下不再列，记在本机；取消置顶放回去", async () => {
  const view = await renderTree();
  try {
    await view.act(async () => view.button("「镁硫电池第3篇精读」的更多操作").click());
    await view.act(async () => view.button("置顶").click());
    const pinned = view.host.querySelector('[aria-label="置顶的对话"]');
    assert.ok(pinned?.textContent?.includes("镁硫电池第3篇精读"), "置顶一节里有它");
    assert.ok(!view.chatGroup("综述流程测试")!.textContent!.includes("镁硫电池第3篇精读"), "原课题下不重复列");
    assert.deepEqual(JSON.parse(localStorage.getItem("ccode.sidebarChatPins")!), ["claude-code\nr3"]);
    await view.act(async () => view.button("「镁硫电池第3篇精读」的更多操作").click());
    await view.act(async () => view.button("取消置顶").click());
    assert.equal(view.host.querySelector('[aria-label="置顶的对话"]'), null);
    assert.ok(view.chatGroup("综述流程测试")!.textContent!.includes("镁硫电池第3篇精读"));
  } finally {
    await view.close();
  }
});

test("跑完没看的那段标题亮到 l1、悬停写明；收着的课题（随手聊）名字也亮", async () => {
  const view = await renderTree({ unreadChats: ["claude-code\nr2", "claude-code\nsc1"] });
  try {
    const row = view.button("镁硫电池第2篇精读");
    assert.match(row.className, /\btext-l1\b/);
    assert.match(row.title, /跑完了，还没看/);
    assert.doesNotMatch(view.button("镁硫电池第1篇精读").className, /\btext-l1\b/);
    assert.match(view.button("随手聊").className, /\btext-l1\b/, "随手聊收着，里面那段没看，名字亮");
  } finally {
    await view.close();
  }
});

test("键盘：↓ 走到下一行，对话上 ← 回到课题名，课题名上 ← 收起、→ 展开", async () => {
  const view = await renderTree();
  try {
    const doc = view.host.ownerDocument;
    const press = (key: string) =>
      view.act(async () => {
        (doc.activeElement as HTMLElement).dispatchEvent(new doc.defaultView!.KeyboardEvent("keydown", { key, bubbles: true }));
      });
    view.button("镁硫电池第5篇精读").focus();
    await press("ArrowDown");
    assert.equal(doc.activeElement?.textContent?.trim(), "镁硫电池第4篇精读");
    await press("ArrowLeft");
    assert.equal(doc.activeElement?.textContent?.trim(), "综述流程测试", "回到它的课题名");
    await press("ArrowLeft");
    assert.equal(view.chatGroup("综述流程测试"), null, "收起");
    await press("ArrowRight");
    assert.ok(view.chatGroup("综述流程测试"), "展开");
  } finally {
    await view.close();
  }
});

test("开步刚建的工作副本：侧栏先不认识，开着的对话出现认不出的目录就重读工作区清单，挂回课题下面（2026-10-24）", async () => {
  const WT = "/Users/u/ccode/workspaces/review-step2";
  const view = await renderTree(
    {
      terminalRunInputs: [
        {
          tabId: "t-step",
          title: "综述流程测试 · 第二步",
          agentId: "claude-code",
          model: "",
          cwd: WT,
          running: false,
          shell: false,
          attention: null,
          sessionId: null,
        },
      ],
      terminalActiveTabId: "t-step",
    },
    // 挂上时拉到的清单里还没有这个工作副本（开步刚建），重读一次才有
    (call) => (call >= 2 ? [{ repoPath: PROJECT.path, repoName: "review", worktreePath: WT }] : []),
  );
  try {
    await view.act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await view.act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.equal(view.wsCalls(), 2, "认不出归属的目录触发了一次重读，之后不再反复读");
    assert.equal(view.host.querySelector('[aria-label="其他打开的"]'), null, "不再挂在「其他打开的」");
    const group = view.chatGroup("综述流程测试");
    assert.ok(group?.textContent?.includes("新对话"), "挂在这个课题下面");
  } finally {
    await view.close();
  }
});

test("弹出列表（liftCurrent）：正聊着的项目整块提到最上面（随手聊上面），换项目就换过去；展开的侧栏不动", async () => {
  const openIn = (cwd: string) => ({
    terminalRunInputs: [
      { tabId: "t1", title: "", agentId: "claude-code", model: "", cwd, running: true, shell: false, attention: "idle", sessionId: "x" },
    ],
  });
  const order = (view: Awaited<ReturnType<typeof renderTree>>) => {
    const text = view.host.textContent ?? "";
    return ["随手聊", "综述流程测试", "Ccode"].sort((a, b) => text.indexOf(a) - text.indexOf(b));
  };
  const lift = { liftCurrent: true };
  const onCode = await renderTree(openIn("/work/code"), undefined, lift);
  try {
    assert.deepEqual(order(onCode), ["Ccode", "随手聊", "综述流程测试"], "在 Ccode 里聊，Ccode 提到最上");
    assert.equal(onCode.host.querySelectorAll("[data-rail-folder]").length, 3, "两个项目 + 随手聊各一行，提上来的不重复列");
  } finally {
    await onCode.close();
  }
  const onReview = await renderTree(openIn("/work/review"), undefined, lift);
  try {
    assert.deepEqual(order(onReview), ["综述流程测试", "随手聊", "Ccode"], "在综述项目里聊，它提到随手聊上面");
  } finally {
    await onReview.close();
  }
  const onScratch = await renderTree(openIn("/Users/u/ccode/scratch"), undefined, lift);
  try {
    assert.deepEqual(order(onScratch), ["随手聊", "综述流程测试", "Ccode"], "在随手聊里聊，项目顺序不变");
  } finally {
    await onScratch.close();
  }
  const sidebar = await renderTree(openIn("/work/code"));
  try {
    assert.deepEqual(order(sidebar), ["随手聊", "综述流程测试", "Ccode"], "展开的侧栏不提：位置不跟着正聊的项目跳");
  } finally {
    await sidebar.close();
  }
});

test("「项目 N」标签在置顶的对话和随手聊下面、课题上面：它只管下面那排文件夹（2026-10-26）", async () => {
  const view = await renderTree();
  try {
    await view.act(async () => view.button("「镁硫电池第3篇精读」的更多操作").click());
    await view.act(async () => view.button("置顶").click());
    const doc = view.host.ownerDocument;
    const label = Array.from(view.host.querySelectorAll("span")).find((s) => s.textContent === "项目")!;
    assert.ok(label, "有「项目」标签");
    const before = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & doc.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    assert.ok(before(view.host.querySelector('[aria-label="置顶的对话"]')!, label), "置顶在「项目」上面");
    assert.ok(before(view.button("随手聊"), label), "随手聊在「项目」上面");
    assert.ok(before(label, view.button("综述流程测试")), "课题在「项目」下面");
    assert.ok(before(label, view.button("Ccode")), "课题在「项目」下面");
    assert.equal(label.parentElement?.querySelector(".text-l4")?.textContent, "2", "计数只数课题");
    // 搜索和添加还在这一行
    assert.ok(label.parentElement?.querySelector('[aria-label="搜索对话和项目"]'));
    assert.ok(label.parentElement?.querySelector('[aria-label="添加项目 / 创建示例课题"]'));
  } finally {
    await view.close();
  }
});

test("课题下的对话标题开头是课题名时省掉，悬停里还是完整标题；置顶一节不省（2026-10-26）", async () => {
  const step = session({
    sessionId: "step1",
    customTitle: "1026|研究|综述流程测试文献检索筛选任务书",
    updatedAt: "2026-10-26T00:00:00Z",
  });
  const view = await renderTree({ sessions: [...reviewChats, step] });
  try {
    const row = view.button("文献检索筛选任务书");
    assert.ok(view.chatGroup("综述流程测试")!.contains(row));
    assert.match(row.title, /综述流程测试文献检索筛选任务书/, "完整标题在悬停里");
    assert.ok(view.button("「文献检索筛选任务书」的更多操作"));
    await view.act(async () => view.button("「文献检索筛选任务书」的更多操作").click());
    await view.act(async () => view.button("置顶").click());
    const pinned = view.host.querySelector('[aria-label="置顶的对话"]')!;
    assert.ok(pinned.textContent?.includes("综述流程测试文献检索筛选任务书"), "置顶一节看不出属于谁，不省");
  } finally {
    await view.close();
  }
});

test("随手聊不列空对话；节头 ⋯ 能去对话页看全部随手聊、一键归档 7 天没动的（连空对话，开着的不动）（2026-10-26）", async () => {
  const SC = "/Users/u/ccode/scratch";
  const old = "2026-01-01T00:00:00Z";
  const view = await renderTree({
    sessions: [
      ...reviewChats,
      session({ sessionId: "sc-old", projectPath: SC, customTitle: "很早的随手聊", updatedAt: old }),
      session({ sessionId: "sc-empty", projectPath: SC, title: null, updatedAt: old }),
      session({ sessionId: "sc-new", projectPath: SC, customTitle: "刚聊的随手聊", updatedAt: new Date().toISOString() }),
    ],
  });
  try {
    await view.act(async () => view.button("随手聊").click());
    const group = view.chatGroup("随手聊")!;
    assert.ok(group.textContent?.includes("很早的随手聊"));
    assert.ok(!group.textContent?.includes("未命名对话"), "空对话不列");
    await view.act(async () => view.button("随手聊的更多操作").click());
    await view.act(async () => view.button("在对话页看全部随手聊").click());
    assert.equal(view.reqs.scratch, true);
    assert.equal(view.pages.at(-1), "sessions");
    await view.act(async () => view.button("随手聊的更多操作").click());
    await view.act(async () => view.button("归档 7 天没动的（2 段）").click());
    await view.act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(view.calls.some((c) => c[0] === "confirmDialog"), "先问一句");
    const archived = view.calls
      .filter((c) => c[0] === "set_session_meta")
      .map((c) => (c[1] as { sessionId: string; archived: boolean }));
    assert.deepEqual(archived.map((a) => a.sessionId).sort(), ["sc-empty", "sc-old"]);
    assert.ok(archived.every((a) => a.archived));
    // 本地镜像当场标归档（侧栏据此不再列），没归档的不动
    const store = (view.host.ownerDocument.defaultView as unknown as { __treeStore: { sessions: SessionMetaDto[] } })
      .__treeStore;
    const flag = (id: string) => store.sessions.find((x) => x.sessionId === id)?.archived;
    assert.equal(flag("sc-old"), true);
    assert.equal(flag("sc-empty"), true);
    assert.equal(flag("sc-new"), false);
  } finally {
    await view.close();
  }
});

test("置顶一节的对话行尾小字写它属于哪个课题（随手聊写「随手聊」），悬停时让位给 ⋯；课题下的行不写（2026-10-26）", async () => {
  const view = await renderTree();
  try {
    assert.equal(view.host.querySelector("[data-chat-origin]"), null, "没置顶时不出");
    await view.act(async () => view.button("「镁硫电池第3篇精读」的更多操作").click());
    await view.act(async () => view.button("置顶").click());
    await view.act(async () => view.button("随手聊").click());
    await view.act(async () => view.button("「截图区块内容询问」的更多操作").click());
    await view.act(async () => view.button("置顶").click());
    const pinned = view.host.querySelector('[aria-label="置顶的对话"]')!;
    const origins = Array.from(pinned.querySelectorAll("[data-chat-origin]")).map((e) => e.textContent);
    assert.deepEqual(origins.sort(), ["综述流程测试", "随手聊"].sort());
    const tag = pinned.querySelector("[data-chat-origin]")!;
    assert.match(tag.className, /group-hover\/chat:hidden/, "悬停时让位给 ⋯");
    assert.match(view.button("镁硫电池第3篇精读").title, /综述流程测试 · /, "悬停里也写");
    assert.equal(view.chatGroup("综述流程测试")!.querySelector("[data-chat-origin]"), null);
  } finally {
    await view.close();
  }
});

test("收着的课题一行挨一行（只隔 1px），展开的那节上下留白（2026-10-27）", async () => {
  const view = await renderTree();
  try {
    const rows = () => Array.from(view.host.querySelectorAll("[data-tree-row]")) as HTMLElement[];
    const gaps = () => rows().map((r) => (/\bpt-3\b/.test(r.className) ? "gap" : /\bpt-px\b/.test(r.className) ? "tight" : "first"));
    // 综述流程测试展开着：它后面那节留白
    assert.deepEqual(gaps(), ["first", "gap"]);
    await view.act(async () => view.button("收起「综述流程测试」的对话").click());
    assert.deepEqual(gaps(), ["first", "tight"]);
  } finally {
    await view.close();
  }
});

test("多选：⌘ / Ctrl 点只选不开，⇧ 点整段选上，树底一条能一起置顶 / 归档，右键选中的行是同一份，Esc 和普通点清掉（2026-10-27）", async () => {
  const view = await renderTree();
  try {
    const win = view.host.ownerDocument.defaultView!;
    const click = (label: string, init: MouseEventInit) =>
      view.act(async () => {
        view.button(label).dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1, ...init }));
      });
    const pickedTitles = () =>
      Array.from(view.host.querySelectorAll("[data-picked]")).map((b) => b.textContent?.trim());
    const opens = () => view.calls.filter((c) => c[0] === "openConversation").length;
    await click("镁硫电池第4篇精读", { metaKey: true, ctrlKey: true });
    await click("镁硫电池第2篇精读", { metaKey: true, ctrlKey: true });
    assert.deepEqual(pickedTitles(), ["镁硫电池第4篇精读", "镁硫电池第2篇精读"]);
    assert.equal(opens(), 0, "只选不开");
    const bar = () => view.host.querySelector('[aria-label="选中的对话"]');
    assert.match(bar()!.textContent!, /已选 2 段/);
    // ⇧ 点：从上回 ⌘ 点的那段整段选到这一段
    await click("镁硫电池第1篇精读", { shiftKey: true });
    assert.deepEqual(pickedTitles(), ["镁硫电池第2篇精读", "镁硫电池第1篇精读"]);
    // 右键选中的行：对这几段的菜单
    await view.act(async () => {
      view.button("镁硫电池第1篇精读").dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true }));
    });
    assert.ok(view.button("置顶这 2 段"));
    await view.act(async () => view.button("置顶这 2 段").click());
    assert.deepEqual(JSON.parse(localStorage.getItem("ccode.sidebarChatPins")!), ["claude-code\nr2", "codex\nr1"]);
    assert.equal(bar(), null, "做完清掉选择");
    // 再选两段，从树底那条归档：先问一句，逐条写归档
    await click("镁硫电池第4篇精读", { metaKey: true, ctrlKey: true });
    await click("镁硫电池第3篇精读", { metaKey: true, ctrlKey: true });
    const archive = Array.from(bar()!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "归档")!;
    await view.act(async () => archive.click());
    await view.act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(view.calls.some((c) => c[0] === "confirmDialog"));
    const archived = view.calls
      .filter((c) => c[0] === "set_session_meta")
      .map((c) => (c[1] as { sessionId: string }).sessionId);
    assert.deepEqual(archived, ["r4", "r3"]);
    // Esc 清掉
    await click("镁硫电池第5篇精读", { metaKey: true, ctrlKey: true });
    assert.ok(bar());
    await view.act(async () => {
      view.button("镁硫电池第5篇精读").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(bar(), null);
    // 普通点下去：清掉选择并打开
    await click("镁硫电池第5篇精读", { metaKey: true, ctrlKey: true });
    await view.act(async () => {
      const b = view.button("镁硫电池第5篇精读");
      b.dispatchEvent(new win.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      b.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    assert.equal(bar(), null);
    assert.equal(opens(), 1);
  } finally {
    await view.close();
  }
});

test("多选键盘：对话上 ⇧↓ 从这一段整段选下去，⇧↑ 收回（2026-10-27）", async () => {
  const view = await renderTree();
  try {
    const win = view.host.ownerDocument.defaultView!;
    const key = (label: string, k: string) =>
      view.act(async () => {
        view.button(label).dispatchEvent(new win.KeyboardEvent("keydown", { key: k, shiftKey: true, bubbles: true }));
      });
    const picked = () => Array.from(view.host.querySelectorAll("[data-picked]")).map((b) => b.textContent?.trim());
    await key("镁硫电池第5篇精读", "ArrowDown");
    await key("镁硫电池第4篇精读", "ArrowDown");
    assert.deepEqual(picked(), ["镁硫电池第5篇精读", "镁硫电池第4篇精读", "镁硫电池第3篇精读"]);
    await key("镁硫电池第3篇精读", "ArrowUp");
    assert.deepEqual(picked(), ["镁硫电池第5篇精读", "镁硫电池第4篇精读"]);
  } finally {
    await view.close();
  }
});
