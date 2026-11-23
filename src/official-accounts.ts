import type { PlanQuotaDto, Profile } from "./types";

const MULTI_OFFICIAL_AGENTS = new Set([
  "claude-code",
  "codex",
  "agy",
  "grok",
  "kimi",
  "gemini",
  "codebuddy",
]);

const ISOLATED_ENV_VARS: Record<string, string> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME",
  kimi: "KIMI_CODE_HOME",
  gemini: "GEMINI_CLI_HOME",
  codebuddy: "CODEBUDDY_CONFIG_DIR",
};

const OFFICIAL_QUOTA_AGENTS = new Set(["claude-code", "codex", "agy", "grok", "kimi"]);

export function supportsMultiOfficial(agentId: string): boolean {
  return MULTI_OFFICIAL_AGENTS.has(agentId);
}

export function isolatedEnvVarOf(agentId: string): string {
  return ISOLATED_ENV_VARS[agentId] ?? "CONFIG_DIR";
}

export function hasOfficialQuotaCard(agentId: string): boolean {
  return OFFICIAL_QUOTA_AGENTS.has(agentId);
}

export function officialAccountModeOf(
  profile: Pick<Profile, "accountType" | "officialRef"> | null | undefined,
): "default" | "isolatedDir" | "managedSnapshot" | null {
  if (!profile || profile.accountType !== "official") return null;
  return profile.officialRef?.mode ?? "default";
}

export function isNonDefaultOfficial(
  profile: Pick<Profile, "accountType" | "officialRef"> | null | undefined,
): boolean {
  const mode = officialAccountModeOf(profile);
  return mode === "isolatedDir" || mode === "managedSnapshot";
}

/**
 * 同 Agent 内切换连接时，判断是否必须走「接力简报（relay_prepare）」而非原 session_id 直连：
 * - Claude / Codex 隔离目录官方号与默认目录或其他隔离目录之间，session 文件互相隔离，不能原 ID 接回；
 * - Antigravity 跨官方账号（不同托管快照 / 默认槽位）涉及账号归属与签名，统一走接力简报更安全；
 * - 同目录普通网关之间的切换仍走原有 switchConnection 原会话接回。
 */
export function needsRelayOnSameAgentSwitch(
  from: Pick<Profile, "id" | "agent" | "accountType" | "officialRef"> | null | undefined,
  to: Pick<Profile, "id" | "agent" | "accountType" | "officialRef"> | null | undefined,
): boolean {
  if (!from || !to || from.id === to.id || from.agent !== to.agent) return false;
  // 两端都是官方号且 ID 不同（跨账号切换）
  if (from.accountType === "official" && to.accountType === "official") return true;
  // 任一端是独立隔离目录（CLAUDE_CONFIG_DIR / CODEX_HOME），会话文件不在默认根
  if (
    officialAccountModeOf(from) === "isolatedDir" ||
    officialAccountModeOf(to) === "isolatedDir"
  ) {
    return true;
  }
  return false;
}

const QUOTA_ERR_RE =
  /\b(429|rate[_\s-]?limit|usage[_\s-]?limit|quota[_\s-]?exceeded|limit\s+reached|too\s+many\s+requests|hit\s+your\s+(?:usage\s+)?limit)\b|额度已?(?:满|用完|耗尽)|触发限额|达到(?:使用)?上限/i;

export function isQuotaExhaustedError(text: string | null | undefined): boolean {
  if (!text) return false;
  return QUOTA_ERR_RE.test(text);
}

/** 找出某条 PlanQuotaDto 是否已有任意窗口用满（≥ 99.5%） */
export function isPlanRowExhausted(row: PlanQuotaDto | null | undefined): boolean {
  if (!row || !row.ok) return false;
  return row.windows.some((w) => w.usedPercent >= 99.5);
}

function rowMaxUsedPercent(row: PlanQuotaDto | undefined): number {
  if (!row || !row.ok || row.windows.length === 0) return -1;
  return Math.max(...row.windows.map((w) => w.usedPercent));
}

function rowMatchesProfile(row: PlanQuotaDto, profile: Profile): boolean {
  if (row.bindingId && row.bindingId === profile.id) return true;
  if (profile.accountType === "official") {
    const mode = officialAccountModeOf(profile);
    if (mode === "default") {
      if (profile.agent === "claude-code" && row.gatewayId === "official:claude-code") return true;
      if (profile.agent === "codex" && row.gatewayId === "official:codex") return true;
      if (profile.agent === "agy" && row.gatewayId === "official:agy") return true;
      if (profile.agent === "grok" && row.gatewayId === "official:grok") return true;
      if (profile.agent === "kimi" && row.gatewayId === "official:kimi") return true;
    }
    return (
      row.gatewayId === `official:${profile.agent}:${profile.id}` ||
      (profile.agent === "claude-code" && row.gatewayId === `official:claude-code:${profile.id}`)
    );
  }
  return Boolean(profile.gatewayId && row.gatewayId === profile.gatewayId);
}

/**
 * 当当前账号触发限额或用量卡显示已满时，从同 Agent 其他可用账号中挑选最合适的接力备选号：
 * 优先选已知未满且已用比例最低的同类型账号（官方号优先配同厂另一个官方号，其次同厂网关）。
 */
export function pickAlternateAccountForLimit(
  current: Profile | null | undefined,
  allProfiles: readonly Profile[],
  planRows: readonly PlanQuotaDto[],
  hiddenProfileIds: readonly string[] = [],
): { profile: Profile; usedPct: number | null } | null {
  if (!current) return null;
  const hidden = new Set(hiddenProfileIds);
  const candidates = allProfiles.filter(
    (p) =>
      p.agent === current.agent &&
      p.id !== current.id &&
      !hidden.has(p.id) &&
      (p.accountType === "official" || p.hasKey || p.noAuth),
  );
  if (candidates.length === 0) return null;

  const scored = candidates.map((p) => {
    const row = planRows.find((r) => rowMatchesProfile(r, p));
    const maxPct = rowMaxUsedPercent(row);
    const exhausted = row ? isPlanRowExhausted(row) : false;
    const sameKind = p.accountType === current.accountType ? 0 : 1;
    return { profile: p, maxPct, exhausted, sameKind };
  });

  // 过滤掉已知也满额的号
  const available = scored.filter((s) => !s.exhausted);
  if (available.length === 0) return null;

  available.sort((a, b) => {
    // 同类型（官方→官方）优先
    if (a.sameKind !== b.sameKind) return a.sameKind - b.sameKind;
    // 已知余量的优先，且已用越低越靠前
    const aKnown = a.maxPct >= 0 ? 0 : 1;
    const bKnown = b.maxPct >= 0 ? 0 : 1;
    if (aKnown !== bKnown) return aKnown - bKnown;
    return a.maxPct - b.maxPct;
  });

  const best = available[0];
  return {
    profile: best.profile,
    usedPct: best.maxPct >= 0 ? Math.round(best.maxPct) : null,
  };
}

export function findPlanRowForProfile(
  profile: Profile | null | undefined,
  planRows: readonly PlanQuotaDto[],
): PlanQuotaDto | undefined {
  if (!profile) return undefined;
  return planRows.find((r) => rowMatchesProfile(r, profile));
}
