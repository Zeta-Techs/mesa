/**
 * 回到一段很长的对话时「缓存多半已过期」的提示（2026-11-08，借鉴 T3 Code 的压缩提示）。
 *
 * 模型服务端的提示缓存过期后，下一发会把整段对话按全价重新读一遍；对话越长越贵，用订阅额度时最容易撞 5 小时上限。
 * 这里只判断「该不该提醒」，不改发送行为：人看了提示自己点「先压缩」，或照常发送。
 *
 * 只做 Claude Code：Anthropic 的缓存时长有公开口径（官方订阅约 1 小时、API 密钥约 5 分钟），
 * 其余几家的缓存规则查不准，不猜。中转站可能完全不缓存或另有时长，按 API 密钥的 5 分钟算，提示用「多半」。
 */

/** 缓存约多久过期：官方订阅约 1 小时、API 密钥约 5 分钟。没有 Mesa 连接（CLI 自己登录）按订阅算 */
export function cacheTtlMs(accountType: "api" | "official" | null): number {
  return accountType === "api" ? 5 * 60_000 : 60 * 60_000;
}

/** 短对话重读一遍也花不了多少，不提醒 */
export const COLD_RESEND_MIN_TOKENS = 50_000;

/** 只有这几家给提示（Anthropic 缓存口径确知的） */
const CACHE_HINT_AGENTS = new Set(["claude"]);

export interface ColdCacheHint {
  /** 下一发要重新读的 token（上一轮喂进去的量） */
  tokens: number;
  /** 离上一轮多少分钟 */
  idleMinutes: number;
  /** 认这一轮的键：人点「照常发送」后同一轮不再提醒 */
  key: string;
}

/** 最后一条带时间戳的消息时刻（ms）；没有为 null */
export function lastMessageAt(messages: readonly { timestamp: string | null }[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const ts = messages[i].timestamp;
    if (!ts) continue;
    const t = Date.parse(ts);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * 该不该提醒：这家在名单里、上一轮喂进去的够多、离上一轮超过缓存时长。
 * 生成中、没法压缩（没在运行 / 这家没压缩命令）由调用方先挡掉。
 */
export function coldCacheHint(input: {
  agentId: string;
  accountType: "api" | "official" | null;
  lastAt: number | null;
  tokens: number | null;
  now: number;
}): ColdCacheHint | null {
  const { agentId, accountType, lastAt, tokens, now } = input;
  if (!CACHE_HINT_AGENTS.has(agentId)) return null;
  if (lastAt === null || tokens === null || tokens < COLD_RESEND_MIN_TOKENS) return null;
  const idle = now - lastAt;
  if (idle < cacheTtlMs(accountType)) return null;
  return { tokens, idleMinutes: Math.floor(idle / 60_000), key: `${lastAt}|${tokens}` };
}

/** 到什么时刻会变成「该提醒」（调用方据此定一次计时器）；不会变的为 null */
export function coldCacheAt(input: {
  agentId: string;
  accountType: "api" | "official" | null;
  lastAt: number | null;
  tokens: number | null;
}): number | null {
  const { agentId, accountType, lastAt, tokens } = input;
  if (!CACHE_HINT_AGENTS.has(agentId)) return null;
  if (lastAt === null || tokens === null || tokens < COLD_RESEND_MIN_TOKENS) return null;
  return lastAt + cacheTtlMs(accountType);
}

/** 离上一轮多久，写成人话 */
export function idleLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}
