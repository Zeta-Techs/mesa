import type { RoleModels } from "./types";

/**
 * 连接的「模型分工」（2026-10-17 用户：补齐槽位、子 agent 的规则要在连接里看得见、能自定义）。
 * 只列真能分开指定的 CLI 与角色；说明写给用户看「这个模型会被用来干什么」。后端消费见 agents.rs
 * claude_model_env / grok_config_overlay / OpenCode small_model。
 */
export interface RoleSpec {
  key: keyof RoleModels;
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

/** 保存前归一：去空白、空串当没设、不在名单里的丢掉（名单删了某个模型，分工跟着失效回到「跟主模型」） */
export function normalizeRoleModels(roles: RoleModels | undefined, models: string[]): RoleModels {
  const keep = (v: string | null | undefined) => {
    const t = v?.trim();
    return t && models.includes(t) ? t : null;
  };
  return { small: keep(roles?.small), subagent: keep(roles?.subagent) };
}

/**
 * Claude Code 四个别名实际指向哪个模型（连接页只读展示，与 agents.rs claude_model_env 同规则）：
 * 名单前四个依次占 sonnet / opus / haiku / fable；指定了后台小模型时 haiku 用它；
 * 名单不够四个时空的跟主模型（启动时选的，没选用名单第一个）——model 为 null。名单为空 = 用 Claude 自己的映射。
 */
export function claudeAliasMap(
  models: string[],
  roles: RoleModels | undefined,
): { alias: string; model: string | null; why: string }[] {
  const list = models.map((m) => m.trim()).filter(Boolean);
  if (list.length === 0) return [];
  return ["sonnet", "opus", "haiku", "fable"].map((alias, i) => {
    if (alias === "haiku" && roles?.small) return { alias, model: roles.small, why: "后台小模型" };
    if (list[i]) return { alias, model: list[i], why: `名单第 ${i + 1} 个` };
    return { alias, model: null, why: "名单不够四个，空的跟主模型" };
  });
}
