import type { AgentCmdResult } from "./agent-install";

/** 更新命令成功退出且前后版本号相同（如 CLI 自更新提示「已是最新版本」） */
export function isAlreadyLatestResult(res: AgentCmdResult | null | undefined): boolean {
  return Boolean(res?.ok && res.versionBefore && res.versionAfter && res.versionBefore === res.versionAfter);
}

export type AgentNavUpdateState =
  | { kind: "uninstalled" }
  | { kind: "running"; action: "install" | "update"; label: "安装中" | "更新中"; title: string }
  | { kind: "done-ok"; alreadyLatest: boolean; label: "已安装" | "已最新" | "已更新"; title: string }
  | { kind: "done-err"; action: "install" | "update"; label: "安装失败" | "失败"; title: string }
  | { kind: "outdated"; latest: string | null; title: string }
  | { kind: "idle" };

export interface AgentNavUpdateInput {
  agentLabel: string;
  installed: boolean;
  updating: boolean;
  cmdKind?: "update" | "install";
  result?: AgentCmdResult;
  outdated: boolean;
  latest?: string | null;
}

/**
 * 连接页左栏 Agent 项右侧状态徽标：
 * 点击「新版 · N」开始更新后，左栏原地经历「更新中 → 已更新 · N（8s 后收归 N）」或「失败 · N」，
 * 用户切去别的 Agent 或留在当前页都能直接看到更新进度与完成提示。
 */
export function agentNavUpdateState(input: AgentNavUpdateInput): AgentNavUpdateState {
  const { agentLabel, installed, updating, cmdKind, result, outdated, latest } = input;
  if (updating) {
    const action = cmdKind ?? (installed ? "update" : "install");
    return {
      kind: "running",
      action,
      label: action === "install" ? "安装中" : "更新中",
      title:
        action === "install"
          ? `正在安装 ${agentLabel}，点击查看进度`
          : `正在更新 ${agentLabel}${latest ? ` 到 ${latest}` : ""}，点击查看进度`,
    };
  }
  if (result) {
    const action = cmdKind ?? (installed ? "update" : "install");
    if (result.ok) {
      const alreadyLatest = action === "update" && isAlreadyLatestResult(result);
      const ver = result.versionAfter;
      const label = action === "install" ? "已安装" : alreadyLatest ? "已最新" : "已更新";
      const title =
        action === "install"
          ? `${agentLabel} 已安装${ver ? `（${ver}）` : ""}`
          : alreadyLatest
            ? `${agentLabel} 已是最新版本${ver ? `（${ver}）` : ""}`
            : `${agentLabel} 已更新${
                result.versionBefore && ver
                  ? `（${result.versionBefore} → ${ver}）`
                  : ver
                    ? `到 ${ver}`
                    : ""
              }`;
      return { kind: "done-ok", alreadyLatest, label, title };
    }
    return {
      kind: "done-err",
      action,
      label: action === "install" ? "安装失败" : "失败",
      title: `${agentLabel} ${action === "install" ? "安装失败" : "更新失败"}，点击查看输出`,
    };
  }
  if (!installed) return { kind: "uninstalled" };
  if (outdated) {
    return {
      kind: "outdated",
      latest: latest ?? null,
      title: latest ? `有新版本 ${latest}，点击更新` : "有新版本，点击更新",
    };
  }
  return { kind: "idle" };
}

export type AgentHeaderUpdateState =
  | { kind: "install"; running: boolean }
  | { kind: "running"; label: "安装中…" | "更新中…" }
  | { kind: "done-ok"; label: "已安装" | "已是最新" | "已更新" }
  | { kind: "upstream-lag"; note: string; command: string }
  | { kind: "outdated"; latest: string | null; tuiPrefill: string | null }
  | { kind: "fallback-update"; label: "更新" | "重试"; tuiPrefill: string | null }
  | { kind: "hidden" };

export interface AgentHeaderUpdateInput {
  installed: boolean;
  installedVersion?: string | null;
  updating: boolean;
  cmdKind?: "update" | "install";
  result?: AgentCmdResult;
  info?: {
    latest: string | null;
    outdated: boolean;
  };
  /** 首次 check_agent_updates 是否已返回：未返回前不闪「更新」按钮 */
  updateCheckReady: boolean;
  /** 本次会话里已跑过更新且确认已是最新时的本机版本（离线或无查询口渠道在 8s 提示收起后不再挂回「更新」） */
  confirmedVersion?: string | null;
  tuiPrefill: string | null;
  upstreamNote: string | null;
  upstreamCommand: string | null;
}

/** 连接页右侧组头右上角的安装 / 更新状态与按钮推导 */
export function agentHeaderUpdateState(input: AgentHeaderUpdateInput): AgentHeaderUpdateState {
  const {
    installed,
    installedVersion,
    updating,
    cmdKind,
    result,
    info,
    updateCheckReady,
    confirmedVersion,
    tuiPrefill,
    upstreamNote,
    upstreamCommand,
  } = input;
  if (!installed) {
    return { kind: "install", running: updating };
  }
  if (updating) {
    return { kind: "running", label: cmdKind === "install" ? "安装中…" : "更新中…" };
  }
  if (result) {
    if (result.ok) {
      const alreadyLatest = cmdKind !== "install" && isAlreadyLatestResult(result);
      return {
        kind: "done-ok",
        label: cmdKind === "install" ? "已安装" : alreadyLatest ? "已是最新" : "已更新",
      };
    }
    return { kind: "fallback-update", label: "重试", tuiPrefill };
  }
  if (info?.outdated) {
    return { kind: "outdated", latest: info.latest, tuiPrefill };
  }
  const knownLatest = Boolean(info && !info.outdated && info.latest);
  const sessionConfirmed = Boolean(
    confirmedVersion &&
      (!installedVersion || confirmedVersion === installedVersion || confirmedVersion === "ok"),
  );
  if (knownLatest || sessionConfirmed) {
    if (upstreamNote && upstreamCommand) {
      return { kind: "upstream-lag", note: upstreamNote, command: upstreamCommand };
    }
    return { kind: "hidden" };
  }
  if (!updateCheckReady) {
    return { kind: "hidden" };
  }
  return { kind: "fallback-update", label: "更新", tuiPrefill };
}

/** 组头下方统一进度 / 结果卡的标题文案 */
export function agentCardHeadline(input: {
  agentLabel: string;
  cmdKind: "update" | "install";
  installedVersion?: string | null;
  targetVersion?: string | null;
  result?: AgentCmdResult;
}): { tone: "running" | "ok" | "err"; title: string } {
  const { agentLabel, cmdKind, installedVersion, targetVersion, result } = input;
  if (!result) {
    if (cmdKind === "install") {
      return { tone: "running", title: `正在安装 ${agentLabel}` };
    }
    const verSpan =
      installedVersion && targetVersion && installedVersion !== targetVersion
        ? `（${installedVersion} → ${targetVersion}）`
        : installedVersion
          ? `（当前 ${installedVersion}）`
          : "";
    return { tone: "running", title: `正在更新 ${agentLabel}${verSpan}` };
  }
  const methodPart = result.method && result.method !== "none" ? `（${result.method}）` : "";
  if (result.ok) {
    if (cmdKind === "install") {
      return {
        tone: "ok",
        title: `安装完成${methodPart}${result.versionAfter ? `：${result.versionAfter}` : ""}`,
      };
    }
    if (isAlreadyLatestResult(result)) {
      return {
        tone: "ok",
        title: `已是最新版本${methodPart}${result.versionAfter ? `：${result.versionAfter}` : ""}`,
      };
    }
    return {
      tone: "ok",
      title: `更新完成${methodPart}${
        result.versionAfter ? `：${result.versionBefore ?? "?"} → ${result.versionAfter}` : ""
      }`,
    };
  }
  return {
    tone: "err",
    title: `${cmdKind === "install" ? "安装失败" : "更新失败"}${methodPart}${
      result.versionAfter ? `：${result.versionBefore ?? "?"} → ${result.versionAfter}` : ""
    }`,
  };
}
