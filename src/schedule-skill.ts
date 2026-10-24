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

/** 「跟 AI 写技能」开聊种子：只许写草稿文件，确认后才进技能库。
 *  给了 scheduleRelPath 时顺带请 AI 按用户描述建议周期（落盘弹层预填，人可改；2026-10-23） */
export function buildWatchSkillSeedPrompt(input: {
  intent: string;
  draftRelPath: string;
  scheduleRelPath?: string;
  skillName: string;
  scheduleName: string;
}): string {
  const intent = input.intent.trim() || "（用户未写意图，先问清楚再写）";
  const schedulePart = input.scheduleRelPath
    ? `
- 再按用户意图建议多久跑一次，写入项目文件 \`${input.scheduleRelPath}\`，内容是一个 JSON 对象，例如 {"frequency":"weekdays","hour":9,"minute":0,"reason":"工作日早上看前一天的变化"}。frequency 只能是 daily（每天）、weekdays（周一到周五）、weekly（每周，另给 weekday 1-7，周一=1）、hourly（每隔几小时，另给 intervalHours，只能是 1/2/3/4/6/8/12，hour 填 0）、manual（只手动跑）；hour 0-23、minute 0-59；reason 一句话说为什么。用户没说频率就按要盯的东西多久变一次来定，说了就照用户的。`
    : "";
  return `请为这个 Mesa 项目写一份定时巡检技能的 SKILL.md。

【任务名】${input.scheduleName}
【技能目录名】${input.skillName}
【用户意图】
${intent}

【硬要求】
- 这是定时任务：Mesa 会在用户不在场时按周期无头跑，每轮会告诉它原定时刻和上一次成功运行的时间；需要跨轮记住的东西（处理过的条目、基线数字）写进 Mesa 给的跨轮记忆文件，技能里不用另找地方存。
- 把完整 SKILL.md（含 YAML frontmatter）写入项目文件 \`${input.draftRelPath}\`。${input.scheduleRelPath ? "除了这里和下面的周期建议，" : "只写这一个文件，"}不要安装到 agent 技能目录、不要改其它文件。
- frontmatter 必须含：name: ${input.skillName}；description（一行）；outputs（结果写到哪）。不要把产出写成 notes/inbox.md（那是文献雷达专用）。
- 正文写清：何时用、读什么、做什么、完成标准。约束：只新建/追加 outputs 里的文件；不删文件；未声明的表格和代码不要改；没有新内容时不要改任何文件；结束输出三行以内简报，关键数字在前。${schedulePart}
- 写完告诉我文件路径，等我在 Mesa 里确认落盘。不要说已经安装好。`;
}

/** 新建定时任务的种类默认值：科研项目默认文献雷达，其他项目默认新建巡检技能（雷达卡只在科研项目出现） */
export function defaultScheduleKind(research: boolean): "lit" | "new" {
  return research ? "lit" : "new";
}

export interface ScheduleExample {
  /** lit = 文献雷达；new = 新建巡检技能（意图预填，周期由 AI 建议） */
  kind: "lit" | "new";
  label: string;
  name: string;
  intent?: string;
}

const PAGE_WATCH_EXAMPLE: ScheduleExample = {
  kind: "new",
  label: "盯一个网页有没有变化",
  name: "网页变化提醒",
  intent:
    "每天看一下这个网页有没有更新：（在这里写网址）。有变化就把变了什么、什么时候发现的追加写进 notes/page-watch.md；没变化不要改任何文件。",
};

/** 空态里的示例：点一下打开新建弹层并预填（2026-10-23「定时任务使用优化」） */
export function scheduleExamples(workMode: "research" | "coding" | "office"): ScheduleExample[] {
  if (workMode === "coding") {
    return [
      {
        kind: "new",
        label: "每周汇总代码改动",
        name: "每周改动汇总",
        intent:
          "每周一早上汇总这个项目上一周的提交和改动，按模块列出改了什么、还有哪些没收尾的 TODO，追加写进 docs/weekly-changes.md。",
      },
      {
        kind: "new",
        label: "工作日检查依赖新版本",
        name: "依赖更新检查",
        intent:
          "工作日早上检查这个项目的依赖有没有新版本（只看，不升级），把能升级的和有安全公告的列进 docs/dependency-report.md；和上次一样就不要改文件。",
      },
      PAGE_WATCH_EXAMPLE,
    ];
  }
  if (workMode === "office") {
    return [
      {
        kind: "new",
        label: "每周汇总文档改动",
        name: "每周文档汇总",
        intent:
          "每周一早上汇总这个项目上一周新增和改动的文档，每份一句话说改了什么，追加写进 weekly-digest.md。",
      },
      PAGE_WATCH_EXAMPLE,
    ];
  }
  return [
    { kind: "lit", label: "文献雷达：每天查新文献", name: "文献雷达" },
    {
      kind: "new",
      label: "每周汇总课题进展",
      name: "每周课题进展",
      intent:
        "每周一早上汇总这个课题上一周新增和改动的笔记、数据和稿件，列成一页清单，追加写进 notes/weekly-digest.md。",
    },
    PAGE_WATCH_EXAMPLE,
  ];
}

