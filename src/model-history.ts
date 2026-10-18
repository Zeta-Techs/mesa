/**
 * 「这份连接能选哪些模型」：连接自己登记的模型名单 + 用这份连接手填用过的模型。
 * 历史按「Agent + 连接」分开记（`ccode.modelHistory.<agent>.<连接>`；原按 Agent 混记，别家连接的模型会混进来，
 * 2026-10-17 用户截图）。开聊前选择器、终端启动栏、开聊后的「模型 · 思考」芯片同用这一份，名单不得两样。
 */
export function readModelHistory(agentId: string, profileId: string | null | undefined): string[] {
  if (!profileId || typeof localStorage === "undefined") return [];
  try {
    const list = JSON.parse(
      localStorage.getItem(`ccode.modelHistory.${agentId}.${profileId}`) ?? "[]",
    ) as unknown;
    return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return []; // 损坏按空历史
  }
}

export function connectionModels(profileModels: readonly string[], history: readonly string[]): string[] {
  return [...new Set([...profileModels, ...history])].filter(Boolean);
}
