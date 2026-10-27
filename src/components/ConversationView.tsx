import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  BookOpen,
  Brain,
  Check,
  Circle,
  CircleCheck,
  CircleDot,
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
  Quote,
  Search,
  SquareTerminal,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { BlockDto, ChatMessageDto } from "../types";
import { Collapse, FoldMark } from "./PageFrame";
import ChatMarkdown, { ChatCodeBlock, ChatImageCard } from "./ChatMarkdown";
import { splitImagePaths } from "../chat-image";
import { splitLaunchPrompt } from "../project-context";
import { splitFenced } from "../text-fences";
import { useAppStore } from "../store";
import {
  exploreLabel,
  formatSeconds,
  groupConversationSegments,
  problemText,
  segmentContainsIndex,
  turnPlan,
  turnSummary,
  turnToolEntries,
  type ConversationSegment,
  type PlanEntry,
  type ProcessItem,
  type ProcessTool,
} from "../conversation-tools";
import { resultStatusLabel, type ActivityKind, type DiffLine } from "../tool-activity";
import { IS_WINDOWS } from "../hotkeys";
import { estimateSegmentHeight, useVirtualWindow } from "../virtual-window";
import { makeChatQuote, type ChatQuote } from "../chat-navigation";

/** 纯文本块：保留换行，超长不带空格的串（长 URL、一串 aaaa）在气泡内折行，不撑出气泡（2026-10-19 用户截图） */
const WRAP_TEXT = "whitespace-pre-wrap [overflow-wrap:anywhere]";
/** 思考等纯文本块超过该长度先截断，点「展开全部」再看完整内容（AI 回复不截：一律按 Markdown 排版） */
const TEXT_CAP = 4000;
/** 用户长消息收起时只画开头这么多字（收起态只露十来行，再多也看不见，省得大段粘贴整块进 DOM） */
const USER_PREVIEW_CHARS = 2000;

/** 文本里的围栏代码块拆出来，用与 AI 回复同一套的代码块（头栏、复制、高亮）画；其余保持纯文本 */
function textWithFences(text: string, cwd?: string | null): ReactNode {
  const parts = splitFenced(text);
  if (parts.every((p) => !p.code)) return text;
  return parts.map((p, i) =>
    p.code ? (
      <ChatCodeBlock key={i} lang={p.lang} text={p.text} cwd={cwd} />
    ) : (
      // 代码块前后的换行只是围栏分隔，去掉避免多出空行
      <span key={i}>{p.text.replace(/^\n+|\n+$/g, "")}</span>
    ),
  );
}

/**
 * 用户消息正文：超过约 12 行收起、底部渐隐，「展开全部」看全文（2026-10-21：原先按 4000 字切原文、
 * 切口处直接断开）。是否超出在绘制前量（行高 × 13），短消息不挂渐隐
 */
function UserText({ text, cwd, forceOpen }: { text: string; cwd?: string | null; forceOpen: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(text.length > USER_PREVIEW_CHARS);
  const expanded = open || forceOpen;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
    setOverflow(text.length > USER_PREVIEW_CHARS || el.scrollHeight > lh * 13);
  }, [text]);
  const clamped = overflow && !expanded;
  return (
    <>
      <div ref={ref} className={`${WRAP_TEXT} ${clamped ? "ccode-chat-clamp" : ""}`}>
        {textWithFences(clamped ? text.slice(0, USER_PREVIEW_CHARS) : text, cwd)}
      </div>
      {overflow && !forceOpen && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-micro text-l3 hover:text-l1"
        >
          {open ? "收起" : "展开全部"}
        </button>
      )}
    </>
  );
}
/** 展开后的差异 / 输出最多画这么多行，再多写明还剩几行 */
const DETAIL_LINES = 200;

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
export function DiffView({ lines }: { lines: DiffLine[] }) {
  const shown = lines.slice(0, DETAIL_LINES);
  return (
    <div className="ccode-chat-code max-h-80 overflow-auto rounded-md border border-hairline bg-inset py-1 font-mono">
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
export function OutputView({ command, text, full = false, searchHit = false }: { command?: string | null; text?: string | null; full?: boolean; searchHit?: boolean }) {
  const body = text ?? "";
  const lines = body.split("\n");
  const cut = !full && lines.length > DETAIL_LINES ? lines.slice(0, DETAIL_LINES).join("\n") : body;
  return (
    <div className="ccode-chat-code max-h-80 overflow-auto rounded-md border border-hairline bg-inset px-2.5 py-2 font-mono">
      {command && <div className="whitespace-pre-wrap break-all text-l2">$ {command}</div>}
      {/* text 不传（审批卡只看命令）就不画结果那一栏 */}
      {text === undefined ? null : body.trim() ? (
        <div data-search-block={searchHit || undefined} className={`whitespace-pre-wrap break-all text-l3 ${command ? "mt-1.5" : ""}`}>{cut}</div>
      ) : (
        <div className={`text-l4 ${command ? "mt-1.5" : ""}`}>{text === null ? "还没有结果" : "没有输出"}</div>
      )}
      {!full && lines.length > DETAIL_LINES && (
        <div className="mt-1 text-l4">还有 {lines.length - DETAIL_LINES} 行没画出来</div>
      )}
    </div>
  );
}

/** 这一轮的计划（各家待办 / update_plan 收成一份；同一轮只画最新那份，ACP plan 语义） */
function PlanCard({ entries }: { entries: PlanEntry[] }) {
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <div className="my-2 rounded-md border border-hairline px-3 py-2 ccode-chat-meta">
      <div className="mb-1 flex items-center gap-1.5 text-micro text-l4">
        <ListTodo size={12} strokeWidth={1.8} aria-hidden="true" />
        计划 · {done}/{entries.length} 已完成
      </div>
      <ul className="space-y-0.5">
        {entries.map((e, i) => {
          const Icon = e.status === "completed" ? CircleCheck : e.status === "in_progress" ? CircleDot : Circle;
          return (
            <li key={i} className="flex items-start gap-2">
              <span className="ccode-icon-line">
                <Icon
                  size={13}
                  strokeWidth={1.8}
                  aria-hidden="true"
                  className={e.status === "in_progress" ? "text-l1" : "text-l4"}
                />
              </span>
              <span
                className={
                  e.status === "completed" ? "text-l4 line-through" : e.status === "in_progress" ? "text-l1" : "text-l2"
                }
              >
                {e.text}
              </span>
            </li>
          );
        })}
      </ul>
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
    .filter((k) => k.length > 0);
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
  cwd,
  focusIndex = -1,
  focusKeywords,
  focusRequest = 0,
  working,
  awaiting,
  onEditResend,
  onForkHere,
  onQuote,
  queuedNote,
}: {
  messages: ChatMessageDto[];
  /** 会话工作目录：AI 正文里相对图片/链接的解析基准（ChatMarkdown 用），也是过程行里文件写相对路径的基准 */
  cwd?: string | null;
  /** 搜索命中的消息下标；≥0 时高亮并滚进视野 */
  focusIndex?: number;
  /** 搜索关键词，用来在命中消息里标出那一句 */
  focusKeywords?: string[];
  focusRequest?: number;
  /** 最后一轮还在生成（聊天层传）：这一轮的过程铺开、不收起，正文不当回答切出去；还没回结果的那一行带光带 */
  working?: boolean;
  /** 正在等你决定（聊天层有审批 / 确认卡）：还没回结果的那一行写「等你决定」，不再带光带 */
  awaiting?: boolean;
  /** 用户消息「编辑后重发」：把这句放回输入框（聊天层传；回放页不传 = 不显示） */
  onEditResend?: (text: string) => void;
  /** 助手消息「从这里分叉」：带着到这条为止的对话开分叉标签（聊天层传；回放页不传 = 不显示） */
  onForkHere?: (text: string) => void;
  onQuote?: (quote: ChatQuote) => void;
  /** 排队气泡下那一行怎么写（聊天层按这家 CLI 的真实行为传，mid-turn-send.ts）；action 只挂在最后一条排着的气泡上 */
  queuedNote?: {
    text: string;
    title: string;
    action?: { label: string; title: string; onClick: () => void } | null;
  };
}) {
  const setDiffFocusReq = useAppStore((s) => s.setDiffFocusReq);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  /** 悬停在消息上出现的操作（docs/design-chat-layer.md §5）：复制；用户消息另有「编辑后重发」，
   *  助手消息另有「从这里分叉」。浮着不占高度（2026-10-25 用户：对话间距太松）：都挂在消息下面那段留白里
   *  （父元素 relative，下方留白 ≥ 这一行高，App.css .ccode-chat-user-row 一段）；用户消息的靠气泡右缘
   *  （同日用户：贴在气泡左边「怎么跑到左边去了」） */
  function messageActions(m: ChatMessageDto, mk: string, align: "left" | "right", sources: ChatMessageDto[] = [m]) {
    const text = m.blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    if (!text) return null;
    const btn =
      "inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-l3 hover:bg-hover hover:text-l1 focus-visible:outline-2 focus-visible:outline-cta";
    return (
      <div
        className={`absolute flex gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 ${
          align === "right" ? "right-0 top-full mt-0.5 justify-end" : "left-0 top-full mt-0.5"
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
            title="另开一段对话，带着到这条回复为止的内容接着聊（原对话不动）"
          >
            <GitFork size={12} strokeWidth={1.8} aria-hidden="true" />
            从这里分叉
          </button>
        )}
        {align === "left" && onQuote && (
          <button type="button" className={btn} title="引用选中文字，未选择时引用整条回复；不会自动发送"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              const selection = window.getSelection();
              const content = event.currentTarget.closest("[data-chat-message]")?.querySelector("[data-chat-answer]");
              const selected = selection && content?.contains(selection.anchorNode) && content.contains(selection.focusNode) ? selection.toString() : "";
              onQuote(makeChatQuote(sources, text, selected));
            }}><Quote size={13} aria-hidden="true" />引用追问</button>
        )}
      </div>
    );
  }
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detailTarget, setDetailTarget] = useState<{ key: string; seq: number } | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!detailTarget || !detailRef.current) return;
    detailRef.current.scrollIntoView({ block: "center" });
    detailRef.current.querySelector("button")?.focus({ preventScroll: true });
  }, [detailTarget]);
  const hitRef = useRef<HTMLDivElement | null>(null);
  const didFocusScroll = useRef("");
  const focusToken = JSON.stringify([focusIndex, focusKeywords, focusRequest]);
  // 高亮会临时包住 DOM 文本；内容刷新或换命中时重挂这一段，避免影响 React 的流式文本节点。
  const focusRenderKey = `${focusToken}:${JSON.stringify(messages[focusIndex]?.blocks)}`;
  const searchTerms = (focusKeywords ?? []).map((term) => term.toLocaleLowerCase()).filter(Boolean);
  const containsSearch = (text: string | null | undefined) => Boolean(text && searchTerms.some((term) => text.toLocaleLowerCase().includes(term)));

  useLayoutEffect(() => {
    if (focusIndex < 0) { didFocusScroll.current = ""; return; }
    const el = hitRef.current;
    if (!el) return;
    const marked = markFirstKeyword(el.querySelector("[data-search-block]") ?? el, focusKeywords ?? []);
    if (didFocusScroll.current !== focusToken) (marked ?? el).scrollIntoView({ block: "center" });
    didFocusScroll.current = focusToken;
  });

  /** 消息稳定键：角色+时间戳+块数+首段文本特征。前插分页/轮询刷新后数组下标会移位，
   *  展开状态（过程/工具行/长文本）必须跟随内容而非位置 */
  function msgKey(m: ChatMessageDto, mi: number): string {
    if (m.id) return `${m.role}:id:${m.id}`;
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
            <ChatCodeBlock key={i} lang={p.lang} text={p.text} cwd={cwd} />
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
        <div key={key} className={`my-1 whitespace-pre-wrap break-all text-l3 font-mono ccode-chat-code`}>
          {b.toolName ? `${b.toolName} ` : ""}
          {!forceOpen && b.text.length > 200 ? `${b.text.slice(0, 200)}…` : b.text}
        </div>
      );
    }
    // text（用户消息同样截断：超大粘贴不全量渲染）；
    // 整行是图片路径的行剥离成内嵌图片卡（粘贴/拖拽图片在会话里就是一行路径文本）。
    // 用户消息开头 Mesa 塞的项目说明（项目里「＋ 新对话」发第一句时附上）不当人话显示，折成一行（2026-10-24 用户）
    const { pack, said } = isUser ? splitLaunchPrompt(b.text) : { pack: null, said: b.text };
    const { text: bodyText, images } = splitImagePaths(said);
    const imageRow = images.map((p) => (
      <ChatImageCard key={p} path={p} cwd={cwd} />
    ));
    if (isUser) {
      const packKey = `${key}:pack`;
      const packOpen = forceOpen || expanded.has(packKey);
      return (
        <div key={key} className="my-1">
          {pack && (
            <div className={bodyText ? "mb-1 ccode-chat-meta text-l4" : "ccode-chat-meta text-l4"}>
              <button
                type="button"
                onClick={() => toggleExpand(packKey)}
                title="Mesa 开这段对话时附上的项目说明：Agent 看得到，不算你说的话"
                className="underline decoration-dotted underline-offset-2 hover:text-l2"
              >
                {packOpen ? "收起项目说明" : "已附项目说明"}
              </button>
              {packOpen && <div className="mt-1 whitespace-pre-wrap break-words text-l3">{pack}</div>}
            </div>
          )}
          {bodyText && <UserText text={bodyText} cwd={cwd} forceOpen={forceOpen} />}
          {imageRow}
        </div>
      );
    }
    // AI 正文一律走 Markdown 渲染（ChatMarkdown：原始 HTML 转义 + 本地图片内嵌）。原先超过 4000 字先截成
    // 纯文本原文，`**`、`#`、表格竖线全露出来，要点「展开全部」才排版（2026-10-21 去掉）
    return (
      <div key={key} className="my-1">
        {bodyText && <ChatMarkdown text={bodyText} cwd={cwd} />}
        {imageRow}
      </div>
    );
  }

  function renderBlocks(m: ChatMessageDto, mkey: string, isUser: boolean, forceOpen = false) {
    return m.blocks.map((b, bi) => renderBlock(b, `${mkey}:${bi}`, isUser, forceOpen));
  }

  // 过程行、计划、思考正文：聊天字号阶梯里的 0.94 档（App.css .ccode-chat-meta），随「聊天字号」设置走
  const rowText = "ccode-chat-meta";
  // 过程行里的命令 / 参数等宽字：0.86 档（原 text-xs 在 Mac 上只有 10.5px）
  const monoText = "font-mono ccode-chat-code";
  const iconSize = 15;

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
      failed?: boolean;
      forceOpen?: boolean;
      searchHit?: boolean;
      /** 还在跑（进行中的一轮里没回结果的调用） */
      pending?: boolean;
      detail?: () => ReactNode;
    },
  ) {
    const open = expanded.has(key) || Boolean(row.forceOpen);
    const Icon = row.icon;
    // 还没回结果的一行：聊天层在生成时动词和对象一起带一道光带（不再写「进行中…」）；等你决定时写明在等你；
    // 回放里悬着没结果的调用（多半是当时被打断）什么都不标
    const live = row.pending && !row.problem;
    const shimmer = live && working && !awaiting;
    const head = (
      <>
        <span className="shrink-0 text-l3">{row.verb}</span>
        {row.target && (
          <span className={`min-w-0 truncate ${row.plain ? "text-l2" : "text-l1"} ${row.mono ? monoText : ""}`}>
            {row.target}
          </span>
        )}
      </>
    );
    const line = (
      <>
        <Icon size={iconSize} strokeWidth={1.7} aria-hidden="true" className="shrink-0 text-l4" />
        {shimmer ? <span className="ccode-shimmer flex min-w-0 items-center gap-2">{head}</span> : head}
        {row.dir && <span className="min-w-0 shrink truncate text-l4">{row.dir}</span>}
        {row.note && (
          <span className={`min-w-0 shrink-[2] truncate text-l4 ${row.noteMono ? monoText : ""}`}>
            {row.note}
          </span>
        )}
        {(row.added ?? 0) > 0 && <span className="shrink-0 tabular-nums text-add">+{row.added}</span>}
        {(row.removed ?? 0) > 0 && <span className="shrink-0 tabular-nums text-del">−{row.removed}</span>}
        {row.problem && <span className={`shrink-0 ${row.failed ? "text-err-text" : "text-warn-text"}`}>{row.problem}</span>}
        {live && awaiting && <span className="shrink-0 text-l4">等你决定</span>}
      </>
    );
    const rowCls = `flex min-w-0 items-center gap-2 min-h-8 py-0.5 ${rowText}`;
    if (!row.detail) {
      return (
        <div key={key} className={rowCls}>
          {line}
        </div>
      );
    }
    return (
      <div key={key} ref={detailTarget?.key === key ? detailRef : undefined} data-search-block={row.searchHit || undefined}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggleExpand(key)}
          className={`${rowCls} -mx-1.5 w-[calc(100%+0.75rem)] rounded-md px-1.5 text-left hover:bg-hover`}
        >
          {line}
        </button>
        <Collapse key={detailTarget?.key.startsWith(key) ? detailTarget.seq : "toggle"} open={open} className="mb-2 mt-1 pl-6">
          {row.detail()}
        </Collapse>
      </div>
    );
  }

  function toolRow(key: string, t: ProcessTool, live = false, searching = false) {
    searching = searching && (t.index === focusIndex || t.resultIndex === focusIndex);
    const resultHit = searching && t.resultIndex === focusIndex && t.index !== focusIndex;
    const a = t.activity;
    const problem = resultStatusLabel(t.status);
    // 进行中这一轮里还没回结果的调用：正在跑（或等你批准）
    const pending = live && t.result === null && a.verb !== "工具结果";
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
            {(problem || searching) && t.result && (
              <div className="mt-1">
                <OutputView text={t.result} full={searching} searchHit={resultHit} />
              </div>
            )}
          </>
        );
      }
      if (a.kind === "run") return <>
        <OutputView command={a.command} text={t.result} full={searching} searchHit={resultHit} />
        <details open={searching && containsSearch(a.input)} className="mt-1 text-xs text-l3"><summary className="min-h-7 cursor-pointer">调用参数</summary><OutputView text={prettyInput(a.input)} full={searching} /></details>
        {t.status === "failed" && onEditResend && <button type="button" className="min-h-7 rounded-md px-1 text-xs text-l2 hover:bg-hover"
          onClick={() => onEditResend(`请检查这条失败命令的原因，确认影响后再决定是否重试：\n\n${a.command ?? a.target}\n\n失败输出：\n${(t.result ?? "").slice(0, 4000)}`)}>让它检查后重试</button>}
      </>;
      if (a.kind === "other" || a.kind === "mcp") {
        return (
          <>
            {a.input.trim() && a.input.trim() !== "{}" && (
              <div className="mb-1">
                <OutputView text={prettyInput(a.input)} full={searching} />
              </div>
            )}
            <OutputView text={t.result} full={searching} searchHit={resultHit} />
          </>
        );
      }
      return (
        <>
          {a.path && <div className="mb-1 truncate text-micro text-l4">{a.path}</div>}
          <OutputView command={a.command} text={t.result} full={searching} searchHit={resultHit} />
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
      failed: t.status === "failed",
      forceOpen: searching && (containsSearch(a.input) || containsSearch(t.result)),
      searchHit: searching && !resultHit,
      pending,
      detail: () => <>{detail()}{searching && a.kind !== "run" && a.kind !== "other" && a.kind !== "mcp" && containsSearch(a.input) && <details open><summary>调用参数</summary><OutputView text={prettyInput(a.input)} full /></details>}</>,
    });
  }

  function renderItem(item: ProcessItem, key: string, live = false, searching = false) {
    if (item.kind === "thinking") {
      return processRow(key, {
        icon: Brain,
        verb: "思考",
        note: item.seconds !== null ? formatSeconds(item.seconds) : null,
        forceOpen: searching && containsSearch(item.text),
        searchHit: searching && focusIndex >= item.index && focusIndex <= (item.endIndex ?? item.index),
        detail: () =>
          richText(
            `${key}:t`,
            item.text,
            `whitespace-pre-wrap border-l border-hairline pl-3 ${rowText} leading-relaxed text-l3`,
            searching,
          ),
      });
    }
    if (item.kind === "text") {
      // 过程里的中途说明：这一轮做完后降一级（.ccode-chat-aside），回答才是最醒目的字；还在写时它可能就是回答，不降
      return (
        <div key={key} data-search-block={searching && item.index === focusIndex || undefined} className={`my-2 ${live ? "" : "ccode-chat-aside"}`}>
          {renderBlock({ kind: "text", text: item.text, toolName: null }, key, false)}
        </div>
      );
    }
    if (item.kind === "tool") return toolRow(key, item.tool, live, searching);
    return processRow(key, {
      icon: Search,
      verb: "查阅",
      target: exploreLabel(item.tools),
      plain: true,
      problem: problemText(item.tools.map((t) => t.status), "处"),
      pending: live && item.tools.some((t) => t.result === null),
      forceOpen: searching && item.tools.some((t) => containsSearch(t.result) || containsSearch(t.activity.input)),
      detail: () => <div>{item.tools.map((t, i) => toolRow(`${key}:${i}`, t, live, searching))}</div>,
    });
  }

  function renderTurn(seg: Extract<ConversationSegment, { kind: "turn" }>) {
    const key = `turn:${msgKey(messages[seg.start], seg.start)}`;
    const hit = segmentContainsIndex(seg, focusIndex);
    const open = seg.live || hit || expanded.has(key);
    const summary = turnSummary(seg.items);
    const plan = turnPlan(seg.items);
    // 有计划卡就不再一行行列「更新待办」（同一份清单反复改，画最新那份就够）
    const items = plan ? seg.items.filter((it) => !(it.kind === "tool" && it.tool.activity.kind === "todo")) : seg.items;
    const records = turnToolEntries(items);
    const problems = records.filter(({ tool }) => tool.status !== "ok");
    const revealRecord = (record: (typeof records)[number]) => {
      const target = `${key}:${record.row}`;
      setExpanded((prev) => new Set([...prev, key, target, ...(record.parent ? [`${key}:${record.parent}`] : [])]));
      setDetailTarget((prev) => ({ key: target, seq: (prev?.seq ?? 0) + 1 }));
    };
    const answerKey = `${key}:answer`;
    // 只想了想、没动手的一轮：写「已思考」，展开直接是思考正文，不再套一行「思考」
    const thoughtOnly = seg.items.every((item) => item.kind === "thinking");
    const label = thoughtOnly
      ? seg.seconds !== null
        ? `已思考 ${formatSeconds(seg.seconds)}`
        : "思考过程"
      : seg.seconds !== null
        ? `已工作 ${formatSeconds(seg.seconds)}`
        : summary.text || "过程";
    // 没有时长时摘要本身就是这一行（「运行 3 条命令」），不再前缀「过程 ·」（2026-10-25 用户：字太多）
    const summaryTail = seg.seconds !== null || thoughtOnly ? summary.text : "";
    return (
      <div
        key={hit ? `${key}:${focusRenderKey}` : key}
        data-chat-message="1"
        ref={hit ? hitRef : undefined}
        data-search-hit={hit ? "1" : undefined}
        // 回答下面留 2rem：悬停操作浮在这段留白里（messageActions），也是到下一个问题的间距
        className={`group/msg relative max-w-full ${seg.live ? "mb-2" : "mb-8"} ${hit ? "rounded-md bg-seg-sel px-2 py-1" : ""}`}
      >
        {!seg.live && (
          <div className="flex flex-wrap items-center gap-x-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => toggleExpand(key)}
            className={`flex max-w-full items-center gap-1.5 min-h-8 ${rowText} text-l3 hover:text-l1`}
          >
            <span className="shrink-0">{label}</span>
            {summaryTail && <span className="min-w-0 truncate text-l4">· {summaryTail}</span>}
            <FoldMark open={open} />
          </button>
          {problems.length > 0 && (
            <button type="button" className={`min-h-8 rounded-md px-1 ${rowText} text-warn-text hover:bg-hover focus-visible:outline-2 focus-visible:outline-cta`}
              title="展开并定位第一处异常的原始输出" onClick={() => revealRecord(problems[0])}>
              {summary.problem}
            </button>
          )}
          </div>
        )}
        <Collapse key={detailTarget?.key.startsWith(`${key}:`) ? detailTarget.seq : "toggle"} open={open} className={seg.live ? "" : "mb-3 mt-1 border-t border-hairline pt-2"}>
          {plan && <PlanCard entries={plan} />}
          {thoughtOnly && !seg.live
            ? richText(
                `${key}:thought`,
                seg.items.map((item) => (item.kind === "thinking" ? item.text : "")).join("\n\n"),
                `whitespace-pre-wrap border-l border-hairline pl-3 ${rowText} leading-relaxed text-l3`,
                hit,
              )
            : items.map((item, i) => renderItem(item, `${key}:${i}`, seg.live, hit))}
        </Collapse>
        {seg.answer && (
          <>
            <div data-chat-answer="1" data-search-block={hit && messages[focusIndex]?.blocks.some((block) => seg.answer!.blocks.includes(block)) || undefined}>{renderBlocks(seg.answer, answerKey, false, hit)}</div>
            {messageActions(seg.answer, answerKey, "left", messages.slice(seg.start, seg.end + 1).filter((message) => message.blocks.some((block) => seg.answer!.blocks.includes(block))))}
          </>
        )}
      </div>
    );
  }

  let lastQueuedIndex = -1;
  messages.forEach((m, i) => {
    if (m.queued) lastQueuedIndex = i;
  });

  // 长对话只画视野附近的那一段（virtual-window.ts）；每段一个根元素、key 与这里一致，量高按 key 记
  const segments = useMemo(
    () => groupConversationSegments(messages, { live: working, cwd: cwd ?? null, isWindows: IS_WINDOWS }),
    [messages, working, cwd],
  );
  const segmentKeys = useMemo(
    () =>
      segments.map((seg) =>
        seg.kind === "turn" ? `turn:${msgKey(messages[seg.start], seg.start)}` : msgKey(seg.message, seg.index),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [segments],
  );
  const pinSegment =
    focusIndex < 0
      ? -1
      : segments.findIndex((seg) => (seg.kind === "turn" ? segmentContainsIndex(seg, focusIndex) : seg.index === focusIndex));
  const view = useVirtualWindow({
    keys: segmentKeys,
    estimate: (i) => estimateSegmentHeight(segments[i]),
    pin: pinSegment,
  });

  return (
    <>
      {view.enabled && <div ref={view.topRef} aria-hidden="true" data-vpad="top" style={{ height: view.topPad }} />}
      {segments.slice(view.start, view.end).map((seg) => {
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
              key={hit ? `${mk}:${focusRenderKey}` : mk}
              ref={hit ? hitRef : undefined}
              data-search-hit={hit ? "1" : undefined}
              className={`mb-3 flex items-start gap-2 ccode-chat-meta text-l4 ${
                hit ? "rounded-md bg-seg-sel px-2 py-1" : ""
              }`}
            >
              <span className="ccode-icon-line">
                <Terminal size={12} strokeWidth={1.8} aria-hidden="true" />
              </span>
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
            key={hit ? `${mk}:${focusRenderKey}` : mk}
            ref={hit ? hitRef : undefined}
            data-search-hit={hit ? "1" : undefined}
            // 每个新问题前留大空、连着发的几句不拉开（App.css .ccode-chat-user-row）；大圆角气泡（原 6px 像一张卡片）
            className={"group/msg mb-7 flex flex-col items-end ccode-chat-user-row"}
          >
            <div
              className={`relative max-w-[70%] bg-chat-bubble ccode-chat-user rounded-2xl px-3.5 py-2 ${
                hit ? "ring-1 ring-cta-bd" : ""
              }`}
            >
              {renderBlocks(m, mk, true, hit)}
              {!m.queued && messageActions(m, mk, "right")}
            </div>
            {m.queued && (
              // 上一轮还在生成时发的：已写进终端、由 CLI 处理（Mesa 不另设队列，所以没有撤回钮）。
              // 写法按这家 CLI 的真实行为（下一步就交 / 这一轮说完再交），能「立即发送」的给一个钮
              <span className="mt-0.5 flex items-center gap-1.5 text-micro text-l4">
                <span title={queuedNote?.title ?? "已经交给 AI，它这一轮说完就接着处理；要撤回请到终端里改掉排着的那条"}>
                  {queuedNote?.text ?? "排队中 · 这一轮结束后处理"}
                </span>
                {queuedNote?.action && mi === lastQueuedIndex && (
                  <button
                    type="button"
                    onClick={queuedNote.action.onClick}
                    title={queuedNote.action.title}
                    className="rounded-sm px-1 text-l3 underline decoration-dotted underline-offset-2 hover:bg-hover hover:text-l1"
                  >
                    {queuedNote.action.label}
                  </button>
                )}
              </span>
            )}
          </div>
        ) : (
          <div
            key={hit ? `${mk}:${focusRenderKey}` : mk}
            data-chat-message="1"
            ref={hit ? hitRef : undefined}
            data-search-hit={hit ? "1" : undefined}
            className={`group/msg relative mb-8 max-w-full ${hit ? "rounded-md bg-seg-sel px-2 py-1" : ""}`}
          >
            <div data-chat-answer="1">{renderBlocks(m, mk, false, hit)}</div>
            {messageActions(m, mk, "left")}
          </div>
        );
      })}
      {view.enabled && (
        <div ref={view.bottomRef} aria-hidden="true" data-vpad="bottom" style={{ height: view.bottomPad }} />
      )}
    </>
  );
}

function isCommandBlock(b: BlockDto): boolean {
  return b.kind === "command" || b.kind === "command_output";
}
