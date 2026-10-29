/**
 * Project → Task → Run 的前端纯逻辑（与 runs.rs 双端镜像）。
 * 工作台「正在进行」只列交互活；无头不进主卡。
 */
import { pathWithin, samePath } from "./path-utils.ts";
import type { RunDto } from "./types.ts";

export type RunTaskKind =
  | "pipeline_step"
  | "coding_lane"
  | "office_doc"
  | "free_research"
  | "watch"
  | "reader"
  | "scratch"
  | "login";

export type RunPermission = "discuss" | "write_tree";

/** 入口幂等键闭集：旧 `wt:` 升格为 `lane:`。 */
export function canonicalizeReuseKey(key: string | undefined): string {
  const t = key?.trim() ?? "";
  if (t.startsWith("wt:")) return `lane:${t.slice(3)}`;
  return t;
}

export function inferTaskKind(
  reuseKey: string | undefined,
  isolationPath: string,
): RunTaskKind {
  const key = canonicalizeReuseKey(reuseKey);
  if (key.startsWith("login:")) return "login";
  if (key.startsWith("reader:")) return "reader";
  if (key.startsWith("watch:")) return "watch";
  if (key.startsWith("office:")) return "office_doc";
  if (key.startsWith("free:") || key.startsWith("research:")) return "free_research";
  if (key.startsWith("ws:")) return "pipeline_step";
  if (key.startsWith("lane:") || key.startsWith("coding:")) return "coding_lane";
  if (key.startsWith("headless:")) return "scratch";
  const path = isolationPath.replace(/\\/g, "/");
  if (path.includes("/ccode/scratch") || path.includes("/ccode\\scratch")) {
    return "scratch";
  }
  if (path.includes("/ccode/workspaces/") || path.includes("/ccode/workspaces\\")) {
    return "pipeline_step";
  }
  if (path.includes("/ccode/worktrees/") || path.includes("/ccode/worktrees\\")) {
    return "coding_lane";
  }
  return "scratch";
}

/** 用户点开的任务标签（关了还想找回来）；登录 / 无头巡检不算。 */
export function isTaskReuseKey(reuseKey: string | undefined): boolean {
  const key = canonicalizeReuseKey(reuseKey);
  return (
    key.startsWith("ws:") ||
    key.startsWith("lane:") ||
    key.startsWith("office:") ||
    key.startsWith("free:") ||
    key.startsWith("task:") ||
    key.startsWith("reader:") ||
    key.startsWith("custom:") ||
    key.startsWith("research:") ||
    key.startsWith("coding:")
  );
}

export function isDiscussPermission(
  permission?: RunPermission | string | null,
  readonly?: boolean | null,
): boolean {
  if (permission === "discuss") return true;
  if (permission === "write_tree") return false;
  return Boolean(readonly);
}

/** 标签手上那条 Run 的身份里会随人操作变的三样（runs.rs open_at 身份校验的子集）。
 *  连接、模型、思考档不算身份：换了照旧沿用原 Run、接回原会话。 */
export interface RunIdentity {
  agentId: string;
  cwd: string;
  permission: RunPermission;
}

export type RunIdentityChange = "same" | "permission" | "agent" | "cwd";

/**
 * 这次启动还能不能沿用标签手上的 Run（2026-10-29）：Agent 停下后在聊天层换了目录 / Agent 再启动，
 * 带旧 id 会被 open_at 拒（「Run 身份与启动目标不一致」）。
 * - same：沿用原 Run，按原会话接回
 * - permission：只换了权限，另开 Run、接回原会话（同换权限重开）
 * - agent / cwd：换了 Agent 或目录（两样都换报 cwd），另开 Run、开新会话——原会话属于别家 CLI / 别的目录，接不回；
 *   cwd 还意味着离开了原来那个目标的目录，调用方不再把新 Run 挂到原目标上
 * 目录先展开 `~` 再按 samePath 比；bound 为空（还没绑过 Run）一律 same。
 */
export function compareRunIdentity(
  bound: RunIdentity | null,
  next: RunIdentity,
  home: string,
  isWindows = false,
): RunIdentityChange {
  if (!bound) return "same";
  const expand = (p: string) => {
    const t = p.trim();
    if (!home) return t;
    if (t === "~") return home;
    if (t.startsWith("~/") || t.startsWith("~\\")) return `${home}${t.slice(1)}`;
    return t;
  };
  if (!samePath(expand(bound.cwd), expand(next.cwd), isWindows)) return "cwd";
  if (bound.agentId !== next.agentId) return "agent";
  if (bound.permission !== next.permission) return "permission";
  return "same";
}

/** 关标签后仍可从会话恢复的交互 Run：有 session、非 internal、非巡检。
 *  阅读 Run 排除在外：阅读标签只在还开着时算「正在进行」，关掉后不当项目任务留着。 */
export function pickRecoverableRun(
  runs: readonly Pick<
    RunDto,
    | "id"
    | "internal"
    | "closedAt"
    | "taskKind"
    | "sessionId"
    | "runtime"
    | "capabilities"
    | "projectRoot"
    | "isolationPath"
  >[],
  projectPath: string,
  isWindows = false,
): (typeof runs)[number] | null {
  const path = projectPath.trim();
  if (!path) return null;
  for (const run of runs) {
    if (run.internal) continue;
    if (!run.closedAt) continue;
    if (
      run.taskKind === "login" ||
      run.taskKind === "watch" ||
      run.taskKind === "reader"
    )
      continue;
    if (run.runtime === "custom" || !run.capabilities.canResume) continue;
    if (!run.sessionId) continue;
    const root = run.projectRoot?.trim();
    if (root && samePath(root, path, isWindows)) return run;
    if (pathWithin(run.isolationPath, path, isWindows)) return run;
  }
  return null;
}

/**
 * 进程是否还活着（agent 在跑 / 等确认 / 回合结束停在提示符）。
 * 已退出回落 shell、未启动的保留标签不算「运行中」——它们只是可继续的视图。
 * TabStatus.attention 语义：无联动 / shell / 已退出 / 未知为 null，非 null 即进程存活。
 */
export function isRunProcessLive(run: {
  running?: boolean;
  attention?: "done" | "working" | "confirm" | null;
}): boolean {
  return Boolean(run.running) || run.attention != null;
}

/**
 * 工作台「正在进行」白名单：开步 / 工作树 / 普通终端 / 还开着的阅读标签。
 * 登录、定时巡检、无头、空闲未命名 shell 不算。
 */
export function isWorkbenchSurfaceRun(input: {
  reuseKey?: string;
  shell?: boolean;
  running?: boolean;
  attention?: "done" | "working" | "confirm" | null;
}): boolean {
  const key = canonicalizeReuseKey(input.reuseKey);
  if (key.startsWith("login:")) return false;
  if (key.startsWith("watch:") || key.startsWith("headless:")) return false;
  if (inferTaskKind(key, "") === "watch") return false;
  if (isTaskReuseKey(key)) return true;
  return Boolean(input.running || input.attention === "confirm");
}

/** 「正在进行」列表的口径，比 isWorkbenchSurfaceRun（主卡/找回用，保留死标签）更严：
 *  任务/工作区标签必须真有活——进程在跑、有注意力（含已跑完等你收）、或是你开着的
 *  交互 shell。空闲挂着的老标签不算，否则测试期留下的步骤标签会把没有任何交互活动
 *  的项目常驻工作台（2026-10-13 实证）。 */
export function isWorkbenchActiveRun(input: {
  reuseKey?: string;
  shell?: boolean;
  running?: boolean;
  attention?: "done" | "working" | "confirm" | null;
}): boolean {
  if (!isWorkbenchSurfaceRun(input)) return false;
  const key = canonicalizeReuseKey(input.reuseKey);
  if (isTaskReuseKey(key)) {
    return Boolean(
      input.running || input.attention != null || input.shell === true,
    );
  }
  return true;
}
