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

/** 挑出这个工作副本真正最新的一条非 internal Run（绝不因最新 Run 还没绑上 sessionId 就倒退去抓几天前的旧会话）。
 *  若最新 Run 尚无 sessionId，返回 null。 */
export function latestStepSessionRun<
  T extends { internal: boolean; sessionId?: string | null; isolationPath: string; createdAt: string },
>(runs: readonly T[], worktreePath: string, isWindows = false): T | null {
  const latest = runs
    .filter((r) => !r.internal && pathWithin(r.isolationPath, worktreePath, isWindows))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!latest?.sessionId) return null;
  return latest;
}

/**
 * AI 在对话里自己说出了错（2026-11-04：交互对话里「测试失败了」「报错了」不会把运行记成出错，卡点和步进器都看不到）。
 * 只看它最后一段话；「没有报错」「测试都通过了、无失败」这类否定说法不算。宁可漏、不乱报。
 */
const FAILURE_RE = /(失败|报错|出错|错误|异常|崩溃|跑不通|跑不起来|没跑通|Traceback|Error:|Exception|FAILED|failed\b)/i;
const NEGATED_RE =
  /(没有|没|未|无|不再|并未|零)\s*(失败|报错|出错|错误|异常)|(失败|报错|出错|错误|异常)\s*0\b|0\s*(处|条|个)?\s*(失败|报错|出错|错误|异常|failed|errors?)\b|no\s+(errors?|failures?)\b|全部通过|都通过|已修好|已经修好|修复了/i;
/** 剥掉引号与行内代码里被引用的词条名（如 `「下载失败」`、`“错误”`、`` `failed` ``），防止复盘建议或字段说明误触发「出错了」 */
const QUOTED_LABEL_RE = /「[^」\n]{1,24}」|“[^”\n]{1,24}”|`[^`\n]{1,40}`/g;

export function aiReportsFailure(text: string): boolean {
  const tail = text.slice(-600);
  const cleaned = tail.replace(QUOTED_LABEL_RE, "");
  if (!FAILURE_RE.test(cleaned)) return false;
  // 有否定说法、又没有明确的失败痕迹（Traceback / FAILED / 「失败了」）的，当没出错
  if (NEGATED_RE.test(cleaned) && !/Traceback|FAILED|失败了|报错了|出错了/.test(cleaned)) return false;
  return true;
}

/** 从 AI 的话里挑出说出错的那一句（卡点里给人看，最多 50 字） */
export function failureSnippet(text: string): string {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[。！？!?；;\n])/);
  const hit = sentences.reverse().find((s) => FAILURE_RE.test(s)) ?? text;
  const t = hit.trim();
  return t.length > 50 ? `${t.slice(0, 50)}…` : t;
}

export interface TailMessageLike {
  role: string;
  timestamp: string | null;
  blocks: readonly { kind: string; text: string }[];
}

/** 从会话最后一页提取最后一条有正文的 AI 发言，并判断其后是否已有用户正文回复（已回复则不再算「在等用户」） */
export function extractLastAssistantText(
  messages: readonly TailMessageLike[],
): { text: string; at: string | null; awaitingUser: boolean } | null {
  let userRepliedAfter = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      if (m.blocks.some((b) => b.kind === "text" && b.text.trim().length > 0)) {
        userRepliedAfter = true;
      }
      continue;
    }
    if (m.role !== "assistant") continue;
    const text = m.blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return { text, at: m.timestamp, awaitingUser: !userRepliedAfter };
  }
  return null;
}
