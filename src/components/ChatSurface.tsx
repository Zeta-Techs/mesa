import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import ConversationView from "./ConversationView";
import ChatComposer from "./ChatComposer";
import type {
  ChatMessageDto,
  DetectResult,
  McpServerDto,
  SessionSyncState,
  SkillDto,
} from "../types";
import { IS_WINDOWS } from "../hotkeys";
import { dropHitsRect, joinDroppedChatPaths } from "../terminal-input";
import {
  approvalExtraHint,
  chatHeaderStatus,
  chatWaitKind,
  chatWaitText,
  composerShowsInterrupt,
  latestToolName,
  slashHandoff,
} from "../chat-handoff";
import { confirmChoices } from "../chat-reply";
import { welcomeCwdLine } from "../terminal-welcome";
import { escInterruptSafe } from "../agent-caps";

export default function ChatSurface({
  messages,
  state,
  syncState,
  loading,
  active = true,
  agentId,
  confirmDetail,
  cwd,
  running,
  canResume,
  attention,
  readOnly,
  readonlySupported,
  busy,
  skills,
  mcps,
  onSend,
  onAllowWrite,
  onOpenTerminal,
  onInterrupt,
  onApprovalKey,
  peek = false,
  onTogglePeek,
  onRequestPeek,
  modelSwitch,
  hooksEnabled = false,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onChooseCwd,
}: {
  messages: ChatMessageDto[];
  state: "idle" | "detecting" | "linked" | "timeout";
  syncState: SessionSyncState;
  loading: boolean;
  /** 聊天层当前可见（常驻挂载仅隐藏后，用作输入框聚焦信号） */
  active?: boolean;
  agentId?: string | null;
  confirmDetail?: string | null;
  cwd?: string | null;
  running: boolean;
  canResume: boolean;
  attention: "done" | "working" | "confirm" | null;
  readOnly: boolean;
  readonlySupported: boolean;
  busy?: boolean;
  skills: SkillDto[];
  mcps: McpServerDto[];
  onSend: (text: string) => Promise<string | null>;
  onAllowWrite: () => void;
  onOpenTerminal: () => void;
  onInterrupt?: () => void;
  onApprovalKey?: (key: "y" | "n" | "esc") => void;
  peek?: boolean;
  onTogglePeek?: () => void;
  onRequestPeek?: () => void;
  modelSwitch?: DetectResult["modelSwitch"];
  hooksEnabled?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** 空态目录行：点选工作目录（未启动时走终端标签 chooseCwd） */
  onChooseCwd?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [hasNew, setHasNew] = useState(false);
  const [stuckWaiting, setStuckWaiting] = useState(false);
  const [seedInsert, setSeedInsert] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState("");
  const prevScrollHeightRef = useRef(0);
  const loadingOlderRef = useRef(false);

  useEffect(() => {
    void invoke<string>("home_dir")
      .then(setHomeDir)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!(running && syncState === "waiting" && messages.length === 0)) {
      setStuckWaiting(false);
      return;
    }
    const t = setTimeout(() => setStuckWaiting(true), 8000);
    return () => clearTimeout(t);
  }, [running, syncState, messages.length]);

  useEffect(() => {
    if (stuckWaiting) onRequestPeek?.();
  }, [stuckWaiting, onRequestPeek]);

  function scrollBottom() {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    setHasNew(false);
    el.scrollTop = el.scrollHeight;
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (loadingOlderRef.current) {
      const delta = el.scrollHeight - prevScrollHeightRef.current;
      el.scrollTop += delta;
      loadingOlderRef.current = false;
      return;
    }
    if (followRef.current) requestAnimationFrame(scrollBottom);
    else setHasNew(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const unlisten = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      if (
        !dropHitsRect(
          event.payload.position,
          rect,
          window.devicePixelRatio || 1,
        )
      ) {
        return;
      }
      const text = joinDroppedChatPaths(event.payload.paths, IS_WINDOWS);
      if (!text) return;
      if (!cancelled) setSeedInsert(text);
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, [active]);

  const headerStatus = chatHeaderStatus({
    state,
    syncState,
    running,
    canResume,
    messageCount: messages.length,
  });
  // 未就绪状态注记（原头部第一行文案迁入输入框左下角）：识别中/等待会话文件/可恢复才显示，
  // linked 稳态（实时同步/已结束·可继续）不显——运行态由底部状态栏状态点覆盖
  const statusNote =
    syncState === "waiting" || state === "detecting" || state === "timeout"
      ? headerStatus
      : null;
  const canSend = state !== "timeout" || running || canResume;

  const toolName = latestToolName(messages);
  const waitKind = chatWaitKind({
    pendingReply: loading,
    running,
    syncState,
    messageCount: messages.length,
    stuckWaiting,
    toolName,
  });
  const waitText = chatWaitText(waitKind, toolName);
  const generating =
    loading || (running && attention === "working");
  const extraHint = approvalExtraHint(agentId, hooksEnabled);

  async function sendFromComposer(text: string): Promise<string | null> {
    const event = slashHandoff(text, modelSwitch?.kind ?? null);
    if (event === "picker_model") onRequestPeek?.();
    return onSend(text);
  }

  return (
    <div
      ref={rootRef}
      data-chat-drop="1"
      className="flex h-full min-h-0 w-full flex-col bg-canvas"
    >
      {/* 聊天头部整条取消（2026-09-13）：标题归标签条，身份/模型/目录/状态点归底部状态栏
          （chat 变体）——两行头部与它们完全重复。原头部独有功能就近收编：
          停止 → 发送钮同体（正在生成变「进行中」符号钮，点击往终端发 Esc 暂停，会话保留）；
          只读分叉/允许修改与未就绪状态注记 → 输入框左下角 micro 行；
          ＋ 只插入技能/MCP；分叉和回放在启动行 ⋯。
          注意力确认横条（下方）保持不变。 */}

      {attention === "confirm" && (
        <div className="shrink-0 border-b border-hairline bg-inset px-5 py-2.5">
          <div className="mx-auto w-full max-w-4xl">
            <div className="text-xs text-warn-text">
              Agent 正在等待你的确认
              {confirmDetail
                ? `：${confirmDetail}`
                : "（终端里有待处理的批准、登录或菜单选择）"}
            </div>
            {extraHint && (
              <div className="mt-1 text-micro text-l4">{extraHint}</div>
            )}
            {/* Grok 无 Esc 键：非 prompt 态 Esc 会触发整进程退出确认（escInterruptSafe），
                审批/菜单态同理——「Esc 取消」对该家隐藏，去终端里自行处理 */}
            <div className="mt-1.5 flex items-center gap-1.5">
              {confirmChoices(confirmDetail).map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  onClick={() => onApprovalKey?.(choice.key)}
                  title={`往终端按 ${choice.key}`}
                  className={
                    choice.key === "y"
                      ? "rounded-md bg-ok px-2.5 py-1 text-xs text-ok-text hover:opacity-85"
                      : "rounded-md bg-err px-2.5 py-1 text-xs text-err-text hover:opacity-85"
                  }
                >
                  {choice.key === "y" ? "✓ " : "✗ "}
                  {choice.label}
                </button>
              ))}
              {escInterruptSafe(agentId) && (
                <button
                  type="button"
                  onClick={() => onApprovalKey?.("esc")}
                  title="往终端按 Esc（取消当前提示）"
                  className="rounded-md px-2.5 py-1 text-xs text-l3 hover:bg-hover hover:text-l1"
                >
                  Esc 取消
                </button>
              )}
              <span className="mx-1 h-3.5 w-px bg-hairline" />
              <button
                type="button"
                onClick={onOpenTerminal}
                title="选项更多或按键无效时，去终端里直接操作"
                className="rounded-md px-2.5 py-1 text-xs text-l2 hover:bg-hover"
              >
                打开终端
              </button>
              {onTogglePeek && !peek && (
                <button
                  type="button"
                  onClick={onTogglePeek}
                  className="rounded-md px-2.5 py-1 text-xs text-l2 hover:bg-hover"
                >
                  露出终端
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const nearBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 56;
          followRef.current = nearBottom;
          if (nearBottom) setHasNew(false);
        }}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 pb-6 pt-8 sm:px-5">
          {hasOlder && onLoadOlder && (
            <div className="mb-4 flex justify-center">
              <button
                type="button"
                disabled={loadingOlder}
                onClick={() => {
                  followRef.current = false;
                  loadingOlderRef.current = true;
                  prevScrollHeightRef.current =
                    scrollRef.current?.scrollHeight ?? 0;
                  onLoadOlder();
                }}
                className="rounded-md px-2.5 py-1 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:opacity-40"
              >
                {loadingOlder ? "加载中…" : "加载更早的消息"}
              </button>
            </div>
          )}
          {state === "idle" && messages.length === 0 ? (
            stuckWaiting ? (
              <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
                <p className="max-w-md text-sm text-warn-text">
                  {chatWaitText("no_session")}
                  ——信任此目录 / 登录 / 菜单选择通常在终端里
                </p>
                <div className="mt-3 flex items-center gap-2">
                  {onTogglePeek && (
                    <button
                      type="button"
                      onClick={onTogglePeek}
                      className="rounded-md border border-field bg-raised px-3 py-1.5 text-xs text-l2 hover:bg-inset hover:text-l1"
                    >
                      {peek ? "终端已露出" : "露出终端"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onOpenTerminal}
                    className="rounded-md border border-field bg-raised px-3 py-1.5 text-xs text-l2 hover:bg-inset hover:text-l1"
                  >
                    打开终端处理
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-1" />
            )
          ) : state === "detecting" && messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center pb-20 text-sm text-l4">
              正在连接当前会话…
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-1" />
          ) : (
            <ConversationView messages={messages} cwd={cwd} />
          )}
          {generating && (
            <div
              className="mb-2 flex items-center gap-2 text-micro text-l4"
              aria-live="polite"
            >
              <span className="flex items-center gap-1" aria-hidden="true">
                <span className="size-1.5 rounded-full bg-l4 animate-pulse" />
                <span className="size-1.5 rounded-full bg-l4 animate-pulse [animation-delay:120ms]" />
                <span className="size-1.5 rounded-full bg-l4 animate-pulse [animation-delay:240ms]" />
              </span>
              <span>{waitText || "正在回复"}</span>
            </div>
          )}
          {hasNew && (
            <button
              type="button"
              onClick={scrollBottom}
              className="sticky bottom-2 left-1/2 mx-auto -translate-x-1/2 rounded-md border border-field bg-raised px-2.5 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
            >
              有新消息 ↓
            </button>
          )}
        </div>
      </div>

      <ChatComposer
        disabled={!canSend}
        busy={busy}
        skills={skills}
        mcps={mcps}
        onSend={sendFromComposer}
        focusWhen={active}
        agentId={agentId}
        seedInsert={seedInsert}
        onSeedConsumed={() => setSeedInsert(null)}
        placeholder={
          readOnly
            ? "这是只读分叉；可以提问、分析和规划…"
            : messages.length === 0
              ? "问一个问题…"
              : undefined
        }
        cwdHint={
          messages.length === 0 && !stuckWaiting && cwd
            ? welcomeCwdLine(cwd, homeDir, "开始", IS_WINDOWS)
            : null
        }
        cwdTitle={
          cwd
            ? `${cwd === "~" && homeDir ? homeDir : cwd}\n点击选择工作目录`
            : undefined
        }
        onChooseCwd={onChooseCwd}
        leftExtras={
          <>
            {statusNote ? (
              <span
                className="ml-1 shrink-0 text-micro text-l4"
                title={statusNote === "等待会话文件" ? "会话文件还没出现；Agent 起来后会自动接上" : undefined}
              >
                {statusNote}
              </span>
            ) : null}
            {readOnly && (
              <span
                className="ml-1 shrink-0 rounded-md bg-inset px-1.5 py-0.5 text-micro text-warn-text"
                title={
                  readonlySupported
                    ? "该分叉会话启用了 Agent 原生只读/计划模式"
                    : "该 Agent 没有原生只读参数，仅提供提示约束"
                }
              >
                只读分叉
              </span>
            )}
            {readOnly && (
              <button
                type="button"
                onClick={onAllowWrite}
                className="shrink-0 rounded px-1 text-micro text-warn-text hover:bg-hover"
              >
                允许修改
              </button>
            )}
          </>
        }
        running={composerShowsInterrupt({
          running,
          attention,
          pendingReply: loading,
        })}
        onInterrupt={onInterrupt}
      />
      {peek && (
        <button
          type="button"
          onClick={onTogglePeek}
          title="收起露出的终端画面"
          className="shrink-0 border-t border-hairline bg-inset px-3 py-1 text-center text-micro text-l4 hover:bg-hover hover:text-l2"
        >
          下方是同一会话的终端 · 点此收起
        </button>
      )}
    </div>
  );
}
