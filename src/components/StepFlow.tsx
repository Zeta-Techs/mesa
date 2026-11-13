import CoachTip from "./CoachTip";
import { consultNudgeSeen, discussNudgeSeen, markConsultNudgeSeen, markDiscussNudgeSeen } from "../coach-tips";
import { discussOpeningPrompt, discussReuseKey } from "../discuss-prompt";
import { toast } from "../toast";
import { sanitizeDocumentHtml } from "../document-html";
import { useCallback, useRef, useState, useEffect, useLayoutEffect, useMemo } from "react";
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
import { stepStopTab } from "../run-overview";
import { IS_WINDOWS } from "../hotkeys";
import { samePath } from "../path-utils";
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
  LIBRARY_SYNC_ATTACH,
  LIBRARY_SYNC_NOTES_CAVEAT,
  missingToFetchCount,
  parseToFetchItems,
  recalledToFetchDone,
  rememberToFetchDone,
  toFetchPaperRel,
  toFetchSavedCount,
  type LibrarySyncAttach,
  type StepFlowNode,
  type ToFetchItem,
} from "../step-flow";
import { stepFillsAnySlot, useSkillProvides } from "../skill-slots.ts";
import {
  RESEARCH_TOOL_FIELDS,
  type ResearchToolField,
  type ResearchTools,
} from "../research-tools";
import { displayCitationTitle, parseIncludedRecords } from "../screening-review";
import { loadDraftProgress, outlineThinWithNotes, readResearchFile, readResearchLedger, searchCountLineWithFiles } from "../research-report-load";
import { stepKind } from "../step-kind";
import {
  excludedIncludedIds,
  figurePlan,
  figurePlanLine,
  notesProgress,
  notesProgressParts,
  outlineProgress,
  outlineProgressParts,
  spotCheckPicks,
  type SpotCheckPick,
} from "../notes-progress";
import { inlineDecisionListVisible, stepNodeAction, stepNodeReady } from "../step-node-actions.ts";
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
import { CARSI_URL, instOpenTarget, type FetchedFulltextDto } from "../inst-access";
import PendingConfirmList, { type PendingConfirmHandle } from "./PendingConfirmList";
import ReviewDecisionList from "./ReviewDecisionList";
import { DeclarationsForm, FigurePermissionsPanel } from "./HandbackPanels";
import ProjectFilePreview from "./ProjectFilePreview";
import { showProjectFile } from "../project-file-open";
import { handbackTask } from "../handback-tasks";
import {
  continueAfterDecisionsPrompt,
  isInlineDecisionTaskTitle,
  reviewItemKind,
} from "../review-decisions";
import type { ProjectStepDto, WorkspaceDto } from "../types";
import type { StepRunStatus } from "../step-flow";
import { pollEvery } from "../polling";

/** 步骤内协同流程线（v3.71，聚焦视图顶部）：把这一步里人和 Agent 的动作按先后排成有序节点链
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
        title="你自己下：在浏览器里打开这篇的出版商官网。点站方下载，或 PDF 在浏览器里打开后点保存、存进「下载」文件夹。PDF 里带本篇 DOI 的，30 分钟内存下都能收进 papers/。没收到就把文件拖进清单，或用「关联」"
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
        {waiting ? "等待下载…" : "官网"}
      </button>
      {waiting && (
        <button
          type="button"
          className={`${ghostActionClass} shrink-0`}
          title="这篇不下载了。不再等它，之后下载的 PDF 不会挂到这一行。"
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

/** 每步「AI 干活」统计行上次读到的分段（键 = 项目 + 步骤 + 读哪份）。只在本次打开 Mesa 内有效，不落盘 */
const agentProgressCache = new Map<string, string[]>();
const sameParts = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

/** 精读步「AI 干活」行下的进度（notes/index.json，工作区优先、项目根兜底）。
 *  Agent 分批写、中途提交后接着读：跑着时 20 秒重读一次，窗口回到前台也重读。 */
function NotesProgressLine({ roots, live, onChange }: { roots: string[]; live: boolean; onChange: (parts: string[] | null) => void }) {
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
          if (!stale) onChange(progress ? notesProgressParts(progress) : null);
          return;
        } catch {
          /* 这一处还没有索引，试下一处 */
        }
      }
      if (!stale) onChange(null);
    };
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const unpoll = live ? pollEvery(() => load(), 20000) : null;
    return () => {
      stale = true;
      window.removeEventListener("focus", onFocus);
      unpoll?.();
    };
  }, [rootsKey, live, onChange]);
  return null;
}

/** 检索 / 大纲步「AI 干活」行下的一行台账计数（同 NotesProgressLine：工作区优先、项目根兜底，跑着时 20 秒重读）。
 *  数字由 Mesa 从文件数，不靠 AI 自述（综述回路设计稿 §11/§12）。 */
function LedgerCountLine({
  roots,
  live,
  rel,
  line,
  read = readResearchLedger,
  refreshKey = "",
  onChange,
}: {
  roots: string[];
  live: boolean;
  rel: string;
  line: (text: string) => string[] | null | Promise<string[] | null>;
  onChange: (parts: string[] | null) => void;
  /** 台账白名单外的文件（outline.md）走只读预览通道：白名单同时管写回，不为计数放宽 */
  read?: (root: string, rel: string) => Promise<{ text: string; truncated: boolean }>;
  /** 变了就重读（大纲那行：上游保存后要跟着变） */
  refreshKey?: string;
}) {
  const rootsKey = roots.join("\n");
  const lineRef = useRef(line);
  lineRef.current = line;
  useEffect(() => {
    let stale = false;
    const load = async () => {
      for (const root of rootsKey.split("\n")) {
        try {
          const file = await read(root, rel);
          if (file.truncated) continue;
          const out = await lineRef.current(file.text);
          if (!stale) onChange(out);
          return;
        } catch {
          /* 这一处还没有这份文件，试下一处 */
        }
      }
      if (!stale) onChange(null);
    };
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const unpoll = live ? pollEvery(() => load(), 20000) : null;
    return () => {
      stale = true;
      window.removeEventListener("focus", onFocus);
      unpoll?.();
    };
  }, [rootsKey, live, rel, read, refreshKey, onChange]);
  return null;
}

/** 初稿步「AI 干活」行下的统计（同 LedgerCountLine：工作区优先、项目根兜底，跑着时 20 秒重读）。
 *  主稿要先列 manuscript/ 才挑得出，不走单文件的 LedgerCountLine */
function DraftProgressLine({ roots, artifacts, live, onChange }: { roots: string[]; artifacts: readonly string[]; live: boolean; onChange: (parts: string[] | null) => void }) {
  const rootsKey = roots.join("\n");
  const artifactsKey = artifacts.join("\n");
  useEffect(() => {
    let stale = false;
    const load = async () => {
      const parts = await loadDraftProgress(rootsKey.split("\n"), artifactsKey ? artifactsKey.split("\n") : []).catch(() => null);
      if (!stale) onChange(parts);
    };
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const unpoll = live ? pollEvery(() => load(), 20000) : null;
    return () => {
      stale = true;
      window.removeEventListener("focus", onFocus);
      unpoll?.();
    };
  }, [rootsKey, artifactsKey, live, onChange]);
  return null;
}

/** 大纲一行：定框架几问、薄几节（综述回路三期）+ 用图计划。薄节由大纲判，补料到没到由 Mesa 按笔记索引数
 *  （工作副本与项目根都读：精读保存进项目后这里立刻变，不等大纲那一步并入） */
const outlineCountLine = (roots: readonly string[]) => async (text: string) => {
  const o = outlineProgress(text);
  const p = figurePlan(text);
  const thin = await outlineThinWithNotes(roots, text).catch(() => null);
  const parts = [
    ...(o ? (thin ? outlineProgressParts({ ...o, thin: thin.thin }, thin.arrived) : outlineProgressParts(o)) : []),
    ...(p ? [figurePlanLine(p)] : []),
  ];
  return parts.length ? parts : null;
};

/** 「抽查 3 篇笔记」就地给出三篇候选（notes/index.json，工作区优先、项目根兜底）：
 *  点一篇直接盖上阅读区的核对档（笔记｜原文），三篇在里面切，退出回流程页（2026-10-23）。 */
function SpotCheckPicks({
  projectPath,
  ws,
  stepName,
  taskTitle,
  refreshKey,
  hint,
}: {
  projectPath: string;
  ws: WorkspaceDto | undefined;
  stepName: string;
  taskTitle: string;
  /** 怎么抽查的说明：挂在这一行的悬停上，不在行下另写一段（2026-11-11 项目页减法） */
  hint?: string;
  /** 步骤状态变了就重读：挂载时索引还没写出来、补读一轮后换了篇，都要跟上（2026-11-05 排查） */
  refreshKey: string;
}) {
  const setReaderReq = useAppStore((s) => s.setReaderReq);
  const setPage = useAppStore((s) => s.setPage);
  const [picks, setPicks] = useState<{ root: string; items: SpotCheckPick[] } | null>(null);
  const roots = ws ? [ws.worktreePath, projectPath] : [projectPath];
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
  }, [rootsKey, refreshKey]);
  if (!picks) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1" title={hint}>
      {picks.items.map((pick, index) => {
        const rel = pick.notePath.replace(/\\/g, "/");
        const name = rel.split("/").pop() ?? rel;
        return (
          <button
            key={pick.notePath}
            type="button"
            className="inline-flex max-w-[16rem] items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1"
            title={`对照原文看 ${rel}`}
            onClick={() => {
              setReaderReq({
                pdfPath: "",
                projectRoot: projectPath,
                spotCheck: {
                  projectRoot: projectPath,
                  base: picks.root,
                  stepName,
                  taskTitle,
                  // 索引读自项目根（已保存进项目）就没有可交回的对话
                  ws: ws && picks.root === ws.worktreePath ? ws : null,
                  items: picks.items,
                  index,
                },
              });
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
const PENDING_DONE_HINT =
  "待确认都定了，这一项已自动勾上。已纳入的仍可移出：移出会从纳入清单、待获取和两份 RIS 里拿掉，已写的笔记和引文留着，要到精读那一步清。";

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
    label: "让 Agent 检索",
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
  openSeeds,
  onStart,
  onReadPaper,
  readPaperPrimary = false,
  onChanged,
  draft,
  agentContent,
  loopActions,
  onRestore,
  reviewConflict,
  nudge,
  onDraftChanged,
  onSeedDraft,
  draftLoadError,
  onLoadTaskMd,
  discussed = false,
  discussResume = null,
  discussContent,
  discussInline,
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
  onContinueFresh,
  stepIndex,
}: {
  projectPath: string;
  step: ProjectStepDto;
  /** 第几步（1 起）：商量的标签带上它，侧栏在会话认出来前就把标签挂到「④ 这一步」下面 */
  stepIndex?: number;
  runStatus: StepRunStatus;
  /** 本步骤任务书草稿已起草（discuss 节点完成口径） */
  hasDraft: boolean;
  /** 本步骤绑定的活跃工作区（无 = 未开始） */
  ws: WorkspaceDto | undefined;
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
  /** discuss 节点内嵌内容：只剩老话题卡（kind=idea）的清单，新话题 2026-11-11 起不再新建 */
  discussContent?: React.ReactNode;
  /** 跟在「继续讨论 · TASK.md」同一行的入口（「请几家研讨」，2026-11-11 项目页减法：同类入口不另占一行） */
  discussInline?: React.ReactNode;
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
  /** agent 节点内嵌内容（如「预览 TASK.md」——TASK.md 是 Agent 的合同，属于这个节点） */
  agentContent?: React.ReactNode;
  /** 「AI 干活」下一行的回路动作：跟进更新、补读、补文献 / 退回上一步修改（design-review-loop.md §4/§5），
   *  「这一步做过 N 轮」（§6）也排在这一行（2026-11-11 项目页减法） */
  loopActions?: React.ReactNode;
  /** 步骤工作区已归档时 Agent 节点的主入口（替代「开始」）：恢复工作区 */
  onRestore?: () => void;
  /** 合并冲突阻塞：评审节点入口改为「去处理冲突」（直达冲突解决意图） */
  reviewConflict?: boolean;
  /** 「AI 干活」下第一行的下一步提示（2026-11-11 用户：新用户看不出要点「跟进更新」）：一句发生了什么 + 唯一一颗强调色按钮；
   *  有它时「去评审」降成线框，一屏只剩一个强调色主动作（step-panel R6） */
  nudge?: { text: string; action: React.ReactNode } | null;
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
  /** 有能接回的上次对话时才给：不接原对话，新开一个会话从任务书读起 */
  onContinueFresh?: () => void;
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
  // 「停下」关的是这一步工作区里还开着的 AI 标签（同侧栏「关掉这段对话」，在干活的会先问）
  const stopTabId = useAppStore((s) => stepStopTab(ws ?? undefined, s.terminalRunInputs, IS_WINDOWS));
  const requestCloseTab = useAppStore((s) => s.requestCloseTab);
  // 给后面步骤用的台账（待确认清单、待获取、计数、抽查选篇）读写哪一份：这一步已保存进项目就以项目根为准。
  // 原先保存后仍先读写工作副本那份旧的——后面步骤改过的看不到，回头在这里改的也永远进不了项目（2026-11-05 排查）。
  // 要交回这一步 AI 接着做的（逐条决定、许可 / 声明、引用样式）仍走工作副本：AI 在那里接着干活
  const dataWs = runStatus === "done" ? undefined : ws;
  // 分段：首段放标题旁，其余进明细行；由取数函数直接分好，改计数文案不会把标题和明细拆错
  // 换步骤时整张卡按 key 重新挂载，计数要等异步读完台账：先空着再补一行，工具行会被往下推一下（2026-11-13 用户：切步骤小字抖）。
  // 记住每步上次读到的分段，挂载时直接画出来，读完有变化才换
  const progressKey = `${projectPath}\n${step.name}\n${dataWs?.worktreePath ?? ""}\n${!!ws || runStatus === "done"}`;
  const [progressState, setProgressState] = useState(() => ({ key: progressKey, parts: agentProgressCache.get(progressKey) ?? null }));
  const agentProgress = progressState.key === progressKey ? progressState.parts : agentProgressCache.get(progressKey) ?? null;
  const setAgentProgress = useCallback((parts: string[] | null) => {
    if (parts) agentProgressCache.set(progressKey, parts);
    else agentProgressCache.delete(progressKey);
    setProgressState((prev) =>
      prev.key === progressKey && sameParts(prev.parts, parts) ? prev : { key: progressKey, parts },
    );
  }, [progressKey]);
  const [progressHeadline, ...progressDetails] = agentProgress ?? [];
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const setPage = useAppStore((s) => s.setPage);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const setPendingMcpPreset = useAppStore((s) => s.setPendingMcpPreset);
  const setFilePreviewReq = useAppStore((s) => s.setFilePreviewReq);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const setSettingsSectionReq = useAppStore((s) => s.setSettingsSectionReq);
  // 这一步的工作副本里 AI 问了还没处理完的（2026-11-02）：动作前面给「回答问题」，点了弹全局卡片
  const asking = useAppStore((s) => (ws ? (s.helpPending[ws.worktreePath] ?? 0) : 0));
  const setHelpViewReq = useAppStore((s) => s.setHelpViewReq);

  /** 已经有文献库的项目：落点在 papers/ 的事项不该再劝人把 PDF 往项目里塞——
   *  文献的唯一出处是那个库，往 papers/ 另放一份之后两边各自漂移。
   *  只影响文案与按钮，不改事项本身的完成口径（落点检测照旧）。
   *  这个判断随动作一起在 step-node-actions.ts 里算（descriptor 带 hasLibrary），
   *  这里不再留第二份。 */
  /** after 档事项的就绪口径与压暗口径**同一出处**（见 step-node-actions.ts）：
   *  分叉就会出现「压暗的行里躺着可点的按钮」 */
  const afterReady = (h: { expectedCount?: number }) =>
    stepNodeReady(runStatus, agentAttention, h);
  /** 「核对待确认篇目」开工后就挂清单（检索中途写出的待确认也能先点）；没开工时还没有清单，同其他收尾事项一样压暗（2026-11-09 HER 实测） */
  const pendingRowLive = runStatus !== "pending";

  // ===== 决策项（可枚举的拍板点）：点一下就答完，不开会话 =====
  // 答案存在草稿的「已定方向」小节里（草稿是开工合同，不另立一份状态），选中态由它回填
  const decisions = step.decisions ?? [];
  const answered = parseDecisions(draft?.text ?? "");
  /** 已有编辑内容（v3.90：UI 不再暴露「草稿」概念）= 文件有可执行正文；
      仅含已定方向 / 评审沉淀 / 标题的不算——那不是编辑过的 TASK.md */
  const draftHasBody =
    !!draft?.text?.trim() && !isTaskMdStub(draft.text ?? "");
  const taskMdBtnClass = `shrink-0 font-mono text-micro underline-offset-2 hover:underline disabled:opacity-50 ${
    draftHasBody ? "text-cta-pill-text" : "text-l3 hover:text-l1"
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
  // 开工后「先定几件事」收成一行；点「更改」才摊开（同「确定文献来源」的 litSourceEditing）
  const [settleEditing, setSettleEditing] = useState(false);
  // 开工后「稿件载体 / 实验方式」同样收成一行，点「更改」才摊开选项（记的是节点 key）
  const [toolEditing, setToolEditing] = useState<string | null>(null);
  const [writeOwn, setWriteOwn] = useState<{
    q: string;
    text: string;
    status: DecisionStatus | "";
  } | null>(null);
  // 草稿弹层的呈现方式：编辑（textarea，主用途）/ 预览（渲染 markdown，长草稿好读）
  const [draftPreview, setDraftPreview] = useState(false);

  /** 落盘一批答案：读-改-写整份草稿（write_task_draft 是整份覆盖），
   *  批量入参让「全部用推荐值」只写一次，也少一次与 Agent 并发改草稿的窗口 */
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
  /** 「打开清单 / 打开填写」展开的是哪一行（按事项标题） */
  const [editOpen, setEditOpen] = useState<string | null>(null);
  const [handbackNote, setHandbackNote] = useState<{ title: string; text: string } | null>(null);
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
  // 首次点开才读文件，收起不清缓存；这一步的运行状态变了（退回修改后 agent 在同一工作区
  // 又跑一轮）就重读——项目页常驻不卸载，不重读会一直显示上一轮的清单。
  // 位置口径：agent 的产出落在步骤工作区，评审合并后才进项目根——先读工作区再回落项目根
  const [pendingListOpen, setPendingListOpen] = useState(true);
  // 开工后「确定文献来源」收成一行；点「更改」才摊开选项
  const [litSourceEditing, setLitSourceEditing] = useState(false);
  // 进来时「核对待确认篇目」已经做完：文献清单先收起（回看不铺一长串）；当场清完的保持展开，画面不跳
  const pendingFoldInit = useRef(false);
  useEffect(() => {
    if (pendingFoldInit.current || !states) return;
    pendingFoldInit.current = true;
    if (states.some((s) => isPendingConfirmTaskTitle(s.title) && s.done)) setPendingListOpen(false);
  }, [states]);
  const pendingListRef = useRef<PendingConfirmHandle>(null);
  const [pendingMeta, setPendingMeta] = useState({ count: 0, busy: false });
  const pendingSettled =
    pendingMeta.count === 0 && (states ?? []).some((s) => isPendingConfirmTaskTitle(s.title) && s.done);
  /** 文献清单与待获取跟着这一步的运行状态重读（与 ReviewDecisionList 同口径） */
  const ledgerRefreshKey = `${runStatus}|${agentAttention ?? ""}`;
  const ledgerKeySeen = useRef(ledgerRefreshKey);
  useEffect(() => {
    if (ledgerKeySeen.current === ledgerRefreshKey) return;
    ledgerKeySeen.current = ledgerRefreshKey;
    if (paywallList.text != null || paywallList.error) void loadPaywallList();
    // 收起的文献清单：新一轮补进了待确认篇目就摊开，不让人以为没补上
    if (pendingListOpen || !dataWs) return;
    if (!(step.humanTasks ?? []).some((task) => isPendingConfirmTaskTitle(task.title))) return;
    let stale = false;
    void (async () => {
      for (const root of [dataWs.worktreePath, projectPath]) {
        try {
          const file = await readResearchLedger(root, "papers/included.json");
          if (stale || file.truncated) return;
          if (parseIncludedRecords(file.text).some((row) => row.decision === "pending")) {
            setPendingListOpen(true);
          }
          return;
        } catch {
          // 试下一个位置
        }
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerRefreshKey]);
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
  /** 同步到文献库导入哪些：只导条目 / 带 PDF / 带 PDF 和笔记，默认只导条目 */
  const [syncAttach, setSyncAttach] = useState<LibrarySyncAttach>("items");
  const [endnoteSyncResult, setEndnoteSyncResult] = useState<string | null>(null);
  /** 人指定的 EndNote 库（papers/endnote-library.path 那一行）。undefined = 还没读；null = 没指定 */
  const [endnoteLib, setEndnoteLib] = useState<
    { path: string | null; revision: string; legacy?: boolean } | undefined
  >(undefined);
  const [endnoteLibNote, setEndnoteLibNote] = useState<string | null>(null);
  /** 「选这个 EndNote 库」展开的候选：EndNote 最近打开过的库，加文稿 / 桌面里的 .enl */
  const [endnoteChoices, setEndnoteChoices] = useState<
    { path: string; name: string; recent: boolean; legacy: boolean }[] | null
  >(null);
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
  const [instLoginErr, setInstLoginErr] = useState<string | null>(null);
  const appSettings = useAppStore((s) => s.settings);
  // 学校访问方式（设置 → 网络「学校图书馆」）；老设置没选过：填了校外访问链接按 proxy
  const instAccess = appSettings?.institutionalAccess ?? ((appSettings?.institutionalPrefix ?? "").trim() ? "proxy" : "campus");
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
    return pollEvery(() => refreshToFetchProgress(), 2000);
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
        attach: syncAttach,
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

  // EndNote 在 Word 里只认库里的记录号：同步把题录导进了「当前打开的库」，可 Mesa 不知道那是哪个 .enl。
  // 人在这里指一次，后面定稿出的 EndNote 版 Word 就按这个库绑记录号，在 Word 里点 Update 即和库里条目对上
  // （2026-10-24 用户：精读那步同步过，后续域稿应该直接关联好）。Zotero 不用指：脚本直接读默认数据目录。
  /** 这一步有「同步到文献库」那一行（三套模板的初稿、期刊格式、投稿材料、返修）。
   *  2026-11-10 从精读挪到初稿：大纲后还会补文献，初稿保存后清单才基本定；定稿出的两份域稿要库里每篇恰好一条，
   *  所以在定稿开工前同步一次（每次同步都是整份导入，早同步、多同步只会多出重复条目） */
  const endnoteStep =
    step.workspaceName === "draft" ||
    step.workspaceName === "paper-draft" ||
    step.workspaceName === "thesis-draft" ||
    step.workspaceName === "journal-format" ||
    step.workspaceName === "submission-materials" ||
    /^rebuttal-r\d+$/.test(step.workspaceName ?? "");
  useEffect(() => {
    if (!endnoteStep) return;
    let stale = false;
    readResearchFile(projectPath, "papers/endnote-library.path")
      .then((file) => {
        if (stale) return;
        const line = file.text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("#"));
        setEndnoteLib({ path: line ?? null, revision: file.revision ?? "new" });
        if (line) {
          void invoke<boolean>("endnote_library_legacy", { path: line })
            .then((legacy) => !stale && setEndnoteLib((cur) => (cur && cur.path === line ? { ...cur, legacy } : cur)))
            .catch(() => {});
        }
      })
      .catch(() => !stale && setEndnoteLib({ path: null, revision: "new" }));
    return () => {
      stale = true;
    };
  }, [projectPath, endnoteStep]);

  /** 先列 EndNote 最近打开过的库让人点一个（文件对话框里 .enl 旁边有同名 .Data 文件夹，容易点进文件夹）；
   *  一个都没找到才直接开对话框 */
  async function pickEndnoteLibrary() {
    setEndnoteLibNote(null);
    if (endnoteChoices) {
      setEndnoteChoices(null);
      return;
    }
    const found = await invoke<{ path: string; name: string; recent: boolean; legacy: boolean }[]>(
      "endnote_library_choices",
    ).catch(() => []);
    if (found.length > 0) {
      setEndnoteChoices(found);
      return;
    }
    await browseEndnoteLibrary();
  }

  async function browseEndnoteLibrary() {
    const selected = await openFileDialog({
      multiple: false,
      title: "选 EndNote 库：选 .enl 文件（不是旁边同名的 .Data 文件夹），或从 EndNote 导出的 .xml",
      filters: [{ name: "EndNote 库或导出的 XML", extensions: ["enl", "xml"] }],
    });
    if (!selected || typeof selected !== "string") return;
    await saveEndnoteLibrary(selected);
  }

  async function saveEndnoteLibrary(selected: string) {
    setEndnoteLibNote(null);
    try {
      const revision = await invoke<string>("save_file_preview", {
        path: `${projectPath.replace(/[\\/]+$/, "")}/papers/endnote-library.path`,
        root: projectPath,
        text: `${selected}\n`,
        expectedRevision: endnoteLib?.revision ?? "new",
      });
      const legacy = await invoke<boolean>("endnote_library_legacy", { path: selected }).catch(() => false);
      setEndnoteLib({ path: selected, revision, legacy });
      setEndnoteChoices(null);
    } catch (e) {
      setEndnoteLibNote(String(e));
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
        attach: syncAttach,
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


  /** 校外访问链接：在浏览器里打开它登录一次（登录状态在浏览器里，Mesa 不存） */
  async function openInstLogin() {
    setInstLoginErr(null);
    const url = (appSettings?.institutionalPrefix ?? "").trim();
    if (!url) {
      setSettingsSectionReq("network");
      setPage("settings");
      return;
    }
    try {
      await invoke("inst_browser_open", { url });
    } catch (e) {
      setInstLoginErr(String(e));
    }
  }


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
    const candidates = dataWs
      ? [
          {
            path: `${dataWs.worktreePath}/papers/to-fetch.md`,
            root: dataWs.worktreePath,
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

  /** 接回这一步对话时的连接预填：步骤绑定 > 商量 / 项目默认，与任务卡「继续」同一口径。
   *  不带时模型落到连接名单第一个（2026-10-24 HER 润色：Mesa 重启后接回，glm-5.3 换成了 glm-5.3-flash） */
  const resumeLaunch = stepSlotLaunch ?? projectLaunch ?? undefined;

  /** 这一步的文件放在哪：工作区还在用工作区（AI 写在那里，人改完 AI 接着用），否则用项目根 */
  const stepFileRoot = ws?.worktreePath ?? projectPath;

  /** 「交给 AI」：接回这一步原来的对话，把话发过去（同「让 Agent 按决定继续」） */
  async function handBack(title: string, target: string) {
    const task = handbackTask(title);
    if (!ws || !task) return;
    setHandbackNote(null);
    try {
      const req = await buildWorkspaceTerminalRequest(ws, task.prompt(target), {
        autoStart: true,
        resumeSession: true,
        stepLaunch: resumeLaunch,
      });
      setPendingTerminal(req);
      setPage("terminal");
    } catch (reason) {
      setHandbackNote({ title, text: String(reason) });
    }
  }

  /** 域稿用系统里的 Word 打开；没出这一份就说一声 */
  async function openFieldDoc(title: string, file: "endnote" | "zotero") {
    setHandbackNote(null);
    const roots = [...new Set([ws?.worktreePath, projectPath].filter((p): p is string => Boolean(p)))];
    for (const root of roots) {
      try {
        await invoke("open_in_system", { path: `${root.replace(/[\\/]+$/, "")}/output/${file}.docx`, root });
        return;
      } catch {
        /* 试下一处 */
      }
    }
    setHandbackNote({
      title,
      text:
        file === "endnote"
          ? "没有 EndNote 版（output/endnote.docx）：这一步没出。要用 EndNote，回对话让 AI 照出这一份。"
          : "没有 Zotero 版（output/zotero.docx）：这一步没出。",
    });
  }

  async function continueAfterDecisions(target: string, title: string) {
    const kind = reviewItemKind(title);
    if (!ws || !kind) return;
    setDecisionNote(null);
    try {
      const req = await buildWorkspaceTerminalRequest(
        ws,
        continueAfterDecisionsPrompt(target, kind),
        { autoStart: true, resumeSession: true, stepLaunch: resumeLaunch },
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
        { autoStart: true, resumeSession: true, stepLaunch: resumeLaunch },
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

  const [discussNudgeOpen, setDiscussNudgeOpen] = useState(() => !discussNudgeSeen(projectPath));
  const [consultNudgeOpen, setConsultNudgeOpen] = useState(() => !consultNudgeSeen(projectPath));
  useEffect(() => {
    setDiscussNudgeOpen(!discussNudgeSeen(projectPath));
    setConsultNudgeOpen(!consultNudgeSeen(projectPath));
  }, [projectPath]);
  /** 这一步有「请几家研讨」：气泡带研讨那一句，关掉时两笔都记；没有就只记商量（到第一个带研讨链接的步骤再出一次） */
  const nudgeWithConsult = Boolean(discussInline);
  function dismissDiscussNudge() {
    markDiscussNudgeSeen(projectPath);
    setDiscussNudgeOpen(false);
    if (nudgeWithConsult) {
      markConsultNudgeSeen(projectPath);
      setConsultNudgeOpen(false);
    }
  }
  const showDiscussNudge =
    (discussNudgeOpen || (nudgeWithConsult && consultNudgeOpen)) && Boolean(draft) && !ws && !discussed && !draftHasBody;

  /** topic：预置话题 / 决策项「开聊」带进来的问题（2026-11-11 话题收进商量：不再建话题卡，就这个问题开商量）。
   *  carry：研讨结论「带回商量」——照原路接回 / 新开商量，这段话放进聊天输入框、不发送，人改了再发 */
  async function chatDraft(topic?: string, carry?: string) {
    if (!draft || chatBusy) return;
    dismissDiscussNudge();
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
    // 对话管理页（⌘2）按步骤筛会漏掉它。
    // 已经商量过：接回那条会话（resume），不要再注入「先通读一遍」开场——那会另开一轮。
    const resume = discussResume;
    setPendingTerminal({
      cwd: resume?.cwd?.trim() || projectPath,
      extraEnv: {},
      title: `${step.name} · 任务书`,
      stepName: step.name,
      railStep: { name: step.name, index: stepIndex ?? null },
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
            // 接回后再送一句（TerminalPage：resume + initialPrompt = 接上后注入）
            ...(topic ? { initialPrompt: `接着聊这个问题：${topic}` } : {}),
          }
        : {
            initialPrompt:
              discussOpeningPrompt({
                stepName: step.name,
                relPath: draft.relPath,
                workspaceName: step.workspaceName,
                openSettings,
                seeds,
              }) + (topic ? `\n\n先从这个问题聊起：${topic}` : ""),
            ...(projectLaunch ?? {}),
            autoStart: Boolean(projectLaunch?.profileId),
          }),
      // 同一步骤的任务书讨论是同一个对话：再点切回已有标签；没有标签才按上面 resume / 新开会话
      reuseKey: discussReuseKey(projectPath, draft.relPath),
      ...(carry ? { composerInsert: carry, surface: "chat" as const } : {}),
    });
    setPage("terminal");
  }

  // 研讨结论「带回商量」（2026-11-11）：研讨页发请求、项目页聚焦到这一步后在这里接住。
  // 等草稿读到再消费（chatDraft 没有 draft 不开聊），用完清空；不是这一步的不动
  const carryReq = useAppStore((s) => s.discussCarryReq);
  useEffect(() => {
    if (!carryReq || !draft || chatBusy) return;
    if (carryReq.stepName !== step.name || !samePath(carryReq.projectRoot, projectPath, IS_WINDOWS)) return;
    useAppStore.getState().setDiscussCarryReq(null);
    void chatDraft(undefined, carryReq.text);
    // chatDraft 每次渲染重建，只按请求令牌与草稿就位翻转
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carryReq?.token, Boolean(draft), chatBusy, step.name, projectPath]);

  // 商量对话里点「开始」（2026-11-12）：项目页聚焦到这一步后在这里接住，走和右缘「开始」同一条路（开工确认弹层）。
  // 只有这一行此刻真给「开始」时才开；已经开工 / 要恢复工作区的只聚焦，按钮就在眼前
  const startReq = useAppStore((s) => s.stepStartReq);
  useEffect(() => {
    if (!startReq) return;
    if (startReq.stepName !== step.name || !samePath(startReq.projectRoot, projectPath, IS_WINDOWS)) return;
    useAppStore.getState().setStepStartReq(null);
    if (runStatus === "pending" && !onRestore) onStart();
    else toast(`「${step.name}」已经开过工了，接着看这一步的按钮`, "info");
    // onStart 每次渲染重建，只按请求令牌翻转
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startReq?.token, step.name, projectPath]);

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
  const searchStep = stepFillsAnySlot(step.skills, ["lit-search"], skillProvides);
  const outlineStep = stepFillsAnySlot(step.skills, ["review-framework"], skillProvides);
  const draftStep = stepKind(step, skillProvides) === "writing";
  const flow = buildStepFlow({
    step,
    states,
    hasDraft,
    runStatus,
    litSource,
    pendingDecisions: decisionGaps.length,
    toolAsks: toolAskFields.map((field) => ({ key: field.key, label: field.label })),
    endnoteExport: endnoteStep,
    continueNotes: notesStep,
    // 对话还开着、AI 不在出字也不在等确认：轮到人评审，当前节点落到「保存进项目」（与「去评审」露出同一口径）
    agentIdle: runStatus === "active" && agentAttention !== "working" && agentAttention !== "confirm",
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
      .filter((n) => n.section === "main" && n.kind !== "human" && !(n.skipCurrent && n.key !== "tool:manuscript" && n.key !== "tool:experiment"))
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
    // 已保存的步骤上 AI 还留着没答的问题：照样给「回答问题」（原先只挂在「去终端看看 / 去评审」旁边，done 时没入口）
    if (!action && node.kind === "agent" && runStatus === "done" && asking > 0 && ws) {
      return (
        <button
          type="button"
          onClick={() => setHelpViewReq(ws.worktreePath)}
          title="AI 在这一步写了要你拍板的问题，点开在卡片上选"
          className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover"
        >
          回答问题（{asking}）
        </button>
      );
    }
    if (!action) return null;
    const outline =
      "shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1";
    const primary =
      "shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-xs text-cta-text hover:brightness-110";
    const askBtn =
      asking > 0 && ws ? (
        <button
          type="button"
          onClick={() => setHelpViewReq(ws.worktreePath)}
          title="AI 在这一步写了要你拍板的问题，点开在卡片上选"
          className={primary}
        >
          回答问题（{asking}）
        </button>
      ) : null;
    switch (action.kind) {
      case "continue-notes":
        // 保存进项目之前不画灰按钮：行下那句「保存进项目后可用」已经说了（2026-11-11 项目页减法）
        if (!action.enabled) return null;
        return (
          <button
            type="button"
            onClick={openContinueNotes}
            title="到文件页打开 notes/，自己点要读的那篇"
            className={`ml-auto ${outline}`}
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
              title="导入 EndNote 当前打开的库；开着几个库时进最前面那个，同步前只开着要导入的那个"
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
      case "edit-handback": {
        const human = node.human!;
        const task = handbackTask(human.title)!;
        const open = editOpen === human.title;
        return (
          <span className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setEditOpen(open ? null : human.title)}
              aria-expanded={open}
              title={`在这一行下面展开 ${human.target}`}
              className={outline}
            >
              {open ? "收起" : task.open}
            </button>
            {ws && (
              <button
                type="button"
                onClick={() => void handBack(human.title, human.target ?? "")}
                title="回到这一步原来的对话，让 AI 按你改好的内容接着做"
                className={outline}
              >
                {task.handback}
              </button>
            )}
          </span>
        );
      }
      case "open-field-docs":
        return (
          <span className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void openFieldDoc(node.human!.title, "endnote")}
              title="用 Word 打开 output/endnote.docx，在 EndNote 选项卡点 Update Citations and Bibliography，再选样式"
              className={outline}
            >
              Word 打开 EndNote 版
            </button>
            <button
              type="button"
              onClick={() => void openFieldDoc(node.human!.title, "zotero")}
              title="用 Word 打开 output/zotero.docx，在 Zotero 选项卡点 Refresh，再选样式"
              className={outline}
            >
              Word 打开 Zotero 版
            </button>
          </span>
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
        // 这一行只留一个主入口。会话还在出字或等确认：回去看。AI 没在干活、但这一步的对话还开着：「回到对话」只切过去，
        // 不替人发话（2026-11-11 用户：AI 说完了再点继续，会往说完的对话里发「接着做到完成标准」）。
        // 对话已关：「继续」接回这一步上次的对话（同一家 Agent，2026-10-22），用这一步的绑定；「新开一轮」是次要出口。
        const live =
          agentAttention === "working" || agentAttention === "confirm";
        const idleOpen = !live && Boolean(stopTabId);
        return (
          <span className="flex shrink-0 items-center gap-1.5">
            {askBtn}
            {!live && onContinueStep && onContinueFresh && (
              <button
                type="button"
                onClick={onContinueFresh}
                title="不接上次的对话，新开一个会话从任务书读起（上次对话太长或跑偏时用）"
                className="shrink-0 rounded-sm px-1 text-xs text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
              >
                新开一轮
              </button>
            )}
            {live || idleOpen || !onContinueStep ? (
              <button
                type="button"
                onClick={goTerminal}
                title={
                  idleOpen
                    ? "这一步的对话还开着：切过去看 AI 说了什么，不替你发话；要它接着做或改哪里，在对话里说"
                    : "回到这一步正在进行的对话"
                }
                className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover"
              >
                {idleOpen ? "回到对话" : "去终端看看"}
              </button>
            ) : (
              <button
                type="button"
                onClick={onContinueStep}
                title={
                  onContinueFresh
                    ? "接回这一步上次的对话，用这一步绑定的配置，接着做到完成标准"
                    : "在这一步的工作区开新会话，用这一步绑定的配置，接着做到完成标准"
                }
                className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover"
              >
                继续
              </button>
            )}
            {stopTabId && (
              <button
                type="button"
                onClick={() => requestCloseTab(stopTabId)}
                title="停下这一步的 AI、收起对话；工作区文件和对话记录都在，之后点「继续」接回（正在干活时会先问你）"
                className="shrink-0 rounded-sm px-1 text-xs text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
              >
                停下
              </button>
            )}
          </span>
        );
      }
      case "back-to-chat":
        // 待评审（点了停下、或 AI 说完关了对话）：回到这一步干活的那段对话，和「去终端看看」同一条路，不替人发话。
        // 主路径仍是下面「去评审」（强调色）；在对话里改的照样回来评审、保存（2026-11-11 用户：放右边）
        return (
          <button
            type="button"
            onClick={goTerminal}
            title="回到这一步 AI 干活的那段对话，不替你发话。在对话里让它改的，改完照样去评审、保存；想留下修改记录，用评审里的「写意见退回修改」"
            className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover"
          >
            回到对话
          </button>
        );
      case "go-review":
        return (
          <span className="flex shrink-0 items-center gap-1.5">
            {askBtn}
            <button type="button" onClick={goReview} className={askBtn || nudge ? outline : primary}>
              {action.conflict ? "去处理冲突" : "去评审"}
            </button>
          </span>
        );
    }
  }

  /** 单个节点行（主干与可选区共用）：dense = 可选区的紧凑版（更小字号、不显示 hint） */
  const hasDiscussNode = flow.nodes.some((n) => n.kind === "discuss");
  // 商量组（继续讨论 · TASK.md · 方案研讨）：没开工时挂「先定几件事」，开工后跟到「AI 干活」下的工具行，
  // 与回头组用竖线隔开；四类步骤同一顺序（2026-11-13 步骤卡统一设计稿）
  const talkOnAgent = !hasDiscussNode || runStatus !== "pending";
  const talkGroup = (
    <div className="relative flex flex-wrap items-center gap-x-2.5 gap-y-1" data-step-tools="talk">
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
      {discussInline}
      {showDiscussNudge && (
        <CoachTip
          arrow="up"
          arrowAt={28}
          title="开始前，先跟 AI 聊几句？"
          onClose={dismissDiscussNudge}
          className="absolute top-full left-0 mt-2 w-80"
          actions={[
            { label: "先不了", onClick: dismissDiscussNudge },
            { label: "跟 AI 商量一下", onClick: () => void chatDraft() },
          ]}
        >
          AI 会一次问你一个问题，帮你把这一步想要什么说清楚，写进任务书；再点「开始」，做出来的东西更贴你的想法。
          {/* 研讨是可选的一步（2026-11-11 用户）：只在这一步有「请几家研讨」时补一句，不另起气泡、不放按钮 */}
          {nudgeWithConsult && (
            <p className="mt-1.5">商量完还有拿不准的判断，可以再点右边的「方案研讨」（可选），听几家 AI 各自的看法，认同的结论带回商量。</p>
          )}
        </CoachTip>
      )}
    </div>
  );

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
          !(isPendingConfirmTaskTitle(human.title) && pendingRowLive) &&
          !isInlineDecisionTaskTitle(human.title)
            ? "opacity-45"
            : ""
        }`}
      >
        <div className="flex items-center gap-2">
          {/* 人工事项行：复选框本身就是状态 + 控件，直接占序号那一列（2026-11-13 步骤卡统一设计稿：
              方框即节点标记，标题与「AI 干活」同一左缘）；ccode-well 底色盖住竖向连接线 */}
          {node.key === "endnote-export" || node.key === "continue-notes" || (node.kind === "human" && human) ? null : ic.cls === "is-done" ? (
            /* 完成态：中性亮灰空心小圆环——与大圆步进器同语言（实心=进行中、空心=已完成），
               与完成段链条同款 l2 亮灰；①②③ 也是空心圆族（2026-09-15 用户拍板不要绿色） */
            <span className="ccode-well relative z-10 flex w-4 shrink-0 items-center justify-center">
              <span className="block size-3 rounded-full border-[1.5px] border-l2" />
            </span>
          ) : (
            <span className={`ccode-well relative z-10 w-4 shrink-0 text-center text-sm ${ic.cls}`}>
              {ic.text}
            </span>
          )}
          {node.key === "endnote-export" ? (
            <Checkbox
              className="ccode-well relative z-10 shrink-0"
              checked={endnoteChecked}
              onChange={setEndnoteChecked}
              title="勾选 = 已经在 EndNote 里导入完"
            />
          ) : node.key === "continue-notes" ? (
            <Checkbox
              className="ccode-well relative z-10 shrink-0"
              checked={continueNotesChecked}
              onChange={setContinueNotesChecked}
              title="勾选 = 已经去笔记夹看过"
            />
          ) : node.kind === "human" && human ? (
            <Checkbox
              className="ccode-well relative z-10 shrink-0"
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
                  ? // 清单还没读到（没开工、AI 还没写出来）时不说「还有没决定的」，那时一条都还没有
                    decisionOpen.has(human.title)
                    ? `还有 ${decisionOpen.get(human.title)} 条没决定，逐条决定完才能勾`
                    : "等 AI 写出要你裁决的清单，逐条决定完才能勾"
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
            className={`min-w-0 ${node.kind === "agent" ? "" : "truncate"} ${
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
          ) : node.kind === "human" && human?.hitCount != null && !isCitationStyleTask(human.title) && !isInlineDecisionTaskTitle(human.title) && !handbackTask(human.title) ? (
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
          {/* 篇数、「可选」紧跟标题，按钮由这段空白推到右缘（2026-11-13 步骤卡统一设计稿 .line / .right） */}
          <span aria-hidden className="min-w-0 flex-1" />
          {nodeActions(node)}
        </div>
        {node.kind === "human" && isCitationStyleTask(human?.title) && ws && (
          <div className="ml-6 mt-1.5">
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
            {!node.done && !citeOpen && (
              <p className="mt-1 text-micro text-l4">
                现在是方括号编号 [1]。不换就勾掉这一行；想换就点一种，AI 回原对话重渲 PDF、Word 和带引用域的 Word。
              </p>
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
          <p className="mt-1 pl-6 text-micro leading-5 text-l4">
            {node.key === "endnote-export" && (zoteroSyncResult?.line || endnoteSyncResult)
              ? [zoteroSyncResult?.line, endnoteSyncResult].filter(Boolean).join(" ")
              : node.hint}
          </p>
        )}
        {!dense && node.key === "endnote-export" && runStatus === "done" && (
          <div className="mt-1 ml-6">
            <div className="flex flex-wrap items-center gap-1">
              {LIBRARY_SYNC_ATTACH.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  title={option.title}
                  aria-pressed={syncAttach === option.id}
                  onClick={() => setSyncAttach(option.id)}
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    syncAttach === option.id
                      ? "border border-cta-bd bg-cta-pill text-cta-pill-text"
                      : "bg-inset text-l3 hover:bg-hover hover:text-l1"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {syncAttach === "notes" && (
              <p className="mt-1 text-micro leading-5 text-l4">{LIBRARY_SYNC_NOTES_CAVEAT}</p>
            )}
          </div>
        )}
        {!dense && node.key === "endnote-export" && endnoteLib && (
          <p className="mt-0.5 pl-6 text-micro leading-5 text-l4">
            {endnoteLib.path ? (
              <>
                EndNote 库：
                <span className="text-l3" title={endnoteLib.path}>
                  {endnoteLib.path.split(/[\\/]/).pop()}
                </span>
                {endnoteLib.legacy ? (
                  <>
                    。这是 EndNote X9 及更早版本的库，Mesa 读不到里面的记录，Word 只能对上一部分条目。在 EndNote 里打开这个库，File → Export，「保存类型」选 XML，存到项目的 papers 文件夹，再
                    <button type="button" onClick={() => void browseEndnoteLibrary()} className="mx-1 rounded-sm bg-inset px-1.5 py-0.5 text-l2 hover:bg-hover hover:text-l1">
                      选导出的 XML
                    </button>
                    ，然后回定稿对话让 AI 重出 EndNote 版。
                  </>
                ) : (
                  "。定稿出的 EndNote 版 Word 按它对上库里的条目，在 Word 里点 Update 即可。"
                )}
                <button type="button" onClick={() => void pickEndnoteLibrary()} className="ml-1 rounded-sm px-1 text-l3 hover:bg-hover hover:text-l1">
                  换一个
                </button>
              </>
            ) : (
              <>
                用 EndNote 的话，导入后
                <button type="button" onClick={() => void pickEndnoteLibrary()} className="mx-1 rounded-sm bg-inset px-1.5 py-0.5 text-l2 hover:bg-hover hover:text-l1">
                  选这个 EndNote 库（.enl）
                </button>
                ：定稿出的 EndNote 版 Word 才能和库里的条目对上。不选也能用，只是条目只在这份 Word 文件自带的漫游库里，不连着你的库。Zotero 不用选。
              </>
            )}
            {endnoteLibNote && <span className="ml-1 text-err-text">{endnoteLibNote}</span>}
          </p>
        )}
        {!dense && node.key === "endnote-export" && endnoteChoices && (
          <div className="mt-1 ml-6 flex flex-wrap items-center gap-1">
            <span className="text-micro text-l4">选你导入题录的那个库：</span>
            {endnoteChoices.map((choice) => (
              <button
                key={choice.path}
                type="button"
                onClick={() => void saveEndnoteLibrary(choice.path)}
                title={choice.path}
                className="rounded-sm bg-inset px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1"
              >
                {choice.name}
                <span className="ml-1 text-micro text-l4">
                  {choice.path.split(/[\\/]/).slice(-2, -1)[0]}
                  {choice.recent ? " · 最近打开" : ""}
                  {choice.legacy ? " · X9 库，需导出 XML" : ""}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => void browseEndnoteLibrary()}
              className="rounded-sm px-1.5 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
            >
              从别处选…
            </button>
          </div>
        )}
        {node.kind === "input" && node.key.startsWith("tool:") && onSetResearchTool && tools && (
          <div className="ml-6 mt-2.5">
            {node.section === "main" && runStatus !== "pending" && toolEditing !== node.key ? (
              // 开工后收成一行（2026-11-13 步骤卡统一设计稿，同「确定文献来源」）：这一轮已按当时的写法开工，
              // 再点会改档案卡，正在跑的 AI 看不到——不摆成随手可点
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="text-l3">
                  {RESEARCH_TOOL_FIELDS.find((field) => `tool:${field.key}` === node.key)?.options.find(
                    ([key]) => key === tools[node.key.slice(5) as ResearchToolField["key"]],
                  )?.[1] ?? ""}
                </span>
                <button
                  type="button"
                  onClick={() => setToolEditing(node.key)}
                  className="rounded-sm px-1 py-0.5 text-micro text-l4 underline decoration-dotted underline-offset-2 hover:bg-hover hover:text-l2"
                  title="这一轮已按这个写法开工；改了要下次重新开工这一步才生效"
                >
                  更改
                </button>
              </div>
            ) : (
            <>
            {node.section === "main" && runStatus !== "pending" && (
              <p className="mb-1 text-micro text-l4">
                这一轮已经按当时的写法开工。改了只写进项目设置，工作区里的任务书不变，「继续」「新开一轮」的 AI 都看不到；下次重新开工这一步才生效。
                <button
                  type="button"
                  onClick={() => setToolEditing(null)}
                  className="ml-1 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                >
                  不改了
                </button>
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {(RESEARCH_TOOL_FIELDS.find((field) => `tool:${field.key}` === node.key)?.options ?? []).map(([key, label]) => {
                const on = tools[node.key.slice(5) as ResearchToolField["key"]] === key;
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={toolBusy}
                    onClick={() =>
                      void Promise.resolve(onSetResearchTool(node.key.slice(5) as ResearchToolField["key"], key)).then(() => setToolEditing(null))
                    }
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
            </>
            )}
          </div>
        )}
        {node.kind === "input" && node.key === "input" && onSetLitSource && (
          // pl-6 与其余内容区（hint/agentContent）对齐到步骤名左缘，不顶到序号
          <div className="ml-6 mt-2.5">
            {runStatus !== "pending" && !litSourceEditing ? (
              // 开工后收成一行（2026-10-22）：这一轮的任务书已按当时的来源写好，
              // 再点选项会改主仓档案卡与任务书草稿，正在跑的 Agent 看不到——不能摆成随手可点
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="text-l3">
                  {(LIT_SOURCES.find((o) => o.id === (litSource || "search")) ?? LIT_SOURCES[0]).label}
                </span>
                <button
                  type="button"
                  onClick={() => setLitSourceEditing(true)}
                  className="rounded-sm px-1 py-0.5 text-micro text-l4 underline decoration-dotted underline-offset-2 hover:bg-hover hover:text-l2"
                  title="这一轮已按这个来源开工；改了要下次重新开工这一步才生效"
                >
                  更改
                </button>
              </div>
            ) : (
            <>
            {runStatus !== "pending" && (
              <p className="mb-1 text-micro text-l4">
                这一轮已经按「{(LIT_SOURCES.find((o) => o.id === (litSource || "search")) ?? LIT_SOURCES[0]).label}」开工。改了只写进项目设置和任务书草稿，
                工作区里的任务书不变，「继续」「新开一轮」的 AI 都看不到；下次重新开工这一步才按新来源。
                <button
                  type="button"
                  onClick={() => setLitSourceEditing(false)}
                  className="ml-1 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                >
                  不改了
                </button>
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {LIT_SOURCES.map((o) => {
                const on = (litSource || "search") === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    disabled={litBusy}
                    onClick={() =>
                      void Promise.resolve(onSetLitSource(o.id)).then(() => setLitSourceEditing(false))
                    }
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
            </>
            )}
          </div>
        )}
        {node.kind === "agent" && nudge && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6" role="note">
            <span aria-hidden="true" className="h-[3px] w-2.5 shrink-0 rounded-sm bg-mesa-amber" />
            <span className="min-w-0 text-xs text-l1">{nudge.text}</span>
            {nudge.action}
          </div>
        )}
        {/* 想法区与「跟 AI 商量」：discuss 节点存在时挂它，否则挂 Agent 节点（v3.89）——
            内容一字未动，只是换了落点，避免节点被隐藏时这些入口一起消失 */}
        {node.kind === "discuss" && runStatus !== "pending" && !settleEditing && (
          // 开工后收成一行灰字（2026-11-13 步骤卡统一设计稿，同「确定文献来源」）：这一轮的任务书已按当时写好，
          // 再改只进草稿、正在跑的 AI 看不到——不摊成随手可点；没定的开工时由 AI 在对话里问
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs">
            {decisions.length > 0 && (
              <span className="text-l3">
                {decisionGaps.length === 0
                  ? `已定 ${decisions.length} 件`
                  : `已定 ${decisions.length - decisionGaps.length} 件，${decisionGaps.length} 件开工时没定，AI 会在对话里问`}
              </span>
            )}
            <button
              type="button"
              onClick={() => setSettleEditing(true)}
              className="rounded-sm px-1 py-0.5 text-micro text-l4 underline decoration-dotted underline-offset-2 hover:bg-hover hover:text-l2"
              title="这一轮已按当时的任务书开工；改了要下次重新开工这一步才生效"
            >
              {decisions.length > 0 ? "更改" : "展开"}
            </button>
          </div>
        )}
        {(node.kind === "discuss" ||
          (node.kind === "agent" && !hasDiscussNode)) &&
          !(node.kind === "discuss" && runStatus !== "pending" && !settleEditing) && (
          <div className="mt-1.5 space-y-2 pl-6">
            {node.kind === "discuss" && runStatus !== "pending" && (
              <p className="text-micro text-l4">
                这一轮已经按当时的任务书开工。这里改的只写进任务书草稿，工作区里的任务书不变，「继续」「新开一轮」的 AI 都看不到；下次重新开工这一步才生效。
                <button
                  type="button"
                  onClick={() => setSettleEditing(false)}
                  className="ml-1 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                >
                  收起
                </button>
              </p>
            )}
            {/* ── 输入准备（v3.86；v3.89 升格为独立 input 节点，排在 AI 干活之前）──
                · 决策项：答案写进任务书草稿，纯记录，给 Agent 看的合同内容
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
                        void chatDraft(q);
                      }}
                      title="拿不准？就这个问题跟 AI 商量，聊定了它直接写进 TASK.md"
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
            {/* 商量引导气泡（2026-11-05 用户点名）：每个项目第一次走到没开工、没商量过的步骤时出，引导先聊再开工 */}
            {node.kind === "discuss" && !talkOnAgent && talkGroup}
            {chatError && (
              <InlineNotice tone="err" size="micro">{chatError}</InlineNotice>
            )}
            {!draft && draftLoadError && (
              <p className="text-micro text-err-text">{draftLoadError}</p>
            )}
            {/* 预置话题：「跟 AI 商量」的现成话头，点了就带着这个问题开商量（2026-11-11 起不再建话题卡）。
                只列还没开聊过的（老话题卡已在下面的清单里） */}
            {(openSeeds ?? []).length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs text-l4">或直接聊：</span>
                {(openSeeds ?? []).map((seed) => (
                  <button
                    key={seed}
                    type="button"
                    onClick={() => void chatDraft(seed)}
                    title="就这个问题跟 AI 商量，聊定了它直接写进 TASK.md"
                    className="rounded-full bg-strip px-2 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
                  >
                    {seed}
                  </button>
                ))}
              </div>
            )}
            {/* 老话题卡（kind=idea）：2026-11-11 起不再新建，已有的照样列出、能接着聊、能写入任务书 */}
            {discussContent}
          </div>
        )}
        {node.kind === "agent" && agentContent && (
          <div className="mt-1.5 pl-6">{agentContent}</div>
        )}
        {node.kind === "agent" && notesStep && (ws || runStatus === "done") && (
          <NotesProgressLine
            roots={dataWs ? [dataWs.worktreePath, projectPath] : [projectPath]}
            live={runStatus === "active"}
            onChange={setAgentProgress}
          />
        )}
        {node.kind === "agent" && searchStep && (ws || runStatus === "done") && (
          <LedgerCountLine
            roots={dataWs ? [dataWs.worktreePath, projectPath] : [projectPath]}
            live={runStatus === "active"}
            rel="papers/included.json"
            line={(text) => searchCountLineWithFiles(projectPath, text)}
            onChange={setAgentProgress}
          />
        )}
        {/* 计数在上、回头入口在下，各步骤同一顺序（2026-11-11：大纲的计数原先排在回头入口下面） */}
        {node.kind === "agent" && outlineStep && (ws || runStatus === "done") && (
          <LedgerCountLine
            roots={dataWs ? [dataWs.worktreePath, projectPath] : [projectPath]}
            live={runStatus === "active"}
            rel="outline.md"
            read={readResearchFile}
            line={outlineCountLine(dataWs ? [dataWs.worktreePath, projectPath] : [projectPath])}
            refreshKey={`${ledgerRefreshKey}|${nudge?.text ?? ""}`}
            onChange={setAgentProgress}
          />
        )}
        {node.kind === "agent" && draftStep && (ws || runStatus === "done") && (
          <DraftProgressLine
            roots={dataWs ? [dataWs.worktreePath, projectPath] : [projectPath]}
            artifacts={step.expectedArtifacts ?? []}
            live={runStatus === "active"}
            onChange={setAgentProgress}
          />
        )}
        {node.kind === "agent" && (progressHeadline || progressDetails.length > 0) && (
          <div data-step-progress="details" className="mt-1 flex flex-wrap items-baseline gap-x-1.5 pl-6 text-micro tabular-nums text-l3" title={
            notesStep ? "按 notes/index.json 数；全文和仅摘要属于已写笔记，只速读的篇不算已写笔记" :
            searchStep ? "按纳入清单与项目里的 PDF 数；待确认和缺全文单独列出" :
            draftStep ? "按稿件的章级标题数：标题下有正文才算已写，sections.json 定了、稿件里还没出现的节也算进总数；引用按出现次数数；待定标记是 [待核实] [待确认] 一类还没处理的" :
            "按大纲的定框架记录、覆盖检查与用图计划数；补料是否已到由笔记状态核对。用图计划里初稿会从全文 PDF 裁子图拼成这些图、按表计划出对照表，裁不到的改成「见 [@键] Fig.n」"
          }>
            {progressHeadline && <span data-step-progress="headline" className="font-medium text-l2">{progressHeadline}</span>}
            {progressDetails.map((d) => (
              <span key={d} className="before:mr-1.5 before:text-l4 before:content-['·'] first:before:hidden">{d}</span>
            ))}
          </div>
        )}
        {/* 统计行在上、工具行在下（2026-11-13 步骤卡统一设计稿，用户按稿核对）：统计行单独一行只读，首项是本步主进度、加粗；
            工具行 = 商量组 | 回头组，竖线隔开，只有进对话的「继续讨论」带描边，其余是文字链接。
            两行 pl-6 = 序号列 w-4 + gap-2，左缘对齐「AI 干活」的字；只照稿改布局，字号保持原样（用户：字体只是参考观感） */}
        {node.kind === "agent" && (talkOnAgent || loopActions) && (
          <div data-step-tools="row" className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-6">
            {talkOnAgent && talkGroup}
            {talkOnAgent && loopActions && <span aria-hidden className="h-3 w-px bg-hairline" />}
            {loopActions && <div data-step-tools="loop" className="flex flex-wrap items-center gap-x-2.5 gap-y-1 empty:hidden">{loopActions}</div>}
          </div>
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
            <div className="mt-1 flex flex-wrap items-center gap-2 pl-6">
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
                    discussOnly: true,
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
          pendingRowLive &&
          !dense && (
            <div className="mt-1 pl-6 text-micro leading-5 text-l4">
              {/* 清完会自动勾上，但已纳入的仍能移出——勾上后清单不收走；做完了只留「文献清单」一行，
                  移出的后果点开清单才说（2026-11-13 用户：勾上了下面还铺着长说明） */}
              {(!pendingSettled || pendingListOpen) && (
                <p>{pendingSettled ? PENDING_DONE_HINT : PENDING_HINT}</p>
              )}
              <div className={!pendingSettled || pendingListOpen ? "mt-1.5" : undefined}>
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
                      // 不做主按钮：这一步要人逐篇拍板，强调色留给勾选后的「纳入所选」
                      className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
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
                      refreshKey={ledgerRefreshKey}
                      worktreePath={dataWs?.worktreePath}
                      projectRoot={projectPath}
                      commitToProject={runStatus === "done"}
                      onOpenPdf={(path) =>
                        void showProjectFile({ projectRoot: projectPath, path, from: "待确认的文献" })
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
          (isCurrent || inlineDecisionListVisible(runStatus, agentAttention, human)) && (
            <div className="mt-1 pl-6">
              <ReviewDecisionList
                worktreePath={ws?.worktreePath}
                projectRoot={projectPath}
                target={human.target}
                kind={reviewItemKind(human.title)!}
                refreshKey={`${runStatus}|${agentAttention ?? ""}`}
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
        {node.kind === "human" && human && handbackNote?.title === human.title && (
          <div className="mt-1 pl-6">
            <InlineNotice tone="err" size="micro">{handbackNote.text}</InlineNotice>
          </div>
        )}
        {node.kind === "human" &&
          human?.target &&
          !node.done &&
          editOpen === human.title &&
          handbackTask(human.title) && (
            <div className="mt-1.5 ml-6 rounded-md border border-hairline px-2.5 py-2">
              {/* 不再就地开 Markdown 编辑（2026-10-24 用户：打开清单、打开填写很不方便）：
                  许可清单一篇一行、下拉改状态；声明一节一框，离开就存 */}
              {handbackTask(human.title)!.panel === "permissions" ? (
                <FigurePermissionsPanel root={stepFileRoot} rel={human.target} projectRoot={projectPath} />
              ) : (
                <DeclarationsForm
                  root={stepFileRoot}
                  rel={human.target}
                  fallback={
                    <div className="flex h-[24rem] flex-col overflow-hidden rounded-sm">
                      <ProjectFilePreview
                        path={`${stepFileRoot.replace(/[\\/]+$/, "")}/${human.target}`}
                        root={stepFileRoot}
                      />
                    </div>
                  }
                />
              )}
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
            <div className="mt-1 pl-6 text-micro leading-5 text-l4">
              {isPaywallTaskTitle(human.title) ? (
                <p>{PAYWALL_HINT}</p>
              ) : isPendingConfirmTaskTitle(human.title) ? (
                <p>{PENDING_HINT}</p>
              ) : isSpotCheckTaskTitle(human.title) && !node.done ? null : (
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
                <SpotCheckPicks
                  projectPath={projectPath}
                  ws={dataWs}
                  refreshKey={ledgerRefreshKey}
                  stepName={step.name}
                  taskTitle={human.title}
                  hint={guidance}
                />
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
                    {paywallList.text
                      ? `待获取（还缺 ${missingToFetchCount(paywallList.text, toFetchDone)} 篇）`
                      : "待获取"}
                    {paywallListOpen && paywallList.from && (
                      <span className="text-l4">· {paywallList.from}</span>
                    )}
                  </button>
                  {/* 学校访问跟在清单标题右侧（2026-11-08 按设置里的访问方式：校外访问链接给登录按钮，CARSI 给一句指路，校园网不加东西） */}
                  {paywallListOpen && (
                    <span className="ml-auto inline-flex flex-wrap items-center gap-2">
                      {instAccess === "proxy" ? (
                        <button
                          type="button"
                          onClick={() => void openInstLogin()}
                          className="rounded-sm border border-field px-1.5 py-0.5 text-l2 hover:bg-hover hover:text-l1"
                          title="在浏览器里打开学校的校外访问链接，用学校账号登录一次"
                        >
                          <span className="text-xs">在浏览器里登录</span>
                        </button>
                      ) : instAccess === "carsi" ? (
                        <button
                          type="button"
                          onClick={() => {
                            setInstLoginErr(null);
                            void invoke("inst_browser_open", { url: CARSI_URL }).catch((e) => setInstLoginErr(String(e)));
                          }}
                          className="rounded-sm border border-field px-1.5 py-0.5 text-l2 hover:bg-hover hover:text-l1"
                          title="在浏览器里打开 CARSI：选你的学校登录，再点进要用的出版商；也可以在文献官网选「机构登录 → CARSI」"
                        >
                          <span className="text-xs">登录学校账号</span>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setSettingsSectionReq("network");
                          setPage("settings");
                        }}
                        className="text-micro text-l4 underline decoration-dotted underline-offset-2 hover:text-l2"
                        title="设置 → 网络：校园网或学校 VPN / 学校的校外访问链接 / 出版商网站上用学校账号登录"
                      >
                        访问方式
                      </button>
                    </span>
                  )}
                  </div>
                  {paywallListOpen && (
                    <div ref={paywallDropRef} className="mt-1">
                      {instLoginErr && (
                        <p className="mb-1 break-words text-micro text-err-text" role="alert">
                          {instLoginErr}
                        </p>
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
                                          ? `在右侧打开 papers/${doneName}`
                                          : item.url
                                            ? "用右侧「官网」打开这篇的出版商页面"
                                            : item.title
                                      }
                                      onClick={() => {
                                        focusToFetchLine(item.line);
                                        if (doneName) {
                                          const rel = toFetchPaperRel(doneName);
                                          if (!rel) return;
                                          void showProjectFile({
                                            projectRoot: projectPath,
                                            path: absoluteResourcePath(
                                              projectPath,
                                              rel,
                                            ),
                                            from: "待获取清单",
                                          });
                                        }
                                      }}
                                    >
                                      {displayCitationTitle(item.title)}
                                    </button>
                                    {item.addedOn && (
                                      <span
                                        className="shrink-0 rounded-sm bg-raised px-1 text-micro text-l3"
                                        title={`${item.addedOn} 这一轮新加进待获取的（编号接在上一版后面）`}
                                      >
                                        新加 {item.addedOn.slice(5)}
                                      </span>
                                    )}
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
          和「定方向 / agent 执行 / 评审」平铺在一起会让人以为样样都得做。
          保存进项目之后才用得上的收尾（继续精读、同步到文献库、导入批注）再单独放进虚线下的「保存后可做」，
          不和可选事项混排（2026-11-13 步骤卡统一设计稿） */}
      {([
        ["可选", "solid", flow.nodes.filter((n) => n.section === "optional" && !n.afterSave)],
        ["保存后可做", "dashed", flow.nodes.filter((n) => n.section === "optional" && n.afterSave)],
      ] as const).map(([title, line, nodes]) => nodes.length > 0 && (
        <div key={title} data-step-section={line === "dashed" ? "after-save" : "optional"}>
          <div className="mt-3 flex items-center gap-2 pl-[30px]">
            {/* pl-[30px] = 节点 pl-1.5 + 序号列 + 间距，分隔线的字与步骤名同一左缘（设计稿 .split） */}
            <span className="shrink-0 text-micro text-l4">{title}</span>
            <span className={line === "dashed" ? "min-w-0 flex-1 border-t border-dashed border-field" : "h-px min-w-0 flex-1 bg-hairline"} />
          </div>
          <ol className="mt-1.5 space-y-1">{nodes.map((node) => renderNode(node, false))}</ol>
        </div>
      ))}
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
