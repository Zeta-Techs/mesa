/** 流程线「更换引用样式」。点具体形式后，回到这一步原来的对话让 Agent 重渲。
 *  格式只在定稿步定：起草步不装选择器，初稿固定按编号制渲。 */

export const CITATION_STYLE_TASK = "更换引用样式";
/** 已有项目档案里还是旧标题，界面按同一件事显示。 */
export const CITATION_STYLE_TASK_OLD = "填写引用样式";

export function isCitationStyleTask(title: string | undefined): boolean {
  return title === CITATION_STYLE_TASK || title === CITATION_STYLE_TASK_OLD;
}

export const CITATION_STYLE_CHOICES = [
  {
    id: "numbered",
    label: "编号",
    forms: [
      { id: "bracket", label: "方括号 [1]", ask: "正文引用改成方括号编号，如 [1]、[2,3]，文末按出现顺序排列。" },
      { id: "superscript", label: "上标 ¹", ask: "正文引用改成上标数字，如 ¹、²，不加方括号，文末按出现顺序排列。" },
      // 国内学位论文与中文期刊（2026-11-02）：随包的 GB/T 7714-2015 顺序编码制 CSL，正文上标方括号
      {
        id: "gbt7714",
        label: "GB/T 7714",
        ask: "正文引用与文末文献表按国家标准 GB/T 7714-2015 顺序编码制排：把 quarto-render 技能目录里的 gbt7714-numeric.csl 复制成稿件旁的 citation.csl，正文为上标方括号编号如 ^[1]^，文末带 [J]、[M] 等文献类型标识。学校另有细则时以学校规范为准，对不上的停下来问。",
      },
    ],
  },
  {
    id: "author-year",
    label: "作者-年",
    forms: [
      { id: "comma", label: "(Author, Year)", ask: "正文引用改成作者-年，作者和年份之间加逗号，如 (Bieker et al., 2021)，文末按作者字母排序。" },
      { id: "plain", label: "(Author Year)", ask: "正文引用改成作者-年，作者和年份之间不加逗号，如 (Bieker et al. 2021)，文末按作者字母排序。" },
    ],
  },
] as const;

export function journalAsk(name: string): string {
  const journal = name.trim();
  return `正文引用按《${journal}》重排。先读该刊作者须知，再从 references.bib 里取该刊最近 2–3 篇综述，核对正文引用和文末文献表实际怎么排；库里没有就写明，不另找。须知和这几篇不一致时停下来问，不猜。`;
}

/** 老 citation-style.md 里写明的目标期刊。文末「选定：作者-年」不算期刊名。 */
export function currentJournal(styleMd: string): string | null {
  const hits = [...styleMd.matchAll(/按期刊[：:]\s*([^\n（(]+)/g)];
  const last = hits[hits.length - 1];
  const name = last?.[1]?.replace(/[。.\s]+$/, "").trim() ?? "";
  return name.length > 1 ? name : null;
}

/** submission/target-journal.md 里已定的期刊。这是「沿用」按钮的唯一来源。 */
export function parseTargetJournal(doc: string): string | null {
  const hit = doc.match(/^期刊[：:][ \t]*(.+)$/m);
  const name = hit?.[1]?.replace(/[。.\s]+$/, "").trim() ?? "";
  return name.length > 1 ? name : null;
}

export type StyleFamily = "numeric-bracket" | "numeric-superscript" | "author-date";

/**
 * 按 csl 正文判定它属于哪一类样式，用来核对换的样式到底落没落。
 * 取材于随包的 ieee.csl / author-date.csl：数字制标 citation-format="numeric"
 * 且在 citation 布局里排 citation-number，方括号版带 prefix="["，上标版用 vertical-align。
 * 认不出来返回 null（csl 语法复杂，不做过度承诺）。
 */
export function styleFamilyOf(cslText: string): StyleFamily | null {
  if (/citation-format="numeric"/.test(cslText)) {
    const layout = cslText.match(/<citation[\s\S]*?<\/citation>/)?.[0] ?? cslText;
    if (/vertical-align\s*=\s*"sup"/.test(layout)) return "numeric-superscript";
    if (/prefix\s*=\s*"\["/.test(layout)) return "numeric-bracket";
    return null;
  }
  if (/citation-format="author-date"/.test(cslText)) return "author-date";
  return null;
}

export function targetJournalDoc(name: string, source: "沿用已定" | "本次选定"): string {
  return `# 目标期刊\n\n期刊：${name.trim()}\n来源：${source}\n\n下一步投稿格式按这一份，不再另问目标期刊。\n`;
}

/** 行内形式的 id → 期望的样式类别。与随包 csl 的判据同一套（styleFamilyOf）。 */
export function citationFormFamily(formId: string): StyleFamily | null {
  if (formId === "bracket") return "numeric-bracket";
  if (formId === "superscript" || formId === "gbt7714") return "numeric-superscript";
  if (formId === "comma" || formId === "plain") return "author-date";
  return null;
}

/** 样式族的人话标签，面板上回显当前生效的是什么。 */
export const STYLE_FAMILY_LABEL: Record<StyleFamily, string> = {
  "numeric-bracket": "编号・方括号 [1]",
  "numeric-superscript": "编号・上标 ¹",
  "author-date": "作者-年",
};

/** references.bib 里出现最多的期刊，最多 5 个。 */
export function topJournals(bib: string): { name: string; count: number }[] {
  const seen = new Map<string, { name: string; count: number }>();
  for (const match of bib.matchAll(
    /(?:^|[\s,{])(?:journal|journaltitle)[ \t]*=[ \t]*(?:\{([^}]*)\}|"([^"]*)")/gi,
  )) {
    const name = (match[1] ?? match[2] ?? "").replace(/\s+/g, " ").trim();
    if (name.length < 2) continue;
    const key = name.toLowerCase();
    const row = seen.get(key);
    if (row) row.count += 1;
    else seen.set(key, { name, count: 1 });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 5);
}

/** 交给原对话的一句。只说要哪种引用，四份成稿由 Agent 按这一步已有任务重做。 */
export function citationRerenderPrompt(ask: string): string {
  return `${ask}重新渲染 PDF 和普通 Word，并重新生成 output/endnote.docx 与 output/zotero.docx。LaTeX 稿不生成这两份域稿。渲完把结果告诉我。`;
}

/** 定稿开工时问一次：沿用初稿编号，还是改成目标期刊。 */
export function citationCarryAsk(journal: string | null): string {
  const keep = "初稿是编号制。沿用就继续用编号；";
  if (journal) {
    return `${keep}改投《${journal}》就按该刊作者须知，并对照 references.bib 里该刊最近 2–3 篇综述。你选哪一种？`;
  }
  return `${keep}换期刊就先告诉我刊名。你选哪一种？`;
}
