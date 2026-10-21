import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { AGENTS, AGENT_PROTOCOLS } from "../types";
import { PROVIDER_PRESETS, type ProviderPreset } from "../presets";
import { vendorForGateway } from "../vendor-icon";
import VendorIcon from "./VendorIcon";
import { mergeGatewayCatalog } from "../gateway-catalog";
import { Checkbox, fieldClass, FoldMark, ghostActionClass, primaryActionClass, searchFieldClass, secondaryActionClass, NoticeBar, InlineNotice } from "./PageFrame";
import { parseReasoningEffort, reasoningEffortValue } from "../reasoning-effort";
import { confirmDialog } from "./ConfirmDialog";
import { toast } from "../toast";
import { scheduleWarnText, sumRefs, usageWarnText, type UnbindRefs } from "../unbind-impact";
import { policyFieldHint, policyFieldMode } from "../combo-field";
import {
  EMPTY_CAPS_FORM,
  capsFormFromOverride,
  capsFormIsEmpty,
  parseCapsOverrideForm,
  type CapsOverrideFormState,
  type TriState,
} from "../model-caps-override";
import { type GatewaySlotName } from "../gateway-slot";
import { groupModelsByVendor, visibleVendorGroups } from "../model-vendors";
import {
  applyFetchedCatalog,
  catalogFetchNotice,
  catalogFetchSlot,
  catalogSlotWalkOrder,
  effectiveSlotUrl,
  fetchModelsInvokeArgs,
  primaryProbeSlot,
  parseHeaderEnv,
  probeDtoToSummary,
  responsesSlotUrlWarning,
  zhipuOpenAiSlotBillingHint,
  slotsFollowMaster,
} from "../gateway-draft";
import { gatewayPickerRows } from "../gateway-option";
import { gatewayHasWallet } from "../gateway-balance";
import type {
  BindingInput,
  ComboSurfaceDto,
  FetchGatewayCatalogDto,
  FetchModelsResultDto,
  Gateway,
  GatewayInput,
  GatewayModel,
  GatewayProbeDto,
  GatewayUsageRow,
  ModelCapabilityDto,
  ModelCapsOverrideDto,
  Profile,
  ProtocolSlots,
  ScheduleDto,
  SlotProbeSummary,
} from "../types";

const SLOT_LABELS: { key: keyof ProtocolSlots; label: string }[] = [
  { key: "anthropic", label: "Anthropic" },
  { key: "openai", label: "OpenAI 兼容" },
  { key: "responses", label: "Responses（Codex）" },
  { key: "gemini", label: "Gemini" },
  { key: "cursor", label: "Cursor" },
];

function emptySlots(): ProtocolSlots {
  return { anthropic: "", openai: "", responses: "", gemini: "", cursor: "" };
}

function numOrNull(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function probeSummaryText(sum: SlotProbeSummary | undefined): string {
  if (!sum || sum.lastOk == null) return "— 未测";
  if (sum.lastOk) {
    return sum.lastLatencyMs != null ? `✓ ${sum.lastLatencyMs}ms` : "✓";
  }
  return "✗ 失败";
}

function ModelClassFilter({
  ids,
  vendor,
  onVendor,
  filter,
  onFilter,
}: {
  ids: string[];
  vendor: string;
  onVendor: (vendor: string) => void;
  filter: string;
  onFilter: (value: string) => void;
}) {
  const groups = groupModelsByVendor(ids);
  return (
    <div className="space-y-1">
      <input
        className={`${searchFieldClass} w-full`}
        placeholder="筛选模型名…"
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
      />
      {groups.length > 1 && (
        <div
          className="flex max-h-16 flex-wrap gap-1 overflow-auto"
          role="radiogroup"
          aria-label="模型分类"
        >
          <button
            type="button"
            role="radio"
            aria-checked={vendor === "all"}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs ${
              vendor === "all" ? "bg-seg-sel text-l1" : "text-l3 hover:bg-hover hover:text-l1"
            }`}
            onClick={() => onVendor("all")}
          >
            全部
            <span className="text-micro text-l4">{ids.length}</span>
          </button>
          {groups.map((group) => {
            const selected = vendor === group.vendor;
            return (
              <button
                key={group.vendor}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs ${
                  selected ? "bg-seg-sel text-l1" : "text-l3 hover:bg-hover hover:text-l1"
                }`}
                onClick={() => onVendor(group.vendor)}
              >
                {group.vendor}
                <span className="text-micro text-l4">{group.models.length}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VendorModelSections({
  ids,
  vendor,
  filter,
  openVendors,
  onToggle,
  renderItem,
}: {
  ids: string[];
  vendor: string;
  filter: string;
  openVendors: ReadonlySet<string>;
  onToggle: (vendor: string) => void;
  renderItem: (id: string) => ReactNode;
}) {
  const groups = visibleVendorGroups(ids, vendor, filter);
  if (groups.length === 0) {
    return <p className="px-1 py-1 text-xs text-l4">没有匹配的模型</p>;
  }
  const searching = filter.trim() !== "";
  const foldVendors = vendor === "all" && groups.length > 1 && !searching;
  return (
    <div>
      {groups.map((group) => {
        const open = !foldVendors || openVendors.has(group.vendor);
        return (
          <div key={group.vendor}>
            {foldVendors && (
              <button
                type="button"
                className="flex min-h-7 w-full items-center gap-1.5 text-left text-xs font-medium text-l2 hover:text-l1"
                onClick={() => onToggle(group.vendor)}
              >
                <FoldMark open={open} />
                <span className="min-w-0 flex-1 truncate">{group.vendor}</span>
                <span className="text-micro text-l4">{group.models.length}</span>
              </button>
            )}
            {open && group.models.map((id) => (
              <Fragment key={id}>{renderItem(id)}</Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function ReasoningEffortPicker({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  onChange: (next: string | null) => void;
}) {
  const parsed = parseReasoningEffort(value);
  return (
    <div className="mt-0.5 space-y-1">
      <div className="flex flex-wrap gap-x-2 gap-y-1">
        {REASONING_LEVELS.map((level) => (
          <Checkbox
            key={level}
            checked={parsed.levels.includes(level)}
            disabled={disabled}
            label={<span className="font-mono text-micro">{level}</span>}
            onChange={(on) => {
              const levels = on
                ? [...parsed.levels, level]
                : parsed.levels.filter((item) => item !== level);
              const ordered = REASONING_LEVELS.filter((item) => levels.includes(item));
              const launch =
                parsed.launch && ordered.includes(parsed.launch)
                  ? parsed.launch
                  : ordered.includes("high")
                    ? "high"
                    : (ordered[0] ?? null);
              onChange(reasoningEffortValue(ordered, launch));
            }}
          />
        ))}
      </div>
      {parsed.levels.length > 1 && (
        <label className="block text-micro text-l4">
          开场默认
          <select
            className={`${fieldClass} mt-0.5 w-full`}
            disabled={disabled}
            value={parsed.launch ?? parsed.levels[0]}
            onChange={(e) => onChange(reasoningEffortValue(parsed.levels, e.target.value))}
          >
            {parsed.levels.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </label>
      )}
      <p className="text-micro text-l4">勾选的档位可在会话里切换。开场只用其中一档。</p>
    </div>
  );
}

function catalogAge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 16).replace("T", " ");
  const days = Math.max(0, Math.floor((Date.now() - t) / 86400000));
  if (days === 0) return "今天获取";
  if (days === 1) return "1 天前获取";
  return `${days} 天前获取`;
}

export default function GatewayLibrary({
  onClose,
  onJumpUsage,
  initialId,
  initialNew,
}: {
  onClose: () => void;
  onJumpUsage?: (gatewayId: string) => void;
  initialId?: string | null;
  /** 打开即进「新建网关」表单（上手引导「打开网关库」） */
  initialNew?: boolean;
}) {
  const gateways = useAppStore((s) => s.gateways);
  const profiles = useAppStore((s) => s.profiles);
  const loadGateways = useAppStore((s) => s.loadGateways);
  const saveGateway = useAppStore((s) => s.saveGateway);
  const removeGateway = useAppStore((s) => s.removeGateway);
  const bindGateway = useAppStore((s) => s.bindGateway);
  const [editing, setEditing] = useState<Gateway | "new" | null>(null);
  const [name, setName] = useState("");
  const [noAuth, setNoAuth] = useState(false);
  const [slots, setSlots] = useState<ProtocolSlots>(emptySlots());
  // Base URL 主输入：中转站九成情况五个协议槽同址。值为空的槽与「仍等于旧主值」的槽
  // 跟随主输入；手动改过的槽脱离跟随（镜像到改写为止的经典交互）
  const [masterUrl, setMasterUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [walletToken, setWalletToken] = useState("");
  const [walletUserId, setWalletUserId] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [models, setModels] = useState<GatewayModel[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [comboByModel, setComboByModel] = useState<Record<string, ComboSurfaceDto>>({});
  const [caps, setCaps] = useState<Record<string, ModelCapabilityDto>>({});
  // 能力声明覆盖（注册链最高层）：列表整体读一次，表单按模型懒初始化
  const [capOverrides, setCapOverrides] = useState<Record<string, ModelCapsOverrideDto>>({});
  const [capForms, setCapForms] = useState<Record<string, CapsOverrideFormState>>({});
  const [capOverridesLoaded, setCapOverridesLoaded] = useState(false);
  const [capPending, setCapPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fetchingCatalog, setFetchingCatalog] = useState(false);
  const [listFetchingId, setListFetchingId] = useState<string | null>(null);
  const [probingSlot, setProbingSlot] = useState<string | null>(null);
  const [probingAll, setProbingAll] = useState(false);
  const [bindAgent, setBindAgent] = useState("");
  const [bindProtocol, setBindProtocol] = useState("");
  const [bindModels, setBindModels] = useState<string[]>([]);
  const [monthUsage, setMonthUsage] = useState<GatewayUsageRow[]>([]);
  const [draftProbes, setDraftProbes] = useState<Record<string, SlotProbeSummary>>({});
  const [showSlots, setShowSlots] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showBind, setShowBind] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [policyFilter, setPolicyFilter] = useState("");
  const [policyVendor, setPolicyVendor] = useState("all");
  const [policyOpenVendors, setPolicyOpenVendors] = useState<ReadonlySet<string>>(new Set());
  const [bindFilter, setBindFilter] = useState("");
  const [bindVendor, setBindVendor] = useState("all");
  const [bindOpenVendors, setBindOpenVendors] = useState<ReadonlySet<string>>(new Set());
  const modelSurfaceGen = useRef(0);
  // 「Agent 配置」区：新建网关保存后滚到这里接着绑
  const bindSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadGateways().catch((e) => {
      setError(`网关列表加载失败：${String(e)}`);
    });
    invoke<GatewayUsageRow[]>("usage_by_gateway", { range: "month" })
      .then(setMonthUsage)
      .catch(() => setMonthUsage([]));
  }, [loadGateways]);

  const openedInitial = useRef(false);
  useEffect(() => {
    if (openedInitial.current) return;
    if (initialNew && !initialId) {
      openedInitial.current = true;
      openEdit("new");
      return;
    }
    if (!initialId) return;
    const g = gateways.find((x) => x.id === initialId);
    if (g) {
      openedInitial.current = true;
      openEdit(g);
    }
  }, [initialId, initialNew, gateways]);

  const rate = useAppStore((s) => s.settings?.rateUsdCny) ?? 7.2;

  function openEdit(g: Gateway | "new") {
    modelSurfaceGen.current += 1;
    setError(null);
    setNotice(null);
    setExpanded(null);
    setComboByModel({});
    setCapOverrides({});
    setCapForms({});
    setCapOverridesLoaded(false);
    setCapPending(null);
    setDraftProbes({});
    setShowAdvanced(false);
    setShowBind(false);
    setShowModels(false);
    setPolicyFilter("");
    setPolicyVendor("all");
    setPolicyOpenVendors(new Set());
    setBindFilter("");
    setBindVendor("all");
    setBindOpenVendors(new Set());
    if (g === "new") {
      setEditing("new");
      setName("");
      setNoAuth(false);
      setSlots(emptySlots());
      setMasterUrl("");
      setApiKey("");
      setWalletToken("");
      setWalletUserId("");
      setHeaderText("");
      setModels([]);
      setShowSlots(false);
      return;
    }
    setEditing(g);
    setName(g.name);
    setNoAuth(g.noAuth);
    // 还没有任何绑定的网关直接展开 Agent 配置区——打开就是为了接着绑，不必再找折叠项
    setShowBind(profiles.filter((p) => p.gatewayId === g.id).length === 0);
    const next = {
      anthropic: g.slots.anthropic ?? "",
      openai: g.slots.openai ?? "",
      responses: g.slots.responses ?? "",
      gemini: g.slots.gemini ?? "",
      cursor: g.slots.cursor ?? "",
    };
    setSlots(next);
    // 主输入初值：所有已填槽同址时取该址（跟随关系天然成立），混址时留空不强猜
    const filled = Object.values(next).filter((v) => v.trim());
    const master =
      filled.length > 0 && filled.every((v) => v.trim() === filled[0].trim()) ? filled[0] : "";
    setMasterUrl(master);
    setShowSlots(!slotsFollowMaster(next, master));
    setApiKey("");
    setWalletToken("");
    setWalletUserId(g.walletUserId ?? "");
    setHeaderText(
      Object.entries(g.headerEnv)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
    setModels(g.models.map((m) => ({ ...m })));
  }

  /** 主输入变更：空槽与跟随中的槽（仍等于旧主值）一起改，手动改过的槽不动 */
  function onMasterChange(v: string) {
    const prev = masterUrl;
    setMasterUrl(v);
    setSlots((s) => {
      const out = { ...s };
      for (const { key } of SLOT_LABELS) {
        const cur = (s[key] ?? "").trim();
        if (cur === "" || cur === prev.trim()) out[key] = v;
      }
      return out;
    });
  }

  const modelIdsKey = models.map((m) => m.id).join("\u0001");
  async function loadModelSurface(ids: string[]) {
    if (editing === null || editing === "new" || ids.length === 0) return;
    const gatewayId = editing.id;
    const gen = ++modelSurfaceGen.current;
    const [combo, capability] = await Promise.allSettled([
      invoke<ComboSurfaceDto[]>("combo_surface_for_gateway_batch", {
        gatewayId,
        models: ids,
      }),
      invoke<ModelCapabilityDto[]>("model_capabilities", {
        models: ids,
        gatewayId,
      }),
    ]);
    if (gen !== modelSurfaceGen.current) return;
    const failures: string[] = [];
    if (combo.status === "fulfilled") {
      setComboByModel((current) => ({
        ...current,
        ...combo.value.reduce<Record<string, ComboSurfaceDto>>((all, item) => {
          all[item.model] = item;
          return all;
        }, {}),
      }));
    } else {
      failures.push(`模型策略加载失败：${String(combo.reason)}`);
    }
    if (capability.status === "fulfilled") {
      setCaps((current) => ({
        ...current,
        ...capability.value.reduce<Record<string, ModelCapabilityDto>>((all, item) => {
          all[item.model] = item;
          return all;
        }, {}),
      }));
    } else {
      failures.push(`模型能力加载失败：${String(capability.reason)}`);
    }
    if (failures.length) setError(failures.join("；"));
  }

  useEffect(() => {
    if (editing === null || editing === "new") return;
    // 首屏只批量预取前 24 个模型；其余模型在展开行时懒加载，避免大目录打开即打满 IPC。
    void loadModelSurface(models.slice(0, 24).map((m) => m.id));
    // modelIdsKey 只在目录增删模型时变化，编辑策略字段不会重复触发 IPC。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, modelIdsKey]);

  function patchModel(id: string, patch: Partial<GatewayModel>) {
    setModels((cur) => cur.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  function patchCapForm(id: string, patch: Partial<CapsOverrideFormState>) {
    setCapForms((cur) => ({
      ...cur,
      [id]: { ...(cur[id] ?? EMPTY_CAPS_FORM), ...patch },
    }));
  }

  /** 展开模型行时按需载入覆盖列表并落表单初值（只落一次，不覆盖编辑中的草稿） */
  async function ensureCapOverrideForm(modelId: string) {
    let map = capOverrides;
    if (!capOverridesLoaded) {
      try {
        const list = await invoke<ModelCapsOverrideDto[]>("list_model_capability_overrides");
        map = Object.fromEntries(list.map((e) => [e.prefix, e]));
        setCapOverrides(map);
        setCapOverridesLoaded(true);
      } catch (e) {
        setError(`能力声明读取失败：${String(e)}`);
        return;
      }
    }
    setCapForms((cur) =>
      cur[modelId]
        ? cur
        : { ...cur, [modelId]: capsFormFromOverride(map[modelId] ?? EMPTY_CAPS_FORM) },
    );
  }

  /** 保存/清除单条能力声明；保存后刷新解析值，行徽章立即反映覆盖生效 */
  async function saveCapOverride(m: GatewayModel) {
    const form = capForms[m.id] ?? EMPTY_CAPS_FORM;
    if (capsFormIsEmpty(form)) {
      await clearCapOverride(m);
      return;
    }
    const parsed = parseCapsOverrideForm(form);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setCapPending(m.id);
    try {
      const list = await invoke<ModelCapsOverrideDto[]>("set_model_capability_override", {
        entry: {
          prefix: m.id,
          thinking: parsed.fields.thinking,
          context: parsed.fields.context,
          vision: parsed.fields.vision,
          // output/api_backend 不进 UI：output 的用户旋钮是上面的 max output（策略），
          // 能力层的 output 只喂 opencode limit.output（有兜底）；保存时原样保留不丢
          output: capOverrides[m.id]?.output ?? null,
          api_backend: capOverrides[m.id]?.api_backend ?? null,
        },
      });
      setCapOverrides(Object.fromEntries(list.map((e) => [e.prefix, e])));
      await loadModelSurface([m.id]);
      setError(null);
      setNotice(`已保存 ${m.id} 的能力声明`);
    } catch (e) {
      setError(`能力声明保存失败：${String(e)}`);
    } finally {
      setCapPending(null);
    }
  }

  async function clearCapOverride(m: GatewayModel) {
    if (!capOverrides[m.id]) {
      setNotice("这条模型没有已保存的能力声明");
      return;
    }
    setCapPending(m.id);
    try {
      const list = await invoke<ModelCapsOverrideDto[]>("clear_model_capability_override", {
        prefix: m.id,
      });
      setCapOverrides(Object.fromEntries(list.map((e) => [e.prefix, e])));
      setCapForms((cur) => ({ ...cur, [m.id]: { ...EMPTY_CAPS_FORM } }));
      await loadModelSurface([m.id]);
      setNotice(`已清除 ${m.id} 的能力声明`);
    } catch (e) {
      setError(`能力声明清除失败：${String(e)}`);
    } finally {
      setCapPending(null);
    }
  }

  const showWalletFields = useMemo(
    () =>
      gatewayHasWallet({
        slots: {
          anthropic: slots.anthropic || masterUrl,
          openai: slots.openai || masterUrl,
          responses: slots.responses || masterUrl,
          gemini: slots.gemini || masterUrl,
          cursor: slots.cursor || masterUrl,
        },
      }),
    [slots, masterUrl],
  );

  function slotSum(key: keyof ProtocolSlots): SlotProbeSummary | undefined {
    if (draftProbes[key]) return draftProbes[key];
    if (editing === null || editing === "new") return undefined;
    return (editing.slotProbes ?? []).find((s) => s.slot === key);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const headerEnv = parseHeaderEnv(headerText);
    const input: GatewayInput = {
      name: name.trim() || "未命名网关",
      noAuth,
      slots: {
        anthropic: effectiveSlotUrl(slots, "anthropic", masterUrl) || null,
        openai: effectiveSlotUrl(slots, "openai", masterUrl) || null,
        responses: effectiveSlotUrl(slots, "responses", masterUrl) || null,
        gemini: effectiveSlotUrl(slots, "gemini", masterUrl) || null,
        cursor: effectiveSlotUrl(slots, "cursor", masterUrl) || null,
      },
      headerEnv,
      models,
      apiKey: apiKey.trim() || null,
      clearKey: editing !== "new" && editing !== null && noAuth && !apiKey.trim(),
      expectedRevision: editing === "new" || editing === null ? null : editing.revision ?? null,
      walletAccessToken: walletToken.trim() || null,
      walletUserId,
    };
    const id = editing === "new" || editing === null ? null : editing.id;
    try {
      const saved = await saveGateway(id, input);
      // store 刷新后的列表元素带 slotProbes，比 command 返回值更完整；id 以返回值为准不猜末位
      const fresh = useAppStore
        .getState()
        .gateways.find((g) => g.id === saved.id);
      if (fresh) setEditing(fresh);
      // 新建即绑：保存后直接展开 Agent 配置区（此时 editing 已切到保存后的网关），
      // 消除「保存 → 重新找入口 → 展开折叠 → 选 Agent」的往返。保存钮在表单最底下，
      // 结果提示在吸顶的头部里（原先在表单顶上，点完保存看不见），绑定区滚进视野
      if (!id) {
        setShowBind(true);
        setNotice(
          `网关「${saved.name}」已保存。接着在下方 Agent 配置里选要用的 Agent 和模型。`,
        );
        requestAnimationFrame(() =>
          bindSectionRef.current?.scrollIntoView({ block: "nearest" }),
        );
      } else {
        toast(`网关「${saved.name}」已保存`, "success");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  /** 端点预设一键填充（新建表单）：同址只填 Base URL 主输入、槽位跟随；
      分槽供应商（智谱）各槽直填并展开槽位区；推荐模型只在目录为空时播种，不动手填内容 */
  function applyProviderPreset(preset: ProviderPreset) {
    setName((cur) => cur.trim() || preset.name);
    setNoAuth(preset.noAuth ?? false);
    const entries = Object.entries(preset.slots) as [
      keyof ProtocolSlots,
      string,
    ][];
    const urls = entries.map(([, v]) => v);
    if (urls.length > 0 && urls.every((v) => v === urls[0])) {
      setMasterUrl(urls[0]);
      setSlots(emptySlots());
      setShowSlots(false);
    } else {
      const next = emptySlots();
      for (const [k, v] of entries) next[k] = v;
      setSlots(next);
      setMasterUrl("");
      setShowSlots(true);
    }
    if (preset.models?.length) {
      setModels((cur) =>
        cur.length
          ? cur
          : preset.models!.map((id) => ({
              id,
              source: "user",
              status: "available",
              lastSeenAt: null,
              catalogSlot: null,
              temperature: null,
              topP: null,
              maxOutputTokens: null,
              reasoningEffort: null,
            })),
      );
    }
  }

  async function onClearKey() {
    if (editing === null || editing === "new") return;
    const n = profiles.filter((p) => p.gatewayId === editing.id).length;
    const extra = n > 1 ? `共用这个网关的 ${n} 个 Agent 都会没密钥。` : "";
    if (
      !(await confirmDialog(`清除「${editing.name}」的本地密钥？${extra}`, { danger: true }))
    )
      return;
    try {
      await invoke("clear_gateway_key", { id: editing.id });
      await loadGateways();
      const list = await invoke<Gateway[]>("list_gateways");
      const fresh = list.find((g) => g.id === editing.id);
      if (fresh) setEditing(fresh);
      setApiKey("");
      setNotice("已清除本地密钥");
    } catch (e) {
      setError(String(e));
    }
  }

  async function onClearWalletToken() {
    if (editing === null || editing === "new") return;
    if (
      !(await confirmDialog(`清除「${editing.name}」的系统访问令牌？用量页将不再查钱包余额。`, {
        danger: true,
      }))
    )
      return;
    try {
      await invoke("clear_gateway_wallet_token", { id: editing.id });
      await loadGateways();
      const list = await invoke<Gateway[]>("list_gateways");
      const fresh = list.find((g) => g.id === editing.id);
      if (fresh) setEditing(fresh);
      setWalletToken("");
      setNotice("已清除系统访问令牌");
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDelete(g: Gateway) {
    const bound = profiles.filter((p) => p.gatewayId === g.id);
    if (bound.length) {
      await onUnbindAndDelete(g, bound);
      return;
    }
    if (!(await confirmDialog(`删除网关「${g.name}」？密钥一并删除。`, { danger: true })))
      return;
    try {
      await removeGateway(g.id);
    } catch (e) {
      setError(String(e));
    }
  }

  // 解绑并删除：把挂在这个网关上的连接逐条解绑（与连接页「解绑」同一后端命令与清理口径），
  // 再删网关。事前摊开影响面，定时任务仍按 fail-loud 不改投。
  async function onUnbindAndDelete(g: Gateway, bound: Profile[]) {
    const ids = new Set(bound.map((p) => p.id));
    const schedules = await invoke<ScheduleDto[]>("list_schedules")
      .then((all) => all.filter((s) => s.profileId && ids.has(s.profileId)))
      .catch(() => [] as ScheduleDto[]);
    const refs = await Promise.all(
      bound.map((p) =>
        invoke<UnbindRefs>("profile_usage_refs", { id: p.id }).catch(() => null),
      ),
    ).then((list) => sumRefs(list.filter((r): r is UnbindRefs => r !== null)));
    const lines = bound
      .slice(0, 8)
      .map((p) => `· ${AGENTS.find((a) => a.id === p.agent)?.label ?? p.agent}「${p.name}」`)
      .join("\n");
    const more = bound.length > 8 ? `\n· 等共 ${bound.length} 个` : "";
    const ok = await confirmDialog(
      `「${g.name}」还有 ${bound.length} 个连接在用：\n${lines}${more}\n\n` +
        `将先解绑这些连接，再删除网关，密钥一并删除。${usageWarnText(refs)}${scheduleWarnText(schedules)}`,
      { danger: true, confirmText: "解绑并删除" },
    );
    if (!ok) return;
    try {
      for (const p of bound) await invoke("delete_profile", { id: p.id });
      await removeGateway(g.id);
      await useAppStore.getState().loadAll();
    } catch (e) {
      await useAppStore.getState().loadAll();
      setError(`解绑并删除没有全部完成：${String(e)}`);
    }
  }

  async function undoMerge() {
    try {
      const n = await invoke<number>("unbind_split_merge");
      setNotice(n ? `已拆开 ${n} 条被合并的绑定` : "没有可拆开的自动合并");
      await loadGateways();
      await useAppStore.getState().loadAll();
    } catch (e) {
      setError(String(e));
    }
  }

  async function refreshListedCatalog(g: Gateway) {
    setListFetchingId(g.id);
    setError(null);
    setNotice(null);
    try {
      const result = await invoke<FetchGatewayCatalogDto>("fetch_gateway_catalog", {
        gatewayId: g.id,
        preferSlot: g.catalogFromSlot,
      });
      await loadGateways();
      const n = result.gateway.models.filter((m) => m.status !== "stale").length;
      setNotice(
        `${catalogFetchNotice(n, result.capabilityMetadataCount, result.gateway.catalogFromSlot)}绑定里已勾选的名单不会自动改，编辑连接时再勾选新模型。`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setListFetchingId(null);
    }
  }

  async function fetchCatalog() {
    const prefer = editing !== null && editing !== "new" ? editing.catalogFromSlot : null;
    const start = catalogFetchSlot(slots, masterUrl, prefer);
    if (!start) {
      setError("先填 Base URL 或某个协议槽");
      return;
    }
    setFetchingCatalog(true);
    setError(null);
    const gatewayId = editing !== null && editing !== "new" ? editing.id : null;
    let lastError = "没有可拉取的协议槽";
    try {
      for (const slot of catalogSlotWalkOrder(prefer)) {
        const baseUrl = effectiveSlotUrl(slots, slot, masterUrl);
        if (!baseUrl) continue;
        try {
          const result = await invoke<FetchModelsResultDto>(
            "fetch_models",
            fetchModelsInvokeArgs({
              baseUrl,
              apiKey,
              noAuth,
              slot,
              gatewayId,
            }),
          );
          if (result.models.length === 0) {
            lastError = `${slot} 槽返回空目录`;
            continue;
          }
          setModels(applyFetchedCatalog(models, result, slot, mergeGatewayCatalog));
          setNotice(
            `${catalogFetchNotice(result.models.length, result.capabilityMetadataCount, slot)}确认无误后点保存。`,
          );
          return;
        } catch (e) {
          lastError = String(e);
        }
      }
      setError(lastError);
    } finally {
      setFetchingCatalog(false);
    }
  }

  async function probeOne(slot: GatewaySlotName, basicOnly: boolean) {
    if (slot === "cursor" || slot === "gemini") {
      setError(slot === "cursor" ? "Cursor 为专有协议，不支持网关体检" : "Gemini 协议暂不支持网关体检");
      return;
    }
    const baseUrl = effectiveSlotUrl(slots, slot, masterUrl);
    if (!baseUrl) {
      setError("先填 Base URL 或这个槽的地址");
      return;
    }
    setProbingSlot(slot);
    setError(null);
    try {
      const dto = await invoke<GatewayProbeDto>("probe_gateway_slot", {
        gatewayId: editing !== null && editing !== "new" ? editing.id : null,
        slot,
        model:
          models.find((m) => m.status !== "stale" && m.catalogSlot === slot)?.id ??
          models.find((m) => m.status !== "stale")?.id ??
          null,
        basicOnly,
        baseUrl,
        apiKey: noAuth ? null : apiKey.trim() || null,
        noAuth,
      });
      setDraftProbes((cur) => ({ ...cur, [slot]: probeDtoToSummary(slot, dto) }));
      if (dto.ok) {
        setNotice("测试通过，可以保存");
        const list = await invoke<Gateway[]>("list_gateways");
        const id = editing !== null && editing !== "new" ? editing.id : null;
        const fresh = id ? list.find((g) => g.id === id) : null;
        if (fresh) setEditing(fresh);
        await loadGateways();
      } else {
        const failed = dto.checks.find((c) => c.status === "failed");
        setError(failed?.message ?? "测试失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setProbingSlot(null);
    }
  }

  async function probeAll() {
    const filled = SLOT_LABELS.map((s) => s.key).filter(
      (k) =>
        k !== "cursor" &&
        k !== "gemini" &&
        Boolean(effectiveSlotUrl(slots, k, masterUrl)),
    );
    if (filled.length === 0) {
      setError("先填 Base URL 或某个协议槽");
      return;
    }
    setProbingAll(true);
    setError(null);
    let anyOk = false;
    try {
      // 同一 URL 也不能跨协议槽复用完整体检结果：OpenAI/Responses/Anthropic
      // 的请求体、鉴权头和默认模型可能不同。只保留「每个支持体检的槽各测一次」，
      // 避免把一个协议成功错误镜像成另一个协议成功。
      for (const slot of filled) {
        try {
          const dto = await invoke<GatewayProbeDto>("probe_gateway_slot", {
            gatewayId: editing !== null && editing !== "new" ? editing.id : null,
            slot,
            model:
              models.find((m) => m.status !== "stale" && m.catalogSlot === slot)?.id ??
              models.find((m) => m.status !== "stale")?.id ??
              null,
            basicOnly: true,
            baseUrl: effectiveSlotUrl(slots, slot, masterUrl),
            apiKey: noAuth ? null : apiKey.trim() || null,
            noAuth,
          });
          setDraftProbes((cur) => ({ ...cur, [slot]: probeDtoToSummary(slot, dto) }));
          if (dto.ok) anyOk = true;
          else if (!anyOk) {
            const failed = dto.checks.find((c) => c.status === "failed");
            setError(failed?.message ?? "测试失败");
          }
        } catch (e) {
          setError(String(e));
        }
      }
      if (anyOk) setNotice("测试通过，可以保存");
      const id = editing !== null && editing !== "new" ? editing.id : null;
      if (id) {
        const list = await invoke<Gateway[]>("list_gateways");
        const fresh = list.find((g) => g.id === id);
        if (fresh) setEditing(fresh);
        await loadGateways();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setProbingAll(false);
    }
  }

  async function bindToAgent() {
    if (editing === null || editing === "new" || !bindAgent) return;
    const selected = bindModels.filter(Boolean);
    if (!selected.length) {
      setError("请勾选这条绑定要使用的模型，并确认第一个为默认");
      return;
    }
    const proto = AGENT_PROTOCOLS[bindAgent];
    const input: BindingInput = {
      agent: bindAgent,
      name: `${editing.name} · ${AGENTS.find((a) => a.id === bindAgent)?.label ?? bindAgent}`,
      gatewayId: editing.id,
      kind: "api",
      protocol: proto ? (bindProtocol || proto.default) : null,
      models: selected,
      extraEnv: {},
    };
    try {
      await bindGateway(input);
      setNotice(
        `已添加 ${AGENTS.find((a) => a.id === bindAgent)?.label ?? bindAgent} 配置，默认模型 ${selected[0]}。不改 Mesa 启动预选，也不写 CLI 全局文件。`,
      );
      setBindAgent("");
      setBindProtocol("");
      await useAppStore.getState().loadAll();
    } catch (e) {
      setError(String(e));
    }
  }

  const boundAgents = useMemo(() => {
    if (editing === null || editing === "new") return [];
    return profiles.filter((p) => p.gatewayId === editing.id);
  }, [editing, profiles]);

  const catalogModels = models.filter((m) => m.status !== "stale");
  const primarySlot = primaryProbeSlot(
    slots,
    masterUrl,
    editing !== null && editing !== "new" ? editing.catalogFromSlot : null,
  );
  const primaryProbe = primarySlot ? slotSum(primarySlot) : undefined;
  const slotsTogether = slotsFollowMaster(slots, masterUrl);
  // Codex（responses 槽）端点告警：跟随主输入或槽自填的最终生效地址都看
  const responsesUrlWarn = responsesSlotUrlWarning(
    effectiveSlotUrl(slots, "responses", masterUrl),
  );
  const openaiBillingHint = zhipuOpenAiSlotBillingHint(
    effectiveSlotUrl(slots, "openai", masterUrl),
  );

  function usageLine(g: Gateway): string | null {
    const row = monthUsage.find((r) => r.bucket === "gateway" && r.gatewayId === g.id);
    if (!row) return null;
    const yen =
      row.costUsd != null ? `¥${(row.costUsd * rate).toFixed(1)}` : "~";
    return `近 30 天 ${yen} · ${row.sessionCount} 会话`;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gateway-library-title"
        tabIndex={-1}
        data-surface="canvas"
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border border-hairline bg-canvas p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部吸顶：标题、关闭与结果提示随时看得见——表单很长、保存钮在最底下，
            提示原先落在表单顶上，点完保存看不见。负边距抵掉面板内边距，底色盖住滚过去的内容 */}
        <div className="sticky -top-4 z-10 -mx-4 -mt-4 space-y-3 bg-canvas px-4 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <h2 id="gateway-library-title" className="text-base font-medium text-l1">网关库</h2>
          <div className="flex items-center gap-2">
            {/* 少用的恢复动作：原先与「新建网关」同级的次按钮、名字又是内部词，降为带说明的文字钮 */}
            <button
              type="button"
              className={`${ghostActionClass} text-l4`}
              title="把旧版本升级时自动合并到同一网关的连接拆回各自的网关（只在合并结果不对时用）"
              onClick={() => void undoMerge()}
            >
              拆开自动合并的连接
            </button>
            <button type="button" className={primaryActionClass} onClick={() => openEdit("new")}>
              + 新建网关
            </button>
            <button type="button" className={secondaryActionClass} onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        {error && <NoticeBar tone="err" onDismiss={() => setError(null)}>{error}</NoticeBar>}
        {notice && <NoticeBar onDismiss={() => setNotice(null)}>{notice}</NoticeBar>}
        </div>
        {editing ? (
          <div className="space-y-2">
            {editing === "new" && (
              <label className="block text-sm text-l2">
                端点预设
                <select
                  className={`${fieldClass} mt-1 w-full`}
                  value=""
                  onChange={(e) => {
                    const preset = PROVIDER_PRESETS.find(
                      (p) => p.name === e.target.value,
                    );
                    if (preset) applyProviderPreset(preset);
                  }}
                >
                  <option value="" disabled>
                    选一家供应商，自动填地址、槽位和推荐模型…
                  </option>
                  {PROVIDER_PRESETS.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {p.models?.length ? " · 含推荐模型" : ""}
                      {p.confidence === "official" ? " · 官方" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-sm text-l2">
              名称
              <input className={`${fieldClass} mt-1 w-full`} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <Checkbox
              className="text-sm text-l2"
              checked={noAuth}
              onChange={setNoAuth}
              label="无密钥（本地端点）"
            />
            <label className="block text-sm text-l2">
              <span className="flex items-center justify-between gap-2">
                <span>Base URL</span>
                <span className="font-mono text-micro text-l4">
                  {probeSummaryText(primaryProbe)}
                </span>
              </span>
              <input
                className={`${fieldClass} mt-1 w-full font-mono text-xs`}
                value={masterUrl}
                placeholder="https://…（同址时只填这里）"
                title="空槽与仍等于主输入的槽一起改；某个槽手填即脱离"
                onChange={(e) => onMasterChange(e.target.value)}
              />
            </label>
            {responsesUrlWarn && (
              <InlineNotice tone="warn" size="micro">{responsesUrlWarn}</InlineNotice>
            )}
            {openaiBillingHint && (
              <InlineNotice tone="warn" size="micro">{openaiBillingHint}</InlineNotice>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={secondaryActionClass}
                disabled={!!probingSlot || probingAll || !primarySlot}
                title={primarySlot ? "用当前填写的地址和密钥测试，不必先保存" : "先填 Base URL"}
                onClick={() => primarySlot && void probeOne(primarySlot, false)}
              >
                {probingSlot && probingSlot === primarySlot ? "测试中…" : "测试"}
              </button>
              <button
                type="button"
                className={secondaryActionClass}
                disabled={fetchingCatalog}
                title="用当前填写的地址和密钥拉目录，确认后再保存"
                onClick={() => void fetchCatalog()}
              >
                {fetchingCatalog ? "获取中…" : "获取模型"}
              </button>
              {editing !== "new" && catalogAge(editing.catalogFetchedAt) && (
                <span className="self-center text-micro text-l4">
                  {catalogAge(editing.catalogFetchedAt)}
                  {editing.catalogFromSlot ? ` · ${editing.catalogFromSlot}` : ""}
                </span>
              )}
            </div>
            <label className="block text-sm text-l2">
              {editing === "new" || !editing.keyHint ? "密钥" : "密钥（留空不改）"}
              <input
                className={`${fieldClass} mt-1 w-full`}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
            {editing !== "new" && editing.keyHint && (
              <button
                type="button"
                className={`${secondaryActionClass} text-err-text`}
                onClick={() => void onClearKey()}
              >
                清除本地密钥
              </button>
            )}
            {showWalletFields && (
              <div className="space-y-2 rounded-md border border-hairline p-2">
                <p className="text-micro text-l3">
                  查钱包余额用系统访问令牌，不是上面的推理密钥。打开站点钱包页登录后，在个人设置里生成。
                </p>
                <label className="block text-sm text-l2">
                  {editing === "new" || !editing.walletKeyHint
                    ? "系统访问令牌"
                    : "系统访问令牌（留空不改）"}
                  <input
                    className={`${fieldClass} mt-1 w-full`}
                    type="password"
                    value={walletToken}
                    onChange={(e) => setWalletToken(e.target.value)}
                    placeholder="不是 sk- 推理密钥"
                  />
                </label>
                {editing !== "new" && editing.walletKeyHint && (
                  <button
                    type="button"
                    className={`${secondaryActionClass} text-err-text`}
                    onClick={() => void onClearWalletToken()}
                  >
                    清除系统访问令牌
                  </button>
                )}
                <label className="block text-sm text-l2">
                  用户 ID（一般不用填）
                  <input
                    className={`${fieldClass} mt-1 w-full font-mono text-xs`}
                    value={walletUserId}
                    onChange={(e) => setWalletUserId(e.target.value)}
                    placeholder="老站点才要"
                  />
                </label>
              </div>
            )}
            <div>
              <button
                type="button"
                className="flex min-h-7 w-full items-center gap-2 text-left text-sm text-l2"
                onClick={() => setShowSlots((v) => !v)}
              >
                <FoldMark open={showSlots} />
                <span className="flex-1">协议槽</span>
                <span className="text-micro text-l4">
                  {slotsTogether ? "跟随 Base URL" : "有独立地址"}
                </span>
              </button>
              {showSlots && (
                <div className="space-y-2 pt-1">
                  {SLOT_LABELS.map(({ key, label }) => {
                    const follows = !slots[key]?.trim() && !!masterUrl.trim();
                    return (
                      <div key={key} className="space-y-1">
                        <label className="block text-sm text-l2">
                          <span className="flex items-center justify-between gap-2">
                            <span>
                              {label}
                              {follows && (
                                <span className="ml-1.5 text-micro text-l4">跟随 Base URL</span>
                              )}
                            </span>
                            <span className="font-mono text-micro text-l4">{probeSummaryText(slotSum(key))}</span>
                          </span>
                          <input
                            className={`${fieldClass} mt-1 w-full font-mono text-xs`}
                            value={slots[key] ?? ""}
                            placeholder={follows ? masterUrl : "https://…"}
                            title={follows ? "留空 = 跟随 Base URL；填入即脱离跟随" : undefined}
                            onChange={(e) => setSlots((s) => ({ ...s, [key]: e.target.value }))}
                          />
                        </label>
                        {key !== "cursor" && key !== "gemini" && (
                          <button
                            type="button"
                            className={secondaryActionClass}
                            disabled={!!probingSlot || !effectiveSlotUrl(slots, key, masterUrl)}
                            onClick={() => void probeOne(key, false)}
                          >
                            {probingSlot === key ? "测试中…" : "测试"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className={secondaryActionClass}
                    disabled={probingAll}
                    onClick={() => void probeAll()}
                  >
                    {probingAll ? "测速中…" : "测速支持槽位"}
                  </button>
                </div>
              )}
            </div>
            <div>
              <button
                type="button"
                className="flex min-h-7 w-full items-center gap-2 text-left text-sm text-l2"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                <FoldMark open={showAdvanced} />
                <span className="flex-1">Header</span>
              </button>
              {showAdvanced && (
                <label className="block pt-1 text-sm text-l2">
                  名=环境变量名，每行一条
                  <textarea
                    className={`${fieldClass} mt-1 h-20 w-full font-mono text-xs`}
                    value={headerText}
                    onChange={(e) => setHeaderText(e.target.value)}
                  />
                </label>
              )}
            </div>
            {editing !== "new" && (
              <div ref={bindSectionRef} className="scroll-mt-36">
                <button
                  type="button"
                  className="flex min-h-7 w-full items-center gap-2 text-left text-sm text-l2"
                  onClick={() => setShowBind((v) => !v)}
                >
                  <FoldMark open={showBind} />
                  <span className="flex-1">Agent 配置</span>
                  <span className="text-micro text-l4">
                    {boundAgents.length ? `${boundAgents.length} 条` : "未绑定"}
                  </span>
                </button>
                {showBind && (
                  <div className="space-y-2 pt-1 text-sm">
                    <ul className="text-micro text-l3">
                      {boundAgents.length === 0 && <li>还没有 Agent 配置</li>}
                      {boundAgents.map((p) => (
                        <li key={p.id} className="truncate" title={p.name}>
                          {p.name}
                        </li>
                      ))}
                    </ul>
                    <select
                      className={fieldClass}
                      value={bindAgent}
                      onChange={(e) => {
                        const agent = e.target.value;
                        setBindAgent(agent);
                        setBindProtocol(AGENT_PROTOCOLS[agent]?.default ?? "");
                        setBindModels(catalogModels.map((m) => m.id).slice(0, 1));
                      }}
                    >
                      <option value="">选择 Agent…</option>
                      {AGENTS.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                          {boundAgents.some((p) => p.agent === a.id) ? "（已有绑定，将再加一条）" : ""}
                        </option>
                      ))}
                    </select>
                    {bindAgent && AGENT_PROTOCOLS[bindAgent] && (
                      <select className={fieldClass} value={bindProtocol} onChange={(e) => setBindProtocol(e.target.value)}>
                        {AGENT_PROTOCOLS[bindAgent].options.map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    )}
                    {bindAgent && (
                      <div className="max-h-52 space-y-1 overflow-auto">
                        <ModelClassFilter
                          ids={catalogModels.map((m) => m.id)}
                          vendor={bindVendor}
                          onVendor={setBindVendor}
                          filter={bindFilter}
                          onFilter={setBindFilter}
                        />
                        <VendorModelSections
                          ids={catalogModels.map((m) => m.id)}
                          vendor={bindVendor}
                          filter={bindFilter}
                          openVendors={bindOpenVendors}
                          onToggle={(name) => {
                            setBindOpenVendors((prev) => {
                              const next = new Set(prev);
                              if (next.has(name)) next.delete(name);
                              else next.add(name);
                              return next;
                            });
                          }}
                          renderItem={(id) => {
                            const on = bindModels.includes(id);
                            return (
                              <label key={id} className="flex items-center gap-1 py-0.5 text-micro">
                                <Checkbox checked={on} onChange={(checked) => {
                                  setBindModels((cur) => checked
                                    ? (cur.includes(id) ? cur : [...cur, id])
                                    : cur.filter((item) => item !== id));
                                }} />
                                <span>{id}{on && bindModels[0] === id ? "（默认）" : ""}</span>
                              </label>
                            );
                          }}
                        />
                      </div>
                    )}
                    <button type="button" className={secondaryActionClass} disabled={!bindAgent} onClick={() => void bindToAgent()}>
                      添加 Agent 配置
                    </button>
                  </div>
                )}
              </div>
            )}
            {models.length > 0 && (
              <div className="text-sm text-l2">
                <button
                  type="button"
                  className="flex min-h-7 w-full items-center gap-2 text-left"
                  onClick={() => setShowModels((v) => !v)}
                >
                  <FoldMark open={showModels} />
                  <span className="flex-1">模型策略</span>
                  <span className="text-micro text-l4">{models.length} 个</span>
                </button>
                {showModels && (
                <div className="mt-1 space-y-1">
                  <ModelClassFilter
                    ids={models.map((row) => row.id)}
                    vendor={policyVendor}
                    onVendor={setPolicyVendor}
                    filter={policyFilter}
                    onFilter={setPolicyFilter}
                  />
                  <div className="max-h-56 overflow-auto">
                  <VendorModelSections
                    ids={models.map((row) => row.id)}
                    vendor={policyVendor}
                    filter={policyFilter}
                    openVendors={policyOpenVendors}
                    onToggle={(name) => {
                      setPolicyOpenVendors((prev) => {
                        const next = new Set(prev);
                        if (next.has(name)) next.delete(name);
                        else next.add(name);
                        return next;
                      });
                    }}
                    renderItem={(id) => {
                    const m = models.find((row) => row.id === id);
                    if (!m) return null;
                    const combo = comboByModel[m.id];
                    const cap = caps[m.id];
                    const open = expanded === m.id;
                    const effortMode = policyFieldMode({
                      capable: combo?.thinking ?? cap?.thinking ?? false,
                      injectAllowed: combo?.injectEffortAllowed ?? false,
                      channel: combo?.channelEffort,
                      probeFailed: combo?.probeEffort === "failed",
                      stored: m.reasoningEffort != null,
                    });
                    const tempMode = policyFieldMode({
                      capable: true,
                      injectAllowed: combo?.injectTemperatureAllowed ?? false,
                      channel: combo?.channelTemperature,
                      probeFailed: combo?.probeTemperature === "failed",
                      stored: m.temperature != null,
                    });
                    const topPMode = policyFieldMode({
                      capable: true,
                      injectAllowed: combo?.injectTopPAllowed ?? false,
                      channel: combo?.channelTopP,
                      probeFailed: combo?.probeTemperature === "failed",
                      stored: m.topP != null,
                    });
                    const maxMode = policyFieldMode({
                      capable: true,
                      injectAllowed: combo?.injectMaxTokensAllowed ?? false,
                      channel: combo?.channelMaxTokens,
                      probeFailed: false,
                      stored: m.maxOutputTokens != null,
                    });
                    return (
                      <div className="border-b border-hairline py-1 last:border-b-0">
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 text-left font-mono text-xs"
                          onClick={() => {
                            setExpanded(open ? null : m.id);
                            if (!open) {
                              if (!combo && !cap) void loadModelSurface([m.id]);
                              void ensureCapOverrideForm(m.id);
                            }
                          }}
                        >
                          <FoldMark open={open} />
                          <span className="min-w-0 flex-1 truncate">
                            {m.id}
                            {m.status === "stale" && (
                              <span className="ml-2 text-micro text-warn-text">历史失效</span>
                            )}
                          </span>
                          <span className="text-micro text-l4">
                            {(cap ?? combo)?.thinking ? "思考" : ""}
                            {(cap ?? combo)?.vision ? " 视觉" : ""}
                            {cap?.context ? ` ${Math.round(cap.context / 1024)}K` : ""}
                          </span>
                        </button>
                        {open && (
                          <div className="mt-1 space-y-1 pl-5">
                            {combo?.probeNote && (
                              <InlineNotice tone="warn" size="micro">{combo.probeNote}</InlineNotice>
                            )}
                            {combo?.policyChannelNote && (
                              <p className="text-micro text-l4">{combo.policyChannelNote}</p>
                            )}
                            {effortMode !== "hidden" && (
                              <label className="block text-micro text-l3">
                                思考档
                                {effortMode === "readonly" && (
                                  <span className="ml-1 text-l4">{policyFieldHint({
                                    capable: combo?.thinking ?? cap?.thinking ?? false,
                                    injectAllowed: combo?.injectEffortAllowed ?? false,
                                    channel: combo?.channelEffort,
                                    probeFailed: combo?.probeEffort === "failed",
                                    stored: m.reasoningEffort != null,
                                  })}</span>
                                )}
                                <ReasoningEffortPicker
                                  value={m.reasoningEffort}
                                  disabled={effortMode === "readonly"}
                                  onChange={(next) => patchModel(m.id, { reasoningEffort: next })}
                                />
                              </label>
                            )}
                            {tempMode !== "hidden" && (
                              <label className="block text-micro text-l3">
                                temperature
                                {tempMode === "readonly" && (
                                  <span className="ml-1 text-l4">{policyFieldHint({
                                    capable: true,
                                    injectAllowed: combo?.injectTemperatureAllowed ?? false,
                                    channel: combo?.channelTemperature,
                                    probeFailed: combo?.probeTemperature === "failed",
                                    stored: m.temperature != null,
                                  })}</span>
                                )}
                                <input
                                  className={`${fieldClass} mt-0.5 w-full`}
                                  type="number"
                                  disabled={tempMode === "readonly"}
                                  step="0.1"
                                  min="0"
                                  max="2"
                                  value={m.temperature ?? ""}
                                  onChange={(e) =>
                                    patchModel(m.id, { temperature: numOrNull(e.target.value) })
                                  }
                                />
                              </label>
                            )}
                            {topPMode !== "hidden" && (
                              <label className="block text-micro text-l3">
                                top_p
                                {topPMode === "readonly" && (
                                  <span className="ml-1 text-l4">{policyFieldHint({
                                    capable: true,
                                    injectAllowed: combo?.injectTopPAllowed ?? false,
                                    channel: combo?.channelTopP,
                                    probeFailed: combo?.probeTemperature === "failed",
                                    stored: m.topP != null,
                                  })}</span>
                                )}
                                <input
                                  className={`${fieldClass} mt-0.5 w-full`}
                                  type="number"
                                  disabled={topPMode === "readonly"}
                                  step="0.05"
                                  min="0"
                                  max="1"
                                  value={m.topP ?? ""}
                                  onChange={(e) => patchModel(m.id, { topP: numOrNull(e.target.value) })}
                                />
                              </label>
                            )}
                            {maxMode !== "hidden" && (
                              <label className="block text-micro text-l3">
                                max output
                                {maxMode === "readonly" && (
                                  <span className="ml-1 text-l4">{policyFieldHint({
                                    capable: true,
                                    injectAllowed: combo?.injectMaxTokensAllowed ?? false,
                                    channel: combo?.channelMaxTokens,
                                    probeFailed: false,
                                    stored: m.maxOutputTokens != null,
                                  })}</span>
                                )}
                                <input
                                  className={`${fieldClass} mt-0.5 w-full`}
                                  type="number"
                                  disabled={maxMode === "readonly"}
                                  min="1"
                                  value={m.maxOutputTokens ?? ""}
                                  onChange={(e) =>
                                    patchModel(m.id, {
                                      maxOutputTokens: numOrNull(e.target.value),
                                    })
                                  }
                                />
                              </label>
                            )}
                            <div className="mt-2 border-t border-hairline pt-2">
                              <p className="text-micro text-l3">
                                能力声明
                                <span className="ml-1 text-l4">
                                  中转新模型查不到/报错时手填；对本机所有 Agent 生效（能力来源最高层）
                                </span>
                              </p>
                              <p className="mt-0.5 text-micro text-l4">
                                当前解析：
                                {cap
                                  ? `${Math.round(cap.context / 1024)}K 上下文${cap.thinking ? " · 思考" : ""}${cap.vision ? " · 视觉" : ""}`
                                  : "加载中…"}
                                {capOverrides[m.id] ? " · 已声明（最高优先）" : ""}
                              </p>
                              <div className="mt-1">
                                <label className="block text-micro text-l3">
                                  上下文窗口
                                  <input
                                    className={`${fieldClass} mt-0.5 w-full`}
                                    type="number"
                                    min="1"
                                    step="1024"
                                    placeholder="如 1048576"
                                    value={(capForms[m.id] ?? EMPTY_CAPS_FORM).context}
                                    onChange={(e) =>
                                      patchCapForm(m.id, { context: e.target.value })
                                    }
                                  />
                                </label>
                                <div className="mt-1 grid grid-cols-2 gap-2">
                                  <label className="block text-micro text-l3">
                                    思考
                                    <select
                                      className={`${fieldClass} mt-0.5 w-full`}
                                      value={(capForms[m.id] ?? EMPTY_CAPS_FORM).thinking}
                                      onChange={(e) =>
                                        patchCapForm(m.id, {
                                          thinking: e.target.value as TriState,
                                        })
                                      }
                                    >
                                      <option value="">未声明</option>
                                      <option value="true">支持</option>
                                      <option value="false">不支持</option>
                                    </select>
                                  </label>
                                  <label className="block text-micro text-l3">
                                    视觉
                                    <select
                                      className={`${fieldClass} mt-0.5 w-full`}
                                      value={(capForms[m.id] ?? EMPTY_CAPS_FORM).vision}
                                      onChange={(e) =>
                                        patchCapForm(m.id, {
                                          vision: e.target.value as TriState,
                                        })
                                      }
                                    >
                                      <option value="">未声明</option>
                                      <option value="true">支持</option>
                                      <option value="false">不支持</option>
                                    </select>
                                  </label>
                                </div>
                              </div>
                              <div className="mt-1">
                                <button
                                  type="button"
                                  className={secondaryActionClass}
                                  disabled={
                                    capPending === m.id ||
                                    (capsFormIsEmpty(capForms[m.id] ?? EMPTY_CAPS_FORM) &&
                                      !capOverrides[m.id])
                                  }
                                  onClick={() => void saveCapOverride(m)}
                                >
                                  {capPending === m.id
                                    ? "保存中…"
                                    : capsFormIsEmpty(capForms[m.id] ?? EMPTY_CAPS_FORM)
                                      ? "清除声明"
                                      : "保存声明"}
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                    }}
                  />
                  </div>
                </div>
                )}
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button type="button" className={primaryActionClass} disabled={saving} onClick={() => void save()}>
                保存网关
              </button>
              <button type="button" className={secondaryActionClass} onClick={() => setEditing(null)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {gateways.length === 0 && <li className="py-6 text-center text-sm text-l3">还没有网关</li>}
            {gatewayPickerRows(gateways).map((row) => {
              const g = gateways.find((item) => item.id === row.id);
              if (!g) return null;
              const n = profiles.filter((p) => p.gatewayId === g.id).length;
              const usage = usageLine(g);
              return (
                <li key={g.id} className="flex items-center gap-3 py-2 text-sm">
                  <VendorIcon vendor={vendorForGateway(g)} name={row.name} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-l1">{row.name}</span>
                    <span className="ml-2 text-l3">{n ? `${n} 个连接在用` : "没有连接在用"}</span>
                    <span className="mt-0.5 block truncate text-micro text-l4" title={row.detail}>
                      {row.detail}
                    </span>
                    {usage && (
                      <button
                        type="button"
                        className="mt-0.5 block text-micro text-l4 hover:text-l2"
                        onClick={() => onJumpUsage?.(g.id)}
                      >
                        {usage}
                      </button>
                    )}
                  </span>
                  {/* 按钮分级：编辑是这一行的主动作；获取模型是辅助；删除不与它们同权（原先三颗同款次按钮） */}
                  <button
                    type="button"
                    className={ghostActionClass}
                    disabled={listFetchingId === g.id}
                    title="重新拉取这个网关的模型目录并保存"
                    onClick={() => void refreshListedCatalog(g)}
                  >
                    {listFetchingId === g.id ? "获取中…" : "获取模型"}
                  </button>
                  <button type="button" className={secondaryActionClass} onClick={() => openEdit(g)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className={`${ghostActionClass} hover:text-err-text`}
                    onClick={() => void onDelete(g)}
                  >
                    删除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
