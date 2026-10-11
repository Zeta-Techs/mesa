/** 重启后回放用的纯文本：缓冲最后若干行。全屏 TUI 挂在备用屏时由调用方
 *（TerminalPage 的 saveTerminalReplayNow）改拍备用屏可视行——拍的是用户
 * 最后看到的画面。 */

export function terminalReplayText(
  lines: Array<string | undefined>,
  limit = 400,
): string {
  const kept = lines.slice(Math.max(0, lines.length - limit));
  return kept.map((line) => line ?? "").join("\n");
}