import {
  MessageCircle,
  Pencil,
  Trash2,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  hoverRevealClass,
  inlineActionClass,
  primaryActionClass,
  RoleBadge,
  secondaryActionClass,
  InlineNotice,
} from "./PageFrame";
import { Modal } from "./Modal";
import StepEvidenceChip from "./StepEvidenceChip";
import StepFlow from "./StepFlow";
import FuseDraftModal from "./FuseDraftModal";
import { useAppStore } from "../store";
import { stepAttention } from "../run-overview";
import { toast } from "../toast";
import { readResearchFile, readResearchLedger } from "../research-report-load";
import { ReworkDialog, StepRoundsSection, type ReworkFields } from "./StepLoop";
import {
  coverageReworkDrafts,
  groupCoverageDrafts,
  followupFiles,
  followupPrompt,
  followupScale,
  followupConfirmText,
  catchUpConfirmText,
  notesFollowupIds,
  notesDroppedIds,
  unplacedCoverageDrafts,
  reworkTargets,
  withLatestNote,
  chainNext,
  commentReworkDrafts,
  commentsPrompt,
  searchRefreshDraft,
  searchRefreshHint,
  catchUpProbes,
  catchUpPrompt,
  type CatchUpProbe,
  type ReworkDto,
  type FollowupScopeDto,
} from "../step-loop";
import { bringLatest, stepBusy } from "../step-latest";
import { ROUND_CLAUSE, chainDefaultOff, stepKind } from "../step-kind";
import {
  assertRoundable,
  hasUnsavedRound,
  ensureActive,
  pickStepWorkspace,
  recordRound as recordStepRound,
  sendReworkRound,
  SESSION_STARTED_AT,
} from "../step-round";
import { workspaceReuseKey } from "../pipeline-start";
import {
  bucketCardsByStep,
  ideaTopicPlaceholder,
  topicCardsForStep,
  unstartedSeeds,
} from "../task-cards";
import { buildTaskMdPreview, buildWorkspaceTerminalRequest } from "../pipeline-start";
import { CONTINUE_RESUME_PROMPT, CONTINUE_STEP_PROMPT, isTaskMdStub, resolveTaskMdSource } from "../step-decisions";
import { DEFAULT_KICKOFF_PROMPT } from "../pipeline-presets";
import { continueRoute, pickWorkspaceResume } from "../workspace-resume";
import { filterProjectSessions } from "../project-status";
import { pickDiscussResume } from "../step-flow";
import { IS_WINDOWS } from "../hotkeys";
import { composeRelayPrompt } from "../chat-relay";
import { AGENTS } from "../types";
import {
  projectAgentLaunch,
  resolveStepLaunch,
  stepSlotKey,
  taskBindingLaunch,
  DISCUSS_BINDING_SLOT,
} from "../project-agents";
import type {
  GitCommitResultDto,
  GitFileDto,
  ProjectConfigDto,
  ProjectStepDto,
  TaskCardDto,
  TaskDraftDto,
  WorkspaceDto,
} from "../types";
import { isSettingPlaceholder } from "../project-context";
import { upsertPendingSettingsSection } from "../task-md-sections";
import { researchToolAskFieldsForStep, researchToolsFromSettings, type ResearchTools } from "../research-tools";
import { stepFillsAnySlot, useSkillProvides } from "../skill-slots.ts";
import { statusBadgeTitle, userWorkDirtyFiles } from "../git-status-groups";
import {
  historySaveBlockedReason,
  historySaveMessage,
  historySavePaths,
} from "../main-history-save";
import FileTypeMark from "./FileTypeMark";

const actionBtn = inlineActionClass;
const fieldSm =
  "h-7 rounded-md border border-field bg-canvas px-2 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4";

/** 认领登记的 Agent：与终端启动栏的种子口径一致（ccode.lastLaunch → claude-code 兜底）。
 *  用户在启动栏临时换了 Agent 时登记会落空——静默降级，事后仍可在对话页手动归卡 */
function launchBarAgent(): string {
  try {
    const saved = JSON.parse(
      localStorage.getItem("ccode.lastLaunch") ?? "{}",
    ) as Partial<{ agentId: string }>;
    return saved.agentId ?? "claude-code";
  } catch {
    return "claude-code";
  }
}

/**
 * 话题区（项目详情，流水线步进器下方）：卡片 = 对话的归档文件夹（任务书沉淀统一走草稿）。
 * 恒为单步骤聚焦视图（v3.81 起无总览态）：头部 ‹ › 箭头与步进器大圆同口径切步骤；
 * 行主动作 = 聊想法（未绑工作区）/ 开工（挂步骤的卡，走一键开步链路）/ 继续（已绑工作区，开终端预填 CONTINUE_STEP_PROMPT）。
 * 展开手风琴按卡片 id 记忆在本组件内——ProjectGroup 以项目 key 挂载，切项目自然清空。
 */
/** 「AI 干活」下一行的回头入口（2026-11-10 用户：「补充文献和跟进按钮挤在一块，看着很乱」）：一律同一种文字链接、中间点隔开，
 *  不再一个下划线虚线、一个带框按钮混排；眼下有事可做的（跟进、补读）排前面、字重一点，随时可用的工具在后 */
const LOOP_TOOL = "shrink-0 rounded-sm text-xs text-l3 underline-offset-2 hover:text-l1 hover:underline disabled:opacity-50";
const LOOP_PENDING = "shrink-0 rounded-sm text-xs font-medium text-l1 underline-offset-2 hover:underline disabled:opacity-50";

function loopRow(items: ReactNode[]): ReactNode {
  const list = items.filter(Boolean);
  if (list.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {list.map((el, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span aria-hidden="true" className="text-xs text-l4">
              ·
            </span>
          )}
          {el}
        </Fragment>
      ))}
    </span>
  );
}

export default function TaskCardsSection({
  projectPath,
  steps,
  cfg,
  workspaces,
  refreshToken,
  mainDirty,
  focusStep,
  focusStatusText,
  focusRunStatus,
  stepKeys,
  focusAgentAttention,
  focusRunId,
  reviewConflict,
  onRestoreWorkspace,
  onFocusIndex,
  onHumanChanged,
  onWorkspacesChanged,
  onStartStep,
  onReadPaper,
  readPaperPrimary,
  focusDraft,
  focusDraftError,
  onDraftChanged,
  onOpenResources,
  onSetLitSource,
  litBusy,
  onSetResearchTool,
  toolBusy,
  onMainDirtyRefresh,
  preferredAgent,
  preferredProfile,
  preferredModel,
  taskBindings = null,
}: {
  projectPath: string;
  steps: ProjectStepDto[];
  /** 项目档案卡（步骤级「预览 TASK.md」拼装用，renderTaskMd 同一出处） */
  cfg: ProjectConfigDto;
  workspaces: WorkspaceDto[];
  /** 页面刷新令牌：评审沉淀等页外写入后随刷新重读 */
  refreshToken: number;
  /** 项目文件夹里未存入历史的改动数（null = 非 git 仓库/未知）：非零时标题行右侧提醒。
   *  「主仓/未提交」是 git 术语，用户看不懂——文案按 user-guide 术语表走白话（提交 = 存入历史） */
  mainDirty: number | null;
  /** 就地存进历史成功后，父级重读 git_status 计数 */
  onMainDirtyRefresh?: () => void;
  /** 步骤聚焦（v3.70）：聚焦步骤名；null = 项目无研究步骤（只显示「未挂步骤」桶） */
  focusStep?: string | null;
  /** 聚焦步骤的状态白话短语（聚焦头部用；由父级 describeStep 口径派生） */
  focusStatusText?: string | null;
  /** 聚焦步骤的执行状态（v3.71 流程线用；由父级从工作区派生——健康/漂移数据在本组件外） */
  focusRunStatus?: "pending" | "active" | "review" | "done";
  /** 每一步此刻的状态（按 steps 顺序；补料链只把已完成的步骤放进链，流程贯通 §6） */
  stepKeys?: string[];
  /** 聚焦步骤工作区内终端的注意力（stepAttention 口径）：done 时流程线 Agent 节点给「已跑完」提示 */
  focusAgentAttention?: "confirm" | "done" | "working" | null;
  focusRunId?: string | null;
  /** 聚焦步骤处于合并冲突阻塞：流程线评审节点入口改为「去处理冲突」 */
  reviewConflict?: boolean;
  /** 聚焦步骤的工作区已归档：流程线 Agent 节点主入口改为「恢复工作区」 */
  onRestoreWorkspace?: () => void;
  /** 头部 ‹ › 箭头切换聚焦步骤（与步进器大圆点击同一口径） */
  onFocusIndex?: (index: number) => void;
  /** 人工事项勾选/交付后通知父级（流程线橙点与 ⋯ 菜单计数重取） */
  onHumanChanged?: () => void;
  /** 回路动作（补料、跟进）改了工作区或轮次记录后重读工作区列表：「待跟进」等状态要立刻跟上 */
  onWorkspacesChanged?: () => void;
  /** 卡片「开工」：打开开工确认弹层（originCardId = 出处卡）；返回 Promise 供行内 busy 态跟随 */
  onStartStep: (index: number, originCardId?: string) => Promise<void> | void;
  onReadPaper?: () => void;
  readPaperPrimary?: boolean;
  /** 聚焦步骤的任务书草稿（v3.72；ProjectGroup 单一加载点下发）：discuss 节点状态与「聊任务书」指令用 */
  focusDraft?: { relPath: string; text: string | null } | null;
  /** 任务书读失败时的原因。有正文时不显示。 */
  focusDraftError?: string | null;
  /** 「◈ 沉淀进任务书」落盘后回调：ProjectGroup 即刻重读 focusDraft（不等页面刷新） */
  onDraftChanged?: () => void;
  /** 展开「文献与数据」面板：流程线里的文献类交付统一引到那里（focus 高亮对应进料入口） */
  onOpenResources?: (focus?: "zotero" | "files") => void;
  /** 输入准备（v3.86）：透传给流程线「定方向」节点的文献来源选择与就地导入 */
  onSetLitSource?: (value: string) => void | Promise<void>;
  litBusy?: boolean;
  onSetResearchTool?: (key: keyof ResearchTools, value: string) => void | Promise<void>;
  toolBusy?: boolean;
  /** 项目 Agents 页的默认 Agent / 绑定 / 模型；新会话和「跟 AI 商量一下」用这份。 */
  preferredAgent?: string | null;
  preferredProfile?: string | null;
  preferredModel?: string | null;
  /** 项目槽位专属绑定（B1 步骤槽）：聚焦步骤的商量/继续与卡片「继续」优先用 step:<名> */
  taskBindings?: Record<string, { profile: string; model?: string | null }> | null;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const preferredAgentTrimmed = preferredAgent?.trim() ?? "";
  const preferredProfileTrimmed = preferredProfile?.trim() ?? "";
  const preferredModelTrimmed = preferredModel?.trim() ?? "";
  const projectLaunch = useMemo(
    () =>
      projectAgentLaunch(
        profiles,
        preferredAgentTrimmed,
        preferredAgentTrimmed && preferredProfileTrimmed
          ? { [preferredAgentTrimmed]: preferredProfileTrimmed }
          : null,
        preferredAgentTrimmed && preferredModelTrimmed
          ? { [preferredAgentTrimmed]: preferredModelTrimmed }
          : null,
      ),
    [profiles, preferredAgentTrimmed, preferredProfileTrimmed, preferredModelTrimmed],
  );
  /** 商量层（B4）：discuss 槽 ?? 项目默认——聊想法/问 AI/任务书讨论/MCP 登录的
   *  统一偏好（2026-10-15 用户拍板：商量类不吃步骤绑定，全项目一致）。
   *  绑定解析与失效回落收敛在 taskBindingLaunch（绑定失联→null→回落项目默认） */
  const discussLaunch = useMemo(
    () =>
      taskBindingLaunch(profiles, taskBindings?.[DISCUSS_BINDING_SLOT]) ??
      projectLaunch,
    [profiles, taskBindings, projectLaunch],
  );
  /** 步骤启动三元组（B1）：按步骤名现解析——步骤槽 ?? **discussLaunch**（B4 后中间层
   *  是 discuss）。只喂**执行面**（卡片「继续」＝在工作树里继续做到完成标准） */
  function stepLaunchFor(stepName: string | null | undefined) {
    return stepName
      ? resolveStepLaunch(profiles, taskBindings, stepName, discussLaunch)
      : discussLaunch;
  }
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  const cards = useAppStore((s) => s.taskCards[projectPath]);
  const sessions = useAppStore((s) => s.sessions);
  const discussResumeSession = pickDiscussResume(
    filterProjectSessions(sessions, projectPath, [], { isWindows: IS_WINDOWS }),
    focusStep ?? "",
  );
  const discussed = discussResumeSession != null;
  const discussResume = discussResumeSession
    ? {
        agentId: discussResumeSession.agent,
        sessionId: discussResumeSession.sessionId,
        provider: discussResumeSession.provider,
        cwd: discussResumeSession.cwd ?? discussResumeSession.projectPath,
      }
    : null;
  const loadTaskCards = useAppStore((s) => s.loadTaskCards);
  const createCard = useAppStore((s) => s.createCard);
  const renameCard = useAppStore((s) => s.renameCard);
  const deleteCard = useAppStore((s) => s.deleteCard);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  // 聊想法固定只读开聊（2026-10-26 用户拍板收掉「想法期只读保护」开关）：当前启动栏 Agent 没有只读参数
  // （或版本太旧的 Qwen / OpenCode）时启动会被拒绝，想法区先如实标注一句。
  // 能力位来自后端 detect_agents（与 agent_specs 注册表同一出处，不在前端另抄一份名单）
  const detected = useAppStore((s) => s.agents);
  const guardAgentId = launchBarAgent();
  const guardAgentLabel =
    AGENTS.find((a) => a.id === guardAgentId)?.label ?? guardAgentId;
  // 探测结果还没回来时按「有硬保护」显示：不在加载中途闪一条吓人的警告
  const guardHard =
    detected?.find((a) => a.id === guardAgentId)?.readonlySupported ?? true;
  const skillProvides = useSkillProvides();
  /** 找文献 / 读文献的步骤（按技能槽认，引擎不认模板）：退回它叫「补料」，其余叫「修改」 */
  const isLitStep = (st: ProjectStepDto) => stepFillsAnySlot(st.skills, ["lit-search", "lit-notes"], skillProvides);
  const [error, setError] = useState<string | null>(null);
  // 综述回路二期：补料单弹层与跟进在途（design-review-loop.md §4/§5）
  const [reworkOpen, setReworkOpen] = useState(false);
  const [reworkBusy, setReworkBusy] = useState(false);
  const [reworkError, setReworkError] = useState<string | null>(null);
  const [reworkPrefill, setReworkPrefill] = useState<Record<string, { topics: string; reason: string }>>({});
  // 覆盖检查里归不到退回目标的薄节：补料单上单列给人看
  const [reworkUnplaced, setReworkUnplaced] = useState<string[]>([]);
  // 整张预填（定稿前更新检索）：给了就按它开，不按覆盖检查换主题
  const [reworkInitial, setReworkInitial] = useState<{ target: string; topics: string; reason: string; clues: string; scale: number | null } | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  /** 继续时上次会话是另一家 Agent：问要不要带简报。取消 = 先不开。 */
  const [carryAsk, setCarryAsk] = useState<{
    fromAgent: string;
    fromSessionId: string;
    filePath: string;
    sessionTitle: string | null;
    launch: { agentId: string; profileId: string; model: string };
    ws: WorkspaceDto;
    title: string;
    card: TaskCardDto | null;
    /** 开始前并进来的新内容（附在开场指令后面） */
    incoming: string[];
  } | null>(null);
  const [carryBusy, setCarryBusy] = useState(false);
  const [carryError, setCarryError] = useState<string | null>(null);
  useEffect(() => {
    if (!carryAsk) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !carryBusy) setCarryAsk(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [carryAsk, carryBusy]);
  const [dirtyOpen, setDirtyOpen] = useState(false);
  const [dirtyFiles, setDirtyFiles] = useState<GitFileDto[]>([]);
  const [dirtyMerging, setDirtyMerging] = useState(false);
  const [dirtyLoading, setDirtyLoading] = useState(false);
  const [dirtySaving, setDirtySaving] = useState(false);
  const [dirtyError, setDirtyError] = useState<string | null>(null);
  // 新建内联表单（「未挂步骤」桶的「＋ 添加想法」）
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    card: TaskCardDto;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 想法区（聚焦态专属）：新建内联表单 + 沉淀弹层目标卡
  const [ideaFormOpen, setIdeaFormOpen] = useState(false);
  const [ideaName, setIdeaName] = useState("");
  const [fusing, setFusing] = useState<TaskCardDto | null>(null);

  useEffect(() => {
    let stale = false;
    loadTaskCards(projectPath).catch((e) => {
      if (!stale) setError(String(e));
    });
    return () => {
      stale = true;
    };
  }, [projectPath, refreshToken, loadTaskCards]);

  useEffect(() => {
    if (mainDirty === null || mainDirty === 0) {
      setDirtyOpen(false);
      setDirtyFiles([]);
      setDirtyError(null);
    }
  }, [mainDirty]);

  useEffect(() => {
    if (!dirtyOpen) return;
    let stale = false;
    setDirtyLoading(true);
    setDirtyError(null);
    invoke<{ isRepo: boolean; files: GitFileDto[]; merging?: boolean }>(
      "git_status",
      { cwd: projectPath },
    )
      .then((status) => {
        if (stale) return;
        setDirtyFiles(status.isRepo ? userWorkDirtyFiles(status.files) : []);
        setDirtyMerging(status.merging === true);
      })
      .catch((reason) => {
        if (!stale) setDirtyError(String(reason));
      })
      .finally(() => {
        if (!stale) setDirtyLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [dirtyOpen, projectPath, refreshToken]);

  // 分桶只服务「未挂步骤」桶（失效步骤的卡也并入此桶）；聚焦步骤的讨论入口在流程线 chips
  const buckets = bucketCardsByStep(
    cards ?? [],
    steps.map((s) => s.name),
  );
  const unattached = buckets.find((b) => b.step === null);
  /** 聚焦步骤的话题卡（讨论的唯一清单：种子开聊的、决策项开聊的、手动加的都在这儿） */
  const ideaCards = focusStep ? topicCardsForStep(cards ?? [], focusStep) : [];
  /** 聚焦步骤的声明（人工事项清单/种子用）与序号（头部 ‹ › 箭头用）；聚焦名失效（步骤被删/改名）时 null/-1 */
  const focusStepDto = focusStep
    ? (steps.find((s) => s.name === focusStep) ?? null)
    : null;
  const focusIdx = focusStepDto
    ? steps.findIndex((s) => s.name === focusStepDto.name)
    : -1;
  /** 补读（2026-11-10）：已保存的精读步里原来没有全文、papers/ 后来有了的篇。下载多在浏览器里做，回到窗口时再对一次 */
  const [catchUp, setCatchUp] = useState<{ probe: CatchUpProbe; pdf: string }[]>([]);
  const [catchUpTick, setCatchUpTick] = useState(0);
  const catchUpStep =
    focusStepDto && focusRunStatus === "done" && stepFillsAnySlot(focusStepDto.skills, ["lit-notes"], skillProvides)
      ? focusStepDto.name
      : null;
  useEffect(() => {
    if (!catchUpStep) return;
    const onFocus = () => setCatchUpTick((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [catchUpStep]);
  useEffect(() => {
    setCatchUp([]);
    if (!catchUpStep) return;
    let stale = false;
    void (async () => {
      const inc = await readResearchLedger(projectPath, "papers/included.json").catch(() => null);
      const idx = await readResearchLedger(projectPath, "notes/index.json").catch(() => null);
      if (!inc || inc.truncated || !idx || idx.truncated) return;
      const probes = catchUpProbes(inc.text, idx.text) ?? [];
      if (probes.length === 0) return;
      const names = await invoke<(string | null)[]>("to_fetch_progress", {
        projectRoot: projectPath,
        items: probes.map((p) => ({ title: p.title, url: p.url })),
      }).catch(() => [] as (string | null)[]);
      if (stale) return;
      setCatchUp(probes.flatMap((probe, i) => (names[i] ? [{ probe, pdf: names[i] as string }] : [])));
    })();
    return () => {
      stale = true;
    };
  }, [catchUpStep, projectPath, refreshToken, catchUpTick]);
  /** 精读还没读的新纳入篇（项目里的纳入清单 vs 这一步工作副本的索引）。「待跟进」只看有没有并入：解冲突、「继续」并入后
   *  标记就消了，AI 却没读新篇（2026-11-10 HER：解完冲突「待跟进」没了，新加的 2 篇没人读）。有就照样给「跟进更新」 */
  const [unreadNew, setUnreadNew] = useState(0);
  const unreadStep =
    focusStepDto && (focusRunStatus === "done" || focusRunStatus === "review") && stepFillsAnySlot(focusStepDto.skills, ["lit-notes"], skillProvides)
      ? focusStepDto
      : null;
  const unreadWorktree = unreadStep ? pickStepWorkspace(workspaces, projectPath, unreadStep) : undefined;
  const unreadRoot = unreadWorktree?.status === "active" ? unreadWorktree.worktreePath : null;
  useEffect(() => {
    setUnreadNew(0);
    if (!unreadStep) return;
    let stale = false;
    void (async () => {
      const inc = await readResearchLedger(projectPath, "papers/included.json").catch(() => null);
      const idx =
        (unreadRoot ? await readResearchLedger(unreadRoot, "notes/index.json").catch(() => null) : null) ??
        (await readResearchLedger(projectPath, "notes/index.json").catch(() => null));
      // 没有索引（还没开读）不算：那是第一轮，不是跟进
      if (stale || !inc || inc.truncated || !idx || idx.truncated) return;
      setUnreadNew(notesFollowupIds(inc.text, idx.text)?.length ?? 0);
    })();
    return () => {
      stale = true;
    };
  }, [unreadStep?.name, unreadRoot, projectPath, refreshToken, catchUpTick]);
  const dirtyBlocked = historySaveBlockedReason(dirtyFiles, dirtyMerging);
  /** 想法区零态入口（「＋ 话题」）是否常显：有卡 → 常现（管理已有讨论）；
   *  无卡 → 仅 role=you 的步骤常显（人主导的步骤开放讨论最有价值，如综述大纲聊角度/创新点）。
   *  纯执行步骤（检索/清洗等 role≠you 且无卡）不显示——多个没约束对象的入口只会让人问「这是干嘛的」；
   *  那些步骤要么有种子 chip 建首卡，要么真不需要想法（2026-08-20 两轮实测拍板） */
  const showIdeaEntry = ideaCards.length > 0 || focusStepDto?.role === "you";
  /** 还没开聊过的预置话题（讨论种子）：开过的已经在话题清单里，不再出 chip */
  const openSeeds = focusStepDto
    ? unstartedSeeds(
        cards ?? [],
        focusStepDto.name,
        focusStepDto.discussionSeeds ?? [],
      )
    : [];

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    setError(null);
    try {
      // 未挂步骤的卡无步骤语境，只建卡归档（挂步骤的话题从流程线「＋ 自定义话题」走 onSeed 口径）
      await createCard(projectPath, name, null);
      setCreatingIn(null);
      setDraftName("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 想法区「＋ 聊个话题」：kind=idea、挂当前聚焦步骤；不开聊，只建卡 */
  async function submitCreateIdea(e: React.FormEvent) {
    e.preventDefault();
    if (!focusStep) return;
    const name = ideaName.trim();
    if (!name) return;
    setError(null);
    try {
      await createCard(projectPath, name, focusStep, "idea");
      setIdeaFormOpen(false);
      setIdeaName("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    if (!renaming || !renaming.name.trim()) return;
    setError(null);
    try {
      await renameCard(projectPath, renaming.id, renaming.name.trim());
      setRenaming(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function onDelete(card: TaskCardDto) {
    if (
      !(await confirmDialog(
        `删除卡片「${card.name}」？\n\n里面的对话不删，只是移出卡片。`,
        { danger: true },
      ))
    )
      return;
    setError(null);
    try {
      await deleteCard(projectPath, card.id);
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 从卡片发起聊天前登记认领（claim_next_session_for_card：该项目的下一个新会话自动归卡）。
   *  cwd 一律用项目根——工作区内会话的 project_path 已被后端改写为真实仓库，认领照样命中。
   *  登记的 Agent 必须与实际拉起的一致（认领键 = agent+cwd，登记别家 Agent 会认领落空）——
   *  B1 参数化：调用方传各自语境的 launch（onContinue 传 stepLaunch，onDiscuss 暂传
   *  projectLaunch、B4 换 discussLaunch）；开工（onStart）维持预测，spawn 时按最终值
   *  claim_next_session_for_step 兜底。
   *  登记失败静默降级：不阻断开终端，会话事后可在对话页手动归卡 */
  function claimForCard(
    card: TaskCardDto,
    launch?: { agentId?: string } | null,
  ) {
    invoke("claim_next_session_for_card", {
      agent: launch?.agentId ?? projectLaunch?.agentId ?? launchBarAgent(),
      cwd: projectPath,
      taskId: card.id,
    }).catch(() => {});
  }

  /** 聊想法（idea 卡专用——想法区行内主按钮与 ⋯ 菜单；draft 卡的讨论并入 onSeed 草稿口径）：项目根开终端（不建工作区——想法期不动手）。
   *  固定只读开聊（2026-10-26 收掉「想法期只读保护」开关与「允许改文件」单次豁免：关掉 = AI 在项目根直接改文件、
   *  没有验收；真要改，在聊天里换权限重开）：预填指令带不动文件约束 + 只讨论（后端对支持的 CLI 注入只读/计划模式参数
   *  ——硬保护；discussOnly = 方案卡不给开工）。
   *  预填指令还要给「该动手了」一个明确出口（回项目页开工/商量）——只读约束管得住文件、
   *  管不住 Agent 在项目根读到 project.toml 与草稿后主动请缨开工；没有出口话术，
   *  它会把「用户点头」当成在主仓直接产出的授权（实测：聊想法会话里 Agent 问「要现在开 outline 吗」）。
   *  kimi 无启动注入参数：启动栏保留指令文本由用户手动发送（promptDropped 既有处理） */
  function onDiscuss(card: TaskCardDto, topic?: string) {
    claimForCard(card, discussLaunch);
    const opening = topic
      ? `我想跟你探讨「${card.name}」里的待拍板问题：${topic}`
      : `我想跟你探讨：${card.name}`;
    setPendingTerminal({
      cwd: projectPath,
      extraEnv: {},
      title: card.name,
      readonly: true,
      permission: "discuss",
      discussOnly: true,
      initialPrompt: `${opening}。注意：现在只讨论方案，不要修改/新建/删除任何文件，也不要在这里产出任何步骤产物（哪怕我点头）——聊到该动手的程度时，提醒我回项目页点「开工」或「跟 AI 商量一下」，那边会在独立工作区里执行。`,
      ...(discussLaunch ?? {}),
      autoStart: Boolean(discussLaunch?.profileId),
    });
    setPage("terminal");
  }

  /** 开工：挂步骤的卡打开开工确认弹层（TASK.md 预览编辑，草稿优先），确认后才建工作区 */
  function onStart(card: TaskCardDto) {
    const index = steps.findIndex((s) => s.name === card.step);
    if (index < 0 || busyId) return;
    claimForCard(card);
    setBusyId(card.id);
    void Promise.resolve(onStartStep(index, card.id))
      .catch(() => {})
      .finally(() => setBusyId(null));
  }

  /** 开聊一个话题（种子 chip / 决策项「开聊」/ 手动加的话题共用；已有同名卡则续聊）。
   *  与「聊想法」同一口径：**只读开聊**，结论不由 Agent 直接落盘，
   *  聊完走「◈ 沉淀进任务书」提炼后追加——讨论入口只此一条，
   *  「让 Agent 直接改草稿」由 discuss 节点的「跟 Agent 聊任务书」单独承担，两者不再重叠 */
  async function onSeed(stepName: string, seed: string, topic?: string) {
    setError(null);
    try {
      const existing = (cards ?? []).find((c) => c.name === seed);
      const card =
        existing ?? (await createCard(projectPath, seed, stepName, "idea"));
      onDiscuss(card, topic);
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 要看 diff 才去运行页改动面板；一键存进历史不走这里。 */
  function openMainChanges() {
    setPendingTerminal({
      cwd: projectPath,
      extraEnv: {},
      title: "主仓改动",
      shellOnly: true,
      rightTab: "git",
    });
    setPage("terminal");
  }

  async function saveMainHistory() {
    const blocked = historySaveBlockedReason(dirtyFiles, dirtyMerging);
    if (blocked) {
      setDirtyError(blocked);
      return;
    }
    setDirtySaving(true);
    setDirtyError(null);
    try {
      await invoke<GitCommitResultDto>("git_commit", {
        cwd: projectPath,
        message: historySaveMessage(focusStep, dirtyFiles),
        push: false,
        paths: historySavePaths(dirtyFiles),
      });
      setDirtyOpen(false);
      setDirtyFiles([]);
      onMainDirtyRefresh?.();
    } catch (reason) {
      setDirtyError(String(reason));
    } finally {
      setDirtySaving(false);
    }
  }

  /** 卡片上写了 workspace 就用它；否则按卡片步骤名找这一步的活跃工作区。
   *  建卡不写 workspace（字段预留未填），步骤开工后「继续」仍要找得到工作树。 */
  function activeWorkspaceFor(stepName: string | null | undefined, workspaceName?: string | null) {
    const named = workspaceName
      ? workspaces.find((w) => w.name === workspaceName && w.status === "active")
      : undefined;
    if (named) return named;
    if (!stepName) return undefined;
    const step = steps.find((s) => s.name === stepName);
    if (!step?.workspaceName) return undefined;
    return workspaces.find((w) => w.name === step.workspaceName && w.status === "active");
  }

  /** 继续：上次的工作区对话是同一家 Agent 就接回它（2026-10-22 用户拍板，进度与上下文不丢），预填 CONTINUE_RESUME_PROMPT；
   *  没有可接的、或 fresh（「新开一轮」）才在工作树里新开，预填 CONTINUE_STEP_PROMPT；工作区里一段对话都没有时预填开工指令。
   *  上次是另一家先问要不要带接力简报。
   *  配置现读数据库 step:步骤名，失败再走 props（步骤槽 > discuss > 项目默认）。
   *  kimi 无启动注入参数：终端等输入框就绪后自动写入（TerminalView launch 的 promptDropped 分支） */
  async function openStepContinuation(
    stepName: string | null | undefined,
    ws: WorkspaceDto,
    title: string,
    card?: TaskCardDto | null,
    fresh = false,
  ) {
    let launch: { agentId: string; profileId: string; model: string } | null = null;
    if (stepName) {
      try {
        const b = await invoke<{ profile: string; model?: string | null } | null>(
          "get_project_agent_binding",
          { projectRoot: projectPath, slot: stepSlotKey(stepName) },
        );
        launch = taskBindingLaunch(useAppStore.getState().profiles, b);
      } catch {
        /* DB 读失败走 props 链 */
      }
    }
    if (!launch?.profileId) launch = stepLaunchFor(stepName);
    if (!launch?.profileId) {
      setError("还没解析到可用连接：去「Agent 分工」页签给这一步绑一条，或确认项目默认 Agent 有连接。");
      return;
    }
    // 先把项目最新内容并进来（2026-11-06 流程贯通 §3）：后面步骤保存的笔记、大纲，这一步的 AI 接着做时就在手边
    let incoming: string[] = [];
    try {
      const got = await bringLatest(ws, stepName ?? title, confirmDialog, "接着做");
      if (got === null) return;
      incoming = got;
      if (got.length > 0) onWorkspacesChanged?.();
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
      return;
    }
    try {
      await useAppStore.getState().loadSessions();
    } catch {
      /* 用已加载的会话列表判断要不要问 */
    }
    const route = continueRoute(
      useAppStore.getState().sessions,
      ws.name,
      ws.repoPath,
      launch.agentId,
      fresh,
    );
    if (route.kind === "resume") {
      try {
        await resumeContinuation(launch, ws, title, card, incoming);
      } catch (reason) {
        setError(String(reason));
      }
      return;
    }
    if (route.kind === "carry") {
      const prior = route.source;
      setCarryError(null);
      setCarryAsk({
        fromAgent: prior.agent,
        fromSessionId: prior.sessionId,
        filePath: prior.filePath,
        sessionTitle: prior.title,
        launch,
        ws,
        title,
        card: card ?? null,
        incoming,
      });
      return;
    }
    try {
      // 工作区里一段对话都没有：上次开工 AI 没收到指令，这次发完整开工指令（写作红线、MCP 盘点、不读 CLI 配置都在里面）
      const prompt = route.kind === "first" ? DEFAULT_KICKOFF_PROMPT : CONTINUE_STEP_PROMPT;
      await launchContinuation(launch, ws, title, withLatestNote(prompt, incoming), card);
      // 「这一步的几轮」要知道这一轮是人点的新开一轮：真开起来了才记（没连接、接力框取消都不记）
      if (fresh && stepName) void recordRound(ws, stepName, "fresh");
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 接回这一步上次的工作区对话（同一家 Agent）：resume + 下一句接着做；步骤绑定只作连接预填 */
  async function resumeContinuation(
    launch: { agentId: string; profileId: string; model: string },
    ws: WorkspaceDto,
    title: string,
    card?: TaskCardDto | null,
    incoming: string[] = [],
  ) {
    if (card) claimForCard(card, launch);
    const req = await buildWorkspaceTerminalRequest(ws, withLatestNote(CONTINUE_RESUME_PROMPT, incoming), {
      autoStart: true,
      resumeSession: true,
      stepLaunch: launch,
    });
    setPendingTerminal({ ...req, title: req.title || title, surface: "terminal" });
    setPage("terminal");
  }

  /** 新开一轮：不 resume。仍用这个工作区的复用键——同一步只有一个终端标签（2026-10-22：
   *  不带键时这个标签之后「去终端回答」认不出，又开一个）；闲着的旧标签就地换成新一轮。
   *  prompt 可以是完成标准，或先读简报再完成标准。 */
  async function launchContinuation(
    launch: { agentId: string; profileId: string; model: string },
    ws: WorkspaceDto,
    title: string,
    prompt: string,
    card?: TaskCardDto | null,
  ) {
    if (card) claimForCard(card, launch);
    const req = await buildWorkspaceTerminalRequest(ws, prompt, {
      autoStart: true,
      stepLaunch: launch,
    });
    setPendingTerminal({
      cwd: req.cwd,
      extraEnv: req.extraEnv,
      title: req.title || title,
      reuseKey: req.reuseKey,
      agentId: launch.agentId,
      profileId: launch.profileId,
      model: launch.model,
      initialPrompt: prompt,
      autoStart: true,
    });
    setPage("terminal");
  }

  /** 带上上次对话：走聊天里「换 Agent」同一套接力（relay_prepare 写交接简报、按简报文件名记接力关系），
   *  第一句 = 接力抬头 + 这一步的完成标准；聊天里有「前面由谁做」那张卡，侧栏并成一行 */
  async function carryAndContinue() {
    const ask = carryAsk;
    if (!ask || carryBusy) return;
    setCarryBusy(true);
    setCarryError(null);
    try {
      const prepared = await invoke<{ framing: string | null }>("relay_prepare", {
        source: {
          agent: ask.fromAgent,
          sessionId: ask.fromSessionId,
          filePath: ask.filePath,
          cwd: ask.ws.worktreePath,
          title: ask.sessionTitle,
        },
        targetAgent: ask.launch.agentId,
        resumeSession: null,
        withWords: true,
      });
      if (!prepared.framing) throw new Error("没能写出交接简报");
      const prompt = composeRelayPrompt(prepared.framing, withLatestNote(CONTINUE_STEP_PROMPT, ask.incoming));
      await launchContinuation(ask.launch, ask.ws, ask.title, prompt, ask.card);
      setCarryAsk(null);
    } catch (reason) {
      setCarryError(String(reason));
    } finally {
      setCarryBusy(false);
    }
  }

  async function continueWithoutCarry() {
    const ask = carryAsk;
    if (!ask || carryBusy) return;
    setCarryBusy(true);
    setCarryError(null);
    try {
      await launchContinuation(
        ask.launch,
        ask.ws,
        ask.title,
        withLatestNote(CONTINUE_STEP_PROMPT, ask.incoming),
        ask.card,
      );
      setCarryAsk(null);
    } catch (reason) {
      setCarryError(String(reason));
    } finally {
      setCarryBusy(false);
    }
  }

  /** 「去终端看看」：带 reuseKey 交接——命中在跑标签只聚焦，不另起会话 */
  function goWorkspaceTerminal(ws: WorkspaceDto) {
    setPendingTerminal({
      cwd: ws.worktreePath,
      extraEnv: {},
      title: ws.name,
      reuseKey: workspaceReuseKey(ws),
      surface: "terminal",
    });
    setPage("terminal");
  }

  function onContinue(card: TaskCardDto, fresh = false) {
    const ws = activeWorkspaceFor(card.step, card.workspace);
    if (!ws) return;
    void openStepContinuation(card.step, ws, card.name, card, fresh);
  }

  function continueFocusedStep(fresh = false) {
    if (!focusStepDto) return;
    const ws = activeWorkspaceFor(focusStepDto.name, focusStepDto.workspaceName);
    if (!ws) return;
    void openStepContinuation(focusStepDto.name, ws, focusStepDto.name, null, fresh);
  }

  function recordRound(ws: WorkspaceDto, step: string, kind: "rework" | "followup" | "fresh" | "ack" | "comments" | "catchup", reworkId?: string) {
    // 真开了新一轮（不是 ack）：这一步手动打的勾清掉，回到按落点检测，新一轮的条目与面板才会出来
    return recordStepRound(projectPath, ws, step, kind, reworkId).then(() => onHumanChanged?.());
  }

  /** 补料轮 / 跟进轮用哪条连接：步骤绑定 > 步骤槽链（同「继续」）；都没有报错 */
  async function loopLaunch(stepName: string) {
    let launch: { agentId: string; profileId: string; model: string } | null = null;
    try {
      const b = await invoke<{ profile: string; model?: string | null } | null>(
        "get_project_agent_binding",
        { projectRoot: projectPath, slot: stepSlotKey(stepName) },
      );
      launch = taskBindingLaunch(useAppStore.getState().profiles, b);
    } catch {
      /* DB 读失败走 props 链 */
    }
    if (!launch?.profileId) launch = stepLaunchFor(stepName);
    if (!launch?.profileId) {
      throw new Error(`「${stepName}」还没解析到可用连接：去「Agent 分工」页签给它绑一条，或确认项目默认 Agent 有连接。`);
    }
    return launch;
  }

  /** 导入 Word 批注（科研流程补全 §4）：人选 .docx → 拦在忙的 → 并入项目最新 → 后端抽批注写意见清单进这一步的工作副本并提交 →
   *  在这一步另开一轮处理意见（AI 填类别 / 去向 / 处理，上游的事走退回）→ 记「意见轮」 */
  async function importComments() {
    const step = focusStepDto;
    const found = step ? stepWorkspace(step) : undefined;
    if (!step || !found) return;
    setError(null);
    try {
      const picked = await openFileDialog({ multiple: false, directory: false, filters: [{ name: "Word", extensions: ["docx"] }] });
      const docxPath = typeof picked === "string" ? picked : null;
      if (!docxPath) return;
      const launch = await loopLaunch(step.name);
      const ws = await ensureActive(found, step.name);
      // 已保存的步骤开新一轮要先干净；做到一半 / 待评审的就接着在这一步里处理
      if (focusRunStatus === "done") await assertRoundable(ws, step.name);
      else if (stepBusy(ws)) throw new Error(`「${step.name}」的 AI 正在干活或等你确认：等它这一轮停下再导入批注。`);
      if ((await bringLatest(ws, step.name, confirmDialog, "处理意见")) === null) return;
      const got = await invoke<{ relPath: string; count: number }>("docx_comments_import", { worktree: ws.worktreePath, docxPath });
      const name = docxPath.split(/[\\/]/).pop() ?? "批注稿.docx";
      await invoke("git_commit", { cwd: ws.worktreePath, message: `导入 Word 批注：${name}`, push: false, paths: [got.relPath] });
      const d = new Date();
      await launchContinuation(launch, ws, step.name, commentsPrompt(got.relPath, got.count, `${d.getMonth() + 1}-${d.getDate()}`));
      await recordRound(ws, step.name, "comments");
      onWorkspacesChanged?.();
      toast(`抽出 ${got.count} 条批注，写进 ${got.relPath}；这一步另开了一轮逐条处理。`, "info");
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  }

  /** 打开补料单：本步有 outline.md 且「覆盖检查」里有薄节时按退回目标预填（三期 §9.3）。读不到就空着开 */
  async function openRework(initial?: { target: string; topics: string; reason: string }) {
    setReworkError(null);
    setReworkInitial(initial ? { ...initial, clues: "", scale: null } : null);
    const prefill: Record<string, { topics: string; reason: string }> = {};
    let unplaced: string[] = [];
    const step = focusStepDto;
    const ws = step ? activeWorkspaceFor(step.name, step.workspaceName) : undefined;
    let outline: string | null = null;
    for (const root of [ws?.worktreePath, projectPath].filter(Boolean) as string[]) {
      try {
        const f = await readResearchFile(root, "outline.md");
        if (!f.truncated) {
          outline = f.text;
          break;
        }
      } catch {
        /* 这一处没有大纲 */
      }
    }
    if (outline) {
      const drafts = coverageReworkDrafts(outline);
      const upstream = reworkTargets(steps, focusIdx);
      const searchStep = upstream.find((st) => stepFillsAnySlot(st.skills, ["lit-search"], skillProvides));
      const notesStep = upstream.find((st) => stepFillsAnySlot(st.skills, ["lit-notes"], skillProvides));
      const search = groupCoverageDrafts(drafts, "search");
      const read = groupCoverageDrafts(drafts, "read");
      if (searchStep && search) prefill[searchStep.name] = search;
      if (notesStep && read) prefill[notesStep.name] = read;
      unplaced = unplacedCoverageDrafts(drafts, { search: !!searchStep, read: !!notesStep });
    }
    // 意见清单里「去向：退回」的行（科研流程补全 §4）：按最新一份清单预填，覆盖检查已预填的目标不覆盖
    if (ws) {
      try {
        const entries = await invoke<{ name: string; isDir: boolean }[]>("list_dir", {
          path: `${ws.worktreePath.replace(/[\\/]+$/, "")}/manuscript/comments`,
          showHidden: false,
        });
        const latest = entries
          .filter((e) => !e.isDir && e.name.endsWith(".md"))
          .map((e) => e.name)
          .sort()
          .pop();
        if (latest) {
          const sheet = await readResearchFile(ws.worktreePath, `manuscript/comments/${latest}`);
          if (!sheet.truncated) {
            const fromComments = commentReworkDrafts(sheet.text, reworkTargets(steps, focusIdx).map((st) => st.name));
            for (const [target, draft] of Object.entries(fromComments)) prefill[target] ??= draft;
          }
        }
      } catch {
        /* 没有意见清单 */
      }
    }
    setReworkPrefill(prefill);
    setReworkUnplaced(unplaced);
    setReworkOpen(true);
  }

  /** 这一步的工作区：正在用的优先；保存过又归档的也认（回路与「几轮」要找得到它） */
  function stepWorkspace(step: ProjectStepDto): WorkspaceDto | undefined {
    return pickStepWorkspace(workspaces, projectPath, step);
  }

  /** 退回上一步补料（§4）：恢复 / 并入项目最新内容 → 写补料单 → 记轮次 → 在上游工作区另开一段对话（step-round.ts 同一条路） */
  async function sendRework(fields: ReworkFields) {
    if (!focusStepDto) return;
    const fromStep = focusStepDto.name;
    const target = steps.find((s) => s.name === fields.target);
    if (!target?.workspaceName) return;
    setReworkBusy(true);
    setReworkError(null);
    let restored = false;
    try {
      // 先确认有连接再动工作区：恢复之后才发现开不了对话，会留下一个没人干活的工作副本
      const launch = await loopLaunch(target.name);
      const rework = await sendReworkRound(
        {
          projectPath,
          fromStep,
          target,
          topics: fields.topics,
          reason: fields.reason,
          clues: fields.clues,
          scale: fields.scale,
          chain: fields.chain,
          provides: skillProvides,
          launch,
          confirm: confirmDialog,
        },
        () => {
          restored = true;
        },
      );
      if (!rework) return;
      // 对话真开起来了才关弹层（开不起来时弹层留着、报错看得见）
      onHumanChanged?.();
      setReworkOpen(false);
      onWorkspacesChanged?.();
    } catch (reason) {
      const text = String(reason instanceof Error ? reason.message : reason);
      setReworkError(restored ? `已恢复「${target.name}」的工作副本，但补料没发出：${text}` : text);
    } finally {
      setReworkBusy(false);
    }
  }

  /** 跟进更新（§5）：只读算增量 → 人确认规模 → 并入 → 开一段对话只做增量 → 记轮次。
   *  没有要跟进的也记一笔（ack），「待跟进」就此消掉，不会一直挂着（2026-11-05 排查） */
  async function followUpstream(
    target?: ProjectStepDto,
    /** 补料链自动往下（流程贯通 §6）：人发补料单时已确认过一次，不再弹规模确认、恢复确认；出错用提示条说，不占聚焦步骤的报错位 */
    auto?: { label: string },
  ): Promise<"started" | "skipped" | "stopped"> {
    const step = target ?? focusStepDto;
    const found = step ? stepWorkspace(step) : undefined;
    if (!step || !found) return "stopped";
    // 解冲突、「继续」并入后「待跟进」已消、但新篇还没读时，staleUpstream 为空：写最近的上一步名
    const upstream = found.staleUpstream ?? steps[steps.findIndex((s) => s.name === step.name) - 1]?.name ?? "上一步";
    setFollowBusy(true);
    if (!auto) setError(null);
    try {
      const launch = await loopLaunch(step.name);
      // 精读步的增量按项目根的台账算，不用工作副本：收起了也先算、先问，人确认了才恢复（2026-11-05 排查：原先一点就恢复）
      let notesIds: string[] | null = null;
      let droppedIds: string[] = [];
      if (stepFillsAnySlot(step.skills, ["lit-notes"], skillProvides)) {
        const inc = await readResearchLedger(projectPath, "papers/included.json").catch(() => null);
        // 这一步读过哪些篇看工作副本的索引：待评审、没保存时项目根还是旧索引（甚至没有），按它算会把全部篇当新增
        const idx =
          (found.status === "active"
            ? await readResearchLedger(found.worktreePath, "notes/index.json").catch(() => null)
            : null) ?? (await readResearchLedger(projectPath, "notes/index.json").catch(() => null));
        notesIds = inc && !inc.truncated ? notesFollowupIds(inc.text, idx && !idx.truncated ? idx.text : null) : null;
        // 检索后来排除、精读这边还留着的篇（索引或引文库里还有）：跟进时一并撤掉（2026-11-10）
        if (notesIds) {
          const bib =
            (found.status === "active"
              ? await readResearchLedger(found.worktreePath, "references.bib").catch(() => null)
              : null) ?? (await readResearchLedger(projectPath, "references.bib").catch(() => null));
          droppedIds = notesDroppedIds(
            inc!.text,
            idx && !idx.truncated ? idx.text : null,
            bib && !bib.truncated ? bib.text : null,
          );
        }
        // 没有新篇要读、也没有要撤的，但上游改了别的（清单、待获取）：按文件跟进
        if (notesIds && notesIds.length === 0 && droppedIds.length === 0) notesIds = null;
      }
      let ws = found;
      let files: string[] = [];
      if (!notesIds) {
        // 按文件算增量要看工作副本：收起了的先问一句再恢复（链上自动跟进时人已同意过）
        if (
          found.status !== "active" &&
          !auto &&
          !(await confirmDialog(
            `「${step.name}」的工作副本已收起：要先恢复它，才能算出上游有多少新内容要跟进。恢复并检查？`,
            { confirmText: "恢复并检查" },
          ))
        )
          return "stopped";
        ws = await ensureActive(found, step.name);
        const scope = await invoke<FollowupScopeDto>("step_followup_scope", { workspaceId: ws.id });
        files = followupFiles(scope.files);
      }
      // AI 正在干活：先拦，别让人确认完才知道开不了（收起了的恢复后再查）。上一轮还没保存的，人点开时在确认框里
      // 选「接着做，一起评审」（2026-11-10 用户拍板）；补料链自动往下时照旧停下，等人先保存
      const unsaved = ws.status === "active" && (await hasUnsavedRound(ws));
      if (ws.status === "active") await assertRoundable(ws, step.name, { allowUnsaved: !auto });
      const scale = followupScale({ upstream, notesIds, droppedIds, files });
      if (!scale) {
        await recordRound(ws, step.name, "ack");
        onWorkspacesChanged?.();
        toast(
          auto
            ? `${auto.label}：「${step.name}」没有要跟进的新内容，接着往下。`
            : "项目里没有这一步还没用上的新内容，不用跟进；「待跟进」已去掉。",
          "info",
        );
        return "skipped";
      }
      if (!auto) {
        if (
          !(await confirmDialog(followupConfirmText({ notesIds, droppedIds, files, unsaved }), {
            confirmText: unsaved ? "接着做，一起评审" : "开始跟进",
          }))
        )
          return "stopped";
      }
      if (ws.status !== "active") {
        ws = await ensureActive(ws, step.name);
        await assertRoundable(ws, step.name);
      }
      if ((await bringLatest(ws, step.name, confirmDialog, "跟进")) === null) return "stopped";
      await launchContinuation(
        launch,
        ws,
        step.name,
        followupPrompt({ upstream, notesIds, droppedIds, files, clause: ROUND_CLAUSE[stepKind(step, skillProvides)] }),
      );
      await recordRound(ws, step.name, "followup");
      onWorkspacesChanged?.();
      if (auto) toast(`${auto.label}：接着跟进「${step.name}」——${scale} 做完照常评审、保存。`, "info");
      return "started";
    } catch (reason) {
      const text = String(reason instanceof Error ? reason.message : reason);
      if (auto) toast(`${auto.label}停在「${step.name}」：${text} 处理完到这一步点「跟进更新」，保存后链接着往下。`, "error");
      else setError(text);
      return "stopped";
    } finally {
      setFollowBusy(false);
    }
  }

  /** 补读：只让 AI 读这几篇新到的全文、在原笔记上续写。已保存的步骤开新一轮，同「跟进更新」的拦法 */
  async function catchUpReads() {
    const step = focusStepDto;
    const found = step ? stepWorkspace(step) : undefined;
    if (!step || !found || catchUp.length === 0) return;
    const hits = catchUp;
    setFollowBusy(true);
    setError(null);
    try {
      const launch = await loopLaunch(step.name);
      if (
        !(await confirmDialog(catchUpConfirmText(hits.map((h) => h.probe.bibKey || h.probe.id)), { confirmText: "开始补读" }))
      )
        return;
      const ws = await ensureActive(found, step.name);
      await assertRoundable(ws, step.name);
      if ((await bringLatest(ws, step.name, confirmDialog, "补读")) === null) return;
      await launchContinuation(launch, ws, step.name, catchUpPrompt(hits));
      await recordRound(ws, step.name, "catchup");
      onWorkspacesChanged?.();
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setFollowBusy(false);
    }
  }

  // 补料链（流程贯通 §6）：链上的上一步保存进项目后，下一步自动开「跟进更新」。只认这次打开 Mesa 之后的保存；
  // rework_chain_claim 原子地记「这一步开过」，两处同时看到也只开一次；一次只走一步
  const chainBusyRef = useRef(false);
  useEffect(() => {
    if (chainBusyRef.current || steps.length === 0) return;
    let stale = false;
    void (async () => {
      const reworks = await invoke<ReworkDto[]>("rework_list", { root: projectPath }).catch(() => [] as ReworkDto[]);
      if (stale || chainBusyRef.current) return;
      const savedAt = (name: string) => {
        const st = steps.find((x) => x.name === name);
        return (st && stepWorkspace(st)?.mergedAt) || null;
      };
      for (const r of reworks) {
        const next = chainNext(r, savedAt);
        if (!next || Date.parse(next.savedAt) <= Date.parse(SESSION_STARTED_AT)) continue;
        const step = steps.find((x) => x.name === next.step);
        if (!step) continue;
        const claimed = await invoke<boolean>("rework_chain_claim", { root: projectPath, reworkId: r.id, step: next.step }).catch(() => false);
        if (!claimed || stale) continue;
        chainBusyRef.current = true;
        try {
          const chain = r.chain ?? [];
          const result = await followUpstream(step, { label: `补料链（${r.toStep} 之后第 ${chain.indexOf(next.step) + 1}/${chain.length} 步）` });
          if (result === "skipped") await invoke("rework_chain_skip", { root: projectPath, reworkId: r.id, step: next.step }).catch(() => {});
        } finally {
          chainBusyRef.current = false;
        }
        break;
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, projectPath]);

  /** 这个工作区有没有能接回的上次对话（只看会话列表，不管是哪家）：有才给「新开一轮」 */
  function hasPriorSession(ws: WorkspaceDto | undefined): boolean {
    return Boolean(ws && pickWorkspaceResume(sessions, ws.name, ws.repoPath));
  }

  /** 「跟 AI 商量一下」开聊前的草稿播种（v3.90）：空/仅决策答案/仅评审沉淀的草稿
   *  先灌入当前模板拼装（沉淀段接到后面）——商量的产出就是最终落盘的 TASK.md，
   *  从零起草会把简报/预期产物/提货单丢掉。
   *  决策答案不丢：buildTaskMdPreview 的「已定方向」段本就解析自草稿（gatherTaskMdExtras）。
   *  已有正文草稿时不覆盖，agent 接着它改 */
  async function seedDraftForChat() {
    const step = focusStepDto;
    if (!step) return;
    const cur = await invoke<TaskDraftDto>(
      "read_task_draft",
      { projectRoot: projectPath, stepName: step.name },
    );
    const raw = cur?.text?.trim() ?? "";
    if (raw && !isTaskMdStub(raw)) return;
    const assembled = await buildTaskMdPreview(projectPath, step, cfg);
    await invoke("write_task_draft", {
      projectRoot: projectPath,
      stepName: step.name,
      content: resolveTaskMdSource(raw, assembled),
      expectedRevision: cur?.revision ?? null,
    });
    onDraftChanged?.();
  }

  /** 「预览/编辑 TASK.md」的统一加载（v3.90：入口合一，不再有「草稿」概念）：
   *  有可执行正文读文件全文；否则给模板拼装并接上评审沉淀（只读展示不落盘——
   *  纯看不留痕，保存才经 write_task_draft 落地；与 seedDraftForChat 同一出处） */
  async function loadTaskMdForStep(): Promise<{ text: string; revision: string | null }> {
    const step = focusStepDto;
    if (!step) return { text: "", revision: null };
    const cur = await invoke<TaskDraftDto>(
      "read_task_draft",
      { projectRoot: projectPath, stepName: step.name },
    );
    const raw = cur?.text?.trim() ?? "";
    if (raw && !isTaskMdStub(raw)) {
      return {
        text: upsertPendingSettingsSection(cur?.text ?? "", cfg.settings ?? []),
        revision: cur?.revision ?? null,
      };
    }
    return {
      text: resolveTaskMdSource(raw, await buildTaskMdPreview(projectPath, step, cfg)),
      revision: cur?.revision ?? null,
    };
  }

  /** 想法卡行（想法区）：主按钮 = 只读纯聊「聊想法」；「◈ 沉淀进任务书」只在开工前渲染
   *  （步骤已有活跃工作区 = runStatus 非 pending 时藏沉淀入口，卡仍可续聊） */
  function renderIdeaCard(card: TaskCardDto) {
    const canFuse = (focusRunStatus ?? "pending") === "pending";
    return (
      <li key={card.id} className="group">
        <div className="flex h-7 min-w-0 items-center gap-2 rounded-sm px-1 hover:bg-hover">
          <span className="min-w-0 flex-1 truncate text-xs text-l1">
            {card.name}
          </span>
          <button
            type="button"
            onClick={() => onDiscuss(card)}
            title="在项目根开一段对话聊聊这个想法（不建工作区，只读纯聊），新会话自动归入本卡"
            className={`${actionBtn} shrink-0`}
          >
            聊想法
          </button>
          {canFuse && (
            <button
              type="button"
              onClick={() => setFusing(card)}
              title="AI 把这张卡的讨论结论织进当前步骤的 TASK.md；先出稿给你改，确认后才写入"
              className={`${actionBtn} shrink-0`}
            >
              ◈ 写入任务书
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right, y: rect.bottom + 4, card });
            }}
            title="卡片操作"
            aria-label={`卡片操作：${card.name}`}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
          >
            ⋯
          </button>
        </div>
        {renaming?.id === card.id && (
          <form
            onSubmit={submitRename}
            className="flex items-center gap-1 py-1"
          >
            <input
              className={`${fieldSm} min-w-0 flex-1`}
              value={renaming.name}
              onChange={(e) =>
                setRenaming({ id: card.id, name: e.target.value })
              }
              autoFocus
              required
            />
            <button type="submit" className={actionBtn}>
              确定
            </button>
            <button
              type="button"
              className={actionBtn}
              onClick={() => setRenaming(null)}
            >
              取消
            </button>
          </form>
        )}
      </li>
    );
  }

  function renderCard(card: TaskCardDto) {
    // 「开工」是任务书讨论卡（draft）的路径；想法卡（idea）的路径是「◈ 沉淀进任务书」，不给开工入口
    const canStart =
      card.kind === "draft" &&
      card.step !== null &&
      steps.some((s) => s.name === card.step);
    // 已绑定工作区（活跃）= 已开工：主按钮「继续」；未绑定的挂步骤卡 = 想法期：「聊想法」+「开工」；
    // 未挂步骤卡只有「聊想法」（onDiscuss 只读纯聊）
    const boundWs = activeWorkspaceFor(card.step, card.workspace);
    // 在跑闸门（与聚焦步骤「AI 干活」行同款互斥）：Agent 正在出字/等确认时点「继续」
    // 会在同一工作区并行拉起第二条会话——两个 Agent 并发写一棵树。此时只给「去终端
    // 看看」回到在跑的对话（reuseKey 命中活标签只聚焦）；跑完/闲置才恢复「继续」。
    const attention = boundWs ? stepAttention(boundWs, terminalRunInputs, IS_WINDOWS) : null;
    const agentLive = attention === "working" || attention === "confirm";
    return (
      <li key={card.id} className="group">
        <div className="flex h-7 min-w-0 items-center gap-2 rounded-sm px-1 hover:bg-hover">
          <span className="min-w-0 flex-1 truncate text-xs text-l1">
            {card.name}
          </span>
          {boundWs ? (
            agentLive ? (
              <button
                type="button"
                onClick={() => goWorkspaceTerminal(boundWs)}
                title={attention === "confirm" ? "Agent 在等确认：回到那次对话处理" : "Agent 正在出字：回到那次对话看进展（跑完才继续）"}
                className={`${actionBtn} shrink-0`}
              >
                去终端看看
              </button>
            ) : (
              <span className="flex shrink-0 items-center gap-1">
                {hasPriorSession(boundWs) && (
                  <button
                    type="button"
                    onClick={() => onContinue(card, true)}
                    title="不接上次的对话，新开一个会话从任务书读起（上次对话太长或跑偏时用）"
                    className="shrink-0 rounded-sm px-1 text-xs text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                  >
                    新开一轮
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onContinue(card)}
                  title={
                    hasPriorSession(boundWs)
                      ? "接回这一步上次的对话，接着做到完成标准；上次是另一家 Agent 时先问要不要带上原话"
                      : "开终端新会话，预填继续做到完成标准；会话自动归入本卡"
                  }
                  className={`${actionBtn} shrink-0`}
                >
                  继续
                </button>
              </span>
            )
          ) : canStart ? (
            <button
              type="button"
              onClick={() => void onSeed(card.step!, card.name)}
              title="继续这张卡的讨论，结论直接写进 TASK.md；新会话自动归入本卡"
              className={`${actionBtn} shrink-0`}
            >
              接着聊
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onDiscuss(card)}
              title="在项目根开一段对话聊聊这张卡（不建工作区，只读纯聊），新会话自动归入本卡"
              className={`${actionBtn} shrink-0`}
            >
              聊想法
            </button>
          )}
          <span className={`flex shrink-0 items-center gap-1 ${hoverRevealClass}`}>
            {!boundWs && canStart && (
              <button
                type="button"
                disabled={busyId === card.id}
                onClick={() => onStart(card)}
                title="开始这一步：建工作区并写好任务书；会话自动归入本卡"
                className={actionBtn}
              >
                开工
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.right, y: rect.bottom + 4, card });
              }}
              title="卡片操作"
              aria-label={`卡片操作：${card.name}`}
              className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
            >
              ⋯
            </button>
          </span>
        </div>
        {renaming?.id === card.id && (
          <form
            onSubmit={submitRename}
            className="flex items-center gap-1 py-1 pl-6"
          >
            <input
              className={`${fieldSm} min-w-0 flex-1`}
              value={renaming.name}
              onChange={(e) =>
                setRenaming({ id: card.id, name: e.target.value })
              }
              autoFocus
              required
            />
            <button type="submit" className={actionBtn}>
              确定
            </button>
            <button
              type="button"
              className={actionBtn}
              onClick={() => setRenaming(null)}
            >
              取消
            </button>
          </form>
        )}
      </li>
    );
  }

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2">
        {!focusStep && (
          <span className="text-xs text-l3">
            话题{cards && cards.length > 0 ? `（${cards.length}）` : ""}
          </span>
        )}
        {mainDirty !== null && mainDirty > 0 && (
          <button
            type="button"
            onClick={() => setDirtyOpen((open) => !open)}
            aria-expanded={dirtyOpen}
            title={`你在项目文件夹里改了 ${mainDirty} 个文件，还没存入历史（文件本身不会丢）。下一步 Agent 只看得到最近一次存入历史的内容。`}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 text-micro text-l4 hover:bg-hover hover:text-l2"
          >
            {/* 状态圆点用 warn 的文字档：底色档在浅色主题是浅黄，1.5px 圆点会看不见 */}
            <span className="inline-block size-1.5 rounded-full bg-warn-text" />
            {mainDirty} 处改动未存入历史
          </button>
        )}
        {/* 「想法期只读保护」开关已收掉（2026-10-26 用户拍板）：聊想法固定只读开聊，这里不再有开关 */}
      </div>
      {error && <InlineNotice tone="err" className="mt-1">{error}</InlineNotice>}
      {dirtyOpen && mainDirty !== null && mainDirty > 0 && (
        <div className="ccode-well mt-1.5 rounded-md px-2.5 py-2">
          {dirtyLoading && (
            <p className="text-micro text-l4">正在列出改动…</p>
          )}
          {!dirtyLoading && dirtyFiles.length > 0 && (
            <ul className="max-h-32 space-y-0.5 overflow-auto">
              {dirtyFiles.map((file) => (
                <li
                  key={file.path}
                  className="flex min-w-0 items-center gap-2 text-xs text-l2"
                  title={`${file.path} · ${statusBadgeTitle(file.status)}`}
                >
                  <FileTypeMark path={file.path} />
                  <span className="truncate">
                    {file.path.split(/[\\/]/).pop() || file.path}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!dirtyLoading && dirtyBlocked && (
            <p className="mt-1 text-micro text-l3">{dirtyBlocked}</p>
          )}
          {dirtyError && (
            <InlineNotice tone="err" size="micro" className="mt-1">{dirtyError}</InlineNotice>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={actionBtn}
              disabled={dirtyLoading || dirtySaving || !!dirtyBlocked}
              onClick={() => void saveMainHistory()}
            >
              {dirtySaving ? "保存中…" : "存进历史"}
            </button>
            <button
              type="button"
              className="text-micro text-l4 hover:text-l2"
              onClick={openMainChanges}
            >
              打开改动
            </button>
          </div>
        </div>
      )}
      {/* ───── 当前步骤卡（v3.85 三段式的第②段）─────
          「现在该干嘛」以前摊在三处：步进器给状态色、聚焦头给白话短语、流程线给动作，
          三者是三条独立细带（这也是「详情页不够清楚 / 线条化」的直接来源）。
          这里把聚焦头与流程线并进同一张卡：卡头 = 步骤名 + 白话状态，卡身 = 流程线（含唯一主动作）。
          StepFlow 传 bare 去掉自带底色，由这张卡统一承载。 */}
      {focusStep && focusStepDto ? (
        /* shadow-sm：当前步骤卡是本屏唯一「现在该干嘛」答案，微弱投影把它从画布上抬起来（v3.92 走查） */
        <div className="ccode-well mt-2 rounded-lg px-4 py-3.5 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
          {onFocusIndex && (
            <button
              type="button"
              disabled={focusIdx <= 0}
              onClick={() => onFocusIndex(focusIdx - 1)}
              title={focusIdx > 0 ? `上一步：${steps[focusIdx - 1].name}` : "已是第一步"}
              aria-label="上一步"
              className="rounded-sm px-1.5 py-0.5 text-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-30"
            >
              ‹
            </button>
          )}
          <span className="text-sm font-semibold text-l1">{focusStep}</span>
          {/* 角色标记（v3.89）：步骤名保留学术术语，另标「这一步轮到谁」——
              用户扫一眼就知道哪几步要自己出场，流程感来自角色交替而非序号 */}
          {focusStepDto && <RoleBadge role={focusStepDto.role} />}
          {focusStepDto && (
            <StepEvidenceChip
              projectPath={projectPath}
              step={focusStepDto}
              workspaces={workspaces}
              refreshToken={refreshToken}
            />
          )}
          {onFocusIndex && (
            <button
              type="button"
              disabled={focusIdx < 0 || focusIdx >= steps.length - 1}
              onClick={() => onFocusIndex(focusIdx + 1)}
              title={
                focusIdx >= 0 && focusIdx < steps.length - 1
                  ? `下一步：${steps[focusIdx + 1].name}`
                  : "已是最后一步"
              }
              aria-label="下一步"
              className="rounded-sm px-1.5 py-0.5 text-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-30"
            >
              ›
            </button>
          )}
          {focusStatusText &&
            (focusStatusText === "工作区已归档" ||
              focusStatusText === "有合并冲突待处理") && (
            <span className="text-xs text-l3">{focusStatusText}</span>
          )}
        </div>
          {/* 步骤内协同流程线（v3.71）：人/agent 动作按先后排成节点链，当前节点就地操作。
              想法区经 discussContent 收进 discuss 节点内（原先是流程线上方的并列 strip，
              两块并排会把「一步 = 一条线」的时序感冲掉） */}
          <StepFlow
            // 换步骤就重新挂载：待获取清单、期刊、展开状态、人工事项都是按步骤读的，不带 key 会把上一步的串过来
            key={focusStepDto.name}
            bare
            runId={focusRunId}
            projectLaunch={discussLaunch}
            stepSlotLaunch={
              taskBindingLaunch(
                profiles,
                taskBindings?.[stepSlotKey(focusStepDto.name)],
              )
            }
            onContinueStep={() => continueFocusedStep()}
            loopActions={(() => {
              // 退回上一步补料（design-review-loop.md §4）：这一步开过工就有——做到一半、待评审、已保存都能回头（2026-11-06 流程贯通 §5；
              // 原先只在已保存时给，因为没并入就保存会把「待跟进」盖掉，§3 改判定后这个顾虑没了）。跟进更新（§5）只在已保存且待跟进时给
              const upstreamSteps = reworkTargets(steps, focusIdx);
              const targets = upstreamSteps.map((s) => s.name);
              // 默认退回最近的上一步：它是找 / 读文献的就叫「补料」，大纲、初稿这类叫「修改」
              const nearestLit = !!upstreamSteps[0] && isLitStep(upstreamSteps[0]);
              // 按钮名自己说清做什么（step-panel R5）：上一步是找 / 读文献的叫「补充文献…」（2026-11-10 用户：「退回上一步补料」看不懂）
              const reworkButton = targets.length > 0 && (
                <button
                  type="button"
                  onClick={() => void openRework()}
                  title={
                    nearestLit
                      ? "缺文献时用（比如某个方向一篇都没有、大纲某节文献不够）：写清补什么，交给上一步另开一轮去找或去读。这一步做到一半也可以，不用先保存"
                      : "做这一步时发现上游要改（比如大纲某节的顺序撑不住）：写清改什么，交给上一步另开一轮去改。这一步做到一半也可以，不用先保存"
                  }
                  className={LOOP_TOOL}
                >
                  {nearestLit ? "补充文献…" : "退回上一步修改…"}
                </button>
              );
              // 定稿前更新检索（科研流程补全 §2）：检索那一步保存超过 14 天，定稿还没保存过时给入口，点了走退回补料
              const refresh = searchRefreshHint(
                steps,
                steps.map((st) => stepKind(st, skillProvides)),
                stepKeys ?? [],
                (name) => {
                  const st = steps.find((x) => x.name === name);
                  return (st && stepWorkspace(st)?.mergedAt) || null;
                },
                focusIdx,
                Date.now(),
              );
              const refreshButton = refresh && (
                <button
                  type="button"
                  onClick={() => void openRework({ target: refresh.step, ...searchRefreshDraft(refresh.savedAt) })}
                  title={`「${refresh.step}」上次保存是 ${refresh.days} 天前：投稿前按原检索式补一轮这段时间新发表的文献，再顺着精读、大纲、初稿跟进`}
                  className="shrink-0 rounded-sm text-xs text-warn-text underline-offset-2 hover:underline"
                >
                  更新检索（已 {refresh.days} 天）…
                </button>
              );
              // 导入 Word 批注（科研流程补全 §4）：写作 / 定稿类步骤开过工就有
              const focusKind = stepKind(focusStepDto, skillProvides);
              const commentsButton = (focusKind === "writing" || focusKind === "final") && stepWorkspace(focusStepDto) && (
                <button
                  type="button"
                  onClick={() => void importComments()}
                  title="选一份导师 / 合作者批注过的 Word：Mesa 抽出每条批注（批注人、原文、意见）写成意见清单，这一步另开一轮逐条处理；要前面步骤做的，退回单会按清单预填"
                  className={LOOP_TOOL}
                >
                  导入 Word 批注…
                </button>
              );
              if ((focusRunStatus ?? "pending") === "pending") return refreshButton ? loopRow([refreshButton]) : null;
              // 做到一半上游又保存过（流程贯通 §3）：说一句「继续」时会先并进来，不另给按钮
              if (focusRunStatus === "active" || focusRunStatus === "review") {
                const live = stepWorkspace(focusStepDto);
                if (!live?.staleUpstream && !(focusRunStatus === "review" && unreadNew > 0) && !reworkButton && !refreshButton && !commentsButton) return null;
                return loopRow([
                  // 待评审时也能跟进：确认框里选「接着做，一起评审」，两轮合在一起评审（2026-11-10 用户拍板）
                  (live?.staleUpstream || unreadNew > 0) && focusRunStatus === "review" && (
                    <button
                      type="button"
                      disabled={followBusy}
                      onClick={() => void followUpstream()}
                      title={`${unreadNew > 0 ? `纳入清单里有 ${unreadNew} 篇这一步还没读` : `「${live?.staleUpstream}」保存过新内容，这一版还没用上`}：只处理新增的部分，做完和没保存的这一轮一起评审`}
                      className={LOOP_PENDING}
                    >
                      {followBusy ? "正在算…" : "跟进更新"}
                    </button>
                  ),
                  live?.staleUpstream && focusRunStatus === "active" && (
                    <span
                      className="shrink-0 text-xs text-warn-text"
                      title="点「继续」会先把项目最新内容并进来，并告诉 AI 新进来了哪些文件"
                    >
                      「{live.staleUpstream}」有更新，继续时会并进来
                    </span>
                  ),
                  refreshButton,
                  commentsButton,
                  reworkButton,
                ]);
              }
              if (focusRunStatus !== "done") return null;
              const ws = stepWorkspace(focusStepDto);
              const follow = !!ws?.staleUpstream || unreadNew > 0;
              const catchUpButton = catchUp.length > 0 && (
                <button
                  type="button"
                  disabled={followBusy}
                  onClick={() => void catchUpReads()}
                  title={`原来没有全文、现在 papers/ 里有了的：${catchUp.map((h) => h.probe.bibKey || h.probe.id).join("、")}。AI 只补读这几篇，在原笔记上续写`}
                  className={LOOP_PENDING}
                >
                  补读 {catchUp.length} 篇新到的全文
                </button>
              );
              if (!follow && !catchUpButton && targets.length === 0 && !commentsButton) return null;
              return loopRow([
                follow && (
                  <button
                    type="button"
                    disabled={followBusy}
                    onClick={() => void followUpstream()}
                    title={`${unreadNew > 0 ? `纳入清单里有 ${unreadNew} 篇这一步还没读` : `「${ws?.staleUpstream}」保存过新内容，这一步还没用上`}：只处理新增的部分，已有的不重做`}
                    className={LOOP_PENDING}
                  >
                    {followBusy ? "正在算…" : "跟进更新"}
                  </button>
                ),
                catchUpButton,
                commentsButton,
                reworkButton,
              ]);
            })()}
            roundsContent={(() => {
              const ws = stepWorkspace(focusStepDto);
              return ws ? (
                <StepRoundsSection
                  projectPath={projectPath}
                  workspaceId={ws.id}
                  refreshKey={`${focusRunStatus ?? ""}|${refreshToken}`}
                />
              ) : null;
            })()}
            onContinueFresh={
              hasPriorSession(
                focusStepDto
                  ? activeWorkspaceFor(focusStepDto.name, focusStepDto.workspaceName)
                  : undefined,
              )
                ? () => continueFocusedStep(true)
                : undefined
            }
            discussContent={
              // 零态且非人主导步骤：整个想法区不渲染（没有入口也没有约束对象）
              !showIdeaEntry && !ideaFormOpen ? null : (
              <div className="mt-1">
                {/* 想法区（v3.80）：自由想法卡（kind=idea）——只读纯聊 + ◈ 沉淀进任务书；
                    「想法期只读保护」开关 2026-10-26 已收掉，聊想法固定只读开聊（TaskCardsSection 顶部 guard 提示）。
                    与「跟 AI 商量一下」是两层东西，文案对仗点破：商量=边聊边改 TASK.md（改合同），
                    想法=先聊不改稿、点 ◈ 沉淀才进任务书（先发散后收编） */}
                <div className="group flex flex-wrap items-center gap-2">
                  {ideaCards.length > 0 && (
                    <span className="text-xs text-l4">
                      聊过的（{ideaCards.length}）
                    </span>
                  )}
                  {/* 「＋ 话题」零态可见性见上方 showIdeaEntry（R5：唯一入口不能消失，
                      但没约束对象的入口也不白占一行） */}
                  {ideaFormOpen ? (
                    <form
                      onSubmit={(e) => void submitCreateIdea(e)}
                      className="flex min-w-0 flex-1 items-center gap-1"
                    >
                      <input
                        className={`${fieldSm} min-w-0 flex-1`}
                        value={ideaName}
                        onChange={(e) => setIdeaName(e.target.value)}
                        placeholder={ideaTopicPlaceholder(focusStepDto?.name)}
                        autoFocus
                        required
                      />
                      <button type="submit" className={actionBtn}>
                        确定
                      </button>
                      <button
                        type="button"
                        className={actionBtn}
                        onClick={() => setIdeaFormOpen(false)}
                      >
                        取消
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setIdeaName("");
                        setIdeaFormOpen(true);
                      }}
                      title="自己起个话题开聊（如综述角度、创新点）；聊完点卡片上的「◈ 写入任务书」才追加进 TASK.md。要直接改任务书用「跟 AI 商量一下」"
                      className={`${actionBtn} ${ideaCards.length === 0 ? "text-l3" : `text-l4 ${hoverRevealClass}`} hover:text-l1`}
                    >
                      ＋ 话题
                    </button>
                  )}
                  {/* 聊想法固定只读开聊：当前 Agent 做不到只读时启动会被拒，先如实说一句（开关已收掉，2026-10-26） */}
                  {ideaCards.length > 0 && !guardHard && (
                    <span
                      className="ml-auto shrink-0 text-micro text-warn-text"
                      title={`${guardAgentLabel} 没有只读启动参数（或本机版本太旧），聊想法开不起来：换一家 Agent，或更新 CLI`}
                    >
                      {guardAgentLabel} 不能只读开聊
                    </span>
                  )}
                </div>
                {ideaCards.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {ideaCards.map(renderIdeaCard)}
                  </ul>
                )}
              </div>
              )
            }
            projectPath={projectPath}
            step={focusStepDto}
            runStatus={focusRunStatus ?? "pending"}
            agentAttention={focusAgentAttention ?? null}
            hasDraft={!!focusDraft?.text?.trim()}
            draft={
              focusDraft
                ? {
                    relPath: focusDraft.relPath,
                    exists: !!focusDraft.text?.trim(),
                    text: focusDraft.text,
                  }
                : undefined
            }
            onDraftChanged={onDraftChanged}
            onSeedDraft={seedDraftForChat}
            draftLoadError={focusDraftError}
            onLoadTaskMd={loadTaskMdForStep}
            discussed={discussed}
            discussResume={discussResume}
            litSource={cfg.litSource}
            openSettings={(cfg.settings ?? []).filter((line) => isSettingPlaceholder(line))}
            onOpenResources={onOpenResources}
            onSetLitSource={onSetLitSource}
            litBusy={litBusy}
            tools={researchToolsFromSettings(cfg.settings)}
            toolAskFields={researchToolAskFieldsForStep(focusStepDto, steps, skillProvides)}
            onSetResearchTool={onSetResearchTool}
            toolBusy={toolBusy}
            ws={workspaces.find(
              (w) =>
                w.name === focusStepDto.workspaceName && w.status === "active",
            )}
            reviewConflict={reviewConflict}
            onRestore={onRestoreWorkspace}
            onSeed={(seed) => void onSeed(focusStepDto.name, seed)}
            openSeeds={openSeeds}
            onStart={() =>
              void onStartStep(
                steps.findIndex((s) => s.name === focusStepDto.name),
              )
            }
            onReadPaper={onReadPaper}
            readPaperPrimary={readPaperPrimary}
            onChanged={onHumanChanged}
          />
        </div>
      ) : null}
      {/* 「未挂步骤」桶：空时整桶不渲染（它出现时必带卡）；无研究步骤的项目只有这一桶 */}
      {unattached && unattached.cards.length > 0 && (
        <div className="group mt-1">
          <div className="flex h-7 items-center gap-2">
            <span className="text-sm text-l2">未挂步骤</span>
            {creatingIn === "" ? (
              <form
                onSubmit={(e) => void submitCreate(e)}
                className="flex min-w-0 flex-1 items-center gap-1"
              >
                <input
                  className={`${fieldSm} min-w-0 flex-1`}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="卡片名，如 方法对比整理"
                  autoFocus
                  required
                />
                <button type="submit" className={actionBtn}>
                  确定
                </button>
                <button
                  type="button"
                  className={actionBtn}
                  onClick={() => setCreatingIn(null)}
                >
                  取消
                </button>
              </form>
            ) : (
              /* 桶头按钮降噪用悬停才现 */
              <span className={`flex items-center gap-1 ${hoverRevealClass}`}>
                <button
                  type="button"
                  onClick={() => {
                    setDraftName("");
                    setCreatingIn("");
                  }}
                  title="手动开一张讨论卡：起个名建卡，之后点卡片「聊想法」去跟 Agent 聊，对话与简报自动归到这张卡"
                  className={`${actionBtn} text-l4 hover:text-l1`}
                >
                  ＋ 添加想法
                </button>
              </span>
            )}
          </div>
          {/* 行间不画分隔线：行本身有 hover 高亮做分隔感（去线条化，v3.85） */}
          <ul className="space-y-0.5">
            {unattached.cards.map(renderCard)}
          </ul>
        </div>
      )}
      {/* 步骤级 TASK.md 查看/编辑已并入流程线的「预览/编辑 TASK.md」（StepFlow 内弹层，v3.90） */}
      {fusing && focusStepDto && (
        <FuseDraftModal
          projectPath={projectPath}
          card={fusing}
          stepName={focusStepDto.name}
          onClose={() => setFusing(null)}
          onWritten={() => {
            setFusing(null);
            onDraftChanged?.();
          }}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          onClose={() => setMenu(null)}
          items={[
            // 只读纯聊（onDiscuss）给想法卡（kind=idea，含未挂步骤卡——旧卡按 step 推断后两者等价）：
            // draft 讨论卡的讨论已并入 onSeed 草稿口径（行内主按钮「接着聊」）
            ...(menu.card.kind === "idea"
              ? [
                  {
                    icon: MessageCircle,
                    label: "聊想法",
                    title:
                      "在项目根开一段对话聊聊这张卡（不建工作区，只读纯聊），新会话自动归入本卡",
                    onSelect: () => onDiscuss(menu.card),
                  },
                ]
              : []),
            {
              icon: Pencil,
              label: "重命名",
              onSelect: () =>
                setRenaming({ id: menu.card.id, name: menu.card.name }),
            },
            {
              icon: Trash2,
              label: "删除卡片",
              danger: true,
              onSelect: () => void onDelete(menu.card),
            },
          ]}
        />
      )}
      {reworkOpen && focusStepDto && (
        <ReworkDialog
          fromStep={focusStepDto.name}
          targets={reworkTargets(steps, focusIdx).map((st) => st.name)}
          litTargets={reworkTargets(steps, focusIdx)
            .filter((st) => isLitStep(st))
            .map((st) => st.name)}
          fromInProgress={focusRunStatus !== "done"}
          fromPending={(focusRunStatus ?? "pending") === "pending"}
          initial={reworkInitial ?? undefined}
          chainOff={steps.filter((st) => chainDefaultOff(stepKind(st, skillProvides))).map((st) => st.name)}
          chainOptions={Object.fromEntries(
            reworkTargets(steps, focusIdx).map((st) => {
              // 补完后能接着自动跟进的：目标之后、已保存（已完成）的步骤，按顺序；做到一半的不进链，它点「继续」时自己并进来
              const from = steps.indexOf(st);
              return [st.name, steps.filter((_x, i) => i > from && stepKeys?.[i] === "done").map((x) => x.name)];
            }),
          )}
          prefill={reworkPrefill}
          unplaced={reworkUnplaced}
          busy={reworkBusy}
          error={reworkError}
          onCancel={() => setReworkOpen(false)}
          onSend={(fields) => void sendRework(fields)}
        />
      )}
      {carryAsk && (
        <Modal
          open
          size="sm"
          layer="overlay"
          title="换了 Agent"
          // 整理在途时 Esc / 点遮罩都不关，避免关框后后台还在写
          dismissOnBackdrop={!carryBusy}
          onClose={() => {
            if (!carryBusy) setCarryAsk(null);
          }}
          footer={
            <>
              <button
                type="button"
                disabled={carryBusy}
                onClick={() => void continueWithoutCarry()}
                className={secondaryActionClass}
              >
                不带，直接开
              </button>
              <button
                type="button"
                disabled={carryBusy}
                onClick={() => void carryAndContinue()}
                className={primaryActionClass}
              >
                {carryBusy ? "正在整理…" : "带上，接着做"}
              </button>
            </>
          }
        >
            <p className="text-sm leading-6 text-l2">
              这一步上次是 {AGENTS.find((a) => a.id === carryAsk.fromAgent)?.label ?? carryAsk.fromAgent} 做的。带上它的对话记录，让{" "}
              {AGENTS.find((a) => a.id === carryAsk.launch.agentId)?.label ?? carryAsk.launch.agentId} 接着做？
            </p>
            {carryError && (
              <p className="mt-2 text-xs text-err-text" role="alert">
                {carryError}
              </p>
            )}
        </Modal>
      )}
    </div>
  );
}
