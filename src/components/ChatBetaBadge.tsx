import { Flag, Info, ScrollText, SquareTerminal, TriangleAlert } from "lucide-react";
import { channelSourceNote, type ChatChannelSnapshot } from "../chat-channel";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import { chatFidelity, fidelityBadge, nativeFidelityNote, nativeRuntime, nativeStopViaChannel, tierLabel } from "../chat-fidelity";
import { useCliNewer, useVerifiedVersion } from "../cli-verified";
import { IS_WINDOWS } from "../hotkeys";
import { Toggle, ghostActionClass, rowActionClass } from "./PageFrame";

/**
 * 聊天层「测试版」说明（2026-10-22 用户：聊天层要不要标一个测试版）：说清楚这一家在聊天里能做到哪一步、
 * 哪些事要回终端；用户装的 CLI 比 Mesa 核对过的新时多一句提醒（chat-fidelity.ts）。只说明，不挡任何操作。
 * 2026-10-23 起不再单独占输入框底下一格，收进模型菜单底部一行（点开是这里的正文）；CLI 比核对过的新时只在菜单里那一行带点，芯片上不挂（2026-11-20）
 */
export function useChatBeta(agentId: string | null) {
  const fidelity = chatFidelity(agentId, IS_WINDOWS);
  const newer = useCliNewer(agentId);
  const badge = fidelityBadge(fidelity, newer);
  const heading = fidelity?.beta ? "聊天是测试版" : fidelity && fidelity.tier >= 3 ? "这家的聊天是简化的" : "聊天层说明";
  // 模型菜单右上角提示符号悬停时的一句话（2026-11-16 用户：说明简洁显示在上面，不用再点进去）
  const summary = `${heading}，以终端为准${fidelity ? `；${fidelity.terminalOnly}要回终端` : ""}。`;
  const warn = newer ? "你装的 CLI 比 Mesa 核对过的新，聊天里的确认按钮可能按不准。" : null;
  return { badge, newer, heading, summary, warn };
}

/** 这段对话的「原生模式」开关（docs/design-chat-native-mode.md）；这家还没点亮时不传 */
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
  onReportMismatch,
}: {
  agentId: string | null;
  channel?: ChatChannelSnapshot | null;
  live?: boolean;
  native?: NativeModeToggle | null;
  onOpenTerminal?: () => void;
  /** 「对不上？反馈」：带上两边当时的内容打开反馈表单（chat-mismatch.ts） */
  onReportMismatch?: () => void;
}) {
  const installed = useAppStore((s) => s.agents.find((a) => a.id === agentId)?.version ?? null);
  const fidelity = chatFidelity(agentId, IS_WINDOWS);
  const label = AGENTS.find((a) => a.id === agentId)?.label ?? "这家 Agent";
  const verified = useVerifiedVersion(agentId);
  const newer = useCliNewer(agentId);
  // 2026-11-26 用户：说明乱七八糟，精简——一行开关、一句话、按钮；能做到哪一步与数据从哪来收进那句话的悬停提示
  const runtime = nativeRuntime(agentId);
  const runtimeOn = Boolean(native?.on && runtime);
  const nativeNote = runtimeOn ? nativeFidelityNote(agentId) : null;
  const line = nativeNote
    ? `${nativeNote.terminalOnly}要先关掉原生模式。`
    : fidelity
      ? `以终端为准；${fidelity.terminalOnly}要回终端。`
      : "以终端为准。";
  const lineTitle = fidelity ? `${label} · ${tierLabel(fidelity.tier)}：${nativeNote?.source ?? fidelity.source}` : undefined;
  const nativeLine = runtime
    ? `改用 ${label} 官方协议，无终端界面`
    : nativeStopViaChannel(agentId)
      ? `消息和停止直接交给 ${label}`
      : `消息直接交给 ${label}，停止仍按 Esc`;
  // 实时通道断了 / 还在连：例外才说
  const channelIssue =
    live && channel && (channel.connection === "disconnected" || channel.connection === "connecting")
      ? channelSourceNote(channel)
      : null;
  return (
    <div className="px-1.5 pb-1.5 pt-1 text-xs">
      {native && (
        <div
          className="ccode-well rounded-lg px-3 py-2.5"
          title={
            runtime
              ? "聊着的时候翻开关：空闲时停下，再接回这段对话"
              : "终端照样连着这段对话，随时能切过去看"
          }
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-medium leading-5 text-l1">原生模式</span>
            <Toggle checked={native.on} onChange={native.onToggle} label="原生模式" />
          </div>
          <p className="mt-1 text-xs leading-[18px] text-l3">{nativeLine}</p>
        </div>
      )}
      <div
        title={lineTitle}
        className={`flex items-start gap-2 px-1.5 text-xs leading-[19px] text-l3 ${native ? "mt-2.5" : "mt-0.5"}`}
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
              <p>
                {runtimeOn
                  ? `你装的 ${label} ${installed} 比 Mesa 核对过的 ${verified} 新，原生协议若不兼容可暂时关掉原生模式。`
                  : `你装的 ${label} ${installed} 比 Mesa 核对过的 ${verified} 新，确认按钮可能按不准，按不对就露出终端自己选。`}
              </p>
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
