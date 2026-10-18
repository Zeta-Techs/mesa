/**
 * 随包第三方许可清单（src-tauri/resources/third-party-notices.md，`npm run gen:notices` 生成）
 * 的展示解析：npm / Rust 两张依赖表拆成可搜索的行；其余各节（内嵌资产 / 数据来源 / 设计参考
 * 致谢）原样保留为 Markdown 交给阅读版式。文件头的生成说明是写给维护者的，界面不展示。
 */

export interface NoticeDep {
  name: string;
  version: string;
  license: string;
}

export interface NoticeGroup {
  /** 节标题去掉括注：「前端依赖」「Rust 依赖」 */
  title: string;
  /** 括注里的说明：「npm，随安装包分发」 */
  note: string;
  deps: NoticeDep[];
}

export interface ParsedNotices {
  /** 非依赖表各节（含 `## ` 标题），按原顺序拼回的 Markdown */
  prose: string;
  groups: NoticeGroup[];
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function parseNotices(md: string): ParsedNotices {
  const sections: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  let inFence = false;
  for (const line of md.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (!inFence && line.startsWith("## ")) {
      current = { title: line.slice(3).trim(), lines: [] };
      sections.push(current);
      continue;
    }
    // 第一个 `## ` 之前是文件标题与生成说明，丢弃
    current?.lines.push(line);
  }

  const prose: string[] = [];
  const groups: NoticeGroup[] = [];
  for (const section of sections) {
    const rows = section.lines.filter((l) => l.trimStart().startsWith("|"));
    const header = rows.length ? tableCells(rows[0]) : [];
    if (header[0] === "组件") {
      const deps: NoticeDep[] = [];
      for (const row of rows.slice(1)) {
        const cells = tableCells(row);
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        if (cells.length < 3 || !cells[0]) continue;
        deps.push({ name: cells[0], version: cells[1], license: cells.slice(2).join(" | ") });
      }
      const m = /^(.*?)（(.*)）$/.exec(section.title);
      groups.push({
        title: m ? m[1].trim() : section.title,
        note: m ? m[2].trim() : "",
        deps,
      });
      continue;
    }
    prose.push(`## ${section.title}`, ...section.lines);
  }
  return { prose: prose.join("\n").trim(), groups };
}

/** 按组件名或许可搜索（不分大小写）；空查询原样返回，搜完空了的组不留 */
export function filterNoticeGroups(
  groups: readonly NoticeGroup[],
  query: string,
): NoticeGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...groups];
  return groups
    .map((g) => ({
      ...g,
      deps: g.deps.filter(
        (d) => d.name.toLowerCase().includes(q) || d.license.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.deps.length > 0);
}

export function noticeDepCount(groups: readonly NoticeGroup[]): number {
  return groups.reduce((n, g) => n + g.deps.length, 0);
}
