import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowUp, BookmarkPlus, Check, Copy, CornerDownLeft, Library, ListPlus, MoreHorizontal, RotateCcw, Send, Square, Users } from "lucide-react";
import ChatMarkdown from "./ChatMarkdown";
import VendorIcon from "./VendorIcon";
import RememberCard from "./RememberCard";
import ContextMenu from "./ContextMenu";
import { useAppStore } from "../store";
import { toast } from "../toast";
import type { VendorId } from "../vendor-icon";
import {
  contrastRows,
  discussCarrySummaryText,
  discussCarryText,
  memberOf,
  reviewCarrySummaryLines,
  reviewCarryText,
  mentionedNames,
  REF_NOTE,
  round1Messages,
  adoptionReason,
  round1Revealed,
  STATUS_TEXT,
  streamMessages,
  usdText,
  type ConsultDto,
  type ConsultEvent,
  type ConsultMember,
  type ConsultMessage,
  type ConsultRef,
} from "../consult";
import { AGENTS, type ProjectConfigReadDto, type WorkspaceDto } from "../types";
import { pickStepWorkspace } from "../step-round";
import { appendStoredNote } from "../review-notes";
import { CATEGORY_EXAMPLES } from "../research-profile";

const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

/** 成员头像：所选模型的厂商图标（认不出用首字），圆底 */
export function MemberAvatar({ member, size = 22 }: { member: Pick<ConsultMember, "family" | "name">; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-inset ring-1 ring-hairline"
      style={{ width: size, height: size }}
      title={member.name}
    >
      <VendorIcon vendor={(member.family as VendorId | null) ?? null} name={member.name} />
    </span>
  );
}

interface Live {
  steps: Record<string, string[]>;
  text: Record<string, string>;
}

/** 读一份研讨并跟着后端事件刷新：started / done / idle 重读记录，step / text 只更新进行中的显示 */
export function useConsult(projectRoot: string, id: string) {
  const [dto, setDto] = useState<ConsultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Live>({ steps: {}, text: {} });
  const timer = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await invoke<ConsultDto>("consult_read", { projectRoot, id });
      setDto(next);
      setError(null);
      // 答完的那几条不再显示进行中的步骤
      const runningIds = new Set(next.running.map((r) => r.msgId));
      setLive((l) => ({
        steps: Object.fromEntries(Object.entries(l.steps).filter(([k]) => runningIds.has(k))),
        text: Object.fromEntries(Object.entries(l.text).filter(([k]) => runningIds.has(k))),
      }));
    } catch (reason) {
      setError(String(reason));
    }
  }, [projectRoot, id]);

  useEffect(() => {
    setDto(null);
    setLive({ steps: {}, text: {} });
    void reload();
    let alive = true;
    const un = listen<ConsultEvent>("consult-event", (e) => {
      const ev = e.payload;
      if (!alive || ev.consultId !== id) return;
      if (ev.kind === "step" && ev.msgId && ev.step) {
        const mid = ev.msgId;
        setLive((l) => ({ ...l, steps: { ...l.steps, [mid]: [...(l.steps[mid] ?? []), ev.step!].slice(-4) } }));
      } else if (ev.kind === "text" && ev.msgId && ev.text != null) {
        const mid = ev.msgId;
        setLive((l) => ({ ...l, text: { ...l.text, [mid]: ev.text! } }));
      } else {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void reload(), 120);
      }
    });
    return () => {
      alive = false;
      void un.then((f) => f());
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [id, reload]);

  return { dto, error, live, reload, setDto };
}

function useTick(on: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setN((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [on]);
}

function elapsed(startedAt: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function costText(messages: ConsultMessage[]): string {
  const calls = messages.filter((m) => m.role === "member").length;
  const usd = messages.reduce((a, m) => a + (m.costUsd ?? 0), 0);
  return usd > 0 ? `${usdText(usd)} · ${calls} 次` : `${calls} 次`;
}

function copyText(m: ConsultMessage, name: string): string {
  const lines = [`**${name}**`, "", m.text];
  if (m.conclusion) lines.push("", `结论：${m.conclusion}`);
  if (m.refs.length) lines.push(`依据：${m.refs.map((r) => r.raw).join("；")}`);
  if (m.unsure) lines.push(`没把握的：${m.unsure}`);
  return lines.join("\n");
}

function RefChip({ r }: { r: ConsultRef }) {
  const bad = r.state !== "ok";
  return (
    <span className="inline-flex items-baseline gap-1">
      <code
        className={`rounded-sm px-1 font-mono text-[0.92em] ${bad ? "text-warn-text underline decoration-dotted underline-offset-2" : "text-l2"}`}
        title={bad ? REF_NOTE[r.state as "missing" | "unseen"] : r.loc ? `${r.path} · ${r.loc}` : r.path}
      >
        {r.path}
        {r.loc ? (/^\d/.test(r.loc) ? `:${r.loc}` : ` ${r.loc}`) : ""}
      </code>
      {bad && <span className="text-micro text-warn-text">{REF_NOTE[r.state as "missing" | "unseen"]}</span>}
    </span>
  );
}

/** 回答末尾的结论 / 依据 / 没把握的 */
function Tail({ m, compact = false }: { m: ConsultMessage; compact?: boolean }) {
  if (!m.conclusion && !m.refs.length && !m.unsure) return null;
  const row = (label: string, body: React.ReactNode) => (
    <div className="flex gap-2">
      <span className="w-12 shrink-0 text-l4">{label}</span>
      <span className="min-w-0 flex-1">{body}</span>
    </div>
  );
  return (
    <div className={`${compact ? "mt-2" : "mt-3 border-t border-hairline pt-2.5"} space-y-1 text-xs leading-relaxed text-l2`}>
      {m.conclusion && row("结论", <span className="text-l1">{m.conclusion}</span>)}
      {m.refs.length > 0 &&
        row(
          "依据",
          <span className="flex flex-wrap gap-x-2 gap-y-0.5">
            {m.refs.map((r, i) => (
              <RefChip key={i} r={r} />
            ))}
          </span>,
        )}
      {m.unsure && row("没把握", m.unsure)}
    </div>
  );
}

function TierTag({ member }: { member: ConsultMember }) {
  return member.canReadProject ? (
    <span className="rounded-sm border border-hairline px-1 text-micro leading-4 text-l4" title="CLI 外壳能只读打开项目里的文件">
      能看项目
    </span>
  ) : (
    <span
      className="rounded-sm border border-warn-text/35 px-1 text-micro leading-4 text-warn-text"
      title="这家 CLI 还不能只读打开项目，只看 Mesa 附上的材料摘录"
    >
      只看材料
    </span>
  );
}

export default function ConsultView({
  projectRoot,
  id,
  projectName,
  onDeleted,
  inChatPane = false,
}: {
  projectRoot: string;
  id: string;
  projectName?: string | null;
  onDeleted: () => void;
  /** 开在聊天层那一格（研讨页）：头部照对话头的位置（外 px-2、行内 px-1.5），从对话切过来标题不左右跳；
   *  不给 = 对话管理的回放区，照对话回放头 */
  inChatPane?: boolean;
}) {
  const { dto, error, live, reload, setDto } = useConsult(projectRoot, id);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [remembering, setRemembering] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [excludedMembers, setExcludedMembers] = useState<Set<string>>(new Set());
  // 对照卡里「首轮」默认收成一行，点开看全文
  const [firstOpen, setFirstOpen] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => {
    setExcludedMembers(new Set());
    setRemembering(null);
    setPromoting(null);
  }, [id]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const openAssistant = useAppStore((s) => s.openAssistant);
  const running = dto?.running ?? [];
  useTick(running.length > 0);

  const record = dto?.consult ?? null;
  const revealed = round1Revealed(running);
  const r1 = useMemo(() => (record ? round1Messages(record) : []), [record]);
  const stream = useMemo(() => (record ? streamMessages(record) : []), [record]);
  const rows = useMemo(() => (record ? contrastRows(record) : []), [record]);
  const liveLater = running.filter((r) => r.phase !== "r1");
  // 发起的那一步现在开着工作副本（跑着 / 待评审 / 退回修改）吗：开着时结论「加进退回意见」交给那一轮，
  // 没开工或已保存时「带回商量」改任务书草稿（2026-11-12：开工后商量改的是项目根草稿，那一轮 AI 读不到）
  const metaStep = record?.meta.step ?? null;
  const [stepRound, setStepRound] = useState<{ step: string; worktreePath: string | null } | null>(null);
  useEffect(() => {
    if (!metaStep) return;
    let stale = false;
    void Promise.all([
      invoke<ProjectConfigReadDto>("read_project_config", { path: projectRoot }).catch(() => null),
      invoke<WorkspaceDto[]>("list_workspaces").catch(() => [] as WorkspaceDto[]),
    ]).then(([cfg, list]) => {
      if (stale) return;
      const step = cfg?.config.steps.find((s) => s.name === metaStep);
      const ws = step ? pickStepWorkspace(list, projectRoot, step) : undefined;
      setStepRound({ step: metaStep, worktreePath: ws?.status === "active" ? ws.worktreePath : null });
    });
    return () => {
      stale = true;
    };
  }, [metaStep, projectRoot, record?.messages.length]);
  const roundPath = stepRound && stepRound.step === metaStep ? stepRound.worktreePath : null;
  const crossRounds = Math.max(0, ...stream.filter((m) => m.phase === "cross").map((m) => m.round));

  // 有新内容时贴底
  const lastLen = useRef(0);
  useEffect(() => {
    const n = (record?.messages.length ?? 0) + running.length;
    if (n !== lastLen.current) {
      lastLen.current = n;
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [record?.messages.length, running.length]);

  if (error && !dto) {
    return <div className="flex flex-1 items-center justify-center text-xs text-err-text">{error}</div>;
  }
  if (!record) {
    return <div className="flex flex-1 items-center justify-center text-xs text-l4">正在读研讨记录…</div>;
  }
  const members = record.meta.members;
  // 文件链接按成员读文件的地方解析（评审页发起时是工作副本）
  const readCwd = record.meta.readRoot || projectRoot;
  const hasImages = record.meta.materials.some((m) => m.kind === "image");
  const nameOf = (mid: string | null) => memberOf(record, mid)?.name ?? "成员";

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const next = await invoke<ConsultDto>("consult_send", { projectRoot, id, text });
      setDto(next);
      setDraft("");
    } catch (reason) {
      toast(String(reason), "error");
    } finally {
      setSending(false);
    }
  }

  async function stop(member?: string) {
    try {
      await invoke("consult_stop", { id, member: member ?? null });
    } catch (reason) {
      toast(String(reason), "error");
    }
  }

  async function retry(msgId: string) {
    try {
      await invoke("consult_retry", { projectRoot, id, msgId });
      void reload();
    } catch (reason) {
      toast(String(reason), "error");
    }
  }

  function draftWorkOrder(m?: ConsultMessage) {
    const lines = [
      `研讨「${record!.meta.title}」的问题：${record!.meta.question}`,
      "",
      "各家结论：",
      ...rows.map((r) => `- ${r.member.name}：${r.latest ?? r.first ?? "（没答）"}`),
    ];
    if (m) lines.push("", `我想照这条去做（${nameOf(m.member)}）：`, m.text, m.conclusion ? `结论：${m.conclusion}` : "");
    openAssistant(projectRoot, "按这场研讨的结论起草派活单", {
      title: `研讨：${record!.meta.title}`,
      detail: lines.filter((l) => l !== undefined).join("\n"),
    });
  }

  /** 「带回商量」（步骤卡发起的研讨才有）：进这个项目、聚焦那一步，照「继续讨论」原路接回商量，
   *  结论放进输入框不发送——研讨自己不写任务书，由商量那家 AI 改，你当场看到改了什么 */
  async function carryToDiscuss(target: ConsultMessage | readonly ConsultMessage[]) {
    const stepName = record!.meta.step;
    if (!stepName) return;
    const text = Array.isArray(target)
      ? discussCarrySummaryText(record!, target)
      : discussCarryText(record!, target as ConsultMessage);
    if (!text) return;
    const cfg = await invoke<ProjectConfigReadDto>("read_project_config", { path: projectRoot }).catch(() => null);
    const stepIndex = cfg?.config.steps.findIndex((s) => s.name === stepName) ?? -1;
    if (stepIndex < 0) {
      toast(`项目里已经没有「${stepName}」这一步了，复制结论自己贴过去吧`, "warning");
      return;
    }
    const s = useAppStore.getState();
    const token = Date.now();
    s.setDiscussCarryReq({ projectRoot, stepName, text, token });
    s.setSelectProjectReq(projectRoot);
    s.setProjectFocusReq({ projectRoot, focus: "step", stepIndex, token });
    s.setPage("workspaces");
  }

  /** 「加进退回意见」（这一步开着工作副本时）：结论写成一行追加进评审页意见栏，点「退回修改…」时随意见交给那一轮 AI；
   *  不写任何文件，不替人退回 */
  function addToReturnNotes(target: ConsultMessage | readonly ConsultMessage[]) {
    if (!roundPath) return;
    const lines = Array.isArray(target)
      ? reviewCarrySummaryLines(record!, target)
      : [reviewCarryText(record!, target as ConsultMessage)];
    if (lines.length === 0) return;
    for (const line of lines) appendStoredNote(roundPath, line);
    const worktreePath = roundPath;
    const countText = lines.length > 1 ? ` ${lines.length} 条结论` : "";
    toast(`已把${countText}加进「${record!.meta.step}」的退回意见，评审时点「退回修改…」一起交给 AI`, "success", {
      actions: [
        {
          label: "去评审",
          onClick: () => {
            const s = useAppStore.getState();
            s.setWorkspaceReviewRequest({ worktreePath, runId: null, requestId: crypto.randomUUID() });
            s.setPage("terminal");
          },
        },
      ],
    });
  }

  const canCarryDiscuss = Boolean(record.meta.step && stepRound?.step === record.meta.step && !roundPath);
  const canReturnNotes = Boolean(record.meta.step && roundPath);
  const rowsWithConclusion = rows.filter((r) => r.latestMsg);
  const pickedMsgs = rowsWithConclusion
    .filter((r) => !excludedMembers.has(r.member.id))
    .map((r) => r.latestMsg!);
  function toggleMemberPick(memberId: string) {
    setExcludedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  function mention(name: string) {
    setDraft((d) => {
      const tag = `@${name} `;
      return d.includes(tag) ? d : d ? `${d.replace(/\s*$/, " ")}${tag}` : tag;
    });
    taRef.current?.focus();
  }

  async function rename() {
    const t = renaming?.trim();
    setRenaming(null);
    if (!t || t === record!.meta.title) return;
    try {
      await invoke("consult_rename", { projectRoot, id, title: t });
      void reload();
    } catch (reason) {
      toast(String(reason), "error");
    }
  }

  async function remove() {
    try {
      await invoke("consult_delete", { projectRoot, id });
      onDeleted();
    } catch (reason) {
      toast(String(reason), "error");
    }
  }

  const actions = (m: ConsultMessage) => (
    <div className="mt-1.5 flex flex-wrap items-center gap-0.5 opacity-70 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
      {m.conclusion && record.meta.step && roundPath && (
        <button
          type="button"
          onClick={() => addToReturnNotes(m)}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
          title={`「${record.meta.step}」已经开工：这条结论加进评审的退回意见，退回修改时交给干活的那一轮 AI；不替你退回`}
        >
          <ListPlus size={12} strokeWidth={1.8} aria-hidden="true" />
          <span className="text-micro">加进退回意见</span>
        </button>
      )}
      {m.conclusion && record.meta.step && stepRound?.step === record.meta.step && !roundPath && (
        <button
          type="button"
          onClick={() => void carryToDiscuss(m)}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
          title={`回到「${record.meta.step}」的商量，这条结论放进输入框、不发送；你改好再发，由商量的 AI 改任务书`}
        >
          <CornerDownLeft size={12} strokeWidth={1.8} aria-hidden="true" />
          <span className="text-micro">带回商量</span>
        </button>
      )}
      {m.conclusion && (
        <button
          type="button"
          onClick={() => setRemembering(remembering === m.id ? null : m.id)}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
          title="把这条结论改写成一句，记进项目的「已定 / 不做」"
        >
          <BookmarkPlus size={12} strokeWidth={1.8} aria-hidden="true" />
          <span className="text-micro">记进项目知识</span>
        </button>
      )}
      <button
        type="button"
        onClick={() => draftWorkOrder(m)}
        className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
        title="交给项目助手起草派活单；派不派你在项目助手里点"
      >
        <Send size={12} strokeWidth={1.8} aria-hidden="true" />
        <span className="text-micro">起草派活单</span>
      </button>
      {m.conclusion && (
        <button
          type="button"
          onClick={() => setPromoting(promoting === m.id ? null : m.id)}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
          title="这条结论适用于你所有项目时，提升到设置里的「研究档案」；依据写明这场研讨和参与的几家，项目研究记录里也记下它们"
        >
          <Library size={12} strokeWidth={1.8} aria-hidden="true" />
          <span className="text-micro">提升到研究档案</span>
        </button>
      )}
      <button
        type="button"
        onClick={() => void navigator.clipboard.writeText(copyText(m, nameOf(m.member))).then(() => toast("已复制"))}
        className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
      >
        <Copy size={12} strokeWidth={1.8} aria-hidden="true" />
        <span className="text-micro">复制</span>
      </button>
    </div>
  );

  const failed = (m: ConsultMessage) =>
    m.status !== "ok" && (
      <div className="flex items-center gap-2 text-xs text-l3">
        <span className={m.status === "error" ? "text-err-text" : "text-l3"}>{STATUS_TEXT[m.status]}</span>
        {m.error && <span className="min-w-0 truncate text-l4" title={m.error}>{m.error}</span>}
        {!dto?.busy && (
          <button
            type="button"
            onClick={() => void retry(m.id)}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro text-l2 hover:bg-hover hover:text-l1"
          >
            <RotateCcw size={11} strokeWidth={1.8} aria-hidden="true" />
            <span className="text-micro">重试这一家</span>
          </button>
        )}
      </div>
    );

  // 第一轮卡片：一位一张，没亮之前只写进度
  const card = (member: ConsultMember) => {
    const msg = r1.find((m) => m.member === member.id);
    const run = running.find((r) => r.member === member.id && r.phase === "r1");
    const open = expanded.has(member.id);
    return (
      <div key={member.id} className="ccode-well flex min-w-0 flex-col rounded-xl border border-hairline p-3">
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <MemberAvatar member={member} size={20} />
          <span className="truncate text-xs font-medium text-l1">{member.name}</span>
          <span className="min-w-0 truncate text-micro text-l4">{member.model || "默认模型"}</span>
          <span className="flex-1" />
          <TierTag member={member} />
        </div>
        {run ? (
          <div className="flex flex-1 flex-col text-xs text-l3">
            <div className="space-y-0.5 font-mono text-micro text-l3">
              {(live.steps[run.msgId] ?? ["正在读材料…"]).map((s, i) => (
                <div key={i} className="truncate">
                  {s}
                </div>
              ))}
            </div>
            <div className="mt-auto flex items-center justify-between pt-3 text-micro text-l4">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok-text" aria-hidden="true" />
                {elapsed(run.startedAt)}
              </span>
              <button type="button" onClick={() => void stop(member.id)} className="rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-l1">
                <span className="text-micro">停止</span>
              </button>
            </div>
          </div>
        ) : !msg ? (
          <div className="text-xs text-l4">还没开始</div>
        ) : !revealed ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 py-4 text-center">
            <span className="text-xs text-l2">已答完 · 等其他几家</span>
            <span className="text-micro text-l4">全部回来后一起展开，免得先读的影响后读的</span>
          </div>
        ) : msg.status !== "ok" ? (
          failed(msg)
        ) : (
          <div className="group/msg flex min-w-0 flex-1 flex-col">
            <div className={`relative min-w-0 ${open ? "" : "max-h-72 overflow-hidden"}`}>
              <div>
                <ChatMarkdown text={msg.text || "（只写了结论）"} cwd={readCwd} />
              </div>
              {!open && msg.text.length > 600 && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[var(--color-strip)] to-transparent" />
              )}
            </div>
            {msg.text.length > 600 && (
              <button
                type="button"
                onClick={() =>
                  setExpanded((s) => {
                    const n = new Set(s);
                    if (n.has(member.id)) n.delete(member.id);
                    else n.add(member.id);
                    return n;
                  })
                }
                className="mt-1 self-start rounded-md px-1 text-micro text-l3 hover:bg-hover hover:text-l1"
              >
                <span className="text-micro">{open ? "收起" : "展开全文"}</span>
              </button>
            )}
            <Tail m={msg} />
            {actions(msg)}
            {remembering === msg.id && <RememberCard text={msg.conclusion ?? ""} projectPath={projectRoot} />}
            {promoting === msg.id && (
              <PromoteCard
                text={msg.conclusion ?? ""}
                reason={adoptionReason(record, msg, agentLabel, projectName ?? projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? projectRoot)}
                projectRoot={projectRoot}
                consultId={id}
              />
            )}
          </div>
        )}
      </div>
    );
  };

  const cols = members.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2";
  const asked = mentionedNames(draft, members);
  const stageLabel = dto?.busy
    ? "研讨进行中"
    : crossRounds > 0
      ? `已完成 · 交叉 ${crossRounds} 轮`
      : revealed
        ? "已完成 · 首轮对照"
        : "第一轮作答";

  const hasLaterStream = stream.length > 0 || liveLater.length > 0;
  const showContrast = revealed && rows.some((r) => r.status !== "pending");
  const hasAnyUpdated = rows.some((r) => r.latest);
  const showPickCheckboxes = (canCarryDiscuss || canReturnNotes) && rowsWithConclusion.length > 1;
  const contrastPanel = showContrast ? (
    <div className={`ccode-well ${hasLaterStream ? "mt-5" : "mt-3"} overflow-hidden rounded-xl border border-hairline`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-strip/50 px-3.5 py-2">
        <span className="text-xs font-semibold text-l1">
          {hasAnyUpdated ? "各家最终结论对照" : "各家结论对照"}
        </span>
        <span className="text-micro text-l4">原话照搬 · Mesa 只排对照与核依据，不判谁对</span>
      </div>
      {rows.map((r) => {
        const picked = r.latestMsg != null && !excludedMembers.has(r.member.id);
        const rememberKey = `contrast:${r.member.id}`;
        const primaryText =
          r.latest ??
          r.first ??
          (r.status === "ok" ? "（没写结论）" : r.status === "pending" ? "还在答" : STATUS_TEXT[r.status as "error"]);
        return (
          <div
            key={r.member.id}
            className="grid grid-cols-1 gap-1.5 border-t border-hairline px-3.5 py-2 first:border-t-0 sm:grid-cols-[7.5rem_1fr] sm:gap-3"
          >
            {/* 左栏：勾选 + 头像 + 名字一行，下面是状态小标和这一行的图标操作（2026-11-20 用户：卡片太大，收窄左栏、按钮改图标） */}
            <div className="flex min-w-0 flex-col gap-1 self-start">
              <div className="flex min-w-0 items-center gap-1.5" title={`${r.member.name} · 经 ${agentLabel(r.member.agent)}`}>
                {showPickCheckboxes && r.latestMsg && (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={picked}
                    aria-label={`${picked ? "取消勾选" : "勾选"} ${r.member.name} 的结论`}
                    onClick={() => toggleMemberPick(r.member.id)}
                    className={`inline-flex size-3.5 shrink-0 items-center justify-center rounded-xs border transition-colors ${
                      picked
                        ? "border-cta bg-cta text-cta-text"
                        : "border-field bg-canvas text-transparent hover:border-l3"
                    }`}
                  >
                    <Check size={10} strokeWidth={2.5} aria-hidden="true" />
                  </button>
                )}
                <MemberAvatar member={r.member} size={16} />
                <span className="truncate text-xs font-medium text-l1">{r.member.name}</span>
              </div>
              {(r.latest || r.crossPassed || r.missing > 0 || r.unseen > 0) && (
                <div className="flex flex-wrap items-center gap-1">
                  {r.latest && <span className="text-micro text-cta-pill-text">交叉后更新</span>}
                  {r.crossPassed && <span className="text-micro text-l4">交叉：没补充</span>}
                  {r.missing > 0 && <span className="text-micro text-warn-text">{r.missing} 处依据找不到</span>}
                  {r.unseen > 0 && <span className="text-micro text-l4">{r.unseen} 处它没看到</span>}
                </div>
              )}
              {r.latestMsg && (
                <div className="-ml-1 flex items-center">
                  {canCarryDiscuss && (
                    <button
                      type="button"
                      onClick={() => void carryToDiscuss(r.latestMsg!)}
                      aria-label={rowsWithConclusion.length > 1 ? `只把 ${r.member.name} 这条带回商量` : "带回商量"}
                      title={`只把 ${r.member.name} 这条最新结论放进「${record.meta.step}」商量输入框（不自动发送）`}
                      className="inline-flex size-6 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1"
                    >
                      <CornerDownLeft size={12} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  )}
                  {canReturnNotes && (
                    <button
                      type="button"
                      onClick={() => addToReturnNotes(r.latestMsg!)}
                      aria-label={rowsWithConclusion.length > 1 ? `只把 ${r.member.name} 这条加进退回意见` : "加进退回意见"}
                      title={`只把 ${r.member.name} 这条最新结论加进评审页退回意见栏`}
                      className="inline-flex size-6 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1"
                    >
                      <ListPlus size={12} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setRemembering(remembering === rememberKey ? null : rememberKey)}
                    aria-label={`把 ${r.member.name} 这条记进项目知识`}
                    title="把这条结论改写成一句，记进项目的「已定 / 不做」"
                    className={`inline-flex size-6 items-center justify-center rounded-md hover:bg-hover hover:text-l1 ${
                      remembering === rememberKey ? "bg-hover text-l1" : "text-l4"
                    }`}
                  >
                    <BookmarkPlus size={12} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
            <div className="min-w-0">
              <div className="text-xs leading-relaxed text-l1">{primaryText}</div>
              {r.latest && r.first && (
                <button
                  type="button"
                  onClick={() =>
                    setFirstOpen((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.member.id)) next.delete(r.member.id);
                      else next.add(r.member.id);
                      return next;
                    })
                  }
                  aria-expanded={firstOpen.has(r.member.id)}
                  title={firstOpen.has(r.member.id) ? "收起首轮结论" : `首轮：${r.first}`}
                  className="mt-0.5 block w-full min-w-0 text-left text-l4 hover:text-l3"
                >
                  <span className={`block text-micro leading-relaxed ${firstOpen.has(r.member.id) ? "" : "truncate"}`}>
                    首轮：{r.first}
                  </span>
                </button>
              )}
              {r.latestMsg && remembering === rememberKey && (
                <RememberCard text={r.latestMsg.conclusion ?? ""} projectPath={projectRoot} />
              )}
            </div>
          </div>
        );
      })}
      {rowsWithConclusion.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline bg-strip/40 px-3.5 py-2">
          <div className="min-w-0 flex-1 truncate text-micro text-l4">
            {canCarryDiscuss
              ? "带回后填进商量输入框，不自动发送，改好取舍再发。"
              : canReturnNotes
                ? "加进评审页退回意见栏，「退回修改…」时一起交给干活的 AI。"
                : "长期口径点各行的书签记进项目知识；要动手交给项目助手起草派活单。"}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {canCarryDiscuss && (
              <button
                type="button"
                disabled={pickedMsgs.length === 0}
                onClick={() => void carryToDiscuss(pickedMsgs)}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-cta-bd bg-cta px-2.5 text-xs font-medium text-cta-text transition-[filter] hover:brightness-110 disabled:opacity-45"
                title={`切回「${record.meta.step}」商量对话，把勾选的结论放进输入框（不自动发送）`}
              >
                <CornerDownLeft size={12} strokeWidth={2} aria-hidden="true" />
                <span>
                  {pickedMsgs.length === 0
                    ? "请先勾选结论"
                    : rowsWithConclusion.length === 1 || pickedMsgs.length === 1
                      ? `把 ${nameOf(pickedMsgs[0].member)} 的结论带回商量`
                      : `把勾选的 ${pickedMsgs.length} 家结论带回商量`}
                </span>
              </button>
            )}
            {canReturnNotes && (
              <button
                type="button"
                disabled={pickedMsgs.length === 0}
                onClick={() => addToReturnNotes(pickedMsgs)}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-cta-bd bg-cta px-2.5 text-xs font-medium text-cta-text transition-[filter] hover:brightness-110 disabled:opacity-45"
              >
                <ListPlus size={12} strokeWidth={2} aria-hidden="true" />
                <span>
                  {pickedMsgs.length === 0
                    ? "请先勾选结论"
                    : rowsWithConclusion.length === 1 || pickedMsgs.length === 1
                      ? `把 ${nameOf(pickedMsgs[0].member)} 的结论加进退回意见`
                      : `把勾选的 ${pickedMsgs.length} 家结论加进退回意见`}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => draftWorkOrder()}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors ${
                canCarryDiscuss || canReturnNotes
                  ? "border border-hairline bg-canvas text-l2 hover:bg-hover hover:text-l1"
                  : "border border-cta-bd bg-cta font-medium text-cta-text hover:brightness-110"
              }`}
              title="交给项目助手按各家结论起草派活单；派不派你在项目助手里点"
            >
              <Send size={12} strokeWidth={1.8} aria-hidden="true" />
              <span>起草派活单</span>
            </button>
          </div>
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：标题 + 阶段胶囊 + 成员阵容 */}
      <div className={inChatPane ? "border-b border-hairline px-2 pb-2" : "border-b border-hairline bg-strip/35 px-3.5 pb-2.5 pt-1"}>
        <div className={`flex h-9 min-w-0 items-center ${inChatPane ? "gap-1.5 pl-1.5" : "gap-2"}`}>
          <Users size={15} strokeWidth={1.8} className={`shrink-0 text-l3 ${inChatPane ? "" : "ml-0.5"}`} aria-hidden="true" />
          {renaming !== null ? (
            <input
              autoFocus
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={() => void rename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void rename();
                if (e.key === "Escape") setRenaming(null);
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-field bg-canvas px-2 text-sm text-l1 outline-none"
            />
          ) : (
            <span
              className="min-w-0 truncate px-1 text-sm font-semibold text-l1"
              title={record.meta.title}
              onDoubleClick={() => setRenaming(record.meta.title)}
            >
              {record.meta.title}
            </span>
          )}
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-micro font-medium ${
              dto?.busy ? "bg-cta-pill text-cta-pill-text" : "bg-inset text-l3"
            }`}
          >
            {dto?.busy && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
            {stageLabel}
          </span>
          <span className="flex-1" />
          <span className="shrink-0 text-micro tabular-nums text-l4" title="这场研讨各家调用的次数与已知花费">
            {costText(record.messages)}
          </span>
          {dto?.busy && (
            <button
              type="button"
              onClick={() => void stop()}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-err-text/40 px-2 text-xs text-err-text hover:bg-err"
            >
              <Square size={10} strokeWidth={2.2} aria-hidden="true" />
              <span className="text-xs">全部停止</span>
            </button>
          )}
          <button
            type="button"
            aria-label="更多"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right - 180, y: r.bottom + 4 });
            }}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
          >
            <MoreHorizontal size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-0.5 pt-0.5">
          {members.map((m) => (
            <span
              key={m.id}
              className="inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-full border border-hairline bg-inset pl-0.5 pr-2.5 text-xs text-l2"
              title={`${m.name} · ${m.model || "默认模型"} · 经 ${agentLabel(m.agent)}${m.canReadProject ? " · 能看项目" : " · 只看材料"}`}
            >
              <MemberAvatar member={m} size={18} />
              <span className="shrink-0 font-medium text-l1">{m.name}</span>
              {/* 模型名太长只截模型名，经哪个 CLI 总能看见 */}
              <span className="min-w-0 truncate text-micro text-l3">{m.model || "默认"}</span>
              <span className="shrink-0 text-micro text-l4">· {agentLabel(m.agent)}</span>
              {!m.canReadProject && <span className="shrink-0 text-micro text-warn-text">只看材料</span>}
              {hasImages && !m.seesImages && <span className="shrink-0 text-micro text-l4">图没给它看</span>}
            </span>
          ))}
          {projectName && <span className="ml-1 truncate text-micro text-l4">{projectName}</span>}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto [overflow-anchor:none]">
        <div className="mx-auto max-w-5xl px-5 pb-6 pt-3">
          {/* 问题：右侧气泡（同对话页你说的话） */}
          <div className="ccode-chat-column mx-auto flex flex-col items-end">
            <div className="max-w-[80%] rounded-2xl bg-chat-bubble px-3.5 py-2.5 ccode-chat-user">
              <div className="whitespace-pre-wrap text-l1">{record.meta.question}</div>
              {record.meta.readLabel && <div className="mt-1.5 text-micro text-l3">看的是 {record.meta.readLabel}</div>}
              {record.meta.materials.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {record.meta.materials.map((m) => (
                    <span key={`${m.path}#${m.range}`} className="rounded-md bg-inset px-1.5 py-0.5 font-mono text-micro text-l2">
                      {m.path}
                      <span className="ml-1 font-sans text-l4">{m.kind === "image" ? "图片" : m.range || "全文"}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <SectionLabel title="第一轮 · 各答各的" note={revealed ? (hasLaterStream ? "最终结论与带回入口见最下方" : "看完再往下读对照") : "彼此看不见，全部回来后一起展开"} />
          <div className={`grid grid-cols-1 gap-2.5 ${cols}`}>{members.map(card)}</div>

          {!hasLaterStream && contrastPanel}

          {hasLaterStream && (
            <div className="ccode-chat-column mx-auto">
              {crossRounds > 0 && <SectionLabel title={`交叉 · ${crossRounds} 轮`} note="每家看了别家第一轮的回答" />}
              {stream.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="mb-5 mt-6 flex flex-col items-end">
                    <div className="max-w-[70%] whitespace-pre-wrap rounded-2xl bg-chat-bubble px-3.5 py-2 text-l1 ccode-chat-user">{m.text}</div>
                  </div>
                ) : m.role === "system" ? (
                  <div key={m.id} className="my-4 text-center text-micro text-l4">
                    {m.text}
                  </div>
                ) : (
                  <div key={m.id} className="group/msg relative mb-6 mt-3">
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <MemberAvatar member={memberOf(record, m.member) ?? { family: null, name: "?" }} />
                      <span className="font-medium text-l1">{nameOf(m.member)}</span>
                      {m.mentions.length > 0 && (
                        <span className="text-micro text-l4">
                          回应{" "}
                          {m.mentions.map((x) => (
                            <span key={x} className="ml-0.5 rounded-sm bg-cta-pill px-1 text-cta-pill-text">
                              @{nameOf(x)}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    <div className="pl-[30px]">
                      {m.status !== "ok" ? (
                        failed(m)
                      ) : (
                        <>
                          {m.text && <ChatMarkdown text={m.text} cwd={readCwd} />}
                          <Tail m={m} compact />
                          {actions(m)}
                          {remembering === m.id && <RememberCard text={m.conclusion ?? ""} projectPath={projectRoot} />}
                          {promoting === m.id && (
                            <PromoteCard
                              text={m.conclusion ?? ""}
                              reason={adoptionReason(record, m, agentLabel, projectName ?? projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? projectRoot)}
                              projectRoot={projectRoot}
                              consultId={id}
                            />
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ),
              )}
              {liveLater.map((r) => {
                const member = memberOf(record, r.member);
                if (!member) return null;
                const text = live.text[r.msgId];
                const steps = live.steps[r.msgId] ?? [];
                return (
                  <div key={r.msgId} className="mb-6 mt-3">
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <MemberAvatar member={member} />
                      <span className="font-medium text-l1">{member.name}</span>
                      <span className="inline-flex items-center gap-1 text-micro text-l4">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok-text" aria-hidden="true" />
                        {steps.length ? steps[steps.length - 1] : "在想"} · {elapsed(r.startedAt)}
                      </span>
                      <button type="button" onClick={() => void stop(member.id)} className="rounded-md px-1 text-l4 hover:bg-hover hover:text-l1">
                        <span className="text-micro">停止</span>
                      </button>
                    </div>
                    {text && (
                      <div className="pl-[30px] opacity-80">
                        <ChatMarkdown text={text} cwd={readCwd} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {hasLaterStream && contrastPanel}
        </div>
      </div>

      {/* 输入：点名胶囊 + 输入框；不 @ 就是问所有人 */}
      <div className="shrink-0 px-4 pb-3 pt-1.5">
        <div className="ccode-chat-column mx-auto">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1 text-micro text-l4">
            <span className="mr-0.5 font-medium text-l3">快捷点名</span>
            {members.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => mention(m.name)}
                className={`inline-flex h-6 items-center gap-1 rounded-full border pl-0.5 pr-2 transition-colors ${
                  asked.includes(m.name)
                    ? "border-cta/40 bg-cta-pill font-medium text-cta-pill-text"
                    : "border-hairline bg-inset/70 text-l2 hover:border-field hover:bg-hover hover:text-l1"
                }`}
              >
                <MemberAvatar member={m} size={16} />
                <span className="text-micro">@{m.name}</span>
              </button>
            ))}
            <span className="flex-1" />
            <span>
              {asked.length ? `只问 ${asked.join("、")}` : "不 @ 就是问所有人"} · 最多再互相叫 {record.meta.relayLimit} 次
            </span>
          </div>
          <div className="ccode-consult-composer flex items-end gap-2 rounded-2xl border border-field bg-strip px-3 py-2 focus-within:border-l4">
            <textarea
              ref={taRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={dto?.busy ? "它们还在答，可以先写下一句，这一段结束后再叫人" : "追问，或 @ 某一家"}
              className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent py-1 text-sm text-l1 outline-none placeholder:text-l4"
              style={{ fieldSizing: "content" } as React.CSSProperties}
            />
            <button
              type="button"
              disabled={!draft.trim() || sending}
              onClick={() => void send()}
              aria-label="发送"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-l1 text-canvas transition-opacity disabled:opacity-30"
            >
              <ArrowUp size={15} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(canCarryDiscuss && pickedMsgs.length > 0
              ? [{ label: `把各家结论带回「${record.meta.step}」商量`, onSelect: () => void carryToDiscuss(pickedMsgs) }]
              : []),
            ...(canReturnNotes && pickedMsgs.length > 0
              ? [{ label: `把各家结论加进退回意见`, onSelect: () => addToReturnNotes(pickedMsgs) }]
              : []),
            { label: "按结论起草派活单", onSelect: () => draftWorkOrder() },
            {
              label: "复制全部（Markdown）",
              onSelect: () =>
                void navigator.clipboard
                  .writeText(
                    [`# ${record.meta.title}`, "", record.meta.question, "", ...record.messages.filter((m) => m.role === "member" && m.status === "ok" && !m.pass).map((m) => copyText(m, nameOf(m.member)) + "\n")].join("\n"),
                  )
                  .then(() => toast("已复制")),
            },
            { label: "重命名", onSelect: () => setRenaming(record.meta.title) },
            { separator: true },
            { label: "删除", danger: true, confirm: { label: "确认删除（移到回收站）" }, onSelect: () => void remove() },
          ]}
        />
      )}
    </div>
  );
}

function SectionLabel({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-2.5 mt-6 flex items-center gap-2 text-micro text-l4">
      <span className="font-medium text-l3">{title}</span>
      {note && <span>{note}</span>}
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}

/**
 * 研讨结论提升到研究档案（三期）：人选分类、可改写，点了才写（research_profile_update add，与项目知识页「提升到研究档案」同一个口子）；
 * 依据写明这场研讨与参与的几家；写成后把答成过的成员各记一条进项目研究记录（consult_record_adoption）
 */
function PromoteCard({ text, reason, projectRoot, consultId }: { text: string; reason: string; projectRoot: string; consultId: string }) {
  const categories = Object.keys(CATEGORY_EXAMPLES);
  const [draft, setDraft] = useState(text);
  const [category, setCategory] = useState(categories.includes("常用方法") ? "常用方法" : categories[0] ?? "其他");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [note, setNote] = useState<string | null>(null);
  async function save() {
    const line = draft.trim();
    if (!line || state !== "idle") return;
    setState("busy");
    setNote(null);
    try {
      const profile = await invoke<{ doc: { revision: string } }>("research_profile_read");
      await invoke("research_profile_update", {
        expectedRevision: profile.doc.revision,
        id: null,
        action: "add",
        category,
        text: line,
        reason,
      });
      const n = await invoke<number>("consult_record_adoption", { projectRoot, id: consultId }).catch(() => 0);
      setState("done");
      setNote(n > 0 ? `研究记录里记下了参与的 ${n} 位` : "研究记录里已经记过这场研讨");
    } catch (reason) {
      setState("idle");
      setNote(String(reason));
    }
  }
  return (
    <section className="mt-3 rounded-xl border border-hairline p-3" aria-label="提升到研究档案">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-l3">
        <Library size={13} strokeWidth={1.8} aria-hidden="true" />
        <span className="font-medium text-l2">提升到研究档案</span>
        <span className="text-micro text-l4">适用于你所有项目时才提升；依据会写明这场研讨和参与的几家</span>
      </div>
      {state === "done" ? (
        <p className="text-xs text-ok-text">已提升到研究档案（{category}）。{note}</p>
      ) : (
        <>
          <div className="mb-1.5 flex items-center gap-2 text-xs">
            <span className="text-l4">分类</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-7 rounded-lg border border-field bg-canvas px-2 text-xs text-l2 outline-none"
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={draft}
            maxLength={300}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-12 w-full resize-y rounded-lg border border-field bg-canvas px-2 py-1.5 text-xs text-l2 outline-none focus:border-l4"
          />
          <p className="mt-1 text-micro leading-5 text-l4">依据：{reason}</p>
          <div className="mt-1.5 flex items-center justify-end gap-2">
            {note && <span className="min-w-0 flex-1 truncate text-micro text-err-text" title={note}>{note}</span>}
            <button
              type="button"
              disabled={!draft.trim() || state === "busy"}
              onClick={() => void save()}
              className="inline-flex h-7 items-center rounded-lg border border-cta-bd bg-cta px-2.5 text-cta-text disabled:opacity-50"
            >
              <span className="text-xs">{state === "busy" ? "写入中…" : "提升到研究档案"}</span>
            </button>
          </div>
        </>
      )}
    </section>
  );
}
