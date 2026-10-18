import type { McpServerDto, SkillDto } from "../types";

/**
 * 「插入技能 / MCP」菜单的条目：运行页收缩行「插入」、标签栏 ✦、聊天输入框 ＋ 三处共用
 * （2026-10-17 前是三份手写，标签栏那份连分段标题和说明都没有，同时打开时长得不一样）。
 * 只画条目，外层浮层的定位/限高/关闭由调用方负责；渲染成 <li>，放进 <ul> 里用。
 */
export default function InsertMenuItems({
  skills,
  mcps,
  onSkill,
  onMcp,
  onManageMcp,
}: {
  skills: readonly SkillDto[];
  mcps: readonly McpServerDto[];
  onSkill: (name: string) => void;
  onMcp: (name: string) => void;
  /** 有则在末尾给「管理 MCP 分发」出口（聊天输入框里不放，避免离开对话） */
  onManageMcp?: () => void;
}) {
  if (skills.length === 0 && mcps.length === 0) {
    return <li className="px-2 py-3 text-xs text-l4">当前 Agent 没有可插入的技能或 MCP</li>;
  }
  return (
    <>
      {skills.length > 0 && (
        <li className="px-2 pb-0.5 pt-1.5 text-micro text-l4">技能</li>
      )}
      {skills.map((skill) => (
        <li key={skill.id}>
          <button
            type="button"
            onClick={() => onSkill(skill.name)}
            className="flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-hover"
          >
            <span className="text-xs text-l1">{skill.name}</span>
            {skill.description && (
              <span className="truncate text-micro text-l4">{skill.description}</span>
            )}
          </button>
        </li>
      ))}
      {mcps.length > 0 && (
        <li
          className={`px-2 pb-0.5 pt-1.5 text-micro text-l4 ${
            skills.length > 0 ? "mt-1 border-t border-hairline" : ""
          }`}
        >
          MCP
        </li>
      )}
      {mcps.map((mcp) => (
        <li key={mcp.id}>
          <button
            type="button"
            onClick={() => onMcp(mcp.name)}
            className="flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-hover"
          >
            <span className="text-xs text-l1">{mcp.name}</span>
            <span className="truncate font-mono text-micro text-l4">
              {mcp.kind === "stdio" ? `${mcp.command} ${mcp.args.join(" ")}` : mcp.url}
            </span>
          </button>
        </li>
      ))}
      {onManageMcp && (
        <li className="mt-1 border-t border-hairline">
          <button
            type="button"
            onClick={onManageMcp}
            className="flex w-full rounded-sm px-2 py-1.5 text-left text-micro text-l4 hover:bg-hover hover:text-l2"
          >
            管理 MCP 分发 →（变更对新会话生效）
          </button>
        </li>
      )}
    </>
  );
}
