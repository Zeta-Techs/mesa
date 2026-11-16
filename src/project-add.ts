import { useAppStore } from "./store";

/**
 * 「新项目」两条路（2026-10-27 侧栏顶部「新项目」起共用，2026-11-14 移除「创建示例课题」）：
 * 项目树空态、命令面板、⇧⌘N 都走这里。侧栏顶部「新项目」2026-11-16 起直接开新建弹窗（不再先弹两项菜单），
 * 「添加已有文件夹…」在新建弹窗底部左边。
 * 两个弹层的逻辑在项目页（常驻挂载），经一次性请求触发。新建 / 添加已有文件夹的弹窗挂到 body 上、就地弹出，
 * 不先切页——切过去背景会露出上次选中的项目，像跳进了别的项目（2026-11-04 用户反馈）；建好后才切到项目页选中新项目。
 */
export function openNewProject() {
  useAppStore.getState().setNewProjectOpenReq({ token: Date.now() });
}

export function openAddExistingFolder() {
  useAppStore.getState().setAddProjectOpenReq(Date.now());
}
