/**
 * 项目助手的前端取数与问答入口（2026-11-24 真 Agent 架构重构）：
 * - 顶部状态条 / 飞书状态卡 / 桌宠共用 `gatherBriefInput` → 单次调用 Rust 唯一真源 `assistant_project_brief`，
 *   仅在前端叠加实时终端注意力（working / confirm），不再在前端 8 路拼装。
 * - 问答统一走 Rust `project_assistant_chat`：第一档（Claude Code / Codex）持久只读 Agent + 临时 stdio MCP 工具 +
 *   结构化 `proposals`；第二档（其余 CLI）由 Rust 唯一真源直接渲染精简上下文回落。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IS_WINDOWS } from "./hotkeys";
import { useAppStore } from "./store";
import { pathWithin, samePath } from "./path-utils";
import { projectAssistantLaunch, resolveTaskModel } from "./project-agents";
import { AGENTS } from "./types";
import {
  classifyQuestion,
  INSPECT_AGENTS,
  isReviewAsk,
  previousTurnHint,
  wantsInspect,
  type AssistantHistoryTurn,
  type AssistantIntent,
  type AssistantProposalsDto,
} from "./project-assistant";
import { reviewingStep } from "./assistant-brief";
import type { DispatchRecord } from "./assistant-dispatch";
import type { BriefInput, BriefStep } from "./assistant-brief";
import type { ProjectDto } from "./types";

export interface AssistantTurn {
  at: string;
  question: string;
  answer: string;
  connection: string;
  /** 这一问依据了什么（说明书哪几节 / Agent 工具 / 这个项目的记录）；旧记录没有 */
  basis?: string;
  /** 这次调用花了多少（美元；只有 Claude Code / Codex、模型查得到价时有） */
  costUsd?: number | null;
  /** 这一轮的派活单派出去了 */
  dispatched?: DispatchRecord | null;
  /** 派活回音（2026-11-05）：为哪一轮派出去的活补的进展；问题为空，不当成问答喂给 AI */
  echoOf?: string | null;
  /** 第一档 MCP 提议工具产出的结构化提议（派活单 / 补料单 / 规矩 / 按钮 / 说明书标题） */
  proposals?: AssistantProposalsDto | null;
}

/** 「问问为什么」带进来的那件事 */
export interface AssistantFocus {
  title: string;
  detail: string;
  runId?: string | null;
}

/** 支持第一档真 Agent 持久会话 + MCP 工具的 CLI（含其下所有第三方网关连接） */
export const TIER1_ASSISTANT_AGENTS: readonly string[] = ["claude-code", "codex"];

export const ASSISTANT_CANCELLED = "ASSISTANT_CANCELLED";

/** 这个项目用谁答（专属绑定 > 项目默认 > AI 功能连接），以及给人看的一行与运行形态 */
export function assistantConnection(project: ProjectDto | null): {
  profileId: string | null;
  model: string | null;
  line: string;
  /** 底栏紧凑展示（如「Claude Code · GLM-flash · glm-5.3-flash」或「Claude Code · glm-5.3-flash」） */
  shortLine: string;
  bound: boolean;
  /** 用的是哪家 Agent；走「AI 功能」连接时前端不知道，为 null */
  agentId: string | null;
  agentLabel: string | null;
  profileName: string | null;
  /** 运行形态短标（只读 Agent / 只读查文件 / 仅看记录 / 跟随 AI 功能） */
  modeLabel: string;
  modeHint: string;
} {
  const { profiles } = useAppStore.getState();
  const launch = projectAssistantLaunch(profiles, project);
  if (!launch) {
    return {
      profileId: null,
      model: null,
      line: "设置里「AI 功能」的连接",
      shortLine: "设置里「AI 功能」的连接",
      bound: false,
      agentId: null,
      agentLabel: null,
      profileName: null,
      modeLabel: "跟随 AI 功能",
      modeHint: "当前使用设置 → AI 与 Agent 中的默认连接",
    };
  }
  const profile = profiles.find((p) => p.id === launch.profileId);
  const agentLabel = AGENTS.find((a) => a.id === launch.agentId)?.label ?? launch.agentId;
  const profileName = profile?.name?.trim() || null;
  const modelName = launch.model?.trim() || null;
  const line = [agentLabel, profileName, modelName || "默认模型"].filter(Boolean).join(" · ");
  // 底栏紧凑展示：Agent 永远显式标出，连接名与 Agent/模型重复时去重，避免过长又清楚知道底层跑的是谁
  const parts: string[] = [agentLabel];
  if (
    profileName &&
    profileName.toLowerCase() !== agentLabel.toLowerCase() &&
    profileName !== "官方账号" &&
    (!modelName || profileName.toLowerCase() !== modelName.toLowerCase())
  ) {
    parts.push(profileName);
  }
  parts.push(modelName || "默认模型");
  const isTier1 = TIER1_ASSISTANT_AGENTS.includes(launch.agentId);
  const isReadonly = INSPECT_AGENTS.includes(launch.agentId);
  const modeLabel = isTier1 ? "只读 Agent" : isReadonly ? "只读查文件" : "仅看记录";
  const modeHint = isTier1
    ? "持久只读会话 · 可自主调用 Mesa 工具与读取项目文件，绝不修改项目"
    : isReadonly
      ? "直连 Mesa 项目真源 · 支持只读核对项目文件与看图，绝不修改项目"
      : "直连 Mesa 项目真源 · 暂不支持直接读文件与看图";
  return {
    profileId: launch.profileId,
    model: modelName,
    line,
    shortLine: parts.join(" · "),
    bound: launch.bound,
    agentId: launch.agentId,
    agentLabel,
    profileName,
    modeLabel,
    modeHint,
  };
}

/** 当前项目助手连接不支持进程级只读查看（如 agy）时，从已配置的连接里挑一条支持只读查看的备选连接 */
export function readonlyInspectFallback(project: ProjectDto | null): {
  profileId: string;
  model: string | null;
  line: string;
  agentId: string;
  agentLabel: string;
} | null {
  const { profiles, settings } = useAppStore.getState();
  const hidden = new Set(settings?.hiddenProfiles ?? []);
  const eligible = profiles.filter((p) => !hidden.has(p.id) && INSPECT_AGENTS.includes(p.agent));
  if (eligible.length === 0) return null;
  // 优先按 INSPECT_AGENTS 顺序（Claude Code → Codex → Kimi → Grok），同家优先取项目默认连接
  for (const agentId of INSPECT_AGENTS) {
    const defaultId = project?.defaultProfiles?.[agentId];
    const picked = (defaultId ? eligible.find((p) => p.id === defaultId) : null) ?? eligible.find((p) => p.agent === agentId);
    if (!picked) continue;
    const model =
      resolveTaskModel({
        models: picked.models,
        profileId: picked.id,
        defaultProfileId: project?.defaultProfiles?.[agentId],
        defaultModel: project?.defaultModels?.[agentId],
      }) || null;
    const agentLabel = AGENTS.find((a) => a.id === agentId)?.label ?? agentId;
    const line = [agentLabel, picked.name, model || "默认模型"].filter(Boolean).join(" · ");
    return { profileId: picked.id, model, line, agentId, agentLabel };
  }
  return null;
}

interface RustBriefStepDto extends BriefStep {
  worktreePath?: string | null;
}

interface RustBriefDto extends Omit<BriefInput, "steps"> {
  steps: RustBriefStepDto[];
}

/** 「现在的情况」卡与常用问题的取数：单次调用 Rust 唯一真源 `assistant_project_brief`，再叠加前端实时终端状态 */
export async function gatherBriefInput(projectPath: string, since: string | null): Promise<BriefInput> {
  const dto = await invoke<RustBriefDto>("assistant_project_brief", {
    projectRoot: projectPath,
    since,
  });
  const live = useAppStore.getState().terminalRunInputs;
  const steps: BriefStep[] = dto.steps.map((s) => {
    let state = s.state;
    if (s.worktreePath && state !== "saved" && state !== "idle") {
      const hits = live.filter((r) => r.running && !r.shell && pathWithin(r.cwd, s.worktreePath!, IS_WINDOWS));
      if (hits.some((r) => r.attention === "working")) state = "working";
      else if (hits.some((r) => r.attention === "confirm")) state = "confirm";
    }
    return {
      n: s.n,
      name: s.name,
      state,
      failure: s.failure ?? null,
      mergedAt: s.mergedAt ?? null,
      needsHuman: s.needsHuman,
      pendingUpstream: s.pendingUpstream,
      staleUpstream: s.staleUpstream ?? null,
    };
  });
  return {
    hasFlow: dto.hasFlow,
    steps,
    goals: dto.goals,
    since: dto.since ?? since,
    knowledgeEmpty: dto.knowledgeEmpty,
    uncertainSchedules: dto.uncertainSchedules,
  };
}

/** 兼容旧调用点的空操作：状态已全部迁移到 Rust 唯一真源实时读取，不再维护前端快照缓存 */
export function invalidateAssistantSnapshot(_projectPath?: string): void {}

/** 这一问怎么问（用于面板等待提示文案；实际工具调用与状态获取由 Rust 真 Agent 自主完成） */
export function planAsk(
  question: string,
  hasFocus: boolean,
  project: ProjectDto | null,
  forced?: AssistantIntent,
  history?: readonly (AssistantHistoryTurn & { dispatched?: unknown })[],
): { intent: AssistantIntent; inspect: boolean } {
  const last = history?.[history.length - 1];
  const intent = forced ?? classifyQuestion(question, hasFocus, last ? previousTurnHint(last.answer, !!last.dispatched) : undefined);
  const agent = assistantConnection(project).agentId;
  const inspect =
    (agent !== null && TIER1_ASSISTANT_AGENTS.includes(agent)) ||
    (wantsInspect(question, intent, hasFocus) && (agent === null || INSPECT_AGENTS.includes(agent)));
  return { intent, inspect };
}

/** 评审页开着时，「用户此刻在看哪」补一句正在评审哪一步 */
function withReviewing(where: string | undefined, projectPath: string): string | undefined {
  const open = reviewingStep();
  if (!open || !samePath(open.projectRoot, projectPath, IS_WINDOWS)) return where;
  return `${where ? `${where} · ` : ""}正在评审第 ${open.n} 步「${open.name}」`;
}

/** 问「这一轮怎么样」且评审页正开着时，补一条轻量重点提示（让 Agent 调用 step_detail 核对，不再在前端跑检查） */
function reviewingFocusHint(projectPath: string, question: string): AssistantFocus | null {
  if (!isReviewAsk(question)) return null;
  const open = reviewingStep();
  if (!open || !samePath(open.projectRoot, projectPath, IS_WINDOWS)) return null;
  const artifacts = open.artifacts.length ? `（主要产物：${open.artifacts.join("、")}）` : "";
  return {
    title: `这一轮怎么样：第 ${open.n} 步「${open.name}」`,
    detail: `用户正在评审第 ${open.n} 步「${open.name}」，工作副本在 ${open.worktree}${artifacts}。请先查该步详情与核验项，再只读核对主要产物，不替用户判通过。`,
  };
}

/** 统一问答入口：直连 Rust `project_assistant_chat`（第一档持久只读 Agent + MCP 工具；第二档同源回落） */
export async function askProjectAssistant(input: {
  projectPath: string;
  project: ProjectDto | null;
  question: string;
  history: readonly AssistantHistoryTurn[];
  focus: AssistantFocus | null;
  intent?: AssistantIntent;
  inspect?: boolean;
  /** 附的截图（Mesa 粘贴目录里的绝对路径） */
  images?: readonly string[];
  /** 用户此刻在看哪（assistant-dock.ts assistantWhere） */
  where?: string;
  /** 本次流式问答标识（面板点「停止」时按它调 project_assistant_cancel） */
  streamId?: string;
  /** 边生成边推来的更新：到此为止的回答（整段）/ 正在做的一步 */
  onStream?: (update: { text?: string; step?: string }) => void;
  /** 仅本次临时借用的连接（如当前连接不支持只读时，用户显式点借用） */
  overrideConnection?: { profileId: string; model: string | null; line: string } | null;
}): Promise<AssistantTurn> {
  const focus = input.focus ?? reviewingFocusHint(input.projectPath, input.question);
  const whereLabel = withReviewing(input.where, input.projectPath) ?? null;
  const baseConn = assistantConnection(input.project);
  const conn = input.overrideConnection
    ? {
        ...baseConn,
        profileId: input.overrideConnection.profileId,
        model: input.overrideConnection.model,
        line: `${input.overrideConnection.line}（本次借用只读）`,
        bound: true,
      }
    : baseConn;

  const streamId = input.streamId ?? crypto.randomUUID();
  const chat = async (profileId: string | null, model: string | null, connection: string, forceReadonly: boolean) => {
    const unlisten = input.onStream
      ? await listen<{ text?: string; step?: string }>(`assistant-stream-${streamId}`, (event) => input.onStream?.(event.payload))
      : null;
    try {
      return await invoke<AssistantTurn>("project_assistant_chat", {
        projectRoot: input.projectPath,
        profileId,
        model,
        connection,
        question: input.question,
        whereLabel,
        focusTitle: focus?.title ?? null,
        focusDetail: focus?.detail ?? null,
        streamId,
        images: input.images?.length ? input.images : null,
        forceReadonly,
      });
    } finally {
      unlisten?.();
    }
  };

  const forceReadonly = Boolean(input.inspect || input.overrideConnection);
  try {
    return await chat(conn.profileId, conn.model, conn.line, forceReadonly);
  } catch (reason) {
    if (String(reason).includes(ASSISTANT_CANCELLED)) throw reason;
    // 第二档连接不支持只读查看时退回仅依据真源上下文
    if (forceReadonly && !input.images?.length && String(reason).includes("INSPECT_UNSUPPORTED")) {
      return chat(conn.profileId, conn.model, conn.line, false);
    }
    if (!conn.profileId || conn.bound || !String(reason).includes("不支持无头调用")) throw reason;
    return chat(null, null, "设置里「AI 功能」的连接", forceReadonly);
  }
}
