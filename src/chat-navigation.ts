import type { ChatMessageDto } from "./types.ts";

/** 没有上游 id 时保留内容签名；分页下标不能充当引用身份。 */
export function messageIdentity(message: ChatMessageDto): string {
  return message.id ? `${message.role}:id:${message.id}` : JSON.stringify([message.role, message.timestamp, message.blocks]);
}

export function messageText(message: ChatMessageDto): string {
  return message.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n\n").trim();
}

export interface ChatQuote {
  sourceKeys: string[];
  sourceText: string;
  text: string;
  /** Markdown 选区无法原样映射回源文时保留文字，只定位整条回复。 */
  range: { start: number; end: number } | null;
}

export function makeChatQuote(sources: readonly ChatMessageDto[], sourceText: string, selection = ""): ChatQuote {
  const text = selection.trim() || sourceText;
  const start = sourceText.indexOf(text);
  const unique = start >= 0 && sourceText.indexOf(text, start + 1) < 0;
  return { sourceKeys: sources.map(messageIdentity), sourceText, text, range: unique ? { start, end: start + text.length } : null };
}

/** 无法唯一核对来源时不跳到相似消息，草稿里的原文仍保留。 */
export function locateChatQuote(messages: readonly ChatMessageDto[], quote: ChatQuote): number {
  const keys = messages.map(messageIdentity);
  const indices = quote.sourceKeys.map((key) => keys.indexOf(key));
  if (!indices.length || indices.some((index, i) => index < 0 || keys.lastIndexOf(quote.sourceKeys[i]) !== index || (i > 0 && index <= indices[i - 1]))) return -1;
  const current = indices.map((index) => messageText(messages[index])).filter(Boolean).join("\n\n");
  return current.includes(quote.sourceText) ? indices[indices.length - 1] : -1;
}

export function quotePayload(quote: ChatQuote, draft: string): string {
  return `引用之前的回复：\n${quote.text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${draft}`.trim();
}

export function chatSearchHits(messages: readonly ChatMessageDto[], query: string): Array<{ key: string; index: number }> {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [];
  const counts = new Map<string, number>();
  const hits: Array<{ key: string; index: number }> = [];
  // 同文消息从尾部编号，向前加载历史不会改变当前命中的键。
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message.blocks.some((block) => block.text.toLocaleLowerCase().includes(term))) continue;
    const identity = messageIdentity(message);
    const count = counts.get(identity) ?? 0;
    counts.set(identity, count + 1);
    hits.push({ key: `${identity}:${count}`, index });
  }
  return hits.reverse();
}
