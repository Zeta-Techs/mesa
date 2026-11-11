/**
 * 项目页打开文件的唯一入口（2026-11-11 用户拍板「项目页的文件统一从侧边打开」）：本步文件、步骤卡里的论文 / 笔记、
 * 收尾包、文献雷达、资料列表都调 showProjectFile，开在右侧文件栏（ProjectFilePaneHost），不弹窗、不跳对话页、
 * 不切「文件」页签。单独成一个轻模块：调用方不必把预览组件（pdfjs 等）一起拉进来。
 */
import { useAppStore } from "./store";
import { pathWithin, samePath } from "./path-utils";
import { IS_WINDOWS } from "./hotkeys";
import { confirmDialog } from "./components/ConfirmDialog";
import type { ProjectFilePaneReq } from "./project-file-pane";

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

export async function showProjectFile(
  input: Omit<ProjectFilePaneReq, "nonce" | "root" | "name"> & { root?: string; name?: string },
): Promise<void> {
  const st = useAppStore.getState();
  const cur = st.projectFilePane;
  if (cur && !samePath(cur.path, input.path, IS_WINDOWS) && !(await confirmDiscardProjectFile())) return;
  // 读盘根：不给就用项目根；文件不在项目里（工作副本）退到它所在的文件夹
  const dir = input.path.replace(/[\\/][^\\/]*$/, "") || input.path;
  const root = input.root ?? (pathWithin(input.path, input.projectRoot, IS_WINDOWS) ? input.projectRoot : dir);
  st.openProjectFile({ ...input, root, name: input.name ?? input.path.split(/[\\/]/).pop() ?? input.path });
}
