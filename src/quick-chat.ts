/** 「快速开聊」纯逻辑（tests/quick-chat.test.ts）：默认选择、空白标签复用与收起。
 *  2026-10-18 用户拍板：快速开聊＝新对话（不弹窗、选择全在输入框里）。
 *  随手聊历史列表（新对话右键菜单、聊天空态）2026-10-23 撤掉：对话挂进侧栏项目树（sidebar-chats.ts）；
 *  运行页标签条与它的「+」2026-10-24 撤掉，新开只走侧栏「新对话」与项目行 ＋。 */
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

/** 从列表点开一段对话时，刚才看着的那个标签能不能顺手收掉（2026-10-23 侧栏挂对话第一期）：
 *  只看了没说的对话（preview：带着要接的会话、还没起进程），或还没说过话的空白新对话；
 *  输入框里有字、有图的不收（收了就丢了） */
export function isThrowawayTab(
  tab: { resumeSessionId?: string | null; reuseKey?: string; preview?: boolean },
  status: { alive?: boolean; running?: boolean; sessionId?: string | null } | null | undefined,
  hasDraft: boolean,
): boolean {
  if (hasDraft || status?.alive || status?.running) return false;
  if (tab.preview && tab.resumeSessionId) return true;
  return isNewChatKey(tab.reuseKey) && isBlankChatTab(tab, status);
}

/** 「新对话」入口开的空白标签：快速开聊（`quickchat:<uuid>`）与项目行「＋ 新对话」（`<类型>:<项目>:project:<uuid>`，
 *  2026-10-24 起每次 ＋ 都是一段新对话）。别的入口开的空白标签（问 AI、阅读、步骤…）不算 */
export function isNewChatKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return key.startsWith(QUICK_CHAT_KEY_PREFIX) || /^(?:office|coding|research):.+:project:[^:]+$/.test(key);
}

/** Windows 上 Codex 在主目录启动、又跑在沙箱里（非「完全访问」）时要先提醒：Codex 的 Windows 沙箱跑命令前
 *  会给工作目录下每一项改访问权限，主目录 = 整个用户文件夹（文档、桌面、AppData…），很慢，还会给沙箱账户
 *  留下写权限；开发版里改到 Mesa 源码会让 tauri dev 重编译并重启 Mesa（2026-10-20 实测）。
 *  完全访问不进沙箱，不改权限，不提醒 */
export function codexSandboxCoversHome(input: {
  agentId: string;
  cwd: string;
  home: string;
  permissionMode: string | null | undefined;
  isWindows: boolean;
}): boolean {
  if (!input.isWindows || input.agentId !== "codex" || input.permissionMode === "full") return false;
  const cwd = input.cwd.trim();
  if (!cwd || cwd === "~") return true;
  return !!input.home && pathKey(cwd, true) === pathKey(input.home, true);
}

/** 默认随手聊目录：家目录下 `ccode/scratch`（与 ensure_scratch_dir 同口径）。
 *  未添加到项目的编码仓库（例如 Mesa 源码目录）不算随手聊。 */
export function isScratchCwd(path: string, isWindows = false): boolean {
  if (!path) return false;
  const k = pathKey(path, isWindows);
  return k.endsWith("/ccode/scratch") || k.includes("/ccode/scratch/");
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
