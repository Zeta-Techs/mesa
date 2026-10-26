/**
 * 会话列表展示标题：去掉 URL / 中断提示 / CLI resume /「未命名」噪声 / `<user_query>`，
 * 取首句（之后/然后切开），不砍成首词。自定义标题原样保留。不调用 AI、不写回源文件。
 */
function interruptedRe() {
  return /\[?\s*request interrupted by user\s*\]?|请求(?:已)?中断|被用户中断/gi;
}
const CLI_RESUME_RE =
  /^(claude|codex|gemini|qwen|opencode|kimi|cursor|grok|codebuddy)(?:\s+code)?\s+--resume\b/i;
function urlRe() {
  return /https?:\/\/\S+/gi;
}
const LEADING_PROMPT_RE = /^(请你|请|帮我|我想|我要|麻烦你|麻烦|读一下|看一下)+/;
const CLAUSE_SPLIT_RE = /之后|然后|并且|另外|针对|。|！|？|(?<=\w)\.(?=\s)|!|\?/;

function isUnnamedRaw(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("未命名对话")) return true;
  return /^(untitled(?: session)?|session[_-]?)\b/i.test(t);
}

export interface TidySessionTitle {
  title: string;
  interrupted: boolean;
  unnamed: boolean;
}

export function sessionIsInterrupted(text: string | null | undefined): boolean {
  if (!text) return false;
  return interruptedRe().test(text);
}

/** 展示用标题去掉 markdown 装饰，不写回源文件。 */
export function stripTitleMarkdown(text: string): string {
  let t = text.trim();
  t = t.replace(/^#{1,6}\s+/, "");
  t = t.replace(/^>\s+/, "");
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  t = t.replace(/\*\*(.+?)\*\*/g, "$1");
  t = t.replace(/__(.+?)__/g, "$1");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/(^|[^\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?=[^\w*]|$)/g, "$1$2");
  t = t.replace(/\*\*/g, "").replace(/__/g, "");
  return t.replace(/\s+/g, " ").trim();
}

function clampTitle(text: string): string {
  const chars = [...text];
  if (chars.length === 0) return "";
  const cjk = chars.filter((c) => (c.codePointAt(0) ?? 0) > 0xff).length;
  const max = cjk >= chars.length / 2 ? 48 : 72;
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("").trimEnd()}…`;
}

/** Grok 等会把用户话包在 <user_query> 里；列表和回放只显示里面的话。 */
export function unwrapPromptTags(text: string): string {
  const re = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi;
  let out = text.replace(re, "$1");
  out = out.replace(/<\/?user_query>/gi, "");
  return out.replace(/\s+/g, " ").trim();
}

function fileBaseName(p: string): string {
  const cleaned = p.replace(/^["']|["']$/g, "").replace(/[\\/]+$/, "");
  const segs = cleaned.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] || cleaned;
}

/** 绝对路径换成文件名，避免列表被 /Users/... 撑成「看这份文件：/」。
 *  前看不是文件名字符，避免误伤相对路径 src/app.tsx。 */
const ABS_FS_RE =
  /(?<![A-Za-z0-9._-])(?:"((?:[A-Za-z]:[\\/]|\/|~\/)[^"]+)"|'((?:[A-Za-z]:[\\/]|\/|~\/)[^']+)'|(?:[A-Za-z]:[\\/]|\/|~\/)[^\s"'，。；！？]+)/g;

export function replaceAbsFsPaths(text: string): string {
  return text.replace(ABS_FS_RE, (full, dquoted: string | undefined, squoted: string | undefined) => {
    return fileBaseName(dquoted ?? squoted ?? full);
  });
}

/** 去掉噪声后的首句；不够成标题则返回 null。 */
export function tidySessionText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = unwrapPromptTags(raw);
  text = text.replace(urlRe(), " ").replace(interruptedRe(), " ");
  text = replaceAbsFsPaths(text);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  text = text.split("\n")[0]?.trim() ?? "";
  if (!text || CLI_RESUME_RE.test(text) || isUnnamedRaw(text)) return null;
  const clause = text.split(CLAUSE_SPLIT_RE)[0]?.trim() ?? "";
  text = clause || text;
  const stripped = text.replace(LEADING_PROMPT_RE, "").trim();
  if ([...stripped].length >= 4) text = stripped;
  text = stripTitleMarkdown(text);
  if (!text || CLI_RESUME_RE.test(text) || isUnnamedRaw(text)) return null;
  text = clampTitle(text);
  return text || null;
}

export function tidySessionTitle(session: {
  customTitle?: string | null;
  title?: string | null;
  summary?: string | null;
}): TidySessionTitle {
  const custom = session.customTitle?.trim() ?? "";
  if (custom) {
    return { title: custom, interrupted: false, unnamed: false };
  }
  const interrupted =
    sessionIsInterrupted(session.title) ||
    sessionIsInterrupted(session.summary);
  const fromTitle = tidySessionText(session.title);
  if (fromTitle) return { title: fromTitle, interrupted, unnamed: false };
  const fromSummary = tidySessionText(session.summary);
  if (fromSummary) return { title: fromSummary, interrupted, unnamed: false };
  return { title: "未命名对话", interrupted, unnamed: true };
}

/** 项目侧栏：未命名不写这三个字，只留「对话」。 */
export function projectSessionLabel(shown: TidySessionTitle): string {
  return shown.unnamed ? "对话" : shown.title;
}

export function splitRecentItems<T>(
  items: readonly T[],
  limit = 8,
): { recent: T[]; older: T[] } {
  if (limit < 1 || items.length <= limit) {
    return { recent: [...items], older: [] };
  }
  return {
    recent: items.slice(0, limit),
    older: items.slice(limit),
  };
}

/**
 * 聊天中途校正标题的节点：用户说到第 3、第 8 句时各补一次（Agent 退出时再收一次尾）。
 * 返回已到达的最高节点，0 = 还没到。重开旧对话时一上来就过节点也无妨：
 * 后端发现起名材料跟上次一样就不问 AI。
 */
export const AUTO_TITLE_MILESTONES = [3, 8] as const;

export function autoTitleMilestone(userTurns: number): number {
  let reached = 0;
  for (const n of AUTO_TITLE_MILESTONES) if (userTurns >= n) reached = n;
  return reached;
}
