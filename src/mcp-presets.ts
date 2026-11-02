import type { McpEnvPair } from "./types";

/** MCP 内置预设：只收官方/权威 server；密钥一律 ${VAR} 引用环境变量，不落明文。
 *  加预设 = 加一条（McpPage 页头「预设 ▾」自动列出，点击预填「添加 server」表单）。
 *  remote：填 url / headers。stdio：填 command / args；路径里的 `{home}` 打开表单时
 *  展开为家目录绝对路径（三平台统一走家目录，不用官方 Windows 示例的 C:\）。
 *  需要本机先装软件的 server 用 setup 列出安装步骤，Mesa 不代装。 */

export type McpSetupStepId =
  | "blender"
  | "addon"
  | "uv"
  | "repo"
  | "running";

export type McpSetupStepStatus = "todo" | "done" | "warn";

export interface McpPresetSetupStep {
  /** 本机探测键；无则不做检测 */
  id?: McpSetupStepId;
  label: string;
  href?: string;
  /** 可复制命令，可含 `{home}` */
  command?: string;
  /** 默认 always */
  when?: "always" | "unix" | "windows";
}

export interface McpPresetSetup {
  intro: string;
  steps: McpPresetSetupStep[];
  after: string;
}

export interface McpPreset {
  /** 「预设 ▾」菜单里的文案，如「Consensus（学术搜索）」 */
  label: string;
  /** 打开表单时顶部提示（密钥要求等）；有 setup 时作菜单悬浮说明 */
  note: string;
  name: string;
  kind: "stdio" | "remote";
  url?: string;
  headers?: McpEnvPair[];
  command?: string;
  args?: string[];
  /** 体检等待上限（毫秒）；慢启动（如首次 uv run）才填 */
  startupTimeoutMs?: number;
  setup?: McpPresetSetup;
}

export interface ResolvedMcpSetupStep {
  id?: McpSetupStepId;
  label: string;
  href?: string;
  command?: string;
  status?: McpSetupStepStatus;
  detail?: string;
}

export interface ResolvedMcpSetup {
  intro: string;
  steps: ResolvedMcpSetupStep[];
  after: string;
  /** 探测摘要，如「已检测到 3/5 项就绪」 */
  progress?: string;
}

export interface AppliedMcpPreset {
  name: string;
  kind: "stdio" | "remote";
  command: string;
  args: string[];
  url: string;
  headers: McpEnvPair[];
  startupTimeoutMs: number | null;
  note: string;
  setup: ResolvedMcpSetup | null;
}

/** 家目录下按 POSIX 段拼接（`blender_mcp/mcp` → 本机分隔符）。 */
export function joinUnderHome(
  homeDir: string,
  relPosix: string,
  isWindows: boolean,
): string {
  const home = homeDir.replace(/[\\/]+$/, "");
  const parts = relPosix.split("/").filter(Boolean);
  const sep = isWindows ? "\\" : "/";
  if (!home) return parts.join(sep);
  return parts.length ? `${home}${sep}${parts.join(sep)}` : home;
}

/** 展开 `{home}` 及紧随其后的路径，不改 URL 里的 `/`。 */
export function expandHomeToken(
  template: string,
  homeDir: string,
  isWindows: boolean,
): string {
  return template.replace(
    /\{home\}((?:[\\/][^\s"]*)?)/g,
    (_m, rest: string) =>
      joinUnderHome(
        homeDir,
        (rest ?? "").replace(/^[\\/]+/, "").replace(/\\/g, "/"),
        isWindows,
      ),
  );
}

function stepApplies(
  when: McpPresetSetupStep["when"],
  isWindows: boolean,
): boolean {
  if (!when || when === "always") return true;
  return when === "windows" ? isWindows : !isWindows;
}

export interface BlenderMcpProbeItem {
  status: "ok" | "missing" | "too_old" | "unknown";
  detail?: string | null;
}

export interface BlenderMcpProbe {
  blender: BlenderMcpProbeItem;
  addon: BlenderMcpProbeItem;
  uv: BlenderMcpProbeItem;
  repo: BlenderMcpProbeItem;
  running: BlenderMcpProbeItem;
}

function probeToStep(
  item: BlenderMcpProbeItem | undefined,
): { status: McpSetupStepStatus; detail?: string } {
  if (!item) return { status: "todo" };
  if (item.status === "ok") {
    return { status: "done", detail: item.detail ?? undefined };
  }
  if (item.status === "too_old" || item.status === "unknown") {
    return { status: "warn", detail: item.detail ?? undefined };
  }
  return { status: "todo", detail: item.detail ?? undefined };
}

/** 把本机探测结果标到 Blender 安装步骤上；查不到的保持未做。 */
export function applyBlenderMcpProbe(
  setup: ResolvedMcpSetup,
  probe: BlenderMcpProbe | null,
  checking = false,
): ResolvedMcpSetup {
  const steps = setup.steps.map((s) => {
    if (!s.id || !probe) return { ...s, status: s.status ?? "todo" };
    const mapped = probeToStep(probe[s.id]);
    return { ...s, ...mapped };
  });
  const done = steps.filter((s) => s.status === "done").length;
  const total = steps.length;
  const progress = checking
    ? "正在检测本机…"
    : !probe
      ? undefined
      : done === 0
        ? undefined
        : done === total
          ? "本机这些步骤都已就绪，可以直接添加。新开的对话即可用。"
          : `已检测到 ${done}/${total} 项就绪。`;
  return { ...setup, steps, progress };
}

/**
 * 从预设新建时自动启用的 Agent：只含 MCP 分发可写、且本机装了的家。caps 未到则空（不强开）。
 * installedIds 传本机检测到的 agent；没传或为空 = 检测未就位，不按安装过滤。
 * 没装的不写：写了会替人建出 ~/.cursor 这类目录，Cursor 的配置还和它的编辑器共用。
 */
export function writableMcpAgentIds(
  agentIds: string[],
  caps: Record<string, { mcpWrite: { supported: boolean } } | undefined>,
  installedIds?: string[],
): string[] {
  const installed = installedIds && installedIds.length > 0 ? new Set(installedIds) : null;
  return agentIds.filter(
    (id) => caps[id]?.mcpWrite.supported === true && (!installed || installed.has(id)),
  );
}

/** 预设 → 添加表单字段（`{home}` 已展开；键值对已克隆）。 */
export function applyMcpPreset(
  p: McpPreset,
  homeDir: string,
  isWindows: boolean,
): AppliedMcpPreset {
  const setup = p.setup
    ? {
        intro: expandHomeToken(p.setup.intro, homeDir, isWindows),
        after: expandHomeToken(p.setup.after, homeDir, isWindows),
        steps: p.setup.steps
          .filter((s) => stepApplies(s.when, isWindows))
          .map((s) => ({
            id: s.id,
            label: expandHomeToken(s.label, homeDir, isWindows),
            href: s.href,
            command: s.command
              ? expandHomeToken(s.command, homeDir, isWindows)
              : undefined,
          })),
      }
    : null;
  return {
    name: p.name,
    kind: p.kind,
    command: p.command ? expandHomeToken(p.command, homeDir, isWindows) : "",
    args: (p.args ?? []).map((a) => expandHomeToken(a, homeDir, isWindows)),
    url: p.url ?? "",
    headers: (p.headers ?? []).map((x) => ({ ...x })),
    startupTimeoutMs: p.startupTimeoutMs ?? null,
    note: p.note,
    setup,
  };
}

const BLENDER_LAB = "https://www.blender.org/lab/mcp-server/";
const BLENDER_ADDON = `${BLENDER_LAB}#addon`;
const BLENDER_REPO = "https://projects.blender.org/lab/blender_mcp.git";
const UV_INSTALL = "https://docs.astral.sh/uv/getting-started/installation/";

export const MCP_PRESETS: McpPreset[] = [
  // Consensus 官方 hosted MCP（lit-search 技能推荐）；需 Consensus API key。
  // Bearer 后用 ${VAR} 带括号写法：claude/codebuddy/cursor 只插值 ${VAR} 形式（matrix §10.3）
  {
    label: "Consensus（学术搜索）",
    note: "Consensus 官方 hosted MCP。把 API key 填到下面的密钥栏，Mesa 保存后注入给 Agent；请求头保持 Bearer ${CONSENSUS_API_KEY}，密钥不落清单。",
    name: "consensus",
    kind: "remote",
    url: "https://mcp.consensus.app/mcp",
    headers: [
      { key: "Authorization", value: "Bearer ${CONSENSUS_API_KEY}" },
    ],
  },
  // Undermind 官方 hosted MCP（lit-search 技能推荐）。认证走 OAuth（无 API key）：
  // 官方端点实测 401 + WWW-Authenticate（RFC 9728），支持它的客户端会自动拉起浏览器授权
  {
    label: "Undermind（文献语义搜索）",
    note: "Undermind 官方 hosted MCP。认证走 OAuth（没有 API key）：保存分发后，在用到它的 CLI 里登录一次、浏览器授权即可（Codex：codex mcp login undermind；Claude Code：claude mcp login undermind；OpenCode：opencode mcp auth undermind；Cursor：cursor-agent mcp login undermind；Gemini / Qwen 在对话里输入 /mcp auth undermind）。Mesa 连通检测对 OAuth 会显示未登录，不代表条目坏了。登录成功后必须新开会话。",
    name: "undermind",
    kind: "remote",
    url: "https://mcp.undermind.ai/mcp",
  },
  // Blender 官方 MCP（blender.org/lab）：stdio 进程 + Blender 内插件，不是 hosted URL。
  // 命令口径来自官方 Setup wiki（uv --directory <repo>/mcp run blender-mcp）。
  {
    label: "Blender（3D 场景）",
    note: "Blender 官方 MCP。按表单步骤装好后添加并启用，新开的对话即可用。需要 Blender 开着。",
    name: "blender",
    kind: "stdio",
    command: "uv",
    args: [
      "--directory",
      "{home}/blender_mcp/mcp",
      "run",
      "--with",
      "mcp<2",
      "blender-mcp",
    ],
    startupTimeoutMs: 30_000,
    setup: {
      intro:
        "这不是填 URL 就能连的远程服务。Agent 通过本机 blender-mcp 进程连到正在运行的 Blender。按顺序做完下面几步，表单里的命令已经按你家目录填好，不用改路径。",
      steps: [
        {
          id: "blender",
          label: "安装 Blender 5.1 或更新（低于此版本没有对接能力）",
          href: "https://www.blender.org/download/",
        },
        {
          id: "addon",
          label:
            "安装官方 MCP 插件：把安装包拖进 Blender 两次（先加 Blender Lab 仓库，再装插件），然后启用",
          href: BLENDER_ADDON,
        },
        {
          id: "uv",
          label: "安装 uv（用来启动 blender-mcp）",
          href: UV_INSTALL,
          command: "curl -LsSf https://astral.sh/uv/install.sh | sh",
          when: "unix",
        },
        {
          id: "uv",
          label: "安装 uv（用来启动 blender-mcp）",
          href: UV_INSTALL,
          when: "windows",
        },
        {
          id: "repo",
          label:
            "把官方仓库克隆到家目录（与表单路径一致；目录已存在则跳过）",
          command: `git clone ${BLENDER_REPO} "{home}/blender_mcp"`,
        },
        {
          id: "running",
          label:
            "打开 Blender → 编辑 → 偏好设置（Mac：顶部菜单 Blender → 设置）→ 左侧「扩展」，搜索 MCP 并点开。勾选 Auto Start；若写着 Server is stopped，点 Start MCP Bridge Server。系统页还要允许联网，否则起不来。保持这个窗口开着。",
          href: BLENDER_ADDON,
        },
      ],
      after:
        "做完后点「添加并启用」。会写入能分发的 Agent，新开的对话即可用。连通检测也要 Blender 已打开；第一次 uv 会装依赖，可能要等十几秒。若检测报 MCPServer 改名，参数里必须有 --with mcp<2。若报 No such file or directory，把 --directory 改成表单里已经展开的家目录路径，不要留「你的用户名」。官方警告：模型生成的代码会在 Blender 里无防护执行，不要对着存重要工程的本机开。",
    },
  },
];
