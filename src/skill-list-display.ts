/**
 * 技能页列表按用途分（2026-10-31 用户：「按建议做」；tests/skill-list-display.test.ts）。
 * 「Mesa 内置」组内按用途加小标题（10-11 拍板的「Mesa 内置」分组不动），组内原有顺序不变；
 * 每行左侧的图标也按用途取（SkillsPage USAGE_ICONS），不是每行一样的占位方块。
 */

/** 内置技能按用途分小节；顺序即小节顺序。新增内置技能没登记的落「其他」 */
export const BUILTIN_USAGE_GROUPS: ReadonlyArray<{ label: string; names: readonly string[] }> = [
  { label: "文献", names: ["lit-search", "lit-notes", "lit-watch", "zotero-sync", "endnote-bridge"] },
  {
    label: "数据与作图",
    names: ["data-clean", "data-eda", "figure-forge", "schematic-forge", "origin-plot", "image-gen", "blender-research"],
  },
  {
    label: "写作与成稿",
    names: [
      "proposal-writer",
      "review-framework",
      "review-writing",
      "review-figures",
      "research-writing",
      "rebuttal-crafter",
      "slides-deck",
      "quarto-render",
    ],
  },
  { label: "审查与校对", names: ["bib-check", "stats-check"] },
];

/** 技能属于哪个用途小节；没登记的（含用户自己的技能）= 「其他」 */
export function usageGroupOf(name: string): string {
  return BUILTIN_USAGE_GROUPS.find((g) => g.names.includes(name))?.label ?? "其他";
}

/** 把一组技能按用途切成小节；空小节不出；每节内保持传入顺序 */
export function groupByUsage<T extends { name: string }>(
  skills: readonly T[],
): { label: string; skills: T[] }[] {
  const out = BUILTIN_USAGE_GROUPS.map((g) => ({
    label: g.label,
    skills: skills.filter((s) => g.names.includes(s.name)),
  }));
  const known = new Set(BUILTIN_USAGE_GROUPS.flatMap((g) => g.names));
  out.push({ label: "其他", skills: skills.filter((s) => !known.has(s.name)) });
  return out.filter((g) => g.skills.length > 0);
}
