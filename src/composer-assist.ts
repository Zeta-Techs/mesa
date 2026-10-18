/**
 * 聊天输入框的「添加」与「操作」纯逻辑（docs/design-chat-layer.md §4.1、§6，2026-10-17 第二期）。
 * - `@` 引用项目文件：认出光标前的 `@查询`，选中后换成 `@相对路径 `（九家都认路径文本）
 * - 斜杠面板上半组「Mesa」操作：由 Mesa 自己执行（新对话、压缩上下文、分叉、看改动、导出、打开终端），
 *   下半组才是写进终端的 CLI 命令
 * - ↑ 取回上一句：输入框为空时按 ↑，把自己上一句放回来改
 */

/** 光标前的 `@查询`：@ 前是行首或空白，查询里没有空白；不是则 null */
export function mentionQueryAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** 把 `@查询` 换成 `@相对路径 `，返回新文本与新光标位置；路径里有空格时用引号包起来 */
export function applyMention(
  value: string,
  caret: number,
  mention: { start: number; query: string },
  rel: string,
): { value: string; caret: number } {
  const token = /\s/.test(rel) ? `@"${rel}" ` : `@${rel} `;
  const end = mention.start + 1 + mention.query.length;
  const next = value.slice(0, mention.start) + token + value.slice(Math.max(end, caret));
  return { value: next, caret: mention.start + token.length };
}

export interface MesaCommand {
  /** 斜杠面板里显示的命令名（含 /），只用于匹配和展示，不写进终端 */
  cmd: string;
  label: string;
  hint: string;
  run: () => void;
}

/** 斜杠查询匹配 Mesa 操作：命令名前缀或中文名包含 */
export function filterMesaCommands(list: readonly MesaCommand[], query: string): MesaCommand[] {
  const q = query.toLowerCase();
  return list.filter((c) => c.cmd.slice(1).toLowerCase().startsWith(q) || c.label.includes(query));
}

/** 输入框为空时按 ↑：取回自己上一句（只取纯文字块；命令行、乐观消息之外的才算） */
export function lastUserText(
  messages: readonly { role: string; blocks: readonly { kind: string; text: string }[] }[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = m.blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

/** 上一轮请求喂进去的 token（输入 + 缓存读 + 缓存写）：最后一条带用量的助手消息；没有为 null */
export function lastContextTokens(
  messages: readonly {
    role: string;
    usage: { input: number; cacheRead: number; cacheWrite: number } | null;
  }[],
): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i].usage;
    if (messages[i].role === "user" || !u) continue;
    const used = u.input + u.cacheRead + u.cacheWrite;
    if (used > 0) return used;
  }
  return null;
}

/** 上下文用量：上一轮输入占模型窗口的比例。窗口未知或没有用量返回 null（不画圆环，不猜） */
export function contextUsage(
  messages: Parameters<typeof lastContextTokens>[0],
  contextWindow: number | null | undefined,
): { used: number; ratio: number } | null {
  if (!contextWindow || contextWindow <= 0) return null;
  const used = lastContextTokens(messages);
  return used === null ? null : { used, ratio: Math.min(1, used / contextWindow) };
}
