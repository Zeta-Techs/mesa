import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// 聊天输入框的三颗芯片（权限徽标 / 模型·思考 / 命令行渲染）：esbuild 内联打包 + JSDOM，口径同 settings-navigation-ui
const bundle = await build({
  stdin: {
    contents: `export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client';
      export {default as Badge} from './src/components/ChatPermissionBadge';
      export {default as Menu} from './src/components/ChatModelMenu';
      export {default as Decision} from './src/components/ChatDecisionCard';
      export {default as Conversation} from './src/components/ConversationView';
      export {default as Composer} from './src/components/ChatComposer';
      export {default as Picker} from './src/components/ChatProjectPicker';`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  loader: { ".css": "empty", ".png": "dataurl" },
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [
    {
      name: "chat-chips-host",
      setup(b) {
        const stubs: Record<string, string> = {
          "./ConfirmDialog": `export const confirmDialog = async (...args) => { window.__chips.confirms.push(args); return window.__chips.confirmAnswer; };
            export const alertDialog = async () => {};`,
          "@tauri-apps/plugin-opener": `export const openUrl = async (url) => { window.__chips.opened.push(url); };`,
          "@tauri-apps/plugin-dialog": `export const open = async () => window.__chips.pickFiles;`,
          "./ChatMarkdown": `import { createElement } from 'react';
            export default function ChatMarkdown(p) { return createElement('div', null, p.text); }
            export function ChatImageCard() { return null; }
            export function ChatCodeBlock(p) { return createElement('pre', null, p.text); }`,
        };
        b.onResolve({ filter: /.*/ }, (args) =>
          args.path in stubs ? { path: args.path, namespace: "chips-stub" } : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: "chips-stub" }, (args) => ({
          contents: stubs[args.path],
          loader: "js",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});

async function mount() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const host = {
    confirms: [] as unknown[],
    confirmAnswer: false,
    opened: [] as string[],
    pickFiles: ["/proj/docs/报告.pdf"] as string[] | null,
    searches: [] as unknown[],
  };
  Object.assign(dom.window, {
    __chips: host,
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args?: unknown) => {
        if (command === "model_capabilities") {
          return [
            { model: "glm-5.3", thinking: true, context: 200000, vision: null },
            { model: "glm-5.2", thinking: true, context: 128000, vision: true },
            { model: "glm-flash", thinking: false, context: 128000, vision: false },
          ];
        }
        if (command === "search_files") {
          host.searches.push(args);
          return [
            { path: "/proj/src/main.rs", rel: "src/main.rs", name: "main.rs", isDir: false },
            { path: "/proj/src/my app.ts", rel: "src/my app.ts", name: "my app.ts", isDir: false },
          ];
        }
        if (command === "git_status") {
          return { isRepo: true, branch: "main" };
        }
        if (command === "combo_surface") {
          return { showNativeEffort: true, effortLevels: [], launchEffort: "high", thinking: true, mixedModelsNote: null, injectEffortAllowed: true };
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
  const { createElement: h, act, createRoot, Badge, Menu, Decision, Conversation, Composer, Picker } = compiled.exports;
  const el = dom.window.document.getElementById("root")!;
  const root = createRoot(el);
  const render = (node: unknown) => act(async () => root.render(node));
  const button = (text: string) => {
    const found = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
    assert.ok(found, `缺少按钮：${text}`);
    return found as HTMLButtonElement;
  };
  const click = (text: string) => act(async () => button(text).click());
  return {
    h, act, el, host, render, button, click, Badge, Menu, Decision, Conversation, Composer, Picker,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, d] of restore) {
        if (d) Object.defineProperty(globalThis, key, d);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

/** 拖思考强度滑块到某一档再松手（原生 range：先 input 再 pointerup） */
async function slideEffort(ui: { el: HTMLElement; act: (fn: () => Promise<void>) => Promise<void> }, index: number) {
  const range = ui.el.querySelector<HTMLInputElement>('input[type="range"][aria-label="思考强度"]');
  assert.ok(range, "思考强度是滑块");
  await ui.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(range, String(index));
    range.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await ui.act(async () => {
    range.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  });
}

const menuItem = (ui: { el: HTMLElement }, text: string) => {
  const found = Array.from(ui.el.querySelectorAll('[role="menuitemradio"]')).find((b) =>
    b.textContent?.startsWith(text),
  );
  assert.ok(found, `缺少菜单项：${text}`);
  return found as HTMLButtonElement;
};

test("权限菜单四档：本机设置对应的那档打勾并标注，没有的置灰，完全访问要二次确认", async () => {
  const ui = await mount();
  try {
    const picks: unknown[][] = [];
    const props = {
      agentLabel: "Claude Code",
      permission: "write_tree",
      mode: null,
      modes: ["ask", "auto", "full"],
      readonlySupported: true,
      note: { tier: "full", short: "完全访问", detail: "本机 Claude Code 设为自动批准全部操作：改文件、跑命令都不先问" },
      editable: true,
      onPermission: (...args: unknown[]) => picks.push(args),
    };
    await ui.render(ui.h(ui.Badge, props));
    assert.match(ui.el.textContent ?? "", /完全访问/);
    await ui.click("完全访问");
    assert.match(ui.el.textContent ?? "", /假如它要/, "拿一件具体的事说明四档（2026-10-22）");
    for (const label of ["只讨论", "请求批准", "帮我批准", "完全访问"]) menuItem(ui, label);
    assert.doesNotMatch(ui.el.textContent ?? "", /自动改文件|按本机设置|先问再改/, "旧的五档已收掉");
    assert.equal(menuItem(ui, "完全访问").getAttribute("aria-checked"), "true");
    assert.match(menuItem(ui, "完全访问").textContent ?? "", /本机设置/);
    // 2026-10-18 用户：去掉「了解更多」
    assert.doesNotMatch(ui.el.textContent ?? "", /了解更多/);
    // 切到完全访问以外的档不用确认
    await ui.act(async () => menuItem(ui, "帮我批准").click());
    assert.deepEqual(picks.at(-1), ["write_tree", "auto"]);
    assert.equal(ui.host.confirms.length, 0);
    // 选完全访问：确认框取消不动，确认才生效
    await ui.render(ui.h(ui.Badge, { ...props, mode: "ask", note: null }));
    ui.host.confirmAnswer = false;
    await ui.click("请求批准");
    await ui.act(async () => menuItem(ui, "完全访问").click());
    assert.match(String((ui.host.confirms.at(-1) as unknown[])[0]), /^开启完全访问？/);
    assert.deepEqual(picks.at(-1), ["write_tree", "auto"]);
    ui.host.confirmAnswer = true;
    await ui.click("请求批准");
    await ui.act(async () => menuItem(ui, "完全访问").click());
    assert.deepEqual(picks.at(-1), ["write_tree", "full"]);
    // 这家没有的档置灰；本机设置对应不上任何一档时不打勾、底部写原话
    await ui.render(
      ui.h(ui.Badge, {
        ...props,
        modes: ["full"],
        note: { tier: null, short: "自动改文件", detail: "本机 Claude Code 设为自动接受改文件，跑命令仍会先问" },
      }),
    );
    await ui.click("自动改文件");
    assert.equal(menuItem(ui, "请求批准").disabled, true);
    assert.match(menuItem(ui, "请求批准").textContent ?? "", /没有这一档/);
    assert.equal(ui.el.querySelectorAll('[aria-checked="true"]').length, 0);
    assert.match(ui.el.textContent ?? "", /现在按本机设置：本机 Claude Code 设为自动接受改文件/);
    // 运行中：生成时只显示；空闲时换档要确认「会重开」，确认后先改权限再重开
    let restarts = 0;
    await ui.render(ui.h(ui.Badge, { ...props, editable: false, mode: "ask", note: null, live: { busy: true, onRestart: () => restarts++ } }));
    assert.equal(ui.el.querySelector("button"), null);
    await ui.render(ui.h(ui.Badge, { ...props, editable: false, mode: "ask", note: null, live: { busy: false, onRestart: () => restarts++ } }));
    await ui.click("请求批准");
    await ui.act(async () => menuItem(ui, "帮我批准").click());
    assert.match(String((ui.host.confirms.at(-1) as unknown[])[0]), /换权限要重开/);
    assert.deepEqual(picks.at(-1), ["write_tree", "auto"]);
    assert.equal(restarts, 1);
  } finally {
    await ui.close();
  }
});

const status = (over: Record<string, unknown> = {}) => ({
  agentId: "claude-code",
  profileId: "p1",
  model: "glm-5.3",
  launchModel: "glm-5.3",
  cwd: "/tmp",
  running: true,
  ptyId: "pty-1",
  effortSeen: "high",
  modelSeen: null,
  effortOverride: null,
  ...over,
});

test("模型菜单开聊前：顶部 Agent · 配置可进二级，模型带能力灰字，思考是滑块", async () => {
  const ui = await mount();
  try {
    const calls: string[] = [];
    const pick = {
      editable: true,
      resumeSessionId: null,
      agentId: "claude-code",
      profileId: "p1",
      model: "",
      profiles: [{ value: "p1", label: "GLM-flash" }, { value: "p2", label: "官方" }],
      models: ["glm-5.3", "glm-5.2"],
      effort: "",
      effortLevels: ["low", "medium", "high"],
      permission: "write_tree",
      permissionMode: null,
      permissionModes: ["ask", "auto", "full"],
      readonlySupported: true,
      permissionNote: null,
    };
    await ui.render(
      ui.h(ui.Menu, {
        kind: "launch",
        pick,
        onAgent: (id: string) => calls.push(`agent:${id}`),
        onProfile: (id: string) => calls.push(`profile:${id}`),
        onModel: (m: string) => calls.push(`model:${m}`),
        onEffort: (l: string) => calls.push(`effort:${l}`),
        onPermission: () => calls.push("permission"),
      }),
    );
    // 芯片：品牌色 M 说明哪家 Agent（不再写名字），后面是模型（2026-10-22）
    assert.ok(ui.el.querySelector('svg[role="img"][aria-label="Claude Code"]'), "品牌色 M 带 Agent 名供读屏");
    await ui.click("glm-5.3");
    await ui.act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.match(ui.el.textContent ?? "", /200K · 思考/);
    assert.match(ui.el.textContent ?? "", /128K · 思考 · 看图/);
    const range = ui.el.querySelector<HTMLInputElement>('input[type="range"][aria-label="思考强度"]');
    assert.equal(range?.getAttribute("aria-valuetext"), "默认");
    assert.equal(range?.max, "3", "默认 + low / medium / high 四个刻度");
    // 拖到 high（第 3 格）松手才提交
    await slideEffort(ui, 3);
    assert.deepEqual(calls.at(-1), "effort:high");
    // 进二级换配置，选完回到主菜单
    await ui.click("GLM-flash");
    assert.match(ui.el.textContent ?? "", /模型与思考强度/);
    await ui.click("官方");
    assert.deepEqual(calls.at(-1), "profile:p2");
    assert.match(ui.el.textContent ?? "", /思考强度/);
    await ui.click("glm-5.2");
    assert.deepEqual(calls.at(-1), "model:glm-5.2");
  } finally {
    await ui.close();
  }
});

test("模型菜单运行中：切模型写命令、显示「待确认」，读回后以读回为准；思考分段只写命令", async () => {
  const ui = await mount();
  try {
    const sent: string[] = [];
    const props = {
      kind: "runtime",
      status: status(),
      profileModels: ["glm-5.3", "glm-5.2"],
      modelSwitch: { kind: "direct", command: "/model {model}" },
      effort: { levels: ["low", "medium", "high", "max"], command: "/effort {level}" },
      submitCsiU: false,
      onTuiCommand: (cmd: string) => sent.push(cmd),
    };
    await ui.render(ui.h(ui.Menu, props));
    assert.match(ui.el.textContent ?? "", /glm-5\.3 · high/);
    await ui.click("glm-5.3 · high");
    // 没接「重开接回」时只能写命令：Claude 会把思考档存成默认，底部如实写
    assert.match(ui.el.textContent ?? "", /会把它存成以后的默认/);
    await ui.click("glm-5.2");
    assert.deepEqual(sent, ["/model glm-5.2"]);
    assert.match(ui.el.textContent ?? "", /glm-5\.2 · high待确认/);
    await ui.click("glm-5.2 · high");
    await slideEffort(ui, 3);
    assert.equal(sent.at(-1), "/effort max");
    // 松手后回到真值：中途换档 Claude 会先弹确认，等 CLI 回显才变
    assert.equal(
      ui.el.querySelector('input[type="range"]')?.getAttribute("aria-valuetext"),
      "high",
    );
    await ui.render(ui.h(ui.Menu, { ...props, status: status({ modelSeen: "glm-5.2" }) }));
    assert.doesNotMatch(ui.el.textContent ?? "", /待确认/);
  } finally {
    await ui.close();
  }
});

test("模型菜单运行中：会写回 CLI 全局配置的切换改走重开接回，不写命令；生成中不让换", async () => {
  const ui = await mount();
  try {
    const sent: string[] = [];
    const relaunched: unknown[] = [];
    const props = {
      kind: "runtime",
      status: status(),
      profileModels: ["glm-5.3", "glm-5.2"],
      modelSwitch: { kind: "direct", command: "/model {model}" },
      effort: { levels: ["low", "medium", "high", "max"], command: "/effort {level}" },
      submitCsiU: false,
      onTuiCommand: (cmd: string) => sent.push(cmd),
      onRelaunch: (patch: unknown) => relaunched.push(patch),
    };
    await ui.render(ui.h(ui.Menu, props));
    await ui.click("glm-5.3 · high");
    assert.match(ui.el.textContent ?? "", /不改它的全局配置/);
    await ui.click("glm-5.2");
    assert.deepEqual(relaunched, [{ model: "glm-5.2" }]);
    assert.deepEqual(sent, [], "不写 /model：Claude 会把它存成全局默认");
    await ui.click("glm-5.3 · high");
    await slideEffort(ui, 3);
    assert.deepEqual(relaunched.at(-1), { effort: "max" });
    assert.deepEqual(sent, []);
    // 生成中：重开会打断这一轮，先不让换
    await ui.render(ui.h(ui.Menu, { ...props, status: status({ attention: "working" }) }));
    assert.match(ui.el.textContent ?? "", /正在生成，等这一轮结束再换/);
    assert.equal(ui.button("glm-5.2").disabled, true);
  } finally {
    await ui.close();
  }
});

test("模型菜单：Agent 停了还能接着聊时，改选「接着聊用」的模型", async () => {
  const ui = await mount();
  try {
    const picked: string[] = [];
    await ui.render(
      ui.h(ui.Menu, {
        kind: "runtime",
        status: status({ running: false, ptyId: null }),
        profileModels: ["glm-5.3"],
        modelSwitch: { kind: "direct", command: "/model {model}" },
        effort: null,
        submitCsiU: false,
        onTuiCommand: () => assert.fail("停了不该写终端"),
        next: {
          models: ["glm-5.3", "glm-5.2"],
          model: "",
          onModel: (m: string) => picked.push(m),
          effortLevels: [],
          effort: "",
          onEffort: () => {},
        },
      }),
    );
    assert.equal(ui.button("glm-5.3").disabled, false);
    await ui.click("glm-5.3");
    assert.match(ui.el.textContent ?? "", /接着聊用/);
    await ui.click("glm-5.2");
    assert.deepEqual(picked, ["glm-5.2"]);
  } finally {
    await ui.close();
  }
});

test("等你决定卡片：照 CLI 原文摆选项，高亮项实心，总有「打开终端」", async () => {
  const ui = await mount();
  try {
    const hits: string[] = [];
    await ui.render(
      ui.h(ui.Decision, {
        decision: {
          key: "menu:Switch model?",
          title: "Switch model?",
          detail: "Your next response will be slower and use more tokens",
          options: [
            { label: "Yes, switch to glm-other", primary: true, onClick: () => hits.push("yes") },
            { label: "No, go back", onClick: () => hits.push("no") },
          ],
        },
        onOpenTerminal: () => hits.push("terminal"),
      }),
    );
    assert.match(ui.el.textContent ?? "", /Switch model\?/);
    assert.match(ui.button("Yes, switch to glm-other").className, /bg-seg-sel/);
    await ui.click("No, go back");
    await ui.click("打开终端");
    assert.deepEqual(hits, ["no", "terminal"]);
  } finally {
    await ui.close();
  }
});

test("对话里的斜杠命令渲染成一行「命令 → 结果」，不当用户气泡", async () => {
  const ui = await mount();
  try {
    await ui.render(
      ui.h(ui.Conversation, {
        messages: [
          {
            role: "user",
            timestamp: "t1",
            usage: null,
            blocks: [
              { kind: "command", text: "/model glm-5.2", toolName: null },
              { kind: "command_output", text: "Set model to `glm-5.2` and saved as your default", toolName: null },
            ],
          },
          { role: "user", timestamp: "t2", usage: null, blocks: [{ kind: "text", text: "真正的问题", toolName: null }] },
        ],
      }),
    );
    const code = ui.el.querySelector("code");
    assert.equal(code?.textContent, "/model glm-5.2");
    assert.match(ui.el.textContent ?? "", /Set model to/);
    assert.equal(ui.el.querySelectorAll(".bg-chat-bubble").length, 1, "只有真正的问题是气泡");
    assert.doesNotMatch(ui.el.innerHTML, /command-name|local-command-stdout/);
  } finally {
    await ui.close();
  }
});

/** 往受控 textarea 里「打字」：原生 setter + input 事件（React 认 input），光标落在末尾 */
async function typeInto(ui: { el: HTMLElement; act: (fn: () => Promise<void>) => Promise<void> }, text: string) {
  const box = ui.el.querySelector("textarea")!;
  await ui.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(box, text);
    box.setSelectionRange(text.length, text.length);
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  return box;
}

const key = (ui: { el: HTMLElement; act: (fn: () => Promise<void>) => Promise<void> }, k: string) =>
  ui.act(async () => {
    ui.el.querySelector("textarea")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
  });

test("输入框「+」：选文件成文件卡、随消息按路径发出；没有工作目录时不能引用项目文件", async () => {
  const ui = await mount();
  try {
    const sent: string[] = [];
    const props = {
      onSend: async (t: string) => {
        sent.push(t);
        return null;
      },
      cwd: "/proj",
    };
    await ui.render(ui.h(ui.Composer, props));
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="添加"]')!.click());
    assert.match(ui.el.textContent ?? "", /引用项目文件/);
    await ui.click("文件或图片");
    assert.match(ui.el.textContent ?? "", /报告\.pdf/, "选中的文件显示成文件名卡");
    await typeInto(ui, "帮我看看");
    // 发送钮是光标块（只有图标），按 aria-label 找
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click());
    assert.deepEqual(sent, ["帮我看看\n/proj/docs/报告.pdf"]);

    await ui.render(ui.h(ui.Composer, { ...props, cwd: null }));
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="添加"]')!.click());
    assert.equal(ui.button("引用项目文件").disabled, true);
  } finally {
    await ui.close();
  }
});

test("输入框 @：在工作目录里搜文件，选中换成相对路径，带空格的加引号", async () => {
  const ui = await mount();
  try {
    await ui.render(ui.h(ui.Composer, { onSend: async () => null, cwd: "/proj" }));
    await typeInto(ui, "看看 @ma");
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });
    assert.deepEqual(ui.host.searches.at(-1), { root: "/proj", query: "ma", showHidden: false });
    await ui.click("main.rs");
    assert.equal(ui.el.querySelector("textarea")!.value, "看看 @src/main.rs ");

    await typeInto(ui, "再看 @my");
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });
    await key(ui, "ArrowDown");
    await key(ui, "Enter");
    assert.equal(ui.el.querySelector("textarea")!.value, '再看 @"src/my app.ts" ');
  } finally {
    await ui.close();
  }
});

test("斜杠面板：上半组 Mesa 操作由 Mesa 执行、不写进终端；空输入框按 ↑ 取回上一句", async () => {
  const ui = await mount();
  try {
    const ran: string[] = [];
    const sent: string[] = [];
    await ui.render(
      ui.h(ui.Composer, {
        onSend: async (t: string) => {
          sent.push(t);
          return null;
        },
        agentId: "claude-code",
        recallHistory: ["上一句问题", "更早一句"],
        mesaCommands: [
          { cmd: "/new", label: "新对话", hint: "另开一段", run: () => ran.push("new") },
          { cmd: "/diff", label: "查看改动", hint: "右侧打开改动", run: () => ran.push("diff") },
        ],
      }),
    );
    await typeInto(ui, "/");
    const text = ui.el.textContent ?? "";
    assert.match(text, /Mesa/);
    assert.match(text, /命令（写进终端）/);
    assert.ok(text.indexOf("新对话") < text.indexOf("/compact"), "Mesa 组在上");
    await ui.click("新对话");
    assert.deepEqual(ran, ["new"]);
    assert.deepEqual(sent, [], "Mesa 操作不写终端");
    assert.equal(ui.el.querySelector("textarea")!.value, "");

    await typeInto(ui, "/改动");
    assert.match(ui.el.textContent ?? "", /查看改动/, "中文名也能搜到");
    await key(ui, "Enter");
    assert.deepEqual(ran, ["new", "diff"]);

    await key(ui, "ArrowUp");
    assert.equal(ui.el.querySelector("textarea")!.value, "上一句问题");
    // 接着 ↑ 一路往回，↓ 往回走，走过头清空（2026-10-22）
    await key(ui, "ArrowUp");
    assert.equal(ui.el.querySelector("textarea")!.value, "更早一句");
    await key(ui, "ArrowUp");
    assert.equal(ui.el.querySelector("textarea")!.value, "更早一句", "到头了不动");
    await key(ui, "ArrowDown");
    assert.equal(ui.el.querySelector("textarea")!.value, "上一句问题");
    await key(ui, "ArrowDown");
    assert.equal(ui.el.querySelector("textarea")!.value, "");
  } finally {
    await ui.close();
  }
});

test("消息悬停操作：用户消息「编辑后重发」，助手消息「从这里分叉」；排队中的气泡标注且不给操作", async () => {
  const ui = await mount();
  try {
    const edits: string[] = [];
    const forks: string[] = [];
    const text = (role: string, t: string, queued = false) => ({
      role,
      timestamp: null,
      usage: null,
      blocks: [{ kind: "text", text: t, toolName: null }],
      ...(queued ? { queued: true } : {}),
    });
    await ui.render(
      ui.h(ui.Conversation, {
        messages: [text("user", "第一问"), text("assistant", "第一答"), text("user", "补一句", true)],
        onEditResend: (t: string) => edits.push(t),
        onForkHere: (t: string) => forks.push(t),
      }),
    );
    const editButtons = Array.from(ui.el.querySelectorAll("button")).filter((b) => b.textContent?.includes("编辑后重发"));
    assert.equal(editButtons.length, 1, "排队中的那条不给编辑");
    await ui.click("编辑后重发");
    await ui.click("从这里分叉");
    assert.deepEqual(edits, ["第一问"]);
    assert.deepEqual(forks, ["第一答"]);
    assert.match(ui.el.textContent ?? "", /排队中 · 这一轮结束后处理/);

    // 回放页不传回调 = 只有复制
    await ui.render(ui.h(ui.Conversation, { messages: [text("user", "a"), text("assistant", "b")] }));
    assert.doesNotMatch(ui.el.textContent ?? "", /编辑后重发|从这里分叉/);
  } finally {
    await ui.close();
  }
});

test("输入框（2026-10-22）：发送钮是光标块，生成中有字时停止 + 排队；⇧Tab 轮换权限；权限写在框上", async () => {
  const ui = await mount();
  try {
    let cycles = 0;
    let stops = 0;
    const sent: string[] = [];
    const base = {
      onSend: async (t: string) => {
        sent.push(t);
        return null;
      },
      onCyclePermission: () => cycles++,
    };
    await ui.render(ui.h(ui.Composer, { ...base, tone: "full" }));
    assert.equal(ui.el.querySelector(".ccode-composer-box")?.getAttribute("data-tone"), "full");
    assert.equal(
      ui.el.querySelector(".ccode-composer-box")?.hasAttribute("data-tone-flash"),
      false,
      "打开时已是完全访问：细线不亮（只在切换那一下亮）",
    );
    const send = () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!;
    assert.equal(send().getAttribute("data-state"), "empty");
    assert.equal(send().disabled, true);
    await typeInto(ui, "你好");
    assert.equal(send().getAttribute("data-state"), "ready");
    await ui.act(async () => {
      ui.el.querySelector("textarea")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    assert.equal(cycles, 1, "⇧Tab 轮换权限");
    // 生成中：停止钮在，有字时旁边写「排队」并给发送钮
    await ui.render(ui.h(ui.Composer, { ...base, tone: "discuss", running: true, onInterrupt: () => stops++ }));
    assert.equal(ui.el.querySelector(".ccode-composer-box")?.getAttribute("data-tone"), "discuss");
    assert.ok(ui.el.querySelector('button[aria-label="暂停当前生成"]'));
    assert.match(ui.el.textContent ?? "", /排队/);
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="排队发送"]')!.click());
    assert.deepEqual(sent, ["你好"]);
    assert.doesNotMatch(ui.el.textContent ?? "", /排队/, "发出去了、输入框空了就只剩停止钮");
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="暂停当前生成"]')!.click());
    assert.equal(stops, 1);
    // 从别的档切到完全访问：细线亮一下（data-tone-flash），过后自己撤掉
    await ui.render(ui.h(ui.Composer, { ...base, tone: "full" }));
    assert.equal(ui.el.querySelector(".ccode-composer-box")?.hasAttribute("data-tone-flash"), true);
    await ui.act(async () => {
      await new Promise((r) => setTimeout(r, 2600));
    });
    assert.equal(ui.el.querySelector(".ccode-composer-box")?.hasAttribute("data-tone-flash"), false, "亮完淡掉，不常驻");
    assert.equal(ui.el.querySelector(".ccode-composer-box")?.getAttribute("data-tone"), "full");
  } finally {
    await ui.close();
  }
});

test("模型菜单开聊前：最近在这个项目用过的搭配一点四样一起换；输入框有图时标出看不了图的模型", async () => {
  const ui = await mount();
  try {
    const combos: unknown[] = [];
    const warnings: (string | null)[] = [];
    const pick = {
      editable: true,
      resumeSessionId: null,
      agentId: "claude-code",
      profileId: "p1",
      model: "glm-flash",
      profiles: [{ value: "p1", label: "GLM" }],
      models: ["glm-flash", "glm-5.2"],
      effort: "",
      effortLevels: ["low", "medium", "high"],
      permission: "write_tree",
      permissionMode: null,
      permissionModes: ["ask", "auto", "full"],
      readonlySupported: true,
      permissionNote: null,
      autoNote: null,
    };
    const props = {
      kind: "launch",
      pick,
      onAgent: () => {},
      onProfile: () => {},
      onModel: () => {},
      onEffort: () => {},
      onPermission: () => {},
      combosWhere: "Ccode",
      combos: [
        { agentId: "codex", profileId: "cx", model: "gpt-5.5", effort: "medium" },
        // 和当前选择一样的那套不列
        { agentId: "claude-code", profileId: "p1", model: "glm-flash", effort: "" },
      ],
      onCombo: (c: unknown) => combos.push(c),
      hasImages: true,
      onImageWarning: (w: string | null) => warnings.push(w),
    };
    await ui.render(ui.h(ui.Menu, props));
    await ui.act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.match(String(warnings.at(-1)), /glm-flash 看不了图/, "当前模型看不了图：告诉输入框");
    await ui.click("glm-flash");
    await ui.act(async () => new Promise((r) => setTimeout(r, 0)));
    const text = ui.el.textContent ?? "";
    assert.match(text, /最近在 Ccode 用过/);
    // 「最近用过」只剩 Codex 一行：和当前一样的那套不列（各行前是品牌色 M，读屏名就是 Agent 名）
    const comboRows = Array.from(ui.el.querySelectorAll('[role="dialog"] svg[role="img"]')).map((m) => m.getAttribute("aria-label"));
    assert.deepEqual(comboRows, ["Codex", "Claude Code"], "搭配一行 + 菜单顶行的 Agent");
    assert.match(text, /看不了图/);
    await ui.click("Codex");
    assert.deepEqual(combos, [{ agentId: "codex", profileId: "cx", model: "gpt-5.5", effort: "medium" }]);
  } finally {
    await ui.close();
  }
});

test("项目弹层：能搜、带项目类型与项目默认、编程项目写分支，选了交给标签；随手聊 / 选择文件夹在下面", async () => {
  const ui = await mount();
  try {
    const picks: unknown[] = [];
    let folders = 0;
    let created = 0;
    await ui.render(
      ui.h(ui.Picker, {
        cwd: "/u/code/ccode",
        homeDir: "/u",
        label: "Ccode",
        projects: [
          { path: "/u/code/ccode", name: "Ccode", workMode: "coding", lastOpenedAt: "2026-10-22", createdAt: null },
          { path: "/u/res/gut", name: "肠道菌群综述", workMode: "research", defaultAgent: "codex", lastOpenedAt: "2026-10-21", createdAt: null },
        ],
        recentRepos: [],
        isWindows: false,
        onPick: (p: unknown) => picks.push(p),
        onChooseFolder: () => folders++,
        onNewProject: () => created++,
      }),
    );
    await ui.click("Ccode");
    await ui.act(async () => new Promise((r) => setTimeout(r, 0)));
    const text = ui.el.textContent ?? "";
    assert.match(text, /main/, "编程项目写当前分支");
    assert.match(text, /科研\s*· 默认 Codex/);
    assert.match(text, /随手聊/);
    await ui.click("肠道菌群综述");
    assert.deepEqual(picks.at(-1), { kind: "project", path: "/u/res/gut" });
    await ui.click("Ccode");
    const input = ui.el.querySelector<HTMLInputElement>('input[aria-label="找项目或文件夹"]')!;
    await ui.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "肠道");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.doesNotMatch(ui.el.textContent ?? "", /随手聊/, "搜的时候固定两行对不上就不列");
    await ui.click("选择文件夹");
    assert.equal(folders, 1);
  } finally {
    await ui.close();
  }
});

test("输入框：CLI 猜的下一句空着时灰着显示，Tab 填进来；有字就不显示", async () => {
  const ui = await mount();
  try {
    const sent: string[] = [];
    await ui.render(ui.h(ui.Composer, { onSend: async (t: string) => (sent.push(t), null), suggestion: "再运行一次看看输出" }));
    const box = ui.el.querySelector("textarea")!;
    assert.equal(box.placeholder, "再运行一次看看输出");
    assert.ok(ui.button("填入"));
    await key(ui, "Tab");
    assert.equal(box.value, "再运行一次看看输出");
    assert.ok(!Array.from(ui.el.querySelectorAll("button")).some((b) => b.textContent?.includes("填入")), "填进来后提示收起");
    // 空着按回车不替你发（终端里会直接发出这句猜的话）
    await typeInto(ui, "");
    await key(ui, "Enter");
    assert.deepEqual(sent, []);
    await typeInto(ui, "我自己写");
    assert.notEqual(box.placeholder, "再运行一次看看输出");
  } finally {
    await ui.close();
  }
});
