/** 一次开几个终端标签（拆分方案批准、一步分几路、收尾一路）：先等前一个请求被收下、再交这个，等终端页收下再返回。
 *  返回终端页收下了没有；没收下（终端页没挂上 / 不在前台）就把这个请求撤回，免得之后被别的入口覆盖时悄悄丢掉（2026-11-03 自查） */
import { useAppStore, type PendingTerminal } from "./store";

async function waitUntilFree(deadline: number): Promise<boolean> {
  while (useAppStore.getState().pendingTerminal && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  return !useAppStore.getState().pendingTerminal;
}

export async function openTerminalInTurn(req: PendingTerminal, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  if (!(await waitUntilFree(deadline))) return false;
  useAppStore.getState().setPendingTerminal(req);
  const taken = await waitUntilFree(deadline);
  if (!taken && useAppStore.getState().pendingTerminal === req) useAppStore.getState().setPendingTerminal(null);
  return taken;
}
