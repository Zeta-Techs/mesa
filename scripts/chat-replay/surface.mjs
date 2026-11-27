/**
 * 聊天层回放：用 timeline.ts 生成的实时预览序列驱动真 ChatSurface（JSDOM，Tauri 全部打桩），
 * 回合结束后按 --delay 把会话文件的最终消息接上，每 40ms 记一次画面，最后报：
 *   重复（同一句同时出现两次）、闪没（消失后又出现）、消失（出现过、后来不见）、「终端在等你」卡、
 *   过程区标签与折叠容器的变化、文字总长骤降。有重复 / 闪没 / 消失 / 等你卡时退出码为 1。
 *
 * 2026-11-25 用它查出：会话文件晚于 4 秒落盘时回复整段空半秒（settleHoldMs）、Claude 2.1.326 工具说明被当成回复
 * （toolHeadAbove）、Gemini 的 hooks 状态行混进预览。说明与场景见同目录 README.md。
 *
 * 用法：node scripts/chat-replay/surface.mjs <序列.json> <最终回复.md> [选项]
 *   --delay <毫秒>      会话文件比回合结束晚多少毫秒落盘（默认 350）；先于结束信号写负数，要连等号：--delay=-300
 *   --agent <id>        传给 ChatSurface 的 agentId（默认取序列里的 agent）
 *   --channel <kind>    同步喂一份结构化旁路快照（如 claude-native / acp / codex / qwen / opencode），模拟原生模式实时思考与流式通道
 *   --thinking-stream   在正文到来前按块流式喂入超过 120 字的多句实时思考原文，校验前端完整呈现（不被 48 字/首句截断）并在正文到来后让位
 *   --keys "a|b|c"      判定用的几句（默认从最终回复里自动挑：首、中、尾几行的开头）
 *   --tool-flow a,b     这一轮先调工具：a 秒落 tool_use、b 秒落 tool_result，回复正文照 --delay 落（工具说明见 --tool-desc）
 *   --tool-desc <字>    工具调用的说明文字（默认「写一个探针文件」）
 *   --prev-reply <md>   上一轮的回复（记录里已有：上一句 --prev-prompt + 这份回复），看第二轮
 *   --prev-prompt / --prompt   上一句 / 这一句发出的话（默认 TRIGGER_LONG 写长一点 / 同序列抓屏时发的那句请自行对上）
 *   --snap 9.5,9.9      到这些时刻打印对话区结构；配 --grep <字> 只打印含这串字的那个元素的 HTML
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const repo = new URL("../../", import.meta.url);
const req = createRequire(new URL("package.json", repo));
const { JSDOM } = req("jsdom");

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    delay: { type: "string", default: "350" },
    agent: { type: "string" },
    channel: { type: "string" },
    "thinking-stream": { type: "boolean", default: false },
    keys: { type: "string" },
    "tool-flow": { type: "string" },
    "tool-desc": { type: "string", default: "写一个探针文件" },
    "prev-reply": { type: "string" },
    "prev-prompt": { type: "string", default: "TRIGGER_LONG 写长一点" },
    prompt: { type: "string", default: "TRIGGER_LONG 写长一点" },
    snap: { type: "string", default: "" },
    grep: { type: "string" },
  },
});
const [timelinePath, replyPath] = positionals;
if (!timelinePath || !replyPath) throw new Error("用法见文件头注释");

// —— 打包真 ChatSurface（同 tests/*-ui.test.ts 的 esbuild 桩，Tauri 接口一律打桩） ——
const TAURI_STUB = `
  export async function invoke(cmd) { return globalThis.__invoke ? globalThis.__invoke(cmd) : null; }
  export function convertFileSrc(s) { return s; } export async function openPath() {} export async function openUrl() {}
  export async function listen() { return () => {}; }
  export function getCurrentWindow() { return { listen: async () => () => {}, onFocusChanged: async () => () => {} }; }
  export function getCurrentWebview() { return { onDragDropEvent: async () => () => {} }; }
  export function getCurrentWebviewWindow() { return { listen: async () => () => {}, onDragDropEvent: async () => () => {}, onFocusChanged: async () => () => {}, label: "main" }; }
  export class Channel { constructor() { this.onmessage = () => {}; } }
  export async function readText() { return ""; } export async function writeText() {}
  export async function open() { return null; } export async function save() { return null; }
  export async function message() {} export async function ask() { return false; } export async function confirm() { return false; }
  export function getVersion() { return Promise.resolve("0"); } export const platform = () => "macos";
  export async function revealItemInDir() {} export async function check() { return null; }`;
const bundled = await build({
  stdin: {
    contents: `export { createElement } from 'react'; export { createRoot } from 'react-dom/client';
      export { default as ChatSurface } from './src/components/ChatSurface';`,
    resolveDir: fileURLToPath(repo),
    loader: "tsx",
  },
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom/client", "react/jsx-runtime", "jsdom"],
  logLevel: "silent",
  plugins: [
    {
      name: "stub-tauri",
      setup(b) {
        b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: "urlstub" }));
        b.onLoad({ filter: /.*/, namespace: "urlstub" }, () => ({ loader: "js", contents: "export default ''" }));
        b.onResolve({ filter: /^@tauri-apps\// }, (a) => ({ path: a.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", contents: TAURI_STUB }));
      },
    },
  ],
});

// —— JSDOM（pretendToBeVisual：requestAnimationFrame 按 60Hz 真跑，匀速放字 / 折叠动画照常走） ——
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const w = dom.window;
const g = globalThis;
Object.assign(g, {
  window: w, document: w.document, HTMLElement: w.HTMLElement, Node: w.Node, Element: w.Element, DOMParser: w.DOMParser,
  getComputedStyle: w.getComputedStyle.bind(w), requestAnimationFrame: w.requestAnimationFrame.bind(w),
  cancelAnimationFrame: w.cancelAnimationFrame.bind(w), MutationObserver: w.MutationObserver, Event: w.Event,
  KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, CustomEvent: w.CustomEvent,
  HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLInputElement: w.HTMLInputElement,
  localStorage: w.localStorage, sessionStorage: w.sessionStorage, IS_REACT_ACT_ENVIRONMENT: false,
});
Object.defineProperty(g, "navigator", { value: w.navigator, configurable: true });
const Noop = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
w.ResizeObserver = g.ResizeObserver = Noop;
w.IntersectionObserver = g.IntersectionObserver = Noop;
w.matchMedia = g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
w.Element.prototype.scrollTo = function () {};
w.HTMLElement.prototype.scrollIntoView = function () {};
const errors = [];
console.error = (...a) => {
  const s = a.map((x) => (x && x.stack ? x.stack : String(x))).join(" ");
  if (!/act\(|not wrapped/.test(s)) errors.push(s.slice(0, 1200));
};
process.on("unhandledRejection", (e) => errors.push(`unhandled: ${String(e?.message ?? e).slice(0, 300)}`));
// 后端命令：home_dir 给个字符串，列表类给空数组，其余 null（真后端的返回形状不同时 ChatSurface 会报错，见「控制台错误」）
g.__invoke = (cmd) => (cmd === "home_dir" ? "/Users/u" : /exist|list|files|refs|paths|search/i.test(cmd) ? [] : null);

const mod = { exports: {} };
new Function("require", "module", "exports", bundled.outputFiles[0].text)(req, mod, mod.exports);
const { createElement, createRoot, ChatSurface } = mod.exports;

// —— 场景 ——
const tl = JSON.parse(readFileSync(timelinePath, "utf8"));
const frames = tl.frames;
const endAt = tl.endAt ?? (frames.at(-1)?.t ?? 0) + 0.5;
const reply = readFileSync(replyPath, "utf8").trim();
const D = Number(opt.delay) / 1000;
const ts = (n) => new Date(Date.UTC(2026, 10, 25, 12, 0, n)).toISOString();
const msg = (role, text, n) => ({ role, blocks: [{ kind: "text", text, toolName: null }], timestamp: ts(n), usage: null, id: `${role}-${n}` });
// 前面垫一轮带工具调用与表格的历史：过程区收起、回答排版都走一遍
const history = [
  msg("user", "先看看 live-reply.ts 是做什么的", 1),
  { role: "assistant", blocks: [{ kind: "thinking", text: "先读文件。", toolName: null }, { kind: "tool_use", text: '{"file_path":"src/live-reply.ts"}', toolName: "Read", callId: "c1" }], timestamp: ts(2), usage: null, id: "a-2" },
  { role: "user", blocks: [{ kind: "tool_result", text: "（文件内容）", toolName: null, callId: "c1" }], timestamp: ts(3), usage: null, id: "u-3" },
  msg("assistant", "`live-reply.ts` 按每家画面布局读终端屏，抽出这一轮正在写的段落。\n\n| 项 | 说明 |\n|---|---|\n| 输入框 | boxTop |\n| 预览 | extractLiveReply |", 4),
];
if (opt["prev-reply"]) history.push(msg("user", opt["prev-prompt"], 5), msg("assistant", readFileSync(opt["prev-reply"], "utf8").trim(), 6));
const user = msg("user", opt.prompt, 10);

const autoKeys = () => {
  // 表格行、代码块不挑：落盘后排成真表格 / 代码块，原文里的「|」「```」不在画面上
  let fence = false;
  const lines = reply.split("\n").filter((l) => {
    if (/^\s*```/.test(l)) fence = !fence;
    return !fence && !/^\s*```/.test(l) && !l.includes("|");
  }).map((l) => l.replace(/^[#>*\-\d.\s`]+/, "").replace(/[*`]/g, "").trim().slice(0, 14))
    // 回复里只出现一次的才能拿来判重复（小标题里的文件名表格里还有一份）
    .filter((k) => k.length >= 10 && reply.replace(/[*`]/g, "").split(k).length === 2);
  const pick = [...new Set([0, Math.floor(lines.length / 3), Math.floor((2 * lines.length) / 3), lines.length - 1])].map((i) => lines[i]);
  return pick.filter(Boolean);
};
const KEYS = opt.keys ? opt.keys.split("|") : autoKeys();

const agentId = opt.agent ?? tl.agent ?? "claude-code";
const makeChannel = (patch = {}) =>
  opt.channel
    ? {
        tabId: "t1",
        agent: agentId,
        kind: opt.channel,
        connection: "connected",
        sessionId: "s1",
        transcriptPath: "/tmp/s1.jsonl",
        sessionSeq: 1,
        sessionSource: null,
        turn: { seq: 1, status: "running", stopReason: null, startedAt: 1, endedAt: null },
        approval: null,
        liveText: null,
        notice: null,
        activity: null,
        thinking: null,
        thinkingLive: null,
        canSend: true,
        backgroundStarted: 0,
        ...patch,
      }
    : null;
const THINKING_CHUNKS = [
  "第一句先核对需求范围。",
  "接下来对比 Python、Rust、TypeScript 在桌面工具开发中的打包体积、并发能力与生态成熟度，",
  "同时检查 Windows 盘符路径、反斜杠归一化与中文文件名 UTF-8 编码是否一致，",
  "最后整理成四列对比表与结论，确保思考过程完整输出不被截断。",
];
const THINKING_TAIL_KEY = "确保思考过程完整输出不被截断";
const thinkLead = opt["thinking-stream"] && opt.channel ? 1.2 : 0;
let state = {
  messages: [...history, user],
  attention: "working",
  liveReply: null,
  liveReplyStyled: null,
  liveReplySource: null,
  channel: makeChannel(
    thinkLead > 0
      ? { thinking: THINKING_CHUNKS[0], thinkingLive: THINKING_CHUNKS[0] }
      : { thinkingLive: "先梳理三个文件各自负责的边界…" },
  ),
};
const noop = () => {};
const props = () => ({
  messages: state.messages, state: "linked", syncState: "watching", loading: false, active: true,
  agentId, cwd: "/tmp/w", running: true, canResume: false, attention: state.attention,
  readOnly: false, readonlySupported: true, skills: [], mcps: [], onSend: async () => null, onAllowWrite: noop,
  onOpenTerminal: noop, onInterrupt: noop, onApprovalKey: noop, hooksEnabled: true, ptyQuiet: false,
  liveReply: state.liveReply, liveReplySource: state.liveReplySource, liveReplyStyled: state.liveReplyStyled,
  channel: state.channel, nativeOn: opt.channel ? true : null,
  tabId: "t1", sessionId: "s1", hasStatusBar: true,
});
const rootEl = w.document.getElementById("root");
const root = createRoot(rootEl);
const render = () => root.render(createElement(ChatSurface, props()));
render();

// —— 采样 ——
const samples = [];
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const count = (hay, needle) => hay.split(needle).length - 1;
const sample = () => {
  const text = rootEl.textContent ?? "";
  samples.push({
    t: +now().toFixed(3),
    counts: KEYS.map((k) => count(text, k)),
    len: text.length,
    collapse: rootEl.querySelectorAll(".ccode-collapse").length,
    wait: count(text, "终端在等你"),
    thinkTail: thinkLead > 0 ? count(text, THINKING_TAIL_KEY) : 0,
    label: (text.match(/已思考[^，。\s]{0,8}|已工作[^，。\s]{0,8}/g) ?? []).join("|"),
  });
};
const timer = setInterval(sample, 40);
const describe = (el) => {
  const parts = [];
  const walk = (n, depth) => {
    for (const c of n.children) {
      const cls = typeof c.className === "string" ? c.className.split(/\s+/).filter((x) => /ccode|collapse|live|caret|md-/.test(x)).join(".") : "";
      if (["TABLE", "PRE", "BUTTON"].includes(c.tagName) || cls) {
        parts.push(`${"  ".repeat(Math.min(depth, 6))}<${c.tagName.toLowerCase()}${cls ? `.${cls}` : ""}> ${(c.textContent ?? "").replace(/\s+/g, " ").slice(0, 80)}`);
      }
      if (depth < 30) walk(c, depth + 1);
    }
  };
  walk(el, 0);
  return parts.slice(-40).join("\n");
};
for (const st of opt.snap.split(",").filter(Boolean).map(Number)) {
  setTimeout(() => {
    const body = opt.grep
      ? [...rootEl.querySelectorAll("*")].filter((e) => e.children.length < 8 && (e.textContent ?? "").includes(opt.grep)).slice(-1).map((e) => e.outerHTML.slice(0, 1500)).join("\n")
      : describe(rootEl);
    console.log(`\n===== t=${st} =====\n${body}`);
  }, st * 1000);
}

// —— 事件：实时思考逐块（可选）→ 预览逐帧 → 回合结束（attention done，hooks Stop / 程序状态 idle）→ 会话文件落盘 ——
const events = [];
if (thinkLead > 0) {
  let acc = THINKING_CHUNKS[0];
  for (let i = 1; i < THINKING_CHUNKS.length; i++) {
    acc += THINKING_CHUNKS[i];
    const snapText = acc;
    events.push([
      +(0.25 * i).toFixed(3),
      () =>
        (state = {
          ...state,
          channel: makeChannel({ thinking: snapText, thinkingLive: snapText, liveText: null }),
        }),
    ]);
  }
}
for (const f of frames) {
  events.push([
    +(f.t + thinkLead).toFixed(3),
    () =>
      (state = {
        ...state,
        liveReply: f.lines,
        liveReplyStyled: f.styled,
        liveReplySource: tl.source ?? "screen",
        channel: makeChannel({ liveText: f.lines.join("\n"), thinking: null, thinkingLive: null }),
      }),
  ]);
}
const endAtShifted = +(endAt + thinkLead).toFixed(3);
events.push([
  endAtShifted,
  () =>
    (state = {
      ...state,
      attention: "done",
      channel: makeChannel({
        turn: { seq: 1, status: "completed", stopReason: "end_turn", startedAt: 1, endedAt: 2 },
        liveText: null,
        thinking: null,
        thinkingLive: null,
      }),
    }),
]);
if (opt["tool-flow"]) {
  const [tUse, tRes] = opt["tool-flow"].split(",").map((v) => +(Number(v) + thinkLead).toFixed(3));
  const use = { role: "assistant", blocks: [{ kind: "tool_use", text: JSON.stringify({ command: "echo mesa > mesa_probe.txt", description: opt["tool-desc"] }), toolName: "Bash", callId: "b1" }], timestamp: ts(11), usage: null, id: "a-11" };
  const res = { role: "user", blocks: [{ kind: "tool_result", text: "ok", toolName: null, callId: "b1" }], timestamp: ts(14), usage: null, id: "u-14" };
  const text = { role: "assistant", blocks: [{ kind: "text", text: reply, toolName: null }], timestamp: ts(15), usage: null, id: "a-15" };
  if (endAtShifted + D < tRes) console.log(`注意：--delay 让回复正文早于工具结果（${(endAtShifted + D).toFixed(2)}s < ${tRes}s），真实会话文件不会这样排`);
  events.push([tUse, () => (state = { ...state, messages: [...history, user, use] })]);
  events.push([tRes, () => (state = { ...state, messages: [...history, user, use, res] })]);
  events.push([endAtShifted + D, () => (state = { ...state, messages: [...history, user, use, res, text] })]);
} else {
  const final = { role: "assistant", blocks: [{ kind: "thinking", text: "先想一下怎么组织。", toolName: null }, { kind: "text", text: reply, toolName: null }], timestamp: ts(20), usage: null, id: "a-20" };
  events.push([endAtShifted + D, () => (state = { ...state, messages: [...history, user, final] })]);
}
events.sort((a, b) => a[0] - b[0]);
for (const [t, fn] of events) {
  await new Promise((r) => setTimeout(() => { fn(); render(); r(); }, Math.max(0, t - now()) * 1000));
}
await new Promise((r) => setTimeout(r, 5000));
clearInterval(timer);
sample();

// —— 判定 ——
const problems = [];
KEYS.forEach((k, i) => {
  const dup = samples.filter((s) => s.counts[i] > 1);
  if (dup.length) problems.push(`重复：「${k}」同时出现两次，${dup.length} 帧，首次 t=${dup[0].t}`);
  let seen = false;
  let gone = null;
  for (const s of samples) {
    if (s.counts[i] > 0) {
      if (gone !== null) problems.push(`闪没：「${k}」t=${gone}–${s.t} 消失后又出现`);
      gone = null;
      seen = true;
    } else if (seen && gone === null) gone = s.t;
  }
  if (gone !== null) problems.push(`消失：「${k}」t=${gone} 起不见了`);
});
const waitFrames = samples.filter((s) => s.wait > 0).length;
if (waitFrames) problems.push(`「终端在等你」出现 ${waitFrames} 帧`);
if (thinkLead > 0) {
  const thinkSeen = samples.filter((s) => s.thinkTail > 0).length;
  if (!thinkSeen) problems.push(`实时思考尾句「${THINKING_TAIL_KEY}」从未出现（疑似 48 字/首句截断）`);
  const lastSample = samples[samples.length - 1];
  if (lastSample && lastSample.thinkTail > 0) problems.push("正文落盘结束后实时思考预览仍残留未让位");
}
if (errors.length) problems.push(`控制台错误 ${errors.length} 条`);
const changes = (key) => {
  const out = [];
  let prev;
  for (const s of samples) if (s[key] !== prev) out.push(`${s.t}:${s[key] === "" ? "∅" : s[key]}`), (prev = s[key]);
  return out.join("  ");
};
const drops = [];
for (let i = 1; i < samples.length; i++) {
  if (samples[i].len < samples[i - 1].len - 40 && samples[i].t > 0.5) drops.push(`${samples[i].t}:${samples[i - 1].len}→${samples[i].len}`);
}
console.log(`延迟 ${opt.delay}ms，回合结束 ${endAtShifted}s，采样 ${samples.length} 帧，判定句：${KEYS.map((k) => `「${k}」`).join("")}`);
console.log(problems.length ? problems.join("\n") : "未见重复 / 闪没 / 消失");
console.log(`过程标签：${changes("label")}`);
console.log(`折叠容器：${changes("collapse")}`);
console.log(`文字总长骤降：${drops.slice(0, 12).join("  ") || "无"}（预览里终端画的表格落盘后换成真表格，字数会少，属正常）`);
if (errors.length) console.log(`控制台错误：\n${errors.slice(0, 3).join("\n")}`);
root.unmount();
process.exit(problems.length ? 1 : 0);
