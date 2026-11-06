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
  /** 出口记忆：最近 7 天常用的出口地区 */
  usualRegion: string | null;
  usualRegionName: string | null;
  /** 这次和常用地区不一样（给「记为常用出口」） */
  regionChanged: boolean;
  /** unix 秒 */
  checkedAt: number;
}

/** 后台复查的间隔（毫秒）：只在有官方账号会话运行时跑 */
export const WATCH_INTERVAL_MS = 5 * 60 * 1000;
/** 后台复查复用结果的时效（秒）：略短于间隔，保证每轮真测一次 */
export const WATCH_MAX_AGE_SECS = 240;

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

/** 正在运行的官方账号会话 → 要后台复查的（每家一条，取第一个会话用的连接） */
export function runningOfficialTargets(
  runs: readonly { running: boolean; agentId: string; profileId?: string | null }[],
  profiles: Pick<Profile, "id" | "agent" | "accountType">[],
  agents: readonly string[],
): { agent: string; profileId: string }[] {
  const out: { agent: string; profileId: string }[] = [];
  for (const r of runs) {
    if (!r.running || !r.profileId || !agents.includes(r.agentId)) continue;
    if (out.some((t) => t.agent === r.agentId)) continue;
    const p = profiles.find((x) => x.id === r.profileId);
    if (p?.accountType === "official") out.push({ agent: r.agentId, profileId: p.id });
  }
  return out;
}

/** 收件箱「线路」条目：拦下 / 换了出口地区才出；文案不带延迟，同一状态反复复查也不会冒成新条目（忽略按文案签名） */
export function routeInboxFields(
  check: RouteCheck,
  agentName: string,
): { key: string; text: string; warn: boolean } | null {
  const key = `net:${check.agent}`;
  if (check.verdict === "block") return { key, text: `${agentName} 的线路不通：${check.reason}`, warn: false };
  if (check.verdict === "review" && check.regionChanged) {
    return { key, text: `${agentName} 换了出口地区：${check.reason}`, warn: true };
  }
  return null;
}

/** 修复动作：换成检测到的代理（设置里的不在运行、本机另有在跑的），或打开已装的代理软件 */
export type RouteFix =
  | { kind: "switchProxy"; url: string; source: string }
  | { kind: "openApp"; name: string; path: string };

/** 只在「代理没在运行」时给修复；连接附加环境变量 / shell 带进来的代理 Mesa 不替你改，只给打开软件 */
export function pickRouteFix(
  check: Pick<RouteCheck, "stage" | "proxySource" | "proxy">,
  candidates: readonly { url: string; source: string; alive: boolean }[],
  apps: readonly { name: string; path: string }[],
): RouteFix | null {
  if (check.stage !== "proxy") return null;
  if (check.proxySource === "settings") {
    const live = candidates.find((c) => c.alive && c.url !== check.proxy);
    if (live) return { kind: "switchProxy", url: live.url, source: live.source };
  }
  return apps[0] ? { kind: "openApp", name: apps[0].name, path: apps[0].path } : null;
}

export function routeFixLabel(fix: RouteFix): string {
  return fix.kind === "switchProxy" ? `换成 ${fix.url}` : `打开 ${fix.name}`;
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

/** 拦下且有修复办法时先问的那一句：确定 = 修好再启动；取消再落到「仍要启动？」 */
export function preflightFixMessage(check: RouteCheck, agentName: string, fix: RouteFix): string {
  const how =
    fix.kind === "switchProxy"
      ? `检测到本机 ${fix.url}（${fix.source}）在运行，可以把出网代理换成它。`
      : `本机装了 ${fix.name}，可以先打开它，等代理起来再启动（最多等约 20 秒）。`;
  return [`${agentName} 的官方账号可能用不了`, "", check.reason, "", how].join("\n");
}

/** 「待你判断」时启动后的一句提示；通过时不打扰（返回 null） */
export function preflightReviewNote(check: RouteCheck, agentName: string): string | null {
  return check.verdict === "review" ? `${agentName} 线路体检：${check.reason}` : null;
}
