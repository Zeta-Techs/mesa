import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirmDialog } from "./components/ConfirmDialog";
import { useAppStore } from "./store";
import { toast } from "./toast";

/**
 * 应用更新的「下载并安装」：设置 → 更新与帮助菜单的更新弹窗共用。
 * 成功后 relaunch 进新版本；下载失败恢复按钮可重试。重启会杀掉后台无头任务，
 * 安装前先查一遍，有活着的任务必须用户明确点头。
 */

export interface UpdateInstallProgress {
  downloaded: number;
  total: number | null;
}

// 两个入口各持一份 hook 状态；模块级闸防同一进程里重复下载
let installInFlight = false;

export function useAppUpdateInstall(onError?: (message: string) => void) {
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateInstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function install() {
    const update = useAppStore.getState().appUpdate;
    if (!update || installing || installInFlight) return;
    try {
      const active = await invoke<{ agent: string; taskRef: string | null }[]>(
        "active_background_runs",
      );
      if (active.length > 0) {
        const first = active[0];
        const label = first.taskRef || first.agent || "后台任务";
        const ok = await confirmDialog(
          `有 ${active.length} 个后台任务正在运行（如「${label}」）。\n\n` +
            "更新安装完成后应用会重启，这些任务会被直接中断，未保存的进度会丢失。\n\n" +
            "可以先去「后台任务」停止它们再更新。仍要现在安装？",
          { danger: true, confirmText: "仍然安装", focusCancel: true },
        );
        if (!ok) return;
      }
    } catch {
      // 查询失败不拦更新：用户主动点的安装，别因诊断性查询挂掉主流程
    }
    installInFlight = true;
    setInstalling(true);
    setProgress({ downloaded: 0, total: null });
    setError(null);
    let stopped = false;
    try {
      // 先下载：这一步失败什么都没动，终端照常，可以直接重试
      await update.download((ev) => {
        if (ev.event === "Started") {
          setProgress({ downloaded: 0, total: ev.data.contentLength ?? null });
        } else if (ev.event === "Progress") {
          setProgress((prev) => ({
            downloaded: (prev?.downloaded ?? 0) + ev.data.chunkLength,
            total: prev?.total ?? null,
          }));
        } else if (ev.event === "Finished") {
          setProgress((prev) => ({
            downloaded: prev?.total ?? prev?.downloaded ?? 0,
            total: prev?.total ?? null,
          }));
        }
      });
      // 下完再做退出收尾：更新后的重启与 Windows 安装包都绕过正常退出那一套（lib.rs prepare_app_exit）。
      // 各标签先存一版回放，给落盘留出与关窗链路相同的时间，再让后端停终端、后台任务和聊天旁路服务
      window.dispatchEvent(new CustomEvent("mesa:save-terminal-replays"));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await invoke("prepare_app_exit");
      stopped = true;
      // Windows 上 install 拉起安装包后进程就退出，走不到 relaunch
      await update.install();
      await relaunch();
    } catch (e) {
      const message = stopped
        ? `${String(e)}。终端和后台任务已经停下，请退出并重新打开 Mesa 后再试`
        : String(e);
      setError(message);
      onError?.(message);
      toast(`更新安装失败：${message}`, "error");
      setInstalling(false);
    } finally {
      installInFlight = false;
    }
  }

  return { installing, progress, error, install };
}
