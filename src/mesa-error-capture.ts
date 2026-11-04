/**
 * Mesa 出错记录的安装（2026-11-04，docs/design-project-assistant.md §3）：Mesa 自己出的错原来只闪一下红色提示、
 * 不留任何记录，用户和项目助手都无从知道。这里在一个地方接住**所有**失败的后台调用（tauri-core-shim.ts 的钩子，
 * 不改 140 多处调用点），按参数里的路径归到项目，记进配置目录；紧跟着弹出的红色提示补到同一条上
 * （用户真正看到的那句）。归不到项目的不记（全局诊断日志照旧）。
 */
import { rawInvoke, setInvokeFailureHook } from "./tauri-core-shim";
import type { ProjectDto, WorkspaceDto } from "./types";
import { IS_WINDOWS } from "./hotkeys";
import { subscribeToasts } from "./toast";
import { attributeProject, errorText, shouldRecordFailure, type ProjectRootIndex } from "./mesa-errors";

const INDEX_TTL_MS = 60_000;
/** 红色提示与后台失败相隔多久内算同一件事 */
const NOTICE_WINDOW_MS = 3_000;

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

  /** 最近一次记下的后台失败（等红色提示来配对） */
  let lastFailure: { project: string; at: number } | null = null;
  /** 归属还没查完提示就先到了：先存着，查完一起记 */
  let pendingNotice: { message: string; at: number } | null = null;

  const record = (project: string, source: string, command: string, message: string, notice?: string) => {
    rawInvoke("mesa_error_record", { projectRoot: project, source, command, message, notice: notice ?? null }).catch(
      () => {},
    );
  };

  setInvokeFailureHook((cmd, args, error) => {
    if (!shouldRecordFailure(cmd, error)) return;
    const failedAt = Date.now();
    void refreshIndex()
      .then(() => {
        const project = attributeProject(args, index, IS_WINDOWS);
        if (!project) return;
        const notice = pendingNotice && Math.abs(pendingNotice.at - failedAt) <= NOTICE_WINDOW_MS ? pendingNotice : null;
        pendingNotice = null;
        lastFailure = notice ? null : { project, at: failedAt };
        record(project, "invoke", cmd, errorText(error), notice?.message);
      })
      .catch(() => {});
  });

  subscribeToasts((notice) => {
    if (notice.tone !== "error") return;
    if (!lastFailure || Date.now() - lastFailure.at > NOTICE_WINDOW_MS) {
      pendingNotice = { message: notice.message, at: Date.now() };
      return;
    }
    const project = lastFailure.project;
    lastFailure = null;
    // 稍等一下，让后台失败那条先落盘，提示才补得上
    setTimeout(() => record(project, "toast", "", "", notice.message), 300);
  });
}
