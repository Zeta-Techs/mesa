import { FolderOpen, FolderPlus, Sparkles } from "lucide-react";
import type { ContextMenuItem } from "./context-menu";
import { useAppStore } from "./store";

/**
 * 「新项目」三条路（2026-10-27 侧栏顶部「新项目」起共用）：侧栏顶部按钮的菜单、项目树空态、命令面板、⇧⌘N 都走这里。
 * 三个弹层都在项目页，经一次性请求触发，所以先切到项目页。
 */
export function openNewProject() {
  const s = useAppStore.getState();
  s.setPage("workspaces");
  s.setNewProjectOpenReq({ token: Date.now() });
}

export function openAddExistingFolder() {
  const s = useAppStore.getState();
  s.setPage("workspaces");
  s.setAddProjectOpenReq(Date.now());
}

export function openDemoProject() {
  const s = useAppStore.getState();
  s.setPage("workspaces");
  s.setDemoProjectOpenReq(Date.now());
}

export function projectAddMenuItems(): ContextMenuItem[] {
  return [
    {
      label: "新建项目…",
      icon: FolderPlus,
      title: "起个名字建一个新文件夹，定好工作方式后登记为项目",
      onSelect: openNewProject,
    },
    {
      label: "添加已有文件夹…",
      icon: FolderOpen,
      title: "把电脑上已有的文件夹登记为项目",
      onSelect: openAddExistingFolder,
    },
    {
      label: "创建示例课题",
      icon: Sparkles,
      hint: "演示",
      title: "在 文档/Mesa 示例课题 生成带演示数据的完整研究流程项目。以前建在「Ccode 示例课题」里的，再点仍打开那一份",
      onSelect: openDemoProject,
    },
  ];
}
