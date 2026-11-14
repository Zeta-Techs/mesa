/**
 * 独立文件查看窗口（file-viewer）的通用打开入口：
 * 零 store / 零重组件依赖，供项目页右侧文件栏、项目「文件」页签、聊天/终端右侧文件区、
 * 文件树右键菜单、步骤审阅等任意文件查看场景复用。
 */
import { invoke } from "@tauri-apps/api/core";
import { armDraftHandoff } from "./file-draft-handoff";
import { IS_WINDOWS } from "./hotkeys";
import { pathWithin } from "./path-utils";
import type { ProjectFilePaneFile } from "./project-file-pane";

export interface OpenFileWindowInput {
  path: string;
  projectRoot?: string;
  root?: string;
  name?: string;
  rel?: string;
  list?: ProjectFilePaneFile[];
  line?: number;
  showList?: boolean;
  from?: string;
}

export function resolveFileWindowTarget(input: OpenFileWindowInput): {
  projectRoot: string;
  root: string;
  name: string;
} {
  const dir = input.path.replace(/[\\/][^\\/]*$/, "") || input.path;
  const fallbackProject = input.projectRoot ?? input.root ?? dir;
  const root =
    input.root ??
    (pathWithin(input.path, fallbackProject, IS_WINDOWS) ? fallbackProject : dir);
  const name = input.name ?? input.path.split(/[\\/]/).pop() ?? input.path;
  return { projectRoot: fallbackProject, root, name };
}

/** 在独立系统窗口打开或更新文件预览 */
export async function openFileInWindow(input: OpenFileWindowInput): Promise<void> {
  const { projectRoot, root, name } = resolveFileWindowTarget(input);
  await invoke("file_viewer_open", {
    state: {
      projectRoot,
      root,
      path: input.path,
      name,
      rel: input.rel,
      list: input.list,
      line: input.line,
      showList: input.showList,
      from: input.from,
      nonce: 0,
    },
  });
}

/** 将当前内嵌预览拆到独立系统窗口（自动通过 localStorage 交接未保存编辑草稿） */
export async function popOutFileToWindow(
  input: OpenFileWindowInput & {
    dirty?: boolean;
    onBeforeOpen?: () => void;
  },
): Promise<void> {
  if (input.dirty) armDraftHandoff(input.path);
  input.onBeforeOpen?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await openFileInWindow(input);
}
