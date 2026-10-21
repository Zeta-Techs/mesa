/**
 * 聊天回复里的文献引用键（Pandoc / Quarto 写法 `[@key]`、`[@a; @b]`、`[-@key, p. 3]`）→ 小胶囊（2026-10-21）。
 * 认法与后端 citation.rs extract_cite_keys 同口径：方括号里每一项都得以 [-]@键 起头，带前缀的 `[cf. @a]` 不认；
 * 后面紧跟 ( 或 [ 的是链接，不认。条目信息（作者 / 年份 / 题名）由后端 cite_lookup 从会话目录的
 * references.bib 读，只读、不改 bib。
 */
import { invoke } from "@tauri-apps/api/core";

export interface CiteItem {
  key: string;
  /** `-@key`：只要年份不要作者（Pandoc 抑制作者） */
  suppressAuthor: boolean;
  /** 逗号后的页码等定位（「p. 3」）；没有为 null */
  locator: string | null;
}

export interface CiteHit {
  /** 在原文里的起点（含左方括号） */
  index: number;
  raw: string;
  items: CiteItem[];
}

const KEY = String.raw`[\w][\w.:-]*`;
const ITEM = String.raw`\s*-?@${KEY}(?:\s*,[^\];[\]]*)?`;
const CITE = new RegExp(String.raw`\[(${ITEM}(?:\s*;${ITEM})*)\s*\](?![(\[])`, "g");

/** 一段纯文字里的引用段（不在代码、链接里的文字由调用方挑好再给） */
export function findCitations(text: string): CiteHit[] {
  const hits: CiteHit[] = [];
  for (const m of text.matchAll(CITE)) {
    const items: CiteItem[] = [];
    for (const part of m[1].split(";")) {
      const pm = new RegExp(String.raw`^\s*(-?)@(${KEY})\s*(?:,\s*([^\]]*?))?\s*$`).exec(part);
      if (!pm) continue;
      // 键尾的 . : 多半是句读，不是键的一部分
      const key = pm[2].replace(/[.:]+$/, "");
      items.push({ key, suppressAuthor: pm[1] === "-", locator: pm[3]?.trim() || null });
    }
    if (items.length) hits.push({ index: m.index ?? 0, raw: m[0], items });
  }
  return hits;
}

export interface CiteEntry {
  key: string;
  /** 作者姓（家族名）按顺序；读不出为空 */
  authors: string[];
  year: string | null;
  title: string | null;
}

const CJK = /[㐀-鿿]/;

/** 胶囊上的字：「Smith 2020」「Smith & Lee 2020」「Smith et al. 2020」「张三等 2020」；不认识的键写 @键 */
export function citeLabel(entry: CiteEntry | null | undefined, item: CiteItem): string {
  const tail = item.locator ? `, ${item.locator}` : "";
  if (!entry) return `@${item.key}${tail}`;
  const year = entry.year ?? "";
  const [first, second] = entry.authors;
  let who = "";
  if (!item.suppressAuthor && first) {
    if (entry.authors.length === 1) who = first;
    else if (CJK.test(first)) who = `${first}等`;
    else if (entry.authors.length === 2) who = `${first} & ${second}`;
    else who = `${first} et al.`;
  }
  const label = [who, year].filter(Boolean).join(" ");
  return `${label || `@${item.key}`}${tail}`;
}

/** 悬停卡片的正文：作者 · 年份 / 题名 / @键 */
export function citeTipText(entry: CiteEntry): string {
  const who = entry.authors.length > 3 ? `${entry.authors.slice(0, 3).join("、")} 等` : entry.authors.join("、");
  const head = [who, entry.year].filter(Boolean).join(" · ");
  return [head, entry.title, `@${entry.key}`].filter(Boolean).join("\n");
}

export interface CiteLookup {
  /** 会话目录（或上级项目根）里找到了 references.bib */
  bibFound: boolean;
  entries: Map<string, CiteEntry>;
}

interface CiteLookupDto {
  bibFound: boolean;
  entries: CiteEntry[];
}

/** 同一目录 30 秒内复用（一屏回复往往引用同一批文献；bib 改了半分钟内就能看到） */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; lookup: Promise<CiteLookup>; keys: Set<string> }>();

export function lookupCitations(cwd: string, keys: string[]): Promise<CiteLookup> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS && keys.every((k) => hit.keys.has(k))) return hit.lookup;
  const all = new Set([...(hit && Date.now() - hit.at < CACHE_MS ? hit.keys : []), ...keys]);
  const lookup = invoke<CiteLookupDto>("cite_lookup", { cwd, keys: [...all] })
    .then((dto) => ({
      bibFound: dto.bibFound,
      entries: new Map(dto.entries.map((e) => [e.key, e])),
    }))
    .catch(() => ({ bibFound: false, entries: new Map<string, CiteEntry>() }));
  cache.set(cwd, { at: Date.now(), lookup, keys: all });
  return lookup;
}
