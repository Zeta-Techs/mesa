/**
 * 对话搜索纯逻辑：分词、元数据即时过滤、正文命中合并排序。
 * 不读文件系统、不读平台。正文打分在 Rust，前端只按命中序排列。
 */
import type {
  ChatMessageDto,
  SessionMatchDto,
  SessionMetaDto,
  SessionSearchHitDto,
} from "./types.ts";

function isCjk(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

function isTrimPunct(c: string): boolean {
  return /[.,;:!?()[\]{}"'`~@#$%^&*+=|\\/<>，。；：！？、""''（）【】《》]/.test(c);
}

function trimPunct(s: string): string {
  const chars = [...s];
  let a = 0;
  let b = chars.length;
  while (a < b && isTrimPunct(chars[a])) a += 1;
  while (b > a && isTrimPunct(chars[b - 1])) b -= 1;
  return chars.slice(a, b).join("");
}

/** 与后端 tokenize 同口径：空白切开、去首尾标点、短英文丢掉、中日韩单字保留。 */
export function tokenizeSearchQuery(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of query.trim().split(/\s+/)) {
    const trimmed = trimPunct(raw);
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    const keep = [...lower].some(isCjk) || [...lower].length >= 2;
    if (!keep || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

function metaHaystack(s: SessionMetaDto): string {
  return [
    s.customTitle ?? "",
    s.title ?? "",
    s.summary ?? "",
    s.workspace ?? "",
    s.stepName ?? "",
    s.taskName ?? "",
    s.projectPath,
    ...s.tags,
  ]
    .join("\n")
    .toLowerCase();
}

/** 还没有正文结果时：任一关键词落在标题/摘要/标签等即留下。 */
export function metadataMatchesQuery(s: SessionMetaDto, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = metaHaystack(s);
  return tokens.some((t) => hay.includes(t));
}

export function searchHitKey(agent: string, sessionId: string): string {
  return `${agent}\n${sessionId}`;
}

/** 回放里要滚到、高亮的那一处 */
export interface SearchFocus {
  around: number | null;
  matchTimestamp: string | null;
  matchRole: string | null;
  snippet: string | null;
  matchedKeywords: string[];
}

export function focusFromMatch(m: SessionMatchDto, keywords: string[]): SearchFocus {
  return {
    around: m.around,
    matchTimestamp: m.timestamp,
    matchRole: m.role,
    snippet: m.snippet,
    matchedKeywords: keywords,
  };
}

function messageText(m: ChatMessageDto): string {
  return m.blocks
    .filter((b) => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}

function snippetCore(snippet: string | null | undefined): string {
  if (!snippet) return "";
  return snippet.replace(/^[.…\s]+/, "").replace(/[.…\s]+$/, "").trim();
}

function foldWs(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function indexBySnippet(
  messages: readonly ChatMessageDto[],
  core: string,
): number {
  const needle = foldWs(core);
  if (needle.length < 2) return -1;
  return messages.findIndex((m) => foldWs(messageText(m)).includes(needle));
}

/** 在已加载的一页消息里找出搜索命中的那一条（时间戳优先，其次摘录/关键词）。 */
export function findFocusMessageIndex(
  messages: readonly ChatMessageDto[],
  focus: SearchFocus | null | undefined,
): number {
  if (!focus) return -1;
  const role = focus.matchRole;
  const ts = focus.matchTimestamp;
  const core = snippetCore(focus.snippet);
  if (ts) {
    const idxs: number[] = [];
    messages.forEach((m, i) => {
      if (m.timestamp === ts && (!role || m.role === role)) idxs.push(i);
    });
    if (idxs.length === 1) return idxs[0];
    if (idxs.length > 1) {
      const among = idxs.map((i) => messages[i]);
      const j = indexBySnippet(among, core);
      if (j >= 0) return idxs[j];
      return idxs[0];
    }
  }
  const bySnip = indexBySnippet(messages, core);
  if (bySnip >= 0) return bySnip;
  const kws = (focus.matchedKeywords ?? [])
    .map((k) => k.toLowerCase())
    .filter(Boolean);
  if (kws.length === 0) return -1;
  return messages.findIndex((m) => {
    const t = messageText(m).toLowerCase();
    return kws.some((k) => t.includes(k));
  });
}

export function applySearchHits(
  sessions: readonly SessionMetaDto[],
  query: string,
  hits: SessionSearchHitDto[] | null,
): { list: SessionMetaDto[]; snippets: Record<string, string> } {
  const q = query.trim();
  if (!q) return { list: [...sessions], snippets: {} };
  const tokens = tokenizeSearchQuery(q);
  if (hits) {
    const byKey = new Map(
      sessions.map((s) => [searchHitKey(s.agent, s.sessionId), s]),
    );
    const list: SessionMetaDto[] = [];
    const snippets: Record<string, string> = {};
    for (const h of hits) {
      const s = byKey.get(searchHitKey(h.agent, h.sessionId));
      if (!s) continue;
      list.push(s);
      if (h.snippet) snippets[searchHitKey(h.agent, h.sessionId)] = h.snippet;
    }
    return { list, snippets };
  }
  if (tokens.length === 0) {
    const lower = q.toLowerCase();
    return {
      list: sessions.filter((s) => metaHaystack(s).includes(lower)),
      snippets: {},
    };
  }
  return {
    list: sessions.filter((s) => metadataMatchesQuery(s, tokens)),
    snippets: {},
  };
}
