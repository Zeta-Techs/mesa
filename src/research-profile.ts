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

/** Mesa 从各项目里找出的反复出现的意见（research_profile_suggestions）；只提议，人点「记下」才进档案 */
export interface ProfileSuggestion {
  id: string;
  text: string;
  category: string;
  count: number;
  sources: { project: string; kind: string }[];
}

/** 提议的出处说明，也当「记下」时预填的依据 */
export function suggestionReason(s: ProfileSuggestion): string {
  const projects = [...new Set(s.sources.map((x) => x.project))];
  const kinds = [...new Set(s.sources.map((x) => x.kind))].join("、");
  return projects.length > 1
    ? `在「${projects.join("」「")}」${projects.length} 个项目的${kinds}里都出现过`
    : `在「${projects[0]}」的${kinds}里出现了 ${s.count} 次`;
}
