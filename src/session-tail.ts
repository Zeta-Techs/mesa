/**
 * 某一步最近那段对话里 AI 最后说的话（2026-11-04 项目助手第二档：交互对话里的出错不进运行记录，从会话尾巴补抓）。
 * 运行记录里最新一条带会话 id 的 → find_session 找会话文件 → 只读最后一页（get_session_conversation_page，文本已在后端脱敏）。
 * 读不到就当没有，不报错。
 */
import { invoke } from "@tauri-apps/api/core";
import { IS_WINDOWS } from "./hotkeys";
import { aiReportsFailure, extractLastAssistantText, latestStepSessionRun } from "./run-failure";
import type { ConversationPageDto, RunDto, SessionMetaDto } from "./types";

export { latestStepSessionRun };

export interface StepTail {
  text: string;
  flagged: boolean;
  at: string | null;
  runId?: string | null;
  /** AI 这句之后还没有用户正文回复；已回复时调度台不再当成「对话里在问你」 */
  awaitingUser?: boolean;
}

const cache = new Map<string, { at: number; value: StepTail | null }>();
const TTL_MS = 30_000;

export async function stepSessionTail(
  runs: readonly RunDto[],
  worktreePath: string,
  opts: { fresh?: boolean } = {},
): Promise<StepTail | null> {
  const run = latestStepSessionRun(runs, worktreePath, IS_WINDOWS);
  if (!run?.sessionId) return null;
  const key = `${run.id}\n${run.agent}\n${run.sessionId}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: StepTail | null = null;
  try {
    const meta = await invoke<SessionMetaDto | null>("find_session", { agent: run.agent, sessionId: run.sessionId });
    if (meta?.filePath) {
      const page = await invoke<ConversationPageDto>("get_session_conversation_page", {
        agent: run.agent,
        filePath: meta.filePath,
        before: null,
        around: null,
      });
      const last = extractLastAssistantText(page.messages);
      if (last) {
        const text = last.text.length > 700 ? `…${last.text.slice(-700)}` : last.text;
        value = { text, flagged: aiReportsFailure(last.text), at: last.at, runId: run.id, awaitingUser: last.awaitingUser };
      }
    }
  } catch {
    value = null;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
