import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, SquareArrowOutUpRight } from "lucide-react";
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

/**
 * 工作台项目分组（workbench-cards.ts；2026-10-27 由卡片改成分组列表，用户截图：卡片一排按最高那张对齐、
 * 只有一行的卡下面空一大块，状态 / 时长 / 花费也横着对不齐）：一行项目头 + 下面缩进的任务行，
 * 按容器宽度收放状态与时间，几个分组摞在同一个细线框里，和上面的「等你拍板」同一种列表
 */
export default function WorkbenchProjectGroup({
  card,
  openTaskId,
  selectedTaskId,
  onOpenTask,
  onOpenProject,
  onContinue,
  continueTip,
  continueLabel,
  clientJump,
  lastActive,
  liveMeta,
  caretFor,
  footer,
}: {
  card: ProjectCard;
  /** 右侧任务面板正开着的那一行 */
  openTaskId: string | null;
  /** 键盘选中的那一行（选到折起来的部分时整组展开） */
  selectedTaskId: string | null;
  onOpenTask: (task: CardTask) => void;
  onOpenProject: (() => void) | null;
  onContinue: () => void;
  continueTip: string;
  continueLabel: string;
  clientJump: { label: string; onClick: () => void } | null;
  /** 这个项目最后一次活动（项目头右侧小字）；不知道就不写 */
  lastActive: string | null;
  /** 开着的那一行：此刻在做什么 / 这一轮跑了多久 */
  liveMeta: (live: CardLiveRun) => { activity: string | null; elapsed: string | null };
  /** 行尾光标：注意力 + 跑完没看（蓝） */
  caretFor: (live: CardLiveRun) => RunCaretState;
  /** 分组末尾一行（记目标的按钮 / 输入框由页面给）；没有就不画 */
  footer: ReactNode;
}) {
  const contentsId = useId();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (selectedTaskId) setCollapsed(false);
  }, [selectedTaskId]);
  const [expandedByClick, setExpanded] = useState(false);
  const selectedAt = selectedTaskId ? card.tasks.findIndex((t) => t.id === selectedTaskId) : -1;
  const expanded = expandedByClick || selectedAt >= CARD_VISIBLE_TASKS;
  const shown = expanded ? card.tasks : card.tasks.slice(0, CARD_VISIBLE_TASKS);
  const hidden = card.tasks.length - shown.length;
  // 项目头只写「进行到」以外的几个数：进度由进度条和它下面的「第几步」说
  const vitals = card.vitals.filter((v) => v.label !== "进行到");
  const progress = card.vitals.find((v) => v.label === "进行到")?.value ?? null;
  return (
    <section className="border-t border-hairline first:border-t-0" aria-label={card.name}>
      <div className="ccode-workbench-project-head group flex min-h-11 min-w-0 flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-l3 hover:bg-hover hover:text-l1"
          aria-label={`${collapsed ? "展开" : "收起"}${card.name}`}
          aria-expanded={!collapsed}
          aria-controls={contentsId}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronDown size={14} className={collapsed ? "-rotate-90" : ""} aria-hidden="true" />
        </button>
        <div className="ccode-workbench-project-name flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {onOpenProject ? (
            <button
              type="button"
              className="min-w-0 break-words text-left text-sm font-medium text-l1 hover:underline"
              title={`去项目页：${card.path}`}
              onClick={onOpenProject}
            >
              {card.name}
            </button>
          ) : (
            <span className="min-w-0 break-words text-sm font-medium text-l1" title={card.path}>
              {card.name}
            </span>
          )}
          {card.workMode ? (
            <span className="inline-block shrink-0 rounded-full border border-hairline px-1.5 py-px text-micro leading-tight text-l3">
              {WORK_MODE_LABEL[card.workMode]}
            </span>
          ) : null}
          {vitals.length > 0 && (
            <span className="ccode-workbench-vitals min-w-0 text-micro text-l3">
              {vitals.map((v) => `${v.label} ${v.value}`).join(" · ")}
            </span>
          )}
        </div>
        {card.track && (
          <div
            className="ccode-workbench-track w-32 shrink-0"
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
          <span className="ccode-workbench-updated shrink-0 text-right text-micro text-l3" title={absTime(lastActive)}>
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
          <span className="text-xs">{continueLabel}</span>
          <ArrowRight size={12} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <div id={contentsId} hidden={collapsed}>
        {shown.length > 0 && (
          <ul className="pb-1.5">
            {shown.map((task) => {
              const meta = task.live ? liveMeta(task.live) : null;
              const selected = selectedTaskId === task.id;
              // 等你确认时照写「等你确认」，不拿正在跑的工具顶掉
              const state = meta?.activity && task.live?.attention !== "confirm" ? meta.activity : task.state;
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    id={`wbt-${card.path}\n${task.id}`}
                    data-workbench-nav={`t:${card.path}\n${task.id}`}
                    className={`ccode-workbench-task min-h-9 w-full py-1 pl-6 pr-4 text-left hover:bg-hover ${
                      openTaskId === task.id || selected ? "bg-hover shadow-[inset_2px_0_0_var(--color-nav-accent)]" : ""
                    }`}
                    aria-haspopup="dialog"
                    onClick={() => onOpenTask(task)}
                  >
                    <span
                      aria-hidden="true"
                      className={`ccode-workbench-task-dot size-1.5 rounded-full ${
                        task.current && task.tone === "idle" && !task.queued ? "bg-nav-accent" : TONE_DOT[task.queued ? "wait" : task.tone]
                      }`}
                      title={task.current ? "流程当前这一步" : undefined}
                    />
                    <span className="ccode-workbench-task-kind text-micro text-l3">{task.kindLabel}</span>
                    <span className="ccode-workbench-task-name min-w-0 break-words text-sm text-l1" title={task.name}>
                      {task.name}
                    </span>
                    <span className="ccode-workbench-task-state flex min-w-0 items-center gap-1.5 text-xs text-l3">
                      <span className={`min-w-0 break-words ${task.tone === "fail" ? "text-err-text" : ""}`} title={state}>
                        {state}
                      </span>
                      {task.live && <RunCaret state={caretFor(task.live)} decorative className="text-micro" />}
                    </span>
                    <span className="ccode-workbench-task-time min-w-0 text-xs tabular-nums text-l3" title={meta?.elapsed ? "这一轮已跑多久" : task.touchedAt ? absTime(task.touchedAt) : undefined}>
                      {meta?.elapsed ? `本轮 ${meta.elapsed}` : task.touchedAt ? `更新于 ${relTime(task.touchedAt)}` : ""}
                    </span>
                    <span className="ccode-workbench-task-badge text-right">
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
      </div>
    </section>
  );
}
