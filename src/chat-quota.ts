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
import { endpointHost } from "./gateway-option.ts";

export type ChatQuotaTone = "ok" | "warn" | "danger";

export interface ChatQuotaWindowItem {
  window: string;
  /** 底栏短标签（如 5h / 周 / 月），单窗展示时可省略 */
  shortTag: string | null;
  remainPct: number;
  usedPercent: number;
  resetsAt: number | null;
  used: number | null;
  total: number | null;
  tone: ChatQuotaTone;
}

export type ChatQuotaView =
  | {
      kind: "plan";
      row: PlanQuotaDto;
      /** 最紧的窗口（用于判定整体告警档与重置卡提示） */
      primary: PlanQuotaWindowDto;
      /** 固定自然顺序排列的窗口列表（5 小时优先，其次本周，方便底栏同时展示且位置稳定） */
      windows: ChatQuotaWindowItem[];
      /** 最紧窗口的剩余百分比（0-100） */
      remainPct: number;
      /** 最紧窗口的已用百分比（0-100 整数；底栏圆环与数字都写已用，越满越接近上限） */
      usedPct: number;
      tone: ChatQuotaTone;
    }
  | {
      kind: "wallet";
      row: GatewayBalanceDto;
      usedPct: number | null;
      /** 剩余比例（0-100） */
      remainPct: number | null;
      /**
       * 底栏圆环画的已用比例：只有真上限（密钥额度、非不限）才有；
       * 账户钱包的 total = 剩余 + 历史累计花费，不是上限，画成比例会误导，返回 null（底栏只写余额，不画环）
       */
      ringUsedPct: number | null;
      tone: ChatQuotaTone;
    };

export interface ChatQuotaPeer {
  profile: Profile;
  row: PlanQuotaDto | null;
  remainPct: number | null;
  tone: ChatQuotaTone;
}

/** 将已用百分比换算为 0-100 的整数剩余百分比 */
export function quotaRemainPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, Math.round(100 - usedPercent)));
}

const WINDOW_DISPLAY_RANK: Record<string, number> = {
  five_hour: 0,
  weekly: 1,
  agy_argon_weekly: 1,
  monthly: 2,
  credits: 3,
};

export function shortWindowTag(window: string): string | null {
  if (window === "five_hour") return "5h";
  if (window === "weekly" || window === "agy_argon_weekly") return "周";
  if (window === "monthly") return "月";
  return null;
}

function gatewayHosts(gw: Gateway): string[] {
  const urls = [
    gw.slots?.anthropic,
    gw.slots?.openai,
    gw.slots?.responses,
    gw.slots?.gemini,
    gw.slots?.cursor,
  ];
  const hosts = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    const h = endpointHost(u).trim().toLowerCase();
    if (h) hosts.add(h);
  }
  return [...hosts];
}

function findWalletRowForProfile(
  profile: Profile,
  walletRows: readonly GatewayBalanceDto[],
  gateways: readonly Gateway[],
): GatewayBalanceDto | null {
  if (!profile.gatewayId) return null;
  const direct = walletRows.find((r) => r.gatewayId === profile.gatewayId && r.ok) ?? null;
  if (direct && direct.source === "wallet") return direct;

  // New API 一般按站点钱包计费而非单 Key 限额：若当前网关行是 token 视图或缺失，优先回落到同站点的钱包行
  if (direct?.origin) {
    const sameOriginWallet = walletRows.find(
      (r) => r.ok && r.source === "wallet" && r.origin === direct.origin,
    );
    if (sameOriginWallet) return sameOriginWallet;
  }

  const gw = gateways.find((g) => g.id === profile.gatewayId);
  if (gw) {
    const hosts = gatewayHosts(gw);
    if (hosts.length > 0) {
      const hostSet = new Set(hosts);
      const byHostWallet = walletRows.find(
        (r) => r.ok && r.source === "wallet" && hostSet.has(endpointHost(r.origin).trim().toLowerCase()),
      );
      if (byHostWallet) return byHostWallet;
    }
  }
  return direct;
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

/** 为聊天底栏微环解析当前 Profile 对应的订阅余量或网关钱包余额；无有效数据时返回 null（不占空位） */
export function resolveChatQuotaView(
  profile: Profile | null | undefined,
  planRows: readonly PlanQuotaDto[],
  walletRows: readonly GatewayBalanceDto[],
  gateways: readonly Gateway[] = [],
): ChatQuotaView | null {
  if (!profile) return null;
  const planRow = findPlanRowForProfile(profile, planRows);
  if (planRow && planRow.ok && planRow.windows.length > 0) {
    const byTightness = planWindowsByTightness(planRow.windows);
    const primary = byTightness[0];
    const naturalWindows: ChatQuotaWindowItem[] = [...planRow.windows]
      .sort((a, b) => (WINDOW_DISPLAY_RANK[a.window] ?? 9) - (WINDOW_DISPLAY_RANK[b.window] ?? 9))
      .map((w) => ({
        window: w.window,
        shortTag: shortWindowTag(w.window),
        remainPct: quotaRemainPercent(w.usedPercent),
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt,
        used: w.used,
        total: w.total,
        tone: quotaBarLevel(w.usedPercent),
      }));
    return {
      kind: "plan",
      row: planRow,
      primary,
      windows: naturalWindows,
      remainPct: quotaRemainPercent(primary.usedPercent),
      usedPct: 100 - quotaRemainPercent(primary.usedPercent),
      tone: quotaBarLevel(primary.usedPercent),
    };
  }
  const walletRow = findWalletRowForProfile(profile, walletRows, gateways);
  if (walletRow) {
    const usedPct = walletUsedPercent(walletRow.used, walletRow.total);
    const remainPct = usedPct == null ? null : Math.min(100, Math.max(0, 100 - usedPct));
    // 钱包余额按绝对余量防误报：累计充值很高时剩几千元不应因历史占比 >90% 标红
    const lowBalance =
      walletRow.remaining != null &&
      Number.isFinite(walletRow.remaining) &&
      (walletRow.currency === "USD" ? walletRow.remaining < 10 : walletRow.remaining < 50);
    const criticalBalance =
      walletRow.remaining != null &&
      Number.isFinite(walletRow.remaining) &&
      (walletRow.currency === "USD" ? walletRow.remaining < 2 : walletRow.remaining < 10);
    const tone: ChatQuotaTone =
      criticalBalance || (usedPct != null && usedPct >= 95 && walletRow.remaining == null)
        ? "danger"
        : lowBalance || (usedPct != null && usedPct >= 90 && walletRow.remaining == null)
          ? "warn"
          : "ok";
    const ringUsedPct =
      walletRow.source !== "wallet" && !walletRow.unlimited && usedPct != null ? Math.round(usedPct) : null;
    return {
      kind: "wallet",
      row: walletRow,
      usedPct,
      remainPct,
      ringUsedPct,
      tone,
    };
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
      const remainPct = top ? quotaRemainPercent(top.usedPercent) : null;
      const tone: ChatQuotaTone = top ? quotaBarLevel(top.usedPercent) : "ok";
      return {
        profile: p,
        row,
        remainPct,
        tone,
        sameKind: p.accountType === current.accountType ? 0 : 1,
      };
    });

  peers.sort((a, b) => {
    if (a.sameKind !== b.sameKind) return a.sameKind - b.sameKind;
    const aKnown = a.remainPct != null ? 0 : 1;
    const bKnown = b.remainPct != null ? 0 : 1;
    if (aKnown !== bKnown) return aKnown - bKnown;
    return (b.remainPct ?? -1) - (a.remainPct ?? -1);
  });

  return peers.slice(0, limit).map(({ profile, row, remainPct, tone }) => ({
    profile,
    row,
    remainPct,
    tone,
  }));
}
