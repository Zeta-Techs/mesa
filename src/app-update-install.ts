import { useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";
import { confirmDialog } from "./components/ConfirmDialog";
import {
  DEV_UPDATE_PREVIEW_MARKER,
  isDevPreviewUpdate,
  nextPreviewVersion,
  type AppUpdateInstallPhase,
} from "./app-update";
import { useAppStore } from "./store";

/**
 * 应用更新的「下载并安装」：设置 → 更新、帮助菜单的更新弹窗与侧栏底部更新按钮共用。
 * 成功后 relaunch 进新版本；下载失败恢复按钮可重试。重启会杀掉后台无头任务，
 * 安装前先查一遍，有活着的任务必须用户明确点头。失败原因由各入口各自写在卡片里，这里不另弹提示。
 */

export interface UpdateInstallProgress {
  downloaded: number;
  total: number | null;
}

interface AppUpdateInstallSnapshot {
  installing: boolean;
  phase: AppUpdateInstallPhase | null;
  progress: UpdateInstallProgress | null;
  error: string | null;
}

// 多个入口共享同一份安装状态；模块级闸防同一进程里重复下载
let installInFlight = false;
let snapshot: AppUpdateInstallSnapshot = {
  installing: false,
  phase: null,
  progress: null,
  error: null,
};
const listeners = new Set<() => void>();

function setSnapshot(patch: Partial<AppUpdateInstallSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AppUpdateInstallSnapshot {
  return snapshot;
}

/** 后台重查更新时避开正在下载安装的那次（重查会关掉旧的更新句柄） */
export function isAppUpdateInstallInFlight(): boolean {
  return installInFlight;
}

// 下载块很碎（几十 MB 上千个事件），进度最多每 100ms 刷一次界面
const PROGRESS_PAINT_MS = 100;

let devPreviewTimer: number | null = null;

function stopDevPreviewTimer() {
  if (devPreviewTimer !== null) {
    window.clearInterval(devPreviewTimer);
    devPreviewTimer = null;
  }
}

function createDevPreviewUpdate(currentVersion: string): Update {
  const version = nextPreviewVersion(currentVersion);
  const mock = {
    [DEV_UPDATE_PREVIEW_MARKER]: true,
    rid: -1,
    available: true,
    currentVersion,
    version,
    date: new Date().toISOString(),
    body: [
      "### 新功能",
      "- 侧栏底部最右侧新增可更新快捷按钮，点击原地打开更新窗口",
      "- 侧栏按钮、更新弹窗与设置页实时同步下载 / 安装 / 重启进度",
      "",
      "### 开发版预览说明",
      "- 当前为开发版（热更新窗口）模拟更新，点击「下载并安装」仅演示进度动画，不会真的下载、停终端或重启。",
    ].join("\n"),
    rawJson: {},
    download: async () => {},
    install: async () => {},
    downloadAndInstall: async () => {},
    close: async () => {},
  };
  return mock as unknown as Update;
}

/** 仅开发版可用：开关「发现新版本」完整预览（点亮侧栏底部更新按钮、帮助菜单绿点、收件箱与弹窗） */
export async function setDevUpdatePreview(on: boolean): Promise<void> {
  if (!import.meta.env.DEV) return;
  if (!on) {
    stopDevPreviewTimer();
    installInFlight = false;
    setSnapshot({ installing: false, phase: null, progress: null, error: null });
    useAppStore.setState({
      appUpdate: null,
      appUpdateStatus: "dev",
      appUpdateError: null,
    });
    return;
  }
  const currentVersion = (await getVersion().catch(() => "")) || "0.2.2";
  const mock = createDevPreviewUpdate(currentVersion);
  useAppStore.setState({
    appUpdate: mock,
    appUpdateStatus: "available",
    appUpdateError: null,
  });
}

function runDevPreviewInstall() {
  stopDevPreviewTimer();
  installInFlight = true;
  const total = 48 * 1024 * 1024;
  const t0 = performance.now();
  setSnapshot({
    installing: true,
    phase: "downloading",
    progress: { downloaded: 0, total: null },
    error: null,
  });
  const tick = () => {
    const t = performance.now() - t0;
    if (t < 1600) {
      setSnapshot({
        installing: true,
        phase: "downloading",
        progress: { downloaded: 0, total: null },
      });
    } else if (t < 7600) {
      setSnapshot({
        installing: true,
        phase: "downloading",
        progress: { downloaded: Math.round(total * ((t - 1600) / 6000)), total },
      });
    } else if (t < 9800) {
      setSnapshot({
        installing: true,
        phase: "installing",
        progress: { downloaded: total, total },
      });
    } else if (t < 11600) {
      setSnapshot({
        installing: true,
        phase: "restarting",
        progress: { downloaded: total, total },
      });
    } else {
      stopDevPreviewTimer();
      installInFlight = false;
      setSnapshot({ installing: false, phase: null, progress: null });
    }
  };
  tick();
  devPreviewTimer = window.setInterval(tick, 120);
}

export async function startAppUpdateInstall(): Promise<void> {
  const update = useAppStore.getState().appUpdate;
  if (!update || snapshot.installing || installInFlight) return;
  if (import.meta.env.DEV && isDevPreviewUpdate(update)) {
    runDevPreviewInstall();
    return;
  }
  try {
    const active = await invoke<{ agent: string; taskRef: string | null }[]>(
      "active_background_runs",
    );
    if (active.length > 0) {
      const first = active[0];
      const label = first.taskRef || first.agent || "后台任务";
      const ok = await confirmDialog(
        `有 ${active.length} 个后台任务正在运行（如「${label}」），仍要现在更新？\n\n` +
          "更新后 Mesa 会重启，这些任务会被中断。",
        { danger: true, confirmText: "仍然安装", focusCancel: true },
      );
      if (!ok) return;
    }
  } catch {
    // 查询失败不拦更新：用户主动点的安装，别因诊断性查询挂掉主流程
  }
  installInFlight = true;
  setSnapshot({
    installing: true,
    phase: "downloading",
    progress: { downloaded: 0, total: null },
    error: null,
  });
  let stopped = false;
  let downloaded = 0;
  let total: number | null = null;
  let lastPaint = 0;
  const paint = (force: boolean) => {
    const now = performance.now();
    if (!force && now - lastPaint < PROGRESS_PAINT_MS) return;
    lastPaint = now;
    setSnapshot({ progress: { downloaded, total } });
  };
  try {
    // 先下载：这一步失败什么都没动，终端照常，可以直接重试
    await update.download((ev) => {
      if (ev.event === "Started") {
        total = ev.data.contentLength ?? null;
        paint(true);
      } else if (ev.event === "Progress") {
        downloaded += ev.data.chunkLength;
        paint(false);
      } else if (ev.event === "Finished") {
        if (total) downloaded = total;
        paint(true);
      }
    });
    setSnapshot({ phase: "installing" });
    // 下完再做退出收尾：更新后的重启与 Windows 安装包都绕过正常退出那一套（lib.rs prepare_app_exit）。
    // 各标签先存一版回放，给落盘留出与关窗链路相同的时间，再让后端停终端、后台任务和聊天旁路服务
    window.dispatchEvent(new CustomEvent("mesa:save-terminal-replays"));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await invoke("prepare_app_exit");
    stopped = true;
    // Windows 上 install 拉起安装包后进程就退出，走不到 relaunch
    await update.install();
    setSnapshot({ phase: "restarting" });
    // 重启是先起新进程再退旧进程：先放掉单实例锁，否则新进程以为已有 Mesa 在开、自己退出
    await invoke("release_single_instance");
    await relaunch();
  } catch (e) {
    const message = stopped
      ? `${String(e)}。终端和后台任务已经停下，请退出并重新打开 Mesa 后再试`
      : String(e);
    setSnapshot({
      error: message,
      installing: false,
      phase: null,
    });
  } finally {
    installInFlight = false;
  }
}

export function useAppUpdateInstall() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snap, install: startAppUpdateInstall };
}
