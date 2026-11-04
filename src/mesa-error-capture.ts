/**
 * Mesa 出错记录的安装（2026-11-04，docs/design-project-assistant.md §3）：Mesa 自己出的错原来只闪一下红色提示、
 * 不留任何记录，用户和项目助手都无从知道。这里在一个地方接住**所有**失败的后台调用（tauri-core-shim.ts 的钩子，
 * 不改 140 多处调用点），按参数里的路径归到项目，记进配置目录；紧跟着弹出的红色提示补到同一条上
 * （用户真正看到的那句）。归不到项目的不记（全局诊断日志照旧）。
 */
import { rawInvoke, setInvokeFailureHook } from "./tauri-core-shim";
import type { ProjectDto, WorkspaceDto } from "./types";
import { IS_WINDOWS } from "./hotkeys";
import { addToastActions, subscribeToasts } from "./toast";
import { useAppStore } from "./store";
import { attributeProject, errorText, isRoutineFailure, shouldRecordFailure, type ProjectRootIndex } from "./mesa-errors";

const INDEX_TTL_MS = 60_000;
/** 红色提示与后台失败相隔多久内算同一件事 */
const NOTICE_WINDOW_MS = 3_000;
const THROTTLE_MS = 10 * 60_000;

let installed = false;

export function installMesaErrorCapture() {
  if (installed) return;
  installed = true;

  let index: ProjectRootIndex = { roots: [], worktrees: [] };
  let indexAt = 0;
  let indexing: Promise<void> | null = null;
  const refreshIndex = (): Promise<void> => {
    if (indexing) return indexing;
    if (Date.now() - indexAt < INDEX_TTL_MS) return Promise.resolve();
    indexing = Promise.all([
      rawInvoke<ProjectDto[]>("list_projects").catch(() => [] as ProjectDto[]),
      rawInvoke<WorkspaceDto[]>("list_workspaces").catch(() => [] as WorkspaceDto[]),
    ])
      .then(([projects, workspaces]) => {
        index = {
          roots: projects.map((p) => p.path),
          worktrees: workspaces.map((w) => ({ path: w.worktreePath, root: w.repoPath })),
        };
        indexAt = Date.now();
      })
      .finally(() => {
        indexing = null;
      });
    return indexing;
  };

  /** 最近一次后台失败（等红色提示来配对）；例行的「没找到」先不落盘，配上提示才记 */
  let lastFailure: { project: string; command: string; message: string; at: number; recorded: boolean } | null = null;
  /** 归属还没查完提示就先到了：先存着，查完一起记 */
  let pendingNotice: { message: string; at: number; id: number } | null = null;

  /** 归到项目的红色报错上补一个「问问为什么」：带着这次出错打开项目助手（2026-11-04） */
  const offerAsk = (toastId: number, project: string, command: string, message: string, notice: string) => {
    addToastActions(toastId, [
      {
        label: "问问为什么",
        onClick: () =>
          useAppStore.getState().openAssistant(project, "刚才这个报错是怎么回事？是谁的问题，我该怎么办？", {
            title: "刚才弹出的红色报错",
            detail: `你看到的提示：${notice}\n后台调用 ${command} 失败：${message}`,
          }),
      },
    ]);
  };
  /** 同一处错 10 分钟内只送一次后端（后端也会合并，这里省掉一次次写盘） */
  const lastSent = new Map<string, number>();

  const record = (project: string, source: string, command: string, message: string, notice?: string) => {
    rawInvoke("mesa_error_record", { projectRoot: project, source, command, message, notice: notice ?? null }).catch(
      () => {},
    );
  };

  setInvokeFailureHook((cmd, args, error) => {
    if (!shouldRecordFailure(cmd, error)) return;
    const failedAt = Date.now();
    const message = errorText(error);
    void refreshIndex()
      .then(() => {
        const project = attributeProject(args, index, IS_WINDOWS);
        if (!project) return;
        const notice = pendingNotice && Math.abs(pendingNotice.at - failedAt) <= NOTICE_WINDOW_MS ? pendingNotice : null;
        pendingNotice = null;
        if (notice) {
          lastFailure = null;
          record(project, "invoke", cmd, message, notice.message);
          offerAsk(notice.id, project, cmd, message, notice.message);
          return;
        }
        const routine = isRoutineFailure(message);
        const key = `${project}\n${cmd}\n${message}`;
        const throttled = failedAt - (lastSent.get(key) ?? 0) < THROTTLE_MS;
        const recorded = !routine && !throttled;
        if (recorded) {
          lastSent.set(key, failedAt);
          if (lastSent.size > 200) lastSent.clear();
          record(project, "invoke", cmd, message);
        }
        lastFailure = { project, command: cmd, message, at: failedAt, recorded };
      })
      .catch(() => {});
  });

  subscribeToasts((notice) => {
    if (notice.tone !== "error") return;
    const failure = lastFailure;
    if (!failure || Date.now() - failure.at > NOTICE_WINDOW_MS) {
      pendingNotice = { message: notice.message, at: Date.now(), id: notice.id };
      return;
    }
    lastFailure = null;
    offerAsk(notice.id, failure.project, failure.command, failure.message, notice.message);
    if (!failure.recorded) {
      // 例行失败 / 刚记过的这一回配上了红色提示：用户确实看到了，连原因一起记
      record(failure.project, "invoke", failure.command, failure.message, notice.message);
      return;
    }
    // 稍等一下，让后台失败那条先落盘，提示才补得上
    setTimeout(() => record(failure.project, "toast", "", "", notice.message), 300);
  });
}
