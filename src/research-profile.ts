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
  /** 附给 AI 的原文（不看开关；开关关着时实际不附） */
  context: string;
}

/** 新增栏按分类给的例句（只是占位提示，不进档案） */
export const CATEGORY_EXAMPLES: Record<string, string> = {
  研究方向: "例如：钠离子电池负极，侧重界面副反应机理",
  常用方法: "例如：阻抗谱用等效电路拟合，报告拟合误差",
  数据处理习惯: "例如：缺失值超过 20% 的变量直接剔除，不插补",
  写作偏好: "例如：少用被动句；结论里不写「首次」",
  导师意见: "例如：图注写清样本量和误差棒含义",
  放弃的方向: "例如：试过隔膜涂层改性，循环寿命没改善，不再做",
  其他: "例如：组会汇报用中文，图里的标注用英文",
};

/** 档案此刻对 AI 的状态：生效几条 / 关着 / 还没条目 */
export function profileStatus(profile: ResearchProfileDto): { tone: "on" | "off" | "empty"; count: number } {
  const count = profile.doc.entries.filter((e) => e.meta.state === "active").length;
  if (count === 0) return { tone: "empty", count };
  return { tone: profile.settings.inject ? "on" : "off", count };
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
