import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { NO_PRESET_REASON, presetsForAgent } from "../presets";
import { slotForAgent, type GatewaySlotName } from "../gateway-slot";
import { AGENT_PROTOCOLS, type BindingInput, type GatewayInput, type GatewayModel, type GatewayProbeDto } from "../types";
import { fieldClass, primaryActionClass, quietActionClass } from "./PageFrame";

/**
 * 上手向导里的精简「服务商 + API Key」接入：选预设服务商、贴密钥、测试、保存并绑定到这家 Agent，
 * 三步合一。下拉最后一项「其他服务商 / 中转」自填一个地址（只填这家 Agent 用的那个协议槽）；
 * 多协议槽、请求头、模型目录等仍去网关库（onMore）。
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
  const model = (modelDraft ?? presetModels[0] ?? "").trim();
  // 自填地址：qwen / kimi 的中转一般是 OpenAI 兼容，按 openai 协议接
  const protocol = custom ? (AGENT_PROTOCOLS[agent] ? "openai" : undefined) : preset!.protocol;
  const slot = slotForAgent(agent, protocol);
  const baseUrl = custom ? customUrl.trim() : preset!.baseUrl;
  const urlOk = /^https?:\/\/\S+$/i.test(baseUrl);

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
        setError(failed?.message ?? "测试失败，检查密钥和服务商是否对应");
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
                setTested(false);
                setError(null);
              }}
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
              setTested(false);
              setError(null);
            }}
          />
        </label>
        <label className="block">
          <span className="text-xs text-l3">默认模型</span>
          <input
            className={`${fieldClass} mt-1 w-full`}
            list="onboarding-model-options"
            value={modelDraft ?? presetModels[0] ?? ""}
            placeholder={presetModels.length ? "从列表选，或填服务商文档里的模型名" : "填服务商文档里的模型名"}
            onChange={(e) => {
              setModelDraft(e.target.value);
              setTested(false);
              setError(null);
            }}
          />
          <datalist id="onboarding-model-options">
            {presetModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
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
