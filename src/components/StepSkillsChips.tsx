import { useState } from "react";
import { skillChainWarnings, skillOutputConflicts, unresolvedSkillRefs } from "../skill-conflicts";
import type { SkillDto } from "../types";

/**
 * 步骤「推荐技能」chip 区（v3.67）：步骤级 TASK.md 预览弹层（只读）与开工确认弹层（可编辑）共用。
 * 只读：chip 点击展开/收起一句话描述；可编辑（给了 onChange）：chip 带 × 移除 + 尾部「＋ 添加技能」下拉。
 * 增删的持久化由调用方负责（update_step_skills 写回 project.toml steps[].skills）。
 * mcpRecommended 命中的技能在 chips 下方出一行暗色提示（2026-09-15 两轮收口：先是 chip 旁独立
 * 「推荐 MCP」钮——夹在技能中间像第三个条目、单击还把确认弹层甩去 MCP 页；再是并进 chip 的
 * 「· MCP」后缀——看着像技能名的一部分。最终形态＝chips 行下独立提示行，与产物冲突 ⚠ 行
 * 同一范式、点名技能、纯文本不导航；配置入口留给步骤面板的人工事项预设按钮（带预填）与 MCP 页）。
 * 给了 skillLib 时检测挂载技能的产物路径冲突（outputs 相交），chips 下方逐行 ⚠ 提示（v3.79）。
 * 给了 requiredSkills/onRequiredChange 时，编辑器可在技能 chip 上切换必需/可选；未提供时保持只读兼容。
 */
export default function StepSkillsChips({
  skills,
  skillMeta,
  available,
  mcpRecommended,
  skillLib,
  onChange,
  requiredSkills,
  onRequiredChange,
  chainSupply,
  expectedArtifacts,
  stepOutputs,
  brief,
  hint,
  bare = false,
}: {
  /** 步骤当前挂载的技能名（project.toml steps[].skills） */
  skills: string[];
  /** 必需技能子集；缺省兼容为全部必需，显式空数组表示全部可选。 */
  requiredSkills?: string[];
  /** 技能库元数据（name → 一句话描述）；缺省时 chip 只显示名字 */
  skillMeta: Record<string, string> | undefined;
  /** 可编辑时的候选清单（已安装技能名，调用方排除已挂载与否均可，组件内再过滤一次） */
  available?: string[];
  /** SKILL.md 提及 MCP 工具的技能名（后端内容扫描）：chip 旁显示「推荐 MCP」标记 */
  mcpRecommended?: string[];
  /** 技能库完整条目（产物冲突/链路校验用；缺省 = 不检测） */
  skillLib?: SkillDto[] | null;
  /** 提供 = 可编辑模式；增删后的完整 skills 数组经此回调 */
  onChange?: (next: string[]) => void;
  /** 编辑必需技能子集；仅在步骤编辑器提供。 */
  onRequiredChange?: (next: string[]) => void;
  /** 链路校验供给侧：上游步骤产物 + 本步骤声明输入 + 项目资源（与 expectedArtifacts 一起给才启用） */
  chainSupply?: string[];
  /** 本步骤预期产物（链路校验：技能 outputs 未进清单时提示；空数组 = 不检 output 侧） */
  expectedArtifacts?: string[];
  /** 本步合同实际要写的文件。给了就只检查这批，不拿技能声明里别的阶段来报。 */
  stepOutputs?: string[];
  /** 步骤简报：{skill:锚名} 占位校验用（点名了没挂载的技能位 → 提醒，不拦截） */
  brief?: string;
  /** 标题旁小字；false = 不写（开工弹层用 tooltip 承担） */
  hint?: string | false;
  /** 不画「技能」标题行与外边距：开工弹层把标签放在左侧标签列，与读入/产出/执行同列对齐 */
  bare?: boolean;
}) {
  // 只读模式下点击 chip 展开描述（按技能名记忆展开态）
  const [expanded, setExpanded] = useState<string | null>(null);
  const editable = !!onChange;
  const canEditRequired = editable && !!onRequiredChange;
  const required = new Set(requiredSkills ?? skills);
  const showRequirement = requiredSkills !== undefined;
  const candidates = (available ?? []).filter((name) => !skills.includes(name));
  const outputConflicts = skillLib ? skillOutputConflicts(skills, skillLib) : [];
  const unresolvedRefs = skillLib && brief ? unresolvedSkillRefs(brief, skills, skillLib) : [];
  const chainWarnings =
    skillLib && chainSupply && expectedArtifacts
      ? skillChainWarnings(skills, skillLib, chainSupply, expectedArtifacts, stepOutputs)
      : [];
  if (skills.length === 0 && !editable) return null;
  return (
    <div className={bare ? "min-w-0" : "mb-3 shrink-0"}>
      {!bare && <div className="mb-1 flex items-center gap-2">
        <span
          className="text-xs text-l3"
          title={
            editable
              ? "增删会写回这一步的技能，以后开工都用这份"
              : "点击技能名看一句话说明"
          }
        >
          技能
        </span>
        {hint !== false && (
          <span className="text-micro text-l4">
            {hint ??
              (editable
                ? "增删写回这一步，以后开工都用"
                : "点击看说明")}
          </span>
        )}
      </div>}
      <div className="flex flex-wrap items-center gap-1 text-micro">
        {skills.map((name) => {
          const desc = skillMeta?.[name];
          const open = expanded === name && !editable;
          const label = (
            <>
              {name}
              {!editable && showRequirement && (
                <span className="text-micro text-l4">
                  （{required.has(name) ? "必需" : "可选"}）
                </span>
              )}
              {!(name in (skillMeta ?? {})) && (
                <span className="text-micro text-l4">（未安装）</span>
              )}
            </>
          );
          const chipClass =
            "flex items-center gap-1 rounded-sm bg-inset px-1.5 py-0.5 text-micro text-l2";
          return (
            <span key={name} className="flex flex-col">
              <span className="flex items-center gap-1">
                {editable ? (
                  <span className={chipClass} title={desc ?? name}>
                    {label}
                    {canEditRequired && (
                      <button
                        type="button"
                        className="rounded-sm px-1 text-micro text-l4 hover:text-l1"
                        title={required.has(name) ? "改为可选技能" : "改为必需技能"}
                        aria-label={`${name}：${required.has(name) ? "改为可选技能" : "改为必需技能"}`}
                        onClick={() => {
                          const next = new Set(required);
                          if (next.has(name)) next.delete(name);
                          else next.add(name);
                          onRequiredChange([...next].filter((skill) => skills.includes(skill)));
                        }}
                      >
                        {required.has(name) ? "必需" : "可选"}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`移除技能 ${name}`}
                      title="从步骤定义移除"
                      onClick={() => onChange(skills.filter((s) => s !== name))}
                      className="rounded-sm px-0.5 text-l4 hover:text-l1"
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : name)}
                    title={open ? "收起说明" : (desc ?? "查看说明")}
                    className={`${chipClass} hover:bg-hover`}
                  >
                    {label}
                  </button>
                )}
              </span>
              {open && desc && (
                <span className="max-w-72 px-1.5 py-0.5 text-micro text-l4">
                  {desc}
                </span>
              )}
            </span>
          );
        })}
        {editable && candidates.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const name = e.target.value;
              if (name) onChange([...skills, name]);
            }}
            title="添加技能到步骤定义"
            className="h-6 rounded-md border border-field bg-canvas px-1 text-micro text-l4 outline-none focus:border-l4"
          >
            <option value="">＋ 添加技能</option>
            {candidates.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>
      {skills
        .filter((name) => mcpRecommended?.includes(name))
        .map((name) => (
          <p key={`mcp-${name}`} className="mt-1 text-micro text-l4">
            · 技能「{name}」说明里推荐配合 MCP 工具（可选，不配也能跑）——配置在左侧
            MCP 页
          </p>
        ))}
      {outputConflicts.map((c) => (
        <p key={`${c.a}|${c.b}`} className="mt-1 text-micro text-warn-text">
          ! 技能「{c.a}」与「{c.b}」的产物都指向 {c.output}
          ——确认步骤简报里写明了分工（如“按 {c.a} 执行、{c.b} 只出报告”）
        </p>
      ))}
      {chainWarnings.map((w) => (
        <p
          key={`${w.skill}|${w.kind}|${w.path}`}
          className="mt-1 text-micro text-warn-text"
        >
          {w.kind === "input"
            ? `! 技能「${w.skill}」预期读入 ${w.path}，但上游产物、本步骤输入与项目资源里都没有——确认上游落点或调整技能`
            : `! 技能「${w.skill}」产出 ${w.path}，不在本步骤预期产物里——中间产物可忽略，关键产物建议补进步骤定义`}
          {w.inferred ? "（接口为正文推断，供参考）" : ""}
        </p>
      ))}
      {unresolvedRefs.length > 0 && (
        <p className="mt-1 text-micro text-warn-text">
          ! 简报点名的技能位（{unresolvedRefs.join("、")}）在本步骤没有挂载占据者——
          正文指令会保留占位原样；挂载对应技能或声明 provides 即顶位
        </p>
      )}
    </div>
  );
}
