import { classifyMdHref } from "./reader.ts";

/**
 * 沙箱不含 allow-same-origin：文档源为不透明源，读不到 GUI。脚本照跑（动画、交互图表），
 * 页面自己的 CSP 由 mesa-html 协议给（html_preview.rs）。不给 allow-modals：脚本能跑以后
 * 一个死循环 alert 就能把窗口卡住。
 */
export const HTML_IFRAME_SANDBOX = "allow-scripts allow-popups allow-downloads";

function linkHref(tag: string): string | null {
  const quoted = /\bhref\s*=\s*(['"])([\s\S]*?)\1/i.exec(tag);
  if (quoted) return quoted[2];
  const bare = /\bhref\s*=\s*([^\s>]+)/i.exec(tag);
  return bare ? bare[1].replace(/["']/g, "") : null;
}

function isStylesheetLink(tag: string): boolean {
  return /\brel\s*=\s*(['"]?)stylesheet\1/i.test(tag);
}

/** 抽出 `<link rel=stylesheet href>`，供预览时内联本地 CSS。 */
export function htmlStylesheetHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!isStylesheetLink(tag)) continue;
    const href = linkHref(tag);
    if (href) out.push(href);
  }
  return out;
}

export function escapeCssForStyle(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

/** 把已读到的本地 stylesheet 换成 `<style>`；读不到的 link 丢掉。 */
export function replaceStylesheetLinks(
  html: string,
  cssByHref: Readonly<Record<string, string>>,
): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!isStylesheetLink(tag)) return tag;
    const href = linkHref(tag);
    if (!href) return "";
    const css = cssByHref[href];
    if (css == null) return "";
    return `<style>${escapeCssForStyle(css)}</style>`;
  });
}

const IMG_SRC_RE = /<img\b([^>]*?)\/?\s*>/gi;

function matchSrc(attrs: string): string | null {
  const m = /\bsrc\s*=\s*(['"])([\s\S]*?)\1/i.exec(attrs)
    ?? /\bsrc\s*=\s*([^\s>]+)/i.exec(attrs);
  if (!m) return null;
  return (m[2] ?? m[1]).replace(/^['"]|['"]$/g, "");
}

/** 本地相对/绝对图片 src（跳过 data/blob/http）。 */
export function htmlLocalImageSrcs(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  IMG_SRC_RE.lastIndex = 0;
  while ((m = IMG_SRC_RE.exec(html))) {
    const src = matchSrc(m[1] ?? "");
    if (!src || /^(data:|blob:)/i.test(src)) continue;
    if (classifyMdHref(src) !== "local") continue;
    if (seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
}

export function replaceHtmlImageSrc(
  html: string,
  src: string,
  dataUrl: string,
): string {
  const needle = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(\\bsrc\\s*=\\s*)(['"])${needle}\\2`, "gi");
  return html.replace(re, `$1$2${dataUrl}$2`);
}

const SCRIPT_RE = /<script\b([^>]*)>\s*<\/script\s*>/gi;

/** 带本地 src 的外置脚本（跳过 http/data/blob），供预览时内联：预览页地址不在原文件旁，相对路径取不到。 */
export function htmlLocalScriptSrcs(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html))) {
    const src = matchSrc(m[1] ?? "");
    if (!src || /^(data:|blob:)/i.test(src)) continue;
    if (classifyMdHref(src) !== "local") continue;
    if (seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
}

/** 把已读到的本地脚本换成内联 `<script>`（保留 type 等属性）；读不到的原样留着，预览里只是不跑。 */
export function replaceLocalScripts(
  html: string,
  jsBySrc: Readonly<Record<string, string>>,
): string {
  return html.replace(SCRIPT_RE, (tag, attrs: string) => {
    const src = matchSrc(attrs ?? "");
    if (!src) return tag;
    const js = jsBySrc[src];
    if (js == null) return tag;
    const rest = attrs.replace(/\s*\bsrc\s*=\s*(?:(['"])[\s\S]*?\1|[^\s>]+)/i, "");
    return `<script${rest}>${js.replace(/<\/script/gi, "<\\/script")}</script>`;
  });
}

export function wrapHtmlDocument(html: string): string {
  const trimmed = html.trim();
  if (/^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return html;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}

export function isLocalStylesheetHref(href: string): boolean {
  return classifyMdHref(href) === "local";
}
