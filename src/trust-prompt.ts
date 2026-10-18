/**
 * 识别 CLI 启动时的「是否信任这个目录」提示（纯逻辑，读的是 xterm 当前屏幕的文本行）。
 *
 * 为什么要认：聊天层发第一条消息会顺带拉起 Agent，Claude Code 等在没信任过的目录（典型是主目录）
 * 先弹信任菜单，会话文件要等用户在菜单里选了才出现——聊天层就一直停在「已送出 / 等待会话文件」，
 * 用户看不到菜单（2026-10-17 用户截图）。认出来后聊天层给两个按钮，替用户把方向键和回车按进终端。
 *
 * 只认明确在问「信任」的提示。选项要成块（带高亮标记的那一行连同上下紧挨的选项行）：
 * 「信任」取第一个 Yes / Trust 开头、且不是「信任上级 / 连子目录一起」的那项（范围最窄），
 * 「不信任」取 No / Exit / Don't 开头那项。认不出就返回 null，交回原来的出口（8 秒没有会话文件就拉起终端）。
 * 已认的形态（2026-10-17 按 Mesa 应答口径 PTY 实录）：
 * - Claude Code：「❯ No, exit / Yes, I trust this folder」（默认高亮在 No）；旧版「❯ 1. Yes, proceed / 2. No, exit」
 * - Kimi：「Trust this folder? … ❯ Trust and continue / Exit」
 * - CodeBuddy：方框里「Do you trust the files in this folder? … > 1. Trust folder only (work) / 2. Trust parent folder /
 *   3. Trust folder and all subdirectories / 4. No, exit (escape)」
 * - Gemini：「● 1. Trust folder (demo) / 2. Trust parent folder / 3. Don't trust (esc)」
 * 原先只认 Yes / No 开头，Kimi、CodeBuddy 的信任菜单在聊天层出不来，聊天停在「已送出」8 秒才拉起终端。
 */

export interface TrustPrompt {
  /** 提示里写的目录（认不出为 null） */
  path: string | null;
  /** 选项原文（去掉选中标记与序号），按屏幕自上而下 */
  options: string[];
  /** 当前高亮的选项下标 */
  selected: number;
  yesIndex: number;
  noIndex: number;
}

const TRIGGER =
  /trust this folder|trust the files in this folder|do you trust|quick safety check/i;
// 方框边线（CodeBuddy 把整个菜单画在 │ … │ 里）
const BOX_EDGE = /^[\s│┃]+|[\s│┃]+$/g;
// 选中标记：Claude / Kimi 用 ❯，Codex 用 ›，CodeBuddy 用 >，Gemini 用 ●
const MARKED = /^[❯›>●]\s*(?:\d+[.)]\s*)?(\S.*)$/;
const PLAIN = /^(?:\d+[.)]\s*)?(\S.*)$/;
const OPTION_WORD = /^(?:yes|no|trust|exit|don'?t|quit)\b/i;
const YES = /^(?:yes|trust)\b/i;
const NO = /^(?:no\b|exit\b|don'?t\b|quit\b)/i;
// 「信任」只选范围最窄的那项：不替用户信任上级目录或整棵子目录
const WIDE = /parent|all subdirectories|subfolders|上级|子目录/i;
const PATH_LINE = /^((?:\/|~\/?|[A-Za-z]:\\)\S.*?)$/;

function optionText(line: string, marked: boolean): string | null {
  const m = (marked ? MARKED : PLAIN).exec(line);
  if (!m) return null;
  return OPTION_WORD.test(m[1]) ? m[1].trim() : null;
}

export function parseTrustPrompt(lines: readonly string[]): TrustPrompt | null {
  const clean = lines.map((l) => l.replace(BOX_EDGE, ""));
  const start = clean.findIndex((line) => TRIGGER.test(line));
  if (start < 0) return null;
  // 「Accessing workspace:」与路径可能在问句上面，路径从整屏找；选项只在问句之后找
  const path = clean.find((line) => PATH_LINE.test(line)) ?? null;
  let mark = -1;
  for (let i = start + 1; i < clean.length; i++) {
    if (optionText(clean[i], true) !== null) {
      mark = i;
      break;
    }
  }
  let first: number;
  let last: number;
  if (mark >= 0) {
    first = mark;
    while (first - 1 > start && optionText(clean[first - 1], false) !== null) first--;
    last = mark;
    while (last + 1 < clean.length && optionText(clean[last + 1], false) !== null) last++;
  } else {
    // 没有高亮标记（个别 CLI 首帧还没画）：问句后第一段连续的选项行，默认高亮第一项
    first = clean.findIndex((line, i) => i > start && optionText(line, false) !== null);
    if (first < 0) return null;
    last = first;
    while (last + 1 < clean.length && optionText(clean[last + 1], false) !== null) last++;
  }
  const options: string[] = [];
  for (let i = first; i <= last; i++) {
    options.push((i === mark ? optionText(clean[i], true) : optionText(clean[i], false))!);
  }
  const yesNarrow = options.findIndex((o) => YES.test(o) && !WIDE.test(o));
  const yesIndex = yesNarrow >= 0 ? yesNarrow : options.findIndex((o) => YES.test(o));
  const noIndex = options.findIndex((o) => NO.test(o));
  if (yesIndex < 0 || noIndex < 0) return null;
  return { path, options, selected: mark >= 0 ? mark - first : 0, yesIndex, noIndex };
}

/** 选中目标项要按的键：上下方向键挪过去再回车。每个键单独写，Ink 一次只认一个键 */
export function trustAnswerKeys(prompt: TrustPrompt, accept: boolean): string[] {
  const target = accept ? prompt.yesIndex : prompt.noIndex;
  const delta = target - prompt.selected;
  const arrow = delta > 0 ? "\x1b[B" : "\x1b[A";
  return [...Array.from({ length: Math.abs(delta) }, () => arrow), "\r"];
}

/** 两次扫描结果是否同一个提示（避免每帧都往上报一份新对象） */
export function sameTrustPrompt(a: TrustPrompt | null, b: TrustPrompt | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.path === b.path &&
    a.selected === b.selected &&
    a.yesIndex === b.yesIndex &&
    a.noIndex === b.noIndex &&
    a.options.join("\n") === b.options.join("\n")
  );
}
