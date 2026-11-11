import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { primaryActionClass } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import { ReworkDialog, type ReworkFields } from "./StepLoop";
import { dispatchStatus, type DispatchRecord, type DispatchTone } from "../assistant-dispatch";
import { relTime } from "../rel-time";
import { loadSkillProvides, type SkillProvides } from "../skill-slots";
import { litKind, sendReworkRound } from "../step-round";
import { reworkTargets } from "../step-loop";
import { chainDefaultOff, stepKind } from "../step-kind";
import type { ReworkOrder } from "../project-assistant";
import type { ProjectConfigReadDto, ProjectStepDto, WorkspaceDto } from "../types";

const TONE_CLASS: Record<DispatchTone, string> = {
  wait: "text-warn-text",
  live: "text-ok-text",
  done: "text-cta",
  fail: "text-err-text",
  idle: "text-l3",
};

/**
 * 项目助手起草的补料单（2026-11-06 流程贯通 §4，design-flow-weave.md）：你说「按新大纲第 3 节补文献」，它起草退回哪一步、补什么、为什么。
 * 点「看一看，退回去补…」打开步骤卡上同一个补料单弹窗（能改、能换退回目标），点「退回去补」才发——
 * 走 step-round.ts 同一条路：并入项目最新、写补料单、在那一步另开一轮、记轮次。发过的记在问答记录那一轮上，卡片每 10 秒看一次进度。
 */
export default function ReworkOrderCard({
  order,
  record,
  projectPath,
  onSent,
}: {
  order: ReworkOrder;
  record: DispatchRecord | null;
  projectPath: string | null;
  onSent: (record: DispatchRecord) => Promise<void>;
}) {
  const [steps, setSteps] = useState<ProjectStepDto[] | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [provides, setProvides] = useState<SkillProvides>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: DispatchTone } | null>(null);

  useEffect(() => {
    if (!projectPath) return;
    let stale = false;
    invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath })
      .then((read) => !stale && setSteps(read.config.steps))
      .catch(() => {});
    loadSkillProvides()
      .then((m) => !stale && setProvides(m))
      .catch(() => {});
    // 补完后能接着自动跟进的：保存过的步骤（按工作副本名认）
    invoke<WorkspaceDto[]>("list_workspaces")
      .then((list) => !stale && setSaved(new Set(list.filter((w) => w.mergedAt && w.status === "active").map((w) => w.name))))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [projectPath]);

  useEffect(() => {
    if (!record || !projectPath) return;
    let stale = false;
    const load = () =>
      void dispatchStatus(record, projectPath)
        .then((s) => !stale && setStatus(s))
        .catch(() => {});
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, [record, projectPath]);

  const target = steps?.[order.toStep - 1];
  const from = order.fromStep ? steps?.[order.fromStep - 1] : undefined;
  const lit = target ? Object.values(litKind(target, provides)).some(Boolean) : true;
  // 能退回的：「从」那一步之前开过工的步骤；没写「从」就是所有排得上的步骤
  const targets = steps ? reworkTargets(steps, order.fromStep ? order.fromStep - 1 : steps.length) : [];
  const word = lit ? "补" : "改";

  async function send(fields: ReworkFields) {
    if (!projectPath || !steps) return;
    const to = steps.find((s) => s.name === fields.target);
    if (!to) return;
    setBusy(true);
    setError(null);
    try {
      const rework = await sendReworkRound({
        projectPath,
        fromStep: from?.name ?? "项目助手",
        target: to,
        topics: fields.topics,
        reason: fields.reason,
        clues: fields.clues,
        scale: fields.scale,
        chain: fields.chain,
        reads: fields.reads,
        provides,
        launch: null,
        confirm: confirmDialog,
      });
      if (!rework) return;
      const ws = (await invoke<WorkspaceDto[]>("list_workspaces").catch(() => [] as WorkspaceDto[])).find(
        (w) => w.id === rework.toWorkspaceId,
      );
      await onSent({
        at: new Date().toISOString(),
        target: "step",
        step: steps.indexOf(to) + 1,
        title: `退回「${to.name}」：${fields.topics[0] ?? ""}`.slice(0, 80),
        mode: "resume",
        worktreePath: ws?.worktreePath ?? null,
        note: `在「${to.name}」另开了一轮，只${word}单上列的`,
      });
      setOpen(false);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-3 rounded-xl border border-hairline p-3" aria-label="补料单">
      <div className="mb-2 flex items-center gap-2 text-xs text-l3">
        <span className="h-[3px] w-2.5 shrink-0 rounded-sm bg-mesa-amber" aria-hidden="true" />
        <span className="font-medium text-l2">{lit ? "补料单" : "修改单"}</span>
        <span>
          · 退回到第 {order.toStep} 步{target ? `「${target.name}」` : ""}
          {from ? ` · 因为「${from.name}」` : ""}
        </span>
      </div>
      <div className="space-y-1.5 text-sm leading-6">
        <ul className="list-disc pl-5 text-l1">
          {order.topics.map((t) => (
            <li key={t} className="break-words">
              {t}
            </li>
          ))}
        </ul>
        <p className="break-words text-l2">
          <span className="text-l3">为什么：</span>
          {order.reason}
        </p>
        {order.clues && (
          <p className="whitespace-pre-wrap break-words text-l2">
            <span className="text-l3">线索：</span>
            {order.clues}
          </p>
        )}
        {lit && order.scale && <p className="text-xs text-l3">大致{word} {order.scale} 篇</p>}
      </div>
      {error && <p className="mt-2 break-words text-xs text-err-text">没发出去：{error}</p>}
      <div className="mt-3 flex min-w-0 items-center gap-2">
        {record ? (
          <div className="min-w-0 text-xs leading-5">
            <p className="text-l3">
              {relTime(record.at)}发出 · {record.note}
            </p>
            <p className={status ? TONE_CLASS[status.tone] : "text-l3"}>现在：{status?.text ?? "正在看…"}</p>
          </div>
        ) : (
          <>
            <button
              type="button"
              className={primaryActionClass}
              disabled={!steps || !target || targets.length === 0}
              onClick={() => setOpen(true)}
              title="打开补料单：能改每一栏、换退回到哪一步；点「退回去补」才发"
            >
              看一看，退回去{word}…
            </button>
            <span className="min-w-0 text-xs text-l4">
              {steps && !target ? "这个项目没有这一步了" : steps && targets.length === 0 ? "前面还没有开过工的步骤，退不回去" : "发之前会先把项目最新内容并进那一步"}
            </span>
          </>
        )}
      </div>
      {open && steps && target && (
        <ReworkDialog
          fromStep={from?.name ?? "项目助手"}
          targets={targets.map((s) => s.name)}
          searchTarget={targets.find((s) => litKind(s, provides).isSearch)?.name}
          notesTarget={targets.find((s) => litKind(s, provides).isNotes)?.name}
          chainOff={steps.filter((st) => chainDefaultOff(stepKind(st, provides))).map((st) => st.name)}
          chainOptions={Object.fromEntries(
            targets.map((t) => {
              const from = steps.indexOf(t);
              return [t.name, steps.filter((x, i) => i > from && !!x.workspaceName && saved.has(x.workspaceName)).map((x) => x.name)];
            }),
          )}
          initial={{
            target: target.name,
            topics: order.topics.join("\n"),
            reason: order.reason,
            clues: order.clues,
            scale: order.scale,
          }}
          busy={busy}
          error={error}
          onCancel={() => setOpen(false)}
          onSend={(fields) => void send(fields)}
        />
      )}
    </section>
  );
}
