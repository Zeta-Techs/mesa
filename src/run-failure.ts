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

/**
 * AI 在对话里自己说出了错（2026-11-04：交互对话里「测试失败了」「报错了」不会把运行记成出错，卡点和步进器都看不到）。
 * 只看它最后一段话；「没有报错」「测试都通过了、无失败」这类否定说法不算。宁可漏、不乱报。
 */
const FAILURE_RE = /(失败|报错|出错|错误|异常|崩溃|跑不通|跑不起来|没跑通|Traceback|Error:|Exception|FAILED|failed\b)/i;
const NEGATED_RE = /(没有|没|未|无|不再|并未|零)\s*(失败|报错|出错|错误|异常)|0\s*(failed|errors?)\b|no\s+(errors?|failures?)\b|全部通过|都通过|已修好|已经修好|修复了/i;

export function aiReportsFailure(text: string): boolean {
  const tail = text.slice(-600);
  if (!FAILURE_RE.test(tail)) return false;
  // 有否定说法、又没有明确的失败痕迹（Traceback / FAILED / 「失败了」）的，当没出错
  if (NEGATED_RE.test(tail) && !/Traceback|FAILED|失败了|报错了|出错了/.test(tail)) return false;
  return true;
}

/** 从 AI 的话里挑出说出错的那一句（卡点里给人看，最多 50 字） */
export function failureSnippet(text: string): string {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[。！？!?；;\n])/);
  const hit = sentences.reverse().find((s) => FAILURE_RE.test(s)) ?? text;
  const t = hit.trim();
  return t.length > 50 ? `${t.slice(0, 50)}…` : t;
}
