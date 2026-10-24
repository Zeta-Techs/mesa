/**
 * 运行页三块的宽度（2026-10-24 用户：「文件树、对话、右边面板的宽度你也需要设计一下」；tests/run-layout.test.ts）。
 * 三块从左到右：文件树（这段对话的文件夹，可收起）、对话（聊天或终端）、右栏（文件预览 / 改动，可收起）。
 * 规则：
 *   一，对话永远不窄于 CHAT_MIN_PX——它是主角，聊天栏一行约 52 字的上限另由 .ccode-chat-column 管，多出来的空间归它、文字居中。
 *   二，文件树默认 15rem，可拖 12–22rem，记住；右栏默认 460px，可拖，最窄 RIGHT_MIN_PX，记住（都是偏好，实际宽度每次按窗口现算，不改偏好）。
 *   三，地方不够时按顺序让：先把右栏压到最窄，再让文件树先收起来（右栏关掉或窗口拉宽后自己回来，不改「开着」的偏好）；
 *       还不够（窗口实在太窄）右栏也只给到「总宽 − 对话最窄」。
 *   四，「专注内容」（右栏铺满）时文件树收起，右栏取偏好宽度但给对话留最窄那一条。
 */

export const CHAT_MIN_PX = 360;
export const RIGHT_MIN_PX = 360;
export const RIGHT_DEFAULT_PX = 460;
export const TREE_MIN_REM = 12;
export const TREE_DEFAULT_REM = 15;
export const TREE_MAX_REM = 22;

export function clampTreeWidth(width: number, rem: number): number {
  return Math.round(Math.min(TREE_MAX_REM * rem, Math.max(TREE_MIN_REM * rem, width)));
}

export interface RunLayoutInput {
  /** 运行页（不含应用侧栏）的总宽 */
  total: number;
  /** 根字号（Mac 14px、Windows 16px） */
  rem: number;
  treeOpen: boolean;
  /** 文件树偏好宽度（px） */
  treeWidth: number;
  rightOpen: boolean;
  /** 右栏偏好宽度（px） */
  rightWidth: number;
  /** 右栏「专注内容」铺满 */
  rightExpanded: boolean;
}

export interface RunLayout {
  /** 文件树这次画不画（开着但让位时为 false） */
  treeShown: boolean;
  /** 开着、但因为地方不够先让给右栏 */
  treeYielded: boolean;
  tree: number;
  right: number;
  /** 拖右栏时能拖到的最宽 */
  rightMax: number;
  /** 拖文件树时能拖到的最宽 */
  treeMax: number;
}

export function runLayout(input: RunLayoutInput): RunLayout {
  const total = Math.max(0, input.total);
  const tree = clampTreeWidth(input.treeWidth, input.rem);
  const treeMinPx = TREE_MIN_REM * input.rem;
  const treeMaxPx = TREE_MAX_REM * input.rem;
  const rightCap = (used: number) => Math.max(RIGHT_MIN_PX, total - used - CHAT_MIN_PX);

  if (input.rightOpen && input.rightExpanded) {
    const rightMax = rightCap(0);
    return {
      treeShown: false,
      treeYielded: input.treeOpen,
      tree,
      right: Math.round(Math.min(rightMax, Math.max(RIGHT_MIN_PX, input.rightWidth))),
      rightMax,
      treeMax: treeMinPx,
    };
  }

  // 文件树放不放得下：对话最窄 + （右栏开着时）右栏最窄之外还剩它的地方
  const reserve = CHAT_MIN_PX + (input.rightOpen ? RIGHT_MIN_PX : 0);
  const treeFits = total - tree >= reserve;
  const treeShown = input.treeOpen && treeFits;
  const usedByTree = treeShown ? tree : 0;
  const rightMax = rightCap(usedByTree);
  const right = input.rightOpen
    ? Math.round(Math.min(rightMax, Math.max(RIGHT_MIN_PX, input.rightWidth)))
    : 0;
  return {
    treeShown,
    treeYielded: input.treeOpen && !treeFits,
    tree,
    right,
    rightMax,
    treeMax: Math.max(treeMinPx, Math.min(treeMaxPx, total - reserve)),
  };
}
