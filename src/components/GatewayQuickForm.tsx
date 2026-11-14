import { probeHint } from "../connection-form";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff } from "lucide-react";
import { useAppStore } from "../store";
import { NO_PRESET_REASON, presetsForAgent } from "../presets";
import { PROBEABLE_GATEWAY_SLOTS, slotForAgent, type GatewaySlotName } from "../gateway-slot";
import { fetchModelsInvokeArgs } from "../gateway-draft";
import { compatibleGatewaysForAgent } from "../onboarding";
import {
  AGENT_PROTOCOLS,
  type BindingInput,
  type FetchModelsResultDto,
  type GatewayInput,
  type GatewayModel,
  type GatewayProbeDto,
} from "../types";
import {
  InlineNotice,
  MenuSelect,
  primaryActionClass,
  quietActionClass,
  secondaryActionClass,
  surfaceFieldClass,
} from "./PageFrame";

/**
 * 上手向导里的精简「服务商 + API Key」接入：
 * - 若本地网关库已有兼容当前 Agent 的网关（比如前一步已给另一家 Agent 配过 DeepSeek / 智谱 / 中转），
 *   顶部可直接「复用已有网关」免填密钥一键测试并绑定；
 * - 新建服务商连接：MenuSelect 选预设或「其他服务商 / 中转（自填地址）」、贴密钥（支持明文切换）、
 *   自动拉模型目录（不替人预选目录第一个）、支持单独「测试连接」或直接回车「测试并保存」。
 * 保存路径与网关库同源：probe_gateway_slot → saveGateway → bindGateway。
 */
export function GatewayQuickForm({
  agent,
  onConnected,
  onMore,
  onBusyChange,
}: {
  agent: string;
  onConnected: () => void;
  onMore: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const gateways = useAppStore((s) => s.gateways);
  const profiles = useAppStore((s) => s.profiles);
  const reusable = useMemo(
    () => compatibleGatewaysForAgent(agent, gateways, profiles),
    [agent, gateways, profiles],
  );
  const [mode, setMode] = useState<"reuse" | "new" | null>(null);
  const activeMode = reusable.length === 0 ? "new" : (mode ?? "reuse");

  const presets = useMemo(() => presetsForAgent(agent), [agent]);
  const [index, setIndex] = useState(0);
  // 下拉最后一项（index === presets.length）= 自填地址
  const custom = index >= presets.length;
  const preset = custom ? undefined : presets[index];
  const [customUrl, setCustomUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  // 拉到的模型目录：null = 没拉过；manual = 用户选了「手动填写」
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const catalogFor = useRef("");
  const saveInFlight = useRef(false);

  // 复用已有网关状态
  const [reuseGwId, setReuseGwId] = useState<string>(() => reusable[0]?.gateway.id ?? "");
  const pickedReuse = reusable.find((r) => r.gateway.id === reuseGwId) ?? reusable[0];
  const [reuseModelDraft, setReuseModelDraft] = useState<string | null>(null);
  const [reuseManual, setReuseManual] = useState(false);

  useEffect(() => {
    onBusyChange(!!busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  // Cursor 是自家协议、第三方端点接不通；Gemini / Agy 官方不需要填地址——无兼容网关时给说明和网关库入口
  if (!presets.length && reusable.length === 0) {
    return (
      <div className="text-sm leading-6 text-l3">
        {NO_PRESET_REASON[agent] ?? "这家 Agent 没有内置的服务商预设。"}
        <div className="mt-3">
          <button type="button" className={quietActionClass} onClick={onMore}>
            打开网关库手动填写
          </button>
        </div>
      </div>
    );
  }

  const modeTabs = reusable.length > 0 && presets.length > 0 && (
    <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="网关来源">
      {(
        [
          ["reuse", `复用已有网关（${reusable.length}）`],
          ["new", "新建服务商连接"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          disabled={!!busy}
          aria-pressed={activeMode === id}
          onClick={() => {
            setMode(id);
            setError(null);
            setTested(false);
          }}
          className={`flex h-7 items-center rounded-full border px-3 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            activeMode === id
              ? "border-cta bg-cta/10 font-medium text-l1"
              : "border-hairline text-l3 hover:bg-hover hover:text-l1"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (activeMode === "reuse" && pickedReuse) {
    const reuseModels = pickedReuse.models;
    const reusePicking = reuseModels.length > 0 && !reuseManual;
    const reuseModel = (reuseModelDraft ?? reuseModels[0] ?? "").trim();
    const canProbeReuse = PROBEABLE_GATEWAY_SLOTS.includes(pickedReuse.slot);

    async function testReuse(): Promise<boolean> {
      if (!canProbeReuse) {
        setTested(true);
        return true;
      }
      setBusy("test");
      setError(null);
      try {
        const dto = await invoke<GatewayProbeDto>("probe_gateway_slot", {
          gatewayId: pickedReuse.gateway.id,
          slot: pickedReuse.slot,
          model: reuseModel || null,
          basicOnly: true,
          baseUrl: pickedReuse.baseUrl,
          apiKey: null,
          noAuth: Boolean(pickedReuse.gateway.noAuth),
        });
        if (!dto.ok) {
          const failed = dto.checks.find((c) => c.status === "failed");
          setError(failed ? `${failed.message}${probeHint(failed.message)}` : "测试失败，检查网关密钥与模型是否可用");
          setTested(false);
          return false;
        }
        setTested(true);
        return true;
      } catch (e) {
        setError(String(e));
        setTested(false);
        return false;
      } finally {
        setBusy("");
      }
    }

    async function bindExisting() {
      if (saveInFlight.current) return;
      if (!reuseModel) {
        setError("选一个或填一个要用的模型名");
        return;
      }
      saveInFlight.current = true;
      try {
        if (!tested && canProbeReuse && !(await testReuse())) return;
        setBusy("save");
        setError(null);
        const s = useAppStore.getState();
        await s.bindGateway({
          agent,
          name: `${pickedReuse.gateway.name} · ${agent}`,
          gatewayId: pickedReuse.gateway.id,
          kind: "api",
          protocol: pickedReuse.protocol,
          models: [reuseModel],
          extraEnv: {},
        });
        await s.loadAll();
        onConnected();
      } catch (e) {
        setError(String(e));
      } finally {
        saveInFlight.current = false;
        setBusy("");
      }
    }

    return (
      <div>
        {modeTabs}
        <form onSubmit={(e) => { e.preventDefault(); void bindExisting(); }}>
          <fieldset disabled={!!busy} className="min-w-0 space-y-4">
            <div>
              <span className="mb-1 block text-xs text-l3">已有网关（免重贴 API Key）</span>
              <MenuSelect
                aria-label="已有网关"
                disabled={!!busy}
                value={pickedReuse.gateway.id}
                options={reusable.map((r) => ({
                  value: r.gateway.id,
                  label: `${r.gateway.name}${r.gateway.keyHint ? `（密钥 ${r.gateway.keyHint}）` : ""}`,
                  short: r.gateway.name,
                }))}
                onChange={(nextId) => {
                  setReuseGwId(nextId);
                  setReuseModelDraft(null);
                  setReuseManual(false);
                  setTested(false);
                  setError(null);
                }}
              />
              <span className="mt-1 block truncate font-mono text-micro leading-5 text-l4">
                接入地址：{pickedReuse.baseUrl}
              </span>
            </div>
            <div>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                <label htmlFor="onboarding-reuse-model" className="text-l3">默认模型</label>
                {reuseManual && reuseModels.length > 0 && (
                  <button
                    type="button"
                    className="text-cta hover:underline"
                    onClick={() => {
                      setReuseManual(false);
                      setReuseModelDraft(reuseModels[0] ?? null);
                    }}
                  >
                    从列表选择
                  </button>
                )}
              </div>
              {reusePicking ? (
                <MenuSelect
                  aria-label="默认模型"
                  disabled={!!busy}
                  value={reuseModels.includes(reuseModel) ? reuseModel : ""}
                  placeholder={`选一个模型（共 ${reuseModels.length} 个）`}
                  options={[
                    ...reuseModels.map((m) => ({ value: m, label: m })),
                    { value: MANUAL, label: "手动填写…" },
                  ]}
                  onChange={(val) => {
                    if (val === MANUAL) {
                      setReuseManual(true);
                      setReuseModelDraft("");
                    } else {
                      setReuseModelDraft(val);
                    }
                    setTested(false);
                    setError(null);
                  }}
                />
              ) : (
                <input
                  id="onboarding-reuse-model"
                  className={surfaceFieldClass}
                  value={reuseModelDraft ?? ""}
                  placeholder="填要用的模型名"
                  onChange={(e) => {
                    setReuseModelDraft(e.target.value);
                    setTested(false);
                    setError(null);
                  }}
                />
              )}
            </div>
            {error && <InlineNotice tone="err">{error}</InlineNotice>}
            {tested && !error && (
              <div role="status">
                <InlineNotice tone="ok">连接测试通过，可以绑定</InlineNotice>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button type="submit" className={primaryActionClass} disabled={!!busy || !reuseModel}>
                {busy === "save" ? "绑定中…" : busy === "test" ? "测试中…" : canProbeReuse ? "测试并绑定" : "直接绑定"}
              </button>
              {canProbeReuse && (
                <button
                  type="button"
                  className={secondaryActionClass}
                  disabled={!!busy || !reuseModel}
                  onClick={() => void testReuse()}
                >
                  测试连接
                </button>
              )}
              <button type="button" className={quietActionClass} disabled={!!busy} onClick={onMore}>
                更多设置（网关库）
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    );
  }

  const presetModels = preset?.provider.models ?? [];
  // 自填地址：qwen / kimi 的中转一般是 OpenAI 兼容，按 openai 协议接
  const protocol = custom ? (AGENT_PROTOCOLS[agent] ? "openai" : undefined) : preset!.protocol;
  const slot = slotForAgent(agent, protocol);
  const baseUrl = custom ? customUrl.trim() : preset!.baseUrl;
  const urlOk = /^https?:\/\/\S+$/i.test(baseUrl);
  const canProbe = PROBEABLE_GATEWAY_SLOTS.includes(slot);
  const picking = !!catalog?.length && !manual;
  // 下拉里默认只认预设推荐且目录里真有的；都没有就留空让人自己选
  const defaultModel = picking ? (presetModels.find((m) => catalog!.includes(m)) ?? "") : (presetModels[0] ?? "");
  const model = (modelDraft ?? defaultModel).trim();
  const options = picking
    ? [...presetModels.filter((m) => catalog!.includes(m)), ...catalog!.filter((m) => !presetModels.includes(m))]
    : [];

  function resetCatalog() {
    catalogFor.current = "";
    setCatalog(null);
    setCatalogError(null);
    setManual(false);
  }

  async function loadCatalog() {
    const key = apiKey.trim();
    if (!urlOk || !key) return;
    const ask = `${baseUrl}\n${slot}\n${key}`;
    if (catalogFor.current === ask) return;
    catalogFor.current = ask;
    setCatalogBusy(true);
    setCatalogError(null);
    try {
      const res = await invoke<FetchModelsResultDto>(
        "fetch_models",
        fetchModelsInvokeArgs({ baseUrl, apiKey: key, noAuth: false, slot }),
      );
      if (catalogFor.current !== ask) return;
      const ids = Array.from(new Set((res?.models ?? []).map((m) => m.trim()).filter(Boolean)));
      setCatalog(ids);
      if (!ids.length) setCatalogError("这个地址没有返回模型列表，照服务商文档手动填模型名");
    } catch (e) {
      if (catalogFor.current !== ask) return;
      catalogFor.current = "";
      setCatalog(null);
      setCatalogError(`没拉到模型列表：${String(e)}`);
    } finally {
      if (catalogFor.current === ask || catalogFor.current === "") setCatalogBusy(false);
    }
  }

  async function test(): Promise<boolean> {
    if (!canProbe) {
      setTested(true);
      return true;
    }
    setBusy("test");
    setError(null);
    try {
      const dto = await invoke<GatewayProbeDto>("probe_gateway_slot", {
        gatewayId: null,
        slot,
        model: model || null,
        basicOnly: true,
        baseUrl,
        apiKey: apiKey.trim() || null,
        noAuth: false,
      });
      if (!dto.ok) {
        const failed = dto.checks.find((c) => c.status === "failed");
        setError(failed ? `${failed.message}${probeHint(failed.message)}` : "测试失败，检查密钥和服务商是否对应");
        setTested(false);
        return false;
      }
      setTested(true);
      return true;
    } catch (e) {
      setError(String(e));
      setTested(false);
      return false;
    } finally {
      setBusy("");
    }
  }

  async function save() {
    if (saveInFlight.current) return;
    if (!urlOk) {
      setError("填服务商给的 API 地址，以 http:// 或 https:// 开头");
      return;
    }
    if (!apiKey.trim()) {
      setError("先贴上 API Key");
      return;
    }
    if (!model) {
      setError("填一个要用的模型名");
      return;
    }
    saveInFlight.current = true;
    try {
      if (!tested && canProbe && !(await test())) return;
      setBusy("save");
      setError(null);
      const s = useAppStore.getState();
      const slots: Partial<Record<GatewaySlotName, string>> = custom ? { [slot]: baseUrl } : preset!.provider.slots;
      const models: GatewayModel[] = [model, ...presetModels.filter((m) => m !== model)].map((id) => ({
        id,
        source: "user",
        status: "available",
        lastSeenAt: null,
        catalogSlot: null,
        temperature: null,
        topP: null,
        maxOutputTokens: null,
        reasoningEffort: null,
      }));
      const input: GatewayInput = {
        name: custom ? customGatewayName(baseUrl) : preset!.name,
        noAuth: false,
        slots: {
          anthropic: slots.anthropic ?? null,
          openai: slots.openai ?? null,
          responses: slots.responses ?? null,
          gemini: slots.gemini ?? null,
          cursor: slots.cursor ?? null,
        },
        headerEnv: {},
        models,
        apiKey: apiKey.trim(),
      };
      const saved = await s.saveGateway(null, input);
      const binding: BindingInput = {
        agent,
        name: `${saved.name} · ${agent}`,
        gatewayId: saved.id,
        kind: "api",
        protocol: protocol ?? null,
        models: [model],
        extraEnv: {},
      };
      await s.bindGateway(binding);
      await s.loadAll();
      onConnected();
    } catch (e) {
      setError(String(e));
    } finally {
      saveInFlight.current = false;
      setBusy("");
    }
  }

  const providerOptions = [
    ...presets.map((p, i) => ({ value: String(i), label: p.name })),
    { value: String(presets.length), label: "其他服务商 / 中转（自填地址）" },
  ];

  return (
    <div>
      {modeTabs}
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={!!busy} className="min-w-0 space-y-4">
          <div>
            <span className="mb-1 block text-xs text-l3">服务商</span>
            <MenuSelect
              aria-label="服务商"
              disabled={!!busy}
              value={String(index)}
              options={providerOptions}
              onChange={(val) => {
                setIndex(Number(val));
                setCustomUrl("");
                setModelDraft(null);
                resetCatalog();
                setTested(false);
                setError(null);
              }}
            />
            {preset?.note && <span className="mt-1 block text-xs leading-5 text-l4">{preset.note}</span>}
          </div>
          {custom && (
            <label className="block">
              <span className="mb-1 block text-xs text-l3">API 地址</span>
              <input
                type="url"
                autoComplete="off"
                spellCheck={false}
                className={surfaceFieldClass}
                value={customUrl}
                placeholder="https://…"
                onChange={(e) => {
                  setCustomUrl(e.target.value);
                  resetCatalog();
                  setTested(false);
                  setError(null);
                }}
                onBlur={() => void loadCatalog()}
              />
              <span className="mt-1 block text-xs leading-5 text-l4">{SLOT_HINT[slot]}</span>
            </label>
          )}
          <div>
            <label htmlFor="onboarding-api-key" className="mb-1 block text-xs text-l3">API Key</label>
            <div className="relative">
              <input
                id="onboarding-api-key"
                type={showKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                className={`${surfaceFieldClass} pr-9`}
                value={apiKey}
                placeholder="粘贴服务商给你的密钥"
                onChange={(e) => {
                  setApiKey(e.target.value);
                  resetCatalog();
                  setTested(false);
                  setError(null);
                }}
                onBlur={() => void loadCatalog()}
              />
              {apiKey && (
                <button
                  type="button"
                  disabled={!!busy}
                  aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                  title={showKey ? "隐藏密钥" : "显示密钥"}
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-l4 transition-colors hover:bg-hover hover:text-l2 disabled:opacity-50"
                >
                  {showKey ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                </button>
              )}
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
              <label htmlFor="onboarding-model" className="text-l3">默认模型</label>
              <div className="flex items-center gap-3">
                {manual && !!catalog?.length && (
                  <button
                    type="button"
                    disabled={!!busy}
                    className="text-cta hover:underline disabled:cursor-not-allowed disabled:text-l4 disabled:no-underline"
                    onClick={() => setManual(false)}
                  >
                    从列表选择
                  </button>
                )}
                {/* 目录拉不拉在于有没有地址和密钥；拉过了也能手动重拉（换了 Key 权限等） */}
                <button
                  type="button"
                  className="text-cta hover:underline disabled:cursor-not-allowed disabled:text-l4 disabled:no-underline"
                  disabled={catalogBusy || !urlOk || !apiKey.trim()}
                  onClick={() => {
                    catalogFor.current = "";
                    void loadCatalog();
                  }}
                >
                  {catalogBusy ? "正在获取模型列表…" : catalog ? "重新获取" : "获取模型列表"}
                </button>
              </div>
            </div>
            {picking ? (
              <MenuSelect
                aria-label="默认模型"
                disabled={!!busy}
                value={options.includes(model) ? model : ""}
                placeholder={`选一个模型（共 ${options.length} 个）`}
                options={[
                  ...options.map((m) => ({
                    value: m,
                    label: presetModels.includes(m) ? `${m}（推荐）` : m,
                    short: m,
                  })),
                  { value: MANUAL, label: "手动填写…" },
                ]}
                onChange={(val) => {
                  if (val === MANUAL) {
                    setManual(true);
                    setModelDraft(model);
                  } else {
                    setModelDraft(val);
                  }
                  setTested(false);
                  setError(null);
                }}
              />
            ) : (
              <>
                <input
                  id="onboarding-model"
                  className={surfaceFieldClass}
                  list="onboarding-model-options"
                  value={modelDraft ?? defaultModel}
                  placeholder={apiKey.trim() && urlOk ? "填模型名，或点右上「获取模型列表」" : "填好地址和 API Key 后可获取模型列表"}
                  onChange={(e) => {
                    setModelDraft(e.target.value);
                    setTested(false);
                    setError(null);
                  }}
                />
                <datalist id="onboarding-model-options">
                  {(catalog ?? presetModels).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </>
            )}
            {catalogError && <span className="mt-1 block text-xs leading-5 text-l4">{catalogError}</span>}
            {picking && !model && <span className="mt-1 block text-xs leading-5 text-l4">目录里有的模型不一定都能用，选你在服务商那边开通了的那个。</span>}
          </div>
          {error && <InlineNotice tone="err">{error}</InlineNotice>}
          {tested && !error && (
            <div role="status">
              <InlineNotice tone="ok">测试通过，可以保存</InlineNotice>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="submit" className={primaryActionClass} disabled={!!busy || !urlOk || !apiKey.trim() || !model}>
              {busy === "save" ? "保存中…" : busy === "test" ? "测试中…" : "测试并保存"}
            </button>
            {canProbe && (
              <button
                type="button"
                className={secondaryActionClass}
                disabled={!!busy || !urlOk || !apiKey.trim() || !model}
                onClick={() => void test()}
              >
                测试连接
              </button>
            )}
            <button type="button" className={quietActionClass} disabled={!!busy} onClick={onMore}>
              更多设置（网关库）
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}

/** 自填地址时说清这家 Agent 要哪种接口的地址（服务商文档里一般按协议分开给） */
const SLOT_HINT: Record<GatewaySlotName, string> = {
  anthropic: "填 Anthropic 兼容（Claude 格式）的地址，服务商文档里常写作 Claude Code 接入地址",
  responses: "填 OpenAI Responses 接口的地址（Codex 用这个），通常以 /v1 结尾",
  openai: "填 OpenAI 兼容（chat/completions）的地址，通常以 /v1 结尾",
  gemini: "填 Gemini 兼容的地址",
  cursor: "",
};

/** 自填地址的网关名取域名，网关库里一眼认得出 */
function customGatewayName(url: string): string {
  try {
    return new URL(url).host || "自定义服务商";
  } catch {
    return "自定义服务商";
  }
}

const MANUAL = "__manual__";
