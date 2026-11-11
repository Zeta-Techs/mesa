import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowUp, BookmarkPlus, Copy, Library, MoreHorizontal, RotateCcw, Send, Square, Users } from "lucide-react";
import ChatMarkdown from "./ChatMarkdown";
import VendorIcon from "./VendorIcon";
import RememberCard from "./RememberCard";
import ContextMenu from "./ContextMenu";
import { useAppStore } from "../store";
import { toast } from "../toast";
import type { VendorId } from "../vendor-icon";
import {
  contrastRows,
  memberOf,
  mentionedNames,
  REF_NOTE,
  round1Messages,
  adoptionReason,
  round1Revealed,
  STATUS_TEXT,
  streamMessages,
  type ConsultDto,
  type ConsultEvent,
  type ConsultMember,
  type ConsultMessage,
  type ConsultRef,
} from "../consult";
import { AGENTS } from "../types";
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
  return usd > 0 ? `$${usd.toFixed(2)} · ${calls} 次` : `${calls} 次`;
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
}: {
  projectRoot: string;
  id: string;
  projectName?: string | null;
  onDeleted: () => void;
}) {
  const { dto, error, live, reload, setDto } = useConsult(projectRoot, id);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [remembering, setRemembering] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
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
    <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：标题行 + 成员行，与对话回放头同高同字 */}
      <div className="px-3 pb-2">
        <div className="flex h-9 min-w-0 items-center gap-2">
          <Users size={14} strokeWidth={1.8} className="ml-1 shrink-0 text-l4" aria-hidden="true" />
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
              className="h-7 min-w-0 flex-1 rounded-md border border-field bg-canvas px-2 text-xs text-l1 outline-none"
            />
          ) : (
            <span className="min-w-0 truncate px-1 text-xs text-l2" title={record.meta.title} onDoubleClick={() => setRenaming(record.meta.title)}>
              {record.meta.title}
            </span>
          )}
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
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-1 pt-0.5">
          {members.map((m) => (
            <span
              key={m.id}
              className="inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-full bg-inset pl-0.5 pr-2 text-xs text-l2"
              title={`${m.name} · ${m.model || "默认模型"} · 经 ${agentLabel(m.agent)}${m.canReadProject ? " · 能看项目" : " · 只看材料"}`}
            >
              <MemberAvatar member={m} size={20} />
              <span className="shrink-0">{m.name}</span>
              <span className="truncate text-micro text-l4">
                {m.model || "默认"} · {agentLabel(m.agent)}
              </span>
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

          <SectionLabel title="第一轮 · 各答各的" note={revealed ? "看完再往下读对照" : "彼此看不见，全部回来后一起展开"} />
          <div className={`grid grid-cols-1 gap-2.5 ${cols}`}>{members.map(card)}</div>

          {revealed && rows.some((r) => r.status !== "pending") && (
            <div className="ccode-well mt-3 overflow-hidden rounded-xl border border-hairline">
              <div className="border-b border-hairline px-3 py-1.5 text-micro text-l4">各家结论（原话，Mesa 只排在一起，不判谁对）</div>
              {rows.map((r) => (
                <div key={r.member.id} className="grid grid-cols-[8.5rem_1fr] gap-3 border-t border-hairline px-3 py-2 first:border-t-0">
                  <span className="flex min-w-0 items-center gap-2 self-start text-xs text-l1">
                    <MemberAvatar member={r.member} size={18} />
                    <span className="truncate">{r.member.name}</span>
                  </span>
                  <span className="min-w-0 text-xs leading-relaxed text-l2">
                    {r.first ?? (r.status === "ok" ? "（没写结论）" : r.status === "pending" ? "还在答" : STATUS_TEXT[r.status as "error"])}
                    {(r.latest || r.crossPassed || r.missing > 0 || r.unseen > 0) && (
                      <span className="mt-0.5 block text-micro text-l4">
                        {[
                          r.latest ? `后来改成：${r.latest}` : "",
                          r.crossPassed ? "交叉：没补充" : "",
                          r.missing ? `依据里 ${r.missing} 处找不到` : "",
                          r.unseen ? `${r.unseen} 处它没看到` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {(stream.length > 0 || liveLater.length > 0) && (
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
        </div>
      </div>

      {/* 输入：点名胶囊 + 输入框；不 @ 就是问所有人 */}
      <div className="shrink-0 px-4 pb-3 pt-1.5">
        <div className="ccode-chat-column mx-auto">
          <div className="mb-1.5 flex flex-wrap items-center gap-1 px-1 text-micro text-l4">
            <span className="mr-0.5">点名</span>
            {members.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => mention(m.name)}
                className={`inline-flex h-6 items-center gap-1 rounded-full pl-0.5 pr-2 transition-colors hover:bg-hover hover:text-l1 ${
                  asked.includes(m.name) ? "bg-cta-pill text-cta-pill-text" : "text-l3"
                }`}
              >
                <MemberAvatar member={m} size={18} />
                <span className="text-micro">{m.name}</span>
              </button>
            ))}
            <span className="flex-1" />
            <span>
              {asked.length ? `只问 ${asked.join("、")}` : "不 @ 就是问所有人"} · 你不说话时它们最多再互相叫 {record.meta.relayLimit} 次
            </span>
          </div>
          <div className="flex items-end gap-2 rounded-2xl border border-field bg-strip px-3 py-2 focus-within:border-l4">
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
