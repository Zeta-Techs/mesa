//! 终端输入侧纯逻辑：图片粘贴 / 文件拖入 / 右键菜单共用的可测函数（tests/terminal-input.test.ts）。

import { isLightTheme } from "./themes.ts";

/** POSIX shell 安全字符：落进集合内的路径不包裹，直接写进终端更干净 */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** Windows 追加反斜杠：它是路径的常规成分，不该仅因为它就给每条路径都套上引号 */
const SHELL_SAFE_WIN = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

/** shell 路径转义：含空格/引号等特殊字符时整体包裹。
 *  POSIX 用单引号（单引号自身转 '\''）；Windows 用双引号（自身双写）——
 *  PowerShell / cmd / 各家 agent TUI 都认双引号，而 cmd 里单引号只是字面字符。
 *  注意 Windows 分支不能沿用 POSIX 规则：`\` 不在 POSIX 安全集里，会导致**每一条**
 *  Windows 绝对路径都被套引号，而 macOS 上干净路径是裸写的——agent 收到的形态平白分叉。 */
export function escapeShellPath(path: string, isWindows = false): string {
  if (isWindows) {
    if (SHELL_SAFE_WIN.test(path)) return path;
    return `"${path.replace(/"/g, '""')}"`;
  }
  if (SHELL_SAFE.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** 拖入的多个路径转义后以空格拼接（不换行——只进输入框，避免直接执行） */
export function joinDroppedPaths(paths: string[], isWindows = false): string {
  return paths
    .filter((p) => p.length > 0)
    .map((p) => escapeShellPath(p, isWindows))
    .join(" ");
}

/** 聊天层拖入：一行一个路径（和粘贴图片附件同形，发给 Agent 当正文） */
export function joinDroppedChatPaths(
  paths: string[],
  isWindows = false,
): string {
  return paths
    .filter((p) => p.length > 0)
    .map((p) => escapeShellPath(p, isWindows))
    .join("\n");
}

/** Tauri 拖放坐标命中检测：物理像素与 CSS 像素都试（HumanTasksList / 终端同款） */
export function dropHitsRect(
  position: { x: number; y: number },
  rect: { left: number; top: number; right: number; bottom: number },
  devicePixelRatio = 1,
): boolean {
  const scale = devicePixelRatio || 1;
  return [
    [position.x, position.y],
    [position.x / scale, position.y / scale],
  ].some(
    ([px, py]) =>
      px >= rect.left &&
      px <= rect.right &&
      py >= rect.top &&
      py <= rect.bottom,
  );
}

/** kimi TUI 开了 kitty 键盘协议后只认的 CSI-u 序列（xterm.js 不支持该协议，由宿主改写） */
export const KIMI_CSI_U_ENTER = "\x1b[13u";
export const KIMI_CSI_U_CTRL_V = "\x1b[118;5u";
/** Codex composer 默认 shift-enter = 换行。xterm.js 对 Shift+Enter 仍发 `\r`，会被当成发送。
 *  kitty CSI-u：键 13（Enter）+ 修饰位 2（Shift）。Codex 0.154 含 KeyboardEnhancement。 */
export const CODEX_CSI_U_SHIFT_ENTER = "\x1b[13;2u";
/** claude-code 官方 terminal-setup 给别家终端装的正是 `ESC+CR`（Alacritty 键位表 / iTerm2
 *  映射同款）：它从不 push kitty 协议，多行换行认 \x1b\r 或 Ctrl+J，xterm 默认发 \r 会直接提交。 */
export const CLAUDE_SHIFT_ENTER = "\x1b\r";
/** Cursor 的输入解析接受 CSI-u 13;2u（chunk 9969.index.js 实证），且从不查询/推送 kitty 协议。 */
export const CURSOR_CSI_U_SHIFT_ENTER = "\x1b[13;2u";

/** Shift+Enter 要改写成非 `\r` 的序列时返回载荷；不需要改写返回 null（让 xterm 原样穿透）。 */
export function ptyShiftEnterRewrite(agentId: string): string | null {
  if (agentId === "codex") return CODEX_CSI_U_SHIFT_ENTER;
  if (agentId === "cursor") return CURSOR_CSI_U_SHIFT_ENTER;
  if (agentId === "claude-code") return CLAUDE_SHIFT_ENTER;
  return null;
}

/** Shift+标点丢字的补发决议。xterm 在 keyCode 229 时不自己发字符，等 textarea。
 *  WKWebView 上中文输入法开着时，Shift+数字/标点的 `key` 常是 `"Process"`，
 *  物理键在 `code`（Digit1、Digit3、Slash）。只认 Slash 时，Shift+1 补不出 `!`；
 *  Shift+3 第一下靠 xterm 写出 `#`，第二下组词收尾再写一遍，变成 `##`。
 *  美式键盘的 Shift 档按物理键补那一个符号，并 return false 拦住 xterm 再发。
 *
 *  汉字上屏也是 229，但 `code` 不是下面这张表：不补，避免「你你」。
 *  不按 Shift 的数字、字母交给 xterm。带 Ctrl/Alt/Cmd 不补。 */
export type PrintableKeyFallback = { action: "send"; data: string };

/** 与 xterm KEYCODE_KEY_MAPPINGS 的 Shift 档一致（美式键盘）。 */
const SHIFTED_FROM_CODE: Record<string, string> = {
  Digit1: "!",
  Digit2: "@",
  Digit3: "#",
  Digit4: "$",
  Digit5: "%",
  Digit6: "^",
  Digit7: "&",
  Digit8: "*",
  Digit9: "(",
  Digit0: ")",
  Minus: "_",
  Equal: "+",
  BracketLeft: "{",
  BracketRight: "}",
  Backslash: "|",
  Semicolon: ":",
  Quote: '"',
  Comma: "<",
  Period: ">",
  Slash: "?",
  Backquote: "~",
};

export function printableKeyFallback(e: {
  type: string;
  key: string;
  code?: string;
  keyCode: number;
  shiftKey?: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): PrintableKeyFallback | null {
  if (e.type !== "keydown") return null;
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.shiftKey && e.code) {
    const shifted = SHIFTED_FROM_CODE[e.code];
    // keyCode >= 48 时 xterm 自己会发；0 与 229 它发不出。只补这两档，避免正常键变成两个。
    if (shifted && (e.keyCode === 0 || e.keyCode === 229)) {
      return { action: "send", data: shifted };
    }
  }
  if (e.key.length !== 1) return null;
  const code = e.key.charCodeAt(0);
  if (code < 32 || code === 127) return null;
  if (e.keyCode === 0) return { action: "send", data: e.key };
  return null;
}

/** 补发之后，xterm 仍可能从 textarea / 组词收尾再送出同一个符号。
 *  同一符号连续补发时把待吞次数加上，两下 Shift+3 得到 `##`，不会被吞成一个，也不会变成四个。 */
export interface PrintableEchoGuard {
  char: string;
  count: number;
  until: number;
}

export function armPrintableEcho(
  guard: PrintableEchoGuard,
  char: string,
  now: number,
  windowMs = 400,
): PrintableEchoGuard {
  if (guard.char === char && now < guard.until) {
    return { char, count: guard.count + 1, until: now + windowMs };
  }
  return { char, count: 1, until: now + windowMs };
}

/** 命中则吞掉这一记并返回更新后的守卫；不是回声则原样交还、守卫不动。 */
export function takePrintableEcho(
  guard: PrintableEchoGuard,
  data: string,
  now: number,
): { swallow: boolean; guard: PrintableEchoGuard } {
  if (guard.count > 0 && now < guard.until && data === guard.char) {
    const count = guard.count - 1;
    return {
      swallow: true,
      guard: count > 0 ? { ...guard, count } : { char: "", count: 0, until: 0 },
    };
  }
  return { swallow: false, guard };
}

/** 剪贴板条目里挑出第一张图片（image/*），无图片返回 null（不干预默认文本粘贴） */
export function firstImageItem(
  items: readonly { type: string }[],
): number {
  return items.findIndex((it) => it.type.startsWith("image/"));
}

/** 图片 MIME → 落盘扩展名（白名单外的类型一律 png，与 Rust 端 save_clipboard_image 口径一致） */
export function imageExtFromMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

/** 粘贴图片成功后的轻反馈文案（名字太长截断，避免状态栏被路径撑爆） */
/** 去掉常见 Markdown 标记，留下可读的字。代码块围栏去掉，里面的字留下。
 *  不处理单下划线斜体，避免把文件名里的下划线拆掉。 */
export function markdownToPlain(text: string): string {
  let plain = text.replace(/\r\n/g, "\n");
  plain = plain.replace(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, "$1");
  plain = plain.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  plain = plain.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  plain = plain.replace(/`([^`]+)`/g, "$1");
  plain = plain.replace(/\*\*([^*]+)\*\*/g, "$1");
  plain = plain.replace(/__([^_]+)__/g, "$1");
  plain = plain.replace(/~~([^~]+)~~/g, "$1");
  plain = plain.replace(/(^|[\s])\*([^*\n]+)\*(?=[\s]|$)/g, "$1$2");
  plain = plain.replace(/^#{1,6}\s+/gm, "");
  plain = plain.replace(/^>\s?/gm, "");
  plain = plain.replace(/^(\s*)[-*+]\s+/gm, "$1");
  plain = plain.replace(/^(\s*)\d+[.)]\s+/gm, "$1");
  return plain;
}

export function pasteImageFeedback(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return `已粘贴图片路径：${name.length > 40 ? `${name.slice(0, 37)}…` : name}`;
}

/** OSC 10/11 前景/底色回报的 16-bit RGB 载荷（Windows 下主动推给 agent TUI）。 */
export function xtermOscColorReport(
  slot: 10 | 11,
  color: string,
): string | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const rgb = [0, 2, 4]
    .map((offset) => match[1].slice(offset, offset + 2).toLowerCase())
    .map((channel) => `${channel}${channel}`);
  return `\x1b]${slot};rgb:${rgb[0]}/${rgb[1]}/${rgb[2]}\x1b\\`;
}

/** 启动时会用 OSC 10/11 查询终端底色、并把回报**消费掉**的 agent（逐个核过 CLI 实现）。
 *  - gemini 0.57.0：TerminalCapabilityManager.detectCapabilities，1s 超时，回报进 onData 后丢弃
 *  - qwen 0.22.2（gemini-cli fork）：detectOsc11Theme，同款 onData 消费
 *  - codex 0.162：tui/src/terminal_probe/terminal_identity.rs 重新引入 ]10;? / ]11;? 探测
 *    （0.150 曾短暂移除；旧版 codex 收到没人消费的回报会把字节落进输入框，见下行警告）。
 *  白名单之外**一律不能推**：没人消费的字节会原样落进 TUI 输入框变成可见乱码，
 *  claude-code 走 settings.json 的 theme 配置、不探测。 */
const TERMINAL_BG_PROBING_AGENTS = new Set(["gemini", "qwen", "codex"]);

/** 是否要在 attach 后主动把终端前景/底色推给 agent。
 *  仅 Windows：ConPTY 两个方向都不转发 OSC 10/11 查询，agent 探不到底色只能回落深色。
 *  仅 agent 且在探测白名单内：见 TERMINAL_BG_PROBING_AGENTS——推给不探测的 agent 会变乱码。
 *  仅浅色：深色本就是 agent 探测失败时的回落值，推了没收益。
 *  enabled = 设置页开关（默认开）：白名单里的 CLI 换了实现时可以整体关掉。 */
export function shouldReportTerminalColors(opts: {
  isWindows: boolean;
  kind: "agent" | "shell";
  agentId: string | undefined;
  themeId: string | undefined;
  enabled: boolean;
}): boolean {
  return (
    opts.isWindows &&
    opts.kind === "agent" &&
    opts.enabled &&
    TERMINAL_BG_PROBING_AGENTS.has(opts.agentId ?? "") &&
    isLightTheme(opts.themeId)
  );
}
