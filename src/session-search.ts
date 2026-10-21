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

/**
 * 搜索框语法，与后端 parse_query 同口径：
 * `"整句"` / `“整句”` / `「整句」` 必须原样出现；`agent:` / `来自:` 只看某家；
 * `role:` / `角色:` 只搜我说的（我/用户/user）或 AI 的回复（ai/回复/助手）；
 * `after:` / `从:`、`before:` / `到:` 按对话更新日期（本地时区，可写到年/月/日）。认不出的 `x:y` 当普通词。
 */
export interface ParsedSearchQuery {
  /** 小写：普通词 + 引号整句 */
  tokens: string[];
  phrases: string[];
  agents: string[];
  role: "user" | "ai" | null;
  after: string | null;
  before: string | null;
}

const QUOTE_CLOSE: Record<string, string> = { '"': '"', "“": "”", "「": "」" };

function splitQuery(q: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  const chars = [...q];
  let cur = "";
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    const close = QUOTE_CLOSE[c];
    if (close) {
      if (cur) out.push({ text: cur, quoted: false });
      cur = "";
      let quoted = "";
      i += 1;
      while (i < chars.length && chars[i] !== close) {
        quoted += chars[i];
        i += 1;
      }
      out.push({ text: quoted, quoted: true });
    } else if (/\s/.test(c)) {
      if (cur) out.push({ text: cur, quoted: false });
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur) out.push({ text: cur, quoted: false });
  return out;
}

export function normAgent(s: string): string {
  return s.toLowerCase().replace(/[ \-_]/g, "");
}

function normDate(v: string): string | null {
  const parts = v.split(/[-/.]/);
  if (parts.length === 0 || parts.length > 3 || parts[0].length !== 4) return null;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (!/^\d+$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    const ok = i === 0 ? n >= 1970 && n <= 2100 : i === 1 ? n >= 1 && n <= 12 : n >= 1 && n <= 31;
    if (!ok) return null;
    out.push(i === 0 ? String(n) : String(n).padStart(2, "0"));
  }
  return out.join("-");
}

function applyFilter(pq: ParsedSearchQuery, piece: string): boolean {
  const m = /^([^:：]+)[:：](.+)$/.exec(piece);
  if (!m) return false;
  const key = m[1].toLowerCase();
  const v = m[2].trim();
  if (!v) return false;
  if (key === "agent" || key === "来自") {
    const a = normAgent(v);
    if (!a) return false;
    pq.agents.push(a);
    return true;
  }
  if (key === "role" || key === "角色") {
    const r = v.toLowerCase();
    if (["user", "me", "我", "用户", "你"].includes(r)) pq.role = "user";
    else if (["ai", "assistant", "助手", "回复", "模型"].includes(r)) pq.role = "ai";
    else return false;
    return true;
  }
  if (key === "after" || key === "从" || key === "before" || key === "到") {
    const d = normDate(v);
    if (!d) return false;
    if (key === "after" || key === "从") pq.after = d;
    else pq.before = d;
    return true;
  }
  return false;
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const pq: ParsedSearchQuery = {
    tokens: [],
    phrases: [],
    agents: [],
    role: null,
    after: null,
    before: null,
  };
  const seen = new Set<string>();
  for (const { text, quoted } of splitQuery(query)) {
    if (quoted) {
      const p = text.trim().split(/\s+/).join(" ").toLowerCase();
      if (p && !seen.has(p)) {
        seen.add(p);
        pq.phrases.push(p);
        pq.tokens.push(p);
      }
      continue;
    }
    if (applyFilter(pq, text)) continue;
    const trimmed = trimPunct(text);
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    const keep = [...lower].some(isCjk) || [...lower].length >= 2;
    if (!keep || seen.has(lower)) continue;
    seen.add(lower);
    pq.tokens.push(lower);
  }
  return pq;
}

/** 空白切开、去首尾标点、短英文丢掉、中日韩单字保留；筛选写法（agent: 等）不算词。 */
export function tokenizeSearchQuery(query: string): string[] {
  return parseSearchQuery(query).tokens;
}

export function hasSearchFilters(pq: ParsedSearchQuery): boolean {
  return pq.agents.length > 0 || pq.role !== null || pq.after !== null || pq.before !== null;
}

function localDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** agent / 日期筛选（角色只影响正文搜索，这里不管） */
export function sessionPassesFilters(s: SessionMetaDto, pq: ParsedSearchQuery): boolean {
  if (pq.agents.length > 0) {
    const id = normAgent(s.agent);
    if (!pq.agents.some((a) => id.startsWith(a))) return false;
  }
  if (pq.after || pq.before) {
    const day = localDay(s.updatedAt);
    if (!day) return false;
    if (pq.after && day.slice(0, pq.after.length) < pq.after) return false;
    if (pq.before && day.slice(0, pq.before.length) > pq.before) return false;
  }
  return true;
}

/** 搜索框下面那行：把认出来的筛选写成人话，让人知道生效了 */
export function describeSearchFilters(pq: ParsedSearchQuery): string[] {
  const out: string[] = [];
  if (pq.agents.length > 0) out.push(`来自 ${pq.agents.join(" / ")}`);
  if (pq.role === "user") out.push("只搜你说的");
  if (pq.role === "ai") out.push("只搜 AI 回复");
  if (pq.after) out.push(`${pq.after} 起`);
  if (pq.before) out.push(`到 ${pq.before}`);
  for (const p of pq.phrases) out.push(`整句「${p}」`);
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
  const pq = parseSearchQuery(q);
  const tokens = pq.tokens;
  // 只写了筛选、没写词：按 agent / 日期筛列表
  if (tokens.length === 0 && hasSearchFilters(pq)) {
    return { list: sessions.filter((s) => sessionPassesFilters(s, pq)), snippets: {} };
  }
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
  // 正文结果回来之前先按标题等过一遍；按角色搜时标题命中不算，等正文结果
  return {
    list:
      pq.role !== null
        ? []
        : sessions.filter(
            (s) => sessionPassesFilters(s, pq) && metadataMatchesQuery(s, tokens),
          ),
    snippets: {},
  };
}
