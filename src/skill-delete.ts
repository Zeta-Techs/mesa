/** 技能删除保护纯逻辑（删除确认弹层的数据源，与 mcp-display.ts 同层独立模块）：
 *  来源判定 + 删除影响面拼装。
 *
 *  来源口径 = SkillDto.source（持久字段，各入口写入的单一出处，不另加 origin 列）：
 *  builtin    = 内置种子（播种器写入；判定不需与种子清单现算比对——source 比现算更简单可靠）
 *  ccode      = Mesa 新建（v3.100 起 create_skill 写入）
 *  local      = 本地目录导入；旧数据的自建技能同记 local 无法区分
 *  zip/github = ZIP / GitHub 仓库导入（github 带 repo 记录）
 *  discovered = 从 Agent 目录收编
 *  fail-safe：空串/未知值与旧 local 一律按「非自建」对待——删除提示宁可多讲来源，
 *  也不漏掉「内置技能删除后不复活」这类警告。 */

/** 内置种子技能：删除后不会随启动恢复（播种只补缺失项、不复活已删除项），弹层须额外警告 */
export function isBuiltinSkill(source: string): boolean {
  return source === "builtin";
}

/** 删除弹层的来源说明：内置/自建返回 null（内置有专门警告行、自建无需说明）；
 *  外部导入给出渠道（github 带仓库名）；空串/未知按「未知来源」提示（fail-safe） */
export function skillOriginLabel(skill: {
  source: string;
  repo?: string | null;
}): string | null {
  switch (skill.source) {
    case "builtin":
    case "ccode":
      return null;
    case "github":
      return skill.repo
        ? `GitHub 仓库 ${skill.repo} 导入`
        : "GitHub 导入（未记录仓库）";
    case "zip":
      return "ZIP 文件导入";
    case "local":
      // 旧数据：自建与本地导入同记 local，按外部导入提示（fail-safe）
      return "本地目录导入或早期自建";
    case "discovered":
      return "从 Agent 目录收编";
    default:
      return "未知来源";
  }
}

/** 删除影响面：apps 里值为 true 的 Agent 显示名清单（按 agents 表序，稳定可测）。
 *  后端删除时只清理 Mesa 分发的副本/链接（symlink 指向库目录或带 .ccode-copy 标记），
 *  agent 目录里用户自放的同名内容本就不会被动 */
export function skillDeleteImpact(
  apps: Record<string, boolean>,
  agents: ReadonlyArray<{ id: string; label: string }>,
): string[] {
  return agents.filter((a) => apps[a.id]).map((a) => a.label);
}
