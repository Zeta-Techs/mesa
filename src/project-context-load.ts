import { invoke } from "@tauri-apps/api/core";
import type { DirEntryDto } from "./components/FileTree";
import {
  isGoalContextPack,
  normalizeSessionInjectionMode,
  projectShowsProtectedPaths,
  projectUsesSkillPool,
  renderProjectContextPack,
  renderSessionInjection,
  sessionTemplateValues,
  type ContextPackEntry,
  type ContextPackKind,
  type ProjectSkillPack,
  type SessionInjectionMode,
} from "./project-context";
import { acceptedGoalOutputs, isDeclaredTask } from "./project-tasks";
import type { ProjectConfigReadDto, ProjectStatusDto, SkillDto, TaskDto } from "./types";

type PackRequest = {
  name: string;
  path: string;
  workMode?: string | null;
  goal?: string | null;
  writeReview?: boolean;
  feedback?: string | null;
  /** 本目标点名的技能（Task.skills）；无流程时与项目技能池（config.skills）分两段进上下文包 */
  goalSkills?: readonly string[];
  /** session = 对话/问 AI；缺省与 writeReview 视为目标包。 */
  kind?: ContextPackKind;
  /** 设置面板预览用：按面板里还没保存的档位/模板渲染（只管 session 包，所见即所得） */
  sessionOverride?: { mode: SessionInjectionMode; template: string };
};

/** 读档案卡、顶层目录、长期知识与验收状态，备好拼包的原料（失败时尽量返回能用的短包原料）。 */
async function gatherPack(input: PackRequest) {
  const isGoal = isGoalContextPack(input.kind, input.writeReview);
  let topic: string | null = null;
  let settings: string[] = [];
  let rulesOwned = false;
  let protectedPaths: string[] = [];
  let skillNames: string[] = [];
  let topLevel: ContextPackEntry[] = [];
  // 对话注入三态只管 session 包（2026-10-16 拍板）；档案卡读不到时按 auto 走现状
  let injectionMode: SessionInjectionMode = "auto";
  let injectionTemplate = "";
  try {
    const read = await invoke<ProjectConfigReadDto>("read_project_config", {
      path: input.path,
    });
    if (isGoal && (read.warnings ?? []).length) throw new Error(`项目档案卡需要处理：${read.warnings.join("；")}`);
    topic = read.config.topic ?? null;
    settings = read.config.settings ?? [];
    rulesOwned = read.config.rulesOwned === true;
    injectionMode = normalizeSessionInjectionMode(
      read.config.sessionInjectionMode,
    );
    injectionTemplate =
      read.config.sessionInjectionTemplate?.trim() ?? "";
    const mode = input.workMode ?? read.config.workMode;
    const stepCount = read.config.steps?.length ?? 0;
    protectedPaths =
      isGoal && projectShowsProtectedPaths(mode, stepCount)
        ? (read.config.protectedPaths ?? [])
        : [];
    skillNames =
      isGoal && projectUsesSkillPool(mode, stepCount)
        ? (read.config.skills ?? [])
        : [];
  } catch (error) {
    if (isGoal) throw new Error(`无法确认项目规则，未启动：${String(error)}`);
    /* 普通会话仍可在用户指定目录开始 */
  }
  try {
    const entries = await invoke<DirEntryDto[]>("list_dir", {
      path: input.path,
      showHidden: false,
    });
    topLevel = entries.map((entry) => ({
      name: entry.name,
      isDir: entry.isDir,
    }));
  } catch {
    /* 列目录失败时地图为空 */
  }
  let accepted: { name: string; outputs: string[]; note?: string }[] = [];
  let openGoals: string[] = [];
  let memory = "";
  try {
    memory = await invoke<string>("read_project_memory", { path: input.path });
  } catch (error) {
    if (isGoal) throw new Error(`无法读取项目知识，未启动：${String(error)}`);
  }
  try {
    const status = await invoke<ProjectStatusDto>("read_project_status", {
      path: input.path,
    });
    accepted = (status.accepted ?? []).slice(0, 8).map((item) => ({
      name: item.name,
      outputs: item.outputs ?? [],
      note: item.note,
    }));
  } catch {
    /* 无状态文件时从目标列表回落 */
  }
  if (isGoal) {
    try {
      const tasks = await invoke<TaskDto[]>("task_list", { projectRoot: input.path });
      const declared = tasks.filter((task) => isDeclaredTask(task));
      if (accepted.length === 0) {
        accepted = declared
          .filter((task) => task.status === "completed")
          .slice(0, 8)
          .map((task) => ({
            name: task.name,
            outputs: acceptedGoalOutputs(task.outputPaths, task.adoptedPaths),
          }));
      }
      openGoals = declared
        .filter((task) => task.status !== "completed")
        .slice(0, 8)
        .map((task) => task.name);
    } catch {
      /* 没有目标列表时省略已验收段 */
    }
  }
  // 技能两段式：本目标点名（要用）在前，项目技能池（可用但默认不用）在后。
  // 有研究步骤时 load 侧已丢弃池名单，此处 pool 为空。会话包不列技能。
  let skills: ProjectSkillPack[] = [];
  const named = isGoal
    ? (input.goalSkills ?? []).filter((name) => name.trim())
    : [];
  const pool = skillNames.filter((name) => !named.includes(name));
  if (named.length + pool.length > 0) {
    try {
      const library = await invoke<SkillDto[]>("list_skills");
      const byName = new Map(library.map((skill) => [skill.name, skill]));
      const toEntry = (name: string, isNamed: boolean): ProjectSkillPack => {
        const skill = byName.get(name);
        if (!skill && isNamed) throw new Error(`点名技能「${name}」未安装`);
        if (!skill) return { name, missing: true, named: isNamed };
        return {
          name,
          description: skill.description,
          digest: skill.contentDigest ?? null,
          inputs: skill.inputs ?? [],
          outputs: skill.outputs ?? [],
          named: isNamed,
        };
      };
      skills = [
        ...named.map((name) => toEntry(name, true)),
        ...pool.map((name) => toEntry(name, false)),
      ];
    } catch (error) {
      if (named.length) throw new Error(`无法确认点名技能，未启动：${String(error)}`);
      skills = [
        ...named.map((name) => ({ name, named: true })),
        ...pool.map((name) => ({ name, named: false })),
      ];
    }
  }
  const packInput = {
    name: input.name,
    path: input.path,
    workMode: input.workMode,
    topic,
    settings,
    rulesOwned,
    topLevel,
    goal: input.goal,
    writeReview: input.writeReview,
    kind: (isGoal ? "goal" : "session") as ContextPackKind,
    accepted,
    openGoals,
    protectedPaths,
    feedback: input.feedback,
    memory,
    skills,
  };
  if (input.sessionOverride) {
    injectionMode = input.sessionOverride.mode;
    injectionTemplate = input.sessionOverride.template.trim();
  }
  return { isGoal, packInput, injectionMode, injectionTemplate };
}

/** 读档案卡和顶层目录，拼启动用的环境说明。失败时仍返回能用的短包。 */
export async function loadProjectContextPack(input: PackRequest): Promise<string> {
  const { isGoal, packInput, injectionMode, injectionTemplate } = await gatherPack(input);
  // 对话注入三态：off = 不注入；custom = 按模板（空模板 fail-open 回自动）。
  // goal 包（开工任务书/验收后写入/编程车道目标）不经过这里，保持验收合同行。
  if (!isGoal && injectionMode === "off") return "";
  if (!isGoal && injectionMode === "custom" && injectionTemplate) {
    return renderSessionInjection(injectionTemplate, packInput);
  }
  return renderProjectContextPack(packInput);
}

/** 对话注入分段编辑器的逐段内容：每个占位符在这个项目下此刻会填进去什么（会话包口径）。 */
export async function loadSessionTemplateValues(input: {
  name: string;
  path: string;
  workMode?: string | null;
}): Promise<Record<string, string>> {
  const { packInput } = await gatherPack({ ...input, kind: "session" });
  return sessionTemplateValues(packInput);
}
