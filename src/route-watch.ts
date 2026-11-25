// 线路体检的副作用层（design-outbound-route.md 二期）：修复动作、后台复查。纯逻辑在 route-check.ts。
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type InboxItem } from "./store";
import { AGENTS } from "./types";
import {
  WATCH_INTERVAL_MS,
  WATCH_MAX_AGE_SECS,
  pickRouteFix,
  routeInboxFields,
  runningOfficialTargets,
  type RouteCheck,
  type RouteFix,
} from "./route-check";

const labelOf = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

export function checkRoute(agentId: string, profileId: string | null, maxAgeSecs: number): Promise<RouteCheck> {
  return invoke<RouteCheck>("route_check", { agentId, profileId, maxAgeSecs });
}

/** 被拦在「代理没在运行」时能做的修复（没有就 null）；查不到候选 / 软件当没有 */
export async function findRouteFix(check: RouteCheck): Promise<RouteFix | null> {
  if (check.stage !== "proxy") return null;
  const [candidates, apps] = await Promise.all([
    invoke<{ url: string; source: string; alive: boolean }[]>("detect_outbound_proxy").catch(() => []),
    invoke<{ name: string; path: string }[]>("route_proxy_apps").catch(() => []),
  ]);
  return pickRouteFix(check, candidates, apps);
}

/** 执行修复后重测：换代理/清代理立刻重测一次；打开代理软件要等它起来，最多等约 20 秒 */
export async function applyRouteFix(
  fix: RouteFix,
  agentId: string,
  profileId: string | null,
): Promise<RouteCheck | null> {
  if (fix.kind === "switchProxy") {
    await useAppStore.getState().updateSettings({ outboundProxy: fix.url });
  } else if (fix.kind === "clearProxy") {
    await useAppStore.getState().updateSettings({ outboundProxy: "" });
  } else {
    await invoke("route_open_proxy_app", { path: fix.path });
  }
  const immediate = fix.kind === "switchProxy" || fix.kind === "clearProxy";
  let last: RouteCheck | null = null;
  for (let i = 0; i < 10; i++) {
    last = await checkRoute(agentId, profileId, 0).catch(() => null);
    if (immediate || (last && last.verdict !== "block")) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (last) setRouteAlertFromCheck(last);
  return last;
}

/** 一次体检结果同步到收件箱：拦下 / 换了出口地区出条目，其余撤掉 */
export function setRouteAlertFromCheck(check: RouteCheck) {
  const fields = routeInboxFields(check, labelOf(check.agent));
  const item: InboxItem | null = fields
    ? {
        key: fields.key,
        dot: fields.warn ? "bg-warn-text" : "bg-err-text",
        text: fields.text,
        actionLabel: "去看看",
        action: { type: "settings", section: "network" },
      }
    : null;
  useAppStore.getState().setRouteAlert(check.agent, item);
}

/** 后台复查：只在有官方账号会话运行时，每 5 分钟测一次；会话都停了就撤掉这几家的提醒、不再测；
 *  设置页改了出网代理或 NO_PROXY 时立即复查，及时消除收件箱旧报警 */
export function useRouteWatch() {
  const runs = useAppStore((s) => s.terminalRunInputs);
  const profiles = useAppStore((s) => s.profiles);
  const proxyKey = useAppStore(
    (s) => `${s.settings?.outboundProxy ?? ""}|${s.settings?.outboundNoProxy ?? ""}`,
  );
  const [agents, setAgents] = useState<string[] | null>(null);
  const lastProxyKeyRef = useRef(proxyKey);

  useEffect(() => {
    if (agents !== null) return;
    let cancelled = false;
    invoke<string[]>("route_check_agents")
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => {
        // 首次拉取失败不写死 []，保留 null 以便下一次状态变化重拉
      });
    return () => {
      cancelled = true;
    };
  }, [agents, runs.length, profiles.length]);

  const targets = agents ? runningOfficialTargets(runs, profiles, agents) : [];
  const key = targets.map((t) => `${t.agent}:${t.profileId}`).join(",");

  useEffect(() => {
    if (!agents) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const proxyChanged = lastProxyKeyRef.current !== proxyKey;
    lastProxyKeyRef.current = proxyKey;

    const tick = async (force: boolean) => {
      const s = useAppStore.getState();
      const now = runningOfficialTargets(s.terminalRunInputs, s.profiles, agents);
      for (const agent of Object.keys(s.routeAlerts)) {
        if (!now.some((t) => t.agent === agent)) s.setRouteAlert(agent, null);
      }
      for (const t of now) {
        const check = await checkRoute(t.agent, t.profileId, force ? 0 : WATCH_MAX_AGE_SECS).catch(() => null);
        if (cancelled) return;
        if (check) setRouteAlertFromCheck(check);
      }
      if (now.length && !cancelled) timer = setTimeout(() => void tick(false), WATCH_INTERVAL_MS);
    };
    void tick(proxyChanged);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agents, key, proxyKey]);
}
