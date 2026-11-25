import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RotateCw, ShieldCheck } from "lucide-react";
import { paneOutlineButtonClass } from "./PageFrame";
import { HoverTip, useHoverTip } from "./HoverTip";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import {
  PREFLIGHT_MAX_AGE_SECS,
  VERDICT_LABEL,
  checkedAgoText,
  exitTypeText,
  latencyText,
  nativeText,
  proxyHeaderSummary,
  proxySourceText,
  routeCheckTargets,
  routeFixLabel,
  routeProxyKey,
  routeRowMain,
  routeTargetKey,
  serviceConfirmText,
  serviceConfirmTip,
  type ExitType,
  type RouteCheck,
  type RouteFix,
  type RouteTarget,
} from "../route-check";
import { applyRouteFix, findRouteFix, setRouteAlertFromCheck } from "../route-watch";
import { toast } from "../toast";

type Row = RouteCheck | { agent: string; error: string };

// 全站 button { font: inherit } 会吞掉按钮自身的 text-*：细边按钮跟设置页其他按钮一样随外层字号；
// 行内小字动作（查出口类型）的字号写在内层 span

/** 状态只给圆点上色（design-system：语义色只给点 / 图标，不铺在文字上） */
const DOT_CLASS = { pass: "bg-ok-text", block: "bg-err-text", review: "bg-warn-text" } as const;
/** 一行到底：点 · 名称 · 地区 · 用时 · 确认与出口类型 · 修复按钮（靠右）；各行用同一组定宽列对齐。
 *  拦下的原因较长，占地区 / 用时 / 确认三列的位置 */
const ROW_GRID = "grid grid-cols-[0.5rem_8rem_9rem_3.5rem_minmax(0,1fr)_auto] items-center gap-x-3";

/** 设置 → 网络「线路体检」：每家配了官方账号的 Agent 一行（同家多号配不同代理时分别测），
 *  经与启动同源的代理访问这家服务自己的地址。
 *  进页面先用 5 分钟内的结果，出网代理/NO_PROXY 改了（proxyKey 变）或点「重测」才真去测。
 *  二期：换了地区给「记为常用出口」；代理没在运行给修复按钮（换成在跑代理 / 打开软件 / 改走直连）。
 *  三期：「查出口类型」（要把出口 IP 发给 ipinfo.io，所以只在点了才查）。 */
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
  const runSeqRef = useRef(0);

  useEffect(() => {
    invoke<string[]>("route_check_agents").then(setAgents, () => setAgents([]));
    // 「几分钟前测过」随时间走
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, []);

  const targets = useMemo(() => (agents ? routeCheckTargets(profiles, agents) : []), [profiles, agents]);
  const targetsKey = targets.map((t) => `${routeTargetKey(t)}:${t.profileName ?? ""}`).join(",");

  async function probeTarget(t: RouteTarget, maxAgeSecs: number): Promise<{ row: Row; fix: RouteFix | null }> {
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
    let fix: RouteFix | null = null;
    if (!("error" in row)) {
      setRouteAlertFromCheck(row);
      fix = await findRouteFix(row).catch(() => null);
    }
    return { row, fix };
  }

  async function run(maxAgeSecs: number, subset?: readonly RouteTarget[]) {
    const seq = ++runSeqRef.current;
    const list = subset ?? targets;
    setRunning(true);
    if (maxAgeSecs === 0) {
      if (subset) {
        const drop = new Set(subset.map(routeTargetKey));
        setExitTypes((prev) => {
          const next = { ...prev };
          for (const k of drop) delete next[k];
          return next;
        });
      } else {
        setExitTypes({});
      }
    }
    await Promise.all(
      list.map(async (t) => {
        const key = routeTargetKey(t);
        const { row, fix } = await probeTarget(t, maxAgeSecs);
        if (runSeqRef.current !== seq) return;
        setRows((prev) => ({ ...prev, [key]: row }));
        if (!("error" in row)) {
          setFixes((prev) => ({ ...prev, [key]: fix }));
        }
      }),
    );
    if (runSeqRef.current !== seq) return;
    setNow(Math.floor(Date.now() / 1000));
    setRunning(false);
  }

  useEffect(() => {
    if (!targets.length) return;
    void run(firstRun.current ? PREFLIGHT_MAX_AGE_SECS : 0);
    firstRun.current = false;
    // targetsKey 代表 targets；proxyKey 变 = 出网代理或 NO_PROXY 刚保存过，要重测
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey, proxyKey]);

  async function doFix(t: RouteTarget, fix: RouteFix) {
    const key = routeTargetKey(t);
    setBusy(key);
    try {
      // 改 settings 的修复直接保存设置，由 proxyKey 变化统一触发全卡重测，避免并发双测
      if (fix.kind === "switchProxy") {
        await useAppStore.getState().updateSettings({ outboundProxy: fix.url });
        return;
      }
      if (fix.kind === "clearProxy") {
        await useAppStore.getState().updateSettings({ outboundProxy: "" });
        return;
      }
      const r = await applyRouteFix(fix, t.agent, t.profileId);
      if (r) {
        setRows((prev) => ({ ...prev, [key]: r }));
        setFixes((prev) => ({ ...prev, [key]: null }));
        if (r.verdict === "block") {
          toast(`还是不通：${r.reason}`, "warning");
        } else {
          // 代理软件拉起成功后，顺带把同卡内其他被拦住的行重测一遍，避免其余行仍停在红点
          const blockedOthers = targets.filter((other) => {
            const ok = routeTargetKey(other);
            if (ok === key) return false;
            const prevRow = rows[ok];
            return prevRow && !("error" in prevRow) && prevRow.verdict === "block";
          });
          if (blockedOthers.length) {
            void run(0, blockedOthers);
          }
        }
      }
    } catch (e) {
      toast(`没修成：${String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function lookupExitType(t: RouteTarget) {
    const key = routeTargetKey(t);
    setExitTypes((prev) => ({ ...prev, [key]: "查询中…" }));
    try {
      const res = await invoke<ExitType>("route_exit_type", {
        agentId: t.agent,
        profileId: t.profileId,
      });
      setExitTypes((prev) => ({ ...prev, [key]: res }));
    } catch (e) {
      setExitTypes((prev) => ({ ...prev, [key]: String(e) }));
    }
  }

  async function acceptRegion(t: RouteTarget) {
    const key = routeTargetKey(t);
    setBusy(key);
    try {
      await invoke("route_accept_region", { agentId: t.agent });
      const sameAgent = targets.filter((x) => x.agent === t.agent);
      await run(0, sameAgent);
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(null);
    }
  }

  if (agents === null) return null;
  if (!targets.length) {
    return (
      <p className="py-2 text-sm text-l3">还没有官方账号连接。在连接页添加官方账号后，这里会测它从哪里出去</p>
    );
  }
  const checks = targets
    .map((t) => rows[routeTargetKey(t)])
    .filter((r): r is RouteCheck => !!r && !("error" in r));
  const header = proxyHeaderSummary(checks);
  const oldest = checks.length ? Math.min(...checks.map((c) => c.checkedAt)) : null;
  const labelOf = (t: RouteTarget) => {
    const base = AGENTS.find((a) => a.id === t.agent)?.label ?? t.agent;
    return t.profileName ? `${base} · ${t.profileName}` : base;
  };

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 pb-2">
        <p className="min-w-0 flex-1 truncate text-xs text-l3">
          {header.text}
          {oldest != null && !running && <span className="text-l4"> · {checkedAgoText(oldest, now)}</span>}
        </p>
        <button
          type="button"
          onClick={() => void run(0)}
          disabled={running}
          className={`${paneOutlineButtonClass} gap-1.5`}
        >
          <RotateCw className={`size-3.5 ${running ? "animate-spin" : ""}`} aria-hidden="true" />
          {running ? "体检中" : "重测"}
        </button>
      </div>
      <ul className="divide-y divide-hairline border-t border-hairline">
        {targets.map((t) => {
          const key = routeTargetKey(t);
          const row = rows[key];
          const rowProxyNote =
            row && !("error" in row) && (header.baseKey === null || routeProxyKey(row) !== header.baseKey)
              ? proxySourceText(row)
              : null;
          return (
            <RouteRow
              key={key}
              name={labelOf(t)}
              row={row}
              rowProxyNote={rowProxyNote}
              fix={fixes[key] ?? null}
              busy={busy === key}
              exitType={exitTypes[key]}
              onFix={(f) => void doFix(t, f)}
              onAccept={() => void acceptRegion(t)}
              onLookup={() => void lookupExitType(t)}
            />
          );
        })}
      </ul>
    </div>
  );
}

function RouteRow({
  name,
  row,
  rowProxyNote,
  fix,
  busy,
  exitType,
  onFix,
  onAccept,
  onLookup,
}: {
  name: string;
  row: Row | undefined;
  rowProxyNote: string | null;
  fix: RouteFix | null;
  busy: boolean;
  exitType: ExitType | string | undefined;
  onFix: (fix: RouteFix) => void;
  onAccept: () => void;
  onLookup: () => void;
}) {
  const nameRef = useRef<HTMLSpanElement>(null);
  const tip = useHoverTip(nameRef);
  const confirmRef = useRef<HTMLSpanElement>(null);
  const confirmTip = useHoverTip(confirmRef);
  const check = row && !("error" in row) ? row : null;
  const tipText = check
    ? `${VERDICT_LABEL[check.verdict]} · 探测 ${check.probeHost}${rowProxyNote ? ` · ${rowProxyNote}` : ""}`
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
      <li className={`${ROW_GRID} min-h-12 py-2`}>
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
  const native = typed ? nativeText(typed) : null;
  const hasExitMeta = Boolean(check.exitRegion || exitType !== undefined);
  const meta =
    rowProxyNote || confirm || hasExitMeta ? (
      <span className="flex min-w-0 items-center gap-1.5 text-micro text-l4">
        {rowProxyNote && <span className="truncate text-l3">{rowProxyNote}</span>}
        {rowProxyNote && (confirm || hasExitMeta) && <span aria-hidden="true">·</span>}
        {confirm && (
          <span
            ref={confirmRef}
            onMouseEnter={confirmTip.show}
            onMouseLeave={confirmTip.hide}
            className="inline-flex shrink-0 cursor-help items-center gap-1 text-l3"
          >
            <ShieldCheck className="size-3 text-ok-text" aria-hidden="true" />
            {confirm}
            <HoverTip tip={confirmTip.tip} text={serviceConfirmTip(check)} />
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
            <>
              <span
                className={`min-w-0 truncate ${typed?.kind === "datacenter" ? "text-warn-text" : ""}`}
              >
                {typed ? exitTypeText(typed) : (exitType as string)}
              </span>
              {native && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className={`shrink-0 ${typed?.native === false ? "text-warn-text" : ""}`}>{native}</span>
                </>
              )}
            </>
          ))}
      </span>
    ) : null;
  // 设置里的代理端口未运行但装了代理软件：多半是软件没开或改用了纯 TUN 透明代理，补一个「改走直连」次按钮
  const showDirectFallback =
    check.stage === "proxy" && check.proxySource === "settings" && fix?.kind === "openApp";
  const actions =
    check.regionChanged || fix || showDirectFallback ? (
      <span className="flex justify-end gap-2">
        {check.regionChanged && (
          <button type="button" disabled={busy} onClick={onAccept} className={paneOutlineButtonClass}>
            记为常用出口
          </button>
        )}
        {fix && (
          <button type="button" disabled={busy} onClick={() => onFix(fix)} className={paneOutlineButtonClass}>
            {busy ? "处理中…" : routeFixLabel(fix)}
          </button>
        )}
        {showDirectFallback && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onFix({ kind: "clearProxy" })}
            title="已改用 TUN 透明代理或不再需要代理时，清空出网代理改走直连"
            className={paneOutlineButtonClass}
          >
            改走直连
          </button>
        )}
      </span>
    ) : (
      <span />
    );
  const blocked = check.verdict === "block";

  return (
    <li className={`${ROW_GRID} min-h-12 py-2`}>
      <span className={`size-2 rounded-full ${DOT_CLASS[check.verdict]}`} />
      {nameCell}
      {blocked ? (
        <span className="col-span-3 truncate text-sm text-l1">
          {routeRowMain(check)}
          {rowProxyNote && <span className="ml-2 text-micro text-l4">· {rowProxyNote}</span>}
        </span>
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
