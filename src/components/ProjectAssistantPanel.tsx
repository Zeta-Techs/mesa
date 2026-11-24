import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowRight, ArrowUp, BookMarked, MessageCircleQuestion, MoreHorizontal, Search, Square, X } from "lucide-react";
import { SettingsDrawerShell } from "./ProjectSettingsDrawer";
import { confirmDialog } from "./ConfirmDialog";
import { ghostActionClass, secondaryActionClass } from "./PageFrame";
import ChatMarkdown from "./ChatMarkdown";
import MesaBuddy from "./MesaBuddy";
import { MesaStatusLead } from "./MesaMark";
import MesaThinkingDots from "./MesaThinkingDots";
import { absTime, relTime } from "../rel-time";
import { toast } from "../toast";
import { useAppStore } from "../store";
import { resumeDispatchedGoal } from "../assistant-dispatch";
import { quickIntent } from "../im-route";
import { buddyDayPart, buddyMood } from "../buddy-time";
import {
  assistantErrorText,
  extractAtMentionQuery,
  filterMentionFiles,
  filterTurnsByQuery,
  INSPECT_AGENTS,
  INSPECT_WAITING,
  INTENT_WAITING,
  localReply,
  parseAssistantAnswer,
  guardClaims,
  resolveTurnParts,
  splitAnswerLead,
  type AssistantAction,
  type AssistantIntent,
  type WorkOrder,
} from "../project-assistant";
import WorkOrderCard from "./WorkOrderCard";
import ReworkOrderCard from "./ReworkOrderCard";
import RememberCard from "./RememberCard";
import AssistantDesk from "./AssistantDesk";
import GuideSectionModal from "./GuideSectionModal";
import { Modal } from "./Modal";
import ProjectMemoryPanel from "./ProjectMemoryPanel";
import type { DispatchRecord, DispatchResult } from "../assistant-dispatch";
import {
  briefLines,
  goalReviewPrereadFocus,
  quickAsks,
  reviewPrereadFocus,
  reviewPrereadQuestion,
  SUMMARY_QUESTION,
  summaryDue,
  summaryFocus,
  type BriefLine,
  type QuickAsk,
} from "../assistant-brief";
import { assistantDayLabel, sameLocalDay } from "../assistant-dock";
import {
  askProjectAssistant,
  ASSISTANT_CANCELLED,
  assistantConnection,
  gatherBriefInput,
  planAsk,
  readonlyInspectFallback,
  TIER1_ASSISTANT_AGENTS,
  type AssistantFocus,
  type AssistantTurn,
} from "../project-assistant-run";
import type { MapEntry } from "../project-map";
import type { KnowledgeForAiDto, ProjectDto, RunDto, TaskDto } from "../types";
import { samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { saveClipboardImage } from "../clipboard-image";
import { firstImageItem, imageExtFromMime } from "../terminal-input";

/** 项目助手一次最多附几张截图（与后端 project_assistant.rs MAX_IMAGES 同） */
const MAX_ASSISTANT_IMAGES = 4;
interface AssistantImage {
  path: string;
  /** 缩略图：粘贴时的本地对象地址 */
  url: string;
}

/** 外面要它带着问题打开（卡点、「问问为什么」）：nonce 变了才再问一次 */
export interface AssistantAsk {
  question: string;
  focus: AssistantFocus | null;
  nonce: number;
}

/** 上次打开项目助手的时间（按项目）：「现在的情况」卡据此列「上次打开以来」的变化 */
const SEEN_KEY = (path: string) => `ccode.assistant.seen:${path}`;
/** 上次「整理这一阵定下的事」（或点了「不用」）时最后一轮的时间（按项目记在本机） */
const SUMMARY_KEY = (path: string) => `ccode.assistant.summarizedAt:${path}`;
/** 「起草项目知识」这一行点过「不用了」的项目（按项目记在本机） */
const NO_DRAFT_KEY = (path: string) => `ccode.assistant.noKnowledgeDraft:${path}`;
function draftDismissed(path: string): boolean {
  try {
    return localStorage.getItem(NO_DRAFT_KEY(path)) === "1";
  } catch {
    return false;
  }
}

/** 用户问的话：右侧小气泡 */
function QuestionBubble({ text, at }: { text: string; at?: string }) {
  return (
    <div className="flex justify-end">
      <p
        className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-inset px-3 py-1.5 text-sm leading-6 text-l1"
        title={at ? absTime(at) : undefined}
      >
        {text}
      </p>
    </div>
  );
}

/**
 * 项目助手（2026-11-04，docs/design-project-assistant.md）：工作台右侧抽屉，与任务面板同一位置。
 * 形象是卡通小工作台「小桌」（MesaBuddy.tsx；同日用户几轮拍板：要生动的卡通形象、深色同浅色一套、按时间换样子）：
 * 没问过时正文是大图小桌（按时段打招呼 / 端咖啡 / 亮台灯 / 盘腿睡觉）+ 三个常用问题细线列表，顶栏只有名字；
 * 问过以后小桌只在顶栏一个，跟着状态变：问着托腮想、刚答完举手、没问成皱眉；回答前只一道琥珀短线 + 名字，等待那一行用聊天层的 M▁ 状态头，
 * 多段回答的第一句结论加粗带琥珀竖线，按钮在下。
 * 输入框钉在底部，连接与「清空记录」在输入框下一行小字。
 * 不开终端、不派活：每问一次，取一次项目快照、无头调用一次；回答里的按钮交给页面跳到原有入口。
 */
export default function ProjectAssistantPanel({
  open,
  onClose,
  projectPath,
  projectName,
  project,
  stepCount,
  steps,
  ask,
  onAction,
  onDispatch,
  where = "",
  docked = null,
  dockSwitch,
  hideProjectName = false,
}: {
  /** 停在同一个项目的项目页旁边：页头已经写着项目名，标题下不再写一遍 */
  hideProjectName?: boolean;
  /** 用户此刻在看哪（「项目页 · HER催化综述 ·「定时任务」页签」）：提问时附上，问「这个提示什么意思」时它知道「这个」在哪 */
  where?: string;
  /** 常驻侧栏（宿主够宽时给）；null = 浮层抽屉 */
  docked?: { width: number; onResize: (width: number) => void; onResizeEnd?: () => void } | null;
  /** 与项目页文件栏同一位置轮流时，标题行里的「项目助手 / 文件」切换（2026-11-11） */
  dockSwitch?: ReactNode;
  open: boolean;
  onClose: () => void;
  projectPath: string | null;
  projectName: string;
  project: ProjectDto | null;
  stepCount: number;
  steps?: readonly { name: string }[];
  ask: AssistantAsk | null;
  onAction: (action: AssistantAction, turn: AssistantTurn) => void;
  /** 派活单「派出去」：页面按去处开工，返回给人看的一句（「已留话给第 2 步的 AI」） */
  onDispatch: (order: WorkOrder) => Promise<DispatchResult>;
}) {
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  /** 在应用里打开的说明书小节 */
  const [guideHeading, setGuideHeading] = useState<string | null>(null);
  /** 边生成边推来的：到此为止的回答、正在做的一步（Claude Code / Codex 才有） */
  const [liveText, setLiveText] = useState("");
  const [liveStep, setLiveStep] = useState<string | null>(null);
  /** 这次问的是哪一类（等的时候那一行写什么） */
  const [intent, setIntent] = useState<AssistantIntent>("project");
  /** 这次会不会只读打开项目文件（等得久一些，等待文案要说清） */
  const [inspecting, setInspecting] = useState(false);
  /** 已经等了几秒（超过 3 秒才写出来） */
  const [waited, setWaited] = useState(0);
  /** 没问成的那一问（错误上方照样显示，「再问一次」用它） */
  const [failed, setFailed] = useState<{ question: string; focus: AssistantFocus | null; images?: AssistantImage[] } | null>(null);
  /** 这一问附的截图（2026-11-05 用户：「有些问题可能需要截图去问」）：粘贴 / 拖进输入框，和聊天层同一条落盘通道 */
  const [images, setImages] = useState<AssistantImage[]>([]);
  const [imageNote, setImageNote] = useState<string | null>(null);
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const streamIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  useEffect(
    () => () => {
      for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
      blobUrlsRef.current.clear();
    },
    [],
  );
  async function addImageFile(file: File) {
    if (images.length >= MAX_ASSISTANT_IMAGES) {
      setImageNote(`一次最多附 ${MAX_ASSISTANT_IMAGES} 张截图`);
      return;
    }
    try {
      const path = await saveClipboardImage(await file.arrayBuffer(), imageExtFromMime(file.type));
      const url = URL.createObjectURL(file);
      blobUrlsRef.current.add(url);
      setImages((cur) => {
        if (cur.length >= MAX_ASSISTANT_IMAGES) {
          URL.revokeObjectURL(url);
          blobUrlsRef.current.delete(url);
          return cur;
        }
        return [...cur, { path, url }];
      });
      setImageNote(null);
    } catch (reason) {
      setImageNote(`截图没贴上：${String(reason)}`);
    }
  }
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<AssistantFocus | null>(null);
  /** 这次打开后刚答完的那一轮（它旁边的小桌举手蹦一下，旧的站着） */
  const [freshAt, setFreshAt] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const askedNonce = useRef<number | null>(null);
  const conn = assistantConnection(project);
  // 能只读看文件与看图的是 INSPECT_AGENTS 四家；走「AI 功能」连接时前端不知道是哪家，先不拦，后端会说
  const imageCapable = conn.agentId === null || INSPECT_AGENTS.includes(conn.agentId);
  const inspectFallback = !imageCapable ? readonlyInspectFallback(project) : null;
  /** `@` 引用项目文件补全：懒加载项目地图，切项目时清空 */
  const [mentionFiles, setMentionFiles] = useState<MapEntry[] | null>(null);
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  useEffect(() => {
    setMentionFiles(null);
    setMentionRange(null);
    setMentionIdx(0);
  }, [projectPath]);
  useEffect(() => {
    if (!mentionRange || !projectPath || mentionFiles !== null) return;
    let stale = false;
    invoke<{ entries: MapEntry[]; truncated: boolean }>("project_file_map", { projectRoot: projectPath })
      .then((res) => {
        if (!stale) setMentionFiles(res?.entries ?? []);
      })
      .catch(() => {
        if (!stale) setMentionFiles([]);
      });
    return () => {
      stale = true;
    };
  }, [mentionRange, projectPath, mentionFiles]);
  const mentionMatches = mentionRange ? filterMentionFiles(mentionFiles ?? [], mentionRange.query, 8) : [];
  function updateMentionFromInput(value: string, caret: number | null) {
    const hit = caret != null ? extractAtMentionQuery(value, caret) : null;
    setMentionRange(hit);
    setMentionIdx(0);
  }
  function pickMention(path: string) {
    if (!mentionRange) return;
    const token = `\`${path}\` `;
    const next = `${draft.slice(0, mentionRange.start)}${token}${draft.slice(mentionRange.end)}`;
    const nextCaret = mentionRange.start + token.length;
    setDraft(next);
    setMentionRange(null);
    setMentionIdx(0);
    window.requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    });
  }
  // 派活单派出去后记到那一轮上（后端问答记录），卡片据此跟进度、不重复派；项目快照据此告诉项目助手派过什么
  async function dispatch(turnAt: string, order: WorkOrder) {
    const result = await onDispatch(order);
    await saveDispatched(turnAt, {
      at: new Date().toISOString(),
      target: order.target,
      step: order.step,
      title: order.title,
      mode: result.mode,
      mailId: result.mailId ?? null,
      taskId: result.taskId ?? null,
      worktreePath: result.worktreePath ?? null,
      note: result.note,
      baseAhead: result.baseAhead ?? null,
    });
  }
  /** 派出去的单子记在那一轮上（派活单、补料单共用；不再派第二次，回音巡视按它补进展） */
  async function saveDispatched(turnAt: string, record: DispatchRecord) {
    setTurns((list) => list.map((t) => (t.at === turnAt ? { ...t, dispatched: record } : t)));
    if (projectPath) {
      await invoke("assistant_mark_dispatched", { projectRoot: projectPath, turnAt, record }).catch(() => {});
    }
  }
  const mood = buddyMood(buddyDayPart(new Date().getHours()));
  /** 「现在的情况」卡与按状态换的常用问题（Mesa 按记录算，不调 AI）；briefOff = 这次打开点过「知道了」 */
  const [brief, setBrief] = useState<{ lines: BriefLine[]; asks: QuickAsk[]; since: string | null } | null>(null);
  const [briefOff, setBriefOff] = useState(false);
  // 聊久了提议整理一次（2026-11-08）：点了才调 AI，起草的条目仍逐条点才记
  const [summarizedAt, setSummarizedAt] = useState<string | null>(null);
  useEffect(() => {
    if (!projectPath) return;
    try {
      setSummarizedAt(localStorage.getItem(SUMMARY_KEY(projectPath)));
    } catch {
      setSummarizedAt(null);
    }
  }, [projectPath]);
  function markSummarized() {
    const last = turns[turns.length - 1]?.at ?? new Date().toISOString();
    setSummarizedAt(last);
    try {
      if (projectPath) localStorage.setItem(SUMMARY_KEY(projectPath), last);
    } catch {
      /* 存不了就只是这次不再提 */
    }
  }
  const asks = brief?.asks ?? quickAsks({ hasFlow: stepCount > 0, steps: [], goals: [], since: null });

  // 派活回音补了一条（巡视在 ProjectAssistantHost）：开着就重读记录，新的回音接在最后
  const echoTick = useAppStore((s) => s.assistantEchoTick);
  const helpTick = useAppStore((s) => s.helpRefreshTick);
  const briefSinceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !projectPath || echoTick === 0) return;
    let stale = false;
    invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: projectPath })
      .then((list) => {
        if (!stale) setTurns(list);
      })
      .catch(() => {});
    // 派出去的活有了进展：卡和常用问题跟着换（since 沿用这次打开时的）
    const since = briefSinceRef.current;
    gatherBriefInput(projectPath, since)
      .then((input) => {
        if (!stale) setBrief({ lines: briefLines({ ...input, knowledgeEmpty: input.knowledgeEmpty && !draftDismissed(projectPath) }), asks: quickAsks(input), since });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [echoTick, open, projectPath]);

  // 常驻侧栏开着期间定期刷新「现在的情况」：在左侧保存/跟进步骤或人工请求变动后，右侧卡片自动跟上，不必开关面板重拉
  useEffect(() => {
    if (!open || !projectPath) return;
    let stale = false;
    const refresh = () => {
      const since = briefSinceRef.current;
      gatherBriefInput(projectPath, since)
        .then((input) => {
          if (!stale) setBrief({ lines: briefLines({ ...input, knowledgeEmpty: input.knowledgeEmpty && !draftDismissed(projectPath) }), asks: quickAsks(input), since });
        })
        .catch(() => {});
    };
    if (helpTick > 0) refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, [open, projectPath, helpTick]);

  function markSeenNow(targetPath: string | null) {
    if (!targetPath) return;
    try {
      localStorage.setItem(SEEN_KEY(targetPath), new Date().toISOString());
    } catch {
      /* 存不了就只列现状 */
    }
  }

  useEffect(() => {
    if (!open || !projectPath) return;
    let stale = false;
    setError(null);
    setFreshAt(null);
    setBrief(null);
    setBriefOff(false);
    let since: string | null = null;
    try {
      since = localStorage.getItem(SEEN_KEY(projectPath));
    } catch {
      /* 存不了就只列现状 */
    }
    briefSinceRef.current = since;
    // 停留满 4 秒再把「上次打开」拨到现在：顺手打开一眼就关或切项目时，不把还没看清的变化冲掉
    const openedAt = new Date().toISOString();
    const seenTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(SEEN_KEY(projectPath), openedAt);
      } catch {
        /* 存不了就只列现状 */
      }
    }, 4000);
    gatherBriefInput(projectPath, since)
      .then((input) => {
        if (!stale) setBrief({ lines: briefLines({ ...input, knowledgeEmpty: input.knowledgeEmpty && !draftDismissed(projectPath) }), asks: quickAsks(input), since });
      })
      .catch(() => {});
    invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: projectPath })
      .then((list) => {
        if (!stale) setTurns(list);
      })
      .catch(() => {
        if (!stale) setTurns([]);
      });
    return () => {
      stale = true;
      window.clearTimeout(seenTimer);
    };
  }, [open, projectPath]);

  // 往上翻过以后底部给「回到最新」：看末尾那个锚点还在不在视野里。
  // 锚点挂上才开始看（回调 ref）：外壳打开时晚一帧才渲染内容，按 open 去找锚点会扑空，
  // 上次关面板时留下的「不在末尾」就一直挂着（2026-11-08 用户截图：翻到底了还显示「回到最新」）
  const [endEl, setEndEl] = useState<HTMLDivElement | null>(null);
  const endRefCb = useCallback((el: HTMLDivElement | null) => {
    endRef.current = el;
    setEndEl(el);
  }, []);
  const [atEnd, setAtEnd] = useState(true);
  useEffect(() => {
    setAtEnd(true);
    if (!endEl || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setAtEnd(entry.isIntersecting));
    io.observe(endEl);
    return () => io.disconnect();
  }, [endEl]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, busy, error]);

  // 流式出字 / 换步骤时只有本来就在底部才跟着滚；往上翻看旧记录时不抢滚动条
  useEffect(() => {
    if (atEnd) endRef.current?.scrollIntoView({ block: "end" });
  }, [liveText, liveStep, atEnd]);

  useEffect(() => {
    if (!busy) return;
    setWaited(0);
    const started = Date.now();
    const timer = window.setInterval(() => setWaited(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  /** 让停了 / 失败的派出去的目标接着做（进展下面的按钮、或直接说「接着做」） */
  async function resume(taskId: string) {
    if (!projectPath) return;
    try {
      toast(await resumeDispatchedGoal(projectPath, project, taskId), "success");
    } catch (reason) {
      toast(`没接上：${String(reason)}`, "error");
    }
  }

  /** 派活卡上点「先帮我过一遍」：按步骤或目标隔离副本发起只读预读 */
  async function prereadDispatch(rec: DispatchRecord) {
    if (!projectPath || busy) return;
    if (rec.target === "step" && rec.step) {
      const name = steps?.[rec.step - 1]?.name ?? `第 ${rec.step} 步`;
      const f = reviewPrereadFocus(rec.step, name, { worktree: rec.worktreePath ?? undefined });
      await send(reviewPrereadQuestion(rec.step), f, "project");
      return;
    }
    if (rec.mode === "goal" && rec.taskId) {
      const [task, runs] = await Promise.all([
        invoke<TaskDto | null>("task_get", { id: rec.taskId }).catch(() => null),
        invoke<RunDto[]>("run_list", { projectRoot: projectPath }).catch(() => [] as RunDto[]),
      ]);
      const hit = runs
        .filter((r) => !r.internal && r.taskId === rec.taskId && r.isolationPath && !samePath(r.isolationPath, projectPath, IS_WINDOWS))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const name = task?.name ?? rec.title;
      const f = goalReviewPrereadFocus(name, {
        isolationPath: task?.workspaceCleared ? null : (hit?.isolationPath ?? null),
        outputs: task?.outputPaths ?? [],
      });
      await send(`目标「${name}」做得怎么样，我验收时看哪？`, f, "project");
    }
  }

  /** 派活卡上点「问问为什么」：直接带着该目标/步骤信息查原因 */
  async function askWhyDispatch(rec: DispatchRecord) {
    if (!projectPath || busy) return;
    if (rec.target === "step" && rec.step) {
      await send(
        `派给第 ${rec.step} 步的「${rec.title}」为什么没做成？我该怎么办？`,
        { title: `第 ${rec.step} 步「${rec.title}」`, detail: rec.worktreePath ? `工作副本：${rec.worktreePath}` : "" },
        "project",
      );
      return;
    }
    const runs = await invoke<RunDto[]>("run_list", { projectRoot: projectPath }).catch(() => [] as RunDto[]);
    const hit = rec.taskId
      ? runs.filter((r) => !r.internal && r.taskId === rec.taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      : undefined;
    await send(
      `目标「${rec.title}」为什么没做成或停下了？我该怎么办？`,
      {
        title: `目标「${rec.title}」`,
        detail: hit?.isolationPath ? `这个目标的工作副本：${hit.isolationPath}` : "",
        runId: hit?.id ?? null,
      },
      "project",
    );
  }

  async function send(
    question: string,
    withFocus: AssistantFocus | null,
    forced?: AssistantIntent,
    attached: AssistantImage[] = images,
    forcedInspect?: boolean,
    overrideConnection?: { profileId: string; model: string | null; line: string } | null,
  ) {
    setMentionRange(null);
    // 只贴了图没写字：替人补一句最常见的问法
    const q = question.trim() || (attached.length ? "看看这张截图是怎么回事，我该怎么办？" : "");
    if (!q || busy || !projectPath) return;
    markSeenNow(projectPath);
    // 「派出去」「接着做」照字面办，不交给 AI（它自己做不了动作，交给它只会被说成「已经派出去了」，2026-11-06 实证）
    const quick = !withFocus && !forced && !attached.length ? quickIntent(q) : null;
    if (quick) {
      setDraft("");
      if (quick === "dispatch") {
        const steps = stepCount;
        const lastEntry = [...turns]
          .reverse()
          .map((t) => ({ turn: t, order: !t.echoOf ? resolveTurnParts(t, steps).order : null }))
          .find((x) => !!x.order);
        const last = lastEntry?.turn ?? null;
        const order = lastEntry?.order ?? null;
        if (!last || !order || last.dispatched) {
          toast("现在没有还没派的单子：先说要做什么，起草好单子再派", "info");
          return;
        }
        try {
          await dispatch(last.at, order);
        } catch (reason) {
          toast(`没派出去：${String(reason)}`, "error");
        }
        return;
      }
      const last = [...turns].reverse().find((t) => t.dispatched?.mode === "goal" && t.dispatched.taskId && (t.dispatched.echoed === "stopped" || t.dispatched.echoed === "failed"));
      if (!last?.dispatched?.taskId) {
        toast("没有停下的、经项目助手派出去的活", "info");
        return;
      }
      await resume(last.dispatched.taskId);
      return;
    }
    // 纯寒暄本地直接回，不调 AI（原来一句「你好」要 8–19 秒）；带图的不算寒暄
    const canned = withFocus || forced || attached.length ? null : localReply(q, new Date().getHours());
    if (canned) {
      setDraft("");
      if (inputRef.current) inputRef.current.style.height = "";
      setError(null);
      try {
        const turn = await invoke<AssistantTurn>("assistant_log_append", { projectRoot: projectPath, question: q, answer: canned });
        setTurns((list) => [...list, turn]);
        setFreshAt(turn.at);
      } catch {
        setTurns((list) => [...list, { at: new Date().toISOString(), question: q, answer: canned, connection: "" }]);
      }
      return;
    }
    // 回音不是问答：不喂给 AI、不算「上一轮」
    const qaTurns = turns.filter((t) => !t.echoOf);
    const planned = planAsk(q, !!withFocus, project, forced, qaTurns);
    // 带截图的多半在问眼前这个项目里的东西：说明书和项目记录都看（2026-11-05：「这个提示什么意思」+ 截图只翻了说明书，没对上项目的实际产物）
    const plan =
      attached.length && !forced && (planned.intent === "howto" || planned.intent === "general" || planned.intent === "chat")
        ? { ...planned, intent: "mixed" as const }
        : planned;
    const streamId = crypto.randomUUID();
    streamIdRef.current = streamId;
    cancelledRef.current = false;
    const inspectRun = forcedInspect ?? plan.inspect;
    setIntent(plan.intent);
    setInspecting(inspectRun);
    setBusy(true);
    setPending(q);
    setLiveText("");
    setLiveStep(null);
    setFailed(null);
    setDraft("");
    setImages([]);
    setImageNote(null);
    if (inputRef.current) inputRef.current.style.height = "";
    setError(null);
    try {
      const turn = await askProjectAssistant({
        projectPath,
        project,
        question: q,
        history: qaTurns,
        focus: withFocus,
        intent: plan.intent,
        inspect: inspectRun,
        images: attached.map((img) => img.path),
        where,
        streamId,
        overrideConnection,
        onStream: (update) => {
          if (update.text !== undefined) setLiveText(update.text);
          if (update.step) setLiveStep(update.step);
        },
      });
      for (const img of attached) {
        URL.revokeObjectURL(img.url);
        blobUrlsRef.current.delete(img.url);
      }
      setTurns((list) => [...list, turn]);
      setFreshAt(turn.at);
      setFocus(null);
    } catch (reason) {
      if (cancelledRef.current || String(reason).includes(ASSISTANT_CANCELLED)) {
        setDraft((cur) => cur || (question.trim() ? question : ""));
        setFocus((cur) => cur ?? withFocus);
        setImages((cur) => (cur.length ? cur : attached));
      } else {
        setError(assistantErrorText(String(reason)));
        setFailed({ question: q, focus: withFocus, images: attached });
      }
    } finally {
      streamIdRef.current = null;
      setBusy(false);
      setPending(null);
      setLiveText("");
      setLiveStep(null);
    }
  }

  function stopAsk() {
    const id = streamIdRef.current;
    if (!busy || !id) return;
    cancelledRef.current = true;
    void invoke("project_assistant_cancel", { streamId: id }).catch(() => {});
  }

  // 带着问题打开：只问一次（同一个 nonce 不重问）
  useEffect(() => {
    if (!open || !ask || askedNonce.current === ask.nonce) return;
    askedNonce.current = ask.nonce;
    setFocus(ask.focus);
    void send(ask.question, ask.focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ask]);

  const [onlyDispatches, setOnlyDispatches] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const [memoryTick, setMemoryTick] = useState(0);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [turnMenuKey, setTurnMenuKey] = useState<string | null>(null);
  const [quickAsksOpen, setQuickAsksOpen] = useState(false);
  const hasDispatches = turns.some((t) => !!t.dispatched || !!t.echoOf);
  const openDispatchCount = turns.filter((t) => t.dispatched && t.dispatched.echoed !== "accepted").length;
  const dueForSummary = !busy && summaryDue(turns, summarizedAt);
  useEffect(() => {
    setOnlyDispatches(false);
    setSearchOpen(false);
    setSearchQuery("");
    setMemoryOpen(false);
    setHeaderMenuOpen(false);
    setTurnMenuKey(null);
    setQuickAsksOpen(false);
  }, [projectPath]);
  useEffect(() => {
    if (!open) {
      setHeaderMenuOpen(false);
      setTurnMenuKey(null);
      setQuickAsksOpen(false);
    }
  }, [open]);
  useEffect(() => {
    if (!headerMenuOpen && !turnMenuKey && !quickAsksOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const el = event.target as HTMLElement | null;
      if (el?.closest("[data-assistant-menu]")) return;
      setHeaderMenuOpen(false);
      setTurnMenuKey(null);
      setQuickAsksOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setHeaderMenuOpen(false);
      setTurnMenuKey(null);
      setQuickAsksOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [headerMenuOpen, turnMenuKey, quickAsksOpen]);
  useEffect(() => {
    if (!hasDispatches && onlyDispatches) setOnlyDispatches(false);
  }, [hasDispatches, onlyDispatches]);
  useEffect(() => {
    if (turns.length === 0 && (searchOpen || searchQuery)) {
      setSearchOpen(false);
      setSearchQuery("");
    }
  }, [turns.length, searchOpen, searchQuery]);
  useEffect(() => {
    if (!open || !projectPath) return;
    let stale = false;
    invoke<KnowledgeForAiDto>("project_memory_for_ai", { path: projectPath })
      .then((res) => {
        if (!stale) setMemoryCount((res?.included ?? 0) + (res?.omitted ?? 0));
      })
      .catch(() => {
        if (!stale) setMemoryCount(null);
      });
    return () => {
      stale = true;
    };
  }, [open, projectPath, echoTick, memoryTick]);

  const indexedTurns = turns.map((turn, i) => ({ turn, i }));
  const byDispatch = onlyDispatches
    ? indexedTurns.filter(({ turn }) => !!turn.dispatched || !!turn.echoOf)
    : indexedTurns;
  const trimmedSearch = searchQuery.trim();
  const queryMatched = trimmedSearch ? new Set(filterTurnsByQuery(byDispatch.map((x) => x.turn), trimmedSearch)) : null;
  const visibleTurns = queryMatched ? byDispatch.filter(({ turn }) => queryMatched.has(turn)) : byDispatch;

  async function clear() {
    if (!projectPath) return;
    const ok = await confirmDialog(
      openDispatchCount > 0
        ? `清空项目助手的问答记录？\n\n普通问答：彻底清空\n在途派活与进展：保留 ${openDispatchCount} 条还没验收的派活记录，方便继续跟进度`
        : "清空项目助手的问答记录？\n\n清空后不能恢复；已记进项目知识的规矩不受影响。",
      { danger: true, confirmText: "清空记录" },
    );
    if (!ok) return;
    try {
      const kept = await invoke<number>("assistant_log_clear", { projectRoot: projectPath, keepDispatches: true });
      setOnlyDispatches(false);
      if (kept > 0) {
        const list = await invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: projectPath });
        setTurns(list);
        toast(`已清空普通问答，保留了 ${openDispatchCount || kept} 条在途派活记录`, "info");
      } else {
        setTurns([]);
      }
    } catch (reason) {
      toast(`清空失败：${String(reason)}`, "error");
    }
  }

  const empty = turns.length === 0 && !busy && !error;
  // 小桌只在顶栏出现一个（2026-11-04 用户：「聊天信息有个小人，顶部还有小人」）：问着托腮想、没问成皱眉、
  // 刚答完举手蹦两秒半，其余按时段；还没问过时正文里有大图，顶栏就不再放
  const [cheer, setCheer] = useState(false);
  useEffect(() => {
    if (!freshAt) return;
    setCheer(true);
    const timer = window.setTimeout(() => setCheer(false), 2500);
    return () => window.clearTimeout(timer);
  }, [freshAt]);
  const headPose = busy ? "think" : error ? "oops" : cheer ? "happy" : mood.restPose;

  /** 一轮问答（或一条派活进展）的样子；换天分隔在调用处画 */
  function renderTurn(turn: AssistantTurn, i: number) {
    if (turn.echoOf) {
      const echo = parseAssistantAnswer(turn.answer, stepCount);
      // 停了 / 失败的派出去的目标：最新那条进展下面给「接着做」（2026-11-06）
      const rec = turns.find((t) => t.at === turn.echoOf)?.dispatched;
      const latestEcho = !turns.slice(i + 1).some((t) => t.echoOf === turn.echoOf);
      const resumable = latestEcho && rec?.mode === "goal" && !!rec.taskId && (rec.echoed === "stopped" || rec.echoed === "failed");
      return (
        <article key={`${turn.at}-${i}`} className="flex flex-col gap-1.5" aria-label="派活进展">
          <div className="flex items-center gap-2">
            <span className="h-[3px] w-2.5 shrink-0 rounded-sm bg-mesa-amber" aria-hidden="true" />
            <span className="text-xs text-l3" title={absTime(turn.at)}>
              项目助手 · 派活进展 · {relTime(turn.at)}
            </span>
          </div>
          <p className="text-sm leading-6 text-l1">{echo.text}</p>
          {(echo.actions.length > 0 || resumable) && (
            <div className="flex flex-wrap gap-1.5">
              {resumable && (
                <button type="button" className={secondaryActionClass} disabled={busy} onClick={() => void resume(rec!.taskId!)}>
                  接着做
                </button>
              )}
              {echo.actions.map((action) => (
                <button key={`${action.kind}-${action.step ?? ""}`} type="button" className={secondaryActionClass} onClick={() => onAction(action, turn)}>
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </article>
      );
    }
    const resolved = resolveTurnParts(turn, stepCount);
    // 只有最后一轮的问题能点选作答（前面的已经答过了）
    const openAsk = i === turns.length - 1 ? resolved.clarify : null;
    // 话与事实分开：它声称自己做了动作的句子换成如实说明（根源三，2026-11-06）
    const { lead, rest } = splitAnswerLead(guardClaims(resolved.text).text);
    const turnKey = `${turn.at}-${i}`;
    const isLocal = !turn.connection || turn.connection.startsWith("本地");
    const alreadyInspected = Boolean(turn.basis?.includes("文件（只读查看）") || turn.basis?.includes("项目助手 Agent（只读"));
    const canDraftFromTurn =
      !busy &&
      !isLocal &&
      !resolved.order &&
      !resolved.rework &&
      !resolved.clarify &&
      `${lead}${rest}`.trim().length >= 30;
    const canInspectTurn = !busy && !isLocal && !alreadyInspected && (imageCapable || !!inspectFallback);
    const costTitle =
      turn.costUsd != null ? ` · $${turn.costUsd < 0.1 ? turn.costUsd.toFixed(3) : turn.costUsd.toFixed(2)}` : "";
    return (
      <article key={turnKey} className="group/turn flex flex-col gap-3">
        <QuestionBubble text={turn.question} at={turn.at} />
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="h-[3px] w-2.5 shrink-0 rounded-sm bg-mesa-amber" aria-hidden="true" />
            <span
              className="text-xs text-l3"
              title={`${absTime(turn.at)}${turn.connection ? ` · ${turn.connection}` : ""}${turn.basis ? ` · 依据：${turn.basis}` : ""}${costTitle}`}
            >
              项目助手 · {relTime(turn.at)}
            </span>
            {/* 悬停露出的极轻 ⋯ 菜单：复制回答 / 据此起草派活 / 进文件核对（不再铺一排「没答到点上？」） */}
            <div className="relative ml-auto" data-assistant-menu>
              <button
                type="button"
                aria-label="这条回答的更多操作"
                aria-expanded={turnMenuKey === turnKey}
                className={`inline-flex h-6 w-6 items-center justify-center rounded-md text-l4 transition-opacity hover:bg-hover hover:text-l1 ${
                  turnMenuKey === turnKey
                    ? "bg-hover text-l1 opacity-100"
                    : "opacity-0 group-hover/turn:opacity-100 focus-visible:opacity-100"
                }`}
                onClick={() => setTurnMenuKey((cur) => (cur === turnKey ? null : turnKey))}
              >
                <MoreHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
              {turnMenuKey === turnKey && (
                <div
                  role="menu"
                  className="ccode-float-surface absolute right-0 top-7 z-30 min-w-44 rounded-lg border border-field p-1 shadow-md"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-l1 hover:bg-hover"
                    onClick={() => {
                      setTurnMenuKey(null);
                      const raw = [lead, rest].filter(Boolean).join("\n\n") || turn.answer;
                      void navigator.clipboard.writeText(raw).then(
                        () => toast("已复制回答", "success"),
                        () => toast("复制失败", "error"),
                      );
                    }}
                  >
                    复制回答
                  </button>
                  {canDraftFromTurn && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-l1 hover:bg-hover disabled:opacity-50"
                      onClick={() => {
                        setTurnMenuKey(null);
                        const excerpt = [lead, rest].filter(Boolean).join("\n").replace(/\s+/g, " ").trim().slice(0, 360);
                        void send(`按这轮分析起草一张派活单（原问：${turn.question.slice(0, 80)}）：\n${excerpt}`, null, "request");
                      }}
                    >
                      据此起草派活
                    </button>
                  )}
                  {canInspectTurn && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-l1 hover:bg-hover disabled:opacity-50"
                      onClick={() => {
                        setTurnMenuKey(null);
                        void send(
                          turn.question,
                          null,
                          "project",
                          [],
                          true,
                          imageCapable ? null : inspectFallback,
                        );
                      }}
                    >
                      {imageCapable ? "进文件核对" : `借用 ${inspectFallback!.agentLabel} 查文件`}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          {lead && (
            <p className="mb-2 border-l-2 border-mesa-amber pl-3 text-sm font-medium leading-6 text-l1">{lead}</p>
          )}
          {rest && (
            <div className="text-sm text-l1">
              <ChatMarkdown text={rest} cwd={projectPath} />
            </div>
          )}
          {resolved.clarify && (
            <section className="mt-3 rounded-xl border border-hairline p-3" aria-label="要先问你一句">
              <p className="text-sm font-medium leading-6 text-l1">{resolved.clarify.question}</p>
              {openAsk ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {openAsk.options.map((o) => (
                    <button key={o} type="button" className={secondaryActionClass} disabled={busy} onClick={() => void send(o, null)}>
                      {o}
                    </button>
                  ))}
                  <span className="self-center text-micro text-l4">{openAsk.options.length ? "或者直接在下面打字回答" : "在下面打字回答"}</span>
                </div>
              ) : null}
            </section>
          )}
          {resolved.rememberItems.map((r) => (
            <RememberCard
              key={r.text}
              text={r.text}
              source={r.source}
              projectPath={projectPath}
              onSaved={() => {
                setMemoryTick((n) => n + 1);
              }}
            />
          ))}
          {resolved.rework && (
            <ReworkOrderCard
              order={resolved.rework}
              record={turn.dispatched ?? null}
              projectPath={projectPath}
              onSent={(record) => saveDispatched(turn.at, record)}
            />
          )}
          {resolved.order && (
            <WorkOrderCard
              order={resolved.order}
              record={turn.dispatched ?? null}
              projectPath={projectPath}
              workMode={project?.workMode ?? null}
              steps={steps}
              onDispatch={(order) => dispatch(turn.at, order)}
              onReviewGoal={(taskId) =>
                onAction({ kind: "project", step: null, text: `goal:${taskId}`, label: "去验收" }, turn)
              }
              onReviewStep={(step) =>
                onAction({ kind: "review", step, text: "", label: `去评审第 ${step} 步` }, turn)
              }
              onPreread={(rec) => void prereadDispatch(rec)}
              onResumeGoal={(taskId) => void resume(taskId)}
              onAskWhy={(rec) => void askWhyDispatch(rec)}
            />
          )}
          {resolved.actions.length > 0 && (
            // 一条回答只一个显眼的按钮：有单子时主按钮是单子上的「派出去」，这里全降成文字按钮；否则第一个是次级按钮
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {resolved.actions.map((action, ai) => (
                <button
                  key={`${action.kind}-${action.step ?? ""}-${action.text === "schedule" ? "schedule" : ""}`}
                  type="button"
                  className={ai === 0 && !resolved.order && !resolved.rework ? secondaryActionClass : ghostActionClass}
                  title={action.text || undefined}
                  onClick={() => onAction(action, turn)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
          {/* 仅引用了说明书小节时留一行可点击的说明书链接；「依据」「花费」全部静默收进顶部时间悬停 */}
          {resolved.guideHeadings.length > 0 && (
            <p className="mt-2 text-micro text-l4">
              参考说明书：
              {resolved.guideHeadings.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                  title="在应用里打开说明书这一节"
                  onClick={() => setGuideHeading(h)}
                >
                  <span className="text-micro">「{h}」</span>
                </button>
              ))}
            </p>
          )}
        </div>
      </article>
    );
  }

  const activeBriefLines = brief && !briefOff ? brief.lines : [];

  // 顶栏右侧安静的图标工具：搜索/筛选、项目知识、更多（整理定下的事 / 清空记录），不再铺在输入框下面
  const headerTools = (
    <div className="flex shrink-0 items-center gap-0.5">
      {dockSwitch}
      {turns.length > 0 && (
        <button
          type="button"
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
            searchOpen || trimmedSearch || onlyDispatches
              ? "bg-hover text-l1"
              : "text-l3 hover:bg-hover hover:text-l1"
          }`}
          aria-label="搜索或筛选记录"
          aria-pressed={searchOpen}
          title="搜索历史问答或仅看派活"
          onClick={() => {
            if (searchOpen) {
              setSearchOpen(false);
              setSearchQuery("");
              setOnlyDispatches(false);
            } else {
              setSearchOpen(true);
              window.requestAnimationFrame(() => searchInputRef.current?.focus());
            }
          }}
        >
          <Search size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      {projectPath && (
        <button
          type="button"
          className="relative inline-flex h-7 w-7 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
          aria-label={memoryCount ? `项目知识（${memoryCount} 条）` : "项目知识"}
          title={memoryCount ? `项目知识（${memoryCount} 条）— 查看或修改这个项目的长期规矩` : "项目知识 — 查看或新增这个项目的长期规矩"}
          onClick={() => setMemoryOpen(true)}
        >
          <BookMarked size={14} strokeWidth={1.8} aria-hidden="true" />
          {memoryCount != null && memoryCount > 0 && (
            <span className="pointer-events-none absolute -right-0.5 top-0.5 min-w-3.5 rounded-full bg-inset px-1 text-center text-micro font-medium leading-3.5 text-l2 ring-1 ring-hairline">
              {memoryCount > 99 ? "99+" : memoryCount}
            </span>
          )}
        </button>
      )}
      {turns.length > 0 && (
        <div className="relative" data-assistant-menu>
          <button
            type="button"
            className={`relative inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              headerMenuOpen ? "bg-hover text-l1" : "text-l3 hover:bg-hover hover:text-l1"
            }`}
            aria-label="更多操作"
            aria-expanded={headerMenuOpen}
            title={dueForSummary ? "更多操作（聊了一阵了，可整理定下的事）" : "更多操作"}
            onClick={() => setHeaderMenuOpen((v) => !v)}
          >
            <MoreHorizontal size={15} strokeWidth={1.8} aria-hidden="true" />
            {dueForSummary && (
              <span className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-mesa-amber" aria-hidden="true" />
            )}
          </button>
          {headerMenuOpen && (
            <div
              role="menu"
              className="ccode-float-surface absolute right-0 top-8 z-30 min-w-44 rounded-lg border border-field p-1 shadow-md"
            >
              {turns.length >= 2 && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-l1 hover:bg-hover disabled:opacity-50"
                  title="把最近这阵聊定下的长期规矩整理出来，你逐条确认才记进项目知识"
                  onClick={() => {
                    setHeaderMenuOpen(false);
                    const f = summaryFocus(turns, summarizedAt);
                    markSummarized();
                    void send(SUMMARY_QUESTION, f, "project");
                  }}
                >
                  <span>整理定下的事</span>
                  {dueForSummary && <span className="size-1.5 rounded-full bg-mesa-amber" aria-hidden="true" />}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-l2 hover:bg-hover hover:text-err-text disabled:opacity-50"
                onClick={() => {
                  setHeaderMenuOpen(false);
                  void clear();
                }}
              >
                清空记录
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const composer = (
    <div className="space-y-2">
      {focus && (
        <p className="text-xs text-l3">
          这次重点：{focus.title}
          <button type="button" className="ml-2 text-l3 underline hover:text-l1" onClick={() => setFocus(null)}>
            不带
          </button>
        </p>
      )}
      {!empty && quickAsksOpen && (
        <div
          data-assistant-menu
          className="rounded-xl border border-hairline bg-raised p-1.5 shadow-sm"
          aria-label="推荐问题"
        >
          <p className="px-2 pb-1 pt-0.5 text-micro text-l4">推荐问题</p>
          {asks.map((a) => (
            <button
              key={a.q}
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-l1 hover:bg-hover disabled:opacity-50"
              disabled={busy}
              title={a.hint}
              onClick={() => {
                setQuickAsksOpen(false);
                void send(a.q, a.focus ?? focus);
              }}
            >
              <span className="min-w-0 truncate">{a.q}</span>
              <ArrowRight size={12} className="shrink-0 text-l4" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label="附的截图">
          {images.map((img, i) => (
            <span key={img.path} className="group relative">
              <img src={img.url} alt={`截图 ${i + 1}`} className="size-12 rounded-md border border-hairline object-cover" />
              <button
                type="button"
                className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-raised text-l3 shadow-none ring-1 ring-hairline hover:text-l1"
                aria-label={`去掉截图 ${i + 1}`}
                onClick={() => {
                  URL.revokeObjectURL(img.url);
                  blobUrlsRef.current.delete(img.url);
                  setImages((cur) => cur.filter((x) => x.path !== img.path));
                }}
              >
                <X size={10} strokeWidth={2} aria-hidden="true" />
              </button>
            </span>
          ))}
          {!imageCapable && (
            <span className="min-w-0 flex-1 text-micro text-warn-text">
              现在的连接看不了图：到 Agent 分工换成 Claude Code / Codex / Kimi Code / Grok Build，或把图里的字打出来
              {inspectFallback && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="underline decoration-dotted underline-offset-2 hover:text-l1"
                    disabled={busy}
                    onClick={() => void send(draft, focus, "mixed", images, true, inspectFallback)}
                  >
                    <span className="text-micro">借用 {inspectFallback.agentLabel} 看图发送</span>
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      )}
      {imageNote && <p className="text-micro text-warn-text">{imageNote}</p>}
      {mentionRange && (
        <div
          className="max-h-48 overflow-auto rounded-lg border border-hairline bg-raised p-1 shadow-sm"
          role="listbox"
          aria-label="引用项目文件"
        >
          {mentionFiles === null ? (
            <p className="px-2 py-1 text-xs text-l4">正在读取项目文件列表…</p>
          ) : mentionMatches.length === 0 ? (
            <p className="px-2 py-1 text-xs text-l4">没有匹配的项目文件</p>
          ) : (
            mentionMatches.map((entry, idx) => (
              <button
                key={entry.path}
                type="button"
                role="option"
                aria-selected={idx === mentionIdx}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-xs ${
                  idx === mentionIdx ? "bg-hover text-l1" : "text-l2 hover:bg-hover hover:text-l1"
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickMention(entry.path);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{entry.path}</span>
              </button>
            ))
          )}
        </div>
      )}
      <form
        className="ccode-assistant-composer flex items-end gap-2 rounded-xl border border-hairline bg-inset px-3 py-2 focus-within:border-l4"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft, focus);
        }}
        onDragOver={(event) => {
          const items = Array.from(event.dataTransfer.items);
          if (items.some((it) => it.type.startsWith("image/") || it.kind === "file" || it.type === "text/plain")) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          const imgFiles = Array.from(event.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
          if (imgFiles.length > 0) {
            event.preventDefault();
            for (const f of imgFiles) void addImageFile(f);
            return;
          }
          const rawText = event.dataTransfer.getData("text/plain").trim();
          if (rawText && projectPath) {
            const normRoot = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
            const normRaw = rawText.replace(/^file:\/\//i, "").replace(/\\/g, "/");
            let rel = normRaw;
            if (normRaw.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
              rel = normRaw.slice(normRoot.length + 1);
            }
            if (rel && !rel.startsWith("/") && !rel.includes("..")) {
              event.preventDefault();
              setDraft((cur) => `${cur}${cur && !/\s$/.test(cur) ? " " : ""}\`${rel}\` `);
            }
          }
        }}
      >
        {!empty && (
          <button
            type="button"
            data-assistant-menu
            className={`mb-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
              quickAsksOpen ? "bg-hover text-l1" : "text-l4 hover:bg-hover hover:text-l1"
            }`}
            aria-label="推荐问题"
            aria-expanded={quickAsksOpen}
            title="推荐问题"
            disabled={busy}
            onClick={() => setQuickAsksOpen((v) => !v)}
          >
            <MessageCircleQuestion size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        <textarea
          ref={inputRef}
          className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent py-0.5 text-sm leading-6 text-l1 outline-none placeholder:text-l4"
          rows={1}
          value={draft}
          maxLength={2000}
          placeholder={mood.restPose === "sleep" ? "问点什么，它就醒…" : "问点什么…（可 @ 引用文件或粘贴截图）"}
          aria-label="问项目助手"
          onPaste={(event) => {
            // 剪贴板里有图就接管（存成附图），纯文字照常粘贴
            const items = Array.from(event.clipboardData?.items ?? []);
            const idx = firstImageItem(items);
            if (idx < 0) return;
            event.preventDefault();
            const file = items[idx].getAsFile();
            if (file) void addImageFile(file);
          }}
          onChange={(event) => {
            const val = event.target.value;
            setDraft(val);
            updateMentionFromInput(val, event.target.selectionStart);
            const el = event.target;
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
          }}
          onClick={(event) => updateMentionFromInput(event.currentTarget.value, event.currentTarget.selectionStart)}
          onKeyUp={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              updateMentionFromInput(event.currentTarget.value, event.currentTarget.selectionStart);
            }
          }}
          onKeyDown={(event) => {
            if (mentionRange && mentionMatches.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMentionIdx((i) => (i + 1) % mentionMatches.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                return;
              }
              if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                pickMention(mentionMatches[Math.min(mentionIdx, mentionMatches.length - 1)].path);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionRange(null);
                return;
              }
            } else if (mentionRange && event.key === "Escape") {
              event.preventDefault();
              setMentionRange(null);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send(draft, focus);
            }
          }}
        />
        {/* 发送钮与聊天输入框同一块 M▁ 光标（App.css .ccode-send-block）：没字是淡箭头，有字亮琥珀，问着时变成停止钮 */}
        <button
          type={busy ? "button" : "submit"}
          className="ccode-send-block mb-0.5"
          data-state={busy ? "stop" : draft.trim() || images.length ? "ready" : "empty"}
          disabled={!busy && !draft.trim() && images.length === 0}
          aria-label={busy ? "停止" : "发送"}
          title={busy ? "停止这次提问（原问题放回输入框）" : "Enter 发送 · Shift+Enter 换行"}
          onClick={busy ? stopAsk : undefined}
        >
          <ArrowUp size={13} strokeWidth={2.4} aria-hidden="true" className="ccode-send-arrow" />
          <Square size={8} strokeWidth={0} fill="currentColor" aria-hidden="true" className="ccode-send-stop" />
        </button>
      </form>
      {/* 输入框下方清晰标明底层运行形态（只读 Agent / 只读查文件 / 仅看记录）与实际运行的 Agent · 连接 · 模型 */}
      <div className="flex items-center justify-between gap-2 text-micro text-l4">
        <span
          className="inline-flex shrink-0 items-center gap-1.5 text-micro text-l4"
          title={conn.modeHint}
        >
          <span
            className={`size-1.5 rounded-full ${
              conn.agentId !== null && TIER1_ASSISTANT_AGENTS.includes(conn.agentId)
                ? "bg-ok-text/80"
                : imageCapable
                  ? "bg-l3"
                  : "bg-warn-text/80"
            }`}
            aria-hidden="true"
          />
          {conn.modeLabel}
        </span>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 truncate text-l4 hover:text-l2"
          title={`${conn.line}${conn.bound ? "（Agent 分工里给项目助手绑的）" : "（跟随项目默认）"}\n${conn.modeHint}${
            !imageCapable && inspectFallback ? `；回答右上角 ⋯ 可借用 ${inspectFallback.agentLabel} 查文件` : ""
          }\n点击去 Agent 分工切换`}
          onClick={() => onAction({ kind: "agents", step: null, text: "", label: "去 Agent 分工" }, { at: "", question: "", answer: "", connection: "" })}
        >
          <span className="truncate text-micro">{conn.shortLine}</span>
        </button>
      </div>
    </div>
  );

  return (
    <SettingsDrawerShell
      className="ccode-workbench-detail"
      backdropClassName="ccode-workbench-detail-backdrop"
      open={open && !!projectPath}
      onClose={onClose}
      title="项目助手"
      subtitle={hideProjectName ? undefined : projectName}
      titleIcon={empty ? <></> : <MesaBuddy size={28} pose={headPose} prop={busy || error || cheer ? null : mood.prop} />}
      footer={composer}
      docked={docked}
      headerExtra={headerTools}
    >
      {/* 顶部唯一粘滞区：合并「等你的事」与「现在的情况」，以及按需展开的历史搜索条；都为空时 empty:hidden 不占位 */}
      <div className="sticky top-0 z-10 -mx-5 -mt-4 mb-2 bg-canvas empty:hidden">
        {projectPath && (
          <AssistantDesk
            projectPath={projectPath}
            briefLines={activeBriefLines}
            briefSince={brief?.since ?? null}
            assistantBusy={busy}
            onBriefAction={(action) => onAction(action, { at: "", question: "", answer: "", connection: "" })}
            onBriefAsk={(line) => {
              if (line.kind === "knowledge-draft" && projectPath) {
                try {
                  localStorage.setItem(NO_DRAFT_KEY(projectPath), "1");
                } catch {
                  /* 存不了就只是这次收起 */
                }
                setBrief((b) => (b ? { ...b, lines: b.lines.filter((l) => l.kind !== "knowledge-draft") } : b));
              }
              void send(line.ask!.question, line.ask!.focus, line.ask!.intent);
            }}
            onDismissBrief={() => {
              markSeenNow(projectPath);
              setBriefOff(true);
            }}
            onDismissKnowledgeDraft={() => {
              if (!projectPath) return;
              try {
                localStorage.setItem(NO_DRAFT_KEY(projectPath), "1");
              } catch {
                /* 存不了就只是这次收起 */
              }
              setBrief((b) => (b ? { ...b, lines: b.lines.filter((l) => l.kind !== "knowledge-draft") } : b));
            }}
          />
        )}
        {searchOpen && turns.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-canvas px-5 py-2">
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              placeholder="搜历史问答或派活标题…"
              aria-label="搜索项目助手历史问答"
              className="min-w-0 flex-1 bg-transparent text-xs text-l1 outline-none placeholder:text-l4"
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setSearchOpen(false);
                  setSearchQuery("");
                  setOnlyDispatches(false);
                }
              }}
            />
            {(onlyDispatches || (hasDispatches && turns.some((t) => !t.dispatched && !t.echoOf))) && (
              <button
                type="button"
                className={`shrink-0 rounded-full border px-2 py-0.5 text-micro transition-colors ${
                  onlyDispatches
                    ? "border-cta-bd bg-hover font-medium text-l1"
                    : "border-hairline text-l3 hover:text-l1"
                }`}
                aria-pressed={onlyDispatches}
                onClick={() => setOnlyDispatches((v) => !v)}
              >
                <span className="text-micro">仅派活</span>
              </button>
            )}
            <span className="shrink-0 text-micro tabular-nums text-l4">
              {trimmedSearch || onlyDispatches ? `${visibleTurns.length}/${turns.length}` : `${turns.length} 轮`}
            </span>
            <button
              type="button"
              className="shrink-0 text-l4 hover:text-l1"
              aria-label="关闭搜索"
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery("");
                setOnlyDispatches(false);
              }}
            >
              <X size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      {empty ? (
        <div className="px-1 pt-8">
          <MesaBuddy size={72} pose={mood.greetPose} prop={mood.prop} />
          <h3 className="mt-5 text-lg font-semibold text-l1">{mood.greeting}</h3>
          <p
            className="mt-2 text-sm leading-6 text-l3"
            title="交代要做的事，我问清楚后起草派活单，你点「派出去」才交给 AI 做；我自己不改文件"
          >
            问项目里的事，或交代要做的事。
          </p>
          {/* 建议问题：行间留白 + 悬停整行浅底，不画横线；记号是淡灰 M▁ 横光标，悬停才亮成琥珀（琥珀只表示「你在这里写 / 轮到你」，常亮会读成三件事在等你） */}
          <ul className="-mx-2 mt-8 space-y-0.5">
            {asks.map((a) => (
              <li key={a.q}>
                <button
                  type="button"
                  className="group flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-hover"
                  onClick={() => void send(a.q, a.focus ?? focus)}
                >
                  <span
                    className="ml-1 h-[3px] w-2.5 shrink-0 rounded-sm bg-l4 transition-colors group-hover:bg-mesa-amber group-focus-visible:bg-mesa-amber"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-l1">{a.q}</span>
                    <span className="block text-xs text-l3">{a.hint}</span>
                  </span>
                  <ArrowRight size={14} className="mr-1 shrink-0 text-l4 group-hover:text-l2" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {visibleTurns.length === 0 && (trimmedSearch || onlyDispatches) ? (
            <p className="py-6 text-center text-xs text-l4">
              {trimmedSearch ? `没有匹配「${trimmedSearch}」的历史记录` : "暂无派活记录"}
            </p>
          ) : (
            visibleTurns.map(({ turn, i }, vi, visible) => {
              // 换天时先画一道分隔（本机时区）；同一天的不画
              const prev = vi > 0 ? visible[vi - 1].turn : null;
              const divider =
                turn.at && (!prev || !sameLocalDay(prev.at, turn.at)) ? (
                  <div className="flex items-center gap-2 text-micro text-l4" role="separator" aria-label={assistantDayLabel(turn.at)}>
                    <span className="h-px flex-1 bg-hairline" aria-hidden="true" />
                    {assistantDayLabel(turn.at)}
                    <span className="h-px flex-1 bg-hairline" aria-hidden="true" />
                  </div>
                ) : null;
              return (
                <Fragment key={`${turn.at}-${i}`}>
                  {divider}
                  {renderTurn(turn, i)}
                </Fragment>
              );
            })
          )}
          {busy && (
            <article className="flex flex-col gap-3">
              {pending && <QuestionBubble text={pending} />}
              <div className="flex min-w-0 items-center gap-2 text-sm text-l3">
                {/* 与聊天层生成中那一行同一个 M▁ 状态头（MesaStatusLead：光标呼吸 + 光带扫过），2026-11-04 用户：「用 Mesa 的聊天层图标显示」；
                    只读查看时实时写正在读哪个文件 / 搜什么（后端推来的步骤） */}
                <MesaStatusLead
                  text={
                    liveStep ??
                    (liveText
                      ? "正在写…"
                      : conn.agentId !== null && TIER1_ASSISTANT_AGENTS.includes(conn.agentId)
                        ? "正在查看项目…"
                        : inspecting
                          ? INSPECT_WAITING
                          : INTENT_WAITING[intent])
                  }
                  motion={liveText ? "write" : liveStep ? "read" : "thinking"}
                  sweep
                />
                {waited >= 3 && (
                  <span className="shrink-0 text-xs tabular-nums text-l4" aria-hidden="true">
                    {waited} 秒
                  </span>
                )}
              </div>
              {/* 边生成边出字：动作标记、派活单写完前先不画，最终回答到了整段换上 */}
              {liveText && (
                <div className="text-sm text-l1">
                  <ChatMarkdown text={guardClaims(resolveTurnParts({ answer: liveText }, stepCount).text).text.replace(/\[\[[^\]]*$|:::[\s\S]*$/, "")} cwd={projectPath} />
                </div>
              )}
            </article>
          )}
          {error && (
            <article className="flex flex-col gap-3">
              {failed && <QuestionBubble text={failed.question} />}
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm leading-6 text-err-text">没问成：{error}</p>
                  {failed && (
                    <button
                      type="button"
                      className={`${secondaryActionClass} mt-2`}
                      onClick={() => {
                        setError(null);
                        void send(failed.question, failed.focus, undefined, failed.images ?? []);
                      }}
                    >
                      再问一次
                    </button>
                  )}
                </div>
              </div>
            </article>
          )}
        </div>
      )}
      {!atEnd && turns.length > 0 && (
        // 回到最新：照聊天层（ChatSurface）的悬浮圆钮——零高粘底层挂在滚动区里，浮在可视区底边上方、不占版面；
        // 正在问时是三枚琥珀光标（鼠标移上去换成 ↓），平时只有 ↓。mb-0 盖掉外壳 space-y 给的下边距。
        // 粘底偏移从滚动区内边距里面算起：外壳滚动区自带 pb-6（24px），-bottom-3 才落在可视底边上方 12px，
        // 与聊天层一样（WKWebView 实测：bottom-3 时离底 36px，2026-11-09 用户「有点高了」）
        <div data-scroll-control className="pointer-events-none sticky -bottom-3 z-10 mb-0 h-0">
          <div className="absolute inset-x-0 bottom-0 flex justify-center">
            <button
              type="button"
              onClick={() => endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })}
              // 光标换队时会探出内容框一点点：Chromium（WebView2）给 button 的 overflow 不是 visible，会冒出滚动条
              style={{ overflow: "visible" }}
              aria-label={busy ? "回到最新（正在问）" : "回到最新"}
              title="回到最新"
              className="ccode-float-surface group/jump pointer-events-auto relative flex size-8 shrink-0 items-center justify-center rounded-full border border-hairline text-l2 transition-colors hover:border-field hover:text-l1"
            >
              {busy ? (
                <>
                  <MesaThinkingDots className="absolute inset-0 transition-opacity group-hover/jump:opacity-0 group-focus-visible/jump:opacity-0" />
                  <span className="relative flex size-3.5 items-center justify-center">
                    <ArrowDown
                      size={14}
                      strokeWidth={2}
                      aria-hidden="true"
                      className="absolute opacity-0 transition-opacity group-hover/jump:opacity-100 group-focus-visible/jump:opacity-100"
                    />
                  </span>
                </>
              ) : (
                <ArrowDown size={14} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      )}
      <div ref={endRefCb} className="h-px" aria-hidden="true" />
      <GuideSectionModal heading={guideHeading} onClose={() => setGuideHeading(null)} />
      {projectPath && (
        <Modal
          open={memoryOpen}
          onClose={() => setMemoryOpen(false)}
          size="lg"
          layer="overlay"
          title="项目知识"
          description={`${projectName} · 记在这里的「已定 / 不做」会带给项目助手和干活的 AI`}
          footer={
            <button type="button" className={secondaryActionClass} onClick={() => setMemoryOpen(false)}>
              关闭
            </button>
          }
        >
          <ProjectMemoryPanel
            projectPath={projectPath}
            workMode={project?.workMode}
            compact
            defaultOpen
            onChanged={() => {
              setMemoryTick((n) => n + 1);
            }}
          />
        </Modal>
      )}
    </SettingsDrawerShell>
  );
}
