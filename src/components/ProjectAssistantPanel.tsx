import { Fragment, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, ArrowUp, X } from "lucide-react";
import { SettingsDrawerShell } from "./ProjectSettingsDrawer";
import { ghostActionClass, secondaryActionClass } from "./PageFrame";
import ChatMarkdown from "./ChatMarkdown";
import MesaBuddy from "./MesaBuddy";
import { MesaStatusLead } from "./MesaMark";
import { absTime, relTime } from "../rel-time";
import { toast } from "../toast";
import { useAppStore } from "../store";
import { resumeDispatchedGoal } from "../assistant-dispatch";
import { quickIntent } from "../im-route";
import { buddyDayPart, buddyMood } from "../buddy-time";
import {
  assistantErrorText,
  basisGuideHeadings,
  INSPECT_WAITING,
  INTENT_WAITING,
  localReply,
  retryIntents,
  parseAssistantAnswer,
  guardClaims,
  parseClarify,
  parseRemember,
  parseReworkOrder,
  parseWorkOrder,
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
import type { DispatchRecord, DispatchResult } from "../assistant-dispatch";
import { briefLines, quickAsks, SUMMARY_QUESTION, summaryDue, summaryFocus, type BriefLine, type QuickAsk } from "../assistant-brief";
import { assistantDayLabel, sameLocalDay } from "../assistant-dock";
import {
  askProjectAssistant,
  assistantConnection,
  gatherBriefInput,
  planAsk,
  prefetchSnapshot,
  type AssistantFocus,
  type AssistantTurn,
} from "../project-assistant-run";
import type { ProjectDto } from "../types";
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

const BRIEF_TONE: Record<BriefLine["tone"], string> = {
  err: "bg-err-text",
  warn: "bg-mesa-amber",
  ok: "bg-ok-text",
};

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
  ask,
  onAction,
  onDispatch,
  where = "",
  docked = null,
}: {
  /** 用户此刻在看哪（「项目页 · HER催化综述 ·「定时任务」页签」）：提问时附上，问「这个提示什么意思」时它知道「这个」在哪 */
  where?: string;
  /** 常驻侧栏（宿主够宽时给）；null = 浮层抽屉 */
  docked?: { width: number; onResize: (width: number) => void; onResizeEnd?: () => void } | null;
  open: boolean;
  onClose: () => void;
  projectPath: string | null;
  projectName: string;
  project: ProjectDto | null;
  stepCount: number;
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
  async function addImageFile(file: File) {
    if (images.length >= MAX_ASSISTANT_IMAGES) {
      setImageNote(`一次最多附 ${MAX_ASSISTANT_IMAGES} 张截图`);
      return;
    }
    try {
      const path = await saveClipboardImage(await file.arrayBuffer(), imageExtFromMime(file.type));
      setImages((cur) => (cur.length >= MAX_ASSISTANT_IMAGES ? cur : [...cur, { path, url: URL.createObjectURL(file) }]));
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
  // 能看图的只有 Claude Code / Codex（走只读查看那条路）；走「AI 功能」连接时前端不知道是哪家，先不拦，后端会说
  const imageCapable = conn.agentId === null || conn.agentId === "claude-code" || conn.agentId === "codex";
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
  useEffect(() => {
    if (!open || !projectPath || echoTick === 0) return;
    let stale = false;
    invoke<AssistantTurn[]>("assistant_log_read", { projectRoot: projectPath })
      .then((list) => {
        if (!stale) setTurns(list);
      })
      .catch(() => {});
    // 派出去的活有了进展：卡和常用问题跟着换（since 沿用这次打开时的）
    gatherBriefInput(projectPath, brief?.since ?? null)
      .then((input) => {
        if (!stale) setBrief({ lines: briefLines({ ...input, knowledgeEmpty: input.knowledgeEmpty && !draftDismissed(projectPath) }), asks: quickAsks(input), since: brief?.since ?? null });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [echoTick, open, projectPath]);

  useEffect(() => {
    if (!open || !projectPath) return;
    let stale = false;
    setError(null);
    setFreshAt(null);
    // 一打开就先把项目记录整理好，问项目类问题时不再等这一段
    prefetchSnapshot(projectPath);
    setBriefOff(false);
    let since: string | null = null;
    try {
      since = localStorage.getItem(SEEN_KEY(projectPath));
      localStorage.setItem(SEEN_KEY(projectPath), new Date().toISOString());
    } catch {
      /* 存不了就只列现状 */
    }
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
    };
  }, [open, projectPath]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, busy, error, liveText, liveStep]);

  // 往上翻过以后底部给「回到最新」：看末尾那个锚点还在不在视野里
  const [atEnd, setAtEnd] = useState(true);
  useEffect(() => {
    const el = endRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setAtEnd(entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [open]);

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

  async function send(question: string, withFocus: AssistantFocus | null, forced?: AssistantIntent, attached: AssistantImage[] = images) {
    // 只贴了图没写字：替人补一句最常见的问法
    const q = question.trim() || (attached.length ? "看看这张截图是怎么回事，我该怎么办？" : "");
    if (!q || busy || !projectPath) return;
    // 「派出去」「接着做」照字面办，不交给 AI（它自己做不了动作，交给它只会被说成「已经派出去了」，2026-11-06 实证）
    const quick = !withFocus && !forced && !attached.length ? quickIntent(q) : null;
    if (quick) {
      setDraft("");
      if (quick === "dispatch") {
        const steps = stepCount;
        const last = [...turns].reverse().find((t) => !t.echoOf && t.answer.includes(":::派活"));
        const order = last ? parseWorkOrder(parseReworkOrder(parseClarify(parseRemember(last.answer).text).text, steps).text, steps).order : null;
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
    setIntent(plan.intent);
    setInspecting(plan.inspect);
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
        inspect: plan.inspect,
        images: attached.map((img) => img.path),
        where,
        onStream: (update) => {
          if (update.text !== undefined) setLiveText(update.text);
          if (update.step) setLiveStep(update.step);
        },
      });
      setTurns((list) => [...list, turn]);
      setFreshAt(turn.at);
      setFocus(null);
    } catch (reason) {
      setError(assistantErrorText(String(reason)));
      setFailed({ question: q, focus: withFocus, images: attached });
    } finally {
      setBusy(false);
      setPending(null);
      setLiveText("");
      setLiveStep(null);
    }
  }

  // 带着问题打开：只问一次（同一个 nonce 不重问）
  useEffect(() => {
    if (!open || !ask || askedNonce.current === ask.nonce) return;
    askedNonce.current = ask.nonce;
    setFocus(ask.focus);
    void send(ask.question, ask.focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ask]);

  async function clear() {
    if (!projectPath) return;
    try {
      await invoke("assistant_log_clear", { projectRoot: projectPath });
      setTurns([]);
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
    const withMemo = parseRemember(turn.answer);
    const withAsk = parseClarify(withMemo.text);
    const withRework = parseReworkOrder(withAsk.text, stepCount);
    const withOrder = parseWorkOrder(withRework.text, stepCount);
    const parsed = parseAssistantAnswer(withOrder.text, stepCount);
    // 只有最后一轮的问题能点选作答（前面的已经答过了）
    const openAsk = i === turns.length - 1 ? withAsk.ask : null;
    // 话与事实分开：它声称自己做了动作的句子换成如实说明（根源三，2026-11-06）
    const { lead, rest } = splitAnswerLead(guardClaims(parsed.text).text);
    return (
      <article key={`${turn.at}-${i}`} className="flex flex-col gap-3">
        <QuestionBubble text={turn.question} at={turn.at} />
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="h-[3px] w-2.5 shrink-0 rounded-sm bg-mesa-amber" aria-hidden="true" />
            <span className="text-xs text-l3" title={`${absTime(turn.at)}${turn.connection ? ` · ${turn.connection}` : ""}`}>
              项目助手 · {relTime(turn.at)}
            </span>
          </div>
          {lead && (
            <p className="mb-2 border-l-2 border-mesa-amber pl-3 text-sm font-medium leading-6 text-l1">{lead}</p>
          )}
          {rest && (
            <div className="text-sm text-l1">
              <ChatMarkdown text={rest} cwd={projectPath} />
            </div>
          )}
          {withAsk.ask && (
            <section className="mt-3 rounded-xl border border-hairline p-3" aria-label="要先问你一句">
              <p className="text-sm font-medium leading-6 text-l1">{withAsk.ask.question}</p>
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
          {withMemo.remembers.map((r) => (
            <RememberCard key={r} text={r} projectPath={projectPath} />
          ))}
          {withRework.rework && (
            <ReworkOrderCard
              order={withRework.rework}
              record={turn.dispatched ?? null}
              projectPath={projectPath}
              onSent={(record) => saveDispatched(turn.at, record)}
            />
          )}
          {withOrder.order && (
            <WorkOrderCard
              order={withOrder.order}
              record={turn.dispatched ?? null}
              projectPath={projectPath}
              onDispatch={(order) => dispatch(turn.at, order)}
            />
          )}
          {parsed.actions.length > 0 && (
            // 一条回答只一个显眼的按钮：有单子时主按钮是单子上的「派出去」，这里全降成文字按钮；否则第一个是次级按钮
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {parsed.actions.map((action, ai) => (
                <button
                  key={`${action.kind}-${action.step ?? ""}`}
                  type="button"
                  className={ai === 0 && !withOrder.order && !withRework.rework ? secondaryActionClass : ghostActionClass}
                  title={action.text || undefined}
                  onClick={() => onAction(action, turn)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
          {/* 依据、花费、换个查法并成一行小字（原来各占一行） */}
          {(() => {
            const retry = i === turns.length - 1 && !busy ? retryIntents(turn.basis, turn.connection) : [];
            if (!turn.basis && turn.costUsd == null && retry.length === 0) return null;
            const heads = turn.basis ? basisGuideHeadings(turn.basis) : [];
            const tail = turn.basis ? turn.basis.replace(/^说明书(「[^」]+」)+/, "") : "";
            const dot = <span aria-hidden="true"> · </span>;
            return (
              <p className="mt-2 flex flex-wrap items-center gap-x-1 text-micro text-l4">
                {turn.basis && (
                  <span>
                    依据：
                    {heads.length === 0 ? (
                      turn.basis
                    ) : (
                      <>
                        说明书
                        {heads.map((h) => (
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
                        {tail}
                      </>
                    )}
                  </span>
                )}
                {/* 这次调用花了多少（只有 Claude Code / Codex、模型查得到价时有；同用量页口径） */}
                {turn.costUsd != null && (
                  <span title="这次问答的花费（用量页同一口径，记在内部活动里）">
                    {turn.basis && dot}${turn.costUsd < 0.1 ? turn.costUsd.toFixed(3) : turn.costUsd.toFixed(2)}
                  </span>
                )}
                {retry.length > 0 && (
                  <span>
                    {(turn.basis || turn.costUsd != null) && dot}没答到点上？
                    {retry.map((r, ri) => (
                      <button
                        key={r.intent}
                        type="button"
                        className="text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                        onClick={() => void send(turn.question, null, r.intent)}
                      >
                        <span className="text-micro">{ri > 0 ? " / " : ""}{r.label}</span>
                      </button>
                    ))}
                  </span>
                )}
              </p>
            );
          })()}
        </div>
      </article>
    );
  }

  // 「现在的情况」：Mesa 按记录写，不经 AI；没有要看的事、也没有变化就不出现
  const briefCard =
    brief && brief.lines.length > 0 && !briefOff ? (
      <section className="rounded-xl border border-hairline px-3 py-2.5" aria-label="现在的情况">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="text-xs font-medium text-l2">现在的情况</span>
          <span className="min-w-0 flex-1 truncate text-micro text-l4" title={brief.since ? absTime(brief.since) : undefined}>
            Mesa 按记录整理{brief.since ? ` · 上次打开是${relTime(brief.since)}` : ""}
          </span>
          <button type="button" className="shrink-0 text-l4 hover:text-l2" onClick={() => setBriefOff(true)}>
            <span className="text-micro">知道了</span>
          </button>
        </div>
        <ul className="space-y-1">
          {brief.lines.map((line) => (
            <li key={line.text} className="flex items-start gap-2 text-xs leading-5">
              <span className={`mt-2 size-1.5 shrink-0 rounded-full ${BRIEF_TONE[line.tone]}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words text-l1">{line.text}</span>
              {line.action && (
                <button
                  type="button"
                  className="shrink-0 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                  onClick={() => onAction(line.action!, { at: "", question: "", answer: "", connection: "" })}
                >
                  <span className="text-xs">{line.action.label}</span>
                </button>
              )}
              {line.ask && (
                <button
                  type="button"
                  className="shrink-0 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void send(line.ask!.question, line.ask!.focus, line.ask!.intent)}
                >
                  <span className="text-xs">{line.ask.label ?? "问问为什么"}</span>
                </button>
              )}
              {line.kind === "knowledge-draft" && projectPath && (
                <button
                  type="button"
                  className="shrink-0 text-l4 hover:text-l2"
                  title="这个项目不再提议起草；以后照样可以在回答下面点「记进项目知识」"
                  onClick={() => {
                    try {
                      localStorage.setItem(NO_DRAFT_KEY(projectPath), "1");
                    } catch {
                      /* 存不了就只是这次收起 */
                    }
                    setBrief((b) => (b ? { ...b, lines: b.lines.filter((l) => l.kind !== "knowledge-draft") } : b));
                  }}
                >
                  <span className="text-xs">不用了</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  const composer = (
    <div className="space-y-2">
      {!busy && summaryDue(turns, summarizedAt) && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-l3">
          <span>聊了一阵了，要不要我把这一阵定下的事整理一下？值得以后照办的会起草出来，你逐条点了才记。</span>
          <button
            type="button"
            className="text-l2 underline decoration-dotted underline-offset-2 hover:text-l1"
            onClick={() => {
              const f = summaryFocus(turns, summarizedAt);
              markSummarized();
              void send(SUMMARY_QUESTION, f, "project");
            }}
          >
            <span className="text-xs">整理一下</span>
          </button>
          <button type="button" className="text-l4 hover:text-l2" onClick={markSummarized}>
            <span className="text-xs">不用</span>
          </button>
        </p>
      )}
      {!atEnd && turns.length > 0 && (
        <div className="flex justify-center">
          <button
            type="button"
            className="h-6 rounded-full border border-hairline bg-canvas px-2.5 text-l3 hover:bg-hover hover:text-l1"
            onClick={() => endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })}
          >
            <span className="text-xs">回到最新 ↓</span>
          </button>
        </div>
      )}
      {focus && (
        <p className="text-xs text-l3">
          这次重点：{focus.title}
          <button type="button" className="ml-2 text-l3 underline hover:text-l1" onClick={() => setFocus(null)}>
            不带
          </button>
        </p>
      )}
      {!empty && (
        <div className="flex flex-wrap gap-1.5">
          {asks.map((a) => (
            <button
              key={a.q}
              type="button"
              className="h-6 max-w-full truncate rounded-full border border-hairline px-2.5 text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              disabled={busy}
              title={a.hint}
              onClick={() => void send(a.q, a.focus ?? focus)}
            >
              {/* 字号写内层：全站 button { font: inherit } 会吞掉按钮上的 text-* */}
              <span className="text-xs">{a.q}</span>
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
                onClick={() => setImages((cur) => cur.filter((x) => x.path !== img.path))}
              >
                <X size={10} strokeWidth={2} aria-hidden="true" />
              </button>
            </span>
          ))}
          {!imageCapable && (
            <span className="min-w-0 flex-1 text-micro text-warn-text">
              现在的连接看不了图：到 Agent 分工给项目助手换成 Claude Code / Codex，或把图里的字打出来
            </span>
          )}
        </div>
      )}
      {imageNote && <p className="text-micro text-warn-text">{imageNote}</p>}
      <form
        className="ccode-assistant-composer flex items-end gap-2 rounded-xl border border-hairline bg-inset px-3 py-2 focus-within:border-l4"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft, focus);
        }}
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer.items).some((it) => it.type.startsWith("image/"))) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
          if (files.length === 0) return;
          event.preventDefault();
          for (const f of files) void addImageFile(f);
        }}
      >
        <textarea
          ref={inputRef}
          className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent py-0.5 text-sm leading-6 text-l1 outline-none placeholder:text-l4"
          rows={1}
          value={draft}
          maxLength={2000}
          placeholder={mood.restPose === "sleep" ? "问点什么，它就醒…" : "问点什么…（可以粘贴截图）"}
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
            setDraft(event.target.value);
            const el = event.target;
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send(draft, focus);
            }
          }}
        />
        {/* 发送钮与聊天输入框同一块 M▁ 光标（App.css .ccode-send-block）：没字是淡箭头，有字亮琥珀，问着时半透明 */}
        <button
          type="submit"
          className="ccode-send-block mb-0.5"
          data-state={busy ? "sending" : draft.trim() || images.length ? "ready" : "empty"}
          disabled={busy || (!draft.trim() && images.length === 0)}
          aria-label="发送"
          title={busy ? "正在问…" : "Enter 发送 · Shift+Enter 换行"}
        >
          <ArrowUp size={13} strokeWidth={2.4} aria-hidden="true" className="ccode-send-arrow" />
        </button>
      </form>
      <div className="flex items-center gap-2 text-micro text-l4">
        <span
          className="min-w-0 flex-1 truncate"
          title={conn.bound ? "Agent 分工里给项目助手绑的连接" : "项目助手没单独绑连接，跟随项目默认；可在 Agent 分工里指定"}
        >
          {conn.line}
          {conn.bound ? "" : " · 跟随项目默认"}
        </span>
        {turns.length > 0 && (
          <button type="button" className="shrink-0 text-l4 hover:text-l2 disabled:opacity-50" disabled={busy} onClick={() => void clear()}>
            <span className="text-micro">清空记录</span>
          </button>
        )}
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
      subtitle={projectName}
      titleIcon={empty ? <></> : <MesaBuddy size={34} pose={headPose} prop={busy || error || cheer ? null : mood.prop} />}
      footer={composer}
      docked={docked}
    >
      {/* 调度台：这个项目里等你的事，就地回、原路转达（2026-11-06） */}
      {projectPath && <AssistantDesk projectPath={projectPath} />}
      {empty ? (
        <div className="px-1 pt-8">
          <MesaBuddy size={112} pose={mood.greetPose} prop={mood.prop} />
          <h3 className="mt-5 text-lg font-semibold text-l1">{mood.greeting}</h3>
          <p className="mt-2 text-sm leading-6 text-l3">
            问这个项目里的事，或直接交代要做的事：我问清楚后起草派活单，你点「派出去」才交给 AI 做。我自己不改文件。
          </p>
          {briefCard && <div className="mt-6">{briefCard}</div>}
          <ul className="mt-8 border-t border-hairline">
            {asks.map((a) => (
              <li key={a.q} className="border-b border-hairline">
                <button
                  type="button"
                  className="group flex w-full items-center gap-3 py-3 text-left hover:bg-hover"
                  onClick={() => void send(a.q, a.focus ?? focus)}
                >
                  <span className="ml-1 h-[3px] w-3 shrink-0 rounded-sm bg-mesa-amber" aria-hidden="true" />
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
          {turns.map((turn, i) => {
            // 换天时先画一道分隔（本机时区）；同一天的不画
            const divider =
              turn.at && (i === 0 || !sameLocalDay(turns[i - 1].at, turn.at)) ? (
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
          })}
          {briefCard}
          {busy && (
            <article className="flex flex-col gap-3">
              {pending && <QuestionBubble text={pending} />}
              <div className="flex min-w-0 items-center gap-2 text-sm text-l3">
                {/* 与聊天层生成中那一行同一个 M▁ 状态头（MesaStatusLead：光标呼吸 + 光带扫过），2026-11-04 用户：「用 Mesa 的聊天层图标显示」；
                    只读查看时实时写正在读哪个文件 / 搜什么（后端推来的步骤） */}
                <MesaStatusLead
                  text={liveStep ?? (liveText ? "正在写…" : inspecting ? INSPECT_WAITING : INTENT_WAITING[intent])}
                  motion={liveText ? "stretch" : "breathe"}
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
                  <ChatMarkdown text={guardClaims(parseAssistantAnswer(parseWorkOrder(parseReworkOrder(parseClarify(parseRemember(liveText).text).text, stepCount).text, stepCount).text, stepCount).text).text.replace(/\[\[[^\]]*$|:::[\s\S]*$/, "")} cwd={projectPath} />
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
      <div ref={endRef} />
      <GuideSectionModal heading={guideHeading} onClose={() => setGuideHeading(null)} />
    </SettingsDrawerShell>
  );
}
