import type { LanguageFn } from "highlight.js";
import { isMermaidLanguage, languageFromCodeClass } from "./md-code-chrome.ts";

/**
 * 代码块语法高亮（聊天回复与笔记阅读共用，2026-10-21）。highlight.js 核心 + 科研常用的十几种语言，
 * 页面里真有写明语言的代码块才动态 import（不进主包）。只认围栏写明的语言、不猜：没写或不认识的原样不动。
 * hljs 自己转义正文，输出只有带 class 的 span；颜色在 App.css（.hljs-*，取主题强调色）。
 */

type Loader = () => Promise<{ default: LanguageFn }>;

const LANGUAGES: Record<string, Loader> = {
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  julia: () => import("highlight.js/lib/languages/julia"),
  matlab: () => import("highlight.js/lib/languages/matlab"),
  latex: () => import("highlight.js/lib/languages/latex"),
  bash: () => import("highlight.js/lib/languages/bash"),
  shell: () => import("highlight.js/lib/languages/shell"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  json: () => import("highlight.js/lib/languages/json"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  sql: () => import("highlight.js/lib/languages/sql"),
  rust: () => import("highlight.js/lib/languages/rust"),
  go: () => import("highlight.js/lib/languages/go"),
  java: () => import("highlight.js/lib/languages/java"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
};

const ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  jl: "julia",
  m: "matlab",
  tex: "latex",
  sh: "bash",
  zsh: "bash",
  console: "shell",
  ps1: "powershell",
  pwsh: "powershell",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsonc: "json",
  yml: "yaml",
  toml: "ini",
  html: "xml",
  svg: "xml",
  md: "markdown",
  rs: "rust",
  golang: "go",
  h: "c",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  patch: "diff",
  docker: "dockerfile",
  make: "makefile",
};

/** 围栏语言名 → 这里认的语言；不认识返回 null（原样显示，不猜） */
export function highlightLanguage(lang: string): string | null {
  const l = lang.trim().toLowerCase();
  if (!l) return null;
  const name = ALIASES[l] ?? l;
  return name in LANGUAGES ? name : null;
}

/** 超过这么长的代码块不高亮（逐字着色的 span 太多，滚动发沉） */
const MAX_CHARS = 60_000;

type HljsCore = typeof import("highlight.js").default;
let corePromise: Promise<HljsCore> | null = null;
const registered = new Map<string, Promise<void>>();

async function ensureLanguage(name: string): Promise<HljsCore> {
  corePromise ??= import("highlight.js/lib/core").then((m) => m.default as HljsCore);
  const hljs = await corePromise;
  let ready = registered.get(name);
  if (!ready) {
    ready = LANGUAGES[name]().then((m) => hljs.registerLanguage(name, m.default));
    registered.set(name, ready);
  }
  await ready;
  return hljs;
}

/**
 * 给 host 里写明语言的 `pre > code` 上色（已上过的跳过）。正文在 await 前快照，回来时节点已被换掉
 * 或内容变了就放弃——React 换了整段 HTML 时下一次 layout 会重新调。加载失败静默保持原样。
 */
export async function highlightCodeBlocks(host: HTMLElement): Promise<void> {
  const jobs = Array.from(host.querySelectorAll<HTMLElement>("pre > code"))
    .filter((el) => !el.dataset.hl)
    .map((el) => {
      const lang = languageFromCodeClass(el.className);
      const name = isMermaidLanguage(lang) ? null : highlightLanguage(lang);
      return { el, name, text: el.textContent ?? "" };
    })
    .filter((job): job is { el: HTMLElement; name: string; text: string } =>
      Boolean(job.name) && job.text.length <= MAX_CHARS,
    );
  for (const job of jobs) job.el.dataset.hl = "pending";
  for (const { el, name, text } of jobs) {
    try {
      const hljs = await ensureLanguage(name);
      if (!el.isConnected || el.textContent !== text) continue;
      el.innerHTML = hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
      el.dataset.hl = "1";
    } catch {
      el.dataset.hl = "failed";
    }
  }
}
