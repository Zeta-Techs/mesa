/**
 * 定时巡检「技能」下拉与任务名默认值、新建巡检技能的种子 prompt。
 *
 * - 选项：lit-watch 恒在最前；其余只收分类为「巡检」的技能（一次性内置技能不进下拉）。
 * - 下拉 value = 技能目录名（Schedule.skill / Agent 查找用），不是库 UUID。
 * - 默认任务名跟随技能：lit-watch = 「文献雷达」，巡检技能 = 技能名；手改过的名称不被覆盖。
 */

export const WATCH_SKILL_CATEGORY = "巡检";
export const LIT_WATCH_SKILL = "lit-watch";

export interface ScheduleSkillOption {
  /** 写入 Schedule.skill 的值（技能目录名） */
  id: string;
  /** 下拉显示名 */
  name: string;
}

export interface SkillLike {
  id: string;
  name: string;
  category?: string | null;
}

/** 下拉选项：文献雷达 + 分类「巡检」的技能。value 一律用目录名。 */
export function scheduleSkillOptions(
  skills: readonly SkillLike[],
): ScheduleSkillOption[] {
  const watch = skills.filter(
    (s) =>
      s.name !== LIT_WATCH_SKILL && s.category === WATCH_SKILL_CATEGORY,
  );
  return [
    { id: LIT_WATCH_SKILL, name: "文献雷达" },
    ...watch.map((s) => ({ id: s.name, name: s.name })),
  ];
}

/** 编辑时若当前技能不在下拉里（存量任务），补一条以免保存丢值 */
export function scheduleSkillOptionsForEdit(
  skills: readonly SkillLike[],
  currentSkill: string,
): ScheduleSkillOption[] {
  const opts = scheduleSkillOptions(skills);
  const cur = currentSkill.trim();
  if (cur && !opts.some((o) => o.id === cur)) {
    opts.push({ id: cur, name: cur });
  }
  return opts;
}

/** 默认任务名：lit-watch = 文献雷达；其他技能 = 技能显示名（库缺失兜底 id） */
export function defaultScheduleName(
  skillId: string,
  skills: readonly SkillLike[],
): string {
  if (skillId === LIT_WATCH_SKILL) return "文献雷达";
  return skills.find((s) => s.name === skillId || s.id === skillId)?.name || skillId;
}

/** 切换技能时的任务名跟随：名为空或等于上一技能的默认名 = 未手改 → 跟随新默认；否则保留 */
export function followSkillName(
  currentName: string,
  prevSkillId: string,
  nextSkillId: string,
  skills: readonly SkillLike[],
): string {
  const untouched =
    currentName.trim() === "" ||
    currentName === defaultScheduleName(prevSkillId, skills);
  return untouched ? defaultScheduleName(nextSkillId, skills) : currentName;
}

/** 草稿相对项目根：`.ccode/drafts/watch-<id>.md`（id 已是落盘安全名） */
export function watchDraftRelPath(id: string): string {
  return `.ccode/drafts/watch-${id}.md`;
}

export function watchDraftMetaRelPath(id: string): string {
  return `.ccode/drafts/watch-${id}.meta.json`;
}

/** 任务名 → 技能目录名候选（后端还会再校验） */
export function suggestWatchSkillName(taskName: string): string {
  const s = taskName
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "watch-skill";
}

export function isLitWatchSkill(skill: string): boolean {
  return skill === LIT_WATCH_SKILL;
}

/** 「跟 AI 写技能」开聊种子：只许写草稿文件，确认后才进技能库 */
export function buildWatchSkillSeedPrompt(input: {
  intent: string;
  draftRelPath: string;
  skillName: string;
  scheduleName: string;
}): string {
  const intent = input.intent.trim() || "（用户未写意图，先问清楚再写）";
  return `请为这个 Mesa 项目写一份定时巡检技能的 SKILL.md。

【任务名】${input.scheduleName}
【技能目录名】${input.skillName}
【用户意图】
${intent}

【硬要求】
- 这是定时任务：Mesa 会在用户不在场时按每天/每周无头跑。
- 把完整 SKILL.md（含 YAML frontmatter）写入项目文件 \`${input.draftRelPath}\`。只写这一个文件，不要安装到 agent 技能目录、不要改其它文件。
- frontmatter 必须含：name: ${input.skillName}；description（一行）；outputs（结果写到哪）。不要把产出写成 notes/inbox.md（那是文献雷达专用）。
- 正文写清：何时用、读什么、做什么、完成标准。约束：只新建/追加 outputs 里的文件；不删文件；未声明的表格和代码不要改；结束输出三行以内简报，关键数字在前。
- 写完告诉我文件路径，等我在 Mesa 里确认落盘。不要说已经安装好。`;
}
