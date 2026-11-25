import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Globe, Loader2, RotateCw, ShieldCheck } from "lucide-react";
import AgentIcon from "./AgentIcon";
import { paneOutlineButtonClass } from "./PageFrame";
import { HoverTip, useHoverTip } from "./HoverTip";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import {
  PREFLIGHT_MAX_AGE_SECS,
  VERDICT_LABEL,
  checkedAgoText,
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
  shortOrg,
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

/** 状态只给圆点上色（design-system：语义色只给点 / 图标 / 克制徽标，不把整段正文涂彩） */
const DOT_CLASS = { pass: "bg-ok-text", block: "bg-err-text", review: "bg-warn-text" } as const;
const ROW_CLASS =
  "flex min-h-10 items-center gap-3 rounded-md px-2.5 py-1.5 transition-colors hover:bg-hover";

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
  const blockCount = checks.filter((c) => c.verdict === "block").length;
  const reviewCount = checks.filter((c) => c.verdict === "review").length;
  const baseLabelOf = (agentId: string) => AGENTS.find((a) => a.id === agentId)?.label ?? agentId;

  return (
    <div className="w-full pt-1">
      <div className="flex items-center justify-between gap-3 pb-2.5">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Globe className="size-3.5 shrink-0 text-l4" aria-hidden="true" />
          <span className="truncate text-l2">{header.text}</span>
          {!running && checks.length > 0 && blockCount > 0 && (
            <span className="shrink-0 text-err-text">· {blockCount} 项不通</span>
          )}
          {!running && checks.length > 0 && blockCount === 0 && reviewCount > 0 && (
            <span className="shrink-0 text-warn-text">· {reviewCount} 项待判断</span>
          )}
          {oldest != null && !running && (
            <span className="shrink-0 text-l4">· {checkedAgoText(oldest, now)}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void run(0)}
          disabled={running}
          className={`${paneOutlineButtonClass} shrink-0 gap-1.5`}
        >
          <RotateCw className={`size-3.5 ${running ? "animate-spin" : ""}`} aria-hidden="true" />
          {running ? "体检中" : "重测"}
        </button>
      </div>
      <ul className="space-y-0.5 rounded-lg bg-canvas/55 p-1">
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
              agentId={t.agent}
              baseName={baseLabelOf(t.agent)}
              profileName={t.profileName}
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
  agentId,
  baseName,
  profileName,
  row,
  rowProxyNote,
  fix,
  busy,
  exitType,
  onFix,
  onAccept,
  onLookup,
}: {
  agentId: string;
  baseName: string;
  profileName?: string;
  row: Row | undefined;
  rowProxyNote: string | null;
  fix: RouteFix | null;
  busy: boolean;
  exitType: ExitType | string | undefined;
  onFix: (fix: RouteFix) => void;
  onAccept: () => void;
  onLookup: () => void;
}) {
  const nameRef = useRef<HTMLDivElement>(null);
  const tip = useHoverTip(nameRef);
  const confirmRef = useRef<HTMLSpanElement>(null);
  const confirmTip = useHoverTip(confirmRef);
  const check = row && !("error" in row) ? row : null;
  const tipText = check
    ? `${VERDICT_LABEL[check.verdict]} · 探测 ${check.probeHost}${rowProxyNote ? ` · ${rowProxyNote}` : ""}`
    : row && "error" in row
      ? "没测成"
      : "体检中";

  const identityCell = (
    <div
      ref={nameRef}
      onMouseEnter={tip.show}
      onMouseLeave={tip.hide}
      className="flex w-[9.5rem] shrink-0 items-center gap-2 min-w-0"
    >
      <AgentIcon agent={agentId} label={baseName} size={15} />
      <span className="min-w-0 truncate text-sm font-medium text-l1">
        {baseName}
        {profileName && <span className="font-normal text-l3"> · {profileName}</span>}
      </span>
    </div>
  );

  if (!check) {
    const isErr = Boolean(row && "error" in row);
    return (
      <li className={ROW_CLASS}>
        {identityCell}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={`size-1.5 shrink-0 rounded-full ${isErr ? "bg-err-text" : "animate-pulse bg-l4"}`}
          />
          <span className={`min-w-0 truncate text-xs ${isErr ? "text-l2" : "text-l4"}`}>
            {row && "error" in row ? `没测成：${row.error}` : "体检中…"}
          </span>
        </div>
        <HoverTip tip={tip.tip} text={tipText} />
      </li>
    );
  }

  const confirm = serviceConfirmText(check);
  const typed = typeof exitType === "object" ? exitType : null;
  const orgName = typed ? shortOrg(typed.org) : "";
  const native = typed ? nativeText(typed) : null;
  const hasExitMeta = Boolean(check.exitRegion || exitType !== undefined);
  const meta =
    rowProxyNote || confirm || hasExitMeta ? (
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {rowProxyNote && (
          <span
            className="max-w-44 shrink-0 truncate rounded-md bg-inset px-1.5 py-0.5 font-mono text-micro text-l3"
            title={rowProxyNote}
          >
            {rowProxyNote}
          </span>
        )}
        {confirm && (
          <span
            ref={confirmRef}
            onMouseEnter={confirmTip.show}
            onMouseLeave={confirmTip.hide}
            className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-md border border-hairline bg-raised/70 px-1.5 py-0.5 text-micro text-l2"
          >
            <ShieldCheck className="size-3 shrink-0 text-ok-text" aria-hidden="true" />
            {confirm}
            <HoverTip tip={confirmTip.tip} text={serviceConfirmTip(check)} />
          </span>
        )}
        {check.exitRegion &&
          (exitType === undefined ? (
            <button
              type="button"
              onClick={onLookup}
              title="向 ipinfo.io 查询出口 IP 是住宅还是机房、是否原生 IP"
              className="inline-flex shrink-0 items-center rounded-md border border-hairline bg-raised/50 px-1.5 py-0.5 text-l3 transition-colors hover:border-field hover:bg-hover hover:text-l1"
            >
              <span className="text-micro">查出口类型</span>
            </button>
          ) : typeof exitType === "string" ? (
            exitType === "查询中…" ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-micro text-l4">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                查询中…
              </span>
            ) : (
              <span className="min-w-0 truncate text-micro text-l4" title={exitType}>
                {exitType}
              </span>
            )
          ) : typed ? (
            <>
              <span
                className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-micro font-medium ${
                  typed.kind === "datacenter"
                    ? "border-warn-text/20 bg-warn text-warn-text"
                    : "border-hairline bg-raised/70 text-l2"
                }`}
              >
                {typed.label}
              </span>
              {orgName && (
                <span className="min-w-0 truncate text-micro text-l3" title={typed.org}>
                  {orgName}
                </span>
              )}
              {native && (
                <span
                  className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-micro ${
                    typed.native === false
                      ? "border-warn-text/20 bg-warn text-warn-text"
                      : "border-hairline bg-inset/80 text-l3"
                  }`}
                >
                  {native}
                </span>
              )}
            </>
          ) : null)}
      </div>
    ) : null;

  // 设置里的代理端口未运行但装了代理软件：多半是软件没开或改用了纯 TUN 透明代理，补一个「改走直连」次按钮
  const showDirectFallback =
    check.stage === "proxy" && check.proxySource === "settings" && fix?.kind === "openApp";
  const hasActions = Boolean(check.regionChanged || fix || showDirectFallback);
  const actions = hasActions ? (
    <span className="flex shrink-0 items-center gap-1.5">
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
  ) : null;

  const blocked = check.verdict === "block";
  const mainText = routeRowMain(check);
  const latency = latencyText(check.latencyMs);
  const compactStatus = check.verdict === "pass";

  return (
    <li className={ROW_CLASS}>
      {identityCell}
      {blocked ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[check.verdict]}`} />
          <span className="min-w-0 truncate text-sm text-l1" title={mainText}>
            {mainText}
          </span>
          {rowProxyNote && (
            <span
              className="max-w-44 shrink-0 truncate rounded-md bg-inset px-1.5 py-0.5 font-mono text-micro text-l3"
              title={rowProxyNote}
            >
              {rowProxyNote}
            </span>
          )}
        </div>
      ) : compactStatus ? (
        <>
          <div className="flex w-[5.5rem] shrink-0 items-center gap-1.5 min-w-0">
            <span className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[check.verdict]}`} />
            <span
              className={`truncate text-sm ${check.exitRegionName ? "font-medium text-l1" : "text-l2"}`}
              title={mainText}
            >
              {mainText}
            </span>
          </div>
          {meta ?? <div className="min-w-0 flex-1" />}
        </>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[check.verdict]}`} />
          <span className="min-w-0 truncate text-sm text-l1" title={mainText}>
            {mainText}
          </span>
          {meta}
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2.5">
        {actions}
        {!blocked && latency && (
          <span
            className={`w-12 shrink-0 text-right font-mono text-micro tabular-nums ${
              (check.latencyMs ?? 0) >= 2500 ? "text-l3" : "text-l4"
            }`}
          >
            {latency}
          </span>
        )}
      </div>
      <HoverTip tip={tip.tip} text={tipText} />
    </li>
  );
}
