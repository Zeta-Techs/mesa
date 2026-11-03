/** 一次开几个终端标签（拆分方案批准、一步分几路）：交一个请求，等终端页收下（pendingTerminal 清空）再交下一个 */
import { useAppStore, type PendingTerminal } from "./store";

export async function openTerminalInTurn(req: PendingTerminal, timeoutMs = 15_000): Promise<void> {
  useAppStore.getState().setPendingTerminal(req);
  const deadline = Date.now() + timeoutMs;
  while (useAppStore.getState().pendingTerminal && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
}
