/**
 * 跨厂商复核（2026-11-02，docs/design-research-moat.md §3.1）：评审页「请另一家复核」换一个**模型族不同**的
 * 模型读原文摘录与正文，逐条判断支持与否，只写 .ccode/checks/cross-review.jsonl。「不同」按模型比（同一个 GLM
 * 换个 CLI 外壳不算另一家）；默认自动挑、人可在下拉里改选，九家都能选，维护级与同模型族的标出来。
 * 复核结论一律「待你判断」——后端也把 agent: 检查器的 passed 降成 needs_human（research_record.rs）。
 */

import { vendorForModel, vendorForOfficialAgent } from "./vendor-icon.ts";

/** 一等支持的 Agent（AGENTS.md「CLI 支持分级」，2026-11-02）；默认复核先从这几家挑 */
export const TIER1_AGENTS = ["claude-code", "codex", "kimi"] as const;

export const CROSS_REVIEW_FILE = ".ccode/checks/cross-review.jsonl";

export interface ReviewerProfile {
  id: string;
  agent: string;
  name: string;
  models: readonly string[];
  lastUsedAt: string | null;
  accountType?: "api" | "official";
}

export interface CrossReviewer {
  agentId: string;
  profileId: string;
  model: string;
  profileName: string;
}

/** 写稿方：哪家 Agent、用过哪些模型（research_run_producer；没有 runId 时未知） */
export interface Producer {
  agent: string;
  models: readonly string[];
  /** 写稿那条连接（官方账号模型列表常为空，用它的 Agent 认厂商） */
  profile?: ReviewerProfile | null;
}

/** 一个可选的复核方：连接 × 模型 */
export interface ReviewerOption extends CrossReviewer {
  /** 模型族（vendor-icon 的厂商 id）；认不出为 null */
  family: string | null;
  tier: 1 | 2;
  /** 和写稿方同一个模型族：等于自己复核自己 */
  sameFamily: boolean;
}

/** 模型 → 模型族：按模型名认厂商（不认中转站）；官方账号没写模型时按 Agent 认 */
export function modelFamily(model: string, agent: string, accountType?: string): string | null {
  // API 连接没写模型时不猜（中转站上 Codex 不一定跑 GPT）；只有官方账号才按 Agent 认
  return vendorForModel(model) ?? (accountType === "official" ? vendorForOfficialAgent(agent) : null);
}

/** 写稿方用过的模型族；一个都认不出时为空集（调用方退回按 Agent 判断） */
export function producerFamilies(producer: Producer | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!producer) return out;
  const models = producer.models.length ? producer.models : producer.profile?.models.slice(0, 1) ?? [];
  for (const m of models) {
    const f = modelFamily(m, producer.agent, producer.profile?.accountType);
    if (f) out.add(f);
  }
  if (!out.size && producer.profile?.accountType === "official") {
    const f = vendorForOfficialAgent(producer.agent);
    if (f) out.add(f);
  }
  return out;
}

const tierOf = (agent: string): 1 | 2 => ((TIER1_AGENTS as readonly string[]).includes(agent) ? 1 : 2);

/** 全部可选项：每条没停用的连接 × 它的模型（官方账号没写模型的给一项空模型 = CLI 默认）；
 *  一等在前、最近用过的连接在前，连接内按模型列表顺序；每条连接最多列 40 个模型 */
export function reviewerOptions(
  profiles: readonly ReviewerProfile[],
  hidden: readonly string[],
  producer: Producer | null | undefined,
): ReviewerOption[] {
  const families = producerFamilies(producer);
  const sorted = profiles
    .filter((p) => !hidden.includes(p.id))
    .sort((a, b) => tierOf(a.agent) - tierOf(b.agent) || (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
  const out: ReviewerOption[] = [];
  for (const p of sorted) {
    const models = p.models.length ? p.models.slice(0, 40) : [""];
    for (const model of models) {
      const family = modelFamily(model, p.agent, p.accountType);
      out.push({
        agentId: p.agent,
        profileId: p.id,
        profileName: p.name,
        model,
        family,
        tier: tierOf(p.agent),
        sameFamily: family !== null && families.has(family),
      });
    }
  }
  return out;
}

/** 默认挑哪一个：一等支持、模型族与写稿方不同（写稿方认不出模型族时退回「不是同一家 Agent」），
 *  最近用过的连接优先、连接里取第一个符合的模型；一等里没有就从维护级里按同样条件挑 */
export function pickCrossReviewer(
  profiles: readonly ReviewerProfile[],
  hidden: readonly string[],
  producer: Producer | null | undefined,
): ReviewerOption | null {
  const options = reviewerOptions(profiles, hidden, producer);
  const known = producerFamilies(producer).size > 0;
  const differs = (o: ReviewerOption) =>
    known ? o.family !== null && !o.sameFamily : o.agentId !== producer?.agent;
  return options.find((o) => o.tier === 1 && differs(o)) ?? options.find(differs) ?? null;
}

/** 下拉里一项的写法：Agent · 连接 · 模型（厂商），后面带提醒 */
export function reviewerOptionLabel(o: ReviewerOption, agentLabel: string): string {
  const model = o.model || "默认模型";
  const notes = [o.sameFamily ? "与写稿同一模型族" : "", o.tier === 2 ? "维护级，复核指令未在这家验证过" : ""].filter(Boolean);
  return `${agentLabel} · ${o.profileName} · ${model}${notes.length ? `（${notes.join("；")}）` : ""}`;
}

export function reviewerOptionKey(o: Pick<CrossReviewer, "profileId" | "model">): string {
  return `${o.profileId}::${o.model}`;
}

/** 这一步写不写「带引用的正文」：稿件 / 开题 / 章节 / 报告才有论断可核；文献检索、精读、数据步没有，
 *  在那里复核 Agent 找不到稿件只能空转（2026-11-02 体验审查：文献检索步也挂了复核按钮） */
export function stepHasClaims(expectedArtifacts: readonly string[] | null | undefined): boolean {
  return (expectedArtifacts ?? []).some(
    (path) => /^(manuscript|proposal|chapters)\/.+\.(md|qmd|tex)$/.test(path) || /(^|\/)[^/]*report\.md$/.test(path),
  );
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
    "2. 逐条分两层判断：先看这段摘录本身是否支撑正文那句论断（研究对象、条件、方向、程度、因果强度是否一致，有没有把相关说成因果、把局部结论说成普遍结论）；" +
      "摘录撑不住时，再到原文其他位置找依据——找到了记「摘录不当」并在 detail 写出原文里真正支撑的那句与页码，找不到记「不支持」。摘录在原文里逐字找不到的直接记「不支持」并写明。",
    `3. 只写一个文件 ${CROSS_REVIEW_FILE}，每条一行 JSON：`,
    `   {"id": "X-<摘录编号或键>", "kind": "claim_support", "status": "needs_human", "title": "[@键] 摘录不当 / 部分支持 / 不支持 / 无法判断：<一句话>", ` +
      `"target": {"file": "<稿件>", "line": <行号>}, "evidence": {"source": "<键>", "quote": "<原文摘录>", "detail": "<理由：正文哪部分超出了原文>"}, "checker": "agent:${agentId}"}`,
    "   每个字段都要写，checker 照上面原样写。status 一律写 needs_human：支持与否由人最终判断，你的判断只是参考。只列「摘录不当」「部分支持」「不支持」「无法判断」的条目，摘录本身就撑得住的不必列。",
    "4. 不改稿件、不改其他任何文件、不提交。抽 PDF 文字等临时文件放系统临时目录（macOS / Linux 的 /tmp，Windows 的 %TEMP%），不在工作目录建文件。",
    `5. 每判断完一条就立刻往 ${CROSS_REVIEW_FILE} 追加一行（先落盘再核下一条；写文件单独一条命令或用编辑工具，不和删除等命令拼在一起），不要攒到最后一起写。`,
    "6. 一轮内做完：不要只说「接下来我要核对……」就停。全部写完后在对话里汇总：不支持几条、部分支持几条、无法判断几条。",
  ].join("\n");
}
