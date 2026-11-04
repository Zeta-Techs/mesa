/**
 * 工作台项目头下的「卡点」一行（2026-11-04 项目助手一期，docs/design-project-assistant.md §4）：
 * 把这个项目卡住的事合成最多三条，点哪条跳哪；旁边就是「问项目助手」。纯逻辑，配 tests/project-blockers.test.ts。
 * 只收「卡住了」的事：出错的步骤 / 目标、AI 在对话里自己说出了错、Mesa 近一天出的错、等你拍板的。工作副本开着没保存、落后基准这类是事实不是卡点。
 */
import type { CardTask, ProjectCard } from "./workbench-cards.ts";
import { latestRunFailure, type RunFailureInput } from "./run-failure.ts";
import { recentMesaErrors, type MesaErrorRecord } from "./mesa-errors.ts";

export interface ProjectBlocker {
  key: string;
  text: string;
  /** 出错（红）/ 等你（黄） */
  tone: "fail" | "wait";
  /** 点了去哪：开那一行的任务面板，或问项目助手（Mesa 出错没有别的去处） */
  target: { kind: "task"; taskId: string } | { kind: "assistant"; question: string };
}

export const BLOCKERS_SHOWN = 3;

export function projectBlockers(input: {
  card: Pick<ProjectCard, "tasks">;
  runs: readonly RunFailureInput[];
  mesaErrors: readonly MesaErrorRecord[];
  nowMs: number;
  isWindows?: boolean;
  /** 步骤那段对话里 AI 最后说的话像是出了错（session-tail.ts）：任务行 id → 那一句 */
  tailFailures?: Readonly<Record<string, string>>;
}): ProjectBlocker[] {
  const out: ProjectBlocker[] = [];
  const win = input.isWindows ?? false;
  const label = (t: CardTask) => (t.ref.kind === "step" ? `第 ${t.ref.stepIndex + 1} 步「${t.name}」` : `「${t.name}」`);
  for (const task of input.card.tasks) {
    // AI 自己在对话里说出了错（交互对话出错不进运行记录）：它不在干活时才算，正在干活的说不定马上就修好了
    const said = input.tailFailures?.[task.id];
    if (said && task.live?.attention !== "working") {
      out.push({ key: `said:${task.id}`, text: `${label(task)}的 AI 说：${said}`, tone: "fail", target: { kind: "task", taskId: task.id } });
      continue;
    }
    if (task.live) continue;
    if (task.ref.kind === "step" && task.ref.worktreePath) {
      const failure = latestRunFailure(input.runs, task.ref.worktreePath, win);
      if (failure) {
        out.push({ key: `fail:${task.id}`, text: `${label(task)}出错了：${failure.reason}`, tone: "fail", target: { kind: "task", taskId: task.id } });
        continue;
      }
    }
    if (task.ref.kind === "goal" && task.tone === "fail") {
      out.push({ key: `fail:${task.id}`, text: `目标${label(task)}${task.state}`, tone: "fail", target: { kind: "task", taskId: task.id } });
    }
  }
  // 只算你真看到过红色提示的：后台静默失败（轮询读不到文件之类）可能只是噪声，留给项目助手判断，不在卡点里催人
  const mesa = recentMesaErrors(input.mesaErrors, input.nowMs).filter((e) => !!e.notice);
  if (mesa.length > 0) {
    const times = mesa.reduce((n, e) => n + e.count, 0);
    const last = mesa[mesa.length - 1];
    const what = last.notice || last.message;
    out.push({
      key: "mesa",
      text: `Mesa 近一天在这个项目上报错 ${times} 次，最近一次：${what.length > 60 ? `${what.slice(0, 60)}…` : what}`,
      tone: "fail",
      target: { kind: "assistant", question: "Mesa 最近在这个项目上出的错是怎么回事？我该怎么办？" },
    });
  }
  for (const task of input.card.tasks) {
    if (task.queued) out.push({ key: `wait:${task.id}`, text: `${label(task)}等你拍板`, tone: "wait", target: { kind: "task", taskId: task.id } });
  }
  return out;
}
