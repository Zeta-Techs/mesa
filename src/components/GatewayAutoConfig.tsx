import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Check, Loader2, Plus, X } from "lucide-react";
import { useAppStore } from "../store";
import { AGENTS, type Gateway } from "../types";
import { PROVIDER_PRESETS } from "../presets";
import { SLOT_LABEL } from "../connection-form";
import {
  duplicateConnection,
  planAutoConfig,
  roleModelsFor,
  rowModels,
  slotCandidates,
  VENDOR_LABEL,
  type AutoConfigRow,
  type PriceTable,
} from "../gateway-autoconfig";
import { Checkbox, InlineNotice, primaryActionClass, searchFieldClass, secondaryActionClass } from "./PageFrame";
import { Modal } from "./Modal";

const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

type RunState = "queued" | "running" | "done" | "failed";
/** 建连接时每家至少停这么久，逐家打勾看得清（后端建一条通常几十毫秒） */
const STEP_MIN_MS = 220;

/**
 * 网关库「一键配置各 CLI」弹窗（2026-11-04 用户拍板）：网关行尾的魔棒打开。每个已安装的 CLI 一行，
 * 名单一个模型一个槽（胶囊）：点槽换模型、× 去掉、＋ 加一个，第一个是默认；勾选后点「建」逐家打勾建好。
 * 只建 Mesa 连接，不写 CLI 配置文件。规则见 gateway-autoconfig.ts。
 */
export default function GatewayAutoConfig({
  gateway,
  dirty = false,
  open,
  onClose,
}: {
  gateway: Gateway;
  /** 从编辑页打开且网关有没保存的修改：不让建（连接按已保存的网关建） */
  dirty?: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const agents = useAppStore((s) => s.agents);
  const profiles = useAppStore((s) => s.profiles);
  const settings = useAppStore((s) => s.settings);
  const bindGateway = useAppStore((s) => s.bindGateway);
  const updateSettings = useAppStore((s) => s.updateSettings);
  // 人改过的名单（第一个 = 默认）；没改过的按规则算。键 = agent
  const [lists, setLists] = useState<Record<string, string[]>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [setDefault, setSetDefault] = useState(false);
  const [progress, setProgress] = useState<Record<string, RunState> | null>(null);
  const [result, setResult] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const busy = Boolean(progress && Object.values(progress).some((s) => s === "queued" || s === "running"));
  const finished = Boolean(progress) && !busy;

  // 每次打开从头来
  useEffect(() => {
    if (!open) return;
    setLists({});
    setExcluded(new Set());
    setProgress(null);
    setResult(null);
  }, [open, gateway.id]);

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

  /** 这一行现在的名单；多厂商行没人定默认前为各家旗舰、不标默认 */
  const listOf = (r: AutoConfigRow): string[] =>
    lists[r.agent] ?? (r.defaultModel ? rowModels(r, r.defaultModel) : r.options);
  const needsDefault = (r: AutoConfigRow) => r.multi && !r.defaultModel && !lists[r.agent];
  const dupOf = (r: AutoConfigRow) => {
    if (needsDefault(r)) return null;
    const l = listOf(r);
    return l.length ? duplicateConnection(r, l, gateway.id, profiles) : null;
  };
  const usable = rows.filter((r) => !r.skip);
  const selected = usable.filter((r) => !excluded.has(r.agent) && !dupOf(r));
  const missingPick = selected.filter((r) => needsDefault(r) || listOf(r).length === 0);
  const blocker = dirty
    ? "网关有没保存的修改，先保存"
    : gateway.models.length === 0
      ? "先在网关里点「获取模型」"
      : missingPick.length
        ? `先给 ${missingPick.map((r) => agentLabel(r.agent)).join("、")} 定默认模型`
        : selected.length === 0
          ? "没有可建的连接"
          : null;

  const edit = (r: AutoConfigRow, next: string[]) => setLists((c) => ({ ...c, [r.agent]: next }));
  /** 多厂商行第一次定默认：按规则补上那家的同代轻量 */
  const makeDefault = (r: AutoConfigRow, m: string) => {
    if (needsDefault(r)) return edit(r, rowModels(r, m));
    const l = listOf(r);
    edit(r, [m, ...l.filter((x) => x !== m)]);
  };

  async function run() {
    if (blocker || busy) return;
    const queue = selected;
    setResult(null);
    setProgress(Object.fromEntries(queue.map((r) => [r.agent, "queued" as RunState])));
    const made: { agent: string; id: string }[] = [];
    const failed: string[] = [];
    for (const r of queue) {
      setProgress((p) => ({ ...p, [r.agent]: "running" }));
      const models = listOf(r);
      const started = Date.now();
      let ok = false;
      try {
        const p = await bindGateway({
          agent: r.agent,
          name: gateway.name,
          gatewayId: gateway.id,
          kind: "api",
          protocol: r.protocol,
          models,
          roleModels: roleModelsFor(r, models),
          extraEnv: {},
        });
        made.push({ agent: r.agent, id: p.id });
        ok = true;
      } catch (e) {
        failed.push(`${agentLabel(r.agent)}：${String(e)}`);
      }
      const wait = STEP_MIN_MS - (Date.now() - started);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      setProgress((p) => ({ ...p, [r.agent]: ok ? "done" : "failed" }));
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
    const doneText = made.length
      ? `已建 ${made.length} 条连接${setDefault ? "，并设为 Mesa 启动默认" : ""}，在连接页能看到。`
      : "";
    setResult(
      failed.length
        ? { tone: "err", text: [doneText, `没建成：${failed.join("；")}`].filter(Boolean).join(" ") }
        : { tone: "ok", text: doneText },
    );
  }

  return (
    <Modal
      open={open}
      size="xl"
      title={`一键配置各 CLI · ${gateway.name}`}
      description={
        "给每个装了的 CLI 在这个网关上各建一条连接。每个小格是一个模型：点它换成别的、× 去掉、＋ 再加一个，第一个是默认。" +
        "只建 Mesa 连接，不改 CLI 自己的配置文件。"
      }
      dismissOnBackdrop={!busy}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          {!finished && (
            <Checkbox
              checked={setDefault}
              disabled={busy}
              onChange={setSetDefault}
              className="mr-auto"
              label={<span className="text-xs text-l2">建好后设为这几家的 Mesa 启动默认</span>}
            />
          )}
          {!finished && blocker && !busy && <span className="text-xs text-l3">{blocker}</span>}
          {finished ? (
            <button type="button" className={primaryActionClass} onClick={onClose}>
              完成
            </button>
          ) : (
            <>
              <button type="button" className={secondaryActionClass} disabled={busy} onClick={onClose}>
                取消
              </button>
              <button type="button" className={primaryActionClass} disabled={Boolean(blocker) || busy} onClick={() => void run()}>
                {busy ? "正在建…" : `建 ${selected.length} 条连接`}
              </button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-1 text-sm">
        {rows.map((r) => {
          const state = progress?.[r.agent];
          const locked = Boolean(progress);
          const dup = r.skip ? null : dupOf(r);
          const on = !r.skip && !dup && !excluded.has(r.agent);
          const list = listOf(r);
          const pending = needsDefault(r);
          const small = pending ? null : roleModelsFor(r, list).small;
          return (
            <div
              key={r.agent}
              className={`flex items-start gap-2 rounded-md px-2 py-1.5 transition-opacity duration-200 ${
                locked && !state ? "opacity-40" : ""
              }`}
            >
              <div className="flex h-7 w-5 shrink-0 items-center">
                {state ? (
                  <RunMark state={state} />
                ) : (
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
                    label={<span className="sr-only">{agentLabel(r.agent)}</span>}
                  />
                )}
              </div>
              <span className="flex h-7 w-24 shrink-0 items-center truncate text-xs text-l2">{agentLabel(r.agent)}</span>
              {r.skip ? (
                <span className="flex min-h-7 min-w-0 flex-1 items-center text-xs text-l3">{r.skip}</span>
              ) : (
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  {list.map((m, i) => (
                    <ModelSlot
                      key={m}
                      model={m}
                      tag={pending ? VENDOR_LABEL[r.vendorOf[m]] : i === 0 ? "默认" : m === small ? "后台" : null}
                      primary={!pending && i === 0}
                      disabled={locked}
                      candidates={slotCandidates(gateway.models, m, list)}
                      canDefault={pending || i > 0}
                      canRemove={list.length > 1}
                      onReplace={(next) => edit(r, list.map((x) => (x === m ? next : x)))}
                      onMakeDefault={() => makeDefault(r, m)}
                      onRemove={() => edit(r, list.filter((x) => x !== m))}
                    />
                  ))}
                  {!locked && (
                    <ModelSlot
                      model={null}
                      candidates={slotCandidates(gateway.models, list[0] ?? null, list)}
                      onReplace={(next) => edit(r, [...list, next])}
                    />
                  )}
                  {pending && <span className="text-micro text-warn-text">点一个设为默认</span>}
                  {dup && <span className="text-micro text-l3">已有一样的连接「{dup}」</span>}
                </div>
              )}
              <span className="flex h-7 shrink-0 items-center text-micro text-l3">{r.slot ? SLOT_LABEL[r.slot] : ""}</span>
            </div>
          );
        })}
        {rows.length === 0 && <p className="text-xs text-l3">本机还没装任何 CLI。</p>}
      </div>
      {result && (
        <div className="mt-3">
          <InlineNotice tone={result.tone}>{result.text}</InlineNotice>
        </div>
      )}
    </Modal>
  );
}

function RunMark({ state }: { state: RunState }) {
  if (state === "running") return <Loader2 className="size-4 animate-spin text-l2" aria-label="正在建" />;
  if (state === "done")
    return (
      <span className="ccode-fade flex size-4 items-center justify-center rounded-full bg-ok-text text-white" aria-label="已建好">
        <Check className="size-3" strokeWidth={3} />
      </span>
    );
  if (state === "failed")
    return (
      <span className="ccode-fade flex size-4 items-center justify-center rounded-full bg-err-text text-white" aria-label="没建成">
        <X className="size-3" strokeWidth={3} />
      </span>
    );
  return <span className="size-4 rounded-full border border-field" aria-label="排队中" />;
}

/**
 * 名单里的一个模型槽：小胶囊，点开是可搜索的模型列表（同家新的在前）。model = null 是末尾的「＋」。
 * 弹出层挂 body：弹窗面板会滚动、会裁掉子元素
 */
function ModelSlot({
  model,
  tag = null,
  primary = false,
  disabled = false,
  candidates,
  canDefault = false,
  canRemove = false,
  onReplace,
  onMakeDefault,
  onRemove,
}: {
  model: string | null;
  tag?: string | null;
  primary?: boolean;
  disabled?: boolean;
  candidates: string[];
  canDefault?: boolean;
  canRemove?: boolean;
  onReplace: (model: string) => void;
  onMakeDefault?: () => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 288;
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // 捕获阶段：弹窗面板 mousedown 会 stopPropagation；Esc 先关这里，不让弹窗跟着关
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = (q ? candidates.filter((id) => id.toLowerCase().includes(q)) : candidates).slice(0, 80);
  const pick = (id: string) => {
    setOpen(false);
    setQuery("");
    if (id !== model) onReplace(id);
  };

  return (
    <span className="group relative inline-flex">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={model ? "点一下换成别的模型" : "再加一个模型"}
        onClick={() => setOpen((v) => !v)}
        className={
          model
            ? `inline-flex h-7 max-w-[18rem] items-center gap-1.5 rounded-md border px-2 font-mono text-xs transition-colors disabled:cursor-default ${
                primary ? "border-cta-bd text-l1" : "border-field text-l2"
              } ${open ? "bg-hover" : "hover:bg-hover"} ${canRemove && !disabled ? "pr-6" : ""}`
            : "inline-flex size-7 items-center justify-center rounded-md border border-dashed border-field text-l3 hover:bg-hover hover:text-l1"
        }
      >
        {model ? (
          <>
            <span className="truncate">{model}</span>
            {tag && <span className="shrink-0 font-sans text-micro text-l3">{tag}</span>}
          </>
        ) : (
          <Plus className="size-3.5" aria-label="再加一个模型" />
        )}
      </button>
      {model && canRemove && !disabled && (
        <button
          type="button"
          aria-label={`去掉 ${model}`}
          title="去掉这个模型"
          onClick={onRemove}
          className="absolute right-1 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded text-l4 opacity-0 transition-opacity hover:text-l1 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X className="size-3" />
        </button>
      )}
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            style={{ top: pos.top, left: pos.left, width: 288 }}
            className="ccode-float-surface fixed z-50 flex flex-col gap-1 p-1.5"
          >
            {model && canDefault && onMakeDefault && (
              <button
                type="button"
                className="flex h-8 items-center rounded px-2 text-left text-sm text-l1 hover:bg-hover"
                onClick={() => {
                  setOpen(false);
                  onMakeDefault();
                }}
              >
                设为默认
              </button>
            )}
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) pick(shown[0]);
              }}
              placeholder={model ? "换成…（输入筛选）" : "加一个模型（输入筛选）"}
              className={`${searchFieldClass} w-full`}
            />
            <ul role="listbox" className="max-h-64 overflow-auto">
              {shown.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={id === model}
                    className={`flex h-7 w-full items-center rounded px-2 text-left font-mono text-xs ${
                      id === model ? "bg-hover text-l1" : "text-l2 hover:bg-hover hover:text-l1"
                    }`}
                    onClick={() => pick(id)}
                  >
                    <span className="truncate">{id}</span>
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="px-2 py-1.5 text-xs text-l3">目录里没有匹配的模型</li>}
            </ul>
          </div>,
          document.body,
        )}
    </span>
  );
}
