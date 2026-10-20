import { mentionedAudioFiles, mentionedProjectFiles, splitReplySections } from "../chat-reply";
import { FoldMark } from "./PageFrame";
import { sanitizeDocumentHtml } from "../document-html";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Marked } from "marked";
import { useAppStore } from "../store";
import { classifyMdHref, resolveMdPath, rewriteMdImageHtml } from "../reader";
import { hydrateMdImages } from "../md-image-hydrate";
import { decorateMdCodeBlocks, handleMdCodeCopyClick } from "../md-code-chrome";

/**
 * 聊天消息 Markdown 渲染（AI 回复正文；用户气泡保持纯文本）。
 * 与 FilePreviewEditor 的 MarkdownView 的关键差异：会话内容可能含联网抓取的文本，
 * 按不可信处理——用独立 Marked 实例（不碰 md-math 注册的全局实例），原始 HTML 一律转义
 * （raw <img> 会成为追踪像素/外泄通道）；聊天场景单换行很常见，开 breaks。
 * 图片与链接口径同 MarkdownView（批次 B2）：http(s) 图片不加载只显示文本，
 * 本地图片经 read_image_bytes 白名单换 data URL（rewrite 先换成 data-md-src 占位 span）；
 * 外链走系统浏览器，本地路径跳终端页预览。
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
  },
});

export default function ChatMarkdown({
  text,
  cwd,
}: {
  text: string;
  /** 会话工作目录：相对图片/链接的解析基准 + read_image_bytes 的 cwdHint */
  cwd?: string | null;
}) {
  const sections = useMemo(() => splitReplySections(text), [text]);
  const files = useMemo(() => mentionedProjectFiles(text), [text]);
  const audios = useMemo(() => mentionedAudioFiles(text), [text]);
  const setDiffFocusReq = useAppStore((s) => s.setDiffFocusReq);
  // 默认全部展开、点小节标题收起：原先只开第一节，长回答大半被藏在一串标题后面，
  // 读起来像内容丢了（2026-10-17 用户截图）
  const [closedSections, setClosedSections] = useState<Set<number>>(() => new Set());
  if (sections && sections.length > 1) {
    return (
      <div>
        {sections.map((section, index) => {
          const open = !closedSections.has(index);
          // 第一个小标题之前的引子没有标题（chat-reply 记作「正文」）：照常排版，不配折叠钮
          if (section.title === "正文") {
            return <MarkdownBody key={`lead-${index}`} text={section.body} cwd={cwd} />;
          }
          return (
            <div key={`${section.title}-${index}`} className="mt-3 first:mt-0">
              <button
                type="button"
                aria-expanded={open}
                title={open ? "收起这一节" : "展开这一节"}
                className="-ml-1 flex items-center gap-1 rounded-sm px-1 text-sm font-medium text-l1 hover:bg-hover"
                onClick={() =>
                  setClosedSections((prev) => {
                    const next = new Set(prev);
                    if (next.has(index)) next.delete(index);
                    else next.add(index);
                    return next;
                  })
                }
              >
                <FoldMark open={open} />
                <span>{section.title}</span>
              </button>
              {open && section.body && <MarkdownBody text={section.body} cwd={cwd} />}
            </div>
          );
        })}
        <MentionedAudios paths={audios} cwd={cwd} />
        <MentionedFiles files={files} cwd={cwd} onOpen={setDiffFocusReq} />
      </div>
    );
  }
  return (
    <div>
      <MarkdownBody text={text} cwd={cwd} />
      <MentionedAudios paths={audios} cwd={cwd} />
      <MentionedFiles files={files} cwd={cwd} onOpen={setDiffFocusReq} />
    </div>
  );
}

function MentionedFiles({
  files,
  cwd,
  onOpen,
}: {
  files: string[];
  cwd?: string | null;
  onOpen: (req: { cwd: string; path: string }) => void;
}) {
  if (!cwd || files.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {files.slice(0, 8).map((path) => (
        <button
          key={path}
          type="button"
          title="在右侧改动里打开"
          className="rounded-sm bg-inset px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1"
          onClick={() => onOpen({ cwd, path })}
        >
          {path}
        </button>
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
      <span className="truncate text-micro text-l3">🔊 {name}</span>
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
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
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

  /** 链接：锚点默认；外链系统浏览器；本地路径跳终端页预览。图片点击 = 预览放大 */
  function onBodyClick(e: React.MouseEvent<HTMLDivElement>) {
    if (handleMdCodeCopyClick(e.target)) return;
    const target = e.target as HTMLElement;
    const img = target.closest("img");
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
    <div
      ref={bodyRef}
      onClick={onBodyClick}
      className="md-body md-chat"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** 消息级图片卡：整行图片路径经 read_image_bytes 白名单换 data URL 内嵌，点击放大到预览页签；
 *  不可读（白名单外/文件已删）回落为路径文本卡。相对路径以 cwd 为基准解析 */
export function ChatImageCard({
  path,
  cwd,
}: {
  path: string;
  cwd?: string | null;
}) {
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const abs = cwd ? resolveMdPath(`${cwd}/_`, path) : path;
  const name = abs.split(/[\\/]/).pop() ?? abs;

  useEffect(() => {
    let stale = false;
    setSrc(null);
    setFailed(false);
    invoke<{ mime: string; data: string }>("read_image_bytes", {
      path: abs,
      cwdHint: cwd ?? null,
    })
      .then((dto) => {
        if (!stale) setSrc(`data:${dto.mime};base64,${dto.data}`);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [abs, cwd]);

  if (failed)
    return (
      <div
        className="my-1 break-all rounded-md border border-hairline bg-inset px-2.5 py-1.5 font-mono text-xs text-l3"
        title={abs}
      >
        🖼 {name}（不在可读取范围或文件已删除）
      </div>
    );
  if (!src) return <div className="md-img-pending my-1">图片加载中…</div>;
  return (
    <button
      type="button"
      className="my-1 block cursor-zoom-in border-0 bg-transparent p-0"
      title={`${name}（点击放大预览）`}
      onClick={() => {
        if (cwd)
          setPreviewReq({ path: abs, name, root: cwd });
      }}
    >
      <img
        src={src}
        alt={name}
        className="max-h-64 max-w-full rounded-md border border-hairline object-contain"
      />
    </button>
  );
}
