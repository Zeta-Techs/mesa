/**
 * 派活回音的巡视（调 invoke）：应用开着时每分钟看一次各项目还在跟的派活，到了新阶段就补回音、刷新收件箱。
 * 由 ProjectAssistantHost（App 里唯一一份）挂上；判定与文字在 assistant-echo.ts。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store";
import { dispatchStatus } from "./assistant-dispatch";
import { echoInboxItems, echoText, loadEchoSeen, markEchoSeen, type OpenDispatch } from "./assistant-echo";
import { samePath } from "./path-utils";
import { IS_WINDOWS } from "./hotkeys";
import type { ProjectDto } from "./types";
import { imPushText } from "./im-bridge";
import { phoneText } from "./im-cards";

export const ECHO_POLL_MS = 60_000;

let running = false;

export async function pollAssistantEchoes(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const open = await invoke<OpenDispatch[]>("assistant_open_dispatches").catch(() => [] as OpenDispatch[]);
    let added = false;
    for (const d of open) {
      const status = await dispatchStatus(d.record, d.projectRoot).catch(() => null);
      const phase = status?.phase;
      if (!phase || phase === d.record.echoed) continue;
      const echo = await invoke<{ at: string } | null>("assistant_echo", {
        projectRoot: d.projectRoot,
        turnAt: d.turnAt,
        state: phase,
        text: echoText(d.record, phase),
      }).catch(() => null);
      d.record = { ...d.record, echoed: phase, echoedAt: echo?.at ?? new Date().toISOString() };
      if (echo) {
        added = true;
        // 手机上也说一声（飞书连上、绑定过才发）
        const name = d.projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? d.projectRoot;
        void imPushText(`${name}：${phoneText(echoText(d.record, phase))}`);
      }
    }
    const state = useAppStore.getState();
    // 只有要进收件箱的才去取项目名（list_projects 不便宜，没回音时不取）
    const pending = echoInboxItems(open, loadEchoSeen(), () => "");
    const projects = pending.length ? await invoke<ProjectDto[]>("list_projects").catch(() => [] as ProjectDto[]) : [];
    const name = (root: string) =>
      projects.find((p) => samePath(p.path, root, IS_WINDOWS))?.name ?? root.split(/[\\/]/).filter(Boolean).pop() ?? root;
    state.setAssistantEchoes(pending.length ? echoInboxItems(open, loadEchoSeen(), name) : []);
    if (added) state.bumpAssistantEchoTick();
  } finally {
    running = false;
  }
}

/** 打开了某个项目的项目助手：它的回音算看过，从收件箱拿掉 */
export function seeAssistantEchoes(projectRoot: string): void {
  markEchoSeen(projectRoot);
  const state = useAppStore.getState();
  const rest = state.assistantEchoes.filter((item) => !(item.action.type === "assistant" && samePath(item.action.projectRoot, projectRoot, IS_WINDOWS)));
  if (rest.length !== state.assistantEchoes.length) state.setAssistantEchoes(rest);
}
