/**
 * Agent 安装的共用件：结果类型、失败诊断、缺安装工具时的指引，以及上手向导用的就地安装 hook。
 * 连接页自己的安装 / 更新流程仍在 ProfilesPage（并发更新、交互输入等与页面态耦合），只共用这里的纯函数。
 * 平台一律显式传 isWindows，不在模块内读。
 */
import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./store";

export interface AgentCmdResult {
  ok: boolean;
  output: string;
  method: string;
  versionBefore: string | null;
  versionAfter: string | null;
}

/** 失败诊断：按输出/方式文本给一条下一步建议，无匹配则不提示（纯函数，可单测） */
export function diagnose(output: string, method: string, isWindows: boolean): string | null {
  const lower = output.toLowerCase();
  if (
    method.includes("brew") &&
    (output.includes("formulae.brew.sh") || output.includes("Downloading"))
  ) {
    return "brew 元数据下载异常：先在系统终端跑 `brew doctor` 检查 brew 状态，或重试（会走 TUNA 镜像）";
  }
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    output.includes("Could not resolve") ||
    output.includes("Failed to connect")
  ) {
    return "网络连接问题：检查代理设置；如在国内网络，brew 已自动走国内镜像（元数据 TUNA、包体南大 ghcr 代理），npm 可配置 registry.npmmirror.com 镜像";
  }
  if (output.includes("EACCES") || lower.includes("permission denied")) {
    if (isWindows) {
      return "Windows 权限不足：请先安装 Node.js LTS 并重新打开 Mesa；若 Node.js 已安装，请确认 npm 全局目录可写，再重试。";
    }
    return "权限不足：该命令需要写入全局目录，检查安装目录权限";
  }
  if (output.includes("命令超时")) {
    return method.includes("npm")
      ? "npm 安装超过 15 分钟仍未完成，已自动终止：请检查 registry/代理设置后重试"
      : "命令超过 15 分钟未完成，已自动终止：通常是下载过慢，重试或检查网络";
  }
  return null;
}

/** Windows 上有官方 winget 包的 agent（与 agent_specs.rs 的 winget 字段同源，新增时同步） */
const WINGET_AGENTS = new Set(["claude-code", "codex", "opencode", "kimi", "grok"]);

export function installToolHelp(agentId: string, isWindows: boolean): string {
  if (isWindows) {
    if (agentId === "cursor") {
      return "Cursor CLI 在 Windows 上用官方的 PowerShell 安装器，但这台电脑找不到 PowerShell。也可以在 PowerShell 里手动运行：irm 'https://cursor.com/install?win32=true' | iex，装好后重新打开 Mesa。";
    }
    if (WINGET_AGENTS.has(agentId)) {
      return "未找到可用的安装工具：winget 与 Node.js 都不可用。该 agent 在 Windows 上有两条路——① 系统自带 winget：若被卸载，请在 Microsoft Store 安装「应用安装程序」；② 安装 Node.js LTS 走 npm 渠道（下载：https://nodejs.org/en/download）。完成后完全退出并重新打开 Mesa。";
    }
    return "未找到可用的安装工具：该 agent 在 Windows 上只能走 npm 渠道。请先安装 Node.js LTS（自带 npm），安装完成后完全退出并重新打开 Mesa 再重试。下载：https://nodejs.org/en/download";
  }
  return "未找到可用的安装工具。请先安装 Node.js（会同时提供 npm），然后完全退出并重新打开 Mesa 再重试。";
}

export interface AgentInstallEntry {
  running: boolean;
  output: string;
  result: AgentCmdResult | null;
}

/**
 * 上手向导的就地安装：先查将执行的命令（previews，null = 这台电脑没有可用安装工具），
 * 点安装即确认；先挂 agent-update-output/done-<id> 两事件再 invoke，结果以 done 事件为准、invoke 返回值兜底。
 * 装完刷新 detect（store.loadAll）。
 */
export function useAgentInstall() {
  const [entries, setEntries] = useState<Record<string, AgentInstallEntry>>({});
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const runningRef = useRef<Set<string>>(new Set());

  const patch = useCallback((id: string, part: Partial<AgentInstallEntry>) => {
    setEntries((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { running: false, output: "", result: null }), ...part },
    }));
  }, []);

  const loadPreviews = useCallback(async (ids: readonly string[]) => {
    const pairs = await Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await invoke<string | null>("install_method_preview", { agentId: id })] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    setPreviews((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
  }, []);

  const install = useCallback(
    async (agentId: string) => {
      if (runningRef.current.has(agentId)) return;
      runningRef.current.add(agentId);
      patch(agentId, { running: true, output: "", result: null });
      const unOut = await listen<string>(`agent-update-output-${agentId}`, (e) =>
        setEntries((prev) => ({
          ...prev,
          [agentId]: { ...prev[agentId]!, output: (prev[agentId]?.output ?? "") + e.payload },
        })),
      );
      let doneArrived = false;
      const unDone = await listen<AgentCmdResult>(`agent-update-done-${agentId}`, (e) => {
        doneArrived = true;
        patch(agentId, { result: e.payload });
      });
      try {
        const res = await invoke<AgentCmdResult>("install_agent", { agentId });
        if (!doneArrived) patch(agentId, { result: res });
      } catch (e) {
        if (!doneArrived)
          patch(agentId, {
            result: { ok: false, output: String(e), method: "", versionBefore: null, versionAfter: null },
          });
      } finally {
        unOut();
        unDone();
        runningRef.current.delete(agentId);
        patch(agentId, { running: false });
        await useAppStore.getState().loadAll();
      }
    },
    [patch],
  );

  return { entries, previews, loadPreviews, install };
}
