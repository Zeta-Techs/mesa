/**
 * 开一轮之前把项目最新内容并进这一步的工作副本（2026-11-06 流程贯通 §3，design-flow-weave.md）：
 * 继续、新开一轮、退回补料、跟进、项目助手派活接回都先走这里——那一步的 AI 拿到的是项目最新的笔记、大纲，
 * 不是它上次留下的旧文件。并入成功由后端记一行 sync（step_loop::record_sync），「待跟进」按最后一次并入判。
 * 落后才并；AI 正在干活或等确认时不并（会改它手下的文件）；工作副本有没提交的文件先点名问人。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store";
import { IS_WINDOWS } from "./hotkeys";
import { stepAttention } from "./run-overview";
import { followupFiles } from "./step-loop";
import type { GitFileDto, WorkspaceDto, WorkspaceHealthDto } from "./types";

export type ConfirmFn = (message: string, opts: { confirmText: string }) => Promise<boolean>;

/** 这一步的 AI 此刻是不是在干活 / 等确认（是就不能并入） */
export function stepBusy(ws: WorkspaceDto): boolean {
  const a = stepAttention(ws, useAppStore.getState().terminalRunInputs, IS_WINDOWS);
  return a === "working" || a === "confirm";
}

/** 工作副本落后于项目吗：落后就返回要并进来的有效文件（过程文件不算），不落后返回 null */
export async function incomingFor(ws: WorkspaceDto): Promise<string[] | null> {
  const h = await invoke<WorkspaceHealthDto>("workspace_health", { id: ws.id });
  if (!h.behind) return null;
  const files = await invoke<string[]>("workspace_incoming", { id: ws.id }).catch(() => [] as string[]);
  return followupFiles(files);
}

/** 并入前工作副本必须干净（git merge 拒绝脏树）：有没提交的文件点名问一句，一起提交进这一步再继续。返回 false = 人取消了 */
export async function commitLeftovers(ws: WorkspaceDto, stepName: string, confirm: ConfirmFn, next = "开新一轮"): Promise<boolean> {
  const status = await invoke<{ files: GitFileDto[] }>("git_status", { cwd: ws.worktreePath });
  if (status.files.length === 0) return true;
  const shown = status.files.slice(0, 6).map((f) => `· ${f.path}`);
  if (status.files.length > 6) shown.push(`· …另有 ${status.files.length - 6} 个`);
  const ok = await confirm(
    `「${stepName}」的工作副本里有 ${status.files.length} 个文件改了还没提交：\n${shown.join("\n")}\n\n` +
      `多半是上一轮 AI 写了没提交。一起提交进这一步再${next}？这一轮评审时会一起看到，不想要的到时退回或勾掉。`,
    { confirmText: "一起提交，继续" },
  );
  if (!ok) return false;
  await invoke("git_commit", {
    cwd: ws.worktreePath,
    message: `${next}前提交上一轮留下的改动`,
    push: false,
    paths: null,
  });
  return true;
}

/** 把项目最新内容并进这一步；冲突时说清去哪处理（冲突现场留在工作副本，那一步的评审入口会变成「去处理冲突」） */
export async function syncStep(ws: WorkspaceDto, stepName: string): Promise<void> {
  try {
    await invoke("workspace_sync_base", { id: ws.id, restart: false });
  } catch (reason) {
    const text = String(reason);
    if (text.includes("冲突")) {
      throw new Error(
        `把项目里的最新内容并进「${stepName}」时，有文件两边都改过、冲突了。到「${stepName}」这一步点「去处理冲突」，逐个文件选用哪一版，处理完再回来。`,
      );
    }
    throw reason;
  }
}

/**
 * 开一轮前的并入：不落后什么都不做；落后就（AI 在忙时报错）→ 问没提交的 → 并入。
 * 返回并进来的有效文件（给开场指令用，可能为空）；人取消返回 null。next = 弹窗里说接下来做什么。
 */
export async function bringLatest(
  ws: WorkspaceDto,
  stepName: string,
  confirm: ConfirmFn,
  next = "开新一轮",
): Promise<string[] | null> {
  const incoming = await incomingFor(ws);
  if (incoming === null) return [];
  if (stepBusy(ws)) {
    throw new Error(`「${stepName}」的 AI 正在干活或等你确认，这时不能把项目里的新内容并进去：等它这一轮停下再来。`);
  }
  if (!(await commitLeftovers(ws, stepName, confirm, next))) return null;
  await syncStep(ws, stepName);
  return incoming;
}
