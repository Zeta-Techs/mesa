/**
 * 跨厂商复核（2026-11-02，docs/design-research-moat.md §3.1）：评审页「请另一家复核」换一家一等支持的
 * Agent 读原文摘录与正文，逐条判断支持与否，只写 .ccode/checks/cross-review.jsonl。
 * 复核结论一律「待你判断」——后端也把 agent: 检查器的 passed 降成 needs_human（research_record.rs）。
 */

/** 一等支持的 Agent（AGENTS.md「CLI 支持分级」，2026-11-02）；复核按这个顺序挑 */
export const TIER1_AGENTS = ["claude-code", "codex", "kimi"] as const;

export const CROSS_REVIEW_FILE = ".ccode/checks/cross-review.jsonl";

export interface ReviewerProfile {
  id: string;
  agent: string;
  name: string;
  models: readonly string[];
  lastUsedAt: string | null;
}

export interface CrossReviewer {
  agentId: string;
  profileId: string;
  model: string;
  profileName: string;
}

/** 挑复核用的连接：一等支持、没被停用、和干活的不是同一家；同一家里挑最近用过的那条 */
export function pickCrossReviewer(
  profiles: readonly ReviewerProfile[],
  hidden: readonly string[],
  producerAgent: string | null | undefined,
): CrossReviewer | null {
  for (const agent of TIER1_AGENTS) {
    if (agent === producerAgent) continue;
    const candidates = profiles
      .filter((p) => p.agent === agent && !hidden.includes(p.id))
      .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
    const pick = candidates[0];
    if (pick) {
      return { agentId: agent, profileId: pick.id, model: pick.models[0] ?? "", profileName: pick.name };
    }
  }
  return null;
}

/** 复核标签与干活的标签分开，不复用同一个（不用 ws: 前缀：那是工作区标签的持久化键） */
export function crossReviewReuseKey(worktreePath: string): string {
  return `cross-review:${worktreePath}`;
}

/** 交给复核 Agent 的首条指令 */
export function crossReviewPrompt(agentId: string, projectRoot: string): string {
  return [
    "你在做只读的交叉复核：这一步的稿件是另一家模型写的，请换个角度挑问题，不要顺着原作者的思路。",
    "",
    "1. 读 manuscript/evidence.json（每处引用的原文摘录与正文位置）和对应正文；摘录不够判断时，打开项目根 " +
      `${projectRoot}/papers/ 下的 PDF 看上下文。没有 evidence.json 时，改读正文里的 [@键] 和 notes/ 下的精读笔记。`,
    "2. 逐条判断：这段原文是否支持正文那句论断——研究对象、条件、方向、程度、因果强度是否一致，有没有把相关说成因果、把局部结论说成普遍结论。",
    `3. 只写一个文件 ${CROSS_REVIEW_FILE}，每条一行 JSON：`,
    `   {"id": "X-<摘录编号或键>", "kind": "claim_support", "status": "needs_human", "title": "[@键] 支持 / 部分支持 / 不支持 / 无法判断：<一句话>", ` +
      `"target": {"file": "<稿件>", "line": <行号>}, "evidence": {"source": "<键>", "quote": "<原文摘录>", "detail": "<理由：正文哪部分超出了原文>"}, "checker": "agent:${agentId}"}`,
    "   status 一律写 needs_human：支持与否由人最终判断，你的判断只是参考。只列「部分支持」「不支持」「无法判断」的条目，支持的不必列。",
    "4. 不改稿件、不改其他任何文件、不提交。抽 PDF 文字等临时文件放系统临时目录（macOS / Linux 的 /tmp，Windows 的 %TEMP%），不在工作目录建文件。",
    `5. 每判断完一条就立刻往 ${CROSS_REVIEW_FILE} 追加一行（先落盘再核下一条；写文件单独一条命令或用编辑工具，不和删除等命令拼在一起），不要攒到最后一起写。`,
    "6. 一轮内做完：不要只说「接下来我要核对……」就停。全部写完后在对话里汇总：不支持几条、部分支持几条、无法判断几条。",
  ].join("\n");
}
