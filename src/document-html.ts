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
  });
}

let sanitize: ((html: string) => string) | undefined;

export function sanitizeDocumentHtml(html: string): string {
  sanitize ??= createDocumentSanitizer(window);
  return sanitize(html);
}

/** HTML 文件预览：进沙箱 iframe 前再洗一遍。允许 style/文档骨架，仍剥脚本与表单。 */
export function createHtmlPreviewSanitizer(window: WindowLike): (html: string) => string {
  const purifier = createDOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    if (["href", "src"].includes(data.attrName)) {
      const url = data.attrValue.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
      const image = node.nodeName === "IMG" && data.attrName === "src";
      const local = !/^[a-z][a-z0-9+.-]*:/i.test(url) || /^[a-z]:[\\/]/i.test(url);
      const embeddedImage = image && (
        /^blob:/i.test(url) ||
        /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon);base64,/i.test(url)
      );
      const allowed = local || /^(https?:|mailto:|tel:)/i.test(url) || embeddedImage;
      if (!allowed) data.keepAttr = false;
    }
  });
  // 2026-10-26 放宽到「报告能看」：Quarto / Jupyter 导出的 HTML 靠内联 style、内嵌 SVG 图（matplotlib）、
  // MathML 公式排版，原先白名单把三样都剥了。脚本、表单、内嵌框架仍一律剥掉——交互图表（plotly 等）
  // 在预览里只能看静态部分，工具条给「在浏览器打开」
  return (html) => purifier.sanitize(html, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    ADD_TAGS: ["meta", "title", "style", "link"],
    ADD_ATTR: ["charset", "content", "name", "rel", "media"],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      "script", "iframe", "frame", "frameset", "object", "embed", "form", "input",
      "button", "textarea", "select", "base", "portal",
    ],
    FORBID_ATTR: ["srcset", "ping", "formaction", "action"],
  });
}

let sanitizeHtmlPreview: ((html: string) => string) | undefined;

export function sanitizeHtmlPreviewDocument(html: string): string {
  sanitizeHtmlPreview ??= createHtmlPreviewSanitizer(window);
  return sanitizeHtmlPreview(html);
}
