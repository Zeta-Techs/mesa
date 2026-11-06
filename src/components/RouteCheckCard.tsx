import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RotateCw, ShieldCheck } from "lucide-react";
import { ghostActionClass, rowActionClass } from "./PageFrame";
import { HoverTip, useHoverTip } from "./HoverTip";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import {
  PREFLIGHT_MAX_AGE_SECS,
  VERDICT_LABEL,
  checkedAgoText,
  exitTypeText,
  latencyText,
  proxySourceText,
  routeCheckTargets,
  routeFixLabel,
  routeRowMain,
  serviceConfirmText,
  type ExitType,
  type RouteCheck,
  type RouteFix,
} from "../route-check";
import { applyRouteFix, findRouteFix, setRouteAlertFromCheck } from "../route-watch";
import { toast } from "../toast";

type Row = RouteCheck | { agent: string; error: string };

// 按钮文字的字号写在内层 span：全站 button { font: inherit } 会吞掉按钮自身的 text-*

/** 状态只给圆点上色（design-system：语义色只给点 / 图标，不铺在文字上） */
const DOT_CLASS = { pass: "bg-ok-text", block: "bg-err-text", review: "bg-warn-text" } as const;
/** 一行到底：点 · 名称 · 地区 · 用时 · 确认与出口类型 · 修复按钮（靠右）；各行用同一组定宽列对齐。
 *  拦下的原因较长，占地区 / 用时 / 确认三列的位置 */
const ROW_GRID = "grid grid-cols-[0.5rem_8rem_9rem_3.5rem_minmax(0,1fr)_auto] items-center gap-x-3";

/** 设置 → 网络「线路体检」：每家配了官方账号的 Agent 一行，经与启动同源的代理访问这家服务自己的地址。
 *  进页面先用 5 分钟内的结果，出网代理改了（proxyKey 变）或点「重测」才真去测。
 *  二期：换了地区给「记为常用出口」；代理没在运行给一个修复按钮（换成检测到的代理 / 打开代理软件）。
 *  三期：「查出口类型」（要把出口 IP 发给 ipinfo.io，所以只在点了才查）。
 *  2026-11-06 用户嫌粗糙重排：四列对齐、状态只看点、用时单列等宽、确认与出口类型收进第二行小字、探测地址进悬停 */
export default function RouteCheckCard({ proxyKey }: { proxyKey: string }) {
  const profiles = useAppStore((s) => s.profiles);
  const [agents, setAgents] = useState<string[] | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [running, setRunning] = useState(false);
  const [fixes, setFixes] = useState<Record<string, RouteFix | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [exitTypes, setExitTypes] = useState<Record<string, ExitType | string>>({});
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const firstRun = useRef(true);

  useEffect(() => {
    invoke<string[]>("route_check_agents").then(setAgents, () => setAgents([]));
    // 「几分钟前测过」随时间走
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
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
        if (!("error" in row)) {
          setRouteAlertFromCheck(row);
          const fix = await findRouteFix(row).catch(() => null);
          setFixes((prev) => ({ ...prev, [t.agent]: fix }));
        }
      }),
    );
    setNow(Math.floor(Date.now() / 1000));
    setRunning(false);
  }

  useEffect(() => {
    if (!targets.length) return;
    void run(firstRun.current ? PREFLIGHT_MAX_AGE_SECS : 0);
    firstRun.current = false;
    // targetsKey 代表 targets；proxyKey 变 = 出网代理刚保存过，要重测
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey, proxyKey]);

  async function doFix(agent: string, profileId: string, fix: RouteFix) {
    setBusy(agent);
    try {
      const r = await applyRouteFix(fix, agent, profileId);
      if (r) {
        setRows((prev) => ({ ...prev, [agent]: r }));
        setFixes((prev) => ({ ...prev, [agent]: null }));
        if (r.verdict === "block") toast(`还是不通：${r.reason}`, "warning");
      }
    } catch (e) {
      toast(`没修成：${String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function lookupExitType(agent: string) {
    setExitTypes((prev) => ({ ...prev, [agent]: "查询中…" }));
    try {
      const t = await invoke<ExitType>("route_exit_type", { agentId: agent });
      setExitTypes((prev) => ({ ...prev, [agent]: t }));
    } catch (e) {
      setExitTypes((prev) => ({ ...prev, [agent]: String(e) }));
    }
  }

  async function acceptRegion(agent: string) {
    setBusy(agent);
    try {
      await invoke("route_accept_region", { agentId: agent });
      await run(0);
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(null);
    }
  }

  if (agents === null) return null;
  if (!targets.length) {
    return (
      <p className="text-xs text-l4">还没有官方账号连接。在连接页添加官方账号后，这里会测它从哪里出去。</p>
    );
  }
  const checks = targets.map((t) => rows[t.agent]).filter((r): r is RouteCheck => !!r && !("error" in r));
  const anyCheck = checks[0];
  const oldest = checks.length ? Math.min(...checks.map((c) => c.checkedAt)) : null;
  const labelOf = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 pb-2">
        <p className="min-w-0 flex-1 truncate text-xs text-l3">
          {anyCheck ? proxySourceText(anyCheck) : "体检中…"}
          {oldest != null && !running && <span className="text-l4"> · {checkedAgoText(oldest, now)}</span>}
        </p>
        <button
          type="button"
          onClick={() => void run(0)}
          disabled={running}
          className={`${ghostActionClass} shrink-0 gap-1.5`}
        >
          <RotateCw className={`size-3.5 ${running ? "animate-spin" : ""}`} aria-hidden="true" />
          <span className="text-xs">{running ? "体检中" : "重测"}</span>
        </button>
      </div>
      <ul className="divide-y divide-hairline border-t border-hairline">
        {targets.map((t) => (
          <RouteRow
            key={t.agent}
            name={labelOf(t.agent)}
            row={rows[t.agent]}
            fix={fixes[t.agent] ?? null}
            busy={busy === t.agent}
            exitType={exitTypes[t.agent]}
            onFix={(f) => void doFix(t.agent, t.profileId, f)}
            onAccept={() => void acceptRegion(t.agent)}
            onLookup={() => void lookupExitType(t.agent)}
          />
        ))}
      </ul>
    </div>
  );
}

function RouteRow({
  name,
  row,
  fix,
  busy,
  exitType,
  onFix,
  onAccept,
  onLookup,
}: {
  name: string;
  row: Row | undefined;
  fix: RouteFix | null;
  busy: boolean;
  exitType: ExitType | string | undefined;
  onFix: (fix: RouteFix) => void;
  onAccept: () => void;
  onLookup: () => void;
}) {
  const nameRef = useRef<HTMLSpanElement>(null);
  const tip = useHoverTip(nameRef);
  const check = row && !("error" in row) ? row : null;
  const tipText = check
    ? `${VERDICT_LABEL[check.verdict]} · 探测 ${check.probeHost}`
    : row && "error" in row
      ? "没测成"
      : "体检中";

  const nameCell = (
    <span
      ref={nameRef}
      onMouseEnter={tip.show}
      onMouseLeave={tip.hide}
      className="truncate text-sm text-l2"
    >
      {name}
    </span>
  );

  if (!check) {
    return (
      <li className={`${ROW_GRID} min-h-10 py-2`}>
        <span className="size-2 rounded-full bg-l4" />
        {nameCell}
        <span className="col-span-3 truncate text-sm text-l4">
          {row && "error" in row ? `没测成：${row.error}` : "体检中…"}
        </span>
        <span />
        <HoverTip tip={tip.tip} text={tipText} />
      </li>
    );
  }

  const confirm = serviceConfirmText(check);
  const typed = typeof exitType === "object" ? exitType : null;
  const meta =
    confirm || check.exitRegion || exitType !== undefined ? (
      <span className="flex min-w-0 items-center gap-1.5 text-micro text-l4">
        {confirm && (
          <span className="inline-flex shrink-0 items-center gap-1 text-l3">
            <ShieldCheck className="size-3 text-ok-text" aria-hidden="true" />
            {confirm}
          </span>
        )}
        {confirm && check.exitRegion && <span aria-hidden="true">·</span>}
        {check.exitRegion &&
          (exitType === undefined ? (
            <button
              type="button"
              onClick={onLookup}
              className="shrink-0 underline-offset-2 hover:text-l2 hover:underline"
            >
              <span className="text-micro">查出口类型</span>
            </button>
          ) : (
            <span
              className={`min-w-0 truncate ${typed?.kind === "datacenter" ? "text-warn-text" : ""}`}
            >
              {typed ? exitTypeText(typed) : (exitType as string)}
            </span>
          ))}
      </span>
    ) : null;
  const actions =
    check.regionChanged || fix ? (
      <span className="flex justify-end gap-2">
        {check.regionChanged && (
          <button type="button" disabled={busy} onClick={onAccept} className={rowActionClass}>
            <span className="text-xs">记为常用出口</span>
          </button>
        )}
        {fix && (
          <button type="button" disabled={busy} onClick={() => onFix(fix)} className={rowActionClass}>
            <span className="text-xs">{busy ? "处理中…" : routeFixLabel(fix)}</span>
          </button>
        )}
      </span>
    ) : (
      <span />
    );
  const blocked = check.verdict === "block";

  return (
    <li className={`${ROW_GRID} min-h-10 py-2`}>
      <span className={`size-2 rounded-full ${DOT_CLASS[check.verdict]}`} />
      {nameCell}
      {blocked ? (
        <span className="col-span-3 truncate text-sm text-l1">{routeRowMain(check)}</span>
      ) : (
        <>
          <span className="truncate text-sm text-l1">{routeRowMain(check)}</span>
          <span className="text-right text-xs tabular-nums text-l4">{latencyText(check.latencyMs)}</span>
          {meta ?? <span />}
        </>
      )}
      {actions}
      <HoverTip tip={tip.tip} text={tipText} />
    </li>
  );
}
