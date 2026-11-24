/**
 * 项目快照（2026-11-04 项目助手，docs/design-project-assistant.md §5）：把一个项目的现状写成一份给 AI 看的文本。
 * 纯函数，数据由 project-assistant-run.ts 用已有命令取齐后传进来；这里只管挑什么、怎么写、写多长。
 * 不放文献 / 数据 / 稿件正文，不放密钥（出站前后端还会整段脱敏），不放别的项目的东西。
 */
import { CHECK_STATUS_LABEL, checkSourceLabel, type CheckItem } from "./research-checks.ts";
import { mesaErrorLine, type MesaErrorRecord } from "./mesa-errors.ts";
import { isAppCrashClose, runFailureReason, type RunFailureInput } from "./run-failure.ts";

export interface SnapshotStep {
  index: number;
  name: string;
  brief: string;
  expectedArtifacts: readonly string[];
  acceptanceCriteria: readonly string[];
  /** 步进器同口径的状态短语（还没开始 / 进行中 / 待评审 / 已保存进项目 / 有冲突 / 出错了…） */
  state: string;
  worktreePath: string | null;
  failure: string | null;
  checks: readonly CheckItem[];
  reviewNotes: string | null;
  /** 这一步的人工事项完成情况（必做已完成/总数 + 没勾的项，另列可选未勾项） */
  humanTasks?: { done: number; total: number; pending: readonly string[]; optionalPending?: readonly string[] } | null;
  /** 这一步收尾「后续建议」里还没勾选处理的条目 */
  pendingNextActions?: readonly string[];
}

export interface SnapshotRun extends RunFailureInput {
  agent: string;
  taskKind: string;
  /** 这次运行是哪件事（第几步 / 哪个目标 / 对话），由调用方按路径对上 */
  where: string;
}

export interface SnapshotHelpItem {
  where: string;
  question: string;
  options: readonly string[];
  recommend: string | null;
}

export interface SnapshotDep {
  name: string;
  status: string;
  version: string | null;
  note?: string | null;
}

export interface SnapshotInput {
  now: string;
  mesaVersion: string;
  platform: string;
  project: {
    name: string;
    path: string;
    workMode: string | null;
    topic: string | null;
    settings: readonly string[];
    hasPipeline: boolean;
    defaultAgent: string | null;
  };
  steps: readonly SnapshotStep[];
  goals: readonly { name: string; status: string; outputPaths?: readonly string[] }[];
  runs: readonly SnapshotRun[];
  /** 重点那次运行的最后若干条事件（「问问为什么」带进来） */
  focus: { title: string; detail: string; events: readonly string[] } | null;
  failedRunEvents: readonly { where: string; events: readonly string[] }[];
  helpItems: readonly SnapshotHelpItem[];
  pendingMail: readonly string[];
  mesaErrors: readonly MesaErrorRecord[];
  appLog: readonly { ts: string; level: string; source: string; message: string }[];
  deps: readonly SnapshotDep[];
  agents: readonly { id: string; installed: boolean; version: string | null }[];
  decided: readonly string[];
  /** 研究档案（跨项目的个人偏好与历史，后端已带段头；设置里关掉时为空）——起草派活单时照顾，不当本项目事实 */
  profile?: string;
  /** 项目助手派过的活与现在的进度（「「修列名」交给第 2 步（留话）· 现在：在做」） */
  dispatched?: readonly string[];
  /** 各步最近那段对话里 AI 最后说的话（交互对话出错不进运行记录，靠这里补；第几步 → 末尾一段） */
  stepTails?: readonly { where: string; text: string; flagged: boolean }[];
  /** 全部流程完成后的完结产物、目标期刊与待核对清单 */
  closeout?: { finalFiles: readonly string[]; targetJournal?: string | null; pendingChecks?: readonly string[] } | null;
  /** 这个项目配置的定时任务与事件规则（含文献雷达） */
  schedules?: readonly { name: string; enabled: boolean; trigger: string; skill: string; status: string }[];
  /** 最近的多模型研讨结论（项目内研讨，方便接着起草派活单或记规矩） */
  consults?: readonly { title: string; updatedAt: string; summary: string }[];
  /** 项目根或非步骤目标对话里最近 AI 说的要点 */
  recentChats?: readonly { where: string; text: string }[];
}

const RUN_STATUS: Record<string, string> = {
  created: "已登记",
  starting: "启动中",
  running: "开着",
  completed: "正常结束",
  failed: "出错退出",
  stopped: "已停止",
};

function clip(text: string, max: number): string {
  const t = text.replace(/\s+\n/g, "\n").trim();
  return t.length > max ? `${t.slice(0, max)}…（已截断）` : t;
}

function section(title: string, lines: readonly string[], empty?: string): string {
  if (lines.length === 0) return empty ? `## ${title}\n${empty}` : "";
  return `## ${title}\n${lines.join("\n")}`;
}

export function runLine(run: SnapshotRun): string {
  const status = RUN_STATUS[run.status] ?? run.status;
  const why =
    run.status === "failed"
      ? isAppCrashClose(run)
        ? "：Mesa 上次异常退出，这次运行没能正常收尾（Mesa 的问题，不是这一步的）"
        : `：${runFailureReason(run)}`
      : run.status === "stopped" && run.closeReason
        ? `（${run.closeReason}）`
        : "";
  return `- ${run.createdAt} ${run.where} · ${run.agent} · ${status}${why}`;
}

/** 整份快照；maxChars 超了先砍运行事件和诊断日志，再砍更早的运行 */
export function buildProjectSnapshot(input: SnapshotInput, maxChars = 24000): string {
  const p = input.project;
  const head = [
    `# 项目快照（${input.now}，Mesa ${input.mesaVersion}，${input.platform}）`,
    `项目：${p.name}`,
    `路径：${p.path}`,
    `工作方式：${p.workMode ?? "未登记的目录"}${p.hasPipeline ? "，按流程步骤做" : "，没有流程步骤"}`,
    p.topic ? `课题：${clip(p.topic, 300)}` : "",
    p.defaultAgent ? `项目默认 Agent：${p.defaultAgent}` : "",
    p.settings.length ? `项目规则：\n${p.settings.slice(0, 12).map((s) => `- ${clip(s, 200)}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const stepLines = input.steps.map((s) => {
    const parts = [`### 第 ${s.index + 1} 步「${s.name}」：${s.state}`];
    if (s.failure) parts.push(`最近一次运行出错：${s.failure}`);
    if (s.brief) parts.push(`要做：${clip(s.brief, 300)}`);
    if (s.expectedArtifacts.length) parts.push(`应交：${s.expectedArtifacts.slice(0, 8).join("、")}`);
    if (s.acceptanceCriteria.length) parts.push(`怎样算做完：${s.acceptanceCriteria.slice(0, 5).map((c) => clip(c, 120)).join("；")}`);
    // 拦下的在前；Mesa 核对的是数出来的事实，带上位置和说明（2026-11-11 大纲核对），其余只写标题
    const flagged = s.checks
      .filter((c) => c.status !== "passed")
      .sort((a, b) => Number(a.status !== "blocked") - Number(b.status !== "blocked"));
    if (flagged.length) {
      const shown = flagged.slice(0, 12).map((c) => {
        const mesa = c.checker === "mesa";
        const at = c.target ? `（${c.target.file}${mesa && c.target.line ? `:${c.target.line}` : ""}）` : "";
        const detail = mesa && c.evidence?.detail ? `：${clip(c.evidence.detail, 160)}` : "";
        return `[${CHECK_STATUS_LABEL[c.status]}·${checkSourceLabel(c)}] ${clip(c.title, 120)}${at}${detail}`;
      });
      if (flagged.length > shown.length) shown.push(`另有 ${flagged.length - shown.length} 项`);
      parts.push(`核验：\n${shown.map((l) => `- ${l}`).join("\n")}`);
    }
    if (s.humanTasks && (s.humanTasks.total > 0 || (s.humanTasks.optionalPending?.length ?? 0) > 0)) {
      const h = s.humanTasks;
      const bits: string[] = [];
      if (h.total > 0) bits.push(`已完成 ${h.done}/${h.total}`);
      if (h.pending.length) bits.push(`待做：${h.pending.slice(0, 6).join("、")}`);
      if (h.optionalPending?.length) bits.push(`可选未勾：${h.optionalPending.slice(0, 4).join("、")}`);
      parts.push(`人工事项：${bits.join("；")}`);
    }
    if (s.pendingNextActions?.length) {
      parts.push(`未处理后续建议：${s.pendingNextActions.slice(0, 6).map((a) => clip(a, 100)).join("；")}`);
    }
    if (s.reviewNotes) parts.push(`评审退回意见：\n${clip(s.reviewNotes, 800)}`);
    return parts.join("\n");
  });

  const goalLines = input.goals.map(
    (g) => `- ${g.name}：${g.status}${g.outputPaths?.length ? `（交付：${g.outputPaths.slice(0, 4).join("、")}）` : ""}`,
  );
  const closeoutLines: string[] = [];
  if (input.closeout) {
    if (input.closeout.targetJournal) closeoutLines.push(`- 目标期刊：${clip(input.closeout.targetJournal, 120)}`);
    if (input.closeout.finalFiles.length) closeoutLines.push(`- 最终稿：${input.closeout.finalFiles.slice(0, 8).join("、")}`);
    if (input.closeout.pendingChecks?.length) {
      closeoutLines.push(`- 核对与投稿材料：${input.closeout.pendingChecks.slice(0, 8).join("、")}`);
    }
  }
  const scheduleLines = (input.schedules ?? []).slice(0, 10).map(
    (s) => `- ${s.name}（${s.enabled ? "已启用" : "已暂停"} · ${s.trigger}${s.skill ? ` · 技能 ${s.skill}` : ""}）：${clip(s.status, 120)}`,
  );
  const consultLines = (input.consults ?? []).slice(0, 3).map(
    (c) => `- ${c.title}（${c.updatedAt.slice(0, 10)}）：${clip(c.summary, 320)}`,
  );
  const chatLines = (input.recentChats ?? []).slice(0, 3).map(
    (c) => `- ${c.where}：${clip(c.text, 320)}`,
  );
  const helpLines = input.helpItems.map(
    (h) =>
      `- ${h.where}：${clip(h.question, 200)}${h.options.length ? `（选项：${h.options.slice(0, 5).join(" / ")}）` : ""}${
        h.recommend ? `；AI 建议：${clip(h.recommend, 120)}` : ""
      }`,
  );
  const mesaLines = input.mesaErrors.slice(-15).map((e) => `- ${mesaErrorLine(e)}`);
  const depLines = [
    ...input.deps.map((d) => `- ${d.name}：${d.status === "ok" ? `已就绪${d.version ? ` ${d.version}` : ""}` : `${d.status}${d.note ? `（${d.note}）` : ""}`}`),
    ...input.agents.map((a) => `- ${a.id}：${a.installed ? `已装${a.version ? ` ${a.version}` : ""}` : "没装"}`),
  ];
  // 与任务书、开对话同一份（project_memory_for_ai 已筛过失效条目、按字数封顶），这里不再另截
  const decidedLines = input.decided.map((d) => `- ${d}`);
  const dispatchedLines = (input.dispatched ?? []).slice(0, 6).map((d) => `- ${clip(d, 200)}`);
  const tailLines = (input.stepTails ?? []).map(
    (t) => `- ${t.where}${t.flagged ? "（像是在说出错 / 失败）" : ""}：${clip(t.text, 500)}`,
  );
  const mailLines = input.pendingMail.slice(0, 8).map((m) => `- ${clip(m, 160)}`);

  const focus = input.focus
    ? section("这次重点问的", [
        input.focus.title,
        input.focus.detail,
        ...(input.focus.events.length ? ["最后的运行事件：", ...input.focus.events.map((e) => `  ${clip(e, 300)}`)] : []),
      ])
    : "";

  // 可砍的部分：从最长到最短试，直到放得下
  const build = (opts: { events: boolean; log: boolean; runs: number; chats: boolean }) => {
    const eventLines = opts.events
      ? input.failedRunEvents.flatMap((f) => [`${f.where} 出错那次的最后几条事件：`, ...f.events.map((e) => `  ${clip(e, 240)}`)])
      : [];
    const logLines = opts.log
      ? input.appLog.slice(-20).map((l) => `- ${l.ts} [${l.level}] ${l.source}：${clip(l.message, 240)}`)
      : [];
    return [
      head,
      focus,
      section("流程步骤", stepLines, input.project.hasPipeline ? "（没读到步骤）" : undefined),
      section("完结产物与投稿收尾", closeoutLines),
      section("目标（含近期已完成目标的交付路径）", goalLines),
      section("定时任务与事件规则", scheduleLines),
      section("最近的运行（新在前）", input.runs.slice(0, opts.runs).map(runLine), "（还没有运行记录）"),
      section("出错运行的事件", eventLines),
      section("项目助手派过的活", dispatchedLines),
      section("各步最近对话里 AI 最后说的话（交互对话里的出错不进运行记录，看这里）", tailLines),
      opts.chats ? section("最近的多模型研讨", consultLines) : "",
      opts.chats ? section("项目内其他对话最近内容", chatLines) : "",
      section("等你回答的人工请求", helpLines),
      section("还没送到的留话", mailLines),
      section("Mesa 自己在这个项目上出的错（新在后）", mesaLines, "（没有记录）"),
      section("Mesa 诊断日志里和这个项目有关的警告 / 错误", logLines),
      section("环境", depLines),
      section("项目知识（人确认过的规矩，不要违背；「已定 / 不做」在前）", decidedLines),
      section("研究档案（这位研究者跨项目的习惯，起草派活单时照顾；不是本项目的事实）", input.profile?.trim() ? [clip(input.profile.trim(), 1800)] : []),
    ]
      .filter(Boolean)
      .join("\n\n");
  };
  const attempts = [
    { events: true, log: true, runs: 20, chats: true },
    { events: true, log: false, runs: 20, chats: true },
    { events: false, log: false, runs: 12, chats: true },
    { events: false, log: false, runs: 6, chats: false },
  ];
  for (const opts of attempts) {
    const text = build(opts);
    if (text.length <= maxChars) return text;
  }
  return clip(build(attempts[attempts.length - 1]), maxChars);
}
