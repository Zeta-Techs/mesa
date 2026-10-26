import { closeChatCombo, comboLabel, IS_MAC } from "../hotkeys";
import { canShowCoachTip, CLOSE_KEY_WINDOW_MS, markCoachTipShown, noteRepeat } from "../coach-tips";
import { confirmDialogOpen } from "./ConfirmDialog";
import { showFloatingCoach } from "./CoachTip";

// 用鼠标关对话的时刻（侧栏行尾 ×、侧栏 ⋯、对话头 ⋯ 共用一份，模块级）
let mouseCloses: number[] = [];

/** 用鼠标关掉了一段对话（2026-10-27 用户定）：5 分钟内第 2 次时，在点的地方旁边提醒 ⌘W / Ctrl+Shift+W。
 *  规矩见 coach-tips.ts；关的时候要先问一句（在干活的）就等这一下过去，确认框开着不出 */
export function noteMouseCloseChat(
  anchor: { left: number; top: number; right: number; bottom: number },
  place: "right" | "below",
  scrollRoot?: Element | null,
) {
  const r = noteRepeat(mouseCloses, Date.now(), CLOSE_KEY_WINDOW_MS);
  mouseCloses = r.at;
  if (!r.hit || !canShowCoachTip("closeKey")) return;
  window.setTimeout(() => {
    if (confirmDialogOpen() || !canShowCoachTip("closeKey")) return;
    markCoachTipShown("closeKey");
    showFloatingCoach({
      anchor,
      place,
      scrollRoot,
      title: "关掉对话有快捷键",
      body: (
        <>
          在运行页按 <kbd>{comboLabel(closeChatCombo(IS_MAC))}</kbd>，直接关掉正看着的这段；记录还在侧栏里，点开就能接着聊。
        </>
      ),
      actions: [{ label: "知道了", onClick: () => {} }],
    });
  }, 400);
}
