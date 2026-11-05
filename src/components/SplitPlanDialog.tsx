import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { compactFieldClass, InlineNotice, inlineActionClass, primaryActionClass, quietActionClass, secondaryActionClass } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import { laneGoalText, laneWaits, parseSplitPlan, planIssues } from "../split-plan";
import { taskPathsForScope } from "../project-tasks";
import { resolveTaskModel } from "../project-agents";
import { goalRunTerminalFields, prepareGoalRun } from "../goal-run";
import { draftSplitPlan, projectDefaultProfile, replyNotice, splitEligibility } from "../split-draft";
import { useAppStore } from "../store";
import { openTerminalInTurn } from "../terminal-queue";
import { toast } from "../toast";
import { pushBatch, readBatches, writeBatches } from "../split-batch";
import type { ProjectDto, TaskDto } from "../types";

/**
 * 拆分方案卡（2026-11-03 项目内协作三期）：AI 写的 `.ccode/split-plan.md` 给人看——按什么拆、每路要做 / 读 / 交 / 写不写共享文件 / 预算，
 * 拦下的改了才能开，提醒的看情况；可以勾掉几路；不满意写一句「让它改」，AI 整份重写（同日起不再经协调对话，工作台无头调用一次）。
 * 「批准并开 N 路」= 每路记成一条目标（整个项目进隔离副本、验收后写回）并一起开工，用项目默认的 Agent。
 * 只有能记目标的项目（无流程科研、工作项目）能一次开；有流程的科研与编程照方案自己开。
 */
export default function SplitPlanDialog({
  projectPath,
  projectName,
  text,
  onClose,
  onRevised,
  onDone,
}: {
  projectPath: string;
  projectName: string;
  text: string;
  onClose: () => void;
  /** 「让它改」写好新方案后：外面重读，text 换成新的 */
  onRevised: () => Promise<void> | void;
  onDone: () => void;
}) {
  const plan = useMemo(() => parseSplitPlan(text), [text]);
  const issues = useMemo(() => planIssues(plan), [plan]);
  const blocks = issues.filter((i) => i.level === "block");
  const warns = issues.filter((i) => i.level === "warn");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(plan.lanes.map((l) => l.name)));
  // 让它改之后换了一版：勾选跟着新方案重来
  useEffect(() => setPicked(new Set(plan.lanes.map((l) => l.name))), [plan]);
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [revising, setRevising] = useState(false);
  const [reviseNote, setReviseNote] = useState<string | null>(null);
  const setPage = useAppStore((s) => s.setPage);

  useEffect(() => {
    let stale = false;
    void splitEligibility(projectPath).then((r) => {
      if (stale) return;
      setProject(r.project);
      setEligible(r.eligible);
    });
    return () => {
      stale = true;
    };
  }, [projectPath]);

  async function revise() {
    if (!feedback.trim()) return;
    setRevising(true);
    setReviseNote(null);
    try {
      const reply = await draftSplitPlan({
        projectPath,
        projectName,
        project,
        request: plan.title || "（见上一版方案）",
        previous: text,
        feedback,
      });
      const note = replyNotice(reply);
      if (note) setReviseNote(`${note}（上一版还在）`);
      else {
        setFeedback("");
        await onRevised();
      }
    } catch (reason) {
      setReviseNote(`没改成：${String(reason)}`);
    } finally {
      setRevising(false);
    }
  }

  async function decline() {
    if (!(await confirmDialog("不开这份方案？方案会移进 .ccode/split-plans/ 留底，之后可以在工作台重新「拆成几个目标同时做」。", { confirmText: "不开" }))) return;
    try {
      await invoke("split_plan_close", { projectRoot: projectPath, outcome: "declined" });
      onDone();
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function approve() {
    if (!project) return;
    const lanes = plan.lanes.filter((l) => picked.has(l.name));
    if (lanes.length === 0) return;
    const profile = projectDefaultProfile(project);
    if (!profile) {
      setError("还没有可用连接，先到连接页配一个，或在项目的 Agent 分工里定默认。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const paths = taskPathsForScope("whole", [], "write_tree");
      // 一路一路记；中途有一路记不下也接着记别的，只要记下了一路就把方案收进留底——
      // 不然人再点一次批准，前面记下的会重复一遍（2026-11-03 自查）
      const recorded: { task: TaskDto; waits: boolean }[] = [];
      const failed: string[] = [];
      for (const lane of lanes) {
        try {
          const task = await invoke<TaskDto>("task_create", {
            input: {
              projectRoot: projectPath,
              kind: project.workMode === "office" ? "office_doc" : "free_research",
              name: lane.name,
              description: laneGoalText(plan, lane),
              inputPaths: paths.inputPaths,
              outputPaths: paths.outputPaths,
              permission: "write_tree",
            },
          });
          recorded.push({ task, waits: laneWaits(lane) });
        } catch (reason) {
          failed.push(`${lane.name}（${String(reason)}）`);
        }
      }
      if (recorded.length === 0) throw new Error(`一个目标都没记下：${failed.join("；")}`);
      await invoke("split_plan_close", { projectRoot: projectPath, outcome: "approved" });
      if (failed.length) toast(`这几个没记下，方案已收进留底，要做就在项目里手动新建目标：${failed.join("；")}`, "error");
      const tasks = recorded.map((r) => r.task);
      // 要等别的几路做完的只记下、不开工（人等前面评审采纳后在项目里点开始；开工时整仓复制，就带上了前面的产物）
      const toStart = recorded.filter((r) => !r.waits).map((r) => r.task);
      const parked = tasks.length - toStart.length;
      // 终端页先挂上，才收得下开工请求
      if (toStart.length > 0) setPage("terminal");
      let started = 0;
      const startedIds = new Set<string>();
      for (const task of toStart) {
        try {
          const { run, prompt } = await prepareGoalRun({
            projectName: project.name,
            projectPath,
            workMode: project.workMode,
            task,
            agent: profile.agent,
            profileId: profile.id,
          });
          const taken = await openTerminalInTurn({
            extraEnv: {},
            title: task.name,
            agentId: profile.agent,
            profileId: profile.id,
            model: resolveTaskModel({
              models: profile.models,
              taskModel: task.model,
              profileId: profile.id,
              defaultProfileId: project.defaultProfiles?.[profile.agent],
              defaultModel: project.defaultModels?.[profile.agent],
            }),
            ...goalRunTerminalFields(task, run, prompt),
          });
          if (!taken) throw new Error("终端页没收下开工请求");
          started += 1;
          startedIds.add(task.id);
        } catch (reason) {
          toast(`「${task.name}」没开起来：${String(reason)}。目标已记下，可以在项目里点开始重试。`, "error");
        }
      }
      // 记下这一批，工作台「拆成几路做」那一行写进度、都收场时回报一次（split-batch.ts）
      if (started > 0) {
        writeBatches(
          projectPath,
          pushBatch(readBatches(projectPath), {
            id: crypto.randomUUID(),
            title: plan.title,
            createdAt: Date.now(),
            lanes: recorded.map((r) => ({ taskId: r.task.id, name: r.task.name, waits: r.waits, started: startedIds.has(r.task.id) })),
          }),
        );
      }
      toast(
        `已按方案开了 ${started} 个目标${started < toStart.length ? `（${toStart.length - started} 个没开起来）` : ""}，做完各自进待验收，都做完时工作台这一行会回报。${
          parked ? `另有 ${parked} 个要等前面做完，已记下没开，前面验收后在项目里点「开始」。` : ""
        }`,
        started || parked ? "success" : "error",
      );
      onDone();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const chosen = plan.lanes.filter((l) => picked.has(l.name)).length;
  const chosenWaiting = plan.lanes.filter((l) => picked.has(l.name) && laneWaits(l)).length;
  return (
    <Modal
      open
      size="lg"
      title={`拆分方案：${plan.title || "（没写标题）"}`}
      description="AI 起草的拆法：一件事拆成几个目标同时做。看清每个目标做什么、写不写共享文件，勾掉不想开的，不满意就在下面让它改；批准后每个都记成目标，各自在隔离副本里做，验收后才写回项目。"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={quietActionClass} disabled={busy || revising} onClick={() => void decline()}>
            不开
          </button>
          <button type="button" className={secondaryActionClass} disabled={busy} onClick={onClose}>
            先放着
          </button>
          <button
            type="button"
            className={primaryActionClass}
            disabled={busy || revising || !eligible || blocks.length > 0 || chosen === 0}
            onClick={() => void approve()}
          >
            <span>
              {busy
                ? "开工中…"
                : chosenWaiting > 0
                  ? `批准：开 ${chosen - chosenWaiting} 个，记下 ${chosenWaiting} 个`
                  : `批准并开 ${chosen} 个目标`}
            </span>
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {error && <InlineNotice tone="err">{error}</InlineNotice>}
        {eligible === false && (
          <InlineNotice tone="warn">
            这个项目有研究流程或是编程项目，不能一次开几个目标；照方案在流程 / 编程页自己开，或点「不开」收起方案。
          </InlineNotice>
        )}
        {plan.basis && <p className="text-xs text-l2">按什么拆：{plan.basis}</p>}
        {plan.sharedFiles && <p className="text-xs text-l2">共享文件：{plan.sharedFiles}</p>}
        {blocks.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-err-text">拦下 {blocks.length} 条（在下面让它改了才能开）</p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-l2">
              {blocks.map((b, i) => (
                <li key={i}>{b.lane ? `「${b.lane}」` : ""}{b.message}</li>
              ))}
            </ul>
          </div>
        )}
        {warns.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-warn-text">提醒 {warns.length} 条</p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-l3">
              {warns.map((w, i) => (
                <li key={i}>{w.lane ? `「${w.lane}」` : ""}{w.message}</li>
              ))}
            </ul>
          </div>
        )}
        <ul className="space-y-1.5">
          {plan.lanes.map((l) => (
            <li key={l.name} className="rounded-sm ccode-well p-2.5 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={picked.has(l.name)}
                  onChange={(e) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(l.name);
                      else next.delete(l.name);
                      return next;
                    })
                  }
                />
                <span className="text-sm font-medium text-l1">{l.name}</span>
                {l.budget && <span className="text-l3">· {l.budget}</span>}
              </label>
              <p className="mt-1 whitespace-pre-wrap text-l2">{l.todo || "（没写要做什么）"}</p>
              <p className="mt-0.5 text-l3">
                读：{l.reads || "—"} · 交：{l.delivers || "—"} · 写共享文件：{l.shared || "不写"}
              </p>
              {laneWaits(l) && <p className="mt-0.5 text-warn-text">等：{l.waits}——批准时只记下，前面做完再开</p>}
              {l.notes.map((n) => (
                <p key={n} className="mt-0.5 whitespace-pre-wrap text-l3">
                  {n}
                </p>
              ))}
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void revise();
          }}
        >
          <input
            className={`${compactFieldClass} min-w-0 flex-1`}
            placeholder="让它改：比如「批次三不用做」「汇总那个等前三个做完」"
            value={feedback}
            disabled={revising || busy}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <button type="submit" className={inlineActionClass} disabled={revising || busy || !feedback.trim()}>
            <span className="text-xs">{revising ? "AI 在改…" : "让它改"}</span>
          </button>
        </form>
        {reviseNote && <p className="text-xs text-l3">{reviseNote}</p>}
        {project && eligible && (
          <p className="text-xs text-l3">用项目默认的 Agent 开（{project.defaultAgent || "跟随全局默认"}）；要换在开之前去项目的 Agent 分工里改。</p>
        )}
      </div>
    </Modal>
  );
}
