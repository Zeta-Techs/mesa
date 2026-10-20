import { Fragment, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  CopyPlus,
  Database,
  Eye,
  EyeOff,
  FileDown,
  Globe,
  Import,
  LogIn,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SquareArrowOutUpRight,
  SquareTerminal,
  Star,
  Trash2,
  Undo2,
} from "lucide-react";
import { useAppStore } from "../store";
import { AGENTS, AGENT_PROTOCOLS, type ScheduleDto } from "../types";
import { presetsForAgent, NO_PRESET_REASON, type ProviderPreset } from "../presets";
import {
  extraBindTargets,
  gatewayDraftSlots,
  intersectCatalog,
  sameModelList,
} from "../preset-flow";
import { upstreamNoteText, upstreamCommand } from "../upstream-note";
import { copyTargets } from "../profile-copy";
import { channelLabel } from "../combo-field";
import { canOneClickInstall } from "../dep-check";
import { DepInstallLog, useDepInstall } from "../dep-install";
import { MODEL_SWITCH } from "../model-switch";
import { claudeAliasMap, normalizeRoleModels, rolesFor } from "../role-models";
import { groupModelsByVendor, vendorOf } from "../model-vendors";
import { interactiveUpdatePrefill } from "../update-routing";
import { absTime, relTime } from "../rel-time";
import { toast } from "../toast";
import { slotForAgent } from "../gateway-slot";
import { catalogCapabilityNote } from "../gateway-draft";
import {
  profileConnectionCaptions,
  showCatalogSyncAction,
} from "../profile-connection-ui";
import { endpointHost, gatewayPickerRows } from "../gateway-option";
import ContextMenu from "../components/ContextMenu";
import GatewayLibrary from "../components/GatewayLibrary";
import { HoverTip, useHoverTip } from "../components/HoverTip";
import { alertDialog, confirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { collapseCarriageReturns } from "../stream-text";
import {
  PageFrame,
  NoticeBar,
  PageHeader,
  PageToolbar,
  SegTabs,
  Checkbox,
  fieldClass,
  FoldMark,
  MenuSelect,
  ghostActionClass,
  hoverRevealClass,
  primaryActionClass,
  rowActionClass,
  searchFieldClass,
  secondaryActionClass,
  InlineNotice,
} from "../components/PageFrame";
import type {
  AgentCapabilitiesDto,
  BindingInput,
  ComboSurfaceDto,
  GlobalDriftDto,
  ImportV2Result,
  GlobalApplyResultDto,
  GlobalWritePreviewDto,
  OfficialAccountStatusDto,
  Profile,
  ProfileInput,
  ModelCapabilityDto,
  FetchModelsResultDto,
  FetchGatewayCatalogDto,
  ProfileValidationDto,
  ValidationCheckDto,
  RequestPolicy,
  RoleModels,
  LaunchPlanPreviewDto,
} from "../types";

function ProfileModal({
  initial,
  presetAgent,
  officialSupported,
  onClose,
  onSaved,
  onOpenGateway,
}: {
  initial: Profile | null;
  /** 从某个 agent 组的「+ 添加连接」打开时预选该 agent */
  presetAgent?: string;
  /** 各 agent 是否支持官方账号（来自 official_account_status） */
  officialSupported: Record<string, boolean>;
  onClose: () => void;
  /** 保存成功回调：页面据此判断要不要提示「该 agent 有标签在跑，需重开才生效」 */
  onSaved?: (agent: string, name: string) => void;
  onOpenGateway?: (id: string) => void;
}) {
  const saveProfile = useAppStore((s) => s.saveProfile);
  const bindGateway = useAppStore((s) => s.bindGateway);
  const saveGateway = useAppStore((s) => s.saveGateway);
  const gateways = useAppStore((s) => s.gateways);
  const loadGateways = useAppStore((s) => s.loadGateways);
  // 一键接入：选中的 provider 预设（含完整槽位与推荐模型）；null = 手填
  const [appliedPreset, setAppliedPreset] = useState<ProviderPreset | null>(null);
  // 「同时绑到」勾选的额外 Agent：保存时用同一份网关一次建多条绑定
  const [extraAgents, setExtraAgents] = useState<string[]>([]);
  const [bindMode, setBindMode] = useState<"new" | "existing">(
    initial ? "new" : "new",
  );
  const [bindGatewayId, setBindGatewayId] = useState("");
  const [combo, setCombo] = useState<ComboSurfaceDto | null>(null);
  const [form, setForm] = useState({
    agent: initial?.agent ?? presetAgent ?? "claude-code",
    name: initial?.name ?? "",
    accountType: (initial?.accountType ?? "api") as "api" | "official",
    noAuth: initial?.noAuth ?? false,
    protocol: (initial?.protocol ??
      AGENT_PROTOCOLS[initial?.agent ?? "claude-code"]?.default ??
      null) as string | null,
    apiBackend: (initial?.apiBackend ?? null) as string | null,
    baseUrl: initial?.baseUrl ?? "",
    models: initial?.models ?? ([] as string[]),
    roleModels: (initial?.roleModels ?? {}) as RoleModels,
    extraEnvText: Object.entries(initial?.extraEnv ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    requestPolicy: {
      temperature: initial?.requestPolicy?.temperature ?? null,
      topP: initial?.requestPolicy?.topP ?? null,
      maxOutputTokens: initial?.requestPolicy?.maxOutputTokens ?? null,
      reasoningEffort: initial?.requestPolicy?.reasoningEffort ?? null,
      headerEnv: initial?.requestPolicy?.headerEnv ?? {},
    } as RequestPolicy,
    apiKey: "",
  });
  const [headerEnvText, setHeaderEnvText] = useState(
    Object.entries(initial?.requestPolicy?.headerEnv ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [fetching, setFetching] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [fetchedCapabilityCount, setFetchedCapabilityCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // 获取模型的厂商分组面板：开关 / 筛选词 / 展开的厂商组
  const [pickerOpen, setPickerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState("");
  const [openVendors, setOpenVendors] = useState<ReadonlySet<string>>(new Set());
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [capabilities, setCapabilities] = useState<ModelCapabilityDto[]>([]);
  const [agentCapabilities, setAgentCapabilities] = useState<AgentCapabilitiesDto | null>(null);
  const showGatewayFields =
    form.accountType === "api" && !initial && bindMode !== "existing";
  // 模型选择器数据源：新建网关 = 「获取模型」拉取结果；选用已有网关/编辑绑定 = 该网关目录
  // （null = 无网关语境——官方账号或纯新建，不出选择器）
  const catalogGatewayId =
    !initial && bindMode === "existing"
      ? bindGatewayId
      : (initial?.gatewayId ?? null);
  const gatewayCatalog = catalogGatewayId
    ? (gateways.find((g) => g.id === catalogGatewayId)?.models ?? []).map(
        (m) => m.id,
      )
    : null;
  const pickerModels = showGatewayFields
    ? (fetchedModels ?? [])
    : (gatewayCatalog ?? []);

  // 协议推导（选用已有网关 / 编辑绑定）：qwen/kimi 的候选协议各自落固定槽位
  //（与后端 gateway_store::slot_for_agent 同口径）。所选网关恰好只填了一个候选槽时
  // 协议唯一确定——高级设置里只读展示，不再让手选（多槽已填 = 真选择，保留下拉）
  const PROTOCOL_SLOT: Record<string, Record<string, "anthropic" | "openai">> = {
    qwen: { openai: "openai", anthropic: "anthropic" },
    kimi: { kimi: "openai", openai: "openai", anthropic: "anthropic" },
  };
  const derivedProtocol = (() => {
    if (showGatewayFields) return null; // 新建网关：协议决定 Base URL 落哪个槽，保持手选
    const mapping = PROTOCOL_SLOT[form.agent];
    if (!mapping) return null;
    const gw = gateways.find((g) => g.id === catalogGatewayId);
    if (!gw) return null;
    const filledSlots = new Set(
      Object.values(mapping).filter((slot) => (gw.slots[slot] ?? "").trim()),
    );
    if (filledSlots.size !== 1) return null;
    const slot = [...filledSlots][0];
    const candidates = Object.entries(mapping)
      .filter(([, s]) => s === slot)
      .map(([p]) => p);
    const def = AGENT_PROTOCOLS[form.agent]?.default;
    return candidates.includes(def ?? "") ? (def ?? null) : (candidates[0] ?? null);
  })();
  useEffect(() => {
    if (derivedProtocol && form.protocol !== derivedProtocol)
      setForm((f) => ({ ...f, protocol: derivedProtocol }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedProtocol]);

  useEffect(() => {
    let cancelled = false;
    void invoke<AgentCapabilitiesDto[]>("agent_capabilities")
      .then((items) => {
        if (!cancelled) setAgentCapabilities(items.find((item) => item.agent === form.agent) ?? null);
      })
      .catch(() => {
        if (!cancelled) setAgentCapabilities(null);
      });
    return () => {
      cancelled = true;
    };
  }, [form.agent]);

  useEffect(() => {
    // 编辑绑定也要拿网关目录（模型选择器的数据源），不再仅限新建
    void loadGateways();
  }, [loadGateways]);

  useEffect(() => {
    if (!initial?.id) {
      setCombo(null);
      return;
    }
    let cancelled = false;
    void invoke<ComboSurfaceDto>("combo_surface", {
      profileId: initial.id,
      model: form.models[0] || null,
    })
      .then((c) => {
        if (!cancelled) setCombo(c);
      })
      .catch(() => {
        if (!cancelled) setCombo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [initial?.id, form.models]);

  useEffect(() => {
    let cancelled = false;
    if (!form.models.length) {
      setCapabilities([]);
      return;
    }
    void invoke<ModelCapabilityDto[]>("model_capabilities", {
      models: form.models,
      gatewayId: catalogGatewayId,
    })
      .then((items) => {
        if (!cancelled) setCapabilities(items);
      })
      .catch(() => {
        if (!cancelled) setCapabilities([]);
      });
    return () => {
      cancelled = true;
    };
  }, [form.models, catalogGatewayId]);

  /** 解析「每行 KEY=VALUE」文本为环境变量表，# 开头视为注释 */
  function parseEnvLines(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
  }

  /** 解析 Header 名=环境变量名；值只允许是变量名，不接受密文。 */
  function parseHeaderEnvLines(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
  }

  /** 请求策略数字输入：空 = null；非法中间态（NaN，如 "-"/"1e"）返回 undefined 不落表单，
      避免 NaN 存进 profiles.json 时 serde_json 序列化直接失败 */
  function parseOptionalNumber(raw: string): number | null | undefined {
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  /** 模型槽位编辑：i 越界 = 尾部空槽首击，先追加再就位（后续击键走更新分支） */
  function setModelSlot(i: number, v: string) {
    if (i < form.models.length) {
      const next = [...form.models];
      next[i] = v;
      setForm({ ...form, models: next });
    } else {
      setForm({ ...form, models: [...form.models, v] });
    }
  }

  function removeModelSlot(i: number) {
    setForm({ ...form, models: form.models.filter((_, j) => j !== i) });
  }

  /** 从获取面板添加：优先填进第一个空槽，没有去尾部追加 */
  function addModelToList(m: string) {
    const v = m.trim();
    if (!v || form.models.some((x) => x.trim() === v)) return;
    const emptyIdx = form.models.findIndex((x) => !x.trim());
    const next = [...form.models];
    if (emptyIdx >= 0) next[emptyIdx] = v;
    else next.push(v);
    setForm({ ...form, models: next });
  }

  /** 「验证并获取」：真实请求验证端点+密钥（force 跳过缓存），成功即拉到模型目录并：
      ① 预设推荐模型未被手改 → 与目录求交后替换（不在目录的不选，不整目录预填）；
      ② 名单仍为空 → 默认选目录第一个，避免空名单「完全不注入」的静默陷阱。 */
  async function verifyAndFetch() {
    setFetching(true);
    setFetchError(null);
    const started = Date.now();
    let autoNote = "";
    try {
      const res = await invoke<FetchModelsResultDto>("fetch_models", {
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey || null,
        profileId: initial?.id ?? null,
        agentId: form.agent,
        protocol: form.protocol,
        force: true,
      });
      setFetchedModels(res.models);
      setFetchedAt(res.fetchedAt);
      setFetchedCapabilityCount(res.capabilityMetadataCount);
      const rec = appliedPreset?.models;
      if (rec?.length && sameModelList(form.models, rec)) {
        const hit = intersectCatalog(rec, res.models);
        if (hit.length) {
          setForm((f) => ({ ...f, models: hit }));
          autoNote = ` · 已选中 ${hit.length} 个推荐模型`;
        }
      }
      if (!form.models.some((m) => m.trim()) && res.models.length > 0) {
        setForm((f) => ({ ...f, models: [res.models[0]] }));
        setPickerOpen(true);
        if (!autoNote) autoNote = " · 已默认选中第一个模型，可再调整";
      }
      setTestResult({
        ok: true,
        text: `✓ 连通 · ${res.models.length} 个模型 · ${Date.now() - started}ms${autoNote}`,
      });
    } catch (e) {
      setTestResult({ ok: false, text: `✗ ${String(e)}` });
      setFetchError(String(e));
      setFetchedModels(null);
      setFetchedAt(null);
      setFetchedCapabilityCount(0);
    } finally {
      setFetching(false);
    }
  }

  /** 已有网关：现拉目录并立刻写入该网关，不改当前勾选的绑定模型。 */
  async function refreshExistingCatalog() {
    if (!catalogGatewayId) return;
    setFetching(true);
    setFetchError(null);
    try {
      const result = await invoke<FetchGatewayCatalogDto>("fetch_gateway_catalog", {
        gatewayId: catalogGatewayId,
        preferSlot: slotForAgent(form.agent, form.protocol),
      });
      await loadGateways();
      setPickerOpen(true);
      setFetchedAt(result.gateway.catalogFetchedAt);
      setFetchedCapabilityCount(result.capabilityMetadataCount);
    } catch (e) {
      setFetchError(String(e));
    } finally {
      setFetching(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const input: ProfileInput = {
      agent: form.agent,
      name: form.name.trim(),
      accountType: form.accountType,
      noAuth: form.accountType === "api" && form.noAuth,
      protocol: AGENT_PROTOCOLS[form.agent] ? form.protocol : null,
      // grok 专用：API 后端（仅设为全局写入消费），其余 agent 不携带
      apiBackend: form.agent === "grok" ? form.apiBackend : null,
      // 官方账号：认证交给 CLI 登录，不落端点/密钥
      baseUrl: form.accountType === "official" ? "" : form.baseUrl.trim(),
      // 槽位化编辑允许空串/重复中间态，保存时归一：去空白、去空、去重（保序）
      models: [...new Set(form.models.map((m) => m.trim()).filter(Boolean))],
      // 模型分工：只留名单里还在的；不支持分工的 Agent 存空（后端也只在支持的家消费）
      roleModels: rolesFor(form.agent).length
        ? normalizeRoleModels(form.roleModels, form.models.map((m) => m.trim()))
        : {},
      extraEnv: parseEnvLines(form.extraEnvText),
      requestPolicy: {
        ...form.requestPolicy,
        headerEnv: parseHeaderEnvLines(headerEnvText),
      },
      apiKey: form.accountType === "official" ? null : form.apiKey || null,
      expectedGatewayRevision: initial?.gatewayId
        ? gateways.find((g) => g.id === initial.gatewayId)?.revision ?? null
        : null,
    };
    try {
      if (!initial && bindMode === "existing") {
        if (!bindGatewayId) throw new Error("请选择网关");
        const bind: BindingInput = {
          agent: input.agent,
          name: input.name,
          gatewayId: bindGatewayId,
          kind: "api",
          protocol: input.protocol,
          apiBackend: input.apiBackend,
          models: input.models,
          roleModels: input.roleModels,
          extraEnv: input.extraEnv,
        };
        await bindGateway(bind);
        onSaved?.(input.agent, input.name);
        onClose();
        return;
      }
      // 「同时绑到」：先建网关（拿到 id、按预设/同族槽位补齐其他协议槽），再逐家绑定。
      // 走 saveGateway 而非 saveProfile——后者一次只建一条绑定且只填一个槽。
      if (
        !initial &&
        bindMode !== "existing" &&
        input.accountType === "api" &&
        extraAgents.length > 0
      ) {
        const targets = extraBindTargets(input.agent, input.protocol, extraAgents).filter(
          (t) => t.ok,
        );
        const gw = await saveGateway(null, {
          name: input.name,
          noAuth: input.noAuth,
          slots: gatewayDraftSlots(
            { agent: input.agent, protocol: input.protocol, baseUrl: input.baseUrl ?? "" },
            targets,
            appliedPreset,
          ),
          headerEnv: parseHeaderEnvLines(headerEnvText),
          models: input.models.map((id) => ({
            id,
            source: "user",
            status: "available",
            lastSeenAt: null,
            catalogSlot: null,
            temperature: input.requestPolicy?.temperature ?? null,
            topP: input.requestPolicy?.topP ?? null,
            maxOutputTokens: input.requestPolicy?.maxOutputTokens ?? null,
            reasoningEffort: input.requestPolicy?.reasoningEffort ?? null,
          })),
          apiKey: input.apiKey,
        });
        try {
          await bindGateway({
            agent: input.agent,
            name: input.name,
            gatewayId: gw.id,
            kind: "api",
            protocol: input.protocol,
            apiBackend: input.apiBackend,
            models: input.models,
            roleModels: input.roleModels,
            extraEnv: input.extraEnv,
          });
          for (const t of targets) {
            await bindGateway({
              agent: t.agent,
              gatewayId: gw.id,
              kind: "api",
              protocol: t.protocol,
              models: input.models,
              extraEnv: {},
            });
          }
        } catch (err) {
          // 网关已保存：绑定失败不回滚网关，指路网关库补绑，避免重试再建一个重复网关
          setError(
            `部分绑定失败：${String(err)}。网关已保存，失败的 Agent 可在网关库里补绑。`,
          );
          return;
        }
        onSaved?.(input.agent, input.name);
        onClose();
        return;
      }
      await saveProfile(initial?.id ?? null, input);
      onSaved?.(input.agent, input.name);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      title={initial ? "编辑连接" : "添加连接"}
      description={
        initial
          ? "改这份绑定用的模型名单和附加环境变量。"
          : undefined
      }
      onClose={onClose}
      size="md"
    >
      <form onSubmit={submit}>
        {!initial && (
          <div className="mb-3">
            <SegTabs
              items={[
                { id: "new", label: "新建网关" },
                { id: "existing", label: "选用已有网关" },
              ]}
              value={bindMode}
              onChange={(id) => {
                setBindMode(id);
                setPickerOpen(false);
                setExtraAgents([]);
                setAppliedPreset(null);
                if (id === "existing") {
                  setForm((f) => ({ ...f, accountType: "api", noAuth: false }));
                }
              }}
            />
          </div>
        )}
        {!initial && bindMode === "existing" && (
          <div className="mb-3">
            {gateways.length === 0 ? (
              <p className="text-xs text-l3">
                还没有网关。改选「新建网关」，或到网关库添加。
              </p>
            ) : (
              <ul className="max-h-48 space-y-0.5 overflow-auto" aria-label="已有网关">
                {gatewayPickerRows(gateways).map((row) => {
                  const selected = bindGatewayId === row.id;
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        className={`flex w-full flex-col rounded-md px-2.5 py-1.5 text-left ${
                          selected ? "bg-seg-sel text-l1" : "text-l2 hover:bg-hover hover:text-l1"
                        }`}
                        onClick={() => {
                          setBindGatewayId(row.id);
                          const gw = gateways.find((g) => g.id === row.id);
                          if (gw)
                            setForm((f) => {
                              const gwNames = new Set(gateways.map((item) => item.name));
                              return {
                                ...f,
                                name: !f.name.trim() || gwNames.has(f.name) ? gw.name : f.name,
                                models: [],
                                accountType: "api",
                              };
                            });
                          setPickerOpen(Boolean(gw && gw.models.length > 0));
                          setPickerFilter("");
                          setOpenVendors(new Set());
                        }}
                      >
                        <span className="truncate text-sm font-medium">{row.name}</span>
                        <span className="truncate text-micro text-l4">{row.detail}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {!initial && (
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">Agent</span>
          {/* 浮层禁用原生 select（设计系统）：原生下拉在弹层里是系统样式，与其余控件两套长相 */}
          <MenuSelect
            aria-label="Agent"
            value={form.agent}
            options={AGENTS.map((a) => ({ value: a.id, label: a.label }))}
            onChange={(agent) => {
              setForm({
                ...form,
                agent,
                accountType: officialSupported[agent]
                  ? form.accountType
                  : "api",
                protocol: AGENT_PROTOCOLS[agent]?.default ?? null,
              });
              setTestResult(null);
              setFetchError(null);
              setFetchedModels(null);
              // 换 Agent = 换协议语境：预设与「同时绑到」的勾选都要重选
              setAppliedPreset(null);
              setExtraAgents([]);
            }}
          />
        </label>
        )}

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">名称</span>
          <input
            className={fieldClass}
            required
            placeholder="这份连接叫什么"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        {initial?.gatewayId && (
          <p className="mb-3 text-xs text-l3">
            端点与密钥在网关库改。
            {onOpenGateway && (
              <button
                type="button"
                className="ml-1 text-cta hover:underline"
                onClick={() => {
                  onOpenGateway(initial.gatewayId!);
                  onClose();
                }}
              >
                打开网关库
              </button>
            )}
          </p>
        )}
        {officialSupported[form.agent] && !initial && bindMode === "new" && (
          <div className="mb-3">
            <SegTabs
              items={[
                { id: "api", label: "API 密钥" },
                { id: "official", label: "官方账号" },
              ]}
              value={form.accountType}
              onChange={(id) => {
                setForm((f) => ({ ...f, accountType: id, noAuth: false }));
                // 切到官方账号 = 不建网关，「同时绑到」勾选随之失效
                setExtraAgents([]);
              }}
            />
          </div>
        )}
        {showGatewayFields && (
          <>
        {(() => {
          const agentPresets = presetsForAgent(form.agent);
          if (initial) return null;
          if (agentPresets.length === 0) {
            const reason = NO_PRESET_REASON[form.agent];
            return reason ? (
              <p className="mb-3 text-xs text-l4">{reason}</p>
            ) : null;
          }
          return (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-xs text-l3">端点预设</span>
            <MenuSelect
              aria-label="端点预设"
              value=""
              placeholder="选一家供应商，自动填地址和推荐模型…"
              options={agentPresets.map((p) => ({
                value: p.name,
                label: `${p.name}${p.provider.models?.length ? " · 含推荐模型" : ""}${
                  p.confidence === "official"
                    ? " · 官方"
                    : p.confidence === "verified-compatible"
                      ? " · 已验证兼容"
                      : p.confidence === "address-only"
                        ? " · 仅填地址"
                        : ""
                }${p.note ? `（${p.note}）` : ""}`,
              }))}
              onChange={(name) => {
                const preset = agentPresets.find((p) => p.name === name);
                if (preset) {
                  setAppliedPreset(preset.provider);
                  setForm({
                    ...form,
                    baseUrl: preset.baseUrl,
                    name: form.name || preset.name,
                    protocol: preset.protocol ?? form.protocol,
                    // 预设推荐模型直接预填（精选清单，非整份目录）；「验证并获取」后与实际目录求交
                    models: preset.provider.models ? [...preset.provider.models] : [],
                    noAuth: preset.provider.noAuth ?? false,
                  });
                  setTestResult(null);
                  setFetchError(null);
                  setFetchedModels(null);
                  if (preset.provider.models?.length) setPickerOpen(false);
                }
              }}
            />
          </label>
          );
        })()}
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">Base URL</span>
          <input
            className={fieldClass}
            placeholder="https://api.example.com"
            value={form.baseUrl}
            onChange={(e) => {
              setForm({ ...form, baseUrl: e.target.value });
              // 手改地址即脱离预设推荐语境，避免「验证并获取」再按旧预设改写名单
              if (appliedPreset) setAppliedPreset(null);
            }}
          />
          <span className="mt-1 block text-micro text-l4">
            填好后到下方「验证并获取」一次完成连通验证和模型目录拉取
          </span>
        </label>
        {(form.agent === "claude-code" || form.agent === "codebuddy" || form.protocol === "anthropic") &&
          form.baseUrl.trim().replace(/\/+$/, "").endsWith("/v1") && (
          <p className="-mt-2 mb-3 text-xs text-warn-text">
            Anthropic 客户端会自动在 Base URL 后拼 /v1/messages，以 /v1 结尾将打成 /v1/v1/messages 报 404（此时「测试」仍能成功，不代表运行可用）——请去掉末尾的 /v1
          </p>
        )}
        {testResult && (
          <p
            className={`-mt-2 mb-3 text-xs ${testResult.ok ? "text-ok-text" : "text-err-text"}`}
          >
            {testResult.text}
          </p>
        )}
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">API Key</span>
          <input
            className={fieldClass}
            type="password"
            autoComplete="new-password"
            placeholder={initial ? "留空则不修改" : "密钥"}
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
        </label>
          </>
        )}
        <div className="mb-4 text-sm">
          <span className="mb-1 block text-xs text-l3">
            模型列表（可选，首个为默认）
          </span>
          {(() => {
            const sw = MODEL_SWITCH[form.agent];
            if (!sw) return null;
            const filled = form.models.filter((m) => m.trim()).length;
            const over = sw.max != null && filled > sw.max;
            if (sw.max == null && !over) return null;
            return (
              <p
                title={sw.hint}
                className={`mb-2 text-xs ${over ? "text-warn-text" : "text-l3"}`}
              >
                {`最多 ${sw.max} 个模型可进入 CLI 选择器`}
                {over && `；当前超出 ${filled - (sw.max ?? 0)} 个`}
              </p>
            );
          })()}
          {showGatewayFields && (
            <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void verifyAndFetch()}
              disabled={fetching || !form.baseUrl.trim()}
              title={
                form.baseUrl.trim()
                  ? "真实请求验证端点与密钥，并拉取模型目录；预设推荐模型会自动选中"
                  : "先填写 Base URL"
              }
              className={`${rowActionClass} shrink-0 whitespace-nowrap`}
            >
              {fetching ? "验证中…" : "验证并获取"}
            </button>
            {fetchedModels && fetchedModels.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  // 首次打开时展开「已配置首个模型」所在的厂商组
                  if (!pickerOpen && openVendors.size === 0) {
                    const first = form.models.find((x) => x.trim());
                    if (first) setOpenVendors(new Set([vendorOf(first)]));
                  }
                  setPickerOpen(!pickerOpen);
                }}
                className={`${fieldClass} flex min-w-0 items-center justify-between gap-2 text-left`}
              >
                <span className="truncate text-l3">
                  从 {fetchedModels.length} 个模型中选择…
                </span>
                <span className="text-l4">{pickerOpen ? "▴" : "▾"}</span>
              </button>
            )}
            {/* 每次点都真实请求（不读缓存），连通性与目录一次拿齐；缓存提示不再需要 */}
            {fetchedModels && fetchedModels.length > 0 && (
              <>
                {fetchedCapabilityCount === 0 && (
                  <span
                    className="max-w-[16rem] text-xs text-warn-text"
                    title="这家网关的 /models 只有模型 ID。思考档、上下文窗口、视觉用连接页 ⋯「下载模型能力库」。"
                  >
                    网关未给能力字段，用页头 ⋯ 下载公共能力库
                  </span>
                )}
                {fetchedCapabilityCount > 0 && (
                  <span className="shrink-0 text-xs text-l4">
                    {catalogCapabilityNote(
                      fetchedModels.length,
                      fetchedCapabilityCount,
                    )}
                  </span>
                )}
              </>
            )}
            {fetchedModels && fetchedModels.length === 0 && (
              <span className="text-xs text-l4">接口返回 0 个模型</span>
            )}
          </div>
          {fetchError && (
            <InlineNotice tone="err" className="mb-2">{fetchError}</InlineNotice>
          )}
            </>
          )}
          {/* 选用已有网关 / 编辑绑定：目录在网关；此处可现拉并写入，不改当前勾选 */}
          {!showGatewayFields && catalogGatewayId && form.accountType === "api" && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshExistingCatalog()}
                disabled={fetching}
                title="重新拉取这个网关的模型目录并保存；不会改当前已勾选的模型"
                className={`${rowActionClass} shrink-0 whitespace-nowrap`}
              >
                {fetching ? "获取中…" : "获取模型"}
              </button>
              {gatewayCatalog && gatewayCatalog.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (!pickerOpen && openVendors.size === 0) {
                      const first = form.models.find((x) => x.trim());
                      if (first) setOpenVendors(new Set([vendorOf(first)]));
                    }
                    setPickerOpen(!pickerOpen);
                  }}
                  className={`${fieldClass} flex min-w-0 flex-1 items-center justify-between gap-2 text-left`}
                >
                  <span className="truncate text-l3">
                    从网关目录 {gatewayCatalog.length} 个模型中选择…
                  </span>
                  <span className="text-l4">{pickerOpen ? "▴" : "▾"}</span>
                </button>
              )}
              {(!gatewayCatalog || gatewayCatalog.length === 0) && (
                <span className="text-micro text-l4">
                  还没有目录，点「获取模型」拉取，或在下方手填。
                </span>
              )}
              {fetchError && (
                <InlineNotice tone="err" className="basis-full">{fetchError}</InlineNotice>
              )}
              {fetchedAt &&
                catalogCapabilityNote(
                  gatewayCatalog?.length ?? 0,
                  fetchedCapabilityCount,
                ) && (
                  <p
                    className={`basis-full text-xs ${
                      fetchedCapabilityCount === 0 ? "text-warn-text" : "text-l4"
                    }`}
                  >
                    {catalogCapabilityNote(
                      gatewayCatalog?.length ?? 0,
                      fetchedCapabilityCount,
                    )}
                  </p>
                )}
            </div>
          )}
          {/* 厂商分组折叠面板：大网关 400+ 模型平铺没法选；筛选时全部强制展开。
              数据源 = pickerModels（新建网关 = 拉取结果；选用已有/编辑绑定 = 网关目录） */}
          {pickerOpen && pickerModels.length > 0 && (
            <div className="mb-2 max-h-64 overflow-y-auto rounded-md ccode-well p-1">
              <input
                autoFocus
                className={`${searchFieldClass} mb-1 w-full`}
                placeholder="筛选模型名…"
                value={pickerFilter}
                onChange={(e) => setPickerFilter(e.target.value)}
              />
              {(() => {
                const groups = groupModelsByVendor(pickerModels, pickerFilter);
                if (groups.length === 0) {
                  return (
                    <p className="px-2 py-1 text-xs text-l4">
                      没有匹配的模型。请先同步模型目录，或清除筛选词。
                    </p>
                  );
                }
                return groups.map((g) => {
                  const open =
                    pickerFilter.trim() !== "" || openVendors.has(g.vendor);
                  return (
                    <div key={g.vendor}>
                      <button
                        type="button"
                        onClick={() =>
                          setOpenVendors((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.vendor)) next.delete(g.vendor);
                            else next.add(g.vendor);
                            return next;
                          })
                        }
                        className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs font-medium text-l2 hover:bg-hover"
                      >
                        <FoldMark open={open} />
                        {g.vendor}
                        <span className="text-micro text-l4">
                          {g.models.length}
                        </span>
                      </button>
                      {open &&
                        g.models.map((m) => {
                          const added = form.models.some((x) => x.trim() === m);
                          return (
                            <button
                              key={m}
                              type="button"
                              disabled={added}
                              onClick={() => addModelToList(m)}
                              className="flex w-full items-center justify-between gap-2 rounded-sm py-1 pl-7 pr-2 text-left font-mono text-micro text-l2 hover:bg-hover disabled:opacity-40"
                            >
                              <span className="truncate">{m}</span>
                              {added && (
                                <span className="shrink-0 text-l4">
                                  已添加
                                </span>
                              )}
                            </button>
                          );
                        })}
                    </div>
                  );
                });
              })()}
            </div>
          )}
          {/* 空模型是个静默陷阱（pty.rs）：models 为空时**完全不注入**模型环境变量，
              CLI 用自己的默认值——用户看到的现象就是「切了没反应」。API 类配置才提示，
              官方账号本就由 CLI 自己决定模型；空串槽位不算已填 */}
          {/* 行式槽位列表：已有模型一行一个（首个非空 = 默认），尾部只留 1 个空槽手填——
              不按选择器容量铺一排空行（视觉噪音）；超容量仍可经「仍要添加」补充
              （超出的不进 CLI 选择器，但启动栏/手输可用，见 model-switch.ts 语义） */}
          {(() => {
            const max = MODEL_SWITCH[form.agent]?.max ?? null;
            const filled = form.models.filter((m) => m.trim()).length;
            const slots = [...form.models];
            if (slots.length === 0 || slots[slots.length - 1].trim() !== "")
              slots.push("");
            const firstFilled = slots.findIndex((m) => m.trim());
            return (
              <div className="space-y-0.5">
                {max != null && filled > max && (
                  <div className="mb-1 flex items-center gap-2 text-xs text-warn-text">
                    <span>选择器只显示前 {max} 个，另有 {filled - max} 个不会进 CLI</span>
                    <button
                      type="button"
                      onClick={() =>
                        setForm({
                          ...form,
                          models: form.models
                            .map((m) => m.trim())
                            .filter(Boolean)
                            .slice(0, max),
                        })
                      }
                      className="text-l3 hover:text-l1"
                    >
                      只保留前 {max} 个
                    </button>
                  </div>
                )}
                {slots.map((m, i) => (
                  <div
                    key={i}
                    title={(() => {
                      const c = capabilities.find(
                        (item) => item.model === m.trim(),
                      );
                      if (!m.trim() || !c) return undefined;
                      const flags = [
                        c.thinking ? "思考" : null,
                        c.tools === true
                          ? "工具"
                          : c.tools === false
                            ? "无工具"
                            : "工具未知",
                        c.vision === true
                          ? "图像"
                          : c.vision === false
                            ? "无图像"
                            : "图像未知",
                      ].filter(Boolean);
                      return `${flags.join(" · ")} · 上下文 ${(c.context / 1024).toFixed(0)}K`;
                    })()}
                    className="group flex items-center gap-2 rounded-sm px-2 py-0.5 hover:bg-hover"
                  >
                    <span className="w-4 shrink-0 text-right text-micro text-l4">
                      {i + 1}
                    </span>
                    <input
                      className="min-w-0 flex-1 bg-transparent py-0.5 font-mono text-xs text-l2 outline-none placeholder:font-sans placeholder:text-l4"
                      placeholder="模型名，如 gpt-5.6-sol"
                      value={m}
                      onChange={(e) => setModelSlot(i, e.target.value)}
                    />
                    {i === firstFilled && (
                      <span className="shrink-0 text-micro text-l1">默认</span>
                    )}
                    <button
                      type="button"
                      aria-label={m.trim() ? `移除 ${m}` : "清空此行"}
                      onClick={() => removeModelSlot(i)}
                      className={`flex h-7 w-7 shrink-0 items-center justify-center text-l4 hover:text-err-text ${hoverRevealClass}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {max != null && filled >= max && (
                  <button
                    type="button"
                    onClick={() =>
                      setForm({ ...form, models: [...form.models, ""] })
                    }
                    className="px-2 py-1 text-xs text-l3 hover:text-l1"
                  >
                    ＋ 仍要添加（选择器只显示前 {max} 个）
                  </button>
                )}
              </div>
            );
          })()}
        </div>
        {/* 模型分工（2026-10-17）：哪些小任务 / 子 Agent 用哪个模型，原先由 Mesa 暗中补齐，现在摆出来可改 */}
        {form.accountType === "api" && rolesFor(form.agent).length > 0 && (() => {
          const listed = [...new Set(form.models.map((m) => m.trim()).filter(Boolean))];
          const aliases = form.agent === "claude-code" ? claudeAliasMap(listed, form.roleModels) : [];
          // 没在启动时选模型时，主模型 = 名单第一个
          const mainHint = listed[0] ? `（没选时是 ${listed[0]}）` : "";
          const selectCls =
            "w-full rounded-md border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none focus:border-l4";
          return (
            <div className="mb-4">
              <span className="mb-1 block text-xs text-l3">模型分工</span>
              <div className="rounded-md border border-hairline">
                <div className="space-y-2.5 px-3 py-2.5">
                  {rolesFor(form.agent).map((r) => (
                    <label key={r.key} className="grid grid-cols-[6.5rem_1fr] items-start gap-x-3">
                      <span className="pt-1 text-xs text-l2">{r.label}</span>
                      <span className="min-w-0">
                        <select
                          className={selectCls}
                          value={form.roleModels[r.key] ?? ""}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              roleModels: { ...form.roleModels, [r.key]: e.target.value || null },
                            })
                          }
                        >
                          <option value="">跟主模型{mainHint}</option>
                          {listed.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                        <span className="mt-0.5 block text-micro leading-4 text-l4">{r.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {aliases.length > 0 && (
                  // Claude 四个别名的实际指向：原先是底部一行小灰字，用户看不见（2026-10-17 截图）——
                  // 改成和上面同层级的一张小表，空槽明写「跟主模型」
                  <div className="border-t border-hairline px-3 py-2.5">
                    <div className="mb-1.5 flex items-baseline justify-between">
                      <span className="text-xs text-l2">Claude 别名指向</span>
                      <span className="text-micro text-l4">按上面的名单和分工自动算，只读</span>
                    </div>
                    <div className="grid grid-cols-[4.5rem_1fr_auto] gap-x-3 gap-y-1 text-xs">
                      {aliases.map((a) => (
                        <Fragment key={a.alias}>
                          <span className="font-mono text-l3">{a.alias}</span>
                          <span className={`truncate font-mono ${a.model ? "text-l1" : "text-l3"}`}>
                            {a.model ?? `跟主模型${mainHint}`}
                          </span>
                          <span className="text-micro text-l4">{a.why}</span>
                        </Fragment>
                      ))}
                    </div>
                    <p className="mt-2 text-micro leading-4 text-l4">
                      在 Claude 里用 /model 选 sonnet、opus 这些别名，或它自己派小任务时，用的就是右边的模型。你本机 Claude 设置里的同名配置在 Mesa 启动的会话里会被这里盖过，不改你的配置文件。
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
        {/* 同时绑到：换 Agent 不必重走一遍「添加连接 → 选网关 → 挑模型」——
            同一份网关和模型名单一次建多条绑定；协议按各家默认推导，保存后可单独调整 */}
        {showGatewayFields && form.accountType === "api" && (
          <div className="mb-4">
            <span className="mb-1 block text-xs text-l3">
              同时绑到（可选，省去逐家重配）
            </span>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {extraBindTargets(
                form.agent,
                form.protocol,
                AGENTS.map((a) => a.id),
              ).map((t) => (
                <Checkbox
                  key={t.agent}
                  className="text-xs"
                  disabled={!t.ok}
                  title={t.reason}
                  checked={extraAgents.includes(t.agent)}
                  onChange={(checked) =>
                    setExtraAgents((cur) =>
                      checked
                        ? [...cur, t.agent]
                        : cur.filter((x) => x !== t.agent),
                    )
                  }
                  label={AGENTS.find((a) => a.id === t.agent)?.label ?? t.agent}
                />
              ))}
            </div>
            <p className="mt-1 text-micro text-l4">
              保存时用同一份网关和模型名单给勾选的 Agent 各建一条绑定，协议自动按各家适配。
              {/* 灰掉的原因原先只在悬停里，看上去像坏了 */}
              {extraBindTargets(form.agent, form.protocol, AGENTS.map((a) => a.id)).some(
                (t) => !t.ok,
              ) && " 灰色的几家和这个端点的协议不兼容，勾不了（鼠标停上去看原因）。"}
            </p>
          </div>
        )}
        <details
          className="mb-4 border-t border-hairline pt-3"
          onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        >
          {/* 折叠指示统一 FoldMark（设计系统禁手写 ▸/▾；原生 summary 三角也算） */}
          <summary className="flex cursor-pointer list-none select-none items-center gap-1 text-xs font-medium text-l2 [&::-webkit-details-marker]:hidden">
            <FoldMark open={advancedOpen} />
            高级设置
          </summary>
          <div className="mt-3">
            {showGatewayFields && (
              <label className="mb-3 flex items-center gap-2 text-xs text-l2">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={form.noAuth}
                  onChange={(e) => setForm({ ...form, noAuth: e.target.checked })}
                />
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-field bg-canvas text-micro text-cta-text transition-colors peer-checked:border-cta-bd peer-checked:bg-cta peer-checked:after:content-['✓']"
                />
                本地端点无密钥
              </label>
            )}
            {AGENT_PROTOCOLS[form.agent] && (
              derivedProtocol ? (
                <div className="mb-3 text-sm">
                  <span className="mb-1 block text-xs text-l3">协议</span>
                  <p className="text-xs text-l2">
                    {derivedProtocol}
                    <span className="ml-1.5 text-micro text-l4">按网关已填槽位自动确定</span>
                  </p>
                </div>
              ) : (
              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-xs text-l3">协议</span>
                <MenuSelect
                  aria-label="协议"
                  value={form.protocol ?? AGENT_PROTOCOLS[form.agent].default}
                  options={AGENT_PROTOCOLS[form.agent].options.map((p) => ({ value: p, label: p }))}
                  onChange={(protocol) => setForm({ ...form, protocol })}
                />
              </label>
              )
            )}
            {form.agent === "grok" && form.accountType === "api" && (
              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-xs text-l3">API 后端</span>
                <MenuSelect
                  aria-label="API 后端"
                  value={form.apiBackend ?? ""}
                  options={[
                    { value: "", label: "默认（chat_completions）" },
                    { value: "responses", label: "responses" },
                    { value: "messages", label: "messages" },
                  ]}
                  onChange={(v) => setForm({ ...form, apiBackend: v || null })}
                />
                <span className="mt-1 block text-micro text-l4">
                  启动注入改不了后端（grok overlay 白名单不放行），此项随「设为全局默认」写入 ~/.grok/config.toml 的 [model.*] 段；中转目录条目带 apiBackend 字段时以目录为准之外的另一渠道
                </span>
              </label>
            )}
            {form.accountType === "api" && initial && !showGatewayFields && (
              // 编辑已有绑定：这里没有可改的策略字段，原先摆一个「请求策略」框装两段重复说明
              <p className="mb-3 text-xs text-l3">
                思考档、温度、输出上限按模型在网关库里设置。
                {onOpenGateway && initial.gatewayId && (
                  <button
                    type="button"
                    className="ml-1 text-cta hover:underline"
                    onClick={() => {
                      onOpenGateway(initial.gatewayId!);
                      onClose();
                    }}
                  >
                    打开网关库
                  </button>
                )}
                {/* 已存策略「存了但注不进去」的说明照留：这是编辑时唯一需要知道的策略事实 */}
                {combo?.policyChannelNote && (
                  <span className="mt-1 block text-micro text-l4">{combo.policyChannelNote}</span>
                )}
                {combo?.effortReadonly && (
                  <span className="mt-1 block text-micro text-l4">思考档已保存在网关，当前 CLI 没有注入通道，启动时不会写进去。</span>
                )}
                {combo?.mixedModelsNote && (
                  <span className="mt-1 block text-micro text-warn-text">{combo.mixedModelsNote}</span>
                )}
              </p>
            )}
            {form.accountType === "api" && !(initial && !showGatewayFields) && (
            <div className="mb-3 rounded border border-hairline ccode-well p-2">
              <p className="mb-2 text-xs font-medium text-l2">请求策略</p>
              {combo?.policyChannelNote && (
                <p className="mb-1 text-micro text-l3">{combo.policyChannelNote}</p>
              )}
              {combo?.effortReadonly && (
                <p className="mb-1 text-micro text-l3">思考档已保存在网关，当前 CLI 没有注入通道，启动时不会写进去。</p>
              )}
              {combo && combo.channelTemperature !== "inject" && form.requestPolicy.temperature != null && (
                <p className="mb-1 text-micro text-l3">{combo.channelTemperature === "persist" ? "温度已保存在网关，仅「设为全局默认」写入后生效，启动注入不携带。" : "温度已保存在网关，当前 CLI 没有通道，启动时不会注入。"}</p>
              )}
              {combo?.mixedModelsNote && (
                <InlineNotice tone="warn" size="micro" className="mb-1">{combo.mixedModelsNote}</InlineNotice>
              )}
              {!initial && bindMode === "new" && (
                <>
              <div className="grid grid-cols-3 gap-2">
                {([[
                  "temperature", "temperature", "temperature"], ["topP", "top_p", "topP"], ["maxOutputTokens", "max output", "maxOutputTokens"]] as const).map(([key, label, capability]) => {
                  const support = agentCapabilities?.requestPolicy[capability];
                  return <label key={key} className="text-xs text-l3">{label}<span className="ml-1 text-micro text-l4">协议{channelLabel(support)}</span><input className={fieldClass} type="number" min={key === "temperature" ? "0" : key === "topP" ? "0" : "1"} max={key === "temperature" ? "2" : key === "topP" ? "1" : undefined} step={key === "temperature" ? "0.1" : key === "topP" ? "0.05" : "1"} placeholder="默认" value={form.requestPolicy[key] ?? ""} onChange={(e) => { const n = parseOptionalNumber(e.target.value); if (n !== undefined) setForm({ ...form, requestPolicy: { ...form.requestPolicy, [key]: n } }); }} /></label>;
                })}
              </div>
              <label className="mt-2 block text-xs text-l3">reasoning effort<span className="ml-1 text-micro text-l4">协议{channelLabel(agentCapabilities?.requestPolicy.reasoningEffort)}</span>{agentCapabilities?.effortOptions?.length ? (
                <MenuSelect
                  aria-label="reasoning effort"
                  value={form.requestPolicy.reasoningEffort ?? ""}
                  options={[
                    { value: "", label: "默认" },
                    ...agentCapabilities.effortOptions.map((opt) => ({ value: opt, label: opt })),
                  ]}
                  onChange={(v) => setForm({ ...form, requestPolicy: { ...form.requestPolicy, reasoningEffort: v || null } })}
                />
              ) : (
                <input className={fieldClass} placeholder="如 low / medium / high" value={form.requestPolicy.reasoningEffort ?? ""} onChange={(e) => setForm({ ...form, requestPolicy: { ...form.requestPolicy, reasoningEffort: e.target.value || null } })} />
              )}</label>
                </>
              )}
              {initial && (
                <p className="mb-2 text-micro text-l4">思考档 / 温度 / 输出上限在网关库里按模型编辑，这里改了也不会覆盖已有逐模型策略。</p>
              )}
              {showGatewayFields && (
              <label className="mt-2 block text-xs text-l3">自定义 Header（Header 名=环境变量名）<span className="ml-1 text-micro text-l4">协议{channelLabel(agentCapabilities?.requestPolicy.customHeaders)}</span><textarea className={`${fieldClass} h-16 font-mono text-xs`} placeholder="X-Provider-Region=MODEL_REGION\nX-Trace-Id=TRACE_ID" value={headerEnvText} onChange={(e) => setHeaderEnvText(e.target.value)} /></label>
              )}
              {showGatewayFields && (
                <p className="mt-1 text-micro text-l4">自定义 Header 跟着网关走，思考档和温度跟着每个模型走。Header 的值只写环境变量名，Mesa 不保存明文。</p>
              )}
            </div>
            )}
            <label className="block text-sm">
              <span className="mb-1 block text-xs text-l3">
                附加环境变量（每行 KEY=VALUE，可覆盖内置值
                {form.accountType === "official" ? "与设置页出网代理" : ""}）
              </span>
              <textarea
                className={`${fieldClass} h-20 font-mono text-xs`}
                placeholder={
                  "HTTPS_PROXY=http://127.0.0.1:7890\nNO_PROXY=localhost,127.0.0.1"
                }
                value={form.extraEnvText}
                onChange={(e) =>
                  setForm({ ...form, extraEnvText: e.target.value })
                }
              />
            </label>
            {form.agent === "kimi" && (
              <p className="mt-1 text-micro text-l4">
                Kimi 窄通道（不自动注入，按需在此声明）：KIMI_MODEL_ADAPTIVE_THINKING=true/false（Anthropic 通道思考形态）、KIMI_MODEL_REASONING_KEY=reasoning_content/reasoning_details/reasoning（OpenAI 通道思考字段方言，中转异常时 pin）
              </p>
            )}
          </div>
        </details>
        {error && <NoticeBar tone="err" className="mb-3">{error}</NoticeBar>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={secondaryActionClass}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving}
            className={primaryActionClass}
          >
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 分组折叠状态持久化的 localStorage key：值为折叠中的 agent id 数组 */
const COLLAPSED_KEY = "ccode.profiles.collapsed";

/** 读取已持久化的折叠分组；无记录时默认折叠「还没有连接」的组，避免空组淹没已有连接 */
function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) {
      const list = useAppStore.getState().profiles;
      return new Set(
        AGENTS.filter((a) => !list.some((p) => p.agent === a.id)).map(
          (a) => a.id,
        ),
      );
    }
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

interface AgentCmdResult {
  ok: boolean;
  output: string;
  method: string;
  versionBefore: string | null;
  versionAfter: string | null;
}

/** 最新版检查结果（check_agent_updates）；latest 为 null 表示该渠道查不到 */
interface AgentUpdateInfo {
  id: string;
  installed: string | null;
  latest: string | null;
  outdated: boolean;
  /** brew 渠道滞后提示：上游 npm 已更新的版本号；查不到为 null */
  upstreamNote: string | null;
  /** 上游 npm 包名（配套 upstreamNote，供复制 npm 安装命令） */
  upstreamPackage: string | null;
  /** 渠道切换一体命令（brew 卸载 + npm 安装），配套 upstreamNote */
  upstreamCommand: string | null;
  /** 本次更新将走交互式 TUI 自更新（kimi upgrade 方向键选择界面）：更新改在完整终端执行 */
  interactiveTui: boolean;
  /** 交互式自更新的终端预填命令（interactiveTui 为 true 时必有值） */
  interactiveUpdateCommand: string | null;
}

/** 各 agent 在 TUI 模型切换页可用的模型数上限（注入模式；matrix 调研结论）。
 *  max = null 表示不限（选择器列出全部已配置模型） */

/** 各 CLI 断开官方账号的方式（Mesa 不删 auth 文件，引导用 CLI 自己的 logout；
 *  命令按官方文档/CLI help 核实，见 agent_specs.rs 的 official_account 注释） */
const OFFICIAL_LOGOUT_HINT: Record<string, string> = {
  "claude-code": "claude auth logout（或 TUI 内 /logout）",
  codex: "codex logout",
  gemini: "TUI 内 /auth signout",
  codebuddy: "TUI 内 /logout",
  cursor: "cursor-agent logout",
  grok: "grok logout",
  kimi: "TUI 内 /logout",
  qwen: "TUI 内 /auth",
};

const displayHost = endpointHost;

/** 连接列表五列网格模板：名称 | 域名 | 模型 | 密钥状态 | 操作。
 *  官方账号行与数据行共用同一模板，保证上下行严格垂直对齐；
 *  操作列 170px 刚好容纳「两枚 hover 图标钮 + 编辑 + ⋯」，再宽会在中等窗口把行撑出横向滚动 */
const PROFILE_GRID =
  "grid-cols-[minmax(150px,1.1fr)_minmax(140px,0.9fr)_minmax(150px,1fr)_110px_170px]";

/** 连接状态微型胶囊（Pill Badge）：每行只出一个最高优先级状态
 *  （配置失效 > 已停用 > 已验证 > 未验证），不再多标记堆叠；
 *  「默认」「全局生效」不是健康状态，收进名称下方 caption 行 */
function StatusPill({
  tone,
  tip,
  children,
}: {
  tone: "ok" | "err" | "muted";
  tip: string;
  children: string;
}) {
  const cls =
    tone === "ok"
      ? "bg-ok text-ok-text"
      : tone === "err"
        ? "bg-err text-err-text"
        : "bg-inset text-l4";
  return (
    <span
      className={`ml-1.5 inline-flex items-center whitespace-nowrap rounded-full px-1.5 py-px text-micro font-normal ${cls}`}
      title={tip}
    >
      {children}
    </span>
  );
}

/** 官方账号状态：收进组头芯片（已安装才挂），不再占一整行「未连接」。
 *  未连接仍出「连接」——那是 CLI 登录入口，不是「+ 添加连接」。
 *  hook 约束：挂在 per-agent 组头上，useHoverTip 才能逐组实例化。 */
function OfficialStatusChip({
  agentId,
  st,
  onConnect,
}: {
  agentId: string;
  st: OfficialAccountStatusDto;
  onConnect: () => void;
}) {
  const anchorRef = useRef<HTMLElement>(null);
  const { tip, show, hide } = useHoverTip(anchorRef);
  const hasOutboundProxy = Boolean(
    useAppStore((s) => s.settings?.outboundProxy?.trim()),
  );
  const lines: string[] = [];
  if (st.detail) lines.push(st.detail);
  if (st.connected) {
    const hint = OFFICIAL_LOGOUT_HINT[agentId];
    if (hint) lines.push(`断开方式：${hint}`);
  } else if (st.loginCommand) {
    lines.push(`点「登录」将在终端执行：${st.loginCommand}`);
  }
  if (!hasOutboundProxy) {
    lines.push("官方通道直连厂商；国内网络请在设置 → 网络填写出网代理");
  }
  if (st.connected) {
    return (
      <span
        ref={anchorRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        tabIndex={0}
        className="flex cursor-default items-center gap-1 px-1 text-micro text-ok-text"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-ok-text" />
        官方
        {lines.length > 0 && <HoverTip tip={tip} text={lines.join("\n")} />}
      </span>
    );
  }
  return (
    <span ref={anchorRef} className="inline-flex text-xs">
      <button
        type="button"
        onMouseEnter={show}
        onMouseLeave={hide}
        onClick={onConnect}
        title={lines.join("\n") || "在终端登录官方账号"}
        className={rowActionClass}
      >
        登录
      </button>
      {lines.length > 0 && <HoverTip tip={tip} text={lines.join("\n")} />}
    </span>
  );
}

/** 失败诊断：按输出/方式文本给一条下一步建议，无匹配则不提示（纯函数，可单测） */
function diagnose(output: string, method: string): string | null {
  const lower = output.toLowerCase();
  if (
    method.includes("brew") &&
    (output.includes("formulae.brew.sh") || output.includes("Downloading"))
  ) {
    return "brew 元数据下载异常：先在系统终端跑 `brew doctor` 检查 brew 状态，或重试（会走 TUNA 镜像）";
  }
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    output.includes("Could not resolve") ||
    output.includes("Failed to connect")
  ) {
    return "网络连接问题：检查代理设置；如在国内网络，brew 已自动走国内镜像（元数据 TUNA、包体南大 ghcr 代理），npm 可配置 registry.npmmirror.com 镜像";
  }
  if (output.includes("EACCES") || lower.includes("permission denied")) {
    if (/Windows/i.test(navigator.userAgent)) {
      return "Windows 权限不足：请先安装 Node.js LTS 并重新打开 Mesa；若 Node.js 已安装，请确认 npm 全局目录可写，再重试。";
    }
    return "权限不足：该命令需要写入全局目录，检查安装目录权限";
  }
  if (output.includes("命令超时")) {
    return method.includes("npm")
      ? "npm 安装超过 15 分钟仍未完成，已自动终止：请检查 registry/代理设置后重试"
      : "命令超过 15 分钟未完成，已自动终止：通常是下载过慢，重试或检查网络";
  }
  return null;
}

/** Windows 上有官方 winget 包的 agent（与 agent_specs.rs 的 winget 字段同源，新增时同步） */
const WINGET_AGENTS = new Set(["claude-code", "codex", "opencode", "kimi", "grok"]);

function installToolHelp(agentId: string): string {
  if (/Windows/i.test(navigator.userAgent)) {
    if (agentId === "cursor") {
      return "Cursor CLI 官方仅支持 macOS/Linux，Windows 请在 WSL 中安装 cursor-agent，或改用其他 Agent。";
    }
    if (WINGET_AGENTS.has(agentId)) {
      return "未找到可用的安装工具：winget 与 Node.js 都不可用。该 agent 在 Windows 上有两条路——① 系统自带 winget：若被卸载，请在 Microsoft Store 安装「应用安装程序」；② 安装 Node.js LTS 走 npm 渠道（下载：https://nodejs.org/en/download）。完成后完全退出并重新打开 Mesa。";
    }
    return "未找到可用的安装工具：该 agent 在 Windows 上只能走 npm 渠道。请先安装 Node.js LTS（自带 npm），安装完成后完全退出并重新打开 Mesa 再重试。下载：https://nodejs.org/en/download";
  }
  return "未找到可用的安装工具。请先安装 Node.js（会同时提供 npm），然后完全退出并重新打开 Mesa 再重试。";
}

function validationTone(status: ValidationCheckDto["status"]): string {
  if (status === "passed") return "text-ok-text";
  if (status === "failed") return "text-err-text";
  return "text-l4";
}

function ValidationDialog({
  profile,
  result,
  running,
  onClose,
}: {
  profile: Profile;
  result: ProfileValidationDto | null;
  running: boolean;
  onClose: () => void;
}) {
  const rows: Array<[string, ValidationCheckDto | null]> = [
    ["本地配置解析", result?.local ?? null],
    ["CLI 预检", result?.cli ?? null],
    ["API / 模型", result?.api ?? null],
  ];
  return (
    <Modal
      open
      title={`验证连接 · ${profile.name}`}
      description="密钥只在后端用于预检，不会返回界面"
      onClose={onClose}
      size="lg"
      dismissOnBackdrop={!running}
      footer={
        !running ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 items-center justify-center rounded-md border border-field bg-strip px-3 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1"
          >
            关闭
          </button>
        ) : undefined
      }
    >
        <div className="divide-y divide-hairline">
          {rows.map(([label, item], index) => (
            <div
              key={label}
              className="grid grid-cols-[24px_112px_1fr] gap-2 px-4 py-3 text-xs"
            >
              <span className={item ? validationTone(item.status) : "text-l4"}>
                {item?.status === "passed"
                  ? "✓"
                  : item?.status === "failed"
                    ? "✗"
                    : "—"}
              </span>
              <span className="font-medium text-l2">{label}</span>
              <div className="min-w-0 text-l3">
                <p className="break-words">
                  {item?.message ??
                    (running && index === 0 ? "正在检查…" : "等待检查")}
                </p>
                {item?.latencyMs != null && (
                  <span className="mt-1 block font-mono text-l4">
                    {item.latencyMs}ms
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <footer className="border-t border-hairline px-4 py-3 text-xs">
          {running ? (
            <span className="text-l3">
              正在执行 CLI 与最小模型列表请求，最长约 35 秒…
            </span>
          ) : result ? (
            <span className={result.ok ? "text-ok-text" : "text-err-text"}>
              {result.ok
                ? "✓ 三层验证完成"
                : "✗ 存在未通过项目，请按上方信息修复后重试"}
            </span>
          ) : null}
        </footer>
    </Modal>
  );
}

/** 启动计划预览弹层：结构化展示二进制/参数/注入 env（含来源）/清理变量/初始指令注入，
    密钥值永不显示 */
function PreviewDialog({
  profile,
  result,
  onClose,
}: {
  profile: Profile;
  result: LaunchPlanPreviewDto;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      title={`启动计划预览 · ${profile.name}`}
      description="启动时实际注入的完整参数与环境变量"
      onClose={onClose}
      size="lg"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 items-center justify-center rounded-md border border-field bg-strip px-3 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1"
        >
          关闭
        </button>
      }
    >
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-4 py-3 text-xs">
          <div>
            <p className="mb-1 font-medium text-l2">二进制</p>
            <p className="break-all font-mono text-l3">
              {result.binary ?? "未找到"}
            </p>
          </div>
          <div>
            <p className="mb-1 font-medium text-l2">参数</p>
            {result.args.length ? (
              <ul className="space-y-0.5">
                {result.args.map((arg, index) => (
                  <li key={index} className="break-all font-mono text-l3">
                    {arg}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-l4">（无）</p>
            )}
          </div>
          <div>
            <p className="mb-1 font-medium text-l2">注入环境变量</p>
            {result.env.length ? (
              <ul className="space-y-1">
                {result.env.map((item, index) => (
                  <li key={index} className="flex flex-wrap items-baseline gap-2">
                    <span className="rounded border border-hairline px-1.5 py-0.5 font-mono text-micro text-l2">
                      {item.name}
                    </span>
                    <span className="text-l4">{item.source}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-l4">（无）</p>
            )}
          </div>
          {result.notes.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-l2">协议与上下文</p>
              <ul className="space-y-0.5">
                {result.notes.map((note, index) => (
                  <li key={index} className="text-l3">
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.overlays.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-l2">配置 overlay</p>
              {result.overlays.map((overlay, index) => (
                <div key={index} className="mb-2">
                  <span className="rounded border border-hairline px-1.5 py-0.5 font-mono text-micro text-l2">
                    {overlay.name}
                  </span>
                  <pre className="mt-1 overflow-x-auto rounded border border-hairline p-2 font-mono text-micro text-l3">
                    {overlay.content}
                  </pre>
                  {overlay.note && (
                    <p className="mt-1 text-micro text-l4">{overlay.note}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          <div>
            <p className="mb-1 font-medium text-l2">清理继承变量</p>
            {result.envRemove.length ? (
              <div className="flex flex-wrap gap-1.5">
                {result.envRemove.map((name) => (
                  <span
                    key={name}
                    className="rounded border border-hairline px-1.5 py-0.5 font-mono text-micro text-l2"
                  >
                    {name}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-l4">（无）</p>
            )}
          </div>
          <div>
            <p className="mb-1 font-medium text-l2">初始指令注入</p>
            <p className="text-l3">
              {result.promptSupported ? "支持" : "不支持，需手动发送"}
            </p>
          </div>
        </div>
        <footer className="border-t border-hairline px-4 py-3 text-xs text-l4">
          密钥值永不显示；同名变量后者覆盖前者（附加环境变量优先级最高）
        </footer>
    </Modal>
  );
}

function changeOpLabel(op: string): string {
  if (op === "add") return "新增";
  if (op === "remove") return "删除";
  if (op === "modify") return "修改";
  return op;
}

function fileActionLabel(action: string): string {
  if (action === "create") return "新建";
  if (action === "modify") return "修改";
  return action;
}

/** 「设为全局默认」确认前的脱敏预览：文件、字段增删改、此入口带不上的策略、是否要重开。 */
function GlobalWritePreviewDialog({
  profile,
  loading,
  preview,
  error,
  conflict,
  onCancel,
  onConfirm,
}: {
  profile: Profile;
  loading: boolean;
  preview: GlobalWritePreviewDto | null;
  error: string | null;
  conflict: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open
      title={`写入 CLI 全局默认 · ${profile.name}`}
      description="先看将改哪些文件。确认后才写入；失败自动回滚。"
      onClose={onCancel}
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-7 items-center justify-center rounded-md border border-field bg-strip px-3 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1"
          >
            取消
          </button>
          <button
            type="button"
            autoFocus={!conflict}
            disabled={loading || !preview || !!error}
            onClick={onConfirm}
            className="inline-flex h-7 items-center justify-center rounded-md border border-cta-bd bg-cta px-3 text-xs font-medium text-cta-text transition-[filter] hover:brightness-110 disabled:opacity-50"
          >
            {conflict ? "仍要写入" : "写入全局默认"}
          </button>
        </>
      }
    >
      <div className="space-y-3 px-4 py-3 text-xs leading-5">
        {loading && <p className="text-l3">◌ 正在对照磁盘生成脱敏预览…</p>}
        {error && <InlineNotice tone="err">{error}</InlineNotice>}
        {conflict && (
          <InlineNotice tone="warn">{conflict}</InlineNotice>
        )}
        {preview && (
          <>
            <p className="text-l3">{preview.scopeNote}</p>
            {preview.files.length === 0 ? (
              <p className="text-l3">磁盘已是这份配置，再写入不会改内容。</p>
            ) : (
              <ul className="space-y-2">
                {preview.files.map((file) => (
                  <li key={file.path}>
                    <p className="font-medium text-l2">
                      {fileActionLabel(file.action)} {file.path}
                    </p>
                    <ul className="mt-1 space-y-0.5 font-mono text-micro text-l3">
                      {file.changes.map((c) => (
                        <li key={`${c.op}:${c.path}`} className="break-all">
                          {changeOpLabel(c.op)} {c.path}
                          {c.op === "remove"
                            ? c.before
                              ? ` ← ${c.before}`
                              : ""
                            : c.after
                              ? ` → ${c.after}`
                              : ""}
                        </li>
                      ))}
                    </ul>
                    {file.omitted > 0 && (
                      <p className="text-micro text-l4">另有 {file.omitted} 项未列出</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {preview.skippedPolicies.length > 0 && (
              <div>
                <p className="font-medium text-l2">不会通过此入口生效</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-l3">
                  {preview.skippedPolicies.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-l3">{preview.restartNote}</p>
          </>
        )}
      </div>
    </Modal>
  );
}

/** 「设为全局」进度/结果弹层：确认后立即弹出（写入 + CLI 复检含网络检查，要几秒到
    十几秒，没反馈像点了没反应）；完成后同层切换为结果视图；验证未通过可一键展开
    三层验证详情（复用 ValidationDialog）。进行中禁关（点遮罩无效、无关闭钮）防误触 */
function GlobalApplyDialog({
  profile,
  running,
  applied,
  error,
  onClose,
  onShowValidation,
}: {
  profile: Profile;
  running: boolean;
  applied: GlobalApplyResultDto | null;
  error: string | null;
  onClose: () => void;
  onShowValidation: () => void;
}) {
  const cli = applied?.validation.cli ?? null;
  return (
    <Modal
      open
      title={`写入 CLI 全局默认 · ${profile.name}`}
      description="已写入外部 CLI 配置文件；失败已回滚。不改 Mesa 启动预选。"
      onClose={onClose}
      size="lg"
      dismissOnBackdrop={!running}
      footer={
        !running ? (
          <>
            {applied && !applied.validation.ok && (
              <button
                type="button"
                onClick={onShowValidation}
                className="inline-flex h-7 items-center justify-center rounded-md border border-field bg-strip px-3 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1"
              >
                查看验证详情
              </button>
            )}
            <button
              type="button"
              autoFocus
              onClick={onClose}
              className="inline-flex h-7 items-center justify-center rounded-md border border-cta-bd bg-cta px-3 text-xs font-medium text-cta-text transition-[filter] hover:brightness-110"
            >
              知道了
            </button>
          </>
        ) : undefined
      }
    >
        <div className="px-4 py-3 text-xs leading-5">
          {running ? (
            <p className="text-l3">
              ◌ 正在写入全局配置并做 CLI 复检（含网络检查，可能要几秒到十几秒）…
            </p>
          ) : error ? (
            <p className="break-words text-err-text">{error}</p>
          ) : applied ? (
            <div className="space-y-2">
              <div>
                <p className="font-medium text-l2">已写入全局连接：</p>
                <ul className="mt-1 space-y-0.5 font-mono text-l3">
                  {applied.files.map((f) => (
                    <li key={f} className="break-all">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
              {cli && (
                <p
                  className={`break-words ${
                    cli.status === "passed" ? "text-ok-text" : "text-err-text"
                  }`}
                >
                  CLI 配置检查：{cli.status === "passed" ? "通过" : "未通过"} —{" "}
                  {cli.message}
                </p>
              )}
            </div>
          ) : null}
        </div>
    </Modal>
  );
}

export default function ProfilesPage({ visible }: { visible: boolean }) {
  const connectionLoadError = useAppStore((s) => s.connectionLoadError);
  const retryConnections = useAppStore((s) => s.loadAll);
  const profiles = useAppStore((s) => s.profiles);
  const profileIssues = useAppStore((s) => s.profileIssues);
  const [driftByAgent, setDriftByAgent] = useState<Record<string, GlobalDriftDto>>({});
  const [validationMap, setValidationMap] = useState<Record<string, { ok: boolean; checkedAt: string }>>(() => {
    try {
      return JSON.parse(localStorage.getItem("ccode.profileValidation") ?? "{}") as Record<string, { ok: boolean; checkedAt: string }>;
    } catch {
      return {};
    }
  });

  function rememberValidation(profileId: string, result: ProfileValidationDto) {
    const next = { ...validationMap, [profileId]: { ok: result.ok, checkedAt: result.checkedAt } };
    setValidationMap(next);
    try {
      localStorage.setItem("ccode.profileValidation", JSON.stringify(next));
    } catch {
      /* localStorage unavailable: current view still shows the result */
    }
  }

  // 组头「! N 项连接冲突」胶囊的点击弹层（锚定 agent 分组头）
  const [conflictPop, setConflictPop] = useState<{
    x: number;
    y: number;
    agentId: string;
  } | null>(null);

  // 各 profile 用量（按模型近似归属；模型跨 profile 共享时会重复计入）
  useEffect(() => {
    const agents = [...new Set(profiles.map((p) => p.agent))];
    let cancelled = false;
    Promise.all(
      agents.map(async (agent) => {
        try {
          return [agent, await invoke<GlobalDriftDto>("check_global_drift", { agent })] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const m: Record<string, GlobalDriftDto> = {};
      for (const e of entries) if (e) m[e[0]] = e[1];
      setDriftByAgent(m);
    });
    return () => {
      cancelled = true;
    };
  }, [profiles]);

  // 悬浮卡（用量 / 连接冲突）：Escape / 任意滚动即关闭（同 ContextMenu；滚动关闭也避免与锚点脱离）
  useEffect(() => {
    if (!conflictPop) return;
    const closeAll = () => {
      setConflictPop(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    // capture 阶段的滚动监听能捕获任意容器的滚动
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", closeAll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", closeAll, true);
    };
  }, [conflictPop]);
  const agents = useAppStore((s) => s.agents);
  const removeProfile = useAppStore((s) => s.removeProfile);
  const loadAll = useAppStore((s) => s.loadAll);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  // npm 渠道不可用时的「一键安装 Node.js」：渠道判定用依赖体检结果（dep-check.ts）
  const depCheck = useAppStore((s) => s.depCheck);
  const refreshDepCheck = useAppStore((s) => s.refreshDepCheck);
  // 记住是哪个 Agent 因缺 Node.js 装不了：Node.js 装好后清掉报错、接着走它的安装确认，
  // 不让用户再找一遍按钮
  const [nodeInstallFor, setNodeInstallFor] = useState<string | null>(null);
  const depInstall = useDepInstall((_tool, res) => {
    if (res.ok) {
      void refreshDepCheck();
      const pending = nodeInstallFor;
      setNodeInstallFor(null);
      setError(null);
      if (pending) void onInstall(pending);
    }
  });
  // 各 agent 官方账号连接状态（P1a；仅 supported 的 agent 会展示状态行）
  const [officialStatus, setOfficialStatus] = useState<
    Record<string, OfficialAccountStatusDto>
  >({});
  // 冲突提醒的显式忽略（同收件箱 v3.88 口径）：按「冲突清单签名」记录，⟳ 重检后
  // 残留项有增减（签名变化）提醒自动复现；只隐藏提醒，官方账号启动拦截仍在后端生效
  const [conflictDismissed, setConflictDismissed] = useState<Record<string, string>>(
    () => {
      try {
        return JSON.parse(
          localStorage.getItem("ccode.conflictDismissed") ?? "{}",
        ) as Record<string, string>;
      } catch {
        return {};
      }
    },
  );
  function dismissConflicts(agentId: string, conflicts: string[]) {
    const sig = [...conflicts].sort().join("\n");
    setConflictDismissed((prev) => {
      const next = { ...prev, [agentId]: sig };
      try {
        localStorage.setItem("ccode.conflictDismissed", JSON.stringify(next));
      } catch {
        /* 存储不可用仅本次会话生效 */
      }
      return next;
    });
    setConflictPop(null);
  }

  /** 重新检测某个 agent 的官方账号连接状态（只读 auth 文件，失败不影响页面） */
  async function refreshOfficial(agentId: string) {
    try {
      const st = await invoke<OfficialAccountStatusDto>(
        "official_account_status",
        { agentId },
      );
      setOfficialStatus((prev) => ({ ...prev, [agentId]: st }));
    } catch {
      toast(`无法读取 ${labelOf(agentId)} 官方账号状态`, "warning");
    }
  }

  // 页面保持挂载：挂载与每次回切本页都重新探测（登录在终端页完成后回来要能看到已连接；
  // 探测是本地 auth 文件只读扫描，成本低）
  useEffect(() => {
    if (!visible) return;
    for (const a of AGENTS) void refreshOfficial(a.id);
  }, [visible]);

  /** 「连接」：在内嵌终端开新标签执行 CLI 登录命令（Codex 走设备码，其余多为浏览器 OAuth）；回切本页自动刷新状态。
   *  reuseKey 去重：重复点「登录」聚焦已有标签而不是再开一个——两个 login 进程会各弹一个浏览器页 */
  function connectOfficial(agentId: string) {
    const st = officialStatus[agentId];
    if (!st?.loginCommand) return;
    const official = profiles.find(
      (p) => p.agent === agentId && p.accountType === "official",
    );
    setPendingTerminal({
      cwd: "~",
      extraEnv: { ...(st.loginEnv ?? {}), ...(official?.extraEnv ?? {}) },
      title: `登录 ${labelOf(agentId)}`,
      prefillCommand: st.loginCommand,
      shellOnly: true,
      reuseKey: `login:${agentId}`,
    });
    setPage("terminal");
  }

  async function clearAccountConflicts(agentId: string) {
    const st = officialStatus[agentId];
    if (!st?.cleanupSupported) return;
    if (!(await confirmDialog(`只移除 ${labelOf(agentId)} 已识别的 API 环境项，并保留其他配置。继续？`, { danger: true })))
      return;
    try {
      const files = await invoke<string[]>("clear_account_conflicts", { agentId });
      await refreshOfficial(agentId);
      setNotice(files.length ? `已清理：${files.join("、")}` : "没有可清理的已识别冲突项");
      setTimeout(() => setNotice(null), 5000);
    } catch (e) {
      setError(String(e));
    }
  }
  const [modal, setModal] = useState<{
    initial: Profile | null;
    presetAgent?: string;
  } | null>(null);
  const [gwLib, setGwLib] = useState(false);
  const [gwFocus, setGwFocus] = useState<string | null>(null);
  const [topMenu, setTopMenu] = useState<{ x: number; y: number } | null>(null);
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    profile: Profile;
  } | null>(null);
  const [groupMenu, setGroupMenu] = useState<{
    x: number;
    y: number;
    agentId: string;
  } | null>(null);
  // 「复制到其他 agent…」二级菜单（#14）：点 rowMenu 项后替换弹出，列出同协议族目标
  const [copyMenu, setCopyMenu] = useState<{
    x: number;
    y: number;
    profile: Profile;
  } | null>(null);
  const [validationDialog, setValidationDialog] = useState<{
    profile: Profile;
    result: ProfileValidationDto | null;
    running: boolean;
  } | null>(null);
  // 启动计划预览弹层（preview_launch_plan）：结构化展示，替代旧 alertDialog 堆文本
  const [previewDialog, setPreviewDialog] = useState<{
    profile: Profile;
    result: LaunchPlanPreviewDto;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 操作成功提示（复制到其他 agent 等），几秒后自动消失
  const [notice, setNotice] = useState<string | null>(null);
  const [syncingCatalogId, setSyncingCatalogId] = useState<string | null>(null);
  // 过滤条：按安装状态过滤 agent 组；按名称/端点/模型过滤配置行
  const [statusFilter, setStatusFilter] = useState<
    "all" | "installed" | "uninstalled"
  >("all");
  const [search, setSearch] = useState("");
  // 组折叠状态：首次默认折叠空组，手动折叠后持久化到 localStorage
  const [collapsedGroups, setCollapsedGroups] =
    useState<Set<string>>(loadCollapsedGroups);
  useEffect(() => {
    try {
      if (localStorage.getItem(COLLAPSED_KEY)) return;
    } catch {
      return;
    }
    setCollapsedGroups(
      new Set(
        AGENTS.filter((a) => !profiles.some((p) => p.agent === a.id)).map(
          (a) => a.id,
        ),
      ),
    );
  }, [profiles]);

  /** 更新折叠集合并同步写入 localStorage */
  function updateCollapsed(updater: (prev: Set<string>) => Set<string>) {
    setCollapsedGroups((prev) => {
      const next = updater(prev);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // 存储不可用时静默降级为仅本次会话生效
      }
      return next;
    });
  }
  const [globalBackups, setGlobalBackups] = useState<Record<string, boolean>>(
    {},
  );
  // 「首次写入前」原始快照（永久保留）：控制「恢复初始状态」入口显隐
  const [originalBackups, setOriginalBackups] = useState<Record<string, boolean>>(
    {},
  );
  // 公共模型能力库（models.dev/OpenRouter 下载）状态：顶部 ⋯ 菜单的下载/更新入口
  const [modelDb, setModelDb] = useState<{
    downloaded: boolean;
    models: number;
    pricedModels?: number;
    downloadedAt?: string | null;
  } | null>(null);
  const [modelDbBusy, setModelDbBusy] = useState(false);
  useEffect(() => {
    invoke<{
      downloaded: boolean;
      models: number;
      pricedModels?: number;
      downloadedAt?: string | null;
    }>("model_db_status")
      .then(setModelDb)
      .catch(() => toast("模型能力库状态读取失败", "warning"));
  }, []);

  /** 下载/更新公共模型能力库：下载后接入的模型自动带上正确的上下文/输出/视觉/推理声明与定价 */
  async function onModelDbDownload() {
    if (modelDbBusy) return;
    setModelDbBusy(true);
    setNotice("正在下载模型能力库…");
    try {
      const s = await invoke<{
        downloaded: boolean;
        models: number;
        pricedModels?: number;
        downloadedAt?: string | null;
      }>("download_model_db");
      setModelDb(s);
      setNotice(
        `模型能力库已就绪：${s.models} 个模型 · ${s.pricedModels ?? 0} 个带价`,
      );
      setTimeout(() => setNotice(null), 4000);
      setError(null);
    } catch (e) {
      setNotice(null);
      setError(String(e));
    } finally {
      setModelDbBusy(false);
    }
  }
  // 各 agent 的升级/安装进行态、实时输出与最近结果（可并发操作多个 agent）
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>({});
  const [updateResults, setUpdateResults] = useState<
    Record<string, AgentCmdResult>
  >({});
  // 更新成功提示 8s 自动收起（失败保留——输出要留着排错）；同一 agent 的新结果覆盖旧计时
  const updateResultTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>(
    {},
  );
  function applyUpdateResult(agentId: string, res: AgentCmdResult) {
    setUpdateResults((prev) => ({ ...prev, [agentId]: res }));
    clearTimeout(updateResultTimersRef.current[agentId]);
    if (!res.ok) return;
    updateResultTimersRef.current[agentId] = setTimeout(() => {
      setUpdateResults((prev) => {
        if (!prev[agentId]?.ok) return prev;
        const next = { ...prev };
        delete next[agentId];
        return next;
      });
    }, 8000);
  }
  useEffect(
    () => () => {
      for (const t of Object.values(updateResultTimersRef.current)) clearTimeout(t);
    },
    [],
  );
  // 各 agent 最新版检查（组头「新版/已更新」状态；查不到渠道的组头回退普通「更新」按钮）
  const [updateInfo, setUpdateInfo] = useState<Record<string, AgentUpdateInfo>>(
    {},
  );

  async function refreshUpdateInfo(force = false) {
    try {
      const list = await invoke<AgentUpdateInfo[]>("check_agent_updates", {
        force,
      });
      setUpdateInfo(Object.fromEntries(list.map((i) => [i.id, i])));
    } catch {
      /* 检查失败（网络等）不影响页面 */
    }
  }
  // 交互式自更新（kimi upgrade 等）路由到终端执行，绕过后端的缓存失效链路：
  // 记下待重查标记，回切本页时 force 刷新（页面在 App.tsx 保持挂载，不会重新 mount）
  const interactiveUpdateLaunchedRef = useRef(false);
  const visibleRef = useRef(visible);
  useEffect(() => {
    const was = visibleRef.current;
    visibleRef.current = visible;
    if (!visible || was) return;
    if (interactiveUpdateLaunchedRef.current) {
      interactiveUpdateLaunchedRef.current = false;
      void (async () => {
        await refreshUpdateInfo(true);
        await loadAll();
      })();
    } else {
      // 未标记的回切也顺手刷一次：后端缓存有 2 分钟 TTL，未过期时是纯缓存命中
      void refreshUpdateInfo();
    }
  }, [visible]);
  // 挂载查一次；更新/安装跑完（后端缓存已失效）后重查
  useEffect(() => {
    void refreshUpdateInfo();
  }, [updateResults]);
  // 运行中 run 的交互输入（如回答 brew 的 [y/n]）
  const [cmdInput, setCmdInput] = useState<Record<string, string>>({});
  // 各 run 最近一次收到输出块的时间戳（ref 即可，渲染时按当前时间算闲置分钟数）
  const lastChunkAtRef = useRef<Record<string, number>>({});
  // 仅用于让闲置提醒每 15s 重算一次
  const [, setIdleTick] = useState(0);

  /** 向运行中的安装/更新进程写一行输入（Enter 发送，自动补 \n） */
  async function sendUpdaterInput(agentId: string) {
    const text = cmdInput[agentId] ?? "";
    if (!text) return;
    setCmdInput((prev) => ({ ...prev, [agentId]: "" }));
    try {
      await invoke("updater_write", { agentId, data: `${text}\n` });
    } catch (e) {
      setError(String(e));
    }
  }

  /** 跑更新/安装命令：先挂事件监听再 invoke；结果以 done 事件为准，invoke 返回值兜底 */
  async function runAgentCmd(
    agentId: string,
    command: "update_agent" | "install_agent",
  ) {
    setUpdating((prev) => ({ ...prev, [agentId]: true }));
    setLiveOutput((prev) => ({ ...prev, [agentId]: "" }));
    lastChunkAtRef.current[agentId] = Date.now();
    // 闲置提醒用的节拍器：每 15s 触发一次重渲染，run 结束即清
    const idleTimer = setInterval(() => setIdleTick((t) => t + 1), 15000);
    const unOut = await listen<string>(
      `agent-update-output-${agentId}`,
      (e) => {
        lastChunkAtRef.current[agentId] = Date.now();
        setLiveOutput((prev) => ({
          ...prev,
          [agentId]: (prev[agentId] ?? "") + e.payload,
        }));
      },
    );
    let doneArrived = false;
    const unDone = await listen<AgentCmdResult>(
      `agent-update-done-${agentId}`,
      (e) => {
        doneArrived = true;
        applyUpdateResult(agentId, e.payload);
      },
    );
    try {
      const res = await invoke<AgentCmdResult>(command, { agentId });
      if (!doneArrived) {
        applyUpdateResult(agentId, res);
      }
      await loadAll();
    } catch (e) {
      if (!doneArrived) {
        applyUpdateResult(agentId, {
          ok: false,
          output: String(e),
          method: "",
          versionBefore: null,
          versionAfter: null,
        });
      }
    } finally {
      clearInterval(idleTimer);
      unOut();
      unDone();
      setUpdating((prev) => ({ ...prev, [agentId]: false }));
    }
  }

  /** 升级某个 agent 的 CLI；完成后重新 detect 刷新版本号。
   *  交互式 TUI 自更新（kimi upgrade 方向键选择界面）行输入无法应答，
   *  与官方账号「连接」同款：开完整终端让用户用方向键操作 */
  async function onUpdate(agentId: string) {
    const prefill = interactiveUpdatePrefill(updateInfo[agentId]);
    if (prefill) {
      interactiveUpdateLaunchedRef.current = true;
      setPendingTerminal({
        cwd: "~",
        extraEnv: {},
        title: `更新 ${labelOf(agentId)}`,
        prefillCommand: prefill,
        shellOnly: true,
      });
      setPage("terminal");
      return;
    }
    await runAgentCmd(agentId, "update_agent");
  }

  /** 安装未装的 agent：先亮出将执行的命令，用户确认后才跑 */
  async function onInstall(agentId: string) {
    setNodeInstallFor(null);
    try {
      const method = await invoke<string | null>("install_method_preview", {
        agentId,
      });
      if (!method) {
        setError(installToolHelp(agentId));
        // 文案之外给出口：渠道允许时错误旁追加「一键安装 Node.js」；尚未体检先探测一次
        if (!useAppStore.getState().depCheck) void refreshDepCheck();
        setNodeInstallFor(agentId);
        return;
      }
      if (
        !(await confirmDialog(
          `将通过以下命令安装 ${labelOf(agentId)}：\n\n${method}\n\n继续？`,
        ))
      )
        return;
    } catch (e) {
      setError(String(e));
      return;
    }
    await runAgentCmd(agentId, "install_agent");
  }

  const labelOf = (agentId: string) =>
    AGENTS.find((a) => a.id === agentId)?.label ?? agentId;

  /** 每个 agent 是否有可恢复的完整全局配置批次（控制「撤销上次写入」按钮显隐）；
      顺带查「首次写入前」原始快照（控制「恢复初始状态」入口显隐） */
  async function refreshGlobalBackups() {
    const entries = await Promise.all(
      AGENTS.map(
        async (a) =>
          [
            a.id,
            await invoke<boolean>("has_global_backup", { agent: a.id }),
          ] as const,
      ),
    );
    setGlobalBackups(Object.fromEntries(entries));
    const originals = await Promise.all(
      AGENTS.map(
        async (a) =>
          [
            a.id,
            await invoke<boolean>("has_original_backup", { agent: a.id }),
          ] as const,
      ),
    );
    setOriginalBackups(Object.fromEntries(originals));
  }

  useEffect(() => {
    refreshGlobalBackups().catch(() => toast("全局配置备份状态读取失败", "warning"));
  }, [profiles]);

  /** 能力表（agent_capabilities）：「设为全局」按 setGlobal 置灰 + 原因提示，与后端报错同源 */
  const [caps, setCaps] = useState<Record<string, AgentCapabilitiesDto>>({});
  useEffect(() => {
    invoke<AgentCapabilitiesDto[]>("agent_capabilities")
      .then((list) =>
        setCaps(Object.fromEntries(list.map((c) => [c.agent, c]))),
      )
      .catch(() => toast("Agent 能力读取失败，部分操作可能暂时不可用", "warning"));
  }, []);

  /** 三层验证结果镜像进 store（收件箱「配置失效」条目）；通过则摘除。原因取第一个未通过层 */
  function mirrorValidation(p: Profile, result: ProfileValidationDto) {
    const layers: [string, ValidationCheckDto][] = [
      ["本地解析", result.local],
      ["CLI 预检", result.cli],
      ["API 连通", result.api],
    ];
    const failed = layers.find(([, c]) => c.status === "failed");
    useAppStore.getState().setProfileIssue(
      p.id,
      failed
        ? { name: p.name, agent: p.agent, reason: `${failed[0]}：${failed[1].message}` }
        : null,
    );
  }

  /** 把 profile 事务化写入该 CLI 的全部目标文件，UI 明示影响范围 */
  async function runApplyGlobal(p: Profile) {
    setWritePreview(null);
    setApplyDialog({ profile: p, running: true, applied: null, error: null });
    try {
      const applied = await invoke<GlobalApplyResultDto>(
        "apply_profile_global",
        {
          profileId: p.id,
        },
      );
      await refreshGlobalBackups();
      await loadSettings();
      mirrorValidation(p, applied.validation);
      rememberValidation(p.id, applied.validation);
      setApplyDialog({ profile: p, running: false, applied, error: null });
      setError(null);
    } catch (e) {
      setApplyDialog({
        profile: p,
        running: false,
        applied: null,
        error: String(e),
      });
    }
  }

  async function onApplyGlobal(p: Profile) {
    if (applyDialog || writePreview) return;
    if (p.accountType === "official") {
      if (
        !(await confirmDialog(
          `将恢复 ${labelOf(p.agent)} 首次写入前的配置，让官方账号接手外部终端。不会改 Mesa 启动栏预选。已经打开的进程需要新开才会读到。继续？`,
        ))
      )
        return;
      await runApplyGlobal(p);
      return;
    }
    setWritePreview({
      profile: p,
      loading: true,
      preview: null,
      error: null,
      conflict: null,
    });
    try {
      const [preview, conflict] = await Promise.all([
        invoke<GlobalWritePreviewDto>("preview_profile_global", {
          profileId: p.id,
        }),
        invoke<string | null>("set_global_conflict", { agent: p.agent }).catch(
          () => null,
        ),
      ]);
      setWritePreview({
        profile: p,
        loading: false,
        preview,
        error: null,
        conflict: conflict ?? null,
      });
    } catch (e) {
      setWritePreview({
        profile: p,
        loading: false,
        preview: null,
        error: String(e),
        conflict: null,
      });
    }
  }

  async function onValidate(p: Profile) {
    setValidationDialog({ profile: p, result: null, running: true });
    try {
      const result = await invoke<ProfileValidationDto>("validate_profile", {
        profileId: p.id,
      });
      mirrorValidation(p, result);
      rememberValidation(p.id, result);
      setValidationDialog({ profile: p, result, running: false });
      setError(null);
    } catch (e) {
      setValidationDialog(null);
      setError(String(e));
    }
  }

  async function onPreviewLaunchPlan(p: Profile) {
    try {
      const result = await invoke<LaunchPlanPreviewDto>("preview_launch_plan", { profileId: p.id, model: p.models[0] ?? null });
      setPreviewDialog({ profile: p, result });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 恢复该 agent 最近一个完整备份批次；恢复前先备份当前状态。 */
  async function onRestoreBackup(agentId: string) {
    if (
      !(await confirmDialog(
        `将恢复 ${labelOf(agentId)} 最近一个完整备份批次。当前状态会先另存为新备份，原恢复点不会被消耗。继续？`,
      ))
    )
      return;
    try {
      const files = await invoke<string[]>("restore_global_backup", {
        agent: agentId,
      });
      await refreshGlobalBackups();
      // 恢复后全局内容不再是任何连接的快照，后端已清「全局生效」标记，重拉设置刷新徽标
      await loadSettings();
      await alertDialog(
        files.length
          ? `已恢复完整批次：\n${files.join("\n")}`
          : "没有可恢复的完整备份批次",
      );
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 恢复到「Mesa 首次写入前」的原始状态（永久快照，不参与批次轮换）。
      当前状态会先存成常规批次，恢复后想反悔可再点「撤销上次写入」 */
  async function onRestoreOriginal(agentId: string) {
    if (
      !(await confirmDialog(
        `将把 ${labelOf(agentId)} 的全局配置恢复到 Mesa 首次写入前的原始状态（Mesa 当时新建的文件会被删除）。当前状态会先另存为新备份，可用「撤销上次写入」反悔。继续？`,
      ))
    )
      return;
    try {
      const files = await invoke<string[]>("restore_original_backup", {
        agent: agentId,
      });
      await refreshGlobalBackups();
      // 后端已清「全局生效」标记，重拉设置刷新徽标
      await loadSettings();
      await alertDialog(
        files.length
          ? `已恢复首次写入前的原始状态：\n${files.join("\n")}`
          : "首次写入前没有任何目标文件，已全部清除",
      );
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 导出网关+绑定 v2；含密钥须二次确认，文件权限 0600 */
  async function onExport() {
    try {
      const wantKeys = await confirmDialog(
        "导出是否包含密钥？包含时文件是明文，请只放在本机可信位置。点取消则导出不含密钥。",
      );
      let includeKeys = !!wantKeys;
      if (includeKeys) {
        const sure = await confirmDialog(
          "再确认一次：导出文件将写入明文密钥，并设为仅你可读。确定包含？",
          { danger: true, confirmText: "仍要包含密钥" },
        );
        if (!sure) return;
      }
      const path = await save({
        defaultPath: "ccode-gateways.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("export_gateways_v2", { path, includeKeys });
      setError(null);
      setNotice(
        `已导出：${path}${includeKeys ? "（含密钥，请妥善保管文件）" : "（不含密钥）"}`,
      );
    } catch (e) {
      setError(String(e));
    }
  }

  /** 导入 v2 网关包；失败再走旧 profiles 数组 */
  async function onImport() {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      try {
        const res = await invoke<ImportV2Result>("import_gateways_v2", { path });
        await loadAll();
        setError(null);
        const skip = res.skippedSlots.length
          ? `\n跳过 ${res.skippedSlots.length} 项：\n${res.skippedSlots.join("\n")}`
          : "";
        await alertDialog(`已导入 ${res.addedGateways} 个网关、${res.addedBindings} 条绑定${skip}`);
      } catch {
        const added = await invoke<number>("import_profiles", { path });
        await loadAll();
        setError(null);
        await alertDialog(`已导入 ${added} 个连接（旧格式，密钥需逐个补填）`);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDelete(p: Profile) {
    // 定时任务把 profile_id 当硬绑定（scheduler 里缺失即停、拒绝静默改投别的连接），
    // 解绑前必须把这些任务摊给用户看——否则只会在下次运行时炸在日志里。
    const affected = await invoke<ScheduleDto[]>("list_schedules")
      .then((all) => all.filter((s) => s.profileId === p.id))
      .catch(() => [] as ScheduleDto[]);
    const warn =
      affected.length > 0
        ? `\n\n注意：有 ${affected.length} 条定时任务正在用这个配置` +
          `（${affected
            .slice(0, 3)
            .map((s) => `「${s.name}」`)
            .join("、")}${affected.length > 3 ? " 等" : ""}）。` +
          `解绑后它们不会自动改用别的配置，会在下次运行时停下并提示重选连接。`
        : "";
    // 删连接清点（W2b）：把「删了会怎样」说在事前——项目侧引用会被级联清理、
    // 目标回落项目默认、定时按上句 fail-loud。数不出来（命令失败）不拦删除。
    const usageWarn = await invoke<{
      projects: number;
      goals: number;
    }>("profile_usage_refs", { id: p.id })
      .then((refs) =>
        refs.projects + refs.goals > 0
          ? `\n\n另有 ${refs.projects} 个项目的默认/专属绑定引用它（删除后自动清理），` +
            `${refs.goals} 条目标钉着它（删除后跟随项目默认）。`
          : "",
      )
      .catch(() => "");
    if (
      !(await confirmDialog(
        `解绑「${p.name}」？网关和密钥会留下，其它 Agent 的绑定不受影响。${usageWarn}${warn}`,
        {
          danger: true,
        },
      ))
    )
      return;
    try {
      await removeProfile(p.id);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 复制到其他 agent（#14）：密钥在后端 0600 文件内直读直写，不经前端；成功后刷新列表并提示 */
  async function onCopyToAgent(p: Profile, targetAgent: string) {
    try {
      const created = await invoke<Profile>("copy_profile_to_agent", {
        profileId: p.id,
        targetAgent,
      });
      await loadAll();
      invoke("rebuild_tray").catch(() =>
        toast("连接已复制，但托盘菜单刷新失败", "warning"),
      );
      setNotice(`已复制连接到 ${labelOf(targetAgent)}：「${created.name}」`);
      setTimeout(() => setNotice(null), 4000);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  const q = search.trim().toLowerCase();
  const matchProfile = (p: Profile) =>
    !q ||
    [p.name, p.baseUrl ?? "", ...p.models].join("\n").toLowerCase().includes(q);
  const visibleAgents = AGENTS.filter((a) => {
    const installed = !!agents.find((x) => x.id === a.id)?.binaryPath;
    if (statusFilter === "installed") return installed;
    if (statusFilter === "uninstalled") return !installed;
    return true;
  });
  // 可见分组中存在展开项 → 按钮显示「全部折叠」，否则「全部展开」
  const anyExpanded = visibleAgents.some((a) => !collapsedGroups.has(a.id));
  // 保存后的「要重启标签才生效」提示（仅当该 agent 确有标签在跑）
  const [savedNote, setSavedNote] = useState<string | null>(null);
  // 「设为全局」进度/结果弹层：确认后立即弹出（写文件 + CLI 复检含网络检查要几秒到
  // 十几秒，没反馈像点了没反应）；非 null 期间禁止重入
  const [applyDialog, setApplyDialog] = useState<{
    profile: Profile;
    running: boolean;
    applied: GlobalApplyResultDto | null;
    error: string | null;
  } | null>(null);
  const [writePreview, setWritePreview] = useState<{
    profile: Profile;
    loading: boolean;
    preview: GlobalWritePreviewDto | null;
    error: string | null;
    conflict: string | null;
  } | null>(null);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const loadSettings = useAppStore((s) => s.loadSettings);

  /** 「在终端使用」：新开标签并直接启动（与快速开聊共用 pendingTerminal 链路）。
   *  目录取上次启动过的，没有就交给启动栏留空由用户填 */
  function useTerminalWith(profile: Profile) {
    let cwd = "";
    try {
      cwd =
        (JSON.parse(localStorage.getItem("ccode.lastLaunch") ?? "{}") as {
          cwd?: string;
        }).cwd ?? "";
    } catch {
      /* 读不到就留空 */
    }
    setPendingTerminal({
      cwd,
      extraEnv: {},
      agentId: profile.agent,
      profileId: profile.id,
      autoStart: !!cwd,
    });
    setPage("terminal");
  }

  async function useExternalWith(profile: Profile) {
    let cwd = "";
    try {
      cwd =
        (JSON.parse(localStorage.getItem("ccode.lastLaunch") ?? "{}") as { cwd?: string }).cwd ?? "";
    } catch {
      /* 损坏的本地记忆不阻断外部启动 */
    }
    if (!cwd.trim()) {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") cwd = picked;
    }
    if (!cwd.trim()) return;
    try {
      await invoke("new_external_terminal", {
        agentId: profile.agent,
        cwd,
        profileId: profile.id,
        model: profile.models[0] ?? null,
      });
      setNotice(`已在外部终端启动「${profile.name}」`);
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 连接行的就地修复：先刷新网关目录，再让后端重新计算绑定同步状态。
   * 不自动改写绑定模型——目录刷新可能新增大量模型，替换绑定仍由用户在编辑弹层确认。
   */
  async function refreshGatewayCatalog(profile: Profile) {
    if (!profile.gatewayId) return;
    setRowMenu(null);
    setError(null);
    setSyncingCatalogId(profile.id);
    try {
      const result = await invoke<FetchGatewayCatalogDto>("fetch_gateway_catalog", {
        gatewayId: profile.gatewayId,
        preferSlot: slotForAgent(profile.agent, profile.protocol),
      });
      await loadAll();
      const n = result.gateway.models.length;
      const cap = catalogCapabilityNote(n, result.capabilityMetadataCount);
      setNotice(
        `已刷新「${profile.name}」的模型目录 · ${n} 个模型${
          result.gateway.catalogFromSlot ? ` · ${result.gateway.catalogFromSlot} 槽` : ""
        }${cap ? `。${cap}` : ""}`,
      );
      setTimeout(() => setNotice(null), 5000);
    } catch (e) {
      setError(`模型目录刷新失败：${String(e)}`);
    } finally {
      setSyncingCatalogId(null);
    }
  }

  /** 停用/取消停用（settings.hiddenProfiles 整表覆盖；字段名沿用旧称不改存储）：
      软停用 = 不被自动路径挑中（启动栏预选/兜底、恢复会话、AI 功能回落），
      手动指定仍可用——启动栏下拉里沉到「已停用」分组可手选 */
  async function toggleHiddenProfile(profile: Profile) {
    const cur = new Set(settings?.hiddenProfiles ?? []);
    if (cur.has(profile.id)) cur.delete(profile.id);
    else cur.add(profile.id);
    await updateSettings({ hiddenProfiles: [...cur] });
  }

  /** 设为该 agent 的默认配置（settings.defaultProfiles 整图覆盖；再点一次取消） */
  async function toggleDefaultProfile(profile: Profile) {
    const cur = { ...(settings?.defaultProfiles ?? {}) };
    if (cur[profile.agent] === profile.id) delete cur[profile.agent];
    else cur[profile.agent] = profile.id;
    await updateSettings({ defaultProfiles: cur });
  }
  const liveSessions = useAppStore((s) => s.liveSessions);
  const runningAgents = new Set(
    Object.keys(liveSessions).map((k) => k.split("\n")[0]),
  );

  return (
    <div className="min-h-full bg-canvas">
      <PageFrame width="wide">
        {/* 注入模式的核心规则：配置只在**启动那一刻**注入子进程，改了对已在跑的标签无效。
            这条以前只写在用户手册里，用户改完配置回终端发现没变化，界面上没有任何解释
            （「有时候配置了无法切换模型」的第二个来源）。保存后有标签在跑才提示，平时不啰嗦。 */}
        {savedNote && (
          <NoticeBar tone="warn" onDismiss={() => setSavedNote(null)}>
            {savedNote}
          </NoticeBar>
        )}
        {/* 命令栏：标题 + 元信息，右侧动作 */}
        <PageHeader
          title="连接"
          meta={`每个 Agent 绑哪个网关、用哪些模型 · ${profiles.length} 个连接`}
          actions={
            <>
              <button
                type="button"
                onClick={() => setGwLib(true)}
                className={secondaryActionClass}
              >
                网关库
              </button>
              <button
                type="button"
                onClick={() => setModal({ initial: null })}
                className={primaryActionClass}
              >
                + 添加连接
              </button>
              <button
                type="button"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTopMenu({ x: rect.right - 176, y: rect.bottom + 4 });
                }}
                title="更多连接操作"
                aria-label="更多连接操作"
                className="flex h-8 w-8 items-center justify-center rounded-sm text-sm text-l2 hover:bg-hover hover:text-l1"
              >
                ⋯
              </button>
            </>
          }
        />

        {/* 过滤条：状态筛选胶囊（选中=实心 seg-sel）+ 右侧搜索框 */}
        <PageToolbar>
          <div className="flex items-center gap-1">
            <SegTabs
              items={(
                [
                  ["all", "全部"],
                  ["installed", "已安装"],
                  ["uninstalled", "未安装"],
                ] as const
              ).map(([id, label]) => ({ id, label }))}
              value={statusFilter}
              onChange={setStatusFilter}
            />
            <button
              onClick={() =>
                updateCollapsed((prev) => {
                  const next = new Set(prev);
                  if (anyExpanded) {
                    for (const a of visibleAgents) next.add(a.id);
                  } else {
                    for (const a of visibleAgents) next.delete(a.id);
                  }
                  return next;
                })
              }
              className="ml-2 flex h-7 items-center rounded-sm px-2 text-xs text-l2 hover:bg-hover hover:text-l1"
            >
              {anyExpanded ? "全部折叠" : "全部展开"}
            </button>
          </div>
          {/* 搜索框：inset 底 + hairline 细边（同对话页手法） */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索连接 / 端点 / 模型"
            className={`${searchFieldClass} w-56`}
          />
        </PageToolbar>

        {error && <NoticeBar tone="err" className="mt-4" onDismiss={() => setError(null)}>{error}</NoticeBar>}
        {/* npm 渠道不可用（无 Node.js）时的一键安装出口：渠道由依赖体检判定，
            渠道不允许（无 brew/winget）时保持纯文案不画按钮 */}
        {nodeInstallFor && (
          <div className="mt-2">
            {depCheck && canOneClickInstall("node", depCheck.channel) && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void depInstall.install("node")}
                  disabled={depInstall.entries.node.running}
                  className={`${secondaryActionClass} text-xs`}
                >
                  {depInstall.entries.node.running
                    ? "安装中…"
                    : "一键安装 Node.js"}
                </button>
                {!depInstall.entries.node.running && (
                  <span className="text-xs text-l3">
                    装好后接着安装 {labelOf(nodeInstallFor)}
                  </span>
                )}
              </div>
            )}
            <DepInstallLog entry={depInstall.entries.node} />
          </div>
        )}
        {notice && <NoticeBar className="mt-4" onDismiss={() => setNotice(null)}>{notice}</NoticeBar>}

        {connectionLoadError && (
          <NoticeBar tone="warn" className="my-3">
            <span className="block font-medium text-l1">连接加载失败，已保留上次成功的数据</span>
            <span className="mt-0.5 block break-words text-l3">{connectionLoadError}</span>
            <button type="button" className="mt-1.5 text-cta hover:underline" onClick={() => void retryConnections().catch(() => {})}>重新读取连接</button>
          </NoticeBar>
        )}

        {/* agent 分组（可折叠） */}
        <div>
          {visibleAgents.map((agent) => {
            const det = agents.find((a) => a.id === agent.id);
            const list = profiles.filter(
              (p) => p.agent === agent.id && matchProfile(p),
            );
            const connectionCount = profiles.filter(
              (p) => p.agent === agent.id,
            ).length;
            if (q && list.length === 0) return null;
            const isCollapsed = collapsedGroups.has(agent.id);
            // 分组卡片化（v3.93 用户拍板）：field 细边 + strip 底色卡片给每个 agent 明确边界，
            // 替代原 hairline + 左侧缩进线手法；未安装的卡片去底色降权（无配置可管，权重最低）。
            // 不用 opacity 降权：opacity<1 会改变 fixed 后代的包含块，悬浮层定位会错乱。
            const installed = !!det?.binaryPath;
            return (
              <section
                key={agent.id}
                className={`mb-4 overflow-hidden rounded-xl border ${
                  installed
                    ? "border-field ccode-well"
                    : "border-hairline"
                }`}
              >
                <div className="group flex h-11 items-center gap-2 px-3">
                  <button
                    onClick={() => {
                      // 更新/安装进行中禁止折叠，避免交互输入行（如 brew [y/n]）被隐藏
                      if (updating[agent.id] && !isCollapsed) return;
                      updateCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(agent.id)) next.delete(agent.id);
                        else next.add(agent.id);
                        return next;
                      });
                    }}
                    aria-label={isCollapsed ? "展开" : "收起"}
                    className="flex shrink-0 items-center justify-center rounded-md hover:brightness-110"
                  >
                    <FoldMark open={!isCollapsed} boxed />
                  </button>
                  <h2
                    className="text-sm font-medium text-l1"
                    title={
                      det?.binaryPath
                        ? `${agent.binary} ${det.version ?? ""}`.trim()
                        : undefined
                    }
                  >
                    {agent.label}
                  </h2>
                  <span className="rounded-full bg-inset px-1.5 py-0.5 text-micro text-l4">
                    {connectionCount}
                  </span>
                  {/* 连接冲突提升为组头琥珀胶囊（v3.93）：CLI 自读文件里的残留密钥会覆盖官方账号
                      登录并产生计费——藏在大段灰字里会被忽略；点击弹层列出具体文件/变量 */}
                  {(officialStatus[agent.id]?.conflicts.length ?? 0) > 0 &&
                    conflictDismissed[agent.id] !==
                      [...officialStatus[agent.id].conflicts].sort().join("\n") && (
                    <button
                      type="button"
                      onClick={(event) => {
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        setConflictPop({
                          x: rect.left,
                          y: rect.bottom + 4,
                          agentId: agent.id,
                        });
                      }}
                      title="本地配置文件中的残留密钥会覆盖官方账号登录，点击查看明细"
                      className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-warn px-2 text-micro text-warn-text transition-[filter] hover:brightness-125"
                    >
                      ! {officialStatus[agent.id].conflicts.length} 项连接冲突
                    </button>
                  )}
                  {!det?.binaryPath && (
                    <span className="text-xs text-l4">未安装</span>
                  )}
                  {officialStatus[agent.id]?.supported && det?.binaryPath && (
                    <OfficialStatusChip
                      agentId={agent.id}
                      st={officialStatus[agent.id]}
                      onConnect={() => connectOfficial(agent.id)}
                    />
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setGroupMenu({
                          x: rect.right - 176,
                          y: rect.bottom + 4,
                          agentId: agent.id,
                        });
                      }}
                      aria-label={`${agent.label} 全局备份`}
                      title="恢复全局配置备份"
                      className="flex h-8 w-8 items-center justify-center rounded-sm text-sm text-l2 hover:bg-hover hover:text-l1"
                    >
                      ⋯
                    </button>
                    {det?.binaryPath ? (
                    (() => {
                      if (updating[agent.id])
                        return (
                          <span className="text-xs text-l2">
                            更新中…
                          </span>
                        );
                      const info = updateInfo[agent.id];
                      const tuiPrefill = interactiveUpdatePrefill(info);
                      if (updateResults[agent.id]?.ok) return null;
                      if (info && !info.outdated && info.latest) {
                        // brew 已最新但上游 npm 更高（渠道滞后边角场景）：不再常驻一串小字
                        // 挤组头，收成一枚安静的 ⧉ 图标钮——tooltip 承载完整说明，点击复制渠道切换命令
                        const note = upstreamNoteText(info);
                        const cmd = upstreamCommand(info);
                        if (!note || !cmd) return null;
                        return (
                          <button
                            type="button"
                            title={`${note}\n点击复制渠道切换命令：${cmd}\n含义：卸载 brew 版本并改装 npm 版本（之后更新走 npm 渠道，Mesa 自动按 npm 检查）`}
                            onClick={() =>
                              void navigator.clipboard.writeText(cmd)
                            }
                            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-l4 transition-colors hover:bg-hover hover:text-cta"
                          >
                            ⧉
                          </button>
                        );
                      }
                      if (info?.outdated)
                        return (
                          <button
                            onClick={() => onUpdate(agent.id)}
                            title={
                              tuiPrefill
                                ? `有新版本 ${info.latest ?? ""}；交互式更新（${tuiPrefill}），将在终端中打开，需方向键选择`
                                : `有新版本 ${info.latest ?? ""}，点击更新`
                            }
                            className="flex h-8 items-center rounded-sm px-2 text-xs text-cta hover:bg-hover hover:brightness-125"
                          >
                            新版
                          </button>
                        );
                      return (
                        <button
                          onClick={() => onUpdate(agent.id)}
                          title={
                            tuiPrefill
                              ? `交互式更新（${tuiPrefill}），将在终端中打开，需方向键选择`
                              : undefined
                          }
                          className="flex h-8 items-center rounded-sm px-2 text-xs text-l2 hover:bg-hover hover:text-l1"
                        >
                          更新
                        </button>
                      );
                    })()
                  ) : (
                    <button
                      onClick={() => onInstall(agent.id)}
                      disabled={updating[agent.id]}
                      className={`${secondaryActionClass} px-2.5`}
                    >
                      {updating[agent.id] ? "安装中…" : "安装"}
                    </button>
                    )}
                  </div>
                </div>

                {!isCollapsed && (
                  <div className="border-t border-hairline">
                    {/* 安装/更新实时输出（全宽，行为不变） */}
                    {updating[agent.id] && (
                      <div className="mx-3 mt-2">
                        <pre
                          // callback ref：每次渲染都把滚动条钉在底部，实现跟随输出自动滚动
                          ref={(el) => {
                            if (el) el.scrollTop = el.scrollHeight;
                          }}
                          className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-t border border-hairline border-b-0 bg-canvas p-2 font-mono text-xs text-l2"
                        >
                          {collapseCarriageReturns(liveOutput[agent.id] ?? "") || "运行中，等待输出…"}
                        </pre>
                        {(() => {
                          // 120s 无新输出给提示；新块到达（时间戳刷新）或 run 结束（整块隐藏）自动消失
                          const last = lastChunkAtRef.current[agent.id];
                          const idleMin = last
                            ? Math.floor((Date.now() - last) / 60000)
                            : 0;
                          if (idleMin < 2) return null;
                          return (
                            <div className="bg-warn px-2 py-1 text-xs text-warn-text">
                              已 {idleMin}{" "}
                              分钟无新输出：可能是网络慢，或命令在等待输入（在下方输入行回答）。若持续异常可把当前内容发给开发者。
                            </div>
                          );
                        })()}
                        <div className="flex items-center gap-1.5 rounded-b border border-hairline bg-canvas px-2 py-1.5">
                          <span className="font-mono text-xs text-l4">
                            &gt;
                          </span>
                          <input
                            value={cmdInput[agent.id] ?? ""}
                            onChange={(e) =>
                              setCmdInput((prev) => ({
                                ...prev,
                                [agent.id]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter")
                                void sendUpdaterInput(agent.id);
                            }}
                            placeholder="需要交互时在此输入（如 y），Enter 发送"
                            className="flex-1 bg-transparent font-mono text-xs text-l2 outline-none placeholder:text-l4"
                          />
                        </div>
                      </div>
                    )}
                    {updateResults[agent.id] && (
                      <div className="mx-3 mt-2 rounded-sm ccode-well p-2 text-xs text-l2">
                        <span
                          className={
                            updateResults[agent.id].ok
                              ? "text-ok-text"
                              : "text-err-text"
                          }
                        >
                          {updateResults[agent.id].ok
                            ? "✓ 更新完成"
                            : "✗ 更新失败"}
                        </span>
                        <span>
                          {updateResults[agent.id].method &&
                            `（${updateResults[agent.id].method}）`}
                          {updateResults[agent.id].versionAfter &&
                            `：${updateResults[agent.id].versionBefore ?? "?"} → ${updateResults[agent.id].versionAfter}`}
                        </span>
                        {updateResults[agent.id].output && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-l3">
                              输出
                            </summary>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">
                              {updateResults[agent.id].output}
                            </pre>
                          </details>
                        )}
                        {(() => {
                          const r = updateResults[agent.id];
                          const hint = r.ok
                            ? null
                            : diagnose(r.output, r.method);
                          return hint ? (
                            <p className="mt-1 text-xs text-l3">
                              ⓘ 建议：{hint}
                            </p>
                          ) : null;
                        })()}
                      </div>
                    )}

                    {list.length === 0 ? (
                      // 只说状态不说教：页头已有「+ 添加连接」主按钮，入口不必每组复述一遍
                      <p className="px-4 py-3 text-xs text-l4">还没有连接</p>
                    ) : (
                      // 行间极细分割线（hairline）替代卡片间距：整列垂直严格对齐，视觉节奏与官方账号行一致
                      <ul className="divide-y divide-hairline overflow-x-auto">
                        {list.map((profile) => {
                          const hidden = (
                            settings?.hiddenProfiles ?? []
                          ).includes(profile.id);
                          const isDefault =
                            settings?.defaultProfiles?.[profile.agent] ===
                            profile.id;
                          const isGlobal =
                            settings?.activeGlobalProfiles?.[profile.agent] ===
                            profile.id;
                          // caption：默认 / 全局生效 + 上次使用 + 外部文件被改过
                          const caption: {
                            text: string;
                            tip: string;
                            cls?: string;
                          }[] = [];
                          if (isDefault)
                            caption.push({
                              text: "默认",
                              tip: "Mesa 启动栏预选这份连接。只改启动栏，不写外部 CLI 文件。",
                            });
                          if (isGlobal)
                            caption.push({
                              text: "全局生效",
                              tip: "最近一次由 Mesa 写入该 CLI 的全局默认。外部终端会读到这份配置。",
                            });
                          if (profile.lastUsedAt)
                            caption.push({
                              text: `上次使用 ${relTime(profile.lastUsedAt)}`,
                              tip: `上次使用 ${absTime(profile.lastUsedAt)}`,
                            });
                          if (isGlobal) {
                            const drift = driftByAgent[profile.agent];
                            const drifted = drift?.status === "drifted";
                            if (drifted) {
                              caption.push({
                                text: "外部 CLI 文件已被改过",
                                tip: `磁盘与 Mesa 写入不一致：${(drift?.files ?? []).join("、") || "配置文件"}。可用「写入 CLI 全局默认」以 Mesa 为准重写，或「撤销上次写入」。`,
                                cls: "text-warn-text",
                              });
                            }
                          }
                          caption.push(...profileConnectionCaptions(profile));
                          return (
                          <li
                            key={profile.id}
                            className={`group grid min-h-14 ${PROFILE_GRID} items-center gap-3 px-4 text-sm transition-colors hover:bg-hover/60`}
                          >
                            <span className="min-w-0">
                              <span
                                className="block truncate font-medium text-l1"
                                title={profile.name}
                              >
                                {profile.name}
                                {profileIssues[profile.id] ? (
                                  <StatusPill tone="err" tip={profileIssues[profile.id].reason}>配置失效</StatusPill>
                                ) : hidden ? (
                                  <StatusPill tone="muted" tip="已停用：不会被恢复会话和 AI 功能自动挑中；启动栏下拉里沉到「已停用」分组，仍可手选">已停用</StatusPill>
                                ) : null}
                              </span>
                              {/* caption 行：micro 档灰字，相对时间主显、悬浮给绝对时间（白话双层） */}
                              {caption.length > 0 && (
                                <span className="mt-0.5 block break-words text-micro text-l4">
                                  {caption.map((c, i) => (
                                    <span key={`${c.text}-${i}`} title={c.tip} className={c.cls}>
                                      {i > 0 ? " · " : ""}
                                      {c.text}
                                    </span>
                                  ))}
                                </span>
                              )}
                            </span>
                            <span
                              className={`min-w-0 truncate text-xs ${profile.baseUrl ? "text-l2" : "text-l4"}`}
                              title={
                                profile.accountType === "official"
                                  ? "官方账号登录（CLI 自身认证，不注入端点/密钥）"
                                  : profile.baseUrl
                                    ? displayHost(profile.baseUrl)
                                    : "使用 CLI 默认端点"
                              }
                            >
                              {/* 官方账号没有端点可言；名称列已标「官方账号」，这里只留占位不重复 */}
                              {profile.accountType === "official"
                                ? "—"
                                : profile.baseUrl
                                  ? displayHost(profile.baseUrl)
                                  : "默认端点"}
                            </span>
                            {/* 模型列轻量化：mono micro 纯文字（不套底色块），前 3 个平铺，其余折叠为 +N；
                                列宽装不下时 overflow 裁切，悬浮 title 始终给全文 */}
                            <span
                              className="flex min-w-0 items-center gap-1.5 overflow-hidden"
                              title={
                                profile.models.length > 0
                                  ? profile.models.join(" · ")
                                  : undefined
                              }
                            >
                              {profile.models.length > 0 ? (
                                <>
                                  {profile.models.slice(0, 3).map((m, i) => (
                                    // 首个模型是启动默认：字色提一档、悬停说明，其余是会话里可切的
                                    <span
                                      key={m}
                                      className={`shrink-0 font-mono text-micro ${i === 0 ? "text-l2" : "text-l4"}`}
                                      title={i === 0 ? `${m}（启动默认）` : m}
                                    >
                                      {m}
                                    </span>
                                  ))}
                                  {profile.models.length > 3 && (
                                    <span className="shrink-0 font-mono text-micro text-l4">
                                      +{profile.models.length - 3}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="text-xs text-l4">
                                  未指定模型
                                </span>
                              )}
                            </span>
                            {profile.accountType === "official" ? (
                              <span
                                className="flex items-center gap-1 text-xs text-l4"
                                title="官方账号登录，无需 API 密钥"
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-l4" />
                                无需密钥
                              </span>
                            ) : (
                            <span
                              className="flex items-center gap-1 text-xs text-l2"
                              title={
                                profile.hasKey
                                  ? `密钥已受限存储${profile.keyHint ? `（${profile.keyHint}）` : ""}`
                                  : "尚未填写密钥"
                              }
                            >
                              {/* 纯状态 = 中性文字 + 语义色小圆点（设计系统口径）：
                                  「密钥已存」是事实不是成就，亮绿整列重复会抢走视线 */}
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  profile.hasKey ? "bg-ok-text" : "bg-l4"
                                }`}
                              />
                              {profile.hasKey ? "已保存密钥" : "未设置"}
                            </span>
                            )}
                            <span className="flex items-center justify-end gap-1 whitespace-nowrap">
                              {/* 「在终端使用」（v3.88）：配置页原本没有任何通往终端的路——
                                  建完配置只能自己去终端页再选一遍。
                                  低频入口 = hover 才现的 28px 图标 ghost 钮（常驻位只留「编辑」），
                                  操作列才塞得下、行高不被撑乱 */}
                              <button
                                type="button"
                                onClick={() => useTerminalWith(profile)}
                                title="在终端使用：用这个连接新开一个终端标签"
                                aria-label={`在终端使用：${profile.name}`}
                                className={`flex h-7 w-7 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                              >
                                <SquareTerminal size={14} strokeWidth={1.8} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void useExternalWith(profile)}
                                title="外部终端：用这个连接在外部终端新开会话"
                                aria-label={`外部终端打开：${profile.name}`}
                                className={`flex h-7 w-7 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                              >
                                <SquareArrowOutUpRight size={14} strokeWidth={1.8} aria-hidden="true" />
                              </button>
                              {showCatalogSyncAction(profile) && (
                                  <button
                                    type="button"
                                    className={`${rowActionClass} text-warn-text`}
                                    disabled={syncingCatalogId === profile.id}
                                    title="目录超过 7 天未刷新。绑定模型不在目录时请点编辑勾选，刷新清不掉。"
                                    onClick={() => void refreshGatewayCatalog(profile)}
                                  >
                                    {syncingCatalogId === profile.id ? "同步中…" : "同步目录"}
                                  </button>
                                )}
                              <button
                                type="button"
                                onClick={() => setModal({ initial: profile })}
                                className={ghostActionClass}
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  const rect =
                                    event.currentTarget.getBoundingClientRect();
                                  setRowMenu({
                                    x: rect.right - 176,
                                    y: rect.bottom + 4,
                                    profile,
                                  });
                                }}
                                aria-label={`更多操作：${profile.name}`}
                                className={`flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                              >
                                ⋯
                              </button>
                            </span>
                          </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </PageFrame>
      {/* 连接冲突弹层：组头琥珀胶囊点出，列出具体文件/变量；只含文件名与变量名，密钥值不出后端 */}
      {conflictPop &&
        (() => {
          const st = officialStatus[conflictPop.agentId];
          if (!st || st.conflicts.length === 0) return null;
          // 忽略签名命中时也不弹（忽略动作本身会关弹层，这里守住重渲染路径）
          if (
            conflictDismissed[conflictPop.agentId] ===
            [...st.conflicts].sort().join("\n")
          )
            return null;
          return (
            <div
              className="fixed inset-0 z-20"
              onClick={() => setConflictPop(null)}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute w-80 rounded-md border border-field ccode-float-surface p-3 text-xs"
                // 防出屏：往左/往上收（卡片 w-80 约 320px、高约 270px）
                style={{
                  left: Math.max(
                    8,
                    Math.min(conflictPop.x, window.innerWidth - 336),
                  ),
                  top: Math.max(
                    8,
                    Math.min(conflictPop.y, window.innerHeight - 280),
                  ),
                }}
              >
                <div className="mb-1.5 font-medium text-warn-text">
                  ! {st.conflicts.length} 项连接冲突 ·{" "}
                  {labelOf(conflictPop.agentId)}
                </div>
                <ul className="space-y-1">
                  {st.conflicts.map((c) => (
                    <li
                      key={c}
                      className="rounded-sm ccode-well px-1.5 py-1 font-mono text-l2"
                    >
                      {c}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 leading-5 text-l3">
                  这些文件里残留的密钥会覆盖官方账号登录并产生 API
                  计费，只在你点「登录」改用官方账号时才碍事；平时用上面的 API
                  连接，Mesa 启动时自带注入，不受影响。
                </p>
                <p className="mt-1.5 leading-5 text-l3">
                  <span className="text-l2">只用 API 连接</span>：点「忽略」。
                  <span className="text-l2">要用官方账号</span>
                  ：点「备份后清理已识别项」（会去掉这些键，在 Mesa 外直接敲命令也不再走它们；清理前会先备份），
                  或自行编辑文件后点状态行 ⟳ 重新检测。
                </p>
                <div className="mt-2 flex items-center gap-2">
                  {st.cleanupSupported && (
                    <button
                      type="button"
                      className="rounded-sm border border-warn-bd bg-warn px-2 py-1 text-xs text-warn-text hover:brightness-110"
                      onClick={() => void clearAccountConflicts(conflictPop.agentId)}
                    >
                      备份后清理已识别项
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded-sm px-2 py-1 text-xs text-l3 hover:bg-hover hover:text-l1"
                    title="只隐藏这条提醒；官方账号启动拦截仍生效，残留项有变化时提醒自动回来"
                    onClick={() => dismissConflicts(conflictPop.agentId, st.conflicts)}
                  >
                    忽略
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      {gwLib && (
        <GatewayLibrary
          initialId={gwFocus}
          onClose={() => {
            setGwLib(false);
            setGwFocus(null);
          }}
          onJumpUsage={(id) => {
            sessionStorage.setItem("ccode.statsGateway", id);
            setGwLib(false);
            setGwFocus(null);
            setPage("stats");
          }}
        />
      )}
      {modal && (
        <ProfileModal
          initial={modal.initial}
          presetAgent={modal.presetAgent}
          officialSupported={Object.fromEntries(
            Object.entries(officialStatus).map(([k, v]) => [k, v.supported]),
          )}
          onClose={() => setModal(null)}
          onOpenGateway={(id) => {
            setModal(null);
            setGwFocus(id);
            setGwLib(true);
          }}
          onSaved={(agent, name) => {
            // 注入模式：改动只对**新启动**的标签生效，已在跑的要重开
            if (runningAgents.has(agent))
              setSavedNote(
                `已保存「${name}」。这个 agent 有终端标签正在运行——连接是在启动那一刻注入的，改动要**重开标签**才生效。`,
              );
          }}
        />
      )}
      {topMenu && (
        <ContextMenu
          x={topMenu.x}
          y={topMenu.y}
          onClose={() => setTopMenu(null)}
          items={[
            { label: "导入连接", icon: Import, onSelect: () => void onImport() },
            { label: "导出连接", icon: FileDown, onSelect: () => void onExport() },
            { separator: true },
            {
              icon: Database,
              label: modelDbBusy
                ? "正在下载模型能力库…"
                : modelDb?.downloaded
                  ? `更新模型能力库（${modelDb.models} 个${
                      modelDb.downloadedAt
                        ? ` · ${modelDb.downloadedAt.slice(0, 10)}`
                        : ""
                    }）`
                  : "下载模型能力库（models.dev）",
              disabled: modelDbBusy,
              title:
                "第三方模型的能力声明（上下文/输出上限/视觉/推理）与官方定价的公共数据源：下载后统计页费用估算随之更新（定价优先级：自定义定价 > 本库 > 内置价目）。models.dev 不可达时自动换 OpenRouter。点「获取模型」时也会沉淀该网关实测数据。",
              onSelect: () => void onModelDbDownload(),
            },
          ]}
        />
      )}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          items={[
            {
              label: "验证",
              icon: ShieldCheck,
              onSelect: () => void onValidate(rowMenu.profile),
            },
            {
              label: "启动计划预览",
              icon: Eye,
              onSelect: () => void onPreviewLaunchPlan(rowMenu.profile),
            },
            ...(rowMenu.profile.accountType !== "official" &&
            rowMenu.profile.gatewayId
              ? [
                  {
                    icon: RefreshCw,
                    label: "刷新网关模型目录",
                    title:
                      "重新获取该网关的模型目录；不会自动修改当前绑定的模型名单",
                    onSelect: () => void refreshGatewayCatalog(rowMenu.profile),
                  },
                ]
              : []),
            { separator: true },
            {
              // 「停用」的准确形态（软停用）：不动数据、不动启动行为，只让自动路径
              // （启动栏预选/兜底、恢复会话、AI 功能回落）不再挑中它；手动指定仍可用。
              // 真正的「禁用」在注入模式下无意义——配置只在启动那一刻生效，
              // 没被选中的配置本来就不产生任何作用
              icon: EyeOff,
              label: (settings?.hiddenProfiles ?? []).includes(rowMenu.profile.id)
                ? "取消停用"
                : "停用此连接",
              title:
                "不再被恢复会话和 AI 功能自动挑中；启动栏下拉里沉到「已停用」分组，仍可手选",
              onSelect: () => void toggleHiddenProfile(rowMenu.profile),
            },
            {
              // 用户要的「启用」其实是这个：注入模式没有全局激活态，
              // 能表达的是「这个 agent 默认用哪套」（启动栏据此预选）
              icon: Star,
              label:
                settings?.defaultProfiles?.[rowMenu.profile.agent] ===
                rowMenu.profile.id
                  ? "取消 Mesa 启动默认"
                  : "设为 Mesa 启动默认",
              title: "只改 Mesa 新启动时的预选，不写外部 CLI 配置，也不改某个项目的默认",
              onSelect: () => void toggleDefaultProfile(rowMenu.profile),
            },
            {
              icon: CopyPlus,
              label: "复制到其他 agent…",
              onSelect: () =>
                setCopyMenu({
                  x: rowMenu.x,
                  y: rowMenu.y,
                  profile: rowMenu.profile,
                }),
            },
            { separator: true },
            {
              icon: Globe,
              label: rowMenu.profile.accountType === "official" ? "写入 CLI 全局默认（恢复官方）" : "写入 CLI 全局默认…",
              disabled:
                rowMenu.profile.noAuth ||
                !!rowMenu.profile.slotMissing ||
                (rowMenu.profile.accountType !== "official" &&
                  caps[rowMenu.profile.agent] !== undefined &&
                  !caps[rowMenu.profile.agent].setGlobal.supported),
              title:
                rowMenu.profile.accountType === "official"
                  ? "恢复该 CLI 首次写入前的配置，让官方账号接手外部终端"
                  : rowMenu.profile.slotMissing
                    ? "这个网关还没配该协议的端点"
                  : rowMenu.profile.noAuth
                    ? "无密钥连接不写入全局配置"
                    : (caps[rowMenu.profile.agent]?.setGlobal.reason ??
                      "修改外部 CLI 的配置文件（先备份、失败自动回滚）。不改 Mesa 启动栏预选，也不改项目默认。已打开的进程需要新开才会读到。"),
              onSelect: () => void onApplyGlobal(rowMenu.profile),
            },
            { separator: true },
            {
              icon: Trash2,
              label: "解绑",
              danger: true,
              onSelect: () => void onDelete(rowMenu.profile),
            },
          ]}
        />
      )}
      {groupMenu && (
        <ContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          onClose={() => setGroupMenu(null)}
          items={[
            ...(officialStatus[groupMenu.agentId]?.supported
              ? [
                  {
                    icon: LogIn,
                    label: officialStatus[groupMenu.agentId].connected
                      ? "刷新官方账号"
                      : "登录官方账号",
                    onSelect: () =>
                      officialStatus[groupMenu.agentId].connected
                        ? void refreshOfficial(groupMenu.agentId)
                        : connectOfficial(groupMenu.agentId),
                  },
                ]
              : []),
            {
              icon: Undo2,
              label: "撤销上次写入",
              disabled: !globalBackups[groupMenu.agentId],
              title: globalBackups[groupMenu.agentId]
                ? "回到最近一次写入（设为全局默认 / 在客户端打开时补写的渠道定义）前的状态；写了几遍就要撤销几遍。想彻底回到 Mesa 介入前的手工配置，用下面的「恢复初始状态」"
                : "还没有可撤销的写入",
              onSelect: () => void onRestoreBackup(groupMenu.agentId),
            },
            {
              icon: RotateCcw,
              label: "恢复初始状态",
              disabled: !originalBackups[groupMenu.agentId],
              title: originalBackups[groupMenu.agentId]
                ? "彻底回到 Mesa 首次写入前的原始配置（永久快照，连续多次写入也一次回到底）"
                : "还没有首次写入前的快照",
              onSelect: () => void onRestoreOriginal(groupMenu.agentId),
            },
          ]}
        />
      )}
      {copyMenu && (
        <ContextMenu
          x={copyMenu.x}
          y={copyMenu.y}
          onClose={() => setCopyMenu(null)}
          items={copyTargets(
            copyMenu.profile.agent,
            copyMenu.profile.protocol,
          ).map((t) => ({
            label: t.label,
            disabled: !t.compatible,
            title: t.reason,
            onSelect: () => void onCopyToAgent(copyMenu.profile, t.id),
          }))}
        />
      )}
      {validationDialog && (
        <ValidationDialog
          profile={validationDialog.profile}
          result={validationDialog.result}
          running={validationDialog.running}
          onClose={() => {
            if (!validationDialog.running) setValidationDialog(null);
          }}
        />
      )}
      {previewDialog && (
        <PreviewDialog
          profile={previewDialog.profile}
          result={previewDialog.result}
          onClose={() => setPreviewDialog(null)}
        />
      )}
      {writePreview && (
        <GlobalWritePreviewDialog
          profile={writePreview.profile}
          loading={writePreview.loading}
          preview={writePreview.preview}
          error={writePreview.error}
          conflict={writePreview.conflict}
          onCancel={() => setWritePreview(null)}
          onConfirm={() => void runApplyGlobal(writePreview.profile)}
        />
      )}
      {applyDialog && (
        <GlobalApplyDialog
          profile={applyDialog.profile}
          running={applyDialog.running}
          applied={applyDialog.applied}
          error={applyDialog.error}
          onClose={() => {
            if (!applyDialog.running) setApplyDialog(null);
          }}
          onShowValidation={() => {
            // 「查看验证详情」：进度/结果层换三层验证层（同一份 validation 数据）
            if (applyDialog.applied) {
              setValidationDialog({
                profile: applyDialog.profile,
                result: applyDialog.applied.validation,
                running: false,
              });
            }
            setApplyDialog(null);
          }}
        />
      )}
    </div>
  );
}
