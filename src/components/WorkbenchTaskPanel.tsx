import type { ReactNode } from "react";
import { SettingsDrawerShell } from "./ProjectSettingsDrawer";
import { rowActionClass, secondaryActionClass } from "./PageFrame";
import RunCaret from "./RunCaret";
import { caretOfAttention } from "../run-caret";
import { absTime, relTime } from "../rel-time";
import { frequencyLabel, nextRunLabel, summaryPreview } from "../schedule-tasks";
import { codingDivergenceLabel } from "../work-mode";
import type { CardTask, ProjectCard } from "../workbench-cards";
import type { CodingWorktreeDto, ProjectStepDto, RunDto, ScheduleDto, TaskDto } from "../types";

export interface TaskPanelAction {
  label: string;
  onClick: () => void;
}

const RUN_STATUS_LABEL: Record<RunDto["status"], string> = {
  created: "已登记",
  starting: "启动中",
  running: "开着",
  completed: "已结束",
  failed: "出错退出",
  stopped: "已停止",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-medium text-l3">{title}</h3>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-l3">{k}</dt>
          <dd className="min-w-0 break-words text-l1">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function PathList({ paths }: { paths: readonly string[] }) {
  if (!paths.length) return <p className="text-sm text-l3">（无）</p>;
  return (
    <ul className="space-y-0.5">
      {paths.map((p) => (
        <li key={p} className="break-all font-mono text-micro text-l2">
          {p}
        </li>
      ))}
    </ul>
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
}) {
  return (
    <SettingsDrawerShell
      className="ccode-workbench-detail"
      backdropClassName="ccode-workbench-detail-backdrop"
      open={open && !!task}
      onClose={onClose}
      title={task?.name ?? "任务"}
      subtitle={task && card ? `${card.name} · ${task.kindLabel}` : undefined}
      headerActions={actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((action, index) => (
            <button
              key={action.label}
              type="button"
              className={index === 0 ? secondaryActionClass : rowActionClass}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    >
      {task && (
        <>
          <div className="flex items-center gap-2 text-sm">
            {task.live && <RunCaret state={caretOfAttention(task.live.attention)} decorative />}
            <span className={task.queued ? "text-warn-text" : "text-l2"}>
              {task.state}
              {task.queued ? " · 在「等你拍板」里" : ""}
            </span>
          </div>
          {live}

          {goal && (
            <Section title="目标">
              {goal.description.trim() && goal.description.trim() !== goal.name.trim() && (
                <p className="mb-3 whitespace-pre-wrap break-words text-sm text-l1">{goal.description}</p>
              )}
              <div>
                <Rows
                  rows={[
                    ["Agent", agentLabel(goal.agent) ?? "跟随项目默认"],
                    ["写回方式", goal.reviewRequired ? "验收后写入项目" : "直接写在项目里"],
                    ["记下于", <span title={absTime(goal.createdAt)}>{relTime(goal.createdAt)}</span>],
                  ]}
                />
              </div>
            </Section>
          )}
          {goal && (
            <Section title="带上的资料">
              <PathList paths={goal.inputPaths.map((p) => (p === "." ? "整个项目" : p))} />
            </Section>
          )}
          {goal?.adoptedPaths?.length ? (
            <Section title="上次写回项目的">
              <PathList paths={goal.adoptedPaths} />
            </Section>
          ) : null}

          {step && (
            <Section title="这一步要做什么">
              <p className="whitespace-pre-wrap break-words text-sm text-l1">{step.brief || step.name}</p>
            </Section>
          )}
          {step?.expectedArtifacts.length ? (
            <Section title="应交的产物">
              <PathList paths={step.expectedArtifacts} />
            </Section>
          ) : null}
          {step?.acceptanceCriteria?.length ? (
            <Section title="怎样算做完">
              <ul className="list-disc space-y-0.5 pl-4 text-sm text-l1">
                {step.acceptanceCriteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Section>
          ) : null}
          {task.ref.kind === "step" && (
            <Section title="工作副本">
              <p className="break-all font-mono text-micro text-l2">
                {task.ref.worktreePath ?? "还没开工，开始这一步时创建"}
              </p>
            </Section>
          )}

          {branch && (
            <Section title="分支">
              <Rows
                rows={[
                  ["名称", <span className="font-mono">{branch.branch || "（游离）"}</span>],
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
                  ["频率", frequencyLabel(schedule.frequency, schedule.weekday, schedule.hour, schedule.minute, schedule.intervalHours)],
                  ["下次", nextRunLabel(schedule)?.replace(/^下次 /, "") ?? (schedule.enabled ? "仅手动" : "已停用")],
                  ...(schedule.pausedReason ? ([["暂停原因", schedule.pausedReason]] as [string, ReactNode][]) : []),
                  ["技能", <span className="font-mono">{schedule.skill}</span>],
                ]}
              />
            </Section>
          )}
          {schedule && schedule.history.length > 0 && (
            <Section title="最近几次">
              <ul className="space-y-1.5">
                {schedule.history.slice(0, 4).map((r) => (
                  <li key={`${r.at}-${r.status}`} className="text-sm">
                    <span className="text-micro text-l3" title={absTime(r.at)}>
                      {relTime(r.at)} ·{" "}
                      {r.status === "ok" ? "完成" : r.status === "skipped" ? "跳过" : r.status === "timeout" ? "超时" : "失败"}
                    </span>
                    <p className="line-clamp-2 text-l2">{summaryPreview(r)}</p>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {task.ref.kind === "chat" && task.live && (
            <Section title="对话">
              <Rows rows={[["Agent", agentLabel(task.live.agentId) ?? task.live.agentId]]} />
            </Section>
          )}

          {pastRuns.length > 0 && (
            <Section title="过程">
              <ul className="space-y-1">
                {pastRuns.slice(0, 6).map((run) => (
                  <li key={run.id} className="flex items-baseline gap-2 text-sm">
                    <span className="w-16 shrink-0 text-micro text-l3" title={absTime(run.createdAt)}>
                      {relTime(run.createdAt)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-l2">
                      {agentLabel(run.agent) ?? run.agent} · {RUN_STATUS_LABEL[run.status] ?? run.status}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

        </>
      )}
    </SettingsDrawerShell>
  );
}
