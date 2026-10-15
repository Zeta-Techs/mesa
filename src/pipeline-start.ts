import { researchToolContractMatches } from "./research-tools";
import { appendUpstreamAcceptance, type UpstreamAcceptance } from "./research-acceptance";
import { invoke } from "@tauri-apps/api/core";
import { isGitMissingError } from "./dep-check";
import { decisionGate, orderedAnswers, parseDecisions } from "./step-decisions";
import {
  pickWorkspaceResume,
  shouldResumeWorkspaceSession,
} from "./workspace-resume";
import { DEFAULT_KICKOFF_PROMPT } from "./pipeline-presets";
import { renderTaskMd } from "./task-md";
export { renderTaskMd };
import type { KickoffLaunch } from "./kickoff-launch";
import type { PendingTerminal } from "./store";
import type {
  ArtifactEntryDto,
  BootstrapCommitDto,
  EnsureGitDto,
  ProjectConfigDto,
  ProjectStepDto,
  SessionMetaDto,
  SkillDto,
  WorkspaceDto,
} from "./types";

/** TASK.md 的提货单/技能元数据收集（best-effort，失败回落空）：开工确认弹层预览与实际开工共用 */
export async function gatherTaskMdExtras(
  projectPath: string,
  step: ProjectStepDto,
): Promise<{
  artifacts: ArtifactEntryDto[];
  skillMeta: Record<string, string> | undefined;
  providesByName: Record<string, string[]> | undefined;
  decisions: { q: string; answer: string }[];
  upstream: UpstreamAcceptance[];
}> {
  // 提货单：项目根已有上一步产物清单时带进 TASK.md（读取失败不阻断）
  let artifacts: ArtifactEntryDto[] = [];
  try {
    artifacts = await invoke<ArtifactEntryDto[]>("read_artifacts_manifest", {
      repoPath: projectPath,
    });
  } catch {
    /* 清单缺失或后端未就绪时跳过提货单段 */
  }
  // 步骤挂载技能（RX3b）：skills 非空时读库元数据渲染「本步骤推荐技能」段，
  // best-effort——库读取失败只列技能名，不阻断开步
  let skillMeta: Record<string, string> | undefined;
  let providesByName: Record<string, string[]> | undefined;
  if (step.skills.length > 0) {
    try {
      const lib = await invoke<SkillDto[]>("list_skills");
      skillMeta = Object.fromEntries(
        lib.map((skill) => [skill.name, skill.description]),
      );
      providesByName = Object.fromEntries(
        lib.map((skill) => [skill.name, skill.provides ?? []]),
      );
    } catch {
      /* 技能库不可读时只列技能名 */
    }
  }
  // 已定方向：答案存在任务书草稿里，拼装时读出来渲染成一段（读失败只是不带这段，不阻断开步）
  let decisions: { q: string; answer: string }[] = [];
  try {
    const d = await invoke<{ relPath: string; text: string | null }>(
      "read_task_draft",
      { projectRoot: projectPath, stepName: step.name },
    );
    decisions = orderedAnswers(
      step.decisions ?? [],
      parseDecisions(d?.text ?? ""),
    );
  } catch {
    /* 草稿不可读时跳过「已定方向」段 */
  }
  const upstream = await invoke<UpstreamAcceptance[]>("research_upstream_acceptances", { projectRoot: projectPath, stepName: step.name });
  return { artifacts, skillMeta, providesByName, decisions, upstream };
}

/** 只读预览用的一步到位拼装（步骤级「预览 TASK.md」入口）：与开工落盘同一出处
 *  （gatherTaskMdExtras + renderTaskMd），禁复制第二份拼装逻辑 */
export async function buildTaskMdPreview(
  projectPath: string,
  step: ProjectStepDto,
  cfg: ProjectConfigDto,
): Promise<string> {
  const { artifacts, skillMeta, providesByName, decisions, upstream } = await gatherTaskMdExtras(
    projectPath,
    step,
  );
  return appendUpstreamAcceptance(
    renderTaskMd(step, cfg, projectPath, artifacts, skillMeta, providesByName, decisions),
    upstream,
  );
}

/** 开工接驳决定（2026-10-13 双台账拍板）：accepted 且 paths 非空时，把积累面
 *  （流程正典清单 + 用户笔记，见 kickoff-dirty-gate 的接驳面判定）随开工提交进基准分支。
 *  由开工确认弹层随 onConfirm 第四参透传，调用链把它原样交给 startPipelineStep。 */
export interface IntakeBridgeDecision {
  accepted: boolean;
  /** 接驳面的仓库相对路径（弹层按 git_status 现算，只含仍脏的文件） */
  paths: string[];
}

/** 一键开步共享链路（§11.3 机制三）：ensure git → bootstrap 提交 → 建工作区 → 简报落成 TASK.md →
 *  run 脚本写入 → onOpenTerminal 预填启动。开工确认弹层与评审覆盖层「开始下一步」共用；
 *  组件态（starting/刷新）由调用方自持。硬失败抛错，best-effort 子步骤失败只经 onError 提示 */
export async function startPipelineStep({
  projectPath,
  step,
  cfg,
  taskMdOverride,
  onError,
  onOpenTerminal,
  launch,
  decisionPauseAcknowledged = false,
  intakeBridge,
}: {
  projectPath: string;
  step: ProjectStepDto;
  cfg: ProjectConfigDto;
  /** 开工确认弹层编辑区的最终内容（人编辑后的定稿）：非空时覆盖默认拼装，
      写盘仍是 write_workspace_task_md 单一路径 */
  taskMdOverride?: string;
  onError: (msg: string) => void;
  /** 开步完成后的终端交接；实现负责跳终端页并预填首条指令 */
  onOpenTerminal: (
    ws: WorkspaceDto,
    initialPrompt?: string,
    opts?: { autoStart?: boolean; launch?: KickoffLaunch },
  ) => void | Promise<void>;
  /** 弹层已选定的 Agent/连接：有 profile 时自动启动，不再让人去运行页点「启动」 */
  launch?: KickoffLaunch | null;
  /** soft_pause 的二次确认只允许推进不依赖未答决策的工作。 */
  decisionPauseAcknowledged?: boolean;
  /** 开工接驳决定：开工弹层「开工接驳」勾选态 + 积累面命中路径（无命中传 undefined） */
  intakeBridge?: IntakeBridgeDecision;
}): Promise<void> {
  const gate = decisionGate(step, taskMdOverride ?? "");
  if (gate.blocked) {
    throw new Error(`本步骤处于硬暂停，尚有未授权决策：${gate.missing.join("、")}`);
  }
  if (gate.needsAck && !decisionPauseAcknowledged) {
    throw new Error(`本步骤只允许准备或无依赖工作，请先确认：${gate.missing.join("、") || "仅允许准备"}`);
  }
  if (taskMdOverride?.trim() && !researchToolContractMatches(step, taskMdOverride)) {
    throw new Error("任务书工具合同与当前步骤不一致，请重新核对后开始；未覆盖已有草稿");
  }
  if (launch && step.skills.length > 0) {
    const checks = await invoke<{ name: string; detail: string; blocking: boolean }[]>("research_tool_preflight", {
      projectRoot: projectPath, stepName: step.name, agent: launch.agentId,
    });
    const blocked = checks.filter((c) => c.blocking);
    if (blocked.length) throw new Error(blocked.map((c) => `${c.name}：${c.detail}`).join("；"));
  }
  const upstream = await invoke<UpstreamAcceptance[]>("research_upstream_acceptances", { projectRoot: projectPath, stepName: step.name });
  if (taskMdOverride?.trim() && appendUpstreamAcceptance(taskMdOverride, upstream).trim() !== taskMdOverride.trim()) {
    throw new Error("上游科研验收记录或证据已变化，请重新打开开工确认并核对；未创建工作区或启动 Agent");
  }
  try {
    await invoke<EnsureGitDto>("ensure_git_repo", { path: projectPath });
  } catch (reason) {
    // git 缺失（如 macOS 新机未装 CLT）：走调用方既有错误面提示后中止开步，
    // 不再抛——错误串原样透出（isGitMissingError 可识别，诊断区/改动面板有一键安装）
    const msg = String(reason);
    if (isGitMissingError(msg)) {
      onError(msg);
      return;
    }
    throw reason;
  }
  // 档案卡/gitignore 自动提交为 best-effort（沿用 TASK.md 同款模式）：
  // git init 后 .ccode 与 .gitignore 未跟踪会被工作区合并的「主文件夹里还有没保存的改动」拦截；
  // 后端只提交这两个 Mesa 自有路径，用户文件绝不纳入，失败不阻断开步
  try {
    await invoke<BootstrapCommitDto>("commit_project_bootstrap", {
      repoPath: projectPath,
    });
  } catch (reason) {
    onError(`档案卡自动提交失败（不影响开步）：${String(reason)}`);
  }
  // 开工接驳：勾选且命中非空时，把积累面（清单/笔记）随开工提交进基准分支——
  // 在档案卡 bootstrap 之后、建工作区之前，新工作区从基准 HEAD 建树即带上这批积累与笔记。
  // best-effort：提交失败只提示（积累与笔记留在项目根未提交），不阻断开步
  if (intakeBridge?.accepted && intakeBridge.paths.length > 0) {
    try {
      await invoke("git_commit", {
        cwd: projectPath,
        // 固定提交信息（时序测试钉住）；不用模块常量——startPipelineStep 会被提取式
        // 单测在隔离上下文执行，模块级新标识符在那里不存在
        message: "Mesa: 开工接驳——积累清单与笔记并入基准（开工确认）",
        push: false,
        paths: intakeBridge.paths,
      });
    } catch (reason) {
      onError(`开工接驳提交失败（不影响开步，积累与笔记留在项目根未提交）：${String(reason)}`);
    }
  }
  const ws = await invoke<WorkspaceDto>("create_workspace", {
    repoPath: projectPath,
    name: step.workspaceName,
  });
  // 任务书是执行合同；写入失败保留工作区供排查，不得无合同启动 Agent。
  // taskMdOverride（开工确认弹层编辑区定稿）非空时覆盖默认拼装；否则按模板现拼
  let content: string;
  if (taskMdOverride?.trim()) {
    content = taskMdOverride;
  } else {
    const { artifacts, skillMeta, providesByName, decisions } = await gatherTaskMdExtras(
      projectPath,
      step,
    );
    content = renderTaskMd(
      step,
      cfg,
      projectPath,
      artifacts,
      skillMeta,
      providesByName,
      decisions,
    );
  }
  content = appendUpstreamAcceptance(content, upstream);
  try {
    await invoke("write_workspace_task_md", {
      worktreePath: ws.worktreePath,
      content,
    });
  } catch (reason) {
    throw new Error(`工作区「${ws.name}」已创建，但 TASK.md 写入失败，未启动 Agent；请修复任务书后再继续：${String(reason)}`);
  }
  // 积累账冻结（best-effort）：create_workspace 成功、任务书落盘后，把项目根
  // papers/reading-list.md 复制为工作区 .ccode/handoff-lit-intake.md——检索步按简报
  // 把这份开工定格副本当进料口；失败只提示（检索步回落按「项目根」绝对路径直读），不阻断开步
  try {
    await invoke("freeze_reading_list_intake", {
      projectRoot: projectPath,
      worktreePath: ws.worktreePath,
    });
  } catch (reason) {
    onError(`积累清单快照写入失败（不影响开步）：${String(reason)}`);
  }
  // 步骤预设的 run 脚本（P4 quarto 渲染等）落进项目层 .ccode/settings.toml：
  // 同名覆盖、其余键保留；best-effort 失败不阻断开步
  if (step.run.length > 0) {
    try {
      await invoke("upsert_project_run_scripts", {
        repoPath: projectPath,
        scripts: step.run,
      });
    } catch (reason) {
      onError(
        `工作区「${ws.name}」已创建，run 脚本写入失败：${String(reason)}`,
      );
    }
  }
  // 预填首条指令：跳到终端后用户确认配置点「启动」即自动注入，无需手动打字
  await onOpenTerminal(ws, DEFAULT_KICKOFF_PROMPT, {
    autoStart: Boolean(launch?.profileId),
    launch: launch ?? undefined,
  });
}

/** 工作区 → 终端的交接 payload：取端口段 env + 预填该目录上次使用的配置
 *  （与工作区页 useOpenInTerminal 同一语义；`ccode.wsLast.<worktreePath>` 为共享键）。
 *  始终带 reuseKey：同一工作区永远回到同一个终端标签（开工起的标签之后「去终端」能找回）。
 *  无 initialPrompt（「去终端看看」等纯查看入口）时自动 resume 该工作区最近会话。
 *  有 prompt 默认是新任务（开工/按意见重写），不 resume；
 *  `resumeSession: true`（评审「退回修改」）接回最近会话并把意见当下一轮输入。 */
export async function buildWorkspaceTerminalRequest(
  ws: WorkspaceDto,
  initialPrompt?: string,
  opts?: { autoStart?: boolean; launch?: KickoffLaunch; resumeSession?: boolean },
): Promise<PendingTerminal> {
  const pairs = await invoke<[string, string][]>("workspace_env_for", {
    worktreePath: ws.worktreePath,
  });
  const last = (() => {
    try {
      return JSON.parse(
        localStorage.getItem(`ccode.wsLast.${ws.worktreePath}`) ?? "{}",
      ) as Partial<{ agentId: string; profileId: string; model: string }>;
    } catch {
      return {};
    }
  })();
  const resume = shouldResumeWorkspaceSession({
    hasPrompt: Boolean(initialPrompt?.trim()),
    resumeSession: opts?.resumeSession,
  })
    ? await latestWorkspaceSession(ws)
    : null;
  return {
    cwd: ws.worktreePath,
    extraEnv: Object.fromEntries(pairs),
    title: ws.name,
    // resume 命中时以会话的 agent 为准（TerminalPage 的 resume 分支会自选 profile/model）；
    // 未命中按该目录上次使用的配置预填
    agentId: resume?.agentId ?? opts?.launch?.agentId ?? last.agentId,
    profileId: resume ? undefined : (opts?.launch?.profileId ?? last.profileId),
    model: resume ? undefined : (opts?.launch?.model ?? last.model),
    // 开工弹层的本次思考档覆盖（空 = 绑定默认）：随标签种子传递，launch 时经
    // pty_spawn effortOverride 注入，不写回绑定
    effort: opts?.launch?.effort ?? undefined,
    resume: resume ?? undefined,
    initialPrompt,
    autoStart: Boolean(opts?.autoStart && (opts.launch?.profileId || last.profileId)),
    reuseKey: workspaceReuseKey(ws),
  };
}

/** 工作区终端的复用键：开工/去终端/评审「开始下一步」共用同一口径 */
export function workspaceReuseKey(ws: WorkspaceDto): string {
  return `ws:${ws.worktreePath}`;
}

/** 该工作区最近一次的会话（resume 用）：纯筛选逻辑在 workspace-resume.ts（可测）。
 *  列表失败降级为不 resume（仍新开标签），不阻断「去终端」 */
async function latestWorkspaceSession(
  ws: WorkspaceDto,
): Promise<{ agentId: string; sessionId: string } | null> {
  try {
    const sessions = await invoke<SessionMetaDto[]>("list_sessions");
    return pickWorkspaceResume(sessions, ws.name, ws.repoPath);
  } catch {
    return null;
  }
}
