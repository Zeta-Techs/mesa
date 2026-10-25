import { cachedImageUrl, loadImageUrl } from "./image-cache";
import { classifyMdHref, mdImageAbsPath } from "./reader";

function failNode(node: Element, text: string): void {
  if (!node.isConnected) return;
  const span = document.createElement("span");
  span.className = "md-img-failed";
  span.textContent = text;
  node.replaceWith(span);
}

function applyImageUrl(node: Element, url: string, alt: string, abs?: string): void {
  if (!node.isConnected) return;
  const el = document.createElement("img");
  el.src = url;
  el.alt = alt;
  if (abs) el.dataset.ccodePath = abs;
  node.replaceWith(el);
}

/**
 * 把 host 里剩余的 [data-md-src] 占位换成 https 直链或本地图（blob URL）。
 * 一进来就摘掉 data-md-src，防止同一次绘制里重复发起读取。
 * 调用方应在每次 layout 都跑一遍：dangerouslySetInnerHTML 重绘后 deps 不变，
 * 不重跑就会永远停在「图片加载中」。
 */
export function hydrateMdImages(
  host: HTMLElement,
  opts: {
    fromFile: string | null;
    cwdHint: string | null | undefined;
    allowHttps: boolean;
  },
): void {
  for (const node of Array.from(host.querySelectorAll("[data-md-src]"))) {
    const src = node.getAttribute("data-md-src") ?? "";
    const alt = node.getAttribute("data-md-alt") ?? node.getAttribute("alt") ?? "";
    node.removeAttribute("data-md-src");
    node.removeAttribute("data-md-alt");
    if (!src || src.startsWith("data:")) continue;

    if (classifyMdHref(src) === "external") {
      if (opts.allowHttps && /^https:\/\//i.test(src.trim())) {
        if (!node.isConnected) continue;
        const el = document.createElement("img");
        el.referrerPolicy = "no-referrer";
        el.src = src.trim();
        el.alt = alt;
        node.replaceWith(el);
        continue;
      }
      if (!node.isConnected) continue;
      const span = document.createElement("span");
      span.className = "md-img-remote";
      span.textContent = opts.allowHttps
        ? `[外部图片未加载] ${src}`
        : `[图片] ${alt || src}`;
      node.replaceWith(span);
      continue;
    }

    if (!opts.fromFile) {
      if (!node.isConnected) continue;
      const span = document.createElement("span");
      span.className = "md-img-remote";
      span.textContent = `[图片] ${alt || src}`;
      node.replaceWith(span);
      continue;
    }

    const abs = mdImageAbsPath(src, opts.fromFile);
    if (!abs) {
      failNode(node, `[图片不可读] ${src}`);
      continue;
    }
    // 读过的图（image-cache 共用缓存）同步换回：预览重绘、切回会话都不再卡在「图片加载中」
    const cached = cachedImageUrl(abs);
    if (cached) {
      applyImageUrl(node, cached, alt, abs);
      continue;
    }
    if (node instanceof HTMLElement) {
      node.classList.add("md-img-pending");
      node.textContent = "图片加载中…";
    }
    loadImageUrl(abs, opts.cwdHint)
      .then((url) => applyImageUrl(node, url, alt, abs))
      .catch(() => {
        failNode(node, `[图片不可读] ${src}`);
      });
  }
}
