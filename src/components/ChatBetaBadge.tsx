import { Flag, Info, ScrollText, SquareTerminal, TriangleAlert } from "lucide-react";
import { channelSourceNote, type ChatChannelSnapshot } from "../chat-channel";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import { chatFidelity, fidelityBadge, nativeFidelityNote, nativeRuntime, tierLabel } from "../chat-fidelity";
import { useCliNewer, useVerifiedVersion } from "../cli-verified";
import { IS_WINDOWS } from "../hotkeys";
import { ghostActionClass, rowActionClass } from "./PageFrame";

/**
 * 聊天层说明（2026-11-27 拍板：聊天模式默认原生且不再标「测试版」，兼容模式保留测试版标）：
 * 说清楚当前这一家在聊天里能做到哪一步、哪些事需要改用终端模式打开；本机 CLI 比 Mesa 核对过的新时多一句提醒。
 */
export function useChatBeta(agentId: string | null, nativeOn = false) {
  const fidelity = chatFidelity(agentId, IS_WINDOWS);
  const newer = useCliNewer(agentId);
  const badge = fidelityBadge(fidelity, newer, nativeOn);
  const runtime = nativeRuntime(agentId);
  const nativeNote = nativeOn && runtime ? nativeFidelityNote(agentId) : null;
  const isBeta = !nativeOn && Boolean(fidelity?.beta);
  const heading = nativeOn
    ? "原生聊天"
    : fidelity?.beta
      ? "聊天是测试版"
      : fidelity && fidelity.tier >= 3
        ? "这家的聊天是简化的"
        : "聊天层说明";
  // 模型菜单右上角提示符号悬停时的一句话（2026-11-16 用户：说明简洁显示在上面，不用再点进去）
  const summary = nativeOn
    ? nativeNote
      ? `已启用原生协议；${nativeNote.terminalOnly}需要改用终端模式打开。`
      : fidelity
        ? `已启用原生通道；${fidelity.terminalOnly}需要改用终端模式打开。`
        : "已启用原生聊天。"
    : `${heading}，以终端为准${fidelity ? `；${fidelity.terminalOnly}要回终端` : ""}。`;
  const warn = newer
    ? nativeOn
      ? "你装的 CLI 比 Mesa 核对过的新，原生协议若不兼容可改用终端模式打开。"
      : "你装的 CLI 比 Mesa 核对过的新，聊天里的确认按钮可能按不准。"
    : null;
  return { badge, isBeta, newer, heading, summary, warn };
}

/** 这段对话的原生状态与切回终端模式动作（2026-11-27 单一工作界面预设：不再在菜单内放开关，只提供回退动作） */
export interface NativeModeToggle {
  on: boolean;
  onToggle: (on: boolean) => void;
}

export function ChatBetaNotes({
  agentId,
  channel,
  live = false,
  native,
  onOpenTerminal,
  onSwitchToTerminalMode,
  onReportMismatch,
}: {
  agentId: string | null;
  channel?: ChatChannelSnapshot | null;
  live?: boolean;
  native?: NativeModeToggle | null;
  onOpenTerminal?: () => void;
  /** 本机 CLI 版本比核对过的新时，给用户一键「改用终端模式打开」的兜底按钮 */
  onSwitchToTerminalMode?: () => void;
  /** 「对不上？反馈」：带上两边当时的内容打开反馈表单（chat-mismatch.ts） */
  onReportMismatch?: () => void;
}) {
  const installed = useAppStore((s) => s.agents.find((a) => a.id === agentId)?.version ?? null);
  const fidelity = chatFidelity(agentId, IS_WINDOWS);
  const label = AGENTS.find((a) => a.id === agentId)?.label ?? "这家 Agent";
  const verified = useVerifiedVersion(agentId);
  const newer = useCliNewer(agentId);
  const runtime = nativeRuntime(agentId);
  const nativeOn = Boolean(native?.on);
  const runtimeOn = Boolean(nativeOn && runtime);
  const nativeNote = runtimeOn ? nativeFidelityNote(agentId) : null;
  const line = nativeNote
    ? `${nativeNote.terminalOnly}需要改用终端模式打开。`
    : nativeOn && fidelity
      ? `已启用原生通道；${fidelity.terminalOnly}需要改用终端模式打开。`
      : fidelity
        ? `以终端为准；${fidelity.terminalOnly}要回终端。`
        : "以终端为准。";
  const lineTitle = fidelity ? `${label} · ${tierLabel(fidelity.tier)}：${nativeNote?.source ?? fidelity.source}` : undefined;
  const switchTerminalAction = onSwitchToTerminalMode ?? (native ? () => native.onToggle(false) : undefined);
  // 实时通道断了 / 还在连：例外才说
  const channelIssue =
    live && channel && (channel.connection === "disconnected" || channel.connection === "connecting")
      ? channelSourceNote(channel)
      : null;
  return (
    <div className="px-1.5 pb-1.5 pt-1 text-xs">
      <div
        title={lineTitle}
        className="mt-0.5 flex items-start gap-2 px-1.5 text-xs leading-[19px] text-l3"
      >
        <Info size={13} strokeWidth={1.8} aria-hidden="true" className="mt-[3px] shrink-0 text-l4" />
        <p className="min-w-0 flex-1">{line}</p>
      </div>
      {(channelIssue || newer) && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-strip px-2.5 py-2 text-xs leading-[18px] text-caution-text">
          <TriangleAlert size={13} strokeWidth={1.8} aria-hidden="true" className="mt-[2.5px] shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            {channelIssue && <p>{channelIssue}</p>}
            {newer && (
              <div className="space-y-1.5">
                <p>
                  {nativeOn
                    ? `你装的 ${label} ${installed} 比 Mesa 核对过的 ${verified} 新，原生协议若不兼容可改用终端模式打开。`
                    : `你装的 ${label} ${installed} 比 Mesa 核对过的 ${verified} 新，确认按钮可能按不准，按不对就露出终端自己选。`}
                </p>
                {nativeOn && switchTerminalAction && (
                  <button
                    type="button"
                    onClick={switchTerminalAction}
                    className={`${rowActionClass} gap-1.5 bg-inset font-medium text-l1`}
                  >
                    <SquareTerminal size={12} strokeWidth={1.8} aria-hidden="true" className="text-l3" />
                    改用终端模式打开
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {(onOpenTerminal || onReportMismatch) && (
        <div className="mt-3 flex items-center gap-2 border-t border-hairline pt-2">
          {onReportMismatch && (
            <button
              type="button"
              onClick={onReportMismatch}
              title={
                runtimeOn
                  ? "把当前通道记录（已去掉密钥）附上，打开反馈表单"
                  : "把聊天里显示的和终端里的内容（已去掉密钥）附上，打开反馈表单"
              }
              className={`${ghostActionClass} gap-1.5 text-l4 hover:text-l2`}
            >
              <Flag size={12} strokeWidth={1.8} aria-hidden="true" />
              对不上？反馈
            </button>
          )}
          {onOpenTerminal && (
            <button
              type="button"
              onClick={onOpenTerminal}
              className={`${rowActionClass} ml-auto gap-1.5 font-medium text-l1`}
            >
              {runtimeOn ? (
                <>
                  <ScrollText size={13} strokeWidth={1.8} aria-hidden="true" className="text-l3" />
                  查看运行日志
                </>
              ) : (
                <>
                  <SquareTerminal size={13} strokeWidth={1.8} aria-hidden="true" className="text-l3" />
                  切到终端
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
