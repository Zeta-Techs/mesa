import { useEffect, useState, type ReactNode } from "react";
import { SettingsDrawerShell } from "./ProjectSettingsDrawer";
import { rowActionClass, secondaryActionClass } from "./PageFrame";
import RunCaret from "./RunCaret";
import { caretOfAttention } from "../run-caret";
import { absTime, relTime } from "../rel-time";
import { frequencyLabel, nextRunLabel, summaryPreview } from "../schedule-tasks";
import { codingDivergenceLabel } from "../work-mode";
import { criterionText, readableBrief } from "../acceptance-text";
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

/** 产物 / 路径排成一行行小标签，不竖排一长列 */
function PathChips({ paths }: { paths: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {paths.map((p) => (
        <li key={p} className="max-w-full break-all rounded-md bg-inset px-1.5 py-0.5 font-mono text-micro text-l2">
          {p}
        </li>
      ))}
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
    <div>
      <div className={`space-y-1.5 text-sm leading-relaxed text-l1 ${long && !open ? "line-clamp-5" : ""}`}>
        {paras.map((p, i) => (
          <p key={i} className="break-words">{p}</p>
        ))}
      </div>
      {long && (
        <button type="button" className="mt-1.5 text-xs text-l3 hover:text-l1" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "展开全文"}
        </button>
      )}
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
                <div className="mb-3"><Brief text={goal.description} resetKey={task.id} /></div>
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
              <PathChips paths={goal.inputPaths.map((p) => (p === "." ? "整个项目" : p))} />
            </Section>
          )}
          {goal?.adoptedPaths?.length ? (
            <Section title="上次写回项目的">
              <PathChips paths={goal.adoptedPaths} />
            </Section>
          ) : null}

          {step?.expectedArtifacts.length ? (
            <Section title="应交的产物">
              <PathChips paths={step.expectedArtifacts} />
            </Section>
          ) : null}
          {step?.acceptanceCriteria?.length ? (() => {
            // 人看的条件在前；Mesa 自动核对的（machine:）翻成白话、小字列在后面，不露内部写法
            const items = step.acceptanceCriteria.map(criterionText);
            const human = items.filter((c) => !c.machine);
            const auto = items.filter((c) => c.machine);
            return (
              <Section title="怎样算做完">
                {human.length > 0 && (
                  <ul className="list-disc space-y-1 pl-4 text-sm leading-relaxed text-l1">
                    {human.map((c) => (
                      <li key={c.text} className="break-words">{c.text}</li>
                    ))}
                  </ul>
                )}
                {auto.length > 0 && (
                  <div className={human.length ? "mt-2.5" : ""}>
                    <p className="mb-1 text-micro text-l3">Mesa 会自动核对：</p>
                    <ul className="space-y-0.5 text-xs text-l2">
                      {auto.map((c) => (
                        <li key={c.text} className="break-all">· {c.text}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </Section>
            );
          })() : null}
          {step && (
            <Section title="这一步要做什么">
              <Brief text={step.brief || step.name} resetKey={task.id} />
            </Section>
          )}
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
