import { closeChatCombo, comboLabel, IS_MAC } from "../hotkeys";
import {
  canShowCoachTip,
  CLOSE_KEY_WINDOW_MS,
  markCoachTipShown,
  noteRepeat,
  SURFACE_KEY_TIMES,
  SURFACE_KEY_WINDOW_MS,
} from "../coach-tips";
import { confirmDialogOpen } from "./ConfirmDialog";
import { showFloatingCoach } from "./CoachTip";

// 「用鼠标做了本有快捷键的事」提醒快捷键（规矩见 coach-tips.ts）。计数都是模块级，一次打开 Mesa 内累计

// 用鼠标关对话的时刻（侧栏行尾 ×、侧栏 ⋯、对话头 ⋯ 共用一份）
let mouseCloses: number[] = [];
// 用右上角 >_ 在聊天和终端之间切的时刻
let mouseSurfaceToggles: number[] = [];

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

/** 点了对话头右上角 >_（聊天 ↔ 终端，2026-10-27 用户：「聊天层切换终端也加一个」）：5 分钟内去、回、再去（第 3 下）时，
 *  挂在按钮下面提醒切换快捷键。combo 是设置里眼下的键（可改）；关掉了快捷键的不提 */
export function noteMouseToggleSurface(
  anchor: { left: number; top: number; right: number; bottom: number },
  combo: string,
) {
  const r = noteRepeat(mouseSurfaceToggles, Date.now(), SURFACE_KEY_WINDOW_MS, SURFACE_KEY_TIMES);
  mouseSurfaceToggles = r.at;
  if (!r.hit || !combo || !canShowCoachTip("surfaceKey")) return;
  markCoachTipShown("surfaceKey");
  showFloatingCoach({
    anchor,
    place: "below",
    title: "聊天和终端来回切有快捷键",
    body: (
      <>
        按 <kbd>{comboLabel(combo)}</kbd> 在聊天和这段对话的终端之间切换，不用回来点这个按钮；快捷键能在设置里改。
      </>
    ),
    actions: [{ label: "知道了", onClick: () => {} }],
  });
}
