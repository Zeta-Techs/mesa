/**
 * 「选 Agent · 连接 · 模型」两层菜单的分组（纯逻辑，tests/agent-model-groups.test.ts；UI 在 components/AgentModelPicker.tsx）。
 * 2026-11-11 用户：复核方、研讨成员的原生下拉把每条连接 × 每个模型一次摊开，四五十行太长——改成聊天层换 Agent 那样，
 * 先一家一行，点进去再按连接分组列模型。顺序沿用传入的选项顺序（调用方已按一等在前、最近用过的在前排好）。
 */
export interface AgentModelOption {
  key: string;
  agentId: string;
  profileId: string;
  profileName: string;
  /** 空串 = 按连接默认 */
  model: string;
  /** 这一项的提醒（如「与写稿同一模型族」），橙字写在行尾 */
  warn?: string;
  disabled?: boolean;
}

export interface AgentModelGroup<O extends AgentModelOption = AgentModelOption> {
  agentId: string;
  /** 这家的选项数 */
  count: number;
  profiles: { profileId: string; profileName: string; options: O[] }[];
}

export function groupByAgent<O extends AgentModelOption>(options: readonly O[]): AgentModelGroup<O>[] {
  const out: AgentModelGroup<O>[] = [];
  for (const o of options) {
    let g = out.find((x) => x.agentId === o.agentId);
    if (!g) {
      g = { agentId: o.agentId, count: 0, profiles: [] };
      out.push(g);
    }
    let p = g.profiles.find((x) => x.profileId === o.profileId);
    if (!p) {
      p = { profileId: o.profileId, profileName: o.profileName, options: [] };
      g.profiles.push(p);
    }
    p.options.push(o);
    g.count += 1;
  }
  return out;
}
