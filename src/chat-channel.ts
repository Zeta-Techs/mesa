/**
 * 聊天层结构化旁路（docs/design-chat-structured-channels.md）的前端纯逻辑：后端 chat_channel.rs 把各家 CLI 自己吐的
 * 结构化事件统一成一份快照（`chat-channel-<tabId>` 事件），这里把它翻成聊天层要的东西——跟着换会话文件、
 * 回合状态 → 标签注意力、实时文字、「等你决定」卡的内容与按钮。
 *
 * 优先级：旁路说了算的事，读会话文件 / 读屏的推断只补空缺（旁路没接上的家照旧走原来那套）。
 */
import { samePath } from "./path-utils.ts";
import { lineDiff, parsePatch, unwrapPowerShell, type DiffLine } from "./tool-activity.ts";

export type ChannelKind = "hooks" | "qwen" | "opencode" | "codex";

export interface ChannelTurn {
  seq: number;
  status: "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
  stopReason: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface ChannelApproval {
  requestId: string | null;
  /** 可经 CLI 官方通道从聊天层答（Qwen / OpenCode / Codex）；false = 只能在终端菜单里答 */
  replyable: boolean;
  toolName: string | null;
  kind: "execute" | "edit" | "read" | "fetch" | "other";
  command: string | null;
  path: string | null;
  oldText: string | null;
  newText: string | null;
  diff: string | null;
  detail: string | null;
  alwaysLabel: string | null;
}

export interface ChatChannelSnapshot {
  tabId: string;
  agent: string;
  kind: ChannelKind;
  sessionId: string | null;
  transcriptPath: string | null;
  sessionSeq: number;
  sessionSource: string | null;
  turn: ChannelTurn | null;
  approval: ChannelApproval | null;
  liveText: string | null;
  notice: { seq: number; text: string } | null;
}

export type ChannelReplyDecision = "allow" | "allow_always" | "deny";

export function channelTurnOpen(snap: ChatChannelSnapshot | null): boolean {
  const s = snap?.turn?.status;
  return s === "running" || s === "awaiting_approval";
}

/** 旁路的回合状态 → 标签注意力（working / confirm / done）；旁路没说过就 null（交回原来的推断） */
export function channelAttention(snap: ChatChannelSnapshot | null): "working" | "confirm" | "done" | null {
  const t = snap?.turn;
  if (!t) return null;
  if (t.status === "running") return "working";
  if (t.status === "awaiting_approval") return "confirm";
  return "done";
}

/**
 * 旁路告诉的会话与聊天层现在盯的文件对不上时怎么办：
 * - lock：还没认出会话文件，旁路直接给了路径 → 按它锁定（不再按目录排队猜）
 * - switch：已经盯着一个文件，CLI 换了会话（/clear、恢复别的会话）→ 改盯新文件
 * - hint：只给了会话 id（Qwen / OpenCode）→ 交给按 id 找文件
 */
export function channelRelink(
  snap: ChatChannelSnapshot | null,
  current: { filePath: string | null; hint: string | null; seenSeq: number },
  isWindows: boolean,
): { kind: "none" } | { kind: "lock" | "switch"; path: string; sessionId: string | null } | { kind: "hint"; sessionId: string } {
  if (!snap) return { kind: "none" };
  if (snap.transcriptPath) {
    if (!current.filePath) return { kind: "lock", path: snap.transcriptPath, sessionId: snap.sessionId };
    if (snap.sessionSeq > current.seenSeq && !samePath(snap.transcriptPath, current.filePath, isWindows)) {
      return { kind: "switch", path: snap.transcriptPath, sessionId: snap.sessionId };
    }
    return { kind: "none" };
  }
  if (snap.sessionId && !current.filePath && current.hint !== snap.sessionId) {
    return { kind: "hint", sessionId: snap.sessionId };
  }
  return { kind: "none" };
}

/** 换会话时对话流里插的一行说明 */
export function sessionSwitchNote(source: string | null): string {
  if (source === "clear") return "已开始新对话（/clear）";
  if (source === "resume") return "已接回另一段对话";
  if (source === "compact") return "上下文已压缩，接着这段对话";
  return "已切到新的会话";
}

/** 旁路送来的这一轮实时文字（Qwen / OpenCode / Codex）；回合结束后不再当预览 */
export function channelLiveLines(snap: ChatChannelSnapshot | null): string[] | null {
  if (!snap?.liveText || !snap.turn) return null;
  const text = snap.liveText.trim();
  return text ? text.split("\n") : null;
}

export type DecisionPreview =
  | { kind: "command"; text: string }
  | { kind: "diff"; path: string | null; lines: DiffLine[] }
  | { kind: "text"; text: string };

/** 审批卡上画什么：命令原文 / 要改的差异 / 参数原文 */
export function approvalPreview(a: ChannelApproval | null): DecisionPreview | null {
  if (!a) return null;
  if (a.command) return { kind: "command", text: displayCommand(a.command) };
  if (a.diff) {
    const files = parsePatch(a.diff);
    const lines = files.length ? files.flatMap((f) => f.lines) : diffTextLines(a.diff);
    return { kind: "diff", path: a.path, lines };
  }
  if (a.oldText !== null || a.newText !== null) {
    return { kind: "diff", path: a.path, lines: lineDiff(a.oldText ?? "", a.newText ?? "") };
  }
  if (a.kind === "other" && a.detail) return { kind: "text", text: a.detail };
  return null;
}

/**
 * 命令去掉外层 shell 包装再给人看：Codex 把模型的命令再包一层登录 shell，审批里是
 * `/bin/zsh -lc "/bin/zsh -lc 'printf …'"`（2026-10-20 用户截图）。只剥「整条就是 sh -c 加一个引号串」的；
 * 双引号串里有没转义的 $ 或反引号就不剥（那要外层 shell 先展开，剥了含义会变）。
 * Windows 上包的是 PowerShell：`"D:\…\pwsh.exe" -Command 'echo …'`（同日 Windows 端到端实测），同样剥掉
 */
export function displayCommand(command: string): string {
  let cur = command.trim();
  for (let i = 0; i < 3; i++) {
    const m = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")$/.exec(cur);
    if (!m) {
      const ps = unwrapPowerShell(cur);
      if (ps === null) break;
      cur = ps;
      continue;
    }
    if (m[1] !== undefined) {
      cur = m[1].trim();
    } else {
      if (/(^|[^\\])[$`]/.test(m[2])) break;
      cur = m[2].replace(/\\(["\\$`])/g, "$1").trim();
    }
  }
  return cur;
}

/** 统一差异文本 → 行（没有补丁头的裸差异：+ / - / 空格开头；改多个文件时后端每段前加「*** 路径」，画成分隔） */
function diffTextLines(diff: string): DiffLine[] {
  return diff
    .split("\n")
    .filter((l) => !l.startsWith("@@") && !l.startsWith("+++") && !l.startsWith("---"))
    .map((l) =>
      l.startsWith("*** ")
        ? { op: "~" as const, text: l.slice(4) }
        : l.startsWith("+")
        ? { op: "+" as const, text: l.slice(1) }
        : l.startsWith("-")
          ? { op: "-" as const, text: l.slice(1) }
          : { op: " " as const, text: l.startsWith(" ") ? l.slice(1) : l },
    );
}

const KIND_TITLE: Record<ChannelApproval["kind"], string> = {
  execute: "要运行一条命令",
  edit: "要改文件",
  read: "要读文件",
  fetch: "要访问网络",
  other: "要用一个工具",
};

/** 卡片标题：「Codex 要运行一条命令」「Claude Code 要改文件 · a.ts」 */
export function approvalTitle(a: ChannelApproval, agentLabel: string): string {
  const name = a.path ? a.path.split(/[\\/]/).pop() : null;
  const base = `${agentLabel} ${KIND_TITLE[a.kind]}`;
  if (a.kind === "edit" && name) return `${base} · ${name}`;
  if (a.kind === "other" && a.toolName) return `${agentLabel} 要用 ${a.toolName}`;
  return base;
}

/** 眼下这一问聊天层卡上就能答（Codex / Qwen / OpenCode 经官方通道）：不必再把终端拉出来 */
export function channelCanAnswer(snap: ChatChannelSnapshot | null, agent: string | null): boolean {
  return Boolean(snap?.approval && approvalChoices(snap.approval, agent).length);
}

/** 可从聊天层答的审批给哪几个按钮（只摆 CLI 支持的，不替用户选） */
export function approvalChoices(
  a: ChannelApproval,
  agent: string | null,
): Array<{ decision: ChannelReplyDecision; label: string; primary?: boolean }> {
  if (!a.replyable || !a.requestId) return [];
  const always =
    agent === "codex" ? "这次会话都允许" : agent === "opencode" ? "总是允许这类操作" : null;
  return [
    { decision: "allow", label: "允许", primary: true },
    ...(always ? [{ decision: "allow_always" as const, label: a.alwaysLabel ?? always }] : []),
    { decision: "deny", label: "拒绝" },
  ];
}
