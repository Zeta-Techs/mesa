/**
 * 运行状态光标（2026-10-24 用户：「在跑的那段对话行尾的绿点换成 Mesa 的独有设计，用一个光标代替，运行中就是灰色光标闪烁，
 * 其他你根据这个设计」；tests/run-caret.test.ts）。光标就是 M▁ 里那一道，坐在文字基线上（组件 RunCaret，样式 App.css .ccode-run-caret）。
 *   working  灰光标呼吸（一明一暗、缓入缓出；2026-10-24 用户：不要闪）：Agent 正在干活（Mesa 外的终端正在写这段也算）。
 *            鼠标放到那一行上停在常亮，也不给 ⋯ 让位
 *   idle     更淡的灰光标、常亮：进程开着，这一轮做完了，在等你下一句（空闲 30 分钟自己收）
 *   confirm  琥珀光标、常亮：轮到你——批准一个操作或选一项。运行状态里琥珀只表示「轮到你」
 * 凡是说「这段对话的 Agent 现在怎样」的地方都用它（侧栏对话行 / 项目头、图标态「运行」、活动芯片与列表、对话头、
 * 对话页、工作台），不再用绿点 / 黄点。
 */

export type RunCaretState = "working" | "idle" | "confirm";

export const RUN_CARET_LABEL: Record<RunCaretState, string> = {
  working: "正在干活",
  idle: "开着，在等你下一句",
  confirm: "等你确认",
};

/** 一个开着的 Agent 的状态：会话尾部注意力 → 光标；还不知道（刚起来、没联动上）按闲着算 */
export function caretOfAttention(
  attention: "done" | "working" | "confirm" | null | undefined,
): RunCaretState {
  return attention === "confirm" ? "confirm" : attention === "working" ? "working" : "idle";
}

/** 几个合成一个（项目头、活动芯片）：有等确认的 > 有在干活的 > 都闲着；一个都没有为 null */
export function strongestCaret(states: Iterable<RunCaretState | null | undefined>): RunCaretState | null {
  let out: RunCaretState | null = null;
  for (const s of states) {
    if (s === "confirm") return "confirm";
    if (s === "working") out = "working";
    else if (s === "idle" && out === null) out = "idle";
  }
  return out;
}
