/**
 * 终端里选中的文字交给对话 / 存进笔记时的排版（纯逻辑，2026-10-17 用户选定「选中终端文字，直接交给对话」）。
 * 选区来自 xterm.getSelection()：每行带 TUI 的缩进和行尾空格，长输出可能几万字——
 * 去掉行尾空格、压连续空行、太长截断并写明，免得一次塞爆输入框或对话上下文。
 */

/** 单次引用的上限（字符）：再长就截断并注明，要整段给 AI 请让它自己读文件 */
export const QUOTE_MAX_CHARS = 12_000;

function tidy(text: string): { body: string; cut: boolean } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const out: string[] = [];
  for (const l of lines) {
    if (!l.trim() && out.length && !out[out.length - 1].trim()) continue;
    out.push(l);
  }
  let body = out.join("\n");
  const cut = body.length > QUOTE_MAX_CHARS;
  if (cut) body = body.slice(0, QUOTE_MAX_CHARS);
  return { body, cut };
}

/** 「引用到输入框」：每行加「> 」，末尾空一行，光标落在引用下面接着写 */
export function quoteForChat(text: string): string {
  const { body, cut } = tidy(text);
  if (!body) return "";
  const quoted = body.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
  return `${quoted}${cut ? "\n> （后面太长，已截断）" : ""}\n\n`;
}

/** 「问 AI 这是什么意思」：问句 + 引用 */
export function askAboutText(text: string): string {
  const quoted = quoteForChat(text);
  return quoted ? `这段终端输出是什么意思？\n\n${quoted.trimEnd()}\n` : "";
}

/** 「存进笔记」：一个小节，标题写时间、哪家 AI、哪段对话；正文放代码块（围栏比正文里最长的反引号串多一个） */
export function clipNoteEntry(input: {
  text: string;
  when: Date;
  agentLabel: string | null;
  sessionTitle: string | null;
}): string {
  const { body, cut } = tidy(input.text);
  if (!body) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = input.when;
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const from = [input.agentLabel, input.sessionTitle].filter(Boolean).join(" · ");
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  return `\n## ${stamp}${from ? ` · ${from}` : ""}\n\n${fence}text\n${body}\n${fence}\n${cut ? "\n（后面太长，已截断）\n" : ""}`;
}
