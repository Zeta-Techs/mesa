//! 内嵌终端对九家 TUI 的协议应答。
//!
//! xterm.js 6 不实现 Kitty 键盘协议，也不画 Kitty / Sixel 贴图。
//! 这里只宣布 Mesa 真正会编码的能力：消歧义 + 备用键（flags = 1|4 = 5）。
//! 不宣布按键松开/重复（bit 2）。Grok 源码写明：宣布了松开却发不出，Enter 会交两次。
//!
//! 查询在前端从字节流里剥掉（不交给 xterm 自己答）；应答由后端 PTY 读线程当场写回，应答表与
//! src-tauri/src/term_query.rs 双端镜像（2026-10-21 起：前端答会因后台标签 backlog 晚到）。
//! 贴图/剪贴板/通知序列从字节流里拆出来，不交给 xterm 当文字画。

import {
  takeTerminalNotifications,
  type TerminalProgress,
} from "./terminal-notify.ts";

/** 消歧义（1）+ 报告备用键（4）。不含松开 / 重复事件（2）。 */
export const KKP_FLAGS = 5;

export const KITTY_KEYBOARD_QUERY = "\x1b[?u";
export const KKP_PUSH_RE = /^\x1b\[>(\d*)u$/;
/** 弹栈可带层数：`CSI < 1 u`（crossterm/grok 实际发这个形式），省略时默认 1。 */
export const KKP_POP_RE = /^\x1b\[<(\d*)u$/;
export const KKP_QUERY_RE = /^\x1b\[\?u$/;
export const MODIFY_OTHER_KEYS_QUERY_RE = /^\x1b\[>4;\?m$/;
export const PRIMARY_DA_RE = /^\x1b\[c$/;
export const XTVERSION_QUERY_RE = /^\x1b\[>0q$/;
/** XTVERSION 无参变体（Gemini / Qwen 发这个读终端名）。 */
export const XTVERSION_BARE_QUERY_RE = /^\x1b\[>q$/;
/** XTGETTCAP（DCS + q）：OpenCode 用它问 Ms（OSC 52 剪贴板）能力，答了才开 OSC 52。 */
export const XTGETTCAP_QUERY_RE = /^\x1bP\+q([0-9a-fA-F;]+)\x1b\\$/;
/** 终端名如实自述：内核就是 xterm.js 6——OpenCode 的超链接名单里明确收录 "xterm.js"。 */
export const TERM_NAME = "Mesa (xterm.js 6.0.0)";
/** terminfo Ms 能力 `\\E]52%c;%p2%s\\007` 的十六进制，作 XTGETTCAP 应答值。 */
const XTGETTCAP_MS_VALUE = "1b5d35323b25633b25703273257307";

const ESC = "\x1b";

export interface PtyQueryReply {
  /** 写回 PTY 的字节。空串表示识别了但不应答（避免把查询当文字打进 TUI）。 */
  reply: string;
  /** 子进程推了非空键盘 flags 才开始改按键编码；弹出或推 0 则恢复 xterm 原样。 */
  kkp: "arm" | "disarm" | null;
}

/** 识别 TUI 启动时的能力查询。不是查询返回 null，交给键盘路径。 */
export function replyToTerminalQuery(data: string): PtyQueryReply | null {
  if (KKP_POP_RE.test(data)) return { reply: "", kkp: "disarm" };
  if (KKP_QUERY_RE.test(data)) {
    return { reply: `${ESC}[?${KKP_FLAGS}u`, kkp: null };
  }
  const push = KKP_PUSH_RE.exec(data);
  if (push) {
    // kitty 规范：flags 省略时按 0 处理（= 恢复传统编码），不是按 5
    const requested = push[1] === "" ? 0 : Number(push[1]);
    const granted = (Number.isFinite(requested) ? requested : 0) & KKP_FLAGS;
    // 推栈不应答（kitty 规范只有 CSI ? u 才回）：Gemini 收到不请自来的 CSI ? 1 u 会把「1u」打进输入框
    return { reply: "", kkp: granted === 0 ? "disarm" : "arm" };
  }
  if (MODIFY_OTHER_KEYS_QUERY_RE.test(data)) {
    // 等级 0：不提供 modifyOtherKeys。带修饰的键走 Kitty CSI-u。
    return { reply: `${ESC}[>4;0m`, kkp: null };
  }
  if (PRIMARY_DA_RE.test(data)) {
    // VT100，带高级视频。Kimi 把它当查询哨兵：先收到它就放弃等 Kitty。
    return { reply: `${ESC}[?1;2c`, kkp: null };
  }
  if (XTVERSION_BARE_QUERY_RE.test(data) || XTVERSION_QUERY_RE.test(data)) {
    // 两种问法都是 XTVERSION，应答同一种 DCS 形式
    return { reply: `${ESC}P>|${TERM_NAME}${ESC}\\`, kkp: null };
  }
  const xtgettcap = XTGETTCAP_QUERY_RE.exec(data);
  if (xtgettcap) {
    const asked = (xtgettcap[1] ?? "").split(";");
    // 只答会的那一项；没问到的按规范省略。识别了就整个吞掉，不再透传给 xterm
    const ms = asked.includes("4d73")
      ? `4d73=${XTGETTCAP_MS_VALUE}`
      : null;
    return { reply: ms ? `${ESC}P1+r${ms}${ESC}\\` : "", kkp: null };
  }
  return null;
}

/** 查询引导符全集（matchQuery 的八个模式都以这五种开头）。快速路径的特征标记。 */
const QUERY_MARKERS = ["\x1b[?u", "\x1b[>", "\x1b[<", "\x1bP", "\x1b[c"];
/** 单个查询的最长合理长度：超过按正文放行（防失控流把 pending 无限撑大）。 */
const QUERY_WINDOW = 1200;
/** pending 的硬上限：查询本身极短，半截引导符攒到这个量级只能是坏流。 */
const QUERY_PENDING_CAP = 4096;

/** 一帧里可能粘着普通输出。只吃完结的查询，尾巴不完整时留给下一帧。
 *  绝大多数帧不含任何查询：先做五个 includes 特征探测，未命中整帧透传
 *  （2026-10-11 性能实测：逐字符拼接在 256KB-1MB 帧上 20-65ms，超帧预算
 *  饱和主线程；本路径 1MB 带色帧 ~2.7ms，输出与旧实现逐字节一致）。 */
export function consumeTerminalQueries(
  pending: string,
  chunk: string,
): { pending: string; text: string; replies: PtyQueryReply[] } {
  // 失控流的「半截」积压超限时先放行成正文，再进正常处理
  const carry = pending.length > QUERY_PENDING_CAP ? "" : pending;
  const flushed = pending.length > QUERY_PENDING_CAP ? pending : "";
  const input = carry + chunk;
  const hasMarker = QUERY_MARKERS.some((m) => input.includes(m));
  if (!hasMarker && flushed === "") {
    // 只需查帧尾是否是半截引导符。各 partial 模式至多含两个 ESC
    //（\x1bP+q<hex> 恰好断在自身 ST 终止符的 ESC 上），查最后两个 ESC 起的尾段即可
    const last = input.lastIndexOf(ESC);
    if (last >= 0) {
      if (queryStillOpen(input.slice(last))) {
        return { pending: input.slice(last), text: input.slice(0, last), replies: [] };
      }
      const prev = input.lastIndexOf(ESC, last - 1);
      if (
        prev >= 0 &&
        queryStillOpen(input.slice(prev, prev + QUERY_WINDOW))
      ) {
        return { pending: input.slice(prev), text: input.slice(0, prev), replies: [] };
      }
    }
    return { pending: "", text: input, replies: [] };
  }
  const replies: PtyQueryReply[] = [];
  let text = flushed;
  let i = 0;
  while (i < input.length) {
    if (input[i] !== ESC) {
      // 非 ESC 段整段拼接（不再逐字符分配）
      const next = input.indexOf(ESC, i);
      const stop = next < 0 ? input.length : next;
      text += input.slice(i, stop);
      i = stop;
      continue;
    }
    const tail = input.slice(i, i + QUERY_WINDOW);
    const hit = matchQuery(tail);
    if (hit) {
      const reply = replyToTerminalQuery(hit);
      if (reply) replies.push(reply);
      i += hit.length;
      continue;
    }
    if (queryStillOpen(tail)) {
      return { pending: input.slice(i), text, replies };
    }
    text += ESC;
    i += 1;
  }
  return { pending: "", text, replies };
}

function matchQuery(tail: string): string | null {
  const patterns = [
    /^\x1b\[\?u/,
    /^\x1b\[>\d*u/,
    /^\x1b\[<\d*u/,
    /^\x1b\[>4;\?m/,
    /^\x1b\[c/,
    /^\x1b\[>q/,
    /^\x1b\[>0q/,
    /^\x1bP\+q[0-9a-fA-F;]*\x1b\\/,
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(tail);
    if (found) return found[0];
  }
  return null;
}

function queryStillOpen(tail: string): boolean {
  if (tail === ESC) return true;
  if (/^\x1b\[$/.test(tail)) return true;
  if (/^\x1b\[>\d{0,64}$/.test(tail)) return true;
  if (/^\x1b\[<$/.test(tail)) return true;
  if (/^\x1b\[<\d{0,64}$/.test(tail)) return true;
  if (/^\x1b\[\?$/.test(tail)) return true;
  if (/^\x1b\[>4$/.test(tail)) return true;
  if (/^\x1b\[>4;$/.test(tail)) return true;
  if (/^\x1b\[>4;\??$/.test(tail)) return true;
  if (/^\x1b\[>0$/.test(tail)) return true;
  // XTGETTCAP 的 DCS 可能断在任何位置；其余 DCS（Sixel 等）立即放行给 xterm 自己吞。
  // 长度界与快速路径的 1200 字符窗口配套（见 QUERY_WINDOW）。
  if (/^\x1bP$/.test(tail)) return true;
  if (/^\x1bP\+$/.test(tail)) return true;
  if (/^\x1bP\+q$/.test(tail)) return true;
  if (/^\x1bP\+q[0-9a-fA-F;]{0,256}$/.test(tail)) return true;
  // 恰好断在 ST 终止符的 ESC 上（下一帧补 \\ 收尾）
  if (/^\x1bP\+q[0-9a-fA-F;]{0,256}\x1b$/.test(tail)) return true;
  return false;
}

const MOD = { shift: 1, alt: 2, ctrl: 4, super: 8 } as const;

/** 方向/编辑键：带修饰时按 xterm 的传统编码（`CSI 1;mod A` 形），不用 Kitty 的
 *  57417-57426——那是小键盘（KP_LEFT 等）专用编号，gemini-cli 的映射表没有这段，
 *  会把方向键解析成私用区乱码字符打进输入框。无修饰一律 null 交给 xterm 发
 *  传统序列（消歧义档本就保留传统功能键，gemini/kimi/crossterm 全认）。 */
const LEGACY_EDITING: Record<string, (modParam: number) => string> = {
  ArrowUp: (m) => `${ESC}[1;${m}A`,
  ArrowDown: (m) => `${ESC}[1;${m}B`,
  ArrowRight: (m) => `${ESC}[1;${m}C`,
  ArrowLeft: (m) => `${ESC}[1;${m}D`,
  Home: (m) => `${ESC}[1;${m}H`,
  End: (m) => `${ESC}[1;${m}F`,
  PageUp: (m) => `${ESC}[5;${m}~`,
  PageDown: (m) => `${ESC}[6;${m}~`,
  Insert: (m) => `${ESC}[2;${m}~`,
  Delete: (m) => `${ESC}[3;${m}~`,
};

/** Enter/Tab/Backspace/Escape：带修饰时走 CSI-u（Kitty 功能键编号）。 */
const CSI_U_KEYS: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  Escape: 27,
};

export interface EncodedKey {
  type: string;
  key: string;
  code?: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
}

/** 把一记按键编成协议序列。返回 null 表示不改写，仍由 xterm 发送。
 *  只在子进程推过非空 Kitty flags 后由调用方启用（见 TerminalPage 的 kkpArmed）。 */
export function encodeKittyKey(e: EncodedKey): string | null {
  if (e.type !== "keydown") return null;
  const mods =
    (e.shiftKey ? MOD.shift : 0) |
    (e.altKey ? MOD.alt : 0) |
    (e.ctrlKey ? MOD.ctrl : 0) |
    (e.metaKey ? MOD.super : 0);
  // 消歧义档只改写 Esc（Esc 与序列引导符无法区分，规范要求 CSI 27u）。
  // 其余无修饰功能键保持 xterm 传统序列；kimi 需要的 CSI-u Enter 由宿主特判兜底。
  if (mods === 0) {
    return e.key === "Escape" ? `${ESC}[27u` : null;
  }
  const legacy = LEGACY_EDITING[e.key];
  if (legacy) return legacy(mods + 1);
  const functional = CSI_U_KEYS[e.key];
  if (functional != null) return `${ESC}[${functional};${mods + 1}u`;
  if (e.key.length !== 1) return null;
  const code = e.key.codePointAt(0);
  if (code == null || code < 32 || code === 127) return null;
  // 只有 Shift：可打印字符仍走原字符（xterm / 输入法那条），避免把 `?` 编成 CSI。
  if (mods === MOD.shift) return null;
  return `${ESC}[${code};${mods + 1}u`;
}

/** 编码写进 PTY 之后，这一键还得拦下浏览器的默认动作：Tab / ⇧Tab 的默认动作是挪焦点。
 *  Claude 推了 Kitty 键盘协议后按键走 encodeKittyKey，xterm 不接手（自定义键盘钩子 return false）也就不替我们
 *  preventDefault——⇧Tab 切完一次权限，焦点就跳到界面上的按钮（2026-10-22 用户）。
 *  ⌘ 组合键不拦：WKWebView 里网页拦了，应用菜单的快捷键（⌘W / ⌘Q…）就失灵 */
export function keyNeedsPreventDefault(e: Pick<EncodedKey, "key">): boolean {
  return e.key === "Tab";
}

export type KittyImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export interface InlineImage {
  protocol: "kitty" | "sixel";
  /** 去掉转义后的 base64 载荷。多块图（m=1 分块）拼完才产出。 */
  payload: string;
  /** 按文件头判定的 MIME（RIFF 只认四字符是 WEBP 的，WAV/AVI 不算）。 */
  mime: KittyImageMime;
}

const KITTY_IMAGE_RE = /\x1b_G([\s\S]*?)\x1b\\/g;
const KITTY_MAX_BYTES = 8_000_000;

/** 按文件头认图片格式；不是这四种返回 null（不生成破损预览）。 */
export function kittyImageMime(payload: string): KittyImageMime | null {
  try {
    const head = atob(payload.slice(0, 24));
    if (head.startsWith("\x89PNG")) return "image/png";
    if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
    if (head.startsWith("GIF8")) return "image/gif";
    if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") {
      return "image/webp";
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 从一帧已收齐的文本里抽出贴图（支持 m=1 分块拼装）。
 * Grok 只对 Ghostty / Kitty / WezTerm / Warp 发 Kitty 图形，对 Mesa 不发。
 * Codex 宠物图同样先认终端身份。这里不改 TERM_PROGRAM 去骗身份：
 * 序列真的到了才画，没到就保持各家自己的文字退路。
 * kittyAccum 是上一帧攒下的分块 base64（调用方跨帧持有）。
 */
export function takeHostSequences(frame: string, kittyAccum = ""): {
  text: string;
  images: InlineImage[];
  clipboard: string | null;
  titles: string[];
  /** OSC 9;4 进度（标签条显示用）；没有则 null */
  progress: TerminalProgress | null;
  kittyAccum: string;
} {
  const images: InlineImage[] = [];
  const ranges: Array<[number, number]> = [];
  let accum = kittyAccum;
  KITTY_IMAGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KITTY_IMAGE_RE.exec(frame))) {
    const body = match[1] ?? "";
    const semi = body.indexOf(";");
    if (semi >= 0) {
      const keys = parseKittyKeys(body.slice(0, semi));
      const part = body.slice(semi + 1);
      const continuationOnly = [...keys.keys()].every(
        (k) => k === "m" || k === "q",
      );
      if (keys.get("m") === "1") {
        // 还有后续块：攒着，不出图
        accum += part;
        if (accum.length > KITTY_MAX_BYTES) accum = "";
      } else if (accum !== "" && continuationOnly) {
        // 末块（续块只允许 m/q 键）：拼完校验
        accum += part;
        const mime = kittyImageMime(accum);
        if (mime) images.push({ protocol: "kitty", payload: accum, mime });
        accum = "";
      } else {
        // 单块图：只认能解出图片文件头的
        const mime = kittyImageMime(part);
        if (mime) images.push({ protocol: "kitty", payload: part, mime });
      }
    }
    // 控制指令（如 d=d 删除）与非图片块：不出图，但从文字流里剥掉
    ranges.push([match.index, match.index + match[0].length]);
  }
  let withoutImages = frame;
  if (ranges.length > 0) {
    ranges.sort((a, b) => a[0] - b[0]);
    let text = "";
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start < cursor) continue;
      text += withoutImages.slice(cursor, start);
      cursor = end;
    }
    text += withoutImages.slice(cursor);
    withoutImages = text;
  }
  let clipboard: string | null = null;
  const withoutOsc52 = withoutImages.replace(
    OSC52_RE,
    (_all, _sel, b64: string) => {
      clipboard = osc52ClipboardWrite(b64) ?? clipboard;
      return "";
    },
  );
  const notified = takeTerminalNotifications(withoutOsc52);
  return {
    text: notified.text,
    images,
    clipboard,
    titles: notified.titles,
    progress: notified.progress,
    kittyAccum: accum,
  };
}

function parseKittyKeys(keysPart: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!keysPart) return map;
  for (const entry of keysPart.split(",")) {
    const eq = entry.indexOf("=");
    if (eq > 0) map.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return map;
}

const OSC52_RE = /\x1b\]52;([cp0-7]*);([A-Za-z0-9+/=]*)(?:\x1b\\|\x07)/g;

/** OSC 52 剪贴板写。只认 base64，上限约 256KB，避免任意长序列灌进剪贴板。 */
export function osc52ClipboardWrite(payload: string): string | null {
  if (payload.length === 0 || payload.length > 350_000) return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 贴图 / OSC 52 / OSC 9、777 通知经常被切在两帧之间。没看到结束符之前先攒着，
 * 不把半段 base64 或转义序列写进 xterm。kittyAccum 由调用方跨帧持有（分块贴图）。
 */
export function consumeHostSequences(
  pending: string,
  chunk: string,
  kittyAccum = "",
): {
  pending: string;
  kittyAccum: string;
  text: string;
  images: InlineImage[];
  clipboard: string | null;
  titles: string[];
  progress: TerminalProgress | null;
} {
  const input = pending + chunk;
  const openAt = openHostSequenceAt(input);
  let ready = openAt < 0 ? input : input.slice(0, openAt);
  let rest = openAt < 0 ? "" : input.slice(openAt);
  // 收不完的半截不能把后面的输出一直扣住。通知载荷很短，单独收紧上限。
  const cap = rest.startsWith("\x1b]9;") || rest.startsWith("\x1b]777;")
    ? 4096
    : KITTY_MAX_BYTES;
  if (rest.length > cap) {
    ready += rest;
    rest = "";
  }
  // Windows 上 Ink 的「清屏」（ansi-escapes clearTerminal）是 ESC[2J ESC[0f，不带清回滚区的 ESC[3J（macOS 带）。
  // Gemini CLI 回复超过一屏时每次重画都「清屏 + 整段历史重打」，回滚区里就叠出一份又一份历史
  //（2026-10-21 用户：画面重复好几屏；ConPTY 实录一段 60 行回复重画 251 次）。补上 ESC[3J，与 macOS 同效果
  ready = ready.split(WIN_CLEAR_TERMINAL).join(FULL_CLEAR_TERMINAL);
  const taken = takeHostSequences(ready, kittyAccum);
  return { pending: rest, ...taken };
}

const WIN_CLEAR_TERMINAL = "\x1b[2J\x1b[0f";
const FULL_CLEAR_TERMINAL = "\x1b[2J\x1b[3J\x1b[0f";

function openHostSequenceAt(input: string): number {
  const marks = ["\x1b_G", "\x1b]52;", "\x1b]9;", "\x1b]777;"];
  let open = -1;
  for (const mark of marks) {
    let from = 0;
    while (from < input.length) {
      const at = input.indexOf(mark, from);
      if (at < 0) break;
      const end = input.indexOf("\x1b\\", at + mark.length);
      const bel = input.indexOf("\x07", at + mark.length);
      if (end < 0 && bel < 0) open = open < 0 ? at : Math.min(open, at);
      from = at + mark.length;
    }
  }
  const tail = input.slice(Math.max(0, input.length - 8));
  // 「半截」必须延伸到输入末尾（$ 锚定）：search 不锚定会把帧尾**完整**的短序列
  //（如 kimi 每秒的 \x1b]9;4;3\x07 恰好 8 字符）也当半截扣住，通知/进度终点卡死
  //（2026-10-11 复核实证）。marks 主检查已认「有终结符=完整」，这里只补真半截。
  // Windows 清屏 ESC[2J ESC[0f 切在两帧之间也扣住（拼齐了才补得上 ESC[3J，见 consumeHostSequences）
  const partial = tail.match(
    /\x1b(?:_G?|\](?:5(?:2;?)?|7(?:7(?:7;?)?)?|9;?)?|\[2J(?:\x1b(?:\[0?)?)?)?$/,
  );
  const partialAt = partial?.index;
  if (partialAt !== undefined) {
    const at = input.length - tail.length + partialAt;
    open = open < 0 ? at : Math.min(open, at);
  }
  return open;
}

/** 只允许 http(s) 与 mailto。其余 OSC 8（javascript: 等）不打开。 */
export function safeOsc8Url(url: string): string | null {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) && !/[\r\n]/.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed) && !/[\r\n]/.test(trimmed)) return trimmed;
  return null;
}
