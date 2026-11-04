/**
 * 某一步最近那段对话里 AI 最后说的话（2026-11-04 项目助手第二档：交互对话里的出错不进运行记录，从会话尾巴补抓）。
 * 运行记录里最新一条带会话 id 的 → find_session 找会话文件 → 只读最后一页（get_session_conversation_page，文本已在后端脱敏）。
 * 读不到就当没有，不报错。
 */
import { invoke } from "@tauri-apps/api/core";
import { pathWithin } from "./path-utils";
import { IS_WINDOWS } from "./hotkeys";
import { aiReportsFailure } from "./run-failure";
import type { ChatMessageDto, ConversationPageDto, RunDto, SessionMetaDto } from "./types";

export interface StepTail {
  text: string;
  flagged: boolean;
  at: string | null;
}

const cache = new Map<string, { at: number; value: StepTail | null }>();
const TTL_MS = 30_000;

function lastAssistantText(messages: readonly ChatMessageDto[]): { text: string; at: string | null } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = m.blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return { text, at: m.timestamp };
  }
  return null;
}

export async function stepSessionTail(runs: readonly RunDto[], worktreePath: string): Promise<StepTail | null> {
  const run = runs
    .filter((r) => !r.internal && !!r.sessionId && pathWithin(r.isolationPath, worktreePath, IS_WINDOWS))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!run?.sessionId) return null;
  const key = `${run.agent}\n${run.sessionId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
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
      const last = lastAssistantText(page.messages);
      if (last) {
        const text = last.text.length > 700 ? `…${last.text.slice(-700)}` : last.text;
        value = { text, flagged: aiReportsFailure(last.text), at: last.at };
      }
    }
  } catch {
    value = null;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
