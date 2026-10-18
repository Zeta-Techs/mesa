/**
 * ⌘K 命令面板的过滤与排序纯逻辑：与 DOM 解耦，node --test 直接单测。
 * 命令清单（快速操作 / 最近项目 / 页面 / 外观 / 帮助 / 设置分区 / 主题）由 CommandPalette.tsx 组装后传入。
 */

export interface PaletteCommand {
  id: string;
  /** 主标题（列表行主显） */
  title: string;
  /** 右侧弱化提示（如快捷键 ⌘1、项目的工作方式、「当前」） */
  hint?: string;
  /** 面板中的分组标题；同组命令在列表里连在一起 */
  group?: string;
  /** 额外匹配词（英文别名、拼音、设置项别名等），大小写不敏感 */
  keywords: string[];
  /** 只在搜索时出现：设置分区、单个主题、较早的项目——默认列表不列，免得一屏全是它们 */
  searchOnly?: boolean;
}

function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (const ch of s) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return true;
  }
  return false;
}

/** 单条命令对查询的得分（0 = 不命中）。标题优先于别名，开头命中优先于中间命中；
 *  「主题：琥珀」「设置：网络」这类带前缀的标题，冒号后的部分按开头命中算；
 *  两个字以上的查询再兜一层按序散字命中（「设网」→「设置：网络」），分最低。 */
export function scoreCommand(c: PaletteCommand, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const title = c.title.toLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  const tail = title.slice(title.lastIndexOf("：") + 1);
  if (tail !== title && tail.startsWith(q)) return 75;
  if (title.includes(q)) return 60;
  let best = 0;
  for (const k of c.keywords) {
    const kw = k.toLowerCase();
    if (kw === q) best = Math.max(best, 55);
    else if (kw.startsWith(q)) best = Math.max(best, 50);
    else if (kw.includes(q)) best = Math.max(best, 40);
  }
  if (best) return best;
  if (q.length >= 2 && isSubsequence(q, title)) return 20;
  return 0;
}

/** 标题没命中、靠别名命中时返回那个别名（设置分区行尾展示「为什么搜到它」：搜「代理」→ 设置：网络 · 代理） */
export function matchedKeyword(c: PaletteCommand, query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!q || c.title.toLowerCase().includes(q)) return null;
  return c.keywords.find((k) => k.toLowerCase().includes(q)) ?? null;
}

/**
 * 命令过滤：空查询返回非 searchOnly 的命令、保持原顺序（面板打开时的默认列表）；
 * 非空时只留命中的，按得分排序——组与组按组内最高分排、组内按分排（同分保持原顺序），
 * 同组命令始终连在一起，分组标题不会被打散。
 */
export function filterCommands(
  commands: PaletteCommand[],
  query: string,
): PaletteCommand[] {
  if (!query.trim()) return commands.filter((c) => !c.searchOnly);
  const scored = commands
    .map((c, i) => ({ c, i, s: scoreCommand(c, query) }))
    .filter((x) => x.s > 0);
  const groupBest = new Map<string, { s: number; i: number }>();
  for (const x of scored) {
    const g = x.c.group ?? "";
    const cur = groupBest.get(g);
    if (!cur || x.s > cur.s) groupBest.set(g, { s: x.s, i: cur ? Math.min(cur.i, x.i) : x.i });
    else if (x.i < cur.i) groupBest.set(g, { s: cur.s, i: x.i });
  }
  return scored
    .sort((a, b) => {
      const ga = groupBest.get(a.c.group ?? "")!;
      const gb = groupBest.get(b.c.group ?? "")!;
      if (ga !== gb) return gb.s - ga.s || ga.i - gb.i;
      return b.s - a.s || a.i - b.i;
    })
    .map((x) => x.c);
}
