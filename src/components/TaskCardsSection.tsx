import {
  FilePenLine,
  MessageCircle,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import {
  hoverRevealClass,
  inlineActionClass,
  primaryActionClass,
  RoleBadge,
  secondaryActionClass,
  Toggle,
  InlineNotice,
} from "./PageFrame";
import { Modal } from "./Modal";
import StepEvidenceChip from "./StepEvidenceChip";
import StepFlow from "./StepFlow";
import FuseDraftModal from "./FuseDraftModal";
import { useAppStore } from "../store";
import { stepAttention } from "../run-overview";
import { workspaceReuseKey } from "../pipeline-start";
import {
  bucketCardsByStep,
  ideaTopicPlaceholder,
  topicCardsForStep,
  unstartedSeeds,
} from "../task-cards";
import { buildTaskMdPreview, buildWorkspaceTerminalRequest } from "../pipeline-start";
import { CONTINUE_RESUME_PROMPT, CONTINUE_STEP_PROMPT, continueWithBriefPrompt, isTaskMdStub, resolveTaskMdSource } from "../step-decisions";
import { continueRoute, pickWorkspaceResume } from "../workspace-resume";
import { filterProjectSessions } from "../project-status";
import { pickDiscussResume } from "../step-flow";
import { IS_WINDOWS } from "../hotkeys";
import { normSep, relativeUnder } from "../path-utils";
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
import { researchToolAskFieldsForStep, researchToolsFromSettings } from "../research-tools";
import { useSkillProvides } from "../skill-slots.ts";
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

/** 认领登记的 agent：与终端启动栏的种子口径一致（ccode.lastLaunch → claude-code 兜底）。
 *  用户在启动栏临时换了 agent 时登记会落空——静默降级，事后仍可在对话页手动归卡 */
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
  focusAgentAttention,
  focusRunId,
  reviewConflict,
  onRestoreWorkspace,
  onFocusIndex,
  onHumanChanged,
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
  /** 聚焦步骤工作区内终端的注意力（stepAttention 口径）：done 时流程线 agent 节点给「已跑完」提示 */
  focusAgentAttention?: "confirm" | "done" | "working" | null;
  focusRunId?: string | null;
  /** 聚焦步骤处于合并冲突阻塞：流程线评审节点入口改为「去处理冲突」 */
  reviewConflict?: boolean;
  /** 聚焦步骤的工作区已归档：流程线 agent 节点主入口改为「恢复工作区」 */
  onRestoreWorkspace?: () => void;
  /** 头部 ‹ › 箭头切换聚焦步骤（与步进器大圆点击同一口径） */
  onFocusIndex?: (index: number) => void;
  /** 人工事项勾选/交付后通知父级（流程线橙点与 ⋯ 菜单计数重取） */
  onHumanChanged?: () => void;
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
  onSetResearchTool?: (key: "libraryExport" | "plotting" | "illustration" | "manuscript", value: string) => void | Promise<void>;
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
  const updateSettings = useAppStore((s) => s.updateSettings);
  // 想法期只读保护开关（settings.json，默认开）
  const discussGuard = useAppStore((s) => s.settings?.discussReadonly !== false);
  // 只读保护对当前启动栏 agent 是否真的是硬保护（进程级参数）：
  // qwen/opencode 的注册表 readonly_args 为空，开了也只剩 prompt 软约束，UI 要如实标注。
  // 能力位来自后端 detect_agents（与 agent_specs 注册表同一出处，不在前端另抄一份名单）
  const detected = useAppStore((s) => s.agents);
  const guardAgentId = launchBarAgent();
  const guardAgentLabel =
    AGENTS.find((a) => a.id === guardAgentId)?.label ?? guardAgentId;
  // 探测结果还没回来时按「有硬保护」显示：不在加载中途闪一条吓人的警告
  const guardHard =
    detected?.find((a) => a.id === guardAgentId)?.readonlySupported ?? true;
  const skillProvides = useSkillProvides();
  const [error, setError] = useState<string | null>(null);
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
        `删除卡片「${card.name}」？卡片内的对话会移出卡片（对话本身不删除），TASK.md 不受影响。继续？`,
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
   *  登记的 agent 必须与实际拉起的一致（认领键 = agent+cwd，登记别家 agent 会认领落空）——
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
   *  想法期只读保护（卡片区标题行开关，默认开；allowEdit = ⋯ 菜单的单次豁免）：
   *  开 = 预填指令带不动文件约束 + readonly 标记（后端对支持的 CLI 注入只读/计划模式参数——硬保护）；
   *  关/豁免 = 纯聊天，不动参数。
   *  预填指令还要给「该动手了」一个明确出口（回项目页开工/商量）——只读约束管得住文件、
   *  管不住 agent 在项目根读到 project.toml 与草稿后主动请缨开工；没有出口话术，
   *  它会把「用户点头」当成在主仓直接产出的授权（实测：聊想法会话里 agent 问「要现在开 outline 吗」）。
   *  kimi 无启动注入参数：启动栏保留指令文本由用户手动发送（promptDropped 既有处理） */
  function onDiscuss(card: TaskCardDto, allowEdit = false, topic?: string) {
    claimForCard(card, discussLaunch);
    const guard = useAppStore.getState().settings?.discussReadonly !== false;
    const protect = guard && !allowEdit;
    const opening = topic
      ? `我想跟你探讨「${card.name}」里的待拍板问题：${topic}`
      : `我想跟你探讨：${card.name}`;
    setPendingTerminal({
      cwd: projectPath,
      extraEnv: {},
      title: card.name,
      readonly: protect || undefined,
      permission: protect ? "discuss" : "write_tree",
      initialPrompt: protect
        ? `${opening}。注意：现在只讨论方案，不要修改/新建/删除任何文件，也不要在这里产出任何步骤产物（哪怕我点头）——聊到该动手的程度时，提醒我回项目页点「开工」或「跟 AI 商量一下」，那边会在独立工作区里执行。`
        : opening,
      ...(discussLaunch ?? {}),
      autoStart: Boolean(discussLaunch?.profileId),
      surface: "terminal",
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
   *  与「聊想法」同一口径：**只读开聊**（受想法期只读保护约束），结论不由 agent 直接落盘，
   *  聊完走「◈ 沉淀进任务书」提炼后追加——讨论入口只此一条，
   *  「让 agent 直接改草稿」由 discuss 节点的「跟 Agent 聊任务书」单独承担，两者不再重叠 */
  async function onSeed(stepName: string, seed: string, topic?: string) {
    setError(null);
    try {
      const existing = (cards ?? []).find((c) => c.name === seed);
      const card =
        existing ?? (await createCard(projectPath, seed, stepName, "idea"));
      onDiscuss(card, false, topic);
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
   *  没有可接的、或 fresh（「新开一轮」）才在工作树里新开，预填 CONTINUE_STEP_PROMPT。上次是另一家先问要不要带接力简报。
   *  配置现读数据库 step:步骤名，失败再走 props（步骤槽 > discuss > 项目默认）。
   *  kimi 无启动注入参数：启动栏保留指令文本由用户手动发送（pty_spawn promptDropped 既有处理） */
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
      setError("还没解析到可用连接：去 Agents 页给这一步绑一条，或确认项目默认 Agent 有连接。");
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
        await resumeContinuation(launch, ws, title, card);
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
      });
      return;
    }
    try {
      await launchContinuation(launch, ws, title, CONTINUE_STEP_PROMPT, card);
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
  ) {
    if (card) claimForCard(card, launch);
    const req = await buildWorkspaceTerminalRequest(ws, CONTINUE_RESUME_PROMPT, {
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
      surface: "terminal",
    });
    setPage("terminal");
  }

  function digestReady(): boolean {
    const settings = useAppStore.getState().settings;
    return Boolean(
      settings?.aiProfiles?.digest?.trim() || settings?.aiProfileId?.trim(),
    );
  }

  function briefRel(worktreePath: string, filePath: string): string {
    // 工作树外的原样路径也统一正斜杠（写进给 agent 的指令，沿用旧口径）
    return normSep(relativeUnder(filePath, worktreePath, IS_WINDOWS));
  }

  async function carryAndContinue() {
    const ask = carryAsk;
    if (!ask || carryBusy) return;
    setCarryBusy(true);
    setCarryError(null);
    try {
      const args = {
        agent: ask.fromAgent,
        sessionId: ask.fromSessionId,
        filePath: ask.filePath,
        cwd: ask.ws.worktreePath,
        title: ask.sessionTitle,
        targetPath: null,
      };
      // 配了提炼才走 AI；没配就用规则简报。配了但调用失败不悄悄降级，留在框里重试或改走不带。
      const brief = await invoke<{ filePath: string }>(
        digestReady() ? "build_session_digest" : "build_handoff_brief",
        args,
      );
      await invoke("mark_handoff", {
        targetAgent: ask.launch.agentId,
        targetCwd: ask.ws.repoPath,
        fromAgent: ask.fromAgent,
        fromSessionId: ask.fromSessionId,
      });
      const prompt = continueWithBriefPrompt(briefRel(ask.ws.worktreePath, brief.filePath));
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
        CONTINUE_STEP_PROMPT,
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
            title="在项目根开终端聊聊这个想法（不建工作区，只读纯聊），新会话自动归入本卡"
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
              title="在项目根开终端聊聊这张卡（不建工作区，只读纯聊），新会话自动归入本卡"
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
                title="一键开步：建工作区，TASK.md 随之落盘；会话自动归入本卡"
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
        {/* 「想法期只读保护」开关已迁入聚焦态想法区标题行（它只管想法卡的只读纯聊一路） */}
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
                    「想法期只读保护」开关只管只读纯聊这一路，设置页不加行。
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
                  {ideaCards.length > 0 && (
                  <span
                    className="ml-auto flex shrink-0 items-center gap-1"
                    title={
                      guardHard
                        ? `开启后以只读/计划模式启动 ${guardAgentLabel}——进程级参数，约束工具执行（计划模式不等同于 OS 沙箱）`
                        : `${guardAgentLabel} 没有只读启动参数：不能以只讨论权限启动；请换 Claude Code / Codex / Gemini / Kimi / CodeBuddy / Cursor / Grok`
                    }
                  >
                    <span className="text-xs text-l4">聊天时不让 AI 改文件</span>
                    {/* 如实标注当前 agent 有没有硬保护：不标的话开关会沉默降级，
                        而头脑风暴恰恰最依赖「它不会动我文件」这个假设 */}
                    {discussGuard && !guardHard && (
                      <span className="text-micro text-warn-text">
                        {guardAgentLabel} 不支持只讨论
                      </span>
                    )}
                    <Toggle
                      checked={discussGuard}
                      onChange={(checked) =>
                        void updateSettings({
                          discussReadonly: checked,
                        }).catch((e) => setError(String(e)))
                      }
                      label="聊的时候不让 AI 改文件"
                    />
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
                      "在项目根开终端聊聊这张卡（不建工作区，只读纯聊），新会话自动归入本卡",
                    onSelect: () => onDiscuss(menu.card),
                  },
                ]
              : []),
            // 单次豁免：不动「想法期只读保护」开关，本次允许 Agent 改文件（开关关时无意义不渲染）
            ...(discussGuard && menu.card.kind === "idea"
              ? [
                  {
                    icon: FilePenLine,
                    label: "聊想法（允许改文件）",
                    title:
                      "只此一次以普通模式启动（不注入只读参数、不带不动文件约束）；开关保持开",
                    onSelect: () => onDiscuss(menu.card, true),
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
      {carryAsk && (
        <Modal
          open
          size="sm"
          layer="overlay"
          title={`上次是 ${AGENTS.find((a) => a.id === carryAsk.fromAgent)?.label ?? carryAsk.fromAgent}`}
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
                {carryBusy ? "正在整理…" : "带上上次对话"}
              </button>
            </>
          }
        >
            <p className="text-sm leading-6 text-l2">
              这次用 {AGENTS.find((a) => a.id === carryAsk.launch.agentId)?.label ?? carryAsk.launch.agentId} 开新一轮。要不要把上次对话里的用户原话逐条带上？原话不改写，助手正文附在后面供核对。旧对话还留在原来那家。
            </p>
            {!digestReady() && (
              <p className="mt-2 text-xs text-l4">
                还没配提炼模型，这次用规则简报（对话尾部和改动文件），不调用 AI。
              </p>
            )}
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
