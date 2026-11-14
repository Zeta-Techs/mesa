import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  FileDiff,
  FileText,
  Folder,
  FolderGit2,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
import { SettingsDrawerShell } from "./ProjectSettingsDrawer";
import { primaryActionClass, quietActionClass, secondaryActionClass } from "./PageFrame";
import RunCaret from "./RunCaret";
import TaskPanelPeek from "./TaskPanelPeek";
import { caretOfAttention } from "../run-caret";
import { absTime, relTime } from "../rel-time";
import { applyStepParams } from "../task-packs";
import { eventRuleLabel, frequencyLabel, nextRunLabel, scheduleStatusMark, summaryPreview } from "../schedule-tasks";
import { codingDivergenceLabel } from "../work-mode";
import { criterionText, readableBrief } from "../acceptance-text";
import { runFailureReason } from "../run-failure";
import type { CardTask, ProjectCard } from "../workbench-cards";
import type { CodingWorktreeDto, ProjectStepDto, RunDto, ScheduleDto, TaskDto } from "../types";

export interface TaskPanelAction {
  label: string;
  onClick: () => void;
  tone?: "primary" | "secondary" | "ghost";
  icon?: "chat" | "check" | "diff" | "clock" | "external";
}

const RUN_STATUS_LABEL: Record<RunDto["status"], string> = {
  created: "已登记",
  starting: "启动中",
  running: "开着",
  completed: "已结束",
  failed: "出错退出",
  stopped: "已停止",
};

const INLINE_TOKEN_RE =
  /(`[^`\n]+`|(?:~\/|\.\.?\/|\.[a-z0-9_-]+\/|(?:[a-z0-9_.-]+\/)+)[A-Za-z0-9_.*\/-]+|\b[A-Za-z0-9_-]+\.(?:md|qmd|bib|ris|xml|json|jsonl|csv|tsv|xlsx|pdf|docx|pptx|svg|png|py|sh|toml|yaml|yml|tex|csl)\b)/g;

/** 把混在中文段落里的仓库路径与文件名衬成轻量等宽底色块，保持 DOM textContent 原字不变 */
function InlineCodeText({ text }: { text: string }) {
  const parts = text.split(INLINE_TOKEN_RE);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, idx) => {
        if (!part) return null;
        if (idx % 2 === 1) {
          const clean = part.startsWith("`") && part.endsWith("`") && part.length > 2 ? part.slice(1, -1) : part;
          return (
            <code
              key={idx}
              className="mx-0.5 rounded bg-inset px-1 py-px font-mono text-[11.5px] text-l1"
            >
              {clean}
            </code>
          );
        }
        return <span key={idx}>{part}</span>;
      })}
    </>
  );
}

function ActionIcon({ kind }: { kind?: TaskPanelAction["icon"] }) {
  if (kind === "chat") return <MessageSquare size={13.5} aria-hidden="true" />;
  if (kind === "check") return <CheckCircle2 size={13.5} aria-hidden="true" />;
  if (kind === "diff") return <FileDiff size={13.5} aria-hidden="true" />;
  if (kind === "clock") return <Clock size={13.5} aria-hidden="true" />;
  if (kind === "external") return <ArrowUpRight size={13.5} aria-hidden="true" />;
  return null;
}

function actionButtonClass(action: TaskPanelAction, index: number): string {
  const tone = action.tone ?? (index === 0 ? "primary" : "secondary");
  if (tone === "primary") return `${primaryActionClass} gap-1.5`;
  if (tone === "ghost") return `${quietActionClass} ml-auto gap-1 px-2.5`;
  return `${secondaryActionClass} gap-1.5`;
}

function taskToneDotClass(task: CardTask): string {
  if (task.tone === "fail") return "bg-err-text";
  if (task.tone === "wait" || task.queued) return "bg-warn-text";
  if (task.tone === "live") return "bg-ok-text";
  if (task.current) return "bg-nav-accent";
  if (task.tone === "done") return "bg-ok-text/75";
  return "bg-l4";
}

function taskToneTextClass(task: CardTask): string {
  if (task.tone === "fail") return "text-err-text";
  if (task.tone === "wait" || task.queued) return "text-warn-text";
  return "text-l1";
}

function runDotClass(status: RunDto["status"]): string {
  if (status === "running" || status === "starting") return "bg-ok-text ring-2 ring-ok/30";
  if (status === "failed") return "bg-err-text ring-2 ring-err/30";
  if (status === "completed") return "bg-l3";
  return "border border-l3 bg-canvas";
}

function runBadgeClass(status: RunDto["status"]): string {
  if (status === "running" || status === "starting") return "bg-ok/35 text-ok-text";
  if (status === "failed") return "bg-err/35 text-err-text";
  return "bg-inset text-l3";
}

function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-l3">{title}</h3>
        {meta && <span className="text-micro text-l4">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-hairline/60 rounded-lg ccode-well px-3.5 py-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-x-3 py-2">
          <dt className="text-l3">{k}</dt>
          <dd className="min-w-0 break-words text-l1">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 产物 / 路径排成一行行小标签，不竖排一长列 */
function PathChips({ paths }: { paths: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {paths.map((p) => {
        const isDir = p.endsWith("/") || p === "整个项目";
        return (
          <li
            key={p}
            className="inline-flex max-w-full items-center gap-1.5 break-all rounded-md border border-hairline/80 bg-inset/75 px-2 py-1 font-mono text-micro text-l1"
          >
            {isDir ? (
              <Folder size={11.5} className="shrink-0 text-l3" aria-hidden="true" />
            ) : (
              <FileText size={11.5} className="shrink-0 text-l3" aria-hidden="true" />
            )}
            <span>{p}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 长说明默认只露前几行，点「展开全文」再看全（2026-10-27 用户截图：任务书整段铺满抽屉）。
 * 段落按原文换行分开，段间留一点空；`{skill:x}` 写成技能名
 */
function Brief({ text, resetKey }: { text: string; resetKey: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [resetKey]);
  const paras = readableBrief(text).split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const long = paras.length > 3 || text.length > 220;
  return (
    <div className="rounded-lg ccode-well px-3.5 py-3">
      <div className={`space-y-2 text-sm leading-relaxed text-l2 ${long && !open ? "line-clamp-5" : ""}`}>
        {paras.map((p, i) => (
          <p key={i} className="break-words">
            <InlineCodeText text={p} />
          </p>
        ))}
      </div>
      {long && (
        <button
          type="button"
          className="-ml-1.5 mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-l3 transition-colors hover:bg-hover hover:text-l1"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span>{open ? "收起" : "展开全文"}</span>
          <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function WorktreePathBox({ path }: { path: string | null }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [path]);
  if (!path) {
    return (
      <div className="rounded-lg ccode-well px-3.5 py-2.5 text-xs text-l3">
        还没开工，开始这一步时创建
      </div>
    );
  }
  const sepIdx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = sepIdx >= 0 ? path.slice(0, sepIdx + 1) : "";
  const leaf = sepIdx >= 0 ? path.slice(sepIdx + 1) : path;
  return (
    <div className="flex items-start justify-between gap-2 rounded-lg ccode-well px-3 py-2.5">
      <FolderGit2 size={14} className="mt-0.5 shrink-0 text-l3" aria-hidden="true" />
      <p className="min-w-0 flex-1 break-all font-mono text-micro leading-relaxed">
        {dir && <span className="text-l3">{dir}</span>}
        <span className="font-medium text-l1">{leaf}</span>
      </p>
      <button
        type="button"
        aria-label="复制工作副本路径"
        title={copied ? "已复制" : "复制路径"}
        className="-mr-1 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
        onClick={() => {
          void navigator.clipboard?.writeText(path).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={12.5} className="text-ok-text" aria-hidden="true" /> : <Copy size={12.5} aria-hidden="true" />}
      </button>
    </div>
  );
}

/**
 * 工作台任务面板（2026-10-27 第二批）：点项目分组里的任务行，在右侧看这件事——要做什么、现在怎样、过程、产物，
 * 再从这里回到对话 / 去验收 / 去项目页。只读展示，动作都走已有入口，不在这里另起一套开工或验收流程。
 */
export default function WorkbenchTaskPanel({
  open,
  onClose,
  card,
  task,
  step,
  goal,
  branch,
  baseBranch,
  schedule,
  pastRuns,
  agentLabel,
  live,
  actions,
  onAskWhy = null,
  mailDraft = null,
}: {
  open: boolean;
  onClose: () => void;
  card: ProjectCard | null;
  task: CardTask | null;
  step: ProjectStepDto | null;
  goal: TaskDto | null;
  branch: CodingWorktreeDto | null;
  baseBranch: string | null;
  schedule: ScheduleDto | null;
  /** 这件事的运行记录（新的在前） */
  pastRuns: readonly RunDto[];
  agentLabel: (id: string | null) => string | null;
  /** 在跑那一行的实时信息（第三批：此刻在做什么 / 跑了多久 / 花费）；没有就不画 */
  live: ReactNode;
  actions: readonly TaskPanelAction[];
  /** 出错的那次运行旁「问问为什么」：带着这次运行打开项目助手（只有登记过的项目有） */
  onAskWhy?: ((run: RunDto) => void) | null;
  /** 项目助手带来的留话草稿（填进「给它留话」框） */
  mailDraft?: string | null;
}) {
  const stepTotal = task?.kind === "step" && card?.track?.length ? card.track.length : null;
  const subtitle = task && card
    ? `${card.name} · ${task.kindLabel}${stepTotal ? ` / ${stepTotal}` : ""}`
    : undefined;

  return (
    <SettingsDrawerShell
      className="ccode-workbench-detail"
      backdropClassName="ccode-workbench-detail-backdrop"
      open={open && !!task}
      onClose={onClose}
      title={task?.name ?? "任务"}
      subtitle={subtitle}
      headerActions={actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((action, index) => {
            const trailingExternal = action.icon === "external" && action.tone === "ghost";
            return (
              <button
                key={action.label}
                type="button"
                className={actionButtonClass(action, index)}
                onClick={action.onClick}
              >
                {!trailingExternal && <ActionIcon kind={action.icon} />}
                <span>{action.label}</span>
                {trailingExternal && <ActionIcon kind={action.icon} />}
              </button>
            );
          })}
        </div>
      )}
    >
      {task && (
        <>
          <div className="rounded-lg ccode-well px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {task.live ? (
                <RunCaret state={caretOfAttention(task.live.attention)} decorative />
              ) : (
                <span className={`h-2 w-2 shrink-0 rounded-full ${taskToneDotClass(task)}`} aria-hidden="true" />
              )}
              <span className={`min-w-0 flex-1 text-xs font-medium ${taskToneTextClass(task)}`}>
                {task.state}
              </span>
              {task.queued && (
                <span className="shrink-0 rounded-full bg-warn/45 px-2 py-0.5 text-micro font-medium text-warn-text">
                  · 在「等你拍板」里
                </span>
              )}
            </div>
            {task.kind === "step" && card?.track && card.track.length > 1 && (
              <div className="mt-2.5 flex gap-1" aria-hidden="true">
                {card.track.map((seg, i) => (
                  <span
                    key={`${seg.name}-${i}`}
                    title={`步骤 ${i + 1}：${seg.name}`}
                    className={`h-1 flex-1 rounded-full ${
                      task.ref.kind === "step" && task.ref.stepIndex === i
                        ? "bg-nav-accent"
                        : seg.state === "done"
                          ? "bg-nav-accent/45"
                          : "bg-inset"
                    }`}
                  />
                ))}
              </div>
            )}
            {live && <div className="mt-2.5 border-t border-hairline/80 pt-2">{live}</div>}
          </div>

          {/* 开着的工作：改了哪些文件、给它留话（2026-11-03 协调对话并进工作台）；定时任务的无头运行不收留话 */}
          {task.live?.runId && card && task.ref.kind !== "schedule" && (
            <TaskPanelPeek runId={task.live.runId} projectPath={card.path} draft={mailDraft} agentId={task.live.agentId} />
          )}

          {goal && (
            <Section title="目标">
              {goal.description.trim() && goal.description.trim() !== goal.name.trim() && (
                <div className="mb-2.5"><Brief text={goal.description} resetKey={task.id} /></div>
              )}
              <Rows
                rows={[
                  ["Agent", agentLabel(goal.agent) ?? "跟随项目默认"],
                  ["写回方式", goal.reviewRequired ? "验收后写入项目" : "直接写在项目里"],
                  ["记下于", <span title={absTime(goal.createdAt)}>{relTime(goal.createdAt)}</span>],
                ]}
              />
            </Section>
          )}
          {goal && (
            <Section title="带上的资料">
              <PathChips paths={goal.inputPaths.map((p) => (p === "." ? "整个项目" : p))} />
            </Section>
          )}
          {goal?.adoptedPaths?.length ? (
            <Section title="上次写回项目的">
              <PathChips paths={goal.adoptedPaths} />
            </Section>
          ) : null}

          {step?.expectedArtifacts.length ? (
            <Section title="应交的产物" meta={`${step.expectedArtifacts.length} 项`}>
              <PathChips paths={step.expectedArtifacts} />
            </Section>
          ) : null}
          {step?.acceptanceCriteria?.length ? (() => {
            // 人看的条件在前；Mesa 自动核对的（machine:）翻成白话、小字列在后面，不露内部写法
            const items = step.acceptanceCriteria.map(criterionText);
            const human = items.filter((c) => !c.machine);
            const auto = items.filter((c) => c.machine);
            return (
              <Section title="怎样算做完" meta={`${items.length} 条`}>
                <div className="rounded-lg ccode-well px-3.5 py-3">
                  {human.length > 0 && (
                    <ul className="space-y-2 text-sm leading-relaxed text-l1">
                      {human.map((c) => (
                        <li key={c.text} className="flex items-start gap-2.5">
                          <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-l3" aria-hidden="true" />
                          <span className="min-w-0 flex-1 break-words">
                            <InlineCodeText text={c.text} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {auto.length > 0 && (
                    <div className={human.length ? "mt-3 border-t border-hairline/80 pt-2.5" : ""}>
                      <p className="mb-1.5 inline-flex items-center gap-1.5 text-micro font-medium text-l3">
                        <ShieldCheck size={12.5} className="text-l3" aria-hidden="true" />
                        <span>Mesa 会自动核对：</span>
                      </p>
                      <ul className="space-y-1 text-xs leading-relaxed text-l2">
                        {auto.map((c) => (
                          <li key={c.text} className="break-words pl-1">
                            <span className="mr-1.5 text-l4">·</span>
                            <InlineCodeText text={c.text} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </Section>
            );
          })() : null}
          {step && (
            <Section title="这一步要做什么">
              <Brief text={applyStepParams(step).brief || step.name} resetKey={task.id} />
            </Section>
          )}
          {task.ref.kind === "step" && (
            <Section title="工作副本">
              <WorktreePathBox path={task.ref.worktreePath} />
            </Section>
          )}

          {branch && (
            <Section title="分支">
              <Rows
                rows={[
                  ["名称", <span className="font-mono text-micro">{branch.branch || "（游离）"}</span>],
                  ["和基准比", codingDivergenceLabel(branch.ahead, branch.behind, baseBranch ?? "") || "和基准一致"],
                  ["没提交的", branch.dirty ? `${branch.dirtyCount ?? "有"} 个文件` : "没有"],
                  ...(branch.lastCommitAt
                    ? ([["最近提交", <span title={absTime(branch.lastCommitAt)}>{relTime(branch.lastCommitAt)}</span>]] as [string, ReactNode][])
                    : []),
                  ["目录", <span className="font-mono text-micro">{branch.path}</span>],
                ]}
              />
            </Section>
          )}

          {schedule && (
            <Section title="定时">
              <Rows
                rows={[
                  // 事件规则（2026-11-02）没有频率和「下次」：写什么时候算一次、只记录还是直接跑、攒着几批
                  ...(schedule.event
                    ? ([
                        ["触发", eventRuleLabel(schedule.event).split(" · ")[0]],
                        ["事件来了", schedule.event.mode === "run" ? "直接跑（结果要你评审）" : "只记录（不叫 AI）"],
                        ...(schedule.pendingEvents
                          ? ([["攒着", `${schedule.pendingEvents} 批，评审完上一轮后一并处理`]] as [string, ReactNode][])
                          : []),
                      ] as [string, ReactNode][])
                    : ([
                        ["频率", frequencyLabel(schedule.frequency, schedule.weekday, schedule.hour, schedule.minute, schedule.intervalHours)],
                        ["下次", nextRunLabel(schedule)?.replace(/^下次 /, "") ?? (schedule.enabled ? "仅手动" : "已停用")],
                      ] as [string, ReactNode][])),
                  ...(schedule.stalledMinutes != null
                    ? ([["可能卡住", `${schedule.stalledMinutes} 分钟没有输出、文件和对话记录都没变`]] as [string, ReactNode][])
                    : []),
                  ...(schedule.pausedReason ? ([["暂停原因", schedule.pausedReason]] as [string, ReactNode][]) : []),
                  ["技能", <span className="rounded bg-inset px-1.5 py-0.5 font-mono text-micro">{schedule.skill}</span>],
                ]}
              />
            </Section>
          )}
          {schedule && schedule.history.length > 0 && (
            <Section title="最近几次">
              <ul className="divide-y divide-hairline/60 rounded-lg ccode-well px-3.5 py-1">
                {schedule.history.slice(0, 4).map((r) => {
                  const statusLabel = r.status === "ok" ? "完成" : scheduleStatusMark(r.status).label;
                  const isErr = r.status === "error";
                  return (
                    <li key={`${r.at}-${r.status}`} className="py-2 text-xs">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${isErr ? "bg-err-text" : r.status === "ok" ? "bg-ok-text/80" : "bg-l4"}`}
                            aria-hidden="true"
                          />
                          <span className={isErr ? "font-medium text-err-text" : "font-medium text-l2"}>
                            {statusLabel}
                            {r.trigger === "event" ? " · 事件" : ""}
                          </span>
                        </span>
                        <span className="tabular-nums text-micro text-l3" title={absTime(r.at)}>
                          {relTime(r.at)}
                        </span>
                      </div>
                      <p className="line-clamp-2 leading-relaxed text-l2">{summaryPreview(r)}</p>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          {task.ref.kind === "chat" && task.live && (
            <Section title="对话">
              <Rows rows={[["Agent", agentLabel(task.live.agentId) ?? task.live.agentId]]} />
            </Section>
          )}

          {pastRuns.length > 0 && (
            <Section title="过程" meta={`最近 ${Math.min(pastRuns.length, 6)} 次`}>
              <div className="rounded-lg ccode-well px-3.5 py-3">
                <ul className="relative space-y-3 pl-4 before:absolute before:bottom-2 before:left-[3.5px] before:top-2 before:w-px before:bg-hairline">
                  {pastRuns.slice(0, 6).map((run) => (
                    <li key={run.id} className="relative text-xs">
                      <span
                        className={`absolute -left-4 top-[5px] h-2 w-2 rounded-full ${runDotClass(run.status)}`}
                        aria-hidden="true"
                      />
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate font-medium text-l1">
                          {agentLabel(run.agent) ?? run.agent}
                        </span>
                        <span className={`shrink-0 rounded px-1.5 py-px text-micro ${runBadgeClass(run.status)}`}>
                          {RUN_STATUS_LABEL[run.status] ?? run.status}
                        </span>
                        <span className="ml-auto shrink-0 tabular-nums text-micro text-l3" title={absTime(run.createdAt)}>
                          {relTime(run.createdAt)}
                        </span>
                      </div>
                      {/* 出错写清原因（2026-11-04）：退出码白话 + 关闭原因，原来只有「出错退出」四个字 */}
                      {run.status === "failed" && (
                        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-md bg-err/25 px-2.5 py-1.5 text-xs">
                          <span className="min-w-0 flex-1 break-words leading-relaxed text-err-text">
                            {runFailureReason(run)}
                          </span>
                          {onAskWhy && (
                            <button
                              type="button"
                              className="shrink-0 rounded bg-canvas/75 px-2 py-0.5 text-micro font-medium text-l2 transition-colors hover:bg-canvas hover:text-l1"
                              onClick={() => onAskWhy(run)}
                            >
                              问问为什么
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </Section>
          )}
        </>
      )}
    </SettingsDrawerShell>
  );
}
