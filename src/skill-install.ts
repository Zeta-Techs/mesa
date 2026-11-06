import { invoke } from "@tauri-apps/api/core";
import type { SkillDto } from "./types";

/** 就地把库里的技能装给一家 Agent（上手向导「装上内置技能」、开工弹层「现在装上」共用）：
 *  没启用的走 apply_skill 打开，已启用但复制件过期的走 resync_skill_copies 重拷；
 *  库里没有的装不了，交给调用方提示去技能页。写的是该 Agent 的技能目录，只在人点按钮后调用。 */
export interface SkillInstallPlan {
  enable: SkillDto[];
  resync: SkillDto[];
  /** 库里找不到（没导入或删掉了），这里装不了 */
  missing: string[];
}

/** names 为 null = 全部内置技能（source=builtin）；规格没声明这家技能目录的（apps 无此键）不算 */
export function planSkillInstall(skills: SkillDto[], names: string[] | null, agent: string): SkillInstallPlan {
  const plan: SkillInstallPlan = { enable: [], resync: [], missing: [] };
  const wanted = names ?? skills.filter((s) => s.source === "builtin").map((s) => s.name);
  for (const name of wanted) {
    const skill = skills.find((s) => s.name === name);
    if (!skill || !(agent in skill.apps)) {
      plan.missing.push(name);
    } else if (!skill.apps[agent]) {
      plan.enable.push(skill);
    } else if ((skill.staleCopies ?? []).includes(agent)) {
      plan.resync.push(skill);
    }
  }
  return plan;
}

export function planIsEmpty(plan: SkillInstallPlan): boolean {
  return plan.enable.length === 0 && plan.resync.length === 0;
}

/** 逐个执行；一个失败就停下抛错，已装上的保留（重试时计划会重算，只剩没装的） */
export async function runSkillInstall(plan: SkillInstallPlan, agent: string): Promise<void> {
  for (const skill of plan.enable) {
    await invoke("apply_skill", { id: skill.id, agent, enabled: true });
  }
  for (const skill of plan.resync) {
    await invoke("resync_skill_copies", { id: skill.id });
  }
}
