import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { parseClaudeAsk } from "../src/tui-ask.ts";

// 聊天输入框的三颗芯片（权限徽标 / 模型·思考 / 命令行渲染）：esbuild 内联打包 + JSDOM，口径同 settings-navigation-ui
const bundle = await build({
  stdin: {
    contents: `export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client';
      export {default as Badge} from './src/components/ChatPermissionBadge';
      export {default as Menu} from './src/components/ChatModelMenu';
      export {default as Decision} from './src/components/ChatDecisionCard';
      export {default as Conversation} from './src/components/ConversationView';
      export {default as Composer} from './src/components/ChatComposer';
      export {default as ChatSearch} from './src/components/ChatSearch';
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
          "@tauri-apps/plugin-opener": `export const openUrl = async (url) => { window.__chips.opened.push(url); };
            export const openPath = async () => {}; export const revealItemInDir = async () => {};`,
          "@tauri-apps/plugin-dialog": `export const open = async () => window.__chips.pickFiles;`,
          // 文档首页预览：pdf.js / mammoth 不进测试包，只记谁要了 PDF 缩略图
          "./pdf-thumb": `export const pdfFirstPageThumb = async (path) => { window.__chips.pdfThumbs.push(path); return "data:image/jpeg;base64,AAAA"; };`,
          "./docx-thumb": `export const docxFirstPageThumb = async () => null;`,
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
    NodeFilter: dom.window.NodeFilter,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    // 文档 / 文字缩略图把一页纸序列化进 SVG（doc-thumb htmlPageThumb）
    XMLSerializer: dom.window.XMLSerializer,
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
    imageReads: [] as string[],
    textReads: [] as string[],
    pdfThumbs: [] as string[],
    pickDirs: [] as unknown[],
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function () { this.dataset.scrolled = "1"; };
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
        if (command === "read_file_preview") {
          host.textReads.push((args as { path: string }).path);
          return { text: "# 笔记\n第一行", truncated: false, revision: null, readOnlyReason: null, encoding: null };
        }
        if (command === "list_recent_files") {
          return [
            { path: "/proj/figures/cover.png", rel: "figures/cover.png", name: "cover.png", modified: "2026-10-25T01:49:00Z", size: 10 },
            { path: "/proj/data.csv", rel: "data.csv", name: "data.csv", modified: "2026-10-23T05:40:00Z", size: 10 },
            { path: "/proj/notes/a.md", rel: "notes/a.md", name: "a.md", modified: null, size: 10 },
          ];
        }
        if (command === "git_status") {
          return { isRepo: true, branch: "main" };
        }
        if (command === "pick_attachment_files") {
          host.pickDirs.push((args as { defaultDir: string | null }).defaultDir);
          return host.pickFiles ?? [];
        }
        if (command === "read_image_bytes") {
          host.imageReads.push((args as { path: string }).path);
          return { mime: "image/png", data: "iVBORw0KGgo=" };
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
  const { createElement: h, act, createRoot, Badge, Menu, Decision, Conversation, Composer, Picker, ChatSearch } = compiled.exports;
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
    h, act, el, host, render, button, click, Badge, Menu, Decision, Conversation, Composer, Picker, ChatSearch,
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
    assert.match(menuItem(ui, "先出方案").textContent ?? "", /不建，告诉你怎么做/, "没传哪一家：照旧的说法");
    // 2026-10-26「只讨论」改名「先出方案」（目标 / 聊想法里的只讨论另是一回事，不跟着改）
    assert.equal(ui.el.textContent?.includes("只讨论"), false);
    for (const label of ["先出方案", "请求批准", "帮我批准", "完全访问"]) menuItem(ui, label);
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

test("输入区收字（2026-10-23）：框里只有 + 与发送，下面那一行由调用方给；权限平时灰字、切到时同步亮；测试版收进模型菜单", async () => {
  const ui = await mount();
  try {
    await ui.render(
      ui.h(ui.Composer, {
        onSend: async () => null,
        footer: ui.h("div", { "data-testid": "meta" }, "权限 · 项目"),
      }),
    );
    const box = ui.el.querySelector(".ccode-composer-box")!;
    assert.deepEqual(
      Array.from(box.querySelectorAll("button")).map((b) => b.getAttribute("aria-label")),
      ["添加", "发送"],
      "框里只留 + 和发送",
    );
    const meta = ui.el.querySelector('[data-testid="meta"]')!;
    assert.ok(meta && !box.contains(meta), "那一行画在框外");

    // 权限：完全访问平时灰字，flash 时与输入框细线同一条曲线亮一下
    const badge = {
      agentLabel: "Claude Code",
      permission: "write_tree",
      mode: "full",
      modes: ["ask", "auto", "full"],
      readonlySupported: true,
      note: null,
      editable: true,
    };
    await ui.render(ui.h(ui.Badge, badge));
    const chip = () => ui.button("完全访问");
    assert.match(chip().className, /text-l3/);
    assert.doesNotMatch(chip().className, /caution|ccode-perm-flash/, "常驻不染色");
    await ui.render(ui.h(ui.Badge, { ...badge, flash: true }));
    assert.match(chip().className, /ccode-perm-flash/);

    // 测试版：不再单占一格，在模型菜单底部一行，点进去是说明与「切到终端」
    let toTerminal = 0;
    await ui.render(
      ui.h(ui.Menu, {
        kind: "runtime",
        status: status(),
        profileModels: ["glm-5.3"],
        modelSwitch: { kind: "direct", command: "/model {model}" },
        effort: null,
        submitCsiU: false,
        onTuiCommand: () => {},
        onOpenTerminal: () => toTerminal++,
      }),
    );
    assert.doesNotMatch(ui.el.textContent ?? "", /测试版/, "芯片上不写测试版");
    await ui.click("glm-5.3");
    await ui.click("测试版");
    assert.match(ui.el.textContent ?? "", /以终端为准/);
    await ui.click("切到终端");
    assert.equal(toTerminal, 1);
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

test("等你决定卡片：照 CLI 原文摆选项，高亮项是主按钮（CTA、在最右、带键帽），总有「打开终端」", async () => {
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
    const yes = ui.button("Yes, switch to glm-other");
    assert.match(yes.className, /bg-cta/);
    // 主按钮在最右：底栏最后一个按钮
    const footerButtons = Array.from(ui.el.querySelectorAll("footer button"));
    assert.equal(footerButtons[footerButtons.length - 1], yes);
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
    assert.match(ui.el.textContent ?? "", /报告\.pdf/, "选中的文件显示成文件卡");
    assert.deepEqual(ui.host.pickDirs, ["/proj"], "选择器从工作目录打开（Rust 侧弹，选中的才进读取白名单）");
    await ui.act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.deepEqual(ui.host.pdfThumbs, ["/proj/docs/报告.pdf"], "PDF 要首页缩略图");
    assert.ok(ui.el.querySelector('img[src="data:image/jpeg;base64,AAAA"]'), "PDF 卡带首页缩略图");
    assert.match(ui.el.textContent ?? "", /PDF/, "文件名下写类型");
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

test("输入框「+ → 引用项目文件」：弹层列最近改过的文件、能搜、可多选，添加后成附件卡随消息发出", async () => {
  const ui = await mount();
  try {
    const sent: string[] = [];
    await ui.render(ui.h(ui.Composer, { onSend: async (t: string) => (sent.push(t), null), cwd: "/proj" }));
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="添加"]')!.click());
    await ui.click("引用项目文件");
    const dialog = () => ui.el.querySelector('[role="dialog"]');
    assert.ok(dialog(), "点了弹出挑文件的弹层，不再只往输入框插 @");
    assert.equal(ui.el.querySelector("textarea")!.value, "", "输入框不被插 @");
    await ui.act(async () => new Promise((r) => setTimeout(r, 0)));
    const options = () => Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    assert.deepEqual(options().map((o) => o.title), ["figures/cover.png", "data.csv", "notes/a.md"], "最近改过的在前");
    assert.ok(ui.host.imageReads.includes("/proj/figures/cover.png"), "图片带缩略图");
    assert.ok(ui.host.textReads.includes("/proj/notes/a.md"), "文字文件也排成一页纸当缩略图");
    await ui.act(async () => new Promise((r) => setTimeout(r, 20)));
    assert.match(options()[0].textContent ?? "", /figures/, "默认列表，第二行写所在文件夹");
    assert.equal(options().filter((o) => o.querySelector("img")).length, 3, "列表每行也带缩略图（CSV 排成小表）");
    await ui.act(async () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="网格显示"]')!.click());
    assert.equal(options().filter((o) => o.querySelector("img")).length, 3, "换网格看大缩略图");
    assert.equal(ui.button("添加").disabled, true, "没勾不能添加");

    await ui.act(async () => options()[1].click());
    await ui.act(async () => options()[0].click());
    assert.equal(options()[0].getAttribute("aria-selected"), "true");
    await ui.click("添加 2 个");
    // 弹层退场动画 150ms 后才卸载
    await ui.act(async () => new Promise((r) => setTimeout(r, 200)));
    assert.equal(dialog(), null, "添加后弹层收起");
    assert.match(ui.el.textContent ?? "", /data\.csv/, "文件成附件卡");
    assert.ok(ui.el.querySelector('button[aria-label="看图与标注"]'), "图片成缩略卡");
    await typeInto(ui, "看看这两个");
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click());
    assert.deepEqual(sent, ["看看这两个\n/proj/data.csv\n/proj/figures/cover.png"], "按勾选顺序随消息发出");

    // 搜索整个项目：文件夹不进列表
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="添加"]')!.click());
    await ui.click("引用项目文件");
    assert.ok(dialog()!.querySelector('button[aria-label="网格显示"]'), "上次换了网格，再打开仍是列表");
    const search = dialog()!.querySelector<HTMLInputElement>('input[aria-label="搜索项目文件"]')!;
    await ui.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(search, "main");
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await ui.act(async () => new Promise((r) => setTimeout(r, 200)));
    assert.match(options()[0]?.textContent ?? "", /main\.rs/);
  } finally {
    await ui.close();
  }
});

test("输入框长文：换行后字占满整宽、+ 和发送挪到下一排；超出高度给渐隐和「展开」，Esc 收回", async () => {
  const ui = await mount();
  try {
    await ui.render(ui.h(ui.Composer, { onSend: async () => null, cwd: "/proj" }));
    const row = () => ui.el.querySelector(".ccode-composer-row")!;
    const box = await typeInto(ui, "一句话");
    assert.equal(row().hasAttribute("data-stacked"), false, "一行时 + · 字 · 发送同一排");
    await typeInto(ui, "第一行\n第二行");
    assert.equal(row().hasAttribute("data-stacked"), true, "有换行就换成上下两层");
    assert.equal(ui.el.querySelector("textarea"), box, "换层不重建输入框（焦点、光标不丢）");
    assert.equal(ui.el.querySelector('button[aria-label="展开输入框"]'), null, "没超出高度不给展开");

    // JSDOM 不做布局：假装内容比框高、停在顶上
    Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 216 });
    await typeInto(ui, "第一行\n第二行\n第三行");
    assert.equal(box.hasAttribute("data-fade-bottom"), true, "下面还有字：下沿渐隐");
    assert.equal(box.hasAttribute("data-fade-top"), false);
    await ui.act(async () => {
      box.dispatchEvent(new window.Event("scroll"));
    });
    assert.equal(box.dataset.scrolling, "1", "滚动时打标、滚动条显出来（同侧栏树，停 0.9 秒摘掉）");
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="展开输入框"]')!.click());
    assert.match(box.className, /min-h-/, "展开后至少占一大块高度");
    await key(ui, "Escape");
    assert.ok(ui.el.querySelector('button[aria-label="展开输入框"]'), "Esc 收回原来的高度");
    assert.equal(box.value, "第一行\n第二行\n第三行", "收回不动字");

    await typeInto(ui, "");
    assert.equal(row().hasAttribute("data-stacked"), false, "清空回到一行");
  } finally {
    await ui.close();
  }
});

test("输入框图片：编辑后重发还原成缩略卡；点图在输入框上方看图标注、消息照常写；意见框编号接进消息", async () => {
  const ui = await mount();
  try {
    const win = ui.el.ownerDocument.defaultView!;
    // JSDOM 不做布局：给显示区和标注层一个尺寸，图按 1000×500 读进来
    Object.defineProperty(win.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(win.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
    win.SVGElement.prototype.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 768, height: 384, right: 768, bottom: 384, x: 0, y: 0 }) as DOMRect;
    const sent: string[] = [];
    const props = {
      onSend: async (t: string) => {
        sent.push(t);
        return null;
      },
      cwd: "/proj",
      seedInsert: { text: "这张图哪里不对", paths: ["/tmp/ccode/paste-1.png", "/tmp/ccode/paste-2.png"] },
      onSeedConsumed: () => undefined,
    };
    await ui.render(ui.h(ui.Composer, props));
    const box = ui.el.querySelector("textarea")!;
    assert.equal(box.value, "这张图哪里不对", "正文回输入框，路径不当文字塞回去");
    const thumbs = () => ui.el.querySelectorAll<HTMLButtonElement>('button[aria-label="看图与标注"]');
    assert.equal(thumbs().length, 2, "两张图都还原成缩略卡");
    assert.deepEqual(ui.host.imageReads, ["/tmp/ccode/paste-1.png", "/tmp/ccode/paste-2.png"]);

    await ui.act(async () => thumbs()[0].click());
    const stage = () => ui.el.querySelector('[role="region"][aria-label="看图与标注"]');
    assert.ok(stage(), "点缩略图在输入框上方展开看图台");
    assert.equal(ui.el.ownerDocument.querySelector('[role="dialog"]'), null, "不是挡住输入框的弹窗");
    assert.equal(box.disabled, false, "看图时输入框照常能写");
    assert.equal(thumbs()[0].getAttribute("aria-pressed"), "true");

    const img = stage()!.querySelector("img")!;
    Object.defineProperty(img, "naturalWidth", { value: 1000 });
    Object.defineProperty(img, "naturalHeight", { value: 500 });
    await ui.act(async () => img.dispatchEvent(new win.Event("load")));
    await ui.click("意见框");
    const svg = () => stage()!.querySelector<SVGSVGElement>('svg[aria-label="标注"]')!;
    const pointer = (type: string, x: number, y: number) =>
      ui.act(async () => {
        svg().dispatchEvent(new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
      });
    await pointer("pointerdown", 100, 100);
    await pointer("pointermove", 300, 250);
    await pointer("pointerup", 300, 250);
    assert.equal(box.value, "这张图哪里不对\n① ", "画好意见框，消息末尾另起一行接上 ①");
    assert.ok(svg().querySelector("rect"), "图上出现框");
    assert.ok(thumbs()[0].querySelector('svg[aria-label="已标注"]'), "缩略图上也看得到标注");

    await ui.click("撤销");
    assert.equal(thumbs()[0].querySelector('svg[aria-label="已标注"]'), null, "撤销后标注没了，消息里的字不动");
    assert.equal(box.value, "这张图哪里不对\n① ");

    await ui.act(async () => {
      box.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(stage(), null, "Esc 收起看图台");

    await ui.act(async () => ui.el.querySelectorAll<HTMLButtonElement>('button[aria-label="移除图片"]')[0].click());
    assert.equal(thumbs().length, 1);
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click());
    assert.deepEqual(sent, ["这张图哪里不对\n①\n/tmp/ccode/paste-2.png"], "没标注的图照原路径发，正文 + 一行一个路径");

    ui.host.pickFiles = ["/proj/fig/结果.png"];
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="添加"]')!.click());
    await ui.click("文件或图片");
    assert.equal(thumbs().length, 1, "选来的图片也出缩略图、能点开");
  } finally {
    await ui.close();
  }
});

test("点对话里的图接着改：图进输入框、直接展开看图台，占位字与常用说法按改图口径", async () => {
  const ui = await mount();
  try {
    const sent: string[] = [];
    const kinds: (string | null)[] = [];
    await ui.render(
      ui.h(ui.Composer, {
        onSend: async (t: string) => (sent.push(t), null),
        cwd: "/proj",
        seedInsert: { text: "", paths: [], edit: "/proj/scratch/puppy.jpg" },
        onSeedConsumed: () => undefined,
        onImagesChange: (k: string | null) => kinds.push(k),
        imageWarning: "glm-5.3 看不了图：带图发出去会报错",
      }),
    );
    assert.equal(kinds.at(-1), null, "没标过的改图不算要模型看图");
    assert.doesNotMatch(ui.el.textContent ?? "", /看不了图/, "也就不出看不了图的提示");
    const stage = () => ui.el.querySelector('[role="region"][aria-label="看图与标注"]');
    assert.ok(stage(), "不用再点缩略图，看图台直接展开");
    assert.deepEqual(ui.host.imageReads, ["/proj/scratch/puppy.jpg"]);
    const box = ui.el.querySelector("textarea")!;
    assert.equal(box.placeholder, "描述修改内容");
    assert.match(stage()!.textContent ?? "", /出图模型在原图上改/);
    await ui.click("移除背景");
    assert.equal(box.value, "去掉背景，只留主体（透明或纯白底），其余不变", "常用说法写进输入框，不直接发");
    assert.deepEqual(sent, []);
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click());
    assert.deepEqual(sent, ["去掉背景，只留主体（透明或纯白底），其余不变\n原图：/proj/scratch/puppy.jpg"], "没标注就发「原图：」一行（Claude Code 不会当图片附件）");
    assert.equal(stage(), null);
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

test("完全访问细线：聊天层给定亮不亮时以它为准，切换对话档位读进来不亮（2026-10-25）", async () => {
  const flashing = (ui: Awaited<ReturnType<typeof mount>>) =>
    ui.el.querySelector(".ccode-composer-box")?.hasAttribute("data-tone-flash");
  const base = { onSend: async () => null };
  const ui = await mount();
  try {
    await ui.render(ui.h(ui.Composer, { ...base, tone: null, toneFlash: false }));
    // 切到一段完全访问的对话：档位从没读到变成 full，但不是人换的档
    await ui.render(ui.h(ui.Composer, { ...base, tone: "full", toneFlash: false }));
    assert.equal(flashing(ui), false, "切换对话不亮");
    // 人亲手切到完全访问：聊天层给 true
    await ui.render(ui.h(ui.Composer, { ...base, tone: "full", toneFlash: true }));
    assert.equal(flashing(ui), true);
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
      imageKind: "plain",
      onImageWarning: (w: string | null) => warnings.push(w),
    };
    await ui.render(ui.h(ui.Menu, props));
    await ui.act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.match(String(warnings.at(-1)), /glm-flash 看不了图：带图发出去会报错.*先移除图片/, "当前模型看不了图：告诉输入框会报错、怎么办");
    // 接着改的图标过：不会报错（标注图按文字行交），只是标注白画
    await ui.render(ui.h(ui.Menu, { ...props, imageKind: "marks" }));
    await ui.act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.match(String(warnings.at(-1)), /glm-flash 看不了图，图上的标注它看不到，只会按你写的字在原图上改/);
    await ui.render(ui.h(ui.Menu, props));
    await ui.act(async () => new Promise((r) => setTimeout(r, 0)));
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

// Claude 提问表单（tui-ask.ts 同一份实录，横线截短）
const ASK_RULE = "─".repeat(60);
const ASK_SINGLE = [
  ASK_RULE,
  " ☐ 颜色",
  "",
  "红、绿、蓝三种颜色里，你更喜欢哪一种？",
  "",
  "❯ 1. 红",
  "     选择红色",
  "  2. 绿",
  "     选择绿色",
  "  3. 蓝",
  "     选择蓝色",
  "  4. Type something.",
  ASK_RULE,
  "  5. Chat about this",
];

async function fillInput(ui: { el: HTMLElement; act: (fn: () => Promise<void>) => Promise<void> }, label: string, text: string) {
  const box = ui.el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await ui.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(box, text);
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

test("Claude 提问卡片：选项名和说明分开竖排，可以自己写答案、先不答；不再写「高亮的是终端默认项」", async () => {
  const ui = await mount();
  try {
    const actions: unknown[] = [];
    let terminal = 0;
    const form = parseClaudeAsk(ASK_SINGLE)!;
    await ui.render(
      ui.h(ui.Decision, {
        decision: { key: "ask", title: "q", options: [], ask: { form, pending: false, onAction: (a: unknown) => actions.push(a) } },
        onOpenTerminal: () => terminal++,
      }),
    );
    const text = ui.el.textContent ?? "";
    assert.match(text, /红、绿、蓝三种颜色里，你更喜欢哪一种？/);
    assert.match(text, /颜色/);
    assert.doesNotMatch(text, /Type something|高亮的是|☐/);
    // 选项名与说明是两段字，不是「红 选择红色」一个按钮
    const second = ui.button("选择绿色");
    assert.equal(second.querySelector("span span")?.textContent, "绿");
    await ui.act(async () => second.click());
    await fillInput(ui, "自己写答案", "紫色");
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="就答这个"]')!.click());
    assert.equal(ui.el.querySelector<HTMLInputElement>('input[aria-label="自己写答案"]')!.value, "", "交了就清空");
    await ui.click("先不答，直接聊");
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="打开终端"]')!.click());
    assert.deepEqual(actions, [{ kind: "pick", index: 1 }, { kind: "text", text: "紫色" }, { kind: "chat" }]);
    assert.equal(terminal, 1);

    // 刚点过、终端还没换画面：按钮先停用
    await ui.render(
      ui.h(ui.Decision, {
        decision: { key: "ask", title: "q", options: [], ask: { form, pending: true, onAction: (a: unknown) => actions.push(a) } },
        onOpenTerminal: () => {},
      }),
    );
    assert.equal(ui.button("选择红色").disabled, true);
  } finally {
    await ui.close();
  }
});

test("Claude 提问卡片：多选打勾、提交这一题、点题签切题；确认页列出每题答案", async () => {
  const ui = await mount();
  try {
    const actions: unknown[] = [];
    const tabs = "←  ☒ 颜色  ☐ 水果  ✔ Submit  →";
    const lines = [
      ASK_RULE,
      tabs,
      "下面这些水果你平时会吃哪些？",
      "  1. [✔] 苹果",
      "         脆甜，一年四季都有",
      "❯ 2. [ ] 香蕉",
      "         软糯，适合当早餐",
      "  3. [ ] Type something",
      "     Submit",
      ASK_RULE,
      "  4. Chat about this",
    ];
    const at = tabs.indexOf("☐ 水果");
    const form = parseClaudeAsk(lines, (row) =>
      lines[row] === tabs ? [...tabs].map((ch, i) => ({ ch, dim: false, inverse: false, bg: i >= at - 1 && i <= at + 4 })) : [],
    )!;
    const render = (f: typeof form) =>
      ui.render(
        ui.h(ui.Decision, {
          decision: { key: "ask", title: "q", options: [], ask: { form: f, pending: false, onAction: (a: unknown) => actions.push(a) } },
          onOpenTerminal: () => {},
        }),
      );
    await render(form);
    const boxes = Array.from(ui.el.querySelectorAll('[role="checkbox"]'));
    assert.deepEqual(
      boxes.map((b) => b.getAttribute("aria-checked")),
      ["true", "false"],
    );
    await ui.act(async () => (boxes[1] as HTMLButtonElement).click());
    await ui.click("提交这一题");
    // 右上角翻页：第 2 / 2 题，往前翻到第一题；往后翻是确认页
    assert.match(ui.el.textContent ?? "", /2 \/ 2/);
    assert.match(ui.el.textContent ?? "", /水果/, "当前题签是问句上方的小标签");
    const prev = ui.el.querySelector<HTMLButtonElement>('button[aria-label="上一题"]')!;
    assert.equal(ui.el.querySelector<HTMLButtonElement>('button[aria-label="下一题"]')!.disabled, false);
    await ui.act(async () => prev.click());
    assert.deepEqual(actions, [{ kind: "pick", index: 1 }, { kind: "submit" }, { kind: "tab", index: 0 }]);

    actions.length = 0;
    const review = parseClaudeAsk([
      ASK_RULE,
      "←  ☒ 颜色  ☒ 水果  ✔ Submit  →",
      "Review your answers",
      " ● 红、绿、蓝三种颜色里，你更喜欢哪一种？",
      "   → 红",
      " ● 下面这些水果你平时会吃哪些？",
      "   → 苹果",
      "Ready to submit your answers?",
      "❯ 1. Submit answers",
      "  2. Cancel",
    ])!;
    await render(review);
    const text = ui.el.textContent ?? "";
    assert.match(text, /确认提交这些回答？/);
    assert.match(text, /下面这些水果你平时会吃哪些？苹果/);
    await ui.click("提交回答");
    await ui.click("整组不答");
    assert.deepEqual(actions, [{ kind: "confirm" }, { kind: "cancel" }]);
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

test("输入框：点发送就清空，不等写进终端；发失败把原话放回去，已经接着打的字不覆盖（2026-10-25 用户：发送不够丝滑）", async () => {
  const ui = await mount();
  try {
    let finish: (err: string | null) => void = () => {};
    const sent: string[] = [];
    const onSend = (t: string) => {
      sent.push(t);
      return new Promise<string | null>((resolve) => (finish = resolve));
    };
    await ui.render(ui.h(ui.Composer, { onSend }));
    const box = ui.el.querySelector("textarea")!;
    await typeInto(ui, "第一句");
    await key(ui, "Enter");
    assert.deepEqual(sent, ["第一句"]);
    assert.equal(box.value, "", "写进终端之前就清空");
    await ui.act(async () => finish(null));
    assert.equal(box.value, "");

    // 发失败：框里还空着就放回原话，并显示错误
    await typeInto(ui, "第二句");
    await key(ui, "Enter");
    assert.equal(box.value, "");
    await ui.act(async () => finish("终端已重新启动，这句没有发出，请再发一次"));
    assert.equal(box.value, "第二句");
    assert.ok(ui.el.textContent?.includes("这句没有发出"));

    // 发失败时人已经接着打了字：不覆盖
    await key(ui, "Enter");
    await typeInto(ui, "新写的");
    await ui.act(async () => finish("发送失败：x"));
    assert.equal(box.value, "新写的");
  } finally {
    await ui.close();
  }
});

test("等你决定卡片：焦点在卡片所在的聊天区里按 Ctrl/⌘+Enter = 主按钮；输入框里写了字不抢，焦点在别处不响应", async () => {
  const ui = await mount();
  try {
    const hits: string[] = [];
    await ui.render(
      ui.h("div", { "data-chat-host": "t1" },
        ui.h(ui.Decision, {
          decision: {
            key: "trust",
            title: "启动前要你确认：是否信任这个目录",
            options: [
              { label: "信任此目录", primary: true, onClick: () => hits.push("trust") },
              { label: "不信任，退出", onClick: () => hits.push("exit") },
            ],
          },
          onOpenTerminal: () => {},
        }),
        ui.h("textarea", { "aria-label": "输入" }),
      ),
    );
    const press = (target: Element) =>
      ui.act(async () => {
        target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      });
    const box = ui.el.querySelector("textarea")!;
    // 主按钮带键帽，次按钮在它左边
    const buttons = Array.from(ui.el.querySelectorAll("footer button")).map((b) => b.textContent);
    assert.deepEqual(buttons, ["不信任，退出", "信任此目录Ctrl ↵"]);
    // 焦点不在这个聊天区：不响应
    await press(document.body);
    assert.deepEqual(hits, []);
    box.focus();
    await press(box);
    assert.deepEqual(hits, ["trust"]);
    // 输入框里有字：那是要发的话，不抢
    box.value = "先问一句";
    await press(box);
    assert.deepEqual(hits, ["trust"]);
  } finally {
    await ui.close();
  }
});

test("等你决定卡片：选项多或很长（Claude 审批菜单）时摆成整行列表，高亮那项序号用 CTA 并标键帽", async () => {
  const ui = await mount();
  try {
    const hits: number[] = [];
    const labels = ["Yes", "Yes, and don't ask again for echo commands in this project", "No, and tell Claude what to do differently"];
    await ui.render(
      ui.h(ui.Decision, {
        decision: {
          key: "menu",
          title: "Do you want to proceed?",
          options: labels.map((label, i) => ({ label, primary: i === 0, onClick: () => hits.push(i) })),
        },
        onOpenTerminal: () => {},
      }),
    );
    assert.equal(ui.el.querySelector("footer"), null, "列表时没有按钮底栏");
    const rows = Array.from(ui.el.querySelectorAll<HTMLButtonElement>('[role="listitem"]'));
    assert.deepEqual(rows.map((r) => r.textContent?.replace(/Ctrl ↵$/, "")), labels.map((l, i) => `${i + 1}${l}`));
    assert.match(rows[0].querySelector("span")!.className, /bg-cta/);
    await ui.act(async () => rows[2].click());
    assert.deepEqual(hits, [2]);
  } finally {
    await ui.close();
  }
});

test("Claude 方案确认卡：整篇方案、开工几项带权限说明、高亮项是主按钮、写意见 = 接着改方案", async () => {
  const ui = await mount();
  try {
    const picks: unknown[] = [];
    let terminal = 0;
    await ui.render(
      ui.h(ui.Decision, {
        decision: {
          key: "plan:x",
          title: "方案写好了，按这个方案开工吗？",
          hint: "开工后这段对话接着按选的那一档走",
          options: [],
          plan: {
            text: "# 方案：写一个探针文件\n\n1. 新建 mesa_probe.txt",
            path: "virtual-spinning-toucan.md",
            go: [
              { label: "按方案开工 · 帮我批准", description: "普通操作直接做，有风险的才问你", primary: true, onClick: () => picks.push(0) },
              { label: "按方案开工 · 请求批准", description: "改文件、跑命令前都先问你", onClick: () => picks.push(1) },
            ],
            others: [],
            onRevise: (text: string) => picks.push(["revise", text]),
          },
        },
        onOpenTerminal: () => terminal++,
      }),
    );
    const text = ui.el.textContent ?? "";
    assert.match(text, /方案写好了，按这个方案开工吗？/);
    assert.match(text, /方案：写一个探针文件/, "方案原文画在卡上");
    assert.match(text, /方案文件：virtual-spinning-toucan\.md/);
    assert.doesNotMatch(text, /Yes, and use auto mode|shift\+tab|"plan"/, "不摆英文原文、不摊参数 JSON");
    // 主按钮在底栏（带 ⌘↵ / Ctrl ↵ 键帽），整行列表里也有它
    const footer = ui.el.querySelector("footer")!;
    assert.match(footer.textContent ?? "", /按方案开工 · 帮我批准/);
    await ui.act(async () => ui.button("改文件、跑命令前都先问你").click());
    await fillInput(ui, "接着改方案：写下要改哪里", "第二步先写测试");
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="把意见交回去，它照着改方案"]')!.click());
    assert.equal(ui.el.querySelector<HTMLInputElement>('input[aria-label="接着改方案：写下要改哪里"]')!.value, "", "交了就清空");
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('button[aria-label="打开终端"]')!.click());
    assert.deepEqual(picks, [1, ["revise", "第二步先写测试"]]);
    assert.equal(terminal, 1);

    // 没有能打字的那一行（「Exit plan mode?」那种）：不出意见框，「先不开工」在底栏
    await ui.render(
      ui.h(ui.Decision, {
        decision: {
          key: "plan:y",
          title: "它想结束计划模式，开始动手吗？",
          options: [],
          plan: {
            text: null,
            path: null,
            go: [{ label: "按方案开工 · 请求批准", primary: true, onClick: () => picks.push("go") }],
            others: [{ label: "先不开工", onClick: () => picks.push("stay") }],
            onRevise: null,
          },
        },
        onOpenTerminal: () => {},
      }),
    );
    assert.equal(ui.el.querySelector('input[aria-label="接着改方案：写下要改哪里"]'), null);
    assert.doesNotMatch(ui.el.textContent ?? "", /照终端里显示的抄下来/);
    await ui.click("先不开工");
    assert.deepEqual(picks.slice(2), ["stay"]);

    // 方案是从屏上读的（Kimi / Gemini / CodeBuddy 没有旁路给方案时）：照原样分行，注明只有屏上那一截
    await ui.render(
      ui.h(ui.Decision, {
        decision: {
          key: "plan:z",
          title: "方案写好了，按这个方案开工吗？",
          options: [],
          plan: {
            text: "方案：写一个探针文件\n\n1. 新建 mesa_probe.txt",
            fromScreen: true,
            path: null,
            go: [{ label: "按方案开工", description: "权限回到这家 CLI 自己的设置", primary: true, onClick: () => {} }],
            others: [],
            onRevise: () => {},
          },
        },
        onOpenTerminal: () => {},
      }),
    );
    assert.match(ui.el.textContent ?? "", /照终端里显示的抄下来/);
    assert.match(ui.el.textContent ?? "", /权限回到这家 CLI 自己的设置/);
  } finally {
    await ui.close();
  }
});

test("终端在等你：终端原文、数字键 / 方向键 / 回车 / Esc 发给终端，网址做成按钮，要输入时给输入框", async () => {
  const ui = await mount();
  try {
    const keys: string[] = [];
    const links: string[] = [];
    let terminal = 0;
    await ui.render(
      ui.h(ui.Decision, {
        decision: {
          key: "wait:x",
          title: "终端在等你：Select login method:",
          hint: "Mesa 认不出这一步，下面是终端原文",
          options: [],
          screen: {
            lines: ["Select login method:", "", "❯ 1. Claude account", "  2. Console account", "  3. 3rd-party platform"],
            live: true,
            numbered: 3,
            links: ["https://claude.com/cai/oauth/authorize?code=true"],
            typeIn: true,
            keys: true,
            esc: true,
            onKey: (k: string) => keys.push(k),
            onOpenLink: (u: string) => links.push(u),
          },
        },
        onOpenTerminal: () => terminal++,
      }),
    );
    const text = ui.el.textContent ?? "";
    assert.match(text, /终端原文 · 实时/);
    assert.match(ui.el.querySelector("pre")!.textContent!, /❯ 1\. Claude account\n  2\. Console account/, "原文照排");
    await ui.click("2");
    await ui.click("↓");
    await ui.click("回车");
    await ui.click("Esc");
    await ui.click("在浏览器打开 · claude.com");
    const input = ui.el.querySelector<HTMLInputElement>("form input")!;
    await ui.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "  abc123  ");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await ui.click("发给终端");
    assert.deepEqual(keys, ["digit:2", "down", "enter", "esc", "text:abc123"]);
    assert.deepEqual(links, ["https://claude.com/cai/oauth/authorize?code=true"]);
    await ui.click("打开终端");
    assert.equal(terminal, 1, "去终端只在卡上由人点");
  } finally {
    await ui.close();
  }
});

test("没能启动：定格的最后几行、不给按键，重新启动是主按钮", async () => {
  const ui = await mount();
  try {
    const hits: string[] = [];
    await ui.render(
      ui.h(ui.Decision, {
        decision: {
          key: "launch-failed:127",
          title: "Codex 没能启动",
          detail: "它一启动就退出了（退出码 127）。终端里的最后几行：",
          options: [
            { label: "知道了", onClick: () => hits.push("dismiss") },
            { label: "重新启动", primary: true, onClick: () => hits.push("again") },
          ],
          screen: {
            lines: ["env: node: No such file or directory"],
            live: false,
            numbered: 0,
            links: [],
            typeIn: false,
            keys: false,
            esc: false,
            onKey: () => hits.push("key"),
            onOpenLink: () => {},
          },
        },
        onOpenTerminal: () => {},
      }),
    );
    const text = ui.el.textContent ?? "";
    assert.match(text, /终端原文env: node/);
    assert.doesNotMatch(text, /实时/);
    assert.equal(ui.el.querySelector("form"), null);
    assert.ok(!Array.from(ui.el.querySelectorAll("button")).some((b) => b.textContent === "↑"), "不给方向键");
    await ui.click("重新启动");
    await ui.click("知道了");
    assert.deepEqual(hits, ["again", "dismiss"]);
  } finally {
    await ui.close();
  }
});

test("异常直接展开原始输出，不把后续总结当成通过；重试只填草稿", async () => {
  const ui = await mount();
  try {
    const drafts: string[] = [];
    await ui.render(ui.h(ui.Conversation, { cwd: "/proj", onEditResend: (v: string) => drafts.push(v), messages: [
      {role: "user", timestamp: "1", usage: null, blocks: [{kind: "text", text: "检查", toolName: null}]},
      {role: "assistant", timestamp: "2", usage: null, blocks: [
        {kind: "tool_use", toolName: "Bash", text: '{"command":"npm test","workdir":"/proj"}'},
        {kind: "tool_result", toolName: null, text: "Exit code 1\nmissing fixture"},
        {kind: "text", toolName: null, text: "我已经完成。"},
      ]},
    ]}));
    await ui.click("1 步失败");
    assert.match(ui.el.querySelector('[data-scrolled="1"]')?.textContent ?? "", /missing fixture/);
    assert.doesNotMatch(ui.el.textContent ?? "", /验证通过|已恢复/);
    await ui.click("让它检查后重试");
    assert.equal(drafts.length, 1);
    assert.match(drafts[0], /npm test[\s\S]*missing fixture/);
    assert.match(ui.el.textContent ?? "", /1 步失败/);
  } finally { await ui.close(); }
});

test("引用追问只取当前回复选区，保留来源与范围，不自动发送", async () => {
  const ui = await mount();
  try {
    const quotes: any[] = [];
    await ui.render(ui.h(ui.Conversation, { messages: [{ id: "answer", role: "assistant", timestamp: null, usage: null, blocks: [{kind: "text", text: "前言。重点结论。后记。", toolName: null}] }], onQuote: (quote: unknown) => quotes.push(quote) }));
    const answer = ui.el.querySelector('[data-chat-answer]')!;
    const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode()!;
    const range = document.createRange(); range.setStart(text, 3); range.setEnd(text, 8);
    window.getSelection()!.addRange(range);
    await ui.click("引用追问");
    assert.equal(quotes[0].text, "重点结论。");
    assert.deepEqual(quotes[0].range, {start: 3, end: 8});
    assert.deepEqual(quotes[0].sourceKeys, ["assistant:id:answer"]);
  } finally { await ui.close(); }
});

test("引用条保持原草稿，发送异常恢复引用，移除引用不改正文；来源失效如实提示", async () => {
  const ui = await mount();
  try {
    const sent: string[] = [];
    const props = { onSend: async (text: string) => { sent.push(text); throw new Error("离线"); }, onLocateQuote: () => false };
    await ui.render(ui.h(ui.Composer, props));
    await typeInto(ui, "原草稿");
    await ui.render(ui.h(ui.Composer, { ...props, seedInsert: {text: "", paths: [], quote: {sourceKeys: ["a"], sourceText: "结论", text: "结论", range: {start: 0, end: 2}}} }));
    assert.equal(ui.el.querySelector("textarea")!.value, "原草稿");
    assert.ok(ui.el.querySelector('[aria-label="引用草稿"]'));
    await ui.click("定位原文");
    assert.match(ui.el.textContent ?? "", /来源暂不可定位/);
    await key(ui, "Enter");
    assert.equal(sent[0], "引用之前的回复：\n> 结论\n\n原草稿");
    assert.equal(ui.el.querySelector("textarea")!.value, "原草稿");
    assert.ok(ui.el.querySelector('[aria-label="引用草稿"]'));
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('[aria-label="移除引用"]')!.click());
    assert.equal(ui.el.querySelector("textarea")!.value, "原草稿");
    assert.equal(ui.el.querySelector('[aria-label="引用草稿"]'), null);
  } finally { await ui.close(); }
});

test("聊天搜索切换命中、分页后留在同一消息，说明范围；关闭和加载只触发对应动作", async () => {
  const ui = await mount();
  try {
    const msg = (id: string, text: string) => ({id, role: "assistant", timestamp: null, usage: null, blocks: [{kind: "text", text, toolName: null}]});
    const focuses: any[] = []; let loads = 0; let closes = 0;
    const props = { request: 1, hasOlder: true, loadingOlder: false, messages: [msg("a", "第一条 test"), msg("b", "第二条 test")], onFocus: (index: number, query: string) => focuses.push([index, query]), onLoadOlder: () => loads++, onClose: () => closes++ };
    await ui.render(ui.h(ui.ChatSearch, props));
    const input = ui.el.querySelector("input")!;
    await ui.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "test");
      input.dispatchEvent(new window.Event("input", {bubbles: true}));
    });
    assert.deepEqual(focuses.at(-1), [0, "test"]);
    await ui.act(async () => ui.el.querySelector<HTMLButtonElement>('[aria-label="下一条匹配"]')!.click());
    assert.deepEqual(focuses.at(-1), [1, "test"]);
    await ui.render(ui.h(ui.ChatSearch, {...props, messages: [msg("old", "更早的 test"), ...props.messages]}));
    assert.deepEqual(focuses.at(-1), [2, "test"]);
    assert.match(ui.el.textContent ?? "", /搜索已加载的 3 条消息/);
    await ui.click("加载更早消息继续查找"); assert.equal(loads, 1);
    await ui.act(async () => input.dispatchEvent(new window.KeyboardEvent("keydown", {key: "Escape", bubbles: true})));
    assert.equal(closes, 1);
  } finally { await ui.close(); }
});

test("长对话搜索重新定位已在虚拟窗口外的命中，旧高亮清除，流式更新不重复文字", async () => {
  const ui = await mount();
  try {
    const messages = Array.from({length: 70}, (_, i) => ({id: String(i), role: i % 2 ? "assistant" : "user", timestamp: null, usage: null, blocks: [{kind: "text", text: `消息${i}搜索词`, toolName: null}]}));
    await ui.render(ui.h(ui.Conversation, {messages}));
    await ui.render(ui.h(ui.Conversation, {messages, focusIndex: 1, focusKeywords: ["搜索词"]}));
    assert.match(ui.el.querySelector('[data-search-hit="1"]')?.textContent ?? "", /消息1搜索词/);
    assert.equal(ui.el.querySelectorAll("mark").length, 1);
    await ui.render(ui.h(ui.Conversation, {messages, focusIndex: 69, focusKeywords: ["搜索词"]}));
    assert.match(ui.el.querySelector('[data-search-hit="1"]')?.textContent ?? "", /消息69搜索词/);
    assert.equal(ui.el.querySelectorAll("mark").length, 1);
    const updated = messages.map((message, i) => i === 69 ? {...message, blocks: [{kind: "text", text: "消息69搜索词追加", toolName: null}]} : message);
    await ui.render(ui.h(ui.Conversation, {messages: updated, focusIndex: 69, focusKeywords: ["搜索词"]}));
    const text = ui.el.querySelector('[data-chat-answer]')?.textContent ?? "";
    assert.match(ui.el.querySelector('[data-search-hit="1"]')?.textContent ?? "", /消息69搜索词追加/);
    assert.doesNotMatch(text, /搜索词搜索词/);
  } finally { await ui.close(); }
});

test("确认快捷键不抢空搜索框，也不把只有引用的草稿当作空输入批准", async () => {
  const ui = await mount();
  try {
    let approvals = 0;
    await ui.render(ui.h('div', {'data-chat-host': 'active'},
      ui.h(ui.Decision, {decision: {key: 'approval', title: '是否继续', options: [{label: '允许', primary: true, onClick: () => approvals++}]}, onOpenTerminal: () => {}}),
      ui.h('div', {role: 'search'}, ui.h('input', {'aria-label': '搜索'})),
      ui.h(ui.Composer, {onSend: async () => null, seedInsert: {text: '', paths: [], quote: {sourceKeys: ['a'], sourceText: '引用', text: '引用', range: {start: 0, end: 2}}}}),
    ));
    for (const element of [ui.el.querySelector('input')!, ui.el.querySelector('textarea')!]) {
      element.focus();
      await ui.act(async () => element.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true})));
    }
    assert.equal(approvals, 0);
  } finally { await ui.close(); }
});

test("搜索同一轮的多条结果时定位各自输出，并展开截断之外的命中", async () => {
  const ui = await mount();
  try {
    const msg = (id: string, blocks: unknown[]) => ({id, role: 'assistant', timestamp: null, usage: null, blocks});
    const messages = [
      {id: 'q', role: 'user', timestamp: null, usage: null, blocks: [{kind: 'text', text: '检查', toolName: null}]},
      msg('call1', [{kind: 'tool_use', toolName: 'Bash', text: '{"command":"npm test"}', callId: '1'}]),
      msg('result1', [{kind: 'tool_result', toolName: null, text: '第一份 needle', callId: '1'}]),
      msg('call2', [{kind: 'tool_use', toolName: 'Bash', text: '{"command":"npm run build"}', callId: '2'}]),
      msg('result2', [{kind: 'tool_result', toolName: null, text: '普通行\n'.repeat(300)+'第二份 needle', callId: '2'}]),
      msg('answer', [{kind: 'text', text: '两份 needle 已记录', toolName: null}]),
    ];
    for (const [index, prefix] of [[2, '第一份'], [4, '第二份'], [5, '两份']] as const) {
      await ui.render(ui.h(ui.Conversation, {messages, focusIndex: index, focusKeywords: ['needle']}));
      const mark = ui.el.querySelector('mark');
      assert.ok(mark);
      assert.match(mark.parentElement?.textContent ?? '', new RegExp(prefix));
    }
  } finally { await ui.close(); }
});

test("生成中发送按钮的可访问名称与真实处理时机一致", async () => {
  const ui = await mount();
  try {
    const props = {running: true, onInterrupt: () => {}, onSend: async () => null};
    await ui.render(ui.h(ui.Composer, {...props, queueHint: {label: '下一步交给它', title: '下一步处理'}}));
    await typeInto(ui, '补充');
    assert.ok(ui.el.querySelector('button[aria-label="下一步交给它"]'));
    await ui.render(ui.h(ui.Composer, {...props, queueHint: {label: '发送', title: '由 AI 决定时机'}}));
    assert.ok(ui.el.querySelector('button[aria-label="发送"]'));
    assert.equal(ui.el.querySelector('button[aria-label="排队发送"]'), null);
  } finally { await ui.close(); }
});
