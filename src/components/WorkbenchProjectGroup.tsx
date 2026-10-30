import { useEffect, useId, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Briefcase,
  ChevronDown,
  Code,
  FlaskConical,
  GitBranch,
  MessageSquare,
  SquareArrowOutUpRight,
  Target,
} from "lucide-react";
import RunCaret from "./RunCaret";
import { ghostActionClass } from "./PageFrame";
import type { RunCaretState } from "../run-caret";
import { absTime, shortWhen } from "../rel-time";
import {
  CARD_VISIBLE_TASKS,
  type CardLiveRun,
  type CardTask,
  type ProjectCard,
} from "../workbench-cards";
import { WORK_MODE_LABEL } from "../work-mode";

/** 工作方式图标：与对话页项目选择器同一套（ChatProjectPicker MODE_ICON）；未添加的目录（随手聊）用对话图标 */
const MODE_ICON = { research: FlaskConical, coding: Code, office: Briefcase } as const;

/** 图标的颜色（2026-10-27 用户：「乍一看全是文字」——行首改成按类别的图标，颜色仍只给有事的）。
 *  图标只表类别 + 实时信号（在跑 / 等确认 / 排队）；停了、失败、待验收这类静态状态由行内状态字上色，
 *  图标不再跟着染（2026-10-30 用户截图：红靶心像警报，又和后面的红字重复说一遍） */
function iconTone(task: CardTask): string {
  if (task.queued) return "text-warn-text";
  if (task.live) return task.live.attention === "confirm" ? "text-warn-text" : task.live.attention === "working" ? "text-ok-text" : "text-l3";
  if (task.current) return "text-nav-accent";
  return "text-l3";
}

/** 行首类别图标：步骤写序号圈（当前步实心），分支 / 目标 / 对话各一个线条图标 */
function KindIcon({ task }: { task: CardTask }) {
  const tone = iconTone(task);
  if (task.ref.kind === "step") {
    return (
      <span className={`ccode-workbench-step-badge ${task.current ? "is-current" : ""} ${tone}`} aria-hidden="true">
        {task.ref.stepIndex + 1}
      </span>
    );
  }
  const Icon = task.ref.kind === "branch" ? GitBranch : task.ref.kind === "goal" ? Target : MessageSquare;
  return <Icon size={14} strokeWidth={1.8} className={tone} aria-hidden="true" />;
}

function stateClass(task: CardTask): string {
  if (task.live) return task.live.attention === "confirm" ? "text-warn-text" : task.live.attention === "working" ? "text-ok-text" : "text-l3";
  return task.tone === "fail" ? "text-err-text" : task.tone === "wait" ? "text-warn-text" : "text-l3";
}


/**
 * 工作台项目分组（workbench-cards.ts；2026-10-27 由卡片改成分组列表，用户截图：卡片一排按最高那张对齐、
 * 只有一行的卡下面空一大块，状态 / 时长 / 花费也横着对不齐）：一行项目头 + 下面缩进的任务行，
 * 按容器宽度收放状态与时间，几个分组摞在同一个细线框里，和上面的「等你拍板」同一种列表。
 * 2026-10-27 精修（用户：「有点粗糙」）：任务一行读完——名称后紧跟状态、时间靠右，不再每行带 →；
 * 项目头的去处 / 外开在悬停或聚焦时出现；工作方式写成灰字，不用胶囊；颜色只给在干活 / 等你 / 出错
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
  agentLabel,
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
  agentLabel: (id: string | null) => string | null;
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
  // 进度写在几个数里（「进行到 第 1 / 5 步」）：项目头不再挂进度条——下面的步骤序号圈已经说了走到哪（2026-10-27 用户：进度条突兀）
  const vitals = card.vitals;
  return (
    <section className="ccode-workbench-list overflow-hidden rounded-xl" aria-label={card.name}>
      <div className="ccode-workbench-project-head group flex min-w-0 flex-wrap items-center gap-2">
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
          {(() => {
            const ModeIcon = card.workMode ? MODE_ICON[card.workMode] : MessageSquare;
            return (
              <span title={card.workMode ? WORK_MODE_LABEL[card.workMode] : "对话"} className="flex shrink-0 text-l3">
                <ModeIcon size={14} strokeWidth={1.8} aria-hidden="true" />
              </span>
            );
          })()}
          {onOpenProject ? (
            <button
              type="button"
              className="min-w-0 break-words text-left text-l1 hover:underline"
              title={`去项目页：${card.path}`}
              onClick={onOpenProject}
            >
              <span className="text-sm font-semibold">{card.name}</span>
            </button>
          ) : (
            <span className="min-w-0 break-words text-sm font-semibold text-l1" title={card.path}>
              {card.name}
            </span>
          )}
          {vitals.length > 0 && (
            <span className="ccode-workbench-vitals min-w-0 text-xs text-l3">
              {vitals.map((v) => `${v.label} ${v.value}`).join(" · ")}
            </span>
          )}
        </div>
        {clientJump && (
          <button
            type="button"
            className="ccode-workbench-reveal flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
            title={`${clientJump.label}（只打开项目，不会定位到某条对话）`}
            aria-label={clientJump.label}
            onClick={clientJump.onClick}
          >
            <SquareArrowOutUpRight size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className={`${ghostActionClass} ccode-workbench-reveal h-6 shrink-0 gap-1 px-1.5 text-l3 hover:text-l1`}
          title={continueTip}
          onClick={onContinue}
        >
          <span className="text-xs">{continueLabel}</span>
          <ArrowRight size={12} strokeWidth={1.8} aria-hidden="true" />
        </button>
        {/* 时间放最右、与任务行时间同一右缘；按钮紧挨着时间，不再隔一整列（2026-10-27 用户） */}
        {lastActive && (
          <span className="ccode-workbench-updated shrink-0 text-right text-micro tabular-nums text-l3" title={absTime(lastActive)}>
            {shortWhen(lastActive)}
          </span>
        )}
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
                    className={`ccode-workbench-task w-full text-left hover:bg-hover ${
                      openTaskId === task.id || selected ? "bg-hover shadow-[inset_2px_0_0_var(--color-nav-accent)]" : ""
                    }`}
                    aria-haspopup="dialog"
                    onClick={() => onOpenTask(task)}
                  >
                    <span className="ccode-workbench-task-dot flex items-center justify-center" title={task.current ? `${task.kindLabel} · 流程当前这一步` : task.kindLabel}>
                      <KindIcon task={task} />
                    </span>
                    <span className="ccode-workbench-task-main min-w-0">
                      <span className="ccode-workbench-task-name min-w-0 text-sm text-l1" title={`${task.kindLabel} · ${task.name}`}>
                        {task.name}
                      </span>
                      <span className={`ccode-workbench-task-state min-w-0 text-xs ${stateClass(task)}`} title={state}>
                        {task.current && !task.live ? `当前这一步 · ${state}` : state}
                        {task.live ? ` · ${agentLabel(task.live.agentId) ?? task.live.agentId}` : ""}
                      </span>
                      {task.live && <RunCaret state={caretFor(task.live)} decorative className="shrink-0 text-micro" />}
                    </span>
                    {task.queued && (
                      <span className="ccode-workbench-task-flag shrink-0 rounded-full bg-warn px-1.5 py-px text-micro text-warn-text">待拍板</span>
                    )}
                    <span className="ccode-workbench-task-time min-w-0 text-micro tabular-nums text-l3" title={meta?.elapsed ? "这一轮已跑多久" : task.touchedAt ? `最后一次动它：${absTime(task.touchedAt)}` : undefined}>
                      {meta?.elapsed ? `本轮 ${meta.elapsed}` : shortWhen(task.touchedAt)}
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
