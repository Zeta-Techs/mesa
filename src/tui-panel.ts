/**
 * 认「终端里开着一个面板」（纯逻辑，读 xterm 可视区文本行）。
 *
 * 有些斜杠命令不是往对话里写一段话，而是在终端里打开一个只能在终端里看、要按 Esc 关的全屏面板：
 * Claude 的 /usage（/cost、/stats、/status、/config 同属 Settings 面板）、/help、/permissions…
 * 聊天层读会话文件，面板内容读不到；而面板开着时会话文件没有任何新行，聊天层就一直写「正在生成回复」
 * （2026-10-19 用户发 /cost 实测，卡了好几分钟）。
 *
 * 判定要同时满足三条，宁可漏认也不误认（误认会把一轮正在生成的回复当成「没在生成」）：
 * 一，这家有画面布局表（live-reply.ts），且这一屏看不到它的聊天输入框；
 * 二，屏上有「Esc to cancel / close / dismiss / exit / go back」这类关闭提示（生成中的提示是 esc to interrupt，不算）；
 * 三，屏上有内容（不是刚清屏的空白）。
 * 选择菜单（审批 / 切模型确认 / 启动信任）也有 Esc to cancel，由调用方先认菜单，这里只管剩下的。
 */
import { terminalHasInputBox } from "./live-reply.ts";
import { isArt } from "./terminal-wait.ts";

const CLOSE_HINT = /\bEsc(?:ape)? to (?:cancel|close|dismiss|exit|go back|return)\b/i;

export function parseTuiPanel(lines: readonly string[], agentId: string): boolean {
  if (terminalHasInputBox(lines, agentId) !== false) return false;
  const filled = lines.filter((l) => l.trim());
  if (filled.length < 3) return false;
  return filled.some((l) => CLOSE_HINT.test(l));
}

const CONTINUE_HINT = /\bEnter to continue\b/i;
const RULE_LINE = /^\s*[─━═▔▁-]{8,}/;

/**
 * 认「终端里弹了一条要按回车才继续的提示」：没有输入框、屏上有「Enter to continue」，返回提示正文（从上一条分隔线到提示行之间）。
 * Claude Code 会在一轮中途弹这种通知（2026-10-21 用户实测：经第三方网关时 auto mode 分类器计费的说明，
 * 「Enter to continue · Esc to cancel」），弹着时这一轮停住；原先被当成「面板」，聊天层给的是按 Esc 关面板。认不出返回 null
 */
export function parseTuiNotice(lines: readonly string[], agentId: string): string[] | null {
  if (terminalHasInputBox(lines, agentId) !== false) return null;
  let hint = lines.length - 1;
  while (hint >= 0 && !CONTINUE_HINT.test(lines[hint])) hint--;
  if (hint < 0) return null;
  let start = hint - 1;
  // 上一条分隔线或启动字符画（Claude 首次启动的安全须知顶上是欢迎画）之下才是提示正文
  while (start >= 0 && !RULE_LINE.test(lines[start]) && !isArt(lines[start])) start--;
  const body = lines
    .slice(start + 1, hint)
    .map((l) => l.trim())
    // 首尾空行去掉，段间空行留一行
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]));
  while (body.length && !body[0]) body.shift();
  while (body.length && !body[body.length - 1]) body.pop();
  return body.length ? body : null;
}
