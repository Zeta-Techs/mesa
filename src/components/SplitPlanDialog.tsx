import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { InlineNotice, primaryActionClass, quietActionClass, secondaryActionClass } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import { laneGoalText, laneWaits, parseSplitPlan, planIssues } from "../split-plan";
import { taskPathsForScope } from "../project-tasks";
import { goalDefaultProfile, resolveTaskModel } from "../project-agents";
import { goalRunTerminalFields, prepareGoalRun } from "../goal-run";
import { samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { useAppStore, type PendingTerminal } from "../store";
import { toast } from "../toast";
import type { ProjectConfigReadDto, ProjectDto, TaskDto } from "../types";

/** 交一个终端请求，等终端页收下（pendingTerminal 清空）再交下一个：一次开几路就是几个标签 */
async function openTerminalInTurn(req: PendingTerminal) {
  const store = useAppStore.getState();
  store.setPendingTerminal(req);
  const deadline = Date.now() + 15_000;
  while (useAppStore.getState().pendingTerminal && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * 拆分方案卡（2026-11-03 项目内协作三期）：协调对话写的 `.ccode/split-plan.md` 给人看——按什么拆、每路要做 / 读 / 交 / 写不写共享文件 / 预算，
 * 拦下的改了才能开，提醒的看情况；可以勾掉几路。「批准并开 N 路」= 每路记成一条目标（整个项目进隔离副本、验收后写回）并一起开工，
 * 用项目默认的 Agent。只有能记目标的项目（无流程科研、工作项目）能一次开；有流程的科研与编程照方案自己开。
 */
export default function SplitPlanDialog({
  projectPath,
  text,
  onClose,
  onDone,
}: {
  projectPath: string;
  text: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const plan = useMemo(() => parseSplitPlan(text), [text]);
  const issues = useMemo(() => planIssues(plan), [plan]);
  const blocks = issues.filter((i) => i.level === "block");
  const warns = issues.filter((i) => i.level === "warn");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(plan.lanes.map((l) => l.name)));
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setPage = useAppStore((s) => s.setPage);

  useEffect(() => {
    let stale = false;
    (async () => {
      const list = await invoke<ProjectDto[]>("list_projects").catch(() => [] as ProjectDto[]);
      const p = list.find((x) => samePath(x.path, projectPath, IS_WINDOWS)) ?? null;
      let ok = false;
      if (p?.workMode === "office") ok = true;
      else if (p?.workMode === "research") {
        const read = await invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath }).catch(() => null);
        ok = Boolean(read && read.config.steps.length === 0 && read.config.pipelineOptOut === true);
      }
      if (!stale) {
        setProject(p);
        setEligible(ok);
      }
    })();
    return () => {
      stale = true;
    };
  }, [projectPath]);

  async function decline() {
    if (!(await confirmDialog("不开这份方案？方案会移进 .ccode/split-plans/ 留底，可以让协调对话重写。", { confirmText: "不开" }))) return;
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
    const state = useAppStore.getState();
    // 事件里一次性读（不是选择器，不涉 store-selector-lint 的引用相等问题）
    const hidden = state.settings?.hiddenProfiles ?? [];
    const visible = state.profiles.filter((p) => !hidden.includes(p.id) || p.id === project.defaultProfiles?.[p.agent]);
    const profile = goalDefaultProfile(visible, project.defaultAgent, project.defaultProfiles);
    if (!profile) {
      setError("还没有可用连接，先到连接页配一个，或在项目的 Agent 分工里定默认。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const paths = taskPathsForScope("whole", [], "write_tree");
      const tasks: TaskDto[] = [];
      for (const lane of lanes) {
        tasks.push(
          await invoke<TaskDto>("task_create", {
            input: {
              projectRoot: projectPath,
              kind: project.workMode === "office" ? "office_doc" : "free_research",
              name: lane.name,
              description: laneGoalText(plan, lane),
              inputPaths: paths.inputPaths,
              outputPaths: paths.outputPaths,
              permission: "write_tree",
            },
          }),
        );
      }
      await invoke("split_plan_close", { projectRoot: projectPath, outcome: "approved" });
      // 要等别的几路做完的只记下、不开工（人等前面评审采纳后在项目里点开始；开工时整仓复制，就带上了前面的产物）
      const toStart = tasks.filter((_, i) => !laneWaits(lanes[i]));
      const parked = tasks.length - toStart.length;
      // 终端页先挂上，才收得下开工请求
      if (toStart.length > 0) setPage("terminal");
      let started = 0;
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
          await openTerminalInTurn({
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
          started += 1;
        } catch (reason) {
          toast(`「${task.name}」没开起来：${String(reason)}。目标已记下，可以在项目里点开始重试。`, "error");
        }
      }
      toast(
        `已按方案开了 ${started} 路${started < toStart.length ? `（${toStart.length - started} 路没开起来）` : ""}，做完各自进待验收。${
          parked ? `另有 ${parked} 路要等前面做完，已记成目标没开，前面验收后在项目里点「开始」。` : ""
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
      description="协调对话起草的方案。看清每一路做什么、写不写共享文件，勾掉不想开的；批准后每路记成一条目标，各自在隔离副本里做，验收后才写回项目。"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={quietActionClass} disabled={busy} onClick={() => void decline()}>
            不开
          </button>
          <button type="button" className={secondaryActionClass} disabled={busy} onClick={onClose}>
            先放着
          </button>
          <button
            type="button"
            className={primaryActionClass}
            disabled={busy || !eligible || blocks.length > 0 || chosen === 0}
            onClick={() => void approve()}
          >
            <span>
              {busy
                ? "开工中…"
                : chosenWaiting > 0
                  ? `批准：开 ${chosen - chosenWaiting} 路，记下 ${chosenWaiting} 路`
                  : `批准并开 ${chosen} 路`}
            </span>
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {error && <InlineNotice tone="err">{error}</InlineNotice>}
        {eligible === false && (
          <InlineNotice tone="warn">
            这个项目有研究流程或是编程项目，不能一次开几路目标；照方案在流程 / 编程页自己开，或点「不开」收起方案。
          </InlineNotice>
        )}
        {plan.basis && <p className="text-xs text-l2">按什么拆：{plan.basis}</p>}
        {plan.sharedFiles && <p className="text-xs text-l2">共享文件：{plan.sharedFiles}</p>}
        {blocks.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-err-text">拦下 {blocks.length} 条（回协调对话改了才能开）</p>
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
        {project && eligible && (
          <p className="text-xs text-l3">用项目默认的 Agent 开（{project.defaultAgent || "跟随全局默认"}）；要换在开之前去项目的 Agent 分工里改。</p>
        )}
      </div>
    </Modal>
  );
}
