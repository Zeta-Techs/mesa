import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { AGENTS } from "../types";
import { useAppStore } from "../store";
import { agentBrand } from "../agent-colors";
import { connectionModels, readModelHistory } from "../model-history";
import { relayAgentRows, relayModeRows, type RelayOptionDto, type RelayTarget } from "../chat-relay";

/** 换 Agent 那组要的状态（聊天里来自标签，对话页来自所选那段） */
export interface RelayMenuProps {
  state: { available?: boolean; pick: RelayTarget | null; options: RelayOptionDto[]; blocked: string | null };
  onPick: (target: RelayTarget | null) => void;
  /** 进这组时取一次：这段接力对话里已用过的几家能不能接回 */
  onLoad: () => void;
}

const NO_HIDDEN: string[] = [];
// 行的样子同模型菜单（ChatModelMenu）：选中只靠行尾的勾和字色，悬停 / 键盘焦点才铺底
const item = (selected: boolean) =>
  `flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left outline-none hover:bg-hover focus-visible:bg-hover ${
    selected ? "text-l1" : "text-l2 hover:text-l1"
  }`;
const mark = (selected: boolean) => (
  <Check size={14} strokeWidth={2} aria-hidden="true" className={`shrink-0 ${selected ? "text-l2" : "invisible"}`} />
);
const section = "px-2 pb-1 pt-1.5 text-xs text-l3";
const note = "px-2 pb-1.5 pt-0.5 text-xs leading-[18px] text-l4";

/**
 * 「换一家接着做（接力）」那组（docs/design-chat-relay.md §3.1 / §4.2）。两层（2026-11-10 用户：一次全摊开太长）：
 * 先一家一行，点进去再选怎么接（用过的那家：接回原来那段 / 新开一段）和用哪条连接的哪个模型。
 * 选中只挂在输入框上，发下一句时才交接
 */
export default function RelayPicker({
  relay,
  currentAgent,
  onPicked,
}: {
  relay: RelayMenuProps;
  currentAgent: string;
  onPicked: () => void;
}) {
  const agents = useAppStore((s) => s.agents);
  const profiles = useAppStore((s) => s.profiles);
  const hidden = useAppStore((s) => s.settings?.hiddenProfiles) ?? NO_HIDDEN;
  const { onLoad } = relay;
  useEffect(() => {
    onLoad();
  }, [onLoad]);
  const picked = relay.state.pick;
  const [open, setOpen] = useState<string | null>(null);
  const [mode, setMode] = useState<"new" | "resume" | null>(null);
  const rows = relayAgentRows({
    currentAgent,
    agents: AGENTS.map((a) => ({
      id: a.id,
      label: a.label,
      installed: agents.find((x) => x.id === a.id)?.binaryPath != null,
    })),
    profiles: profiles.map((p) => ({ id: p.id, agent: p.agent, name: p.name, models: p.models })),
    hiddenProfiles: hidden,
    options: relay.state.options,
    lastProfile: (agent) => localStorage.getItem(`ccode.lastProfile.${agent}`),
  });
  const blocked = Boolean(relay.state.blocked);
  const row = open ? rows.find((r) => r.agentId === open) : null;
  const cancelRow = picked && (
    <button
      type="button"
      className={item(false)}
      onClick={() => {
        relay.onPick(null);
        onPicked();
      }}
    >
      <span className="text-l3">不换了</span>
    </button>
  );

  // —— 第二层：这家怎么接、用哪条连接的哪个模型 ——
  if (row) {
    const modes = row.used ? relayModeRows(row.used) : [];
    const chosenMode =
      mode ?? (picked?.agentId === row.agentId ? picked.mode : (modes[0]?.mode ?? "new"));
    const pick = (profileId: string, model: string) => {
      relay.onPick({
        agentId: row.agentId,
        profileId,
        model,
        mode: chosenMode,
        resumeSession: chosenMode === "resume" ? (row.used?.priorSession ?? null) : null,
      });
      onPicked();
    };
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setOpen(null);
            setMode(null);
          }}
          className="flex h-8 w-full shrink-0 items-center gap-1 rounded-lg px-2 text-left text-xs text-l3 outline-none hover:bg-hover hover:text-l1 focus-visible:bg-hover"
        >
          <ChevronLeft size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="text-xs">换 Agent</span>
        </button>
        <div className="flex items-center gap-1.5 px-2 pb-1 pt-0.5 font-medium text-l1">
          <AgentMark agentId={row.agentId} />
          {row.label}
        </div>
        {relay.state.blocked && <p className={note}>{relay.state.blocked}</p>}
        {modes.length > 0 && (
          <>
            <h4 className={section}>怎么接</h4>
            <ul>
              {modes.map((m) => (
                <li key={m.mode}>
                  <button
                    type="button"
                    data-selected={chosenMode === m.mode}
                    className={item(chosenMode === m.mode)}
                    onClick={() => setMode(m.mode)}
                  >
                    <span className="min-w-0 flex-1 truncate">{m.label}</span>
                    {mark(chosenMode === m.mode)}
                  </button>
                  {m.note && <p className={`${note} -mt-0.5`}>{m.note}</p>}
                </li>
              ))}
            </ul>
            <div className="mx-1 my-1 h-px bg-hairline" />
          </>
        )}
        <h4 className={section}>模型</h4>
        <ul>
          {row.profiles.map((p) => {
            const models = connectionModels(p.models, readModelHistory(row.agentId, p.id));
            const list = models.length > 0 ? models : [""];
            return (
              <li key={p.id}>
                <div className="px-2 pb-0.5 pt-1.5 text-micro text-l4">{p.name}</div>
                <ul>
                  {list.map((m) => {
                    const selected =
                      picked?.agentId === row.agentId &&
                      picked.profileId === p.id &&
                      picked.model === m &&
                      picked.mode === chosenMode;
                    return (
                      <li key={m || "default"}>
                        <button
                          type="button"
                          disabled={blocked}
                          data-selected={selected}
                          className={`${item(selected)} disabled:opacity-40`}
                          onClick={() => pick(p.id, m)}
                        >
                          <span className="min-w-0 flex-1 truncate">{m || "按连接默认"}</span>
                          {mark(selected)}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
        {cancelRow}
      </>
    );
  }

  // —— 第一层：一家一行 ——
  return (
    <>
      <h4 className={section}>换 Agent</h4>
      <p className={note}>发下一句时交接，对话留在这里。</p>
      {relay.state.blocked && <p className={note}>{relay.state.blocked}</p>}
      {rows.length === 0 && <p className={note}>没有别的可用 Agent</p>}
      <ul>
        {rows.map((r) => {
          const selected = picked?.agentId === r.agentId;
          return (
            <li key={r.agentId}>
              <button
                type="button"
                data-selected={selected}
                className={item(selected)}
                onClick={() => {
                  setOpen(r.agentId);
                  setMode(null);
                }}
              >
                <AgentMark agentId={r.agentId} />
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                {r.used && (
                  <span className="shrink-0 text-micro text-l4">用过</span>
                )}
                {selected && mark(true)}
                <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l4" />
              </button>
            </li>
          );
        })}
      </ul>
      {cancelRow}
    </>
  );
}

/** Agent 标记：Mesa 标志里的 M（与图标源同一条路径），染成这家的品牌色；悬停写 Agent 名 */
export function AgentMark({ agentId }: { agentId: string }) {
  const name = AGENTS.find((a) => a.id === agentId)?.label ?? agentId;
  return (
    <svg
      viewBox="232 284 560 456"
      className="h-[0.8em] w-auto shrink-0"
      role="img"
      aria-label={name}
      style={{ color: agentBrand(agentId) }}
    >
      <title>{name}</title>
      <path
        d="M232 740 V284 H356 L512 512 L668 284 H792 V740 H672 V474 L548 652 H476 L352 474 V740 Z"
        fill="currentColor"
      />
    </svg>
  );
}
