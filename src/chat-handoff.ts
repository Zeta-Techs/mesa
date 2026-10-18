//! 聊天层 ⇄ 终端层交接纯逻辑（tests/chat-handoff.test.ts）。
//!
//! 聊天是同一 PTY 的结构化显示层，不复制九家 TUI 菜单解析器。
//! 能用已知字符串写进 PTY 的（直切 /model、/effort、y/n/Esc、生成中 Esc 暂停）留在聊天；
//! 方向键选择器、登录、信任目录交给终端画面——默认「窥视」（露出同一 xterm 底部，
//! 不改行列数），只有启动注入失败等必须粘贴进 TUI 输入框的才整层切走。

import type { ChatMessageDto, SessionSyncState } from "./types.ts";

/** 已接入 hooks 精确注意力的七家（cursor / opencode 无等价事件） */
export const HOOKS_AGENTS: ReadonlySet<string> = new Set([
  "claude",
  "qwen",
  "codebuddy",
  "gemini",
  "kimi",
  "grok",
  "codex",
]);

export type ChatHandoffEvent =
  | "send_message"
  | "direct_slash"
  | "picker_model"
  | "hooks_confirm"
  | "no_hooks_confirm"
  | "login_or_trust"
  | "prompt_dropped"
  | "self_update";

/** chat_ok = 聊天层独立完成；peek = 露出同一会话 TUI；must_switch = 整层切到终端 */
export type ChatHandoffAction = "chat_ok" | "peek" | "must_switch";

export type ChatWaitKind =
  | "idle"
  | "sent"
  | "writing"
  | "using_tool"
  | "no_session";

export function agentHasHooks(agentId: string | null | undefined): boolean {
  return Boolean(agentId && HOOKS_AGENTS.has(agentId));
}

export function confirmHandoffEvent(
  agentId: string | null | undefined,
  hooksEnabled: boolean,
): Extract<ChatHandoffEvent, "hooks_confirm" | "no_hooks_confirm"> {
  return agentHasHooks(agentId) && hooksEnabled
    ? "hooks_confirm"
    : "no_hooks_confirm";
}

export function handoffFor(event: ChatHandoffEvent): ChatHandoffAction {
  switch (event) {
    case "send_message":
    case "direct_slash":
      return "chat_ok";
    case "picker_model":
    case "hooks_confirm":
    case "no_hooks_confirm":
    case "login_or_trust":
      return "peek";
    case "prompt_dropped":
    case "self_update":
      return "must_switch";
  }
}

export function shouldAutoPeek(event: ChatHandoffEvent): boolean {
  const action = handoffFor(event);
  return action === "peek" || action === "must_switch";
}

/** 审批卡片附加说明：不解析 TUI，只提示已知失效原因 */
export function approvalExtraHint(
  agentId: string | null | undefined,
  hooksEnabled: boolean,
): string | null {
  if (agentId === "codex") {
    return "若按键无效，请到终端里打开 /hooks，确认已信任该 hook";
  }
  if (!agentHasHooks(agentId) || !hooksEnabled) {
    return "这家 Agent 没有精确注意力标记，批准菜单请在露出的终端里操作";
  }
  return null;
}

export function latestToolName(
  messages: Pick<ChatMessageDto, "role" | "blocks">[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return null;
    for (let j = message.blocks.length - 1; j >= 0; j--) {
      const block = message.blocks[j];
      if (block.kind === "tool_use" && block.toolName) return block.toolName;
    }
  }
  return null;
}

export function hasAssistantText(
  messages: Pick<ChatMessageDto, "role" | "blocks">[],
): boolean {
  return messages.some(
    (message) =>
      message.role !== "user" &&
      message.blocks.some(
        (block) => block.kind === "text" && Boolean(block.text?.trim()),
      ),
  );
}

export function chatWaitKind(input: {
  pendingReply: boolean;
  running: boolean;
  syncState: SessionSyncState;
  messageCount: number;
  stuckWaiting: boolean;
  toolName: string | null;
}): ChatWaitKind {
  if (input.stuckWaiting) return "no_session";
  if (!input.pendingReply) {
    if (
      input.running &&
      input.syncState === "waiting" &&
      input.messageCount === 0
    ) {
      return "idle";
    }
    return "idle";
  }
  if (input.toolName) return "using_tool";
  if (input.syncState === "watching" || input.syncState === "polling") {
    return "writing";
  }
  return "sent";
}

export function chatWaitText(
  kind: ChatWaitKind,
  toolName?: string | null,
): string {
  switch (kind) {
    case "sent":
      return "已送出";
    case "writing":
      // 会话文件一段写完聊天层才看得到；终端里是实时的（聊天层另给「看实时输出」）
      return "正在生成回复";
    case "using_tool":
      return toolName ? `正在用 ${toolName}` : "正在调用工具";
    case "no_session":
      return "会话文件还没出现（去终端看确认）";
    default:
      return "";
  }
}

/**
 * 聊天头状态微字。未发过、也没在跑时不要写「等待会话文件」——
 * 同步通道默认 waiting，那是还没开始，不是丢了文件。
 */
export function chatHeaderStatus(input: {
  state: "idle" | "detecting" | "linked" | "timeout";
  syncState: SessionSyncState;
  running: boolean;
  canResume: boolean;
  messageCount: number;
}): string {
  const { state, syncState, running, canResume, messageCount } = input;
  const started = running || messageCount > 0;
  if (state === "detecting" || syncState === "detecting") return "识别会话";
  if (!started) return state === "timeout" && canResume ? "可恢复" : "";
  if (state === "timeout" && canResume) return "可恢复";
  if (state === "timeout") return "等待会话文件";
  if (syncState === "waiting") return "等待会话文件";
  if (syncState === "polling") return running ? "同步中" : "已结束 · 可继续";
  if (syncState === "watching") return running ? "实时同步" : "已结束 · 可继续";
  if (state === "linked") return running ? "实时同步" : "已结束 · 可继续";
  return running ? "Agent 运行中" : "准备开始";
}

/** 发送钮变「进行中」暂停：只在正在出字，或刚发出还在等首个助手字
 * （pendingReply 窗口里输入框已清、上一轮正文已落——发送钮没有发送对象）。
 * 停在提示符时要点发送；审批 confirm 时 Esc 归审批卡，不占发送钮。 */
export function composerShowsInterrupt(input: {
  running?: boolean;
  attention?: "done" | "working" | "confirm" | null;
  pendingReply?: boolean;
}): boolean {
  if (!input.running) return false;
  if (input.attention === "confirm") return false;
  return input.attention === "working" || Boolean(input.pendingReply);
}

/** 斜杠发出后要不要露出 TUI：无参 /model、/models、/login 会唤选择器或登录页 */
export function slashHandoff(
  text: string,
  modelSwitchKind: "direct" | "picker" | null,
): ChatHandoffEvent {
  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  const cmd = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const hasArgs = space >= 0 && trimmed.slice(space).trim().length > 0;
  if (cmd === "/login" || cmd === "/models") return "picker_model";
  if (cmd === "/model" && (!hasArgs || modelSwitchKind === "picker")) {
    return "picker_model";
  }
  return "direct_slash";
}

export function chatMessageKey(
  message: Pick<ChatMessageDto, "role" | "blocks" | "timestamp">,
): string {
  const firstText = message.blocks.find((block) => block.kind === "text")?.text ?? "";
  return `${message.role}:${message.timestamp ?? ""}:${message.blocks.length}:${firstText.slice(0, 24)}`;
}

/** 向前翻页时把旧窗接到最新窗前面，按内容键去重（最新窗优先） */
export function mergeConversationPages(
  older: ChatMessageDto[],
  latest: ChatMessageDto[],
): ChatMessageDto[] {
  const seen = new Set(latest.map(chatMessageKey));
  const head = older.filter((message) => !seen.has(chatMessageKey(message)));
  return [...head, ...latest];
}

/**
 * 把会话文件还没记下的本地消息放回解析结果里（聊天层乐观显示）。排队中的（上一轮还在生成时发的）
 * 一律接在末尾；其余插在「发送之后才出现的第一条回复」前面——后端暂时只解析到回复时阅读顺序仍对。
 * knownReplyKeys = 发送那一刻已有的回复（JSON.stringify(blocks)）。原先插在整页第一条回复前，
 * 长对话里刚发的那句会跳到页顶（2026-10-18 修）。
 */
export function placePendingUsers(
  parsed: ChatMessageDto[],
  missing: ChatMessageDto[],
  knownReplyKeys: ReadonlySet<string>,
): ChatMessageDto[] {
  if (missing.length === 0) return parsed;
  const next = [...parsed];
  const replyIndex = next.findIndex(
    (message) => message.role !== "user" && !knownReplyKeys.has(JSON.stringify(message.blocks)),
  );
  next.splice(replyIndex < 0 ? next.length : replyIndex, 0, ...missing.filter((m) => !m.queued));
  next.push(...missing.filter((m) => m.queued));
  return next;
}

/** kimi /model 吃的是别名：非法字符清洗为 _，与状态栏 / global_config 同规则 */
export function kimiModelArg(model: string): string {
  return model.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function modelSwitchCommand(
  template: string,
  model: string,
  agentId: string | null | undefined,
): string {
  const arg = agentId === "kimi" ? kimiModelArg(model) : model;
  return template.replace("{model}", arg);
}
