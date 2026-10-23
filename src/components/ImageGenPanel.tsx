// 出图模型（连接页最下方一块；2026-10-23 首版，2026-10-24 挪到连接页并按用户意见重做）。
// 长相跟连接页的 Agent 分组一致：组头 + 一行「名称｜端点｜模型｜状态｜操作」（列模板由连接页传入，列对齐）。
// - 更换：搜索 + 最近用过 + 各家最新在前的选择器（ImageModelPicker），不再是几十项的原生下拉
// - 试出与对比：自己写描述，选 1–4 个模型同时出图，结果并排，挑中的点「用这个」
// - 进度：出图接口不回进度，按这个模型以往的耗时估（image-models.ts），到结果前不满格
// 存在设置的 imageGenGatewayId + imageGenModel（同进退）；这是唯一编辑处，设置页只显示现状并跳过来。
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { X } from "lucide-react";
import { FoldMark, ghostActionClass, primaryActionClass, settingsPillClass } from "./PageFrame";
import ImageModelPicker from "./ImageModelPicker";
import { Modal } from "./Modal";
import VendorIcon from "./VendorIcon";
import { endpointHost } from "../gateway-option";
import {
  estimateSeconds,
  itemKey,
  progressAt,
  pushRecent,
  recordDuration,
  type ImageModelItem,
} from "../image-models";
import { useAppStore } from "../store";
import { toast } from "../toast";
import { AGENTS, type DetectResult, type SkillDto } from "../types";
import { vendorForGateway } from "../vendor-icon";

type ImageGenGateway = { gatewayId: string; gatewayName: string; models: string[] };
type ImageGenTest = { dataUrl: string; protocol: string; elapsedMs: number; note?: string | null };
type Run =
  | { status: "running"; startedAt: number; estimate: number }
  | { status: "done"; dataUrl: string; ms: number; protocol: string; note?: string | null }
  | { status: "error"; error: string; ms: number };

// 选择器缺省值用模块级常量（zustand v5 每次新数组会无限重渲染；store-selector-lint 测试钉住）
const NO_AGENTS: DetectResult[] = [];
const NO_GATEWAYS: never[] = [];
const MAX_COMPARE = 4;
const LS_RECENT = "ccode.imageGen.recent";
const LS_DURATIONS = "ccode.imageGen.durations";
const LS_COLLAPSED = "ccode.imageGen.collapsed";
const LS_PROMPT = "ccode.imageGen.prompt";
const DEFAULT_PROMPT = "A small ceramic cup of tea on a wooden desk, soft morning light, simple composition";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存不了就算了：只影响排序与估时 */
  }
}

/** 把某网关的某个出图模型设为出图模型（连接行「改作出图模型」也走它） */
export async function setImageGenModel(gatewayId: string, model: string) {
  await useAppStore.getState().updateSettings({ imageGenGatewayId: gatewayId, imageGenModel: model });
  writeJson(LS_RECENT, pushRecent(readJson<string[]>(LS_RECENT, []), itemKey({ gatewayId, model })));
}

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} 秒`;

export default function ImageGenPanel({
  gridClass,
  sectionRef,
}: {
  /** 连接页行的列模板（PROFILE_GRID），保证这一行和上面的连接行列对齐 */
  gridClass: string;
  sectionRef?: Ref<HTMLElement>;
}) {
  const settings = useAppStore((s) => s.settings);
  const agents = useAppStore((s) => s.agents ?? NO_AGENTS);
  const gateways = useAppStore((s) => s.gateways ?? NO_GATEWAYS);
  const [groups, setGroups] = useState<ImageGenGateway[] | null>(null);
  const [helperReady, setHelperReady] = useState<boolean | null>(null);
  const [skill, setSkill] = useState<SkillDto | null | undefined>(undefined);
  const [enabling, setEnabling] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readJson<boolean>(LS_COLLAPSED, false));
  const [lab, setLab] = useState(false);
  const [prompt, setPrompt] = useState(() => readJson<string>(LS_PROMPT, ""));
  const [compare, setCompare] = useState<string[]>([]);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [recent, setRecent] = useState<string[]>(() => readJson<string[]>(LS_RECENT, []));
  const [durations, setDurations] = useState<Record<string, number[]>>(() => readJson(LS_DURATIONS, {}));
  const [pickOpen, setPickOpen] = useState<"single" | "multi" | null>(null);
  const [zoom, setZoom] = useState<{ title: string; src: string } | null>(null);
  const [, setTick] = useState(0);
  const changeRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  async function loadSkill() {
    const lib = await invoke<SkillDto[]>("list_skills").catch(() => null);
    setSkill(Array.isArray(lib) ? (lib.find((s) => s.name === "image-gen") ?? null) : null);
  }
  useEffect(() => {
    void invoke<ImageGenGateway[]>("image_gen_candidates").then(
      (r) => setGroups(Array.isArray(r) ? r : []),
      () => setGroups([]),
    );
    void invoke<{ helperReady: boolean }>("image_gen_status").then(
      (r) => setHelperReady(Boolean(r?.helperReady)),
      () => setHelperReady(false),
    );
    void loadSkill();
  }, []);

  const items: ImageModelItem[] = useMemo(
    () => (groups ?? []).flatMap((g) => g.models.map((model) => ({ gatewayId: g.gatewayId, gatewayName: g.gatewayName, model }))),
    [groups],
  );
  const gatewayId = settings?.imageGenGatewayId ?? "";
  const model = settings?.imageGenModel ?? "";
  const currentKey = gatewayId && model ? itemKey({ gatewayId, model }) : "";
  const gw = gateways.find((g) => g.id === gatewayId);
  const gwUrl = gw ? (gw.slots.openai ?? gw.slots.responses ?? gw.slots.gemini ?? gw.slots.anthropic ?? "") : "";
  const gatewayName = items.find((i) => i.gatewayId === gatewayId)?.gatewayName ?? gw?.name ?? null;

  // 生成中每半秒重画一次进度条；全部结束就停
  const anyRunning = Object.values(runs).some((r) => r.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [anyRunning]);

  const remember = useCallback((key: string) => {
    setRecent((prev) => {
      const next = pushRecent(prev, key);
      writeJson(LS_RECENT, next);
      return next;
    });
  }, []);

  function choose(it: ImageModelItem) {
    remember(itemKey(it));
    void setImageGenModel(it.gatewayId, it.model).catch((e) => toast(`保存失败：${String(e)}`));
  }

  function openLab() {
    setLab((v) => !v);
    if (!lab && compare.length === 0 && currentKey) setCompare([currentKey]);
    if (collapsed) toggleCollapsed();
  }

  function toggleCollapsed() {
    setCollapsed((v) => {
      writeJson(LS_COLLAPSED, !v);
      return !v;
    });
  }

  function toggleCompare(it: ImageModelItem) {
    const k = itemKey(it);
    setCompare((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : prev.length >= MAX_COMPARE ? prev : [...prev, k]));
  }

  async function runOne(key: string, text: string) {
    const it = items.find((i) => itemKey(i) === key) ?? (key === currentKey ? { gatewayId, gatewayName: gatewayName ?? "", model } : null);
    if (!it) return;
    const started = Date.now();
    setRuns((prev) => ({ ...prev, [key]: { status: "running", startedAt: started, estimate: estimateSeconds(it.model, durations[it.model]) } }));
    try {
      const r = await invoke<ImageGenTest>("image_gen_test", { gatewayId: it.gatewayId, model: it.model, prompt: text });
      setRuns((prev) => ({ ...prev, [key]: { status: "done", dataUrl: r.dataUrl, ms: r.elapsedMs, protocol: r.protocol, note: r.note } }));
      setDurations((prev) => {
        const next = recordDuration(prev, it.model, r.elapsedMs);
        writeJson(LS_DURATIONS, next);
        return next;
      });
      remember(key);
    } catch (e) {
      setRuns((prev) => ({ ...prev, [key]: { status: "error", error: String(e), ms: Date.now() - started } }));
    }
  }

  function generate() {
    const text = prompt.trim() || DEFAULT_PROMPT;
    writeJson(LS_PROMPT, prompt);
    const keys = compare.filter((k) => runs[k]?.status !== "running");
    for (const k of keys) void runOne(k, text);
  }

  // 已装、技能目录可分发、还没打开的 Agent（与技能页「一键应用」同口径：没装的不塞副本）
  const installed = new Set(agents.filter((a) => a.binaryPath).map((a) => a.id));
  const pendingAgents = skill
    ? Object.keys(skill.apps).filter((a) => !skill.apps[a] && (agents.length === 0 || installed.has(a)))
    : [];
  const enabledAgents = skill ? Object.keys(skill.apps).filter((a) => skill.apps[a]) : [];
  const labelOf = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

  async function enableForAll() {
    if (!skill || enabling) return;
    setEnabling(true);
    try {
      for (const agent of pendingAgents) {
        await invoke("apply_skill", { id: skill.id, agent, enabled: true });
      }
      toast(`已给 ${pendingAgents.map(labelOf).join("、")} 打开出图技能`);
    } catch (e) {
      toast(`打开出图技能失败：${String(e)}`);
    } finally {
      await loadSkill();
      setEnabling(false);
    }
  }

  const caption =
    helperReady === false
      ? { text: "这版 Mesa 没找到随包的出图工具，Agent 暂时调不了", cls: "text-warn-text" }
      : skill === null
        ? { text: "技能 image-gen 还没进技能库，重启 Mesa 后自动加入", cls: "text-l3" }
        : enabledAgents.length > 0
          ? {
              text: `已给 ${enabledAgents.length} 家 Agent 打开技能，说「画一张…」就会用它`,
              tip: enabledAgents.map(labelOf).join("、"),
              cls: "text-l3",
            }
          : { text: "还没给 Agent 打开技能 image-gen", cls: "text-warn-text" };
  const currentRun = currentKey ? runs[currentKey] : undefined;

  return (
    <section ref={sectionRef} className="mb-4 overflow-hidden rounded-xl border border-field ccode-well">
      <div className="group flex h-11 items-center gap-2 px-3">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "展开" : "收起"}
          className="flex shrink-0 items-center justify-center rounded-md hover:brightness-110"
        >
          <FoldMark open={!collapsed} boxed />
        </button>
        <h2 className="text-sm font-medium text-l1">出图模型</h2>
        <span className="rounded-full bg-inset px-1.5 py-0.5 text-micro text-l3" title="各网关目录里能直接出图的模型">
          {items.length}
        </span>
        <span className="min-w-0 truncate text-micro text-l3">Agent 画图用，和上面的对话模型分开配</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {pendingAgents.length > 0 && skill && (
            <button
              type="button"
              className={ghostActionClass}
              disabled={enabling}
              title={`给 ${pendingAgents.map(labelOf).join("、")} 打开技能 image-gen`}
              onClick={() => void enableForAll()}
            >
              {enabling ? "打开中…" : "给已装的 Agent 打开"}
            </button>
          )}
        </span>
      </div>
      {!collapsed && (
        <>
          <div className={`group grid min-h-14 ${gridClass} items-center gap-3 border-t border-hairline px-4 text-sm`}>
            <span className="flex min-w-0 items-center gap-2">
              <VendorIcon vendor={gw ? vendorForGateway(gw) : null} name={gatewayName ?? "出图"} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-l1">Agent 出图</span>
                <span className={`mt-0.5 block truncate text-micro ${caption.cls}`} title={"tip" in caption ? caption.tip : undefined}>
                  {caption.text}
                </span>
              </span>
            </span>
            <span className="min-w-0 truncate text-xs text-l2" title={gatewayName ? `网关「${gatewayName}」` : undefined}>
              {gwUrl ? endpointHost(gwUrl) : gatewayName ? gatewayName : "—"}
            </span>
            <span className="min-w-0 truncate font-mono text-micro text-l2" title={model || undefined}>
              {model || <span className="font-sans text-xs text-l3">还没选</span>}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-xs">
              {currentRun?.status === "done" && (
                <span className="flex min-w-0 items-center gap-1 text-l2" title={`${currentRun.protocol} · ${secs(currentRun.ms)}`}>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok-text" />
                  <span className="truncate">试出通过</span>
                </span>
              )}
              {currentRun?.status === "error" && (
                <span className="flex min-w-0 items-center gap-1 text-err-text" title={currentRun.error}>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-err-text" />
                  <span className="truncate">试出失败</span>
                </span>
              )}
              {currentRun?.status === "running" && <span className="truncate text-l3">出图中…</span>}
            </span>
            <span className="flex items-center justify-end gap-1 whitespace-nowrap">
              <button
                ref={changeRef}
                type="button"
                className={ghostActionClass}
                disabled={groups === null}
                onClick={() => setPickOpen((v) => (v === "single" ? null : "single"))}
              >
                {model ? "更换" : "选模型"}
              </button>
              <button
                type="button"
                className={lab ? `${ghostActionClass} bg-hover text-l1` : ghostActionClass}
                disabled={!currentKey && items.length === 0}
                onClick={openLab}
                title="写一句想画的，挑几个模型同时出图对比"
              >
                试出与对比
              </button>
            </span>
          </div>
          {groups !== null && items.length === 0 && (
            <p className="border-t border-hairline px-4 py-2.5 text-micro leading-4 text-l3">
              网关目录里还没有出图模型：到「网关库」给网关点一次「获取模型」，或换一个开通了出图模型的网关。
            </p>
          )}
          {lab && (
            <div className="border-t border-hairline px-4 py-3">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={2}
                placeholder="想画什么？比如：一只在书桌上打盹的橘猫，水彩风格。留空就画一杯茶"
                className="w-full resize-y rounded-lg border border-field bg-canvas px-2.5 py-2 text-sm text-l1 outline-none placeholder:text-l4 focus:border-l4"
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {compare.map((k) => {
                  const it = items.find((i) => itemKey(i) === k);
                  if (!it) return null;
                  return (
                    <span key={k} className="inline-flex h-7 items-center gap-1 rounded-full bg-inset pl-2.5 pr-1 font-mono text-micro text-l2">
                      {it.model}
                      {k === currentKey && <span className="font-sans text-l3">（当前）</span>}
                      <button
                        type="button"
                        aria-label={`不比 ${it.model}`}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-l3 hover:bg-hover hover:text-l1"
                        onClick={() => setCompare((prev) => prev.filter((x) => x !== k))}
                      >
                        <X size={12} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </span>
                  );
                })}
                {compare.length < MAX_COMPARE && (
                  <button
                    ref={addRef}
                    type="button"
                    className={ghostActionClass}
                    onClick={() => setPickOpen((v) => (v === "multi" ? null : "multi"))}
                  >
                    + 加模型对比
                  </button>
                )}
                <span className="ml-auto flex items-center gap-2">
                  <span className="text-micro text-l3">每个模型出一张，按张计费</span>
                  <button
                    type="button"
                    className={primaryActionClass}
                    disabled={compare.length === 0 || compare.every((k) => runs[k]?.status === "running")}
                    onClick={generate}
                  >
                    {compare.length > 1 ? `生成 ${compare.length} 张对比` : "生成"}
                  </button>
                </span>
              </div>
              {compare.some((k) => runs[k]) && (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {compare.map((k) => {
                    const it = items.find((i) => itemKey(i) === k);
                    const run = runs[k];
                    if (!it || !run) return null;
                    return (
                      <div key={k} className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-hairline">
                        <div className="flex items-center gap-2 px-2.5 py-1.5">
                          <span className="min-w-0 flex-1 truncate font-mono text-micro text-l1" title={`${it.model} · ${it.gatewayName}`}>
                            {it.model}
                          </span>
                          {run.status !== "running" && <span className="shrink-0 text-micro text-l3">{secs(run.ms)}</span>}
                        </div>
                        <div className="flex h-44 items-center justify-center bg-inset">
                          {run.status === "done" && (
                            <button type="button" className="h-full w-full" onClick={() => setZoom({ title: it.model, src: run.dataUrl })} title="看大图">
                              <img src={run.dataUrl} alt={`${it.model} 出的图`} className="h-full w-full object-contain" />
                            </button>
                          )}
                          {run.status === "running" && (() => {
                            const elapsed = (Date.now() - run.startedAt) / 1000;
                            const pct = Math.round(progressAt(elapsed, run.estimate) * 100);
                            return (
                              <div className="w-4/5" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${it.model} 出图进度（估算）`}>
                                <div className="h-1 overflow-hidden rounded-full bg-hairline">
                                  <div className="h-full rounded-full bg-cta transition-[width] duration-500" style={{ width: `${Math.max(pct, 3)}%` }} />
                                </div>
                                <p className="mt-2 text-center text-micro text-l3">
                                  {elapsed <= run.estimate
                                    ? `已等 ${Math.round(elapsed)} 秒 · 这个模型一般约 ${run.estimate} 秒`
                                    : `比平常久，还在等（已等 ${Math.round(elapsed)} 秒）`}
                                </p>
                              </div>
                            );
                          })()}
                          {run.status === "error" && (
                            <p className="line-clamp-6 px-3 text-micro leading-4 text-err-text" title={run.error}>
                              {run.error}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 px-2.5 py-1.5">
                          <span className="min-w-0 flex-1 truncate text-micro text-l3" title={run.status === "done" ? run.note ?? undefined : undefined}>
                            {run.status === "done" ? run.protocol : run.status === "error" ? "没出图" : "生成中"}
                          </span>
                          {k === currentKey ? (
                            <span className="shrink-0 text-micro text-l3">当前出图模型</span>
                          ) : (
                            run.status === "done" && (
                              <button type="button" className={settingsPillClass} onClick={() => choose(it)}>
                                用这个
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}
      <ImageModelPicker
        anchorRef={pickOpen === "multi" ? addRef : changeRef}
        open={pickOpen !== null}
        onClose={() => setPickOpen(null)}
        items={items}
        recent={recent}
        selected={pickOpen === "multi" ? compare : currentKey ? [currentKey] : []}
        multi={pickOpen === "multi"}
        maxSelected={MAX_COMPARE}
        onPick={(it) => (pickOpen === "multi" ? toggleCompare(it) : choose(it))}
      />
      {zoom && (
        <Modal open title={zoom.title} onClose={() => setZoom(null)} size="xl">
          <img src={zoom.src} alt={zoom.title} className="mx-auto max-h-[75vh] w-auto object-contain" />
        </Modal>
      )}
    </section>
  );
}
