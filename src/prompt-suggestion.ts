/**
 * Claude Code「猜你下一句」（纯逻辑）：一轮做完后它另发一次请求猜你接下来想说什么，灰着字放进输入框（Tab 填入、空着回车直接发）。
 * 聊天层的输入框原先看不到这句（2026-10-22 用户：终端里有「再运行一次看看输出」，聊天层输入框里没有）。
 *
 * 它不进会话文件、hooks 也不报，只能从屏上读。和你自己打的字只差在样子：Claude 把输入框的占位字整句画灰（SGR 2），
 * 终端有焦点时第一个字反色当光标（2.1.306 源码 placeholder 渲染：invert(t[0]) + dim(t.slice(1))）。
 * 「猜的下一句」和别的占位提示走同一个占位位置，样子一样，按原文排除：新手的 Try "…" 示例、排队时的「Press up to edit…」、
 * 队友会话的「Message @…」。
 *
 * 实测（2026-10-22，假网关，126×29）：开关在服务端（growthbook），假网关下要设 CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1 才出；
 * 第二轮起才猜（头一轮不猜）；终端失焦（ESC[O）之后照样出。
 */
import type { ScreenCell } from "./screen-cells";

// 输入框上下沿的横线
const RULE = /^─{20,}$/;
// 输入框那一行：顶格「❯」，后面是空格 / 不换行空格（Claude 在提示符后面用 U+00A0）或什么都没有
const PROMPT = /^❯(?:[ \u00a0]|$)/;
// 同一个占位位置上的固定提示（不是猜的下一句）
const NOT_SUGGESTION = [/^Try "/, /^Press (?:up|Enter)\b/i, /^Message @/];

export function promptSuggestionSupported(agentId: string | null | undefined): boolean {
  return agentId === "claude-code";
}

/** Claude 输入框那一行在可视区里的行号：顶格「❯」、上一行是整条横线；从下往上找，没有为 -1 */
export function claudeInputRow(lines: readonly string[]): number {
  for (let i = lines.length - 1; i > 0; i--) {
    if (PROMPT.test(lines[i]) && RULE.test(lines[i - 1].trim())) return i;
  }
  return -1;
}

/**
 * 输入框里那行灰字；输入框是空的、里面是自己打的字、或是固定提示时为 null。
 * cellsOf(row) 给出那一行每个字的样子（screen-cells.ts lineCells）。占位字长了会折到下一行，一直读到下沿横线。
 */
export function readPromptSuggestion(
  lines: readonly string[],
  cellsOf: (row: number) => readonly ScreenCell[],
): string | null {
  const row = claudeInputRow(lines);
  if (row < 0) return null;
  const chars: ScreenCell[] = [];
  for (let r = row; r < lines.length && !RULE.test(lines[r].trim()); r++) {
    let cells = [...cellsOf(r)];
    // 第一行去掉「❯ 」，折下来的行去掉缩进
    if (r === row) cells = cells.slice(cells[1] && /[ \u00a0]/.test(cells[1].ch) ? 2 : 1);
    else while (cells.length && cells[0].ch === " " && !cells[0].inverse) cells.shift();
    while (cells.length && /\s/.test(cells[cells.length - 1].ch) && !cells[cells.length - 1].inverse) cells.pop();
    if (!cells.length) continue;
    // 折行处：两边都是英文字母 / 数字时原来是个空格（Ink 按词折行时把它吃掉了）
    const prev = chars[chars.length - 1]?.ch ?? "";
    if (chars.length && /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(cells[0].ch)) {
      chars.push({ ch: " ", dim: true, inverse: false, bg: false });
    }
    chars.push(...cells);
  }
  const visible = chars.filter((c) => c.ch.trim() !== "");
  if (visible.length < 2) return null;
  // 第一个字可能是反色的假光标，其余每个字都得是灰的；有一个不灰就是自己打的字
  if (!(visible[0].dim || visible[0].inverse)) return null;
  if (!visible.slice(1).every((c) => c.dim)) return null;
  const text = chars
    .map((c) => c.ch)
    .join("")
    .replace(/\u00a0/g, " ")
    .trim();
  if (NOT_SUGGESTION.some((re) => re.test(text))) return null;
  return text;
}
