/** MCP 页展示纯逻辑：协议徽章固定识别色 + 命令/路径智能缩略 + 分发状态徽标（mcpDistBadge）
 *  + 命令路径告警徽标（mcpCmdPathBadge）+ 收编/导入的相对路径解析附注（mcpPathResolveNote）
 *  + 体检行文案（mcpHealthText/mcpCheckAtLabel）+ $VAR 预检提示（missingEnvSignature/
 *  missingEnvWarnText）+ 密钥栏（mcpEnvRefNames / mcpSecretFieldLabel / mcpSecretPlaceholder）。
 *  色相固定 hex（同 file-icons / agent-colors 先例：识别色不随主题换色相），
 *  底色走 color-mix 10% 混合，深浅主题自动跟随；
 *  文字色向主题主文本色 var(--color-l1) 混 30%——浅色主题压深、深色主题提亮，
 *  对比度自适应（2026-08-25 设计评审：原色在米白底上偏淡）。 */

import type { McpHealthDto } from "./types";


/** 单个 token 的路径缩略：家目录前缀折成 ~，段数 >3 且折后仍 >28 字符才砍中段留首尾
 *  （短路径如 /opt/homebrew/bin/node、~/.bun/bin/bun 原样保留——缩了反而丢信息）。
 *  非路径形态（无分隔符、URL、短相对名）原样返回。 */
export function shortenPathToken(token: string): string {
  // URL 不缩（:// 会被路径分段逻辑切碎）
  if (token.includes("://")) return token;
  // 统一分隔符（Windows 反斜杠）再判断
  let t = token.replace(/\\/g, "/");
  // 家目录前缀折叠：macOS / Linux / Windows 三形态
  t = t
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^[A-Za-z]:\/Users\/[^/]+/i, "~");
  if (!t.includes("/")) return token;
  const leadingSlash = t.startsWith("/");
  const segs = t.split("/").filter(Boolean);
  if (segs.length <= 3 || t.length <= 28) return t;
  const head = segs[0];
  const tail = segs[segs.length - 1];
  return `${leadingSlash ? "/" : ""}${head}/…/${tail}`;
}

/** 完整启动命令的展示缩略：逐 token（空格分隔）缩略路径形态 token，普通参数原样。
 *  展示用；完整命令始终在悬浮提示里给全文 */
export function shortenCommand(command: string, args: string[]): string {
  const raw = [command, ...args].filter((s) => s.length > 0);
  return raw.map(shortenPathToken).join(" ");
}

/** 收编条目判定：只有 origin === "ccode" 是本应用自建；收编/粘贴导入/旧数据空串（来源未知）
 *  一律按收编对待——删除与关闭分发的默认动作不得反向动 agent 侧配置（宁可少删不可错删） */
export function isAdoptedMcp(origin: string): boolean {
  return origin !== "ccode";
}

/** 删除影响面：apps 里值为 true 的 agent 显示名清单（按 agents 表序，稳定可测） */
export function mcpDeleteImpact(
  apps: Record<string, boolean>,
  agents: ReadonlyArray<{ id: string; label: string }>,
): string[] {
  return agents.filter((a) => apps[a.id]).map((a) => a.label);
}

/** 收编来源的展示名：imported:<agent> → agent 显示名；imported:json → 粘贴的 JSON；
 *  空串（旧数据）→ 未知来源 */
export function mcpOriginLabel(
  origin: string,
  agents: ReadonlyArray<{ id: string; label: string }>,
): string {
  if (origin === "imported:json") return "粘贴的 JSON";
  const agent = origin.match(/^imported:(.+)$/)?.[1];
  if (agent) return agents.find((a) => a.id === agent)?.label ?? agent;
  return "未知来源";
}

/** 分发实际状态闭集（与后端 mcp_distribution_status 同口径）：
 *  off = apps 未分发；ok = 落盘与清单一致；modified = 被外部改过；
 *  missing = apps 标记已分发但磁盘条目不存在；disabled_externally = agent 侧被禁用
 *  （仅 codex/grok/codebuddy 三家有实证 enabled 语义才产出） */
export type McpDistState =
  | "off"
  | "ok"
  | "modified"
  | "missing"
  | "disabled_externally";

export interface McpDistBadge {
  label: string;
  tip: string;
  color: string;
  background: string;
}

/** 分发状态徽标：仅三个异常态有徽标（ok/off 是正常态不标）。
 *  色相固定 hex + color-mix，同 mcpKindBadgeStyle 口径（深浅主题自适应对比度） */
const mkBadge = (hex: string, label: string, tip: string): McpDistBadge => ({
  label,
  tip,
  color: `color-mix(in srgb, ${hex} 70%, var(--color-l1))`,
  background: `color-mix(in srgb, ${hex} 10%, transparent)`,
});

export function mcpDistBadge(state: string | undefined): McpDistBadge | null {
  switch (state) {
    case "modified":
      return mkBadge(
        "#d9930d",
        "外部已修改",
        "该 agent 侧的条目被外部改过——保存或重新分发会按本清单覆盖",
      );
    case "missing":
      return mkBadge(
        "#e05d5d",
        "外部已删除",
        "该 agent 配置里的条目已不存在；拨开开关将把该条目重新写入",
      );
    case "disabled_externally":
      return mkBadge(
        "#8a8f98",
        "外部已禁用",
        "在该 agent 侧被禁用，Mesa 清单不受影响；拨开开关重写条目即恢复启用",
      );
    default:
      return null;
  }
}

/** 命令路径健康闭集（与后端 mcp_command_path_status 同口径）：ok = 正常态不标 */
export type McpCmdPathState = "ok" | "relative" | "missing";

/** 命令路径告警徽标：仅 relative/missing 两异常态有徽标（ok 与未探测不标）。
 *  白话双层：短语讲现象，悬浮讲后果与出路 */
export function mcpCmdPathBadge(state: string | undefined): McpDistBadge | null {
  switch (state) {
    case "relative":
      return mkBadge(
        "#d9930d",
        "相对路径命令",
        "命令是相对路径，只有来源 CLI 在特定目录启动时才找得到——Mesa 内嵌终端拉起会启动失败。展开条目可用「修复为绝对路径」自动解析",
      );
    case "missing":
      return mkBadge(
        "#e05d5d",
        "命令路径不存在",
        "命令指向的路径在磁盘上不存在（应用已卸载或版本升级后路径失效），拉起会启动失败；请点 ✎ 编辑修正",
      );
    default:
      return null;
  }
}

/** 收编/粘贴导入完成 toast 的相对路径附注：解析了几条、几条没解出来（都没有返回 null） */
export function mcpPathResolveNote(
  resolved: number,
  unresolved: number,
): string | null {
  const parts: string[] = [];
  if (resolved > 0) parts.push(`其中 ${resolved} 条的相对路径已解析为绝对路径`);
  if (unresolved > 0)
    parts.push(`${unresolved} 条的相对路径未能解析，请在列表里修复`);
  return parts.length > 0 ? parts.join("；") : null;
}

/** 体检沉淀时间标签：ISO（2023-11-14T22:13:20Z）→ "11-14 22:13"；解析不动原串，认不出原样返回 */
export function mcpCheckAtLabel(at: string): string {
  const m = at.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : at;
}

/** HealthDot/mcpHealthText 消费的最小形状：实时结果带 status 细分；清单沉淀（lastCheck）
 *  没落 status 字段，按可选处理——沉淀文案维持 ok/error 两层，不虚构细分 */
export type McpHealthView = Pick<
  McpHealthDto,
  "ok" | "latencyMs" | "error" | "detail"
> & { status?: McpHealthDto["status"] };

/** 行内健康状态浮层文案（HealthDot 的 tooltip 与 aria 共用）：
 *  检测中 / 正常（握手成功；reachable 细分只说「地址可达」）/ 失败原因；
 *  checkedAt 有值 = 展示的是沉淀的上次结果，加「上次检测」前缀与实时结果区分；
 *  未检测过返回 null（无状态不渲染状态点） */
/** Mesa 探测不带各 CLI 的 OAuth 令牌。带 resource_metadata 的 401 是「要登录」，不是断网。 */
export function mcpHealthNeedsLogin(
  health: McpHealthView | "checking" | undefined,
): boolean {
  if (!health || health === "checking" || health.ok) return false;
  return /OAuth|mcp login/i.test(health.error ?? "");
}

/** 行内常显的异常短语：状态点只靠颜色分不出黄绿，不正常时名字后面直接写出来（2026-10-23 审查）。
 *  没检测 / 检测中 / 正常返回 null（正常只留一个点） */
export function mcpHealthLabel(
  health: McpHealthView | "checking" | undefined,
): { text: string; tone: "warn" | "err" } | null {
  if (!health || health === "checking" || health.ok) return null;
  return mcpHealthNeedsLogin(health)
    ? { text: "需登录", tone: "warn" }
    : { text: "连不上", tone: "err" };
}

export function mcpHealthText(
  health: McpHealthView | "checking" | undefined,
  checkedAt?: string | null,
): string | null {
  if (!health) return null;
  if (health === "checking") return "正在检测连通性…";
  const prefix = checkedAt ? `上次检测（${mcpCheckAtLabel(checkedAt)}）：` : "";
  const body = health.ok
    ? health.status === "reachable"
      ? `地址可达，握手未确认${health.detail ? ` · ${health.detail}` : ""} · ${health.latencyMs}ms`
      : `连通正常${health.detail ? ` · ${health.detail}` : ""} · ${health.latencyMs}ms`
    : mcpHealthNeedsLogin(health)
      ? `${health.error ?? "需要 OAuth 登录"}。Mesa 不会代登，在对应 CLI 登录后新开会话即可用`
      : (health.error ?? "检测失败");
  return `${prefix}${body}\n点击重新检测`;
}

/** 缺失环境变量提示的会话内去重签名：同一组变量同会话只提示一次（批量场景不重复打扰） */
export function missingEnvSignature(missing: string[]): string {
  return [...new Set(missing)].sort().join(",");
}

/** $VAR 引用未设置的非阻断警告文案（白话双层：先列变量，再讲为什么可能起不来、怎么选） */
export function missingEnvWarnText(
  missing: string[],
  action: "保存" | "分发",
): string {
  return `以下密钥还没填：${missing.join("、")}。请在表单密钥栏粘贴（由 Mesa 注入），不必自己设系统环境变量。仍要${action}吗？`;
}

/** env/header 值里的 $VAR / ${VAR} 引用名，去重保序（与后端 scan_env_refs 同口径的常用子集） */
export function mcpEnvRefNames(pairs: ReadonlyArray<{ value: string }>): string[] {
  const out: string[] = [];
  const re = /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const pair of pairs) {
    const value = pair.value ?? "";
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(value))) {
      const name = (match[1] || match[2] || "").trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

export function mcpSecretFieldLabel(name: string): string {
  if (name === "CONSENSUS_API_KEY") return "Consensus API 密钥";
  return name;
}

export function mcpSecretPlaceholder(hint?: string): string {
  return hint ? `已保存 ${hint}，留空保持不变` : "粘贴密钥，由 Mesa 注入";
}
