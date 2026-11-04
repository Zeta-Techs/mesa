/**
 * 运行出错的白话（2026-11-04 项目助手一期，docs/design-project-assistant.md §4）：
 * 运行库里存着退出码与关闭原因，界面原来只写「出错退出」四个字。这里把它们译成一句人话，
 * 并判断某一步（某个工作副本）最近一次运行是不是出错收的场。
 * 「应用上次异常退出」是 Mesa 自己没收好尾，不算这一步出错（归 Mesa 的问题）。
 */
import { exitCodeSummary } from "./exit-code.ts";
import { pathWithin } from "./path-utils.ts";

export interface RunFailureInput {
  id: string;
  isolationPath: string;
  internal: boolean;
  createdAt: string;
  closedAt: string | null;
  status: string;
  exitCode: number | null;
  closeReason: string | null;
}

const APP_CRASH_REASON = "应用上次异常退出";
/** 后端写的通用原因：有退出码时退出码已经说清了，不重复 */
const GENERIC_REASON = "进程以非零退出码结束";

export function isAppCrashClose(run: Pick<RunFailureInput, "closeReason">): boolean {
  return !!run.closeReason?.includes(APP_CRASH_REASON);
}

/** 一句出错原因：「未找到命令（退出码 127）」「PTY 启动失败」「异常退出（退出码 1）· 评审基线写入失败」 */
export function runFailureReason(run: Pick<RunFailureInput, "exitCode" | "closeReason">): string {
  const parts: string[] = [];
  if (run.exitCode != null) {
    const s = exitCodeSummary(run.exitCode);
    parts.push(s.code != null && !s.label.includes(String(s.code)) ? `${s.label}（退出码 ${s.code}）` : s.label);
  }
  const reason = run.closeReason?.trim();
  if (reason && !(reason === GENERIC_REASON && run.exitCode != null)) parts.push(reason);
  return parts.join(" · ") || "出错退出，没有留下原因";
}

/** 这个目录里最近一次运行出错收场就给出那次运行；最近一次没出错、还开着、或是 Mesa 自己异常退出的，返回 null */
export function latestRunFailure<T extends RunFailureInput>(
  runs: readonly T[],
  root: string,
  isWindows = false,
): { run: T; reason: string } | null {
  let latest: T | null = null;
  for (const run of runs) {
    if (run.internal || !pathWithin(run.isolationPath, root, isWindows)) continue;
    if (!latest || run.createdAt > latest.createdAt) latest = run;
  }
  if (!latest || latest.status !== "failed" || isAppCrashClose(latest)) return null;
  return { run: latest, reason: runFailureReason(latest) };
}
