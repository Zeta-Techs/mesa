import { Fragment, useEffect, useId, useRef, useState } from "react";
import { contextLabel } from "../model-caps-label";
import { isImageGenModel, modelKind, nonChatReason, splitChatModels } from "../model-kinds";
import ImageGenPanel, { setImageGenModel } from "../components/ImageGenPanel";
import { invoke } from "@tauri-apps/api/core";
import { scheduleWarnText, usageWarnText, type UnbindRefs } from "../unbind-impact";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  CopyPlus,
  Database,
  Eye,
  EyeOff,
  FileDown,
  ArrowDown,
  ArrowUp,
  Globe,
  GripVertical,
  Image as ImageIcon,
  Import,
  LayoutList,
  LogIn,
  RefreshCw,
  Search,
  RotateCcw,
  ShieldCheck,
  SquareArrowOutUpRight,
  Star,
  Trash2,
  Undo2,
  Check,
} from "lucide-react";
import { useAppStore } from "../store";
import { NAV_ICONS } from "../navigation-icons";
import { openChatWithProfile } from "../quick-chat-launch";
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
import { explicitClaudeRoles, normalizeRoleModels, rolesFor } from "../role-models";
import { ClaudeModelMapping } from "../components/ClaudeModelMapping";
import { gatewayMissingSlot, probeHint, saveBlocker } from "../connection-form";
import { EffectPreview } from "../components/EffectPreview";
import { groupModelsByVendor, vendorOf } from "../model-vendors";
import { interactiveUpdatePrefill } from "../update-routing";
import { absTime, relTime } from "../rel-time";
import { toast } from "../toast";
import { slotForAgent } from "../gateway-slot";
import { catalogCapabilityNote, zhipuOpenAiSlotBillingHint } from "../gateway-draft";
import {
  CONNECTION_STATUS_CAPTION,
  canProbeProfile,
  secretLikeEnvKeys,
  duplicateNameIds,
  profileNeedsProbe,
  unsyncedModels,
  profileStatusCell,
  showCatalogSyncAction,
  suggestConnectionName,
  type ProfileStatus,
  type ProfileStatusTone,
} from "../profile-connection-ui";
import { addConnectionDefaults, endpointHost, gatewayPickerRows } from "../gateway-option";
import ContextMenu from "../components/ContextMenu";
import GatewayLibrary from "../components/GatewayLibrary";
import VendorIcon from "../components/VendorIcon";
import AgentIcon from "../components/AgentIcon";
import { PROFILES_PANE_REQ_KEY } from "../profiles-pane";
import { officialModelLabel, type OfficialAliasTable } from "../official-model-names";
import { vendorForModel, vendorForOfficialAgent, vendorForProfile } from "../vendor-icon";
import {
  loadAgentGroupOrder,
  loadProfileOrder,
  moveWithinVisible,
  orderAgentIds,
  saveAgentGroupOrder,
  saveProfileOrder,
} from "../agent-group-order";
import {
  clampTabDragDx,
  rubberbandTabDx,
  tabDragSettleDx,
  tabDragShift,
  tabDragTarget,
} from "../tab-drag";
import { HoverTip, useHoverTip } from "../components/HoverTip";
import { alertDialog, confirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { collapseCarriageReturns } from "../stream-text";
import { diagnose, installToolHelp, type AgentCmdResult } from "../agent-install";

const IS_WINDOWS_UA = /Windows/i.test(navigator.userAgent);
import {
  NoticeBar,
  PageFrame,
  PageHeader,
  PaneNav,
  PaneNavGroup,
  PaneNavItem,
  PaneSplit,
  PaneSearch,
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
  GlobalDriftDetailDto,
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
  GatewayProbeDto,
  RequestPolicy,
  RoleModels,
  LaunchPlanPreviewDto,
} from "../types";

/** 添加 / 编辑连接弹层（导出供 UI 测试挂载） */
export function ProfileModal({
  initial,
  presetAgent,
  presetGatewayId,
  officialSupported,
  onClose,
  onSaved,
  onOpenGateway,
}: {
  initial: Profile | null;
  /** 从某个 agent 组的「+ 添加连接」打开时预选该 agent */
  presetAgent?: string;
  /** 从网关库「为此网关添加连接」打开时预选该网关（选用已有网关） */
  presetGatewayId?: string;
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
  // 新建时的默认选择只在打开那一刻算一次：没有连接在用的网关（多半刚在网关库建好）直接选上，
  // Agent 先挑装好的（gateway-option.ts addConnectionDefaults）
  const [opening] = useState(() => {
    if (initial) return null;
    const s = useAppStore.getState();
    const installed = new Set(s.agents.filter((a) => a.binaryPath).map((a) => a.id));
    const pick = addConnectionDefaults({
      gateways: s.gateways,
      boundGatewayIds: s.profiles.map((p) => p.gatewayId),
      installed: AGENTS.map((a) => a.id).filter((id) => installed.has(id)),
      presetAgent,
      presetGatewayId,
    });
    const gw = pick.gatewayId ? s.gateways.find((g) => g.id === pick.gatewayId) : undefined;
    return { agent: pick.agent, gateway: gw ?? null };
  });
  // 一键接入：选中的 provider 预设（含完整槽位与推荐模型）；null = 手填
  const [appliedPreset, setAppliedPreset] = useState<ProviderPreset | null>(null);
  // 服务商下拉显示的是哪家（2026-10-31：原先选完回到占位字，看不出套用了谁）；手改地址后清空
  const [presetName, setPresetName] = useState("");
  // 「同时绑到」部分失败：网关已建好，再点保存只补绑还没成功的几家，不再新建网关（2026-10-31 审查：原先重试会多建一个）
  const [retry, setRetry] = useState<{ gatewayId: string; done: string[] } | null>(null);
  // 换 Agent 时清掉了预设带来的地址：提示一句，免得以为丢了
  const [agentSwitchNote, setAgentSwitchNote] = useState<string | null>(null);
  // 「同时绑到」勾选的额外 Agent：保存时用同一份网关一次建多条绑定
  const [extraAgents, setExtraAgents] = useState<string[]>([]);
  const [bindMode, setBindMode] = useState<"new" | "existing">(
    opening?.gateway ? "existing" : "new",
  );
  const [bindGatewayId, setBindGatewayId] = useState(opening?.gateway?.id ?? "");
  const [combo, setCombo] = useState<ComboSurfaceDto | null>(null);
  const [form, setForm] = useState({
    agent: initial?.agent ?? opening?.agent ?? "claude-code",
    name: initial?.name ?? opening?.gateway?.name ?? "",
    accountType: (initial?.accountType ?? "api") as "api" | "official",
    noAuth: initial?.noAuth ?? false,
    protocol: (initial?.protocol ??
      AGENT_PROTOCOLS[initial?.agent ?? opening?.agent ?? "claude-code"]?.default ??
      null) as string | null,
    apiBackend: (initial?.apiBackend ?? null) as string | null,
    baseUrl: initial?.baseUrl ?? "",
    // 打开时已预选网关（网关库「为此网关添加连接」/ 没有连接在用的网关）：同点选网关一样默认带目录第一个能对话的模型
    models:
      initial?.models ??
      (opening?.gateway
        ? splitChatModels(opening.gateway.models.filter((m) => m.status !== "stale").map((m) => m.id)).chat.slice(0, 1)
        : ([] as string[])),
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
  // 打开时的表单快照：去网关库前判断有没有没保存的修改
  const [formSnapshot] = useState(() => JSON.stringify(form));
  const dirty = JSON.stringify(form) !== formSnapshot;
  async function leaveToGateway(gatewayId: string) {
    if (!onOpenGateway) return;
    if (dirty && !(await confirmDialog("这条连接还有没保存的修改，去网关库会丢掉。仍要去？", { confirmText: "去网关库" }))) return;
    onOpenGateway(gatewayId);
    onClose();
  }
  const [headerEnvText, setHeaderEnvText] = useState(
    Object.entries(initial?.requestPolicy?.headerEnv ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  // 同一 agent 下重名只提醒不拦：名字是给人看的，启动栏 / 选择器里同名分不清
  const allProfiles = useAppStore((s) => s.profiles);
  const sameNameTaken = (name: string) =>
    name !== "" &&
    allProfiles.some(
      (p) =>
        p.id !== initial?.id &&
        p.agent === form.agent &&
        p.name.trim().toLowerCase() === name.toLowerCase(),
    );
  const [fetching, setFetching] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [fetchedCapabilityCount, setFetchedCapabilityCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // 获取模型的厂商分组面板：开关 / 筛选词 / 展开的厂商组（预选了已有网关且它有目录时直接展开）
  const [pickerOpen, setPickerOpen] = useState(
    Boolean(opening?.gateway && opening.gateway.models.length > 0),
  );
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
  const formId = useId();
  // 添加连接的顺序（2026-10-23 弹层审查）：Agent → 账号类型 → 网关（新建 / 已有）→ 模型 → 名称。
  // 账号类型在上：官方账号不用网关，「新建 / 已有网关」只在 API 下出现，也只在 API 下生效
  const usesExisting = !initial && form.accountType === "api" && bindMode === "existing";
  const showGatewayFields =
    form.accountType === "api" && !initial && bindMode !== "existing";
  // 模型选择器数据源：新建网关 = 「验证并获取」拉取结果；选用已有网关/编辑连接 = 该网关目录
  // （null = 无网关语境——官方账号或纯新建，不出选择器）
  const catalogGatewayId = usesExisting ? bindGatewayId : (initial?.gatewayId ?? null);
  // 名称放最后、自动起：没手改过就按网关 / 服务商 / 地址起，这家 Agent 下撞名补首个模型（suggestConnectionName）
  const [nameTouched, setNameTouched] = useState(false);
  const autoName = (() => {
    if (initial) return "";
    const base =
      form.accountType === "official"
        ? "官方账号"
        : usesExisting
          ? (gateways.find((g) => g.id === bindGatewayId)?.name ?? "")
          : (appliedPreset?.name ?? endpointHost(form.baseUrl));
    return suggestConnectionName({
      base,
      firstModel: form.models.find((m) => m.trim()) ?? null,
      takenNames: allProfiles.filter((p) => p.agent === form.agent).map((p) => p.name),
    });
  })();
  const effectiveName = (initial || nameTouched ? form.name : autoName).trim();
  // 模型框的例子跟着 Agent 走：取这家第一个服务商的推荐模型，没有就不举例
  const modelPlaceholder = (() => {
    const example = presetsForAgent(form.agent).find((p) => p.provider.models?.length)
      ?.provider.models?.[0];
    return example ? `模型名，如 ${example}` : "模型名";
  })();
  // 网关目录里标了失效的旧模型不列（选了也用不了），数字与网关行「N 个模型」同口径（2026-10-31 截图：427 vs 473）
  const gatewayCatalog = catalogGatewayId
    ? (gateways.find((g) => g.id === catalogGatewayId)?.models ?? [])
        .filter((m) => m.status !== "stale")
        .map((m) => m.id)
    : null;
  // 出图 / 视频 / 向量等模型不能当 Agent 的对话模型：选择面板里不列，只报隐藏了几个（model-kinds.ts）
  const { chat: pickerModels, hidden: pickerHidden } = splitChatModels(
    showGatewayFields ? (fetchedModels ?? []) : (gatewayCatalog ?? []),
  );

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

  /** 目录里点一下：没选就加入、已选就去掉（原先已选的灰掉点不了，只能回名单点 ×） */
  function toggleModelInList(m: string) {
    const v = m.trim();
    if (form.models.some((x) => x.trim() === v)) {
      setForm({ ...form, models: form.models.filter((x) => x.trim() !== v) });
      return;
    }
    addModelToList(v);
  }

  /** 名单行「设为默认」：挪到第一个（Claude 先把别名映射转成显式，挪顺序不改别名指向） */
  function setDefaultModel(m: string) {
    const v = m.trim();
    const roleModels =
      form.agent === "claude-code" && form.accountType === "api"
        ? explicitClaudeRoles(form.models, form.roleModels)
        : form.roleModels;
    setForm({ ...form, roleModels, models: [v, ...form.models.filter((x) => x.trim() !== v)] });
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
      // 只在密钥框下报一次，补「下一步怎么改」（模型区不再重复同一条）
      setTestResult({ ok: false, text: `✗ ${String(e)}${probeHint(String(e))}` });
      setFetchError(null);
      setFetchedModels(null);
      setFetchedAt(null);
      setFetchedCapabilityCount(0);
    } finally {
      setFetching(false);
    }
  }

  // 网关没给能力字段时就地下载公共能力库（原先要离开弹层去页头 ⋯）
  const [capDbBusy, setCapDbBusy] = useState(false);
  async function downloadCapDb() {
    setCapDbBusy(true);
    try {
      await invoke("download_model_db");
      setFetchedCapabilityCount((n) => n || 1);
      toast("模型能力库已下载，上下文长度和思考能力按它认", "success");
    } catch (e) {
      toast(`能力库下载失败：${String(e)}`, "warning");
    } finally {
      setCapDbBusy(false);
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
      name: effectiveName,
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
      // Claude 存显式映射（旧绑定在这里按名单顺序算一遍写进去，指向不变）
      roleModels: rolesFor(form.agent).length
        ? normalizeRoleModels(
            form.agent === "claude-code" && form.accountType === "api"
              ? explicitClaudeRoles(form.models, form.roleModels)
              : form.roleModels,
            form.models.map((m) => m.trim()),
          )
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
      if (retry) {
        // 补绑：网关已在上一次保存时建好，只给还没成功的几家建绑定
        const targets = [
          { agent: input.agent, protocol: input.protocol, main: true },
          ...extraBindTargets(input.agent, input.protocol, extraAgents)
            .filter((t) => t.ok)
            .map((t) => ({ agent: t.agent, protocol: t.protocol, main: false })),
        ].filter((t) => !retry.done.includes(t.agent));
        const done = [...retry.done];
        try {
          for (const t of targets) {
            await bindGateway({
              agent: t.agent,
              name: t.main ? input.name : undefined,
              gatewayId: retry.gatewayId,
              kind: "api",
              protocol: t.protocol,
              apiBackend: t.main ? input.apiBackend : null,
              models: input.models,
              roleModels: t.main ? input.roleModels : undefined,
              extraEnv: t.main ? input.extraEnv : {},
            });
            done.push(t.agent);
          }
        } catch (err) {
          setRetry({ gatewayId: retry.gatewayId, done });
          setError(`还有绑定没成功：${String(err)}。网关已保存，改好后再点「补绑剩下的」。`);
          return;
        }
        onSaved?.(input.agent, input.name);
        onClose();
        return;
      }
      if (usesExisting) {
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
        const done: string[] = [];
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
          done.push(input.agent);
          for (const t of targets) {
            await bindGateway({
              agent: t.agent,
              gatewayId: gw.id,
              kind: "api",
              protocol: t.protocol,
              models: input.models,
              extraEnv: {},
            });
            done.push(t.agent);
          }
        } catch (err) {
          // 网关已保存：绑定失败不回滚网关；记下网关与已成功的几家，再点保存只补绑剩下的（不重复建网关）
          setRetry({ gatewayId: gw.id, done });
          setError(`部分绑定失败：${String(err)}。网关已保存，改好后点「补绑剩下的」。`);
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

  // 先选网关、后换 Agent：选中的网关可能没有新 Agent 要的协议地址
  const pickedMissing =
    usesExisting && !retry && bindGatewayId
      ? gatewayMissingSlot(gateways.find((g) => g.id === bindGatewayId)?.slots ?? {}, form.agent)
      : null;
  const blocker =
    saveBlocker({
      accountType: form.accountType,
      usesExisting: usesExisting && !retry,
      gatewayPicked: Boolean(bindGatewayId),
      newGateway: showGatewayFields && !retry,
      baseUrl: form.baseUrl,
      name: effectiveName,
    }) ?? (pickedMissing ? `选中的网关缺 ${pickedMissing} 地址，换一个网关或去网关库补` : null);
  const editGateway = initial?.gatewayId ? gateways.find((g) => g.id === initial.gatewayId) : undefined;

  return (
    <Modal
      open
      title={
        initial
          ? `编辑连接 · ${AGENTS.find((a) => a.id === initial.agent)?.label ?? initial.agent}`
          : "添加连接"
      }
      description={
        initial ? "改这条连接用的模型名单和附加环境变量。" : undefined
      }
      onClose={onClose}
      size="md"
      // 标题与「取消 / 保存」常驻，只有表单滚动（2026-10-23 弹层审查：保存钮原先跟着表单滚出视野）
      overflow="hidden"
      contentClassName="flex-1 overflow-y-auto overscroll-contain -mx-1 px-1"
      footer={
        <>
          {/* 还缺什么 / 保存失败写在按钮左边常驻（原先禁用原因只在悬停里、失败提示在表单最底下常滚出视野） */}
          {(error || blocker) && (
            <span
              className={`mr-auto min-w-0 flex-1 text-xs ${error ? "text-err-text" : "text-l3"} line-clamp-2`}
              title={error ?? undefined}
            >
              {error ?? blocker}
            </span>
          )}
          <button type="button" onClick={onClose} className={secondaryActionClass}>
            取消
          </button>
          <button
            type="submit"
            form={formId}
            disabled={saving || Boolean(blocker)}
            className={primaryActionClass}
          >
            {saving ? "保存中…" : retry ? "补绑剩下的" : "保存"}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>

        {/* 2026-10-31 简化：Agent 与账号类型并成一行（原先各占一段标题 + 控件） */}
        {!initial && (
        <div className="mb-4 flex items-end gap-3">
        <label className="block min-w-0 flex-1 text-sm">
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
              // 换 Agent = 换协议语境：预设与「同时绑到」的勾选都要重选；预设填的地址是给上一家协议的，一并清空
              if (appliedPreset && agent !== form.agent) {
                setForm((f) => ({ ...f, baseUrl: "" }));
                setAgentSwitchNote("换了 Agent，服务商预设填的地址已清空，重新选服务商或填地址");
              } else {
                setAgentSwitchNote(null);
              }
              setAppliedPreset(null);
              setPresetName("");
              setExtraAgents([]);
            }}
          />
        </label>
        {officialSupported[form.agent] && (
          <div className="shrink-0 pb-0.5">
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
        </div>
        )}

        {/* 编辑时先说清用的是哪个网关（地址、密钥、逐模型参数都在那边改）；有没保存的修改，去之前先问 */}
        {initial?.gatewayId && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-hairline px-3 py-2 text-xs">
            <span className="min-w-0 flex-1">
              <span className="text-l3">网关 </span>
              <span className="font-medium text-l1">{editGateway?.name ?? "（已删除）"}</span>
              {editGateway && (
                <span className="text-l3">
                  {" · "}
                  {gatewayPickerRows([editGateway])[0]?.detail}
                  {editGateway.keyHint ? ` · 密钥 ${editGateway.keyHint}` : ""}
                </span>
              )}
              <span className="mt-0.5 block text-micro text-l3">地址、密钥和每个模型的思考档 / 温度在网关库改</span>
            </span>
            {onOpenGateway && (
              <button type="button" className={`${rowActionClass} shrink-0`} onClick={() => void leaveToGateway(initial.gatewayId!)}>
                在网关库改
              </button>
            )}
          </div>
        )}
        {!initial && form.accountType === "api" && (
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs text-l3">网关</span>
            <SegTabs
              items={[
                { id: "new", label: "新建" },
                { id: "existing", label: "选用已有" },
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
        {usesExisting && (
          <div className="mb-3">
            {gateways.length === 0 ? (
              <p className="text-xs text-l3">
                还没有网关。改选「新建网关」，或到网关库添加。
              </p>
            ) : (
              <ul className="max-h-48 space-y-0.5 overflow-auto" aria-label="已有网关">
                {gatewayPickerRows(gateways).map((row) => {
                  const selected = bindGatewayId === row.id;
                  const gw = gateways.find((g) => g.id === row.id);
                  // 没填这家 Agent 要的协议地址：灰掉并写明缺什么（原先要到保存才报错）
                  const missing = gw ? gatewayMissingSlot(gw.slots, form.agent) : null;
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        disabled={Boolean(missing)}
                        className={`flex w-full flex-col rounded-md px-2.5 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
                          selected ? "bg-seg-sel text-l1" : "text-l2 hover:bg-hover hover:text-l1"
                        }`}
                        onClick={() => {
                          setBindGatewayId(row.id);
                          // 名称不在这里改：没手改过就按所选网关自动起（effectiveName）。
                          // 模型默认选目录里第一个能对话的（同新建网关「验证并获取」）：空名单 = 启动时不注入模型，用 CLI 自己的默认
                          const first = gw ? splitChatModels(gw.models.map((m) => m.id)).chat[0] : undefined;
                          if (gw) setForm((f) => ({ ...f, models: first ? [first] : [], accountType: "api" }));
                          setPickerOpen(Boolean(gw && gw.models.length > 0));
                          setPickerFilter("");
                          setOpenVendors(new Set());
                        }}
                      >
                        <span className="truncate text-sm font-medium">{row.name}</span>
                        <span className="truncate text-micro text-l3">
                          {missing ? `缺 ${missing} 地址，${AGENTS.find((a) => a.id === form.agent)?.label ?? form.agent} 用不了 · 去网关库补` : row.detail}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
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
              <p className="mb-3 text-xs text-l3">{reason}</p>
            ) : null;
          }
          return (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-xs text-l3">服务商</span>
            <MenuSelect
              aria-label="服务商"
              value={presetName}
              placeholder={form.baseUrl.trim() ? "自定义地址（也可以再选一家服务商）" : "选一家服务商，自动填地址和推荐模型…"}
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
                  setPresetName(preset.name);
                  setAgentSwitchNote(null);
                  setForm({
                    ...form,
                    baseUrl: preset.baseUrl,
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
        {agentSwitchNote && <p className="mb-2 text-xs text-warn-text">{agentSwitchNote}</p>}
        {/* Qwen / Kimi：协议决定地址填进网关的哪个槽，新建时放在地址上面（原先藏在高级设置里） */}
        {AGENT_PROTOCOLS[form.agent] && AGENT_PROTOCOLS[form.agent].options.length > 1 && (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-xs text-l3">接口协议（地址按这个协议填）</span>
            <MenuSelect
              aria-label="接口协议"
              value={form.protocol ?? AGENT_PROTOCOLS[form.agent].default}
              options={AGENT_PROTOCOLS[form.agent].options.map((p) => ({ value: p, label: protocolLabel(p) }))}
              onChange={(protocol) => setForm({ ...form, protocol })}
            />
          </label>
        )}
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">地址</span>
          <input
            className={fieldClass}
            placeholder="https://api.example.com"
            value={form.baseUrl}
            onChange={(e) => {
              setForm({ ...form, baseUrl: e.target.value });
              setAgentSwitchNote(null);
              // 手改地址即脱离预设推荐语境，避免「验证并获取」再按旧预设改写名单
              if (appliedPreset) setAppliedPreset(null);
              setPresetName("");
            }}
          />
        </label>
        {(form.agent === "claude-code" || form.protocol === "anthropic") &&
          form.baseUrl.trim().replace(/\/+$/, "").endsWith("/v1") && (
          <p className="-mt-2 mb-3 text-xs text-warn-text">
            Anthropic 客户端会自动在地址后拼 /v1/messages，以 /v1 结尾将打成 /v1/v1/messages 报 404（此时「验证并获取」仍能成功，不代表运行可用）——请去掉末尾的 /v1
          </p>
        )}
        {zhipuOpenAiSlotBillingHint(form.baseUrl) && (
          <p className="-mt-2 mb-3 text-xs text-warn-text">
            {zhipuOpenAiSlotBillingHint(form.baseUrl)}
          </p>
        )}
        <div className="mb-3 text-sm">
          <label htmlFor={`${formId}-key`} className="mb-1 block text-xs text-l3">密钥</label>
          {/* 「验证并获取」紧挨密钥：地址 + 密钥一填完就能点，不用去下面找（2026-10-23 弹层审查） */}
          <div className="flex items-center gap-2">
            <input
              id={`${formId}-key`}
              className={`${fieldClass} min-w-0 flex-1`}
              type="password"
              autoComplete="new-password"
              placeholder={initial ? "留空则不修改" : form.noAuth ? "本地端点无密钥，可留空" : "API 密钥"}
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
            <button
              type="button"
              onClick={() => void verifyAndFetch()}
              disabled={fetching || !form.baseUrl.trim()}
              title={
                form.baseUrl.trim()
                  ? "真实请求验证地址与密钥，并拉取模型目录；服务商推荐模型会自动选中"
                  : "先填地址"
              }
              className={`${secondaryActionClass} shrink-0 whitespace-nowrap`}
            >
              {fetching ? "验证中…" : "验证并获取"}
            </button>
          </div>
          {testResult && (
            <p className={`mt-1 text-xs ${testResult.ok ? "text-ok-text" : "text-err-text"}`}>
              {testResult.text}
            </p>
          )}
        </div>
          </>
        )}
        <div className="mb-4 text-sm">
          <span className="mb-1 block text-xs text-l3">
            {form.agent === "claude-code" && form.accountType === "api"
              ? "模型"
              : "模型（第一个是默认）"}
          </span>
          {(() => {
            const sw = MODEL_SWITCH[form.agent];
            if (!sw) return null;
            const filled = form.models.filter((m) => m.trim()).length;
            const over = sw.max != null && filled > sw.max;
            // 只在快到 / 超过上限时说（原先每次打开都挂一行「最多 5 个」）
            if (sw.max == null || filled < sw.max) return null;
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
          <div className="mb-2 flex flex-wrap items-center gap-2 empty:hidden">
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
                className={`${fieldClass} flex min-w-0 flex-1 items-center justify-between gap-2 text-left`}
              >
                <span className="truncate text-l3">
                  从 {pickerModels.length} 个模型中选择…
                </span>
                <FoldMark open={pickerOpen} />
              </button>
            )}
            {/* 每次点都真实请求（不读缓存），连通性与目录一次拿齐；缓存提示不再需要 */}
            {fetchedModels && fetchedModels.length > 0 && (
              <>
                {fetchedCapabilityCount === 0 && (
                  <span className="flex items-center gap-1.5 text-xs text-warn-text">
                    <span title="这家网关的 /models 只有模型 ID：上下文长度、会不会思考、能不能看图要靠公共能力库认">
                      网关没给能力字段
                    </span>
                    <button type="button" className={rowActionClass} disabled={capDbBusy} onClick={() => void downloadCapDb()}>
                      {capDbBusy ? "下载中…" : "下载能力库"}
                    </button>
                  </span>
                )}
                {fetchedCapabilityCount > 0 && (
                  <span className="shrink-0 text-xs text-l3">
                    {catalogCapabilityNote(
                      fetchedModels.length,
                      fetchedCapabilityCount,
                    )}
                  </span>
                )}
              </>
            )}
            {fetchedModels && fetchedModels.length === 0 && (
              <span className="text-xs text-l3">接口返回 0 个模型</span>
            )}
          </div>
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
                {fetching
                  ? "获取中…"
                  : gatewayCatalog && gatewayCatalog.length > 0
                    ? "刷新目录"
                    : "获取目录"}
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
                    从网关目录 {pickerModels.length} 个模型中选择…
                  </span>
                  <FoldMark open={pickerOpen} />
                </button>
              )}
              {(!gatewayCatalog || gatewayCatalog.length === 0) && (
                <span className="text-micro text-l3">
                  还没有目录，点「获取目录」拉取，或在下方手填。
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
            // 限高约十来行、搜索框与已选数固定在面板顶上：原先面板在弹层里自己滚一层，占满一屏把名单和映射表挤下去
            <div className="mb-2 max-h-56 overflow-y-auto rounded-md ccode-well p-1">
              <div className="sticky -top-1 z-10 -mx-1 -mt-1 mb-1 flex items-center gap-2 bg-inherit p-1">
                <input
                  autoFocus
                  className={`${searchFieldClass} min-w-0 flex-1`}
                  placeholder="筛选模型名…"
                  value={pickerFilter}
                  onChange={(e) => setPickerFilter(e.target.value)}
                />
                <span className="shrink-0 text-micro text-l3">已选 {form.models.filter((m) => m.trim()).length} 个</span>
              </div>
              {pickerHidden.length > 0 && (
                <p
                  className="mb-1 px-2 text-micro text-l3"
                  title={pickerHidden.join("\n")}
                >
                  已隐藏 {pickerHidden.length} 个出图、视频、向量等不能对话的模型；出图模型在连接页左栏「出图模型」里配
                </p>
              )}
              {(() => {
                const groups = groupModelsByVendor(pickerModels, pickerFilter);
                if (groups.length === 0) {
                  return (
                    <p className="px-2 py-1 text-xs text-l3">
                      没有匹配的模型。请先同步模型目录，或清除筛选词。
                    </p>
                  );
                }
                // 「常用」一组放最前：服务商推荐的 + 别的连接已经在用的（目录里有的才列）；分组不多（≤3）时默认全展开
                const common = commonPickerModels(
                  pickerModels,
                  appliedPreset?.models ?? [],
                  allProfiles.filter((p) => p.id !== initial?.id).flatMap((p) => p.models),
                  pickerFilter,
                );
                const allGroups = common.length ? [{ vendor: "常用", models: common }, ...groups] : groups;
                return allGroups.map((g) => {
                  const open =
                    pickerFilter.trim() !== "" ||
                    allGroups.length <= 3 ||
                    g.vendor === "常用" ||
                    openVendors.has(g.vendor);
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
                        <span className="text-micro text-l3">
                          {g.models.length}
                        </span>
                      </button>
                      {open &&
                        g.models.map((m) => {
                          const added = form.models.some((x) => x.trim() === m);
                          return (
                            <button
                              key={`${g.vendor}:${m}`}
                              type="button"
                              aria-pressed={added}
                              title={added ? "再点一下从名单去掉" : "点一下加进名单"}
                              onClick={() => toggleModelInList(m)}
                              className={`flex w-full items-center justify-between gap-2 rounded-sm py-1 pl-7 pr-2 text-left font-mono text-micro hover:bg-hover ${added ? "text-l1" : "text-l2"}`}
                            >
                              <span className="truncate">{m}</span>
                              {added && <Check aria-hidden="true" className="size-3.5 shrink-0 text-cta" />}
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
          {form.accountType === "api" && !form.models.some((m) => m.trim()) && pickerModels.length > 0 && (
            <p className="mb-1 text-xs text-warn-text">
              还没选模型：不选就用 CLI 自己的默认模型，多半不在这个网关上。
            </p>
          )}
          {(() => {
            const max = MODEL_SWITCH[form.agent]?.max ?? null;
            const filled = form.models.filter((m) => m.trim()).length;
            const slots = [...form.models];
            if (slots.length === 0 || slots[slots.length - 1].trim() !== "")
              slots.push("");
            const firstFilled = slots.findIndex((m) => m.trim());
            // Claude Code 的默认和各别名在下面的映射表里定：名单这里不再标「默认」/「设为默认」，免得两处各改一半
            const claudeMapped = form.agent === "claude-code" && form.accountType === "api";
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
                      const ctx = contextLabel(c.context);
                      return ctx ? `${flags.join(" · ")} · 上下文 ${ctx}` : flags.join(" · ");
                    })()}
                    className="group flex items-center gap-2 rounded-sm px-2 py-0.5 hover:bg-hover"
                  >
                    <span className="w-4 shrink-0 text-right text-micro text-l3">
                      {i + 1}
                    </span>
                    <input
                      aria-label={`第 ${i + 1} 个模型`}
                      className="min-w-0 flex-1 bg-transparent py-0.5 font-mono text-xs text-l2 outline-none placeholder:font-sans placeholder:text-l3"
                      placeholder={modelPlaceholder}
                      value={m}
                      onChange={(e) => setModelSlot(i, e.target.value)}
                    />
                    {/* 手填了出图 / 向量等模型：当场标出来（保存不拦，启动时后端闸会拒） */}
                    {nonChatReason(m.trim()) && (
                      <span
                        className="shrink-0 text-micro text-caution-text"
                        title={nonChatReason(m.trim()) ?? undefined}
                      >
                        不能对话
                      </span>
                    )}
                    {claudeMapped ? null : i === firstFilled ? (
                      // 与连接列表名称旁的「默认」同一枚主题色胶囊
                      <span className="shrink-0 rounded-full bg-cta-pill px-1.5 py-px text-micro text-cta-pill-text">
                        默认
                      </span>
                    ) : (
                      m.trim() && (
                        <button
                          type="button"
                          onClick={() => setDefaultModel(m)}
                          className={`shrink-0 text-micro text-l3 hover:text-l1 ${hoverRevealClass}`}
                        >
                          设为默认
                        </button>
                      )
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
        {/* 模型分工（2026-10-17）：哪些小任务 / 子 Agent 用哪个模型，原先由 Mesa 暗中补齐，现在摆出来可改。
            名单里有模型才出现（2026-10-23：空名单时只能选「跟主模型」，整块是噪声）；下拉用 MenuSelect，
            与弹层里其余下拉同一套长相（原生 select 是系统样式、字号也对不上） */}
        {form.accountType === "api" && form.agent === "claude-code" && (() => {
          const listed = [...new Set(form.models.map((m) => m.trim()).filter(Boolean))];
          if (listed.length === 0) return null;
          return (
            <ClaudeModelMapping
              models={listed}
              roles={form.roleModels}
              connName={form.name.trim()}
              gatewayId={catalogGatewayId}
              onRolesChange={(roleModels) => setForm({ ...form, roleModels })}
              onSetDefault={(m) => {
                // 先把映射转成显式，再挪顺序：挪名单不能顺带改掉别名指向
                const roleModels = explicitClaudeRoles(form.models, form.roleModels);
                const rest = form.models.filter((x) => x.trim() !== m);
                setForm({ ...form, roleModels, models: [m, ...rest] });
              }}
            />
          );
        })()}
        {form.accountType === "api" && form.agent !== "claude-code" && rolesFor(form.agent).length > 0 && (() => {
          const listed = [...new Set(form.models.map((m) => m.trim()).filter(Boolean))];
          if (listed.length === 0) return null;
          // 没在启动时选模型时，主模型 = 名单第一个
          const mainLabel = `跟主模型（${listed[0]}）`;
          return (
            <div className="mb-4">
              <span className="mb-1 block text-xs text-l3">模型分工</span>
              <div className="rounded-md border border-hairline">
                <div className="space-y-2.5 px-3 py-2.5">
                  {rolesFor(form.agent).map((r) => (
                    <div key={r.key} className="grid grid-cols-[6.5rem_1fr] items-start gap-x-3">
                      <span className="pt-1.5 text-xs text-l2">{r.label}</span>
                      {/* text-sm 定住下拉字号：按钮 font: inherit，不给就随外层变大（与 Agent 下拉对齐） */}
                      <span className="min-w-0 text-sm">
                        <MenuSelect
                          aria-label={r.label}
                          value={form.roleModels[r.key] ?? ""}
                          options={[
                            { value: "", label: mainLabel },
                            ...listed.map((m) => ({ value: m, label: m })),
                          ]}
                          onChange={(v) =>
                            setForm({
                              ...form,
                              roleModels: { ...form.roleModels, [r.key]: v || null },
                            })
                          }
                        />
                        <span className="mt-0.5 block text-micro leading-4 text-l3">{r.hint}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}
        {/* 生效预览（2026-10-30）：已保存的连接才有，九家同一块；内容按这家的启动注入与设为全局写入算 */}
        {initial?.id && (
          <EffectPreview
            profileId={initial.id}
            setGlobalReason={
              agentCapabilities && !agentCapabilities.setGlobal.supported
                ? (agentCapabilities.setGlobal.reason ?? "这家不支持设为全局")
                : null
            }
          />
        )}
        {/* 同时绑到：换 Agent 不必重走一遍「添加连接 → 选网关 → 挑模型」——
            同一份网关和模型名单一次建多条绑定；协议按各家默认推导，保存后可单独调整 */}
        {/* 同时绑到（2026-10-31 简化）：只列协议兼容的几家，做成点选小胶囊；说明与不兼容的原因收进悬停 */}
        {showGatewayFields && form.accountType === "api" && (() => {
          const targets = extraBindTargets(form.agent, form.protocol, AGENTS.map((a) => a.id));
          const ok = targets.filter((t) => t.ok);
          const blocked = targets.filter((t) => !t.ok);
          if (ok.length === 0) return null;
          return (
            <div className="mb-4">
              <span
                className="mb-1.5 block text-xs text-l3"
                title={`保存时用同一份网关和模型名单给选中的 Agent 各建一条连接，协议按各家自动适配。${
                  blocked.length ? `\n${blocked.map((t) => `${AGENTS.find((a) => a.id === t.agent)?.label ?? t.agent}：${t.reason ?? "协议不兼容"}`).join("\n")}` : ""
                }`}
              >
                顺便给这几家也建一条
              </span>
              <div className="flex flex-wrap gap-1.5">
                {ok.map((t) => {
                  const on = extraAgents.includes(t.agent);
                  return (
                    <button
                      key={t.agent}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setExtraAgents((cur) => (on ? cur.filter((x) => x !== t.agent) : [...cur, t.agent]))
                      }
                      className={`flex h-7 items-center gap-1 rounded-full px-2.5 ${
                        on ? "border border-transparent bg-seg-sel text-l1" : "border border-hairline text-l3 hover:bg-hover hover:text-l1"
                      }`}
                    >
                      {on && <Check aria-hidden="true" className="size-3" />}
                      <span className="text-xs">{AGENTS.find((a) => a.id === t.agent)?.label ?? t.agent}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">名称</span>
          <input
            className={fieldClass}
            placeholder={initial ? "这条连接叫什么" : "选好网关和模型后自动起，也可以自己改"}
            value={initial || nameTouched ? form.name : autoName}
            onChange={(e) => {
              setNameTouched(true);
              setForm({ ...form, name: e.target.value });
            }}
          />
          {!initial && !nameTouched && autoName && (
            <span className="mt-1 block text-micro text-l3">按网关和模型自动起的，可以改</span>
          )}
          {sameNameTaken(effectiveName) && (
            <span className="mt-1 block text-xs text-warn-text">
              这个 Agent 下已有同名连接，启动栏里会分不清。建议加上模型或用途，比如「{effectiveName} · {form.models.find((m) => m.trim()) || "flash"}」。
            </span>
          )}
        </label>
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
            {(showGatewayFields || (form.accountType === "api" && !(initial && !showGatewayFields))) && (
              <p className="mb-2 text-micro font-medium text-l2">跟着网关走<span className="ml-1.5 font-normal text-l3">用这个网关的其他连接也一样</span></p>
            )}
            {showGatewayFields && (
              <Checkbox
                className="mb-3 text-xs text-l2"
                checked={form.noAuth}
                onChange={(noAuth) => setForm({ ...form, noAuth })}
                label="本地端点无密钥"
              />
            )}
            {(form.accountType === "api" || !initial) && (
              <p className="mb-2 mt-3 border-t border-hairline pt-3 text-micro font-medium text-l2">只对这条连接</p>
            )}
            {AGENT_PROTOCOLS[form.agent] && !showGatewayFields && (
              derivedProtocol ? (
                <div className="mb-3 text-sm">
                  <span className="mb-1 block text-xs text-l3">接口协议</span>
                  <p className="text-xs text-l2">
                    {protocolLabel(derivedProtocol)}
                    <span className="ml-1.5 text-micro text-l3">按网关填了哪个地址自动确定</span>
                  </p>
                </div>
              ) : (
              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-xs text-l3">接口协议</span>
                <MenuSelect
                  aria-label="接口协议"
                  value={form.protocol ?? AGENT_PROTOCOLS[form.agent].default}
                  options={AGENT_PROTOCOLS[form.agent].options.map((p) => ({ value: p, label: protocolLabel(p) }))}
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
                <span className="mt-1 block text-micro text-l3">
                  这家中转用哪种接口和 Grok 对话。一般不用改；中转说明里写了要用 responses 或 messages 才选。只在「设为全局默认」后生效（在 Mesa 里启动带不上），中转自己的模型目录写明了接口时以目录为准。
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
                    onClick={() => void leaveToGateway(initial.gatewayId!)}
                  >
                    打开网关库
                  </button>
                )}
                {/* 已存策略「存了但注不进去」的说明照留：这是编辑时唯一需要知道的策略事实 */}
                {combo?.policyChannelNote && (
                  <span className="mt-1 block text-micro text-l3">{combo.policyChannelNote}</span>
                )}
                {combo?.effortReadonly && (
                  <span className="mt-1 block text-micro text-l3">思考档已保存在网关，当前 CLI 没有注入通道，启动时不会写进去。</span>
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
                  "temperature", "温度", "temperature"], ["topP", "top_p（采样范围）", "topP"], ["maxOutputTokens", "输出上限", "maxOutputTokens"]] as const).map(([key, label, capability]) => {
                  const support = agentCapabilities?.requestPolicy[capability];
                  return <label key={key} className="text-xs text-l3">{label}<span className="ml-1 text-micro text-l3">{channelLabel(support)}</span><input className={fieldClass} type="number" min={key === "temperature" ? "0" : key === "topP" ? "0" : "1"} max={key === "temperature" ? "2" : key === "topP" ? "1" : undefined} step={key === "temperature" ? "0.1" : key === "topP" ? "0.05" : "1"} placeholder="默认" value={form.requestPolicy[key] ?? ""} onChange={(e) => { const n = parseOptionalNumber(e.target.value); if (n !== undefined) setForm({ ...form, requestPolicy: { ...form.requestPolicy, [key]: n } }); }} /></label>;
                })}
              </div>
              <label className="mt-2 block text-xs text-l3">思考档<span className="ml-1 text-micro text-l3">{channelLabel(agentCapabilities?.requestPolicy.reasoningEffort)}</span>{agentCapabilities?.effortOptions?.length ? (
                <MenuSelect
                  aria-label="思考档"
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
                <p className="mb-2 text-micro text-l3">思考档 / 温度 / 输出上限在网关库里按模型编辑，这里改了也不会覆盖已有逐模型策略。</p>
              )}
              {showGatewayFields && (
              <label className="mt-2 block text-xs text-l3">自定义 Header（Header 名=环境变量名）<span className="ml-1 text-micro text-l3">{channelLabel(agentCapabilities?.requestPolicy.customHeaders)}</span><textarea className={`${fieldClass} h-16 font-mono text-xs`} placeholder="X-Provider-Region=MODEL_REGION\nX-Trace-Id=TRACE_ID" value={headerEnvText} onChange={(e) => setHeaderEnvText(e.target.value)} /></label>
              )}
              {showGatewayFields && (
                <p className="mt-1 text-micro text-l3">思考档、温度这些存到网关里这次选的每个模型上，以后在网关库按模型改。Header 的值只写环境变量名，Mesa 不保存明文。</p>
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
            {(() => {
              const secret = secretLikeEnvKeys(form.extraEnvText);
              return secret.length > 0 ? (
                <p className="mt-1 text-micro text-warn-text">
                  {secret.join("、")} 看起来是密钥。附加环境变量是明文存的，导出连接时也会被剔掉；
                  {form.accountType === "official" ? "官方账号不需要密钥" : "密钥请填在网关的「密钥」里（只存在本机的密钥文件）"}。
                </p>
              ) : null;
            })()}
            {form.agent === "kimi" && (
              <p className="mt-1 text-micro text-l3">
                Kimi 的思考输出在个别中转上显示不出来时，可以在这里加一行试试：用 Anthropic 协议的加 KIMI_MODEL_ADAPTIVE_THINKING=false；用 OpenAI 协议的加 KIMI_MODEL_REASONING_KEY=reasoning_content（或 reasoning_details、reasoning，看中转返回哪个字段）。平时不用填。
              </p>
            )}
          </div>
        </details>
      </form>
    </Modal>
  );
}

/** 接口协议的界面叫法（内部值 anthropic / openai / kimi 不直接给人看） */
function protocolLabel(p: string): string {
  if (p === "anthropic") return "Anthropic 兼容";
  if (p === "openai") return "OpenAI 兼容";
  if (p === "kimi") return "Kimi 官方协议";
  return p;
}

/** 目录面板最前的「常用」：服务商推荐的 + 别的连接已在用的，只列目录里有的，按这个顺序去重 */
function commonPickerModels(catalog: string[], recommended: string[], inUse: string[], filter: string): string[] {
  const has = new Set(catalog);
  const q = filter.trim().toLowerCase();
  return [...new Set([...recommended, ...inUse])].filter((m) => has.has(m) && (!q || m.toLowerCase().includes(q)));
}

/** 分组折叠状态持久化的 localStorage key：值为折叠中的 agent id 数组 */
const COLLAPSED_KEY = "ccode.profiles.collapsed";
/** 连接页左栏选中项（all / image / agent id） */
const PANE_KEY = "ccode.profiles.pane";


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

/** 连接列表五列网格模板：名称 | 端点 | 模型 | 状态 | 操作。
 *  官方账号行与数据行共用同一模板，保证上下行严格垂直对齐；
 *  操作列 170px 刚好容纳「两枚 hover 图标钮 + 编辑 + ⋯」，再宽会在中等窗口把行撑出横向滚动 */
const PROFILE_GRID =
  "grid-cols-[minmax(150px,1.1fr)_minmax(140px,0.9fr)_minmax(150px,1fr)_110px_220px]";

/** 状态列配色：纯状态 = 中性字 + 语义色小圆点；例外（缺/失败）字也着色，扫一眼就能挑出来 */
const STATUS_TONE: Record<ProfileStatusTone, { text: string; dot: string | null }> = {
  ok: { text: "text-l2", dot: "bg-ok-text" },
  warn: { text: "text-warn-text", dot: "bg-warn-text" },
  err: { text: "text-err-text", dot: "bg-err-text" },
  muted: { text: "text-l3", dot: null },
};

/** 名称旁的标记胶囊：配置失效 / 已停用（健康类，每行至多一颗）与 默认 / 全局（选用类）。
 *  默认、全局不是健康状态，但决定启动时用谁——2026-10-23 起从灰色 caption 提到名称旁，一眼能找到 */
function StatusPill({
  tone,
  tip,
  children,
}: {
  tone: "ok" | "err" | "muted" | "accent";
  tip: string;
  children: string;
}) {
  const cls =
    tone === "ok"
      ? "bg-ok text-ok-text"
      : tone === "err"
        ? "bg-err text-err-text"
        : tone === "accent"
          ? "bg-cta-pill text-cta-pill-text"
          : "bg-inset text-l3";
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-px text-micro font-normal ${cls}`}
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
  // 勾只在「刚登录成功」那一下亮几秒（2026-10-28 用户：不用一直挂着）：看到的是未登录 → 已登录的那次翻转才亮，
  // 打开页面时本来就登着的不亮
  const wasConnected = useRef(st.connected);
  const [justConnected, setJustConnected] = useState(false);
  useEffect(() => {
    if (st.connected && !wasConnected.current) {
      setJustConnected(true);
      const t = window.setTimeout(() => setJustConnected(false), 3000);
      wasConnected.current = true;
      return () => window.clearTimeout(t);
    }
    wasConnected.current = st.connected;
  }, [st.connected]);
  const hasOutboundProxy = Boolean(
    useAppStore((s) => s.settings?.outboundProxy?.trim()),
  );
  const lines: string[] = [];
  if (st.detail) lines.push(st.detail);
  if (st.connected) {
    const hint = OFFICIAL_LOGOUT_HINT[agentId];
    if (hint) lines.push(`断开方式：${hint}`);
  } else if (st.loginCommand) {
    lines.push(`点「官方登录」将在终端执行：${st.loginCommand}`);
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
        // 已登录：中性小胶囊（2026-10-28 用户：绿点「官方」像连通状态，和行里「● 测试通过」撞）；
        // 与未登录时的「官方登录」按钮同位同高，登录前后原地切换；勾只在刚登录成功时亮几秒
        className="inline-flex h-5 shrink-0 cursor-default items-center gap-1 rounded-full bg-inset px-2 text-micro text-l2"
      >
        {justConnected && <Check size={11} strokeWidth={2.4} className="text-ok-text" aria-hidden="true" />}
        官方已登录
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
        官方登录
      </button>
      {lines.length > 0 && <HoverTip tip={tip} text={lines.join("\n")} />}
    </span>
  );
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

/** 在 Mesa 里用官方账号启动时，进程级就能盖掉磁盘残留的 Agent（--settings 空串 / --auth-type），
 *  与 agents.rs `official_launch_conflicts` 放行的三家一致 */
const MESA_OVERRIDES_OFFICIAL = new Set(["claude-code", "codebuddy", "qwen"]);

/** 官方账号能「设为全局」（撤掉 API 键、交回 CLI 登录，走预览确认）的 Agent。
 *  与 global_config.rs `official_global_is_patch` 双端镜像；OpenCode 没有官方账号，Cursor 不支持设为全局 */
const OFFICIAL_GLOBAL_AGENTS = new Set(["codex", "claude-code", "gemini", "qwen", "codebuddy", "kimi", "grok"]);
function officialGlobalIsPatch(agent: string): boolean {
  return OFFICIAL_GLOBAL_AGENTS.has(agent);
}

/** 「外部 CLI 文件已被改过」明细：逐项写 Mesa 写的 → 现在磁盘上的（密钥已脱敏）。
 *  三个去向：按 Mesa 重写一遍 / 保留外部改动（不再记成 Mesa 的全局默认）/ 关掉 */
function GlobalDriftDialog({
  agentLabel,
  profile,
  detail,
  error,
  busy,
  onClose,
  onRewrite,
  onKeep,
}: {
  agentLabel: string;
  profile: Profile;
  detail: GlobalDriftDetailDto | null;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onRewrite: () => void;
  onKeep: () => void;
}) {
  const opText = (op: string) => (op === "remove" ? "被删掉了" : op === "add" ? "多出来" : "被改了");
  return (
    <Modal
      open
      title={`外部改过的地方 · ${agentLabel}`}
      description={`对照 Mesa 上次写入的「${profile.accountType === "official" ? "官方账号" : profile.name}」，看磁盘上现在哪里不一样（密钥已脱敏）。`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" onClick={onClose} className={secondaryActionClass}>
            关闭
          </button>
          <button
            type="button"
            disabled={busy || !detail}
            onClick={onKeep}
            title="文件不动；Mesa 不再把这份配置记成自己写的全局默认，这条提醒也随之消失"
            className={secondaryActionClass}
          >
            保留外部改动
          </button>
          <button
            type="button"
            disabled={busy || !detail}
            onClick={onRewrite}
            className="inline-flex h-7 items-center justify-center rounded-md border border-cta-bd bg-cta px-3 text-xs font-medium text-cta-text transition-[filter] hover:brightness-110 disabled:opacity-50"
          >
            按 Mesa 重写
          </button>
        </>
      }
    >
      <div className="space-y-3 px-4 py-3 text-xs leading-5">
        {!detail && !error && <p className="text-l3">◌ 正在对照磁盘…</p>}
        {error && <InlineNotice tone="err">{error}</InlineNotice>}
        {detail && detail.files.length === 0 && (
          <p className="text-l3">现在和 Mesa 写的一致了，可能刚被改回来。</p>
        )}
        {detail?.files.map((file) => (
          <div key={file.path}>
            <p className="font-medium text-l2">
              {file.path}
              {file.action === "deleted" && <span className="ml-2 text-warn-text">整个文件不见了</span>}
            </p>
            <ul className="mt-1 divide-y divide-hairline rounded-md border border-hairline">
              {file.changes.map((c) => (
                <li key={`${c.op}:${c.path}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-2.5 py-1.5">
                  <span className="break-all font-mono text-micro text-l2">{c.path}</span>
                  <span className="text-micro text-warn-text">{opText(c.op)}</span>
                  <span className="col-span-2 break-all font-mono text-micro text-l3">
                    {c.op === "add" ? (
                      <>现在：{c.after}</>
                    ) : c.op === "remove" ? (
                      <>Mesa 写的：{c.before}</>
                    ) : (
                      <>
                        Mesa 写的：{c.before} <span className="text-l4">→</span> 现在：{c.after}
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {file.omitted > 0 && <p className="mt-1 text-micro text-l4">另有 {file.omitted} 项未列出</p>}
          </div>
        ))}
      </div>
    </Modal>
  );
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
            {preview.overrideNotes.length > 0 && (
              <div>
                <p className="font-medium text-l2">外部用时可能被别处盖掉</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-l3">
                  {preview.overrideNotes.map((n) => (
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
  const gateways = useAppStore((s) => s.gateways);
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

  // 外部 CLI 文件被改过（漂移）：连接变化、全局写入后、回到本页时重查
  const [driftTick, setDriftTick] = useState(0);
  const activeGlobalMap = useAppStore((st) => st.settings?.activeGlobalProfiles);
  useEffect(() => {
    if (!visible) return;
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
  }, [profiles, visible, driftTick, activeGlobalMap]);

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

  // 官方账号别名 → 本机 CLI 实测的完整型号（后端查 Claude 状态时按版本后台重测，十几秒内落盘）
  const [officialAliases, setOfficialAliases] = useState<OfficialAliasTable>({});
  function loadOfficialAliases() {
    invoke<OfficialAliasTable>("official_model_aliases")
      .then(setOfficialAliases)
      .catch(() => {});
  }

  /** 重新检测某个 agent 的官方账号连接状态（只读 auth 文件，失败不影响页面） */
  async function refreshOfficial(agentId: string) {
    try {
      const st = await invoke<OfficialAccountStatusDto>(
        "official_account_status",
        { agentId },
      );
      setOfficialStatus((prev) => ({ ...prev, [agentId]: st }));
      if (agentId === "claude-code" || agentId === "gemini") {
        // 实测在后台跑：现在先读一次，稍后再读一次拿刚测出来的
        loadOfficialAliases();
        window.setTimeout(loadOfficialAliases, 20000);
      }
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
    presetGatewayId?: string;
    /** 从网关库进来的：关掉后回到网关库的这个网关 */
    backToGateway?: string;
  } | null>(null);
  const [gwLib, setGwLib] = useState(false);
  const [gwFocus, setGwFocus] = useState<string | null>(null);
  // 网关库「打开即新建」（上手引导发起）；gwOpenToken 换 key 让已开着的库按新请求重开
  const [gwNew, setGwNew] = useState(false);
  const [gwOpenToken, setGwOpenToken] = useState(0);
  // 别处（上手引导 / 下一步提示）发来的一次性请求：打开网关库 / 添加连接弹窗
  const gatewayLibraryReq = useAppStore((s) => s.gatewayLibraryReq);
  useEffect(() => {
    if (!gatewayLibraryReq) return;
    useAppStore.getState().setGatewayLibraryReq(null);
    setModal(null);
    setGwFocus(null);
    setGwNew(gatewayLibraryReq.create);
    setGwOpenToken(gatewayLibraryReq.token);
    setGwLib(true);
  }, [gatewayLibraryReq]);
  const profileModalReq = useAppStore((s) => s.profileModalReq);
  useEffect(() => {
    if (!profileModalReq) return;
    useAppStore.getState().setProfileModalReq(null);
    setGwLib(false);
    setGwFocus(null);
    setModal({ initial: null });
  }, [profileModalReq]);
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
  // 行上「测试」的就地结果：测试中 / 刚测完（后端状态重算前先用它，重算后以后端为准，失败原因留在悬停里）
  const [rowProbe, setRowProbe] = useState<
    Record<string, { running: true } | { running: false; ok: boolean; message: string }>
  >({});
  // 搜索：按名称/端点/模型过滤配置行（2026-10-29 起收成页头放大镜，点开才是输入框；安装状态过滤并进左栏：未安装的 Agent 灰显标「未安装」）
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // 左栏选中项（2026-10-29 借鉴 Claude 设置页「左选右看」）：all = 九家连排，image = 出图模型，其余是 agent id；记住上次看的
  const [pane, setPaneState] = useState<string>(() => {
    try {
      return localStorage.getItem(PANE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  function selectPane(next: string) {
    setPaneState(next);
    try {
      localStorage.setItem(PANE_KEY, next);
    } catch {
      // 存不下就只在本次生效
    }
  }
  // 别的页要打开某一项（设置页「去连接页设置」→ 出图模型）：本页可见时读走请求
  useEffect(() => {
    if (!visible) return;
    try {
      const req = localStorage.getItem(PROFILES_PANE_REQ_KEY);
      if (!req) return;
      localStorage.removeItem(PROFILES_PANE_REQ_KEY);
      selectPane(req);
    } catch {
      // 读不到就停在原来那一项
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  // 组折叠状态：首次默认折叠空组，手动折叠后持久化到 localStorage
  // 分组顺序（2026-10-28 用户：可拖动排序）：组头按住拖，松手存 localStorage；键盘走组头 ⋯ 的上移 / 下移
  const [groupOrder, setGroupOrder] = useState<string[] | null>(() => loadAgentGroupOrder());
  // 组内连接顺序（同日用户：每个连接也可自定义排序）：按 Agent 分存，行按住拖或 ⋯ 上移 / 下移
  const [profileOrder, setProfileOrder] = useState<Record<string, string[]>>(() => loadProfileOrder());
  /** 拖动中的那一项：scope = "groups"（拖组）或某个 agent id（拖该组里的连接行） */
  const [dragSort, setDragSort] = useState<{
    scope: string;
    id: string;
    from: number;
    target: number;
    dy: number;
    slots: { left: number; width: number }[];
    settling: boolean;
  } | null>(null);
  const suppressHeaderClickRef = useRef(false);
  function commitGroupMove(visibleIds: string[], from: number, to: number) {
    const full = orderAgentIds(
      AGENTS.map((a) => a.id),
      groupOrder,
    );
    const next = moveWithinVisible(full, visibleIds, from, to);
    setGroupOrder(next);
    saveAgentGroupOrder(next);
  }
  function commitProfileMove(agentId: string, visibleIds: string[], from: number, to: number) {
    setProfileOrder((cur) => {
      const full = orderAgentIds(
        profiles.filter((p) => p.agent === agentId).map((p) => p.id),
        cur[agentId],
      );
      const next = { ...cur, [agentId]: moveWithinVisible(full, visibleIds, from, to) };
      saveProfileOrder(next);
      return next;
    });
  }
  /** 某个 Agent 的全部连接，按用户排过的顺序（没排过的、新加的接在后面，保持原顺序） */
  function sortedProfilesOf(agentId: string) {
    const own = profiles.filter((p) => p.agent === agentId);
    const order = orderAgentIds(
      own.map((p) => p.id),
      profileOrder[agentId],
    );
    return order.map((id) => own.find((p) => p.id === id)!);
  }
  /** 按住拖排序：动 6px 才进拖拽态（点按照常生效），跟手、其余项让位，松手吸附后落位（同侧栏项目树）。
   *  组和组内连接行共用：listSelector 找容器、itemAttr 标出参与排序的项 */
  function startDragSort(
    e: React.PointerEvent,
    scope: string,
    id: string,
    listSelector: string,
    itemAttr: string,
    onCommit: (from: number, to: number) => void,
  ) {
    if (e.button !== 0) return;
    const startY = e.clientY;
    const list = (e.currentTarget as HTMLElement).closest(listSelector);
    let active = false;
    let slots: { left: number; width: number }[] = [];
    let from = 0;
    let lastTarget = 0;
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    const finish = () => {
      cleanup();
      if (!active) return;
      // 项上的按钮（官方登录 / ⋯ / 新版 / 编辑）跟着一起移动，松手常还在原按钮上：吞掉紧随的这一次 click
      suppressHeaderClickRef.current = true;
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => {
        suppressHeaderClickRef.current = false;
        window.removeEventListener("click", swallow, { capture: true });
      }, 0);
      const target = lastTarget;
      if (target === from) {
        setDragSort(null);
        return;
      }
      setDragSort((cur) =>
        cur ? { ...cur, dy: tabDragSettleDx(cur.slots, from, target), settling: true } : null,
      );
      window.setTimeout(() => {
        onCommit(from, target);
        setDragSort(null);
      }, 170);
    };
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) <= 6 || !list) return;
        const els = Array.from(list.querySelectorAll<HTMLElement>(`[${itemAttr}]`));
        if (els.length < 2) return;
        active = true;
        slots = els.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.top, width: r.height };
        });
        from = Math.max(0, els.findIndex((el) => el.getAttribute(itemAttr) === id));
        lastTarget = from;
        window.getSelection()?.removeAllRanges();
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      const raw = ev.clientY - startY;
      const target = tabDragTarget(slots, from, clampTabDragDx(slots, from, raw));
      lastTarget = target;
      setDragSort({ scope, id, from, target, dy: rubberbandTabDx(slots, from, raw), slots, settling: false });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }
  /** 拖动中某一项的位移与动效类：源项跟手，夹在中间的让位（高矮不一，见 tabDragShift） */
  function dragSortStyle(scope: string, id: string, index: number) {
    if (!dragSort || dragSort.scope !== scope) return { style: undefined, cls: "", dragging: false };
    const dragging = dragSort.id === id;
    const shift = dragging
      ? dragSort.dy
      : tabDragShift(dragSort.slots, dragSort.from, dragSort.target, index);
    return {
      style: { transform: `translateY(${shift}px)` },
      cls: dragging
        ? `relative z-10 ${dragSort.settling ? "transition-transform duration-150 ease-out" : ""}`
        : "transition-transform duration-150 ease-out",
      dragging,
    };
  }

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
  // 公共模型能力库（models.dev + LiteLLM，都不通退 OpenRouter）状态：顶部 ⋯ 菜单的更新入口。
  // 启动时没下过或超过 14 天会自己下；没下成时用随包快照
  const [modelDb, setModelDb] = useState<{
    downloaded: boolean;
    models: number;
    pricedModels?: number;
    downloadedAt?: string | null;
    bundledModels?: number;
    bundledAt?: string | null;
  } | null>(null);
  const [modelDbBusy, setModelDbBusy] = useState(false);
  useEffect(() => {
    invoke<{
      downloaded: boolean;
      models: number;
      pricedModels?: number;
      downloadedAt?: string | null;
      bundledModels?: number;
      bundledAt?: string | null;
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
        bundledModels?: number;
        bundledAt?: string | null;
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
        setError(installToolHelp(agentId, IS_WINDOWS_UA));
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

  /** 一键「设为全局」（连接行地球图标，2026-10-28 用户：每次写都弹预览和进度两个框太麻烦）：
   *  不弹预览、不弹进度，写完一条提示带「撤销」；复检在后台跑，没通过再提示。
   *  cc-switch 提醒每个 Agent 只问一次（globalConflictAck）；要看改什么走 ⋯ 里的「写入 CLI 全局默认…」 */
  const [globalBusy, setGlobalBusy] = useState<string | null>(null);
  async function quickApplyGlobal(p: Profile, opts?: { undoOf?: boolean }) {
    if (globalBusy || applyDialog || writePreview) return;
    const agent = p.agent;
    if (
      !opts?.undoOf &&
      p.accountType === "official" &&
      officialStatus[agent]?.supported &&
      !officialStatus[agent]?.connected &&
      !(await confirmDialog(
        `${labelOf(agent)} 还没登录官方账号。切过去后外部终端和客户端会要求先登录。仍要切回官方？`,
      ))
    )
      return;
    const acked = settings?.globalConflictAck ?? [];
    if (!acked.includes(agent)) {
      const conflict = await invoke<string | null>("set_global_conflict", { agent }).catch(() => null);
      if (conflict) {
        const ok = await confirmDialog(
          `${conflict}\n\n确认后，在连接页点地球图标或在托盘里切换 ${labelOf(agent)} 不再问这一句；⋯ 里的「写入 CLI 全局默认…」仍会先给你看要改什么。`,
          { confirmText: "切换，以后不再问" },
        );
        if (!ok) return;
        await updateSettings({ globalConflictAck: [...new Set([...acked, agent])] });
      }
    }
    const prevId = settings?.activeGlobalProfiles?.[agent] ?? null;
    const prev = prevId && prevId !== p.id ? (profiles.find((x) => x.id === prevId) ?? null) : null;
    setGlobalBusy(p.id);
    try {
      const applied = await invoke<GlobalApplyResultDto>("apply_profile_global", { profileId: p.id, validate: false });
      await refreshGlobalBackups();
      await loadSettings();
      setDriftTick((t) => t + 1);
      setError(null);
      const name = p.accountType === "official" ? "官方账号" : `「${p.name}」`;
      // Codex 客户端要重启才读新的模型目录：装了客户端就在提示里给「重启客户端」
      const codexClient =
        agent === "codex"
          ? await invoke<{ clientId: string; installed: boolean }[]>("client_open_list")
              .then((l) => l.find((c) => c.clientId === "codex-desktop" && c.installed))
              .catch(() => undefined)
          : undefined;
      const actions = [
        ...(opts?.undoOf ? [] : [{ label: "撤销", onClick: () => void undoQuickGlobal(agent, prev) }]),
        ...(codexClient
          ? [
              {
                label: "重启 Codex 客户端",
                onClick: () =>
                  void (async () => {
                    if (
                      !(await confirmDialog(
                        "将退出 ChatGPT（含 Codex 客户端）再重新打开。客户端里正在跑的任务会中断。继续？",
                        { confirmText: "重启" },
                      ))
                    )
                      return;
                    try {
                      await invoke("client_restart", { clientId: "codex-desktop" });
                      toast("Codex 客户端已重新打开，新建的对话走新连接", "success");
                    } catch (e) {
                      toast(String(e), "warning");
                    }
                  })(),
              },
            ]
          : []),
      ];
      toast(
        `外部 ${labelOf(agent)} 已切到${name}${agent === "codex" ? "；Codex 客户端重启后生效" : "，新开的会话生效"}`,
        "success",
        actions.length ? { actions } : undefined,
      );
      // 只报 shell 确实导出了的变量（不报每次都一样的项目级说明，那些在「写入 CLI 全局默认…」预览里看）
      const shellHits = (applied.overrideNotes ?? []).filter((n) => n.startsWith("你的 shell"));
      if (shellHits.length) toast(shellHits.join("；"), "warning");
      void invoke<ProfileValidationDto>("validate_global_profile", { profileId: p.id })
        .then((v) => {
          mirrorValidation(p, v);
          rememberValidation(p.id, v);
          if (!v.ok)
            toast(`${name}已写入，但复检没通过`, "warning", {
              actions: [{ label: "查看", onClick: () => setValidationDialog({ profile: p, result: v, running: false }) }],
            });
        })
        .catch(() => {});
    } catch (e) {
      toast(`切换失败：${String(e)}`, "error");
    } finally {
      setGlobalBusy(null);
    }
  }

  /** 撤销一键切换：之前有 Mesa 写的全局连接就切回它（连「全局使用中」一起回来），没有就撤销上次写入 */
  async function undoQuickGlobal(agent: string, prev: Profile | null) {
    if (prev) {
      await quickApplyGlobal(prev, { undoOf: true });
      return;
    }
    try {
      await invoke<string[]>("restore_global_backup", { agent });
      await refreshGlobalBackups();
      await loadSettings();
      setDriftTick((t) => t + 1);
      toast(`已撤销 ${labelOf(agent)} 的全局写入`, "success");
    } catch (e) {
      toast(`撤销失败：${String(e)}`, "error");
    }
  }

  /** 「外部 CLI 文件已被改过」点开：Mesa 写的 vs 磁盘现在的 */
  const [driftView, setDriftView] = useState<{
    agent: string;
    profile: Profile;
    detail: GlobalDriftDetailDto | null;
    error: string | null;
  } | null>(null);
  async function openDriftView(p: Profile) {
    setDriftView({ agent: p.agent, profile: p, detail: null, error: null });
    try {
      const detail = await invoke<GlobalDriftDetailDto>("global_drift_detail", { agent: p.agent });
      setDriftView({ agent: p.agent, profile: p, detail, error: null });
    } catch (e) {
      setDriftView({ agent: p.agent, profile: p, detail: null, error: String(e) });
    }
  }
  async function keepExternalChanges(agent: string) {
    try {
      await invoke("forget_active_global", { agent });
      await loadSettings();
      setDriftTick((t) => t + 1);
      setDriftView(null);
      toast(`${labelOf(agent)} 的外部改动已保留，Mesa 不再把它记成全局默认`, "success");
    } catch (e) {
      toast(String(e), "error");
    }
  }

  /** 一键添加官方账号连接（名字后端固定「官方账号」，不需要网关、密钥） */
  async function addOfficialProfile(agent: string) {
    try {
      await saveOfficialProfile(null, {
        agent,
        name: "官方账号",
        accountType: "official",
        noAuth: false,
        protocol: null,
        baseUrl: null,
        models: [],
        extraEnv: {},
        apiKey: null,
      });
      toast(
        officialStatus[agent]?.connected
          ? `已添加 ${labelOf(agent)} 官方账号，点那一行的地球图标就能把外部 ${labelOf(agent)} 切回官方`
          : `已添加 ${labelOf(agent)} 官方账号；还没登录，先点组头的「官方登录」`,
        "success",
      );
    } catch (e) {
      toast(`添加失败：${String(e)}`, "error");
    }
  }

  /** 行内「设为全局」：能直接写的才给（官方账号只有能只改几行的 Agent 给，其余官方仍走 ⋯ 里的恢复初始） */
  function canQuickGlobal(p: Profile): boolean {
    if (p.noAuth || p.slotMissing) return false;
    if (p.accountType === "official") return officialGlobalIsPatch(p.agent);
    return caps[p.agent]?.setGlobal.supported === true;
  }

  async function onApplyGlobal(p: Profile) {
    if (applyDialog || writePreview) return;
    if (
      p.accountType === "official" &&
      officialGlobalIsPatch(p.agent) &&
      officialStatus[p.agent]?.supported &&
      !officialStatus[p.agent]?.connected &&
      !(await confirmDialog(
        `${labelOf(p.agent)} 还没登录官方账号。切过去后外部终端和客户端会要求先登录。仍要切回官方？`,
      ))
    )
      return;
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
    const warn = scheduleWarnText(affected);
    // 删连接清点（W2b）：把「删了会怎样」说在事前——项目侧引用会被级联清理、
    // 目标回落项目默认、定时按上句 fail-loud。数不出来（命令失败）不拦删除。
    const usageWarn = await invoke<UnbindRefs>("profile_usage_refs", { id: p.id })
      .then((refs) => usageWarnText(refs))
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
  const orderedAgents = orderAgentIds(
    AGENTS.map((a) => a.id),
    groupOrder,
  ).map((id) => AGENTS.find((a) => a.id === id)!);
  // 实际画出来的组（搜索时没命中的组不画）：拖动排序只在这些组之间挪
  const shownAgents = orderedAgents.filter(
    (a) => !q || profiles.some((p) => p.agent === a.id && matchProfile(p)),
  );
  const shownIds: string[] = shownAgents.map((a) => a.id);
  // 右边实际看的：存下的选中项还在就用它；搜索把它筛掉了 / 第一次打开时，落到第一个有连接的 Agent
  const activePane =
    pane === "all" || pane === "image" || shownIds.includes(pane)
      ? pane
      : (shownAgents.find((a) => profiles.some((p) => p.agent === a.id && matchProfile(p)))?.id ??
        shownIds[0] ??
        "all");
  const paneAgents = activePane === "all" ? shownAgents : shownAgents.filter((a) => a.id === activePane);
  const dupNameIds = duplicateNameIds(profiles);
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
  const saveOfficialProfile = useAppStore((s) => s.saveProfile);
  const loadSettings = useAppStore((s) => s.loadSettings);
  // 托盘被 cc-switch 挡路后转来的请求：弹该连接的「设为全局」确认（挡路说明在确认框里）。
  // 连接还没加载完就等下一轮；profileId 为空只是跳到本页
  const trayGlobalReq = useAppStore((s) => s.trayGlobalReq);
  useEffect(() => {
    if (!trayGlobalReq) return;
    if (!trayGlobalReq.profileId) {
      useAppStore.getState().setTrayGlobalReq(null);
      return;
    }
    if (profiles.length === 0 && !connectionLoadError) return;
    useAppStore.getState().setTrayGlobalReq(null);
    const p = profiles.find((x) => x.id === trayGlobalReq.profileId);
    if (p) void onApplyGlobal(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trayGlobalReq, profiles, connectionLoadError]);

  /** 「新对话」：用这条连接开一段空白对话（与侧栏「新对话」同一落点），发一句话就能看出连接可不可用。
   *  不预先挡缺端点 / 缺密钥 / 已停用的连接——问题由输入框和启动提示如实说出来 */
  function openChatWith(profile: Profile) {
    void openChatWithProfile(profile);
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

  // 连接行「改作出图模型」：把这条连接里的出图模型设成出图模型，切到左栏「出图模型」
  const imageGenRef = useRef<HTMLElement | null>(null);
  const imageGenSetting = useAppStore((s) => `${s.settings?.imageGenGatewayId ?? ""}\u0001${s.settings?.imageGenModel ?? ""}`);
  const imageGenModelName = useAppStore((s) => s.settings?.imageGenModel ?? "");
  const imageGenVendor = vendorForModel(imageGenModelName);
  async function convertToImageGen(gatewayId: string, model: string) {
    try {
      await setImageGenModel(gatewayId, model);
      setNotice(`已把 ${model} 设为出图模型（左栏「出图模型」）。这条连接里没有能对话的模型，用不上了可以在 ⋯ 里删除`);
      selectPane("image");
    } catch (e) {
      setError(String(e));
    }
  }

  /** 行上「测试」：就地对这条连接用的协议槽 + 它的启动模型发一次基础请求（与网关库「测试」同一条命令，
   *  结果按槽 / 模型 / 地址密钥指纹存进网关，后端据此算出这条连接的「测试通过 / 测试失败」），不开网关库 */
  /** 官方账号行的「测试」（2026-10-28）：没有网关可测，就用这条连接无头发一句话（走 CLI 自己的登录），
   *  回复了算通过；失败的原因由后端 summarize_headless_error 收成一句（登录过期、个人账号被停用等）。
   *  会用一点官方额度，所以不自动跑，只在点了时测 */
  async function probeOfficialRow(profile: Profile) {
    if (rowProbe[profile.id]?.running) return;
    setRowProbe((cur) => ({ ...cur, [profile.id]: { running: true } }));
    try {
      const reply = await invoke<string>("ai_prompt", {
        profileId: profile.id,
        fnKey: null,
        prompt: "这是连接测试，请只回复两个字：收到",
      });
      const passed = { running: false as const, ok: true, message: reply.trim().slice(0, 40) };
      setRowProbe((cur) => ({ ...cur, [profile.id]: passed }));
      // 通过只亮一会儿，再回到「官方账号」（2026-10-28 用户）；失败一直留着等人处理。
      // 只撤这一次的结果：期间又点了重测（换成新对象）就不动
      window.setTimeout(() => {
        setRowProbe((cur) => {
          if (cur[profile.id] !== passed) return cur;
          const next = { ...cur };
          delete next[profile.id];
          return next;
        });
      }, 4000);
    } catch (e) {
      setRowProbe((cur) => ({
        ...cur,
        [profile.id]: { running: false, ok: false, message: String(e) },
      }));
    }
  }

  async function probeRow(profile: Profile) {
    if (profile.accountType === "official") return probeOfficialRow(profile);
    if (!profile.gatewayId || rowProbe[profile.id]?.running) return;
    setRowProbe((cur) => ({ ...cur, [profile.id]: { running: true } }));
    try {
      const dto = await invoke<GatewayProbeDto>("probe_gateway_slot", {
        gatewayId: profile.gatewayId,
        slot: slotForAgent(profile.agent, profile.protocol),
        model: profile.models[0] ?? null,
        basicOnly: true,
        baseUrl: null,
        apiKey: null,
        noAuth: null,
      });
      const failed = dto.checks.find((c) => c.status === "failed");
      setRowProbe((cur) => ({
        ...cur,
        [profile.id]: { running: false, ok: dto.ok, message: failed?.message ?? "" },
      }));
    } catch (e) {
      setRowProbe((cur) => ({
        ...cur,
        [profile.id]: { running: false, ok: false, message: String(e) },
      }));
    }
    // 测试结果已写进网关：重拉连接，让状态列换成后端算出的结论
    await loadAll().catch(() => {});
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
    // 2026-10-29 借鉴 Claude 设置页（连接页重做）：左边 Agent 栏（官方图标 + 连接数，可拖宽、可拖动排序、吸顶），右边只看选中的那家
    // （或「全部」九家连排、「出图模型」）；Agent 节不套卡，节标题粗体 + 细线，连接行名称在上、端点 · 模型灰字在下。
    // 页头与宽度维持原样（PageFrame wide）；搜索收成页头里的放大镜，点开才是输入框
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
        <PageHeader
          title="连接"
          meta={`每个 Agent 绑哪个网关、用哪些模型 · ${profiles.length} 个连接`}
          actions={
            <>
              {searchOpen || search ? (
                <PaneSearch
                  inputRef={searchRef}
                  className="w-56"
                  value={search}
                  onChange={setSearch}
                  placeholder="搜索连接 / 端点 / 模型"
                  label="搜索连接"
                  onBlur={() => {
                    if (!search.trim()) setSearchOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setSearch("");
                      setSearchOpen(false);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setSearchOpen(true);
                    requestAnimationFrame(() => searchRef.current?.focus());
                  }}
                  title="搜索连接 / 端点 / 模型"
                  aria-label="搜索连接"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-l3 hover:bg-hover hover:text-l1"
                >
                  <Search size={15} strokeWidth={1.8} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setGwNew(false);
                  setGwLib(true);
                }}
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
      <PaneSplit>
        <PaneNav inline narrow="hide" storageKey="ccode.profiles.navWidth" label="调整 Agent 栏宽度" defaultWidth={216} minWidth={176} maxWidth={340}>
          <div className="pb-4">
            <div className="flex flex-col gap-0.5">
              <PaneNavItem
                icon={<LayoutList size={15} strokeWidth={1.8} aria-hidden="true" />}
                label="全部"
                count={profiles.filter(matchProfile).length}
                selected={activePane === "all"}
                onClick={() => selectPane("all")}
              />
            </div>
            <PaneNavGroup label="Agent" />
            {/* 按住上下拖调整 Agent 顺序（与原来拖组头同一份顺序）；没装的灰显、右边写「未安装」 */}
            <div data-agent-group-list className="flex flex-col gap-0.5">
              {shownAgents.map((agent, navIndex) => {
                const installed = !!agents.find((x) => x.id === agent.id)?.binaryPath;
                const count = profiles.filter((p) => p.agent === agent.id && matchProfile(p)).length;
                const conflicted =
                  (officialStatus[agent.id]?.conflicts.length ?? 0) > 0 &&
                  conflictDismissed[agent.id] !== [...officialStatus[agent.id].conflicts].sort().join("\n");
                const outdated = installed && !!updateInfo[agent.id]?.outdated && !updating[agent.id];
                const navDrag = dragSortStyle("navgroups", agent.id, navIndex);
                return (
                  <div
                    key={agent.id}
                    data-agent-group={agent.id}
                    style={navDrag.style}
                    className={navDrag.cls}
                    onPointerDown={(e) =>
                      startDragSort(e, "navgroups", agent.id, "[data-agent-group-list]", "data-agent-group", (from, to) =>
                        commitGroupMove(shownIds, from, to),
                      )
                    }
                  >
                    <PaneNavItem
                      icon={<AgentIcon agent={agent.id} label={agent.label} size={16} />}
                      label={
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{agent.label}</span>
                          {conflicted && (
                            <span
                              className="size-1.5 shrink-0 rounded-full bg-warn-text"
                              title="有连接冲突：本地配置里的残留密钥会覆盖官方账号登录"
                            />
                          )}
                        </span>
                      }
                      count={
                        !installed ? (
                          "未安装"
                        ) : outdated ? (
                          <span className="text-cta" title={`有新版本 ${updateInfo[agent.id]?.latest ?? ""}`}>
                            新版 · {count}
                          </span>
                        ) : (
                          count
                        )
                      }
                      muted={!installed}
                      selected={activePane === agent.id}
                      title={installed ? `${agent.label}：${count} 个连接；按住上下拖可调整顺序` : `${agent.label}（本机未安装）`}
                      onClick={() => {
                        if (suppressHeaderClickRef.current) return;
                        selectPane(agent.id);
                      }}
                    />
                  </div>
                );
              })}
            </div>
            <PaneNavGroup label="其他" />
            <PaneNavItem
              icon={
                // 选了出图模型就用这个模型厂商的图标（gpt-image → OpenAI…），没选或认不出给中性图片图标
                imageGenVendor ? (
                  <VendorIcon vendor={imageGenVendor} name={imageGenModelName} />
                ) : (
                  <ImageIcon size={15} strokeWidth={1.8} aria-hidden="true" />
                )
              }
              label="出图模型"
              title={imageGenModelName ? `出图模型：${imageGenModelName}` : "还没选出图模型"}
              selected={activePane === "image"}
              onClick={() => selectPane("image")}
            />
          </div>
        </PaneNav>
        <div className="min-w-0 flex-1">
        {/* 内容区窄于 48rem 时左栏藏起，换成这个下拉（拖动排序只在宽的时候有；「全部」里的节标题照旧能拖） */}
        <div className="max-w-72 @min-[48rem]/pane:hidden">
          <MenuSelect
            aria-label="选择 Agent"
            value={activePane}
            onChange={selectPane}
            options={[
              { value: "all", label: `全部 · ${profiles.filter(matchProfile).length}` },
              ...shownAgents.map((agent) => {
                const installed = !!agents.find((x) => x.id === agent.id)?.binaryPath;
                const count = profiles.filter((p) => p.agent === agent.id && matchProfile(p)).length;
                return { value: agent.id, label: `${agent.label} · ${installed ? count : "未安装"}` };
              }),
              { value: "image", label: "出图模型" },
            ]}
          />
        </div>
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

        {/* agent 分组：左栏选一家只画这一家；选「全部」九家连排（可折叠、可拖组头排序）。列标题行已去掉（2026-10-25 用户拍板） */}
        {activePane !== "image" && paneAgents.length === 0 && (
          <p className="py-10 text-center text-sm text-l3">{q ? `没有匹配「${search.trim()}」的连接` : "还没有连接"}</p>
        )}
        <div data-agent-group-list>
          {paneAgents.map((agent) => {
            const groupIndex = shownIds.indexOf(agent.id);
            const det = agents.find((a) => a.id === agent.id);
            const list = sortedProfilesOf(agent.id).filter(matchProfile);
            const listIds = list.map((p) => p.id);
            const allView = activePane === "all";
            // 只看一家时没有折叠（左栏就是切换）；「全部」里照旧能折叠
            const isCollapsed = allView && collapsedGroups.has(agent.id);
            const groupDrag = dragSortStyle("groups", agent.id, groupIndex);
            // 2026-10-29 起不套卡（借鉴 Claude 设置页）：节标题粗体 + 标题行下一根细线，节与节大留白；
            // 未安装的不降透明度（opacity<1 会改变 fixed 后代的包含块，悬浮层定位会错乱），节标题旁写「未安装」
            return (
              <section
                key={agent.id}
                data-agent-group={agent.id}
                style={groupDrag.style}
                className={`mt-6 first:mt-3 ${allView ? "mb-6" : ""} ${groupDrag.cls}`}
              >
                <div
                  className={`group relative flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-hairline pb-2 ${
                    allView && !dragSort ? "cursor-grab" : ""
                  }`}
                  onPointerDown={(e) => {
                    if (!allView) return;
                    startDragSort(e, "groups", agent.id, "[data-agent-group-list]", "data-agent-group", (from, to) =>
                      commitGroupMove(shownIds, from, to),
                    );
                  }}
                >
                  {/* 握把浮在左外侧、不占布局（只在「全部」里能拖组头） */}
                  {allView && (
                    <span
                      aria-hidden
                      title="按住组头上下拖，调整分组顺序"
                      className="pointer-events-none absolute inset-y-0 -left-4 flex w-3 items-center justify-center text-l4 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <GripVertical size={14} strokeWidth={1.8} />
                    </span>
                  )}
                  {allView && (
                  <button
                    onClick={() => {
                      if (suppressHeaderClickRef.current) return;
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
                    className="flex shrink-0 items-center justify-center rounded-md text-l4 hover:text-l1"
                  >
                    <FoldMark open={!isCollapsed} />
                  </button>
                  )}
                  <AgentIcon agent={agent.id} label={agent.label} size={18} />
                  {/* 比页名「连接」（text-lg）低一档，同技能页分组名（2026-10-30 用户） */}
                  <h2
                    className="text-base font-semibold text-l1"
                    title={
                      det?.binaryPath
                        ? `${agent.binary} ${det.version ?? ""}`.trim()
                        : undefined
                    }
                  >
                    {agent.label}
                  </h2>
                  {/* 组头不写连接数（2026-10-28 用户拍板去掉）：展开就看得见，常驻只添噪 */}
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
                  {/* 还没有官方账号连接：一键加一条（不用开表单），加了就能在 Mesa 里用官方账号启动、一键切回官方 */}
                  {officialStatus[agent.id]?.supported &&
                    det?.binaryPath &&
                    !profiles.some((p) => p.agent === agent.id && p.accountType === "official") && (
                      <button
                        type="button"
                        onClick={() => void addOfficialProfile(agent.id)}
                        title={`添加一条「官方账号」连接：在 Mesa 里用 ${agent.label} 自己的登录启动，也能一键把外部 ${agent.label} 切回官方`}
                        className={ghostActionClass}
                      >
                        ＋ 官方账号
                      </button>
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
                  <div>
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
                            : diagnose(r.output, r.method, IS_WINDOWS_UA);
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
                      <p className="border-b border-hairline px-1 py-4 text-sm text-l3">还没有连接</p>
                    ) : (
                      // 行间极细分割线（hairline）替代卡片间距：整列垂直严格对齐，视觉节奏与官方账号行一致
                      // 列表宽于 60rem 时「端点 · 模型」挪成名字右边的一列（宽屏不再左右两头空一大截），窄了折回名字下面
                      <ul data-profile-list className="@container/rows divide-y divide-hairline border-b border-hairline">
                        {list.map((profile, rowIndex) => {
                          const hidden = (
                            settings?.hiddenProfiles ?? []
                          ).includes(profile.id);
                          const isDefault =
                            settings?.defaultProfiles?.[profile.agent] ===
                            profile.id;
                          const isGlobal =
                            settings?.activeGlobalProfiles?.[profile.agent] ===
                            profile.id;
                          // caption：上次使用 + 外部文件被改过（默认 / 全局已提到名称旁，连接状态在状态列）
                          const caption: {
                            text: string;
                            tip: string;
                            cls?: string;
                            onClick?: () => void;
                          }[] = [];
                          if (profile.lastUsedAt)
                            caption.push({
                              text: `上次使用 ${relTime(profile.lastUsedAt)}`,
                              tip: `上次使用 ${absTime(profile.lastUsedAt)}`,
                            });
                          const drifted = isGlobal && driftByAgent[profile.agent]?.status === "drifted";
                          if (drifted) {
                            caption.push({
                              text: "外部 CLI 文件已被改过 · 查看",
                              tip: `磁盘与 Mesa 写入不一致：${(driftByAgent[profile.agent]?.files ?? []).join("、") || "配置文件"}。点开看改了哪里，可按 Mesa 重写或保留外部改动`,
                              cls: "text-warn-text",
                              onClick: () => void openDriftView(profile),
                            });
                          }
                          // 绑定了、但网关目录里已经没有的模型：状态列点名，模型列划掉
                          const goneModels =
                            profile.accountType === "official"
                              ? []
                              : unsyncedModels(
                                  profile.models,
                                  gateways.find((g) => g.id === profile.gatewayId)?.models,
                                );
                          const status = profileStatusCell({ ...profile, unsynced: goneModels });
                          const officialSt =
                            profile.accountType === "official" && officialStatus[profile.agent]?.connected
                              ? officialStatus[profile.agent]
                              : null;
                          const officialPlan = officialSt?.plan ?? null;
                          // 邮箱不常驻，只在悬停时给（2026-10-28 用户）
                          const officialEmail = officialSt?.email ?? null;
                          const imageOnly =
                            profile.models.length > 0 && profile.models.every((m) => modelKind(m) !== "chat");
                          const imageGenPick = imageOnly ? (profile.models.find(isImageGenModel) ?? null) : null;
                          // 已经是出图模型了：不再给按钮，状态改说「已作出图模型」
                          const imageGenDone =
                            imageGenPick !== null && imageGenSetting === `${profile.gatewayId ?? ""}\u0001${imageGenPick}`;
                          // 同组重名：补首个模型名区分（只改显示，不动名字）
                          const nameSuffix =
                            dupNameIds.has(profile.id) && profile.models[0]
                              ? profile.models[0]
                              : null;
                          const rowDrag = dragSortStyle(agent.id, profile.id, rowIndex);
                          return (
                          <li
                            key={profile.id}
                            data-profile-row={profile.id}
                            style={rowDrag.style}
                            // 组内排序：行上空白处按住上下拖（按钮、链接照常点）；键盘走行尾 ⋯ 的上移 / 下移
                            onPointerDown={(e) => {
                              if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
                              startDragSort(e, agent.id, profile.id, "[data-profile-list]", "data-profile-row", (from, to) =>
                                commitProfileMove(agent.id, listIds, from, to),
                              );
                            }}
                            className={`group relative grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto_auto] content-center items-center gap-x-3 px-3 py-2.5 text-sm @min-[60rem]/rows:grid-cols-[auto_minmax(0,18rem)_minmax(0,1fr)_auto_auto] @min-[60rem]/rows:gap-x-4 ${
                              rowDrag.dragging ? "" : "transition-colors"
                            } ${
                              // 拖着走的那行：实底浮起，免得透出底下让位的行
                              rowDrag.dragging
                                ? "bg-raised shadow-md"
                                : // 全局使用中的那条：整行淡强调底 + 左缘强调短条（同侧栏选中口径），照 cc-switch「使用中」
                                  isGlobal
                                  ? "bg-[color-mix(in_oklab,var(--color-cta)_8%,transparent)] shadow-[inset_2px_0_0_var(--color-cta)]"
                                  : "hover:bg-hover/60"
                            } ${rowDrag.cls}`}
                          >
                            {/* 握把浮在左内边距里、不占布局，悬停才露出 */}
                            {list.length > 1 && (
                              <span
                                aria-hidden
                                title="按住行上空白处上下拖，调整连接顺序"
                                className="pointer-events-none absolute inset-y-0 left-0.5 flex w-3 items-center justify-center text-l4 opacity-0 transition-opacity group-hover:opacity-100"
                              >
                                <GripVertical size={14} strokeWidth={1.8} />
                              </span>
                            )}
                            {/* 格子摆放：窄 = 图标 | 名称 / 端点 · 模型 / 说明（三行） | 状态 | 操作；宽 = 图标 | 名称 / 说明 | 端点 · 模型 | 状态 | 操作 */}
                            <span className="col-start-1 row-span-3 row-start-1 flex self-center">
                              <VendorIcon
                                vendor={
                                  profile.accountType === "official"
                                    ? vendorForOfficialAgent(profile.agent)
                                    : vendorForProfile(
                                        profile.baseUrl,
                                        gateways.find((g) => g.id === profile.gatewayId),
                                      )
                                }
                                name={profile.name}
                              />
                            </span>
                              <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5">
                                <span
                                  className="truncate text-base font-medium text-l1"
                                  title={
                                    nameSuffix
                                      ? `${profile.name}（同一 Agent 下有同名连接，这里补上首个模型 ${nameSuffix} 区分；可在「编辑」里改名）`
                                      : profile.name
                                  }
                                >
                                  {profile.name}
                                  {nameSuffix && (
                                    <span className="font-normal text-l3"> · {nameSuffix}</span>
                                  )}
                                </span>
                                {isDefault && (
                                  <StatusPill tone="accent" tip="Mesa 启动栏预选这份连接。只改启动栏，不写外部 CLI 文件。">默认</StatusPill>
                                )}
                                {profileIssues[profile.id] ? (
                                  <StatusPill tone="err" tip={profileIssues[profile.id].reason}>配置失效</StatusPill>
                                ) : hidden ? (
                                  <StatusPill tone="muted" tip="已停用：不会被恢复会话和 AI 功能自动挑中；启动栏下拉里沉到「已停用」分组，仍可手选">已停用</StatusPill>
                                ) : null}
                              </span>
                              {/* 第二行（2026-10-29 起，原端点 / 模型两列）：端点 · 模型灰字，前 3 个模型平铺、其余 +N */}
                              <span className="col-start-2 row-start-2 mt-0.5 flex min-w-0 items-baseline gap-1.5 text-xs @min-[60rem]/rows:col-start-3 @min-[60rem]/rows:row-span-2 @min-[60rem]/rows:row-start-1 @min-[60rem]/rows:mt-0 @min-[60rem]/rows:self-center">
                                  {(profile.accountType !== "official" || officialPlan) && (
                                  <span
                                    className={`min-w-0 max-w-[45%] shrink-0 truncate ${profile.baseUrl ? "text-l3" : "text-l4"}`}
                                    title={
                                      profile.accountType === "official"
                                        ? `${officialEmail ? `账号：${officialEmail}\n` : ""}${officialPlan ? `套餐：${officialPlan}\n` : ""}官方账号登录（CLI 自身认证，不注入端点/密钥）`
                                        : profile.baseUrl
                                          ? displayHost(profile.baseUrl)
                                          : "使用 CLI 默认端点"
                                    }
                                  >
                                    {/* 官方账号没有端点可言：这一格写登录账号的套餐（2026-10-28 用户：只显示套餐，不显示邮箱）；
                                        读不到（未登录 / 这家还没接）就留空，不放横杠 */}
                                    {profile.accountType === "official"
                                      ? officialPlan
                                      : profile.baseUrl
                                        ? displayHost(profile.baseUrl)
                                        : "默认端点"}
                                  </span>
                                  )}
                                  {(profile.accountType !== "official" || officialPlan) && (
                                    <span className="shrink-0 text-l4" aria-hidden="true">·</span>
                                  )}
                                  {/* 模型列轻量化：mono micro 纯文字（不套底色块），前 3 个平铺，其余折叠为 +N；
                                      列宽装不下时 overflow 裁切，悬浮 title 始终给全文 */}
                                  <span
                                    className="flex min-w-0 items-baseline gap-1.5 overflow-hidden"
                                    title={
                                      profile.models.length > 0
                                        ? profile.models
                                            .map((m) =>
                                              profile.accountType === "official" ? officialModelLabel(profile.agent, m, officialAliases).text : m,
                                            )
                                            .join(" · ")
                                        : undefined
                                    }
                                  >
                                    {profile.models.length > 0 ? (
                                      <>
                                        {profile.models.slice(0, 3).map((m, i) => {
                                          // 官方账号的别名（Claude opus 等）显示成当前对应的完整型号，悬停说明启动传的仍是别名
                                          const label =
                                            profile.accountType === "official"
                                              ? officialModelLabel(profile.agent, m, officialAliases)
                                              : { text: m, tip: m };
                                          return (
                                          // 首个模型是启动默认：字色提一档、悬停说明，其余是会话里可切的
                                          // （其余用 l3 不用 l4：l4 在卡底上不到 4.5:1，是装饰档不是阅读档）
                                          <span
                                            key={m}
                                            className={`shrink-0 font-mono text-micro ${
                                              goneModels.includes(m)
                                                ? "text-warn-text line-through"
                                                : i === 0
                                                  ? "text-l2"
                                                  : "text-l3"
                                            }`}
                                            title={
                                              goneModels.includes(m)
                                                ? `${m}：已不在网关的模型目录里，点「编辑」去掉或换一个`
                                                : i === 0
                                                  ? `${label.tip}（启动默认）`
                                                  : label.tip
                                            }
                                          >
                                            {label.text}
                                          </span>
                                          );
                                        })}
                                        {profile.models.length > 3 && (
                                          <span className="shrink-0 font-mono text-micro text-l3">
                                            +{profile.models.length - 3}
                                          </span>
                                        )}
                                      </>
                                    ) : (
                                      <span
                                        className="text-xs text-l3"
                                        title={
                                          profile.accountType === "official"
                                            ? "这家 CLI 没有可读的官方模型名单，启动时用它自己的默认模型；要换在 CLI 里用 /model"
                                            : undefined
                                        }
                                      >
                                        {profile.accountType === "official" ? "CLI 默认模型" : "未指定模型"}
                                      </span>
                                    )}
                                  </span>
                              </span>
                              {/* caption 行：micro 档灰字，相对时间主显、悬浮给绝对时间（白话双层） */}
                              {caption.length > 0 && (
                                <span className="col-start-2 row-start-3 mt-0.5 block break-words text-micro text-l3 @min-[60rem]/rows:row-start-2">
                                  {caption.map((c, i) => (
                                    <Fragment key={`${c.text}-${i}`}>
                                      {i > 0 ? " · " : ""}
                                      {c.onClick ? (
                                        <button
                                          type="button"
                                          title={c.tip}
                                          onClick={c.onClick}
                                          className={`${c.cls ?? ""} underline-offset-2 hover:underline`}
                                        >
                                          {c.text}
                                        </button>
                                      ) : (
                                        <span title={c.tip} className={c.cls}>
                                          {c.text}
                                        </span>
                                      )}
                                    </Fragment>
                                  ))}
                                </span>
                              )}
                            {/* 状态列：只说例外与「测试通过」。未测试不常驻，悬停出「测试」，点了就地测，
                                结果写在原位；测过的结论也能点一下重测 */}
                            <span className="col-start-3 row-span-3 row-start-1 flex min-w-0 items-center self-center text-xs @min-[60rem]/rows:col-start-4">
                              {(() => {
                                // 名单里全是出图 / 视频等模型：这条连接对话不了（启动闸会拒），状态列直说
                                if (imageOnly) {
                                  return (
                                    <span
                                      className="flex min-w-0 items-center gap-1 text-warn-text"
                                      title={`${profile.models.join("、")} 不能用来和 Agent 对话。出图模型在左栏「出图模型」里配；点「改作出图模型」一步转过去`}
                                    >
                                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn-text" />
                                      <span className="truncate">{imageGenDone ? "已作出图模型" : "只有出图模型"}</span>
                                    </span>
                                  );
                                }
                                const local = rowProbe[profile.id];
                                // 官方账号：已登录、这家能无头调用（OpenCode 没有官方账号）才给测
                                const officialProbeable =
                                  profile.accountType === "official" && !!officialStatus[profile.agent]?.connected;
                                const probeable = canProbeProfile(profile) || officialProbeable;
                                if (local?.running) {
                                  return (
                                    <span className="flex items-center gap-1 text-l3" role="status">
                                      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-l3" />
                                      测试中…
                                    </span>
                                  );
                                }
                                // 后端算出结论优先；后端还认不出这次结果（比如被目录过期压住以外的情形）时用就地结果兜底
                                const localShown: ProfileStatus | null = local
                                  ? local.ok
                                    ? { text: "测试通过", tip: "刚才的连接测试通过", tone: "ok" }
                                    : { text: "测试失败", tip: "刚才的连接测试没通过", tone: "err" }
                                  : null;
                                // 官方账号的后端状态只是固定的「官方账号」：测过就以这次结果为准，否则它会把结果盖住
                                const shown: ProfileStatus | null =
                                  profile.accountType === "official" ? (localShown ?? status) : (status ?? localShown);
                                if (shown) {
                                  const why =
                                    local && !local.running && !local.ok && local.message
                                      ? `\n${local.message}`
                                      : "";
                                  const body = (
                                    <>
                                      {STATUS_TONE[shown.tone].dot && (
                                        <span
                                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_TONE[shown.tone].dot}`}
                                        />
                                      )}
                                      <span className="truncate">{shown.text}</span>
                                    </>
                                  );
                                  // 模型不在目录：重测清不掉，点一下直接打开编辑去改模型
                                  if (shown === status && shown.text === CONNECTION_STATUS_CAPTION.model_unsynced[0]) {
                                    return (
                                      <button
                                        type="button"
                                        onClick={() => setModal({ initial: profile })}
                                        title={shown.tip}
                                        className={`flex min-w-0 items-center gap-1 rounded-md px-1 -mx-1 hover:bg-hover ${STATUS_TONE[shown.tone].text}`}
                                      >
                                        {body}
                                      </button>
                                    );
                                  }
                                  return probeable ? (
                                    <button
                                      type="button"
                                      onClick={() => void probeRow(profile)}
                                      title={`${shown.tip}${why}\n${shown === localShown ? "点击重新测试" : "点击测试：用这个账号发一句话（会用一点额度）"}`}
                                      className={`flex min-w-0 items-center gap-1 rounded-md px-1 -mx-1 hover:bg-hover ${STATUS_TONE[shown.tone].text}`}
                                    >
                                      {body}
                                    </button>
                                  ) : (
                                    <span
                                      className={`flex min-w-0 items-center gap-1 ${STATUS_TONE[shown.tone].text}`}
                                      title={`${shown.tip}${why}`}
                                    >
                                      {body}
                                    </span>
                                  );
                                }
                                if (officialProbeable) {
                                  return (
                                    <button
                                      type="button"
                                      onClick={() => void probeRow(profile)}
                                      title="用这条官方账号发一句话试试（走 CLI 自己的登录，会用一点官方额度），结果写在这里"
                                      aria-label={`测试官方账号：${labelOf(profile.agent)}`}
                                      className={`${ghostActionClass} ${hoverRevealClass}`}
                                    >
                                      测试
                                    </button>
                                  );
                                }
                                return profileNeedsProbe(profile) ? (
                                  <button
                                    type="button"
                                    onClick={() => void probeRow(profile)}
                                    title="这条连接还没测过。点一下用它的启动模型发一次请求，结果写在这里"
                                    aria-label={`测试连接：${profile.name}`}
                                    className={`${ghostActionClass} ${hoverRevealClass}`}
                                  >
                                    测试
                                  </button>
                                ) : null;
                              })()}
                            </span>
                            <span className="col-start-4 row-span-3 row-start-1 flex items-center justify-end gap-1 self-center whitespace-nowrap @min-[60rem]/rows:col-start-5">
                              {/* 「新对话」（2026-10-19 取代 v3.88 的「在终端使用」）：建完连接立刻验证它能不能用——
                                  跳到新对话页、输入框里已选好这条连接，发一句话看有没有回复。
                                  低频入口 = hover 才现的 28px 图标 ghost 钮（常驻位只留「编辑」），
                                  操作列才塞得下、行高不被撑乱 */}
                              <button
                                type="button"
                                onClick={() => openChatWith(profile)}
                                title="新对话：用这个连接开一段新对话，发一句话就能看出它能不能用"
                                aria-label={`新对话：${profile.name}`}
                                className={`flex h-7 w-7 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                              >
                                <NAV_ICONS.quickChat size={14} strokeWidth={1.8} aria-hidden="true" />
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
                              {imageGenPick && profile.gatewayId && !imageGenDone && (
                                <button
                                  type="button"
                                  className={`${rowActionClass} text-warn-text`}
                                  title={`把 ${imageGenPick} 设为出图模型（左栏「出图模型」），Agent 画图时用它；这条连接本身不动，用不上了可在 ⋯ 里删除`}
                                  onClick={() => void convertToImageGen(profile.gatewayId!, imageGenPick)}
                                >
                                  改作出图模型
                                </button>
                              )}
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
                              {isGlobal ? (
                                <button
                                  type="button"
                                  onClick={() => (drifted ? void openDriftView(profile) : undefined)}
                                  title={
                                    drifted
                                      ? "Mesa 写进去之后，外部又改过这份配置。点开看改了哪里"
                                      : `外部 ${labelOf(profile.agent)}（系统终端${profile.agent === "codex" ? "、Codex 客户端" : ""}）现在用这条。要改回 Mesa 写的样子或撤销，在 ⋯ 里`
                                  }
                                  className={`mr-1 inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs ${
                                    drifted ? "text-warn-text hover:bg-hover" : "cursor-default text-l1"
                                  }`}
                                >
                                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${drifted ? "bg-warn-text" : "bg-cta"}`} />
                                  {drifted ? "外部改过" : "全局使用中"}
                                </button>
                              ) : canQuickGlobal(profile) ? (
                                <button
                                  type="button"
                                  disabled={globalBusy !== null}
                                  onClick={() => void quickApplyGlobal(profile)}
                                  title={
                                    profile.accountType === "official"
                                      ? `设为全局：把外部 ${labelOf(profile.agent)} 切回官方账号（直接写，提示里可撤销）`
                                      : `设为全局：把外部 ${labelOf(profile.agent)} 切到这条连接（直接写，提示里可撤销）`
                                  }
                                  aria-label={`设为全局：${profile.name}`}
                                  className={`flex h-7 w-7 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50 ${
                                    globalBusy === profile.id ? "" : hoverRevealClass
                                  }`}
                                >
                                  {globalBusy === profile.id ? (
                                    <RefreshCw size={14} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                                  ) : (
                                    <Globe size={14} strokeWidth={1.8} aria-hidden="true" />
                                  )}
                                </button>
                              ) : null}
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
        {/* 出图模型（2026-10-24 用户「连接这里配置生图模型」）：不属于哪个 Agent 的对话连接，单独一块；
            长相与 Agent 分组一致、行与连接行同一列模板。编辑处只此一处，设置页只显示现状并跳过来 */}
        {(activePane === "image" || (activePane === "all" && !q)) && (
          <ImageGenPanel gridClass={PROFILE_GRID} sectionRef={imageGenRef} />
        )}
        </div>
      </PaneSplit>
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
                  {MESA_OVERRIDES_OFFICIAL.has(conflictPop.agentId)
                    ? "这些键只影响 Mesa 外直接敲命令：在 Mesa 里用官方账号启动时会临时盖掉它们，不受影响；外部终端会照它们走 API 计费。"
                    : "这些键会覆盖官方账号登录并产生 API 计费：在 Mesa 里用官方账号启动会被拦下，外部终端也会照它们走 API。平时用 API 连接不受影响。"}
                </p>
                <p className="mt-1.5 leading-5 text-l3">
                  <span className="text-l2">只用 API 连接</span>：点「忽略」。
                  <span className="text-l2">外部也要用官方账号</span>
                  ：在「官方账号」那行点地球图标切回官方（只撤这几项，提示里可撤销），或点「备份后清理已识别项」，
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
          key={gwOpenToken}
          initialId={gwFocus}
          initialNew={gwNew}
          onClose={() => {
            setGwLib(false);
            setGwFocus(null);
            setGwNew(false);
            // 网关可能改过地址 / 密钥 / 重测过：行上就地结果作废，以后端重算为准
            setRowProbe({});
          }}
          onJumpUsage={(id) => {
            sessionStorage.setItem("ccode.statsGateway", id);
            setGwLib(false);
            setGwFocus(null);
            setGwNew(false);
            setPage("stats");
          }}
          onAddConnection={(id) => {
            setGwLib(false);
            setGwNew(false);
            setModal({ initial: null, presetGatewayId: id, backToGateway: id });
          }}
          onEditProfile={(p) => {
            setGwLib(false);
            setGwNew(false);
            setModal({ initial: p, backToGateway: p.gatewayId ?? undefined });
          }}
        />
      )}
      {modal && (
        <ProfileModal
          initial={modal.initial}
          presetAgent={modal.presetAgent}
          presetGatewayId={modal.presetGatewayId}
          officialSupported={Object.fromEntries(
            Object.entries(officialStatus).map(([k, v]) => [k, v.supported]),
          )}
          onClose={() => {
            // 从网关库进来的：回到库里刚才那个网关
            const back = modal.backToGateway;
            setModal(null);
            if (back) {
              setGwFocus(back);
              setGwOpenToken((t) => t + 1);
              setGwLib(true);
            }
          }}
          onOpenGateway={(id) => {
            setModal(null);
            setGwFocus(id);
            setGwNew(false);
            setGwLib(true);
          }}
          onSaved={(agent, name) => {
            // 注入模式：改动只对**新启动**的标签生效，已在跑的要重开
            if (runningAgents.has(agent))
              setSavedNote(
                `已保存「${name}」。这家 Agent 有对话正在运行——连接是在启动那一刻注入的，那几段要**停下再接着聊**才用上改动。`,
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
              // 名字固定、现况放行尾小字（2026-10-28 用户截图：长括号把菜单撑满、日期被截断）
              label: modelDbBusy ? "正在更新模型能力库…" : "更新模型能力库",
              hint: modelDbBusy
                ? undefined
                : modelDb?.downloaded
                  ? `${modelDb.models} 个${modelDb.downloadedAt ? ` · ${modelDb.downloadedAt.slice(5, 10)}` : ""}`
                  : `随包 ${modelDb?.bundledModels ?? 0} 个${
                      modelDb?.bundledAt ? ` · ${modelDb.bundledAt.slice(5, 10)}` : ""
                    }`,
              disabled: modelDbBusy,
              title:
                "各家模型的上下文、输出上限、看图、思考与官方定价的公共数据（models.dev 与 LiteLLM 合并，都连不上才用 OpenRouter；直连不通走设置里的出网代理）。启动时没下过或超过 14 天会自己更新，没下成时用安装包里带的那份。统计页费用估算随之更新（定价优先级：自定义定价 > 本库 > 内置价目）。点「获取模型」时也会沉淀该网关实测数据。",
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
            // 组内排序：拖动的键盘 / 不方便拖时的替代
            ...(() => {
              const ids = sortedProfilesOf(rowMenu.profile.agent)
                .filter(matchProfile)
                .map((p) => p.id);
              const i = ids.indexOf(rowMenu.profile.id);
              if (ids.length < 2) return [];
              return [
                {
                  icon: ArrowUp,
                  label: "上移一位",
                  disabled: i <= 0,
                  onSelect: () => commitProfileMove(rowMenu.profile.agent, ids, i, i - 1),
                },
                {
                  icon: ArrowDown,
                  label: "下移一位",
                  disabled: i >= ids.length - 1,
                  onSelect: () => commitProfileMove(rowMenu.profile.agent, ids, i, i + 1),
                },
                { separator: true as const },
              ];
            })(),
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
              label:
                rowMenu.profile.accountType !== "official"
                  ? "写入 CLI 全局默认…"
                  : "写入 CLI 全局默认（切回官方）…",
              disabled:
                rowMenu.profile.noAuth ||
                !!rowMenu.profile.slotMissing ||
                (rowMenu.profile.accountType === "official"
                  ? !officialGlobalIsPatch(rowMenu.profile.agent)
                  : caps[rowMenu.profile.agent] !== undefined &&
                    !caps[rowMenu.profile.agent].setGlobal.supported),
              title:
                rowMenu.profile.accountType === "official"
                  ? officialGlobalIsPatch(rowMenu.profile.agent)
                    ? "只撤掉会盖过官方登录的端点、密钥和中转模型名，交回 CLI 自己的官方登录；别的配置不动（先预览）"
                    : "这家 CLI 暂不支持从 Mesa 写入全局默认"
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
            // 拖动排序的键盘 / 不方便拖时的替代
            {
              icon: ArrowUp,
              label: "上移一位",
              disabled: shownIds.indexOf(groupMenu.agentId) <= 0,
              onSelect: () => {
                const i = shownIds.indexOf(groupMenu.agentId);
                commitGroupMove(shownIds, i, i - 1);
              },
            },
            {
              icon: ArrowDown,
              label: "下移一位",
              disabled: shownIds.indexOf(groupMenu.agentId) >= shownIds.length - 1,
              onSelect: () => {
                const i = shownIds.indexOf(groupMenu.agentId);
                commitGroupMove(shownIds, i, i + 1);
              },
            },
            { separator: true },
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
      {driftView && (
        <GlobalDriftDialog
          agentLabel={labelOf(driftView.agent)}
          profile={driftView.profile}
          detail={driftView.detail}
          error={driftView.error}
          busy={globalBusy !== null}
          onClose={() => setDriftView(null)}
          onKeep={() => void keepExternalChanges(driftView.agent)}
          onRewrite={() => {
            const target = profiles.find((x) => x.id === driftView.detail?.profileId) ?? driftView.profile;
            setDriftView(null);
            void quickApplyGlobal(target, { undoOf: true });
          }}
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
