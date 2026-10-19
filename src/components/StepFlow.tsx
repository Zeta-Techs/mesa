import { sanitizeDocumentHtml } from "../document-html";
import { useRef, useState, useEffect, useLayoutEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  cachedJournalMetric,
  journalMetricTone,
  rememberJournalMetrics,
  type JournalMetricsDto,
  type JournalMetricsStatusDto,
} from "../lit-watch";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { marked } from "marked";
import { renderMathInto } from "../md-math";
import { useAppStore } from "../store";
import { absoluteResourcePath } from "./ArtifactChecklist";
import { confirmDialog } from "./ConfirmDialog";
import {
  Checkbox,
  FoldMark,
  ghostActionClass,
  inlineActionClass,
  primaryActionClass,
  secondaryActionClass,
  InlineNotice,
} from "./PageFrame";
import {
  buildStepFlow,
  discussChatLabel,
  isPaywallTaskTitle,
  isPendingConfirmTaskTitle,
  isSpotCheckTaskTitle,
  missingToFetchCount,
  parseToFetchItems,
  recalledToFetchDone,
  rememberToFetchDone,
  toFetchPaperRel,
  toFetchSavedCount,
  type StepFlowNode,
  type ToFetchItem,
} from "../step-flow";
import { stepFillsAnySlot, useSkillProvides } from "../skill-slots.ts";
import {
  RESEARCH_TOOL_FIELDS,
  type ResearchToolField,
  type ResearchTools,
} from "../research-tools";
import { displayCitationTitle } from "../screening-review";
import { readResearchLedger } from "../research-report-load";
import { excludedIncludedIds, notesProgress, notesProgressLine, spotCheckPicks, type SpotCheckPick } from "../notes-progress";
import { stepNodeAction, stepNodeReady } from "../step-node-actions.ts";
import {
  DECISION_STATUS,
  DECISION_STATUS_ASK,
  decisionAsk,
  formatDecisionAnswer,
  isTaskMdStub,
  parseDecisionAnswer,
  parseDecisions,
  recommendedAnswers,
  unansweredDecisions,
  upsertDecisions,
  decisionGate,
  type DecisionStatus,
} from "../step-decisions";
import { useHumanTasks, RegisterOfferRow } from "./HumanTasksList";
import { buildWorkspaceTerminalRequest } from "../pipeline-start";
import { stepSlotKey, taskBindingLaunch } from "../project-agents";
import {
  CITATION_STYLE_CHOICES,
  citationFormFamily,
  citationRerenderPrompt,
  isCitationStyleTask,
  journalAsk,
  parseTargetJournal,
  styleFamilyOf,
  targetJournalDoc,
  topJournals,
  type StyleFamily,
} from "../citation-style-choice";

import {
  ACADEMIC_MCP_PRESETS,
  academicMcpLoginPrompt,
  isAcademicMcpTaskTitle,
  type AcademicMcpLogin,
} from "../academic-mcp";
import {
  instActiveFrom,
  instOpenTarget,
  type FetchedFulltextDto,
  type InstSessionStatus,
} from "../inst-access";
import PendingConfirmList, { type PendingConfirmHandle } from "./PendingConfirmList";
import ReviewDecisionList from "./ReviewDecisionList";
import {
  continueAfterDecisionsPrompt,
  isInlineDecisionTaskTitle,
  reviewItemKind,
} from "../review-decisions";
import type { ProjectStepDto, WorkspaceDto } from "../types";
import type { StepRunStatus } from "../step-flow";

/** 步骤内协同流程线（v3.71，聚焦视图顶部）：把这一步里人和 agent 的动作按先后排成有序节点链
 * （种子 → before 事项 → agent 执行 → during 事项 → after 事项 → 评审合并），当前节点高亮。
 *  回答三个问题：这一步谁先谁后（节点顺序）、现在轮到谁（当前节点）、轮到我时在哪操作（节点行就地）。 */
/** 文献来源选项（值与后端 lit_source 对应）：zotero 与 folder 都属「我已有文献库」，
 *  区别只在进料方式，故并列三项而不是嵌套两层 */
/** 付费墙任务的现行三步口径（2026-09-16 精简；2026-09-17 审计后文案对齐现行
 *  按钮）：旧项目档案里存的是当年模板的老 guidance，就地替换显示，不动数据；
 *  新模板 guidance 同步收敛到同一版 */
/** 待获取清单展开状态的持久化（2026-09-17 用户实测：切去文件页再回来清单收起
 *  了，还得重新点开找回刚才看的位置）——按项目记忆，localStorage 客户端偏好 */
const paywallListOpenKey = (root: string) => `ccode.paywallListOpen:${root}`;
function readPaywallListOpen(root: string): boolean {
  try {
    return localStorage.getItem(paywallListOpenKey(root)) === "1";
  } catch {
    return false;
  }
}
function writePaywallListOpen(root: string, open: boolean): void {
  try {
    localStorage.setItem(paywallListOpenKey(root), open ? "1" : "0");
  } catch {
    /* 隐私模式写不进就只靠本次 */
  }
}

/** 切去文件页会卸掉任务页：记住刚才那一行和清单滚动，回来对上。 */
const toFetchFocusKey = (root: string) => `ccode.toFetchFocus:${root}`;
const toFetchScrollKey = (root: string) => `ccode.toFetchScroll:${root}`;
function readToFetchFocus(root: string): number | null {
  try {
    const n = Number(sessionStorage.getItem(toFetchFocusKey(root)));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
function writeToFetchFocus(root: string, line: number | null): void {
  try {
    if (line == null) sessionStorage.removeItem(toFetchFocusKey(root));
    else sessionStorage.setItem(toFetchFocusKey(root), String(line));
  } catch {
    /* 隐私模式写不进就只靠本次 */
  }
}
function readToFetchScroll(root: string): number | null {
  try {
    const n = Number(sessionStorage.getItem(toFetchScrollKey(root)));
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
function writeToFetchScroll(root: string, top: number): void {
  try {
    sessionStorage.setItem(toFetchScrollKey(root), String(Math.round(top)));
  } catch {
    /* 隐私模式写不进就只靠本次 */
  }
}
const toFetchPageScrollKey = (root: string) => `ccode.toFetchPageScroll:${root}`;
function readToFetchPageScroll(root: string): number | null {
  try {
    const n = Number(sessionStorage.getItem(toFetchPageScrollKey(root)));
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
function writeToFetchPageScroll(root: string, top: number): void {
  try {
    sessionStorage.setItem(toFetchPageScrollKey(root), String(Math.round(top)));
  } catch {
    /* 隐私模式写不进就只靠本次 */
  }
}
function PublisherOpenButton({
  url,
  title,
  projectPath,
  onOpened,
  onError,
}: {
  url: string;
  title: string;
  projectPath: string;
  onOpened: () => void;
  onError: (message: string) => void;
}) {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setWaiting(false), 95000);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  return (
    <>
      <button
        type="button"
        className={`${inlineActionClass} shrink-0`}
        title="去出版商官网打开这篇；点站方下载，90 秒内落下的 PDF 会收进 papers/。没收到用「关联」"
        onClick={() => {
          onError("");
          void invoke("inst_browser_open", {
            url: instOpenTarget(url),
            projectRoot: projectPath,
            title,
            doi: url,
          })
            .then(() => {
              onOpened();
              setWaiting(true);
            })
            .catch((e) => {
              onError(`打开浏览器失败：${String(e)}`);
            });
        }}
      >
        {waiting ? "等待收货…" : "官网"}
      </button>
      {waiting && (
        <button
          type="button"
          className={`${ghostActionClass} shrink-0`}
          title="这篇不下载了。收货等待取消，之后的 PDF 不会挂到这一行。"
          onClick={() => {
            setWaiting(false);
            void invoke("inst_browser_cancel", {
              projectRoot: projectPath,
              title,
              doi: url,
            }).catch(() => {});
          }}
        >
          取消
        </button>
      )}
    </>
  );
}

function JournalPills({ metric }: { metric: JournalMetricsDto | null | undefined }) {
  if (!metric) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {metric.impactFactor && (
        <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("if")}`}>
          IF {metric.impactFactor}
        </span>
      )}
      {metric.casQuartile != null && (
        <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("quartile", metric.casQuartile)}`}>
          {metric.casQuartile}区
        </span>
      )}
      {metric.top && (
        <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("top")}`}>TOP</span>
      )}
    </span>
  );
}

function rememberToFetchPlace(root: string, ul: HTMLUListElement | null): void {
  if (!ul) return;
  writeToFetchScroll(root, ul.scrollTop);
  const pane = ul.closest("[data-project-main-scroll]");
  if (pane instanceof HTMLElement) writeToFetchPageScroll(root, pane.scrollTop);
}

/** 精读步「AI 干活」行下的进度（notes/index.json，工作区优先、项目根兜底）。
 *  Agent 分批写、中途提交后接着读：跑着时 20 秒重读一次，窗口回到前台也重读。 */
function NotesProgressLine({ roots, live }: { roots: string[]; live: boolean }) {
  const [line, setLine] = useState<string | null>(null);
  const rootsKey = roots.join("\n");
  useEffect(() => {
    let stale = false;
    const load = async () => {
      for (const root of rootsKey.split("\n")) {
        try {
          const file = await readResearchLedger(root, "notes/index.json");
          if (file.truncated) continue;
          // 评审里排除的篇不算进度（旧索引可能给它们建过行）；读不到纳入清单就不扣
          const excluded = await readResearchLedger(root, "papers/included.json")
            .then((f) => (f.truncated ? new Set<string>() : excludedIncludedIds(f.text)))
            .catch(() => new Set<string>());
          const progress = notesProgress(file.text, excluded);
          if (!stale) setLine(progress ? notesProgressLine(progress) : null);
          return;
        } catch {
          /* 这一处还没有索引，试下一处 */
        }
      }
      if (!stale) setLine(null);
    };
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const timer = live ? window.setInterval(() => void load(), 20000) : null;
    return () => {
      stale = true;
      window.removeEventListener("focus", onFocus);
      if (timer != null) window.clearInterval(timer);
    };
  }, [rootsKey, live]);
  if (!line) return null;
  return (
    <p
      className="mt-1 pl-9 text-micro tabular-nums text-l4"
      title="按 notes/index.json 数：标成已读完的才算写完；仅摘要的篇目补到全文后再精读"
    >
      {line}
    </p>
  );
}

/** 「抽查 3 篇笔记」就地给出三篇候选（notes/index.json，工作区优先、项目根兜底）：
 *  点一篇在运行页预览打开——保存进项目前笔记还只在工作区里，文件页看不到。 */
function SpotCheckPicks({ roots }: { roots: string[] }) {
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const setPage = useAppStore((s) => s.setPage);
  const [picks, setPicks] = useState<{ root: string; items: SpotCheckPick[] } | null>(null);
  const rootsKey = roots.join("\n");
  useEffect(() => {
    let stale = false;
    void (async () => {
      for (const root of rootsKey.split("\n")) {
        try {
          const file = await readResearchLedger(root, "notes/index.json");
          if (file.truncated) continue;
          const items = spotCheckPicks(file.text);
          if (!stale) setPicks(items.length > 0 ? { root, items } : null);
          return;
        } catch {
          /* 这一处还没有索引，试下一处 */
        }
      }
      if (!stale) setPicks(null);
    })();
    return () => {
      stale = true;
    };
  }, [rootsKey]);
  if (!picks) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-micro text-l4">抽这几篇：</span>
      {picks.items.map((pick) => {
        const rel = pick.notePath.replace(/\\/g, "/");
        const abs = /^(?:[A-Za-z]:)?\//.test(rel)
          ? rel
          : `${picks.root.replace(/[\\/]+$/, "")}/${rel.replace(/^\.?\//, "")}`;
        const name = rel.split("/").pop() ?? rel;
        return (
          <button
            key={pick.notePath}
            type="button"
            className="inline-flex max-w-[16rem] items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1"
            title={`在运行页预览 ${rel}`}
            onClick={() => {
              setPreviewReq({ path: abs, name, root: picks.root });
              setPage("terminal");
            }}
          >
            <span className="min-w-0 truncate underline decoration-dotted underline-offset-2">{name}</span>
            <span className="shrink-0 text-micro text-l4">{pick.fulltext ? "全文" : "仅摘要"}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 按钮没说的那一句：可选/跳过的后果。做法进行内按钮 title。 */
const PAYWALL_HINT = "跳过的篇目下一篇按摘要记。";
const PENDING_HINT = "待确认点纳入或排除。已纳入不想要就点移出，笔记和引文留着。";

const LIT_SOURCES: {
  id: string;
  label: string;
  hint: string;
  /** 选完之后要做的事（链接文案）；null = 不需要准备什么 */
  action: string | null;
  /** 落点聚焦：到「文献与数据」后高亮哪个入口 */
  focus?: "zotero" | "files";
}[] = [
  {
    id: "search",
    label: "让 agent 检索",
    hint: "不用准备，开工即检索。",
    action: "去补几篇 →",
    focus: "files",
  },
  {
    id: "zotero",
    label: "我有 Zotero 库",
    hint: "读你的 Zotero 库；文献留在原处不搬走。",
    action: "去导入 Zotero 库 →",
    focus: "zotero",
  },
  {
    id: "endnote",
    label: "我有 EndNote 库",
    hint: "把 EndNote 导出的 XML 或 RIS 放进项目，开工时解析。不读 .enl。",
    action: "去放入 EndNote 题录 →",
    focus: "files",
  },
  {
    id: "folder",
    label: "我已有 PDF / 题录",
    hint: "PDF 或 RIS/XML 放进项目，开工时写成题录。不必安装 Zotero 或 EndNote。",
    action: "去放入题录 / PDF →",
    focus: "files",
  },
];

function guidancePreview(text: string): string {
  const full = text.trim();
  const firstParagraph = full.split(/\n\s*\n/)[0]?.trim() ?? full;
  if (firstParagraph.length <= 120) return firstParagraph;
  const sentence = firstParagraph.match(/^.*?[。！？!?]/)?.[0]?.trim();
  return sentence && sentence.length <= 120
    ? sentence
    : `${firstParagraph.slice(0, 117).trimEnd()}…`;
}

export default function StepFlow({
  projectPath,
  step,
  runStatus,
  hasDraft,
  ws,
  onSeed,
  openSeeds,
  onStart,
  onReadPaper,
  readPaperPrimary = false,
  onChanged,
  draft,
  agentContent,
  onRestore,
  reviewConflict,
  onDraftChanged,
  onSeedDraft,
  draftLoadError,
  onLoadTaskMd,
  discussed = false,
  discussResume = null,
  discussContent,
  litSource,
  openSettings,
  onOpenResources,
  onSetLitSource,
  litBusy = false,
  tools,
  toolAskFields = [],
  onSetResearchTool,
  toolBusy = false,
  bare = false,
  agentAttention = null,
  runId = null,
  projectLaunch = null,
  stepSlotLaunch = null,
  onContinueStep,
}: {
  projectPath: string;
  step: ProjectStepDto;
  runStatus: StepRunStatus;
  /** 本步骤任务书草稿已起草（discuss 节点完成口径） */
  hasDraft: boolean;
  /** 本步骤绑定的活跃工作区（无 = 未开始） */
  ws: WorkspaceDto | undefined;
  /** 讨论种子点击（由卡片区已有逻辑承载：建卡 + 聊想法） */
  onSeed: (seed: string) => void;
  /** 还没开聊过的预置话题 chips（开过的已在话题清单里，不再重复出 chip） */
  openSeeds?: string[];
  /** agent 节点「开始」= 打开开工确认弹层 */
  onStart: () => void;
  /** 仅示例课题精读步：主按钮「开读这一篇」进沉浸阅读，开始仍在旁边。
   *  父级必须用 demoReadPaperResource 门控，普通模板不得传入。 */
  onReadPaper?: () => void;
  readPaperPrimary?: boolean;
  /** 人工事项勾选/交付后通知父级（流程线橙点等外部计数重取） */
  onChanged?: () => void;
  /** 任务书草稿（v3.72）：relPath 恒有（后端单一出处），exists = 草稿已起草，
   *  text = 草稿正文（决策项答案就存在它的「已定方向」小节里，用来回填选中态） */
  draft?: { relPath: string; exists: boolean; text?: string | null };
  /** 决策项落盘后通知父级重读草稿（与「◈ 沉淀进任务书」同一回调） */
  onDraftChanged?: () => void;
  /** 「跟 AI 商量一下」开聊前的播种（v3.90）：空内容先灌模板拼装，由卡片区实现（它有 cfg 与拼装出处） */
  onSeedDraft?: () => Promise<void>;
  /** 任务书读失败的原因。按钮变灰时把这句话显示在旁边。 */
  draftLoadError?: string | null;
  /** 「预览/编辑 TASK.md」的统一加载（v3.90）：返回展示内容——已有编辑内容读文件全文，
   *  否则给模板拼装（只读展示不落盘，保存才落地）。由卡片区实现（它有 cfg 与拼装出处） */
  onLoadTaskMd?: () => Promise<{ text: string; revision: string | null }>;
  /** 本步已经开过「跟 AI 商量」会话：按钮改「继续讨论」，不另占一格 */
  discussed?: boolean;
  /** 继续讨论要接回的上次会话；没有就仍开新会话，按钮也不叫继续 */
  discussResume?: {
    agentId: string;
    sessionId: string;
    provider?: string | null;
    cwd?: string | null;
  } | null;
  /** discuss 节点内嵌内容（想法区）：讨论的事全归这个节点，不在流程线外另立并列区块 */
  discussContent?: React.ReactNode;
  /** 项目的文献来源（project.toml lit_source）：zotero/folder 时，落点在 papers/ 的人工事项
   *  不该再劝人往 papers/ 里塞 PDF——那会造出第二个文献存放处，与已有库各自漂移 */
  litSource?: string;
  /** 项目规则里还没填实的全局设定（「综述角度：（…）」）。商量开场要逐项问。 */
  openSettings?: string[];
  /** 展开项目的「文献与数据」面板：文献类交付统一引到那里，不在每个事项行复制入口。
   *  focus = 落地后高亮哪个进料入口（按所选文献来源给） */
  onOpenResources?: (focus?: "zotero" | "files") => void;
  /** 输入准备（v3.86，仅 step.asksLitSource 为真的步骤渲染）：文献来源选择 + 就地导入。
   *  与决策项分属两类——决策项写草稿、纯记录；这里写 config.lit_source 且带动作 */
  onSetLitSource?: (value: string) => void | Promise<void>;
  litBusy?: boolean;
  tools?: ResearchTools;
  toolAskFields?: readonly ResearchToolField[];
  onSetResearchTool?: (key: ResearchToolField["key"], value: string) => void | Promise<void>;
  toolBusy?: boolean;
  /** 嵌在「当前步骤卡」里时去掉自带的底色与内边距，由外层卡片统一承载（v3.85 三段式） */
  bare?: boolean;
  /** agent 节点内嵌内容（如「预览 TASK.md」——TASK.md 是 agent 的合同，属于这个节点） */
  agentContent?: React.ReactNode;
  /** 步骤工作区已归档时 agent 节点的主入口（替代「开始」）：恢复工作区 */
  onRestore?: () => void;
  /** 合并冲突阻塞：评审节点入口改为「去处理冲突」（直达冲突解决意图） */
  reviewConflict?: boolean;
  /** 本步骤工作区内终端的注意力（ProjectGroup stepAttention 同一口径）：
   *  working/confirm = 正在出字或等确认，藏「去评审」；
   *  done = 跑完在等你——active 态的「去终端看看」旁给出完成提示 */
  agentAttention?: "confirm" | "done" | "working" | null;
  /** Explicit Run identity for the review handoff. */
  runId?: string | null;
  /** 项目 Agents 名册解析出的启动；有则「跟 AI 商量一下」直接用它拉起。
   *  商量类入口（任务书讨论/MCP 登录）刻意不吃步骤专属绑定（2026-10-15 用户拍板）：
   *  讨论质量取决于通用对话能力、与步骤任务类型无关，全项目保持一致的商量体验；
   *  步骤绑定只管执行面（开工弹层/继续/去终端）。 */
  projectLaunch?: { agentId: string; profileId: string; model: string } | null;
  /** 仅 step: 槽命中（不含 discuss/项目默认回落）。去终端看看用来决定要不要接回旧会话。 */
  stepSlotLaunch?: { agentId: string; profileId: string; model: string } | null;
  /** 工作区已开时：新会话，用步骤绑定接着做到完成标准。不接回旧 Agent。 */
  onContinueStep?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    states,
    error,
    note,
    busyTitle,
    dropHover,
    toggle,
    checkPendingConfirmIfOpen,
    checkAcademicMcpIfReady,
    pickFile,
    registerOffer,
    registerOffered,
    dismissRegisterOffer,
  } = useHumanTasks({ projectPath, stepName: step.name, containerRef, onChanged });
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const setPage = useAppStore((s) => s.setPage);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const setPendingMcpPreset = useAppStore((s) => s.setPendingMcpPreset);
  const setFilePreviewReq = useAppStore((s) => s.setFilePreviewReq);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const setSettingsSectionReq = useAppStore((s) => s.setSettingsSectionReq);

  /** 已经有文献库的项目：落点在 papers/ 的事项不该再劝人把 PDF 往项目里塞——
   *  文献的唯一出处是那个库，往 papers/ 另放一份之后两边各自漂移。
   *  只影响文案与按钮，不改事项本身的完成口径（落点检测照旧）。
   *  这个判断随动作一起在 step-node-actions.ts 里算（descriptor 带 hasLibrary），
   *  这里不再留第二份。 */
  /** after 档事项的就绪口径与压暗口径**同一出处**（见 step-node-actions.ts）：
   *  分叉就会出现「压暗的行里躺着可点的按钮」 */
  const afterReady = (h: { expectedCount?: number }) =>
    stepNodeReady(runStatus, agentAttention, h);

  // ===== 决策项（可枚举的拍板点）：点一下就答完，不开会话 =====
  // 答案存在草稿的「已定方向」小节里（草稿是开工合同，不另立一份状态），选中态由它回填
  const decisions = step.decisions ?? [];
  const answered = parseDecisions(draft?.text ?? "");
  /** 已有编辑内容（v3.90：UI 不再暴露「草稿」概念）= 文件有可执行正文；
      仅含已定方向 / 评审沉淀 / 标题的不算——那不是编辑过的 TASK.md */
  const draftHasBody =
    !!draft?.text?.trim() && !isTaskMdStub(draft.text ?? "");
  const taskMdBtnClass = `shrink-0 rounded-sm px-1 py-0.5 text-micro disabled:opacity-50 ${
    draftHasBody
      ? "text-cta-pill-text hover:bg-hover"
      : "text-l4 hover:bg-hover hover:text-l2"
  }`;
  const pendingDecisions = unansweredDecisions(decisions, answered);
  const decisionGaps = decisionGate(step, draft?.text ?? "").missing;
  const skillProvides = useSkillProvides();
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  // 「自己写」行内输入：选项不合适时多半只是想填一句自己的答案，
  // 为这个开终端太贵——真要展开讨论才走「开聊」
  // 决策区默认收起；hard_pause 的未答项由开工弹层明确拦截。
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  // 方式二折叠态（v3.90）：与方式一同款——默认收起一行，展开才露「跟 AI 商量一下」
  const [chatOpen, setChatOpen] = useState(false);
  const [writeOwn, setWriteOwn] = useState<{
    q: string;
    text: string;
    status: DecisionStatus | "";
  } | null>(null);
  // 草稿弹层的呈现方式：编辑（textarea，主用途）/ 预览（渲染 markdown，长草稿好读）
  const [draftPreview, setDraftPreview] = useState(false);

  /** 落盘一批答案：读-改-写整份草稿（write_task_draft 是整份覆盖），
   *  批量入参让「全部用推荐值」只写一次，也少一次与 agent 并发改草稿的窗口 */
  async function commitDecisions(answers: { q: string; answer: string }[]) {
    if (answers.length === 0 || decisionBusy) return;
    setDecisionBusy(true);
    setDecisionError(null);
    try {
      // 以磁盘上的最新草稿为基（agent 可能刚改过），不拿组件里可能过期的那份
      const cur = await invoke<{ relPath: string; text: string | null; revision: string | null }>(
        "read_task_draft",
        { projectRoot: projectPath, stepName: step.name },
      );
      await invoke("write_task_draft", {
        projectRoot: projectPath,
        stepName: step.name,
        content: upsertDecisions(cur?.text ?? "", answers),
        expectedRevision: cur?.revision ?? null,
      });
      onDraftChanged?.();
    } catch (reason) {
      setDecisionError(String(reason));
    } finally {
      setDecisionBusy(false);
    }
  }

  /** 聊任务书（v3.72）：讨论直接服务于 TASK.md 内容文件——非只读启动（agent 要写文件），
   *  指令约束只许新建/修改这一个文件；不用卡片的只读保护（那是不动文件口径）。
   *  直接进终端并自动启动，不打开右栏预览（看任务书用流程线弹层）。
   *  v3.90 起先播种（onSeedDraft）：空文件/仅决策答案/仅评审沉淀的文件先灌入模板拼装——
   *  商量改的就是最终落盘的 TASK.md，从零起草会把简报/预期产物/提货单全丢掉 */
  const [chatBusy, setChatBusy] = useState(false);
  const [decisionNote, setDecisionNote] = useState<string | null>(null);
  const [decisionOpen, setDecisionOpen] = useState<Map<string, number>>(new Map());
  const [citeOpen, setCiteOpen] = useState<string | null>(null);
  const [citeBusy, setCiteBusy] = useState(false);
  const [citeNote, setCiteNote] = useState<string | null>(null);

  const [journals, setJournals] = useState<{ name: string; count: number }[] | null>(null);
  const [journalName, setJournalName] = useState("");
  const [draftJournal, setDraftJournal] = useState<string | null>(null);
  const [journalSwap, setJournalSwap] = useState(false);
  // 点选时记下「要哪一类样式」和「改前的样式」，用户回来时据此核对是否真换成。
  const citeWant = useRef<{ family: StyleFamily | null; label: string } | null>(null);
  const citeBefore = useRef<StyleFamily | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  // 付费墙任务的待获取清单就地展开（papers/to-fetch.md，只读预览）：
  // 首次点开才读文件，收起不清缓存（agent 不会在展示期间改它）。
  // 位置口径：agent 的产出落在步骤工作区，评审合并后才进项目根——先读工作区再回落项目根
  const [pendingListOpen, setPendingListOpen] = useState(true);
  const pendingListRef = useRef<PendingConfirmHandle>(null);
  const [pendingMeta, setPendingMeta] = useState({ count: 0, busy: false });
  const [academicMcp, setAcademicMcp] = useState<AcademicMcpLogin | null>(null);
  const [paywallListOpen, setPaywallListOpen] = useState(() =>
    readPaywallListOpen(projectPath),
  );
  const [paywallMetrics, setPaywallMetrics] = useState<Map<number, JournalMetricsDto | null>>(new Map());
  const [paywallMetricsLoading, setPaywallMetricsLoading] = useState(false);
  const [paywallList, setPaywallList] = useState<{
    text: string | null;
    error: string | null;
    from: string | null;
  }>({ text: null, error: null, from: null });
  const [zoteroSyncing, setZoteroSyncing] = useState(false);
  const [zoteroSyncResult, setZoteroSyncResult] = useState<{
    line: string;
    detail?: string;
  } | null>(null);
  const [endnoteSyncing, setEndnoteSyncing] = useState(false);
  const [endnoteSyncResult, setEndnoteSyncResult] = useState<string | null>(null);
  const [endnoteChecked, setEndnoteChecked] = useState(false);
  const [continueNotesChecked, setContinueNotesChecked] = useState(false);
  const [toFetchBusy, setToFetchBusy] = useState<
    Record<number, { status: "busy" | "ok" | "error"; note?: string }>
  >({});
  const toFetchItems = useMemo(
    () => (paywallList.text ? parseToFetchItems(paywallList.text) : []),
    [paywallList.text],
  );
  // 清单逐篇「已存 papers」状态（to_fetch_progress 对照 papers/ 现算）：
  // 「哪些下载了」不再靠人记；机构窗口入库（inst-pdf-relayed）后自动翻新
  const [toFetchDone, setToFetchDone] = useState<Record<number, string>>(() =>
    recalledToFetchDone(projectPath),
  );
  const paywallSavedCount = useMemo(
    () => toFetchSavedCount(toFetchItems, toFetchDone),
    [toFetchItems, toFetchDone],
  );
  const toFetchProbeRef = useRef<{ text: string | null; items: typeof toFetchItems }>({
    text: null,
    items: [],
  });
  toFetchProbeRef.current = { text: paywallList.text, items: toFetchItems };
  // 「浏览器打开」进行中状态（2026-09-17 审计：旧口径点了之后按钮毫无变化，
  // 90 秒窗从注册到过期全程零可见性，漏收也无从察觉）：打开后 95 秒内按钮显示
  // 等待收货文案，到期回落；配套独立错误位（旧口径把报错写进 Zotero 结果槽，
  // 渲染在滚动区最底部、语义也错位）
  const [browserOpenErr, setBrowserOpenErr] = useState<string | null>(null);
  const [instLoggedIn, setInstLoggedIn] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const paywallDropRef = useRef<HTMLDivElement>(null);
  // 点「浏览器」或已存标题后离开，回来要立刻找到刚才那行：主题强调色框，
  // 点下一篇才换/消失（不按时间收）。行号进 sessionStorage——切文件页会卸任务页。
  const [browserSpotlight, setBrowserSpotlight] = useState<number | null>(() =>
    readToFetchFocus(projectPath),
  );
  const browserSpotlightAway = useRef(false);
  const toFetchListRef = useRef<HTMLUListElement>(null);
  const stepHasAcademicMcp = (step.humanTasks ?? []).some((task) =>
    isAcademicMcpTaskTitle(task.title),
  );
  useEffect(() => {
    if (!stepHasAcademicMcp) return;
    let stale = false;
    void invoke<AcademicMcpLogin>("academic_mcp_login_status")
      .then((status) => {
        if (stale) return;
        setAcademicMcp(status);
        if (!status.ready) return;
        const title = (step.humanTasks ?? []).find((task) =>
          isAcademicMcpTaskTitle(task.title),
        )?.title;
        if (title) void checkAcademicMcpIfReady(title);
      })
      .catch(() => {
        if (!stale) setAcademicMcp(null);
      });
    return () => {
      stale = true;
    };
    // 步骤卡挂上时查一次。登录发生在终端或 MCP 页，回到本页会重新挂载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, step.name, stepHasAcademicMcp]);
  function focusToFetchLine(line: number) {
    browserSpotlightAway.current = false;
    setBrowserSpotlight(line);
    writeToFetchFocus(projectPath, line);
    rememberToFetchPlace(projectPath, toFetchListRef.current);
  }
  useLayoutEffect(() => {
    return () => rememberToFetchPlace(projectPath, toFetchListRef.current);
  }, [projectPath]);
  useEffect(() => {
    if (browserSpotlight == null) return;
    const onHide = () => {
      browserSpotlightAway.current = true;
    };
    const onBack = () => {
      if (!browserSpotlightAway.current) return;
      browserSpotlightAway.current = false;
      const el = document.querySelector(
        `[data-to-fetch-line="${browserSpotlight}"]`,
      );
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") onHide();
      else onBack();
    };
    window.addEventListener("blur", onHide);
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", onHide);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [browserSpotlight]);
  // 切文件页再回来：清单重挂后只还原记下的滚动，不 scrollIntoView（会把整页拽到边上）。
  useLayoutEffect(() => {
    if (!paywallListOpen || toFetchItems.length === 0) return;
    const ul = toFetchListRef.current;
    if (!ul) return;
    const top = readToFetchScroll(projectPath);
    if (top != null) ul.scrollTop = top;
    const pane = ul.closest("[data-project-main-scroll]");
    const page = readToFetchPageScroll(projectPath);
    if (pane instanceof HTMLElement && page != null) pane.scrollTop = page;
  }, [paywallListOpen, paywallList.text, toFetchItems.length, projectPath]);
  // 面板收起即清旧错误（终检二轮：错误位只靠再点一次清除，重开面板仍挂旧红字）
  useEffect(() => {
    if (!paywallListOpen) setBrowserOpenErr(null);
  }, [paywallListOpen]);
  const refreshToFetchProgress = () => {
    const { text, items } = toFetchProbeRef.current;
    if (!text || !items.length) return;
    invoke<(string | null)[]>("to_fetch_progress", {
      projectRoot: projectPath,
      items: items.map((it) => ({ title: it.title, url: it.url })),
    })
      .then((names) => {
        const map: Record<number, string> = {};
        names?.forEach((n, i) => {
          const it = items[i];
          if (n && it) map[it.line] = n;
        });
        rememberToFetchDone(projectPath, map);
        setToFetchDone(map);
      })
      .catch(() => {});
  };
  useEffect(() => {
    if (paywallListOpen && paywallList.text) refreshToFetchProgress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paywallListOpen, paywallList.text]);
  // 恢复展开（从持久化读回的 true）：清单内容也要加载回来
  useEffect(() => {
    if (paywallListOpen && paywallList.text == null && !paywallList.error) {
      void loadPaywallList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // 扩展「存到 Mesa」经独立 helper 进程落盘——主程序回执监听广播
    // inst-papers-changed（带 projectRoot），这里就地重拉进度，清单实时翻「已存」
    const internals = (globalThis as { __TAURI_INTERNALS__?: { transformCallback?: unknown } })
      .__TAURI_INTERNALS__;
    if (!projectPath || !internals?.transformCallback) return;
    let un: (() => void) | undefined;
    void listen<{
      projectRoot?: string;
      title?: string;
      doi?: string;
      saved?: string;
    }>("inst-papers-changed", (e) => {
      if (!e.payload?.projectRoot || e.payload.projectRoot !== projectPath) return;
      const title = (e.payload.title ?? "").trim();
      const doi = (e.payload.doi ?? "").trim().toLowerCase();
      const saved = (e.payload.saved ?? "").trim();
      if (saved && (title || doi)) {
        const { items } = toFetchProbeRef.current;
        const add: Record<number, string> = {};
        for (const it of items) {
          const want = it.title.replace(/[^0-9a-z\u4e00-\u9fff]/gi, "").toLowerCase();
          const have = title.replace(/[^0-9a-z\u4e00-\u9fff]/gi, "").toLowerCase();
          const short = Math.min(want.length, have.length);
          const titleHit =
            short >= 8 && (want.includes(have) || have.includes(want));
          const url = (it.url ?? "").toLowerCase();
          const doiHit = doi.length >= 8 && url.includes(doi);
          if (titleHit || doiHit) add[it.line] = saved.endsWith(".pdf") ? saved : `${saved}.pdf`;
        }
        if (Object.keys(add).length) {
          setToFetchDone((cur) => {
            const next = { ...cur, ...add };
            rememberToFetchDone(projectPath, next);
            return next;
          });
        }
      }
      refreshToFetchProgress();
    })
      .then((u) => {
        un = u;
      })
      .catch(() => {});
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);
  useEffect(() => {
    // 扩展「存到 Mesa」经独立 helper 进程落盘，不发任何 Tauri 事件——清单
    // 承诺「实时标出已存」却只有面板开合/事件两个刷新点，用扩展存的篇目要
    // 收起再展开才亮（2026-09-17 审计）。面板开着时低频轮询补上
    if (!paywallListOpen) return;
    const t = window.setInterval(() => refreshToFetchProgress(), 2000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paywallListOpen]);
  useEffect(() => {
    // 组件测试环境没有 Tauri 事件通道（__TAURI_INTERNALS__.transformCallback），
    // 订阅直接跳过——进度刷新仍有面板开合与获取完成的触发点兜底
    const internals = (globalThis as { __TAURI_INTERNALS__?: { transformCallback?: unknown } })
      .__TAURI_INTERNALS__;
    if (!projectPath || !internals?.transformCallback) return;
    let un: (() => void) | undefined;
    void listen<{ projectRoot?: string }>("inst-pdf-relayed", (e) => {
      const root = e.payload?.projectRoot;
      if (!root || root !== projectPath) return;
      // App 层 save 在事件后 ~1s 完成，晚一点再查进度
      window.setTimeout(() => refreshToFetchProgress(), 2500);
    })
      .then((u) => {
        un = u;
      })
      .catch(() => {});
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);
  /** 按 references.bib 重写 to-fetch.ris，再交给 Zotero。不依赖待获取清单是否已展开。 */
  async function syncToZotero() {
    setZoteroSyncing(true);
    setZoteroSyncResult({ line: "正在按引文库生成…" });
    try {
      const line = await invoke<string>("zotero_open_import", {
        path: `${projectPath.replace(/[\\/]+$/, "")}/papers/to-fetch.ris`,
        root: projectPath,
      });
      setZoteroSyncResult({ line });
    } catch (e) {
      const line = String(e);
      setZoteroSyncResult({ line, detail: line });
    } finally {
      setZoteroSyncing(false);
    }
  }
  async function openPapersDir() {
    try {
      await invoke("zotero_open_papers", { projectRoot: projectPath });
    } catch (e) {
      setZoteroSyncResult({ line: String(e), detail: String(e) });
    }
  }

  async function openEndnoteImport() {
    if (endnoteSyncing) return;
    setEndnoteSyncing(true);
    const note = "正在交给 EndNote…";
    setEndnoteSyncResult(note);
    try {
      const msg = await invoke<string>("endnote_export_xml", {
        projectRoot: projectPath,
      });
      setEndnoteSyncResult(msg);
    } catch (e) {
      setEndnoteSyncResult(String(e));
    } finally {
      setEndnoteSyncing(false);
    }
  }

  function openContinueNotes() {
    if (runStatus !== "done") return;
    const notesDir = `${projectPath.replace(/[\\/]+$/, "")}/notes`;
    setSelectProjectReq(projectPath);
    setFilePreviewReq({
      projectRoot: projectPath,
      path: notesDir,
      token: Date.now(),
    });
    setPage("workspaces");
  }

  /** 手动关联本地 PDF（2026-09-17）：浏览器手动下载的文件名常是 main(1).pdf 这类
   *  通用名，靠文件名永远对不上清单条目——显式选文件 + 按本行标题登记，行立即亮
   *  「已存 papers/」（拷贝进 papers/，不动源文件） */
  useEffect(() => {
    if (!paywallListOpen) return;
    let stale = false;
    void invoke<InstSessionStatus>("inst_session_status")
      .then((status) => {
        if (!stale) setInstLoggedIn(instActiveFrom(status));
      })
      .catch(() => {
        if (!stale) setInstLoggedIn(false);
      });
    return () => {
      stale = true;
    };
  }, [paywallListOpen]);

  useEffect(() => {
    if (!paywallListOpen || !projectPath) return;
    function overList(x: number, y: number): boolean {
      const scale = window.devicePixelRatio || 1;
      const box = paywallDropRef.current;
      if (!box) return false;
      for (const [cx, cy] of [
        [x, y],
        [x / scale, y / scale],
      ]) {
        const rect = box.getBoundingClientRect();
        if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) return true;
      }
      return false;
    }
    const unlisten = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        if (overList(event.payload.position.x, event.payload.position.y)) setDropNote("松开后按标题对上条目");
        else setDropNote(null);
      } else if (event.payload.type === "drop") {
        const here = overList(event.payload.position.x, event.payload.position.y);
        setDropNote(null);
        const path = event.payload.paths.find((item) => item.toLowerCase().endsWith(".pdf"));
        if (here && path) void matchDroppedPdf(path);
      } else {
        setDropNote(null);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
    // paywallList.text 在匹配时读取，拖放监听只跟清单是否展开走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paywallListOpen, projectPath]);

  async function matchDroppedPdf(path: string) {
    const items = parseToFetchItems(paywallList.text ?? "").filter((item) => !item.done);
    if (items.length === 0) {
      setDropNote("待获取清单是空的");
      return;
    }
    setDropNote("正在按 PDF 标题对条目…");
    try {
      const res = await invoke<FetchedFulltextDto>("match_dropped_paper", {
        projectRoot: projectPath,
        sourcePath: path,
        items: items.map((item) => ({ title: item.title, url: item.url })),
      });
      setDropNote(`已对上并保存：${res.name}`);
      refreshToFetchProgress();
    } catch (e) {
      setDropNote(String(e));
    }
  }

  async function attachToFetchItem(item: ToFetchItem) {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected || typeof selected !== "string") return;
    setToFetchBusy((cur) => ({ ...cur, [item.line]: { status: "busy" } }));
    try {
      const res = await invoke<FetchedFulltextDto>("attach_paper_pdf", {
        projectRoot: projectPath,
        sourcePath: selected,
        title: item.title,
      });
      setToFetchBusy((cur) => ({
        ...cur,
        [item.line]: { status: "ok", note: `已关联：${res.name}` },
      }));
      refreshToFetchProgress();
    } catch (e) {
      setToFetchBusy((cur) => ({
        ...cur,
        [item.line]: { status: "error", note: String(e) },
      }));
    }
  }
  async function togglePaywallList() {
    const next = !paywallListOpen;
    setPaywallListOpen(next);
    writePaywallListOpen(projectPath, next);
    if (!next || paywallList.text != null || paywallList.error) return;
    await loadPaywallList();
  }
  /** 读 to-fetch.md（步骤工作区优先回落项目根）；恢复展开的挂载路径也走这里 */
  async function loadPaywallList() {
    const candidates = ws
      ? [
          {
            path: `${ws.worktreePath}/papers/to-fetch.md`,
            root: ws.worktreePath,
            from: "步骤工作区",
          },
          {
            path: `${projectPath}/papers/to-fetch.md`,
            root: projectPath,
            from: "项目根",
          },
        ]
      : [
          {
            path: `${projectPath}/papers/to-fetch.md`,
            root: projectPath,
            from: "项目根",
          },
        ];
    for (const c of candidates) {
      try {
        const p = await invoke<{ text: string }>("read_research_ledger", {
          path: c.path,
          root: c.root,
        });
        setPaywallList({ text: p.text, error: null, from: c.from });
        void loadPaywallMetrics(p.text);
        return;
      } catch {
        // 试下一个位置
      }
    }
    setPaywallList({
      text: null,
      error:
        "还没找到 papers/to-fetch.md——agent 筛完会在步骤工作区生成缺全文清单（评审合并后进项目根）",
      from: null,
    });
  }

  async function loadPaywallMetrics(text: string) {
    const items = parseToFetchItems(text).filter((item) => item.venue || item.url);
    if (items.length === 0) {
      setPaywallMetrics(new Map());
      return;
    }
    const needsRemote = items.some((item) => !item.venue && item.url);
    if (needsRemote) setPaywallMetricsLoading(true);
    try {
      const status = await invoke<JournalMetricsStatusDto>("journal_metrics_status");
      if (!status.available) {
        setPaywallMetrics(new Map());
        return;
      }
      const queries = items.map((item) => ({
        venue: item.venue,
        issn: "",
        doi: item.url,
      }));
      const next = new Map<number, JournalMetricsDto | null>();
      const pending: { line: number; query: (typeof queries)[number] }[] = [];
      items.forEach((item, index) => {
        const hit = cachedJournalMetric(queries[index]?.doi ?? "");
        if (hit !== undefined) next.set(item.line, hit);
        else pending.push({ line: item.line, query: queries[index]! });
      });
      if (pending.length > 0) {
        const found = await invoke<(JournalMetricsDto | null)[]>("lookup_journal_metrics", {
          queries: pending.map((row) => row.query),
        });
        rememberJournalMetrics(pending.map((row) => row.query), found);
        pending.forEach((row, index) => next.set(row.line, found[index] ?? null));
      }
      setPaywallMetrics(next);
    } catch {
      setPaywallMetrics(new Map());
    } finally {
      setPaywallMetricsLoading(false);
    }
  }
  // 换步骤就清掉上一步读到的期刊：按需读，不在每步无条件打 IPC。
  useEffect(() => {
    setDraftJournal(null);
    setJournalSwap(false);
  }, [step.name, projectPath]);

  /** 打开「按期刊」时才读已定期刊：先看工作区，再看项目根（上一步合并前只有工作区里有）。 */
  async function loadTargetJournal() {
    const candidates = [
      ...(ws ? [{ path: `${ws.worktreePath}/submission/target-journal.md`, root: ws.worktreePath }] : []),
      { path: `${projectPath}/submission/target-journal.md`, root: projectPath },
    ];
    for (const c of candidates) {
      try {
        const file = await invoke<{ text: string }>("read_file_preview", {
          path: c.path,
          root: c.root,
        });
        setDraftJournal(parseTargetJournal(file.text));
        return;
      } catch {
        // 试下一个位置
      }
    }
    setDraftJournal(null);
  }

  async function recordTargetJournal(name: string, source: "沿用已定" | "本次选定") {
    if (!ws) return;
    const path = `${ws.worktreePath}/submission/target-journal.md`;
    let revision = "new";
    try {
      const existing = await invoke<{ revision: string | null }>("read_file_preview", {
        path,
        root: ws.worktreePath,
      });
      if (existing.revision) revision = existing.revision;
    } catch {
      revision = "new";
    }
    await invoke("save_file_preview", {
      path,
      root: ws.worktreePath,
      text: targetJournalDoc(name, source),
      expectedRevision: revision,
    });
  }

  async function openJournals() {
    setCiteOpen("journal");
    if (journals || !ws) return;
    try {
      const file = await invoke<{ text: string }>("read_file_preview", {
        path: `${ws.worktreePath}/references.bib`,
        root: ws.worktreePath,
      });
      setJournals(topJournals(file.text));
    } catch {
      setJournals([]);
    }
  }

  async function continueAfterDecisions(target: string, title: string) {
    const kind = reviewItemKind(title);
    if (!ws || !kind) return;
    setDecisionNote(null);
    try {
      const req = await buildWorkspaceTerminalRequest(
        ws,
        continueAfterDecisionsPrompt(target, kind),
        { autoStart: true, resumeSession: true },
      );
      setPendingTerminal(req);
      setPage("terminal");
    } catch (reason) {
      setDecisionNote(String(reason));
    }
  }

  async function chooseCitationStyle(
    ask: string,
    journal?: { name: string; source: "沿用已定" | "本次选定" },
    want?: { family: StyleFamily | null; label: string },
  ) {
    if (citeBusy || !ws || !ask.trim()) return;
    setCiteBusy(true);
    setCiteNote(null);
    try {
      // 选期刊：任何步骤都落盘，下一步（含投稿模板）直接沿用，不再重问。
      if (journal) {
        await recordTargetJournal(journal.name, journal.source);
      }
      // 记下改前的样式，等用户回来时核对这一步到底有没有真换。
      citeBefore.current = await readStyleFamily();
      citeWant.current = want ?? null;
      const req = await buildWorkspaceTerminalRequest(
        ws,
        citationRerenderPrompt(ask),
        { autoStart: true, resumeSession: true },
      );
      setPendingTerminal(req);
      setPage("terminal");
    } catch (reason) {
      setCiteNote(String(reason));
    } finally {
      setCiteBusy(false);
    }
  }

  /** 读当前稿子实际用的 csl：样式族 + 版本指纹。读不到返回 null（还没设过样式）。 */
  async function readStyleFamily(): Promise<StyleFamily | null> {
    const roots = [
      ...(ws ? [ws.worktreePath] : []),
      ...(projectPath ? [projectPath] : []),
    ];
    for (const root of roots) {
      for (const rel of ["manuscript/citation.csl", "citation.csl"]) {
        try {
          const file = await invoke<{ text: string }>("read_file_preview", {
            path: `${root}/${rel}`,
            root,
          });
          return styleFamilyOf(file.text);
        } catch {
          // 试下一个位置
        }
      }
    }
    return null;
  }

  /** 人回到本页时核对：想要的样式和稿子实际用的对不对得上。 */
  async function verifyCitationStyle() {
    const before = citeBefore.current;
    const want = citeWant.current;
    if (want === null) return; // 没选过，不打扰
    const now = await readStyleFamily();
    if (now === null) {
      setCiteNote("还没找到 manuscript/citation.csl——样式可能没落到文件上，回对话里问一句再渲。");
      return;
    }
    if (want !== null && want.family === null) {
      setCiteNote(`样式文件已存在（${now}）。按期刊的样式请确认 csl 与该刊作者须知一致。`);
      return;
    }
    if (now === before && now !== want.family) {
      setCiteNote(`样式文件没变，可能只重渲了 PDF——这一步要的样式还没落到 csl 上。`);
      return;
    }
    if (now !== want.family) {
      setCiteNote(`样式文件现在是 ${now}，和这一步要的不一致，回对话里核对一下。`);
      return;
    }
    setCiteNote(null);
  }

  async function chatDraft() {
    if (!draft || chatBusy) return;
    setChatBusy(true);
    setChatError(null);
    try {
      await onSeedDraft?.();
    } catch (reason) {
      setChatBusy(false);
      setChatError(`TASK.md 准备失败：${String(reason)}`);
      return;
    }
    setChatBusy(false);
    // 步骤认领不在此登记：启动栏还可能改 agent/目录，改由终端页 spawn 时以最终值登记
    // （pendingTerminal.stepName → TerminalView launch 时 invoke claim_next_session_for_step）。
    // 它跑在项目根（只改 TASK.md，不落步骤工作区），不登记的话 stepName 为空，
    // 项目「对话」页按步骤筛会漏掉它。
    // 已经商量过：接回那条会话（resume），不要再注入「先通读一遍」开场——那会另开一轮。
    const resume = discussResume;
    setPendingTerminal({
      cwd: resume?.cwd?.trim() || projectPath,
      extraEnv: {},
      title: `${step.name} · 任务书`,
      stepName: step.name,
      ...(resume
        ? {
            agentId: resume.agentId,
            resume: {
              agentId: resume.agentId,
              sessionId: resume.sessionId,
              provider: resume.provider,
            },
            autoLaunchProfileId: projectLaunch?.profileId,
            autoStart: true,
          }
        : {
            initialPrompt:
              `我们一起敲定「${step.name}」这一步的任务书（${draft.relPath}）。` +
              `它现在的内容就是 TASK.md 的默认拼装（步骤简报、预期产物等都在里面），定稿后会原样落成工作区的 TASK.md。` +
              `先通读一遍，把拿不准的点（范围、口径、标准等）逐个问我，按我的回答直接修改这份文件。` +
              `只允许新建/修改这一个文件，以及下面点名的项目规则行。其他文件一律不要动。` +
              `讨论中没定下来的问题，记到这份任务书的「## 待拍板」小节。` +
              ((openSettings ?? []).filter((line) => line.trim()).length
                ? `项目规则里还有没定的全局设定。开场先逐项问我，说明括号里的说法。我确定一项，就把 .ccode/project.toml 的 settings 里对应那一行从「名称：（提示）」改成「名称：我的答案」，不要改这个文件的其他内容。还没定的是：${(openSettings ?? []).filter((line) => line.trim()).join("；")}。`
                : "") +
              (seeds.length > 0 ? `可以先从这几个问题聊起：${seeds.join("；")}` : ""),
            ...(projectLaunch ?? {}),
            autoStart: Boolean(projectLaunch?.profileId),
          }),
      surface: "terminal",
      // 同一步骤的任务书讨论是同一个对话：再点切回已有标签；没有标签才按上面 resume / 新开会话
      reuseKey: `discuss:${projectPath}:${draft.relPath}`,
    });
    setPage("terminal");
  }

  /** TASK.md 就地预览/编辑（本页弹层，v3.90 起与「预览 TASK.md」入口合一——不再有「草稿」概念）：
   *  内容经 onLoadTaskMd 加载：已有编辑内容读文件，否则给模板拼装（只读展示不落盘，纯看不留痕，
   *  discuss 节点完成口径不受影响）；保存才经 write_task_draft 落地。
   *  仍保留「在终端里打开」作为逃生口（要看 diff/用编辑器时） */
  const [draftEdit, setDraftEdit] = useState<{
    /** 打开时读到的原文，用来判断是否有未保存改动 */
    origin: string;
    text: string;
    revision: string | null;
    /** true = 还没有编辑内容，显示的是模板拼装（保存才创建文件）；「在终端里打开」此时无文件可开 */
    fromTemplate: boolean;
    saving: boolean;
    error: string | null;
  } | null>(null);
  // 渲染在 draftEdit 声明之后：useMemo 读它，提前声明会踩 TDZ
  const draftHtml = useMemo(
    () =>
      draftEdit?.text
        ? sanitizeDocumentHtml(
            marked.parse(draftEdit.text, {
              gfm: true,
              breaks: false,
              async: false,
            }) as string,
          )
        : "",
    [draftEdit?.text],
  );
  // TASK.md 预览的公式升级（与文件预览阅读版式同一口径；无公式不加载 katex）
  const draftHtmlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (draftHtmlRef.current) void renderMathInto(draftHtmlRef.current);
  }, [draftHtml]);

  async function openDraftInline() {
    setDraftEdit({ origin: "", text: "", revision: null, fromTemplate: false, saving: false, error: null });
    try {
      if (onLoadTaskMd) {
        const loaded = await onLoadTaskMd();
        setDraftEdit({
          origin: loaded.text,
          text: loaded.text,
          revision: loaded.revision,
          fromTemplate: !draftHasBody,
          saving: false,
          error: null,
        });
        return;
      }
      // 无加载回调的兜底（StepFlow 目前仅卡片区使用，正常不会走到）
      const cur = await invoke<{ relPath: string; text: string | null; revision: string | null }>(
        "read_task_draft",
        { projectRoot: projectPath, stepName: step.name },
      );
      const text = cur?.text ?? "";
      setDraftEdit({ origin: text, text, revision: cur?.revision ?? null, fromTemplate: !text.trim(), saving: false, error: null });
    } catch (reason) {
      setDraftEdit({
        origin: "",
        text: "",
        revision: null,
        fromTemplate: false,
        saving: false,
        error: String(reason),
      });
    }
  }

  async function saveDraftInline() {
    if (!draftEdit || draftEdit.saving) return;
    const submitted = draftEdit.text;
    const expected = draftEdit.revision;
    setDraftEdit({ ...draftEdit, saving: true, error: null });
    try {
      const saved = await invoke<{ relPath: string; revision: string | null }>("write_task_draft", {
        projectRoot: projectPath,
        stepName: step.name,
        content: submitted,
        expectedRevision: expected,
      });
      onDraftChanged?.();
      setDraftEdit((s) => {
        if (!s) return s;
        if (s.text !== submitted) {
          return { ...s, origin: submitted, revision: saved.revision, saving: false, error: null };
        }
        return null;
      });
    } catch (reason) {
      setDraftEdit((s) =>
        s ? { ...s, saving: false, error: String(reason) } : s,
      );
    }
  }

  /** 关闭前守一道：有未保存改动时确认，避免误点背景丢掉手写的内容 */
  async function closeDraftInline() {
    if (!draftEdit) return;
    if (
      draftEdit.text !== draftEdit.origin &&
      !(await confirmDialog("TASK.md 有未保存的改动，确定放弃？", {
        danger: true,
        confirmText: "放弃改动",
      }))
    )
      return;
    setDraftEdit(null);
  }

  /** Esc 关闭草稿弹层（与 DigestPicker 同口径；有未保存改动时走同一道确认） */
  useEffect(() => {
    if (!draftEdit) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        void closeDraftInline();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftEdit?.text, draftEdit?.origin]);

  /** 在终端页打开草稿（原行为，保留为逃生口） */
  function openDraft() {
    if (!draft) return;
    setPreviewReq({
      path: `${projectPath.replace(/[\\/]+$/, "")}/${draft.relPath}`,
      name: draft.relPath.split("/").pop() ?? draft.relPath,
      root: projectPath,
    });
    setPage("terminal");
  }

  if (!states) return null;
  const notesStep = stepFillsAnySlot(step.skills, ["lit-notes"], skillProvides);
  const flow = buildStepFlow({
    step,
    states,
    hasDraft,
    runStatus,
    litSource,
    pendingDecisions: decisionGaps.length,
    toolAsks: toolAskFields.map((field) => ({ key: field.key, label: field.label })),
    endnoteExport:
      step.workspaceName === "lit-notes" ||
      step.workspaceName === "journal-format" ||
      step.workspaceName === "submission-materials" ||
      /^rebuttal-r\d+$/.test(step.workspaceName ?? ""),
    continueNotes: notesStep,
  });
  const seeds = step.discussionSeeds ?? [];

  function goTerminal() {
    if (!ws) return;
    // 共享交接（pipeline-start.ts）：有活标签就切回去。没有活会话时，步骤绑定若是
    // 另一家 Agent，不接回历史会话，启动栏用绑定。同一家或没绑步骤才接回原对话。
    void (async () => {
      let stepL: { agentId: string; profileId: string; model: string } | null = null;
      try {
        const b = await invoke<{ profile: string; model?: string | null } | null>(
          "get_project_agent_binding",
          { projectRoot: projectPath, slot: stepSlotKey(step.name) },
        );
        stepL = taskBindingLaunch(useAppStore.getState().profiles, b);
      } catch {
        /* DB 读失败走 props 里的步骤槽 */
      }
      try {
        const req = await buildWorkspaceTerminalRequest(ws, undefined, {
          stepLaunch: stepL ?? stepSlotLaunch ?? undefined,
          releaseToStepBinding: true,
        });
        setPendingTerminal(req);
        setPage("terminal");
      } catch (reason) {
        // 后端 workspace_env_for 等失败：不静默（点了没反应无从重试）
        setDecisionError(`打不开终端：${String(reason)}`);
      }
    })();
  }

  function goReview() {
    if (!ws) return;
    setWorkspaceReviewRequest({
      worktreePath: ws.worktreePath,
      runId,
      action: reviewConflict ? "resolve-conflict" : undefined,
      requestId: crypto.randomUUID(),
    });
    setPage("terminal");
  }

  /** 节点圆点：同一族形状，靠「空心 → 实心」表达进度，不引入第二种字形。
   *  原来完成态用绿 ✓——勾号在一列圆点里是异类，而且 ok-text 的亮绿在暗色主题下发飘。
   *  改用实心圆 + done 色（与上方大圆步进器的 bg-done 同一枚绿），全站一套语言；
   *  「已完成」的语义还有标题的降级色兜着（人工事项另有删除线），不靠图标独扛 */
  /** 主干节点的序号（可选区不编号——它们不在时间线上；人工事项行也不参与编号——
   *  人工序用复选框表达状态、从不显示序号，把它们算进去会让可见序号断档：
   *  ① ② [复选框行] ④，用户实测「可选项占用了一个计数但没显示」）：
   *  流程感来自「① → ② → ③」的顺序本身，光靠 ○/● 看不出先后（用户反馈） */
  const mainOrder = new Map(
    flow.nodes
      .filter((n) => n.section === "main" && n.kind !== "human" && !(n.skipCurrent && n.key !== "tool:manuscript"))
      .map((n, i) => [n.key, i + 1] as const),
  );

  function icon(node: StepFlowNode): { text: string; cls: string } {
    const n = mainOrder.get(node.key);
    const num = n ? "①②③④⑤⑥⑦⑧⑨"[n - 1] ?? String(n) : "○";
    // 完成态用实心圆（done 色圆点，渲染在下方 icon span 分支）——绿 ✓ 在一列圆点里
    // 是异类字形，且 ok-text 亮绿在暗色主题下发飘（用户实测「不好看」）
    if (node.done) return { text: "", cls: "is-done" };
    if (node.key === flow.currentKey) return { text: num, cls: "text-cta" };
    return { text: num, cls: "text-l4" };
  }

  /** 动作选择在纯函数里（step-node-actions.ts，有测试钉住）；这里只把动作翻成长相。
   *  样式留在组件是故意的：颜色/间距改了看得见，「什么时候给入口」改错了只会静默消失。 */
  function nodeActions(node: StepFlowNode) {
    const action = stepNodeAction(node, {
      runStatus,
      agentAttention,
      litSource,
      hasWorkspace: !!ws,
      reviewConflict: !!reviewConflict,
      canRestore: !!onRestore,
      readPaper: !!onReadPaper,
      readPaperPrimary,
    });
    if (!action) return null;
    const outline =
      "shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1";
    const primary =
      "shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-xs text-cta-text hover:brightness-110";
    switch (action.kind) {
      case "continue-notes":
        return (
          <button
            type="button"
            disabled={!action.enabled}
            onClick={openContinueNotes}
            title={
              action.enabled
                ? "到文件页打开 notes/，自己点要读的那篇"
                : "先保存进项目，再去笔记夹"
            }
            className={`ml-auto ${outline} disabled:opacity-50`}
          >
            去笔记夹
          </button>
        );
      case "endnote-sync":
        return (
          <span className="ml-auto flex shrink-0 gap-1">
            <button
              type="button"
              disabled={!action.enabled || zoteroSyncing}
              onClick={() => void syncToZotero()}
              className={`${outline} disabled:opacity-50`}
            >
              {zoteroSyncing ? "打开中…" : "同步到 Zotero"}
            </button>
            <button
              type="button"
              disabled={!action.enabled || endnoteSyncing}
              onClick={() => void openEndnoteImport()}
              className={`${outline} disabled:opacity-50`}
            >
              {endnoteSyncing ? "打开中…" : "同步到 EndNote"}
            </button>
            <button
              type="button"
              disabled={!action.enabled}
              onClick={() => void openPapersDir()}
              className={`${outline} disabled:opacity-50`}
            >
              打开 papers
            </button>
          </span>
        );
      case "papers-import":
        return (
          <button
            type="button"
            // 按文献来源高亮对应进料口（与「确定文献来源」节点的落地口径一致），
            // 免得跳过去之后不知道点哪个（用户实测「和确定文献来源一样，没说清怎么导入」）
            onClick={() => onOpenResources?.(action.focus)}
            title={
              action.hasLibrary
                ? "新文献加进你的文献库后，到「文献与数据」重新导入即可——不必往项目里另放一份"
                : "到「文献与数据」导入：可从 Zotero 导入、导入 RIS/BibTeX 题录，或把文件放进项目目录后重新扫描"
            }
            className={outline}
          >
            到「文献与数据」导入
          </button>
        );
      case "submit-deliverable":
        return (
          <button
            type="button"
            disabled={busyTitle !== null}
            onClick={() => void pickFile(node.human!.title)}
            title={`选文件提交到落点 ${node.human!.target}；也可直接把文件拖到这一行`}
            className={`${outline} disabled:opacity-50`}
          >
            {busyTitle === node.human!.title ? "提交中…" : "提交产物"}
          </button>
        );
      case "restore-workspace":
        return (
          <button type="button" onClick={onRestore} className={primary}>
            恢复工作区
          </button>
        );
      case "start":
        return (
          // 唯一主路径（v3.89）：上面那些题都不拦着开工，所以「开始」必须比它们显眼一档。
          // 仅示例课题精读：主按钮改成「开读这一篇」，开始仍可用。普通模板不应传入 onReadPaper。
          <span className="flex shrink-0 items-center gap-1.5">
            {action.readPaper && (
              <button
                type="button"
                onClick={onReadPaper}
                title="打开沉浸阅读：笔记｜PDF｜终端"
                className={
                  action.readPaperPrimary
                    ? "shrink-0 rounded-sm border border-cta-bd bg-cta px-3 py-1 text-sm text-cta-text hover:brightness-110"
                    : "shrink-0 rounded-sm border border-field px-2 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1"
                }
              >
                开读这一篇
              </button>
            )}
            <button
              type="button"
              onClick={onStart}
              title="直接开工也行，AI 会在对话里问你缺的信息"
              className={
                action.readPaperPrimary
                  ? "shrink-0 rounded-sm border border-field px-2 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1"
                  : "shrink-0 rounded-sm border border-cta-bd bg-cta px-3 py-1 text-sm text-cta-text hover:brightness-110"
              }
            >
              开始
            </button>
          </span>
        );
      case "go-terminal": {
        // 这一行只留一个入口。会话还在出字或等确认：回去看。否则「继续」新开一轮，
        // 用这一步的绑定。两颗同时出现会和下面工作区的「继续」叠成三件同一件事。
        const live =
          agentAttention === "working" || agentAttention === "confirm";
        return (
          <span className="flex shrink-0 items-center gap-1.5">
            {action.agentDone && <span className="text-xs text-l3">Agent 已跑完</span>}
            {live || !onContinueStep ? (
              <button
                type="button"
                onClick={goTerminal}
                title="回到这一步正在进行的对话"
                className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover"
              >
                去终端看看
              </button>
            ) : (
              <button
                type="button"
                onClick={onContinueStep}
                title="在这一步的工作区开新会话，用这一步绑定的配置，接着做到完成标准"
                className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover"
              >
                继续
              </button>
            )}
          </span>
        );
      }
      case "go-review":
        return (
          <button type="button" onClick={goReview} className={primary}>
            {action.conflict ? "去处理冲突" : "去评审"}
          </button>
        );
    }
  }

  /** 单个节点行（主干与可选区共用）：dense = 可选区的紧凑版（更小字号、不显示 hint） */
  const hasDiscussNode = flow.nodes.some((n) => n.kind === "discuss");

  function renderNode(node: StepFlowNode, dense = false) {
    const isCurrent = node.key === flow.currentKey;
    const ic = icon(node);
    const human = node.human;
    const done =
      node.key === "endnote-export"
        ? endnoteChecked
        : node.key === "continue-notes"
          ? continueNotesChecked
          : node.done;
    const guidance = node.kind === "human" ? human?.guidance?.trim() : "";
    const guidanceShort = guidance ? guidancePreview(guidance) : "";
    return (
      <li
        key={node.key}
        data-node-key={node.key}
        data-human-task={
          node.kind === "human" && node.human?.target
            ? isCitationStyleTask(node.human.title)
              ? "更换引用样式"
              : node.human.title
            : undefined
        }
        className={`rounded-sm pr-1.5 transition-colors duration-300 ${
          node.kind === "input"
            ? "pt-1.5 pb-0"
            : "py-1.5"
        } ${
          node.kind === "human" && dropHover === node.human?.title
            ? "bg-cta/10 outline outline-1 outline-cta-bd pl-1.5"
            : isCurrent
              ? // 当前节点只在左侧立一道竖线，不给整块刷底色：
                // 「定方向」内容高，整块 bg-hover 会变成一大片色板，把主动作「开始」压下去。
                // 竖线走绝对定位压在**序号那一列**（left-[7px]，与 StepperChain 的连接线同轴），
                // 用 border-l 会画在行最左，与序号差 7px 对不上（用户实测「框线没对上」）。
                // 起点 top-[22px] 对齐序号圆心下方：圆圈字形（①②）在 20px 行框里只占中部，
                // 固定 top-3（12px）会冒到字形顶上方（用户实测「序号上方多出一段」）；
                // 22px 在紧凑行（无按钮）落在序号正下方、加高行（按钮撑到 28px+）落在圆心附近，
                // 两种行高都不会越过字形顶
                "relative pl-1.5 before:absolute before:bottom-1 before:left-[7px] before:top-[22px] before:w-0.5 before:bg-cta before:content-['']"
              : "pl-1.5"
        } ${
          // 还轮不到才压暗。待确认清单已经挂在这一行上，不因为检索会话还没标完成就发灰。
          node.kind === "human" &&
          human?.timing === "after" &&
          !afterReady(human) &&
          !node.done &&
          !isPendingConfirmTaskTitle(human.title) &&
          !isInlineDecisionTaskTitle(human.title)
            ? "opacity-45"
            : ""
        }`}
      >
        <div className="flex items-center gap-2">
          {/* 人工事项行：复选框本身就是状态 + 控件，再画一个 ✓ 是同一件事说两遍
              （用户实测：一行两个勾）。这里只占位保持与主干节点同列对齐 */}
          {node.kind !== "human" && ic.cls === "is-done" ? (
            /* 完成态：中性亮灰空心小圆环——与大圆步进器同语言（实心=进行中、空心=已完成），
               与完成段链条同款 l2 亮灰；①②③ 也是空心圆族（2026-09-15 用户拍板不要绿色） */
            <span className="ccode-well relative z-10 flex w-4 shrink-0 items-center justify-center">
              <span className="block size-3 rounded-full border-[1.5px] border-l2" />
            </span>
          ) : (
            <span
              className={`ccode-well relative z-10 w-4 shrink-0 text-center text-sm ${
                node.kind === "human" ? "" : ic.cls
              }`}
            >
              {node.kind === "human" ? "" : ic.text}
            </span>
          )}
          {node.key === "endnote-export" ? (
            <Checkbox
              className="shrink-0"
              checked={endnoteChecked}
              onChange={setEndnoteChecked}
              title="勾选 = 已经在 EndNote 里导入完"
            />
          ) : node.key === "continue-notes" ? (
            <Checkbox
              className="shrink-0"
              checked={continueNotesChecked}
              onChange={setContinueNotesChecked}
              title="勾选 = 已经去笔记夹看过"
            />
          ) : node.kind === "human" && human ? (
            <Checkbox
              className="shrink-0"
              checked={node.done}
              disabled={
                busyTitle === human.title ||
                (isInlineDecisionTaskTitle(human.title) &&
                  !node.done &&
                  (decisionOpen.get(human.title) ?? 1) > 0)
              }
              onChange={(checked) => void toggle(human, checked)}
              title={
                isInlineDecisionTaskTitle(human.title) &&
                !node.done &&
                (decisionOpen.get(human.title) ?? 1) > 0
                  ? "还有没决定的条目"
                  : node.done
                    ? "已完成；取消勾选会保留为未完成，需重新勾选确认"
                    : "勾选 = 人工确认完成（系统不再追问）"
              }
            />
          ) : null}
          <span
            title={
              node.kind === "human" && human?.guidance && (dense || !isCurrent)
                ? human.guidance
                : undefined
            }
            className={`min-w-0 flex-1 truncate ${
              dense ? "text-xs" : "text-sm"
            } ${
              // 删除线只给打勾的人工事项（清单打勾的惯例）；「AI 干活」「确定文献来源」
              // 完成后划掉读起来像「取消了 / 跳过了」（用户截图），完成态交给左侧空心圆
              done
                ? node.kind === "human"
                  ? "text-l4 line-through"
                  : "text-l4"
                : isCurrent
                  ? "text-l1"
                  : dense
                    ? "text-l3"
                    : "text-l2"
            }`}
          >
            {node.label}
          </span>
          {/* 可选事项标记：不做也不影响这一步跑完。没有这个标记的话，
              一个永远不打勾的条目看起来就像没做完的必办项。
              待确认还有篇目时不标可选：模板里「没有待确认可跳过」，有就得人拍板，
              换成待确认篇数（清单折着也看得见还剩几篇） */}
          {node.section === "main" &&
            node.kind === "human" &&
            human?.optional &&
            !node.done &&
            !isPaywallTaskTitle(human.title) &&
            !(isPendingConfirmTaskTitle(human.title) && pendingMeta.count > 0) && (
            <span
              className="shrink-0 rounded-sm bg-raised px-1.5 py-0.5 text-micro text-l4"
              title="可选：不做也能跑完这一步"
            >
              可选
            </span>
          )}

          {/* 付费墙进度只认清单已存/总数，不拿 papers/ 里全部 PDF 当「已见到」——
              那会把无关文件算进来，和清单「已存 21/89」对不上。 */}
          {node.kind === "human" && human && isPendingConfirmTaskTitle(human.title) ? (
            !node.done && pendingMeta.count > 0 ? (
              <span
                className="shrink-0 text-micro tabular-nums text-warn-text"
                title="这些篇目要你点纳入或排除；拍板前不进待获取、不写精读笔记"
              >
                待确认 {pendingMeta.count} 篇
              </span>
            ) : null
          ) : node.kind === "human" && human && isPaywallTaskTitle(human.title) ? (
            toFetchItems.length > 0 ? (
              <span
                className="shrink-0 text-micro tabular-nums text-l4"
                title={`已存 ${paywallSavedCount} 篇，清单共 ${toFetchItems.length} 篇`}
              >
                {paywallSavedCount}/{toFetchItems.length}
              </span>
            ) : human.expectedCount != null ? (
              <span className="shrink-0 text-micro tabular-nums text-l4">
                清单 {human.expectedCount}
              </span>
            ) : null
          ) : node.kind === "human" && human?.hitCount != null && !isCitationStyleTask(human.title) && !isInlineDecisionTaskTitle(human.title) ? (
            <span className="shrink-0 text-micro text-l4">
              已见到 {human.hitCount} 个文件
              {human.expectedCount != null
                ? ` / 清单共 ${human.expectedCount} 篇`
                : ""}
            </span>
          ) : null}
          {node.section === "main" &&
            node.kind === "human" &&
            human?.optional &&
            !node.done &&
            isPaywallTaskTitle(human.title) && (
            <span
              className="shrink-0 rounded-sm bg-raised px-1.5 py-0.5 text-micro text-l4"
              title="可选：不做也能跑完这一步。跳过的篇目下一篇按摘要记"
            >
              可选
            </span>
          )}
          {nodeActions(node)}
        </div>
        {node.kind === "human" && isCitationStyleTask(human?.title) && ws && (
          <div className="ml-9 mt-1.5">
            <div className="flex flex-wrap items-center gap-1">
              {CITATION_STYLE_CHOICES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={citeBusy}
                  onClick={() => {
                    const next = citeOpen === item.id ? null : item.id;
                    setCiteOpen(next);
                    // 选过样式的人再打开这一排时，顺便核对落到 csl 上没有。
                    if (next !== null) void verifyCitationStyle();
                  }}
                  className={`rounded-full px-2 py-0.5 text-xs disabled:opacity-50 ${
                    citeOpen === item.id
                      ? "border border-cta-bd bg-cta-pill text-cta-pill-text"
                      : "bg-inset text-l3 hover:bg-hover hover:text-l1"
                  }`}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                disabled={citeBusy}
                onClick={() => {
                  if (citeOpen === "journal") {
                    setCiteOpen(null);
                    return;
                  }
                  void openJournals();
                  void loadTargetJournal();
                }}
                className={`rounded-full px-2 py-0.5 text-xs disabled:opacity-50 ${
                  citeOpen === "journal"
                    ? "border border-cta-bd bg-cta-pill text-cta-pill-text"
                    : "bg-inset text-l3 hover:bg-hover hover:text-l1"
                }`}
              >
                按期刊
              </button>
            </div>
            {citeOpen && citeOpen !== "journal" && (
              <div className="mt-1 flex flex-wrap gap-1">
                {CITATION_STYLE_CHOICES.find((item) => item.id === citeOpen)?.forms.map((form) => (
                  <button
                    key={form.id}
                    type="button"
                    disabled={citeBusy}
                    onClick={() =>
                      void chooseCitationStyle(form.ask, undefined, {
                        family: citationFormFamily(form.id),
                        label: form.label,
                      })
                    }
                    className="rounded-sm bg-inset px-2 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                  >
                    {form.label}
                  </button>
                ))}
              </div>
            )}
            {citeOpen === "journal" && draftJournal && !journalSwap && (
              <div className="mt-1 flex flex-wrap gap-1">
                <button
                  type="button"
                  disabled={citeBusy}
                  onClick={() =>
                    void chooseCitationStyle(journalAsk(draftJournal), {
                      name: draftJournal,
                      source: "沿用已定",
                    }, { family: null, label: draftJournal })
                  }
                  className="rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  沿用已定：{draftJournal}
                </button>
                <button
                  type="button"
                  disabled={citeBusy}
                  onClick={() => {
                    setJournalSwap(true);
                    void openJournals();
                  }}
                  className="rounded-sm bg-inset px-2 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1"
                >
                  更换期刊
                </button>
              </div>
            )}
            {citeOpen === "journal" && (!draftJournal || journalSwap) && (
              <form
                className="mt-1 max-w-md"
                onSubmit={(event) => {
                  event.preventDefault();
                  void chooseCitationStyle(journalAsk(journalName), {
                    name: journalName,
                    source: "本次选定",
                  }, { family: null, label: journalName });
                }}
              >
                <div className="flex flex-wrap gap-1">
                  {(journals ?? []).map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      disabled={citeBusy}
                      onClick={() =>
                        void chooseCitationStyle(journalAsk(item.name), {
                          name: item.name,
                          source: "本次选定",
                        }, { family: null, label: item.name })
                      }
                      className="rounded-sm bg-inset px-2 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                    >
                      {item.name}
                      <span className="ml-1 text-l4">{item.count}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-1 flex gap-1">
                  <input
                    value={journalName}
                    onChange={(event) => setJournalName(event.target.value)}
                    placeholder="输入期刊名"
                    className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none placeholder:text-l4"
                  />
                  <button
                    type="submit"
                    disabled={citeBusy || !journalName.trim()}
                    className="rounded-sm bg-inset px-2 py-1 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                  >
                    用这个期刊
                  </button>
                </div>
              </form>
            )}
            {citeNote && <p className="mt-1 text-micro text-l4">{citeNote}</p>}
          </div>
        )}
        {/* 当前节点的引导与展开操作：种子 chips / 落点说明。
            例外：评审节点的验收引导不看「当前」身份（v3.97）——hint 已按 runStatus 门控
            （待开始无文案、进行中预告、待评审给步骤）；agent 跑完没提交时当前节点一直停在
            agent 上，若死守 isCurrent，验收引导永远显示不出来（用户实测） */}
        {!dense &&
          (isCurrent ||
            node.kind === "review" ||
            node.key === "endnote-export" ||
            node.key === "continue-notes") &&
          node.hint && (
          <p className="mt-1 pl-9 text-micro leading-5 text-l4">
            {node.key === "endnote-export" && (zoteroSyncResult?.line || endnoteSyncResult)
              ? [zoteroSyncResult?.line, endnoteSyncResult].filter(Boolean).join(" ")
              : node.hint}
          </p>
        )}
        {node.kind === "input" && node.key.startsWith("tool:") && onSetResearchTool && tools && (
          <div className="ml-9 mt-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {(RESEARCH_TOOL_FIELDS.find((field) => `tool:${field.key}` === node.key)?.options ?? []).map(([key, label]) => {
                const on = tools[node.key.slice(5) as ResearchToolField["key"]] === key;
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={toolBusy}
                    onClick={() => void onSetResearchTool(node.key.slice(5) as ResearchToolField["key"], key)}
                    className={`rounded-full px-2 py-0.5 text-xs disabled:opacity-50 ${
                      on
                        ? "border border-cta-bd bg-cta-pill text-cta-pill-text"
                        : "bg-inset text-l3 hover:bg-hover hover:text-l1"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {node.kind === "input" && node.key === "input" && onSetLitSource && (
          // pl-9 与其余内容区（hint/agentContent）对齐到步骤名左缘，不顶到序号
          <div className="ml-9 mt-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {LIT_SOURCES.map((o) => {
                const on = (litSource || "search") === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    disabled={litBusy}
                    onClick={() => void onSetLitSource(o.id)}
                    title={o.hint}
                    className={`rounded-full px-2 py-0.5 text-xs disabled:opacity-50 ${
                      on
                        ? "border border-cta-bd bg-cta-pill text-cta-pill-text"
                        : "bg-inset text-l3 hover:bg-hover hover:text-l1"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
              {/* 跟在选项后面，不 ml-auto 拉到右缘——右边留给这一步的「开始」。 */}
              {(() => {
                const cur =
                  LIT_SOURCES.find((o) => o.id === (litSource || "search")) ??
                  LIT_SOURCES[0];
                return onOpenResources && cur.action ? (
                  <button
                    type="button"
                    onClick={() => onOpenResources(cur.focus)}
                    title={cur.hint}
                    className="shrink-0 rounded-sm px-1 py-0.5 text-xs text-l3 underline decoration-dotted underline-offset-2 hover:bg-hover hover:text-l1"
                  >
                    {cur.action}
                  </button>
                ) : null;
              })()}
            </div>
          </div>
        )}
        {/* 想法区与「跟 AI 商量」：discuss 节点存在时挂它，否则挂 agent 节点（v3.89）——
            内容一字未动，只是换了落点，避免节点被隐藏时这些入口一起消失 */}
        {(node.kind === "discuss" ||
          (node.kind === "agent" && !hasDiscussNode)) && (
          <div className="mt-1.5 space-y-2 pl-9">
            {/* ── 输入准备（v3.86；v3.89 升格为独立 input 节点，排在 AI 干活之前）──
                · 决策项：答案写进任务书草稿，纯记录，给 agent 看的合同内容
                · 文献来源：答案写进项目配置 lit_source，要动手（导入），还会改变这一步的性质
                  （系统检索 → 盘点已有 + 查漏补缺）
                所以它是「这一步的输入从哪来」，不是「这一步怎么做」，单独成块 + 自带动作按钮。
                答完且没有待办动作时收成一行，不长期占地方。 */}
            {/* 决策项 = 方式一（点卡片直接定）：可枚举的拍板点一行一题，点选即答——不开终端、不建卡、不切页。
                与「跟 AI 商量一下」（方式二 · 聊着定）是确定 TASK.md 的两条并列路径，终点相同（v3.90 用户拍板挑明） */}
            {decisions.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {/* 默认折叠（v3.89）：这些题**不拦着开工**（不答也能点「开始」），
                      但摊开成一列待答清单看着像必办任务——每步 0~3 件还没规律，
                      用户无从预期。降为「想省事就点两下」的快捷方式 */}
                  <button
                    type="button"
                    onClick={() => setDecisionsOpen((v) => !v)}
                    aria-expanded={decisionsOpen}
                    className="flex min-w-0 items-center gap-1 text-xs text-l3 hover:text-l1"
                  >
                    <FoldMark open={decisionsOpen} boxed />
                    {decisionGaps.length > 0
                      ? `直接选择（${decisionGaps.length} 项待定）`
                      : "直接选择（已定）"}
                  </button>
                  {pendingDecisions.some((d) => d.options.length > 0) && (
                    <button
                      type="button"
                      disabled={decisionBusy}
                      onClick={() =>
                        void commitDecisions(
                          recommendedAnswers(decisions, answered),
                        )
                      }
                      title="未拍板的一律取第一个选项（推荐值）写进草稿；已选过的不动"
                      className="shrink-0 rounded-sm px-1 py-0.5 text-micro text-l4 underline decoration-dotted underline-offset-2 hover:bg-hover hover:text-l2 disabled:opacity-50"
                    >
                      全部用推荐值
                    </button>
                  )}
                </div>
                {decisionsOpen &&
                  decisions.map((d) => {
                  const picked = answered.get(d.q.trim());
                  const pickedRecord = picked ? parseDecisionAnswer(picked) : null;
                  return (
                    <div
                      key={d.q}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1"
                    >
                      <span
                        className={`shrink-0 text-xs ${picked ? "text-l3" : "text-l1"}`}
                        title={d.q}
                      >
                        {decisionAsk(d.q)}
                      </span>
                      {d.options.map((opt) => {
                        const on = picked === opt || (pickedRecord?.status === "approve" && pickedRecord.note === opt);
                        return (
                          <button
                            key={opt}
                            type="button"
                            disabled={decisionBusy}
                            onClick={() =>
                              void commitDecisions([
                                { q: d.q, answer: formatDecisionAnswer("approve", opt) },
                              ])
                            }
                            title={
                              on
                                ? "已选：写在草稿「已定方向」里，点别的选项可改"
                                : `选它：直接写进草稿「已定方向」，不开会话`
                            }
                            className={`rounded-full px-2 py-0.5 text-xs disabled:opacity-50 ${
                              on
                                ? "border border-cta-bd bg-cta-pill text-cta-pill-text"
                                : "bg-strip text-l3 hover:bg-hover hover:text-l1"
                            }`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                      {/* 自己写的答案不在选项里：单独显示成同款选中 chip，
                          否则填完看不到任何选中态，像是没生效 */}
                      {picked && !d.options.some((opt) => picked === opt || (pickedRecord?.status === "approve" && pickedRecord.note === opt)) && (
                        <button
                          type="button"
                          onClick={() =>
                            setWriteOwn({
                              q: d.q,
                              text: pickedRecord?.note ?? picked,
                              status: pickedRecord && pickedRecord.status !== "legacy" ? pickedRecord.status : "",
                            })
                          }
                          title="你自己写的答案，点击可改"
                          className="rounded-full border border-cta-bd bg-cta-pill px-2 py-0.5 text-xs text-cta-pill-text hover:brightness-110"
                        >
                          {pickedRecord && pickedRecord.status !== "legacy"
                            ? `${DECISION_STATUS_ASK[pickedRecord.status]}：${pickedRecord.note || "（无说明）"}`
                            : picked}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setWriteOwn(
                            writeOwn?.q === d.q
                              ? null
                              : {
                                  q: d.q,
                                  text: pickedRecord?.note ?? picked ?? "",
                                  status: pickedRecord && pickedRecord.status !== "legacy" ? pickedRecord.status : "",
                                },
                          )
                        }
                        title="选项都不合适：自己写一句，或展开去聊"
                        className="shrink-0 rounded-sm px-1 py-0.5 text-micro text-l4 hover:bg-hover hover:text-l1"
                      >
                        {d.options.length > 0 ? "其他…" : "写一句…"}
                      </button>
                    </div>
                  );
                })}
                {/* 自己写：写完直接进草稿，和点选项同一条路径，不开终端 */}
                {writeOwn && (
                  <form
                    className="flex flex-wrap items-center gap-1.5 pt-0.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const answer = writeOwn.text.trim();
                      if (!writeOwn.status || !answer) return;
                      void commitDecisions([
                        { q: writeOwn.q, answer: formatDecisionAnswer(writeOwn.status, answer) },
                      ]).then(() => setWriteOwn(null));
                    }}
                  >
                    <select
                      value={writeOwn.status}
                      onChange={(e) => setWriteOwn({ ...writeOwn, status: e.target.value as DecisionStatus | "" })}
                      className="rounded-sm border border-field bg-canvas px-1.5 py-0.5 text-xs text-l1"
                      title="可以写 = 按你写下的范围开写正文；只准备 = 还不准写正文"
                    >
                      <option value="">能不能写？</option>
                      {(Object.keys(DECISION_STATUS) as DecisionStatus[]).map((key) => (
                        <option key={key} value={key}>{DECISION_STATUS_ASK[key]}</option>
                      ))}
                    </select>
                    <input
                      autoFocus
                      value={writeOwn.text}
                      onChange={(e) =>
                        setWriteOwn({ ...writeOwn, text: e.target.value })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setWriteOwn(null);
                      }}
                      placeholder="例如：按已精读笔记写，没全文的只写到摘要"
                      className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-1.5 py-0.5 text-xs text-l1 outline-none focus:border-cta-bd"
                    />
                    <button
                      type="submit"
                      disabled={decisionBusy || !writeOwn.status || !writeOwn.text.trim()}
                      className="shrink-0 rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
                    >
                      记下
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const q = writeOwn.q;
                        setWriteOwn(null);
                        onSeed(q);
                      }}
                      title="拿不准？就这个问题开终端和 Agent 聊（自动建卡，结论写进草稿）"
                      className="shrink-0 rounded-sm px-1.5 py-0.5 text-micro text-l4 hover:bg-hover hover:text-l2"
                    >
                      开聊
                    </button>
                  </form>
                )}
                {decisionError && (
                  <InlineNotice tone="err" size="micro">{decisionError}</InlineNotice>
                )}
              </div>
            )}
            {/* 方式一/方式二同形（v3.90 走查，用户拍板）：两条路都是「可折叠的一行」——
                ▸ 折叠只露一行标签，▾ 展开才露动作（方式一展开是卡片、方式二展开是聊天按钮）。
                「预览/编辑 TASK.md」是看结果不是第三条路——跟在本行标签后面
                （与方式一行的「全部用推荐值」同位），不 ml-auto 拉到右缘抢「开始」。 */}
            {decisions.length > 0 ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <button
                    type="button"
                    onClick={() => setChatOpen((v) => !v)}
                    aria-expanded={chatOpen}
                    className="flex min-w-0 items-center gap-1 text-xs text-l3 hover:text-l1"
                  >
                    <FoldMark open={chatOpen} boxed />
                    和 AI 商量（可选）
                  </button>
                  <button
                    type="button"
                    disabled={!draft}
                    onClick={() => void openDraftInline()}
                    title={
                      draftHasBody
                        ? "这一步的 TASK.md 已改过，点此查看或再改"
                        : "查看/编辑这一步的 TASK.md（没改过时是模板默认拼装，可直接改）"
                    }
                    className={taskMdBtnClass}
                  >
                    TASK.md
                  </button>
                </div>
                {chatOpen && (
                  <div className="flex flex-wrap items-center gap-2 pl-4">
                    <button
                      type="button"
                      disabled={!draft || chatBusy}
                      onClick={() => void chatDraft()}
                      title={
                        discussed
                          ? "接回上次商量的会话，接着改这一步的 TASK.md"
                          : "开终端跟 AI 一起过一遍任务书：它读稿提问、你拍板、它直接改稿——改的就是最终落盘的 TASK.md"
                      }
                      className="rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                    >
                      {chatBusy ? "准备 TASK.md…" : discussChatLabel(discussed)}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              /* 无决策项的步骤：方式一不存在，不标「方式二」（会让人找方式一）——维持单按钮形态 */
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!draft || chatBusy}
                  onClick={() => void chatDraft()}
                  title={
                    discussed
                      ? "接回上次商量的会话，接着改这一步的 TASK.md"
                      : "开终端跟 AI 一起过一遍任务书：它读稿提问、你拍板、它直接改稿——改的就是最终落盘的 TASK.md"
                  }
                  className="rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                >
                  {chatBusy ? "准备 TASK.md…" : discussChatLabel(discussed)}
                </button>
                <button
                  type="button"
                  disabled={!draft}
                  onClick={() => void openDraftInline()}
                  title={
                    draftHasBody
                      ? "这一步的 TASK.md 已改过，点此查看或再改"
                      : "查看/编辑这一步的 TASK.md（没改过时是模板默认拼装，可直接改）"
                  }
                  className={taskMdBtnClass}
                >
                  TASK.md
                </button>
              </div>
            )}
            {chatError && (
              <InlineNotice tone="err" size="micro">{chatError}</InlineNotice>
            )}
            {!draft && draftLoadError && (
              <p className="text-micro text-err-text">{draftLoadError}</p>
            )}
            {/* 预置话题 chips：只列还没开聊过的——开过的已经以话题行躺在下面的清单里，
                两处都显示会让人以为是两个东西。点击 = 只读开聊（同话题清单口径），
                「让 agent 直接改草稿」是上面那颗「跟 Agent 聊任务书」的活，两者不重叠 */}
            {/* 预置话题：不再是独立一区，而是「跟 AI 商量」的现成话头。
                前缀「聊聊：」让它一眼看出是同一件事的快捷入口，不是第三个功能 */}
            {(openSeeds ?? []).length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs text-l4">或直接聊：</span>
                {(openSeeds ?? []).map((seed) => (
                  <button
                    key={seed}
                    type="button"
                    onClick={() => onSeed(seed)}
                    title="就这个问题开聊，结论可以沉淀进任务书"
                    className="rounded-full bg-strip px-2 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
                  >
                    {seed}
                  </button>
                ))}
              </div>
            )}
            {/* 想法区（v3.80）：自由想法卡，讨论的最松散一档，排在种子之后。
                由卡片区经 discussContent 传入——与 agentContent 同一范式，
                收进本节点是为了让「一步 = 一条线」，不在流程线旁边另立并列区块 */}
            {discussContent}
          </div>
        )}
        {node.kind === "agent" && agentContent && (
          <div className="mt-1.5 pl-9">{agentContent}</div>
        )}
        {node.kind === "agent" && notesStep && (ws || runStatus === "done") && (
          <NotesProgressLine
            roots={ws ? [ws.worktreePath, projectPath] : [projectPath]}
            live={runStatus === "active"}
          />
        )}
        {/* 说明只在当前节点显示：一屏同时摊开五段说明是这一页最大的噪音源。
            非当前节点的说明挂在行的 title 上（悬停可见），信息不丢。
            例外（v3.97）：可选的 after 档事项被设计成不抢「当前节点」，若死守 isCurrent，
            「下载付费墙文献全文」的清单入口就只剩悬停可见（用户实测「没说清怎么导入」）——
            就绪（afterReady）且未完成时就地展示清单；做法进行内按钮 title，不写说明书。
            学术检索 MCP 同款：沉在可选区永远不是当前节点，必须就地给预设入口。 */}
        {node.kind === "human" &&
          human &&
          isAcademicMcpTaskTitle(human.title) &&
          !node.done &&
          !dense && (
            <div className="mt-1 flex flex-wrap items-center gap-2 pl-9">
              {ACADEMIC_MCP_PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => {
                    setPendingMcpPreset(preset.name);
                    setPage("mcp");
                  }}
                  title={
                    preset.auth === "oauth"
                      ? `${preset.what}。分发后先在终端登录，Mesa 体检未连通也正常`
                      : `${preset.what}。在 MCP 页填 API 密钥，Mesa 注入 ${preset.envVar}`
                  }
                  className="shrink-0 rounded-sm px-1 py-0.5 text-xs text-l3 underline decoration-dotted underline-offset-2 hover:bg-hover hover:text-l1"
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setPendingTerminal({
                    cwd: projectPath,
                    extraEnv: {},
                    title: "MCP 登录",
                    initialPrompt: academicMcpLoginPrompt(projectLaunch?.agentId),
                    ...(projectLaunch ?? {}),
                    autoStart: Boolean(projectLaunch?.profileId),
                    permission: "discuss",
                    surface: "terminal",
                    reuseKey: `mcp-login:${projectPath}`,
                  });
                  setPage("terminal");
                }}
                title="开讨论会话并带上 mcp login 指令；登录成功后请新开「开始」，不要在这个会话检索"
                className="shrink-0 rounded-sm px-1 py-0.5 text-xs text-l3 underline decoration-dotted underline-offset-2 hover:bg-hover hover:text-l1"
              >
                去终端登录
              </button>
              {academicMcp && !academicMcp.ready && academicMcp.note && (
                <span className="min-w-0 text-micro text-l4">{academicMcp.note}</span>
              )}
            </div>
          )}
        {node.kind === "human" &&
          human &&
          isPendingConfirmTaskTitle(human.title) &&
          !node.done &&
          !dense && (
            <div className="mt-1 pl-9 text-micro leading-5 text-l4">
              <p>{PENDING_HINT}</p>
              <div className="mt-1.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPendingListOpen((open) => !open)}
                    aria-expanded={pendingListOpen}
                    className="flex items-center gap-1 text-xs text-l3 hover:text-l1"
                    title="待确认点纳入或排除；已纳入点移出"
                  >
                    <FoldMark open={pendingListOpen} />
                    文献清单
                  </button>
                  {pendingListOpen && pendingMeta.count > 0 && (
                    <button
                      type="button"
                      disabled={pendingMeta.busy}
                      onClick={() => pendingListRef.current?.includeAll()}
                      className="rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text disabled:opacity-50"
                      title={`把 ${pendingMeta.count} 篇待确认全部改为纳入。没有 PDF 的会追加到待获取。`}
                    >
                      {pendingMeta.busy ? "纳入中…" : "全部纳入"}
                    </button>
                  )}
                </div>
                {pendingListOpen && (
                  <div className="mt-1">
                    <PendingConfirmList
                      ref={pendingListRef}
                      onMeta={setPendingMeta}
                      worktreePath={ws?.worktreePath}
                      projectRoot={projectPath}
                      onOpenPdf={(path) =>
                        setFilePreviewReq({
                          projectRoot: projectPath,
                          path,
                          token: Date.now(),
                        })
                      }
                      onChanged={() => {
                        onChanged?.();
                        void loadPaywallList();
                      }}
                      onCleared={() => {
                        if (human) void checkPendingConfirmIfOpen(human.title);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        {node.kind === "human" &&
          human &&
          reviewItemKind(human.title) &&
          human.target &&
          !node.done &&
          !dense &&
          (isCurrent || afterReady(human)) && (
            <div className="mt-1 pl-9">
              <ReviewDecisionList
                worktreePath={ws?.worktreePath}
                projectRoot={projectPath}
                target={human.target}
                kind={reviewItemKind(human.title)!}
                onOpenCount={(count) =>
                  setDecisionOpen((prev) => {
                    if (prev.get(human.title) === count) return prev;
                    const next = new Map(prev);
                    next.set(human.title, count);
                    return next;
                  })
                }
                onAllDecided={() => {
                  void checkPendingConfirmIfOpen(human.title);
                  if (human.target) void continueAfterDecisions(human.target, human.title);
                }}
              />
              {decisionNote && <InlineNotice tone="err" size="micro" className="mt-1">{decisionNote}</InlineNotice>}
            </div>
          )}
        {!dense &&
          node.kind === "human" &&
          human &&
          guidance &&
          !isAcademicMcpTaskTitle(human.title) &&
          !isPendingConfirmTaskTitle(human.title) &&
          !isInlineDecisionTaskTitle(human.title) &&
          !isCitationStyleTask(human.title) &&
          (isCurrent ||
            (!node.done &&
              human.timing === "after" &&
              afterReady(human))) && (
            <div className="mt-1 pl-9 text-micro leading-5 text-l4">
              {isPaywallTaskTitle(human.title) ? (
                <p>{PAYWALL_HINT}</p>
              ) : isPendingConfirmTaskTitle(human.title) ? (
                <p>{PENDING_HINT}</p>
              ) : (
                <>
                  <p className="whitespace-pre-wrap">{guidanceShort}</p>
                  {guidanceShort !== guidance && (
                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-micro text-l4 hover:text-l2">
                        怎么做
                      </summary>
                      <p className="mt-0.5 whitespace-pre-wrap text-l3">
                        {guidance}
                      </p>
                    </details>
                  )}
                </>
              )}
              {isSpotCheckTaskTitle(human.title) && !node.done && (
                <SpotCheckPicks roots={ws ? [ws.worktreePath, projectPath] : [projectPath]} />
              )}
              {/* 付费墙：清单就是入口。折叠标题带缺篇数；做法进行内按钮 title，
                  不再在清单上下各写一段说明书。 */}
              {isPaywallTaskTitle(human.title) && !node.done && (
                <div className="mt-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void togglePaywallList()}
                    aria-expanded={paywallListOpen}
                    className="flex items-center gap-1 text-xs text-l3 hover:text-l1"
                    title="agent 筛完列出的缺全文清单"
                  >
                    <FoldMark open={paywallListOpen} />
                    {paywallListOpen
                      ? `待获取${paywallList.from ? ` · ${paywallList.from}` : ""}`
                      : paywallList.text
                        ? `待获取（还缺 ${missingToFetchCount(paywallList.text, toFetchDone)} 篇）`
                        : "待获取"}
                  </button>
                  </div>
                  {paywallListOpen && (
                    <div ref={paywallDropRef} className="mt-1">
                      {instLoggedIn ? (
                        <span
                          className="mb-1 inline-flex rounded-sm border border-done/40 px-1.5 py-0.5 text-xs text-done"
                          title="学校账号会话已保存。清单里点官网即可下载。"
                        >
                          已登录
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setSettingsSectionReq("network");
                            setPage("settings");
                          }}
                          className="mb-1 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1"
                          title="打开设置 → 网络，登录学校账号。登录一次后，清单里点官网即可下载"
                        >
                          登录学校账号
                        </button>
                      )}
                      {dropNote && <p className="mb-1 text-micro text-l3">{dropNote}</p>}
                      {paywallList.error ? (
                        <p className="text-micro text-l4">
                          {paywallList.error}
                        </p>
                      ) : paywallList.text == null ? (
                        <p className="text-micro text-l4">加载中…</p>
                      ) : (
                        <>
                          {browserOpenErr && (
                            <p
                              className="mb-1 break-words text-micro text-err-text"
                              role="alert"
                            >
                              {browserOpenErr}
                            </p>
                          )}
                          {paywallMetricsLoading && (
                            <p className="mb-1 text-micro text-l4">正在按 DOI 补期刊名，影响因子稍后出现。</p>
                          )}
                          {toFetchItems.length > 0 ? (
                            <ul
                              ref={toFetchListRef}
                              className="max-h-72 space-y-0.5 overflow-auto px-0.5 py-px"
                              onScroll={(e) =>
                                writeToFetchScroll(
                                  projectPath,
                                  e.currentTarget.scrollTop,
                                )
                              }
                            >
                              {toFetchItems.map((item) => {
                                const st = toFetchBusy[item.line];
                                const doneName = toFetchDone[item.line];
                                const done = item.done || !!doneName;
                                const spotlight = browserSpotlight === item.line;
                                return (
                                  <li
                                    key={item.line}
                                    data-to-fetch-line={item.line}
                                    className={`flex min-w-0 flex-wrap items-center gap-1 rounded-md px-1 py-0.5 ${
                                      spotlight
                                        ? "bg-cta/10 ring-1 ring-inset ring-cta-bd"
                                        : "hover:bg-hover"
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      className={`min-w-0 flex-1 truncate text-left text-xs ${
                                        doneName
                                          ? "text-l4 line-through hover:text-l2"
                                          : "text-l2 hover:text-l1"
                                      }`}
                                      title={
                                        doneName
                                          ? `在文件页打开 papers/${doneName}`
                                          : item.url
                                            ? "用右侧「官网」打开这篇的出版商页面"
                                            : item.title
                                      }
                                      onClick={() => {
                                        focusToFetchLine(item.line);
                                        if (doneName) {
                                          const rel = toFetchPaperRel(doneName);
                                          if (!rel) return;
                                          setFilePreviewReq({
                                            projectRoot: projectPath,
                                            path: absoluteResourcePath(
                                              projectPath,
                                              rel,
                                            ),
                                            token: Date.now(),
                                          });
                                        }
                                      }}
                                    >
                                      {displayCitationTitle(item.title)}
                                    </button>
                                    <JournalPills metric={paywallMetrics.get(item.line)} />
                                    {done ? (
                                      <span
                                        className={`shrink-0 text-micro ${doneName ? "text-done" : "text-l4"}`}
                                        title={
                                          doneName
                                            ? `点标题打开 papers/${doneName}`
                                            : undefined
                                        }
                                      >
                                        {doneName ? "✓ 已存" : "✓ 已勾"}
                                      </span>
                                    ) : (
                                      <span className="flex shrink-0 items-center">
                                        {item.url && (
                                          <PublisherOpenButton
                                            url={item.url}
                                            title={item.title}
                                            projectPath={projectPath}
                                            onOpened={() => focusToFetchLine(item.line)}
                                            onError={(message) => setBrowserOpenErr(message || null)}
                                          />
                                        )}
                                        <button
                                          type="button"
                                          className={`${ghostActionClass} shrink-0`}
                                          disabled={st?.status === "busy"}
                                          title="选一个已下载的 PDF，按本行标题复制进 papers/（文件名随意）"
                                          onClick={() => void attachToFetchItem(item)}
                                        >
                                          {st?.status === "busy" ? "关联中…" : "关联"}
                                        </button>
                                      </span>
                                    )}
                                    {!done && st?.status === "ok" && (
                                      <span
                                        className="shrink-0 text-micro text-done"
                                        title={st.note}
                                      >
                                        ✓ 已存
                                      </span>
                                    )}
                                    {!done && st?.status === "error" && (
                                      <span
                                        className="shrink-0 max-w-[12rem] truncate text-micro text-err-text"
                                        title={st.note ?? ""}
                                      >
                                        {st.note}
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          ) : (
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-micro leading-5 text-l3">
                              {paywallList.text}
                            </pre>
                          )}
                        </>
                      )}
                      <div className="mt-1 flex min-w-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void openPapersDir()}
                          title="打开课题的 papers/。PDF 在这里；要挂附件，拖到 Zotero 或 EndNote 里对应的那条文献上"
                          className={`${ghostActionClass} shrink-0`}
                        >
                          打开 papers/
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
      </li>
    );
  }

  return (
    <div
      ref={containerRef}
      className={bare ? "" : "ccode-well rounded-md px-2.5 py-2"}
    >
      {/* 主干节点用左侧竖线串起来（连接线落在序号列正下方，1.5px 极淡）：
          没有连线时三个节点像三条独立的行，读不出「这是一条流程」 */}
      <ol className="relative space-y-3 before:absolute before:bottom-4 before:left-[7px] before:top-4 before:w-px before:bg-hairline before:content-['']">
        {flow.nodes
          .filter((n) => n.section === "main")
          .map((node) => renderNode(node, false))}
      </ol>
      {/* 可选补充：沉到分隔线下，与主干拉开层级——它们不做也能跑完这一步，
          和「定方向 / agent 执行 / 评审」平铺在一起会让人以为样样都得做 */}
      {flow.nodes.some((n) => n.section === "optional") && (
        <>
          <div className="mt-3 flex items-center gap-2">
            <span className="shrink-0 text-micro text-l4">可选</span>
            <span className="h-px min-w-0 flex-1 bg-hairline" />
          </div>
          <ol className="mt-1.5 space-y-1">
            {flow.nodes
              .filter((n) => n.section === "optional")
              .map((node) => renderNode(node, false))}
          </ol>
        </>
      )}
      {note && <p className="mt-1 pl-1 text-micro text-l3">{note}</p>}
      {registerOffer && (
        <RegisterOfferRow
          destRels={registerOffer.destRels}
          onRegister={() => void registerOffered()}
          onDismiss={dismissRegisterOffer}
          className="pl-1"
        />
      )}
      {error && <InlineNotice tone="err" size="micro" className="mt-1 pl-1">{error}</InlineNotice>}
      {/* TASK.md 就地编辑弹层：不跳终端页。背景点击在有未保存改动时会先确认 */}
      {draftEdit && (
        <div
          className="ccode-fade fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => void closeDraftInline()}
        >
          <div
            className="ccode-float-surface flex h-[70vh] w-full max-w-2xl flex-col rounded-md border border-field p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex shrink-0 items-baseline gap-2">
              <h2 className="shrink-0 text-base font-semibold text-l1">
                TASK.md：{step.name}
              </h2>
              <button
                type="button"
                onClick={() => setDraftPreview((v) => !v)}
                title={
                  draftPreview ? "回到编辑" : "看渲染后的排版（长文档好读）"
                }
                className="ml-auto shrink-0 self-center rounded-sm border border-field px-1.5 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
              >
                {draftPreview ? "编辑" : "预览"}
              </button>
            </div>
            {draftPreview ? (
              <div className="min-h-0 flex-1 overflow-auto rounded-md border border-field bg-canvas">
                <div
                  ref={draftHtmlRef}
                  className="md-body px-4 py-3"
                  dangerouslySetInnerHTML={{ __html: draftHtml }}
                />
              </div>
            ) : (
              <textarea
                value={draftEdit.text}
                onChange={(e) =>
                  setDraftEdit((s) => (s ? { ...s, text: e.target.value } : s))
                }
                spellCheck={false}
                className="min-h-0 flex-1 resize-none rounded-md border border-field bg-canvas p-3 font-mono text-xs leading-5 text-l2 outline-none focus:border-cta-bd"
              />
            )}
            <p className="mt-2 shrink-0 text-micro text-l4">
              {draftEdit.fromTemplate
                ? "当前是模板默认拼装，还没改过；保存后开工就以这份为准。"
                : "开工时这份内容将原样落成工作区的 TASK.md。"}
            </p>
            <div className="mt-3 flex shrink-0 items-center gap-2">
              {!draftEdit.fromTemplate && (
                <button
                  type="button"
                  onClick={() => {
                    setDraftEdit(null);
                    openDraft();
                  }}
                  title="改用终端页打开（要看改动对比或用编辑器时）"
                  className="rounded-sm px-2 py-1.5 text-micro text-l4 hover:bg-hover hover:text-l2"
                >
                  在终端里打开
                </button>
              )}
              {draftEdit.error && (
                <span className="min-w-0 flex-1 truncate text-micro text-err-text">
                  {draftEdit.error}
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void closeDraftInline()}
                  className={secondaryActionClass}
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={
                    draftEdit.saving || draftEdit.text === draftEdit.origin
                  }
                  onClick={() => void saveDraftInline()}
                  title={
                    draftEdit.text === draftEdit.origin
                      ? "没有改动"
                      : "保存为开工用的 TASK.md 内容"
                  }
                  className={primaryActionClass}
                >
                  {draftEdit.saving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
