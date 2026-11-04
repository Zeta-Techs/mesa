import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { AGENTS, type Gateway } from "../types";
import { PROVIDER_PRESETS } from "../presets";
import { SLOT_LABEL } from "../connection-form";
import {
  duplicateConnection,
  planAutoConfig,
  rowModels,
  rowRoleModels,
  VENDOR_LABEL,
  type AutoConfigRow,
  type PriceTable,
} from "../gateway-autoconfig";
import { Checkbox, FoldMark, InlineNotice, MenuSelect, primaryActionClass } from "./PageFrame";

const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

/**
 * 网关库「一键配置各 CLI」（2026-11-04 用户拍板）：给每个已安装的 CLI 在这个网关上各建一条连接，
 * 模型取目录里各家最新的；先出预览，人点了才建。只建 Mesa 连接，不写 CLI 配置文件。
 * 规则见 gateway-autoconfig.ts。
 */
export default function GatewayAutoConfig({
  gateway,
  dirty,
  open,
  onOpenChange,
}: {
  gateway: Gateway;
  dirty: boolean;
  /** 展开与否由网关库管：列表行的「一键配置」入口打开编辑页时直接展开 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const agents = useAppStore((s) => s.agents);
  const profiles = useAppStore((s) => s.profiles);
  const settings = useAppStore((s) => s.settings);
  const bindGateway = useAppStore((s) => s.bindGateway);
  const updateSettings = useAppStore((s) => s.updateSettings);
  // 人改过的默认模型 / 取消勾选的 CLI；键 = agent
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [setDefault, setSetDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const installed = useMemo(
    () => AGENTS.map((a) => a.id as string).filter((id) => agents.some((d) => d.id === id && d.binaryPath)),
    [agents],
  );
  // 单价用来认名字里看不出的轻量档（gpt-6-luna）；没拿到前先只按名字认
  const [prices, setPrices] = useState<PriceTable>({});
  useEffect(() => {
    if (!open || gateway.models.length === 0) return;
    let live = true;
    invoke<PriceTable>("model_input_prices", { models: gateway.models.map((m) => m.id) })
      .then((p) => live && setPrices(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, gateway.models]);
  const rows = useMemo(
    // 配不了的沉到最后
    () =>
      planAutoConfig({ gateway, installed, profiles, presets: PROVIDER_PRESETS, prices }).sort(
        (a, b) => Number(Boolean(a.skip)) - Number(Boolean(b.skip)),
      ),
    [gateway, installed, profiles, prices],
  );

  const pickOf = (r: AutoConfigRow) => chosen[r.agent] ?? r.defaultModel;
  const dupOf = (r: AutoConfigRow) => {
    const m = pickOf(r);
    return m ? duplicateConnection(r, m, gateway.id, profiles) : null;
  };
  const usable = rows.filter((r) => !r.skip);
  const selected = usable.filter((r) => !excluded.has(r.agent) && !dupOf(r));
  const missingPick = selected.filter((r) => !pickOf(r));
  const blocker = dirty
    ? "先保存上面的修改"
    : gateway.models.length === 0
      ? "先获取模型"
      : missingPick.length
        ? `先给 ${missingPick.map((r) => agentLabel(r.agent)).join("、")} 选默认模型`
        : selected.length === 0
          ? "没有可建的连接"
          : null;

  async function run() {
    if (blocker) return;
    setBusy(true);
    setResult(null);
    const made: { agent: string; id: string }[] = [];
    const failed: string[] = [];
    for (const r of selected) {
      const m = pickOf(r)!;
      try {
        const p = await bindGateway({
          agent: r.agent,
          name: gateway.name,
          gatewayId: gateway.id,
          kind: "api",
          protocol: r.protocol,
          models: rowModels(r, m),
          roleModels: rowRoleModels(r, m),
          extraEnv: {},
        });
        made.push({ agent: r.agent, id: p.id });
      } catch (e) {
        failed.push(`${agentLabel(r.agent)}：${String(e)}`);
      }
    }
    if (setDefault && made.length) {
      const cur = { ...(settings?.defaultProfiles ?? {}) };
      for (const m of made) cur[m.agent] = m.id;
      try {
        await updateSettings({ defaultProfiles: cur });
      } catch (e) {
        failed.push(`设为启动默认：${String(e)}`);
      }
    }
    setBusy(false);
    setChosen({});
    setExcluded(new Set());
    const doneText = made.length
      ? `已建 ${made.length} 条连接（${made.map((m) => agentLabel(m.agent)).join("、")}）${setDefault ? "，并设为 Mesa 启动默认" : ""}`
      : "";
    setResult(
      failed.length
        ? { tone: "err", text: [doneText, `没建成：${failed.join("；")}`].filter(Boolean).join("。") }
        : { tone: "ok", text: doneText },
    );
  }

  return (
    <div>
      <button
        type="button"
        className="flex min-h-7 w-full items-center gap-2 text-left text-sm text-l2"
        onClick={() => onOpenChange(!open)}
      >
        <FoldMark open={open} />
        <span className="flex-1">一键配置各 CLI</span>
        <span className="text-micro text-l3">
          {installed.length ? `本机装了 ${installed.length} 个 CLI` : "本机没装 CLI"}
        </span>
      </button>
      {open && (
        <div className="space-y-2 pt-1 text-sm">
          <p className="text-xs text-l3">
            {"给每个装了的 CLI 在这个网关上各建一条连接，放目录里这家最新一代的每条产品线（如 Claude 的 opus、sonnet、fable、haiku），最新的旗舰作默认。" +
              "目录里只有一家的，所有 CLI 都用这家；有多家的，各 CLI 用自家模型，OpenCode、CodeBuddy 放各家最新旗舰，默认用哪个由你选。" +
              "只建 Mesa 连接，不改 CLI 自己的配置文件。"}
          </p>
          <div className="space-y-1">
            {rows.map((r) => {
              const pick = pickOf(r);
              const dup = r.skip ? null : dupOf(r);
              const on = !r.skip && !dup && !excluded.has(r.agent);
              // 多厂商行的其余各家旗舰另写「另 N 家旗舰」，这里只列同家的
              const light = pick ? rowModels(r, pick).filter((m) => m !== pick && !(r.multi && r.options.includes(m))) : [];
              return (
                <div key={r.agent} className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1">
                  <Checkbox
                    checked={on}
                    disabled={Boolean(r.skip || dup)}
                    onChange={(v) =>
                      setExcluded((s) => {
                        const n = new Set(s);
                        if (v) n.delete(r.agent);
                        else n.add(r.agent);
                        return n;
                      })
                    }
                    label={<span className="inline-block w-24 truncate text-xs text-l2">{agentLabel(r.agent)}</span>}
                  />
                  {r.skip ? (
                    <span className="min-w-0 flex-1 truncate text-xs text-l3">{r.skip}</span>
                  ) : (
                    <>
                      <div className="w-64 min-w-0 shrink">
                        <MenuSelect
                          aria-label={`${agentLabel(r.agent)} 默认模型`}
                          value={pick ?? ""}
                          placeholder={r.multi ? "选默认模型" : undefined}
                          onChange={(v) => setChosen((c) => ({ ...c, [r.agent]: v }))}
                          options={r.options.map((m) => ({
                            value: m,
                            label: r.multi ? `${m}（${VENDOR_LABEL[r.vendorOf[m]]}）` : m,
                            short: m,
                          }))}
                        />
                      </div>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-micro text-l3"
                        title={pick ? `名单：${rowModels(r, pick).join("、")}` : undefined}
                      >
                        {dup
                          ? `已有一样的连接「${dup}」`
                          : [
                              r.multi && pick ? `另 ${r.options.length - 1} 家旗舰` : null,
                              light.length ? `+ ${light.join("、")}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                      </span>
                      <span className="shrink-0 text-micro text-l3">{r.slot ? SLOT_LABEL[r.slot] : ""}</span>
                    </>
                  )}
                </div>
              );
            })}
            {rows.length === 0 && <p className="text-xs text-l3">本机还没装任何 CLI。</p>}
          </div>
          <Checkbox
            checked={setDefault}
            onChange={setSetDefault}
            label={<span className="text-xs text-l2">建好后设为这几家的 Mesa 启动默认</span>}
          />
          <div className="flex items-center gap-3">
            <button type="button" className={primaryActionClass} disabled={Boolean(blocker) || busy} onClick={() => void run()}>
              {busy ? "正在建…" : `建 ${selected.length} 条连接`}
            </button>
            {blocker && !busy && <span className="text-xs text-l3">{blocker}</span>}
          </div>
          {result && <InlineNotice tone={result.tone}>{result.text}</InlineNotice>}
        </div>
      )}
    </div>
  );
}
