// 官方账号线路体检（docs/design-outbound-route.md 一期）的前端纯逻辑：DTO 与后端 route_check.rs 对齐，
// 文案在这里拼，设置页体检卡与启动预检共用。网络与判定都在后端，这里不重判。

import type { Profile } from "./types";

export type RouteVerdict = "pass" | "block" | "review";
export type RouteStage = "proxy" | "reach" | "region";
export type RouteProxySource = "connection" | "settings" | "shell" | "none";

export interface RouteCheck {
  agent: string;
  verdict: RouteVerdict;
  stage: RouteStage | null;
  reason: string;
  proxySource: RouteProxySource;
  proxy: string | null;
  probeHost: string;
  exitRegion: string | null;
  exitRegionName: string | null;
  latencyMs: number | null;
  /** unix 秒 */
  checkedAt: number;
}

/** 启动预检复用的结果时效（秒）：5 分钟内测过就不再等网络 */
export const PREFLIGHT_MAX_AGE_SECS = 300;

export const VERDICT_LABEL: Record<RouteVerdict, string> = {
  pass: "通过",
  block: "拦下",
  review: "待你判断",
};

/** 代理从哪来：体检卡顶部那一行 */
export function proxySourceText(check: Pick<RouteCheck, "proxySource" | "proxy">): string {
  switch (check.proxySource) {
    case "connection":
      return check.proxy ? `这条连接的附加环境变量：${check.proxy}` : "这条连接的附加环境变量把代理清空了（直连）";
    case "settings":
      return `设置里的出网代理：${check.proxy ?? ""}`;
    case "shell":
      return `没在 Mesa 里设，用的是登录 shell 带进来的代理：${check.proxy ?? ""}`;
    default:
      return "没有代理，直连";
  }
}

/** 体检卡每家一行：取这家第一条官方账号连接（同一家多条官方连接共用出网代理，附加环境变量不同才有差别） */
export function routeCheckTargets(
  profiles: Pick<Profile, "id" | "agent" | "accountType">[],
  agents: string[],
): { agent: string; profileId: string }[] {
  return agents.flatMap((agent) => {
    const p = profiles.find((x) => x.agent === agent && x.accountType === "official");
    return p ? [{ agent, profileId: p.id }] : [];
  });
}

/** 启动预检被拦下时的确认框正文（confirmDialog 首行为标题） */
export function preflightBlockMessage(check: RouteCheck, agentName: string): string {
  return [
    `${agentName} 的官方账号可能用不了`,
    "",
    check.reason,
    "",
    "取消后可到 设置 → 网络 看线路体检和改代理；确定要试也可以照常启动。",
  ].join("\n");
}

/** 「待你判断」时启动后的一句提示；通过时不打扰（返回 null） */
export function preflightReviewNote(check: RouteCheck, agentName: string): string | null {
  return check.verdict === "review" ? `${agentName} 线路体检：${check.reason}` : null;
}
