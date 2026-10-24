/** 重启后回放用的纯文本：缓冲最后若干行。全屏 TUI 挂在备用屏时由调用方
 *（TerminalPage 的 saveTerminalReplayNow）改拍备用屏可视行——拍的是用户
 * 最后看到的画面。 */

/** 回放时 Mesa 自己写在前后的两行提示 */
export const REPLAY_HEAD = "── 上次离开时的画面 ──";
export const REPLAY_TAIL = "── 点恢复任务后重新接上 ──";

/** 回放出来还没点恢复时，30 秒快照会把这两行提示连同旧画面再存一遍：
 *  不剥掉的话每重启一次就多叠一行「点恢复任务后重新接上」（2026-10-25 用户截图：两行叠在一起）。
 *  提示行去掉，尾部空行收掉（提示前那个空行同样会一次次叠上去） */
export function terminalReplayText(
  lines: Array<string | undefined>,
  limit = 400,
): string {
  const kept = lines
    .map((line) => line ?? "")
    .filter((line) => {
      const t = line.trim();
      return t !== REPLAY_HEAD && t !== REPLAY_TAIL;
    });
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.slice(Math.max(0, kept.length - limit)).join("\n");
}
