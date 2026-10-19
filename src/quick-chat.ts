/** 「快速开聊」纯逻辑（tests/quick-chat.test.ts）：默认选择、空白标签复用、随手聊历史，以及运行页「+」的目录。
 *  2026-10-18 用户拍板：快速开聊＝新对话（不弹窗、选择全在输入框里），「+」＝在当前项目里再开一个 Agent。
 *  随手聊历史只排除「点了也没法恢复」的——归档 / Mesa 内部无头会话 / 源文件已不在的 /
 *  进程仍活着的（live，resume 同会话会被 CLI 拒：active writer 冲突）。 */
import type { SessionMetaDto } from "./types";
import { pathKey } from "./path-utils.ts";

/** 快速开聊的自动路径只使用明确可启动的配置；未知状态放行，避免旧数据被误拦。 */
export function profileCanAutoStart(
  profile: {
    slotMissing?: boolean;
    connectionStatus?: string;
    modelSyncStatus?: string;
  },
  hidden = false,
): boolean {
  if (hidden || profile.slotMissing) return false;
  return (
    ![
      "gateway_missing",
      "slot_missing",
      "credential_missing",
      "probe_failed",
      "model_unsynced",
    ].includes(profile.connectionStatus ?? "") &&
    profile.modelSyncStatus !== "missing"
  );
}

/** 快速开聊标签的复用键前缀：每个标签带自己的 `quickchat:<uuid>`（后端按复用键认 Run，不能共用一个），
 *  再点快速开聊时按前缀找还没说过话的那个 */
export const QUICK_CHAT_KEY_PREFIX = "quickchat:";

export type QuickChatChoice = {
  agentId?: string;
  profileId?: string;
  model?: string;
  effort?: string | null;
};

/**
 * 连接页「新对话」：点哪条连接就用哪条开空白对话，不走「记住的 / 上次启动的」那套默认。
 * 模型取这条连接名单里的第一个（名单首个即启动默认），名单为空则不预选、交给输入框里的默认。
 * 目的是让人快速验证这条连接能不能用：开出来写着的就是点的那条，发一句话看有没有回复。
 */
export function chatChoiceForProfile(profile: {
  id: string;
  agent: string;
  models?: readonly string[] | null;
}): QuickChatChoice & { agentId: string; profileId: string } {
  const model = profile.models?.find((m) => m.trim()) ?? undefined;
  return {
    agentId: profile.agent,
    profileId: profile.id,
    ...(model ? { model } : {}),
    effort: null,
  };
}

/**
 * 快速开聊直接开的那个空白对话用谁（不弹窗，选择都在输入框里，开出来能看见、能改）：
 * 上次快速开聊发出第一句时用的 → 同一家的另一条可用连接 → 运行页上次启动的 → 本机装了的第一家里第一条可用连接 →
 * 任意一条可用连接。一条可用连接都没有时仍给出一家 Agent（输入框里提示先去「连接」页添加）。
 * 模型只在连接就是记住的那条、且它的模型名单里有（或名单为空）时沿用；思考档跟着模型走。
 * 取代 2026-09-06「直达只接受记住的那条，失效退回弹层」：弹层没了，换成别的连接时输入框里写着是哪条。
 */
export function pickQuickChatDefault(input: {
  remembered: QuickChatChoice;
  lastLaunch: { agentId?: string; profileId?: string };
  /** 可用的连接（已按 profileCanAutoStart 过滤） */
  usable: readonly { id: string; agent: string; models: readonly string[] }[];
  /** 本机装了的 Agent，按界面顺序 */
  installed: readonly string[];
  /** 全部 Agent，按界面顺序（都没装时取第一家） */
  agentOrder: readonly string[];
}): QuickChatChoice & { agentId: string } {
  const { remembered, lastLaunch, usable, installed, agentOrder } = input;
  const exact = usable.find(
    (p) => p.id === remembered.profileId && p.agent === remembered.agentId,
  );
  if (exact) {
    const keepModel =
      Boolean(remembered.model) &&
      (exact.models.length === 0 || exact.models.includes(remembered.model!));
    return {
      agentId: exact.agent,
      profileId: exact.id,
      ...(keepModel ? { model: remembered.model, effort: remembered.effort ?? null } : {}),
    };
  }
  const sameAgent = usable.find((p) => p.agent === remembered.agentId);
  if (sameAgent) return { agentId: sameAgent.agent, profileId: sameAgent.id };
  const last = usable.find(
    (p) => p.id === lastLaunch.profileId && p.agent === lastLaunch.agentId,
  );
  if (last) return { agentId: last.agent, profileId: last.id };
  for (const agent of installed) {
    const first = usable.find((p) => p.agent === agent);
    if (first) return { agentId: agent, profileId: first.id };
  }
  if (usable[0]) return { agentId: usable[0].agent, profileId: usable[0].id };
  return {
    agentId: remembered.agentId || installed[0] || agentOrder[0] || "claude-code",
  };
}

/** 还没说过话的标签：没起过进程、没接上会话、不是重启后等接回的占位。再点快速开聊只复用这种 */
export function isBlankChatTab(
  tab: { resumeSessionId?: string | null },
  status?: { alive?: boolean; running?: boolean; sessionId?: string | null } | null,
): boolean {
  if (tab.resumeSessionId) return false;
  if (!status) return true;
  return !status.alive && !status.running && !status.sessionId;
}

/** 运行页「+」的目录：跟当前标签走（在同一个项目里再开一个 Agent）。当前标签在主目录、没有目录，
 *  或在 Mesa 管的隔离目录（科研工作副本 / 编程工作树 / 定时隔离树，各有自己的入口和 Run 身份）里时，
 *  不跟，照旧开在主目录 */
export function newTabCwd(focusedCwd: string | null | undefined, isWindows = false): string | undefined {
  const cwd = focusedCwd?.trim();
  if (!cwd || cwd === "~") return undefined;
  const k = pathKey(cwd, isWindows);
  if (/\/ccode\/(workspaces|worktrees|watch-worktrees)\//.test(`${k}/`)) return undefined;
  return cwd;
}

/** 「没法恢复」的会话统一排除口径 */
function recoverable(s: SessionMetaDto): boolean {
  return !s.archived && !s.internal && !s.live && s.alive;
}

/** 默认随手聊目录：家目录下 `ccode/scratch`（与 ensure_scratch_dir 同口径）。
 *  未添加到项目的编码仓库（例如 Mesa 源码目录）不算随手聊。 */
export function isScratchCwd(path: string, isWindows = false): boolean {
  if (!path) return false;
  const k = pathKey(path, isWindows);
  return k.endsWith("/ccode/scratch") || k.includes("/ccode/scratch/");
}

/** 快速开聊（随手聊）历史：只列 `~/ccode/scratch` 里可恢复的会话。
 *  工作区 / 已注册项目 / 别的未注册仓库都走对话页，不进这张卡。
 *  「转为项目」后 scratch 若被登记，也会被 projectPaths 挡掉。 */
export function pickQuickChatSessions(
  sessions: SessionMetaDto[],
  projectPaths: string[],
  limit = 8,
  isWindows = false,
): SessionMetaDto[] {
  // 注册项目路径来自后端注册表、会话 projectPath 来自 CLI 写的 cwd —— 两种来源在
  // Windows 上可能是 verbatim/普通、大小写、分隔符三重不同。只去尾斜杠比不中。
  // isWindows 显式传入而非在此读 IS_WINDOWS：本模块是纯逻辑层，
  // 隐式依赖平台会让单测随宿主机器变化。
  const projects = new Set(
    (projectPaths ?? []).filter(Boolean).map((p) => pathKey(p, isWindows)),
  );
  return (sessions ?? [])
    .filter(
      (s) =>
        s != null &&
        recoverable(s) &&
        s.workspace === null &&
        isScratchCwd(s.projectPath, isWindows) &&
        !projects.has(pathKey(s.projectPath, isWindows)),
    )
    .slice(0, limit);
}

/** 终端页正在跑的会话键，与 store.sessionRuntimeKey 同形（agent + 换行 + sessionId） */
function liveSessionKey(agent: string, sessionId: string): string {
  return `${agent}\n${sessionId}`;
}

/** 用终端页 liveSessions 补标正在跑的会话（比上次 list_sessions 更新） */
export function withLiveSessionFlags(
  sessions: readonly SessionMetaDto[],
  liveSessions: Record<string, string>,
): SessionMetaDto[] {
  const live = liveSessions ?? {};
  return (sessions ?? []).map((s) => {
    const isLive = s.live || liveSessionKey(s.agent, s.sessionId) in live;
    return isLive === s.live ? s : { ...s, live: isLive };
  });
}

/** 聊天空态 / 右键菜单共用：本机会话列表现算随手聊历史，不 round-trip */
export function pickQuickChatHistory(
  sessions: SessionMetaDto[],
  projectPaths: string[],
  liveSessions: Record<string, string>,
  isWindows = false,
  limit = 8,
): SessionMetaDto[] {
  return pickQuickChatSessions(
    withLiveSessionFlags(sessions, liveSessions),
    projectPaths,
    limit,
    isWindows,
  );
}

/** 列表行的归属标注：工作区会话显工作区名，否则显目录尾段 */
export function sessionHomeLabel(s: SessionMetaDto): string {
  if (s.workspace) return `⛁ ${s.workspace}`;
  const parts = s.projectPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || s.projectPath;
}

/** 列表行标题：自定义标题 > 会话标题 > 摘要 > 兜底。
 *  会话标题来自后端解析器（首条实质 user 消息；纯问候语已在 usable_title 层跳过） */
export function sessionDisplayTitle(s: SessionMetaDto): string {
  return s.customTitle ?? s.title ?? s.summary ?? "未命名对话";
}
