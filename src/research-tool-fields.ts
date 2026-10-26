/** 科研工具字段表与档案卡键的纯逻辑（不引 React / Tauri），给上下文包这类纯模块用；
 *  research-tools.ts 原样转出。 */
export interface ResearchTools {
  libraryExport: "none" | "zotero" | "endnote";
  plotting: "python" | "origin";
  illustration: "none" | "blender";
  manuscript: "markdown" | "latex" | "word";
}
export const DEFAULT_RESEARCH_TOOLS: ResearchTools = {
  libraryExport: "none", plotting: "python", illustration: "none", manuscript: "markdown",
};
export const RESEARCH_TOOL_FIELDS = [
  { key: "libraryExport", label: "文献库", options: [["none", "不使用"], ["zotero", "Zotero"], ["endnote", "EndNote"]] },
  { key: "plotting", label: "数值图", options: [["python", "Python"], ["origin", "Origin（Windows）"]] },
  { key: "illustration", label: "结构 / 装置示意", options: [["none", "不需要"], ["blender", "Blender"]] },
  { key: "manuscript", label: "稿件载体", options: [["markdown", "Markdown / Quarto"], ["latex", "LaTeX（原生源码）"], ["word", "已有 Word（人工插件验收）"]] },
] as const;
export type ResearchToolField = (typeof RESEARCH_TOOL_FIELDS)[number];
const PREFIX = "科研工具/";
/** 已废除的「文献主来源」设置键：来源只认 lit_source，写回时剥掉以免双源。 */
const LITERATURE_SETTING = `${PREFIX}literature：`;
export function researchToolsFromSettings(settings: readonly string[] = []): ResearchTools {
  const result = { ...DEFAULT_RESEARCH_TOOLS };
  for (const field of RESEARCH_TOOL_FIELDS) {
    const value = settings.find((s) => s.startsWith(`${PREFIX}${field.key}：`))?.split("：").slice(1).join("：");
    if (field.options.some(([key]) => key === value)) Object.assign(result, { [field.key]: value });
  }
  return result;
}
export function settingsWithResearchTools(settings: readonly string[], tools: ResearchTools): string[] {
  return [...settings.filter((s) => !s.startsWith(LITERATURE_SETTING) && !RESEARCH_TOOL_FIELDS.some((f) => s.startsWith(`${PREFIX}${f.key}：`))),
    ...RESEARCH_TOOL_FIELDS.filter((f) => tools[f.key] !== DEFAULT_RESEARCH_TOOLS[f.key]).map((f) => `${PREFIX}${f.key}：${tools[f.key]}`)];
}
/** 档案卡里的「科研工具/manuscript：word」是机器键，给 AI 看的规则换成界面上的说法
 *  （「稿件载体：已有 Word（人工插件验收）」）；认不出的工具键（含已废除的 literature）返回 null 不带。
 *  不是工具键的行原样返回。只用于渲染，档案卡里仍存机器键。 */
export function readableResearchToolSetting(line: string): string | null {
  if (!line.startsWith(PREFIX)) return line;
  const field = RESEARCH_TOOL_FIELDS.find((f) => line.startsWith(`${PREFIX}${f.key}：`));
  if (!field) return null;
  const value = line.slice(`${PREFIX}${field.key}：`.length).trim();
  const option = (field.options as readonly (readonly [string, string])[]).find(([key]) => key === value);
  return option ? `${field.label}：${option[1]}` : null;
}
