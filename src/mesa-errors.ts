/**
 * Mesa 出错记录的纯逻辑（2026-11-04 项目助手一期，docs/design-project-assistant.md §3）。
 * 安装与上报在 mesa-error-capture.ts；这里只管：哪些失败要记、归到哪个项目、给 AI 看时怎么写。
 */
import { pathWithin } from "./path-utils.ts";

export interface MesaErrorRecord {
  at: string;
  firstAt: string;
  count: number;
  source: "invoke" | "toast" | "crash" | string;
  command: string;
  message: string;
  notice?: string | null;
  version: string;
}

/** 已知的项目根，以及挂在它下面的工作副本目录（工作副本可能不在项目目录里） */
export interface ProjectRootIndex {
  roots: readonly string[];
  worktrees: readonly { path: string; root: string }[];
}

/** 不记的后台调用：终端收发与流控（高频、失败多半是标签已关）、记录自身、日志 */
const IGNORED_COMMANDS = new Set([
  "mesa_error_record",
  "log_event",
  "pty_write",
  "pty_ack",
  "pty_resize",
  "pty_subscribe",
  "pty_get_cwd",
]);

export function shouldRecordFailure(command: string, error: unknown): boolean {
  if (!command || IGNORED_COMMANDS.has(command)) return false;
  // 插件命令（对话框、剪贴板、打开链接…）多半是用户取消，不算 Mesa 出错
  if (command.startsWith("plugin:")) return false;
  const text = errorText(error);
  if (!text) return false;
  if (/^(canceled|cancelled|已取消)$/i.test(text.trim())) return false;
  return true;
}

export function errorText(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 例行的「没找到」：界面在探文件在不在（预览、台账、缩略图、目录），没有就算了，不是 Mesa 出错。
 * 2026-11-04 本机一天的记录实证：记下的全是这一类（read_file_preview / read_research_ledger / list_dir 的
 * No such file or directory、Not a directory），一条红色提示都没配上。这类只在紧跟着弹了红色提示时才记
 * （后端 project_assistant.rs is_routine_failure 同口径）。
 */
const ROUTINE_RE = /\(os error 2\)|\(os error 20\)|No such file or directory|Not a directory|文件不存在或不可读|路径不可读/i;

export function isRoutineFailure(message: string): boolean {
  return ROUTINE_RE.test(message);
}

/** 从调用参数里找出所有像路径的字符串（只看两层，够覆盖 { input: { projectRoot } } 这类写法） */
export function pathLikeArgs(args: unknown, depth = 0): string[] {
  if (depth > 2 || args == null) return [];
  if (typeof args === "string") {
    return /^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(args) ? [args] : [];
  }
  if (Array.isArray(args)) return args.slice(0, 20).flatMap((v) => pathLikeArgs(v, depth + 1));
  if (typeof args === "object") {
    return Object.values(args as Record<string, unknown>)
      .slice(0, 30)
      .flatMap((v) => pathLikeArgs(v, depth + 1));
  }
  return [];
}

/** 失败的调用归哪个项目：参数里任一路径落在某个项目根或其工作副本里；多个命中取最长（最具体）的根 */
export function attributeProject(args: unknown, index: ProjectRootIndex, isWindows = false): string | null {
  let best: string | null = null;
  for (const p of pathLikeArgs(args)) {
    for (const root of index.roots) {
      if (pathWithin(p, root, isWindows) && (!best || root.length > best.length)) best = root;
    }
    for (const wt of index.worktrees) {
      if (pathWithin(p, wt.path, isWindows) && (!best || wt.root.length > best.length)) best = wt.root;
    }
  }
  return best;
}

/** 给 AI / 卡点看的一行：时间、次数、命令、原因、用户看到的那句 */
export function mesaErrorLine(e: MesaErrorRecord): string {
  const times = e.count > 1 ? `（10 分钟内 ${e.count} 次）` : "";
  const what = e.command ? `后台调用 ${e.command} 失败` : e.source === "toast" ? "界面报错" : "前端报错";
  const notice = e.notice && e.notice !== e.message ? `；你看到的提示：${e.notice}` : "";
  return `${e.at} ${what}${times}：${e.message}${notice}（Mesa ${e.version}）`;
}

/** 最近 hours 小时内的出错记录（卡点只提近一天的，旧的不催人） */
export function recentMesaErrors(rows: readonly MesaErrorRecord[], nowMs: number, hours = 24): MesaErrorRecord[] {
  return rows.filter((r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && nowMs - t <= hours * 3600_000;
  });
}
