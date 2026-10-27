import { channelSourceNote, type ChatChannelSnapshot } from "../chat-channel";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import { chatFidelity, fidelityBadge, tierLabel, verifiedVersion } from "../chat-fidelity";
import { CANARY_PLATFORM, VERIFIED_VERSIONS, useCliNewer } from "../cli-verified";
import { IS_WINDOWS } from "../hotkeys";

/**
 * 聊天层「测试版」说明（2026-10-22 用户：聊天层要不要标一个测试版）：说清楚这一家在聊天里能做到哪一步、
 * 哪些事要回终端；用户装的 CLI 比 Mesa 核对过的新时多一句提醒（chat-fidelity.ts）。只说明，不挡任何操作。
 * 2026-10-23 起不再单独占输入框底下一格，收进模型菜单底部一行（点开是这里的正文）；CLI 比核对过的新时模型芯片上带个小点
 */
export function useChatBeta(agentId: string | null) {
  const fidelity = chatFidelity(agentId, IS_WINDOWS);
  const newer = useCliNewer(agentId);
  const badge = fidelityBadge(fidelity, newer);
  const heading = fidelity?.beta ? "聊天是测试版" : fidelity && fidelity.tier >= 3 ? "这家的聊天是简化的" : "聊天层说明";
  return { badge, newer, heading };
}

export function ChatBetaNotes({
  agentId,
  channel,
  live = false,
  onOpenTerminal,
}: {
  agentId: string | null;
  channel?: ChatChannelSnapshot | null;
  live?: boolean;
  onOpenTerminal?: () => void;
}) {
  const installed = useAppStore((s) => s.agents.find((a) => a.id === agentId)?.version ?? null);
  const fidelity = chatFidelity(agentId, IS_WINDOWS);
  const label = AGENTS.find((a) => a.id === agentId)?.label ?? "这家 Agent";
  const verified = agentId ? verifiedVersion(VERIFIED_VERSIONS, CANARY_PLATFORM, agentId) : null;
  const newer = useCliNewer(agentId);
  return (
    <div className="px-2 pb-1 pt-0.5 text-xs leading-5 text-l3">
      <p>聊天是同一个终端会话的另一种看法，以终端为准：聊天里看不到、按不动的，切到终端都在。</p>
      {live && <p className="mt-2 text-l2">{channelSourceNote(channel)}</p>}
      {fidelity && (
        <>
          <p className="mt-2">
            <span className="text-l2">
              {label} · 通常能力：{tierLabel(fidelity.tier)}
            </span>
            ：{fidelity.source}。
          </p>
          <p className="mt-1">要回终端做的：{fidelity.terminalOnly}。</p>
        </>
      )}
      {newer && (
        <p className="mt-2 text-caution-text">
          你装的 {label} {installed} 比 Mesa 核对过的 {verified} 新：它的画面要是变了，聊天里的确认按钮可能按不准。
          这期间 Mesa 不替你自动按任何一步，按不对就点卡上的「露出终端」自己选。
        </p>
      )}
      {onOpenTerminal && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={onOpenTerminal}
            className="h-7 rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-l1"
          >
            切到终端
          </button>
        </div>
      )}
    </div>
  );
}
