import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { NO_PRESET_REASON, presetsForAgent } from "../presets";
import { slotForAgent, type GatewaySlotName } from "../gateway-slot";
import { fetchModelsInvokeArgs } from "../gateway-draft";
import {
  AGENT_PROTOCOLS,
  type BindingInput,
  type FetchModelsResultDto,
  type GatewayInput,
  type GatewayModel,
  type GatewayProbeDto,
} from "../types";
import { fieldClass, primaryActionClass, quietActionClass } from "./PageFrame";

/**
 * 上手向导里的精简「服务商 + API Key」接入：选预设服务商、贴密钥、测试、保存并绑定到这家 Agent，
 * 三步合一。下拉最后一项「其他服务商 / 中转」自填一个地址（只填这家 Agent 用的那个协议槽）；
 * 填好地址和密钥后自动拉这条地址的模型目录（fetch_models，与网关库同一条命令），拉到就给下拉选；
 * 不预选目录第一个——聚合站目录里常列着后台接不通的模型。多协议槽、请求头等仍去网关库（onMore）。
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
  const presets = useMemo(() => presetsForAgent(agent), [agent]);
  const [index, setIndex] = useState(0);
  // 下拉最后一项（index === presets.length）= 自填地址
  const custom = index >= presets.length;
  const preset = custom ? undefined : presets[index];
  const [customUrl, setCustomUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
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
  useEffect(() => {
    onBusyChange(!!busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  // Cursor 是自家协议、第三方端点接不通；Gemini 官方不需要填地址——这两家仍只给说明和网关库入口
  if (!presets.length) {
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

  const presetModels = preset?.provider.models ?? [];
  // 自填地址：qwen / kimi 的中转一般是 OpenAI 兼容，按 openai 协议接
  const protocol = custom ? (AGENT_PROTOCOLS[agent] ? "openai" : undefined) : preset!.protocol;
  const slot = slotForAgent(agent, protocol);
  const baseUrl = custom ? customUrl.trim() : preset!.baseUrl;
  const urlOk = /^https?:\/\/\S+$/i.test(baseUrl);
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
      if (!tested && !(await test())) return;
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

  return (
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset disabled={!!busy} className="min-w-0 space-y-4">
        <label className="block">
          <span className="text-xs text-l3">服务商</span>
          <select
            className={`${fieldClass} mt-1 w-full`}
            value={index}
            onChange={(e) => {
              setIndex(Number(e.target.value));
              setCustomUrl("");
              setModelDraft(null);
              resetCatalog();
              setTested(false);
              setError(null);
            }}
          >
            {presets.map((p, i) => (
              <option key={p.name} value={i}>
                {p.name}
              </option>
            ))}
            <option value={presets.length}>其他服务商 / 中转（自填地址）</option>
          </select>
          {preset?.note && <span className="mt-1 block text-xs leading-5 text-l4">{preset.note}</span>}
        </label>
        {custom && (
          <label className="block">
            <span className="text-xs text-l3">API 地址</span>
            <input
              type="url"
              autoComplete="off"
              spellCheck={false}
              className={`${fieldClass} mt-1 w-full`}
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
        <label className="block">
          <span className="text-xs text-l3">API Key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={`${fieldClass} mt-1 w-full`}
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
        </label>
        <div>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <label htmlFor="onboarding-model" className="text-l3">默认模型</label>
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
          {picking ? (
            <select
              id="onboarding-model"
              className={`${fieldClass} mt-1 w-full`}
              value={options.includes(model) ? model : ""}
              onChange={(e) => {
                if (e.target.value === MANUAL) {
                  setManual(true);
                  setModelDraft(model);
                } else {
                  setModelDraft(e.target.value);
                }
                setTested(false);
                setError(null);
              }}
            >
              <option value="" disabled>
                选一个模型（共 {options.length} 个）
              </option>
              {options.map((m) => (
                <option key={m} value={m}>
                  {presetModels.includes(m) ? `${m}（推荐）` : m}
                </option>
              ))}
              <option value={MANUAL}>手动填写…</option>
            </select>
          ) : (
            <>
              <input
                id="onboarding-model"
                className={`${fieldClass} mt-1 w-full`}
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
        {error && <p role="alert" className="text-xs leading-5 text-err-text">{error}</p>}
        {tested && !error && <p role="status" className="text-xs leading-5 text-ok-text">测试通过，可以保存</p>}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="submit" className={primaryActionClass} disabled={!!busy || !urlOk || !apiKey.trim() || !model}>
            {busy === "save" ? "保存中…" : busy === "test" ? "测试中…" : "测试并保存"}
          </button>
          <button type="button" className={quietActionClass} onClick={onMore}>
            更多设置（网关库）
          </button>
        </div>
      </fieldset>
    </form>
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

/** 基础请求失败时补一句下一步：401/403 多是密钥，404 多是地址或模型名，5xx 多是这个模型在服务商那边没有可用线路 */
function probeHint(message: string): string {
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (!status) return "";
  if (status === "401" || status === "403") return "。检查 API Key 是否填对、是否属于这家服务商。";
  if (status === "404") return "。检查地址和模型名是否和服务商文档一致。";
  if (status.startsWith("5") || status === "400") return "。可能是这个模型在服务商那边用不了，换一个模型再试。";
  return "";
}
