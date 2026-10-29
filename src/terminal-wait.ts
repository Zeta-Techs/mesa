/**
 * 「终端在等你」通用卡与 Claude Code 首次启动两屏（纯逻辑，读 xterm 可视区文本行）。
 *
 * 2026-10-27 用户拍板：聊天层认不出终端里在等什么时，不再自动弹出底部终端，改在聊天里出一张通用卡——
 * 把终端里那一块原样贴出来（跟着屏实时变），下面给方向键 / 回车 / Esc / 数字键，要输入文字时给输入框，
 * 屏上的网址做成链接；去终端处理只在卡上、由人点。认得出的屏照旧走专用卡（审批、信任、提问、面板…）。
 *
 * Claude Code 第一次运行先问配色、再给一屏安全须知（2.1.308 空 HOME 实录，样本在 tests/fixtures/terminal-wait/）：
 * 这两屏 Mesa 替人走完（配色选「跟随终端」，Windows 上按 Mesa 主题明暗选），信任文件夹仍由人在信任卡上点。
 */

export interface WaitScreen {
  /** 卡片标题里「终端在等你：」后面那句（屏上的问句 / 第一行）；没有可用的为空串 */
  title: string;
  /** 终端里那一块的原文：去掉启动字符画、方框竖边，连续空行并成一行，最多 MAX_LINES 行 */
  lines: string[];
  /** 屏上带序号的选项有几项（1. 2. 3.…，从 1 连续数）；没有为 0 */
  numbered: number;
  /** 屏上的网址（折到下一行的接上）；按出现顺序、去重 */
  links: string[];
  /** 屏上在等人输入一段文字（「Paste code here」这类提示） */
  typeIn: boolean;
}

const MAX_LINES = 16;
// 实线分隔（Claude 信任屏、审批框上沿）：问题那一块从它下面开始
const SOLID_RULE = /^\s*[╭╰]?[─━═]{8,}[╮╯]?\s*$/;
// 启动字符画用的块字符和点、星（Claude 欢迎屏的像素小人与星空）
const ART_CHARS = /[░▒▓█▄▀▌▐▖▗▘▙▚▛▜▝▞▟■.*·]/g;
const QUESTION_END = /[?？:：]$/;
// 没有问号时，以这些词开头的那行是在问人（同 tui-menu.ts ASK）
const ASK = /^(?:Do you want|Would you like|Allow|Switch|Select|Choose|Are you sure|Apply|Proceed|Confirm|Paste|Enter)\b/i;
const NUMBERED_LINE = /^\s*(?:[❯›>▶●]\s*)?(\d{1,2})[.)]\s+\S/;
const URL = /https?:\/\/\S+/g;
const TYPE_IN = /\b(?:paste|enter|type)\b.*\b(?:here|code|key|token)\b/i;

/** 启动字符画的一行（块字符、点、星占六成以上）：摘录与提示正文都不要它 */
export function isArt(line: string): boolean {
  const solid = line.replace(/\s+/g, "");
  if (solid.length < 3) return /^[.*·\s]+$/.test(line) && solid.length > 0;
  const art = solid.match(ART_CHARS)?.length ?? 0;
  return art / solid.length >= 0.6;
}

/** 剥方框左右竖边（Gemini / Grok 把整块画在框里），行尾空白去掉 */
function unbox(line: string): string {
  return line
    .replace(/[\s█▐▌]+$/, "")
    .replace(/\s*[│┃]$/, "")
    .replace(/^(\s*)[│┃]/, "$1 ");
}

/**
 * 读屏上「在等你」的那一块。屏上没有字返回 null。只管摘录，不判断该不该出卡（调用方按注意力 / 卡住 / 选择器决定）。
 */
export function waitScreenOf(raw: readonly string[]): WaitScreen | null {
  const lines = raw.map(unbox);
  let end = lines.length - 1;
  // 框的下沿、底部空行与字符画都不算内容
  while (end >= 0 && (!lines[end].trim() || isArt(lines[end]) || SOLID_RULE.test(lines[end]))) end--;
  if (end < 0) return null;
  let start = 0;
  for (let i = end; i >= 0; i--) {
    if (SOLID_RULE.test(lines[i]) || isArt(lines[i])) {
      start = i + 1;
      break;
    }
  }
  const block: string[] = [];
  for (const line of lines.slice(start, end + 1)) {
    if (isArt(line)) continue;
    if (!line.trim() && (!block.length || !block[block.length - 1].trim())) continue;
    block.push(line);
  }
  // 公共缩进去掉：终端里统一缩进一两格，卡上不必留
  const indent = Math.min(...block.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  const text = block.map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length)));
  if (!text.length) return null;
  const shown = text.slice(0, MAX_LINES);
  return {
    title: titleOf(text),
    lines: shown,
    numbered: numberedCount(text),
    links: linksOf(text),
    typeIn: text.some((l) => TYPE_IN.test(l)),
  };
}

function titleOf(text: readonly string[]): string {
  const clean = (l: string) => l.replace(/^\s*[❯›>▶●]\s*/, "").trim();
  const filled = text.map(clean).filter((l) => l && !/^https?:\/\//.test(l));
  const question =
    filled.find((l) => QUESTION_END.test(l) && l.length <= 120) ?? filled.find((l) => ASK.test(l));
  const pick = question ?? filled[0] ?? "";
  return pick.length > 80 ? `${pick.slice(0, 79)}…` : pick;
}

function numberedCount(text: readonly string[]): number {
  const seen = new Set<number>();
  for (const l of text) {
    const m = NUMBERED_LINE.exec(l);
    if (m) seen.add(Number(m[1]));
  }
  let n = 0;
  while (seen.has(n + 1)) n++;
  return n >= 2 ? n : 0;
}

/** 网址折行：终端把长网址硬折到下一行，下一行顶格、中间没有空格的算续行 */
function linksOf(text: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    for (const m of text[i].matchAll(URL)) {
      let url = m[0];
      const atLineEnd = m.index! + m[0].length >= text[i].trimEnd().length;
      for (let j = i + 1; atLineEnd && j < text.length && /^\S+$/.test(text[j]); j++) url += text[j];
      url = url.replace(/[)>\].,;'"]+$/, "");
      if (!out.includes(url)) out.push(url);
    }
  }
  return out;
}

/** 通用卡上的一下按键 */
export type WaitKey = "up" | "down" | "enter" | "esc" | `digit:${number}` | `text:${string}`;

/** 按键对应写进终端的字节（回车由调用方按这家的提交键换，Kimi 是 CSI-u） */
export function waitKeyBytes(key: WaitKey): string[] {
  if (key === "up") return ["\x1b[A"];
  if (key === "down") return ["\x1b[B"];
  if (key === "enter") return ["\r"];
  if (key === "esc") return ["\x1b"];
  if (key.startsWith("digit:")) return [key.slice(6)];
  // 文字整段写一次再回车（Ink 的输入行接得住一整段）；换行压成空格，免得提前提交
  return [key.slice(5).replace(/[\r\n]+/g, " "), "\r"];
}

// ===== Claude Code 第一次启动 =====

export type ClaudeFirstRunStep =
  | { kind: "theme"; options: string[]; selected: number }
  | { kind: "security"; text: string[] };

const THEME_HEAD = /Choose the text style that looks best with your terminal/;
const SECURITY_HEAD = /^\s*Security notes:\s*$/;
const PRESS_ENTER = /Press Enter to continue/i;

/** 认 Claude 首次启动的配色屏 / 安全须知屏；都不是返回 null */
export function claudeFirstRunStep(lines: readonly string[]): ClaudeFirstRunStep | null {
  const head = lines.findIndex((l) => THEME_HEAD.test(l));
  if (head >= 0) {
    const options: string[] = [];
    let selected = -1;
    for (let i = head + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) {
        if (options.length) break;
        continue;
      }
      if (/^\s*To change this later/i.test(l)) continue;
      const m = /^\s*(❯)?\s*(?:✔\s*)?(\S.*?)\s*$/.exec(l);
      if (!m || /^[╌─━]/.test(m[2])) break;
      if (m[1]) selected = options.length;
      options.push(m[2]);
    }
    return options.length >= 2 && selected >= 0 ? { kind: "theme", options, selected } : null;
  }
  const sec = lines.findIndex((l) => SECURITY_HEAD.test(l));
  const enter = lines.findIndex((l) => PRESS_ENTER.test(l));
  if (sec >= 0 && enter > sec) {
    const text = lines
      .slice(sec, enter)
      .map((l) => l.trim())
      .filter((l, i, arr) => l || (i > 0 && arr[i - 1]));
    while (text.length && !text[text.length - 1]) text.pop();
    return { kind: "security", text };
  }
  return null;
}

/**
 * 配色选哪一项：能跟随终端的选「Auto」（Mesa 回报主题底色，Claude 按它定深浅）；Windows 的 ConPTY 吞掉底色查询
 * （terminal.md「OSC 底色握手」），Auto 判不出，改按 Mesa 主题选 Light / Dark mode。找不到返回 -1
 */
export function claudeThemeTarget(options: readonly string[], prefer: "auto" | "light" | "dark"): number {
  const find = (re: RegExp) => options.findIndex((o) => re.test(o));
  if (prefer === "auto") {
    const auto = find(/^Auto\b/i);
    if (auto >= 0) return auto;
  }
  return prefer === "light" ? find(/^Light mode$/i) : find(/^Dark mode$/i);
}

/** 配色项给人看的名字（聊天里那行说明用） */
export function claudeThemeLabel(option: string): string {
  if (/^Auto\b/i.test(option)) return "跟随终端（随 Mesa 主题深浅）";
  if (/^Light mode$/i.test(option)) return "浅色";
  if (/^Dark mode$/i.test(option)) return "深色";
  return option;
}

/** 首次启动替人走完的那几步（聊天里留一行说明） */
export interface FirstRunNote {
  /** 选的配色（给人看的名字）；没走到这步为 null */
  theme: string | null;
  /** 安全须知原文；没走到这步为 null */
  security: string[] | null;
}

// ===== 启动失败 =====

/** Agent 一启动就退出（还没接上会话）：退出码与终端最后几行，聊天里出「没能启动」卡 */
export interface LaunchFailure {
  code: number;
  lines: string[];
}

/** 退出那一刻屏上最后几行有字的（不含字符画），最多 n 行 */
export function exitTail(raw: readonly string[], n = 8): string[] {
  const lines = raw.map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() && !isArt(l));
  return lines.slice(-n);
}

/** 认得出的启动失败原因，给一句白话；认不出为 null */
export function launchFailureHint(lines: readonly string[], code: number): string | null {
  const text = lines.join("\n");
  if (/env: node: No such file or directory|node: (?:command )?not found|'node' is not recognized/i.test(text))
    return "这台电脑上找不到 Node：这家 Agent 是用 npm 装的，要靠 Node 才能运行。到「设置 → 诊断 → 依赖体检」里检测或安装 Node 后重新启动。";
  if (code === 127 || /command not found|No such file or directory/i.test(text))
    return "找不到要运行的程序：可能没装好或被移走了。到「连接」页重新检测这家 Agent。";
  if (/EACCES|permission denied/i.test(text)) return "没有权限运行这个程序。";
  // Codex 官方账号启动先联网查一次工作区路由，连不上 OpenAI 就超时退出（0.165 实测：account/read failed … timed out，code -32603）
  if (/workspace routing discovery timed out|account\/read failed/i.test(text))
    return "连不上 OpenAI：Codex 官方账号启动时要先联网确认账号，这台电脑现在访问不到。检查网络，或到「设置 → 网络」填出网代理（官方账号启动会走它）后重新启动。";
  return null;
}

// ===== 认得出的首次启动屏：Gemini 要存密钥、Cursor 要登录（2026-10-27 空 HOME 实录，样本 tests/fixtures/terminal-wait/） =====

/** 后端拦 Gemini 认证方式时话里带的那一句（agents.rs GEMINI_AUTH_MARK 同字）：聊天层据此出「设成 API Key 并启动」卡 */
export const GEMINI_AUTH_MARK = "把认证方式设成 API Key";

/** 启动被拦下、聊天层能给出处理办法的那类（目前只有 Gemini 认证方式） */
export interface LaunchBlock {
  kind: "gemini-auth";
  message: string;
}

export function launchBlockOf(error: string): LaunchBlock | null {
  return error.includes(GEMINI_AUTH_MARK) ? { kind: "gemini-auth", message: error.replace(/^Error:\s*/, "") } : null;
}

export type SpecialScreen =
  /** Gemini「Enter Gemini API Key」：回车会把密钥存进系统钥匙串（原先被当成「面板」） */
  | { kind: "gemini-key-store" }
  /** Cursor 没登录：「Press any key to log in」或已经给出登录链接 */
  | { kind: "cursor-login"; url: string | null };

export function specialScreenOf(raw: readonly string[], agent: string | null | undefined): SpecialScreen | null {
  const lines = raw.map(unbox);
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  if (agent === "gemini" && has(/^\s*Enter Gemini API Key\s*$/) && has(/system keychain/i)) {
    return { kind: "gemini-key-store" };
  }
  if (agent === "cursor") {
    if (has(/click this link to log in/i) || has(/Signing in with the browser/i)) {
      const text = lines.map((l) => l.trim()).filter(Boolean);
      return { kind: "cursor-login", url: linksOf(text)[0] ?? null };
    }
    if (has(/Press any key to log in/i)) return { kind: "cursor-login", url: null };
  }
  return null;
}
