/** 侧栏把对话拖进某一步（2026-11-20 用户：「加一个可以自己拖动对话到任务步骤下面」）的纯逻辑。
 *  只改 Mesa 自己记的步骤归属（set_session_step），不碰会话文件；在步骤工作区里的对话照工作区认，不给拖 */

/** 按下后移动超过这么多像素才算拖（不然就是点一下打开） */
export const CHAT_DRAG_THRESHOLD = 6;

export function pastChatDragThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= CHAT_DRAG_THRESHOLD;
}

type DraggableChat = {
  workspace?: string | null;
  reader?: boolean;
  internal?: boolean;
  stepName?: string | null;
};

/** 能拖进步骤的对话：在课题里、不在某个工作区里（工作区的对话步骤由工作区定）、不是精读或 Mesa 内部对话 */
export function canDragChatToStep(s: DraggableChat, inProject: boolean): boolean {
  return inProject && !s.workspace?.trim() && !s.reader && !s.internal;
}

/** ⋯ 里「移出这一步」：步骤归属是记出来的（商量、研讨接力、人手拖进来的），不是工作区定的 */
export function canLeaveStep(s: DraggableChat): boolean {
  return Boolean(s.stepName?.trim()) && !s.workspace?.trim();
}

/** 拖的时候在课题下补出还没有对话的步骤当落点（已经有组的步骤用组头）：按档案卡顺序，第几步从 1 起 */
export function missingStepTargets(
  configSteps: readonly string[],
  shown: readonly string[],
): { name: string; index: number }[] {
  const have = new Set(shown);
  return configSteps
    .map((name, i) => ({ name, index: i + 1 }))
    .filter((t) => t.name.trim() && !have.has(t.name));
}

/** 写步骤归属要写到哪几段：接力对话列表里只占一行，各段都写，不然代表接过前面那段的步骤又回来了 */
export function stepWriteTargets(s: {
  agent: string;
  sessionId: string;
  relaySegments?: readonly { agent: string; sessionId: string }[] | null;
}): { agent: string; sessionId: string }[] {
  const out = [{ agent: s.agent, sessionId: s.sessionId }];
  for (const seg of s.relaySegments ?? []) {
    if (!out.some((x) => x.agent === seg.agent && x.sessionId === seg.sessionId)) {
      out.push({ agent: seg.agent, sessionId: seg.sessionId });
    }
  }
  return out;
}
