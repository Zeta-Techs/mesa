// 聊天底栏「订阅余量 / 网关余额」微环纯逻辑：
// 从当前会话绑定的 Profile 匹配对应的订阅套餐或网关钱包行，排序出同厂可快速切换的备选号。
import type { Gateway, GatewayBalanceDto, PlanQuotaDto, PlanQuotaWindowDto, Profile } from "./types.ts";
import { findPlanRowForProfile, hasOfficialQuotaCard } from "./official-accounts.ts";
import {
  gatewayHasPlanQuota,
  planWindowsByTightness,
  quotaBarLevel,
} from "./plan-quota.ts";
import { gatewayHasWallet, walletUsedPercent } from "./gateway-balance.ts";

export type ChatQuotaTone = "ok" | "warn" | "danger";

export type ChatQuotaView =
  | {
      kind: "plan";
      row: PlanQuotaDto;
      /** 最紧的窗口（画在外环，决定数字与着色档位） */
      primary: PlanQuotaWindowDto;
      /** 次窗口（画在内环，单窗供应商为 null） */
      secondary: PlanQuotaWindowDto | null;
      /** 其余窗口按紧度排列（供浮层明细遍历） */
      windows: PlanQuotaWindowDto[];
      pct: number;
      tone: ChatQuotaTone;
    }
  | {
      kind: "wallet";
      row: GatewayBalanceDto;
      usedPct: number | null;
      /** 剩余比例（0-100，用于画圆环，满圈 = 余额充足） */
      remainPct: number | null;
      tone: ChatQuotaTone;
    };

export interface ChatQuotaPeer {
  profile: Profile;
  row: PlanQuotaDto | null;
  usedPct: number | null;
  tone: ChatQuotaTone;
}

/** 仅依据本地配置判断这条连接是否「可能有」订阅余量或网关余额，用于决定是否需要后台静默拉取 */
export function profileQuotaKind(
  profile: Profile | null | undefined,
  gateways: readonly Gateway[],
): "plan" | "wallet" | null {
  if (!profile) return null;
  if (profile.accountType === "official" && hasOfficialQuotaCard(profile.agent)) {
    return "plan";
  }
  if (!profile.gatewayId) return null;
  const gw = gateways.find((g) => g.id === profile.gatewayId);
  if (!gw) return null;
  if (gatewayHasPlanQuota(gw)) return "plan";
  if (gatewayHasWallet(gw)) return "wallet";
  return null;
}

/** 为聊天底栏微环解析当前 Profile 对应的订阅余量或网关余额；无有效数据时返回 null（不占空位） */
export function resolveChatQuotaView(
  profile: Profile | null | undefined,
  planRows: readonly PlanQuotaDto[],
  walletRows: readonly GatewayBalanceDto[],
): ChatQuotaView | null {
  if (!profile) return null;
  const planRow = findPlanRowForProfile(profile, planRows);
  if (planRow && planRow.ok && planRow.windows.length > 0) {
    const ordered = planWindowsByTightness(planRow.windows);
    const primary = ordered[0];
    const secondary = ordered[1] ?? null;
    const pct = Math.min(100, Math.max(0, Math.round(primary.usedPercent)));
    return {
      kind: "plan",
      row: planRow,
      primary,
      secondary,
      windows: ordered,
      pct,
      tone: quotaBarLevel(primary.usedPercent),
    };
  }
  if (profile.gatewayId) {
    const walletRow = walletRows.find((r) => r.gatewayId === profile.gatewayId && r.ok);
    if (walletRow) {
      const usedPct = walletUsedPercent(walletRow.used, walletRow.total);
      const remainPct = usedPct == null ? null : Math.min(100, Math.max(0, 100 - usedPct));
      const tone: ChatQuotaTone =
        usedPct == null ? "ok" : usedPct >= 90 ? "danger" : usedPct >= 80 ? "warn" : "ok";
      return {
        kind: "wallet",
        row: walletRow,
        usedPct,
        remainPct,
        tone,
      };
    }
  }
  return null;
}

/** 列出同 Agent 其他可切账号（优先同类型、已知余量且已用比例更低的号），供浮层底部一键切号 */
export function listSameAgentPeers(
  current: Profile | null | undefined,
  allProfiles: readonly Profile[],
  planRows: readonly PlanQuotaDto[],
  hiddenProfileIds: readonly string[] = [],
  limit = 3,
): ChatQuotaPeer[] {
  if (!current || limit <= 0) return [];
  const hidden = new Set(hiddenProfileIds);
  const peers = allProfiles
    .filter(
      (p) =>
        p.agent === current.agent &&
        p.id !== current.id &&
        !hidden.has(p.id) &&
        (p.accountType === "official" || p.hasKey || p.noAuth),
    )
    .map((p) => {
      const row = findPlanRowForProfile(p, planRows) ?? null;
      const ordered = row && row.ok && row.windows.length > 0 ? planWindowsByTightness(row.windows) : [];
      const top = ordered[0] ?? null;
      const usedPct = top ? Math.min(100, Math.max(0, Math.round(top.usedPercent))) : null;
      const tone: ChatQuotaTone = top ? quotaBarLevel(top.usedPercent) : "ok";
      return {
        profile: p,
        row,
        usedPct,
        tone,
        sameKind: p.accountType === current.accountType ? 0 : 1,
      };
    });

  peers.sort((a, b) => {
    if (a.sameKind !== b.sameKind) return a.sameKind - b.sameKind;
    const aKnown = a.usedPct != null ? 0 : 1;
    const bKnown = b.usedPct != null ? 0 : 1;
    if (aKnown !== bKnown) return aKnown - bKnown;
    return (a.usedPct ?? 101) - (b.usedPct ?? 101);
  });

  return peers.slice(0, limit).map(({ profile, row, usedPct, tone }) => ({
    profile,
    row,
    usedPct,
    tone,
  }));
}
