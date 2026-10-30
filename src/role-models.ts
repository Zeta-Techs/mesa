import type { RoleModels } from "./types";

/**
 * 连接的「模型分工」（2026-10-17 用户：补齐槽位、子 agent 的规则要在连接里看得见、能自定义）。
 * 只列真能分开指定的 CLI 与角色；说明写给用户看「这个模型会被用来干什么」。后端消费见 agents.rs
 * claude_model_env / grok_config_overlay / OpenCode small_model。
 */
export interface RoleSpec {
  key: "small" | "subagent";
  label: string;
  hint: string;
}

const ROLES: Record<string, RoleSpec[]> = {
  "claude-code": [
    {
      key: "small",
      label: "后台小模型",
      hint: "会话标题、网页摘要这类小任务用它；Claude 里的 haiku 也指向它",
    },
    {
      key: "subagent",
      label: "子 Agent 模型",
      hint: "主对话派出去的子任务（Agent / Task 工具）用它",
    },
  ],
  grok: [
    {
      key: "small",
      label: "后台小模型",
      hint: "会话标题、摘要和输入框里的下一句提示用它",
    },
  ],
  opencode: [
    {
      key: "small",
      label: "后台小模型",
      hint: "会话标题这类小任务用它",
    },
  ],
};

export function rolesFor(agent: string): RoleSpec[] {
  return ROLES[agent] ?? [];
}

/** Claude 可显式指向的别名槽（haiku 归后台小模型 small 管）；与 profiles.rs CLAUDE_PINNABLE_SLOTS 同 */
export const CLAUDE_PINNABLE_SLOTS = ["sonnet", "opus", "fable"] as const;

/** 保存前归一：去空白、空串当没设、不在名单里的丢掉（名单删了某个模型，分工跟着失效回到「跟主模型」） */
export function normalizeRoleModels(roles: RoleModels | undefined, models: string[]): RoleModels {
  const keep = (v: string | null | undefined) => {
    const t = v?.trim();
    return t && models.includes(t) ? t : null;
  };
  const out: RoleModels = { small: keep(roles?.small), subagent: keep(roles?.subagent) };
  if (roles?.slots) {
    const slots: Record<string, string> = {};
    for (const k of CLAUDE_PINNABLE_SLOTS) {
      const v = keep(roles.slots[k]);
      if (v) slots[k] = v;
    }
    out.slots = slots;
  }
  const names: Record<string, string> = {};
  for (const [m, n] of Object.entries(roles?.displayNames ?? {})) {
    if (models.includes(m.trim()) && n.trim()) names[m.trim()] = n.trim();
  }
  if (Object.keys(names).length) out.displayNames = names;
  return out;
}

/** 旧绑定（没有显式映射）按名单顺序算出的显式表：连接弹层打开时据此填表，保存后就是显式的，用户看到的指向不变 */
export function legacySlotsFromOrder(models: string[]): Record<string, string> {
  const list = models.map((m) => m.trim()).filter(Boolean);
  const slots: Record<string, string> = {};
  if (list[0]) slots.sonnet = list[0];
  if (list[1]) slots.opus = list[1];
  if (list[3]) slots.fable = list[3];
  return slots;
}

/**
 * Claude Code 四个别名实际指向哪个模型（与 agents.rs claude_slot_models 双端镜像，共读 tests/fixtures/claude-slots.json）：
 * haiku 指定了后台小模型用它；显式映射（slots 非空对象）表里有的用它；旧绑定按名单前四个依次占槽；都没有 = 跟默认（model 为 null）。
 * 名单为空 = 用 Claude 自己的映射，返回空表。
 */
export function claudeAliasMap(
  models: string[],
  roles: RoleModels | undefined,
): { alias: string; model: string | null; why: string }[] {
  const list = models.map((m) => m.trim()).filter(Boolean);
  if (list.length === 0) return [];
  const listed = (m: string | null | undefined) => (m && list.includes(m) ? m : null);
  return ["sonnet", "opus", "haiku", "fable"].map((alias, i) => {
    const small = alias === "haiku" ? listed(roles?.small) : null;
    if (small) return { alias, model: small, why: "后台小模型" };
    if (roles?.slots) {
      const m = listed(roles.slots[alias]);
      return m ? { alias, model: m, why: "映射表" } : { alias, model: null, why: "跟默认模型" };
    }
    if (list[i]) return { alias, model: list[i], why: `名单第 ${i + 1} 个` };
    return { alias, model: null, why: "名单不够四个，空的跟主模型" };
  });
}

/** /model 菜单另加的一项（同 agents.rs claude_custom_option）：旧绑定 = 名单第 5 个；显式映射 = 第一个没被别名占用、也不是默认的模型 */
export function claudeCustomOption(models: string[], roles: RoleModels | undefined, fill: string | null): string | null {
  const list = models.map((m) => m.trim()).filter(Boolean);
  if (!roles?.slots) return list[4] ?? null;
  const used = claudeAliasMap(list, roles).map((a) => a.model ?? fill);
  return list.find((m) => !used.includes(m) && m !== fill) ?? null;
}

/** 保存 / 开始编辑 Claude 映射表前转成显式：旧绑定按名单顺序算出 sonnet / opus / fable，haiku（后台小模型）没设时取名单第 3 个 */
export function explicitClaudeRoles(models: string[], roles: RoleModels | undefined): RoleModels {
  if (roles?.slots) return { ...roles };
  const list = models.map((m) => m.trim()).filter(Boolean);
  return { ...(roles ?? {}), slots: legacySlotsFromOrder(list), small: roles?.small ?? list[2] ?? null };
}
