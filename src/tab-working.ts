/** 终端标签「生成中」虚线圆：只表示这一轮正在出字，不是进程还活着。 */

export type TabAttention = "done" | "working" | "confirm" | null;

/** 敲键/焦点引起的 TUI 重绘不算生成中 */
export const PTY_ECHO_SUPPRESS_MS = 300;
/** 已经出过字之后，PTY 静默这么久视为本轮生成结束 */
export const PTY_WORKING_SILENCE_MS = 2000;
/** 会话文件把中途助手正文标成 done 时，PTY 在这段时间内出过字则转圈接着转 */
export const PTY_LIVE_MS = 8000;

export function ptyInputLooksLikeSubmit(data: string, kimiEnter: string): boolean {
  return data.includes("\r") || data.includes("\n") || data.includes(kimiEnter);
}

/** 启动/恢复本身不算生成中。只有这次启动会注入首条指令才点亮。恢复会话后端不注入。 */
export function shouldArmWorkingOnLaunch(input: {
  prompt?: string | null;
  isResume: boolean;
}): boolean {
  if (input.isResume) return false;
  return Boolean(input.prompt?.trim());
}

/** 会话窗口最后一条有效消息已经是助手正文（无待执行工具）= 这一轮已经生成完。 */
export function conversationTurnSettled(
  messages: { role: string; blocks: { kind: string; text: string }[] }[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const hasTool = message.blocks.some((block) => block.kind === "tool_use");
    const hasText = message.blocks.some(
      (block) => block.kind === "text" && Boolean(block.text.trim()),
    );
    if (!hasTool && !hasText) continue;
    if (message.role === "user") return false;
    if (hasTool) return false;
    return true;
  }
  return false;
}

/** PTY 输出要不要把标签打成 working。confirm 不抢；回合结束后的 TUI 残帧必须 armed。 */
export function ptyOutputMarksWorking(input: {
  prev: TabAttention;
  armed: boolean;
  msSinceInteraction: number;
}): boolean {
  if (input.msSinceInteraction <= PTY_ECHO_SUPPRESS_MS) return false;
  if (input.prev === "confirm") return false;
  if (input.prev === "working") return true;
  return input.armed;
}

/** 会话尾部 working 很黏（user 行直到 assistant 落盘），不得在 PTY 已熄灭后重新点亮转圈。
 *  会话窗口已经落完助手正文、且 PTY 不再出字时立刻 done。
 *  Codex 会在工具调用之间写入助手正文，会话尾部提前变 done；PTY 还在出字时不得停转圈。 */
export function applyTailAttention(input: {
  prev: TabAttention;
  tail: string;
  armed: boolean;
  turnSettled?: boolean;
  ptyLive?: boolean;
  /** 聊天层还在等这一轮的下一条回复。会话文件里的半段正文不算回合结束。 */
  pendingReply?: boolean;
}): { attention: TabAttention; armed: boolean } {
  if (input.tail === "confirm") return { attention: "confirm", armed: false };
  // settled = 会话文件里有确定的回合结束标记（Claude 的 system/turn_duration）：
  // 不再看 PTY 是否还在出字——状态行、计时等重绘会让 PTY 一直有输出，
  // 按「静下来才收尾」会让聊天层永远停在「正在回复」（2026-10-17 用户截图）
  if (input.tail === "settled" && !input.pendingReply) {
    return { attention: "done", armed: false };
  }
  const fileSaysOver =
    !input.pendingReply &&
    (input.tail === "done" || input.tail === "settled" || Boolean(input.turnSettled));
  if (fileSaysOver) {
    if (input.ptyLive && (input.armed || input.prev === "working")) {
      return { attention: "working", armed: input.armed };
    }
    return { attention: "done", armed: false };
  }
  if (input.tail === "working" || input.pendingReply) {
    if (input.armed || input.prev === "working" || input.pendingReply) {
      return { attention: "working", armed: input.armed };
    }
    return { attention: input.prev, armed: false };
  }
  return { attention: null, armed: input.armed };
}

/** 生成中静默：armed 回合不因静默熄灭——静默 ≠ 回合结束，推理模型的思考间隙普遍
 *  超过数秒；此前 2s 静默即熄灭且 armed 一并耗尽，后续输出再也点不亮 working
 *  （终端还在出字、标签与聊天层却全程无运行态，2026-09-15 实测）。armed 只由
 *  会话层收尾清（settled/confirm）、退出或下一次提交重置；未 armed 的 working
 *  保持 2s 静默熄灭（无回合语义的兜底）。
 *  2026-09-19 加硬上限：真实思考/执行期间 TUI 动画仍在出字（claude ✽/codex 流式），
 *  整轮「完全无声」超过 PTY_ARMED_SILENCE_CAP_MS 只可能是回合早已结束或链路冻结
 *  （实测：综述大纲跑完后收尾判定被 ptyLive 推迟、轮询又被签名门拦住，转圈冻结）——
 *  此时熄灭转圈但保留 armed，PTY 再出字立即复亮。 */
export const PTY_ARMED_SILENCE_CAP_MS = 120_000;

export function onPtyWorkingSilence(input: {
  prev: TabAttention;
  armed: boolean;
  hadPtyWorkingOutput: boolean;
  pendingReply?: boolean;
  silenceMs?: number;
}): { attention: TabAttention; armed: boolean; clearHadOutput: boolean } {
  if (input.prev !== "working") {
    return {
      attention: input.prev,
      armed: input.armed,
      clearHadOutput: false,
    };
  }
  if (input.armed || input.pendingReply) {
    if (
      !input.pendingReply &&
      (input.silenceMs ?? 0) >= PTY_ARMED_SILENCE_CAP_MS
    ) {
      return { attention: null, armed: true, clearHadOutput: true };
    }
    return {
      attention: "working",
      armed: input.armed || Boolean(input.pendingReply),
      clearHadOutput: false,
    };
  }
  return { attention: null, armed: false, clearHadOutput: true };
}
