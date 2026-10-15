/** 工作区「去终端」的 resume 挑选纯逻辑（tests/workspace-resume.test.ts）。
 *  背景：worktree 会话在列表扫描时已归并回真实仓库（projectPath 改写为仓库路径、
 *  workspace 记工作区名），所以按 workspace 名 + 仓库路径两者匹配。 */
import type { SessionMetaDto } from "./types";

/** 工作区交接要不要接回最近会话。
 *  无首条指令（去终端看看）→ 接回；开工/按意见重写有指令 → 新开会话；
 *  评审「退回修改」显式 resumeSession → 接回并把意见当下一轮输入。 */
export function shouldResumeWorkspaceSession(opts?: {
  hasPrompt?: boolean;
  resumeSession?: boolean;
}): boolean {
  if (opts?.resumeSession) return true;
  return !opts?.hasPrompt;
}

/** 候选会话要不要真的接回。
 *  显式 resume（评审退回、决策后续跑）恒接回原会话。
 *  「去终端看看」没有步骤绑定、或绑定的就是这家 Agent → 接回。
 *  步骤绑定是另一家 Agent → 不接回。否则历史会话会把启动栏钉在开工时的旧 Agent 上，
 *  没有活会话时新开的终端也用不上这一步的绑定。 */
export function keepWorkspaceResume(opts: {
  explicitResume?: boolean;
  sessionAgentId?: string | null;
  stepAgentId?: string | null;
}): boolean {
  if (!opts.sessionAgentId) return false;
  if (opts.explicitResume) return true;
  const stepAgent = opts.stepAgentId?.trim() ?? "";
  if (stepAgent && stepAgent !== opts.sessionAgentId) return false;
  return true;
}

/** 从会话列表（已按最近活跃降序）挑出该工作区可 resume 的最近一条；无命中返回 null。
 *  排除归档（恢复语义怪异）、Mesa 内部无头会话（不是人聊的对话）、
 *  live（CLI 进程仍活着，resume 同会话会冲突） */
export function pickWorkspaceResume(
  sessions: SessionMetaDto[],
  workspaceName: string,
  repoPath: string,
): { agentId: string; sessionId: string } | null {
  const repo = repoPath.replace(/[\\/]+$/, "");
  const hit = sessions.find(
    (s) =>
      s.workspace === workspaceName &&
      s.projectPath.replace(/[\\/]+$/, "") === repo &&
      !s.archived &&
      !s.internal &&
      !s.live,
  );
  return hit ? { agentId: hit.agent, sessionId: hit.sessionId } : null;
}

/** 换 Agent 后点「继续」时，可带上的上一次工作区会话。
 *  没有旧会话、或上次就是这次要启动的 Agent → null（不问，直接开）。
 *  挑选口径与 pickWorkspaceResume 相同：最近一条、排除归档 / 内部无头 / 仍在跑的。 */
export function workspaceCarrySource(
  sessions: SessionMetaDto[],
  workspaceName: string,
  repoPath: string,
  nextAgentId: string,
): {
  agent: string;
  sessionId: string;
  filePath: string;
  title: string | null;
} | null {
  const next = nextAgentId.trim();
  if (!next) return null;
  const repo = repoPath.replace(/[\\/]+$/, "");
  const hit = sessions.find(
    (s) =>
      s.workspace === workspaceName &&
      s.projectPath.replace(/[\\/]+$/, "") === repo &&
      !s.archived &&
      !s.internal &&
      !s.live,
  );
  if (!hit || hit.agent === next) return null;
  return {
    agent: hit.agent,
    sessionId: hit.sessionId,
    filePath: hit.filePath,
    title: hit.customTitle?.trim() || hit.title,
  };
}
