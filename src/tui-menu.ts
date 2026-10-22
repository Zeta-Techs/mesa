/**
 * 认屏幕上的 TUI 选择菜单（纯逻辑，读 xterm 可视区文本行）。
 *
 * 用在聊天层切模型 / 思考档之后：有的 CLI 收到命令会弹确认（「中途换模型会…，继续吗？」）或选择器，
 * 菜单藏在终端里，聊天层看起来像没反应（2026-10-17 用户：切换档位终端会让你确认）。
 * 只在发命令后的几秒窗口里扫（TerminalView 的 runTuiCommand 开窗），平时不扫——
 * 对话正文里出现「❯」开头的行不能被当成菜单。
 *
 * 判定：有一行以选中标记（❯ / ›；带序号时也认 >，CodeBuddy 的写法）开头，它所在的连续块里至少两项，最多九项，
 * 并且带序号 / 下方有按键提示 / 上方有边框三者之一；问句取上方那段说明的第一行。单独一行的输入提示块长为 1，不算。
 * 带序号的菜单里，没有序号的行：在第一项之前的是问句（Claude 审批「Do you want to proceed?」），在某项之后的是
 * 这一项折行的续行（Claude「Yes, and always allow access to / <很长的路径> from this project」），都不单算一项
 * （2026-10-18 聊天层第三期 PTY 实录，样本在 tests/tui-menu.test.ts）。
 */

import { sameClaudeAsk, type ClaudeAsk } from "./tui-ask.ts";

export interface TuiMenu {
  /** 菜单上方那段说明的第一行（标题，如「Switch model?」） */
  question: string | null;
  /** 标题下面的说明（几行拼成一句）；没有为 null */
  detail: string | null;
  options: string[];
  selected: number;
  /** Claude 的提问表单（tui-ask.ts）：认得出时按表单答，question / options 只是它的摘要 */
  ask?: ClaudeAsk | null;
  /** 刚替用户按过键、终端还没换到新画面（卡片按钮先停用） */
  pending?: boolean;
}

const BORDER = /^[─━═│┃╭╮╰╯▔▁]+$/;
// 虚线分隔（Claude 审批框把命令夹在两条 ╌ 之间）：不是菜单的上边界，跳过接着往上收说明
const DASHED = /^[╌┄┈╍┅┉]+$/;
// 选中标记：❯ / › 单用也算；> ▶ ● 只在后面紧跟序号时算（CodeBuddy「> 1.」、Kimi「▶ 1.」、Gemini「● 1.」——
// 这几个符号单独出现时是输入提示、标题或助手正文的行首）
const MARKED = /^\s*(?:[❯›]\s*(?:\d+[.)]\s*)?|[>▶●]\s*\d+[.)]\s*)(\S.*?)\s*$/;
const NUMBERED = /^\s*(?:[❯›>▶●]\s*)?\d+[.)]\s/;
// Grok 的单选写法「2 (●) Yes, proceed」「3 (○) No, reject」：先改写成「❯ 2. …」「  3. …」再认。
// Windows 上 Grok 的选中点画成 •（2026-10-20 ConPTY 抓屏）
const RADIO = /^(\s*)(\d+)\s+\(([●•○◉◯])\)\s+(.*)$/;
// 未选中的选项行：缩进 + 可选序号 + 文字；边框线、空行、工具输出续行（⎿）不算
const PLAIN = /^\s{1,8}(?:\d+[.)]\s*)?([^\s─━═│┃╭╮╰╯▔▁⎿].*?)\s*$/;

// 用户输入的回显：不是题目说明
const ECHO = /^[❯›>]\s/;
// 常见的发问开头（审批 / 切换确认 / 选择器标题）
const ASK = /^(?:Do you want|Would you like|Allow|Switch|Select|Choose|Are you sure|Apply|Proceed|Confirm)/i;

// 菜单下面的按键提示「Enter to confirm · Esc to cancel」也是缩进行，不能当成一项
const KEY_HINT = /^\s*(?:Enter|Esc|Tab|Space|Press|↑|↓|←|→)\b.*\bto\b|·\s*Esc\b/i;

/**
 * 去掉方框的左右竖边和滚动条（Gemini 审批整个画在 ╭│╰ 框里、右边还有 █ 滚动条；Grok 审批左边一条 ┃），
 * 嵌套的框一层层剥；左边框换成空格，保留原来的缩进关系。单选写法改写成标准序号行。
 */
function unbox(line: string): string {
  let t = line.replace(/[\s█▐▌]+$/, "");
  for (let k = 0; k < 3; k++) {
    const next = t.replace(/\s*[│┃]$/, "").replace(/^(\s*)[│┃]/, "$1 ");
    if (next === t) break;
    t = next;
  }
  const radio = RADIO.exec(t);
  if (radio) {
    const on = radio[3] === "●" || radio[3] === "•" || radio[3] === "◉";
    t = `${radio[1]}${on ? "❯ " : "  "}${radio[2]}. ${radio[4]}`;
  }
  return t;
}

export function parseTuiMenu(raw: readonly string[]): TuiMenu | null {
  const lines = raw.map(unbox);
  for (let i = 0; i < lines.length; i++) {
    const m = MARKED.exec(lines[i]);
    // 「❯ /model xxx」是对话记录里回显的用户命令，不是菜单高亮
    if (!m || m[1].startsWith("/")) continue;
    const menu = menuAround(lines, i);
    if (menu) return menu;
  }
  return null;
}

function menuAround(lines: readonly string[], markIdx: number): TuiMenu | null {
  const isOption = (line: string) => !KEY_HINT.test(line) && (MARKED.test(line) || PLAIN.test(line));
  let start = markIdx;
  while (start > 0 && isOption(lines[start - 1]) && !MARKED.test(lines[start - 1])) start--;
  let end = markIdx;
  while (end + 1 < lines.length && isOption(lines[end + 1]) && !MARKED.test(lines[end + 1])) end++;
  const textOf = (line: string) => (MARKED.exec(line) ?? PLAIN.exec(line))![1];
  const indent = (line: string) => line.length - line.trimStart().length;
  // 带序号的菜单：只有带序号的行是选项；第一项之前的无序号行归问句，某项之后、缩进到选项文字那一列的无序号行
  // 是那一项的折行；缩进更浅的（Qwen「⠏ Waiting for user confirmation...」）说明菜单到此为止
  const numbered = NUMBERED.test(lines[markIdx]);
  const lead: string[] = [];
  const options: string[] = [];
  let selected = -1;
  let textCol = 0;
  for (let i = start; i <= end; i++) {
    const line = lines[i];
    if (!numbered || NUMBERED.test(line)) {
      if (i === markIdx) selected = options.length;
      const text = textOf(line);
      options.push(text);
      textCol = line.indexOf(text);
    } else if (options.length === 0) {
      lead.push(textOf(line));
    } else if (indent(line) >= textCol - 1) {
      options[options.length - 1] += ` ${textOf(line)}`;
    } else {
      end = i - 1;
      break;
    }
  }
  if (options.length < 2 || options.length > 9 || selected < 0) return null;
  // 菜单上方的说明：有边框圈住时收到边框为止（最多 8 行，跳过虚线）。
  // Claude Code 2.1.292 实录：「▔▔▔ / Switch model? / Your next response will be slower… / ❯ 1. Yes…」；
  // 审批框：「─── / Bash command / Tip: … / 写一个探针文件 / ╌╌╌ / echo mesa > x / ╌╌╌ / Do you want to proceed? / ❯ 1. Yes…」
  // 往上碰到「╰──╯」是框里套的小框（Gemini 把命令另框一层），框里的内容照收，直到它的「╭──╮」
  const upper: string[] = [];
  let bordered = false;
  let inner = 0;
  for (let i = start - 1; i >= 0 && upper.length < 8; i--) {
    const t = lines[i].trim();
    if (/^╰[─━]*╯$/.test(t)) {
      inner++;
      continue;
    }
    if (inner > 0 && /^╭[─━]*╮$/.test(t)) {
      inner--;
      continue;
    }
    if (BORDER.test(t)) {
      bordered = true;
      break;
    }
    if (t && !DASHED.test(t)) upper.unshift(t);
  }
  // 真菜单至少有一样「菜单的样子」：带序号的选项 / 下方按键提示 / 上方边框。
  // 只凭「❯ 一行 + 缩进续行」会把对话记录里的多行提问认成菜单（Claude 回显多行输入就是这个形状）
  const hinted = lines.slice(end + 1, end + 4).some((line) => KEY_HINT.test(line));
  if (!numbered && !hinted && !bordered) return null;
  // 没有边框圈住（Codex、Qwen 都是裸排的）：一路往上收会收进对话记录。只要紧贴选项的那几行——
  // 选项块里第一项之前的行取最近 4 行（Qwen 整屏都缩进两格，块会一直连到对话记录）；没有就取上方紧贴的一组缩进行，
  // 组内允许单个空行，碰到连着两个空行、顶格的行或边框就停。
  // Codex 0.163 审批实录：「• Running… / 空 / 空 / Would you like to run the following command? / 空 / Environment: local /
  // 空 / Reason: … / 空 / $ echo … / 空 / 空 / › 1. Yes, proceed (y)」
  let context = bordered ? [...upper, ...lead] : lead.slice(-4);
  if (!bordered && lead.length === 0) {
    let i = start - 1;
    while (i >= 0 && !lines[i].trim()) i--;
    let blanks = 0;
    for (; i >= 0 && context.length < 6; i--) {
      const raw = lines[i];
      const t = raw.trim();
      if (!t) {
        if (++blanks >= 2) break;
        continue;
      }
      if (!/^\s/.test(raw) || BORDER.test(t)) break;
      blanks = 0;
      if (!DASHED.test(t)) context.unshift(t);
    }
  }
  // 「Tip: …」是 CLI 的推广提示，「❯ / › / > 开头」是用户输入的回显，都不是这道题的说明
  context = context.filter((t) => !/^Tip:/i.test(t) && !ECHO.test(t));
  // 问句：离选项最近的「常见发问开头」行，再认问号结尾的最后一行，都没有取第一行。
  // Codex 的「Reason: …」是模型写的理由，也可能以问号结尾，所以发问开头优先；
  // CodeBuddy 框顶是标题「Confirm」、贴着选项的才是问句「Are you sure you want to do this?」，所以取最近的
  const lastIndex = (test: (t: string) => boolean) => {
    for (let k = context.length - 1; k >= 0; k--) if (test(context[k])) return k;
    return -1;
  };
  let q = lastIndex((t) => ASK.test(t));
  if (q < 0) q = lastIndex((t) => /[?？]$/.test(t));
  if (q < 0) q = 0;
  // 问句行首的装饰符号（Kimi「▶ Run this command?」）去掉
  const question = context[q]?.replace(/^[▶◆✦•●?]\s+/, "") ?? null;
  const rest = [...context.slice(0, q), ...context.slice(q + 1)];
  const detail = rest.length ? rest.join(" ") : null;
  return { question, detail, options, selected };
}

/** 选第 target 项要按的键：方向键从当前高亮挪过去再回车，每个键单独写（Ink 一次只认一个键） */
export function menuAnswerKeys(menu: TuiMenu, target: number): string[] {
  const delta = target - menu.selected;
  const arrow = delta > 0 ? "\x1b[B" : "\x1b[A";
  return [...Array.from({ length: Math.abs(delta) }, () => arrow), "\r"];
}

/** 菜单的每一项都出现在 text 里：多半是用户刚发的编号清单的回显，不是 CLI 在问。
 *  终端窄时回显的长行被截断、行尾补「…」（2026-10-21 用户 Grok：「…和当前时…」认不出，七步清单被当成审批卡），去掉再比 */
export function menuEchoesText(menu: TuiMenu, text: string): boolean {
  const squash = (v: string) => v.replace(/\s+/g, "");
  const said = squash(text);
  return (
    said.length > 0 &&
    menu.options.every((o) => {
      const opt = squash(o).replace(/(?:…|\.{3})+$/, "");
      return opt.length > 0 && said.includes(opt);
    })
  );
}

export function sameTuiMenu(a: TuiMenu | null, b: TuiMenu | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.question === b.question &&
    a.detail === b.detail &&
    a.selected === b.selected &&
    a.options.join("\n") === b.options.join("\n") &&
    Boolean(a.pending) === Boolean(b.pending) &&
    sameClaudeAsk(a.ask, b.ask)
  );
}
