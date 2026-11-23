/**
 * 工作区列表的聚焦步骤可见性规则（纯逻辑，供 WorkspacesPage 工作区列表过滤）。
 *
 * - 未聚焦（focusStepName = null，项目无研究步骤）→ 全量显示；
 * - 聚焦某步骤 → 绑定该步骤的工作区（步骤 workspaceName === 工作区名，与步进器
 *   deriveStepStatus 同一映射）+ 不匹配任何步骤 workspaceName 的工作区——
 *   用户手动建的工作区不能被默认视图藏掉（曾在按步骤过滤下对「全部」之外不可见）。
 */
export function filterWorkspacesByFocus<T extends { name: string }>(
  list: readonly T[],
  steps: readonly { name: string; workspaceName: string }[],
  focusStepName: string | null,
): T[] {
  if (!focusStepName) return [...list];
  const focusWsName = steps.find((s) => s.name === focusStepName)
    ?.workspaceName;
  const bound = new Set(
    steps.map((s) => s.workspaceName).filter((n) => n !== ""),
  );
  return list.filter((w) => w.name === focusWsName || !bound.has(w.name));
}

/**
 * 仅筛出当前聚焦研究步骤绑定的工作区（归属流程内当前步骤，不进「流程之外」）。
 */
export function filterFocusedStepWorkspaces<T extends { name: string }>(
  list: readonly T[],
  steps: readonly { name: string; workspaceName: string }[],
  focusStepName: string | null,
): T[] {
  if (!focusStepName || steps.length === 0) return [];
  const focusWsName = steps.find((s) => s.name === focusStepName)
    ?.workspaceName;
  if (!focusWsName) return [];
  return list.filter((w) => w.name === focusWsName);
}

/**
 * 仅筛出未绑定任何研究步骤的独立工作区（真正属于「流程之外」的工作区）。
 * 无研究步骤（steps 为空）时返回全量。
 */
export function filterOutsideFlowWorkspaces<T extends { name: string }>(
  list: readonly T[],
  steps: readonly { name: string; workspaceName: string }[],
): T[] {
  if (steps.length === 0) return [...list];
  const bound = new Set(
    steps.map((s) => s.workspaceName).filter((n) => n !== ""),
  );
  return list.filter((w) => !bound.has(w.name));
}

