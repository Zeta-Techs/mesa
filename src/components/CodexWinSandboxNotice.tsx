import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "./ConfirmDialog";
import { InlineNotice, inlineActionClass } from "./PageFrame";
import { IS_WINDOWS } from "../hotkeys";
import { useAppStore } from "../store";
import { toast } from "../toast";

/** 与 agent_specs.rs CodexWinSandboxDto 对应 */
export interface CodexWinSandboxState {
  applicable: boolean;
  userMode: string | null;
  consent: boolean;
  /** elevated / unelevated / null（命令会被 Codex 拦下） */
  effective: string | null;
}

/**
 * 开 Codex 的 Windows 沙箱之前给人看的话：按 2026-10-20 本机实测写（architecture §10 两端完善批第八条、本日追加条）。
 * 定时任务弹层与设置页共用这一份，确认了才写设置 codexWinSandboxConsent。
 */
export const CODEX_WIN_SANDBOX_EXPLAIN = [
  "让 Windows 上的定时任务用 Codex 自己的沙箱跑命令？",
  "",
  "· 不开的话，Codex 在无人值守时会把命令一律拦下：联网检索、下载这类事做不了，只能改文件。",
  "· 开了以后用的是 Codex 的「非提权」沙箱，不需要管理员权限，也不改 Codex 的配置文件，只对 Mesa 的定时任务生效。",
  "· Codex 第一次在某个定时任务的工作副本里跑命令前，会给副本里的每个文件加一条访问权限（让它的沙箱身份能修改）。文件越多越慢，实测第一次约 20–30 秒。只动 Mesa 给定时任务建的隔离副本，不动你的项目文件夹和 .git。",
  "· 沙箱里的命令只能写这个副本，写到别处会被拒绝；联网照常。",
  "· Codex 当前版本在这种模式下命令不从工作目录启动，Mesa 会在任务说明里要求它读写文件用绝对路径。",
  "· 随时可以在 设置 → AI 与 Agent 里关掉。你在 Codex 里自己开过沙箱的话，Mesa 直接用你的设置，这一项不起作用。",
].join("\n");

/** 弹确认框，确认了才写设置；返回是否已开启 */
export async function enableCodexWinSandbox(): Promise<boolean> {
  const ok = await confirmDialog(CODEX_WIN_SANDBOX_EXPLAIN, { confirmText: "开启" });
  if (!ok) return false;
  await useAppStore.getState().updateSettings({ codexWinSandboxConsent: true });
  toast("已开启：之后的定时任务里，Codex 会用它自己的 Windows 沙箱跑命令", "success");
  return true;
}

export function useCodexWinSandboxState(enabled: boolean): [CodexWinSandboxState | null, () => void] {
  const [state, setState] = useState<CodexWinSandboxState | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    invoke<CodexWinSandboxState>("codex_win_sandbox_state")
      .then((s) => !stale && setState(s))
      .catch(() => !stale && setState(null));
    return () => {
      stale = true;
    };
  }, [enabled, tick]);
  return [state, () => setTick((t) => t + 1)];
}

/**
 * 定时任务弹层里选了 Codex（Windows）时的提示：没开沙箱就说清楚会被拦、给「了解并开启」；
 * 开着的给一句现状和「关闭」。用户在 Codex 里自己配了沙箱时照他的，不再问
 */
export default function CodexWinSandboxNotice({ agent, fallback }: { agent: string; fallback: string | null }) {
  const applies = IS_WINDOWS && agent === "codex";
  const [state, refresh] = useCodexWinSandboxState(applies);
  const updateSettings = useAppStore((s) => s.updateSettings);
  if (!applies || !state?.applicable) {
    return fallback ? <InlineNotice tone="warn" className="mb-3">{fallback}</InlineNotice> : null;
  }
  if (state.effective === "elevated") return null;
  if (state.userMode === "unelevated") {
    return (
      <InlineNotice tone="warn" className="mb-3">
        Codex 用的是你配置的非提权沙箱：命令能跑，写文件时 Mesa 会要求它用绝对路径（Codex 的已知问题）
      </InlineNotice>
    );
  }
  if (state.effective === "unelevated") {
    return (
      <InlineNotice tone="info" className="mb-3">
        已按你的确认开 Codex 的 Windows 沙箱（非提权）：命令只写这个定时任务的隔离副本。
        <button
          type="button"
          className={`${inlineActionClass} ml-2`}
          onClick={() => {
            void updateSettings({ codexWinSandboxConsent: false }).then(refresh);
          }}
        >
          关闭
        </button>
      </InlineNotice>
    );
  }
  return (
    <InlineNotice tone="warn" className="mb-3">
      Codex 在 Windows 上没开沙箱：定时任务里的命令会被拦下（联网检索、下载跑不了），只能改文件。
      <button
        type="button"
        className={`${inlineActionClass} ml-2`}
        onClick={() => {
          void enableCodexWinSandbox().then((ok) => ok && refresh());
        }}
      >
        了解并开启
      </button>
    </InlineNotice>
  );
}
