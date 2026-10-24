/**
 * 运行页两块的宽度（2026-10-24 用户：「文件树、对话、右边面板的宽度你也需要设计一下」；同日文件树并进右栏后只剩两块；tests/run-layout.test.ts）。
 * 两块从左到右：对话（聊天或终端）、右栏（文件 / 改动，一次一个窗格，可收起）。文件树不再单占一列，是右栏文件窗格里的「树」标签。
 * 规则：
 *   一，对话永远不窄于 CHAT_MIN_PX——它是主角，聊天栏一行约 52 字的上限另由 .ccode-chat-column 管，多出来的空间归它、文字居中。
 *   二，右栏默认 460px，可拖，最窄 RIGHT_MIN_PX，记住（是偏好，实际宽度每次按窗口现算，不改偏好）。
 *   三，地方不够时只压右栏：最窄 RIGHT_MIN_PX，窗口实在太窄也只给到「总宽 − 对话最窄」。
 *   四，「专注内容」（右栏铺满）和平时同一条规则——铺满时偏好宽度被设成窗口宽的约六成，同样给对话留最窄那一条。
 */

export const CHAT_MIN_PX = 360;
export const RIGHT_MIN_PX = 360;
export const RIGHT_DEFAULT_PX = 460;

export interface RunLayoutInput {
  /** 运行页（不含应用侧栏）的总宽 */
  total: number;
  rightOpen: boolean;
  /** 右栏偏好宽度（px） */
  rightWidth: number;
}

export interface RunLayout {
  /** 右栏这次的实际宽度（关着为 0） */
  right: number;
  /** 拖右栏时能拖到的最宽 */
  rightMax: number;
}

export function runLayout(input: RunLayoutInput): RunLayout {
  const total = Math.max(0, input.total);
  const rightMax = Math.max(RIGHT_MIN_PX, total - CHAT_MIN_PX);
  const right = input.rightOpen
    ? Math.round(Math.min(rightMax, Math.max(RIGHT_MIN_PX, input.rightWidth)))
    : 0;
  return { right, rightMax };
}
