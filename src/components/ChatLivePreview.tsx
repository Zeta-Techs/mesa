import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { highlightCodeBlocks } from "../code-highlight";
import { completeStreamingMarkdown, splitStreamingMarkdownBlocks } from "../live-markdown";
import { sliceStyledLines, type LiveStyledLine, type LiveStyledSpan } from "../live-reply";
import { decorateMdCodeBlocks, decorateMdTables, handleMdCodeCopyClick } from "../md-code-chrome";
import { renderMathInto } from "../md-math";
import { renderChatMarkdownHtml } from "../chat-markdown-html";
import { MesaCaret } from "./MesaMark";

/**
 * 找到渲染后 HTML 里最后一个适合挂行内光标的叶子块节点（如 p / li / h1-h6 / code / td / blockquote），
 * 跳过代码块头栏（.md-code-head）与空元素（br / hr / img / svg / button）。
 */
function lastCaretHost(root: HTMLElement): HTMLElement {
  let cur: HTMLElement = root;
  const SKIP_TAGS = new Set(["BR", "HR", "IMG", "SVG", "BUTTON", "INPUT", "THEAD"]);
  const WALK_TAGS = new Set([
    "DIV",
    "UL",
    "OL",
    "LI",
    "BLOCKQUOTE",
    "TABLE",
    "TBODY",
    "TR",
    "PRE",
    "P",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "TD",
    "TH",
    "CODE",
  ]);
  for (let depth = 0; depth < 12; depth++) {
    let picked: HTMLElement | null = null;
    for (let i = cur.children.length - 1; i >= 0; i--) {
      const child = cur.children[i] as HTMLElement;
      if (child.classList.contains("md-code-head") || child.classList.contains("ccode-live-caret")) continue;
      if (SKIP_TAGS.has(child.tagName)) continue;
      if (WALK_TAGS.has(child.tagName)) {
        picked = child;
        break;
      }
    }
    if (!picked) break;
    cur = picked;
  }
  return cur;
}

const FrozenMdBlock = memo(function FrozenMdBlock({ block }: { block: string }) {
  const html = useMemo(() => renderChatMarkdownHtml(block), [block]);
  const inner = useMemo(() => ({ __html: html }), [html]);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    decorateMdCodeBlocks(host);
    decorateMdTables(host);
    void highlightCodeBlocks(host);
    void renderMathInto(host);
  }, [html]);

  return (
    <div
      ref={ref}
      className="ccode-live-md-block"
      onClick={(e) => {
        handleMdCodeCopyClick(e.target);
      }}
      dangerouslySetInnerHTML={inner}
    />
  );
});

function ActiveMdBlock({
  block,
  showCaret,
  light,
}: {
  block: string;
  showCaret: boolean;
  light: boolean;
}) {
  const completed = useMemo(() => completeStreamingMarkdown(block), [block]);
  const html = useMemo(() => (completed ? renderChatMarkdownHtml(completed) : ""), [completed]);
  const inner = useMemo(() => ({ __html: html }), [html]);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.querySelectorAll(".ccode-live-caret").forEach((el) => el.remove());
    if (html) {
      decorateMdCodeBlocks(host);
      decorateMdTables(host);
      void renderMathInto(host);
    }
    if (showCaret && html) {
      const target = lastCaretHost(host);
      const caret = document.createElement("span");
      caret.setAttribute("aria-hidden", "true");
      caret.className = "ccode-caret-blink ccode-live-caret";
      if (light) caret.dataset.light = "";
      target.appendChild(caret);
    }
  }, [html, showCaret, light]);

  if (!html) {
    return showCaret ? (
      <div className="ccode-live-md-block">
        <MesaCaret light={light} />
      </div>
    ) : null;
  }

  return (
    <div
      ref={ref}
      className="ccode-live-md-block"
      onClick={(e) => {
        handleMdCodeCopyClick(e.target);
      }}
      dangerouslySetInnerHTML={inner}
    />
  );
}

/**
 * 结构化旁路（Codex / Qwen / OpenCode）流式 Markdown 实时渲染：
 * - 已写完的顶层块由 FrozenMdBlock memo 冻结，不随后续增量重复解析 / 闪高亮；
 * - 末尾一块经 completeStreamingMarkdown 补全未闭合语法，渲染样式与落盘后的 ChatMarkdown 一致，
 *   并在最后一个行内文本块末尾挂上 MesaCaret。
 */
export function StreamingMarkdown({
  text,
  showCaret,
  light,
}: {
  text: string;
  showCaret: boolean;
  light: boolean;
}) {
  const blocks = useMemo(() => splitStreamingMarkdownBlocks(text), [text]);
  if (blocks.length === 0) {
    return showCaret ? (
      <div className="md-body md-chat ccode-live-md mb-2">
        <MesaCaret light={light} />
      </div>
    ) : null;
  }
  const completed = blocks.slice(0, -1);
  const tail = blocks[blocks.length - 1];
  return (
    <div className="md-body md-chat ccode-live-md mb-2">
      {completed.map((b, i) => (
        <FrozenMdBlock key={i} block={b} />
      ))}
      <ActiveMdBlock block={tail} showCaret={showCaret} light={light} />
    </div>
  );
}

function renderSpan(span: LiveStyledSpan, key: number): ReactNode {
  let node: ReactNode = span.text;
  if (span.code) {
    node = <code>{node}</code>;
  }
  if (span.strike) {
    node = <del>{node}</del>;
  }
  if (span.italic) {
    node = <em>{node}</em>;
  }
  if (span.bold) {
    node = <strong>{node}</strong>;
  }
  const cls: string[] = [];
  if (span.underline) cls.push("ccode-live-underline");
  if (span.dim) cls.push("text-l3");
  if (span.accent) cls.push("ccode-live-accent");
  if (cls.length > 0) {
    return (
      <span key={key} className={cls.join(" ")}>
        {node}
      </span>
    );
  }
  return <span key={key}>{node}</span>;
}

type ScreenBlock =
  | { kind: "table"; lines: LiveStyledLine[] }
  | { kind: "code"; lines: LiveStyledLine[] }
  | { kind: "heading"; line: LiveStyledLine }
  | { kind: "line"; line: LiveStyledLine }
  | { kind: "gap" };

function groupScreenBlocks(lines: readonly LiveStyledLine[]): ScreenBlock[] {
  const blocks: ScreenBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.table) {
      const group: LiveStyledLine[] = [];
      while (i < lines.length && lines[i].table) {
        group.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "table", lines: group });
      continue;
    }
    if (line.codeBlock) {
      const group: LiveStyledLine[] = [];
      while (i < lines.length && lines[i].codeBlock) {
        group.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "code", lines: group });
      continue;
    }
    if (!line.text.trim()) {
      blocks.push({ kind: "gap" });
      i++;
      continue;
    }
    if (line.heading) {
      blocks.push({ kind: "heading", line });
      i++;
      continue;
    }
    blocks.push({ kind: "line", line });
    i++;
  }
  return blocks;
}

/**
 * 读屏来源（Claude Code / Kimi / Gemini / Grok / Antigravity CLI）的富文本流式预览：
 * 从 xterm 单元格还原粗体、斜体、删除线、下划线、标题、行内代码、代码块与等宽对齐的终端框线表格，
 * 复用 .md-chat 字体色阶，落盘切换成 ChatMarkdown 时不再从灰纯文本骤跳。
 */
export function LiveScreenPreview({
  styledLines,
  text,
  maxChars,
  showCaret,
  light,
}: {
  styledLines: readonly LiveStyledLine[] | null;
  text: string;
  maxChars: number;
  showCaret: boolean;
  light: boolean;
}) {
  const visible = useMemo(
    () => (styledLines && styledLines.length > 0 ? sliceStyledLines(styledLines, maxChars) : null),
    [styledLines, maxChars],
  );

  if (!visible || visible.length === 0) {
    return (
      <div className="ccode-chat-body mb-2 whitespace-pre-wrap break-words text-[var(--color-chat-text)]">
        {text}
        {showCaret && <MesaCaret light={light} />}
      </div>
    );
  }

  const blocks = groupScreenBlocks(visible);
  // 最后一个非空块的位置，用来把 MesaCaret 紧跟在最后一个字后面
  let lastContentIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind !== "gap") {
      lastContentIdx = i;
      break;
    }
  }

  return (
    <div className="md-body md-chat ccode-chat-body ccode-live-screen mb-2">
      {blocks.map((b, bi) => {
        const isLast = bi === lastContentIdx;
        if (b.kind === "gap") {
          return <div key={bi} className="ccode-live-gap" aria-hidden="true" />;
        }
        if (b.kind === "table") {
          return (
            <pre key={bi} className="ccode-live-table">
              {b.lines.map((line, li) => (
                <span key={li} className="block">
                  {line.spans.map((sp, si) => renderSpan(sp, si))}
                  {isLast && li === b.lines.length - 1 && showCaret && <MesaCaret light={light} />}
                </span>
              ))}
            </pre>
          );
        }
        if (b.kind === "code") {
          return (
            <pre key={bi} className="ccode-live-codeblock">
              <code>
                {b.lines.map((line, li) => (
                  <span key={li} className="block">
                    {line.spans.map((sp, si) => renderSpan(sp, si))}
                    {isLast && li === b.lines.length - 1 && showCaret && <MesaCaret light={light} />}
                  </span>
                ))}
              </code>
            </pre>
          );
        }
        if (b.kind === "heading") {
          return (
            <div key={bi} className="ccode-live-heading">
              {b.line.spans.map((sp, si) => renderSpan(sp, si))}
              {isLast && showCaret && <MesaCaret light={light} />}
            </div>
          );
        }
        return (
          <div key={bi} className="ccode-live-line whitespace-pre-wrap break-words">
            {b.line.spans.map((sp, si) => renderSpan(sp, si))}
            {isLast && showCaret && <MesaCaret light={light} />}
          </div>
        );
      })}
      {lastContentIdx < 0 && showCaret && <MesaCaret light={light} />}
    </div>
  );
}
