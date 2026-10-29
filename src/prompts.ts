/**
 * 常用提示词（2026-10-30）：纯函数部分，后端存取见 src-tauri/src/prompts.rs，界面状态见 prompt-store.ts。
 * 对话输入框「+」菜单列出来、`/` 面板按名称或正文搜，选中就把正文填进输入框（不自动发送）。
 */

export interface PromptItem {
  id: string;
  /** 可空：显示时拿正文第一行顶上 */
  title: string;
  body: string;
  updatedAt: number;
}

const TITLE_FALLBACK_CHARS = 24;

/** 列表里显示的名字：有名称用名称，没有用正文第一段非空行（过长截断） */
export function promptLabel(p: Pick<PromptItem, "title" | "body">): string {
  const title = p.title.trim();
  if (title) return title;
  const line = p.body.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  const chars = Array.from(line);
  return chars.length > TITLE_FALLBACK_CHARS ? `${chars.slice(0, TITLE_FALLBACK_CHARS).join("")}…` : line;
}

/** 列表第二行的正文预览：压成一行；没起名时第一行已经当名字，预览从下一行起 */
export function promptPreview(p: Pick<PromptItem, "title" | "body">): string {
  const lines = p.body.split("\n").map((s) => s.trim()).filter(Boolean);
  const rest = p.title.trim() ? lines : lines.slice(1);
  return rest.join(" ");
}

/**
 * `/` 面板里的提示词：名称前缀命中排前，其次名称或正文包含（不分大小写）；空查询给前 limit 条。
 * 保持各自组内的原顺序（用户在管理里排的顺序）。
 */
export function filterPrompts(list: readonly PromptItem[], query: string, limit = 5): PromptItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const head: PromptItem[] = [];
  const contains: PromptItem[] = [];
  for (const p of list) {
    const label = promptLabel(p).toLowerCase();
    if (label.startsWith(q)) head.push(p);
    else if (label.includes(q) || p.body.toLowerCase().includes(q)) contains.push(p);
  }
  return [...head, ...contains].slice(0, limit);
}

/**
 * 把提示词放进输入框：
 * - 来自 `/` 面板时，框里那段「/查询」整个换成正文；
 * - 来自「+」菜单时，空框直接填，已有字就另起一行接在后面（与插技能同口径）。
 */
export function applyPrompt(current: string, body: string, fromSlash: boolean): string {
  if (fromSlash || !current.trim()) return body;
  return `${current.replace(/\s+$/, "")}\n${body}`;
}

/** 上下移一位后的 id 顺序（管理弹窗里的 ↑ / ↓），越界原样返回 */
export function moveId(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
