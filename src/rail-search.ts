import type { RunCaretState } from "./run-caret";

/**
 * 侧栏「搜索对话和项目」弹层的纯逻辑（2026-10-24 照 Claude 客户端）：
 * 不输入时列最近的对话；输入后先列命中的项目、再列命中的对话。
 * 匹配不分大小写，按空白拆词、每个词都要命中（标题 / 所在文件夹名 / 项目路径任一处）。
 */

export interface RailSearchChat<T> {
  /** agent + sessionId，去重用 */
  key: string;
  /** 侧栏同款短标题（去掉「MMDD|类型|」） */
  title: string;
  /** 完整标题：搜得到类型和日期 */
  fullTitle: string;
  /** 所在文件夹：项目名或「随手聊」 */
  folder: string;
  updatedAt: string | null;
  state?: RunCaretState | null;
  data: T;
}

export interface RailSearchProject<T> {
  key: string;
  name: string;
  path: string;
  data: T;
}

export type RailSearchFilter = "all" | "working" | "confirm" | "unread";

export type RailSearchHit<C, P> =
  | { kind: "chat"; item: RailSearchChat<C> }
  | { kind: "project"; item: RailSearchProject<P> };

/** 不输入时列多少段最近对话；输入后命中的对话最多列多少段 */
export const RAIL_SEARCH_RECENT = 50;
export const RAIL_SEARCH_MAX_CHATS = 100;

function tokensOf(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesAll(fields: string[], tokens: string[]): boolean {
  const hay = fields.map((f) => f.toLowerCase());
  return tokens.every((t) => hay.some((h) => h.includes(t)));
}

function byRecent<C>(a: RailSearchChat<C>, b: RailSearchChat<C>): number {
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

export function railSearch<C, P>(
  chats: readonly RailSearchChat<C>[],
  projects: readonly RailSearchProject<P>[],
  query: string,
  filter: RailSearchFilter = "all",
): RailSearchHit<C, P>[] {
  const seen = new Set<string>();
  const unique = chats.filter((c) =>
    (filter === "all" || c.state === filter) && !seen.has(c.key) && (seen.add(c.key), true),
  );
  const tokens = tokensOf(query);
  if (tokens.length === 0) {
    return [...unique]
      .sort(byRecent)
      .slice(0, RAIL_SEARCH_RECENT)
      .map((item) => ({ kind: "chat", item }));
  }
  const projectHits = (filter === "all" ? projects : [])
    .filter((p) => matchesAll([p.name, p.path], tokens))
    // 名字里就命中的排在只有路径命中的前面
    .map((p, i) => ({ p, i, byName: matchesAll([p.name], tokens) ? 0 : 1 }))
    .sort((a, b) => a.byName - b.byName || a.i - b.i)
    .map(({ p }) => ({ kind: "project" as const, item: p }));
  const chatHits = unique
    .filter((c) => matchesAll([c.fullTitle, c.folder], tokens))
    // 标题里就命中的排在只有文件夹名命中的前面，同档按最近
    .map((c) => ({ c, byTitle: matchesAll([c.fullTitle], tokens) ? 0 : 1 }))
    .sort((a, b) => a.byTitle - b.byTitle || byRecent(a.c, b.c))
    .slice(0, RAIL_SEARCH_MAX_CHATS)
    .map(({ c }) => ({ kind: "chat" as const, item: c }));
  return [...projectHits, ...chatHits];
}
