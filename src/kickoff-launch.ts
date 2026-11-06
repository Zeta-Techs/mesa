/**
 * 科研开步启动配置：弹层里选 Agent/连接，确认后自动拉起。
 * 项目内新会话优先 Agents 名册；没有项目默认才回落问 AI 记忆 / 上次使用。
 */
import { askAiCanSkip, type AskAiRemembered } from "./ask-ai.ts";
import { projectAgentLaunch } from "./project-agents.ts";

export interface KickoffLaunch {
  agentId: string;
  profileId: string;
  model: string;
  /** 本次思考档覆盖（2026-09-15）：空 = 用绑定逐模型策略/端点默认；
   *  非空经 pty_spawn 的 effortOverride 注入，不写回绑定 */
  effort?: string | null;
  /** 这一步用哪一档原生权限（2026-11-06 用户拍板：开工弹层能选，默认「帮我批准」）：
   *  经标签种子 permissionMode → pty_spawn 只加在这次命令行；null / 缺省 = 按这家 CLI 本机设置 */
  permissionMode?: KickoffPermission | null;
}

/** 开工能选的三档（先出方案不在这里：步骤要写文件） */
export type KickoffPermission = "ask" | "auto" | "full";
export const KICKOFF_PERMISSIONS: readonly KickoffPermission[] = ["ask", "auto", "full"];

/** 开工弹层里每档的说明：按「一步要跑很久、人可能走开」来写 */
export const KICKOFF_PERMISSION_TEXT: Record<KickoffPermission, string> = {
  ask: "改文件、跑脚本前都先停下问你。一步要点很多次，你走开它就停着",
  auto: "日常改文件、跑脚本直接做，删文件这类有风险的才停下问你",
  full: "什么都不再问你，删文件也不问。只在你清楚这一步要做什么时用",
};

function kickoffPermKey(projectRoot: string): string {
  return `ccode.kickoffPerm.${projectRoot}`;
}

/** 本项目上次开工选的档：只记「请求批准 / 帮我批准」——完全访问每次都要重新选、重新确认，不默认带上 */
export function loadKickoffPermission(projectRoot: string): KickoffPermission | null {
  try {
    const v = localStorage.getItem(kickoffPermKey(projectRoot));
    return v === "ask" || v === "auto" ? v : null;
  } catch {
    return null;
  }
}

export function saveKickoffPermission(projectRoot: string, tier: KickoffPermission): void {
  try {
    if (tier === "full") localStorage.removeItem(kickoffPermKey(projectRoot));
    else localStorage.setItem(kickoffPermKey(projectRoot), tier);
  } catch {
    /* 不记即可 */
  }
}

/** 开工弹层预选哪一档：本项目上次选的 > 这家 CLI 本机设置对应的 > 帮我批准 > 请求批准；
 *  这家一档原生参数都没有（available 空）返回 null = 按本机设置，不给选 */
export function pickKickoffPermission(
  available: readonly string[],
  remembered: KickoffPermission | null,
  localTier: string | null | undefined,
): KickoffPermission | null {
  const ok = (t: string | null | undefined): t is KickoffPermission =>
    !!t && (KICKOFF_PERMISSIONS as readonly string[]).includes(t) && available.includes(t);
  if (ok(remembered)) return remembered;
  if (ok(localTier)) return localTier;
  if (ok("auto")) return "auto";
  if (ok("ask")) return "ask";
  return null;
}

// ===== 开工项目级记忆（B1）：ccode.kickoffLast.<projectRoot> =====
// 开工确认无条件写入，供本项目的下次开工预填与弹层折叠判定；与问 AI 的
// ccode.askAi（AskAiModal 自管）彻底分键——此前两处写同一个键互相覆写 useDefault。
// 只记三元组（effort 是本次覆盖不入记忆）。kickoffLast 缺失时由弹层只读回落
// loadAskAiRemembered() 做首跑预填（不回写），保老用户肌肉记忆。

export interface KickoffLastChoice {
  agentId: string;
  profileId: string;
  model: string;
}

export function kickoffLastKey(projectRoot: string): string {
  return `ccode.kickoffLast.${projectRoot}`;
}

export function loadKickoffLast(projectRoot: string): KickoffLastChoice | null {
  try {
    const raw = localStorage.getItem(kickoffLastKey(projectRoot));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<KickoffLastChoice>;
    if (!v || typeof v.agentId !== "string" || typeof v.profileId !== "string") {
      return null;
    }
    return {
      agentId: v.agentId,
      profileId: v.profileId,
      model: typeof v.model === "string" ? v.model : "",
    };
  } catch {
    return null;
  }
}

export function saveKickoffLast(projectRoot: string, choice: KickoffLastChoice): void {
  try {
    localStorage.setItem(kickoffLastKey(projectRoot), JSON.stringify(choice));
  } catch {
    /* 隐私模式：不记即可 */
  }
}

export function pickKickoffLaunch(
  profiles: readonly { id: string; agent: string; models?: string[] }[],
  /** 记忆三件组（问 AI 记忆或开工 kickoffLast 均可——只读 agentId/profileId/model） */
  remembered:
    | Pick<AskAiRemembered, "agentId" | "profileId" | "model">
    | null,
  last?: { agentId?: string; profileId?: string; model?: string } | null,
  preferredAgent?: string | null,
  preferredProfile?: string | null,
  preferredModel?: string | null,
): KickoffLaunch | null {
  if (profiles.length === 0) return null;
  const has = (id: string) => profiles.some((p) => p.id === id);
  const from = remembered ?? last ?? null;
  const profile =
    (preferredProfile &&
    (!preferredAgent ||
      profiles.find((p) => p.id === preferredProfile)?.agent === preferredAgent)
      ? profiles.find((p) => p.id === preferredProfile) ?? null
      : null) ??
    (preferredAgent
      ? profiles.find((p) => p.agent === preferredAgent) ?? null
      : null) ??
    (from?.profileId && has(from.profileId)
      ? profiles.find((p) => p.id === from.profileId)
      : null) ??
    (from?.agentId
      ? profiles.find((p) => p.agent === from.agentId)
      : null) ??
    profiles[0]!;
  const models = profile.models ?? [];
  const projectModel =
    preferredProfile &&
    profile.id === preferredProfile.trim() &&
    preferredModel?.trim()
      ? preferredModel.trim()
      : "";
  const rememberedModel = from?.model?.trim() ?? "";
  // 连接没列模型时，记忆里的模型只认同一条连接：别的连接（甚至别家 Agent）的模型名带过来会启动失败
  const model = projectModel && models.includes(projectModel)
    ? projectModel
    : rememberedModel &&
        (models.includes(rememberedModel) || (models.length === 0 && from?.profileId === profile.id))
      ? rememberedModel
      : (models[0] ?? "");
  return { agentId: profile.agent, profileId: profile.id, model };
}

/** 编程开工 / 进入工作树：项目绑了 Agents 就直接拉起，否则记住的默认连接可直接拉起。 */
export function codingTerminalLaunch(
  profiles: readonly { id: string; agent: string; models?: string[] }[],
  remembered: AskAiRemembered | null,
  preferredAgent?: string | null,
  preferredProfile?: string | null,
  preferredModel?: string | null,
): {
  agentId: string;
  profileId: string;
  model: string;
  autoStart: boolean;
} | null {
  const agent = preferredAgent?.trim() ?? "";
  const bound = preferredProfile?.trim() ?? "";
  const model = preferredModel?.trim() ?? "";
  const project = projectAgentLaunch(
    profiles,
    agent,
    agent && bound ? { [agent]: bound } : null,
    agent && model ? { [agent]: model } : null,
  );
  const launch =
    project ??
    pickKickoffLaunch(
      profiles,
      remembered,
      null,
      preferredAgent,
      preferredProfile,
      preferredModel,
    );
  if (!launch) return null;
  return {
    ...launch,
    autoStart: !!project || askAiCanSkip(remembered, profiles),
  };
}

export function kickoffLaunchLabel(
  launch: KickoffLaunch | null,
  profiles: readonly { id: string; name?: string; agent: string }[],
  agentLabel: (id: string) => string,
): string {
  if (!launch) return "还没有可用连接";
  const p = profiles.find((x) => x.id === launch.profileId);
  const agent = agentLabel(launch.agentId);
  const name = p?.name?.trim();
  const model = launch.model.trim();
  if (name && model) return `${agent} · ${name} · ${model}`;
  if (name) return `${agent} · ${name}`;
  return agent;
}
