import {
  Copy,
  Files,
  SquareTerminal,
  Unlink,
  Workflow,
} from "lucide-react";
import { researchToolsFromSettings, settingsWithResearchTools, withResearchTools, type ResearchTools } from "../research-tools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IS_WINDOWS } from "../hotkeys";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import PipelineEditor from "./PipelineEditor";
import HistoryOverlay from "./HistoryOverlay";

import TemplatePicker, { type TemplatePickItem } from "./TemplatePicker";
import CloseoutPack from "./CloseoutPack";
import { closeoutPackVisible, closeoutScanEntries } from "../closeout-pack";
import ArtifactChecklist, {
  absoluteResourcePath,
  formatSize,
} from "./ArtifactChecklist";
import { REVIEW_SAVE } from "../review-save-copy";
import TaskCardsSection from "./TaskCardsSection";

import ResourceListSection from "./ResourceListSection";
import ProjectUserTasksView from "./ProjectUserTasksView";
import { SettingsDrawerShell, SettingsRulesSection } from "./ProjectSettingsDrawer";
import KickoffConfirmDialog from "./KickoffConfirmDialog";
import { HoverTip, useHoverTip } from "./HoverTip";
import {
  Checkbox,
  compactFieldClass,
  FoldMark,
  compactPrimaryActionClass,
  ghostActionClass,
  hoverRevealClass,
  inlineActionClass,
  NoticeBar,
  secondaryActionClass,
} from "./PageFrame";
import { useAppStore } from "../store";
import { RESOURCE_TYPE_LABELS, settingsForTemplateApply } from "../pipeline-presets";
import { startPipelineStep, type IntakeBridgeDecision } from "../pipeline-start";
import type { KickoffLaunch } from "../kickoff-launch";
import { upsertLitSourceSection, upsertPendingSettingsSection } from "../task-md-sections";
import { isTaskMdStub } from "../step-decisions";
import { userWorkDirtyFiles } from "../git-status-groups";
import { demoReadPaperResource } from "../step-flow";
import { useSkillProvides } from "../skill-slots.ts";
import { stepAttention } from "../run-overview";
import { stepperStatusText } from "../stepper-status";
import { unsavedUpstreamSteps } from "../kickoff-inputs";
import { beginAskAi } from "./AskAiModal";
import {
  projectAgentPrefs,
  projectNeedsDefaultAgent,
  slotPrefs,
  DISCUSS_BINDING_SLOT,
} from "../project-agents";
import {
  runIdForPath,
  workspaceHasLiveAgent,
  type RunOverviewInput,
} from "../run-overview";
import type {
  DiscoveredResourceDto,
  ZoteroLibraryDto,
  EnsureGitDto,
  PipelineTemplateDto,
  ProjectConfigDto,
  ProjectConfigReadDto,
  ProjectDto,
  ProjectResourceDto,
  ProjectStepDto,
  WorkspaceDto,
  WorkspaceDriftDto,
  WorkspaceHealthDto,
  GitFileDto,
} from "../types";

const actionBtn = inlineActionClass;
const ctaSm = compactPrimaryActionClass;
const fieldSm = compactFieldClass;
// 危险向行内钮：平时与普通行内钮同灰，悬停才转红（「不使用研究流程」一类带确认的低频退出动作）
const dangerBtn =
  "inline-flex h-7 items-center rounded-md px-2 text-xs text-l3 transition-colors hover:bg-hover hover:text-err-text disabled:opacity-50";

// 家目录（项目路径缩略 ~ 显示用）：模块级缓存，全部项目组共用一次查询

/** 绝对路径缩略：家目录前缀 → ~（完整路径仍在外层 title 悬浮里）。
 *  两侧都先剥 verbatim 前缀：存量库里的项目路径可能仍是 `\\?\C:\Users\...`，
 *  而 home 是普通形式，不剥就永远缩不掉、界面直接把 `\\?\` 显示给用户。
 *  Windows 文件系统大小写不敏感，前缀判定同样要折叠大小写。 */

/** 步进器带级整条虚线链：真实 6×6px 方块按 12px 等距（6px 块 + 6px 间隙）铺满整个带宽。
 *  块位以圆心为锚分段计算（圆是列中心，列等宽，段长相等）——每个圆两侧的断口、
 *  每个步骤之间的块数与间隙严格一致（按全局相位铺排时圆会随机截断方块，用户反馈不规则）。
 *  段内余数（<12px）均摊到方块之间；圆旁的首尾断口固定，不随窗口宽度漂移。
 *  完成列区间内的块亮灰白（l2）、其余暗（hairline），300ms 颜色过渡 */
const STEPPER_BLOCK_PX = 6;
const STEPPER_GAP_PX = 6;
const STEPPER_PITCH_PX = STEPPER_BLOCK_PX + STEPPER_GAP_PX;
// 这里不能用 Tailwind 的 gap-1.5：项目根字号是 14px，它实际等于 5.25px，
// 会让按 6px 计算的虚线链与每列圆心逐列产生累计偏差。
const NODE_HALF = 17; // 圆遮罩半宽：22px 视觉圆（半径 11）+ 6px 语义空档——与块间间隙精确相等
function StepperChain({
  dones,
  children,
}: {
  dones: boolean[];
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const nSteps = dones.length;
  const blocks: { left: number; done: boolean }[] = [];
  if (width > 0 && nSteps > 0) {
    // 与下方 grid 完全相同的列几何：列间隙 6px，列 i 圆心 = i*(列宽+6) + 列宽/2
    const colW = (width - STEPPER_GAP_PX * (nSteps - 1)) / nSteps;
    const center = (i: number) =>
      i * (colW + STEPPER_GAP_PX) + colW / 2;
    for (let seg = 0; seg <= nSteps; seg++) {
      const start = seg === 0 ? 0 : center(seg - 1) + NODE_HALF;
      const end = seg === nSteps ? width : center(seg) - NODE_HALF;
      const len = end - start;
      if (len < STEPPER_BLOCK_PX) continue;
      const m = Math.max(
        1,
        Math.floor((len + STEPPER_GAP_PX) / STEPPER_PITCH_PX),
      );
      // 两端方块分别贴住圆遮罩边界；剩余像素只均摊到段内间隙，
      // 避免窗口变宽时余数累积到圆旁，造成右侧断口越来越远。
      const extra = len - (STEPPER_PITCH_PX * m - STEPPER_GAP_PX);
      const pitch =
        m > 1 ? STEPPER_PITCH_PX + extra / (m - 1) : STEPPER_PITCH_PX;
      for (let b = 0; b < m; b++) {
        const left = start + b * pitch;
        const xCenter = left + STEPPER_BLOCK_PX / 2;
        const col = Math.min(
          nSteps - 1,
          Math.max(0, Math.floor(xCenter / (colW + STEPPER_GAP_PX))),
        );
        blocks.push({ left, done: dones[col] });
      }
    }
  }
  return (
    <div ref={ref} className="relative min-w-0 flex-1 self-stretch">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {blocks.map((b, i) => (
          <span
            key={i}
            className={`absolute top-1/2 block size-[6px] -translate-y-1/2 rounded-[1px] transition-colors duration-300 ${
              b.done ? "bg-l2" : "bg-hairline"
            }`}
            style={{ left: b.left }}
          />
        ))}
      </div>
      {children}
    </div>
  );
}

/** 步进器单元格：只剩大圆节点（虚线链由 StepperChain 在带级统一铺满）。
 *  圆的包裹 span 带 strip 底色 + 两侧 6px 内边距形成遮罩，链条在圆处整齐断开。
 *  大圆的悬浮信息走应用内 tooltip（useHoverTip，fixed 定位、滚动即关、点击即关，见 ./HoverTip）：
 *  原生 title 在 WKWebView 上行为不稳定（不渲染或移开后残留数秒串到相邻控件），
 *  状态/目录/agent/点击动作提示必须可见，且禁用按钮也能触发（事件挂在包裹 span 上）。 */
function StepperCell({
  circleClass,
  circleTitle,
  circleWarn,
  circleLabel,
  circleDisabled,
  pulsing,
  selected,
  onCircleClick,
}: {
  circleClass: string;
  circleTitle: string;
  /** 悬浮卡内的警告色小字行（上游漂移提醒等），null/缺省不显示 */
  circleWarn?: string | null;
  circleLabel: string;
  circleDisabled: boolean;
  pulsing: boolean;
  /** 聚焦选中（v3.70：点圆 = 下方只看这一步）：中性高亮环 */
  selected?: boolean;
  onCircleClick: () => void;
}) {
  const circleRef = useRef<HTMLButtonElement>(null);
  const { tip, show: showTip, hide: hideTip } = useHoverTip(circleRef);
  // 进行中/checking 的圆加 cta 外环锁定焦点
  const active = circleClass.split(" ").includes("bg-cta");
  return (
    <li className="flex min-w-0 items-center justify-center">
      <span
        className="ccode-well shrink-0 px-[3px]"
        onMouseEnter={showTip}
        onMouseLeave={hideTip}
        onFocus={showTip}
        onBlur={hideTip}
      >
        <button
          ref={circleRef}
          type="button"
          disabled={circleDisabled}
          aria-label={circleLabel}
          className="group/circle flex h-[28px] w-[28px] shrink-0 cursor-pointer items-center justify-center rounded-full disabled:cursor-not-allowed"
          onClick={() => {
            // 点击即关 tooltip：聚焦后不留残留悬浮
            hideTip();
            onCircleClick();
          }}
        >
          {/* 视觉圆 22px，按钮保持 28px 热区 */}
          <span
            className={`block h-[22px] w-[22px] rounded-full transition-[filter,color,background-color,border-color] duration-300 group-hover/circle:brightness-110 ${circleClass} ${
              active || pulsing ? "animate-pulse-brief" : ""
            } ${active ? "ring-2 ring-cta/50" : ""} ${selected ? "ring-2 ring-l1/70" : ""}`}
          />
        </button>
        <HoverTip tip={tip} text={circleTitle} warn={circleWarn} />
      </span>
    </li>
  );
}

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 工作区记住的上次启动配置（与终端页 `ccode.wsLast.<worktreePath>` 同一键） */
function wsLastConfig(
  worktreePath: string,
): Partial<{ agentId: string; profileId: string; model: string }> {
  try {
    return JSON.parse(
      localStorage.getItem(`ccode.wsLast.${worktreePath}`) ?? "{}",
    );
  } catch {
    return {};
  }
}

/** 步骤状态：从绑定工作区（steps[].workspaceName 匹配工作区名）的 health/drift 派生，纯展示无双状态机 */
type StepStatusKey =
  | "pending"
  | "active"
  | "review"
  | "blocked"
  | "done"
  | "checking";

/** 状态文字只进悬浮 tooltip（白话双层），圆上不再直接显示 */
const STEP_STATUS_LABEL: Record<StepStatusKey, string> = {
  pending: "待开始",
  active: "进行中",
  review: "待评审",
  blocked: "阻塞",
  done: "已完成",
  checking: "检查中",
};

/** 大圆步进器的圆填色：纯实心无字符，状态只靠颜色区分；进行中/检查中的脉冲用
 *  有界的 animate-pulse-brief（App.css，3 个周期后静止），不用无限 animate-pulse */
function stepCircleClass(key: StepStatusKey): string {
  // done = 中性亮灰空心圆环（2026-09-15 用户拍板不要绿色）：系统语言本就是
  // 「同一族形状，空心 → 实心表达进度」——实心留给当前/进行中，已完成是过去时
  // 掏空降噪；环与完成段链条块同用 l2 亮灰，done 区整体统一中性，绿色全面退场
  if (key === "done") return "border-[1.5px] border-l2 bg-transparent";
  // 阻塞用 warn 的「文字/圆点」档而非底色档：底色档在浅色主题是浅黄（#fdf1cd），
  // 铺成 22px 实心圆会在近白 canvas 上消失；且同为实心圆的 done 本就用 -text 档口径
  if (key === "blocked") return "bg-warn-text";
  // 评审圆是实心状态形状，使用强调色文字档；深色主题的 cta-pill 底会显成深红块。
  if (key === "review") return "bg-cta-pill-text";
  if (key === "active" || key === "checking") return "bg-cta";
  // 待开始：实心灰圆
  return "bg-l4";
}

function deriveStepStatus(
  step: ProjectStepDto,
  workspaces: WorkspaceDto[],
  health: Record<string, WorkspaceHealthDto>,
  drift: Record<string, WorkspaceDriftDto>,
  liveInputs: RunOverviewInput[] = [],
): { key: StepStatusKey; ws?: WorkspaceDto } {
  const ws = workspaces.find((w) => w.name === step.workspaceName);
  // 预置完成（示例课题检索步）：主仓已有产物、尚未建工作区 → 视为已完成。
  // 真建了工作区后以工作区状态为准。
  if (step.seedComplete && (!ws || ws.status === "archived")) {
    return { key: "done", ws };
  }
  // 归档工作区视为待开始：行内给出「恢复」入口
  if (!ws || ws.status === "archived") return { key: "pending", ws };
  const h = health[ws.id];
  const d = drift[ws.id];
  if (d?.canResolveMerge === true || h?.conflict === true) {
    return { key: "blocked", ws };
  }
  // Agent 还在跑：即使已经有待合并提交，也还是进行中，不能提前「去评审」
  if (workspaceHasLiveAgent(ws.worktreePath, liveInputs, IS_WINDOWS)) {
    return { key: "active", ws };
  }
  // 衔接工作区「已合并」规则：merged_at 置位且没有新的待合并提交
  if (ws.status === "active" && ws.mergedAt && h?.ahead === 0) {
    return { key: "done", ws };
  }
  if (!h) return { key: "checking", ws };
  // 有待合并提交就是待评审；未提交改动（纳入/排除等）不得把「去评审」打回进行中
  if (h.ahead > 0) return { key: "review", ws };
  if (h.uncommitted) return { key: "active", ws };
  return { key: "active", ws };
}

/**
 * 工作区页的项目分组（§11.4 P1b）：分组头 + 研究流程 strip + 资源面板。
 * 工作区行列表由 WorkspacesPage 作为 children（render prop）传入：本组件把聚焦步骤名
 * 与步骤表回传给父级，工作区列表按聚焦步骤过滤（归属口径 = steps[].workspaceName === 工作区名）。
 */
export default function ProjectGroup({
  project,
  repoPath,
  repoName,
  workspaces,
  health,
  drift,
  refreshToken,
  freshGitGuide,
  onDismissGitGuide,
  onRefresh,
  onOpenTerminal,
  onError,
  children,
  focusStepReq,
  pageVisible,
  chromeReq,
  onIdentityAction,
  onOpenAgents,
  onChromeConsumed,
}: {
  /** null = 未注册分组（仅按工作区 repo 归组） */
  project: ProjectDto | null;
  repoPath: string;
  repoName: string;
  workspaces: WorkspaceDto[];
  health: Record<string, WorkspaceHealthDto>;
  drift: Record<string, WorkspaceDriftDto>;
  /** 页面每次刷新自增，触发档案卡重读（用户可能在页外改了 project.toml） */
  refreshToken: number;
  /** 刚通过「添加项目」注册：显示一次性 git 初始化引导 */
  freshGitGuide: boolean;
  onDismissGitGuide: () => void;
  onRefresh: () => Promise<void>;
  /** initialPrompt：一键开步时预填的首条指令；步进器大圆「跳终端」也经此回调（不传 prompt） */
  onOpenTerminal: (
    ws: WorkspaceDto,
    initialPrompt?: string,
    opts?: { autoStart?: boolean; launch?: KickoffLaunch },
  ) => void;
  onError: (msg: string) => void;
  /** 工作区列表渲染（render prop）：回传聚焦视图上下文，父级按步骤过滤列表 */
  children: (wsView: {
    /** 聚焦步骤名（null = 项目无研究步骤：显示项目全量工作区） */
    focusStepName: string | null;
    /** 项目步骤表（归属判定用；未注册/未加载 = 空表） */
    steps: ProjectStepDto[];
  }) => ReactNode;
  /** 外部一次性聚焦请求（收件箱「去核验」：目标工作区被聚焦过滤藏掉时，先切到它的步骤）；
   *  传工作区名，步骤名按 steps[].workspaceName 在本组件内解析（父级没有 cfg）；
   *  token 变化才消费，同目标重复点不重复切 */
  focusStepReq?: { wsName: string; token: number } | null;
  /** 页面可见性（v3.97）：项目页常驻挂载，手动聚焦会跨页留存——从终端页等回来时，
   *  若聚焦的步骤已完成（ merged ），放掉手动聚焦、回落到当前步骤（第一个未完成），
   *  否则用户看到的永远是上次点过的那一步（实测：已完成的「文献检索」一直占着聚焦） */
  pageVisible?: boolean;
  chromeReq?: { action: string; token: number } | null;
  onIdentityAction?: (action: "rename" | "topic") => void;
  /** 刚添加的项目还没设默认 Agent 时，欢迎条上的「设默认」切到 Agents 页 */
  onOpenAgents?: () => void;
  /** 顶栏 ⋯ 的打开请求消费后清掉，避免切页/切页签后组件重挂又把编辑器打开。 */
  onChromeConsumed?: () => void;
}) {
  const registered = project !== null;
  const projectPath = project?.path ?? repoPath;
  const displayName = project?.name ?? repoName;

  // ===== 档案卡（仅注册项目） =====
  const skillProvides = useSkillProvides();
  const [cfg, setCfg] = useState<ProjectConfigDto | null>(null);
  const [cfgWarnings, setCfgWarnings] = useState<string[]>([]);
  const [cfgLoadError, setCfgLoadError] = useState<string | null>(null);

  /** 从磁盘重读档案卡并同步本地状态：档案卡的唯一读入口。
   *  原先四处各写一遍「read → setCfg + setCfgWarnings」，漏掉 warnings 的那处会让
   *  ⚠ 徽标停在上一次的结果；收成一个函数后本地与磁盘只有这一条同步路径。
   *  后端保证不 reject（坏配置回落空配置 + warnings），失败时保留现有本地配置。 */
  async function reloadCfg(path: string): Promise<ProjectConfigDto | null> {
    try {
      const read = await invoke<ProjectConfigReadDto>("read_project_config", {
        path,
      });
      setCfg(read.config);
      setCfgWarnings(read.warnings);
      setCfgLoadError(null);
      return read.config;
    } catch {
      setCfgLoadError("项目配置读取失败");
      return null;
    }
  }

  useEffect(() => {
    if (!project) {
      setCfg(null);
      setCfgLoadError(null);
      return;
    }
    let stale = false;
    invoke<ProjectConfigReadDto>("read_project_config", { path: project.path })
      .then((read) => {
        if (stale) return;
        setCfg(read.config);
        setCfgWarnings(read.warnings);
        setCfgLoadError(null);
      })
      .catch((reason) => {
        if (!stale) setCfgLoadError(`项目配置读取失败：${String(reason)}`);
      });
    return () => {
      stale = true;
    };
  }, [project, refreshToken]);


  const reloadMainDirty = useCallback(() => {
    if (!project) {
      setMainDirty(null);
      return;
    }
    invoke<{ isRepo: boolean; files: GitFileDto[] }>("git_status", {
      cwd: project.path,
    })
      .then((status) => {
        setMainDirty(status.isRepo ? userWorkDirtyFiles(status.files).length : null);
      })
      .catch(() => {});
  }, [project]);

  // 主仓脏检查：进项目详情读一次 + 页面刷新时重读，不轮询（开工弹层打开时会再刷新一次）
  useEffect(() => {
    if (!project) {
      setMainDirty(null);
      return;
    }
    let stale = false;
    invoke<{ isRepo: boolean; files: GitFileDto[] }>("git_status", {
      cwd: project.path,
    })
      .then((status) => {
        if (!stale) setMainDirty(status.isRepo ? userWorkDirtyFiles(status.files).length : null);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [project, refreshToken]);

  /** 全量写回 resources/steps（后端保留未知键）；失败只报错不回滚本地状态 */  async function saveConfig(next: ProjectConfigDto): Promise<boolean> {
    if (!project) return false;
    try {
      await invoke("write_project_config", { path: project.path, config: next });
      setCfg(next);
      return true;
    } catch (reason) {
      onError(String(reason));
      return false;
    }
  }

  // 保存历史（白话时间线）：全宽覆盖层，同 PipelineEditor 形态
  const [historyOpen, setHistoryOpen] = useState(false);
  // 工作区名 → 步骤名：merge commit 的「保存进项目」优先显示步骤名
  const wsStepMap = Object.fromEntries(
    (cfg?.steps ?? []).map((s) => [s.workspaceName, s.name]),
  );

  function copyText(text: string, failMsg: string) {
    void navigator.clipboard.writeText(text).catch(() => onError(failMsg));
  }

  // ===== git 初始化引导（新注册项目一次性横幅） =====
  const [gitMsg, setGitMsg] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  async function ensureGit() {
    setGitBusy(true);
    try {
      const res = await invoke<EnsureGitDto>("ensure_git_repo", {
        path: projectPath,
      });
      setGitMsg(
        res.initialized
          ? `已初始化 git 仓库${res.gitignoreWritten ? "，并生成 .gitignore" : ""}`
          : "已是 git 仓库，无需初始化",
      );
    } catch (reason) {
      onError(String(reason));
    } finally {
      setGitBusy(false);
    }
  }

  // ===== 研究流程 strip =====
  const [starting, setStarting] = useState<number | null>(null);
  // 开工确认弹层（v3.64）：步进器大圆与卡片「开工」的唯一开工入口
  const [kickoff, setKickoff] = useState<{
    index: number;
    originCardId: string | null;
  } | null>(null);
  // 主仓未提交改动数（null = 非 git 仓库/读取失败）：卡片区提醒行用，进项目详情读一次不轮询
  const [mainDirty, setMainDirty] = useState<number | null>(null);
  const [stepMenu, setStepMenu] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);
  // 研究流程编辑器（RX1）：步骤编辑唯一入口，覆盖旧 ⋯ 内联重命名/编辑简报/+ 步骤表单
  const [editorOpen, setEditorOpen] = useState(false);
  // 步骤 ⋯「编辑步骤」：打开编辑器并定位到该步骤卡片（null = 从项目菜单进入，不定位）
  const [editorFocus, setEditorFocus] = useState<number | null>(null);
  // 步骤 ⋯「产物核验」手风琴：strip 下方就地展开 ArtifactChecklist，记展开的步骤 index（单开）
  const [artifactsStep, setArtifactsStep] = useState<number | null>(null);
  // 步骤聚焦（v3.70）：null = 跟随当前步骤（第一个未完成，全部完成则落最后一步）；其余 = 指定步骤。
  // 大圆点击与卡片区头部 ‹ › 箭头设置；卡片区恒为单步骤聚焦视图（v3.81 起无总览态）
  /** 聚焦步骤名（存名字而非索引）：索引在流水线编辑器里重排/改名后会指向另一个步骤，
   *  而下游全部按名字找回。名字对不上时 focusIndex 回落到当前步骤，不静默跳错 */
  const [focusStepKey, setFocusStepKey] = useState<string | null>(null);
  // 外部一次性聚焦请求（收件箱「去核验」）：目标工作区被聚焦过滤藏掉时，父级请先切到它的步骤。
  // 传的是工作区名，步骤名在这里按 steps[].workspaceName 解析；解析不到（未绑定步骤的手动工作区
  // 恒可见，不需要切）就不动
  useEffect(() => {
    if (!focusStepReq || !cfg) return;
    const step = cfg.steps.find((s) => s.workspaceName === focusStepReq.wsName);
    if (step) setFocusStepKey(step.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusStepReq, cfg]);
  // 人工事项派生状态原本只喂步骤 ⋯ 菜单的「N 件待做」计数，该菜单项已随 v3.86 精简删除
  // （清单本体在 useHumanTasks 里自取自刷），这里连同 list_human_task_states 一次调用一并去掉
  // 聚焦步骤的任务书草稿（v3.72）：聚焦头部「待开始」情境文案（describeStep）与卡片区流程线
  // 共用这一份加载（TaskCardsSection 经 focusDraft prop 接收，不重复请求）；effect 在 focusStepName 之后
  const [focusDraft, setFocusDraft] = useState<{
    stepName: string;
    relPath: string;
    text: string | null;
  } | null>(null);
  const [focusDraftError, setFocusDraftError] = useState<string | null>(null);
  const [pipelineSaving, setPipelineSaving] = useState(false);
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  const [optingOut, setOptingOut] = useState(false);
  // 「使用研究流程模板」旁的可选课题主题输入，随模板一并落进 project.toml；
  // 与选模板层顶部的课题主题是同一字段：回显既有值（templateTopic 为空才回填，不盖用户输入）
  const [templateTopic, setTemplateTopic] = useState("");
  // 应用模板成功的一次性引导条（组件态，切项目自然消失；不持久化——应用模板不是高频动作）
  const [tplApplied, setTplApplied] = useState(false);
  useEffect(() => {
    if (cfg?.topic?.trim()) {
      setTemplateTopic((cur) => (cur.trim() ? cur : cfg.topic!.trim()));
    }
  }, [cfg]);
  // 模板选择器：首启引导与「更换模板」共用，列出内置 + 用户模板
  const [pickerOpen, setPickerOpen] = useState(false);
  // 另存为模板：内联表单（WKWebView 无 window.prompt），同名覆盖先 confirm
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [tplNameDraft, setTplNameDraft] = useState("");
  const [tplDescDraft, setTplDescDraft] = useState("");
  const [tplSaving, setTplSaving] = useState(false);
  const [tplSavedMsg, setTplSavedMsg] = useState<string | null>(null);

  /** 一键开步（§11.3 机制三）：invoke 链路在 pipeline-start.ts 与评审「开始下一步」共用，此处只管组件态。
   *  v3.64 起「开工」为两步：先开 KickoffConfirmDialog（TASK.md 预览编辑，任务书草稿优先），
   *  确认后本函数才执行建工作区链路；taskMdOverride = 弹层编辑区的最终内容 */
  async function runStartStep(
    index: number,
    taskMdOverride?: string,
    launch?: KickoffLaunch | null,
    decisionPauseAcknowledged = false,
    intakeBridge?: IntakeBridgeDecision,
  ) {
    if (!project || !cfg) return;
    const step = cfg.steps[index];
    setStarting(index);
    try {
      await startPipelineStep({
        projectPath: project.path,
        step,
        cfg,
        taskMdOverride,
        decisionPauseAcknowledged,
        launch,
        intakeBridge,
        onError,
        // 刷新先于跳终端：run 脚本写入在工作区行刷新之前，「运行脚本」菜单当次即可见
        onOpenTerminal: async (ws, initialPrompt, opts) => {
          await onRefresh();
          onOpenTerminal(ws, initialPrompt, opts);
        },
      });
    } catch (reason) {
      onError(String(reason));
    } finally {
      setStarting(null);
    }
  }

  /** 「开工」第一步：打开确认弹层（originCardId = 卡片开工的出处卡；步进器大圆为 null） */
  function startStep(index: number, originCardId: string | null = null) {
    if (!project || !cfg) return;
    setKickoff({ index, originCardId });
  }

  async function restoreWs(ws: WorkspaceDto) {
    try {
      await invoke("restore_workspace", { id: ws.id });
      await onRefresh();
    } catch (reason) {
      onError(String(reason));
    }
  }

  function openEditor(focus: number | null = null) {
    setEditorFocus(focus);
    setEditorOpen(true);
  }

  /** 按索引聚焦（大圆 / 步骤 ⋯ 菜单 / 卡片区 ‹ › 箭头共用）：落库存的是步骤名 */
  function focusByIndex(index: number) {
    const name = cfg?.steps[index]?.name;
    if (name) setFocusStepKey(name);
  }

  /** 大圆点击 = 步骤聚焦（v3.70，用户拍板：圆的终端入口语义删除——跳终端/开步/恢复分别由
   *  流程线节点、卡片行、任务行承担）：点圆 = 下方卡片区只看这一步（种子/卡片/人工事项）；
   *  与卡片区头部 ‹ › 箭头同一切换口径 */
  function onCircleClick(index: number) {
    focusByIndex(index);
  }

  async function applyTemplate(item: TemplatePickItem) {
    if (!cfg) return;
    // 空流程（含「不使用研究流程」后从 ⋯ 菜单回流）：走追加——后端顺带清 pipeline_opt_out
    if (cfg.steps.length === 0) {
      setApplyingTemplate(true);
      try {
        await invoke("apply_pipeline_template", {
          projectRoot: projectPath,
          steps: item.steps.map((s) => withResearchTools(s, researchToolsFromSettings(cfg.settings), cfg.artifactDir, cfg.litSource, skillProvides)),
          projectSettings: settingsForTemplateApply(item),
          strategy: "append",
          topic: templateTopic.trim() || null,
          submissionMode:
            item.id === "submission-rebuttal" ? item.mode ?? "initial" : null,
          submissionRound:
            item.id === "submission-rebuttal" && item.mode === "revision"
              ? item.round ?? 1
              : null,
        });
        // 与编辑器及注册后选择层同一事务口径：重读配置刷新本地状态
        await reloadCfg(projectPath);
        setPickerOpen(false);
        // 模板选完就该看到步进器，别把抽屉留在前面挡着
        setSettingsOpen(false);
        // 顺序引导（一次性提示条，可关）：把视线引到第 1 步与种子
        setTplApplied(true);
      } catch (reason) {
        onError(String(reason));
      } finally {
        setApplyingTemplate(false);
      }
      return;
    }
    // 已有步骤时视为「更换模板」：提示覆盖，绑定的工作区与资源不受影响；
    // 步骤专属绑定按步骤名匹配，步骤被换可能失效或转移到同名新步骤（B1）
    if (
      !(await confirmDialog(
        `更换模板「${item.name}」？现有 ${cfg.steps.length} 个步骤会被替换，绑定的工作区与资源不受影响；步骤专属绑定按步骤名匹配，可能失效或转移。继续？`,
        { danger: true },
      ))
    )
      return;
    setApplyingTemplate(true);
    // 后端一次性处理步骤替换、全局设定、投稿元数据、topic 与 opt-out；
    // resources/artifactDir 保持现状。
    let ok = true;
    try {
      await invoke("apply_pipeline_template", {
        projectRoot: projectPath,
        steps: item.steps.map((s) => withResearchTools(s, researchToolsFromSettings(cfg.settings), cfg.artifactDir, cfg.litSource, skillProvides)),
        projectSettings: settingsForTemplateApply(item),
        strategy: "replace",
        topic: templateTopic.trim() || null,
        submissionMode:
          item.id === "submission-rebuttal" ? item.mode ?? "initial" : null,
        submissionRound:
          item.id === "submission-rebuttal" && item.mode === "revision"
            ? item.round ?? 1
            : null,
      });
    } catch (reason) {
      ok = false;
      onError(String(reason));
    }
    if (ok) await reloadCfg(projectPath);
    setApplyingTemplate(false);
    if (ok) {
      setPickerOpen(false);
      setSettingsOpen(false);
      // 顺序引导（一次性提示条，可关）：把视线引到第 1 步与种子
      setTplApplied(true);
    }
  }

  /** 「不使用研究流程」：空步骤只写标记；已有步骤先确认再清空步骤表（笔记/工作区保留）。 */
  async function optOutPipeline() {
    if (!project || optingOut || applyingTemplate) return;
    const stepCount = cfg?.steps.length ?? 0;
    if (
      stepCount > 0 &&
      !(await confirmDialog(
        `去掉研究流程？${stepCount} 个步骤会从档案卡拿掉，已有笔记、文献和工作区都保留。`,
        { danger: true, confirmText: "不使用研究流程" },
      ))
    )
      return;
    setOptingOut(true);
    try {
      await invoke("set_pipeline_opt_out", {
        projectRoot: project.path,
        optOut: true,
      });
      await reloadCfg(project.path);
      setPickerOpen(false);
      setSettingsOpen(false);
    } catch (reason) {
      onError(String(reason));
    } finally {
      setOptingOut(false);
    }
  }

  /** 另存为模板：当前 steps 存入用户模板库（后端同名覆盖，先查重 confirm） */
  async function submitSaveTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!cfg || cfg.steps.length === 0) return;
    const name = tplNameDraft.trim();
    if (!name) return;
    setTplSaving(true);
    try {
      // 后端未就绪时列表回落为空，保存本身会报错提示，不阻断内置流程
      const existing = await invoke<PipelineTemplateDto[]>(
        "list_pipeline_templates",
      ).catch(() => [] as PipelineTemplateDto[]);
      if (
        existing.some((t) => t.name === name) &&
        !(await confirmDialog(`已存在同名模板「${name}」，保存将覆盖。继续？`, {
          danger: true,
        }))
      )
        return;
      const saved = await invoke<PipelineTemplateDto>(
        "save_pipeline_template",
        { name, description: tplDescDraft.trim(), steps: cfg.steps },
      );
      setSavingTemplate(false);
      setTplNameDraft("");
      setTplDescDraft("");
      setTplSavedMsg(`已保存模板「${saved.name}」，可在模板库中选择使用。`);
    } catch (reason) {
      onError(String(reason));
    } finally {
      setTplSaving(false);
    }
  }

  /** 编辑器保存：整体写回 steps 后重读配置，刷新资源绑定等校验警告并关闭编辑器 */
  async function savePipeline(steps: ProjectStepDto[], settings?: string[]) {
    if (!project || !cfg) return;
    setPipelineSaving(true);
    const ok = await saveConfig({ ...cfg, steps, ...(settings ? { settings } : {}) });
    if (ok) {
      try {
        await reloadCfg(project.path);
      } catch {
        /* 重读失败保留刚写入的本地配置 */
      }
      setEditorOpen(false);
    }
    setPipelineSaving(false);
  }

  /**
   * 步骤 ⋯ 菜单（v3.86 精简 6 → 1~3）。删掉的三项与理由：
   * - **人工事项**：`onSelect` 就是 `focusByIndex`，与「点大圆 = 只看这一步」完全同效；
   *   清单本身在聚焦后的当前步骤卡流程线里直接可见。标签上的「N 件待做」是 v3.84
   *   已删的「等你做」计数的最后残留，同一噪音不再从菜单里冒出来。
   * - **复制工作区名**：近乎零频次；工作区名在「编辑步骤 → 高级」里可见，
   *   任务行 ⋯ 另有更有用的「复制工作树路径」。
   * - **删除步骤**：结构性编辑，按约定归编辑器（每张步骤卡自带删除），
   *   且不该把破坏性动作放在悬停即出的菜单里紧挨着步进器大圆。
   * 余下两项**不再渲染禁用态**：没有工作区时「产物核验 / 定位目录」本就无事可做，
   * 灰着占位只是噪音（原菜单 6 项里有 2 项常年是灰的）。
   */
  function stepMenuItems(index: number) {
    if (!cfg) return [];
    // 「◫ 定位目录」与胶囊原 ◫ 按钮同一语义：仅活跃工作区可定位
    const st = statusAt(index)!;
    const activeWs =
      st.ws && st.ws.status === "active" ? st.ws : undefined;
    return [
      {
        icon: Workflow,
        label: "编辑步骤",
        title: "打开研究流程编辑器并定位到该步骤",
        onSelect: () => openEditor(index),
      },
      ...(st.ws
        ? [
            {
              icon: Files,
              label: artifactsStep === index ? "收起本步文件" : "本步文件",
              title: "打开这一步已经写出的文件",
              onSelect: () =>
                setArtifactsStep((v) => (v === index ? null : index)),
            },
          ]
        : []),
      ...(activeWs
        ? [
            {
              icon: SquareTerminal,
              label: "在终端打开工作区",
              title: "在运行页开一个终端，目录就是这一步的工作区；左边文件树跟着显示它的文件",
              onSelect: () => {
                useAppStore.getState().setPendingTerminal({
                  cwd: activeWs.worktreePath,
                  extraEnv: {},
                  title: activeWs.name,
                  shellOnly: true,
                });
                setPage("terminal");
              },
            },
          ]
        : []),
    ];
  }

  // ===== 资源面板 =====
  // 资源面板展开态：新注册的项目默认展开——注册时自动扫过一遍，
  // 不展开的话用户既不知道扫到了什么，也看不到还能从哪儿补
  const [resOpen, setResOpen] = useState(freshGitGuide);
  // 「项目设置」抽屉（v3.85）：项目级低频配置的单一落点。原先资源面板与定时任务
  // 各占详情页一条常驻带，配置项还散在 ⋯ 菜单八项里；收进抽屉后详情页少两条带、
  // ⋯ 菜单收到四项，项目级配置也终于有了一个能一眼看全的地方。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const chromeConsumed = useRef<number | null>(null);
  useEffect(() => {
    if (!chromeReq || !cfg) return;
    if (chromeConsumed.current === chromeReq.token) return;
    if (chromeReq.action === "rename" || chromeReq.action === "topic") return;
    chromeConsumed.current = chromeReq.token;
    if (chromeReq.action === "settings") setSettingsOpen(true);
    if (chromeReq.action === "editor") openEditor();
    if (chromeReq.action === "history") setHistoryOpen(true);
    onChromeConsumed?.();
  }, [chromeReq, cfg, onChromeConsumed]);

  // 「文献与数据」落点聚焦：从流程线按所选来源跳过来时高亮对应进料入口，2.5s 后自动消退。
  // 落点统一是这一处面板（导入只此一处），高亮解决「到了之后点哪个」
  const [resFocus, setResFocus] = useState<"zotero" | "files" | null>(null);
  /** 「文献与数据」面板锚点：流程线里的「到「文献与数据」导入」展开后滚到这里 */
  const resPanelRef = useRef<HTMLElement>(null);
  /** 「◔ 定时任务」面板锚点：文献雷达卡片「◔ 定时」开抽屉后滚到这里 */

  const stepperScrollerRef = useRef<HTMLDivElement>(null);
  const [stepperOverflows, setStepperOverflows] = useState(false);
  useEffect(() => {
    const el = stepperScrollerRef.current;
    if (!el) {
      setStepperOverflows(false);
      return;
    }
    const update = () => {
      setStepperOverflows(el.scrollWidth - el.clientWidth > 1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, [cfg?.steps.length, registered]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  // Zotero 进料口（只读适配器；不做文献库，见 zotero.rs 头注）：探测 → 选分类 → 导入
  const [zoteroBusy, setZoteroBusy] = useState(false);
  const [zoteroLib, setZoteroLib] = useState<ZoteroLibraryDto | null>(null);
  /** 手动指定过的 Zotero 数据目录（自定义目录的用户不必每次重选） */
  const [zoteroDir, setZoteroDir] = useState<string | null>(null);
  const [zoteroMsg, setZoteroMsg] = useState<string | null>(null);
  const [litBusy, setLitBusy] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);

  /** 切换文献来源：改 project.toml 的 lit_source + 就地同步各步骤已编辑的 TASK.md 内容文件。
   *  取值与后端 LIT_SOURCES 一致：search / zotero / endnote / folder。选什么就是什么。
   *  v3.90 起内容文件是快照（编辑/播种后不再随模板拼装变化），但「文献来源」段是改变检索
   *  步骤性质的硬前提，必须就地 upsert 进已有正文的文件；无正文/不存在的文件不管
   *  （它们展示与落盘走模板拼装，本来就是最新） */
  async function setLitSource(next: string) {
    if (!cfg || litBusy) return;
    const target = ["search", "zotero", "endnote", "folder"].includes(next)
      ? next
      : "search";
    if (target === (cfg.litSource?.trim() || "search")) return;
    setLitBusy(true);
    try {
      const steps = cfg.steps.map((s) =>
        withResearchTools(s, researchToolsFromSettings(cfg.settings), cfg.artifactDir, target, skillProvides),
      );
      const ok = await saveConfig({ ...cfg, litSource: target, steps });
      if (ok) await syncLitSourceToTaskMds(target);
    } catch (reason) {
      onError(String(reason));
    } finally {
      setLitBusy(false);
    }
  }

  async function setResearchTool(key: keyof ResearchTools, value: string) {
    if (!cfg || toolBusy) return;
    const current = researchToolsFromSettings(cfg.settings);
    if (current[key] === value) return;
    const tools = { ...current, [key]: value } as ResearchTools;
    setToolBusy(true);
    try {
      const steps = cfg.steps.map((s) =>
        withResearchTools(s, tools, cfg.artifactDir, cfg.litSource, skillProvides),
      );
      await saveConfig({
        ...cfg,
        settings: settingsWithResearchTools(cfg.settings ?? [], tools),
        steps,
      });
    } catch (reason) {
      onError(String(reason));
    } finally {
      setToolBusy(false);
    }
  }

  /** 把「文献来源」段就地同步进各步骤已有正文的 TASK.md 内容文件（快照的例外，见 setLitSource）。
   *  单步失败不阻断（best-effort）；完成后重读聚焦步骤内容，让「预览/编辑 TASK.md」即刻反映 */
  async function syncLitSourceToTaskMds(target: string) {
    if (!project || !cfg) return;
    for (const s of cfg.steps) {
      try {
        const cur = await invoke<{ relPath: string; text: string | null; revision: string | null }>(
          "read_task_draft",
          { projectRoot: project.path, stepName: s.name },
        );
        const raw = cur?.text?.trim() ?? "";
        if (!raw || isTaskMdStub(raw)) continue;
        const nextText = upsertPendingSettingsSection(
          upsertLitSourceSection(cur?.text ?? "", target),
          cfg.settings ?? [],
        );
        if (nextText !== cur?.text) {
          await invoke("write_task_draft", {
            projectRoot: project.path,
            stepName: s.name,
            content: nextText,
            expectedRevision: cur?.revision ?? null,
          });
        }
      } catch {
        /* 单步读写失败跳过，不阻断其余步骤 */
      }
    }
    loadFocusDraft();
  }

  /** 打开 Zotero 分类选择：探测失败（没装/自定义数据目录）时把后端原因显示出来，
   *  并给一个手动选目录的入口——报错文案说了「可手动指定」，就得真有这个入口 */
  async function openZotero(dataDir?: string) {
    setZoteroBusy(true);
    setZoteroMsg(null);
    try {
      const lib = await invoke<ZoteroLibraryDto>("zotero_inspect", {
        dataDir: dataDir ?? zoteroDir ?? null,
      });
      if (dataDir) setZoteroDir(dataDir);
      setZoteroLib(lib);
    } catch (reason) {
      const message = String(reason);
      setZoteroMsg(message);
      if (!dataDir && message.includes("没找到")) void pickZoteroDir();
    } finally {
      setZoteroBusy(false);
    }
  }

  /** 手动指定 Zotero 数据目录（Zotero 里可改数据目录，默认 ~/Zotero 找不到时走这条） */
  async function pickZoteroDir() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选 Zotero 数据目录：里面要有 zotero.sqlite。不要选 storage 里的那些短码文件夹",
    });
    if (typeof picked === "string") await openZotero(picked);
  }

  /** 导入选定分类：生成 references.bib + 登记 PDF 为资源；顺带把 lit_source 置为 zotero，
   *  TASK.md 据此把检索步骤降级为「盘点 + 查漏补缺」（renderTaskMd 的「文献来源」段） */
  const [zoteroAttachmentBase, setZoteroAttachmentBase] = useState<string | null>(null);
  async function importZotero(collectionId: number | null) {
    if (!project) return;
    setZoteroBusy(true);
    setZoteroMsg(null);
    try {
      const out = await invoke<{
        bibRel: string;
        itemCount: number;
        pdfCount: number;
        missingPdf: number;
        config: ProjectConfigDto;
      }>("zotero_import", {
        projectRoot: project.path,
        dataDir: zoteroDir ?? null,
        collectionId,
        linkedAttachmentBase: zoteroAttachmentBase,
      });
      // 后端已把资源与来源一起保存；不得用导入前的 cfg 全量回写。
      // 来源既已是 zotero，检索/精读步要补上同步技能（与流程线选择同一合同）。
      const steps = out.config.steps.map((s) =>
        withResearchTools(s, researchToolsFromSettings(out.config.settings), out.config.artifactDir, "zotero", skillProvides),
      );
      await saveConfig({ ...out.config, litSource: "zotero", steps });
      await syncLitSourceToTaskMds("zotero");
      setZoteroLib(null);
      setZoteroMsg(
        `已导入 ${out.itemCount} 条 → ${out.bibRel}` +
          (out.pdfCount > 0 ? `，${out.pdfCount} 篇 PDF 已登记为项目资源` : "") +
          (out.missingPdf > 0 ? `；${out.missingPdf} 条没有正文 PDF（只有补充材料或文件没下完的也算在内，agent 会列进待获取）` : ""),
      );
      await onRefresh();
    } catch (reason) {
      setZoteroMsg(String(reason));
    } finally {
      setZoteroBusy(false);
    }
  }
  const [discoverState, setDiscoverState] = useState<{
    items: DiscoveredResourceDto[];
    selected: Set<string>;
  } | null>(null);
  const [resourceMenu, setResourceMenu] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);
  const [gitignoreHint, setGitignoreHint] = useState(false);
  // 检索结果导入（papers/imports/ 人肉中转入口）的行内提示：换掉或手动关掉即消
  const [importMsg, setImportMsg] = useState<string | null>(null);

  /** 导入检索结果：多选 RIS/BibTeX/CSV/TXT 复制进项目根的 papers/imports/
   *  （import_human_deliverable 无步骤语境 = 纯导入落主仓，不登记提货单） */
  async function importSearchResults() {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "选择导出的检索结果文件",
      filters: [
        {
          name: "检索结果（RIS / BibTeX / CSV / TXT）",
          extensions: ["ris", "bib", "csv", "txt"],
        },
      ],
    });
    const paths = Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
    if (paths.length === 0) return;
    let ok = 0;
    for (const p of paths) {
      try {
        await invoke("import_human_deliverable", {
          projectRoot: projectPath,
          step: null,
          title: null,
          sourcePath: p,
          targetOverride: "papers/imports/",
        });
        ok++;
      } catch (reason) {
        onError(String(reason));
      }
    }
    if (ok > 0) {
      setImportMsg(
        `已放入 papers/imports/（${ok} 个文件），agent 开工时会自动解析、去重并合并进筛选清单`,
      );
    }
  }

  async function discoverResources() {
    if (!project) return;
    setDiscoverLoading(true);
    try {
      const items = await invoke<DiscoveredResourceDto[]>(
        "discover_resources",
        { path: project.path },
      );
      // 默认全选未登记项，用户按需取消勾选
      setDiscoverState({
        items,
        selected: new Set(
          items.filter((d) => !d.exists).map((d) => d.path),
        ),
      });
    } catch (reason) {
      onError(String(reason));
    } finally {
      setDiscoverLoading(false);
    }
  }

  async function addSelectedResources() {
    if (!project || !cfg || !discoverState) return;
    const additions = discoverState.items
      .filter((d) => discoverState.selected.has(d.path) && !d.exists)
      .map((d) => ({
        name: baseName(d.path),
        path: d.path,
        type: d.type,
        readonly: false,
        note: "",
      }));
    if (additions.length === 0) {
      setDiscoverState(null);
      return;
    }
    if (
      await saveConfig({
        ...cfg,
        resources: [...cfg.resources, ...additions],
      })
    ) {
      setDiscoverState(null);
      // 一次性提示：repo 内数据资源建议加入 .gitignore，避免大文件进 git 历史
      const key = `ccode.resGitignoreHint.${project.path}`;
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, "1");
        setGitignoreHint(true);
      }
    }
  }

  async function removeResource(index: number) {
    if (!cfg) return;
    await saveConfig({
      ...cfg,
      resources: cfg.resources.filter((_, i) => i !== index),
    });
  }

  // PDF 资源「查看」：拼绝对路径交给终端页预览（后端按登记资源白名单放行，可选段问 AI）
  const setPage = useAppStore((s) => s.setPage);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const profiles = useAppStore((s) => s.profiles);
  // 步进器大圆的注意力点：终端运行状态镜像（TerminalPage 唯一写入方，只读消费）
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  const setReaderReq = useAppStore((s) => s.setReaderReq);
  const taskCards = useAppStore((s) => s.taskCards[projectPath]);
  const loadTaskCards = useAppStore((s) => s.loadTaskCards);

  function immerseResource(r: ProjectResourceDto) {
    setReaderReq({
      pdfPath: absoluteResourcePath(projectPath, r.path),
      projectRoot: projectPath,
    });
    setPage("terminal");
  }

  function askAiResource(
    r: ProjectResourceDto,
    e?: { metaKey: boolean; ctrlKey: boolean },
  ) {
    const abs = absoluteResourcePath(projectPath, r.path);
    beginAskAi(
      {
        path: abs,
        name: r.name,
        cwd: projectPath,
        root: projectPath,
        reuseKey: `lit:${projectPath}:${r.path.replace(/\\/g, "/")}`,
        ...slotPrefs(profiles, project, DISCUSS_BINDING_SLOT),
      },
      { forcePick: !!(e?.metaKey || e?.ctrlKey) },
    );
  }

  const liteResearch = !!(
    registered &&
    cfg?.pipelineOptOut &&
    (cfg.steps?.length ?? 0) === 0
  );
  useEffect(() => {
    if (liteResearch) void loadTaskCards(projectPath);
  }, [liteResearch, projectPath, loadTaskCards]);

  function resourceMenuItems(index: number) {
    if (!cfg) return [];
    const r = cfg.resources[index];
    return [
      {
        icon: Copy,
        label: "复制路径",
        onSelect: () =>
          copyText(
            absoluteResourcePath(projectPath, r.path),
            "复制资源路径失败",
          ),
      },
      { separator: true },
      {
        icon: Unlink,
        label: "移除资源",
        title: "只从资源清单摘掉，不删磁盘文件",
        onSelect: () => void removeResource(index),
      },
    ];
  }

  // ===== 渲染 =====
  // 步骤状态表：每步算一次，下面各处派生共用同一份快照。
  // 原先 7 处各调一次 deriveStepStatus，每次都遍历 workspaces——N 步项目每渲染要跑 2N+ 次
  // find（describeStep 与 currentStep 还会互相嵌套调用）。纯派生无副作用，
  // 依赖变了整表重算，行为与逐处现算完全一致。
  const stepStatuses = useMemo(
    () =>
      (cfg?.steps ?? []).map((s) =>
        deriveStepStatus(s, workspaces, health, drift, terminalRunInputs),
      ),
    [cfg, workspaces, health, drift, terminalRunInputs],
  );
  /** 按索引取状态；越界回落现算（artifactsStep 等可能指向已删步骤） */
  const statusAt = (i: number) =>
    stepStatuses[i] ??
    (cfg?.steps[i]
      ? deriveStepStatus(
          cfg.steps[i],
          workspaces,
          health,
          drift,
          terminalRunInputs,
        )
      : null);
  /** 资源构成一句话（折叠态也让人知道里面有什么）：按类型计数，零资源时明说扫过了 */
  const resourceSummary = (() => {
    const rs = cfg?.resources ?? [];
    if (rs.length === 0) return "还没有登记文献/数据";
    const by = new Map<string, number>();
    for (const r of rs) by.set(r.type, (by.get(r.type) ?? 0) + 1);
    return [...by.entries()]
      .map(([t, n]) => `${n} 个${RESOURCE_TYPE_LABELS[t] ?? t}`)
      .join(" · ");
  })();
  // 产物核验手风琴展开项（单开）：无绑定工作区不渲染（菜单项本身已禁用，此处兜底）
  const artStep =
    cfg && artifactsStep !== null ? (cfg.steps[artifactsStep] ?? null) : null;
  const artSt = artifactsStep !== null ? statusAt(artifactsStep) : null;
  const artWs = artSt?.ws;
  const artMerged = artSt?.key === "done";
  // 每步完成态（带级虚线链按列区间着色）+ 末端菱形：全部步骤完成才点亮（与完成圆同一 done 绿）
  const stepDoneFlags = stepStatuses.map((st) => st.key === "done");
  // 圆下状态小字（2026-10-17 用户拍板）：圆只有颜色，待评审/进行中一眼分不清；
  // 进行中再按终端注意力细分「等你确认 / 等你查看」。待开始与检查中不写
  const stepperTexts = stepStatuses.map((st) =>
    stepperStatusText(st.key, {
      archived: st.key === "pending" && !!st.ws,
      attention: st.key === "active" ? stepAttention(st.ws, terminalRunInputs, IS_WINDOWS) : null,
    }),
  );
  const allStepsDone =
    stepDoneFlags.length > 0 && stepDoneFlags.every(Boolean);
  /** 步骤状态快照：白话状态短语 + 主推进动作（聚焦头部与流程线节点入口共用口径；
   *  待评审/阻塞时直达评审覆盖层，比跳终端少一步）。done 步骤无动作 */
  const describeStep = (i: number) => {
    if (!cfg) return null;
    const step = cfg.steps[i];
    const st = statusAt(i)!;
    const goReview = (intent?: "resolve-conflict") => () => {
      if (!st.ws) return;
      setWorkspaceReviewRequest({
        worktreePath: st.ws.worktreePath,
        runId: runIdForPath(terminalRunInputs, st.ws.worktreePath, IS_WINDOWS),
        action: intent,
        requestId: crypto.randomUUID(),
      });
      setPage("terminal");
    };
    const base = { index: i, step, st };
    switch (st.key) {
      case "pending":
        return st.ws
          ? {
              ...base,
              statusText: "工作区已归档",
              actionLabel: "恢复工作区",
              action: (() => void restoreWs(st.ws!)),
            }
          : {
              ...base,
              // 情境化引导（顺序引导 A）：任务书草稿已起草 = 想法聊透了；
              // 没有则建议先点种子——不阻断，「开始」始终可用。
              // （草稿只加载聚焦步骤那一份；statusText 仅经 focusDesc 展示，即聚焦步骤）
              statusText:
                focusDraft?.stepName === step.name && focusDraft.text?.trim()
                  ? "TASK.md 已就位，可以开始"
                  : "待开始",
              actionLabel: "开始",
              action: (() => void startStep(i)),
            };
      case "review":
        return {
          ...base,
          statusText: "agent 做完了，待你评审",
          actionLabel: "去评审",
          action: goReview(),
        };
      case "blocked":
        return {
          ...base,
          statusText: "有合并冲突待处理",
          actionLabel: "去处理冲突",
          action: goReview("resolve-conflict"),
        };
      case "checking":
        return {
          ...base,
          statusText: "状态检查中",
          actionLabel: "去终端",
          action: (() => {
            if (st.ws) onOpenTerminal(st.ws);
          }),
        };
      case "done":
        return {
          ...base,
          statusText: step.seedComplete && !st.ws ? "演示里已经筛完" : "已完成",
          actionLabel: null,
          action: null,
        };
      default:
        return {
          ...base,
          statusText: "agent 进行中",
          actionLabel: "去终端",
          action: (() => {
            if (st.ws) onOpenTerminal(st.ws);
          }),
        };
    }
  };
  // 当前步骤 = 第一个未完成步骤（步进器亮环回落与默认聚焦用；全部完成 → null）
  const currentStep = (() => {
    if (!cfg) return null;
    for (let i = 0; i < cfg.steps.length; i++) {
      const d = describeStep(i)!;
      if (d.st.key === "done") continue;
      return d;
    }
    return null;
  })();
  // 步骤聚焦：显式选择（按名字核对身份）> 跟随当前步骤 > 全部完成时落最后一步；
  // 名字在流程里找不到（被改名/删除）时不认这次聚焦，回落当前步骤——避免静默指向另一个步骤
  const focusIndex = (() => {
    if (!cfg || cfg.steps.length === 0) return null;
    if (focusStepKey !== null) {
      const i = cfg.steps.findIndex((s) => s.name === focusStepKey);
      if (i >= 0) return i;
    }
    return currentStep?.index ?? cfg.steps.length - 1;
  })();
  const focusStepName = (() => {
    if (!cfg || focusIndex === null) return null;
    return cfg.steps[focusIndex]?.name ?? null;
  })();
  // 回页释放已完成聚焦（v3.97）：页面常驻挂载，手动聚焦（focusStepKey）跨页留存——
  // 从终端页等回来时，若聚焦的步骤已完成，放掉手动聚焦、回落到当前步骤（第一个未完成）。
  // 只认「完成」这个明确信号：聚焦的步骤仍在进行/待评审时不抢用户的选择
  const prevPageVisibleRef = useRef(pageVisible);
  useEffect(() => {
    const becameVisible = pageVisible === true && prevPageVisibleRef.current !== true;
    const leftPage = pageVisible === false && prevPageVisibleRef.current !== false;
    prevPageVisibleRef.current = pageVisible;
    if (leftPage) {
      setEditorOpen(false);
      setSettingsOpen(false);
      setHistoryOpen(false);
      setKickoff(null);
      return;
    }
    if (!becameVisible || focusStepKey === null) return;
    const i = cfg?.steps.findIndex((s) => s.name === focusStepKey) ?? -1;
    if (i >= 0 && stepStatuses[i]?.key === "done") setFocusStepKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageVisible]);
  // 聚焦步骤草稿加载（state 声明在上方 describeStep 之前）：进项目详情/切聚焦/页面刷新时重读，不轮询；
  // 「◈ 沉淀进任务书」落盘后经 onDraftChanged 回调即刻重读（不等页面刷新）
  function loadFocusDraft() {
    if (!project || !focusStepName) {
      setFocusDraft(null);
      setFocusDraftError(null);
      return;
    }
    invoke<{ relPath: string; text: string | null }>("read_task_draft", {
      projectRoot: project.path,
      stepName: focusStepName,
    })
      .then((d) => {
        setFocusDraftError(null);
        setFocusDraft({ stepName: focusStepName, ...d });
      })
      .catch((reason) => {
        setFocusDraft(null);
        setFocusDraftError(
          `任务书没加载出来：${String(reason)}。「跟 AI 商量一下」和「TASK.md」先不能用。`,
        );
      });
  }
  useEffect(() => {
    loadFocusDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, focusStepName, refreshToken]);
  // 聚焦步骤的执行状态（流程线 agent/评审节点用）：deriveStepStatus 六态映射到流程线四态
  const focusRunStatus = (() => {
    if (!cfg || !focusStepName) return undefined;
    const i = cfg.steps.findIndex((s) => s.name === focusStepName);
    const st = i >= 0 ? stepStatuses[i] : undefined;
    if (!st) return undefined;
    if (st.key === "done") return "done" as const;
    if (st.key === "review" || st.key === "blocked") return "review" as const;
    if (st.key === "active" || st.key === "checking") return "active" as const;
    return "pending" as const;
  })();
  // 聚焦步骤的完整快照：聚焦头部状态短语 + 流程线动作入口（恢复工作区/冲突意图）共用
  const focusDesc = (() => {
    if (!cfg || !focusStepName) return null;
    const i = cfg.steps.findIndex((s) => s.name === focusStepName);
    return i >= 0 ? describeStep(i) : null;
  })();
  // 聚焦步骤的终端注意力（流程线 agent 节点「已跑完」提示用）
  const focusAttention = stepAttention(
    focusDesc?.st.ws && focusDesc.st.ws.status === "active"
      ? focusDesc.st.ws
      : undefined,
    terminalRunInputs,
    IS_WINDOWS,
  );
  // 聚焦步骤的已归档工作区（pending + ws）：流程线 agent 节点此时主入口是「恢复工作区」而非「开始」
  const focusArchivedWs =
    focusDesc && focusDesc.st.key === "pending" ? (focusDesc.st.ws ?? null) : null;
  // 「开读这一篇」只给示例课题精读步；普通模板流程线只显示「开始」
  const demoPaper = cfg
    ? demoReadPaperResource({
        steps: cfg.steps,
        focusStepName,
        resources: cfg.resources,
        providesByName: skillProvides,
      })
    : undefined;
  return (
    // 分组卡片收敛掉外框/底色：hairline 分隔 + 左侧缩进线分层，strip 底只保留给研究流程等必要块
    <section className="mb-5">
      <div>


      {/* 分组主体：左侧 1px 缩进线 + 透明度分层，保持原 p-4 留白节奏 */}
      <div className="border-l border-white/5 pb-4 pl-3 pr-1">

      {savingTemplate && cfg && (
        <form
          onSubmit={submitSaveTemplate}
          className="mb-2 flex flex-wrap items-center gap-1"
        >
          <input
            className={fieldSm}
            value={tplNameDraft}
            onChange={(e) => setTplNameDraft(e.target.value)}
            placeholder="模板名，如 我的综述流程"
            autoFocus
            required
          />
          <input
            className={`${fieldSm} min-w-0 flex-1`}
            value={tplDescDraft}
            onChange={(e) => setTplDescDraft(e.target.value)}
            placeholder="描述（可选）：适用场景说明"
          />
          <button type="submit" className={ctaSm} disabled={tplSaving}>
            {tplSaving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            className={actionBtn}
            onClick={() => setSavingTemplate(false)}
          >
            取消
          </button>
        </form>
      )}

      {tplSavedMsg && (
        <NoticeBar className="mb-2" onDismiss={() => setTplSavedMsg(null)}>
          {tplSavedMsg}
        </NoticeBar>
      )}

      {registered && freshGitGuide && project && projectNeedsDefaultAgent(project) && onOpenAgents && (
        <div className="ccode-well mb-2 flex items-center gap-3 rounded-lg px-3 py-2 text-xs text-l2">
          <span className="min-w-0 flex-1">先定这个项目默认用哪家、哪个模型。</span>
          <button type="button" className={ctaSm} onClick={onOpenAgents}>
            设默认
          </button>
        </div>
      )}

      {registered && freshGitGuide && (
        <div className="ccode-well mb-3 flex items-center gap-3 rounded-lg px-3 py-2 text-xs text-l2">
          <span className="min-w-0 flex-1">
            初始化 git 后才能建工作区。
            {cfg && (cfg.resources.length > 0) && (
              <span className="text-l3"> 已扫到 {resourceSummary}。</span>
            )}
            {gitMsg && <span className="text-ok-text"> ✓ {gitMsg}</span>}
          </span>
          <button
            type="button"
            className={ctaSm}
            disabled={gitBusy}
            onClick={() => void ensureGit()}
          >
            {gitBusy ? "初始化中…" : "初始化 git"}
          </button>
          {cfg && cfg.resources.length > 0 && (
            <button
              type="button"
              className={actionBtn}
              onClick={() => {
                setSettingsOpen(true);
                setResOpen(true);
                requestAnimationFrame(() =>
                  resPanelRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  }),
                );
              }}
            >
              查看文献
            </button>
          )}
          <button type="button" className="shrink-0 text-l3 hover:text-l1" onClick={onDismissGitGuide}>
            知道了
          </button>
        </div>
      )}

      {registered && cfgLoadError && (
        <NoticeBar tone="warn" className="mb-3">
          <span className="mr-2">{cfgLoadError}，研究流程与资源面板暂不可用。</span>
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2 hover:text-l1"
            onClick={() => void reloadCfg(projectPath)}
          >
            重试
          </button>
        </NoticeBar>
      )}

      {/* 首启引导（轻量版）：注册项目且 steps 为空 → 从模板库选择写入研究流程；
          「不使用研究流程」（pipelineOptOut）显式隐藏本横幅，回流入口在项目设置 */}
      {liteResearch && project && (
        <ProjectUserTasksView
          project={project}
          embed
        />
      )}

      {registered && cfg && cfg.steps.length === 0 && !cfg.pipelineOptOut && (
        <div className="ccode-well mb-2 rounded-md p-3">
          <p className="mb-2 text-xs text-l3">
            还没有研究步骤。写论文请从模板库选一套；只读文献、写笔记，选「不使用研究流程」。
          </p>
          <input
            className={`${fieldSm} mb-2 w-full`}
            value={templateTopic}
            onChange={(e) => setTemplateTopic(e.target.value)}
            placeholder="课题主题（给 Agent 看，随 TASK.md 走）：选模板时填过会显示在这里，可改可留空"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={ctaSm}
              disabled={optingOut}
              onClick={() => {
                // 模板库实例住在项目设置抽屉里（v3.85），这里必须连抽屉一起开，
                // 否则只翻了 pickerOpen、界面上什么都不会发生
                setPickerOpen(true);
                setSettingsOpen(true);
              }}
            >
              选择研究流程模板
            </button>
            <button
              type="button"
              className={actionBtn}
              title="打开研究流程编辑器，从头手动添加步骤"
              onClick={() => openEditor()}
            >
              编辑研究流程
            </button>
            <button
              type="button"
              className={actionBtn}
              disabled={optingOut}
              title="不挂步进器，这个文件夹只用来读文献、写笔记（记住选择，不再显示本引导）"
              onClick={() => void optOutPipeline()}
            >
              {optingOut ? "保存中…" : "不使用研究流程"}
            </button>
          </div>
        </div>
      )}

      {/* 研究流程 strip（大圆步进器，v3.46）：状态从绑定工作区派生；
          大圆 = 状态色 + 主推进点击；编辑步骤/产物核验收进步骤 ⋯ 菜单（原圆前/圆后小方块
          伪装成虚线块可发现性为零，入口删除、视觉块保留为普通虚线块）；末端菱形 = 流程终点，
          全部步骤完成后点亮（与完成圆同一 done 绿）。
          结构 = 名称带 + 步进器带两个同列网格；虚线链由 StepperChain 在带级一次铺满
          （块位以圆心为锚分段等距计算，跨列无边界、各圆两侧断口一致），圆以同款内容井底色遮罩压在链上 */}
      {registered && cfg && cfg.steps.length > 0 && (
        <div className="ccode-well mb-3 rounded-md px-3 py-2.5">
          {cfg.steps.some((step) => step.role === "you" || step.role === "both") && (
            <div
              className="mb-1 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-micro text-l4"
              role="note"
              aria-label="步骤角色提示"
            >
              <span>角色提示</span>
              {cfg.steps.some((step) => step.role === "you") && (
                <span className="inline-flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-cta" aria-hidden />
                  你主要负责
                </span>
              )}
              {cfg.steps.some((step) => step.role === "both") && (
                <span className="inline-flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-l4" aria-hidden />
                  你和 AI 一起定
                </span>
              )}
            </div>
          )}
          {/* 等分列网格：列宽下限 9rem 让更多步骤在常规窗口内完整可见；
              窗口过窄放不下全部步骤时保持整体横向滚动（不换行，虚线与各列大圆同轴） */}
          {/* 横向滚动容器必须显式 overflow-y-clip：overflow-x:auto 会把 y 轴也算成 auto，
              圆的 28px 热区/tooltip 溢出纵向就会冒出滚动条，宽度变化又触发链重算（左右晃动） */}
          <div
            ref={stepperScrollerRef}
            className="overflow-x-auto overflow-y-clip pb-1"
          >
            <div
              className="min-w-full"
              style={{
                minWidth: `calc(${cfg.steps.length} * 9rem + ${cfg.steps.length - 1} * ${STEPPER_GAP_PX}px + 20px)`,
              }}
            >
              {/* 名称带：居中截断（悬浮全称）；⋯ 步骤菜单 hover/聚焦才现。
                  末尾占位与步进器带的终点菱形同宽（10px），两条带的列严格对齐 */}
              <div className="flex items-center gap-[6px]">
                <ol
                  className="grid min-w-0 flex-1 gap-[6px]"
                  style={{
                    gridTemplateColumns: `repeat(${cfg.steps.length}, minmax(9rem, 1fr))`,
                  }}
                >
                {cfg.steps.map((step, i) => (
                  <li key={`${i}-${step.name}`} className="group relative min-w-0">
                    <div className="relative flex h-7 items-center px-7">
                      <span
                        className="flex min-w-0 flex-1 items-center justify-center gap-1 truncate text-center text-xs text-l2"
                        title={
                          step.role === "you"
                            ? `${step.name}（这一步主要靠你）`
                            : step.role === "both"
                              ? `${step.name}（你和 AI 一起定）`
                              : step.name
                        }
                      >
                        <span className="min-w-0 truncate">{step.name}</span>
                        {/* 「轮到我」的一眼扫描（v3.89）：名称带列宽只有 9rem，
                            塞文字徽标会挤掉步骤名，故只用一个点；完整说明在 title 与流程线里 */}
                        {(step.role === "you" || step.role === "both") && (
                          <span
                            className={`size-1.5 shrink-0 rounded-full ${
                              step.role === "you" ? "bg-cta" : "bg-l4"
                            }`}
                          />
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setStepMenu({
                            x: rect.right,
                            y: rect.bottom + 4,
                            index: i,
                          });
                        }}
                        title="步骤操作"
                        aria-label={`步骤操作：${step.name}`}
                        className={`absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                      >
                        ⋯
                      </button>
                    </div>
                  </li>
                ))}
                </ol>
                <span className="w-3.5 shrink-0" aria-hidden />
              </div>
              {/* 步进器带：StepperChain 在带级把虚线链一次铺满（6px 块 + 6px 间隙，跨列连续无边界），
                  圆用 strip 底色遮罩压在链上；与名称带同列同隙。
                  末端菱形 = 流程终点符号（装饰，无点击），全部步骤完成后点亮 */}
              <div className="flex items-center gap-[6px]">
                <StepperChain dones={stepDoneFlags}>
                  <ol
                    className="relative grid gap-[6px]"
                    style={{
                      gridTemplateColumns: `repeat(${cfg.steps.length}, minmax(9rem, 1fr))`,
                    }}
                  >
                  {cfg.steps.map((step, i) => {
                    const st = statusAt(i)!;
                    const statusLabel =
                      st.key === "pending" && st.ws
                        ? "已归档"
                        : STEP_STATUS_LABEL[st.key];
                    const activeWs =
                      st.ws && st.ws.status === "active" ? st.ws : undefined;
                    const last = activeWs
                      ? wsLastConfig(activeWs.worktreePath)
                      : {};
                    const lastProfile = last.profileId
                      ? profiles.find((p) => p.id === last.profileId)
                      : undefined;
                    // 状态/目录/agent + 点击动作提示并入悬浮全文（白话双层），圆上只留状态色
                    // 点击 = 聚焦该步骤（下方卡片区只看这一步）；推进动作归流程线节点/卡片行/任务行
                    const circleTitle = [
                      `${step.name} · ${statusLabel}`,
                      activeWs
                        ? `目录：${activeWs.worktreePath}`
                        : st.ws
                          ? "工作区已归档"
                          : "工作区尚未创建",
                      last.agentId
                        ? `Agent：${last.agentId}${lastProfile ? ` / ${lastProfile.name}` : ""}`
                        : null,
                      "点击在下方只看这一步",
                    ]
                      .filter(Boolean)
                      .join("\n");
                    // 聚焦选中态：显式选择优先；未选过时当前步骤（第一个未完成）亮环
                    const selected = focusIndex === i;
                    return (
                      <StepperCell
                        key={`${i}-${step.name}`}
                        circleClass={stepCircleClass(st.key)}
                        circleTitle={circleTitle}
                        circleWarn={
                          st.ws?.staleUpstream
                            ? `上游「${st.ws.staleUpstream}」有更新，产物可能过期`
                            : null
                        }
                        circleLabel={`${step.name}：${statusLabel}`}
                        circleDisabled={false}
                        pulsing={starting === i}
                        selected={selected}
                        onCircleClick={() => onCircleClick(i)}
                      />
                    );
                  })}
                  </ol>
                </StepperChain>
                <span
                  className="flex h-7 w-3.5 shrink-0 items-center justify-center"
                  role="img"
                  aria-label={
                    allStepsDone ? "流程终点：全部步骤已完成" : "流程终点"
                  }
                >
                  {/* 实心菱形终点（9px 旋转 45°），与虚线块同轴、同 6px 间隙接上链条；
                      明暗跟随完成态：未完成与未完成链条同暗（hairline），全部完成点亮
                      高对比中性色（l1）——2026-09-15 用户拍板步进器不要绿色 */}
                  <span
                    aria-hidden
                    className={`block size-[9px] rotate-45 rounded-[1px] transition-colors duration-300 ${
                      allStepsDone ? "bg-l1" : "bg-hairline"
                    }`}
                  />
                </span>
              </div>
              {/* 状态带：圆正下方一行小字，与名称带、步进器带同列同隙；一个都没有（全待开始）不占行 */}
              {stepperTexts.some(Boolean) && (
                <div className="flex items-center gap-[6px]">
                  <ol
                    aria-label="步骤状态"
                    className="grid min-w-0 flex-1 gap-[6px]"
                    style={{
                      gridTemplateColumns: `repeat(${cfg.steps.length}, minmax(9rem, 1fr))`,
                    }}
                  >
                    {stepperTexts.map((text, i) => (
                      <li
                        key={`${i}-${cfg.steps[i]?.name ?? ""}`}
                        className="flex h-4 min-w-0 items-center justify-center"
                      >
                        {text && (
                          <span className={`truncate text-micro leading-4 ${text.tone}`}>
                            {text.text}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                  <span className="w-3.5 shrink-0" aria-hidden />
                </div>
              )}
            </div>
          </div>
          {stepperOverflows && (
            <p className="mt-1 text-center text-micro text-l4">
              步骤较多，可左右滚动查看后续步骤 →
            </p>
          )}
        </div>
      )}

      {/* 应用模板成功的一次性引导条（顺序引导的入口提示）：把视线引到第 1 步，可关 */}
      {tplApplied && (
        <NoticeBar
          tone="info"
          className="mb-3"
          onDismiss={() => setTplApplied(false)}
        >研究流程已就位。</NoticeBar>
      )}

      {cfg && closeoutPackVisible(cfg.steps, stepDoneFlags) && (
        <CloseoutPack
            projectRoot={projectPath}
            worktrees={workspaces
              .filter((workspace) => workspace.status === "active")
              .map((workspace) => workspace.worktreePath)}
            entries={closeoutScanEntries(cfg.steps)}
          />
      )}

      {/* 人工事项清单已并入聚焦视图（TaskCardsSection 聚焦步骤时顶部渲染）；原 ⋯ 手风琴面板删除 */}

      {/* 产物核验手风琴（步骤 ⋯ 菜单触发）：strip 下方就地展开（单开）；root 口径同任务行——已合并读项目根，其余读工作树 */}
      {artStep && artWs && (
        <div className="mb-4">
          <ArtifactChecklist
            projectPath={projectPath}
            workspaceName={artStep.workspaceName}
            root={artMerged ? repoPath : artWs.worktreePath}
            rootLabel={artMerged ? REVIEW_SAVE.artifactRootMerged : "工作区"}
          />
        </div>
      )}

      {/* 话题区（研究流程步进器下方）：对话的归档文件夹（任务书沉淀统一走草稿）；无独立状态机，不碰工作区/评审流程。
          v3.70 起按 focusStep 聚焦：恒为单步骤视图，点大圆或卡片区头部 ‹ › 箭头切步骤（v3.81 起无总览态） */}
      {registered && cfg && (!liteResearch || (taskCards?.length ?? 0) > 0) && (
        <TaskCardsSection
          projectPath={projectPath}
          {...projectAgentPrefs(project)}
          taskBindings={project.taskBindings ?? null}
          steps={cfg.steps}
          cfg={cfg}
          workspaces={workspaces}
          refreshToken={refreshToken}
          mainDirty={mainDirty}
          onMainDirtyRefresh={reloadMainDirty}
          focusStep={focusStepName}
          focusStatusText={focusDesc?.statusText ?? null}
          focusRunStatus={focusRunStatus}
          focusAgentAttention={focusAttention}
          focusRunId={runIdForPath(
            terminalRunInputs,
            focusAttention ? (focusDesc?.st.ws?.worktreePath ?? "") : "",
            IS_WINDOWS,
          )}
          focusDraft={
            focusDraft && focusDraft.stepName === focusStepName
              ? focusDraft
              : null
          }
          focusDraftError={
            focusDraftError &&
            !(focusDraft && focusDraft.stepName === focusStepName)
              ? focusDraftError
              : null
          }
          onDraftChanged={loadFocusDraft}
          onOpenResources={(focus) => {
            // 资源面板已搬进项目设置抽屉（v3.85）：开抽屉 + 展开该区，
            // 再滚到它（抽屉里内容多时它不一定在首屏）；focus 高亮对应进料入口
            setSettingsOpen(true);
            setResOpen(true);
            setResFocus(focus ?? null);
            if (focus) window.setTimeout(() => setResFocus(null), 2500);
            requestAnimationFrame(() =>
              resPanelRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "center",
              }),
            );
          }}
          // 输入准备（v3.86）：文献来源与两个导入入口直接放到流程线「定方向」里，
          // 不必再进抽屉找。Zotero 选择器本就是根级弹层，任何地方都能拉起
          onSetLitSource={setLitSource}
          litBusy={litBusy}
          onSetResearchTool={setResearchTool}
          toolBusy={toolBusy}
          reviewConflict={focusDesc?.st.key === "blocked"}
          onRestoreWorkspace={
            focusArchivedWs ? () => void restoreWs(focusArchivedWs) : undefined
          }
          onFocusIndex={focusByIndex}
          onStartStep={(index, originCardId) => startStep(index, originCardId)}
          onReadPaper={demoPaper ? () => immerseResource(demoPaper) : undefined}
          readPaperPrimary={Boolean(demoPaper)}
        />
      )}

      {/* ───── 项目设置抽屉（右侧滑出，不是页面、不进侧栏、不占路由） ─────
          外壳与「规则与验收」分区走 ProjectSettingsDrawer 的共用件，三种工作方式
          同一入场/退场/Esc/焦点口径；科研独有分区：基本 / 研究流程 / 文献与数据。 */}
      <SettingsDrawerShell
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        subtitle={displayName}
      >
        {project && (
          <section>
            <h3 className="mb-2 text-xs font-medium text-l3">基本</h3>
            {/* 容器定 text-xs：全站 button { font: inherit } 吞掉按钮上的 text-*，
                「重命名 / 编辑 / 复制」原先比左侧标签大一号（2026-10-17 截图） */}
            <div className="space-y-2 rounded-lg ccode-well p-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-l3">项目名</span>
                <span className="min-w-0 flex-1 truncate text-sm text-l1">
                  {displayName}
                </span>
                <button
                  type="button"
                  className={actionBtn}
                  onClick={() => {
                    setSettingsOpen(false);
                    onIdentityAction?.("rename");
                  }}
                >
                  重命名
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-l3">课题主题</span>
                <span className="min-w-0 flex-1 truncate text-sm text-l2">
                  {cfg?.topic?.trim() || (
                    <span className="text-l4">未填写</span>
                  )}
                </span>
                <button
                  type="button"
                  className={actionBtn}
                  disabled={!cfg}
                  onClick={() => {
                    setSettingsOpen(false);
                    onIdentityAction?.("topic");
                  }}
                >
                  编辑
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-l3">项目路径</span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-micro text-l3"
                  title={project.path}
                >
                  {project.path}
                </span>
                <button
                  type="button"
                  className={actionBtn}
                  onClick={() => copyText(project.path, "复制项目路径失败")}
                >
                  复制
                </button>
              </div>
            </div>
          </section>
        )}

        {project && (
          <SettingsRulesSection
            projectPath={project.path}
            projectName={displayName}
            workMode={cfg?.workMode ?? project.workMode}
            onSaved={() => void reloadCfg(projectPath)}
            onError={onError}
          />
        )}

        {registered && cfg && (
          <section>
            <h3 className="mb-2 text-xs font-medium text-l3">研究流程</h3>
            <div className="rounded-lg ccode-well p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-xs text-l4">
                  当前 {cfg.steps.length} 个步骤
                </span>
                <button
                  type="button"
                  className={secondaryActionClass}
                  onClick={() => setPickerOpen((v) => !v)}
                  title={
                    cfg.steps.length === 0
                      ? "打开模板库选一套研究流程写入项目"
                      : "另选一个模板；写入时现有步骤被替换，绑定的工作区与资源不受影响"
                  }
                >
                  {pickerOpen
                    ? "收起模板库"
                    : cfg.steps.length === 0
                      ? "选择模板"
                      : "更换模板"}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  className={ghostActionClass}
                  disabled={cfg.steps.length === 0}
                  title={
                    cfg.steps.length > 0 ? undefined : "没有可保存的研究步骤"
                  }
                  onClick={() => {
                    setTplSavedMsg(null);
                    setSavingTemplate(true);
                    setSettingsOpen(false);
                  }}
                >
                  另存为模板
                </button>
                {cfg.steps.length > 0 && (
                  <button
                    type="button"
                    className={dangerBtn}
                    disabled={optingOut}
                    title="去掉步进器，这个文件夹只用来读文献、写笔记；步骤表清空，文件保留"
                    onClick={() => void optOutPipeline()}
                  >
                    {optingOut ? "保存中…" : "不使用研究流程"}
                  </button>
                )}
              </div>
              {/* 模板库选择器：项目菜单与空研究流程「选择研究流程模板」共用的唯一实例 */}
              {pickerOpen && (
                <div className="mt-3 rounded-lg ccode-well p-2">
                  <TemplatePicker
                    applying={applyingTemplate}
                    onApply={(item) => void applyTemplate(item)}
                    onError={onError}
                  />
                </div>
              )}
            </div>
          </section>
        )}

      {/* 文献与数据（原「资源面板」）：三个进料口收在一处——注册时已自动扫过一遍，
          这里回答「扫到了什么」+「还能从哪儿补」。新注册的项目自动展开：
          原先提示挂在页面底部、又被模板选择层挡住，用户根本看不到扫描发生过 */}
      {registered && cfg && (
        <section ref={resPanelRef} className="text-xs">
          <button
            type="button"
            className="mb-2 flex w-full items-center gap-1.5 text-left text-xs font-medium text-l3 hover:text-l1"
            onClick={() => setResOpen((v) => !v)}
            aria-expanded={resOpen}
          >
            <FoldMark open={resOpen} />
            文献与数据（{cfg.resources.length}）
            {/* 折叠态也要说清「有什么」和「还能补」：只在新注册或零资源时才提示，
                等于对老项目和已有资源的项目永远沉默——那正是用户看不到扫描发生过的原因 */}
            {!resOpen && (
              <span className="min-w-0 flex-1 truncate text-micro font-normal text-l4">
                {resourceSummary}
                <span className="text-l4"> · 展开可从 Zotero / 检索结果补充</span>
              </span>
            )}
          </button>
          {resOpen && (
            <div className="space-y-2 rounded-lg ccode-well p-3 text-xs">
              {/* 「文献来源」选择器已移到流程线「定方向」的输入准备块（v3.86）——
                  它是开工前必须拍板的事，藏在抽屉三层下面本身就是错的位置，
                  而且当时与决策项、人工事项一起把同一个问题问了四遍。
                  这里只留当前值的只读回显 + 跳转，导入动作两处都保留（这里是二级入口）。 */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-micro text-l4">文献来源</span>
                <span className="rounded-full bg-inset px-2 py-0.5 text-micro text-l2">
                  {{
                    search: "让 agent 检索",
                    zotero: "我有 Zotero 库",
                    endnote: "我有 EndNote 库",
                    folder: "我已有 PDF / 题录",
                  }[cfg.litSource?.trim() || "search"] ?? "让 agent 检索"}
                </span>
                <span className="text-micro text-l4" title="在流程线的「确定文献来源」里更改">
                  在流程线里改
                </span>
              </div>
              {(cfg.litSource?.trim() || "search") !== "search" && (
                <p className="text-micro leading-5 text-l4">
                  检索步骤已改为「盘点已有 + 查漏补缺」，筛选这一步不会跳过。
                </p>
              )}
              {/* 进料口三选一：agent 自己扫 / 你已有的库 / 你手动检索的结果。
                  一行摆齐，用户不必在界面里找第二处入口 */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-micro text-l4">从哪儿补</span>
                <button
                  type="button"
                  className={`${actionBtn} ${resFocus === "zotero" ? "ring-2 ring-cta" : ""}`}
                  disabled={zoteroBusy}
                  title="从本机 Zotero 库导入：生成 references.bib，已下载的 PDF 按绝对路径登记为资源（只读引用，不复制）。你的 Zotero 库只读不改"
                  onClick={() => void openZotero()}
                >
                  {zoteroBusy ? "读取中…" : "从 Zotero 导入"}
                </button>
                <button
                  type="button"
                  className={`${actionBtn} ${resFocus === "files" ? "ring-2 ring-cta" : ""}`}
                  title="你在 Undermind / Google Scholar / Elicit 等网页端检索后，把结果导出成 RIS / BibTeX / CSV 文件，点这里导入（可多选）。开工时 agent 会自动解析、按 DOI 去重、并进筛选清单——省掉你手抄一遍"
                  onClick={() => void importSearchResults()}
                >
                  导入 RIS / BibTeX
                </button>
                <button
                  type="button"
                  className={actionBtn}
                  disabled={discoverLoading}
                  title="重新扫描项目目录（PDF / CSV / parquet / bib 等，深度 3）；注册时已自动扫过一次，往目录里放了新文件再点"
                  onClick={() => void discoverResources()}
                >
                  {discoverLoading ? "扫描中…" : "重新扫描目录"}
                </button>
              </div>
              <ResourceListSection
                heading={false}
                projectPath={projectPath}
                resources={cfg.resources}
                onImmerse={immerseResource}
                onAskAi={askAiResource}
                onMenu={(r, el) => {
                  const index = cfg.resources.findIndex((x) => x.path === r.path);
                  if (index < 0) return;
                  const rect = el.getBoundingClientRect();
                  setResourceMenu({
                    x: rect.right,
                    y: rect.bottom + 4,
                    index,
                  });
                }}
              />
              {discoverState && (
                <div>
                  {discoverState.items.length === 0 ? (
                    <p className="text-xs text-l4">
                      未扫描到 PDF / CSV / parquet / bib 等资源文件。
                    </p>
                  ) : (
                    <>
                      <span className="mb-1 block text-xs text-l3">
                        扫描到 {discoverState.items.length}
                        个候选资源，勾选后登记到 project.toml：
                      </span>
                      <ul className="max-h-48 space-y-1 overflow-auto">
                        {discoverState.items.map((d) => (
                          <li key={d.path}>
                            {d.exists ? (
                              <span className="flex min-w-0 items-center gap-1.5 text-xs text-l4">
                                <span className="shrink-0 text-ok-text">✓</span>
                                <span className="min-w-0 truncate font-mono" title={d.path}>
                                  {d.path}
                                </span>
                                <span className="shrink-0">已登记</span>
                              </span>
                            ) : (
                              <Checkbox
                                checked={discoverState.selected.has(d.path)}
                                onChange={(checked) => {
                                  const selected = new Set(
                                    discoverState.selected,
                                  );
                                  if (checked) selected.add(d.path);
                                  else selected.delete(d.path);
                                  setDiscoverState({
                                    ...discoverState,
                                    selected,
                                  });
                                }}
                                label={
                                  <span className="flex min-w-0 items-center gap-2 text-xs">
                                    <span className="shrink-0 rounded-sm bg-inset px-1 py-0.5 text-l3">
                                      {RESOURCE_TYPE_LABELS[d.type] ??
                                        "其他"}
                                    </span>
                                    <span
                                      className="min-w-0 truncate font-mono text-l2"
                                      title={d.path}
                                    >
                                      {d.path}
                                    </span>
                                    <span className="shrink-0 text-l4">
                                      {formatSize(d.size)}
                                    </span>
                                  </span>
                                }
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                      <div className="mt-2 flex justify-end gap-1">
                        <button
                          type="button"
                          className={actionBtn}
                          onClick={() => setDiscoverState(null)}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className={ctaSm}
                          disabled={discoverState.selected.size === 0}
                          onClick={() => void addSelectedResources()}
                        >
                          添加选中（{discoverState.selected.size}）
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
              {importMsg && (
                <NoticeBar onDismiss={() => setImportMsg(null)}>
                  {importMsg}
                </NoticeBar>
              )}
              {zoteroMsg && (
                <div className="flex items-start gap-2 rounded-md ccode-well px-3 py-2.5 text-xs leading-5 text-l2">
                  <span className="min-w-0 flex-1">
                    {zoteroMsg}
                    {zoteroMsg.includes("没找到") &&
                      " 选含 zotero.sqlite 的那一层，通常是「Zotero」。storage 里 5GJUJ4V2 这种短码是它存 PDF 的内部目录，不是库。"}
                  </span>
                  {zoteroMsg.includes("没找到") && (
                    <button
                      type="button"
                      onClick={() => void pickZoteroDir()}
                      className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-l2 hover:bg-hover hover:text-l1"
                    >
                      选择目录
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setZoteroMsg(null)}
                    className="shrink-0 rounded-sm px-1 py-0.5 text-l4 hover:bg-hover hover:text-l1"
                  >
                    知道了
                  </button>
                </div>
              )}
              {gitignoreHint && (
                <NoticeBar
                  tone="info"
                  onDismiss={() => setGitignoreHint(false)}
                >数据与产物类大文件建议加进 .gitignore。</NoticeBar>
              )}
            </div>
          )}
        </section>
      )}
      </SettingsDrawerShell>
      {/* ───── 项目设置抽屉结束 ───── */}

      {!liteResearch &&
        children({
          focusStepName,
          steps: cfg?.steps ?? [],
        })}
      </div>
      </div>


      {stepMenu && (
        <ContextMenu
          x={stepMenu.x}
          y={stepMenu.y}
          alignRight
          onClose={() => setStepMenu(null)}
          items={stepMenuItems(stepMenu.index)}
        />
      )}
      {resourceMenu && (
        <ContextMenu
          x={resourceMenu.x}
          y={resourceMenu.y}
          alignRight
          onClose={() => setResourceMenu(null)}
          items={resourceMenuItems(resourceMenu.index)}
        />
      )}
      {editorOpen && project && cfg && (
        <PipelineEditor
          projectName={displayName}
          projectPath={project.path}
          config={cfg}
          warnings={cfgWarnings}
          saving={pipelineSaving}
          taskBindings={project.taskBindings ?? null}
          focusStep={editorFocus}
          onSave={(steps, settings) => void savePipeline(steps, settings)}
          onClose={() => setEditorOpen(false)}
          onConfigReload={(read) => {
            setCfg(read.config);
            setCfgWarnings(read.warnings);
          }}
        />
      )}
      {historyOpen && project && (
        <HistoryOverlay
          projectName={displayName}
          repoPath={project.path}
          wsSteps={wsStepMap}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {/* Zotero 分类选择：只读适配器的唯一交互点——选一个分类（或整库）导入 */}
      {zoteroLib && (
        <Modal
          open
          size="md"
          title="从 Zotero 导入"
          onClose={() => setZoteroLib(null)}
          footer={
            <>
              <span
                className="mr-auto min-w-0 flex-1 truncate font-mono text-micro text-l4"
                title={zoteroLib.dbPath}
              >
                {zoteroLib.dbPath}
              </span>
              <button
                type="button"
                onClick={() => setZoteroLib(null)}
                className={secondaryActionClass}
              >
                取消
              </button>
            </>
          }
        >
            <p className="text-xs text-l3">生成 references.bib；PDF 只登记位置，不复制。<span className="text-l4">你的 Zotero 库只读不改。</span>
            </p>
            <button type="button" className="mt-2 text-left text-xs text-l3 hover:text-l1" onClick={async () => {
              const picked = await open({ directory: true, multiple: false, title: "选择 Zotero 链接附件基目录（可选）" });
              if (typeof picked === "string") setZoteroAttachmentBase(picked);
            }}>链接附件基目录：{zoteroAttachmentBase ?? "未指定（使用相对链接附件时选择）"}</button>
            <div className="mt-3 space-y-1">
              {zoteroLib.collections.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={zoteroBusy || c.count === 0}
                  onClick={() => void importZotero(c.id)}
                  className="flex w-full items-center gap-2 rounded-md ccode-well px-2.5 py-2 text-left hover:bg-hover disabled:opacity-40"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-l1">
                    {c.name}
                  </span>
                  <span className="shrink-0 text-micro text-l4">
                    {c.count} 条
                  </span>
                </button>
              ))}
              <button
                type="button"
                disabled={zoteroBusy}
                onClick={() => void importZotero(null)}
                className="flex w-full items-center gap-2 rounded-md border border-dashed border-field px-2.5 py-2 text-left hover:bg-hover disabled:opacity-40"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-l2">
                  整个库（含未分类）
                </span>
                <span className="shrink-0 text-micro text-l4">
                  {zoteroLib.total} 条
                </span>
              </button>
            </div>
        </Modal>
      )}
      {/* 开工确认弹层：确认后才走建工作区链路（runStartStep） */}
      {kickoff && project && cfg && cfg.steps[kickoff.index] && (
        <KickoffConfirmDialog
          projectPath={project.path}
          step={cfg.steps[kickoff.index]}
          cfg={cfg}
          taskBindings={project.taskBindings ?? null}
          {...projectAgentPrefs(project)}
          originCardId={kickoff.originCardId}
          busy={starting !== null}
          onCancel={() => setKickoff(null)}
          onConfirm={(taskMd, launch, decisionPauseAcknowledged, intake) => {
            const index = kickoff.index;
            setKickoff(null);
            void runStartStep(index, taskMd, launch, decisionPauseAcknowledged, intake);
          }}
          onCfgChange={(next) => setCfg(next)}
          unsavedUpstream={unsavedUpstreamSteps(cfg.steps, kickoff.index, (i) => {
            const st = statusAt(i);
            return st ? { key: st.key, worktreePath: st.ws?.worktreePath ?? null } : null;
          })}
          onOpenUpstreamReview={(upstream) => {
            setKickoff(null);
            setWorkspaceReviewRequest({
              worktreePath: upstream.worktreePath,
              runId: runIdForPath(terminalRunInputs, upstream.worktreePath, IS_WINDOWS),
              action: upstream.status === "blocked" ? "resolve-conflict" : undefined,
              requestId: crypto.randomUUID(),
            });
            setPage("terminal");
          }}
        />
      )}
    </section>
  );
}
