import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { NO_PRESET_REASON, presetsForAgent } from "../presets";
import { slotForAgent } from "../gateway-slot";
import type { BindingInput, GatewayInput, GatewayModel, GatewayProbeDto } from "../types";
import { fieldClass, primaryActionClass, quietActionClass } from "./PageFrame";

/**
 * 上手向导里的精简「服务商 + API Key」接入：选预设服务商、贴密钥、测试、保存并绑定到这家 Agent，
 * 三步合一。只覆盖预设里有的服务商；自定义端点、多协议槽、请求头等仍去网关库（onMore）。
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
  const preset = presets[index];
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

  if (!preset) {
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

  const presetModels = preset.provider.models ?? [];
  const model = (modelDraft ?? presetModels[0] ?? "").trim();
  const slot = slotForAgent(agent, preset.protocol);

  async function test(): Promise<boolean> {
    setBusy("test");
    setError(null);
    try {
      const dto = await invoke<GatewayProbeDto>("probe_gateway_slot", {
        gatewayId: null,
        slot,
        model: model || null,
        basicOnly: true,
        baseUrl: preset!.baseUrl,
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
      const slots = preset!.provider.slots;
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
        name: preset!.name,
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
        protocol: preset!.protocol ?? null,
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
          </select>
          {preset.note && <span className="mt-1 block text-xs leading-5 text-l4">{preset.note}</span>}
        </label>
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
            placeholder="模型名，如 deepseek-v4-flash"
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
          <button type="submit" className={primaryActionClass} disabled={!!busy || !apiKey.trim() || !model}>
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
