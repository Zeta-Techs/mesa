import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, ArrowUp } from "lucide-react";
import { SettingsDrawerShell } from "./ProjectSettingsDrawer";
import { secondaryActionClass } from "./PageFrame";
import ChatMarkdown from "./ChatMarkdown";
import MesaBuddy from "./MesaBuddy";
import { MesaStatusLead } from "./MesaMark";
import { absTime, relTime } from "../rel-time";
import { toast } from "../toast";
import { buddyDayPart, buddyMood } from "../buddy-time";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  assistantErrorText,
  basisGuideHeadings,
  guideAnchor,
  INSPECT_WAITING,
  INTENT_WAITING,
  parseAssistantAnswer,
  parseWorkOrder,
  QUICK_QUESTIONS,
  splitAnswerLead,
  type AssistantAction,
  type AssistantIntent,
  type WorkOrder,
} from "../project-assistant";
import WorkOrderCard from "./WorkOrderCard";
import { userGuideUrl } from "../help-links";
import {
  askProjectAssistant,
  assistantConnection,
  planAsk,
  type AssistantFocus,
  type AssistantTurn,
} from "../project-assistant-run";
import type { ProjectDto } from "../types";

/** 外面要它带着问题打开（卡点、「问问为什么」）：nonce 变了才再问一次 */
export interface AssistantAsk {
  question: string;
  focus: AssistantFocus | null;
  nonce: number;
}

/** 三个常用问题各配一句说明（空状态里排成列表） */
const QUICK_HINTS = ["每一步走到哪、还剩什么", "出错、卡住的地方，是谁的问题", "接下来该点哪里"] as const;

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
}: {
  open: boolean;
  onClose: () => void;
  projectPath: string | null;
  projectName: string;
  project: ProjectDto | null;
  stepCount: number;
  ask: AssistantAsk | null;
  onAction: (action: AssistantAction, turn: AssistantTurn) => void;
  /** 派活单「派出去」：页面按去处开工，返回给人看的一句（「已留话给第 2 步的 AI」） */
  onDispatch: (order: WorkOrder) => Promise<string>;
}) {
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  /** 这次问的是哪一类（等的时候那一行写什么） */
  const [intent, setIntent] = useState<AssistantIntent>("project");
  /** 这次会不会只读打开项目文件（等得久一些，等待文案要说清） */
  const [inspecting, setInspecting] = useState(false);
  /** 已经等了几秒（超过 3 秒才写出来） */
  const [waited, setWaited] = useState(0);
  /** 没问成的那一问（错误上方照样显示，「再问一次」用它） */
  const [failed, setFailed] = useState<{ question: string; focus: AssistantFocus | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<AssistantFocus | null>(null);
  /** 这次打开后刚答完的那一轮（它旁边的小桌举手蹦一下，旧的站着） */
  const [freshAt, setFreshAt] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const askedNonce = useRef<number | null>(null);
  const conn = assistantConnection(project);
  // 派过的派活单记在本机（按项目 + 那一轮的时间），重开面板也不会再派一次
  const sentKey = projectPath ? `ccode.assistantSent.${projectPath}` : null;
  const [sent, setSent] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!sentKey) return;
    try {
      setSent(JSON.parse(localStorage.getItem(sentKey) ?? "{}") as Record<string, string>);
    } catch {
      setSent({});
    }
  }, [sentKey]);
  async function dispatch(turnAt: string, order: WorkOrder) {
    const note = await onDispatch(order);
    setSent((prev) => {
      const next = { ...prev, [turnAt]: note };
      if (sentKey) localStorage.setItem(sentKey, JSON.stringify(next));
      return next;
    });
  }
  const mood = buddyMood(buddyDayPart(new Date().getHours()));

  useEffect(() => {
    if (!open || !projectPath) return;
    let stale = false;
    setError(null);
    setFreshAt(null);
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
  }, [turns.length, busy, error]);

  useEffect(() => {
    if (!busy) return;
    setWaited(0);
    const started = Date.now();
    const timer = window.setInterval(() => setWaited(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  async function send(question: string, withFocus: AssistantFocus | null) {
    const q = question.trim();
    if (!q || busy || !projectPath) return;
    const plan = planAsk(q, !!withFocus, project);
    setIntent(plan.intent);
    setInspecting(plan.inspect);
    setBusy(true);
    setPending(q);
    setFailed(null);
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "";
    setError(null);
    try {
      const turn = await askProjectAssistant({
        projectPath,
        project,
        question: q,
        history: turns,
        focus: withFocus,
        intent: plan.intent,
        inspect: plan.inspect,
      });
      setTurns((list) => [...list, turn]);
      setFreshAt(turn.at);
      setFocus(null);
    } catch (reason) {
      setError(assistantErrorText(String(reason)));
      setFailed({ question: q, focus: withFocus });
    } finally {
      setBusy(false);
      setPending(null);
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
      {!empty && (
        <div className="flex flex-wrap gap-1.5">
          {QUICK_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              className="h-6 rounded-full border border-hairline px-2.5 text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              disabled={busy}
              onClick={() => void send(q, focus)}
            >
              {/* 字号写内层：全站 button { font: inherit } 会吞掉按钮上的 text-* */}
              <span className="text-xs">{q}</span>
            </button>
          ))}
        </div>
      )}
      <form
        className="ccode-assistant-composer flex items-end gap-2 rounded-xl border border-hairline bg-inset px-3 py-2 focus-within:border-l4"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft, focus);
        }}
      >
        <textarea
          ref={inputRef}
          className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent py-0.5 text-sm leading-6 text-l1 outline-none placeholder:text-l4"
          rows={1}
          value={draft}
          maxLength={2000}
          placeholder={mood.restPose === "sleep" ? "问点什么，它就醒…" : "问点什么…"}
          aria-label="问项目助手"
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
          data-state={busy ? "sending" : draft.trim() ? "ready" : "empty"}
          disabled={busy || !draft.trim()}
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
    >
      {empty ? (
        <div className="px-1 pt-8">
          <MesaBuddy size={112} pose={mood.greetPose} prop={mood.prop} />
          <h3 className="mt-5 text-lg font-semibold text-l1">{mood.greeting}</h3>
          <p className="mt-2 text-sm leading-6 text-l3">
            我看得到每一步的状态、出错原因、核验和退回意见，也看得到 Mesa 自己出过的错。只解释、只指路，要动手时给你按钮，你点了才发生。
          </p>
          <ul className="mt-8 border-t border-hairline">
            {QUICK_QUESTIONS.map((q, i) => (
              <li key={q} className="border-b border-hairline">
                <button
                  type="button"
                  className="group flex w-full items-center gap-3 py-3 text-left hover:bg-hover"
                  onClick={() => void send(q, focus)}
                >
                  <span className="ml-1 h-[3px] w-3 shrink-0 rounded-sm bg-mesa-amber" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-l1">{q}</span>
                    <span className="block text-xs text-l3">{QUICK_HINTS[i]}</span>
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
            const withOrder = parseWorkOrder(turn.answer, stepCount);
            const parsed = parseAssistantAnswer(withOrder.text, stepCount);
            const { lead, rest } = splitAnswerLead(parsed.text);
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
                  {withOrder.order && (
                    <WorkOrderCard
                      order={withOrder.order}
                      sentNote={sent[turn.at] ?? null}
                      onDispatch={(order) => dispatch(turn.at, order)}
                    />
                  )}
                  {turn.basis && (
                    <p className="mt-2 text-micro text-l4">
                      依据：
                      {(() => {
                        const heads = basisGuideHeadings(turn.basis);
                        if (heads.length === 0) return turn.basis;
                        const tail = turn.basis.replace(/^说明书(「[^」]+」)+/, "");
                        return (
                          <>
                            说明书
                            {heads.map((h) => (
                              <button
                                key={h}
                                type="button"
                                className="text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                                title="在浏览器里打开说明书这一节"
                                onClick={() => void openUrl(userGuideUrl(guideAnchor(h))).catch(() => toast("浏览器没打开，稍后再试", "warning"))}
                              >
                                <span className="text-micro">「{h}」</span>
                              </button>
                            ))}
                            {tail}
                          </>
                        );
                      })()}
                    </p>
                  )}
                  {parsed.actions.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {parsed.actions.map((action) => (
                        <button
                          key={`${action.kind}-${action.step ?? ""}`}
                          type="button"
                          className={secondaryActionClass}
                          title={action.text || undefined}
                          onClick={() => onAction(action, turn)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          {busy && (
            <article className="flex flex-col gap-3">
              {pending && <QuestionBubble text={pending} />}
              <div className="flex min-w-0 items-center gap-2 text-sm text-l3">
                {/* 与聊天层生成中那一行同一个 M▁ 状态头（MesaStatusLead：光标呼吸 + 光带扫过），2026-11-04 用户：「用 Mesa 的聊天层图标显示」 */}
                <MesaStatusLead text={inspecting ? INSPECT_WAITING : INTENT_WAITING[intent]} motion="breathe" sweep />
                {waited >= 3 && (
                  <span className="shrink-0 text-xs tabular-nums text-l4" aria-hidden="true">
                    {waited} 秒
                  </span>
                )}
              </div>
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
                        void send(failed.question, failed.focus);
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
    </SettingsDrawerShell>
  );
}
