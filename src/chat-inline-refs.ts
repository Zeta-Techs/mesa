/**
 * 聊天回复渲染后的就地加工（ChatMarkdown 在 HTML 上屏后调用）：
 * - 文件路径：正文与行内代码里提到、后端核实确实在会话目录下的文件，变成可点链接（点开预览）；
 *   取代原先回复末尾另排一行的文件胶囊（同一个路径在正文里、末尾各出现一次）。
 * - 文献引用键 `[@key]`：换成小胶囊，悬停出作者 / 年份 / 题名（chat-cite.ts）。
 * 只动 DOM、不改会话原文；sanitize 之后才做，所以新加的 class / data-* 不会被消毒器剥掉。
 * React 换整段 HTML 时这些节点跟着丢，调用方按 html 重跑。
 */
import { invoke } from "@tauri-apps/api/core";
import { fileRefPath, findFileRefs } from "./chat-reply.ts";
import {
  citeLabel,
  citeTipText,
  findCitations,
  lookupCitations,
  type CiteItem,
} from "./chat-cite.ts";

/** 这些地方的字不加工：代码块、链接、公式、已经加工过的、折叠钮 */
const SKIP = "pre, a, button, .md-math, .md-cite, .md-file-link";

function plainTextNodes(host: HTMLElement, alsoSkip = ""): Text[] {
  const out: Text[] = [];
  const walker = host.ownerDocument.createTreeWalker(host, 4 /* NodeFilter.SHOW_TEXT */);
  const skip = alsoSkip ? `${SKIP}, ${alsoSkip}` : SKIP;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest(skip)) continue;
    if (node.nodeValue && node.nodeValue.trim()) out.push(node as Text);
  }
  return out;
}

/** 把一个文本节点里 [index, index+len) 的几段换成 make() 造的元素，其余照旧是文字 */
function wrapRanges(
  node: Text,
  ranges: Array<{ index: number; length: number; make: (text: string) => HTMLElement }>,
): void {
  const text = node.nodeValue ?? "";
  const doc = node.ownerDocument;
  const frag = doc.createDocumentFragment();
  let at = 0;
  for (const r of [...ranges].sort((a, b) => a.index - b.index)) {
    if (r.index < at) continue;
    if (r.index > at) frag.append(doc.createTextNode(text.slice(at, r.index)));
    frag.append(r.make(text.slice(r.index, r.index + r.length)));
    at = r.index + r.length;
  }
  if (at < text.length) frag.append(doc.createTextNode(text.slice(at)));
  node.replaceWith(frag);
}

// ---------- 文件路径 ----------

const EXIST_CACHE_MS = 15_000;
/** 键 = cwd + 原样路径；abs = null 表示核实过、不是文件 */
const existCache = new Map<string, { at: number; abs: string | null }>();

/** 原样路径 → 规范化后的绝对路径（只含核实存在的） */
async function existingFiles(cwd: string, paths: string[]): Promise<Map<string, string>> {
  const now = Date.now();
  const known = new Map<string, string>();
  const ask: string[] = [];
  for (const p of paths) {
    const hit = existCache.get(`${cwd}\n${p}`);
    if (hit && now - hit.at < EXIST_CACHE_MS) {
      if (hit.abs) known.set(p, hit.abs);
    } else ask.push(p);
  }
  if (ask.length) {
    let found: Array<{ path: string; abs: string }> = [];
    try {
      found = await invoke<Array<{ path: string; abs: string }>>("existing_files", { cwd, paths: ask });
    } catch {
      found = [];
    }
    const yes = new Map(found.map((f) => [f.path, f.abs]));
    for (const p of ask) {
      const abs = yes.get(p) ?? null;
      existCache.set(`${cwd}\n${p}`, { at: now, abs });
      if (abs) known.set(p, abs);
    }
  }
  return known;
}

/**
 * 正文与行内代码里的文件路径 → 可点链接（data-file-abs = 后端核实后的绝对路径，点开预览用）。
 * 行内代码整段是一个路径才算（可以只是文件名）；正文里只认带目录的路径（findFileRefs）。
 */
export async function linkFileRefs(host: HTMLElement, cwd: string): Promise<void> {
  const codes = Array.from(host.querySelectorAll<HTMLElement>("code"))
    .filter((el) => !el.closest(SKIP) && !el.dataset.fileChecked)
    .map((el) => ({ el, path: fileRefPath(el.textContent ?? "") }));
  for (const c of codes) c.el.dataset.fileChecked = "1";
  const texts = plainTextNodes(host, "code").map((node) => ({
    node,
    value: node.nodeValue ?? "",
    hits: findFileRefs(node.nodeValue ?? ""),
  }));
  const paths = new Set<string>();
  for (const c of codes) if (c.path) paths.add(c.path);
  for (const t of texts) for (const h of t.hits) paths.add(h.path);
  if (paths.size === 0) return;
  const exists = await existingFiles(cwd, [...paths]);
  if (exists.size === 0) return;
  for (const { el, path } of codes) {
    const abs = path ? exists.get(path) : undefined;
    if (!abs || !el.isConnected) continue;
    el.classList.add("md-file-link");
    el.dataset.fileAbs = abs;
    el.title = "点开预览这个文件";
  }
  for (const t of texts) {
    const hits = t.hits.filter((h) => exists.has(h.path));
    if (!hits.length || !t.node.isConnected || t.node.nodeValue !== t.value) continue;
    wrapRanges(
      t.node,
      hits.map((h) => ({
        index: h.index,
        length: h.raw.length,
        make: (text) => {
          const span = t.node.ownerDocument.createElement("span");
          span.className = "md-file-link";
          span.dataset.fileAbs = exists.get(h.path);
          span.title = "点开预览这个文件";
          span.textContent = text;
          return span;
        },
      })),
    );
  }
}

// ---------- 文献引用 ----------

/** 悬停卡片要的字：正文 + 一行提醒（没找到时） */
export interface CiteTip {
  text: string;
  warn: string | null;
}

const citeTips = new WeakMap<Element, CiteTip>();

/** ChatMarkdown 悬停时取：这颗胶囊该说什么 */
export function citeTipFor(el: Element): CiteTip | null {
  return citeTips.get(el) ?? null;
}

/**
 * `[@key]` → 一组胶囊。先按键名占位（同步，避免原文一闪），cwd 有值时再去读 bib 换成「Smith 2020」。
 * 没有 cwd（回放页没目录）就只留键名胶囊
 */
export async function decorateCitations(host: HTMLElement, cwd: string | null): Promise<void> {
  const made: Array<{ el: HTMLElement; item: CiteItem }> = [];
  for (const node of plainTextNodes(host, "code")) {
    const hits = findCitations(node.nodeValue ?? "");
    if (!hits.length) continue;
    wrapRanges(
      node,
      hits.map((h) => ({
        index: h.index,
        length: h.raw.length,
        make: () => {
          const doc = node.ownerDocument;
          const group = doc.createElement("span");
          group.className = "md-cite";
          for (const item of h.items) {
            const chip = doc.createElement("span");
            chip.className = "md-cite-item";
            chip.dataset.state = "pending";
            chip.textContent = citeLabel(null, item);
            citeTips.set(chip, { text: `@${item.key}`, warn: null });
            group.append(chip);
            made.push({ el: chip, item });
          }
          return group;
        },
      })),
    );
  }
  if (!made.length || !cwd) return;
  const lookup = await lookupCitations(cwd, [...new Set(made.map((m) => m.item.key))]);
  for (const { el, item } of made) {
    if (!el.isConnected) continue;
    const entry = lookup.entries.get(item.key) ?? null;
    el.textContent = citeLabel(entry, item);
    if (entry) {
      el.dataset.state = "found";
      citeTips.set(el, { text: citeTipText(entry), warn: null });
    } else if (lookup.bibFound) {
      el.dataset.state = "missing";
      citeTips.set(el, { text: `@${item.key}`, warn: "references.bib 里没有这个键，核对引用时会被点名" });
    } else {
      el.dataset.state = "nobib";
      citeTips.set(el, { text: `@${item.key}`, warn: "这个目录（及所在项目）里没有找到 references.bib" });
    }
  }
}
