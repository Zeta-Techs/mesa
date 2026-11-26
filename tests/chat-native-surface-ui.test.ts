import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type { ChatChannelSnapshot } from "../src/chat-channel.ts";

// 聊天层原生模式真 ChatSurface 组件验收测试（JSDOM + esbuild 桩）：
// 覆盖 Claude 原生审批 / 提问表单 / 计划卡（含帮我批准热切 & 输入框打回修改）/ 权限热切与重开 / 流式 Markdown；
// Kimi ACP 三档热切 / 生成中禁插话 / 停止按钮提示；Codex 原生生成中插话。

const TAURI_STUB = `
  export async function invoke(cmd) { return cmd === "home_dir" ? "/Users/u" : /exist|list|files|refs|paths|search/i.test(cmd) ? [] : null; }
  export function convertFileSrc(s) { return s; }
  export async function openPath() {}
  export async function openUrl() {}
  export async function listen() { return () => {}; }
  export function getCurrentWindow() { return { listen: async () => () => {}, onFocusChanged: async () => () => {} }; }
  export function getCurrentWebview() { return { onDragDropEvent: async () => () => {} }; }
  export function getCurrentWebviewWindow() { return { listen: async () => () => {}, onDragDropEvent: async () => () => {}, onFocusChanged: async () => () => {}, label: "main" }; }
  export class Channel { constructor() { this.onmessage = () => {}; } }
  export async function readText() { return ""; }
  export async function writeText() {}
  export async function open() { return null; }
  export async function save() { return null; }
  export async function message() {}
  export async function ask() { return false; }
  export async function confirm() { return false; }
  export function getVersion() { return Promise.resolve("0"); }
  export const platform = () => "macos";
  export async function revealItemInDir() {}
  export async function check() { return null; }
`;

const bundled = await build({
  stdin: {
    contents: `
      export { createElement, act } from 'react';
      export { createRoot } from 'react-dom/client';
      export { default as ChatSurface } from './src/components/ChatSurface';
    `,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  logLevel: "silent",
  plugins: [
    {
      name: "native-surface-stub",
      setup(b) {
        b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: "urlstub" }));
        b.onLoad({ filter: /.*/, namespace: "urlstub" }, () => ({ loader: "js", contents: "export default ''" }));
        b.onResolve({ filter: /\.svg\?raw$/ }, (a) => ({ path: a.path, namespace: "svgraw" }));
        b.onLoad({ filter: /.*/, namespace: "svgraw" }, () => ({ loader: "js", contents: `export default "<svg></svg>"` }));
        b.onResolve({ filter: /ConfirmDialog$/ }, (a) => ({ path: a.path, namespace: "confirmstub" }));
        b.onLoad({ filter: /.*/, namespace: "confirmstub" }, () => ({
          loader: "js",
          contents: `
            export const confirmDialog = async (...args) => {
              globalThis.__nativeConfirm.calls.push(args);
              return globalThis.__nativeConfirm.answer;
            };
            export const alertDialog = async () => {};
          `,
        }));
        b.onResolve({ filter: /^@tauri-apps\// }, (a) => ({ path: a.path, namespace: "tauri" }));
        b.onLoad({ filter: /.*/, namespace: "tauri" }, () => ({ loader: "js", contents: TAURI_STUB }));
      },
    },
  ],
});

const req = createRequire(import.meta.url);
const bundleCode = bundled.outputFiles[0].text;

function mountDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const g = globalThis as Record<string, unknown>;
  const saved: Array<[string, PropertyDescriptor | undefined]> = [];
  const bindings: Record<string, unknown> = {
    window: w,
    document: w.document,
    navigator: w.navigator,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLInputElement: w.HTMLInputElement,
    Node: w.Node,
    Element: w.Element,
    DOMParser: w.DOMParser,
    MutationObserver: w.MutationObserver,
    Event: w.Event,
    KeyboardEvent: w.KeyboardEvent,
    MouseEvent: w.MouseEvent,
    CustomEvent: w.CustomEvent,
    localStorage: w.localStorage,
    sessionStorage: w.sessionStorage,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w),
    cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true,
    __nativeConfirm: { calls: [] as unknown[], answer: true },
  };
  for (const [k, v] of Object.entries(bindings)) {
    saved.push([k, Object.getOwnPropertyDescriptor(g, k)]);
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  }
  const Noop = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  (w as any).ResizeObserver = g.ResizeObserver = Noop;
  (w as any).IntersectionObserver = g.IntersectionObserver = Noop;
  (w as any).matchMedia = g.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  w.Element.prototype.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};

  const errors: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => {
    const s = a.map((x) => (x instanceof Error ? x.stack ?? x.message : String(x))).join(" ");
    if (!/act\(|not wrapped/.test(s)) errors.push(s);
  };

  const mod = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundleCode)(req, mod, mod.exports);
  const { createElement, act, createRoot, ChatSurface } = mod.exports;

  const rootEl = w.document.getElementById("root")!;
  const root = createRoot(rootEl);
  return {
    w,
    rootEl,
    root,
    createElement,
    act,
    ChatSurface,
    errors,
    confirmHost: g.__nativeConfirm as { calls: unknown[]; answer: boolean },
    async cleanup() {
      await act(async () => root.unmount());
      console.error = origErr;
      for (const [k, desc] of saved) {
        if (desc) Object.defineProperty(g, k, desc);
        else delete g[k];
      }
      dom.window.close();
    },
  };
}

function baseChannel(patch: Partial<ChatChannelSnapshot> = {}): ChatChannelSnapshot {
  return {
    tabId: "t1",
    agent: "claude-code",
    kind: "claude-native",
    connection: "connected",
    sessionId: "s-native-1",
    transcriptPath: "/tmp/s-native-1.jsonl",
    sessionSeq: 1,
    sessionSource: null,
    turn: { seq: 1, status: "running", stopReason: null, startedAt: 1, endedAt: null },
    approval: null,
    liveText: null,
    notice: null,
    activity: null,
    thinking: null,
    thinkingLive: null,
    backgroundStarted: 0,
    canSend: true,
    ...patch,
  };
}

function baseLaunchPick(agentId: string, permissionModes: string[]) {
  return {
    editable: false,
    resumeSessionId: null,
    agentId,
    profileId: "p-gateway",
    model: "claude-sonnet-4-5",
    profiles: [{ id: "p-gateway", label: "中转网关" }],
    models: ["claude-sonnet-4-5"],
    effort: "",
    effortLevels: [],
    permission: "write_tree" as const,
    permissionMode: "ask" as const,
    permissionModes,
    readonlySupported: true,
    permissionNote: null,
    observedTier: null,
    autoNote: null,
  };
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    messages: [
      {
        role: "user",
        blocks: [{ kind: "text", text: "帮我检查一下这个脚本", toolName: null }],
        timestamp: "2026-11-26T08:00:00Z",
        usage: null,
        id: "u1",
      },
    ],
    state: "linked",
    syncState: "watching",
    loading: false,
    active: true,
    agentId: "claude-code",
    cwd: "/tmp/work",
    running: true,
    canResume: false,
    attention: "working",
    readOnly: false,
    readonlySupported: true,
    skills: [],
    mcps: [],
    onSend: async () => null,
    onAllowWrite: () => {},
    onOpenTerminal: () => {},
    onInterrupt: () => {},
    onApprovalKey: () => {},
    hooksEnabled: false,
    ptyQuiet: false,
    nativeOn: true,
    onNativeToggle: () => {},
    tabId: "t1",
    sessionId: "s-native-1",
    hasStatusBar: false,
    ...overrides,
  };
}

function setTextareaValue(w: any, ta: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(ta, value);
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
}

function pressEnter(w: any, el: HTMLElement) {
  el.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

function findButton(rootEl: HTMLElement, textIncludes: string): HTMLButtonElement | null {
  return (
    Array.from(rootEl.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(textIncludes)) ?? null
  );
}

test("Claude 原生模式：流式 Markdown + 审批卡（允许 / 本会话都允许 / 拒绝）+ 绝不出终端等你卡", async () => {
  const env = mountDom();
  const { createElement, act, ChatSurface } = env;
  try {
    const replies: Array<{ rid: string; dec: string; answers?: unknown; msg?: string }> = [];
    const onChannelReply = async (rid: string, dec: string, answers?: unknown, msg?: string) => {
      replies.push({ rid, dec, answers, msg });
      return true;
    };

    // 1. 流式 Markdown + 实时思考
    await act(async () => {
      env.root.render(
        createElement(
          ChatSurface,
          baseProps({
            channel: baseChannel({
              liveText: "## 检查结论\n\n已确认 **原生通道** 正常",
              thinkingLive: "先核对审批参数与权限档…",
            }),
            liveReply: ["## 检查结论", "", "已确认 **原生通道** 正常"],
            liveReplySource: "markdown",
            ptyQuiet: true,
            onChannelReply,
          }),
        ),
      );
    });
    assert.ok(env.rootEl.querySelector("h2")?.textContent?.includes("检查结论"), "原生模式应按 Markdown 渲染标题");
    assert.ok(env.rootEl.querySelector("strong")?.textContent?.includes("原生通道"), "原生模式应按 Markdown 渲染粗体");
    assert.equal(env.rootEl.textContent?.includes("终端在等你"), false, "原生模式下即使 ptyQuiet 也不应弹终端等你卡");

    // 2. 原生审批卡：命令原文 + 允许 / 本会话都允许 / 拒绝
    await act(async () => {
      env.root.render(
        createElement(
          ChatSurface,
          baseProps({
            attention: "confirm",
            channel: baseChannel({
              turn: { seq: 1, status: "awaiting_approval", stopReason: null, startedAt: 1, endedAt: null },
              approval: {
                requestId: "req-bash-1",
                replyable: true,
                toolName: "Bash",
                kind: "execute",
                command: "echo mesa-ok > /tmp/probe.txt",
                path: null,
                oldText: null,
                newText: null,
                diff: null,
                detail: "写入探针文件",
                alwaysLabel: "本会话都允许",
              },
            }),
            onChannelReply,
          }),
        ),
      );
    });
    assert.ok(env.rootEl.textContent?.includes("echo mesa-ok > /tmp/probe.txt"), "审批卡应显示命令原文");
    const allowBtn = findButton(env.rootEl, "允许");
    const alwaysBtn = findButton(env.rootEl, "本会话都允许");
    const denyBtn = findButton(env.rootEl, "拒绝");
    assert.ok(allowBtn && alwaysBtn && denyBtn, "审批卡应渲染允许 / 本会话都允许 / 拒绝三个按钮");

    await act(async () => alwaysBtn.click());
    await act(async () => denyBtn.click());
    assert.deepEqual(
      replies.map((r) => [r.rid, r.dec]),
      [
        ["req-bash-1", "allow_always"],
        ["req-bash-1", "deny"],
      ],
    );
    assert.deepEqual(env.errors, []);
  } finally {
    await env.cleanup();
  }
});

test("Claude 原生模式：AskUserQuestion 提问表单支持点选与底部输入框直接打字回复（不误走 onSend）", async () => {
  const env = mountDom();
  const { createElement, act, ChatSurface } = env;
  try {
    const replies: Array<{ rid: string; dec: string; answers?: Record<string, string> }> = [];
    const sent: string[] = [];
    await act(async () => {
      env.root.render(
        createElement(
          ChatSurface,
          baseProps({
            attention: "confirm",
            channel: baseChannel({
              turn: { seq: 1, status: "awaiting_approval", stopReason: null, startedAt: 1, endedAt: null },
              approval: {
                requestId: "req-ask-1",
                replyable: true,
                toolName: "AskUserQuestion",
                kind: "other",
                command: null,
                path: null,
                oldText: null,
                newText: null,
                diff: null,
                detail: null,
                alwaysLabel: null,
                questions: [
                  {
                    question: "输出格式选哪种？",
                    header: "格式",
                    multiSelect: false,
                    options: [
                      { label: "Markdown 报告", description: "适合直接阅读" },
                      { label: "JSON 数据", description: "适合脚本继续处理" },
                    ],
                  },
                ],
              },
            }),
            onSend: async (t: string) => {
              sent.push(t);
              return null;
            },
            onChannelReply: async (rid: string, dec: string, answers?: Record<string, string>) => {
              replies.push({ rid, dec, answers });
              return true;
            },
          }),
        ),
      );
    });
    assert.ok(env.rootEl.textContent?.includes("输出格式选哪种？"), "应渲染原生提问标题");
    assert.ok(env.rootEl.textContent?.includes("Markdown 报告"), "应渲染原生提问选项");

    // 在底部输入框直接打字回答：应直接提交给原生提问卡而不是走 onSend
    const ta = env.rootEl.querySelector("textarea") as HTMLTextAreaElement;
    assert.ok(ta, "应存在底部输入框");
    await act(async () => {
      setTextareaValue(env.w, ta, "两份都给我");
    });
    await act(async () => {
      pressEnter(env.w, ta);
    });
    assert.equal(sent.length, 0, "原生提问激活时底部输入框不应误走 onSend");
    assert.deepEqual(replies, [
      { rid: "req-ask-1", dec: "allow", answers: { "输出格式选哪种？": "两份都给我" } },
    ]);
    assert.deepEqual(env.errors, []);
  } finally {
    await env.cleanup();
  }
});

test("Claude 原生模式：ExitPlanMode 方案卡支持「帮我批准热切」「每次问我」以及底部输入框提修改意见", async () => {
  const env = mountDom();
  const { createElement, act, ChatSurface } = env;
  try {
    const replies: Array<{ rid: string; dec: string; msg?: string }> = [];
    const inlineSwitched: string[] = [];
    const planLeft: Array<string | null> = [];
    const sent: string[] = [];

    const planChannel = baseChannel({
      turn: { seq: 1, status: "awaiting_approval", stopReason: null, startedAt: 1, endedAt: null },
      approval: {
        requestId: "req-plan-1",
        replyable: true,
        toolName: "ExitPlanMode",
        kind: "other",
        command: null,
        path: "/tmp/work/plan.md",
        oldText: null,
        newText: null,
        diff: null,
        detail: null,
        alwaysLabel: null,
        plan: "1. 更新解析逻辑\n2. 补齐单元测试",
      },
    });

    await act(async () => {
      env.root.render(
        createElement(
          ChatSurface,
          baseProps({
            attention: "confirm",
            channel: planChannel,
            onSend: async (t: string) => {
              sent.push(t);
              return null;
            },
            onChannelReply: async (rid: string, dec: string, _a?: unknown, msg?: string) => {
              replies.push({ rid, dec, msg });
              return true;
            },
            onInlinePermission: (tier: string) => inlineSwitched.push(tier),
            onPlanLeft: (tier: string | null) => planLeft.push(tier),
          }),
        ),
      );
    });

    assert.ok(env.rootEl.textContent?.includes("方案写好了，要按它开工吗？"));
    const goAutoBtn = findButton(env.rootEl, "按方案开工（帮我批准）");
    const goAskBtn = findButton(env.rootEl, "按方案开工（每次问我）");
    assert.ok(goAutoBtn && goAskBtn, "原生方案卡应同时提供「帮我批准」与「每次问我」开工按钮");

    // 1. 点「按方案开工（帮我批准）」：先放行 ExitPlanMode，随后同步热切 auto 并通知离开计划模式
    await act(async () => {
      goAutoBtn.click();
      await Promise.resolve();
    });
    assert.deepEqual(replies[0], { rid: "req-plan-1", dec: "allow", msg: undefined });
    assert.deepEqual(planLeft, ["auto"]);
    assert.deepEqual(inlineSwitched, ["auto"]);

    // 2. 点「按方案开工（每次问我）」：只放行并通知 ask（Claude 批准后本身就回 default，不额外发切 auto）
    await act(async () => {
      goAskBtn.click();
      await Promise.resolve();
    });
    assert.deepEqual(replies[1], { rid: "req-plan-1", dec: "allow", msg: undefined });
    assert.deepEqual(planLeft, ["auto", "ask"]);
    assert.deepEqual(inlineSwitched, ["auto"]);

    // 3. 在底部输入框直接提修改意见：拦截走 onRevise（带意见 deny），不误走 onSend
    const ta = env.rootEl.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setTextareaValue(env.w, ta, "把第二步拆成两个测试");
    });
    await act(async () => {
      pressEnter(env.w, ta);
    });
    assert.equal(sent.length, 0, "原生方案卡激活时底部输入框不应误走 onSend");
    assert.deepEqual(replies[2], { rid: "req-plan-1", dec: "deny", msg: "把第二步拆成两个测试" });
    assert.deepEqual(env.errors, []);
  } finally {
    await env.cleanup();
  }
});

test("原生模式权限热切与回合中发话：Claude 原地切 ask/auto、full 走重开；Kimi 三档原地热切且回合中禁插话", async () => {
  const env = mountDom();
  const { createElement, act, ChatSurface } = env;
  try {
    const inlineCalls: string[] = [];
    let restarts = 0;
    const picked: Array<[string, string | null | undefined]> = [];

    // —— Claude 原生：ask/auto 热切，full 走重开 ——
    await act(async () => {
      env.root.render(
        createElement(
          ChatSurface,
          baseProps({
            attention: "done",
            channel: baseChannel({
              turn: { seq: 1, status: "completed", stopReason: "end_turn", startedAt: 1, endedAt: 2 },
            }),
            launchPick: baseLaunchPick("claude-code", ["ask", "auto", "full"]),
            onPickLaunch: {
              agent: () => {},
              profile: () => {},
              model: () => {},
              effort: () => {},
              permission: (p: string, m?: string | null) => picked.push([p, m]),
            },
            onInlinePermission: (t: string) => inlineCalls.push(`claude:${t}`),
            onRestartPermission: () => {
              restarts += 1;
            },
          }),
        ),
      );
    });
    const claudePermBtn = findButton(env.rootEl, "请求批准");
    assert.ok(claudePermBtn, "底部应显示当前权限芯片「请求批准」");
    await act(async () => claudePermBtn.click());
    const autoItem = findButton(env.rootEl, "帮我批准");
    assert.ok(autoItem, "权限菜单应列出「帮我批准」");
    await act(async () => autoItem.click());
    assert.deepEqual(inlineCalls, ["claude:auto"], "Claude 原生切「帮我批准」应原地热切不重开");
    assert.equal(restarts, 0);

    // 再点「完全访问」：应弹确认框并走重开
    await act(async () => claudePermBtn.click());
    const fullItem = findButton(env.rootEl, "完全访问");
    assert.ok(fullItem, "权限菜单应列出「完全访问」");
    await act(async () => fullItem.click());
    assert.equal(env.confirmHost.calls.length, 1, "Claude 切「完全访问」应先弹风险确认");
    assert.equal(restarts, 1, "Claude 原生切「完全访问」应走重开接回");

    // —— Kimi ACP：三档原地热切（含完全访问）+ 生成中禁插话（不给无效 Esc 按钮） ——
    const sentKimi: string[] = [];
    await act(async () => {
      env.root.render(
        createElement(
          ChatSurface,
          baseProps({
            agentId: "kimi",
            attention: "working",
            channel: baseChannel({
              agent: "kimi",
              kind: "acp",
              turn: { seq: 2, status: "running", stopReason: null, startedAt: 10, endedAt: null },
            }),
            launchPick: baseLaunchPick("kimi", ["ask", "auto", "full"]),
            onSend: async (t: string) => {
              sentKimi.push(t);
              return null;
            },
            onPickLaunch: {
              agent: () => {},
              profile: () => {},
              model: () => {},
              effort: () => {},
              permission: (p: string, m?: string | null) => picked.push([p, m]),
            },
            onInlinePermission: (t: string) => inlineCalls.push(`kimi:${t}`),
            onRestartPermission: () => {
              restarts += 1;
            },
          }),
        ),
      );
    });
    // Kimi 生成中：占位字与按钮区明确标明「等这轮结束」，回车不得走 onSend，且不出现「立即发送」按键按钮
    const ta = env.rootEl.querySelector("textarea") as HTMLTextAreaElement;
    assert.ok(
      ta.placeholder.includes("这一轮还在回复，等它结束或先点停止再发"),
      `Kimi ACP 生成中占位字应提示等本轮结束，实际：${ta.placeholder}`,
    );
    await act(async () => {
      setTextareaValue(env.w, ta, "顺手再查一下");
    });
    assert.ok(env.rootEl.textContent?.includes("等这轮结束"), "Kimi ACP 生成中发送区应显示「等这轮结束」");
    assert.equal(findButton(env.rootEl, "立即发送"), null, "Kimi ACP 不应出现无效的 Esc/Ctrl+S 立即发送按钮");
    assert.equal(findButton(env.rootEl, "插进这一轮"), null, "Kimi ACP 不应出现终端模式的 Ctrl+S 插进这一轮按钮");
    await act(async () => {
      pressEnter(env.w, ta);
    });
    assert.equal(sentKimi.length, 0, "Kimi ACP 生成中回车不得发往已阻塞的 ACP 通道");

    // Kimi 原生三档原地热切：连「完全访问」也直接热切、不触发重启
    const kimiPermBtn = findButton(env.rootEl, "请求批准");
    assert.ok(kimiPermBtn);
    await act(async () => kimiPermBtn.click());
    const kimiFull = findButton(env.rootEl, "完全访问");
    assert.ok(kimiFull);
    await act(async () => kimiFull.click());
    assert.ok(inlineCalls.includes("kimi:full"), "Kimi ACP 切「完全访问」应经 session/set_mode 原地热切");
    assert.equal(restarts, 1, "Kimi ACP 切完全访问不应触发重启");

    // —— Codex 原生：生成中支持直接插话，不给终端 Esc 立即发送按钮 ——
    const sentCodex: string[] = [];
    await act(async () => {
      env.root.render(
        createElement(
          ChatSurface,
          baseProps({
            agentId: "codex",
            attention: "working",
            channel: baseChannel({
              agent: "codex",
              kind: "codex",
              turn: { seq: 3, status: "running", stopReason: null, startedAt: 20, endedAt: null },
            }),
            onSend: async (t: string) => {
              sentCodex.push(t);
              return null;
            },
          }),
        ),
      );
    });
    const codexTa = env.rootEl.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setTextareaValue(env.w, codexTa, "顺便把边界条件补上");
    });
    assert.ok(env.rootEl.textContent?.includes("下一步交给它"), "Codex 原生生成中应显示「下一步交给它」");
    assert.equal(findButton(env.rootEl, "立即发送"), null, "Codex 原生不应出现终端 Esc 立即发送按钮");
    await act(async () => {
      pressEnter(env.w, codexTa);
    });
    assert.deepEqual(sentCodex, ["顺便把边界条件补上"], "Codex 原生生成中回车应直接走 onSend 插话");

    // —— Grok 原生（ACP）：虽然终端模式下 escInterruptSafe=false，但原生走 session/cancel 应正常渲染停止按钮 ——
    let grokStopped = 0;
    await act(async () => {
      env.root.render(
        createElement(
          ChatSurface,
          baseProps({
            agentId: "grok",
            attention: "working",
            channel: baseChannel({
              agent: "grok",
              kind: "acp",
              turn: { seq: 4, status: "running", stopReason: null, startedAt: 30, endedAt: null },
            }),
            onInterrupt: () => {
              grokStopped += 1;
            },
          }),
        ),
      );
    });
    const grokStopBtn = Array.from(env.rootEl.querySelectorAll("button")).find((b) =>
      (b.getAttribute("title") ?? "").includes("经官方协议请求停止"),
    );
    assert.ok(grokStopBtn, "Grok 原生模式应显示走官方协议的停止按钮");
    await act(async () => grokStopBtn.click());
    assert.equal(grokStopped, 1);
    assert.deepEqual(env.errors, []);
  } finally {
    await env.cleanup();
  }
});
