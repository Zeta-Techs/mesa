import { previewSaveCompletion, type FilePreviewSnapshot } from "../file-preview";
import { sanitizeDocumentHtml } from "../document-html";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import SelectionFloatBar, { DistillSkillButton } from "./SelectionFloatBar";
import { confirmDialog } from "./ConfirmDialog";
import { useAppStore } from "../store";
import { useNotePaired } from "../note-pdf-pair";
import {
  bytesToBase64,
  classifyMdHref,
  relMdLinkPath,
  resolveMdPath,
  rewriteMdImageHtml,
} from "../reader";
import { escapeShellPath, imageExtFromMime } from "../terminal-input";
import { saveClipboardImage } from "../clipboard-image";
import { comboLabel, eventMatchesCombo, IS_WINDOWS, READER_MODE_HOTKEY } from "../hotkeys";
import { imeBlocksEnter } from "../ime-guard";
// md-math 模块作用域完成 marked 公式扩展注册（全局生效，占位=原始 $..$ 源码，未升级处观感不变）
import { renderMathInto } from "../md-math";
import { mdBlocks, mdChildTagOf, mdLineForChild } from "../md-block-map";
import { renderMarkdownDocument, splitMdFrontmatter } from "../md-render";
import { citeTipFor, decorateCitations } from "../chat-inline-refs";
import { parentDir } from "../path-utils";
import {
  continueListItem,
  toggleInlineMark,
  toggleLinePrefix,
  wrapAsLink,
  type MdEditResult,
} from "../md-edit";
import { hydrateMdImages } from "../md-image-hydrate";
import { focusMdText, linkifyPdfRefs, pdfRefFromTarget } from "../md-pdf-refs";
import type { PdfJumpRef } from "../reader-note";
import { isPreviewableImagePath } from "../file-icons";
import { isHtmlPath, isMarkdownPath } from "../md-path";
import { hasMermaidFence } from "../mermaid-blocks";
import { annotationDraftFromSelection } from "../draft-review";
import {
  decorateMdCodeBlocks,
  handleMdCodeCopyClick,
} from "../md-code-chrome";
import ImagePreview from "./ImagePreview";
import HtmlPreview from "./HtmlPreview";
import MdToc from "./MdToc";
import MdFrontmatterCard from "./MdFrontmatterCard";
import { HoverTip } from "./HoverTip";
import PreviewErrorState from "./PreviewErrorState";
import {
  LATEX_EXTENSIONS,
  LATEX_LANGUAGE_ID,
  latexMonarch,
  matchLanguageByPath,
} from "../editor-languages";

const MermaidDiagrams = lazy(() => import("./MermaidDiagrams"));

// 只用基础 editor worker（不需要语言服务的 intellisense）
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

// Monaco 主题跟随 App.css 令牌：编辑器面色从当前主题的 --color-editor-* 读取
// （只读正在显示的主题，不切 data-theme）；base vs-dark 继承语法高亮。
// 主题切换由 MutationObserver 监听 data-theme 触发重新 define + setTheme（见组件内 effect）。
function syncMonacoTheme() {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  monaco.editor.defineTheme("ccode-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": read("--color-editor-bg", "#11131a"),
      "editor.foreground": read("--color-editor-fg", "#aeb6c6"),
      "editorLineNumber.foreground": read("--color-editor-line", "#525a6b"),
    },
  });
}
syncMonacoTheme();

// LaTeX 语言注册（批次 E）：monaco 0.56 内置语言表没有 latex，注册自带 monarch 定义；
// languageFor 按已注册语言表的扩展名自动命中，无需单独映射
monaco.languages.register({
  id: LATEX_LANGUAGE_ID,
  extensions: [...LATEX_EXTENSIONS],
});
monaco.languages.setMonarchTokensProvider(LATEX_LANGUAGE_ID, latexMonarch);

/** 按文件扩展名/文件名推断 Monaco 语言（无匹配则 plaintext） */
function languageFor(path: string): string | undefined {
  return matchLanguageByPath(monaco.languages.getLanguages(), path);
}

/** 路径归属（workspaces::path_context）：防止误以为在改分支实际改了主仓库 */
interface PathContext {
  kind: "worktree" | "main" | "other";
  workspaceName: string | null;
  branch: string | null;
}

/** 划选记一条的四处文案：浮条按钮 / 提交钮 / 输入框提示 / 记上后的回执 */
export interface AnnotateCopy {
  button: string;
  submit: string;
  placeholder: string;
  done: string;
}

const REVIEW_ANNOTATE_COPY: AnnotateCopy = {
  button: "加进意见",
  submit: "加入意见",
  placeholder: "这一处要怎么改",
  done: "已加进上面的意见",
};

/**
 * Markdown 阅读视图（RX2a）：marked 渲染本地文件内容。
 * 本地文件同样是不可信内容；转换与图片重写后统一清洗，保留 GFM 排版。
 * 代码块不做语法高亮（素色块 + 语言名/复制）；mermaid 围栏懒加载成图。
 * 样式全部走 App.css 的 .md-body 主题令牌。
 * 选中文字出现浮动按钮「◈ 讨论/改写此段」（与 PDF 问 AI 共用 SelectionFloatBar），
 * 点击把选段 + 出处交给调用方写入活跃终端输入（「↵ 直接发送」立即回车发送）；沉浸阅读覆盖层同款生效。
 * 另有「✦ 沉淀为技能」（DistillSkillButton）：AI 把选段提炼成技能草稿，跳技能页新建表单预填。
 * 双击段落切编辑态并定位到对应源码行（映射见 md-block-map；配对失败回落纯切换）。
 * 批次 B2 / v3.161 后处理：渲染前把 img 换成 data-md-src 占位 span（避免 WebView
 * 把相对/绝对本地 png/gif 当成网站地址拉成裂图，也避免无 src 的 img 直接画问号）；
 * 本地图经 read_image_bytes 换 data URL。本机打开的 md 允许显示 https 图；
 * 相对链接点击在阅读区笔记栏/预览页签内打开。
 */
function MarkdownView({
  text,
  large,
  fileName,
  filePath,
  root,
  onDiscuss,
  onAnnotate,
  onOpenFile,
  onJumpToSource,
  compact,
  onPdfRef,
  focusText,
  annotateCopy = REVIEW_ANNOTATE_COPY,
}: {
  text: string;
  large?: boolean;
  /** 划选记一条的文案（缺省 = 审阅页「加进意见」；阅读区抽查 = 「记成问题」） */
  annotateCopy?: AnnotateCopy;
  /** 窄栏排版（阅读区笔记栏）：标题字号收一档 */
  compact?: boolean;
  /** 正文里的页码/图表引用可点（阅读区笔记栏：点了跳 PDF） */
  onPdfRef?: (ref: PdfJumpRef) => void;
  /** 滚到含这段文字的块并闪一下（nonce 递增即执行一次） */
  focusText?: { text: string; nonce: number } | null;
  fileName: string;
  /** 当前 md 文件绝对路径：相对图片/链接的解析基准 */
  filePath: string;
  /** 预览根约束（read_image_bytes 的 cwdHint 来源之一） */
  root: string;
  /** 返回 null 表示已写入；返回字符串为要给用户看的提示（如无运行中 agent）。send=true 直接发送 */
  onDiscuss?: (
    text: string,
    fileName: string,
    send?: boolean,
  ) => string | null | Promise<string | null>;
  /** 审阅划选：把选段和批注收进意见框。返回字符串为提示；返回 null 表示已追加 */
  onAnnotate?: (
    text: string,
    fileName: string,
    comment: string,
  ) => string | null;
  /** 相对链接的打开去向（阅读区笔记栏原地打开）；缺省走 store previewReq 终端页预览 */
  onOpenFile?: (absPath: string) => void;
  /** 双击段落：切编辑态并定位到该块源码行（null=定位失败，只切模式）；只读/截断时宿主不传 */
  onJumpToSource?: (line: number | null) => void;
}) {
  // YAML 头（qmd / SKILL.md / Quarto 稿件）拆出来画成小卡，不交给 marked——原先渲染成横线 + 大号二级标题
  //（md-render.ts）；lineOffset = 拆掉的行数，双击跳源码行要加回去
  const doc = useMemo(() => splitMdFrontmatter(text), [text]);
  // 渲染/映射共用解析源（emoji 替换的原因见下方 html useMemo 注释）：
  // 双击跳源码行的映射（md-block-map）必须与渲染解析同一份字符串
  const mdSource = useMemo(
    () => doc.body.replace(/⚠️/g, "⚠︎"),
    [doc.body],
  );
  const html = useMemo(
    // ⚠️（U+26A0+U+FE0F）在 WKWebView 里渲染成黄色 Apple Color Emoji，
    // 与沉浸冷黑主题冲突（笔记里大量「⚠️ 仅摘要」提示）；换成文本呈现选择符
    // FE0E 让其按文字颜色单色渲染。只改显示、不改文件内容；
    // 实测 font-variant-emoji: text 在 WKWebView 无效，故走字符替换
    () =>
      sanitizeDocumentHtml(rewriteMdImageHtml(renderMarkdownDocument(mdSource))),
    [mdSource],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const showMermaid = useMemo(() => hasMermaidFence(text), [text]);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [annotateDraft, setAnnotateDraft] = useState<string | null>(null);
  const [annotateComment, setAnnotateComment] = useState("");
  const pendingExcerptRef = useRef("");
  useEffect(() => {
    setAnnotateDraft(null);
    setAnnotateComment("");
  }, [filePath]);

  const showHint = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(null), 3000);
  }, []);
  useEffect(
    () => () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    },
    [],
  );

  /** 选段 → 活跃终端 agent 输入；send=true 直接发送。成功写入后清选区，浮动条随 selectionchange 收起 */
  function discuss(send?: boolean) {
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (!selected || !onDiscuss) return;
    void Promise.resolve(onDiscuss(selected, fileName, send)).then((err) => {
      showHint(
        err ??
          (send
            ? "已发送到活跃终端"
            : "已写入活跃终端的输入框，接着输入你的意见后自行发送"),
      );
      if (!err) window.getSelection()?.removeAllRanges();
    });
  }

  /** 审阅批注：按下时先记住选段。WebView 里 click 会清掉选区，那时再读就是空的。 */
  function rememberExcerpt() {
    pendingExcerptRef.current = annotationDraftFromSelection(
      window.getSelection()?.toString() ?? "",
    ) ?? "";
  }

  function beginAnnotate() {
    const selected =
      pendingExcerptRef.current ||
      annotationDraftFromSelection(window.getSelection()?.toString() ?? "") ||
      "";
    pendingExcerptRef.current = "";
    if (!selected || !onAnnotate) return;
    setAnnotateDraft(selected);
    setAnnotateComment("");
    window.getSelection()?.removeAllRanges();
  }

  function commitAnnotate() {
    if (!annotateDraft || !onAnnotate) return;
    const err = onAnnotate(annotateDraft, fileName, annotateComment);
    if (err) showHint(err);
    else showHint(annotateCopy.done);
    setAnnotateDraft(null);
    setAnnotateComment("");
  }

  // 每次 layout 都扫剩余 [data-md-src]：父级重绘若把 innerHTML 盖回占位，
  // deps 不变就不会进这个 effect，图会永远停在「图片加载中」。
  useLayoutEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    hydrateMdImages(host, {
      fromFile: filePath,
      cwdHint: root,
      allowHttps: true,
    });
    decorateMdCodeBlocks(host);
  });

  // 文献引用 [@key] → 小胶囊（与聊天同一套 chat-inline-refs：从文件所在目录往上找 references.bib，
  // 只读）；先于页码链接化，免得「[@a, p. 3]」里的页码被拆成跳转链接、整段认不出引用。
  // 每次布局都扫（幂等，已包过的跳过）
  useLayoutEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    void decorateCitations(host, parentDir(filePath) || root);
    if (onPdfRef) linkifyPdfRefs(host);
  });

  // 引用胶囊的悬停卡片（应用内浮层，同聊天）
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
    setCiteTip({ x: r.left + r.width / 2, y: r.top - 8, ...tip });
  }

  // 外部定位（PDF 高亮「在笔记里看」）：正文换过（html 变）后也要能落位
  const focusedNonceRef = useRef(0);
  useEffect(() => {
    const host = bodyRef.current;
    if (!host || !focusText || focusedNonceRef.current === focusText.nonce) return;
    if (focusMdText(host, focusText.text)) focusedNonceRef.current = focusText.nonce;
  }, [focusText, html]);

  // 公式升级（批次 E）：.md-math 占位换 KaTeX 排版；无公式时函数直接返回、不加载 katex
  useEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    void renderMathInto(host);
  }, [html]);

  /** 链接点击（批次 B2）：锚点默认滚动；外链走系统浏览器（openUrl，webview 内跳转会破坏应用）；
      相对/绝对路径原地打开——阅读区笔记栏由 onOpenFile 接管，否则 previewReq 跳终端页预览 */
  function onBodyClick(e: React.MouseEvent<HTMLDivElement>) {
    if (handleMdCodeCopyClick(e.target)) {
      e.preventDefault();
      return;
    }
    const ref = onPdfRef ? pdfRefFromTarget(e.target) : null;
    if (ref) {
      e.preventDefault();
      onPdfRef!(ref);
      return;
    }
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!href) return;
    const kind = classifyMdHref(href);
    if (kind === "anchor") {
      // 页内锚点（脚注 ↔ 正文、手写目录）只在这份预览里找：同屏几份预览 id 会重名，交给 WebView
      // 默认跳转会改应用地址栏的 hash、还可能跳到别的预览里
      const id = decodeURIComponent(href.slice(1));
      const target = id ? bodyRef.current?.querySelector(`[id="${CSS.escape(id)}"]`) : null;
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      return;
    }
    e.preventDefault();
    if (kind === "external" || kind === "other") {
      void openUrl(href).catch(() => showHint("无法打开外部链接"));
      return;
    }
    const abs = resolveMdPath(filePath, href);
    if (onOpenFile) onOpenFile(abs);
    else setPreviewReq({ path: abs, name: abs.split(/[\\/]/).pop() ?? abs, root });
  }

  /** 双击段落跳源码行（2026-10-14 拍板）：双击时惰性配对当前 DOM 顶层块 ↔ 块 token
      起始行，定位失败回落纯切编辑态。配对不常驻——decorate/mermaid/图片水合都会
      改写顶层节点形态，常驻映射会留死键（详见 md-block-map 头注释） */
  function onBodyDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    const host = bodyRef.current;
    if (!host || !onJumpToSource) return;
    const target = e.target;
    if (!(target instanceof Element) || target === host) return;
    // 链接/图片/代码条的双击保持原语义（单击已处理打开/复制），不抢成跳编辑
    if (target.closest("a, img, button, input, .md-code-bar, .md-pdf-ref")) return;
    // 批注草稿表单开着时双击不跳编辑——跳转会卸载阅读态、把已输入的意见静默丢掉
    if (annotateDraft !== null) return;
    // 双击默认选词会让划选浮条闪一帧——跳转前先清选区
    window.getSelection()?.removeAllRanges();
    let el: Element = target;
    while (el.parentElement && el.parentElement !== host) el = el.parentElement;
    const index = Array.prototype.indexOf.call(host.children, el);
    if (index < 0) {
      onJumpToSource(null);
      return;
    }
    const tags = Array.from(host.children).map((c) =>
      mdChildTagOf(c.tagName, c.getAttribute("class") ?? ""),
    );
    const line = mdLineForChild(mdBlocks(mdSource), tags, index);
    onJumpToSource(line === null ? null : line + doc.lineOffset);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {hint && (
        <p
          className="shrink-0 truncate bg-inset px-3 py-1 text-xs text-l2"
          title={hint}
        >
          {hint}
        </p>
      )}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <MdToc bodyRef={bodyRef} />
        {doc.front && (
          <MdFrontmatterCard
            fields={doc.front.fields}
            className={large ? "mx-auto max-w-3xl px-8 pt-10" : compact ? "px-4 pt-3" : "px-5 pt-4"}
            onDoubleClick={onJumpToSource ? () => onJumpToSource(1) : undefined}
          />
        )}
        <div
          ref={bodyRef}
          onClick={onBodyClick}
          onDoubleClick={onJumpToSource ? onBodyDoubleClick : undefined}
          onMouseOver={onBodyOver}
          onMouseLeave={() => setCiteTip(null)}
          className={`md-body${large ? " md-body-lg" : ""}${compact ? " md-body-compact" : ""} ${
            large ? "mx-auto max-w-3xl px-8 py-10" : compact ? "px-4 py-3" : "px-5 py-4"
          }`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <HoverTip tip={citeTip} text={citeTip?.text ?? ""} warn={citeTip?.warn} up />
        {showMermaid && (
          <Suspense fallback={null}>
            <MermaidDiagrams hostRef={bodyRef} html={html} />
          </Suspense>
        )}
        {(onDiscuss || onAnnotate) && (
          <SelectionFloatBar
            containerRef={scrollRef}
            withinSelector=".md-body"
            reserveWidth={onAnnotate && onDiscuss ? 420 : onAnnotate ? 120 : 320}
          >
            {onAnnotate && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  rememberExcerpt();
                }}
                onClick={beginAnnotate}
                className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110"
              >
                {annotateCopy.button}
              </button>
            )}
            {onDiscuss && (
              <>
                <button
                  type="button"
                  // preventDefault 保住选区，click 时才读文字
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => discuss()}
                  className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110"
                >
                  ◈ 讨论/改写此段
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => discuss(true)}
                  className="rounded-sm border border-field bg-strip px-2 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
                >
                  ↵ 直接发送
                </button>
                <DistillSkillButton onHint={showHint} />
              </>
            )}
          </SelectionFloatBar>
        )}
      </div>
      {annotateDraft && (
        <form
          className="shrink-0 border-t border-hairline bg-strip px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            commitAnnotate();
          }}
        >
          <p className="mb-1 line-clamp-2 text-micro text-l3" title={annotateDraft}>
            「{annotateDraft.replace(/\s+/g, " ")}」
          </p>
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={annotateComment}
              onChange={(event) => setAnnotateComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setAnnotateDraft(null);
                }
              }}
              placeholder={annotateCopy.placeholder}
              className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4"
            />
            <button
              type="submit"
              className="shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110"
            >
              {annotateCopy.submit}
            </button>
            <button
              type="button"
              onClick={() => setAnnotateDraft(null)}
              className="shrink-0 rounded-sm px-2 py-1 text-xs text-l3 hover:bg-hover hover:text-l1"
            >
              取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * 文件预览编辑器（P4）：Monaco 取代只读 pre。
 * 内容经 read_file_preview 加载（根目录约束、二进制/截断处理沿用后端），
 * 脏状态上报给调用方（预览页签的脏点），保存走 save_file_preview（原子写）。
 * png/jpg/gif/webp/svg 在入口处改走 ImagePreview，避免 NUL 嗅探报「二进制不支持」。
 */
function TextFilePreviewEditor({
  path,
  root,
  onDirtyChange,
  revealLine,
  onDiscuss,
  onAnnotate,
  annotateCopy,
  readOnly,
  hideImmersive,
  onOpenFile,
  onOpenReader,
  modeTick,
  leading,
  mainRepoIsHome,
  compact,
  onPdfRef,
  focusText,
}: {
  path: string;
  root: string;
  /** 窄栏排版（阅读区笔记栏）：md 阅读态标题字号收一档 */
  compact?: boolean;
  /** md 阅读态正文里的页码/图表引用可点（阅读区笔记栏：点了跳 PDF） */
  onPdfRef?: (ref: PdfJumpRef) => void;
  /** 定位到含这段文字的地方：阅读态滚到那一块并闪一下，编辑态选中并居中（nonce 递增即执行） */
  focusText?: { text: string; nonce: number } | null;
  onDirtyChange?: (dirty: boolean) => void;
  /** 打开后滚到这一行。终端路径点击传入。 */
  revealLine?: number | null;
  /** md 阅读视图选段「◈ 讨论/改写此段」：写入活跃终端输入（send=true 直接发送）；返回 null 已写入，否则为提示 */
  onDiscuss?: (
    text: string,
    fileName: string,
    send?: boolean,
  ) => string | null | Promise<string | null>;
  /** 审阅划选「加进意见」：选段和批注追加到意见框 */
  onAnnotate?: (
    text: string,
    fileName: string,
    comment: string,
  ) => string | null;
  annotateCopy?: AnnotateCopy;
  /** 宿主要求只读（阅读区抽查：笔记还在工作区里等评审）：值是工具条上给人看的原因 */
  readOnly?: string;
  /** 宿主声明「主仓库就是这份文件的正常落点」（阅读区笔记栏：笔记本来就记在项目里，属日常积累面，
   *  不进任何工作区分支）：不挂琥珀色「主仓库（非分支）」、保存不再每次弹危险确认。 */
  mainRepoIsHome?: boolean;
  /** 嵌入阅读区笔记栏等宿主时置 true：自带的 ⺆ 全宽沉浸层是 z-30，压在阅读区 z-40 下面会失灵。
   *  例外：md 阅读态 + onOpenReader 的「进阅读区」按钮照常显示——它跳去真正的 z-40 阅读区，
   *  不经过 z-30 层（文件页 md 预览就靠这个入口，2026-09-20） */
  hideImmersive?: boolean;
  /** md 阅读视图相对链接的打开去向（阅读区笔记栏原地打开）；缺省走 previewReq 终端页预览 */
  onOpenFile?: (absPath: string) => void;
  /** md 阅读态「⛶ 沉浸阅读」改为进三栏阅读区（笔记｜PDF｜Agent，配对失败由调用方提示）；
      缺省保持自带的单栏沉浸层 */
  onOpenReader?: () => void;
  /** 外部触发「阅读/编辑」翻转的信号（阅读区 ⌘E；先例：TerminalPage readerAgentTick
      同款 tick/signal 模式）——值变化即翻转，初挂载不动作；传了它才在按钮 title 上带快捷键 */
  modeTick?: number;
  /** 审阅笔记列表收起后的展开按钮。放进标题栏，不另占一列。 */
  leading?: ReactNode;
}) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // 编辑器宿主节点独立于 React 渲染树：沉浸编辑切换只移动 DOM 节点，
  // Monaco 实例、undo 栈、dirty 与光标全部保留（React 重挂会丢实例）
  const hostElRef = useRef<HTMLDivElement | null>(null);
  if (!hostElRef.current) hostElRef.current = document.createElement("div");
  const normalSlotRef = useRef<HTMLDivElement>(null);
  const immersiveSlotRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<string | null>(null);
  /** text 对应的文件路径：路径切换后旧内容不等新加载、立即视为无效（防残留误导） */
  const textPathRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [fileReadOnly, setReadOnlyReason] = useState<string | null>(null);
  const readOnlyReason = readOnly ?? fileReadOnly;
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ctx, setCtx] = useState<PathContext | null>(null);
  // 粘贴图片等输入侧动作的瞬态轻反馈（3s 自动消，同终端页 inputNote 模式）
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const pasteNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flashPasteNote(text: string) {
    setPasteNote(text);
    if (pasteNoteTimerRef.current) clearTimeout(pasteNoteTimerRef.current);
    pasteNoteTimerRef.current = setTimeout(() => setPasteNote(null), 3000);
  }
  useEffect(
    () => () => {
      if (pasteNoteTimerRef.current) clearTimeout(pasteNoteTimerRef.current);
    },
    [],
  );
  // 阅读/编辑模式与沉浸覆盖层（md/html 有阅读态；其他文本固定编辑态）
  const isMd = isMarkdownPath(path);
  const isHtml = isHtmlPath(path);
  const hasReadMode = isMd || isHtml;
  const [mode, setMode] = useState<"read" | "edit">(hasReadMode ? "read" : "edit");
  const [immersive, setImmersive] = useState(false);
  // 这份 md 能不能进三栏沉浸阅读（note-pdf-pair.ts）：配得上本篇 PDF 才给「沉浸阅读」；CHANGELOG、README 这类
  // 配不上的只给「全屏阅读」（2026-10-25 用户：没有 PDF 的文件预览也挂「沉浸阅读」有歧义）
  const notePaired = useNotePaired(path, isMd && Boolean(onOpenReader));
  // 双击段落跳源码行（2026-10-14 拍板）：{line, nonce} 同 modeTick 的 tick 模式——
  // 双击同一块两次也要重新定位（revealLine prop 的同值不重触发不适用于交互重放）
  const [jumpReveal, setJumpReveal] = useState<{
    line: number;
    nonce: number;
  } | null>(null);
  const jumpNonceRef = useRef(0);
  const jumpDoneNonceRef = useRef(0);

  /** 编辑→阅读：把编辑器缓冲（含未保存改动）同步进 text 状态。
      编辑期间 text 不随键入更新、dirty 时 watcher 也停订，不同步的话
      阅读态永远停在旧盘稿（新增/删除都看不见）；反向（text → 编辑器）
      由既有的 external-reload effect 负责，模型相同会自行跳过 */
  function switchMode(m: "read" | "edit") {
    if (m === "read" && editorRef.current) {
      setText(editorRef.current.getValue());
    }
    setMode(m);
  }

  /** 阅读态双击段落的落点：切编辑态；拿到行号则排队定位（定位 effect 在 revealLine 邻近） */
  function jumpToSource(line: number | null) {
    switchMode("edit");
    if (line !== null && line > 0) {
      jumpNonceRef.current += 1;
      setJumpReveal({ line, nonce: jumpNonceRef.current });
    }
  }

  /** 把 md-edit 纯函数的结果回写编辑器：整文替换 + undo 止点 + 还原选区（offset↔position）。
      全文替换单条 edit，大文件开销可忽略；undo 一步成组 */
  function applyMdEdit(
    fn: (text: string, s: number, e: number) => MdEditResult,
  ) {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !model || !sel) return;
    const s = model.getOffsetAt(sel.getStartPosition());
    const e = model.getOffsetAt(sel.getEndPosition());
    const r = fn(model.getValue(), s, e);
    if (r.text === model.getValue() && r.selStart === s && r.selEnd === e) return;
    ed.focus();
    // 前后双止点：把格式化独立成一步 undo，不与之前的连续打字并组
    ed.pushUndoStop();
    ed.executeEdits("md-format", [
      { range: model.getFullModelRange(), text: r.text },
    ]);
    ed.pushUndoStop();
    const p1 = model.getPositionAt(r.selStart);
    const p2 = model.getPositionAt(r.selEnd);
    ed.setSelection({
      startLineNumber: p1.lineNumber,
      startColumn: p1.column,
      endLineNumber: p2.lineNumber,
      endColumn: p2.column,
    });
  }

  /** 回车续列表（md）：列表项继承前缀（任务清单重置未勾选）、空项退出；
      非列表行保持默认「换行 + 保留缩进」的等价实现。多光标只处理主光标 */
  function mdEnter() {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !model || !sel || !ed.hasTextFocus()) return;
    const line = model.getLineContent(sel.startLineNumber);
    const lead = /^[\t ]*/.exec(line)![0];
    const cont = continueListItem(line);
    ed.pushUndoStop();
    if (cont.kind === "continue") {
      ed.executeEdits("md-enter", [
        { range: sel, text: "\n" + lead + cont.prefix },
      ]);
      ed.pushUndoStop();
    } else if (cont.kind === "exit") {
      ed.executeEdits("md-enter", [
        {
          range: {
            startLineNumber: sel.startLineNumber,
            startColumn: 1,
            endLineNumber: sel.startLineNumber,
            endColumn: model.getLineMaxColumn(sel.startLineNumber),
          },
          text: cont.clean,
        },
      ]);
      ed.pushUndoStop();
      ed.setPosition({
        lineNumber: sel.startLineNumber,
        column: cont.clean.length + 1,
      });
    } else {
      // 键盘路径不再到达（监听层只在列表行接管），留作防御
      ed.executeEdits("md-enter", [{ range: sel, text: "\n" + lead }]);
      ed.pushUndoStop();
    }
  }

  // 外部快捷键翻转（阅读区 ⌘E）：tick 变化即翻转一次；初挂载跳过
  const modeTickRef = useRef(modeTick);
  useEffect(() => {
    if (modeTickRef.current === modeTick) return;
    modeTickRef.current = modeTick;
    if (hasReadMode) switchMode(mode === "read" ? "edit" : "read");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeTick]);

  // 宿主节点挂到当前槽位（普通位置或沉浸覆盖层），移动不重建编辑器
  useEffect(() => {
    const host = hostElRef.current!;
    const slot =
      immersive && mode === "edit" ? immersiveSlotRef.current : normalSlotRef.current;
    slot?.appendChild(host);
    host.className = `min-h-0 flex-1${mode === "read" ? " hidden" : ""}`;
  }, [immersive, mode]);

  // 路径切换时按文件类型重置阅读/编辑与沉浸态
  useEffect(() => {
    setMode(isMarkdownPath(path) || isHtmlPath(path) ? "read" : "edit");
    setImmersive(false);
  }, [path]);

  // 沉浸覆盖层（阅读/编辑共用）：Esc 退出（终端/PTY 保持挂载，仅视觉覆盖，同评审覆盖层形态）
  useEffect(() => {
    if (!immersive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImmersive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [immersive]);

  // 路径归属查询（失败/未命中不显示徽标）
  useEffect(() => {
    let cancelled = false;
    setCtx(null);
    invoke<PathContext>("path_context", { path })
      .then((c) => {
        if (!cancelled && c.kind !== "other") setCtx(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);

  // 磁盘上的最新内容（加载/保存时更新）：外部变化重载时用于比对，避免自己保存触发的回环
  const lastSavedRef = useRef<FilePreviewSnapshot | null>(null);
  // executeEdits 做外部内容替换期间置位，dirty 监听跳过这次程序性改动
  const applyingExternalRef = useRef(false);

  // 加载文件内容
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    setDirty(false);
    dirtyRef.current = false;
    savingRef.current = false;
    setSaving(false);
    lastSavedRef.current = null;
    setReadOnlyReason(null);
    onDirtyChange?.(false);
    void (async () => {
      try {
        const p = await invoke<FilePreviewSnapshot>(
          "read_file_preview",
          { path, root },
        );
        if (cancelled) return;
        lastSavedRef.current = p;
        textPathRef.current = path;
        setText(p.text);
        setTruncated(p.truncated);
        setReadOnlyReason(p.readOnlyReason);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, root, reloadKey]);

  // text 只有在属于当前 path 时才有效；切换路径的瞬间旧内容立即失效（空白等待新加载）
  const ready = text !== null && textPathRef.current === path;

  // 外部变化自动刷新（合并/agent 写盘等）：监听文件所在目录，内容真的变了才重载；
  // 编辑中（dirty）不订阅，不覆盖用户未保存的修改
  useEffect(() => {
    if (dirty || saving || !ready) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let watchId: string | null = null;
    let refreshGeneration = 0;
    const parent = path.replace(/[\\/][^\\/]*$/, "");
    void (async () => {
      try {
        watchId = await invoke<string>("watch_dir", { path: parent });
        if (cancelled) {
          invoke("unwatch_dir", { id: watchId }).catch(() => {});
          return;
        }
        unlisten = await listen(`fs-changed-${watchId}`, async () => {
          try {
            const generation = ++refreshGeneration;
            const p = await invoke<FilePreviewSnapshot>("read_file_preview", { path, root });
            if (!cancelled && generation === refreshGeneration && !dirtyRef.current && !savingRef.current) {
              const ed = editorRef.current;
              const model = ed?.getModel();
              if (ed && model && model.getValue() !== p.text) {
                applyingExternalRef.current = true;
                try {
                  ed.executeEdits("external-reload", [{ range: model.getFullModelRange(), text: p.text }]);
                } finally {
                  applyingExternalRef.current = false;
                }
              }
              lastSavedRef.current = p;
              setTruncated(p.truncated);
              setReadOnlyReason(p.readOnlyReason);
              setText(p.text);
            }
          } catch {
            /* 文件被删/不可读：保持现状 */
          }
        });
      } catch {
        /* 目录不可监听：退回手动重开 */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      if (watchId) invoke("unwatch_dir", { id: watchId }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, root, dirty, saving, ready]);

  // 创建/销毁编辑器；只读状态单独更新，不因文件增长而重建旧内容。
  // 同路径的外部内容更新不重建编辑器，由下方同步 effect 走 executeEdits，保住滚动/光标/undo。
  useEffect(() => {
    if (!ready) return;
    syncMonacoTheme(); // 创建前对齐当前 data-theme 的编辑器面色
    const ed = monaco.editor.create(hostElRef.current!, {
      value: text!,
      language: languageFor(path),
      theme: "ccode-dark",
      readOnly: truncated || readOnlyReason !== null,
      // md 开折行（2026-10-14 拍板）：笔记栏窄栏 + reflowBlockText 接成的中文单行长段，
      // 不折行时源码态要横向滚动盲找位置；其他语言保持默认不折行
      wordWrap: isMd ? "on" : "off",
      // md 缩进 2 空格（列表嵌套），其他语言保持 monaco 默认
      ...(isMd ? { insertSpaces: true, tabSize: 2 } : {}),
      minimap: { enabled: false },
      fontSize: 12.5,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: "none",
      // 关闭 unicode 高亮（VS Code 式防 Trojan Source 特性）：其 locale 精确匹配
      // zh-hans 在 WKWebView 里拿不到（_os 得 zh-Hans-CN、_vscode 得 zh-cn，均不命中），
      // 回落 _default 后全角标点（）：；， 全部被套黄色方框；即使命中，
      // 科研笔记里大量出现的 −（U+2212）×（U+00D7）也照框不误——对中文笔记纯噪音
      unicodeHighlight: {
        ambiguousCharacters: false,
        invisibleCharacters: false,
        nonBasicASCII: false,
      },
    });
    editorRef.current = ed;
    const sub = ed.onDidChangeModelContent(() => {
      if (applyingExternalRef.current) return;
      dirtyRef.current = true;
      setDirty(true);
      onDirtyChange?.(true);
    });
    return () => {
      sub.dispose();
      ed.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // 终端路径点击的滚行：响应式执行——同文件换行号、编辑器后建好都能滚到。
  // 必须依赖 ready：编辑器创建晚于本 effect 首跑（创建 effect 定义在前、
  // ready 翻 true 的同一 commit 先建编辑器再重跑这里），否则首开/切文件的行号丢失
  //（2026-10-11 复核实证）。
  useEffect(() => {
    if (!ready || !revealLine || revealLine <= 0) return;
    const ed = editorRef.current;
    if (!ed) return;
    ed.revealLineInCenter(revealLine);
    ed.setPosition({ lineNumber: revealLine, column: 1 });
  }, [revealLine, ready]);

  // 双击段落跳源码行的定位执行：nonce 去重防阅读⇄编辑往返时旧定位重放；
  // reveal 等一帧——刚从隐藏态显示时 automaticLayout 的 ResizeObserver 下一帧才
  // 补高度，立即 reveal 会按 0 高度算成顶部对齐
  useEffect(() => {
    if (!jumpReveal || !ready || mode !== "edit") return;
    if (jumpDoneNonceRef.current === jumpReveal.nonce) return;
    jumpDoneNonceRef.current = jumpReveal.nonce;
    const ed = editorRef.current;
    if (!ed) return;
    // 截断/外部变化兜底夹取：目标行不在缓冲里时夹到最后有效行
    const total = ed.getModel()?.getLineCount() ?? jumpReveal.line;
    const line = Math.max(1, Math.min(jumpReveal.line, total));
    ed.setPosition({ lineNumber: line, column: 1 });
    const raf = requestAnimationFrame(() => {
      ed.revealLineInCenter(line);
      ed.focus();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpReveal, ready, mode]);

  // 外部定位的编辑态分支（阅读态交给 MarkdownView）：找到这段文字选中并居中
  const focusDoneRef = useRef(0);
  useEffect(() => {
    if (!focusText || mode !== "edit" || !ready) return;
    if (focusDoneRef.current === focusText.nonce) return;
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model) return;
    focusDoneRef.current = focusText.nonce;
    const needle = focusText.text.replace(/\s+/g, " ").trim().slice(0, 40);
    const hit = needle
      ? model.findMatches(needle, false, false, false, null, false)[0]
      : undefined;
    if (!hit) return;
    ed.revealRangeInCenter(hit.range);
    ed.setSelection(hit.range);
  }, [focusText, mode, ready]);

  // md 编辑快捷键（2026-10-14 补齐；当晚全量审查改版）：行内标记 ⌘B/⌘I/⌘⇧X/⌘⇧C 与
  // 回车续列表全走编辑器 DOM 的 capture 监听（与 ⌘E 同模式）。不用 addCommand——它
  // 挂在全局单例 keybinding 服务上：无 when 子句会跨编辑器串扰（别的预览 Enter 被
  // 吞）、编辑器销毁也不清理（每切一次文件泄漏一批绑定）、还会压掉查找控件输入框
  // 里的原生 Enter。capture + 命中才 preventDefault：组词、多光标、非列表行回车
  // 一律回落 Monaco 原生行为（保留缩进/括号等），不抢不漏
  useEffect(() => {
    const ed = editorRef.current;
    const dom = ed?.getDomNode();
    if (!ed || !dom || !isMd) return;
    // IME 锁：WKWebView 确认候选的 Enter 在 compositionend 之后到达（isComposing
    // 已翻 false、keyCode 13），只看事件态拦不住——锁保持到 compositionend 后一帧
    let composingLock = false;
    let unlockRaf = 0;
    const onCompositionStart = () => {
      cancelAnimationFrame(unlockRaf);
      composingLock = true;
    };
    const onCompositionEnd = () => {
      unlockRaf = requestAnimationFrame(() => (composingLock = false));
    };
    const imeActive = (e: KeyboardEvent) =>
      imeBlocksEnter({
        isComposing: e.isComposing,
        keyCode: e.keyCode,
        composingLock,
      });
    const onKey = (e: KeyboardEvent) => {
      // 查找控件等内嵌输入框：焦点不在正文文本层，全不拦（Enter=下一个匹配等原生行为）
      if (!ed.hasTextFocus()) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const inlineMark =
        mod &&
        !e.altKey &&
        ((e.shiftKey && (key === "x" || key === "c")) ||
          (!e.shiftKey && (key === "b" || key === "i")));
      if (inlineMark) {
        if (imeActive(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const mark = e.shiftKey
          ? key === "x"
            ? "~~"
            : "`"
          : key === "b"
            ? "**"
            : "*";
        applyMdEdit((t, s, e) => toggleInlineMark(t, s, e, mark));
        return;
      }
      if (
        e.key === "Enter" &&
        !mod &&
        !e.shiftKey &&
        !e.altKey &&
        !imeActive(e) &&
        // 只在单光标且光标行确为列表项时才接管；其余回落原生 Enter
        ed.getSelections()?.length === 1 &&
        continueListItem(
          ed.getModel()?.getLineContent(ed.getPosition()?.lineNumber ?? 1) ?? "",
        ).kind !== "none"
      ) {
        e.preventDefault();
        e.stopPropagation();
        mdEnter();
      }
    };
    dom.addEventListener("keydown", onKey, true);
    dom.addEventListener("compositionstart", onCompositionStart, true);
    dom.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      cancelAnimationFrame(unlockRaf);
      dom.removeEventListener("keydown", onKey, true);
      dom.removeEventListener("compositionstart", onCompositionStart, true);
      dom.removeEventListener("compositionend", onCompositionEnd, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, isMd, path]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: truncated || readOnlyReason !== null });
  }, [ready, truncated, readOnlyReason]);

  // 编辑态粘贴图片（批次 B2）：剪贴板含 image/* 时接管粘贴——
  // 项目内 md 落 notes/assets/ 并在光标处插 ![](相对路径)；非项目文件回落临时图路径文本（终端粘贴同口径）
  useEffect(() => {
    const ed = editorRef.current;
    const dom = ed?.getDomNode();
    if (!ed || !dom || !isMd || truncated || readOnlyReason) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const item = Array.from(items).find((it) => it.type.startsWith("image/"));
      if (!item) return; // 纯文本粘贴走 Monaco 默认
      e.preventDefault();
      e.stopPropagation();
      const file = item.getAsFile();
      if (file) void pasteImageIntoMd(ed, file);
    };
    dom.addEventListener("paste", onPaste, true);
    return () => dom.removeEventListener("paste", onPaste, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, truncated, readOnlyReason, isMd, path, root]);

  // ⌘E 翻转阅读/编辑（modeTick 接线的宿主才拦）：焦点在编辑器里时 Monaco 会把
  // mod+E 消化成「用所选内容查找」并弹查找控件（StartFindWithSelectionAction 的
  // mac 默认绑定 CtrlCmd+KeyE），窗口级监听收不到——在编辑器 DOM 上 capture 拦截
  // （与上方粘贴图片同一模式）；stopPropagation 后 ReaderOverlay 的窗口监听不会
  // 二次翻转。无 modeTick 接线的宿主不承诺快捷键，保留 Monaco 原生行为
  useEffect(() => {
    const ed = editorRef.current;
    const dom = ed?.getDomNode();
    if (!ed || !dom || modeTick === undefined || !hasReadMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!eventMatchesCombo(e, READER_MODE_HOTKEY)) return;
      e.preventDefault();
      e.stopPropagation();
      switchMode(mode === "read" ? "edit" : "read");
    };
    dom.addEventListener("keydown", onKey, true);
    return () => dom.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, modeTick, hasReadMode, mode, path]);

  /** 粘贴图片落盘并在光标处插入（executeEdits 会触发 dirty，沿用既有保存链路） */
  async function pasteImageIntoMd(
    ed: monaco.editor.IStandaloneCodeEditor,
    file: File,
  ) {
    flashPasteNote("正在保存图片…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let insert: string;
      try {
        const cap = await invoke<{ relPath: string; absPath: string }>(
          "save_reader_capture",
          { projectRoot: root, imageBase64: bytesToBase64(bytes) },
        );
        insert = `![](${relMdLinkPath(path, cap.absPath)})`;
      } catch (reason) {
        // 不在已注册项目内：回落 <config>/ccode/tmp 临时图 + 路径文本；其它失败如实上报
        if (!String(reason).includes("不是 Mesa 项目")) throw reason;
        const p = await saveClipboardImage(bytes, imageExtFromMime(file.type));
        insert = escapeShellPath(p, IS_WINDOWS);
      }
      const sel = ed.getSelection();
      if (!sel) return;
      ed.executeEdits("paste-image", [{ range: sel, text: insert }]);
      ed.pushUndoStop();
      ed.focus();
      flashPasteNote("已插入图片");
    } catch (e) {
      flashPasteNote(`粘贴图片失败：${String(e)}`);
    }
  }

  // 主题切换跟随：data-theme 变化时按最新 CSS 变量重定义并应用（setTheme 全局生效，
  // 同时覆盖其他已挂载的编辑器实例；设置页色卡预览的瞬时翻转也只是多余一次重定义）
  useEffect(() => {
    const obs = new MutationObserver(() => {
      syncMonacoTheme();
      monaco.editor.setTheme("ccode-dark");
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  // 外部变化重载（合并/agent 写盘等）：整文替换但保留视图状态与 undo 栈。
  // 仅在非 dirty 时外部内容才会进来（上方监听 effect 的订阅条件），不会覆盖用户编辑
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || text === null || dirtyRef.current || savingRef.current) return;
    const model = ed.getModel();
    if (!model || model.getValue() === text) return;
    applyingExternalRef.current = true;
    ed.executeEdits("external-reload", [{ range: model.getFullModelRange(), text }]);
    applyingExternalRef.current = false;
  }, [text]);

  async function onSave() {
    const ed = editorRef.current;
    const baseline = lastSavedRef.current;
    if (!ed || !baseline?.revision || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (
        ctx?.kind === "main" &&
        !mainRepoIsHome &&
        !(await confirmDialog(
          "这是主仓库（非工作区分支）的文件，保存会直接改动主项目。确认保存？",
          { danger: true },
        ))
      ) return;
      if (editorRef.current !== ed || textPathRef.current !== path) return;
      const submitted = ed.getValue();
      setError(null);
      const revision = await invoke<string>("save_file_preview", {
        path, root, text: submitted, expectedRevision: baseline.revision,
      });
      if (editorRef.current !== ed || textPathRef.current !== path) return;
      const completion = previewSaveCompletion(submitted, ed.getValue(), revision);
      lastSavedRef.current = completion.snapshot;
      dirtyRef.current = completion.dirty;
      setDirty(completion.dirty);
      onDirtyChange?.(completion.dirty);
    } catch (e) {
      if (editorRef.current === ed) setError(String(e));
    } finally {
      if (editorRef.current === ed) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条：h-8 + 底部 hairline 与阅读区三栏的顶条规格统一（栏间严丝合缝） */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline bg-strip px-3 text-xs">
        {leading}
        <span className="truncate text-l3">{path.split(/[\\/]/).pop()}</span>
        {ctx?.kind === "worktree" && (
          <span
            className="flex shrink-0 items-center gap-1 text-l3"
            title={`该文件在工作区「${ctx.workspaceName}」的工作树里，改动属于分支 ${ctx.branch}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ok-text" />
            分支 {ctx.branch}
          </span>
        )}
        {ctx?.kind === "main" && !mainRepoIsHome && (
          <span
            className="flex shrink-0 items-center gap-1 text-warn-text"
            title={`该文件在主仓库（${ctx.branch}）里，改动不属于任何工作区分支——要改分支请从工作区进入`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warn-text" />
            主仓库（非分支）
          </span>
        )}
        {readOnlyReason && (
          <span className="shrink-0 rounded-sm bg-warn px-1 text-warn-text" title={readOnlyReason}>
            {truncated ? "已截断（只读）" : "只读"}
          </span>
        )}
        {dirty && <span className="shrink-0 text-l3" title="有未保存的修改">●</span>}
        {hasReadMode && (
          <div className="flex shrink-0 items-center rounded-sm bg-inset p-0.5 text-micro">
            {(["read", "edit"] as const).map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                // 快捷键只有外部接线（modeTick，阅读区 ⌘E）时才在 title 上承诺
                title={
                  modeTick !== undefined
                    ? `${m === "read" ? "阅读" : "编辑"}（${comboLabel(READER_MODE_HOTKEY)} 切换）`
                    : undefined
                }
                className={`rounded-sm px-2 py-0.5 ${
                  mode === m ? "bg-seg-sel text-l1" : "text-l3 hover:text-l2"
                }`}
              >
                {m === "read" ? "阅读" : "编辑"}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {ready && isMd && mode === "read" && onOpenReader && notePaired ? (
            <button
              onClick={onOpenReader}
              title="进沉浸阅读区（笔记｜PDF｜Agent 三栏，自动配对本篇 PDF）"
              className="shrink-0 rounded-sm px-2 py-0.5 text-l2 hover:bg-hover"
            >
              ⛶ 沉浸阅读
            </button>
          ) : (
            ready &&
            !hideImmersive &&
            (mode === "edit" || hasReadMode) && (
              <button
                onClick={() => setImmersive(true)}
                // 「沉浸阅读」专指笔记｜PDF｜Agent 三栏阅读区；这里只是把这份文件铺满窗口，叫「全屏」免得混
                title={`铺满整个窗口${mode === "read" ? "阅读" : "编辑"}这份文件（Esc 退出）`}
                className="shrink-0 rounded-sm px-2 py-0.5 text-l2 hover:bg-hover"
              >
                ⛶ {mode === "read" ? "全屏阅读" : "全屏编辑"}
              </button>
            )
          )}
          {!readOnlyReason && mode === "edit" && (
            <button
              onClick={onSave}
              disabled={!dirty || saving}
              title={
                ctx?.kind === "main" && !mainRepoIsHome
                  ? "直接修改主项目（不属于任何分支），保存前会再确认"
                  : undefined
              }
              className={`shrink-0 rounded-sm px-2 py-0.5 hover:bg-hover disabled:opacity-50 ${
                ctx?.kind === "main" && !mainRepoIsHome ? "text-warn-text" : "text-l2"
              }`}
            >
              {saving ? "保存中…" : ctx?.kind === "main" && !mainRepoIsHome ? "保存到主仓库" : "保存"}
            </button>
          )}
        </div>
      </div>
      {/* md 编辑格式行（2026-10-14 补齐）：按钮与快捷键同一套纯逻辑（md-edit）；
          行级按钮对选区覆盖的行整组切换；只读/截断态收起（executeEdits 会被拒，
          按了只抢焦点没反应） */}
      {isMd && mode === "edit" && ready && !truncated && !readOnlyReason && (
        <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-hairline bg-strip px-2 text-xs">
          <button
            type="button"
            title="加粗（⌘B / Ctrl+B）"
            onClick={() => applyMdEdit((t, s, e) => toggleInlineMark(t, s, e, "**"))}
            className="rounded-sm px-1.5 py-0.5 font-bold text-l3 hover:bg-hover hover:text-l1"
          >
            B
          </button>
          <button
            type="button"
            title="斜体（⌘I / Ctrl+I）"
            onClick={() => applyMdEdit((t, s, e) => toggleInlineMark(t, s, e, "*"))}
            className="rounded-sm px-1.5 py-0.5 italic text-l3 hover:bg-hover hover:text-l1"
          >
            I
          </button>
          <button
            type="button"
            title="删除线（⌘⇧X / Ctrl+Shift+X）"
            onClick={() => applyMdEdit((t, s, e) => toggleInlineMark(t, s, e, "~~"))}
            className="rounded-sm px-1.5 py-0.5 text-l3 line-through hover:bg-hover hover:text-l1"
          >
            S
          </button>
          <button
            type="button"
            title="行内代码（⌘⇧C / Ctrl+Shift+C）"
            onClick={() => applyMdEdit((t, s, e) => toggleInlineMark(t, s, e, "`"))}
            className="rounded-sm px-1.5 py-0.5 font-mono text-l3 hover:bg-hover hover:text-l1"
          >
            {"`"}
          </button>
          <span className="mx-1 h-4 w-px shrink-0 bg-hairline" />
          <button
            type="button"
            title="无序列表（回车自动续项）"
            onClick={() => applyMdEdit((t, s, e) => toggleLinePrefix(t, s, e, "- "))}
            className="rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
          >
            •
          </button>
          <button
            type="button"
            title="任务清单（回车自动续项，新项未勾选）"
            onClick={() => applyMdEdit((t, s, e) => toggleLinePrefix(t, s, e, "- [ ] "))}
            className="rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
          >
            ☑
          </button>
          <button
            type="button"
            title="引用"
            onClick={() => applyMdEdit((t, s, e) => toggleLinePrefix(t, s, e, "> "))}
            className="rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
          >
            ❝
          </button>
          <button
            type="button"
            title="链接（选中文字后点，可接着输入地址）"
            onClick={() => applyMdEdit(wrapAsLink)}
            className="rounded-sm px-1.5 py-0.5 font-mono text-l3 hover:bg-hover hover:text-l1"
          >
            {"<a>"}
          </button>
        </div>
      )}
      {error && (
        error.includes("二进制") ? (
          <PreviewErrorState
            error={error}
            kind="文件"
            path={path}
            onRetry={() => setReloadKey((n) => n + 1)}
          />
        ) : (
          <p className="px-3 py-1 text-xs text-err-text">{error}</p>
        )
      )}
      {pasteNote && <p className="px-3 py-1 text-xs text-l3">{pasteNote}</p>}
      {mode === "read" && ready && (
        isHtml ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <HtmlPreview html={text!} filePath={path} root={root} />
          </div>
        ) : (
          <MarkdownView
            text={text!}
            fileName={path.split(/[\\/]/).pop() ?? path}
            filePath={path}
            root={root}
            onDiscuss={onDiscuss}
            onAnnotate={onAnnotate}
            annotateCopy={annotateCopy}
            onOpenFile={onOpenFile}
            onJumpToSource={isMd && !truncated && !readOnlyReason ? jumpToSource : undefined}
            compact={compact}
            onPdfRef={isMd ? onPdfRef : undefined}
            focusText={focusText}
          />
        )
      )}
      {/* Monaco 宿主槽位（display:contents 不改变布局）：编辑器 DOM 节点由 effect 挂入，
          阅读态仅隐藏、沉浸编辑时移到覆盖层槽位——未保存改动/光标/undo 全程不丢，
          外部刷新与 dirty 语义沿用现有 watcher 链路不变 */}
      <div ref={normalSlotRef} className="contents" />
      {immersive && (
        <div className="fixed inset-0 z-30 flex min-h-0 flex-col bg-canvas">
          <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-strip px-3 py-2 text-xs">
            <span className="truncate text-sm text-l1">
              {path.split(/[\\/]/).pop()}
            </span>
            <span className="text-l4">
              全屏{mode === "read" ? "阅读" : "编辑"} · Esc 退出
            </span>
            {mode === "edit" && !readOnlyReason && (
              <button
                onClick={onSave}
                disabled={!dirty || saving}
                title={
                  ctx?.kind === "main"
                    ? "直接修改主项目（不属于任何分支），保存前会再确认"
                    : undefined
                }
                className={`ml-auto shrink-0 rounded-sm px-2 py-1 hover:bg-hover disabled:opacity-50 ${
                  ctx?.kind === "main" ? "text-warn-text" : "text-l2"
                }`}
              >
                {saving ? "保存中…" : ctx?.kind === "main" ? "保存到主仓库" : "保存"}
              </button>
            )}
            <button
              onClick={() => setImmersive(false)}
              title={`退出全屏${mode === "read" ? "阅读" : "编辑"}（Esc）`}
              className={`${mode === "edit" && !readOnlyReason ? "" : "ml-auto "}shrink-0 rounded-sm px-2 py-1 text-l3 hover:bg-hover hover:text-l1`}
            >
              ✕ 退出
            </button>
          </div>
          {mode === "read" ? (
            isHtml ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <HtmlPreview html={text ?? ""} filePath={path} root={root} />
              </div>
            ) : (
              <MarkdownView
                text={text ?? ""}
                large
                fileName={path.split(/[\\/]/).pop() ?? path}
                filePath={path}
                root={root}
                onDiscuss={onDiscuss}
                onAnnotate={onAnnotate}
                annotateCopy={annotateCopy}
                onOpenFile={onOpenFile}
                onJumpToSource={isMd && !truncated && !readOnlyReason ? jumpToSource : undefined}
              />
            )
          ) : (
            <div ref={immersiveSlotRef} className="contents" />
          )}
        </div>
      )}
    </div>
  );
}

function FilePreviewEditor(
  props: ComponentProps<typeof TextFilePreviewEditor>,
) {
  if (isPreviewableImagePath(props.path)) {
    return <ImagePreview path={props.path} cwdHint={props.root} />;
  }
  return <TextFilePreviewEditor {...props} />;
}

/** memo：父级重渲染不级联到 Monaco 编辑器 */
export default memo(FilePreviewEditor);
