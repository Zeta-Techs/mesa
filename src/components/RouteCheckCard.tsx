import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { secondaryActionClass } from "./PageFrame";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import {
  PREFLIGHT_MAX_AGE_SECS,
  VERDICT_LABEL,
  proxySourceText,
  routeCheckTargets,
  type RouteCheck,
} from "../route-check";

type Row = RouteCheck | { agent: string; error: string };

const VERDICT_CLASS = { pass: "text-ok-text", block: "text-err-text", review: "text-warn-text" } as const;

/** 设置 → 网络「线路体检」：每家配了官方账号的 Agent 一行，经与启动同源的代理访问这家服务自己的地址。
 *  进页面先用 5 分钟内的结果，出网代理改了（proxyKey 变）或点「重测」才真去测 */
export default function RouteCheckCard({ proxyKey }: { proxyKey: string }) {
  const profiles = useAppStore((s) => s.profiles);
  const [agents, setAgents] = useState<string[] | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [running, setRunning] = useState(false);
  const firstRun = useRef(true);

  useEffect(() => {
    invoke<string[]>("route_check_agents").then(setAgents, () => setAgents([]));
  }, []);

  const targets = useMemo(() => (agents ? routeCheckTargets(profiles, agents) : []), [profiles, agents]);
  const targetsKey = targets.map((t) => `${t.agent}:${t.profileId}`).join(",");

  async function run(maxAgeSecs: number) {
    setRunning(true);
    await Promise.all(
      targets.map(async (t) => {
        let row: Row;
        try {
          row = await invoke<RouteCheck>("route_check", {
            agentId: t.agent,
            profileId: t.profileId,
            maxAgeSecs,
          });
        } catch (e) {
          row = { agent: t.agent, error: String(e) };
        }
        setRows((prev) => ({ ...prev, [t.agent]: row }));
      }),
    );
    setRunning(false);
  }

  useEffect(() => {
    if (!targets.length) return;
    void run(firstRun.current ? PREFLIGHT_MAX_AGE_SECS : 0);
    firstRun.current = false;
    // targetsKey 代表 targets；proxyKey 变 = 出网代理刚保存过，要重测
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey, proxyKey]);

  if (agents === null) return null;
  if (!targets.length) {
    return (
      <p className="max-w-[34rem] text-micro text-l4">
        还没有官方账号连接。在连接页添加 Claude Code 或 Codex 的官方账号后，这里会测它实际从哪里出去。
      </p>
    );
  }
  const anyCheck = targets.map((t) => rows[t.agent]).find((r): r is RouteCheck => !!r && !("error" in r));
  const labelOf = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

  return (
    <div className="flex w-full max-w-[34rem] flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-micro text-l3" title={anyCheck ? proxySourceText(anyCheck) : undefined}>
          {anyCheck ? proxySourceText(anyCheck) : running ? "体检中…" : ""}
        </p>
        <button
          type="button"
          onClick={() => void run(0)}
          disabled={running}
          className={`${secondaryActionClass} shrink-0`}
        >
          {running ? "体检中…" : "重测"}
        </button>
      </div>
      <ul className="space-y-1">
        {targets.map((t) => {
          const r = rows[t.agent];
          const name = labelOf(t.agent);
          if (!r) {
            return (
              <li key={t.agent} className="flex items-center gap-2 text-micro text-l4">
                <span className="w-24 shrink-0 text-l2">{name}</span>
                <span>体检中…</span>
              </li>
            );
          }
          if ("error" in r) {
            return (
              <li key={t.agent} className="flex items-center gap-2 text-micro">
                <span className="w-24 shrink-0 text-l2">{name}</span>
                <span className="text-l4">没测成：{r.error}</span>
              </li>
            );
          }
          return (
            <li key={t.agent} className="flex items-start gap-2 text-micro">
              <span className="w-24 shrink-0 text-l2">{name}</span>
              <span className={`w-16 shrink-0 ${VERDICT_CLASS[r.verdict]}`}>● {VERDICT_LABEL[r.verdict]}</span>
              <span className={`min-w-0 flex-1 ${r.verdict === "pass" ? "text-l3" : "text-l2"}`}>{r.reason}</span>
              <span className="shrink-0 text-l4" title="探测的是这家服务自己的地址：代理按域名分流时，出口以它为准">
                {r.probeHost}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
