import { isProseCodeSpan, mentionedAudioFiles, mentionedImageFiles, splitReplySections, type ReplySection } from "../chat-reply";
import { sanitizeDocumentHtml } from "../document-html";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Marked } from "marked";
import { ChevronRight, ImageOff, Volume2 } from "lucide-react";
import { useAppStore } from "../store";
import { classifyMdHref, resolveMdPath, rewriteMdImageHtml } from "../reader";
import { cachedImageUrl, loadImageUrl, revalidateImageUrl } from "../image-cache";
import { hydrateMdImages } from "../md-image-hydrate";
import { decorateMdCodeBlocks, decorateMdTables, handleMdCodeCopyClick } from "../md-code-chrome";
import { chatMathExtensions, renderMathInto } from "../md-math";
import { highlightCodeBlocks } from "../code-highlight";
import { citeTipFor, decorateCitations, linkFileRefs } from "../chat-inline-refs";
import { HoverTip } from "./HoverTip";
import { Collapse } from "./PageFrame";
import ChatImageViewer from "./ChatImageViewer";
import { FileTypeGlyph } from "./FileTypeMark";
import { docThumb, docThumbKind, docTypeLabel } from "../doc-thumb";

/**
 * 聊天层里点对话中的图 =「接着改这张图」（2026-10-25 用户对照 ChatGPT）：ChatSurface 提供，把图放进输入框并展开看图标注台。
 * 没有提供的地方（会话浏览等只读视图）点图照旧预览 / 看大图
 */
export const ChatImageEditContext = createContext<((absPath: string) => void) | null>(null);

/**
 * 聊天消息 Markdown 渲染（AI 回复正文；用户气泡保持纯文本）。
 * 与 FilePreviewEditor 的 MarkdownView 的关键差异：会话内容可能含联网抓取的文本，
 * 按不可信处理——用独立 Marked 实例（不碰 md-math 注册的全局实例），原始 HTML 一律转义
 * （raw <img> 会成为追踪像素/外泄通道）；聊天场景单换行很常见，开 breaks。
 * 图片与链接口径同 MarkdownView（批次 B2）：http(s) 图片不加载只显示文本，
 * 本地图片经 read_image_bytes 白名单换 data URL（rewrite 先换成 data-md-src 占位 span）；
 * 外链走系统浏览器，本地路径跳终端页预览。
 * 2026-10-21 排版一轮：公式（$ $$ 与模型常用的 \( \) / \[ \]，KaTeX 按需加载）、代码高亮、表格横滚壳与数字列、
 * 文献引用键胶囊、正文里提到的项目文件就地可点（取代回复末尾那排文件胶囊）；长回复分节的小标题照 Markdown 级别排。
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const chatMarked = new Marked({ gfm: true, breaks: true, async: false });
chatMarked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    // 反引号里的中文说法不当代码排（chat-reply isProseCodeSpan）；其余走默认 <code>
    codespan({ text }) {
      return isProseCodeSpan(text) ? `<span class="md-code-prose">${escapeHtml(text)}</span>` : false;
    },
  },
  extensions: chatMathExtensions,
});

/**
 * HTML 上屏后的就地加工（按 html 跑一次；StrictMode 双跑各函数自己幂等）：表格壳、代码高亮、公式、
 * 引用胶囊、文件链接。图片与代码头栏在每次 layout 都扫（见 MarkdownBody）
 */
function useChatDecorations(ref: RefObject<HTMLElement | null>, html: string, cwd?: string | null) {
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    decorateMdTables(host);
    void highlightCodeBlocks(host);
    void renderMathInto(host);
    void decorateCitations(host, cwd ?? null).then(() => (cwd ? linkFileRefs(host, cwd) : undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, cwd]);
}

export default function ChatMarkdown({
  text,
  cwd,
}: {
  text: string;
  /** 会话工作目录：相对图片/链接的解析基准 + read_image_bytes 的 cwdHint */
  cwd?: string | null;
}) {
  const sections = useMemo(() => splitReplySections(text), [text]);
  const audios = useMemo(() => mentionedAudioFiles(text), [text]);
  // 内嵌的图与正文里提到的路径按会话目录解析后再比：一边写相对路径、一边写绝对路径也认得出是同一张
  const images = useMemo(
    () => mentionedImageFiles(text, (p) => (p.startsWith("~") || !cwd ? p.replace(/\\/g, "/") : resolveMdPath(`${cwd}/_`, p))),
    [text, cwd],
  );
  // 默认全部展开、点小节标题收起：原先只开第一节，长回答大半被藏在一串标题后面，
  // 读起来像内容丢了（2026-10-17 用户截图）
  const [closedSections, setClosedSections] = useState<Set<number>>(() => new Set());
  if (sections && sections.length > 1) {
    return (
      <div className="md-body md-chat">
        {sections.map((section, index) => {
          // 第一个小标题之前的引子没有标题（chat-reply 记作「正文」）：照常排版，不配折叠钮
          if (section.title === "正文") {
            return <MarkdownBody key={`lead-${index}`} text={section.body} cwd={cwd} />;
          }
          const open = !closedSections.has(index);
          return (
            <div key={`${section.title}-${index}`}>
              <SectionHeading
                section={section}
                open={open}
                cwd={cwd}
                onToggle={() =>
                  setClosedSections((prev) => {
                    const next = new Set(prev);
                    if (next.has(index)) next.delete(index);
                    else next.add(index);
                    return next;
                  })
                }
              />
              {section.body && (
                <Collapse open={open}>
                  <MarkdownBody text={section.body} cwd={cwd} />
                </Collapse>
              )}
            </div>
          );
        })}
        <MentionedImages paths={images} cwd={cwd} />
        <MentionedAudios paths={audios} cwd={cwd} />
      </div>
    );
  }
  return (
    <div>
      <MarkdownBody text={text} cwd={cwd} />
      <MentionedImages paths={images} cwd={cwd} />
      <MentionedAudios paths={audios} cwd={cwd} />
    </div>
  );
}

/**
 * 长回复分节的小标题：照 Markdown 的级别排（与不分节的回复里同一个 ## 长得一样，原先做成按钮后被全站
 * button { font: inherit } 吞成正文字号、常规字重），标题里的加粗 / 代码 / 公式照常解析。
 * 折叠箭头挂在标题左侧留白里，悬停 / 聚焦 / 已收起时才出现；点标题文字也能收起
 */
function SectionHeading({
  section,
  open,
  cwd,
  onToggle,
}: {
  section: ReplySection;
  open: boolean;
  cwd?: string | null;
  onToggle: () => void;
}) {
  const html = useMemo(
    () => sanitizeDocumentHtml(chatMarked.parseInline(section.title) as string),
    [section.title],
  );
  const titleRef = useRef<HTMLSpanElement>(null);
  const inner = useMemo(() => ({ __html: html }), [html]);
  useChatDecorations(titleRef, html, cwd);
  const Tag = (["h1", "h2", "h3", "h4"] as const)[Math.min(Math.max(section.level, 1), 4) - 1];
  return (
    <Tag
      className="md-fold-head"
      data-closed={open ? undefined : ""}
      onClick={(e) => {
        // 标题里的链接照常跳转，不当成收起
        if ((e.target as HTMLElement).closest("a")) return;
        onToggle();
      }}
    >
      <button
        type="button"
        className="md-fold-toggle"
        aria-expanded={open}
        aria-label={open ? "收起这一节" : "展开这一节"}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        <ChevronRight
          size={12}
          strokeWidth={2}
          aria-hidden="true"
          style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}
        />
      </button>
      <span ref={titleRef} dangerouslySetInnerHTML={inner} />
    </Tag>
  );
}

/**
 * 用户消息里的围栏代码块：与 AI 回复里的代码块同一套（头栏、复制、高亮）。围栏用比正文里最长的反引号串
 * 多一个的长度，正文里有 ``` 也不会提前收口
 */
export function ChatCodeBlock({ lang, text, cwd }: { lang: string; text: string; cwd?: string | null }) {
  const md = useMemo(() => {
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}${lang.trim()}\n${text.replace(/\n+$/, "")}\n${fence}`;
  }, [lang, text]);
  return <MarkdownBody text={md} cwd={cwd} />;
}

/** 回复里提到的本机图片：正文下方一排图片卡（同一张图写成相对 / 绝对两种只出一张；读不到的不出卡） */
function MentionedImages({ paths, cwd }: { paths: string[]; cwd?: string | null }) {
  const unique = useMemo(() => {
    const seen = new Set<string>();
    return paths.filter((path) => {
      const abs = path.startsWith("~") || !cwd ? path : resolveMdPath(`${cwd}/_`, path);
      if (seen.has(abs)) return false;
      seen.add(abs);
      return true;
    });
  }, [paths, cwd]);
  if (unique.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {unique.slice(0, 6).map((path) => (
        <ChatImageCard key={path} path={path} cwd={cwd} quiet />
      ))}
    </div>
  );
}

function MentionedAudios({ paths, cwd }: { paths: string[]; cwd?: string | null }) {
  if (paths.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {paths.slice(0, 6).map((path) => (
        <ChatAudioCard key={path} path={path} cwd={cwd} />
      ))}
    </div>
  );
}

/**
 * 音频播放条：经 read_audio_bytes 白名单读出字节，拼成 Blob 交给网页自带播放器（可暂停、拖进度、重播）。
 * 文件不在可读范围、已删除、这台电脑的网页内核放不了这种格式（如 Windows 上压缩过的 aifc；
 * 未压缩的 aiff 后端已转成 wav），都如实写出来
 */
export function ChatAudioCard({ path, cwd }: { path: string; cwd?: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ~/ 与绝对路径原样交后端（expand_tilde）；相对路径以会话目录为基准
  const abs = path.startsWith("~") || !cwd ? path : resolveMdPath(`${cwd}/_`, path);
  const name = abs.split(/[\\/]/).pop() ?? abs;

  useEffect(() => {
    let stale = false;
    let url: string | null = null;
    setSrc(null);
    setError(null);
    invoke<{ mime: string; data: string }>("read_audio_bytes", { path: abs, cwdHint: cwd ?? null })
      .then((dto) => {
        if (stale) return;
        const bytes = Uint8Array.from(atob(dto.data), (c) => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: dto.mime }));
        setSrc(url);
      })
      .catch((e) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [abs, cwd]);

  return (
    <div
      className="flex max-w-md flex-col gap-1 rounded-md border border-hairline bg-inset px-2.5 py-2"
      title={abs}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-micro text-l3">
        <Volume2 size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{name}</span>
      </span>
      {error ? (
        <span className="text-micro text-l4">
          {/只支持|不是有效|超过/.test(error) ? error : "读不到这个文件（不在可读取范围或已删除）"}
        </span>
      ) : src ? (
        <audio
          controls
          preload="metadata"
          src={src}
          className="h-8 w-full"
          onError={() => setError("这台电脑的网页内核放不了这种格式，请用别的播放器打开")}
        />
      ) : (
        <span className="text-micro text-l4">音频加载中…</span>
      )}
    </div>
  );
}

function MarkdownBody({
  text,
  cwd,
}: {
  text: string;
  cwd?: string | null;
}) {
  const html = useMemo(
    () => sanitizeDocumentHtml(rewriteMdImageHtml(chatMarked.parse(text) as string)),
    [text],
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  // React 19 按对象引用比 dangerouslySetInnerHTML：每次重画都给新对象，就每次重设 innerHTML，表格壳、高亮、公式、
  // 文件链接全被冲掉再重做一遍，高度跟着变（2026-10-26 实测：切到一段对话后整屏段落被重写两次，上面的字跟着挪）
  const inner = useMemo(() => ({ __html: html }), [html]);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const editImage = useContext(ChatImageEditContext);
  // resolveMdPath 按「文件所在目录」解析相对路径：传 cwd 下的伪文件名，目录即 cwd
  const baseFile = cwd ? `${cwd}/_` : null;

  // 每次 layout 都扫剩余占位（理由见 FilePreviewEditor MarkdownView）。
  useLayoutEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    hydrateMdImages(host, {
      fromFile: baseFile,
      cwdHint: cwd,
      allowHttps: false,
    });
    // 代码块头栏（语言名 + 复制），与笔记预览同一套（2026-10-19 用户：聊天里的代码块没有复制按钮）
    decorateMdCodeBlocks(host);
  });
  useChatDecorations(bodyRef, html, cwd);

  // 引用胶囊的悬停卡片（应用内浮层，不用 WKWebView 的原生 title）
  const [citeTip, setCiteTip] = useState<{ x: number; y: number; text: string; warn: string | null } | null>(null);
  useEffect(() => {
    if (!citeTip) return;
    const hide = () => setCiteTip(null);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [citeTip]);
  function onBodyOver(e: React.MouseEvent<HTMLDivElement>) {
    const chip = (e.target as HTMLElement).closest(".md-cite-item");
    const tip = chip ? citeTipFor(chip) : null;
    if (!chip || !tip) {
      if (citeTip) setCiteTip(null);
      return;
    }
    const r = chip.getBoundingClientRect();
    setCiteTip({
      x: Math.min(Math.max(r.left + r.width / 2, 150), window.innerWidth - 150),
      y: r.top - 8,
      ...tip,
    });
  }

  /** 链接：锚点默认；外链系统浏览器；本地路径跳终端页预览。图片点击 = 预览放大；
   *  正文里提到的项目文件（md-file-link，后端核实过）= 预览这个文件 */
  function onBodyClick(e: React.MouseEvent<HTMLDivElement>) {
    if (handleMdCodeCopyClick(e.target)) return;
    const target = e.target as HTMLElement;
    const fileLink = target.closest<HTMLElement>(".md-file-link");
    if (fileLink?.dataset.fileAbs && cwd) {
      const abs = fileLink.dataset.fileAbs;
      setPreviewReq({ path: abs, name: abs.split(/[\\/]/).pop() ?? abs, root: cwd });
      return;
    }
    const img = target.closest("img");
    if (img?.dataset.ccodePath && editImage) {
      editImage(img.dataset.ccodePath);
      return;
    }
    if (img?.dataset.ccodePath && cwd) {
      const abs = img.dataset.ccodePath;
      setPreviewReq({
        path: abs,
        name: abs.split(/[\\/]/).pop() ?? abs,
        root: cwd,
      });
      return;
    }
    const a = target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!href) return;
    const kind = classifyMdHref(href);
    if (kind === "anchor") return;
    e.preventDefault();
    if (kind === "external" || kind === "other") {
      void openUrl(href).catch(() => {});
      return;
    }
    if (!baseFile || !cwd) return;
    const abs = resolveMdPath(baseFile, href);
    setPreviewReq({
      path: abs,
      name: abs.split(/[\\/]/).pop() ?? abs,
      root: cwd,
    });
  }

  return (
    <>
      <div
        ref={bodyRef}
        onClick={onBodyClick}
        onMouseOver={onBodyOver}
        onMouseLeave={() => setCiteTip(null)}
        className="md-body md-chat"
        dangerouslySetInnerHTML={inner}
      />
      <HoverTip tip={citeTip} text={citeTip?.text ?? ""} warn={citeTip?.warn} up />
    </>
  );
}

/** 消息级图片卡：整行图片路径经 read_image_bytes 白名单读图（image-cache 缓存成 blob URL）内嵌，点击放大到预览页签；
 *  不可读（白名单外/文件已删）回落为路径文本卡（quiet：回复里顺口提到的路径，读不到就不出卡）。
 *  相对路径以 cwd 为基准解析，~/ 原样交后端展开 */
export function ChatImageCard({
  path,
  cwd,
  quiet = false,
}: {
  path: string;
  cwd?: string | null;
  quiet?: boolean;
}) {
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const editImage = useContext(ChatImageEditContext);
  const abs = path.startsWith("~") || !cwd ? path : resolveMdPath(`${cwd}/_`, path);
  const name = abs.split(/[\\/]/).pop() ?? abs;
  // 读过的图首帧就画（image-cache），切回会话不再先出「图片加载中」
  const [src, setSrc] = useState<string | null>(() => cachedImageUrl(abs) ?? null);
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState(false);

  useEffect(() => {
    let stale = false;
    setFailed(false);
    const hit = cachedImageUrl(abs);
    if (hit) {
      setSrc(hit);
      // 磁盘上换了一版（同名重新出图）就换成新图
      void revalidateImageUrl(abs, cwd).then((fresh) => {
        if (fresh && !stale) setSrc(fresh);
      });
      return () => {
        stale = true;
      };
    }
    setSrc(null);
    loadImageUrl(abs, cwd)
      .then((url) => {
        if (!stale) setSrc(url);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [abs, cwd]);

  if (failed && quiet) return null;
  if (failed)
    return (
      <div
        className="my-1 flex items-start gap-1.5 break-all rounded-md border border-hairline bg-inset px-2.5 py-1.5 font-mono text-xs text-l3"
        title={abs}
      >
        <span className="ccode-icon-line">
          <ImageOff size={13} strokeWidth={1.8} aria-hidden="true" className="text-l4" />
        </span>
        <span>{name}（不在可读取范围或文件已删除）</span>
      </div>
    );
  if (!src) return quiet ? null : <div className="md-img-pending my-1">图片加载中…</div>;
  // 聊天层：点图进输入框上方的看图标注台接着改；只读视图里有工作目录走右栏文件预览，随手聊弹层看大图
  return (
    <>
      <button
        type="button"
        className={`my-1 block border-0 bg-transparent p-0 ${editImage ? "cursor-pointer" : "cursor-zoom-in"}`}
        title={editImage ? `${name}（点击查看、标注，接着改）` : `${name}（点击放大预览）`}
        onClick={() => {
          if (editImage) editImage(abs);
          else if (cwd) setPreviewReq({ path: abs, name, root: cwd });
          else setViewing(true);
        }}
      >
        <img
          src={src}
          alt={name}
          className="max-h-64 max-w-full rounded-md border border-hairline object-contain"
        />
      </button>
      {viewing && <ChatImageViewer path={abs} cwdHint={null} onClose={() => setViewing(false)} />}
    </>
  );
}

/** 读过的文档首页预览（键 = 绝对路径）：切回会话不再重画 pdf.js；读不出的记 null，不反复试 */
const docThumbCache = new Map<string, string | null>();

/**
 * 用户消息里的文档附件卡（2026-10-27 用户：PDF 发出去就成了一行路径，要像 ChatGPT 那样一张卡）：
 * 左边首页预览（PDF / Word / 表格，同输入框附件卡 doc-thumb.ts），读不出的画类型图标；右边文件名 + 类型。
 * 点开：有工作目录走右栏文件预览（PDF 自动展开右栏），没有（只读回放）交系统默认应用打开
 */
export function ChatFileCard({ path, cwd }: { path: string; cwd?: string | null }) {
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const abs = path.startsWith("~") || !cwd ? path : resolveMdPath(`${cwd}/_`, path);
  const name = abs.split(/[\\/]/).pop() ?? abs;
  const [thumb, setThumb] = useState<string | null>(() => docThumbCache.get(abs) ?? null);
  useEffect(() => {
    if (docThumbCache.has(abs) || !docThumbKind(abs)) return;
    let stale = false;
    void docThumb(abs, cwd ?? null)
      .catch(() => null)
      .then((url) => {
        docThumbCache.set(abs, url);
        if (!stale) setThumb(url);
      });
    return () => {
      stale = true;
    };
  }, [abs, cwd]);
  return (
    <button
      type="button"
      title={`${abs}（点开查看）`}
      onClick={() => {
        if (cwd) setPreviewReq({ path: abs, name, root: cwd });
        else void openPath(abs).catch(() => {});
      }}
      className="my-1 flex h-14 w-64 max-w-full items-center gap-2.5 overflow-hidden rounded-lg border border-hairline bg-canvas pr-3 text-left transition-colors hover:border-field"
    >
      {thumb ? (
        <img src={thumb} alt="" className="h-full w-10 shrink-0 border-r border-hairline bg-white object-cover object-top" />
      ) : (
        <span aria-hidden="true" className="flex h-full w-10 shrink-0 items-center justify-center border-r border-hairline">
          <FileTypeGlyph path={abs} size={16} />
        </span>
      )}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-xs text-l1">{name}</span>
        <span className="text-micro text-l4">{docTypeLabel(abs)}</span>
      </span>
    </button>
  );
}
