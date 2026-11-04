import { FolderOpen, FolderPlus, Sparkles } from "lucide-react";
import type { ContextMenuItem } from "./context-menu";
import { useAppStore } from "./store";

/**
 * 「新项目」三条路（2026-10-27 侧栏顶部「新项目」起共用）：侧栏顶部按钮的菜单、项目树空态、命令面板、⇧⌘N 都走这里。
 * 三个弹层的逻辑在项目页（常驻挂载），经一次性请求触发。新建 / 添加已有文件夹的弹窗挂到 body 上、就地弹出，
 * 不先切页——切过去背景会露出上次选中的项目，像跳进了别的项目（2026-11-04 用户反馈）；建好后才切到项目页选中新项目。
 * 示例课题是一键直接建，建完就要看它，仍先切页。
 */
export function openNewProject() {
  useAppStore.getState().setNewProjectOpenReq({ token: Date.now() });
}

export function openAddExistingFolder() {
  useAppStore.getState().setAddProjectOpenReq(Date.now());
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
