import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Circle,
  ClipboardList,
  Clock3,
  Database,
  FlaskConical,
  GitBranch,
  House,
  Lightbulb,
  MessageSquare,
  PenLine,
  Search,
  Sparkles,
  Star,
  Target,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { selectHiddenProfiles, useAppStore } from "../store";
import { toast } from "../toast";
import { AGENTS, type CodingOverviewDto, type ProjectDto, type ScheduleDto, type TaskDto } from "../types";
import { ghostActionClass } from "./PageFrame";
import { agentBrand } from "../agent-colors";
import {
  buildProjectAgentRoster,
  currentProfileLine,
  projectAgentsEmptyWorkHint,
  projectAgentLaunch,
  projectAgentsHint,
  selectedProjectAgentProfile,
  READER_BINDING_SLOT,
  CHAT_BINDING_SLOT,
  DISCUSS_BINDING_SLOT,
  stepSlotKey,
  type ProjectAgentRow,
} from "../project-agents";
import { declaredTaskKindsForMode, isDeclaredTask, taskStatusLabel } from "../project-tasks";
import { normalizeWorkMode } from "../work-mode";
import { schedulesForProject } from "../schedule-tasks";
import { IS_WINDOWS } from "../hotkeys";
import { confirmDialog } from "./ConfirmDialog";
import { headlessWriteBlocked } from "../agent-caps";
import { isLitWatchSkill } from "../schedule-skill";
import type { AgentCapabilitiesDto } from "../types";

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
  }, [project.defaultAgent, project.defaultModels, project.defaultProfiles]);

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
    if (taskKinds.size === 0) return;
    const timer = window.setInterval(() => void loadTasks(), 2500);
    return () => window.clearInterval(timer);
  }, [loadTasks, taskKinds]);

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

  /** 槽位专属绑定：某个固定用途不吃项目默认，单独指一条连接+模型（agent 跟着连接走）。
      首个槽位 = 精读阅读会话；槽位清单与后端 PROJECT_AGENT_BINDING_SLOTS 同源 */
  async function saveSlotBinding(slot: string, profileId: string, modelId: string) {
    setSaving(true);
    try {
      await invoke("set_project_agent_binding", {
        projectRoot: project.path,
        slot,
        profileId: profileId || null,
        model: modelId || null,
      });
      const next = { ...(project.taskBindings ?? {}) };
      if (profileId) next[slot] = { profile: profileId, model: modelId || null };
      else delete next[slot];
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

  const scheduleChoices = useMemo(() => {
    const bound = new Set(
      schedules.map((item) => item.profileId).filter((id): id is string => Boolean(id)),
    );
    return profiles
      .filter((profile) => !hiddenProfiles.includes(profile.id) || bound.has(profile.id))
      .filter(
        (profile) =>
          !headlessWriteBlocked(scheduleCaps[profile.agent]?.headlessWrite) ||
          bound.has(profile.id),
      )
      .flatMap((profile) => {
        const agentLabel = AGENTS.find((agent) => agent.id === profile.agent)?.label ?? profile.agent;
        const models = profile.models.length > 0 ? profile.models : [""];
        return models.map((modelId) => ({
          id: profile.id,
          name: `${agentLabel} · ${profile.name}`,
          modelId,
          model: modelId || "CLI 默认",
          modelLine: `${agentLabel} · ${profile.name} · ${modelId || "CLI 默认"}`,
        }));
      });
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
    const slots = Object.keys(project.taskBindings ?? {}).filter(
      (slot) =>
        slot === CHAT_BINDING_SLOT ||
        slot === DISCUSS_BINDING_SLOT ||
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
        });
      }
      const next = { ...(project.taskBindings ?? {}) };
      for (const slot of slots) delete next[slot];
      onProjectChanged({ ...project, taskBindings: next });
    } catch (reason) {
      onError(`清除专属绑定失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  }

  /** 精读槽位可选的连接×模型（跨 agent 拍平，带 agent 前缀防混淆；显式槽
      尊重停用——被停用的已绑定项仍列出） */
  const readerSlotProfiles = useMemo(() => {
    const boundId = project.taskBindings?.[READER_BINDING_SLOT]?.profile;
    return profiles
      .filter((p) => !hiddenProfiles.includes(p.id) || p.id === boundId)
      .flatMap((p) => {
        const agentLabel = AGENTS.find((a) => a.id === p.agent)?.label ?? p.agent;
        const models = p.models.length > 0 ? p.models : [""];
        return models.map((modelId) => ({
          id: p.id,
          name: `${agentLabel} · ${p.name}`,
          modelId,
          model: modelId || "CLI 默认",
          modelLine: `${agentLabel} · ${p.name} · ${modelId || "CLI 默认"}`,
        }));
      });
  }, [profiles, hiddenProfiles, project.taskBindings]);

  const readerBinding = project.taskBindings?.[READER_BINDING_SLOT];
  const chatBinding = project.taskBindings?.[CHAT_BINDING_SLOT];
  const discussBinding = project.taskBindings?.[DISCUSS_BINDING_SLOT];
  const chatSlotProfiles = useMemo(() => {
    const boundId = chatBinding?.profile;
    return profiles
      .filter((p) => !hiddenProfiles.includes(p.id) || p.id === boundId)
      .flatMap((p) => {
        const agentLabel = AGENTS.find((a) => a.id === p.agent)?.label ?? p.agent;
        const models = p.models.length > 0 ? p.models : [""];
        return models.map((modelId) => ({
          id: p.id,
          name: `${agentLabel} · ${p.name}`,
          modelId,
          model: modelId || "CLI 默认",
          modelLine: `${agentLabel} · ${p.name} · ${modelId || "CLI 默认"}`,
        }));
      });
  }, [profiles, hiddenProfiles, chatBinding?.profile]);
  const discussSlotProfiles = useMemo(() => {
    const boundId = discussBinding?.profile;
    return profiles
      .filter((p) => !hiddenProfiles.includes(p.id) || p.id === boundId)
      .flatMap((p) => {
        const agentLabel = AGENTS.find((a) => a.id === p.agent)?.label ?? p.agent;
        const models = p.models.length > 0 ? p.models : [""];
        return models.map((modelId) => ({
          id: p.id,
          name: `${agentLabel} · ${p.name}`,
          modelId,
          model: modelId || "CLI 默认",
          modelLine: `${agentLabel} · ${p.name} · ${modelId || "CLI 默认"}`,
        }));
      });
  }, [profiles, hiddenProfiles, discussBinding]);

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
      for (const slot of Object.keys(project.taskBindings ?? {})) {
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
  }, [pipelineSteps, project.taskBindings]);
  const boundStepCount = stepRows.filter(
    (r) => !r.stale && project.taskBindings?.[r.slot],
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
  const hasExclusiveBinding = Object.keys(project.taskBindings ?? {}).some(
    (slot) =>
      slot === CHAT_BINDING_SLOT ||
      slot === DISCUSS_BINDING_SLOT ||
      slot === READER_BINDING_SLOT ||
      slot.startsWith("step:"),
  );
  const inherited = useMemo(() => {
    const launch = projectAgentLaunch(profiles, defaultAgent, defaultProfiles, defaultModels);
    if (!launch) return { line: "跟随项目默认", detail: "" };
    const agentLabel = AGENTS.find((agent) => agent.id === launch.agentId)?.label ?? launch.agentId;
    const profile = profiles.find((item) => item.id === launch.profileId);
    return {
      line: `${agentLabel} · ${profile?.name ?? "连接"}`,
      detail: launch.model || "CLI 默认",
    };
  }, [defaultAgent, defaultModels, defaultProfiles, profiles]);

  /** 没钉连接的定时任务实际会用什么（与后端 scheduler::pick_project_default 同口径，
   *  2026-10-17）：项目默认那家能无头写盘就跟随项目默认；不能、或项目没设默认，
   *  运行时回落设置页 AI 专用配置 / 最近用过的连接。 */
  const scheduleFallback = useMemo(() => {
    const launch = projectAgentLaunch(profiles, defaultAgent, defaultProfiles, defaultModels);
    if (!launch) {
      return { tag: "自动", line: "运行时再决定", detail: "设置页 AI 专用配置，或最近用过的连接", option: "自动" };
    }
    if (headlessWriteBlocked(scheduleCaps[launch.agentId]?.headlessWrite)) {
      return {
        tag: "自动",
        line: "项目默认不能用于定时任务",
        detail: "运行时改用设置页 AI 专用配置或最近用过的连接",
        option: "自动",
      };
    }
    return { tag: "跟随默认", line: inherited.line, detail: `${inherited.detail} · 跟随项目默认`, option: "项目默认" };
  }, [defaultAgent, defaultModels, defaultProfiles, profiles, scheduleCaps, inherited]);

  /** 步骤槽可选清单与精读槽同款（跨 agent 拍平 + 停用尊重 + 绑定项保留） */
  const stepSlotProfiles = useMemo(() => {
    const boundIds = new Set(
      [
        ...stepRows.map((r) => project.taskBindings?.[r.slot]?.profile),
        ...goals.map((goal) => goal.profileId),
      ].filter((id): id is string => Boolean(id)),
    );
    return profiles
      .filter((p) => !hiddenProfiles.includes(p.id) || boundIds.has(p.id))
      .flatMap((p) => {
        const agentLabel = AGENTS.find((a) => a.id === p.agent)?.label ?? p.agent;
        const models = p.models.length > 0 ? p.models : [""];
        return models.map((modelId) => ({
          id: p.id,
          name: `${agentLabel} · ${p.name}`,
          modelId,
          model: modelId || "CLI 默认",
          modelLine: `${agentLabel} · ${p.name} · ${modelId || "CLI 默认"}`,
        }));
      });
  }, [goals, profiles, hiddenProfiles, stepRows, project.taskBindings]);

  return (
    <section aria-label="项目 Agents">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-l1">项目 Agents</h2>
          <p className="mt-1 text-xs text-l3">
            {projectAgentsHint(project.workMode)}
          </p>
        </div>
        <button
          type="button"
          className={`${ghostActionClass} shrink-0 gap-1`}
          onClick={() => setPage("profiles")}
        >
          管理连接
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      </div>
      {roster.rows.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-l4">
          还没有可用连接。
          <button
            type="button"
            className="ml-1 text-l2 underline-offset-2 hover:text-l1 hover:underline"
            onClick={() => setPage("profiles")}
          >
            去连接页
          </button>
        </p>
      ) : (
        <ul aria-label="项目 Agent 名册" className="grid grid-cols-1 items-start gap-2 md:grid-cols-2">
          {roster.rows.map((row) => (
            <li
              key={row.agentId}
              className={`min-w-0 rounded-lg p-3 transition-colors ${
                row.isProjectDefault ? "bg-seg-sel" : "ccode-well"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: agentBrand(row.agentId) }}
                />
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-l1">
                  {row.label}
                </h3>
                <button
                  type="button"
                  className={`${ghostActionClass} shrink-0 gap-1 ${row.isProjectDefault ? "font-medium text-l1" : ""}`}
                  disabled={saving}
                  aria-pressed={row.isProjectDefault}
                  aria-label={row.isProjectDefault ? `取消 ${row.label} 的项目默认` : `将 ${row.label} 设为项目默认`}
                  title={row.isProjectDefault
                    ? "取消本项目默认，不改 Mesa 启动栏或 CLI 全局配置"
                    : "只影响本项目的默认选择，不改 Mesa 启动栏或 CLI 全局配置"}
                  onClick={() => void saveAgent(row.isProjectDefault ? "" : row.agentId)}
                >
                  <Star size={13} fill={row.isProjectDefault ? "currentColor" : "none"} aria-hidden="true" />
                  {row.isProjectDefault ? "项目默认" : "设为默认"}
                </button>
              </div>
              <div className="mt-1 min-w-0 pl-2">
                {row.profiles.length === 0 ? (
                  <button
                    type="button"
                    className={ghostActionClass}
                    onClick={() => setPage("profiles")}
                  >
                    还没有连接
                  </button>
                ) : (
                  <ProfileMenu
                    row={row}
                    disabled={saving}
                    onPick={(profileId, modelId) => void saveProfile(row.agentId, profileId, modelId)}
                    onAdd={() => setPage("profiles")}
                  />
                )}
              </div>
              {row.works.length > 0 && (
                <ul className="mt-3 space-y-2 pl-[18px]">
                  {row.works.map((work) => (
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
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8">
        <div className="mb-4 flex items-start justify-between gap-3">
          <SectionHeading title="专属绑定" hint="留空跟随项目默认。" />
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
            Icon={MessageSquare}
            label="项目对话"
            tag={chatBinding ? "已专属" : "跟随默认"}
            marked={Boolean(chatBinding)}
            binding={chatBinding}
            unboundLine={inherited.line}
            unboundDetail={inherited.detail}
            choices={chatSlotProfiles}
            disabled={saving}
            onPick={(pid, mid) => void saveSlotBinding(CHAT_BINDING_SLOT, pid, mid)}
            onClear={() => void saveSlotBinding(CHAT_BINDING_SLOT, "", "")}
            onAdd={() => setPage("profiles")}
          />
          <SlotCard
            Icon={Lightbulb}
            label={workMode === "research" ? "问 AI / 聊想法" : "问 AI"}
            tag={discussBinding ? "已专属" : "跟随默认"}
            marked={Boolean(discussBinding)}
            binding={discussBinding}
            unboundLine={inherited.line}
            unboundDetail={inherited.detail}
            choices={discussSlotProfiles}
            disabled={saving}
            onPick={(pid, mid) => void saveSlotBinding(DISCUSS_BINDING_SLOT, pid, mid)}
            onClear={() => void saveSlotBinding(DISCUSS_BINDING_SLOT, "", "")}
            onAdd={() => setPage("profiles")}
          />
          {workMode === "research" && (
            <SlotCard
              Icon={BookOpen}
              label="沉浸阅读对话"
              tag={readerBinding ? "已专属" : "跟随默认"}
              marked={Boolean(readerBinding)}
              binding={readerBinding}
              unboundLine={inherited.line}
              unboundDetail={inherited.detail}
              choices={readerSlotProfiles}
              disabled={saving}
              onPick={(pid, mid) => void saveSlotBinding(READER_BINDING_SLOT, pid, mid)}
              onClear={() => void saveSlotBinding(READER_BINDING_SLOT, "", "")}
              onAdd={() => setPage("profiles")}
            />
          )}
        </ul>
      </div>
      {workMode !== "research" &&
        Object.keys(project.taskBindings ?? {}).some(
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
            {Object.keys(project.taskBindings ?? {})
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
              hint="每条任务可以单独钉连接；不钉就跟随项目默认。和定时任务页改的是同一份。"
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
                Icon={schedStale ? TriangleAlert : Clock3}
                label={item.name}
                tag={!item.enabled
                  ? "已暂停"
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
                unboundLine={schedStale ? "连接已删除，下次运行会失败；可换绑或改回跟随项目默认" : scheduleFallback.line}
                unboundDetail={schedStale ? "" : scheduleFallback.detail}
                defaultOptionLabel={scheduleFallback.option}
                choices={scheduleChoices}
                disabled={saving || scheduleChoices.length === 0}
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
                  Icon={goalStale ? TriangleAlert : Target}
                  label={goal.name}
                  tag={goalStale ? "已失效" : goal.agent || goal.profileId ? taskStatusLabel(goal.status) : "项目默认"}
                  marked={Boolean(goal.profileId) && !goalStale}
                  stale={goalStale}
                  binding={
                    goal.profileId && !goalStale
                      ? { profile: goal.profileId, model: goal.model }
                      : undefined
                  }
                  unboundLine={goalStale ? "连接已删除，可清除或换绑" : inherited.line}
                  unboundDetail={goalStale ? "" : inherited.detail}
                  choices={stepSlotProfiles}
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
                const binding = project.taskBindings?.[row.slot];
                return (
                  <SlotCard
                    key={row.slot}
                    Icon={row.stale ? TriangleAlert : stepIconFor(row.stepName, row.skills)}
                    label={row.stepName}
                    tag={row.stale ? "已失效" : binding ? "已专属" : "跟随默认"}
                    marked={Boolean(binding) && !row.stale}
                    stale={row.stale}
                    binding={binding}
                    unboundLine={row.stale ? "绑定已失效，可清除" : inherited.line}
                    unboundDetail={row.stale ? "" : inherited.detail}
                    choices={stepSlotProfiles}
                    disabled={saving || stepSlotProfiles.length === 0}
                    onPick={(pid, mid) => void saveSlotBinding(row.slot, pid, mid)}
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

/** 步骤符号按名称和技能推导，同一步永远同一个。 */
function stepIconFor(name: string, skills: string[]): LucideIcon {
  const all = [name, ...skills].join(" ").toLowerCase();
  if (/检索|筛选|search|screen/.test(all)) return Search;
  if (/精读|阅读|笔记|note|read|paper/.test(all)) return BookOpen;
  if (/大纲|outline|框架/.test(all)) return ClipboardList;
  if (/初稿|综述|写作|draft|writ|review/.test(all)) return PenLine;
  if (/润色|定稿|polish|format|final/.test(all)) return Sparkles;
  if (/数据|清洗|clean|dataset/.test(all)) return Database;
  if (/图|plot|fig|chart|visual/.test(all)) return TrendingUp;
  if (/复现|reproduc/.test(all)) return FlaskConical;
  return Circle;
}

function stepGroupSummary(total: number, bound: number, stale: number): string {
  // 三段常显口径（agent-binding.md：组头一眼感知）：N 步 · M 已专属 · K 条失效，
  // 各计数 >0 才出现——既有专属又有坏行时不再二选一吞掉其一
  const parts = [`${total} 步`];
  if (bound > 0) parts.push(`${bound} 已专属`);
  if (stale > 0) parts.push(`${stale} 条失效`);
  if (bound === 0 && stale === 0) parts.push("都跟项目默认");
  return parts.join(" · ");
}

/** 与「项目 Agents / 默认选择仅对本项目生效。」同一套标题。 */
function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="min-w-0">
      <h2 className="text-sm font-medium text-l1">{title}</h2>
      <p className="mt-1 text-xs text-l3">{hint}</p>
    </div>
  );
}

/** 与名册卡同一套：标题在左，状态标签在右，下面是连接和模型。已指定用选中底。 */
function SlotCard({
  Icon,
  label,
  tag,
  marked,
  stale,
  binding,
  unboundLine = "跟随项目默认",
  unboundDetail = "",
  defaultOptionLabel = "项目默认",
  choices,
  disabled,
  onPick,
  onClear,
  onAdd,
}: {
  Icon: LucideIcon;
  label: string;
  tag: string;
  marked?: boolean;
  stale?: boolean;
  binding?: { profile: string; model?: string | null };
  unboundLine?: string;
  /** 未绑定时第二行，用来对齐已绑卡片的模型行 */
  unboundDetail?: string;
  /** 下拉第一项。专属绑定是「项目默认」；定时任务未钉连接是「项目默认」（那家不能定时写盘或项目没设默认时是「自动」）。 */
  defaultOptionLabel?: string;
  choices: readonly {
    id: string;
    name: string;
    modelId: string;
    model: string;
    modelLine: string;
  }[];
  disabled: boolean;
  onPick: (profileId: string, modelId: string) => void;
  onClear: () => void;
  onAdd: () => void;
}) {
  return (
    <li
      className={`min-w-0 rounded-lg p-3 ${marked ? "bg-seg-sel" : "ccode-well"} ${
        stale ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon
          size={14}
          strokeWidth={1.8}
          aria-hidden="true"
          className={`shrink-0 ${stale ? "text-warn-text" : "text-l3"}`}
        />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-l1">{label}</h3>
        <span
          className={`shrink-0 text-xs ${marked ? "font-medium text-l1" : "text-l4"}`}
        >
          {tag}
        </span>
      </div>
      <div className="mt-1 min-w-0">
        {choices.length === 0 ? (
          <button type="button" className={ghostActionClass} onClick={onAdd}>
            还没有连接
          </button>
        ) : (
          <ProfileMenu
            row={{
              agentId: label,
              label,
              isProjectDefault: false,
              defaultProfileId: binding?.profile ?? "",
              defaultModelId: binding?.model ?? "",
              profiles: choices as ProjectAgentRow["profiles"],
              works: [],
            }}
            unboundLine={unboundLine}
            unboundDetail={unboundDetail}
            defaultOptionLabel={defaultOptionLabel}
            disabled={disabled}
            onPick={onPick}
            onClear={onClear}
            onAdd={onAdd}
          />
        )}
      </div>
    </li>
  );
}

function ProfileMenu({
  row,
  disabled,
  unboundLine,
  unboundDetail,
  defaultOptionLabel = "项目默认",
  onPick,
  onClear,
  onAdd,
}: {
  row: ProjectAgentRow;
  disabled: boolean;
  /** 未绑定时的展示行（缺省回落名单第一条的「伪当前」，名册行的既有口径） */
  unboundLine?: string;
  unboundDetail?: string;
  defaultOptionLabel?: string;
  onPick: (profileId: string, modelId: string) => void;
  /** 传了才有「清除」项（槽位专属绑定用；名册行不传，行为不变） */
  onClear?: () => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const unbound = !row.defaultProfileId && unboundLine !== undefined;
  const current = unbound ? undefined : selectedProjectAgentProfile(row);
  const line = unbound ? unboundLine : currentProfileLine(row);

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
        title={`${line ?? "还没有连接"}；只修改本项目的连接和模型`}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-hover disabled:opacity-50"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-l2">
            {unbound ? line : current?.name}
          </span>
          {(current || unboundDetail) && (
            <span className="mt-0.5 block truncate text-xs text-l3">
              {current ? current.model : unboundDetail}
            </span>
          )}
        </span>
        <ChevronDown size={14} className="shrink-0 text-l3" aria-hidden="true" />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={`${row.label} 的项目连接`}
          className="ccode-float-surface absolute inset-x-0 z-50 mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-md border border-field py-1"
        >
          {onClear && (
            <li>
              <button
                type="button"
                role="option"
                aria-selected={unbound}
                className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs ${
                  unbound ? "bg-hover text-l1" : "text-l2 hover:bg-hover hover:text-l1"
                }`}
                onClick={() => {
                  setOpen(false);
                  onClear();
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{defaultOptionLabel}</span>
                  {unbound && line && line !== defaultOptionLabel && (
                    <span className="mt-0.5 block truncate text-l3">{line}</span>
                  )}
                </span>
                {unbound && <Check size={14} className="shrink-0" aria-hidden="true" />}
              </button>
            </li>
          )}
          {row.profiles.map((profile) => {
            const selected = profile.id === current?.id && profile.modelId === current?.modelId;
            return (
              <li key={`${profile.id}\n${profile.modelId}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={disabled}
                  title={profile.modelLine}
                  className={`flex w-full items-center gap-2 px-2.5 py-2 text-left disabled:opacity-50 ${
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
                  {selected && <Check size={14} className="shrink-0" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              className="flex h-7 w-full items-center px-2.5 text-left text-xs text-l4 hover:bg-hover hover:text-l1"
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
