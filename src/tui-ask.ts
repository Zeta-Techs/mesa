/**
 * Claude Code 的「问你一个问题」表单（AskUserQuestion 工具，纯逻辑，读 xterm 可视区）。
 *
 * 通用菜单读法（tui-menu.ts）只认得出「问句 + 一排选项」：选项的说明被并进选项名（「红 选择红色」）、题签「☐ 颜色」当成说明、
 * 「Type something.」当成普通选项（点了是空着回车，什么也没答），多选题光标停在「Submit」那行时整张卡认不出来
 * （2026-10-22 用户截图：提问卡片的 UI 可以优化）。这里按表单的样子单独读，卡片照表单画。
 *
 * 2.1.306 实录（假网关回 AskUserQuestion，126×29，抓屏样本在 tests/tui-ask.test.ts）：
 *
 *   ──────────────                        ← 表单上沿横线
 *    ☐ 颜色                               ← 一题：题签；多题：「←  ☒ 颜色  ☐ 水果  ✔ Submit  →」（☒ = 答过，当前那题有底色）
 *   红、绿、蓝三种颜色里，你更喜欢哪一种？   ← 问句（长了折行）
 *   ❯ 1. 红                               ← 选项（❯ = 光标；多选题是「1. [ ] 苹果」「[✔]」= 勾上）
 *        选择红色                          ← 选项说明（缩进）
 *     4. Type something.                  ← 最后一项永远是「自己写」：光标停上去直接打字，字就写在这一行（多选题打字自动勾上）
 *        Submit                           ← 只有多选题有：这一题选好了
 *   ──────────────
 *     5. Chat about this                  ← 先不答：工具结果记「User declined」，模型接着说
 *   Enter to select · ↑/↓ to navigate · Esc to cancel
 *
 * 多题答完（或切到「✔ Submit」页）是确认页：「Review your answers / ● 问句 / → 答案 / Ready to submit your answers? /
 * ❯ 1. Submit answers / 2. Cancel」（Cancel = 整组不答，这一轮就停）。只有一道多选题时交了也要过这一页。
 * 按键：↑↓ 在可停的行之间一行一行走（不跳、按屏上顺序）；回车 = 单选选中 / 多选勾或取消；←→（或 Tab）换题。
 */
import type { ScreenCell } from "./screen-cells";
import type { TuiMenu } from "./tui-menu";

export interface AskTab {
  label: string;
  /** ☒：这一题答过了 */
  answered: boolean;
}

export interface AskOption {
  label: string;
  description: string | null;
  /** 多选题的勾；单选题为 null */
  checked: boolean | null;
}

/** 光标能停的行（按屏上从上到下的顺序） */
export type AskRow =
  | { kind: "option"; index: number }
  | { kind: "free" }
  | { kind: "submit" }
  | { kind: "chat" }
  | { kind: "confirm" }
  | { kind: "cancel" };

interface AskBase {
  /** 多题时每题一个（不含「✔ Submit」页）；一题时就是那一个题签 */
  tabs: AskTab[];
  /** 当前在第几题（靠题签底色认；认不出为 null，不给切题）；等于 tabs.length = 确认页 */
  current: number | null;
  rows: AskRow[];
  /** 光标在 rows 的第几个 */
  cursor: number;
}

export interface AskQuestion extends AskBase {
  kind: "question";
  question: string;
  multiSelect: boolean;
  /** 模型给的选项（不含「自己写」那一项） */
  options: AskOption[];
  /** 「自己写」那一行里已经打了的字；还没打为 null */
  freeText: string | null;
  /** 多选题「自己写」那一项勾上没有 */
  freeChecked: boolean | null;
}

export interface AskReview extends AskBase {
  kind: "review";
  answers: { question: string; answer: string }[];
  /** 「⚠ You have not answered all questions」 */
  warning: string | null;
}

export type ClaudeAsk = AskQuestion | AskReview;

export type AskAction =
  /** 单选：选这一项；多选：勾上 / 取消这一项 */
  | { kind: "pick"; index: number }
  /** 自己写的答案：单选写完就交；多选写进去自动勾上，submit 时再交这一题 */
  | { kind: "text"; text: string; submit?: boolean }
  /** 多选：这一题选好了 */
  | { kind: "submit" }
  /** 先不答，聊聊再说 */
  | { kind: "chat" }
  /** 切到第几题（tabs.length = 确认页） */
  | { kind: "tab"; index: number }
  /** 确认页：提交 / 整组不答 */
  | { kind: "confirm" }
  | { kind: "cancel" };

const RULE = /^─{20,}$/;
const MULTI_HEADER = /^←\s+(.*?)\s*→$/;
const SINGLE_HEADER = /^\s?([☐☒])\s+(\S.*)$/;
const TAB = /^([☐☒✔])\s+(.+)$/;
// 「❯ 1. 红」「  2. [✔] 香蕉」：第 1 列是光标位
const OPTION = /^([❯ ])\s(\d+)\.\s+(?:\[(.)\]\s*)?(.*?)\s*$/;
const SUBMIT_ROW = /^([❯ ])\s+Submit\s*$/;
const FREE_LABEL = /^Type something\.?$/;
const CHECKED = /[✔✓xX]/;

function joinWrapped(a: string, b: string): string {
  if (!a) return b;
  return /[A-Za-z0-9,.;:!?)]$/.test(a) && /^[A-Za-z0-9(]/.test(b) ? `${a} ${b}` : `${a}${b}`;
}

/** 题签行里每个标签的起止（按 cells 的下标）：找底色落在哪个标签上 */
function currentTab(cells: readonly ScreenCell[], labels: string[]): number | null {
  const text = cells.map((c) => c.ch).join("");
  const hit = cells.findIndex((c) => c.bg);
  if (hit < 0) return null;
  let from = 0;
  for (let i = 0; i < labels.length; i++) {
    const at = text.indexOf(labels[i], from);
    if (at < 0) return null;
    const end = at + labels[i].length;
    // 底色连着标签两边的空格一起铺
    if (hit >= at - 2 && hit < end + 1) return i;
    from = end;
  }
  return null;
}

/**
 * 认屏上的 Claude 提问表单；不是（或缺了关键的一截，比如表单比屏还高、开头滚出去了）返回 null，回落通用菜单读法。
 * cellsOf(row) 给出那一行每个字的样子（只用来认题签底色，不给也行：认不出当前在哪题，就不给切题）。
 */
export function parseClaudeAsk(
  lines: readonly string[],
  cellsOf?: (row: number) => readonly ScreenCell[],
): ClaudeAsk | null {
  // 题签行：上一行是表单上沿横线；从下往上找（对话记录里也可能有「☐ 买菜」这样的行，但上面不会贴着横线）
  let head = -1;
  let tabs: AskTab[] = [];
  let labels: string[] = [];
  let multi = false;
  for (let i = lines.length - 1; i > 0 && head < 0; i--) {
    if (!RULE.test(lines[i - 1].trim())) continue;
    const line = lines[i].trimEnd();
    const m = MULTI_HEADER.exec(line);
    if (m) {
      const parts = m[1].split(/\s{2,}/).map((p) => TAB.exec(p.trim()));
      if (parts.length < 2 || parts.some((p) => !p)) continue;
      const qs = parts.filter((p) => p![1] !== "✔");
      tabs = qs.map((p) => ({ label: p![2], answered: p![1] === "☒" }));
      labels = parts.map((p) => `${p![1]} ${p![2]}`);
      multi = true;
      head = i;
      continue;
    }
    const s = SINGLE_HEADER.exec(line);
    if (s) {
      tabs = [{ label: s[2], answered: s[1] === "☒" }];
      head = i;
    }
  }
  if (head < 0) return null;
  const current = multi ? (cellsOf ? currentTab(cellsOf(head), labels) : null) : 0;

  let i = head + 1;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim() === "Review your answers") return parseReview(lines, i + 1, tabs, multi ? current : null);

  // 问句：选项之前的几行
  let question = "";
  for (; i < lines.length && !OPTION.test(lines[i]); i++) {
    const t = lines[i].trim();
    if (RULE.test(t)) return null;
    if (t) question = joinWrapped(question, t);
  }
  if (!question) return null;

  // 选项块：到下一条横线为止
  const opts: { label: string; description: string | null; mark: string | null; cursor: boolean }[] = [];
  let submitRow: { cursor: boolean } | null = null;
  let descCol = 0;
  for (; i < lines.length && !RULE.test(lines[i].trim()); i++) {
    const line = lines[i];
    const o = OPTION.exec(line);
    if (o && !submitRow) {
      opts.push({ label: o[4], description: null, mark: o[3] ?? null, cursor: o[1] === "❯" });
      descCol = line.indexOf(o[4]);
      continue;
    }
    const sub = SUBMIT_ROW.exec(line);
    if (sub && opts.length) {
      submitRow = { cursor: sub[1] === "❯" };
      continue;
    }
    const t = line.trim();
    if (!t) continue;
    // 说明：缩进到选项文字那一列
    const last = opts[opts.length - 1];
    if (!last || submitRow || line.length - line.trimStart().length < descCol - 1) return null;
    last.description = last.description ? joinWrapped(last.description, t) : t;
  }
  if (i >= lines.length || opts.length < 2) return null;
  // 横线下面：「Chat about this」
  let chat: { cursor: boolean } | null = null;
  for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) {
    const o = OPTION.exec(lines[k]);
    if (o) {
      chat = { cursor: o[1] === "❯" };
      break;
    }
  }
  const free = opts[opts.length - 1];
  const multiSelect = opts.every((o) => o.mark !== null);
  const rows: AskRow[] = [
    ...opts.slice(0, -1).map((_, index) => ({ kind: "option" as const, index })),
    { kind: "free" },
    ...(submitRow ? [{ kind: "submit" as const }] : []),
    ...(chat ? [{ kind: "chat" as const }] : []),
  ];
  const cursorFlags = [...opts.map((o) => o.cursor), ...(submitRow ? [submitRow.cursor] : []), ...(chat ? [chat.cursor] : [])];
  const cursor = cursorFlags.indexOf(true);
  if (cursor < 0) return null;
  return {
    kind: "question",
    tabs,
    current,
    rows,
    cursor,
    question,
    multiSelect,
    options: opts.slice(0, -1).map((o) => ({
      label: o.label,
      description: o.description,
      checked: multiSelect ? CHECKED.test(o.mark ?? "") : null,
    })),
    freeText: FREE_LABEL.test(free.label) ? null : free.label,
    freeChecked: multiSelect ? CHECKED.test(free.mark ?? "") : null,
  };
}

function parseReview(lines: readonly string[], from: number, tabs: AskTab[], current: number | null): AskReview | null {
  const answers: { question: string; answer: string }[] = [];
  let warning: string | null = null;
  let confirm: { cursor: boolean } | null = null;
  let cancel: { cursor: boolean } | null = null;
  for (let i = from; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (RULE.test(t)) break;
    const o = OPTION.exec(lines[i]);
    if (o) {
      if (!confirm) confirm = { cursor: o[1] === "❯" };
      else if (!cancel) cancel = { cursor: o[1] === "❯" };
      continue;
    }
    if (t.startsWith("●")) answers.push({ question: t.replace(/^●\s*/, ""), answer: "" });
    else if (t.startsWith("→") && answers.length) {
      const a = answers[answers.length - 1];
      a.answer = a.answer ? `${a.answer}，${t.replace(/^→\s*/, "")}` : t.replace(/^→\s*/, "");
    } else if (t.startsWith("⚠")) warning = t.replace(/^⚠\s*/, "");
    else if (answers.length && !/^Ready to submit/i.test(t)) {
      // 长问句 / 长答案折行
      const a = answers[answers.length - 1];
      if (a.answer) a.answer = joinWrapped(a.answer, t);
      else a.question = joinWrapped(a.question, t);
    }
  }
  if (!confirm || !cancel) return null;
  const cursor = confirm.cursor ? 0 : cancel.cursor ? 1 : -1;
  if (cursor < 0) return null;
  return {
    kind: "review",
    tabs,
    current: current ?? tabs.length,
    rows: [{ kind: "confirm" }, { kind: "cancel" }],
    cursor,
    answers,
    warning,
  };
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const BACKSPACE = "\x7f";

function moveTo(ask: ClaudeAsk, match: (row: AskRow) => boolean): string[] | null {
  const target = ask.rows.findIndex(match);
  if (target < 0) return null;
  const delta = target - ask.cursor;
  return Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? DOWN : UP));
}

/** 写进「自己写」那一行的字：一行，不带控制字符 */
export function askFreeText(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

/**
 * 做这件事要往终端按的键：每个元素单独写（Ink 一次只认一个键；自己写的那段字整段一次写）。
 * 做不了（表单里没有这一行、认不出当前在哪题）返回 null。
 */
export function askAnswerKeys(ask: ClaudeAsk, action: AskAction): string[] | null {
  switch (action.kind) {
    case "pick": {
      if (ask.kind !== "question") return null;
      const keys = moveTo(ask, (r) => r.kind === "option" && r.index === action.index);
      return keys && [...keys, ENTER];
    }
    case "text": {
      if (ask.kind !== "question") return null;
      const text = askFreeText(action.text);
      const keys = moveTo(ask, (r) => r.kind === "free");
      if (!keys || !text) return null;
      // 那一行里原来打过的字先删掉
      const clear = Array.from({ length: [...(ask.freeText ?? "")].length }, () => BACKSPACE);
      if (!ask.multiSelect) return [...keys, ...clear, text, ENTER];
      // 多选：打字自动勾上，回车反而会取消勾；要交这一题就再往下一行到「Submit」
      return action.submit && ask.rows.some((r) => r.kind === "submit")
        ? [...keys, ...clear, text, DOWN, ENTER]
        : [...keys, ...clear, text];
    }
    case "submit":
    case "chat":
    case "confirm":
    case "cancel": {
      const keys = moveTo(ask, (r) => r.kind === action.kind);
      return keys && [...keys, ENTER];
    }
    case "tab": {
      if (ask.current === null || ask.tabs.length < 2) return null;
      const delta = action.index - ask.current;
      if (action.index < 0 || action.index > ask.tabs.length) return null;
      return Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? RIGHT : LEFT));
    }
  }
}

/**
 * 这一下按完表单就交了（或只剩确认页、由调用方替人按「Submit answers」）：确认 / 整组不答 / 先不答；
 * 或这是还没答的最后一题（只有一题、或别的题都答过）时选定（单选）/ 交这一题（多选）/ 写了答案并交。
 * 交了的卡片当场收起，不等屏上换画面（2026-10-22 用户：点了之后卡住几秒）；多题里还有没答的、多选勾一项、切题都不算
 */
export function askFinishes(ask: ClaudeAsk, action: AskAction): boolean {
  if (action.kind === "confirm" || action.kind === "cancel" || action.kind === "chat") return true;
  if (ask.kind !== "question" || action.kind === "tab") return false;
  const current = ask.current;
  const lastOpen =
    ask.tabs.length <= 1 || (current !== null && ask.tabs.every((t, i) => i === current || t.answered));
  if (!lastOpen) return false;
  if (action.kind === "submit") return true;
  if (ask.multiSelect) return action.kind === "text" && Boolean(action.submit);
  return action.kind === "pick" || action.kind === "text";
}

/** 同一张表单（光标挪了也算变了：按键要从新位置算） */
export function sameClaudeAsk(a: ClaudeAsk | null | undefined, b: ClaudeAsk | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 按完键之后表单还是这一题时，它会变成什么样：多选题勾 / 取消一项（光标停在那一项）、往「自己写」里写字（自动勾上）。
 * 卡片先照这个画，不用等下一次扫屏，连点几项也是从对的光标位置算键（扫屏回来再以屏上为准）。
 * 会换题、会交卷的动作返回 null：等屏上换了再画。
 */
export function askAfter(ask: ClaudeAsk, action: AskAction): ClaudeAsk | null {
  if (ask.kind !== "question" || !ask.multiSelect) return null;
  if (action.kind === "pick") {
    const row = ask.rows.findIndex((r) => r.kind === "option" && r.index === action.index);
    if (row < 0) return null;
    return {
      ...ask,
      cursor: row,
      options: ask.options.map((o, i) => (i === action.index ? { ...o, checked: !o.checked } : o)),
    };
  }
  if (action.kind === "text" && !action.submit) {
    const text = askFreeText(action.text);
    const row = ask.rows.findIndex((r) => r.kind === "free");
    if (!text || row < 0) return null;
    return { ...ask, cursor: row, freeText: text, freeChecked: true };
  }
  return null;
}

/** 给通用菜单那套流程用的摘要（卡片的键、回显判断）：问句 + 选项名 */
export function askMenu(ask: ClaudeAsk): TuiMenu {
  if (ask.kind === "review") {
    return { question: "Ready to submit your answers?", detail: null, options: ["Submit answers", "Cancel"], selected: ask.cursor, ask };
  }
  const options = [...ask.options.map((o) => o.label), ask.freeText ?? "Type something."];
  return { question: ask.question, detail: null, options, selected: Math.min(ask.cursor, options.length - 1), ask };
}
