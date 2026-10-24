/**
 * 终端会话恢复的标签复用与配置挑选纯逻辑（2026-09-08 审计修复）。
 *
 * 两条规则：
 * 1. resume 兜底找「正持有这条会话」的活标签时只按 runId 或 agent+sessionId 认身份；
 *    cwd 相同不算数——同目录的别家 agent / shell 标签不是这条会话的持有者，
 *    抢过去等于把 Codex 会话恢复到 Claude 标签上。
 * 2. 恢复请求显式带了原配置（runId 恢复带出的 run.profileId）时优先原配置，
 *    不按「上次使用」重新挑选覆盖；原配置已删除/停用时不静默替换，
 *    返回 reselectNeeded 让 UI 提示用户重选（停用口径与 resume-profile.ts 一致：
 *    自动路径跳过停用项，手动选择才允许）。
 * 3. 项目绑定（autoLaunchProfileId）要显示在启动栏：不能被 Codex 渠道兼容池
 *    静默换成上次的网关。渠道和这条会话不一致时预填绑定、不自动启动。
 */

import { pickResumeProfile } from "./resume-profile.ts";

export interface HolderTabLike {
  id: string;
  runId?: string;
  initialAgentId?: string;
}

export interface HolderStatusLike {
  alive: boolean;
  running?: boolean;
  runId: string | null;
  sessionId: string | null;
  agentId: string;
}

/** 找正持有目标会话的活标签；没有则 undefined（调用方新开标签） */
export function findResumeHolderTab<T extends HolderTabLike>(
  tabs: readonly T[],
  statuses: Record<string, HolderStatusLike | undefined>,
  target: { runId?: string; agentId: string; sessionId: string },
): T | undefined {
  return tabs.find((t) => {
    const st = statuses[t.id];
    if (!st?.alive) return false;
    if (target.runId && (st.runId ?? t.runId ?? null) === target.runId)
      return true;
    const agent = st.agentId || t.initialAgentId;
    return st.sessionId === target.sessionId && agent === target.agentId;
  });
}

/** 已有标签要不要再 launch。
 *  Agent 还在跑：只切过去。回落 shell / 已退出 / 还没起来：再拉起。
 *  注意：`alive` 含登录 shell，不能拿它当「已经在聊」——否则继续对话只看到壳、再点就抢 Run 锁。 */
export function shouldRelaunchResumeTab(st?: {
  alive?: boolean;
  running?: boolean;
} | null): boolean {
  return !st?.running;
}

/** 拉起 PTY 时用的行列。xterm 还没量到格子（隐藏标签、首帧未 fit）时不传，
 *  后端保持 24×80。量到了就按当前画面启动：resume 会在进程活着的第一帧按这个宽度
 *  重放整段对话；先 80 列再拉宽，窄的那份会留在滚动记录里。 */
/** 启动前先 fit 一次再读格子。fit 抛错（容器宽高为 0）时返回 null。 */
export function fittedPtySize(
  fit: { fit: () => void } | null | undefined,
  term: { cols?: number; rows?: number } | null | undefined,
): { cols: number; rows: number } | null {
  try {
    fit?.fit();
  } catch {
    return null;
  }
  return launchPtySize(term);
}

export function launchPtySize(
  term: { cols?: number; rows?: number } | null | undefined,
): { cols: number; rows: number } | null {
  const cols = term?.cols;
  const rows = term?.rows;
  if (
    typeof cols !== "number" ||
    typeof rows !== "number" ||
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    rows < 1
  ) {
    return null;
  }
  return { cols, rows };
}

export interface ResumeLaunchRequest {
  agentId: string;
  provider?: string | null;
  /** 调用方显式指定的配置（runId 恢复带出的原配置） */
  profileId?: string;
  model?: string;
  autoLaunchProfileId?: string | null;
}

export interface ResumeLaunchPick {
  profileId: string;
  model: string;
  /** true = 原配置失效：只预填不自动启动，UI 需提示用户重选 */
  reselectNeeded: boolean;
  /** 项目默认能显示，但和这条会话上次的 Codex 渠道不同：预填默认，不自动启动 */
  channelChanged?: boolean;
}

export function resolveResumeLaunch<
  T extends {
    id: string;
    agent: string;
    models: string[];
    baseUrl: string | null;
    gatewayId?: string | null;
    accountType?: string | null;
  },
>(
  profiles: T[],
  req: ResumeLaunchRequest,
  hiddenIds?: readonly string[],
  lastProfileId?: string | null,
): ResumeLaunchPick {
  const hidden = hiddenIds ?? [];
  const preferredId = req.autoLaunchProfileId?.trim();
  if (preferredId) {
    const preferred = profiles.find(
      (p) => p.id === preferredId && p.agent === req.agentId,
    );
    if (preferred && !hidden.includes(preferred.id)) {
      const channelPick = pickResumeProfile(
        profiles,
        req.agentId,
        req.provider,
        preferred.id,
        hiddenIds,
      );
      return {
        profileId: preferred.id,
        model: req.model ?? preferred.models[0] ?? "",
        reselectNeeded: false,
        channelChanged: channelPick?.id !== preferred.id,
      };
    }
  }
  if (req.profileId) {
    const orig = profiles.find(
      (p) => p.id === req.profileId && p.agent === req.agentId,
    );
    if (orig && !hidden.includes(orig.id)) {
      return {
        profileId: orig.id,
        model: req.model ?? orig.models[0] ?? "",
        reselectNeeded: false,
      };
    }
    return { profileId: "", model: "", reselectNeeded: true };
  }
  const pick = pickResumeProfile(
    profiles,
    req.agentId,
    req.provider,
    lastProfileId,
    hiddenIds,
  );
  return {
    profileId: pick?.id ?? "",
    model: pick?.models[0] ?? "",
    reselectNeeded: false,
  };
}

/** 列表里点一段对话接着聊时，交给 resolveResumeLaunch 的连接（2026-10-24 用户：点开一段对话，输入框底部应是它之前用的配置）。
 *  这段对话自己记下的连接（session_meta.profile_id，没有退回原 Run 的）还在、没停用就用它，项目默认不再盖过它；
 *  它不在了才按项目给这家设的连接（autoLaunchProfileId，Codex 渠道不同时预填不自动跑）；都没有交给原配置失效提示 / 上次使用 */
export function resumeProfileChoice(input: {
  agentId: string;
  own: string | null | undefined;
  preferred: string | null | undefined;
  profiles: readonly { id: string; agent: string }[];
  hidden?: readonly string[];
}): { profileId?: string; autoLaunchProfileId?: string } {
  const own = input.own?.trim() || "";
  const preferred = input.preferred?.trim() || "";
  const usable = (id: string) =>
    input.profiles.some((p) => p.id === id && p.agent === input.agentId) &&
    !(input.hidden ?? []).includes(id);
  if (own && usable(own)) return { profileId: own };
  if (preferred) return { autoLaunchProfileId: preferred };
  return own ? { profileId: own } : {};
}

/** 接着聊默认的模型：这段对话最后一轮用的那个，换到的连接名单里有它（或名单空着，任填）才带上，
 *  否则交给连接默认（resolveResumeLaunch 取名单第一个） */
export function resumeModelChoice(
  model: string | null | undefined,
  profile: { models: readonly string[] } | null | undefined,
): string | undefined {
  const m = model?.trim();
  if (!m || !profile) return undefined;
  return profile.models.length === 0 || profile.models.includes(m) ? m : undefined;
}

/** 会话文件最近一分钟有写入时，是不是 Mesa 自己写的：这段对话最近一次是 Mesa 起的、已经停了，
 *  最后一次写入不晚于停下的时刻（留 5 秒给 CLI 退出前的最后一笔）。是的话就不是「别的终端里在跑」，不用提醒
 *  （2026-10-24 实证：关掉一个刚起的 Codex 标签，一分钟内再从侧栏点它就误报） */
export function lastWriteIsMesas(
  updatedAt: string | null | undefined,
  run: { closedAt: string | null } | null | undefined,
): boolean {
  if (!updatedAt || !run?.closedAt) return false;
  const wrote = Date.parse(updatedAt);
  const closed = Date.parse(run.closedAt);
  if (Number.isNaN(wrote) || Number.isNaN(closed)) return false;
  return wrote <= closed + 5000;
}
