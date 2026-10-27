import { useState, type ReactNode } from "react";
import { ArrowRight, SquareArrowOutUpRight } from "lucide-react";
import RunCaret from "./RunCaret";
import { ghostActionClass, rowActionClass } from "./PageFrame";
import {
  CARD_VISIBLE_TASKS,
  type CardLiveRun,
  type CardTask,
  type CardTone,
  type ProjectCard,
} from "../workbench-cards";
import type { RunCaretState } from "../run-caret";
import { absTime, relTime } from "../rel-time";
import { WORK_MODE_LABEL } from "../work-mode";

const TONE_DOT: Record<CardTone, string> = {
  live: "bg-ok-text",
  wait: "bg-warn-text",
  fail: "bg-err-text",
  done: "bg-ok-text/50",
  idle: "bg-l4/60",
};

/** 工作台项目卡（workbench-cards.ts）：卡头 = 项目现在怎么样，任务行 = 里面每件事到哪了，卡底 = 下一步能做什么 */
export default function WorkbenchProjectCard({
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
  /** 这个项目最后一次对话活动（卡头右侧小字）；不知道就不写 */
  lastActive: string | null;
  /** 开着的那一行：此刻在做什么 / 这一轮跑了多久 / 这段对话花了多少（第三批） */
  liveMeta: (live: CardLiveRun) => { activity: string | null; elapsed: string | null; cost: string | null };
  /** 行尾光标：注意力 + 跑完没看（蓝） */
  caretFor: (live: CardLiveRun) => RunCaretState;
  /** 卡底动作区（记目标的按钮 / 输入框由页面给） */
  footer: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? card.tasks : card.tasks.slice(0, CARD_VISIBLE_TASKS);
  const hidden = card.tasks.length - shown.length;
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg ccode-well">
      <div className="group px-4 pb-2.5 pt-3">
        <div className="flex min-w-0 items-center gap-2">
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
          <span className="flex-1" />
          {lastActive && (
            <span className="shrink-0 text-micro text-l3" title={absTime(lastActive)}>
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
            className={`${ghostActionClass} h-6 gap-1 px-1.5 text-l3 hover:text-l1`}
            title={continueTip}
            onClick={onContinue}
          >
            <span className="text-micro">继续</span>
            <ArrowRight size={12} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        {card.vitals.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-0.5 text-micro text-l3">
            {card.vitals.map((v) => (
              <span key={v.label}>
                {v.label} <span className="font-medium tabular-nums text-l1">{v.value}</span>
              </span>
            ))}
          </div>
        )}
        {card.track && (
          <div className="mt-2" title={card.track.map((s, i) => `${i + 1}. ${s.name}`).join("\n")}>
            <div className="flex gap-[3px]">
              {card.track.map((s, i) => (
                <span
                  key={i}
                  className={`h-1 flex-1 rounded-full ${
                    s.state === "done" ? "bg-ok-text/60" : s.state === "cur" ? "bg-nav-accent" : "bg-hairline"
                  }`}
                />
              ))}
            </div>
            {card.track.length <= 6 && (
              <div className="mt-1 flex gap-[3px] text-micro text-l4">
                {card.track.map((s, i) => (
                  <span key={i} className="min-w-0 flex-1 truncate">
                    {s.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {shown.length > 0 ? (
        <ul className="border-t border-hairline">
          {shown.map((task) => {
            const meta = task.live ? liveMeta(task.live) : null;
            const side = [meta?.elapsed, meta?.cost].filter(Boolean).join(" · ");
            return (
            <li key={task.id} className="border-t border-hairline first:border-t-0">
              <button
                type="button"
                className={`flex min-h-10 w-full items-center gap-2.5 px-4 py-1.5 text-left hover:bg-hover ${
                  openTaskId === task.id ? "bg-hover shadow-[inset_2px_0_0_var(--color-nav-accent)]" : ""
                }`}
                aria-haspopup="dialog"
                onClick={() => onOpenTask(task)}
              >
                <span className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[task.queued ? "wait" : task.tone]}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="shrink-0 text-micro text-l4">{task.kindLabel}</span>
                    <span className="min-w-0 truncate text-sm text-l1">{task.name}</span>
                  </span>
                  <span className="mt-px flex min-w-0 items-center gap-1.5 text-micro text-l3">
                    {/* 等你确认时照写「等你确认」，不拿正在跑的工具顶掉 */}
                    <span className="min-w-0 truncate" title={meta?.activity ?? undefined}>
                      {meta?.activity && task.live?.attention !== "confirm" ? meta.activity : task.state}
                    </span>
                    {task.live && (
                      <RunCaret state={caretFor(task.live)} decorative className="text-micro" />
                    )}
                  </span>
                </span>
                {side && (
                  <span className="shrink-0 font-mono text-micro tabular-nums text-l3" title="这一轮已跑多久 · 这段对话的花费">
                    {side}
                  </span>
                )}
                {task.queued && (
                  <span className="shrink-0 rounded-full bg-warn px-1.5 py-px text-micro text-warn-text">待拍板</span>
                )}
              </button>
            </li>
            );
          })}
        </ul>
      ) : (
        <p className="border-t border-hairline px-4 py-2.5 text-micro text-l3">
          这个项目里没有进行中的任务。
        </p>
      )}
      {hidden > 0 || expanded ? (
        <button
          type="button"
          className={`${rowActionClass} w-full justify-start rounded-none border-t border-hairline px-4 text-l3`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "收起" : `还有 ${hidden} 项`}
        </button>
      ) : null}
      {footer ? (
        <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-hairline px-3 py-1.5">{footer}</div>
      ) : null}
    </div>
  );
}
