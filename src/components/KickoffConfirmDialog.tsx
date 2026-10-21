import { researchToolArtifacts, researchToolContractMatches } from "../research-tools";
import { appendUpstreamAcceptance, type UpstreamAcceptance } from "../research-acceptance";
import UpstreamResearchAcceptance from "./UpstreamResearchAcceptance";
import ResearchToolPreflight from "./ResearchToolPreflight";
import ResearchEvidencePanel from "./ResearchEvidencePanel";
import ResearchDecisionFields from "./ResearchDecisionFields";
import { researchReportPatterns } from "../research-report";
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { toast } from "../toast";
import { invoke } from "@tauri-apps/api/core";
import {
  Checkbox,
  FoldMark,
  LoadingRows,
  compactFieldClass,
  primaryActionClass,
  secondaryActionClass,
  InlineNotice,
} from "./PageFrame";
import StepSkillsChips from "./StepSkillsChips";
import HumanTasksList from "./HumanTasksList";
import { useAppStore } from "../store";
import { AGENTS, type GitFileDto } from "../types";
import { officialModelAllowed } from "../model-switch";
import { historySaveBlockedReason, historySaveMessage } from "../main-history-save";
import {
  dirtyInputHits,
  intakeBridgeHits,
  intakeBridgeLabel,
  summarizeIntakeBridge,
} from "../kickoff-dirty-gate";
import { userWorkDirtyFiles } from "../git-status-groups";
import { loadAskAiRemembered } from "../ask-ai";
import {
  kickoffLaunchLabel,
  loadKickoffLast,
  pickKickoffLaunch,
  saveKickoffLast,
  type KickoffLaunch,
} from "../kickoff-launch";
import {
  stepSlotKey,
  taskBindingLaunch,
  type ProjectAgentBinding,
} from "../project-agents";
import {
  accumulationChip,
  chipFileName,
  expectedDeliverNames,
  formatKickoffChip,
  isFlowDeclaredPath,
  isOwnDeliverable,
  type KickoffInputChip,
  type UnsavedUpstream,
} from "../kickoff-inputs";
import {
  blockingHumanTasks,
  closingHumanTasks,
  taskMdEditorReduce,
  type TaskMdEditorState,
} from "../task-cards";
import {
  gatherTaskMdExtras,
  renderTaskMd,
  type IntakeBridgeDecision,
} from "../pipeline-start";
import { decisionGate, isTaskMdStub, resolveTaskMdSource } from "../step-decisions";
import { RESOURCE_TYPE_LABELS } from "../pipeline-presets";
import { IS_WINDOWS } from "../hotkeys";
import type {
  ArtifactEntryDto,
  DiscoveredResourceDto,
  HumanTaskStateDto,
  ProjectConfigDto,
  ProjectStepDto,
  SkillDto,
} from "../types";

/** 弹层一行「标签 | 内容」：读入、产出、执行、思考档、技能、权限、任务书同列对齐
 *  （2026-10-17 用户截图：原先每块标签各占一行、间距各异，读不出结构）。
 *  内容区定 text-xs：全站 `button { font: inherit }` 会吞掉按钮上的 text-*，字号只能从容器继承。 */
function KickoffRow({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="mb-2.5 grid grid-cols-[3.25rem_minmax(0,1fr)] items-start gap-x-3">
      <span className="pt-[3px] text-micro text-l4" title={title}>{label}</span>
      <div className="min-w-0 text-xs text-l2">{children}</div>
    </div>
  );
}

const UPSTREAM_STATUS_TEXT: Record<UnsavedUpstream["status"], string> = {
  review: "AI 已交付、等你评审",
  active: "还在进行",
  blocked: "有冲突没解决",
};

/** git_status 返回（未提交改动提醒 + 开工软门都从这里取数） */
interface GitStatusBrief {
  isRepo: boolean;
  files: GitFileDto[];
  merging?: boolean;
}

/**
 * 开工确认弹层（v3.64；任务书沉淀统一走草稿后精简）：「开工」= 点开工 → 本弹层 → 确认开工。
 * 三件事统一在这里承载：
 * 1. TASK.md 编辑区（所见即所得：默认拼装与实际落盘走同一个 renderTaskMd/gatherTaskMdExtras；
 *    任务书草稿非空时初始内容 = 草稿全文；确认开工落盘 = 编辑区最终内容）；
 * 2. 旧版简报兜底：.ccode/brief-*.md 存在且草稿为空时给一行提示，可「并入草稿」
 *    （新口径不再自动带入 TASK.md）；
 * 3. 未存入历史的改动：项目文件夹有改动时顶部提醒（不阻断，文案走白话术语表）；
 *    改动与本步声明输入相交时升级成软门（2026-09-20）：列文件 + 就地「存进历史」+
 *    二击确认——工作区从基准分支 HEAD 建树，未提交的人工修改（如精读后改的笔记）带不进去；
 * 4. 上一步收尾软门：紧邻上一步的非可选 after 事项未勾时，「确认开始」需按两次
 *    （首击知情、按钮变「仍要开工」再击才开——只确认不阻断）。
 * 「继续」动作不经本弹层；评审合并成功的「→ 去下一步」v3.97 起也不直开——跳项目页聚焦下一步，
 * 用户点「开始」仍经本弹层（上一步收尾软门因此不会被绕过）。
 */
export default function KickoffConfirmDialog({
  projectPath,
  step,
  cfg,
  taskBindings,
  preferredAgent,
  preferredProfile,
  preferredModel,
  busy,
  onCancel,
  onConfirm,
  onCfgChange,
  unsavedUpstream = [],
  onOpenUpstreamReview,
}: {
  projectPath: string;
  step: ProjectStepDto;
  cfg: ProjectConfigDto;
  /** 项目槽位专属绑定（projects 表 taskBindings；本弹层消费 step:<步骤名> 槽做预选） */
  taskBindings?: Record<string, ProjectAgentBinding> | null;
  /** 项目级默认 Agent；单次开工仍可在弹层里改选 */
  preferredAgent?: string | null;
  /** 项目级默认 profile；仅在与默认 Agent 匹配时生效 */
  preferredProfile?: string | null;
  /** 项目在这条连接里点选的模型；还在名单里才盖过问 AI 记忆 */
  preferredModel?: string | null;
  /** 从哪张卡点的开工（步进器大圆开工为 null）；简报来源勾选删除后仅作调用方记录保留 */
  originCardId: string | null;
  /** 确认开工后的链路进行中（父组件自持 starting） */
  busy: boolean;
  onCancel: () => void;
  /** 确认开工：taskMd = 编辑区最终内容；launch = 将自动拉起的连接；
   *  intake = 开工接驳决定（勾选 + 积累面命中路径；未接驳时 accepted=false） */
  onConfirm: (
    taskMd: string,
    launch: KickoffLaunch | null,
    decisionPauseAcknowledged: boolean,
    intake?: IntakeBridgeDecision,
  ) => void;
  /** 技能区增删写回 project.toml 后同步父级 cfg（保持步进器/下次打开一致） */
  onCfgChange?: (cfg: ProjectConfigDto) => void;
  /** 这一步要读、但上游还没保存进项目的步骤（unsavedUpstreamSteps；ProjectGroup 按步进器状态算） */
  unsavedUpstream?: UnsavedUpstream[];
  /** 「去评审」：关弹层、打开上游那一步的评审（冲突时直达处理冲突） */
  onOpenUpstreamReview?: (upstream: UnsavedUpstream) => void;
}) {
  // 档案卡本地副本：技能区增删写回 project.toml 后重读替换（步骤其余字段以后端回读为准）
  const [cfgLocal, setCfgLocal] = useState(cfg);
  // 技能库（名称 + 一句话描述 + mentionsMcp）：技能区展示与「＋ 添加技能」候选的数据源，打开时读一次
  const [skillLib, setSkillLib] = useState<SkillDto[] | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  // 当前步骤（技能区写回后 cfgLocal 里的最新版本，prop 可能是旧的）
  const stepNow =
    cfgLocal.steps.find((s) => s.name === step.name) ?? step;
  const skillMeta = useMemo(
    () =>
      skillLib
        ? Object.fromEntries(skillLib.map((s) => [s.name, s.description]))
        : undefined,
    [skillLib],
  );
  // 链路校验供给侧：上游步骤的预期产物与其技能 outputs + 本步骤声明输入 + 项目资源
  const chainSupply = useMemo(() => {
    const idx = cfgLocal.steps.findIndex((s) => s.name === step.name);
    const upstream = (idx > 0 ? cfgLocal.steps.slice(0, idx) : []).flatMap(
      (s) => [
        ...s.expectedArtifacts,
        ...(skillLib
          ? s.skills.flatMap(
              (n) => skillLib.find((x) => x.name === n)?.outputs ?? [],
            )
          : []),
      ],
    );
    return [
      ...upstream,
      ...(stepNow.inputs ?? []),
      ...(stepNow.optionalInputs ?? []),
      ...(stepNow.anyOfInputs ?? []).flat(),
      ...cfgLocal.resources.map((r) => r.path),
    ];
  }, [cfgLocal, step.name, stepNow, skillLib]);

  // TASK.md 提货单/技能元数据（打开时读一次）
  const [extras, setExtras] = useState<{
    artifacts: ArtifactEntryDto[];
    skillMeta: Record<string, string> | undefined;
    providesByName: Record<string, string[]> | undefined;
    /** 已定方向（决策项答案，读自任务书草稿）：渲染进 TASK.md 的「已定方向」段 */
    decisions: { q: string; answer: string }[];
    upstream: UpstreamAcceptance[];
  } | null>(null);
  const [mainDirtyFiles, setMainDirtyFiles] = useState<GitFileDto[] | null>(
    null,
  );
  // 接驳候选必须看原始清单：userWorkDirtyFiles 已把积累面（notes/*.md 等）剔除，
  // 从过滤后的表取会让「未提交笔记」臂永远空转——intakeBridgeSurfaceKind 自带 inbox.md 排除
  const [mainRawFiles, setMainRawFiles] = useState<GitFileDto[] | null>(null);
  const [mainDirtyMerging, setMainDirtyMerging] = useState(false);
  // 积累芯片计数（项目根 papers/reading-list.md 非注释行数；文件缺失为 0）
  const [accCount, setAccCount] = useState(0);
  // 开工接驳（2026-10-13）：积累面脏文件的清单 md 主仓内容（数非注释行用）与勾选态。
  // 默认勾选——接驳是把人攒的积累带进本轮基准，不是需要人主动开启的额外动作
  const [intakeTexts, setIntakeTexts] = useState<Record<string, string>>({});
  const [intakeChecked, setIntakeChecked] = useState(true);
  // 开工软门二击态 + 就地「存进历史」（与上一步收尾软门同款交互）
  const [dirtySaving, setDirtySaving] = useState(false);
  const [dirtySaveError, setDirtySaveError] = useState<string | null>(null);
  // 人工事项状态（HumanTasksList 回传）：开工前（before）未完成的提醒用
  const [humanStates, setHumanStates] = useState<HumanTaskStateDto[] | null>(
    null,
  );
  // 上一步收尾软门（用户拍板）：上一步非可选 after 事项未勾 → 「确认开始」要按两次
  // （只确认不阻断——不违反「主路径唯一不设门控」，但跳过审阅必须明确表态）。
  // 大纲没审就开初稿这类返工最贵的跳步，就靠它拦住手滑
  const [allHumanStates, setAllHumanStates] = useState<HumanTaskStateDto[] | null>(
    null,
  );
  const [closingAcked, setClosingAcked] = useState(false);
  // 未登记资源提醒（打开时只读扫描一次）：有候选才渲染，默认不勾选不打扰，登记后小节消失
  const [resCandidates, setResCandidates] = useState<
    DiscoveredResourceDto[] | null
  >(null);
  const [resChecked, setResChecked] = useState<Set<string>>(new Set());
  const [resSaving, setResSaving] = useState(false);
  const [resError, setResError] = useState<string | null>(null);

  // 任务书草稿（v3.72）：有可执行正文时编辑区初始 = 文件全文（优先于模板拼装）；
  // 空/仅决策/仅评审沉淀走 resolveTaskMdSource。undefined = 尚未加载（防闪换）
  const [draftText, setDraftText] = useState<string | null | undefined>(
    undefined,
  );
  const [draftRel, setDraftRel] = useState<string | null>(null);

  // 旧版简报兜底（.ccode/brief-*.md，新口径不再自动带入 TASK.md）：
  // 草稿为空且旧简报非空时给提示行，「并入草稿」逐份读后 append_step_draft
  const [legacyBriefs, setLegacyBriefs] = useState<string[] | null>(null);
  const [legacyMerging, setLegacyMerging] = useState(false);
  const [legacyError, setLegacyError] = useState<string | null>(null);

  // TASK.md 编辑区：默认拼装内容 + 人编辑覆盖（状态机在 task-cards.ts，纯逻辑可测）
  const [editor, dispatchEditor] = useReducer(
    taskMdEditorReduce,
    { text: "", dirty: false } satisfies TaskMdEditorState,
  );
  const [editorReady, setEditorReady] = useState(false);
  const [toolsBlocked, setToolsBlocked] = useState(false);
  const [evidenceRevision, setEvidenceRevision] = useState<string | null>(null);
  useEffect(() => { setEvidenceRevision(null); }, [stepNow.workspaceName]);
  const gate = decisionGate(stepNow, editor.text, evidenceRevision);
  const staleTools = editorReady && !researchToolContractMatches(stepNow, editor.text);
  const [decisionAck, setDecisionAck] = useState<string | null>(null);
  // 合同或未答问题变了，旧确认自动失效。
  const decisionSignature = JSON.stringify([stepNow.workspaceName, gate.missing, editor.text]);
  const needsDecisionAck = gate.needsAck && decisionAck !== decisionSignature;
  // TASK.md 编辑区默认折叠：它是自动拼装的合同，绝大多数开工不需要看，
  // 更不该摆在正中暗示「你得先改这个」。想看/想改一点即展开
  const [taskMdOpen, setTaskMdOpen] = useState(false);
  const [inputChips, setInputChips] = useState<KickoffInputChip[] | null>(null);
  const [chipPreview, setChipPreview] = useState<{
    path: string;
    text: string;
  } | null>(null);
  const profiles = useAppStore((s) => s.profiles);
  const agents = useAppStore((s) => s.agents);
  const setPage = useAppStore((s) => s.setPage);
  const remembered = useMemo(loadAskAiRemembered, []);
  const installed = useMemo(
    () => new Set(agents.filter((a) => a.binaryPath).map((a) => a.id)),
    [agents],
  );
  // 步骤槽绑定（B1）：显式绑定的三元组作弹层预选来源（弹层内可见选择即最终
  // 启动值；绑定模型不在名单时按弹层自身链回落，预选失效≠启动错误）
  const stepBinding = useMemo(
    () => taskBindingLaunch(profiles, taskBindings?.[stepSlotKey(step.name)]),
    [profiles, taskBindings, step.name],
  );
  // 开工记忆：项目级 kickoffLast（本弹层每次确认无条件写）；缺失时只读回落
  // 问 AI 记忆（useDefault 勾过的）做首跑预填——不回写，保老用户肌肉记忆
  const kickoffMemory = useMemo(() => {
    const last = loadKickoffLast(projectPath);
    if (last) return { agentId: last.agentId, profileId: last.profileId, model: last.model };
    // 不过滤 useDefault：旧开工弹层自己写的记忆（可能没勾「设为默认」）也预填——
    // 设计口径「kickoffLast 缺失时只读回落 loadAskAiRemembered() 做首跑预填」
    return remembered;
  }, [projectPath, remembered]);
  const picked = useMemo(
    () =>
      pickKickoffLaunch(
        profiles,
        kickoffMemory,
        null,
        stepBinding?.agentId ?? preferredAgent,
        stepBinding?.profileId ?? preferredProfile,
        stepBinding?.model ?? preferredModel,
      ),
    [profiles, kickoffMemory, stepBinding, preferredAgent, preferredProfile, preferredModel],
  );
  const [agentId, setAgentId] = useState(
    () => picked?.agentId ?? "claude-code",
  );
  const agentProfiles = profiles.filter((p) => p.agent === agentId);
  const [profileId, setProfileId] = useState(() => picked?.profileId ?? "");
  const [model, setModel] = useState(() => picked?.model ?? "");
  const [editingLaunch, setEditingLaunch] = useState(
    // 任一预填源在（步骤绑定 / 项目默认 / 开工记忆）即折叠成一行 launchLine
    () => !(stepBinding || preferredAgent || kickoffMemory),
  );
  // 「本次手选永远最高」守卫（塔顶规则）：三个下拉任一被手改后，异步刷新
  // （窗口聚焦→loadAll→profiles 引用替换、taskBindings 晚到）不得再把预选顶回
  // 槽/项目默认/记忆值——顶回过一次实测会把用户明确换掉的付费连接悄悄跑起来。
  const launchTouchedRef = useRef(false);
  const saveTouchedRef = useRef(false);

  useEffect(() => {
    if (launchTouchedRef.current) return;
    const next = pickKickoffLaunch(
      profiles,
      kickoffMemory,
      null,
      stepBinding?.agentId ?? preferredAgent,
      stepBinding?.profileId ?? preferredProfile,
      stepBinding?.model ?? preferredModel,
    );
    if (!next) {
      setProfileId("");
      return;
    }
    setAgentId(next.agentId);
    setProfileId(next.profileId);
    setModel(next.model);
    // 依赖补 stepBinding：绑定随 taskBindings 异步到位时重置预选（终检钉住的点）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, preferredAgent, preferredProfile, preferredModel, stepBinding, kickoffMemory]);

  useEffect(() => {
    if (!agentProfiles.some((p) => p.id === profileId))
      setProfileId(agentProfiles[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, profiles]);

  const selected = agentProfiles.find((p) => p.id === profileId);
  const official = selected?.accountType === "official";
  useEffect(() => {
    if (!selected) return;
    if (official && !officialModelAllowed(agentId, model)) {
      setModel(selected.models[0] ?? "");
    } else if (
      selected.models.length > 0 &&
      model &&
      !selected.models.includes(model)
    ) {
      setModel(selected.models[0] ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  // 本次思考档（2026-09-15）：开工前设起点。只有该 agent+绑定+模型有启动注入通道
  // （combo_surface 的 injectEffortAllowed）才显示——不给用户调不了的东西；
  // 值是「本次覆盖」，不写回绑定（改持久默认去网关库逐模型策略）。
  // 运行中仍可在底部状态栏调（状态栏是运行层，这里是起点，数据源同是 combo）。
  const [kickEffort, setKickEffort] = useState("");
  const [effortInjectable, setEffortInjectable] = useState(false);
  useEffect(() => {
    if (!profileId || !model.trim()) {
      setEffortInjectable(false);
      return;
    }
    let stale = false;
    invoke<{ injectEffortAllowed?: boolean }>("combo_surface", {
      profileId,
      model: model.trim(),
    })
      .then((c) => {
        if (!stale) setEffortInjectable(c.injectEffortAllowed === true);
      })
      .catch(() => {
        if (!stale) setEffortInjectable(false);
      });
    return () => {
      stale = true;
    };
  }, [profileId, model]);
  // 档位来源：agent 规格的 effort 档表（claude/qwen/kimi 实证闭集）；
  // 只有注入通道、没有原生档表的 agent（codex 配置注入）给通用三档
  const effortLevels = useMemo(() => {
    const spec = agents.find((a) => a.id === agentId)?.effort;
    return spec?.levels?.length ? spec.levels : ["low", "medium", "high"];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, agents]);

  const launch: KickoffLaunch | null = profileId
    ? {
        agentId,
        profileId,
        model: model.trim(),
        effort: kickEffort.trim() || null,
      }
    : null;
  const launchLine = kickoffLaunchLabel(launch, profiles, (id) =>
    AGENTS.find((a) => a.id === id)?.label ?? id,
  );
  // 「存为本步骤默认」两态（B1）：勾=确认时写 step 槽；不勾=槽原样不动（清槽去
  // Agents 页步骤组）。初值 = 槽存在 && 当前预选==槽值；展开改选偏离槽值时自动
  // 摘勾（改一次选择≠想改默认，要覆盖须再勾一次）
  const selectionMatchesSlot =
    !!stepBinding &&
    launch?.agentId === stepBinding.agentId &&
    launch?.profileId === stepBinding.profileId &&
    launch?.model === stepBinding.model;
  const [saveStepDefault, setSaveStepDefault] = useState(selectionMatchesSlot);
  useEffect(() => {
    if (!selectionMatchesSlot) setSaveStepDefault(false);
    // 晚到的绑定补勾：冷启动 profiles/taskBindings 后到时挂载瞬间算不出匹配，
    // 预选被重置成槽值后勾选框应回到「已存默认」的勾态（两态勾选的视觉契约）。
    // 仅在用户没手改过启动三连、也没碰过勾选框时补——手改后不越权翻回。
    else if (!launchTouchedRef.current && !saveTouchedRef.current) setSaveStepDefault(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionMatchesSlot]);
  const slotLine = stepBinding
    ? kickoffLaunchLabel(
        { ...stepBinding, effort: null },
        profiles,
        (id) => AGENTS.find((a) => a.id === id)?.label ?? id,
      )
    : null;

  // 打开时一次性加载：提货单/技能元数据 + 主仓状态 + 技能库 + 未登记资源 + 任务书草稿 + 旧版简报；不轮询
  useEffect(() => {
    let stale = false;
    gatherTaskMdExtras(projectPath, step).then((value) => {
      if (!stale) setExtras(value);
    }).catch((reason) => { if (!stale) { setSkillError(`无法读取上游验收：${String(reason)}，请关闭后重试`); setEditorReady(false); } });
    invoke<KickoffInputChip[]>("inspect_step_inputs", {
      projectRoot: projectPath,
      stepName: step.name,
    })
      .then((chips) => {
        if (!stale) setInputChips(chips);
      })
      .catch(() => {
        if (!stale) setInputChips([]);
      });
    // 积累芯片：条目数与 reading-list.md 非注释行同一口径（后端解析同一文件）
    invoke<unknown[]>("list_reading_list_entries", {
      projectRoot: projectPath,
    })
      .then((entries) => {
        if (!stale) setAccCount(Array.isArray(entries) ? entries.length : 0);
      })
      .catch(() => {
        if (!stale) setAccCount(0);
      });
    invoke<GitStatusBrief>("git_status", { cwd: projectPath })
      .then((status) => {
        if (stale) return;
        const dirty = status.isRepo ? userWorkDirtyFiles(status.files) : [];
        setMainDirtyFiles(status.isRepo ? dirty : null);
        setMainRawFiles(status.isRepo ? status.files : null);
        setMainDirtyMerging(status.merging === true);
      })
      .catch(() => {});
    invoke<SkillDto[]>("list_skills")
      .then((lib) => {
        if (!stale) setSkillLib(lib);
      })
      .catch(() => {});
    invoke<DiscoveredResourceDto[]>("discover_resources", { path: projectPath })
      .then((items) => {
        if (!stale) {
          setResCandidates(
            items.filter(
              (d) =>
                !d.exists &&
                // 全流水线口径（2026-09-19）：任一步骤声明过的输入/预期产物都不算陌生
                // 发现——检索步直写 papers/ 的 OA PDF 只在精读步声明为可选输入，
                // 只看本步骤会把它们在综述大纲等后续步骤整批再报一遍
                !isFlowDeclaredPath(d.path, cfgLocal.steps),
            ),
          );
        }
      })
      .catch(() => {});
    invoke<{ relPath: string; text: string | null }>("read_task_draft", {
      projectRoot: projectPath,
      stepName: step.name,
    })
      .then((d) => {
        if (stale) return;
        setDraftRel(d.relPath);
        setDraftText(d.text);
      })
      .catch(() => {
        if (!stale) setDraftText(null);
      });
    invoke<string[]>("list_legacy_briefs", { projectRoot: projectPath })
      .then((paths) => {
        if (!stale) setLegacyBriefs(paths);
      })
      .catch(() => {
        if (!stale) setLegacyBriefs([]);
      });
    // 全量人工事项状态（上一步收尾软门用；本步骤的状态由 HumanTasksList 回传，互不相同）
    invoke<HumanTaskStateDto[]>("list_human_task_states", {
      projectRoot: projectPath,
    })
      .then((all) => {
        if (!stale) setAllHumanStates(all);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  // 默认拼装（与实际落盘同一 renderTaskMd，单一出处）：extras/技能元数据就绪即拼。
  // 编辑区 dirty（人改过）时 assemble 事件被状态机忽略，不覆盖用户内容
  const assembled = useMemo(() => {
    if (!extras) return null;
    return renderTaskMd(
      stepNow,
      cfgLocal,
      projectPath,
      extras.artifacts,
      skillMeta ?? extras.skillMeta,
      // 弹层打开时的快照可能落后于弹层内刚挂的技能：有 skillLib 时现算
      skillLib
        ? Object.fromEntries(skillLib.map((s) => [s.name, s.provides ?? []]))
        : extras.providesByName,
      extras.decisions,
      IS_WINDOWS,
    );
  }, [extras, stepNow, cfgLocal, skillMeta, projectPath]);

  // 编辑区初始化：有可执行正文时文件全文优先于模板拼装——讨论的直接产物，所见即所得。
  // 空文件 / 只点了决策项 / 评审沉淀新建的小节都不算正文：顶掉拼装会把简报、产物、
  // 技能、人工事项丢掉。这种情况走模板拼装，并把评审沉淀接到后面。
  // 「恢复默认拼装」仍回模板拼装。等草稿加载完再初始化，避免闪换
  useEffect(() => {
    if (assembled === null || draftText === undefined) return;
    const source = resolveTaskMdSource(draftText, assembled);
    dispatchEditor({ type: "assemble", text: appendUpstreamAcceptance(source, extras?.upstream ?? []) });
    setEditorReady(true);
  }, [assembled, draftText, extras]);

  /** 旧版简报「并入草稿」：逐份读全文（单份失败行内报错、其余继续），
   *  合并为一段经 append_step_draft 追加，完成后重读草稿刷新编辑区（人未编辑时 assemble 生效） */
  async function mergeLegacyBriefs() {
    if (!legacyBriefs || legacyBriefs.length === 0 || legacyMerging) return;
    setLegacyMerging(true);
    setLegacyError(null);
    const root = projectPath.replace(/[\\/]+$/, "");
    const parts: string[] = [];
    for (const rel of legacyBriefs) {
      try {
        const p = await invoke<{ text: string }>("read_file_preview", {
          path: `${root}/${rel}`,
          root: projectPath,
        });
        parts.push(`### ${rel}\n\n${p.text.trim()}`);
      } catch (reason) {
        setLegacyError(`「${rel}」读取失败：${String(reason)}（其余继续并入）`);
      }
    }
    try {
      if (parts.length > 0) {
        await invoke("append_step_draft", {
          projectRoot: projectPath,
          stepName: step.name,
          heading: "旧简报并入",
          content: parts.join("\n\n"),
        });
        const d = await invoke<{ relPath: string; text: string | null }>(
          "read_task_draft",
          { projectRoot: projectPath, stepName: step.name },
        );
        setDraftRel(d.relPath);
        setDraftText(d.text);
      }
    } catch (reason) {
      setLegacyError(String(reason));
    } finally {
      setLegacyMerging(false);
    }
  }

  /** 技能区增删（v3.67）：写回 project.toml steps[].skills（持久配置，影响以后所有开工），
   *  成功后重读档案卡同步本地与父级，预览经 renderTaskMd 即时联动 */
  async function onSkillsChange(next: string[]) {
    setSkillError(null);
    try {
      await invoke("update_step_skills", {
        projectRoot: projectPath,
        stepName: step.name,
        skills: next,
      });
      const read = await invoke<{ config: ProjectConfigDto }>(
        "read_project_config",
        { path: projectPath },
      );
      setCfgLocal(read.config);
      onCfgChange?.(read.config);
    } catch (reason) {
      setSkillError(String(reason));
    }
  }

  /** 「登记选中」未登记资源：resources 数组整体写回 project.toml（与资源面板同一口径），
   *  成功后重读档案卡同步本地与父级，小节消失 */
  async function registerResources() {
    if (!resCandidates || resChecked.size === 0 || resSaving) return;
    setResSaving(true);
    setResError(null);
    try {
      const additions = resCandidates
        .filter((d) => resChecked.has(d.path))
        .map((d) => ({
          name: d.path.split("/").pop() ?? d.path,
          path: d.path,
          type: d.type,
          readonly: false,
          note: "",
        }));
      await invoke("write_project_config", {
        path: projectPath,
        config: {
          ...cfgLocal,
          resources: [...cfgLocal.resources, ...additions],
        },
      });
      const read = await invoke<{ config: ProjectConfigDto }>(
        "read_project_config",
        { path: projectPath },
      );
      setCfgLocal(read.config);
      onCfgChange?.(read.config);
      setResCandidates(null);
    } catch (reason) {
      setResError(String(reason));
    } finally {
      setResSaving(false);
    }
  }

  // 旧简报提示行口径：草稿加载完且为空 + 旧简报非空
  const showLegacyHint =
    draftText !== undefined &&
    !draftText?.trim() &&
    (legacyBriefs?.length ?? 0) > 0;
  // 上一步收尾软门：按流水线顺序取紧邻上一步，其非可选 after 事项未勾则需要二次确认
  const prevStep = (() => {
    const idx = cfgLocal.steps.findIndex((s) => s.name === step.name);
    return idx > 0 ? cfgLocal.steps[idx - 1] : null;
  })();
  const prevClosing =
    prevStep && allHumanStates
      ? closingHumanTasks(allHumanStates, prevStep.name)
      : [];
  // 开工软门（2026-09-20）：工作区从本地基准分支 HEAD 建树，项目根未提交的改动带不进去。
  // 改动与本步声明输入相交时升级成软门（列文件 + 就地存进历史 + 二击确认）；
  // 不相交的仍只是顶部那行提醒（想法期实验性改动留在主仓是合法的）
  // 开工接驳勾选时（2026-10-13），积累面文件从软门排除——它们由接驳提交带进基准，
  // 不再走「存进历史」双份提交；不勾选则保持软门原行为（保留警告）
  const intakeHits = useMemo(
    () => (mainRawFiles ? intakeBridgeHits(mainRawFiles) : []),
    [mainRawFiles],
  );
  const intakePaths = useMemo(
    () => new Set(intakeHits.map((h) => h.path)),
    [intakeHits],
  );
  const dirtyHits = useMemo(() => {
    if (!mainDirtyFiles) return [];
    const base = dirtyInputHits(mainDirtyFiles, [
      ...(stepNow.inputs ?? []),
      ...(stepNow.optionalInputs ?? []),
      ...(stepNow.anyOfInputs ?? []).flat(),
    ]);
    return intakeChecked
      ? base.filter((f) => !intakePaths.has(f.path))
      : base;
  }, [mainDirtyFiles, stepNow, intakeChecked, intakePaths]);

  // 接驳摘要：清单 md 拿主仓内容数非注释行（打开时读一次，读失败按空计）、笔记按份数
  const intakeLedgerMdKey = intakeHits
    .filter((h) => h.kind === "ledger" && h.path.endsWith(".md"))
    .map((h) => h.path)
    .join("\n");
  useEffect(() => {
    let stale = false;
    const rels = intakeLedgerMdKey ? intakeLedgerMdKey.split("\n") : [];
    if (rels.length === 0) {
      setIntakeTexts({});
      return;
    }
    const root = projectPath.replace(/[\\/]+$/, "");
    Promise.all(
      rels.map(async (rel) => {
        try {
          const p = await invoke<{ text: string }>("read_file_preview", {
            path: `${root}/${rel}`,
            root: projectPath,
          });
          return [rel, p.text] as const;
        } catch {
          return [rel, ""] as const;
        }
      }),
    ).then((pairs) => {
      if (!stale) setIntakeTexts(Object.fromEntries(pairs));
    });
    return () => {
      stale = true;
    };
  }, [projectPath, intakeLedgerMdKey]);
  const intakeSummary = useMemo(
    () => summarizeIntakeBridge(intakeHits, intakeTexts),
    [intakeHits, intakeTexts],
  );
  const intakeLine = intakeHits.length > 0
    ? intakeBridgeLabel(
        intakeSummary,
        intakeHits.filter((h) => h.kind === "ledger").length,
      )
    : "";
  const intakeDecision: IntakeBridgeDecision | undefined =
    intakeHits.length > 0
      ? { accepted: intakeChecked, paths: intakeHits.map((h) => h.path) }
      : undefined;
  const rootDir = projectPath.replace(/[\\/]+$/, "");
  const accChip = useMemo(
    () => accumulationChip(accCount, `${rootDir}/papers/reading-list.md`),
    [accCount, rootDir],
  );
  const chipsView = useMemo(
    () => (inputChips && accChip ? [...inputChips, accChip] : inputChips),
    [inputChips, accChip],
  );
  async function saveDirtyHits(): Promise<boolean> {
    const blocked = historySaveBlockedReason(dirtyHits, mainDirtyMerging);
    if (blocked) {
      setDirtySaveError(blocked);
      return false;
    }
    setDirtySaving(true);
    setDirtySaveError(null);
    try {
      await invoke("git_commit", {
        cwd: projectPath,
        message: historySaveMessage("开工前存档", dirtyHits),
        push: false,
        paths: dirtyHits.map((f) => f.path),
      });
      // 重读 git_status：命中清空后软门消失，剩余改动回到顶部提醒行
      const status = await invoke<GitStatusBrief>("git_status", {
        cwd: projectPath,
      });
      const dirty = status.isRepo ? userWorkDirtyFiles(status.files) : [];
      setMainDirtyFiles(status.isRepo ? dirty : null);
      setMainRawFiles(status.isRepo ? status.files : null);
      setMainDirtyMerging(status.merging === true);
      return true;
    } catch (reason) {
      setDirtySaveError(String(reason));
      return false;
    } finally {
      setDirtySaving(false);
    }
  }
  /** 确认开工的统一收口（B1 记忆拆键）：
   *  ① 无条件写项目级开工记忆 kickoffLast（下次开工预填/折叠判定）；
   *  ② 勾「存为本步骤默认」才写 step 槽——不勾槽原样不动（临时换一次不毁绑定）；
   *  ③ 不再写全局问 AI 记忆（那是 AskAiModal 自管的键）。
   *  把接驳决定随第四参交回调用方（无命中传 undefined；透传给 startPipelineStep） */
  function confirmKickoff() {
    if (launch) {
      saveKickoffLast(projectPath, {
        agentId: launch.agentId,
        profileId: launch.profileId,
        model: launch.model,
      });
      if (saveStepDefault) {
        // 失败不拦开工（fire-and-forget）：槽写不进只是没记住默认，开工照常；
        // 但「勾了却没存成」要让人知道（典型：记忆里残留的模型不在所选连接名单）
        void invoke("set_project_agent_binding", {
          projectRoot: projectPath,
          slot: stepSlotKey(step.name),
          profileId: launch.profileId,
          model: launch.model || null,
        }).catch((reason) => {
          toast(`本步骤默认没存成：${String(reason)}。开工不受影响，可去 Agents 页重存。`, "warning");
        });
      }
    }
    onConfirm(editor.text, launch, gate.needsAck && !needsDecisionAck, intakeDecision);
  }
  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/40 p-4 ccode-fade"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-lg border border-field ccode-float-surface"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 工作区名写在标题行右侧：原先挂在整个弹层的 title 上，鼠标停在任务书里就冒出一个
            「工作区 lit-notes」悬浮框压在正文上（2026-10-17 用户截图） */}
        <div className="flex shrink-0 items-baseline gap-3 px-5 pt-5">
          <h2 className="min-w-0 truncate text-base font-semibold text-l1">开始 {step.name}</h2>
          {step.workspaceName && (
            <span
              className="ml-auto shrink-0 font-mono text-micro text-l4"
              title="这一步在独立工作区里做，保存进项目之前不动项目里的文件"
            >
              工作区 {step.workspaceName}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4">
        {/* 上游还没保存进项目（2026-10-17）：放最上面——下面「读入」的篇数读的是项目里的旧版，
            不先点破，人会照着旧清单开工。只确认不阻断，与上一步收尾软门共用二击 */}
        {unsavedUpstream.length > 0 && (
          <div className="mb-4 rounded-md ccode-well px-3 py-2 text-xs leading-5 text-l2">
            {unsavedUpstream.map((u) => (
              <div key={u.name} className="flex items-start gap-2">
                <span className="w-2 shrink-0 text-center text-warn-text">!</span>
                <p className="min-w-0 flex-1">
                  上一步「{u.name}」{UPSTREAM_STATUS_TEXT[u.status]}，还没保存进项目。这一步要读的{" "}
                  {u.inputs.map(chipFileName).join("、")} 现在还是项目里的旧版。
                </p>
                {onOpenUpstreamReview && (
                  <span className="shrink-0 text-micro">
                    <button
                      type="button"
                      onClick={() => onOpenUpstreamReview(u)}
                      className="rounded-sm border border-field px-1.5 py-0.5 text-l2 hover:bg-hover hover:text-l1"
                    >
                      {u.status === "blocked" ? "去处理冲突" : "去评审"}
                    </button>
                  </span>
                )}
              </div>
            ))}
            <p className="mt-1 pl-4 text-micro text-l4">
              {closingAcked
                ? "再点一次「仍要开工」即按现状开工。"
                : "建议先保存进项目再开工；要按现状开工就点「确认开始」，按钮会再问你一次。"}
            </p>
          </div>
        )}
        {chipsView && chipsView.some((chip) => formatKickoffChip(chip)) && (
          <KickoffRow label="读入" title="这一步开工时项目里已有的输入；点芯片看开头">
            <div className="flex flex-wrap gap-1 text-micro">
              {chipsView.map((chip) => {
                if (isOwnDeliverable(chip.pattern, stepNow.expectedArtifacts)) return null;
                const view = formatKickoffChip(chip);
                if (!view) return null;
                return (
                  <button
                    key={`${chip.role}:${chip.pattern}`}
                    type="button"
                    disabled={!chip.previewPath}
                    title={chip.pattern}
                    onClick={() => {
                      if (!chip.previewPath) return;
                      invoke<{ text: string }>("read_file_preview", {
                        path: chip.previewPath,
                        root: projectPath,
                      })
                        .then((p) =>
                          setChipPreview({
                            path: chip.pattern,
                            text: p.text.slice(0, 2000),
                          }),
                        )
                        .catch(() =>
                          setChipPreview({
                            path: chip.pattern,
                            text: "无法预览这个文件。",
                          }),
                        );
                    }}
                    className={`rounded-sm px-1.5 py-0.5 ${
                      view.missing
                        ? "bg-warn text-warn-text"
                        : "bg-inset text-l2 hover:bg-hover"
                    } disabled:cursor-default`}
                  >
                    {view.label}
                  </button>
                );
              })}
            </div>
            {chipPreview && (
              <pre className="mt-1.5 max-h-24 overflow-auto rounded-md bg-inset p-2 font-mono text-micro text-l3">
                {chipPreview.path}
                {"\n"}
                {chipPreview.text}
              </pre>
            )}
          </KickoffRow>
        )}
        {(() => {
          const deliver = expectedDeliverNames(stepNow.expectedArtifacts);
          return deliver.length > 0 ? (
            <KickoffRow label="产出" title="这一步要交的文件；评审时逐个核对">
              <div className="flex flex-wrap gap-1 text-micro">
                {deliver.map((name) => (
                  <span key={name} className="rounded-sm bg-inset px-1.5 py-0.5 text-l2">
                    {name}
                  </span>
                ))}
              </div>
            </KickoffRow>
          ) : null;
        })()}

        {staleTools && <InlineNotice tone="warn" className="my-2">旧任务书的工具合同与当前选择不同。请展开 TASK.md 对照，或「恢复默认拼装」后重新确认；未覆盖你的草稿。</InlineNotice>}
        {(stepNow.decisions?.length ?? 0) > 0 && <>
          <UpstreamResearchAcceptance projectRoot={projectPath} stepName={stepNow.name} decisions={stepNow.decisions ?? []} text={editor.text} evidenceRevision={evidenceRevision} onChange={(text) => dispatchEditor({ type: "edit", text })} />
          <ResearchEvidencePanel key={`${projectPath}:${stepNow.workspaceName}`} root={projectPath} patterns={researchReportPatterns(stepNow, "decision")} kind="decision"
            onFingerprint={setEvidenceRevision} />
          <ResearchDecisionFields decisions={stepNow.decisions ?? []} text={editor.text} disabled={busy || !editorReady}
            evidenceRevision={evidenceRevision}
            onChange={(text) => dispatchEditor({ type: "edit", text })} />
        </>}

        {/* 材料（读入/产出）与执行（谁做/怎么做）两组之间只靠留白分开，不画线 */}
        <div className="mt-3">
        <KickoffRow label="执行" title="这一步用哪家 AI、哪条连接、哪个模型">
        {profiles.length === 0 ? (
          <p>
            还没有可用连接。
            <button
              type="button"
              className="ml-1 text-cta-pill-text hover:underline"
              onClick={() => {
                onCancel();
                setPage("profiles");
              }}
            >
              去添加
            </button>
          </p>
        ) : launch && !editingLaunch ? (
          <div className="flex min-w-0 items-center gap-2 pt-px">
            <span className="min-w-0 truncate" title={launchLine}>
              {launchLine}
            </span>
            {selectionMatchesSlot && (
              <span
                className="shrink-0 text-micro text-l4"
                title="本步骤已存专属默认（Agents → 专属绑定可改可清）"
              >
                · 本步骤默认
              </span>
            )}
            <span className="shrink-0 text-micro">
              <button
                type="button"
                className="rounded-sm px-1 py-0.5 text-l3 hover:bg-hover hover:text-l1"
                onClick={() => setEditingLaunch(true)}
              >
                更换
              </button>
            </span>
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-3 gap-1.5">
              <label className="min-w-0 text-micro text-l4">
                Agent
                <select
                  className={`${compactFieldClass} mt-0.5 w-full`}
                  value={agentId}
                  onChange={(e) => { launchTouchedRef.current = true; setAgentId(e.target.value); }}
                >
                  {[...AGENTS]
                    .sort(
                      (a, b) =>
                        Number(installed.has(b.id)) -
                        Number(installed.has(a.id)),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                        {!installed.has(a.id) ? "（未安装）" : ""}
                      </option>
                    ))}
                </select>
              </label>
              <label className="min-w-0 text-micro text-l4">
                连接
                <select
                  className={`${compactFieldClass} mt-0.5 w-full`}
                  value={profileId}
                  onChange={(e) => { launchTouchedRef.current = true; setProfileId(e.target.value); }}
                >
                  {agentProfiles.length === 0 ? (
                    <option value="">没有连接</option>
                  ) : (
                    agentProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label className="min-w-0 text-micro text-l4">
                模型
                <select
                  className={`${compactFieldClass} mt-0.5 w-full`}
                  value={model}
                  onChange={(e) => { launchTouchedRef.current = true; setModel(e.target.value); }}
                  disabled={!selected}
                >
                  {(selected?.models.length
                    ? selected.models
                    : model
                      ? [model]
                      : [""]
                  ).map((m) => (
                    <option key={m || "default"} value={m}>
                      {m || "默认"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Checkbox
              className="mt-2 text-micro text-l3"
              checked={saveStepDefault}
              onChange={(checked) => { saveTouchedRef.current = true; setSaveStepDefault(checked); }}
              label="存为本步骤默认（下次开工直接用它）"
            />
            {stepBinding && !selectionMatchesSlot && slotLine && (
              // 披露（终检钉住）：已有绑定且本次选择偏离时明说，防止「被顶掉」的无知感
              <p className="mt-1 truncate text-micro text-l4" title={`${slotLine}；本次 ${launchLine}`}>
                已存默认 {slotLine}；本次用 {launchLine}（不勾即不改默认）
              </p>
            )}
          </div>
        )}
        </KickoffRow>

        {/* 本次思考档（2026-09-15）：只在有注入通道时出现（见上方 combo 判定） */}
        {launch && effortInjectable && (
          <KickoffRow label="思考档" title="只影响这一次运行，不改绑定的默认策略；运行中还可在底部状态栏调整">
            <div className="text-micro">
              <select
                className="h-6 rounded-md border border-field bg-canvas px-1 text-l2 outline-none focus:border-l4"
                value={kickEffort}
                onChange={(e) => setKickEffort(e.target.value)}
              >
                <option value="">不设（用绑定默认）</option>
                {effortLevels.map((lv) => (
                  <option key={lv} value={lv}>
                    {lv}
                  </option>
                ))}
              </select>
            </div>
          </KickoffRow>
        )}

        {/* 技能：挂载芯片（增删写回步骤定义）+ 只读预检。预检全部就绪只留一行小字，
            有缺口才展开成块——原先就绪时也摆一整块，和技能芯片把同一件事说两遍 */}
        <KickoffRow label="技能" title="增删会写回这一步的技能，以后开工都用这份">
          <StepSkillsChips
            bare
            hint={false}
            skills={stepNow.skills}
            requiredSkills={stepNow.requiredSkills}
            skillMeta={skillMeta}
            available={skillLib?.map((s) => s.name)}
            mcpRecommended={skillLib
              ?.filter((s) => s.mentionsMcp)
              .map((s) => s.name)}
            skillLib={skillLib}
            chainSupply={chainSupply}
            expectedArtifacts={stepNow.expectedArtifacts}
            stepOutputs={researchToolArtifacts(stepNow.brief)}
            brief={stepNow.brief}
            onChange={(next) => void onSkillsChange(next)}
          />
          {/* 技能预检跟随弹层当前选的 agentId（不依赖 launch——无连接时也展示，
              切换 Agent 后重查；key 含 agentId 使组件重挂刷新检查结果） */}
          {stepNow.skills.length > 0 && <ResearchToolPreflight key={`${stepNow.name}:${stepNow.skills.join(",")}:${agentId}`} projectRoot={projectPath} stepName={stepNow.name} agent={agentId} onBlocked={setToolsBlocked} />}
          {skillError && (
            <InlineNotice tone="err" className="mt-1">{skillError}</InlineNotice>
          )}
        </KickoffRow>

        {/* 运行权限（2026-09-15）：不做成选项——步骤执行必然可写，边界一句话，细节进悬浮 */}
        {launch && (
          <KickoffRow label="权限">
            <p
              className="pt-px text-micro text-l3"
              title="原始文献 PDF 直接放项目根 papers/；清洗后的数据、图、成稿等派生产物写在步骤工作区，经你评审后才合并进项目"
            >
              可写：步骤工作区、项目根 papers/（原始文献）
            </p>
          </KickoffRow>
        )}
        </div>

        {dirtyHits.length > 0 && (
          <p className="mb-3 text-xs leading-5 text-l3">
            开始时会先记下 {dirtyHits.length} 个这一步要读的文件，再开工。
            {dirtySaveError && (
              <span className="mt-1 block text-err-text">{dirtySaveError}</span>
            )}
          </p>
        )}

        {/* 开工接驳（2026-10-13 双台账拍板）：项目根积累面（流程正典清单 + 用户笔记）有
            未提交改动才出现，默认勾选。勾选 = 随开工提交进基准分支；不勾选 = 照常开工，
            文件留在项目根未提交（它们仍是这一步要读的输入时，走上方存进历史软门） */}
        {intakeHits.length > 0 && (
          <div className="mb-3 shrink-0 rounded-md ccode-well px-2.5 py-2">
            <Checkbox
              checked={intakeChecked}
              onChange={setIntakeChecked}
              label={
                <span className="text-xs text-l2">
                  一并带上未保存的清单与笔记{intakeLine ? `：${intakeLine}` : ""}
                </span>
              }
            />
            <p
              className={`mt-1 pl-5 text-micro leading-4 ${
                intakeChecked ? "text-l4" : "text-warn-text"
              }`}
            >
              {intakeChecked
                ? "将随开工提交进基准分支，供检索步/精读步直接使用你的积累与笔记。"
                : "不带上：这批积累与笔记不进本轮基准分支，工作区里用不到；仍留在项目根（不拦合并），需要时可在终端自行提交。"}
            </p>
            <p
              className="mt-1 break-all pl-5 font-mono text-micro leading-4 text-l4"
              title={intakeHits.map((h) => h.path).join("\n")}
            >
              {intakeHits.map((h) => h.path).join("、")}
            </p>
          </div>
        )}

        {/* 旧版简报兜底（只提醒不阻断）：新口径沉淀走任务书草稿，旧 brief-*.md 不再自动带入 */}
        {showLegacyHint && (
          <div className="mb-3 shrink-0 rounded-sm ccode-well px-2.5 py-1.5 text-xs text-l3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                检测到旧版简报 {legacyBriefs!.length}{" "}
                份，新口径不再自动带入 TASK.md
              </span>
              <button
                type="button"
                disabled={legacyMerging}
                onClick={() => void mergeLegacyBriefs()}
                title="把旧版简报全文逐份追加进本步骤的 TASK.md 内容文件（「旧简报并入」小节），之后可在编辑区再改"
                className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                {legacyMerging ? "并入中…" : "并入 TASK.md"}
              </button>
            </div>
            {legacyError && (
              <InlineNotice tone="err" className="mt-1">{legacyError}</InlineNotice>
            )}
          </div>
        )}

        {/* 未登记资源提醒（只提醒不阻断，默认不勾选）：登记后进 TASK.md 的「项目资源」段。
            本步骤声明要读的输入（如精读的 papers/*.pdf）上面「上一步接到」已经点过名，不重复列。 */}
        {resCandidates && resCandidates.length > 0 && (
          <div className="mb-3 shrink-0 rounded-md ccode-well px-2.5 py-2">
            <div className="mb-1 text-xs text-l3">
              发现 {resCandidates.length} 个未登记文件
            </div>
            <ul className="max-h-28 space-y-0.5 overflow-auto">
              {resCandidates.map((d) => (
                <li key={d.path}>
                  <Checkbox
                    checked={resChecked.has(d.path)}
                    onChange={(checked) => {
                      setResChecked((cur) => {
                        const next = new Set(cur);
                        if (checked) next.add(d.path);
                        else next.delete(d.path);
                        return next;
                      });
                    }}
                    label={
                      <span className="flex min-w-0 items-center gap-2 text-xs">
                        <span className="shrink-0 rounded-sm bg-strip px-1 py-0.5 text-l3">
                          {RESOURCE_TYPE_LABELS[d.type] ?? "其他"}
                        </span>
                        <span
                          className="min-w-0 truncate font-mono text-l2"
                          title={d.path}
                        >
                          {d.path}
                        </span>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                disabled={resSaving}
                onClick={() =>
                  setResChecked((cur) =>
                    cur.size === resCandidates.length
                      ? new Set()
                      : new Set(resCandidates.map((item) => item.path)),
                  )
                }
                className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                {resChecked.size === resCandidates.length ? "取消全选" : "全选"}
              </button>
              <button
                type="button"
                disabled={resChecked.size === 0 || resSaving}
                onClick={() => void registerResources()}
                className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                {resSaving ? "登记中…" : `登记选中（${resChecked.size}）`}
              </button>
              <span className="text-micro text-l4">
                不登记也能开工，登记后 TASK.md 才会列出它们
              </span>
            </div>
            {resError && (
              <InlineNotice tone="err" className="mt-1">{resError}</InlineNotice>
            )}
          </div>
        )}

        {/* 人工事项区（步骤声明了才有）：开工前事项未完成给提醒，只提醒不阻断；
            勾选/提交交付直接可在这里做，与卡片区同一个 HumanTasksList。
            收尾（after）事项不出现（agent 干完才轮到人做），步骤只剩 after 事项时整区不渲染 */}
        {(stepNow.humanTasks?.some((t) => t.timing !== "after") ?? false) && (
          <div className="mb-3">
            {(() => {
              const blocking = humanStates
                ? blockingHumanTasks(humanStates, step.name)
                : [];
              return blocking.length > 0 ? (
                <p className="mb-1.5 text-xs text-warn-text">
                  开始前还有 {blocking.length}{" "}
                  件必办（{blocking.map((t) => t.title).join("、")}
                  ）。现在开始也可以。
                </p>
              ) : null;
            })()}
            <HumanTasksList
              compact
              projectPath={projectPath}
              stepName={step.name}
              onStates={setHumanStates}
            />
          </div>
        )}

        {/* TASK.md 编辑区：默认折叠——它由模板+已定方向+资源自动拼装，绝大多数情况不用改；
            摆在正中会暗示「你得编辑这个」，反而让人不敢开工。人改过（dirty）时保持展开，
            避免改完一折叠就看不见自己写了什么 */}
        <KickoffRow label="任务书" title="TASK.md：交给 AI 的这一步合同，由模板、已定方向和项目资源自动拼好">
          <div className="flex items-center gap-2 text-micro">
            <button
              type="button"
              onClick={() => setTaskMdOpen((v) => !v)}
              aria-expanded={taskMdOpen}
              title={
                taskMdOpen ? "收起 TASK.md" : "展开查看/编辑本步交给 agent 的合同"
              }
              className="-ml-1 flex items-center gap-1 rounded-sm px-1 py-0.5 text-l3 hover:bg-hover hover:text-l1"
            >
              <FoldMark open={taskMdOpen} />
              {taskMdOpen ? "收起 TASK.md" : "查看 TASK.md"}
            </button>
            {editor.dirty && <span className="text-l4">已改</span>}
            {taskMdOpen && editor.dirty && (
              <button
                type="button"
                onClick={() =>
                  assembled !== null &&
                  dispatchEditor({ type: "reset", text: appendUpstreamAcceptance(assembled, extras?.upstream ?? []) })
                }
                title="放弃修改，回到模板的默认拼装"
                className="ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-l4 hover:bg-hover hover:text-l2"
              >
                恢复默认拼装
              </button>
            )}
          </div>
        </KickoffRow>
        {taskMdOpen && (
          <>
            {draftText?.trim() && !isTaskMdStub(draftText) && (
              <p className="mb-1 shrink-0 text-micro text-l4">
                内容来自你编辑过的 TASK.md（{draftRel ?? ""}；改这里只影响本次落盘，不回写该文件）
              </p>
            )}
            <div className="mb-3 min-h-0 flex-1 overflow-hidden rounded-md border border-field bg-canvas">
              {!editorReady ? (
                <div className="p-3">
                  <LoadingRows compact />
                </div>
              ) : (
                <textarea
                  className="h-full max-h-[38vh] min-h-40 w-full resize-none overflow-auto bg-canvas p-3 font-mono text-micro leading-5 text-l2 outline-none placeholder:text-l4"
                  value={editor.text}
                  onChange={(e) =>
                    dispatchEditor({ type: "edit", text: e.target.value })
                  }
                  spellCheck={false}
                />
              )}
            </div>
          </>
        )}

        {/* 上一步收尾软门（只确认不阻断）：未勾的非可选收尾事项逐条列出，
            第一次点「确认开始」只是表态知情，按钮变成「仍要开工」再点才真开 */}
        {prevClosing.length > 0 && prevStep && (
          <p className="mb-3 shrink-0 rounded-md ccode-well px-3 py-2 text-xs leading-5 text-l2">
            <span className="mr-1 text-warn-text">!</span>
            上一步「{prevStep.name}」还有 {prevClosing.length}{" "}
            件收尾事项没完成（{prevClosing.map((t) => t.title).join("、")}
            ）——跳过审阅直接开工，上一步要返工时这一步也得跟着作废。
            {closingAcked
              ? "再点一次「仍要开工」即继续。"
              : "建议先回去过完再来；确认跳过就点「确认开始」，按钮会再问你一次。"}
          </p>
        )}
        {(gate.blocked || gate.needsAck) && (
          <p className="mb-3 shrink-0 rounded-md ccode-well px-3 py-2 text-xs leading-5 text-warn-text">
            待拍板：{gate.missing.join("、")}。
            {gate.blocked
              ? `硬暂停：${gate.gaps.map((g) => `${g.q}（${g.reason === "legacy" ? "旧纯文本需重选状态" : g.reason === "stale" ? "依据已变，需重新确认" : g.reason === "wait" ? "待补证据" : g.reason === "reject" ? "不批准" : "未选择状态并填写说明"}）`).join("、")}。待补或不批准不能开工。`
              : gate.prepareOnly
                ? "当前决定只允许准备，不能当作正式开工授权。"
                : "软暂停：建议先回答；再次确认只允许先做不依赖这些答案的工作。"}
          </p>
        )}

        </div>

        <div className="flex shrink-0 justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className={secondaryActionClass}
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || dirtySaving || !editorReady || !launch || gate.blocked || staleTools || (stepNow.skills.length > 0 && toolsBlocked)}
            onClick={() => {
              if (needsDecisionAck) {
                setDecisionAck(decisionSignature);
                return;
              }
              if ((prevClosing.length > 0 || unsavedUpstream.length > 0) && !closingAcked) {
                setClosingAcked(true);
                return;
              }
              if (dirtyHits.length > 0) {
                void saveDirtyHits().then((saved) => {
                  if (saved) confirmKickoff();
                });
                return;
              }
              confirmKickoff();
            }}
            className={primaryActionClass}
          >
            {busy || dirtySaving
              ? "开始中…"
              : !launch
                ? "先加连接"
                : gate.needsAck && !needsDecisionAck
                  ? gate.prepareOnly ? "仅开始准备" : "先做无依赖工作"
                  : (prevClosing.length > 0 || unsavedUpstream.length > 0) && closingAcked
                  ? "仍要开工"
                  : dirtyHits.length > 0
                    ? "记下并开始"
                    : "确认开始"}
          </button>
        </div>
      </div>
    </div>
  );
}
