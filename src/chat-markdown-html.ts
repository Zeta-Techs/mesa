import { Marked } from "marked";
import { isProseCodeSpan } from "./chat-reply";
import { sanitizeDocumentHtml } from "./document-html";
import { chatMathExtensions } from "./md-math";
import { rewriteMdImageHtml } from "./reader";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 聊天正文专用 Marked 实例（ChatMarkdown 与流式预览 StreamingMarkdown 共用）：
 * 原始 HTML 一律转义防追踪像素/外泄、开启 GFM 与单换行 breaks、反引号中文短语不当代码排、支持行内/块级公式。
 */
export const chatMarked = new Marked({ gfm: true, breaks: true, async: false });
chatMarked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    codespan({ text }) {
      return isProseCodeSpan(text) ? `<span class="md-code-prose">${escapeHtml(text)}</span>` : false;
    },
  },
  extensions: chatMathExtensions,
});

/** 聊天正文 Markdown → 安全 HTML（原始 HTML 转义 + http(s) 图占位防外泄） */
export function renderChatMarkdownHtml(md: string): string {
  return sanitizeDocumentHtml(rewriteMdImageHtml(chatMarked.parse(md) as string));
}
