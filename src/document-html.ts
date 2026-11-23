import createDOMPurify, { type WindowLike } from "dompurify";

/** 本地路径只决定能否读文件，不决定其中 HTML 是否可信。仅保留文档排版能力。 */
export function createDocumentSanitizer(window: WindowLike): (html: string) => string {
  const purifier = createDOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    if (["href", "src", "data-md-src"].includes(data.attrName)) {
      const url = data.attrValue.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
      const image = node.nodeName === "IMG" && data.attrName === "src";
      const local = !/^[a-z][a-z0-9+.-]*:/i.test(url) || /^[a-z]:[\\/]/i.test(url);
      const embeddedImage = image && (
        /^blob:/i.test(url) ||
        /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon);base64,/i.test(url)
      );
      const allowed = local || /^(https?:|mailto:|tel:|file:)/i.test(url) || embeddedImage;
      if (!allowed) data.keepAttr = false;
    }
    if (data.attrName === "class") {
      // 不允许文档借应用的 fixed/inset/z-index 等样式覆盖工作台。
      data.attrValue = data.attrValue.split(/\s+/).filter((name) =>
        /^(md-math(?:-display)?|md-img-pending|md-footnotes|md-fn-ref|md-fn-back|task-list-item|contains-task-list|language-[\w-]+)$/.test(name),
      ).join(" ");
    }
  });
  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "INPUT") {
      node.setAttribute("type", "checkbox");
      node.setAttribute("disabled", "");
    }
  });
  return (html) => purifier.sanitize(html, {
    ALLOWED_TAGS: [
      "a", "abbr", "b", "blockquote", "br", "caption", "code", "col", "colgroup",
      "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure",
      "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins",
      "kbd", "li", "mark", "ol", "p", "pre", "s", "samp", "small", "span",
      "strong", "sub", "summary", "sup", "table", "tbody", "td", "th", "thead",
      "tfoot", "tr", "u", "ul", "var",
    ],
    ALLOWED_ATTR: [
      "href", "src", "alt", "title", "id", "class", "width", "height", "colspan",
      "rowspan", "align", "start", "reversed", "open", "checked", "disabled", "type",
      "data-md-src", "data-md-alt",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // DOMPurify 默认 ALLOWED_URI_REGEXP 不含 file:，会把上面 hook 放行的 file:// 本地文件链接剥成无 href 的空 <a>
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tel|file|blob):|data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon);base64,|[a-z]:[\\/]|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
  });
}

let sanitize: ((html: string) => string) | undefined;

export function sanitizeDocumentHtml(html: string): string {
  sanitize ??= createDocumentSanitizer(window);
  return sanitize(html);
}
