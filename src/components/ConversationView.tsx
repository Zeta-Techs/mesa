import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  BookOpen,
  Brain,
  Check,
  Copy,
  FileMinus2,
  FilePlus2,
  FileText,
  FolderOpen,
  GitFork,
  Globe,
  ListTodo,
  MessageCircleQuestion,
  PencilLine,
  Plug,
  Search,
  SquareTerminal,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { BlockDto, ChatMessageDto } from "../types";
import { FoldMark } from "./PageFrame";
import ChatMarkdown, { ChatImageCard } from "./ChatMarkdown";
import { splitImagePaths } from "../chat-image";
import { splitFenced } from "../text-fences";
import { useAppStore } from "../store";
import {
  exploreLabel,
  formatSeconds,
  groupConversationSegments,
  segmentContainsIndex,
  turnSummary,
  type ConversationSegment,
  type ProcessItem,
  type ProcessTool,
} from "../conversation-tools";
import { resultStatusLabel, type ActivityKind, type DiffLine } from "../tool-activity";

/** 纯文本块：保留换行，超长不带空格的串（长 URL、一串 aaaa）在气泡内折行，不撑出气泡（2026-10-19 用户截图） */
const WRAP_TEXT = "whitespace-pre-wrap [overflow-wrap:anywhere]";
/** 文本块超过该长度先截断，点「展开全部」再看完整内容 */
const TEXT_CAP = 4000;
/** 展开后的差异 / 输出最多画这么多行，再多写明还剩几行 */
const DETAIL_LINES = 200;

/** 代码块：inset 底 + hairline 细边，头部语言名 + hover/focus 显现的 ⧉ 复制 */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code my-1.5 overflow-hidden rounded-md border border-hairline bg-inset">
      <div className="flex h-6 items-center justify-between border-b border-hairline px-2.5">
        <span className="text-micro text-l4">{lang || "code"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              })
              .catch(() => {});
          }}
          className="text-micro text-l3 opacity-0 transition-opacity hover:text-l1 focus-visible:opacity-100 group-hover/code:opacity-100"
        >
          {copied ? "已复制" : "⧉ 复制"}
        </button>
      </div>
      <pre className="overflow-x-auto px-2.5 py-2 font-mono text-xs leading-relaxed text-l2">
        <code>{text.replace(/\n+$/, "")}</code>
      </pre>
    </div>
  );
}

const ACTIVITY_ICON: Record<ActivityKind, LucideIcon> = {
  edit: PencilLine,
  write: FilePlus2,
  delete: FileMinus2,
  read: FileText,
  search: Search,
  list: FolderOpen,
  run: SquareTerminal,
  web: Globe,
  task: Bot,
  todo: ListTodo,
  ask: MessageCircleQuestion,
  skill: BookOpen,
  mcp: Plug,
  other: Wrench,
};

/** 编辑 / 写入的差异：增删行只铺底、正文中性（design-system「diff 行」口径），未改动段折成 ⋯ */
function DiffView({ lines }: { lines: DiffLine[] }) {
  const shown = lines.slice(0, DETAIL_LINES);
  return (
    <div className="max-h-80 overflow-auto rounded-md border border-hairline bg-inset py-1 font-mono text-xs leading-5">
      {shown.map((l, i) =>
        l.op === "~" ? (
          <div key={i} className="px-2.5 text-l4">
            ⋯
          </div>
        ) : (
          <div
            key={i}
            className={`flex whitespace-pre-wrap break-all ${
              l.op === "+" ? "bg-diff-add-bg text-l2" : l.op === "-" ? "bg-diff-del-bg text-l2" : "text-l3"
            }`}
          >
            <span
              aria-hidden="true"
              className={`w-6 shrink-0 select-none text-center ${
                l.op === "+" ? "text-diff-add-fg" : l.op === "-" ? "text-diff-del-fg" : "text-l4"
              }`}
            >
              {l.op === " " ? "" : l.op === "+" ? "+" : "−"}
            </span>
            <span className="min-w-0 pr-2.5">{l.text || " "}</span>
          </div>
        ),
      )}
      {lines.length > shown.length && (
        <div className="px-2.5 pt-1 text-l4">还有 {lines.length - shown.length} 行没画出来</div>
      )}
    </div>
  );
}

/** 命令与输出 / 工具结果：等宽、可滚动，太长截断并写明 */
function OutputView({ command, text }: { command?: string | null; text: string | null }) {
  const body = text ?? "";
  const lines = body.split("\n");
  const cut = lines.length > DETAIL_LINES ? lines.slice(0, DETAIL_LINES).join("\n") : body;
  return (
    <div className="max-h-80 overflow-auto rounded-md border border-hairline bg-inset px-2.5 py-2 font-mono text-xs leading-5">
      {command && <div className="whitespace-pre-wrap break-all text-l2">$ {command}</div>}
      {body.trim() ? (
        <div className={`whitespace-pre-wrap break-all text-l3 ${command ? "mt-1.5" : ""}`}>{cut}</div>
      ) : (
        <div className={`text-l4 ${command ? "mt-1.5" : ""}`}>{text === null ? "还没有结果" : "没有输出"}</div>
      )}
      {lines.length > DETAIL_LINES && (
        <div className="mt-1 text-l4">还有 {lines.length - DETAIL_LINES} 行没画出来</div>
      )}
    </div>
  );
}

function prettyInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

/** 在命中消息里标出第一个关键词并返回该节点，供滚进视野。失败则返回 null。 */
function markFirstKeyword(root: Element, keywords: string[]): HTMLElement | null {
  const terms = keywords
    .map((k) => k.toLowerCase())
    .filter((k) => k.length >= 2);
  if (terms.length === 0) return null;
  const existing = root.querySelector("[data-search-mark='1']");
  if (existing instanceof HTMLElement) return existing;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    const lower = text.toLowerCase();
    const hit = terms.find((t) => lower.includes(t));
    if (!hit) continue;
    const idx = lower.indexOf(hit);
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, Math.min(text.length, idx + hit.length));
    const mark = document.createElement("mark");
    mark.dataset.searchMark = "1";
    mark.className = "rounded-sm bg-warn/40";
    try {
      range.surroundContents(mark);
      return mark;
    } catch {
      return node.parentElement;
    }
  }
  return null;
}

/**
 * 结构化对话渲染（用户右对齐气泡 / AI 直接排版 / 围栏代码块 / 长文本截断）。
 * 助手一轮里的过程（思考、工具调用、中途说明）收在「已工作 X 分 Y 秒」下面，展开是一行一行的动作
 * （「编辑 文件名 目录 +2 −2」「运行 命令」「查阅 · 读了 3 个文件」），点一行看差异 / 输出；最后的回答露在外面。
 * 会话页回放、项目对话预览与聊天层共用；滚动容器由调用方提供。
 */
export default function ConversationView({
  messages,
  compact,
  cwd,
  focusIndex = -1,
  focusKeywords,
  working,
  onEditResend,
  onForkHere,
}: {
  messages: ChatMessageDto[];
  compact?: boolean;
  /** 会话工作目录：AI 正文里相对图片/链接的解析基准（ChatMarkdown 用），也是过程行里文件写相对路径的基准 */
  cwd?: string | null;
  /** 搜索命中的消息下标；≥0 时高亮并滚进视野 */
  focusIndex?: number;
  /** 搜索关键词，用来在命中消息里标出那一句 */
  focusKeywords?: string[];
  /** 最后一轮还在生成（聊天层传）：这一轮的过程铺开、不收起，正文不当回答切出去 */
  working?: boolean;
  /** 用户消息「编辑后重发」：把这句放回输入框（聊天层传；回放页不传 = 不显示） */
  onEditResend?: (text: string) => void;
  /** 助手消息「从这里分叉」：带着到这条为止的对话开分叉标签（聊天层传；回放页不传 = 不显示） */
  onForkHere?: (text: string) => void;
}) {
  const setDiffFocusReq = useAppStore((s) => s.setDiffFocusReq);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  /** 悬停在消息上出现的操作（docs/design-chat-layer.md §5）：复制；用户消息另有「编辑后重发」，
   *  助手消息另有「从这里分叉」 */
  function messageActions(m: ChatMessageDto, mk: string, align: "left" | "right") {
    const text = m.blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    if (!text) return null;
    const btn =
      "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-micro text-l4 hover:bg-hover hover:text-l1";
    return (
      <div
        className={`mt-0.5 flex gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 ${
          align === "right" ? "justify-end" : ""
        }`}
      >
        <button
          type="button"
          className={btn}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopiedKey(mk);
              window.setTimeout(() => setCopiedKey((k) => (k === mk ? null : k)), 1200);
            });
          }}
        >
          {copiedKey === mk ? (
            <Check size={12} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Copy size={12} strokeWidth={1.8} aria-hidden="true" />
          )}
          {copiedKey === mk ? "已复制" : "复制"}
        </button>
        {align === "right" && onEditResend && (
          <button type="button" className={btn} onClick={() => onEditResend(text)} title="把这句放回输入框，改完再发">
            <PencilLine size={12} strokeWidth={1.8} aria-hidden="true" />
            编辑后重发
          </button>
        )}
        {align === "left" && onForkHere && (
          <button
            type="button"
            className={btn}
            onClick={() => onForkHere(text)}
            title="新开一个标签，带着到这条回复为止的对话接着聊（原对话不动）"
          >
            <GitFork size={12} strokeWidth={1.8} aria-hidden="true" />
            从这里分叉
          </button>
        )}
      </div>
    );
  }
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const hitRef = useRef<HTMLDivElement | null>(null);
  const didFocusScroll = useRef(false);

  useLayoutEffect(() => {
    if (focusIndex < 0 || didFocusScroll.current) return;
    const el = hitRef.current;
    if (!el) return;
    const marked = markFirstKeyword(el, focusKeywords ?? []);
    (marked ?? el).scrollIntoView({ block: "center" });
    didFocusScroll.current = true;
  }, [focusIndex, focusKeywords]);

  /** 消息稳定键：角色+时间戳+块数+首段文本特征。前插分页/轮询刷新后数组下标会移位，
   *  展开状态（过程/工具行/长文本）必须跟随内容而非位置 */
  function msgKey(m: ChatMessageDto, mi: number): string {
    const firstText = m.blocks.find((b) => b.kind === "text")?.text ?? "";
    return `${m.role}:${m.timestamp ?? `#${mi}`}:${m.blocks.length}:${firstText.length}:${firstText.slice(0, 24)}`;
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** 长文本截断渲染，key 用于记录展开状态；短文本/已展开走围栏代码拆分 */
  function richText(key: string, text: string, cls: string, forceOpen = false) {
    const isOpen = forceOpen || expanded.has(key);
    if (text.length > TEXT_CAP && !isOpen) {
      return (
        <div className={cls}>
          {`${text.slice(0, TEXT_CAP)}…`}
          <button
            onClick={() => toggleExpand(key)}
            className="ml-2 text-l3 hover:text-l1"
          >
            展开全部
          </button>
        </div>
      );
    }
    const parts = splitFenced(text);
    // 无代码围栏时保持纯文本渲染（绝大多数消息走这里）
    if (parts.every((p) => !p.code)) {
      return (
        <div className={cls}>
          {text}
          {text.length > TEXT_CAP && (
            <button
              onClick={() => toggleExpand(key)}
              className="ml-2 text-l3 hover:text-l1"
            >
              收起
            </button>
          )}
        </div>
      );
    }
    return (
      <div className={cls}>
        {parts.map((p, i) =>
          p.code ? (
            <CodeBlock key={i} lang={p.lang} text={p.text} />
          ) : (
            // 代码块前后的换行只是围栏分隔，去掉避免多出空行
            <span key={i}>{p.text.replace(/^\n+|\n+$/g, "")}</span>
          ),
        )}
        {text.length > TEXT_CAP && (
          <button
            onClick={() => toggleExpand(key)}
            className="ml-2 text-l3 hover:text-l1"
          >
            收起
          </button>
        )}
      </div>
    );
  }

  /** 正文块（用户 / 助手）。过程块都在「轮」里画；这里只兜底极少数夹在用户消息里的（如中断时的半截结果） */
  function renderBlock(b: BlockDto, key: string, isUser: boolean, forceOpen = false) {
    if (b.kind === "thinking" || b.kind === "tool_use" || b.kind === "tool_result") {
      return (
        <div key={key} className="my-1 whitespace-pre-wrap break-all font-mono text-xs text-l3">
          {b.toolName ? `${b.toolName} ` : ""}
          {b.text.length > 200 ? `${b.text.slice(0, 200)}…` : b.text}
        </div>
      );
    }
    // text（用户消息同样截断：超大粘贴不全量渲染）；
    // 整行是图片路径的行剥离成内嵌图片卡（粘贴/拖拽图片在会话里就是一行路径文本）
    const { text: bodyText, images } = splitImagePaths(b.text);
    const imageRow = images.map((p) => (
      <ChatImageCard key={p} path={p} cwd={cwd} />
    ));
    if (isUser) {
      return (
        <div key={key} className="my-1">
          {bodyText && richText(key, bodyText, WRAP_TEXT, forceOpen)}
          {imageRow}
        </div>
      );
    }
    // AI 正文走 Markdown 渲染（ChatMarkdown：原始 HTML 转义 + 本地图片内嵌）；
    // 超长未展开保持截断纯文本 + 展开按钮，展开后整段 Markdown
    if (bodyText.length > TEXT_CAP && !forceOpen && !expanded.has(key)) {
      return (
        <div key={key} className="my-1">
          {richText(key, bodyText, `${WRAP_TEXT} ${compact ? "text-xs" : "text-sm"}`)}
          {imageRow}
        </div>
      );
    }
    return (
      <div key={key} className="my-1">
        {bodyText && <ChatMarkdown text={bodyText} cwd={cwd} />}
        {imageRow}
        {bodyText.length > TEXT_CAP && (
          <button
            onClick={() => toggleExpand(key)}
            className="text-xs text-l3 hover:text-l1"
          >
            收起
          </button>
        )}
      </div>
    );
  }

  function renderBlocks(m: ChatMessageDto, mkey: string, isUser: boolean, forceOpen = false) {
    return m.blocks.map((b, bi) => renderBlock(b, `${mkey}:${bi}`, isUser, forceOpen));
  }

  const rowText = compact ? "text-xs" : "text-sm";
  const iconSize = compact ? 13 : 15;

  /** 过程里的一行：图标 + 动词 + 对象 + 目录 / 补充 + 增删行数；有细节的整行可点开 */
  function processRow(
    key: string,
    row: {
      icon: LucideIcon;
      verb: string;
      target?: string;
      mono?: boolean;
      /** 对象是一句说明（「读了 3 个文件」）而不是文件 / 命令：降一级字色 */
      plain?: boolean;
      dir?: string | null;
      note?: string | null;
      noteMono?: boolean;
      added?: number | null;
      removed?: number | null;
      problem?: string | null;
      detail?: () => ReactNode;
    },
  ) {
    const open = expanded.has(key);
    const Icon = row.icon;
    const line = (
      <>
        <Icon size={iconSize} strokeWidth={1.7} aria-hidden="true" className="shrink-0 text-l4" />
        <span className="shrink-0 text-l3">{row.verb}</span>
        {row.target && (
          <span className={`min-w-0 truncate ${row.plain ? "text-l2" : "text-l1"} ${row.mono ? "font-mono text-xs" : ""}`}>
            {row.target}
          </span>
        )}
        {row.dir && <span className="min-w-0 shrink truncate text-l4">{row.dir}</span>}
        {row.note && (
          <span className={`min-w-0 shrink-[2] truncate text-l4 ${row.noteMono ? "font-mono text-xs" : ""}`}>
            {row.note}
          </span>
        )}
        {(row.added ?? 0) > 0 && <span className="shrink-0 tabular-nums text-add">+{row.added}</span>}
        {(row.removed ?? 0) > 0 && <span className="shrink-0 tabular-nums text-del">−{row.removed}</span>}
        {row.problem && <span className="shrink-0 text-err-text">{row.problem}</span>}
      </>
    );
    const rowCls = `flex min-w-0 items-center gap-2 ${compact ? "min-h-6" : "min-h-8"} py-0.5 ${rowText}`;
    if (!row.detail) {
      return (
        <div key={key} className={rowCls}>
          {line}
        </div>
      );
    }
    return (
      <div key={key}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggleExpand(key)}
          className={`${rowCls} -mx-1.5 w-[calc(100%+0.75rem)] rounded-md px-1.5 text-left hover:bg-hover`}
        >
          {line}
        </button>
        {open && <div className={`mb-2 mt-1 ${compact ? "pl-5" : "pl-6"}`}>{row.detail()}</div>}
      </div>
    );
  }

  function toolRow(key: string, t: ProcessTool) {
    const a = t.activity;
    const problem = resultStatusLabel(t.status);
    const inCwd = Boolean(cwd && a.path && a.dir !== null && !/^[~/]|^[A-Za-z]:/.test(a.dir));
    const detail = () => {
      if (a.diff && a.diff.length) {
        return (
          <>
            <DiffView lines={a.diff} />
            {(a.path || (problem && t.result)) && (
              <div className="mt-1 flex items-center gap-2 text-micro text-l4">
                {a.path && <span className="min-w-0 truncate">{a.path}</span>}
                {inCwd && cwd && (
                  <button
                    type="button"
                    className="shrink-0 rounded-sm px-1 text-l3 hover:bg-hover hover:text-l1"
                    onClick={() => setDiffFocusReq({ cwd, path: `${a.dir ?? ""}${a.target}` })}
                  >
                    在改动里查看
                  </button>
                )}
              </div>
            )}
            {problem && t.result && (
              <div className="mt-1">
                <OutputView text={t.result} />
              </div>
            )}
          </>
        );
      }
      if (a.kind === "run") return <OutputView command={a.command} text={t.result} />;
      if (a.kind === "other" || a.kind === "mcp") {
        return (
          <>
            {a.input.trim() && a.input.trim() !== "{}" && (
              <div className="mb-1">
                <OutputView text={prettyInput(a.input)} />
              </div>
            )}
            <OutputView text={t.result} />
          </>
        );
      }
      return (
        <>
          {a.path && <div className="mb-1 truncate text-micro text-l4">{a.path}</div>}
          <OutputView text={t.result} />
        </>
      );
    };
    return processRow(key, {
      icon: ACTIVITY_ICON[a.kind],
      verb: a.verb,
      target: a.target,
      mono: a.kind === "run" && !a.note,
      dir: a.dir,
      note: a.note,
      noteMono: a.kind === "run",
      added: a.added,
      removed: a.removed,
      problem,
      detail,
    });
  }

  function renderItem(item: ProcessItem, key: string) {
    if (item.kind === "thinking") {
      return processRow(key, {
        icon: Brain,
        verb: "思考",
        note: item.seconds !== null ? formatSeconds(item.seconds) : null,
        detail: () =>
          richText(
            `${key}:t`,
            item.text,
            `whitespace-pre-wrap border-l border-hairline pl-3 ${rowText} leading-relaxed text-l3`,
          ),
      });
    }
    if (item.kind === "text") {
      return (
        <div key={key} className="my-2">
          {renderBlock({ kind: "text", text: item.text, toolName: null }, key, false)}
        </div>
      );
    }
    if (item.kind === "tool") return toolRow(key, item.tool);
    const problems = item.tools.filter((t) => t.status !== "ok").length;
    return processRow(key, {
      icon: Search,
      verb: "查阅",
      target: exploreLabel(item.tools),
      plain: true,
      problem: problems ? `${problems} 处没成功` : null,
      detail: () => <div>{item.tools.map((t, i) => toolRow(`${key}:${i}`, t))}</div>,
    });
  }

  function renderTurn(seg: Extract<ConversationSegment, { kind: "turn" }>) {
    const key = `turn:${msgKey(messages[seg.start], seg.start)}`;
    const hit = segmentContainsIndex(seg, focusIndex);
    const open = seg.live || hit || expanded.has(key);
    const summary = turnSummary(seg.items);
    const answerKey = `${key}:answer`;
    // 只想了想、没动手的一轮：写「已思考」，展开直接是思考正文，不再套一行「思考」
    const thoughtOnly = seg.items.every((item) => item.kind === "thinking");
    const label = thoughtOnly
      ? seg.seconds !== null
        ? `已思考 ${formatSeconds(seg.seconds)}`
        : "思考过程"
      : seg.seconds !== null
        ? `已工作 ${formatSeconds(seg.seconds)}`
        : "过程";
    return (
      <div
        key={key}
        ref={hit ? hitRef : undefined}
        data-search-hit={hit ? "1" : undefined}
        className={`group/msg mb-3 max-w-full ${hit ? "rounded-md bg-seg-sel px-2 py-1" : ""}`}
      >
        {!seg.live && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => toggleExpand(key)}
            className={`flex max-w-full items-center gap-1.5 ${compact ? "min-h-6" : "min-h-8"} ${rowText} text-l3 hover:text-l1`}
          >
            <span className="shrink-0">{label}</span>
            {summary.text && <span className="min-w-0 truncate text-l4">· {summary.text}</span>}
            {summary.problems > 0 && (
              <span className="shrink-0 text-warn-text">· {summary.problems} 步没成功</span>
            )}
            <FoldMark open={open} />
          </button>
        )}
        {open && (
          <div className={seg.live ? "" : "mb-3 mt-1 border-t border-hairline pt-2"}>
            {thoughtOnly && !seg.live
              ? richText(
                  `${key}:thought`,
                  seg.items.map((item) => (item.kind === "thinking" ? item.text : "")).join("\n\n"),
                  `whitespace-pre-wrap border-l border-hairline pl-3 ${rowText} leading-relaxed text-l3`,
                )
              : seg.items.map((item, i) => renderItem(item, `${key}:${i}`))}
          </div>
        )}
        {seg.answer && (
          <>
            {renderBlocks(seg.answer, answerKey, false, hit)}
            {!compact && messageActions(seg.answer, answerKey, "left")}
          </>
        )}
      </div>
    );
  }

  return (
    <>
      {groupConversationSegments(messages, { live: working, cwd: cwd ?? null }).map((seg) => {
        if (seg.kind === "turn") return renderTurn(seg);
        const m = seg.message;
        const mi = seg.index;
        const mk = msgKey(m, mi);
        const hit = mi === focusIndex;
        // 斜杠命令 / ! 命令及其本地输出（sessions.rs claude_command_block）：一行「命令 → 结果」，
        // 不当用户气泡——那是操作记录，不是对 AI 说的话
        if (m.blocks.length > 0 && m.blocks.every(isCommandBlock)) {
          return (
            <div
              key={mk}
              ref={hit ? hitRef : undefined}
              data-search-hit={hit ? "1" : undefined}
              className={`mb-3 flex items-start gap-2 text-xs text-l4 ${
                hit ? "rounded-md bg-seg-sel px-2 py-1" : ""
              }`}
            >
              <Terminal size={12} strokeWidth={1.8} aria-hidden="true" className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                {m.blocks.map((b, bi) =>
                  b.kind === "command" ? (
                    <code key={bi} className="block break-all font-mono text-l3">
                      {b.text}
                    </code>
                  ) : (
                    <div key={bi} className="mt-0.5 whitespace-pre-wrap break-words">
                      {b.text}
                    </div>
                  ),
                )}
              </div>
            </div>
          );
        }
        return m.role === "user" ? (
          // 用户消息：右对齐圆角气泡（bubble 令牌底，max-w 70%）
          <div
            key={mk}
            ref={hit ? hitRef : undefined}
            data-search-hit={hit ? "1" : undefined}
            className="group/msg mb-3 flex flex-col items-end"
          >
            <div
              className={`max-w-[70%] rounded-md bg-bubble/75 px-3 py-2 ${compact ? "text-xs" : "text-sm"} ${
                hit ? "ring-1 ring-cta-bd" : ""
              }`}
            >
              {renderBlocks(m, mk, true, hit)}
            </div>
            {m.queued && (
              // 上一轮还在生成时发的：已写进终端、由 CLI 排队（Mesa 不另设队列，所以没有撤回钮）
              <span
                className="mt-0.5 text-micro text-l4"
                title="已经交给 AI，它这一轮说完就接着处理；要撤回请到终端里删掉排队的那条"
              >
                排队中 · 这一轮结束后处理
              </span>
            )}
            {!compact && !m.queued && messageActions(m, mk, "right")}
          </div>
        ) : (
          <div
            key={mk}
            ref={hit ? hitRef : undefined}
            data-search-hit={hit ? "1" : undefined}
            className={`group/msg mb-3 max-w-full ${hit ? "rounded-md bg-seg-sel px-2 py-1" : ""}`}
          >
            {renderBlocks(m, mk, false, hit)}
            {!compact && messageActions(m, mk, "left")}
          </div>
        );
      })}
    </>
  );
}

function isCommandBlock(b: BlockDto): boolean {
  return b.kind === "command" || b.kind === "command_output";
}
