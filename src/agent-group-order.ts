/** 连接页 Agent 分组的顺序（2026-10-28 用户：分组可拖动排序）。纯逻辑，tests/agent-group-order.test.ts。
 *  存的是 agent id 列表（localStorage）；没存过的、以后新加的 Agent 按默认顺序接在后面，存过但已不认识的 id 丢掉。 */

export const AGENT_GROUP_ORDER_KEY = "ccode.profiles.agentGroupOrder";

/** 默认顺序（AGENTS）按存下的顺序重排 */
export function orderAgentIds(defaults: readonly string[], saved: readonly string[] | null | undefined): string[] {
  const known = new Set(defaults);
  const head = (saved ?? []).filter((id, i, arr) => known.has(id) && arr.indexOf(id) === i);
  const seen = new Set(head);
  return [...head, ...defaults.filter((id) => !seen.has(id))];
}

/** 只在看得见的那几组之间挪（筛选「已安装」或搜索时隐藏的组原位不动）：
 *  visible 是当前显示顺序，from / to 是它里面的下标；返回整份新顺序 */
export function moveWithinVisible(
  full: readonly string[],
  visible: readonly string[],
  from: number,
  to: number,
): string[] {
  if (from === to || from < 0 || to < 0 || from >= visible.length || to >= visible.length) {
    return [...full];
  }
  const moved = [...visible];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  const inVisible = new Set(visible);
  let k = 0;
  return full.map((id) => (inVisible.has(id) ? moved[k++] : id));
}

export function loadAgentGroupOrder(): string[] | null {
  try {
    const raw = localStorage.getItem(AGENT_GROUP_ORDER_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

export function saveAgentGroupOrder(order: readonly string[]) {
  try {
    localStorage.setItem(AGENT_GROUP_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* 存不下就只在本次生效 */
  }
}
