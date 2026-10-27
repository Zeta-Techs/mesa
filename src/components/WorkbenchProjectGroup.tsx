import { useState, type ReactNode } from "react";
import { ArrowRight, SquareArrowOutUpRight } from "lucide-react";
import RunCaret from "./RunCaret";
import { ghostActionClass } from "./PageFrame";
import type { RunCaretState } from "../run-caret";
import { absTime, relTime } from "../rel-time";
import {
  CARD_VISIBLE_TASKS,
  type CardLiveRun,
  type CardTask,
  type CardTone,
  type ProjectCard,
} from "../workbench-cards";
import { WORK_MODE_LABEL } from "../work-mode";

const TONE_DOT: Record<CardTone, string> = {
  live: "bg-ok-text",
  wait: "bg-warn-text",
  fail: "bg-err-text",
  done: "bg-ok-text/50",
  idle: "bg-l4/60",
};

/** 任务行的列：点 · 类别 · 名称 · 状态 · 这一轮多久 · 花费 · 待拍板（项目头与任务行共用左缘） */
const TASK_GRID =
  "grid grid-cols-[6px_3.25rem_minmax(0,1.1fr)_minmax(0,1fr)_4.5rem_4rem_3.25rem] items-center gap-x-3";

/**
 * 工作台项目分组（workbench-cards.ts；2026-10-27 由卡片改成分组列表，用户截图：卡片一排按最高那张对齐、
 * 只有一行的卡下面空一大块，状态 / 时长 / 花费也横着对不齐）：一行项目头 + 下面缩进的任务行，
 * 几个分组摞在同一个细线框里，和上面的「等你拍板」同一种列表
 */
export default function WorkbenchProjectGroup({
  card,
  openTaskId,
  onOpenTask,
  onOpenProject,
  onContinue,
  continueTip,
  clientJump,
  lastActive,
  liveMeta,
  caretFor,
  footer,
}: {
  card: ProjectCard;
  /** 右侧任务面板正开着的那一行 */
  openTaskId: string | null;
  onOpenTask: (task: CardTask) => void;
  onOpenProject: (() => void) | null;
  onContinue: () => void;
  continueTip: string;
  clientJump: { label: string; onClick: () => void } | null;
  /** 这个项目最后一次活动（项目头右侧小字）；不知道就不写 */
  lastActive: string | null;
  /** 开着的那一行：此刻在做什么 / 这一轮跑了多久 / 这段对话花了多少 */
  liveMeta: (live: CardLiveRun) => { activity: string | null; elapsed: string | null; cost: string | null };
  /** 行尾光标：注意力 + 跑完没看（蓝） */
  caretFor: (live: CardLiveRun) => RunCaretState;
  /** 分组末尾一行（记目标的按钮 / 输入框由页面给）；没有就不画 */
  footer: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? card.tasks : card.tasks.slice(0, CARD_VISIBLE_TASKS);
  const hidden = card.tasks.length - shown.length;
  // 项目头只写「进行到」以外的几个数：进度由进度条和它下面的「第几步」说
  const vitals = card.vitals.filter((v) => v.label !== "进行到");
  const progress = card.vitals.find((v) => v.label === "进行到")?.value ?? null;
  return (
    <section className="border-t border-hairline first:border-t-0" aria-label={card.name}>
      <div className="group flex min-h-11 min-w-0 items-center gap-3 px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {onOpenProject ? (
            <button
              type="button"
              className="min-w-0 truncate text-left text-sm font-medium text-l1 hover:underline"
              title={`去项目页：${card.path}`}
              onClick={onOpenProject}
            >
              {card.name}
            </button>
          ) : (
            <span className="min-w-0 truncate text-sm font-medium text-l1" title={card.path}>
              {card.name}
            </span>
          )}
          {card.workMode ? (
            <span className="inline-block shrink-0 rounded-full border border-hairline px-1.5 py-px text-micro leading-tight text-l3">
              {WORK_MODE_LABEL[card.workMode]}
            </span>
          ) : null}
          {vitals.length > 0 && (
            <span className="hidden min-w-0 truncate text-micro text-l3 md:inline">
              {vitals.map((v) => `${v.label} ${v.value}`).join(" · ")}
            </span>
          )}
        </div>
        {card.track && (
          <div
            className="w-32 shrink-0"
            title={card.track.map((s, i) => `${i + 1}. ${s.name}${s.state === "done" ? "（已完成）" : s.state === "cur" ? "（当前）" : ""}`).join("\n")}
          >
            <div className="flex gap-[2px]">
              {card.track.map((s, i) => (
                <span
                  key={i}
                  className={`h-[3px] flex-1 rounded-full ${
                    s.state === "done" ? "bg-ok-text/60" : s.state === "cur" ? "bg-nav-accent" : "bg-hairline"
                  }`}
                />
              ))}
            </div>
            {progress && <div className="mt-0.5 text-micro text-l3">{progress}</div>}
          </div>
        )}
        {lastActive && (
          <span className="w-16 shrink-0 text-right text-micro text-l3" title={absTime(lastActive)}>
            {relTime(lastActive)}
          </span>
        )}
        {clientJump && (
          <button
            type="button"
            className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1 group-hover:flex group-focus-within:flex"
            title={`${clientJump.label}（只打开项目，不会定位到某条对话）`}
            aria-label={clientJump.label}
            onClick={clientJump.onClick}
          >
            <SquareArrowOutUpRight size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className={`${ghostActionClass} h-6 shrink-0 gap-1 px-1.5 text-l3 hover:text-l1`}
          title={continueTip}
          onClick={onContinue}
        >
          <span className="text-micro">继续</span>
          <ArrowRight size={12} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      {shown.length > 0 && (
        <ul className="pb-1.5">
          {shown.map((task) => {
            const meta = task.live ? liveMeta(task.live) : null;
            // 等你确认时照写「等你确认」，不拿正在跑的工具顶掉
            const state = meta?.activity && task.live?.attention !== "confirm" ? meta.activity : task.state;
            return (
              <li key={task.id}>
                <button
                  type="button"
                  className={`${TASK_GRID} min-h-8 w-full py-1 pl-6 pr-4 text-left hover:bg-hover ${
                    openTaskId === task.id ? "bg-hover shadow-[inset_2px_0_0_var(--color-nav-accent)]" : ""
                  }`}
                  aria-haspopup="dialog"
                  onClick={() => onOpenTask(task)}
                >
                  <span className={`size-1.5 rounded-full ${TONE_DOT[task.queued ? "wait" : task.tone]}`} />
                  <span className="truncate text-micro text-l4">{task.kindLabel}</span>
                  <span className="min-w-0 truncate text-sm text-l1" title={task.name}>
                    {task.name}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-micro text-l3">
                    <span className={`min-w-0 truncate ${task.tone === "fail" ? "text-err-text" : ""}`} title={state}>
                      {state}
                    </span>
                    {task.live && <RunCaret state={caretFor(task.live)} decorative className="text-micro" />}
                  </span>
                  <span className="truncate text-right font-mono text-micro tabular-nums text-l3" title="这一轮已跑多久">
                    {meta?.elapsed ?? ""}
                  </span>
                  <span className="truncate text-right font-mono text-micro tabular-nums text-l3" title="这段对话的花费">
                    {meta?.cost ?? ""}
                  </span>
                  <span className="text-right">
                    {task.queued && (
                      <span className="rounded-full bg-warn px-1.5 py-px text-micro text-warn-text">待拍板</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          {(hidden > 0 || expanded) && (
            <li>
              <button
                type="button"
                className="min-h-7 w-full pl-[calc(1.5rem+6px+0.75rem)] pr-4 text-left text-l3 hover:bg-hover hover:text-l1"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
              >
                <span className="text-micro">{expanded ? "收起" : `还有 ${hidden} 项`}</span>
              </button>
            </li>
          )}
        </ul>
      )}
      {footer ? <div className="pb-2 pl-[calc(1.5rem+6px+0.25rem)] pr-4">{footer}</div> : null}
    </section>
  );
}
