import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  GitBranch,
  House,
  Search,
  Star,
  TriangleAlert,
} from "lucide-react";
import { selectHiddenProfiles, useAppStore } from "../store";
import { toast } from "../toast";
import {
  AGENTS,
  type AgentCapabilitiesDto,
  type CodingOverviewDto,
  type ComboSurfaceDto,
  type DetectResult,
  type ModelCapabilityDto,
  type ProjectDto,
  type ScheduleDto,
  type TaskDto,
} from "../types";
import { ghostActionClass, secondaryActionClass } from "./PageFrame";
import AgentIcon from "./AgentIcon";
import EffortMark from "./EffortMark";
import { effortDepth } from "../effort-depth";
import {
  PERMISSION_TIERS,
  PermissionGlyph,
  confirmPermissionChoice,
} from "./ChatPermissionBadge";
import { modelCapsLabel } from "../model-caps-label";
import { clipBounds, pickPopoverSide, popoverRoom } from "../popover-side";
import {
  buildProjectAgentRoster,
  currentProfileLine,
  normalizeBindingPermissionTier,
  projectAgentsEmptyWorkHint,
  projectAgentLaunch,
  resolveProfileModel,
  selectedProjectAgentProfile,
  READER_BINDING_SLOT,
  CHAT_BINDING_SLOT,
  DISCUSS_BINDING_SLOT,
  ASSISTANT_BINDING_SLOT,
  stepSlotKey,
  type BindingPermissionTier,
  type ProjectAgentBinding,
  type ProjectAgentProfile,
  type ProjectAgentRow,
} from "../project-agents";
import { declaredTaskKindsForMode, isDeclaredTask, taskStatusLabel } from "../project-tasks";
import { normalizeWorkMode } from "../work-mode";
import { schedulesForProject } from "../schedule-tasks";
import { IS_WINDOWS } from "../hotkeys";
import { confirmDialog, confirmDialogOpen } from "./ConfirmDialog";
import { headlessWriteBlocked } from "../agent-caps";
import { isLitWatchSkill } from "../schedule-skill";
import { usePolling } from "../polling";

const EMPTY_AGENTS: DetectResult[] = [];

export default function ProjectAgentsView({
  project,
  onProjectChanged,
  onOpenGoals,
  onError,
}: {
  project: ProjectDto;
  onProjectChanged: (project: ProjectDto) => void;
  onOpenGoals?: () => void;
  onError: (message: string) => void;
}) {
  const profiles = useAppStore((state) => state.profiles);
  const agents = useAppStore((state) => state.agents ?? EMPTY_AGENTS);
  const hiddenProfiles = useAppStore(selectHiddenProfiles);
  const setPage = useAppStore((state) => state.setPage);
  const [saving, setSaving] = useState(false);
  const [defaultAgent, setDefaultAgent] = useState(project.defaultAgent ?? "");
  const [defaultProfiles, setDefaultProfiles] = useState<Record<string, string>>(
    project.defaultProfiles ?? {},
  );
  const [defaultModels, setDefaultModels] = useState<Record<string, string>>(
    project.defaultModels ?? {},
  );
  const [taskBindings, setTaskBindings] = useState<NonNullable<ProjectDto["taskBindings"]>>(
    project.taskBindings ?? {},
  );
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [schedules, setSchedules] = useState<ScheduleDto[]>([]);
  const [worktrees, setWorktrees] = useState<
    { key: string; label: string; isPrimary: boolean }[]
  >([]);
  const [scheduleCaps, setScheduleCaps] = useState<Record<string, AgentCapabilitiesDto>>({});

  useEffect(() => {
    setDefaultAgent(project.defaultAgent ?? "");
    setDefaultProfiles(project.defaultProfiles ?? {});
    setDefaultModels(project.defaultModels ?? {});
    setTaskBindings(project.taskBindings ?? {});
  }, [project.defaultAgent, project.defaultModels, project.defaultProfiles, project.taskBindings]);

  const taskKinds = useMemo(
    () => declaredTaskKindsForMode(project.workMode),
    [project.workMode],
  );

  const loadTasks = useCallback(async () => {
    if (taskKinds.size === 0) {
      setTasks([]);
      return;
    }
    try {
      const next = await invoke<TaskDto[]>("task_list", { projectRoot: project.path });
      setTasks(next);
    } catch (reason) {
      onError(`读取目标失败：${String(reason)}`);
    }
  }, [onError, project.path, taskKinds]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks, taskKinds]);
  usePolling(() => loadTasks(), taskKinds.size === 0 ? null : 2500);

  useEffect(() => {
    let cancelled = false;
    invoke<ScheduleDto[]>("list_schedules")
      .then((list) => {
        if (!cancelled) setSchedules(schedulesForProject(list, project.path, IS_WINDOWS));
      })
      .catch(() => {
        if (!cancelled) setSchedules([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project.path]);

  useEffect(() => {
    if (normalizeWorkMode(project.workMode) !== "coding") {
      setWorktrees([]);
      return;
    }
    let cancelled = false;
    invoke<CodingOverviewDto>("coding_overview", { repoPath: project.path })
      .then((overview) => {
        if (cancelled) return;
        setWorktrees(
          (overview.worktrees ?? []).map((tree) => ({
            key: tree.path,
            label: tree.isPrimary ? "主仓" : tree.branch || tree.path,
            isPrimary: Boolean(tree.isPrimary),
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setWorktrees([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project.path, project.workMode]);

  useEffect(() => {
    let cancelled = false;
    invoke<AgentCapabilitiesDto[]>("agent_capabilities")
      .then((list) => {
        if (!cancelled) {
          setScheduleCaps(Object.fromEntries(list.map((item) => [item.agent, item])));
        }
      })
      .catch(() => {
        if (!cancelled) setScheduleCaps({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const roster = useMemo(
    () =>
      buildProjectAgentRoster({
        catalog: AGENTS,
        profiles,
        hiddenProfileIds: hiddenProfiles,
        defaultAgent,
        defaultProfiles,
        defaultModels,
        tasks,
        taskKinds,
        workMode: project.workMode,
      }),
    [defaultAgent, defaultModels, defaultProfiles, hiddenProfiles, profiles, project.workMode, taskKinds, tasks],
  );

  async function saveAgent(agent: string) {
    setSaving(true);
    try {
      await invoke("set_project_default_agent", {
        projectRoot: project.path,
        agent: agent || null,
      });
      setDefaultAgent(agent);
      onProjectChanged({
        ...project,
        defaultAgent: agent || null,
        defaultProfiles,
        defaultModels,
      });
    } catch (reason) {
      onError(`保存项目默认 Agent 失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveProfile(agent: string, profileId: string, modelId: string) {
    if (!agent) return;
    setSaving(true);
    const next = { ...defaultProfiles };
    if (profileId) next[agent] = profileId;
    else delete next[agent];
    const nextModels = { ...defaultModels };
    if (profileId && modelId) nextModels[agent] = modelId;
    else delete nextModels[agent];
    try {
      await invoke("set_project_default_profile", {
        projectRoot: project.path,
        agent,
        profileId: profileId || null,
        model: modelId || null,
      });
      setDefaultProfiles(next);
      setDefaultModels(nextModels);
      onProjectChanged({
        ...project,
        defaultAgent: defaultAgent || null,
        defaultProfiles: next,
        defaultModels: nextModels,
      });
    } catch (reason) {
      onError(`保存默认配置失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  }

  /** 槽位专属绑定：某个固定用途不吃项目默认，单独指一条连接+模型，并可预设思考强度与权限档位（agent 跟着连接走）。
      槽位清单与后端 PROJECT_AGENT_BINDING_SLOTS 同源 */
  async function saveSlotBinding(
    slot: string,
    profileId: string,
    modelId: string,
    effort?: string | null,
    permissionTier?: BindingPermissionTier | null,
  ) {
    const cleanEffort = profileId ? (effort?.trim() || null) : null;
    const cleanPerm = profileId ? (normalizeBindingPermissionTier(permissionTier) ?? null) : null;
    setSaving(true);
    try {
      await invoke("set_project_agent_binding", {
        projectRoot: project.path,
        slot,
        profileId: profileId || null,
        model: modelId || null,
        effort: cleanEffort,
        permissionTier: cleanPerm,
      });
      const next = { ...taskBindings };
      if (profileId) {
        next[slot] = {
          profile: profileId,
          model: modelId || null,
          ...(cleanEffort ? { effort: cleanEffort } : {}),
          ...(cleanPerm ? { permissionTier: cleanPerm } : {}),
        };
      } else {
        delete next[slot];
      }
      setTaskBindings(next);
      onProjectChanged({ ...project, taskBindings: next });
      // 生效时机披露（用户自然预期「切换立即生效」，实际在跑会话沿用原 Agent、
      // 下次开工/继续才用新值）：保存回执带一句，免得自己去发现
      if (slot.startsWith("step:")) {
        toast(
          profileId
            ? "已存为本步骤默认：正在跑的会话不受影响，下次开工 / 继续生效"
            : "已清除本步骤默认：这一步回到跟随项目默认（下次启动生效）",
        );
      }
    } catch (reason) {
      onError(`保存专属绑定失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  }

  const scheduleProfiles = useMemo(() => {
    const bound = new Set(
      schedules.map((item) => item.profileId).filter((id): id is string => Boolean(id)),
    );
    return profiles
      .filter((profile) => !hiddenProfiles.includes(profile.id) || bound.has(profile.id))
      .filter(
        (profile) =>
          !headlessWriteBlocked(scheduleCaps[profile.agent]?.headlessWrite) ||
          bound.has(profile.id),
      );
  }, [hiddenProfiles, profiles, scheduleCaps, schedules]);

  async function reloadSchedules() {
    const list = await invoke<ScheduleDto[]>("list_schedules");
    setSchedules(schedulesForProject(list, project.path, IS_WINDOWS));
  }

  /** 定时任务各自一条连接，写回 schedules.json，不进项目槽位。 */
  async function saveScheduleLaunch(item: ScheduleDto, profileId: string, modelId: string) {
    const picked = profiles.find((profile) => profile.id === profileId);
    if (picked) {
      const blocked = headlessWriteBlocked(scheduleCaps[picked.agent]?.headlessWrite);
      if (blocked) {
        onError(blocked);
        return;
      }
    }
    setSaving(true);
    try {
      await invoke("update_schedule", {
        id: item.id,
        patch: { profileId, model: modelId },
      });
      if (profileId && !isLitWatchSkill(item.skill)) {
        try {
          await invoke("ensure_schedule_skill_distributed", {
            skill: item.skill,
            profileId,
          });
        } catch (reason) {
          await reloadSchedules();
          onError(`运行配置已保存，但技能分发失败：${String(reason)}`);
          return;
        }
      }
      await reloadSchedules();
    } catch (reason) {
      onError(`保存定时任务配置失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveGoalLaunch(goal: TaskDto, profileId: string, modelId: string) {
    const agent = profileId
      ? (profiles.find((item) => item.id === profileId)?.agent ?? "")
      : "";
    setSaving(true);
    try {
      await invoke("task_set_launch", {
        id: goal.id,
        agent: agent || null,
        profileId: profileId || null,
        model: modelId || null,
      });
      await loadTasks();
    } catch (reason) {
      onError(String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function clearAllBindings() {
    const slots = Object.keys(taskBindings).filter(
      (slot) =>
        slot === CHAT_BINDING_SLOT ||
        slot === DISCUSS_BINDING_SLOT ||
        slot === ASSISTANT_BINDING_SLOT ||
        slot === READER_BINDING_SLOT ||
        slot.startsWith("step:"),
    );
    if (slots.length === 0) return;
    const ok = await confirmDialog(
      "专属绑定和科研步骤上单独指定的连接都会清掉，之后都跟随项目默认。定时任务不变。",
      { confirmText: "全部跟随默认" },
    );
    if (!ok) return;
    setSaving(true);
    try {
      for (const slot of slots) {
        await invoke("set_project_agent_binding", {
          projectRoot: project.path,
          slot,
          profileId: null,
          model: null,
          effort: null,
          permissionTier: null,
        });
      }
      const next = { ...taskBindings };
      for (const slot of slots) delete next[slot];
      setTaskBindings(next);
      onProjectChanged({ ...project, taskBindings: next });
    } catch (reason) {
      onError(`清除专属绑定失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  }

  const readerBinding = taskBindings[READER_BINDING_SLOT];
  const chatBinding = taskBindings[CHAT_BINDING_SLOT];
  const discussBinding = taskBindings[DISCUSS_BINDING_SLOT];
  const assistantBinding = taskBindings[ASSISTANT_BINDING_SLOT];

  const readerSlotProfiles = useMemo(
    () => profiles.filter((p) => !hiddenProfiles.includes(p.id) || p.id === readerBinding?.profile),
    [profiles, hiddenProfiles, readerBinding?.profile],
  );
  const chatSlotProfiles = useMemo(
    () => profiles.filter((p) => !hiddenProfiles.includes(p.id) || p.id === chatBinding?.profile),
    [profiles, hiddenProfiles, chatBinding?.profile],
  );
  const assistantSlotProfiles = useMemo(
    () => profiles.filter((p) => !hiddenProfiles.includes(p.id) || p.id === assistantBinding?.profile),
    [profiles, hiddenProfiles, assistantBinding?.profile],
  );
  const discussSlotProfiles = useMemo(
    () => profiles.filter((p) => !hiddenProfiles.includes(p.id) || p.id === discussBinding?.profile),
    [profiles, hiddenProfiles, discussBinding?.profile],
  );

  // 流程步骤清单（步骤组数据源）：步骤在 project.toml，ProjectDto 不带——挂载读一次，
  // 读不到/无步骤不渲染步骤组（专属绑定区只留固定用途）。步骤组展开态组件内不持久化
  const [pipelineSteps, setPipelineSteps] = useState<
    { name: string; skills: string[] }[] | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    invoke<{ config: { steps: { name: string; skills?: string[] }[] } }>("read_project_config", {
      path: project.path,
    })
      .then((read) => {
        if (!cancelled) setPipelineSteps(read.config.steps.map((x) => ({ name: x.name, skills: x.skills ?? [] })));
      })
      .catch(() => {
        if (!cancelled) setPipelineSteps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project.path]);

  /** 步骤槽行数据：cfg 步骤逐行 + 悬空坏行（槽在、步骤已删/改名）。无步骤但有
   *  step:* 槽时组仍出现只列坏行（可清）；摘要含失效计数，常显组头 */
  const stepRows = useMemo(() => {
    const rows: { slot: string; stepName: string; skills: string[]; stale: boolean }[] = [];
    const loaded = pipelineSteps !== null; // null=加载中/读失败：不做 stale 判定（防误标）
    const names = new Set((pipelineSteps ?? []).map((x) => x.name));
    for (const st of pipelineSteps ?? []) {
      rows.push({
        slot: stepSlotKey(st.name),
        stepName: st.name,
        skills: st.skills,
        stale: false,
      });
    }
    if (loaded) {
      for (const slot of Object.keys(taskBindings)) {
        if (slot.startsWith("step:") && !names.has(slot.slice("step:".length))) {
          rows.push({
            slot,
            stepName: slot.slice("step:".length),
            skills: [],
            stale: true,
          });
        }
      }
    }
    return rows;
  }, [pipelineSteps, taskBindings]);
  const boundStepCount = stepRows.filter(
    (r) => !r.stale && taskBindings[r.slot],
  ).length;
  const staleStepCount = stepRows.filter((r) => r.stale).length;
  const workMode = normalizeWorkMode(project.workMode);
  const showStepGroup =
    workMode === "research" &&
    ((pipelineSteps ?? []).length > 0 || staleStepCount > 0);
  const goals = tasks.filter(
    (task) => !task.archivedAt && taskKinds.has(task.kind) && isDeclaredTask(task),
  );
  const showGoals =
    workMode === "office" ||
    (workMode === "research" &&
      (goals.length > 0 || (pipelineSteps !== null && pipelineSteps.length === 0)));
  const hasExclusiveBinding = Object.keys(taskBindings).some(
    (slot) =>
      slot === CHAT_BINDING_SLOT ||
      slot === DISCUSS_BINDING_SLOT ||
      slot === ASSISTANT_BINDING_SLOT ||
      slot === READER_BINDING_SLOT ||
      slot.startsWith("step:"),
  );
  const inherited = useMemo(() => {
    const launch = projectAgentLaunch(profiles, defaultAgent, defaultProfiles, defaultModels);
    // 没设项目默认时如实说「开始时再选」（2026-11-05 用户：满屏「跟随项目默认」看不出到底用谁）；
    // 设了就写出它解析到的那家，「跟随项目默认」只在第二行说一次，卡片右上角不再另挂标签
    if (!launch) {
      return {
        agentId: null as string | null,
        profileId: null as string | null,
        line: "还没设项目默认",
        detail: "开始或开对话时再选",
      };
    }
    const agentLabel = AGENTS.find((agent) => agent.id === launch.agentId)?.label ?? launch.agentId;
    const profile = profiles.find((item) => item.id === launch.profileId);
    return {
      agentId: launch.agentId,
      profileId: launch.profileId,
      line: `${agentLabel} · ${profile?.name ?? "连接"}`,
      detail: `${launch.model || "CLI 默认"} · 跟随项目默认`,
    };
  }, [defaultAgent, defaultModels, defaultProfiles, profiles]);

  /** 没钉连接的定时任务实际会用什么（与后端 scheduler::pick_project_default 同口径，
   *  2026-10-17）：项目默认那家能无头写盘就跟随项目默认；不能、或项目没设默认，
   *  运行时回落设置页 AI 专用配置 / 最近用过的连接。 */
  const scheduleFallback = useMemo(() => {
    const launch = projectAgentLaunch(profiles, defaultAgent, defaultProfiles, defaultModels);
    if (!launch) {
      return {
        agentId: null as string | null,
        tag: "自动",
        line: "运行时再决定",
        detail: "设置页 AI 专用配置，或最近用过的连接",
        option: "自动",
      };
    }
    if (headlessWriteBlocked(scheduleCaps[launch.agentId]?.headlessWrite)) {
      return {
        agentId: null as string | null,
        tag: "自动",
        line: "项目默认不能用于定时任务",
        detail: "运行时改用设置页 AI 专用配置或最近用过的连接",
        option: "自动",
      };
    }
    return {
      agentId: inherited.agentId,
      tag: "",
      line: inherited.line,
      detail: inherited.detail,
      option: "项目默认",
    };
  }, [defaultAgent, defaultModels, defaultProfiles, profiles, scheduleCaps, inherited]);

  /** 步骤槽与声明目标可选连接（停用尊重 + 绑定项保留） */
  const stepSlotProfiles = useMemo(() => {
    const boundIds = new Set(
      [
        ...stepRows.map((r) => taskBindings[r.slot]?.profile),
        ...goals.map((goal) => goal.profileId),
      ].filter((id): id is string => Boolean(id)),
    );
    return profiles.filter((p) => !hiddenProfiles.includes(p.id) || boundIds.has(p.id));
  }, [goals, profiles, hiddenProfiles, stepRows, taskBindings]);

  const defaultRow = useMemo(
    () => roster.rows.find((row) => row.isProjectDefault) ?? null,
    [roster.rows],
  );
  const otherRows = useMemo(() => {
    const priorityOrder = ["claude-code", "codex", "kimi", "agy", "gemini"];
    const rankOf = (row: (typeof roster.rows)[number]) => {
      if (row.works.length > 0 || Boolean(defaultProfiles[row.agentId])) return -10;
      const p = priorityOrder.indexOf(row.agentId);
      return p >= 0 ? p : 100;
    };
    return roster.rows
      .filter((row) => !row.isProjectDefault)
      .slice()
      .sort((a, b) => rankOf(a) - rankOf(b));
  }, [defaultProfiles, roster.rows]);
  // 候选 ≤5 家时单行胶囊即可放下（省去「更多 1 家」伪收纳）；>5 家时只露前 4 家常用 CLI，其余收进「更多 N 家」浮层
  const inlineOtherRows = useMemo(
    () => (otherRows.length <= 5 ? otherRows : otherRows.slice(0, 4)),
    [otherRows],
  );
  const overflowOtherRows = useMemo(
    () => (otherRows.length <= 5 ? [] : otherRows.slice(4)),
    [otherRows],
  );
  const defaultSelectedProfile = defaultRow
    ? selectedProjectAgentProfile(defaultRow)
    : undefined;
  const rowsWithWorks = useMemo(
    () => roster.rows.filter((row) => row.works.length > 0),
    [roster.rows],
  );

  return (
    <section aria-label="本项目用哪家 Agent">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-l1">本项目用哪家 Agent</h2>
      </div>
      {roster.rows.length === 0 ? (
        <div className="ccode-well flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-4 text-xs">
          <p className="text-l3">
            还没有可用连接。
            <button
              type="button"
              className="ml-1 text-l2 underline-offset-2 hover:text-l1 hover:underline"
              onClick={() => setPage("profiles")}
            >
              去连接页
            </button>
          </p>
          <button
            type="button"
            aria-label="管理连接"
            className={`${ghostActionClass} shrink-0 gap-1`}
            onClick={() => setPage("profiles")}
          >
            连接页
            <ArrowUpRight size={13} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div
          aria-label="项目 Agent 名册"
          className={`ccode-well rounded-xl p-4 ${
            defaultRow ? "ring-1 ring-cta-bd/35" : ""
          }`}
        >
          {defaultRow ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <AgentIcon agent={defaultRow.agentId} label={defaultRow.label} size={16} className="mt-1" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-l1">
                      {defaultRow.label}
                    </h3>
                    <button
                      type="button"
                      disabled={saving}
                      aria-pressed={true}
                      aria-label={`取消 ${defaultRow.label} 的项目默认`}
                      title="取消本项目默认，不改 Mesa 启动栏或 CLI 全局配置"
                      onClick={() => void saveAgent("")}
                      className="ccode-bound-pill inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-micro font-medium transition-opacity hover:opacity-85 disabled:opacity-50"
                    >
                      <Star size={11} fill="currentColor" aria-hidden="true" />
                      项目默认
                    </button>
                    {defaultSelectedProfile ? (
                      <span className="min-w-0 truncate font-mono text-xs text-l2">
                        {defaultSelectedProfile.name} / {defaultSelectedProfile.model}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={ghostActionClass}
                        onClick={() => setPage("profiles")}
                      >
                        还没有连接
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {defaultRow.profiles.length > 0 && (
                  <DefaultModelMenu
                    row={defaultRow}
                    disabled={saving}
                    onPick={(profileId, modelId) =>
                      void saveProfile(defaultRow.agentId, profileId, modelId)
                    }
                    onAdd={() => setPage("profiles")}
                  />
                )}
                <button
                  type="button"
                  aria-label="管理连接"
                  className={`${ghostActionClass} shrink-0 gap-1`}
                  onClick={() => setPage("profiles")}
                >
                  连接页
                  <ArrowUpRight size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-l1">
                  还没设默认：点「开始」或开对话时再选
                </p>
                <p className="mt-1 text-xs text-l3">
                  点下方任一家设为本项目默认，项目的对话、步骤与未单独指定的入口都用它。
                </p>
              </div>
              <button
                type="button"
                aria-label="管理连接"
                className={`${ghostActionClass} shrink-0 gap-1`}
                onClick={() => setPage("profiles")}
              >
                连接页
                <ArrowUpRight size={13} aria-hidden="true" />
              </button>
            </div>
          )}

          {otherRows.length > 0 && (
            <div className="mt-3 flex items-start gap-2 border-t border-hairline pt-2.5">
              <span className="shrink-0 leading-7 text-xs text-l3">
                {defaultRow ? "切换默认到：" : "设为默认："}
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {inlineOtherRows.map((row) => {
                  const picked = selectedProjectAgentProfile(row);
                  return (
                    <button
                      key={row.agentId}
                      type="button"
                      disabled={saving}
                      aria-pressed={false}
                      aria-label={`将 ${row.label} 设为项目默认`}
                      title={
                        picked
                          ? `${row.label}（${picked.name} / ${picked.model}）— 点击设为本项目默认`
                          : `${row.label}（还没有连接）— 点击设为本项目默认`
                      }
                      onClick={() => void saveAgent(row.agentId)}
                      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-inset/80 px-2.5 text-xs font-medium text-l2 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50"
                    >
                      <AgentIcon agent={row.agentId} label={row.label} size={12} />
                      <span className="truncate">{row.label}</span>
                      {!picked && (
                        <span className="font-normal text-micro text-l4">· 还没有连接</span>
                      )}
                    </button>
                  );
                })}
                {overflowOtherRows.length > 0 && (
                  <MoreAgentsMenu
                    rows={overflowOtherRows}
                    disabled={saving}
                    onPick={(agentId) => void saveAgent(agentId)}
                  />
                )}
              </div>
            </div>
          )}

          {rowsWithWorks.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-hairline pt-2.5">
              {rowsWithWorks.flatMap((row) =>
                row.works.map((work) => (
                  <li key={work.id} className="flex min-w-0 items-center gap-2 text-xs">
                    <AgentIcon agent={row.agentId} label={row.label} size={12} />
                    <span className="shrink-0 text-micro text-l4">{row.label}</span>
                    {onOpenGoals ? (
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-l2 hover:text-l1"
                        onClick={onOpenGoals}
                      >
                        {work.name}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-l2">{work.name}</span>
                    )}
                    <span className="shrink-0 text-micro text-l4">{work.statusLabel}</span>
                  </li>
                )),
              )}
            </ul>
          )}
        </div>
      )}

      <div className="mt-8">
        <div className="mb-4 flex items-start justify-between gap-3">
          <SectionHeading title="专属绑定" hint="留空跟随项目默认；可一并预设思考强度与权限。" />
          <button
            type="button"
            className={`${ghostActionClass} shrink-0`}
            disabled={saving || !hasExclusiveBinding}
            onClick={() => void clearAllBindings()}
          >
            全部跟随项目默认
          </button>
        </div>
        <ul className="grid grid-cols-1 items-start gap-2 md:grid-cols-2">
          <SlotCard
            label="项目对话"
            tag={chatBinding ? "已指定" : ""}
            marked={Boolean(chatBinding)}
            binding={chatBinding}
            unboundAgentId={inherited.agentId}
            unboundProfileId={inherited.profileId}
            unboundLine={inherited.line}
            unboundDetail={inherited.detail}
            eligibleProfiles={chatSlotProfiles}
            agents={agents}
            defaultProfiles={defaultProfiles}
            presetMode="chat"
            disabled={saving}
            onPick={(pid, mid, eff, perm) => void saveSlotBinding(CHAT_BINDING_SLOT, pid, mid, eff, perm)}
            onClear={() => void saveSlotBinding(CHAT_BINDING_SLOT, "", "")}
            onAdd={() => setPage("profiles")}
          />
          <SlotCard
            label={workMode === "research" ? "问 AI / 聊想法" : "问 AI"}
            tag={discussBinding ? "已指定" : ""}
            marked={Boolean(discussBinding)}
            binding={discussBinding}
            unboundAgentId={inherited.agentId}
            unboundProfileId={inherited.profileId}
            unboundLine={inherited.line}
            unboundDetail={inherited.detail}
            eligibleProfiles={discussSlotProfiles}
            agents={agents}
            defaultProfiles={defaultProfiles}
            presetMode="discuss"
            disabled={saving}
            onPick={(pid, mid, eff) => void saveSlotBinding(DISCUSS_BINDING_SLOT, pid, mid, eff, null)}
            onClear={() => void saveSlotBinding(DISCUSS_BINDING_SLOT, "", "")}
            onAdd={() => setPage("profiles")}
          />
          <SlotCard
            label="项目助手"
            tag={assistantBinding ? "已指定" : ""}
            marked={Boolean(assistantBinding)}
            binding={assistantBinding}
            unboundAgentId={inherited.agentId}
            unboundProfileId={inherited.profileId}
            unboundLine={inherited.line}
            unboundDetail={inherited.detail}
            eligibleProfiles={assistantSlotProfiles}
            agents={agents}
            defaultProfiles={defaultProfiles}
            presetMode="assistant"
            note="推荐使用 Claude Code / Codex：查错时可以打开项目文件核对"
            disabled={saving}
            onPick={(pid, mid) => void saveSlotBinding(ASSISTANT_BINDING_SLOT, pid, mid)}
            onClear={() => void saveSlotBinding(ASSISTANT_BINDING_SLOT, "", "")}
            onAdd={() => setPage("profiles")}
          />
          {workMode === "research" && (
            <SlotCard
              label="沉浸阅读对话"
              tag={readerBinding ? "已指定" : ""}
              marked={Boolean(readerBinding)}
              binding={readerBinding}
              unboundAgentId={inherited.agentId}
              unboundProfileId={inherited.profileId}
              unboundLine={inherited.line}
              unboundDetail={inherited.detail}
              eligibleProfiles={readerSlotProfiles}
              agents={agents}
              defaultProfiles={defaultProfiles}
              presetMode="chat"
              disabled={saving}
              onPick={(pid, mid, eff, perm) => void saveSlotBinding(READER_BINDING_SLOT, pid, mid, eff, perm)}
              onClear={() => void saveSlotBinding(READER_BINDING_SLOT, "", "")}
              onAdd={() => setPage("profiles")}
            />
          )}
        </ul>
      </div>
      {workMode !== "research" &&
        Object.keys(taskBindings).some(
          (slot) => slot === READER_BINDING_SLOT || slot.startsWith("step:"),
        ) && (
        <div className="mt-8">
          <div className="mb-4">
            <SectionHeading
              title="遗留绑定（仅清理）"
              hint="这些槽只对科研流程生效，本项目用不到——是以前存下的，清掉即可。"
            />
          </div>
          <ul className="space-y-2">
            {Object.keys(taskBindings)
              .filter((slot) => slot === READER_BINDING_SLOT || slot.startsWith("step:"))
              .map((slot) => (
                <li
                  key={slot}
                  className="flex min-w-0 items-center gap-2 rounded-lg ccode-well p-3"
                >
                  <TriangleAlert
                    size={14}
                    strokeWidth={1.8}
                    aria-hidden="true"
                    className="shrink-0 text-warn-text"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-l2">
                    {slot === READER_BINDING_SLOT
                      ? "沉浸阅读对话"
                      : `步骤 · ${slot.slice("step:".length)}`}
                  </span>
                  <button
                    type="button"
                    className={`${ghostActionClass} shrink-0`}
                    disabled={saving}
                    onClick={() => void saveSlotBinding(slot, "", "")}
                  >
                    清除
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
      {schedules.length > 0 && (
        <div className="mt-8">
          <div className="mb-4">
            <SectionHeading
              title="定时任务"
              hint="每条任务可以单独指定连接；不指定就跟随项目默认。和定时任务页改的是同一份。"
            />
          </div>
          <ul className="grid grid-cols-1 items-start gap-2 md:grid-cols-2">
            {schedules.map((item) => {
              // W2b 读侧坏行：钉住的连接已删——执行侧 fail-loud（留失败 Run），界面
              // 如实标失效给重绑入口，不再显示拍平清单第一条当「已指定」
              const schedStale =
                Boolean(item.profileId) &&
                !profiles.some((p) => p.id === item.profileId);
              return (
              <SlotCard
                key={item.id}
                label={item.name}
                tag={!item.enabled
                  // 与定时任务页同口径（ScheduleSection）：连续失败被系统停下才叫「已自动暂停」，人手关的叫「已停用」
                  ? item.pausedReason ? "已自动暂停" : "已停用"
                  : schedStale
                    ? "已失效"
                    : item.profileId
                      ? "已指定"
                      : scheduleFallback.tag}
                marked={Boolean(item.profileId) && item.enabled && !schedStale}
                stale={schedStale}
                binding={
                  item.profileId && !schedStale
                    ? { profile: item.profileId, model: item.model }
                    : undefined
                }
                unboundAgentId={schedStale ? null : scheduleFallback.agentId}
                unboundProfileId={schedStale ? null : inherited.profileId}
                unboundLine={schedStale ? "连接已删除，下次运行会失败；可换绑或改回跟随项目默认" : scheduleFallback.line}
                unboundDetail={schedStale ? "" : scheduleFallback.detail}
                defaultOptionLabel={scheduleFallback.option}
                eligibleProfiles={scheduleProfiles}
                agents={agents}
                defaultProfiles={defaultProfiles}
                presetMode="none"
                disabled={saving || scheduleProfiles.length === 0}
                onPick={(pid, mid) => void saveScheduleLaunch(item, pid, mid)}
                onClear={() => void saveScheduleLaunch(item, "", "")}
                onAdd={() => setPage("profiles")}
              />
            ) })}
          </ul>
        </div>
      )}
      {workMode === "coding" && (
        <div className="mt-8">
          <SectionHeading
            title="开工"
            hint="从工作树开工用上面的项目默认。不给每棵工作树单独绑 Agent。"
          />
          {worktrees.length > 0 && (
            <ul className="grid grid-cols-1 items-start gap-2 md:grid-cols-2">
              {worktrees.map((tree) => (
                <li key={tree.key} className="min-w-0 rounded-lg ccode-well p-3">
                  <div className="flex items-center gap-2">
                    {/* 与专属绑定 SlotCard 同一符号语言（2026-10-16 用户拍板弃 emoji 换专业线条）：
                        主仓=House（项目之家）、工作树=GitBranch（分支） */}
                    <span aria-hidden="true" className="shrink-0 text-l3">
                      {tree.isPrimary ? (
                        <House size={14} strokeWidth={1.8} />
                      ) : (
                        <GitBranch size={14} strokeWidth={1.8} />
                      )}
                    </span>
                    <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-l1">{tree.label}</h3>
                    <span className="shrink-0 text-xs text-l4">项目默认</span>
                  </div>
                  <p className="mt-2 truncate px-2 text-xs font-medium text-l2">{inherited.line}</p>
                  {inherited.detail && (
                    <p className="truncate px-2 text-xs text-l3">{inherited.detail}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {showGoals && (
        <div className="mt-8">
          <div className="mb-4">
            <SectionHeading
              title={
                workMode === "office"
                  ? "工作目标"
                  : (pipelineSteps ?? []).length > 0
                    ? "目标"
                    : "新建目标"
              }
              hint={
                workMode === "office"
                  ? "新建时用上面的项目默认。这里可以改这一条，不影响别的目标。"
                  : (pipelineSteps ?? []).length > 0
                    ? "科研步骤之外另建的目标。每条自己的连接，这里可以改。"
                    : "没有研究流程。新建时用上面的项目默认；这里可以改这一条。"
              }
            />
          </div>
          {goals.length > 0 && (
            <ul className="grid grid-cols-1 items-start gap-2 md:grid-cols-2">
              {goals.map((goal) => {
                // W2a 读侧坏行：目标钉住的连接已删——如实标「已失效」（可清除/换绑），
                // 不再把拍平清单第一条当「已指定」的伪当前（运行侧早已 fail-loud）
                const goalStale =
                  Boolean(goal.profileId) &&
                  !profiles.some((p) => p.id === goal.profileId);
                return (
                <SlotCard
                  key={goal.id}
                  label={goal.name}
                  tag={goalStale ? "已失效" : goal.agent || goal.profileId ? taskStatusLabel(goal.status) : "项目默认"}
                  marked={Boolean(goal.profileId) && !goalStale}
                  stale={goalStale}
                  binding={
                    goal.profileId && !goalStale
                      ? { profile: goal.profileId, model: goal.model }
                      : undefined
                  }
                  unboundAgentId={goalStale ? null : inherited.agentId}
                  unboundProfileId={goalStale ? null : inherited.profileId}
                  unboundLine={goalStale ? "连接已删除，可清除或换绑" : inherited.line}
                  unboundDetail={goalStale ? "" : inherited.detail}
                  eligibleProfiles={stepSlotProfiles}
                  agents={agents}
                  defaultProfiles={defaultProfiles}
                  presetMode="none"
                  disabled={saving || goal.status === "running" || stepSlotProfiles.length === 0}
                  onPick={(pid, mid) => void saveGoalLaunch(goal, pid, mid)}
                  onClear={() => void saveGoalLaunch(goal, "", "")}
                  onAdd={() => setPage("profiles")}
                />
                );
              })}
            </ul>
          )}
        </div>
      )}
      {showStepGroup && (
        <div className="mt-8">
          <div className="mb-4">
            <SectionHeading
              title="科研步骤"
              hint={stepGroupSummary(
                (pipelineSteps ?? []).length,
                boundStepCount,
                staleStepCount,
              )}
            />
          </div>
          <ul className="grid grid-cols-1 items-start gap-2 md:grid-cols-2">
              {stepRows.map((row) => {
                const binding = taskBindings[row.slot];
                return (
                  <SlotCard
                    key={row.slot}
                    label={row.stepName}
                    tag={row.stale ? "已失效" : binding ? "已指定" : ""}
                    marked={Boolean(binding) && !row.stale}
                    stale={row.stale}
                    binding={binding}
                    unboundAgentId={row.stale ? null : inherited.agentId}
                    unboundProfileId={row.stale ? null : inherited.profileId}
                    unboundLine={row.stale ? "绑定已失效，可清除" : inherited.line}
                    unboundDetail={row.stale ? "" : inherited.detail}
                    eligibleProfiles={stepSlotProfiles}
                    agents={agents}
                    defaultProfiles={defaultProfiles}
                    presetMode="step"
                    disabled={saving || stepSlotProfiles.length === 0}
                    onPick={(pid, mid, eff, perm) => void saveSlotBinding(row.slot, pid, mid, eff, perm)}
                    onClear={() => void saveSlotBinding(row.slot, "", "")}
                    onAdd={() => setPage("profiles")}
                  />
                );
              })}
            </ul>
        </div>
      )}
      <p className="mt-4 px-1 text-micro text-l4">
        AI 功能（翻译/摘要/雷达解读…）在设置页配置
      </p>
      {project.workMode !== "coding" &&
        roster.rows.length > 0 &&
        roster.rows.every((row) => row.works.length === 0) &&
        roster.unassigned.length === 0 &&
        workMode === "research" &&
        pipelineSteps !== null &&
        pipelineSteps.length > 0 && (
          <p className="mt-3 px-1 text-micro text-l4">
            {projectAgentsEmptyWorkHint(project.workMode)}
            {onOpenGoals && (
              <button
                type="button"
                className="ml-1 text-l3 underline-offset-2 hover:text-l1 hover:underline"
                onClick={onOpenGoals}
              >
                去任务页
              </button>
            )}
          </p>
        )}
      {roster.unassigned.length > 0 && (
        <div className="mt-4 px-1">
          <p className="text-xs text-l3">还没指定 Agent 的目标</p>
          <ul className="mt-2 space-y-2">
            {roster.unassigned.map((work) => (
              <li key={work.id} className="min-w-0">
                {onOpenGoals ? (
                  <button
                    type="button"
                    className="block w-full truncate text-left text-xs text-l2 hover:text-l1"
                    onClick={onOpenGoals}
                  >
                    {work.name}
                  </button>
                ) : (
                  <p className="truncate text-xs text-l2">{work.name}</p>
                )}
                <p className="truncate text-micro text-l4">{work.statusLabel}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function stepGroupSummary(total: number, bound: number, stale: number): string {
  // 三段常显口径（agent-binding.md：组头一眼感知）：N 步 · M 已专属 · K 条失效，
  // 各计数 >0 才出现——既有专属又有坏行时不再二选一吞掉其一
  const parts = [`${total} 步`];
  if (bound > 0) parts.push(`${bound} 已指定`);
  if (stale > 0) parts.push(`${stale} 条失效`);
  return parts.join(" · ");
}

/** 分组标题；短说明与标题同基线横排，窄时自然换行。 */
function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <h2 className="text-sm font-medium text-l1">{title}</h2>
      <p className="text-xs text-l3">{hint}</p>
    </div>
  );
}

type SlotEligibleProfile = ProjectAgentProfile & {
  gatewayId?: string | null;
  accountType?: string;
};

/** 槽位支持哪些预设控件：
 *  - chat（项目对话 / 沉浸阅读）：思考强度 + 4 档权限（先出方案 / 请求批准 / 帮我批准 / 完全访问）
 *  - step（科研步骤）：思考强度 + 3 档写权限（请求批准 / 帮我批准 / 完全访问）
 *  - discuss（问 AI / 聊想法）：思考强度 + 只读提示
 *  - assistant（项目助手）：只读核查提示
 *  - none（定时任务 / 目标）：只分层筛选 Agent → 连接 → 模型 */
type SlotPresetMode = "chat" | "step" | "discuss" | "assistant" | "none";

const SLOT_POPOVER_CAP = 520;
const SLOT_POPOVER_WIDTH = 352;

function permTiersForSlot(mode: SlotPresetMode) {
  if (mode === "chat") return PERMISSION_TIERS;
  if (mode === "step") return PERMISSION_TIERS.filter((t) => t.id !== "discuss");
  return [];
}

function isPermAvailableForAgent(
  agents: readonly DetectResult[],
  agentId: string,
  tier: BindingPermissionTier,
): boolean {
  if (agents.length === 0) return true;
  const det = agents.find((a) => a.id === agentId);
  if (!det) return true;
  if (tier === "discuss") return Boolean(det.readonlySupported);
  return Boolean(det.permissionModes?.includes(tier));
}

function defaultEffortLevelsForAgent(agents: readonly DetectResult[], agentId: string): string[] {
  const levels = agents.find((a) => a.id === agentId)?.effort?.levels;
  return levels && levels.length > 0 ? levels : ["low", "medium", "high"];
}

/** 与名册卡同一套：标题在左，状态胶囊在右，下面是分层筛选面板与预设微标。 */
function SlotCard({
  label,
  tag,
  marked,
  stale,
  binding,
  unboundAgentId = null,
  unboundProfileId = null,
  unboundLine = "跟随项目默认",
  unboundDetail = "",
  defaultOptionLabel = "项目默认",
  note,
  eligibleProfiles,
  agents,
  defaultProfiles,
  presetMode,
  disabled,
  onPick,
  onClear,
  onAdd,
}: {
  label: string;
  tag: string;
  marked?: boolean;
  stale?: boolean;
  binding?: ProjectAgentBinding;
  unboundAgentId?: string | null;
  unboundProfileId?: string | null;
  unboundLine?: string;
  /** 未绑定时第二行，用来对齐已绑卡片的模型行 */
  unboundDetail?: string;
  /** 面板首行恢复默认项文案。专属绑定是「项目默认」；定时任务未钉连接可能是「自动」。 */
  defaultOptionLabel?: string;
  /** 卡片最下面一行小字说明（项目助手：哪些能力只有部分 CLI 有） */
  note?: string;
  eligibleProfiles: readonly SlotEligibleProfile[];
  agents: readonly DetectResult[];
  defaultProfiles: Record<string, string>;
  presetMode: SlotPresetMode;
  disabled: boolean;
  onPick: (
    profileId: string,
    modelId: string,
    effort?: string | null,
    permissionTier?: BindingPermissionTier | null,
  ) => void;
  onClear: () => void;
  onAdd: () => void;
}) {
  return (
    <li
      className={`ccode-well min-w-0 rounded-lg p-3 ${
        stale ? "opacity-70" : ""
      }`}
    >
      {/* 卡片不画槽位 / 步骤符号（2026-11-16 用户），只有绑定失效时留警示三角；
          标题与说明左缩 px-2，对齐下面 Agent 信息那一行（选择按钮自带 px-2 的悬停底） */}
      <div className="flex items-center gap-2 px-2">
        {stale && (
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-warn-text" />
        )}
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-l1">{label}</h3>
        {tag && (
          <span
            className={`shrink-0 ${
              marked
                ? "ccode-bound-pill rounded-full px-2 py-0.5 text-micro font-medium"
                : "text-xs text-l4"
            }`}
          >
            {tag}
          </span>
        )}
      </div>
      <div className="mt-1 min-w-0">
        {eligibleProfiles.length === 0 ? (
          <button type="button" className={ghostActionClass} onClick={onAdd}>
            还没有连接
          </button>
        ) : (
          <SlotBindingPopover
            label={label}
            stale={Boolean(stale)}
            binding={binding}
            unboundAgentId={unboundAgentId}
            unboundProfileId={unboundProfileId}
            unboundLine={unboundLine}
            unboundDetail={unboundDetail}
            defaultOptionLabel={defaultOptionLabel}
            eligibleProfiles={eligibleProfiles}
            agents={agents}
            defaultProfiles={defaultProfiles}
            presetMode={presetMode}
            disabled={disabled}
            onPick={onPick}
            onClear={onClear}
            onAdd={onAdd}
          />
        )}
      </div>
      {note && <p className="mt-1.5 px-2 text-micro leading-4 text-l4">{note}</p>}
    </li>
  );
}

function SlotBindingPopover({
  label,
  stale,
  binding,
  unboundAgentId,
  unboundProfileId,
  unboundLine,
  unboundDetail,
  defaultOptionLabel,
  eligibleProfiles,
  agents,
  defaultProfiles,
  presetMode,
  disabled,
  onPick,
  onClear,
  onAdd,
}: {
  label: string;
  stale: boolean;
  binding?: ProjectAgentBinding;
  unboundAgentId: string | null;
  unboundProfileId: string | null;
  unboundLine: string;
  unboundDetail: string;
  defaultOptionLabel: string;
  eligibleProfiles: readonly SlotEligibleProfile[];
  agents: readonly DetectResult[];
  defaultProfiles: Record<string, string>;
  presetMode: SlotPresetMode;
  disabled: boolean;
  onPick: (
    profileId: string,
    modelId: string,
    effort?: string | null,
    permissionTier?: BindingPermissionTier | null,
  ) => void;
  onClear: () => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<"above" | "below">("below");
  const [alignRight, setAlignRight] = useState(false);
  const [room, setRoom] = useState(SLOT_POPOVER_CAP);
  const [query, setQuery] = useState("");

  const boundProfile = useMemo(
    () =>
      !stale && binding?.profile
        ? eligibleProfiles.find((p) => p.id === binding.profile)
        : undefined,
    [stale, binding?.profile, eligibleProfiles],
  );
  const unbound = !boundProfile;
  const boundModelId = boundProfile ? resolveProfileModel(boundProfile.models, binding?.model) : "";
  const boundAgentLabel = boundProfile
    ? (AGENTS.find((a) => a.id === boundProfile.agent)?.label ?? boundProfile.agent)
    : "";
  const boundPerm =
    boundProfile && (presetMode === "chat" || presetMode === "step")
      ? normalizeBindingPermissionTier(binding?.permissionTier)
      : null;
  const boundEffort =
    boundProfile && (presetMode === "chat" || presetMode === "step" || presetMode === "discuss")
      ? (binding?.effort?.trim() || null)
      : null;

  const availableAgents = useMemo(() => {
    const present = new Set(eligibleProfiles.map((p) => p.agent));
    const catalogMatched = AGENTS.filter((a) => present.has(a.id));
    const extras = Array.from(present)
      .filter((id) => !AGENTS.some((a) => a.id === id))
      .map((id) => ({ id, label: id }));
    return [...catalogMatched, ...extras];
  }, [eligibleProfiles]);

  const initialAgentAndProfile = useCallback(() => {
    if (boundProfile) {
      return { agentId: boundProfile.agent, profileId: boundProfile.id };
    }
    if (unboundAgentId && eligibleProfiles.some((p) => p.agent === unboundAgentId)) {
      const byDefault =
        (unboundProfileId && eligibleProfiles.find((p) => p.id === unboundProfileId)) ||
        (defaultProfiles[unboundAgentId] &&
          eligibleProfiles.find((p) => p.id === defaultProfiles[unboundAgentId])) ||
        eligibleProfiles.find((p) => p.agent === unboundAgentId)!;
      return { agentId: unboundAgentId, profileId: byDefault.id };
    }
    const first = eligibleProfiles[0];
    return { agentId: first?.agent ?? "", profileId: first?.id ?? "" };
  }, [boundProfile, defaultProfiles, eligibleProfiles, unboundAgentId, unboundProfileId]);

  const [draftAgentId, setDraftAgentId] = useState(() => initialAgentAndProfile().agentId);
  const [draftProfileId, setDraftProfileId] = useState(() => initialAgentAndProfile().profileId);

  const toggleOpen = () => {
    if (!open) {
      const init = initialAgentAndProfile();
      setDraftAgentId(init.agentId);
      setDraftProfileId(init.profileId);
      setQuery("");
    }
    setOpen((v) => !v);
  };

  const activeAgentId = availableAgents.some((a) => a.id === draftAgentId)
    ? draftAgentId
    : (availableAgents[0]?.id ?? "");
  const activeAgentLabel =
    AGENTS.find((a) => a.id === activeAgentId)?.label ?? activeAgentId;
  const agentProfiles = useMemo(
    () => eligibleProfiles.filter((p) => p.agent === activeAgentId),
    [eligibleProfiles, activeAgentId],
  );
  const activeProfile =
    agentProfiles.find((p) => p.id === draftProfileId) ?? agentProfiles[0] ?? eligibleProfiles[0];
  const rawModels = useMemo(
    () => (activeProfile && activeProfile.models.length > 0 ? [...activeProfile.models] : [""]),
    [activeProfile],
  );
  const activeModelId =
    boundProfile?.id === activeProfile?.id
      ? boundModelId
      : (rawModels[0] ?? "");

  // 思考强度能力：仅在弹层打开且槽位支持预设思考档时按需查 combo_surface
  const supportsEffortPreset =
    presetMode === "chat" || presetMode === "step" || presetMode === "discuss";
  const [effortInjectable, setEffortInjectable] = useState(false);
  const [comboLevels, setComboLevels] = useState<string[]>([]);
  useEffect(() => {
    if (!open || !supportsEffortPreset || !activeProfile?.id) {
      return;
    }
    let cancelled = false;
    invoke<ComboSurfaceDto>("combo_surface", {
      profileId: activeProfile.id,
      model: activeModelId.trim() || null,
    })
      .then((c) => {
        if (cancelled) return;
        setEffortInjectable(c.injectEffortAllowed === true);
        setComboLevels(Array.isArray(c.effortLevels) ? c.effortLevels : []);
      })
      .catch(() => {
        if (cancelled) return;
        setEffortInjectable(false);
        setComboLevels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, supportsEffortPreset, activeProfile?.id, activeModelId]);

  const effortLevels = useMemo(() => {
    if (comboLevels.length > 0) return comboLevels;
    return defaultEffortLevelsForAgent(agents, activeAgentId);
  }, [comboLevels, agents, activeAgentId]);

  // 模型能力标注（200K · 思考 · 看图）：仅打开时查询一次
  const [capsLabels, setCapsLabels] = useState<Record<string, string>>({});
  const modelsKey = useMemo(() => rawModels.filter(Boolean).join("\n"), [rawModels]);
  useEffect(() => {
    if (!open || !modelsKey) return;
    let cancelled = false;
    invoke<ModelCapabilityDto[]>("model_capabilities", {
      models: modelsKey.split("\n"),
      gatewayId: activeProfile?.gatewayId ?? null,
    })
      .then((list) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const item of list) map[item.model] = modelCapsLabel(item);
        setCapsLabels(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, modelsKey, activeProfile?.gatewayId]);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current || !dialogRef.current) return;
    const place = () => {
      if (!wrapRef.current || !dialogRef.current) return;
      const anchor = wrapRef.current.getBoundingClientRect();
      const bounds = clipBounds(wrapRef.current);
      const natural = Math.min(dialogRef.current.scrollHeight + 8, SLOT_POPOVER_CAP);
      const nextSide = pickPopoverSide(anchor, bounds, natural);
      setSide(nextSide);
      const nextRoom = popoverRoom(anchor, bounds, nextSide, SLOT_POPOVER_CAP);
      setRoom(nextRoom >= 180 ? nextRoom : SLOT_POPOVER_CAP);
      const winW = window.innerWidth || 1280;
      setAlignRight(anchor.left + SLOT_POPOVER_WIDTH > winW - 12 && anchor.right >= SLOT_POPOVER_WIDTH);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, activeAgentId, activeProfile?.id, effortInjectable]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (confirmDialogOpen() || target?.closest?.('[role="alertdialog"]')) return;
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (confirmDialogOpen()) return;
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const currentEffort =
    boundProfile?.agent === activeAgentId ? (boundEffort ?? "") : "";
  const currentPerm: BindingPermissionTier | null =
    boundProfile?.agent === activeAgentId ? boundPerm : null;

  const permChoices = permTiersForSlot(presetMode);
  const inheritTitle =
    defaultOptionLabel === "项目默认" ? "跟随项目默认" : defaultOptionLabel;
  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rawModels;
    return rawModels.filter((m) => (m || "cli 默认").toLowerCase().includes(q));
  }, [query, rawModels]);

  function handlePickAgent(nextAgentId: string) {
    setDraftAgentId(nextAgentId);
    setQuery("");
    const list = eligibleProfiles.filter((p) => p.agent === nextAgentId);
    const preferred =
      (defaultProfiles[nextAgentId] && list.find((p) => p.id === defaultProfiles[nextAgentId])) ||
      list[0];
    if (!preferred) return;
    setDraftProfileId(preferred.id);
    const nextModel = preferred.models[0] ?? "";
    const nextLevels = defaultEffortLevelsForAgent(agents, nextAgentId);
    const keptEffort = boundEffort && nextLevels.includes(boundEffort) ? boundEffort : null;
    const keptPerm =
      boundPerm && isPermAvailableForAgent(agents, nextAgentId, boundPerm) ? boundPerm : null;
    onPick(preferred.id, nextModel, keptEffort, keptPerm);
  }

  function handlePickProfile(nextProfile: SlotEligibleProfile) {
    setDraftProfileId(nextProfile.id);
    setQuery("");
    const keptModel =
      activeModelId && nextProfile.models.includes(activeModelId)
        ? activeModelId
        : (nextProfile.models[0] ?? "");
    onPick(nextProfile.id, keptModel, currentEffort || null, currentPerm);
  }

  function handlePickModel(modelId: string) {
    if (!activeProfile) return;
    onPick(activeProfile.id, modelId, currentEffort || null, currentPerm);
    if (presetMode === "none" || presetMode === "assistant") {
      setOpen(false);
    }
  }

  function handlePickEffort(level: string) {
    if (!activeProfile) return;
    onPick(activeProfile.id, activeModelId, level || null, currentPerm);
  }

  async function handlePickPerm(tier: BindingPermissionTier | null) {
    if (!activeProfile) return;
    const nextTier = tier === currentPerm ? null : tier;
    if (nextTier === "full" && currentPerm !== "full") {
      const ok = await confirmPermissionChoice(activeAgentLabel, "full", false);
      if (!ok) return;
    }
    onPick(activeProfile.id, activeModelId, currentEffort || null, nextTier);
  }

  const cardEffortLevels = boundProfile
    ? defaultEffortLevelsForAgent(agents, boundProfile.agent)
    : [];
  const cardPermMeta = boundPerm
    ? PERMISSION_TIERS.find((t) => t.id === boundPerm)
    : null;
  const effChoices = useMemo(
    () => [{ value: "", label: "默认" }, ...effortLevels.map((l) => ({ value: l, label: l }))],
    [effortLevels],
  );
  const effIdx = Math.max(
    0,
    effChoices.findIndex((c) => c.value === currentEffort),
  );
  const effPct = effChoices.length > 1 ? (effIdx / (effChoices.length - 1)) * 100 : 0;
  const effDepth = currentEffort ? effortDepth(currentEffort, effortLevels) : null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`更换 ${label} 的项目连接`}
        className={`flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-hover disabled:opacity-50 ${
          open ? "bg-hover" : ""
        }`}
        onClick={toggleOpen}
      >
        <span className="min-w-0 flex-1">
          {boundProfile ? (
            <>
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-l1">
                <AgentIcon agent={boundProfile.agent} label={boundAgentLabel} size={12} />
                <span className="truncate">{boundAgentLabel} · {boundProfile.name}</span>
              </span>
              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-l3">
                <span className="truncate">{boundModelId || "CLI 默认"}</span>
                {cardPermMeta && (
                  <span
                    className={`ccode-preset-chip text-micro ${
                      boundPerm === "full" ? "text-caution-text" : ""
                    }`}
                  >
                    <PermissionGlyph tier={boundPerm!} />
                    <span>{cardPermMeta.label}</span>
                  </span>
                )}
                {boundEffort && (
                  <span className="ccode-preset-chip text-micro">
                    <EffortMark depth={effortDepth(boundEffort, cardEffortLevels)} />
                    <span>{boundEffort}</span>
                  </span>
                )}
              </span>
            </>
          ) : (
            <>
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-l2">
                {!stale && unboundAgentId && (
                  <span className="shrink-0 opacity-75">
                    <AgentIcon
                      agent={unboundAgentId}
                      label={AGENTS.find((a) => a.id === unboundAgentId)?.label ?? unboundAgentId}
                      size={12}
                    />
                  </span>
                )}
                <span className="truncate">{unboundLine}</span>
              </span>
              {unboundDetail && (
                <span className="mt-0.5 block truncate text-xs text-l3">
                  {unboundDetail}
                </span>
              )}
            </>
          )}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-l3 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-label={`${label} 的项目连接`}
          style={{ maxHeight: room }}
          className={`ccode-float-surface absolute z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto overscroll-contain rounded-xl border border-field p-1.5 text-xs shadow-lg ${
            side === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5"
          } ${alignRight ? "right-0" : "left-0"}`}
        >
          {/* 1. 恢复项目默认行 */}
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setOpen(false);
              onClear();
            }}
            className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors disabled:opacity-50 ${
              unbound && !stale ? "bg-hover text-l1" : "text-l2 hover:bg-hover hover:text-l1"
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-l1">{inheritTitle}</span>
              {!stale && unboundLine && unboundLine !== inheritTitle && (
                <span className="mt-0.5 block truncate text-micro text-l3">{unboundLine}</span>
              )}
            </span>
            {unbound && !stale ? (
              <Check size={14} className="shrink-0 text-l1" aria-hidden="true" />
            ) : (
              <span className="shrink-0 text-micro text-l4">恢复默认</span>
            )}
          </button>

          <div className="mx-1 my-1.5 h-px shrink-0 bg-hairline" />

          {/* 2. Agent 两列筛选胶囊 + 连接切换 */}
          <div className="flex items-center justify-between px-2 pb-1 text-micro text-l3">
            <span>筛选 Agent</span>
            <span className="text-l4">{activeAgentLabel}</span>
          </div>
          <div className="grid grid-cols-2 gap-1 px-0.5">
            {availableAgents.map((a) => {
              const selected = a.id === activeAgentId;
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  onClick={() => handlePickAgent(a.id)}
                  className={`flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-left transition-colors disabled:opacity-50 ${
                    selected
                      ? "bg-seg-sel font-medium text-l1"
                      : "text-l2 hover:bg-hover hover:text-l1"
                  }`}
                >
                  <AgentIcon agent={a.id} label={a.label} size={12} />
                  <span className="min-w-0 flex-1 truncate">{a.label}</span>
                </button>
              );
            })}
          </div>

          {agentProfiles.length > 1 ? (
            <div className="flex flex-wrap gap-1 px-1 pt-1.5">
              {agentProfiles.map((p) => {
                const selected = p.id === activeProfile?.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected}
                    onClick={() => handlePickProfile(p)}
                    className={`h-6 max-w-full truncate rounded-full border px-2.5 text-micro transition-colors disabled:opacity-50 ${
                      selected
                        ? "border-field bg-inset font-medium text-l1"
                        : "border-hairline text-l3 hover:border-field hover:text-l1"
                    }`}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          ) : activeProfile ? (
            <p className="px-2 pt-1 text-micro text-l4">连接：{activeProfile.name}</p>
          ) : null}

          <div className="mx-1 my-1.5 h-px shrink-0 bg-hairline" />

          {/* 3. 模型选择列表（模型多时出搜索框） */}
          <div className="flex items-center justify-between px-2 pb-1 text-micro text-l3">
            <span>模型</span>
            <span className="text-l4">点选即指定</span>
          </div>
          {rawModels.length >= 5 && (
            <div className="mx-1 mb-1 flex h-7 items-center gap-1.5 rounded-lg bg-inset px-2">
              <Search size={12} className="shrink-0 text-l4" aria-hidden="true" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="筛选模型…"
                aria-label="筛选模型"
                className="w-full min-w-0 bg-transparent text-xs text-l1 outline-none placeholder:text-l4"
              />
            </div>
          )}
          {/* 弹层自身限高可滚：列表不 shrink-0 会被 flex 压成 0 高，模型一行都看不见 */}
          <ul
            role="listbox"
            aria-label={`${activeProfile?.name ?? activeAgentLabel} 的模型`}
            className="max-h-36 shrink-0 overflow-y-auto overscroll-contain px-0.5"
          >
            {filteredModels.length === 0 ? (
              <li className="px-2 py-2 text-micro text-l4">没有匹配的模型</li>
            ) : (
              filteredModels.map((m) => {
                const selected =
                  Boolean(boundProfile) &&
                  boundProfile?.id === activeProfile?.id &&
                  boundModelId === m;
                const display = m || "CLI 默认";
                const caps = m ? capsLabels[m] : "";
                return (
                  <li key={m || "__cli_default__"}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={disabled}
                      onClick={() => handlePickModel(m)}
                      className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors disabled:opacity-50 ${
                        selected
                          ? "font-medium text-l1 hover:bg-hover"
                          : "text-l2 hover:bg-hover hover:text-l1"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{display}</span>
                      {caps && <span className="shrink-0 text-micro font-normal text-l4">{caps}</span>}
                      <Check
                        size={13}
                        strokeWidth={2}
                        aria-hidden="true"
                        className={`shrink-0 ${selected ? "text-l1" : "invisible"}`}
                      />
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          {/* 4. 思考强度预设（M▁ 琥珀标尺滑块） */}
          {supportsEffortPreset && effortInjectable && (
            <>
              <div className="mx-1 my-1.5 h-px shrink-0 bg-hairline" />
              <div className="px-2 pb-1.5 pt-0.5">
                <div className="mb-1.5 flex items-center justify-between text-micro">
                  <span className="text-l3">思考强度预设</span>
                  <span className="inline-flex items-center gap-1 font-medium text-l1">
                    <EffortMark depth={effDepth} />
                    <span>{currentEffort || "跟随默认"}</span>
                  </span>
                </div>
                <div className="relative mx-2 h-4">
                  <span className="absolute bottom-1 left-0 h-0.5 w-full rounded-full bg-field" />
                  <span
                    className="absolute bottom-1 left-0 h-0.5 rounded-full bg-l3 transition-[width] duration-[120ms]"
                    style={{ width: `${effPct}%` }}
                  />
                  {effChoices.map((c, idx) =>
                    idx === effIdx ? null : (
                      <span
                        key={c.value || "default"}
                        aria-hidden="true"
                        className={`absolute bottom-1 h-1.5 w-px -translate-x-1/2 ${
                          idx < effIdx ? "bg-l3" : "bg-l4"
                        }`}
                        style={{ left: `${(idx / Math.max(1, effChoices.length - 1)) * 100}%` }}
                      />
                    ),
                  )}
                  <span
                    aria-hidden="true"
                    className="ccode-effort-knob pointer-events-none absolute bottom-1 h-2 w-3.5 -translate-x-1/2 rounded-xs transition-[left] duration-[120ms]"
                    style={{ left: `${effPct}%` }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, effChoices.length - 1)}
                    step={1}
                    value={effIdx}
                    disabled={disabled}
                    aria-label="思考强度预设"
                    onChange={(e) => {
                      const next = effChoices[Number(e.target.value)];
                      if (next) handlePickEffort(next.value);
                    }}
                    className="absolute inset-y-0 -right-2 -left-2 m-0 h-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-default"
                  />
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-1">
                  {effChoices.map((c) => {
                    const selected = c.value === currentEffort;
                    return (
                      <button
                        key={c.value || "default"}
                        type="button"
                        disabled={disabled}
                        aria-pressed={selected}
                        onClick={() => handlePickEffort(c.value)}
                        className={`rounded px-1.5 py-0.5 text-micro transition-colors disabled:opacity-50 ${
                          selected
                            ? "bg-seg-sel font-medium text-l1"
                            : "text-l4 hover:bg-hover hover:text-l2"
                        }`}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* 5. 权限预设（按槽位职责匹配） */}
          {permChoices.length > 0 && (
            <>
              <div className="mx-1 my-1.5 h-px shrink-0 bg-hairline" />
              <div className="px-1.5 pb-1 pt-0.5">
                <div className="mb-1.5 flex items-center justify-between px-0.5 text-micro">
                  <span className="text-l3">权限预设</span>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={currentPerm === null}
                    onClick={() => void handlePickPerm(null)}
                    className={`rounded px-1.5 py-0.5 transition-colors disabled:opacity-50 ${
                      currentPerm === null
                        ? "font-medium text-l2"
                        : "text-l4 hover:bg-hover hover:text-l2"
                    }`}
                  >
                    {currentPerm === null ? "按默认" : "恢复按默认"}
                  </button>
                </div>
                <div
                  className={`grid gap-1 rounded-lg bg-inset p-0.5 ${
                    permChoices.length === 3 ? "grid-cols-3" : "grid-cols-4"
                  }`}
                >
                  {permChoices.map((t) => {
                    const tier = t.id as BindingPermissionTier;
                    const available = isPermAvailableForAgent(agents, activeAgentId, tier);
                    const selected = currentPerm === tier;
                    const danger = tier === "full";
                    return (
                      <button
                        key={tier}
                        type="button"
                        disabled={disabled || !available}
                        aria-pressed={selected}
                        title={available ? t.desc : `${activeAgentLabel} 没有这一档`}
                        onClick={() => void handlePickPerm(tier)}
                        className={`flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-micro transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          selected
                            ? danger
                              ? "bg-seg-sel font-medium text-caution-text"
                              : "bg-seg-sel font-medium text-l1"
                            : "text-l3 hover:bg-hover hover:text-l1"
                        }`}
                      >
                        <PermissionGlyph
                          tier={t.id}
                          className={danger ? "text-caution-text" : selected ? "text-l1" : "text-l3"}
                        />
                        <span className="truncate">{t.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {(presetMode === "discuss" || presetMode === "assistant") && (
            <>
              <div className="mx-1 my-1.5 h-px shrink-0 bg-hairline" />
              <p className="flex items-center gap-1.5 px-2 py-1 text-micro text-l4">
                <PermissionGlyph tier="discuss" className="text-l4" />
                <span>
                  {presetMode === "assistant"
                    ? "固定只读核查，永不修改文件"
                    : "固定只读讨论，不直接改项目文件"}
                </span>
              </p>
            </>
          )}

          <div className="mx-1 my-1 h-px shrink-0 bg-hairline" />
          <button
            type="button"
            className="flex h-7 w-full shrink-0 items-center rounded-lg px-2.5 text-left text-xs text-l4 hover:bg-hover hover:text-l1"
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
          >
            去连接页添加
          </button>
        </div>
      )}
    </div>
  );
}

function DefaultModelMenu({
  row,
  disabled,
  onPick,
  onAdd,
}: {
  row: ProjectAgentRow;
  disabled: boolean;
  onPick: (profileId: string, modelId: string) => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = selectedProjectAgentProfile(row);
  const line = currentProfileLine(row);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`更换 ${row.label} 的项目连接`}
        title={`${line ?? "还没有连接"}；只修改本项目的默认连接和模型`}
        className={`${secondaryActionClass} gap-1.5`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>换默认模型</span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-l3 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={`${row.label} 的项目连接`}
          className="ccode-float-surface absolute right-0 z-50 mt-1.5 max-h-64 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-xl border border-field p-1 shadow-lg"
        >
          {row.profiles.map((profile) => {
            const selected = profile.id === current?.id && profile.modelId === current?.modelId;
            return (
              <li key={`${profile.id}\n${profile.modelId}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={disabled}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left disabled:opacity-50 ${
                    selected ? "bg-hover text-l1" : "text-l2 hover:bg-hover hover:text-l1"
                  }`}
                  onClick={() => {
                    onPick(profile.id, profile.modelId);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{profile.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-l3">{profile.model}</span>
                  </span>
                  {selected && <Check size={14} className="shrink-0 text-cta" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
          <li className="mt-1 border-t border-hairline pt-1">
            <button
              type="button"
              className="flex h-7 w-full items-center rounded-lg px-2.5 text-left text-xs text-l4 hover:bg-hover hover:text-l1"
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
            >
              去连接页添加
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

function MoreAgentsMenu({
  rows,
  disabled,
  onPick,
}: {
  rows: ProjectAgentRow[];
  disabled: boolean;
  onPick: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`展开其余 ${rows.length} 家 Agent`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 items-center gap-1 rounded-full border border-hairline px-2.5 text-xs text-l3 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50"
      >
        <span>更多 {rows.length} 家</span>
        <ChevronDown
          size={12}
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul
          role="menu"
          aria-label="其余可用 Agent"
          className="ccode-float-surface absolute left-0 z-50 mt-1.5 max-h-64 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-xl border border-field p-1 shadow-lg"
        >
          {rows.map((row) => {
            const picked = selectedProjectAgentProfile(row);
            return (
              <li key={row.agentId} role="none">
                <button
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  aria-label={`将 ${row.label} 设为项目默认`}
                  onClick={() => {
                    onPick(row.agentId);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-l2 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <AgentIcon agent={row.agentId} label={row.label} size={12} />
                    <span className="truncate font-medium text-l1">{row.label}</span>
                  </span>
                  <span className="max-w-[8.5rem] shrink-0 truncate font-mono text-micro text-l3">
                    {picked ? picked.model : "未配连接"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
