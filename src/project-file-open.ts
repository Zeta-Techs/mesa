/**
 * 项目页打开文件的唯一入口（2026-11-11 用户拍板「项目页的文件统一从侧边打开」；2026-11-14 补独立新窗口对照）：
 * 本步文件、步骤卡里的论文 / 笔记、收尾包、文献雷达、资料列表都调 showProjectFile，默认开在右侧文件栏（ProjectFilePaneHost）；
 * 若用户已拆出独立文件查看窗口（file-viewer），普通文件与行号跳转自动同步到该独立窗口，不在主窗口叠抽屉。
 * 单独成一个轻模块：调用方不必把预览组件（pdfjs 等）一起拉进来。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store";
import { samePath } from "./path-utils";
import { IS_WINDOWS } from "./hotkeys";
import { confirmDialog } from "./components/ConfirmDialog";
import { openFileInWindow, resolveFileWindowTarget } from "./file-window-open";
import type { ProjectFilePaneReq } from "./project-file-pane";

export type OpenProjectFileInput = Omit<ProjectFilePaneReq, "nonce" | "root" | "name"> & {
  root?: string;
  name?: string;
};

/** 文件栏里有没保存的改动（文本编辑态）：换文件、关栏前要先问。文件栏宿主上报 */
let paneDirty = false;

export function setProjectFilePaneDirty(dirty: boolean): void {
  paneDirty = dirty;
}

/** 有没保存的改动时问一句；放弃了就当已干净 */
export async function confirmDiscardProjectFile(): Promise<boolean> {
  if (!paneDirty) return true;
  const ok = await confirmDialog("有未保存的改动，确定放弃？", { danger: true, confirmText: "放弃" });
  if (ok) paneDirty = false;
  return ok;
}

/** 在独立系统窗口打开或更新文件预览（笔记本窄屏、双屏对照审查意见时主窗口全宽看条目） */
export async function openProjectFileInWindow(input: OpenProjectFileInput): Promise<void> {
  await openFileInWindow(input);
}

export async function showProjectFile(input: OpenProjectFileInput): Promise<void> {
  if (!input.versions && !input.askAi) {
    const externalOpen = await invoke<boolean>("file_viewer_is_open").catch(() => false);
    if (externalOpen) {
      await openFileInWindow(input);
      return;
    }
  }
  const st = useAppStore.getState();
  const cur = st.projectFilePane;
  if (
    cur &&
    (!samePath(cur.path, input.path, IS_WINDOWS) || !!cur.versions !== !!input.versions) &&
    !(await confirmDiscardProjectFile())
  ) {
    return;
  }
  const { root, name } = resolveFileWindowTarget(input);
  st.openProjectFile({ ...input, root, name });
}
