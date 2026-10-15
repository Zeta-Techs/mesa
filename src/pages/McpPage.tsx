import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AGENTS } from "../types";
import { IS_WINDOWS } from "../hotkeys";
import { useAppStore } from "../store";
import type {
  AgentCapabilitiesDto,
  McpCommandFixCandidate,
  McpEnvPair,
  McpEnvSecretHintDto,
  McpHealthDto,
  McpServerDto,
} from "../types";
import { confirmDialog } from "../components/ConfirmDialog";
import ContextMenu from "../components/ContextMenu";
import { Modal } from "../components/Modal";
import { HoverTip, useHoverTip } from "../components/HoverTip";
import { mcpKindBadgeStyle, shortenCommand } from "../mcp-display";
import type { McpHealthView } from "../mcp-display";
import {
  isAdoptedMcp,
  mcpCmdPathBadge,
  mcpDeleteImpact,
  mcpDistBadge,
  mcpHealthNeedsLogin,
  mcpHealthText,
  mcpOriginLabel,
  mcpPathResolveNote,
  missingEnvSignature,
  missingEnvWarnText,
  mcpEnvRefNames,
  mcpSecretFieldLabel,
  mcpSecretPlaceholder,
} from "../mcp-display";
import {
  EmptyState,
  FoldMark,
  PageFrame,
  PageHeader,
  primaryActionClass,
  secondaryActionClass,
  ghostActionClass,
  fieldClass,
  RowAction,
  Toggle,
  hoverRevealClass,
} from "../components/PageFrame";
import {
  applyBlenderMcpProbe,
  applyMcpPreset,
  MCP_PRESETS,
  writableMcpAgentIds,
  type AppliedMcpPreset,
  type BlenderMcpProbe,
  type McpPreset,
  type ResolvedMcpSetup,
} from "../mcp-presets";

/** MCP 列表五列网格模板（表头与数据行共用，保证列严格对齐）：
 *  名称 | 类型 | 配置 | 分发 | 行内操作+启用开关（2026-08-25 设计评审：宽屏下左右信息不再跨整页） */
const MCP_GRID =
  "grid-cols-[minmax(150px,1.1fr)_64px_minmax(200px,1.4fr)_96px_140px]";

/** 行首健康状态点（v3.93）：未检测不渲染（无状态不渲染状态点）；检测过 = 绿/红点 + 延迟，
 *  悬浮看 detail/error 全文，点击重新检测。↯ 行内测试与这里是同一触发。
 *  at 有值 = 展示的是清单里沉淀的上次结果（文案带「上次检测」前缀，与实时结果区分） */
function HealthDot({
  health,
  at,
  onCheck,
}: {
  health: McpHealthView | "checking" | undefined;
  at?: string | null;
  onCheck: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { tip, show, hide } = useHoverTip(ref);
  const text = mcpHealthText(health, at);
  if (!health || !text) return null;
  const checking = health === "checking";
  const ok = !checking && health.ok;
  const needsLogin = !checking && mcpHealthNeedsLogin(health);
  return (
    <button
      ref={ref}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onCheck();
      }}
      onMouseEnter={show}
      onMouseLeave={hide}
      aria-label={
        checking ? "正在检测" : ok ? "连通正常" : needsLogin ? "需 OAuth 登录" : "未连通"
      }
      className="flex h-7 w-4 shrink-0 items-center justify-center"
    >
      <span
        className={`size-2 rounded-full ${
          checking
            ? "animate-pulse bg-l4"
            : ok
              ? "bg-ok-text"
              : needsLogin
                ? "bg-warn-text"
                : "bg-err-text"
        }`}
      />
      <HoverTip tip={tip} text={text} />
    </button>
  );
}

/** 收编候选（后端 discover_mcp_servers） */
interface DiscoveredMcp {
  agent: string;
  name: string;
  summary: string;
  /** 命令是相对路径（./ ../ 开头）：来源 agent 的运行语境下才解析得到，收编时后端会先尝试落绝对路径 */
  relativeCommand: boolean;
}

/** MCP 页（matrix §10 调研落地）：统一清单 + 一键分发到各 CLI 的用户级配置。
 *  分发只写用户级（项目级有审批闸），密钥用 $VAR 引用不落明文 */

const EMPTY_FORM = {
  name: "",
  kind: "stdio" as "stdio" | "remote",
  command: "",
  argsText: "", // 空格分隔
  cwd: "",
  env: [] as McpEnvPair[],
  url: "",
  headers: [] as McpEnvPair[],
  timeoutText: "", // 启动超时（秒），可空
};

type Form = typeof EMPTY_FORM;

function formFrom(s: McpServerDto): Form {
  return {
    name: s.name,
    kind: s.kind,
    command: s.command,
    argsText: s.args.join(" "),
    cwd: s.cwd,
    env: s.env.map((p) => ({ ...p })),
    url: s.url,
    headers: s.headers.map((p) => ({ ...p })),
    timeoutText: s.startupTimeoutMs
      ? String(Math.round(s.startupTimeoutMs / 1000))
      : "",
  };
}

/** 预设 → 添加表单（键值对克隆，避免编辑时改到预设常量） */
function formFromApplied(p: AppliedMcpPreset): Form {
  return {
    ...EMPTY_FORM,
    name: p.name,
    kind: p.kind,
    command: p.command,
    argsText: p.args.join(" "),
    url: p.url,
    headers: p.headers.map((x) => ({ ...x })),
    timeoutText:
      p.startupTimeoutMs != null
        ? String(Math.round(p.startupTimeoutMs / 1000))
        : "",
  };
}

/** 键值对编辑行组（env / headers 共用） */
function PairEditor({
  label,
  pairs,
  onChange,
}: {
  label: string;
  pairs: McpEnvPair[];
  onChange: (next: McpEnvPair[]) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-l3">{label}</span>
        <button
          type="button"
          className="text-xs text-l4 hover:text-l1"
          onClick={() => onChange([...pairs, { key: "", value: "" }])}
        >
          + 添加
        </button>
      </div>
      <div className="space-y-1">
        {pairs.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={`${fieldClass} basis-40 shrink-0 grow-0`}
              placeholder="KEY"
              value={p.key}
              onChange={(e) => {
                const next = [...pairs];
                next[i] = { ...p, key: e.target.value };
                onChange(next);
              }}
            />
            <input
              className={`${fieldClass} min-w-0 flex-1 font-mono`}
              placeholder="值，或 $VAR 引用环境变量"
              value={p.value}
              onChange={(e) => {
                const next = [...pairs];
                next[i] = { ...p, value: e.target.value };
                onChange(next);
              }}
            />
            <button
              type="button"
              aria-label="删除该行"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-err-text"
              onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function McpSecretFields({
  names,
  drafts,
  hints,
  onChange,
}: {
  names: string[];
  drafts: Record<string, string>;
  hints: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  if (names.length === 0) return null;
  return (
    <div className="space-y-2">
      {names.map((name) => (
        <label key={name} className="block">
          <span className="mb-1 block text-xs text-l3">
            {mcpSecretFieldLabel(name)}
          </span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={`${fieldClass} font-mono`}
            placeholder={mcpSecretPlaceholder(hints[name])}
            value={drafts[name] ?? ""}
            onChange={(e) => onChange({ ...drafts, [name]: e.target.value })}
          />
          {name === "CONSENSUS_API_KEY" && (
            <p className="mt-1 text-micro text-l4">
              在 Consensus 账号复制 API key（ak_ 开头）贴到这里。Mesa
              保存后注入给 Agent，不必自己设环境变量。
            </p>
          )}
        </label>
      ))}
    </div>
  );
}

export default function McpPage({ visible }: { visible: boolean }) {
  const [servers, setServers] = useState<McpServerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<{
    id: string | null;
    form: Form;
    /** 从预设打开时的顶部提示（密钥要求等） */
    note?: string;
    setup?: ResolvedMcpSetup;
    setupChecking?: boolean;
    /** 从「预设 ▾」打开：新建保存时自动分发到能写 MCP 的 Agent */
    fromPreset?: boolean;
    /** 密钥栏草稿：空 = 不改已存值 */
    secretDrafts?: Record<string, string>;
  } | null>(null);
  const [secretHints, setSecretHints] = useState<Record<string, string>>({});
  const [homeDir, setHomeDir] = useState("");
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState<Record<string, boolean>>({});
  const applyingRef = useRef<Set<string>>(new Set());
  function beginApply(key: string): boolean {
    if (applyingRef.current.has(key)) return false;
    applyingRef.current.add(key);
    setApplying((prev) => ({ ...prev, [key]: true }));
    return true;
  }
  function endApply(key: string) {
    applyingRef.current.delete(key);
    setApplying((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }
  const [expanded, setExpanded] = useState<string | null>(null);
  // 分发五态缓存（server id → agent id → off|ok|modified|missing|disabled_externally）：
  // 探测要读各 CLI 的配置文件，不轮询；但缓存在三个时机主动作废——展开条目、
  // 回到本页（外部如 codex 客户端可能已改过配置）、分发写操作后（toggleApp 里删键）
  const [distStatus, setDistStatus] = useState<
    Record<string, Record<string, string>>
  >({});
  useEffect(() => {
    if (!visible || !expanded || distStatus[expanded]) return;
    let stale = false;
    invoke<Record<string, string>>("mcp_distribution_status", { id: expanded })
      .then((m) => {
        if (!stale) setDistStatus((prev) => ({ ...prev, [expanded]: m }));
      })
      .catch(() => {
        if (!stale) toast("MCP 分发状态读取失败，可重新展开重试");
      });
    return () => {
      stale = true;
    };
  }, [expanded, visible, distStatus]);
  // 回到本页时整体作废（展开中的条目会经上面的 effect 自动重读）
  useEffect(() => {
    if (visible) setDistStatus({});
  }, [visible]);
  // 能力表（agent_capabilities）：只读 agent 的分发开关换「只读」+ 原因提示，与后端报错同源
  const [caps, setCaps] = useState<Record<string, AgentCapabilitiesDto>>({});
  useEffect(() => {
    if (!visible) return;
    invoke<AgentCapabilitiesDto[]>("agent_capabilities")
      .then((list) =>
        setCaps(Object.fromEntries(list.map((c) => [c.agent, c]))),
      )
      .catch((reason) =>
        setError(`读取 MCP 分发能力失败：${String(reason)}`),
      );
  }, [visible]);
  // 收编现有配置 / 粘贴导入 / 内置预设（低频，收进顶部 ⋯ 菜单）
  const [topMenu, setTopMenu] = useState<{ x: number; y: number } | null>(null);
  // 页头「预设 ▾」下拉：内置预置一键预填（mcp-presets.ts，加预设 = 加一条）
  const [presetMenu, setPresetMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredMcp[]>([]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  // 粘贴导入两阶段：先解析预览（命令清单可见才允许入库），确认后才写
  const [pastePreview, setPastePreview] = useState<{
    servers: McpServerDto[];
    skipped: string[];
    suspects: string[];
  } | null>(null);
  // 命令路径健康（mcp_command_path_status 只读探测）：server id → ok|relative|missing，
  // 只有 relative/missing 出告警徽标；随 load 刷新
  const [cmdPathStatus, setCmdPathStatus] = useState<Record<string, string>>({});
  // 「修复为绝对路径」多候选弹层：唯一命中走确认弹层，多命中在这里让用户选
  const [fixTarget, setFixTarget] = useState<{
    server: McpServerDto;
    candidates: McpCommandFixCandidate[];
  } | null>(null);
  const [fixing, setFixing] = useState(false);

  const load = useCallback(async () => {
    try {
      setServers(await invoke<McpServerDto[]>("list_mcp_servers"));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
    invoke<McpEnvSecretHintDto[]>("list_mcp_env_secrets")
      .then((list) => {
        const next: Record<string, string> = {};
        for (const item of list) next[item.name] = item.hint;
        setSecretHints(next);
      })
      .catch(() => setSecretHints({}));
    // 命令路径健康探测（只读）：失败必须可见，避免把“检查失败”误认为路径正常
    invoke<Record<string, string>>("mcp_command_path_status")
      .then(setCmdPathStatus)
      .catch((reason) => {
        setCmdPathStatus({});
        setError(`MCP 命令路径检查失败：${String(reason)}`);
      });
  }, []);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);
  useEffect(() => {
    if (!visible || homeDir) return;
    void invoke<string>("home_dir")
      .then(setHomeDir)
      .catch(() => {});
  }, [visible, homeDir]);

  function toast(text: string) {
    setNotice(text);
    setTimeout(() => setNotice(null), 4000);
  }

  async function refreshBlenderProbe() {
    setModal((m) =>
      m?.setup
        ? {
            ...m,
            setupChecking: true,
            setup: applyBlenderMcpProbe(m.setup, null, true),
          }
        : m,
    );
    try {
      const probe = await invoke<BlenderMcpProbe>("probe_blender_mcp_setup");
      setModal((m) =>
        m?.setup?.steps.some((s) => s.id)
          ? {
              ...m,
              setupChecking: false,
              setup: applyBlenderMcpProbe(m.setup, probe),
            }
          : m,
      );
    } catch (e) {
      setModal((m) =>
        m
          ? {
              ...m,
              setupChecking: false,
              setup: m.setup
                ? { ...m.setup, progress: `检测失败：${String(e)}` }
                : m.setup,
            }
          : m,
      );
    }
  }

  async function openPreset(p: McpPreset) {
    let home = homeDir;
    if (!home) {
      try {
        home = await invoke<string>("home_dir");
        setHomeDir(home);
      } catch {
        home = "";
      }
    }
    const applied = applyMcpPreset(p, home, IS_WINDOWS);
    const needsProbe = applied.setup?.steps.some((s) => s.id);
    setModal({
      id: null,
      form: formFromApplied(applied),
      note: applied.setup ? undefined : applied.note,
      setup: needsProbe
        ? applyBlenderMcpProbe(applied.setup!, null, true)
        : applied.setup ?? undefined,
      setupChecking: !!needsProbe,
      fromPreset: true,
    });
    if (needsProbe) void refreshBlenderProbe();
  }

  const pendingMcpPreset = useAppStore((s) => s.pendingMcpPreset);
  const setPendingMcpPreset = useAppStore((s) => s.setPendingMcpPreset);
  useEffect(() => {
    if (!visible || !pendingMcpPreset) return;
    const preset = MCP_PRESETS.find((item) => item.name === pendingMcpPreset);
    setPendingMcpPreset(null);
    if (preset) void openPreset(preset);
  }, [visible, pendingMcpPreset, setPendingMcpPreset]);

  // $VAR 引用分发预检（只读 command，非阻断警告）：同一组缺失变量同一会话只提示一次，
  // 只在用户确认后记签名——拒绝=动作没发生，下次照旧问
  const envWarnedRef = useRef<Set<string>>(new Set());
  async function confirmMissingEnv(
    pairs: McpEnvPair[],
    action: "保存" | "分发",
    pendingSecrets?: Record<string, string>,
  ): Promise<boolean> {
    const missing = await invoke<string[]>("mcp_missing_env_refs", {
      pairs,
      pendingSecrets: pendingSecrets ?? {},
    }).catch(
      () => [] as string[], // 预检失败不阻断主动作（宁可少提示）
    );
    if (missing.length === 0) return true;
    const sig = missingEnvSignature(missing);
    if (envWarnedRef.current.has(sig)) return true;
    const ok = await confirmDialog(missingEnvWarnText(missing, action));
    if (ok) envWarnedRef.current.add(sig);
    return ok;
  }

  async function save() {
    if (!modal) return;
    setSaving(true);
    setError(null);
    const f = modal.form;
    try {
      const timeoutSecs = parseFloat(f.timeoutText.trim());
      const server: McpServerDto = {
        id: modal.id ?? "",
        name: f.name.trim(),
        kind: f.kind,
        command: f.command.trim(),
        args: f.argsText.split(/\s+/).filter(Boolean),
        cwd: f.cwd.trim(),
        env: f.env.filter((p) => p.key.trim()),
        url: f.url.trim(),
        headers: f.headers.filter((p) => p.key.trim()),
        apps: {},
        // 新建默认启用；编辑时后端会以开关命令为准覆盖此值（编辑不夹带）
        enabled: true,
        // 来源标记同理：新建后端强制写 "ccode"，编辑保留库中旧值，前端传值一律被忽略
        origin: "",
        // 启动超时（秒→毫秒）：空/非法值 = 不声明，体检维持 8s 上限
        startupTimeoutMs:
          f.kind === "stdio" && Number.isFinite(timeoutSecs) && timeoutSecs > 0
            ? Math.round(timeoutSecs * 1000)
            : null,
      };
      const envSecrets: Record<string, string> = {};
      for (const [name, value] of Object.entries(modal.secretDrafts ?? {})) {
        const trimmed = value.trim();
        if (trimmed) envSecrets[name] = trimmed;
      }
      // $VAR 引用预检：保存前先问（分发后 MCP 可能起不来），非阻断
      if (
        !(await confirmMissingEnv(
          [...server.env, ...server.headers],
          "保存",
          envSecrets,
        ))
      ) {
        setSaving(false);
        return;
      }
      let list = await invoke<McpServerDto[]>("save_mcp_server", {
        server,
        // 参数已废弃（后端对明文密钥一律拒绝，不再确认放行），保留仅为兼容命令签名
        allowPlaintext: false,
        envSecrets,
      });
      const isNewPreset = !modal.id && modal.fromPreset;
      const saved = list.find((s) => s.name === server.name);
      if (isNewPreset && saved) {
        const targets = writableMcpAgentIds(
          AGENTS.map((a) => a.id),
          caps,
        );
        const failedIds: string[] = [];
        for (const agent of targets) {
          try {
            list = await invoke<McpServerDto[]>("set_mcp_server_app", {
              id: saved.id,
              agent,
              enabled: true,
              force: false,
            });
          } catch {
            failedIds.push(agent);
          }
        }
        setDistStatus((prev) => {
          const next = { ...prev };
          delete next[saved.id];
          return next;
        });
        const nameOf = (id: string) =>
          AGENTS.find((a) => a.id === id)?.label ?? id;
        toast(
          targets.length === 0
            ? "已保存。到列表里打开要用的 Agent 开关。"
            : failedIds.length === 0
              ? `已添加并启用到 ${targets.map(nameOf).join("、")}。新开的对话即可用。`
              : `已添加；未写入：${failedIds.map(nameOf).join("、")}。其余已启用。`,
        );
      } else {
        toast("已保存");
      }
      setServers(list);
      setModal(null);
      invoke<McpEnvSecretHintDto[]>("list_mcp_env_secrets")
        .then((items) => {
          const next: Record<string, string> = {};
          for (const item of items) next[item.name] = item.hint;
          setSecretHints(next);
        })
        .catch(() => {});
    } catch (e) {
      // 明文密钥已由后端一律拒绝（报文里含改引用引导），直接展示
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // 连通性检测结果缓存（server id → 结果 | 检测中）：仅手动触发（行内 ↯ / 状态点点按），
  // 不进页面自动全量跑——拉起 N 个 stdio 进程的代价不该由打开页面承担
  const [health, setHealth] = useState<Record<string, McpHealthDto | "checking">>(
    {},
  );

  /** 现场连通性检测：stdio = 拉起进程握手 initialize；remote = POST 探活（8s 上限） */
  async function checkHealth(s: McpServerDto) {
    setHealth((prev) => ({ ...prev, [s.id]: "checking" }));
    try {
      const h = await invoke<McpHealthDto>("check_mcp_server", { id: s.id });
      setHealth((prev) => ({ ...prev, [s.id]: h }));
    } catch (e) {
      setHealth((prev) => ({
        ...prev,
        [s.id]: {
          ok: false,
          latencyMs: 0,
          error: String(e),
          detail: null,
          status: "error",
        },
      }));
    }
  }

  // 批量检测（页头「全部检测」）：后端分波并发（每波 4 个）跑完所有启用的 server 后
  // 一次性回填——不做渐进式事件，实现简单且一次「全部检测」本来就要等到最后一条才敢报喜
  const [checkingAll, setCheckingAll] = useState(false);
  async function checkAllHealth() {
    if (checkingAll) return;
    setCheckingAll(true);
    setError(null);
    try {
      const results =
        await invoke<Record<string, McpHealthDto>>("check_all_mcp_servers");
      setHealth((prev) => ({ ...prev, ...results }));
      const total = Object.keys(results).length;
      const okCount = Object.values(results).filter((h) => h.ok).length;
      // 后端已把结果沉淀进清单 last_check，重读让行内状态与落盘一致
      await load();
      toast(
        total === 0
          ? "没有已启用的 MCP 需要检测"
          : `全部检测完成：${okCount}/${total} 正常`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setCheckingAll(false);
    }
  }

  /** 全局启用/停用：停用从各 agent 移除条目但保留分发映射（重开按原样重投） */
  async function setEnabled(s: McpServerDto, enabled: boolean) {
    const key = `${s.id}:__global__`;
    if (!beginApply(key)) return;
    setError(null);
    try {
      setServers(
        await invoke<McpServerDto[]>("set_mcp_server_enabled", {
          id: s.id,
          enabled,
          force: false,
        }),
      );
      setDistStatus((prev) => {
        const next = { ...prev };
        delete next[s.id];
        return next;
      });
      toast(
        enabled
          ? `已启用「${s.name}」并按映射重新分发`
          : `已停用「${s.name}」（分发映射保留，重新启用时恢复）`,
      );
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith("EXTMOD:")) {
        const agents = msg.slice("EXTMOD:".length);
        if (
          await confirmDialog(
            `「${s.name}」在这些 agent 的配置里已被外部修改：${agents}。停用会移除这些条目。仍要停用吗？`,
            { danger: true },
          )
        ) {
          try {
            setServers(
              await invoke<McpServerDto[]>("set_mcp_server_enabled", {
                id: s.id,
                enabled,
                force: true,
              }),
            );
            setDistStatus((prev) => {
              const next = { ...prev };
              delete next[s.id];
              return next;
            });
            toast(
              enabled
                ? `已启用「${s.name}」并按映射重新分发`
                : `已停用「${s.name}」（分发映射保留，重新启用时恢复）`,
            );
          } catch (retry) {
            setError(String(retry));
          }
        }
      } else {
        setError(msg);
      }
    } finally {
      endApply(key);
    }
  }

  async function toggleApp(
    server: McpServerDto,
    agent: string,
    on: boolean,
    force = false,
  ) {
    const key = `${server.id}:${agent}`;
    if (applyingRef.current.has(key)) return;
    // $VAR 引用预检：拨开前先问（GUI 应用读不到 shell rc 的变量，分发后可能起不来），非阻断
    if (
      on &&
      !(await confirmMissingEnv([...server.env, ...server.headers], "分发"))
    )
      return;
    // 条目已被外部从该 agent 配置删除：拨开 = 重新写入，先点明再执行
    if (on && !force && distStatus[server.id]?.[agent] === "missing") {
      const label = AGENTS.find((a) => a.id === agent)?.label ?? agent;
      if (
        !(await confirmDialog(
          `「${server.name}」在 ${label} 的配置里已不存在（外部已删除）。拨开会将该条目重新写入 ${label} 的配置。仍要打开吗？`,
        ))
      )
        return;
    }
    // 收编条目（含旧数据空 origin，isAdoptedMcp 判定）关闭分发 = 从该 agent 配置移除条目，
    // 先确认影响面；ccode 自建条目不加——开关语义本身就符合预期
    if (!on && !force && isAdoptedMcp(server.origin)) {
      const label = AGENTS.find((a) => a.id === agent)?.label ?? agent;
      if (
        !(await confirmDialog(
          `关闭将把「${server.name}」从 ${label} 的配置中移除（清单里仍保留该条目）。仍要关闭吗？`,
          { danger: true },
        ))
      )
        return;
    }
    if (!beginApply(key)) return;
    setError(null);
    try {
      setServers(
        await invoke<McpServerDto[]>("set_mcp_server_app", {
          id: server.id,
          agent,
          enabled: on,
          force,
        }),
      );
      // 分发状态缓存失效：刚写过，三态点必须按新结果重算
      setDistStatus((prev) => {
        const next = { ...prev };
        delete next[server.id];
        return next;
      });
      toast(
        on
          ? `已分发到 ${AGENTS.find((a) => a.id === agent)?.label}`
          : `已从 ${AGENTS.find((a) => a.id === agent)?.label} 移除`,
      );
    } catch (e) {
      const msg = String(e);
      // 该 agent 里的条目被外部改过：确认后才强删（保护手调版本）
      if (msg.startsWith("EXTMOD:") && !force) {
        const label = AGENTS.find((a) => a.id === agent)?.label ?? agent;
        if (
          await confirmDialog(
            `「${server.name}」在 ${label} 的配置里已被外部修改，移除会丢掉外部改动的版本。仍要移除吗？`,
            { danger: true },
          )
        ) {
          try {
            setServers(
              await invoke<McpServerDto[]>("set_mcp_server_app", {
                id: server.id,
                agent,
                enabled: on,
                force: true,
              }),
            );
            setDistStatus((prev) => {
              const next = { ...prev };
              delete next[server.id];
              return next;
            });
            toast(
              on
                ? `已分发到 ${AGENTS.find((a) => a.id === agent)?.label}`
                : `已从 ${AGENTS.find((a) => a.id === agent)?.label} 移除`,
            );
          } catch (retry) {
            setError(String(retry));
          }
        }
      } else {
        setError(msg);
      }
    } finally {
      endApply(key);
    }
  }

  // 删除确认：收编条目（含旧数据空 origin，isAdoptedMcp 判定）走双选弹层——
  // 主选「仅从清单移除」不动 agent 侧原有配置；ccode 自建条目维持单确认流。
  // 两条路径的确认弹层都明示影响面（apps 为 true 的 agent 显示名列表）
  const [deleteTarget, setDeleteTarget] = useState<McpServerDto | null>(null);

  async function onDelete(server: McpServerDto) {
    if (isAdoptedMcp(server.origin)) {
      setDeleteTarget(server);
      return;
    }
    const impact = mcpDeleteImpact(server.apps, AGENTS);
    if (
      !(await confirmDialog(
        impact.length
          ? `将删除 MCP「${server.name}」，并从以下 agent 的配置中删除：${impact.join("、")}。继续？`
          : `将删除 MCP「${server.name}」。继续？`,
        { danger: true },
      ))
    )
      return;
    await doDelete(server, false, false);
  }

  /** 执行删除：keepAgentConfigs=true 只从清单移除，不碰任何 agent 配置文件 */
  async function doDelete(
    server: McpServerDto,
    keepAgentConfigs: boolean,
    force: boolean,
  ) {
    try {
      setServers(
        await invoke<McpServerDto[]>("delete_mcp_server", {
          id: server.id,
          force,
          keepAgentConfigs,
        }),
      );
      setDeleteTarget(null);
      toast(
        keepAgentConfigs
          ? "已从清单移除（各 agent 配置中的该条目保留）"
          : "已删除",
      );
    } catch (e) {
      const msg = String(e);
      // keepAgentConfigs=true 后端跳过 EXTMOD 预检，这里只有连同删除路径会命中
      if (msg.startsWith("EXTMOD:") && !force) {
        const agents = msg.slice("EXTMOD:".length);
        if (
          await confirmDialog(
            `「${server.name}」在这些 agent 的配置里已被外部修改：${agents}。删除会丢掉外部改动的版本。仍要删除吗？`,
            { danger: true },
          )
        ) {
          return doDelete(server, keepAgentConfigs, true);
        }
      } else {
        setError(msg);
      }
    }
  }

  // 收编：扫描八家用户级配置里不在清单中的 server
  async function onDiscover() {
    setError(null);
    try {
      setDiscovered(await invoke<DiscoveredMcp[]>("discover_mcp_servers"));
      setDiscoverOpen(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onAdopt(item: DiscoveredMcp) {
    setError(null);
    try {
      const outcome = await invoke<{
        servers: McpServerDto[];
        resolved: number;
        unresolved: number;
      }>("import_mcp_from_agent", {
        agent: item.agent,
        name: item.name,
      });
      setServers(outcome.servers);
      setDiscovered((prev) =>
        prev.filter((d) => !(d.agent === item.agent && d.name === item.name)),
      );
      // 相对路径命令的收编解析结果（后端 resolver）：随 toast 附注一句
      const note = mcpPathResolveNote(outcome.resolved, outcome.unresolved);
      toast(
        `已收编「${item.name}」（标记为已分发到来源 agent）${note ? `；${note}` : ""}`,
      );
      await load(); // 重读命令路径探测，徽标立即反映收编结果
    } catch (e) {
      setError(String(e));
    }
  }

  async function onPasteParse() {
    setSaving(true);
    setError(null);
    try {
      const [servers, skipped, suspects] = await invoke<
        [McpServerDto[], string[], string[]]
      >("parse_mcp_json", { text: pasteText });
      setPastePreview({ servers, skipped, suspects });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onPasteConfirm() {
    if (!pastePreview) return;
    // 明文密钥不再支持确认放行（后端一律拒收）：预览阶段直接提示改引用
    if (pastePreview.suspects.length > 0) {
      setError(
        `检测到疑似明文密钥：${pastePreview.suspects.join("、")}。为防密钥落盘泄露，只接受 $VAR / \${VAR} 环境变量引用形式，请改用引用后重试`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const [added, skipped, resolved, unresolved] = await invoke<
        [string[], string[], number, number]
      >("import_mcp_json", {
        text: pasteText,
        // 参数已废弃（后端对明文密钥一律拒绝），保留仅为兼容命令签名
        allowPlaintext: false,
      });
      setPasteOpen(false);
      setPasteText("");
      setPastePreview(null);
      await load();
      // 相对路径命令的解析结果附注（粘贴无来源 agent，只按条目自己的 cwd 解）
      const note = mcpPathResolveNote(resolved, unresolved);
      toast(
        `已导入 ${added.length} 个${skipped.length ? `，跳过同名 ${skipped.length} 个（${skipped.join("、")}）` : ""}${note ? `；${note}` : ""}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // 「修复为绝对路径」（仅 relative 态）：后端 resolver（与收编同一套）出候选——
  // 唯一命中确认弹层、多命中弹层选、无命中提示手工编辑
  async function onFixCommand(s: McpServerDto) {
    setError(null);
    try {
      const candidates = await invoke<McpCommandFixCandidate[]>(
        "resolve_mcp_command_fix",
        { id: s.id },
      );
      if (candidates.length === 0) {
        setError(
          `「${s.name}」的相对路径未能解析（已试条目的工作目录与来源 agent 的配置/插件目录），请点 ✎ 编辑手工改为绝对路径`,
        );
        return;
      }
      if (candidates.length === 1) {
        const c = candidates[0];
        const ok = await confirmDialog(
          `已将「${s.name}」的相对路径解析为：\n命令：${c.command}${c.cwd ? `\n工作目录：${c.cwd}` : ""}\n确认后按此更新条目，并同步重写到已分发的 agent。`,
        );
        if (ok) await applyCommandFix(s, c);
        return;
      }
      setFixTarget({ server: s, candidates });
    } catch (e) {
      setError(String(e));
    }
  }

  /** 应用修复：走现有保存链路（origin/apps/last_check 由后端保留），保存即重投已分发 agent */
  async function applyCommandFix(s: McpServerDto, fix: McpCommandFixCandidate) {
    setFixing(true);
    setError(null);
    try {
      setServers(
        await invoke<McpServerDto[]>("save_mcp_server", {
          server: { ...s, command: fix.command, cwd: fix.cwd },
          allowPlaintext: false, // 已废弃参数，见 save()
        }),
      );
      setFixTarget(null);
      await load();
      toast(`「${s.name}」的命令已修复为绝对路径`);
    } catch (e) {
      // 明文密钥已由后端一律拒绝（报文里含改引用引导），直接展示
      setError(String(e));
    } finally {
      setFixing(false);
    }
  }
  // 与连接/技能同属资源页：外壳随主区变宽。五列网格把多出来的宽度分给名称和配置，
  // 启用开关留在末列，不再出现「名称在左、开关在窗口最右」的空档。
  return (
    <PageFrame width="wide">
      <PageHeader
        title="MCP"
        meta={`${servers.length} 个`}
        actions={
          <>
            <button
              className={primaryActionClass}
              onClick={() => setModal({ id: null, form: { ...EMPTY_FORM } })}
            >
              + 添加 MCP
            </button>
            <button
              type="button"
              title="对清单里所有已启用的 MCP 逐条检测连通性（分波并发，每波最多 4 个）"
              className={secondaryActionClass}
              disabled={checkingAll || servers.length === 0}
              onClick={() => void checkAllHealth()}
            >
              {checkingAll && (
                <span className="mr-1 inline-block animate-spin">◌</span>
              )}
              {checkingAll ? "检测中…" : "全部检测"}
            </button>
            <button
              type="button"
              title="从内置预置一键添加（如 Consensus 学术搜索）"
              className={secondaryActionClass}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setPresetMenu({ x: rect.right, y: rect.bottom + 4 });
              }}
            >
              预设 ▾
            </button>
            <button
              type="button"
              title="更多（收编现有配置 / 粘贴导入）"
              aria-label="更多"
              className="flex h-8 w-8 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setTopMenu({ x: rect.right, y: rect.bottom + 4 });
              }}
            >
              ⋯
            </button>
          </>
        }
      />
      {error && <p role="alert" className="text-sm text-err-text">{error}</p>}
      {notice && <p role="status" className="text-sm text-ok-text">{notice}</p>}
      {loading ? (
        <p className="py-8 text-center text-sm text-l4">加载中…</p>
      ) : servers.length === 0 ? (
        <EmptyState
          title="还没有 MCP"
          detail="这里会显示可供 Agent 使用的工具服务；点右上「+ 添加 MCP」创建。"
          action={
            <button
              type="button"
              className={primaryActionClass}
              onClick={() => setModal({ id: null, form: { ...EMPTY_FORM } })}
            >
              添加 MCP
            </button>
          }
        />
      ) : (
        // 整表收进单张卡片容器（field 细边 + strip 底）+ 轻量表头：数据再少也有闭合边界，
        // 行间 hairline 分割；表头与数据行共用 MCP_GRID 保证列严格对齐
        <div className="mt-1 overflow-hidden rounded-md border border-field ccode-well">
          <div
            className={`grid ${MCP_GRID} items-center gap-3 border-b border-hairline px-3 py-2 text-micro tracking-wider text-l4`}
          >
            <span>名称</span>
            <span>类型</span>
            <span>配置</span>
            <span>用于</span>
            <span className="text-right">启用</span>
          </div>
          <ul className="divide-y divide-hairline">
          {servers.map((s) => {
            const onCount = Object.values(s.apps).filter(Boolean).length;
            const open = expanded === s.id;
            return (
              <li
                key={s.id}
                className="group transition-colors hover:bg-hover/60"
              >
                <div className={`grid ${MCP_GRID} items-center gap-3 px-3 py-2`}>
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2 text-left"
                    title={open ? "收起" : "展开完整配置与分发管理"}
                    onClick={() => {
                      // 展开前作废该条目的五态缓存，保证看到的是磁盘最新事实
                      if (!open)
                        setDistStatus((prev) => {
                          const next = { ...prev };
                          delete next[s.id];
                          return next;
                        });
                      setExpanded(open ? null : s.id);
                    }}
                  >
                    <FoldMark open={open} />
                    {/* 实时结果优先；没测过实时就回落清单里沉淀的上次结果（带时间前缀） */}
                    <HealthDot
                      health={
                        health[s.id] ??
                        (s.lastCheck
                          ? {
                              ok: s.lastCheck.ok,
                              latencyMs: s.lastCheck.latencyMs,
                              error: s.lastCheck.error,
                              detail: null,
                            }
                          : undefined)
                      }
                      at={health[s.id] ? null : (s.lastCheck?.at ?? null)}
                      onCheck={() => void checkHealth(s)}
                    />
                    <span
                      className={`truncate text-sm ${s.enabled ? "text-l1" : "text-l4"}`}
                    >
                      {s.name}
                    </span>
                    {!s.enabled && (
                      <span className="shrink-0 rounded-sm bg-inset px-1.5 py-0.5 text-micro text-l4">
                        已停用
                      </span>
                    )}
                  </button>
                  {/* 协议徽章固定识别色（stdio 紫 / remote 蓝，mcp-display.ts） */}
                  <span>
                    <span
                      className="inline-block rounded-sm px-1.5 py-0.5 font-mono text-micro"
                      style={mcpKindBadgeStyle(s.kind)}
                    >
                      {s.kind}
                    </span>
                  </span>
                  {/* 命令智能缩略（~/…/尾段），完整命令悬浮给全文、展开面板也给全文；
                      相对路径/路径不存在时在命令前压告警徽标（mcp_command_path_status） */}
                  <span className="flex min-w-0 items-center gap-1.5">
                    {(() => {
                      const badge = mcpCmdPathBadge(cmdPathStatus[s.id]);
                      return badge ? (
                        <span
                          className="shrink-0 rounded-sm px-1 py-px text-micro"
                          style={{
                            color: badge.color,
                            background: badge.background,
                          }}
                          title={badge.tip}
                        >
                          {badge.label}
                        </span>
                      ) : null;
                    })()}
                    <span
                      className="min-w-0 truncate font-mono text-xs text-l4"
                      title={
                        s.kind === "stdio"
                          ? `${s.command} ${s.args.join(" ")}`.trim()
                          : s.url
                      }
                    >
                      {s.kind === "stdio"
                        ? shortenCommand(s.command, s.args)
                        : s.url}
                    </span>
                  </span>
                  {/* 用于列可点：点击展开/收起分发网格（勾选在展开区） */}
                  <button
                    type="button"
                    onClick={() => {
                      // 展开前作废该条目的五态缓存，保证看到的是磁盘最新事实
                      if (!open)
                        setDistStatus((prev) => {
                          const next = { ...prev };
                          delete next[s.id];
                          return next;
                        });
                      setExpanded(open ? null : s.id);
                    }}
                    title="展开分发管理"
                    className={`flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs hover:bg-hover ${
                      onCount > 0 ? "text-l3" : "text-l4"
                    }`}
                  >
                    {onCount > 0 && (
                      <span className="size-1.5 rounded-full bg-ok-text" />
                    )}
                    {onCount > 0 ? `${onCount} 个 CLI` : "未用"}
                  </button>
                  <span className="flex items-center justify-end gap-1">
                    {/* 行内悬浮操作（v3.93）：↯ 测试连通 / ✎ 编辑 / ✕ 删除。
                        裸图标钮 hover 淡入，不套胶囊容器——实体栏压在列表行上层级脱节 */}
                    <span
                      className={`flex items-center ${hoverRevealClass} focus-within:opacity-100`}
                    >
                      <RowAction
                        icon="↯"
                        tip="测试连通性（stdio 拉起握手 / remote 探活）"
                        label={`测试 ${s.name} 连通性`}
                        onClick={() => void checkHealth(s)}
                      />
                      <RowAction
                        icon="✎"
                        tip="编辑"
                        label={`编辑 ${s.name}`}
                        onClick={() => setModal({ id: s.id, form: formFrom(s) })}
                      />
                      <RowAction
                        icon="✕"
                        tip="删除（收编条目默认仅从清单移除，不动 agent 配置）"
                        label={`删除 ${s.name}`}
                        onClick={() => void onDelete(s)}
                      />
                    </span>
                    {/* 全局启用开关：停用不删配置，分发映射保留 */}
                    <span
                      title={
                        s.enabled
                          ? "停用：从各 agent 移除条目，分发映射保留"
                          : "启用：按分发映射重新写入各 agent"
                      }
                    >
                      <Toggle
                        label={`${s.name} 启用开关`}
                        checked={s.enabled}
                        onChange={(v) =>
                          !applying[`${s.id}:__global__`] &&
                          void setEnabled(s, v)
                        }
                      />
                    </span>
                  </span>
                </div>
                {open && (
                  // 展开面板：浅底 + 细边 + 圆角的深层区，给嵌套内容（完整配置/变量/分发网格）
                  // 一个明确的空间落点，不再直接摊在行下方
                  <div className="px-3 pb-3">
                    <div className="rounded-md border border-hairline ccode-well p-2.5">
                      <div className="break-all font-mono text-xs leading-5 text-l3">
                        {s.kind === "stdio"
                          ? `${s.command} ${s.args.join(" ")}`.trim()
                          : s.url}
                      </div>
                      {/* 命令路径告警的展开区处理：relative 给一键修复（后端 resolver 出候选），
                          missing 只告警指路编辑（路径失效没有可自动解析的基准） */}
                      {cmdPathStatus[s.id] === "relative" && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <span className="text-micro text-warn-text">
                            相对路径命令：换个工作目录启动就找不到
                          </span>
                          <button
                            type="button"
                            className={secondaryActionClass}
                            disabled={fixing}
                            onClick={() => void onFixCommand(s)}
                          >
                            {fixing ? "解析中…" : "修复为绝对路径"}
                          </button>
                        </div>
                      )}
                      {cmdPathStatus[s.id] === "missing" && (
                        <p className="mt-1.5 text-micro text-err-text">
                          命令路径在磁盘上不存在（应用卸载或版本升级后路径失效），请点
                          ✎ 编辑修正
                        </p>
                      )}
                      {s.env.length > 0 && (
                        <div
                          className="mt-1 truncate font-mono text-micro text-l4"
                          title={s.env
                            .map((p) => `${p.key}=${p.value}`)
                            .join("\n")}
                        >
                          环境变量：{s.env.map((p) => `${p.key}=${p.value}`).join("  ")}
                        </div>
                      )}
                      {s.headers.length > 0 && (
                        <div
                          className="mt-1 truncate font-mono text-micro text-l4"
                          title={s.headers
                            .map((p) => `${p.key}=${p.value}`)
                            .join("\n")}
                        >
                          请求头：{s.headers.map((p) => `${p.key}=${p.value}`).join("  ")}
                        </div>
                      )}
                      {mcpEnvRefNames([...s.env, ...s.headers]).map((name) =>
                        secretHints[name] ? (
                          <div key={name} className="mt-1 text-micro text-l3">
                            {mcpSecretFieldLabel(name)}已填 {secretHints[name]}
                          </div>
                        ) : (
                          <div key={name} className="mt-1 text-micro text-warn-text">
                            {mcpSecretFieldLabel(name)}未填
                          </div>
                        ),
                      )}
                      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                        {AGENTS.map((agent) => {
                          const on = !!s.apps[agent.id];
                          const key = `${s.id}:${agent.id}`;
                          return (
                            <div
                              key={agent.id}
                              className="flex items-center justify-between gap-2 rounded-sm ccode-well px-2 py-1.5"
                            >
                              <span className="flex min-w-0 items-center gap-1 text-xs text-l3">
                                {/* 分发状态徽标（v3.88 三态点扩为五态）：开关表达清单分发意图
                                    （apps 映射），点/徽标表达磁盘事实（mcp_distribution_status
                                    只读探测）。全局停用时条目是 Mesa 自己移除的，
                                    不标「外部已删除」误导 */}
                                {on &&
                                  s.enabled &&
                                  (() => {
                                    const state = distStatus[s.id]?.[agent.id];
                                    const badge = mcpDistBadge(state);
                                    return (
                                      <>
                                        <span
                                          className={`size-1.5 shrink-0 rounded-full ${
                                            state === "modified"
                                              ? "bg-warn-text"
                                              : state === "missing"
                                                ? "bg-err-text"
                                                : state === "disabled_externally"
                                                  ? "bg-l4"
                                                  : "bg-ok-text"
                                          }`}
                                          title={
                                            badge?.tip ??
                                            "已写入该 agent 的用户级配置"
                                          }
                                        />
                                        {/* modified 沿用原三态点提示；missing/disabled 是
                                            新增异常态，补文字徽标避免只靠颜色传达 */}
                                        {badge && state !== "modified" && (
                                          <span
                                            className="shrink-0 rounded-sm px-1 py-px text-micro"
                                            style={{
                                              color: badge.color,
                                              background: badge.background,
                                            }}
                                            title={badge.tip}
                                          >
                                            {badge.label}
                                          </span>
                                        )}
                                      </>
                                    );
                                  })()}
                                <span className="truncate">{agent.label}</span>
                              </span>
                              {caps[agent.id] && !caps[agent.id].mcpWrite.supported ? (
                                <span
                                  className="text-xs text-l4"
                                  title={
                                    caps[agent.id].mcpWrite.reason ??
                                    "该 CLI 的 MCP 配置只读，暂不支持分发"
                                  }
                                >
                                  只读
                                </span>
                              ) : (
                                <Toggle
                                  label={agent.label}
                                  checked={on}
                                  onChange={(v) =>
                                    !applying[key] && void toggleApp(s, agent.id, v)
                                  }
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
          </ul>
        </div>
      )}

      {modal && (
        <Modal
          open
          title={modal.id ? "编辑 MCP" : "添加 MCP"}
          onClose={() => setModal(null)}
          size={modal.setup ? "lg" : "md"}
        >
            {modal.setup && (
              <div className="-mt-2 mb-3 space-y-2">
                <p className="text-xs leading-5 text-l4">{modal.setup.intro}</p>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-xs leading-5 text-l3">
                    {modal.setup.progress ??
                      (modal.setupChecking ? "正在检测本机…" : null)}
                  </p>
                  {modal.setup.steps.some((s) => s.id) && (
                    <button
                      type="button"
                      className="shrink-0 text-micro text-l4 hover:text-l1"
                      disabled={modal.setupChecking}
                      onClick={() => void refreshBlenderProbe()}
                    >
                      {modal.setupChecking ? "检测中…" : "重新检测"}
                    </button>
                  )}
                </div>
                <ol className="space-y-1.5">
                  {modal.setup.steps.map((s, i) => {
                    const done = s.status === "done";
                    const warn = s.status === "warn";
                    return (
                    <li key={i} className="flex gap-2 text-xs leading-5 text-l3">
                      <span
                        className={`w-4 shrink-0 ${
                          done ? "text-ok-text" : "text-l4"
                        }`}
                      >
                        {done ? "✓" : `${i + 1}.`}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div
                          className={
                            done ? "text-l4" : warn ? "text-warn-text" : undefined
                          }
                        >
                          {s.label}
                          {!done && s.href && (
                            <button
                              type="button"
                              className="ml-1.5 text-cta hover:underline"
                              onClick={() => void openUrl(s.href!)}
                            >
                              打开
                            </button>
                          )}
                        </div>
                        {s.detail && (
                          <div className="mt-0.5 break-all font-mono text-micro text-l4">
                            {s.detail}
                          </div>
                        )}
                        {!done && s.command && (
                          <div className="mt-0.5 flex items-start gap-1.5">
                            <code className="min-w-0 flex-1 break-all font-mono text-micro text-l2">
                              {s.command}
                            </code>
                            <button
                              type="button"
                              className="shrink-0 text-micro text-l4 hover:text-l1"
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(s.command!)
                                  .then(
                                    () => toast("已复制"),
                                    () => toast("复制失败"),
                                  )
                              }
                            >
                              复制
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                    );
                  })}
                </ol>
                <p className="text-xs leading-5 text-l4">{modal.setup.after}</p>
              </div>
            )}
            {modal.note && (
              <p className="-mt-2 mb-3 text-xs leading-5 text-l4">
                {modal.note}
              </p>
            )}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  className={`${fieldClass} min-w-0 flex-1`}
                  placeholder="名称（字母/数字/连字符，如 fs-tools）"
                  value={modal.form.name}
                  onChange={(e) =>
                    setModal({
                      ...modal,
                      form: { ...modal.form, name: e.target.value },
                    })
                  }
                />
                <div className="flex shrink-0 gap-0.5 rounded-sm border border-field p-0.5">
                  {(["stdio", "remote"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={`h-7 rounded-sm px-3 text-xs ${
                        modal.form.kind === k
                          ? "bg-seg-sel text-l1"
                          : "text-l3 hover:text-l1"
                      }`}
                      onClick={() =>
                        setModal({
                          ...modal,
                          form: { ...modal.form, kind: k },
                        })
                      }
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </div>
              {modal.form.kind === "stdio" ? (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      className={`${fieldClass} basis-40 shrink-0 grow-0`}
                      placeholder="命令，如 npx"
                      value={modal.form.command}
                      onChange={(e) =>
                        setModal({
                          ...modal,
                          form: { ...modal.form, command: e.target.value },
                        })
                      }
                    />
                    <input
                      className={`${fieldClass} min-w-0 flex-1 font-mono`}
                      placeholder="参数（空格分隔）"
                      value={modal.form.argsText}
                      onChange={(e) =>
                        setModal({
                          ...modal,
                          form: { ...modal.form, argsText: e.target.value },
                        })
                      }
                    />
                  </div>
                  <input
                    className={fieldClass}
                    placeholder="工作目录（可空；claude/codebuddy/cursor 不写此字段）"
                    value={modal.form.cwd}
                    onChange={(e) =>
                      setModal({
                        ...modal,
                        form: { ...modal.form, cwd: e.target.value },
                      })
                    }
                  />
                  <div>
                    <input
                      className={fieldClass}
                      placeholder="启动超时（秒，可空）"
                      title="体检等待该 server 启动的上限：默认 8 秒，填了按 8–30 秒生效"
                      value={modal.form.timeoutText}
                      onChange={(e) =>
                        setModal({
                          ...modal,
                          form: { ...modal.form, timeoutText: e.target.value },
                        })
                      }
                    />
                    <p className="mt-1 text-micro text-l4">
                      慢启动的 server 才需要填（8–30
                      生效）；收编 Codex/Grok 配置时会自动带入其
                      startup_timeout_sec
                    </p>
                  </div>
                  <PairEditor
                    label="环境变量"
                    pairs={modal.form.env}
                    onChange={(env) =>
                      setModal({ ...modal, form: { ...modal.form, env } })
                    }
                  />
                </>
              ) : (
                <>
                  <input
                    className={`${fieldClass} font-mono`}
                    placeholder="URL，如 https://example.com/mcp"
                    value={modal.form.url}
                    onChange={(e) =>
                      setModal({
                        ...modal,
                        form: { ...modal.form, url: e.target.value },
                      })
                    }
                  />
                  <PairEditor
                    label="请求头"
                    pairs={modal.form.headers}
                    onChange={(headers) =>
                      setModal({ ...modal, form: { ...modal.form, headers } })
                    }
                  />
                </>
              )}
              <McpSecretFields
                names={mcpEnvRefNames([...modal.form.env, ...modal.form.headers])}
                drafts={modal.secretDrafts ?? {}}
                hints={secretHints}
                onChange={(secretDrafts) => setModal({ ...modal, secretDrafts })}
              />
              <div className="flex justify-end gap-2 pt-1">
                <button
                  className={ghostActionClass}
                  onClick={() => setModal(null)}
                >
                  取消
                </button>
                <button
                  className={primaryActionClass}
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving
                    ? "保存中…"
                    : modal.fromPreset && !modal.id
                      ? "添加并启用"
                      : "保存"}
                </button>
              </div>
            </div>
        </Modal>
      )}
      {/* 收编条目删除双选弹层：主选「仅从清单移除」不动 agent 侧原有配置（收编条目本是
          从 agent 配置读进来的，默认动作绝不能反向删用户原有配置）；影响面列表说明
          「连同删除」会碰哪些 agent（apps 全为 false 时不列） */}
      {deleteTarget && (
        <Modal open title={`删除 MCP「${deleteTarget.name}」？`} onClose={() => setDeleteTarget(null)} size="md">
            <p className="text-xs leading-5 text-l4">
              该条目来自{mcpOriginLabel(deleteTarget.origin, AGENTS)}
              ，原本就在 agent 的配置里。
            </p>
            {mcpDeleteImpact(deleteTarget.apps, AGENTS).length > 0 && (
              <p className="mt-1 text-xs leading-5 text-l4">
                选「连同 agent 配置一起删除」将从以下 agent 的配置中删除：
                {mcpDeleteImpact(deleteTarget.apps, AGENTS).join("、")}。
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                className={ghostActionClass}
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                // 危险次按钮：与 ConfirmDialog 危险钮同口径的 bg-err 系
                className="inline-flex h-7 items-center justify-center rounded-md bg-err px-3 text-xs text-err-text transition-[filter] hover:brightness-110"
                onClick={() => void doDelete(deleteTarget, false, false)}
              >
                连同 agent 配置一起删除
              </button>
              <button
                className={primaryActionClass}
                autoFocus
                onClick={() => void doDelete(deleteTarget, true, true)}
              >
                仅从清单移除
              </button>
            </div>
            <p className="mt-1.5 text-right text-micro text-l4">
              仅从清单移除（推荐）：保留各 agent 配置中的该条目
            </p>
        </Modal>
      )}
      {/* 「修复为绝对路径」多候选弹层：同一相对路径在多个基准目录下都命中时交给用户选
          （唯一命中走确认弹层不进这里；确认后走现有保存链路，origin/apps/last_check 保留） */}
      {fixTarget && (
        <Modal open title={`修复「${fixTarget.server.name}」为绝对路径`} onClose={() => setFixTarget(null)} size="md">
            <p className="mb-3 text-xs leading-5 text-l4">
              该相对路径在多个目录下都找到了同名文件，请选择要使用的那个：
            </p>
            <ul className="max-h-72 space-y-1 overflow-auto">
              {fixTarget.candidates.map((c) => (
                <li
                  key={c.command}
                  className="rounded-sm ccode-well px-2 py-1.5"
                >
                  <div className="break-all font-mono text-xs text-l2">
                    {c.command}
                  </div>
                  {c.cwd && (
                    <div className="mt-0.5 break-all font-mono text-micro text-l4">
                      工作目录：{c.cwd}
                    </div>
                  )}
                  <div className="mt-1 flex justify-end">
                    <button
                      className={ghostActionClass}
                      disabled={fixing}
                      onClick={() => void applyCommandFix(fixTarget.server, c)}
                    >
                      {fixing ? "保存中…" : "用这个"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex justify-end">
              <button
                className={ghostActionClass}
                onClick={() => setFixTarget(null)}
              >
                取消
              </button>
            </div>
        </Modal>
      )}
      {/* 顶部 ⋯ 更多菜单（低频入口）：收编现有配置 / 粘贴导入 */}
      {topMenu && (
        <ContextMenu
          x={topMenu.x}
          y={topMenu.y}
          alignRight
          onClose={() => setTopMenu(null)}
          items={[
            {
              label: "收编现有配置",
              onSelect: () => void onDiscover(),
            },
            {
              label: "粘贴导入",
              onSelect: () => setPasteOpen(true),
            },
          ]}
        />
      )}
      {presetMenu && (
        <ContextMenu
          x={presetMenu.x}
          y={presetMenu.y}
          alignRight
          onClose={() => setPresetMenu(null)}
          items={MCP_PRESETS.map((p) => ({
            label: p.label,
            title: p.note,
            onSelect: () => void openPreset(p),
          }))}
        />
      )}
      {/* 收编现有配置：八家用户级配置里不在清单的 server */}
      {discoverOpen && (
        <Modal open title="收编现有配置" onClose={() => setDiscoverOpen(false)} size="md">
            <p className="mb-3 text-xs leading-5 text-l4">
              这些 MCP 在 CLI 里已有、但不在 Mesa 清单中。收编后统一管理。
            </p>
            {discovered.length === 0 ? (
              <p className="py-4 text-center text-sm text-l4">
                没有可收编的 MCP
              </p>
            ) : (
              <ul className="max-h-72 space-y-1 overflow-auto">
                {discovered.map((d) => (
                  <li
                    key={`${d.agent}:${d.name}`}
                    className="flex items-center gap-2 rounded-sm ccode-well px-2 py-1.5"
                  >
                    <span className="shrink-0 rounded-sm bg-strip px-1.5 py-0.5 text-micro text-l4">
                      {AGENTS.find((a) => a.id === d.agent)?.label ?? d.agent}
                    </span>
                    {/* 来源配置里的相对路径命令：收编时后端会尝试解析落绝对路径，先预警 */}
                    {d.relativeCommand &&
                      (() => {
                        const badge = mcpCmdPathBadge("relative");
                        return badge ? (
                          <span
                            className="shrink-0 rounded-sm px-1 py-px text-micro"
                            style={{
                              color: badge.color,
                              background: badge.background,
                            }}
                            title={badge.tip}
                          >
                            {badge.label}
                          </span>
                        ) : null;
                      })()}
                    <span className="min-w-0 flex-1 truncate text-xs text-l1">
                      {d.name}
                      <span className="ml-2 font-mono text-micro text-l4">
                        {d.summary}
                      </span>
                    </span>
                    <button
                      className={ghostActionClass}
                      onClick={() => void onAdopt(d)}
                    >
                      收编
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex justify-end">
              <button
                className={ghostActionClass}
                onClick={() => setDiscoverOpen(false)}
              >
                关闭
              </button>
            </div>
        </Modal>
      )}

      {/* 粘贴导入：README/市场页的标准 mcpServers JSON 片段 */}
      {pasteOpen && (
        <Modal open title="粘贴导入" onClose={() => setPasteOpen(false)} size="md">
            <p className="mb-3 text-xs leading-5 text-l4">
              粘贴 MCP 文档里的标准 JSON 片段（形如{" "}
              <span className="font-mono">{'{"mcpServers": {"名称": {...}}}'}</span>
              ），解析后逐条入库；与清单同名自动跳过。
            </p>
            <textarea
              className={`${fieldClass} h-36 font-mono text-xs`}
              placeholder='{"mcpServers": {"fs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}}}'
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value);
                setPastePreview(null);
              }}
            />
            {pastePreview && (
              <div className="mt-2 rounded-sm ccode-well p-2">
                <p className="mb-1 text-xs text-l3">
                  将导入 {pastePreview.servers.length} 个（stdio
                  命令会被各 agent 直接执行，请确认来源可信）：
                </p>
                <ul className="max-h-36 space-y-0.5 overflow-auto">
                  {pastePreview.servers.map((s) => (
                    <li key={s.id} className="font-mono text-micro text-l2">
                      {s.name}
                      <span className="ml-2 text-l4">
                        {s.kind === "stdio"
                          ? `${s.command} ${s.args.join(" ")}`
                          : s.url}
                      </span>
                    </li>
                  ))}
                </ul>
                {pastePreview.skipped.length > 0 && (
                  <p className="mt-1 text-micro text-l4">
                    同名跳过：{pastePreview.skipped.join("、")}
                  </p>
                )}
                {pastePreview.suspects.length > 0 && (
                  <p className="mt-1 text-micro text-warn-text">
                    疑似明文密钥：{pastePreview.suspects.join("、")}
                    （明文不可导入，请改用 $VAR 引用后再试）
                  </p>
                )}
              </div>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button
                className={ghostActionClass}
                onClick={() => {
                  setPasteOpen(false);
                  setPastePreview(null);
                }}
              >
                取消
              </button>
              {pastePreview ? (
                <button
                  className={primaryActionClass}
                  disabled={saving || pastePreview.servers.length === 0}
                  onClick={() => void onPasteConfirm()}
                >
                  {saving ? "导入中…" : "确认导入"}
                </button>
              ) : (
                <button
                  className={primaryActionClass}
                  disabled={saving || !pasteText.trim()}
                  onClick={() => void onPasteParse()}
                >
                  {saving ? "解析中…" : "解析"}
                </button>
              )}
            </div>
        </Modal>
      )}
    </PageFrame>
  );
}
