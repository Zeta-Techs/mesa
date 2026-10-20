import { useMemo } from "react";
import { Marked } from "marked";
import { sanitizeDocumentHtml } from "../document-html";

// 更新说明来自线上更新清单，按不可信文本处理：原始 HTML 转义，链接与图片只留文字（不在更新弹窗里跳转/外联）
const notesMarked = new Marked({ gfm: true, breaks: true, async: false });
notesMarked.use({
  renderer: {
    html({ text }) {
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
    link({ tokens }) {
      return this.parser.parseInline(tokens);
    },
    image({ text }) {
      return text;
    },
  },
});

/** 更新说明：Markdown 渲染进一个浅底框，超高滚动；设置页卡片与帮助菜单「检查更新」弹窗共用 */
export default function UpdateNotes({ text }: { text: string }) {
  const html = useMemo(() => sanitizeDocumentHtml(notesMarked.parse(text) as string), [text]);
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-l3">更新说明</div>
      <div
        className="md-body md-chat ccode-well max-h-60 overflow-auto rounded-md px-3 py-2"
        style={{ fontSize: 13 }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
