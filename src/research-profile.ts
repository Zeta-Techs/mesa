/**
 * 研究档案纯逻辑（2026-11-02，docs/design-research-moat.md §3.3）：条目沿用项目长期知识的格式
 * （goalName 在这里当分类），只列有效条目、按固定分类顺序分组；跨项目文献总表的筛选。
 */

export interface ProfileEntryDto {
  meta: { id: string; createdAt: string; goalName: string; state: string; reason: string; replaces?: string | null };
  text: string;
}

export interface ResearchProfileDto {
  doc: { revision: string; legacyText: string; entries: ProfileEntryDto[] };
  settings: { inject: boolean };
  categories: string[];
}

export interface ProfilePaper {
  title: string;
  doi: string;
  year: string;
  projects: string[];
  hasNote: boolean;
}

/** 有效条目按分类分组；分类顺序跟后端给的一致，组内新的在前 */
export function activeProfileGroups(profile: ResearchProfileDto): { category: string; entries: ProfileEntryDto[] }[] {
  const active = profile.doc.entries.filter((e) => e.meta.state === "active");
  return profile.categories
    .map((category) => ({
      category,
      entries: active.filter((e) => e.meta.goalName === category).reverse(),
    }))
    .filter((g) => g.entries.length > 0);
}

export function filterProfilePapers(papers: readonly ProfilePaper[], query: string): ProfilePaper[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...papers];
  return papers.filter(
    (p) => p.title.toLowerCase().includes(q) || p.doi.includes(q) || p.projects.some((name) => name.toLowerCase().includes(q)),
  );
}
