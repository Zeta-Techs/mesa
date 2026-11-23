/** 综述回路补料界面（docs/design-review-loop.md §4）：
 *  - ReworkDialog：补料单表单。只收字段，发出（恢复 / 并入 / 写单 / 开对话）由 TaskCardsSection 编排。
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Modal } from "./Modal";
import { compactFieldClass, fieldClass, InlineNotice, primaryActionClass, secondaryActionClass } from "./PageFrame";
import {
  litOrder,
  parseTopics,
  type OutlineChapterChoice,
  type PendingFulltextChoice,
} from "../step-loop";

export interface ReworkFields {
  target: string;
  topics: string[];
  reason: string;
  clues: string;
  scale: number | null;
  /** 补完、保存进项目后接着自动跟进的下游步骤（补料链，2026-11-06 流程贯通 §6） */
  chain: string[];
  /** 补文献单上「精读已有的」那几条，随退回检索的单子交给链上的精读（按大纲的节转回路①）；其余情况为空 */
  reads: string[];
}
/** 下拉里「补文献」这一项的值：检索、精读两步并成一项，按两栏分派（按大纲的节转回路①） */
const LIT = "\u0000lit";

export function ReworkDialog({
  fromStep,
  targets,
  prefill = {},
  unplaced = [],
  searchTarget,
  notesTarget,
  initial,
  fromInProgress = false,
  fromPending = false,
  chainOptions = {},
  chainOff = [],
  outlineSections = [],
  pendingPapers = [],
  onOpenOutline,
  busy,
  error,
  onCancel,
  onSend,
}: {
  fromStep: string;
  /** 可退回的上游步骤名，近的在前 */
  targets: string[];
  /** 按退回目标预填的主题与原因（大纲「覆盖检查」里的薄节，三期 §9.3）；人改过就不再覆盖 */
  prefill?: Record<string, { topics: string; reason: string }>;
  /** 覆盖检查里归不到退回目标的薄节（建议没写补检 / 补读）：单列提示，人自己决定抄进哪一步 */
  unplaced?: string[];
  /** 上游里找文献、读文献的步骤（lit-search / lit-notes 槽，最近的那个）：两步并成下拉里的「补文献」，分「找新文献 / 精读已有的」两栏 */
  searchTarget?: string;
  notesTarget?: string;
  /** 整张单子预填（项目助手或「下一步建议」起草的补料单，2026-11-06）：给了就不按 prefill 换主题；reads 可同时预填「精读已有的」栏 */
  initial?: { target: string; topics: string; reads?: string; reason: string; clues: string; scale: number | null };
  /** 发起的这一步还没保存（做到一半 / 待评审，2026-11-06 流程贯通 §5）：说明它之后怎么接上补来的 */
  fromInProgress?: boolean;
  /** 发起的这一步还没开工（定稿前更新检索，2026-11-07）：补完、跟进完再开始它 */
  fromPending?: boolean;
  /** 按退回目标列出补完后能接着自动跟进的下游步骤（目标之后、已保存的步骤，按顺序）；默认全勾 */
  chainOptions?: Record<string, string[]>;
  /** 链上默认不勾的步骤（重跑实验花时间、花算力，step-kind.ts chainDefaultOff）：列出来但要人自己勾 */
  chainOff?: string[];
  /** 从当前项目 outline.md 解析出的章节与覆盖数（2026-11-22：补文献左栏速览，点选即填入节号） */
  outlineSections?: OutlineChapterChoice[];
  /** 库里已有全文但尚未精读的篇（2026-11-22：点选即插入 [@bibKey]，不用凭记忆背键名） */
  pendingPapers?: PendingFulltextChoice[];
  /** 在右侧文件预览中打开完整 outline.md */
  onOpenOutline?: () => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSend: (fields: ReworkFields) => void;
}) {
  const isLit = (t: string) => t === searchTarget || t === notesTarget;
  // 下拉：检索、精读并成一项「补文献」，放在两者里靠前那个的位置；其余步骤照旧一项一步
  const options = targets.reduce<string[]>((acc, t) => {
    const v = isLit(t) ? LIT : t;
    return acc.includes(v) ? acc : [...acc, v];
  }, []);
  const litPrefill = (searchTarget && prefill[searchTarget]) || (notesTarget && prefill[notesTarget]);
  const first =
    (initial && targets.includes(initial.target) ? (isLit(initial.target) ? LIT : initial.target) : null) ??
    (litPrefill ? LIT : null) ??
    options.find((t) => prefill[t]) ??
    options[0] ??
    "";
  const [mode, setMode] = useState(first);
  const lit = mode === LIT;
  const litReason = [searchTarget && prefill[searchTarget]?.reason, notesTarget && prefill[notesTarget]?.reason].filter(Boolean).join("；");
  const [searchText, setSearchText] = useState(
    initial ? (initial.target === searchTarget ? initial.topics : "") : (searchTarget && prefill[searchTarget]?.topics) || "",
  );
  const [readText, setReadText] = useState(
    initial
      ? (initial.reads?.trim()
          ? initial.reads
          : initial.target === notesTarget
            ? initial.topics
            : "")
      : (notesTarget && prefill[notesTarget]?.topics) || "",
  );
  // 非文献步骤（修改单）只有一栏
  const [topics, setTopics] = useState(initial && !isLit(initial.target) ? initial.topics : first !== LIT ? (prefill[first]?.topics ?? "") : "");
  const [reason, setReason] = useState(initial?.reason ?? (first === LIT ? litReason : (prefill[first]?.reason ?? "")));
  const [edited, setEdited] = useState(!!initial);
  const searchRows = parseTopics(searchText);
  const readRows = parseTopics(readText);
  const hasBothLit = !!searchTarget && !!notesTarget;
  // 补文献分三种意图：默认根据预填自动停在对应项，空白打开优先停在「找新文献」
  type LitTab = "search" | "read" | "both";
  const initialLitTab: LitTab = !searchTarget
    ? "read"
    : !notesTarget
      ? "search"
      : searchText.trim() && readText.trim()
        ? "both"
        : readText.trim()
          ? "read"
          : "search";
  const [litTab, setLitTab] = useState<LitTab>(initialLitTab);
  const chainDefault = (t: string) => (chainOptions[t] ?? []).filter((st) => !chainOff.includes(st));
  const initialTarget =
    first === LIT
      ? searchTarget && (initialLitTab !== "read" || !notesTarget)
        ? searchTarget
        : (notesTarget ?? "")
      : first;
  const [chain, setChain] = useState<string[]>(chainDefault(initialTarget));
  const [chainOf, setChainOf] = useState(initialTarget);
  const pickMode = (next: string) => {
    setMode(next);
    if (!edited) {
      if (next === LIT) {
        setReason(litReason);
      } else {
        setTopics(prefill[next]?.topics ?? "");
        setReason(prefill[next]?.reason ?? "");
      }
    }
  };
  const [clues, setClues] = useState(initial?.clues ?? "");
  const [scale, setScale] = useState(initial?.scale ? String(initial.scale) : "");
  const [activeLitBox, setActiveLitBox] = useState<"search" | "read">(initialLitTab === "read" ? "read" : "search");
  const [paperFilter, setPaperFilter] = useState("");
  const [moreOpen, setMoreOpen] = useState(() => Boolean(reason.trim() || clues.trim() || scale.trim()));
  const searchRef = useRef<HTMLTextAreaElement>(null);
  const readRef = useRef<HTMLTextAreaElement>(null);
  const focusRafRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(focusRafRef.current), []);

  const showSearch = lit && !!searchTarget && (litTab === "search" || litTab === "both");
  const showRead = lit && !!notesTarget && (litTab === "read" || litTab === "both");
  // 只提交当前 Tab 对应的输入（避免用户从「两样一起补」切回单一意图后被隐藏栏带偏）
  const activeSearchRows = showSearch ? searchRows : [];
  const activeReadRows = showRead ? readRows : [];
  const effectiveLitTarget =
    searchTarget && (activeSearchRows.length > 0 || litTab === "search" || !notesTarget)
      ? searchTarget
      : (notesTarget ?? "");
  const effectiveTarget = lit ? effectiveLitTarget : mode;
  const effectiveNotesLocked =
    lit && !!searchTarget && !!notesTarget && activeSearchRows.length > 0 && activeReadRows.length > 0;

  // 切换 Tab / 目标时按新目标刷新默认跟进链
  if (chainOf !== effectiveTarget) {
    setChainOf(effectiveTarget);
    setChain(chainDefault(effectiveTarget));
  }

  const parsed = parseTopics(topics);
  const order = lit
    ? litOrder({
        search: searchTarget,
        notes: notesTarget,
        searchRows: activeSearchRows,
        readRows: activeReadRows,
        chainOptions,
        picked: chain,
      })
    : null;
  // 补文献模式填了要补的内容即可发出（理由留空自动补默认说明）
  const ready = (lit ? !!order : !!effectiveTarget && parsed.length > 0 && reason.trim().length > 0) && !busy;
  const scaleNum = Number.parseInt(scale, 10);
  const chainList = (() => {
    const list = chainOptions[effectiveTarget] ?? [];
    return effectiveNotesLocked && effectiveTarget === searchTarget && notesTarget && !list.includes(notesTarget)
      ? [notesTarget, ...list]
      : list;
  })();
  const hasOutlinePanel = lit && outlineSections.length > 0;
  const topChapterCount = outlineSections.filter((s) => s.level === 2).length;
  const filteredPending = pendingPapers.filter((p) => {
    const q = paperFilter.trim().toLowerCase();
    if (!q) return true;
    return [p.author, p.year, p.venue, p.title, p.bibKey].some((s) => s.toLowerCase().includes(q));
  });

  /** 点大纲左栏章节：把「节号 简短标题：」插进当前聚焦的框并把光标放到冒号后 */
  const insertSection = (sec: OutlineChapterChoice) => {
    const shortLabel = sec.label.length > 26 ? `${sec.label.slice(0, 26)}…` : sec.label;
    const prefix = `${shortLabel}：`;
    const useSearch = showSearch && (!showRead || activeLitBox === "search");
    const setter = useSearch ? setSearchText : setReadText;
    const ref = useSearch ? searchRef : readRef;
    setEdited(true);
    setter((prev) => {
      const trimmedEnd = prev.replace(/[ \t]+$/, "");
      return trimmedEnd ? `${trimmedEnd}\n${prefix}` : prefix;
    });
    cancelAnimationFrame(focusRafRef.current);
    focusRafRef.current = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  /** 点已有全文待读篇：把 [@bibKey] 追加到「精读已有的」末尾（若已在框内不重复加） */
  const insertPendingPaper = (bibKey: string) => {
    const token = `[@${bibKey}]`;
    setActiveLitBox("read");
    setEdited(true);
    setReadText((prev) => {
      if (prev.toLowerCase().includes(token.toLowerCase())) return prev;
      if (!prev.trim()) return token;
      return /[：:\s]$/.test(prev) ? `${prev}${token}` : `${prev} ${token}`;
    });
    cancelAnimationFrame(focusRafRef.current);
    focusRafRef.current = requestAnimationFrame(() => {
      const el = readRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const defaultLitReason =
    activeSearchRows.length > 0 && activeReadRows.length > 0
      ? "按大纲补充检索新文献并精读已有全文"
      : activeSearchRows.length > 0
        ? "按大纲补充检索新文献"
        : "补充精读已纳入待读全文";

  const shortDesc = lit
    ? fromPending
      ? `只补你列的这些，补完后按勾选自动跟进，再开始「${fromStep}」。`
      : fromInProgress
        ? `只补你列的这些，补完并入后在「${fromStep}」点「继续」接着做。`
        : `只补你列的这些，已有的不重做；补完评审保存后可自动跟进。`
    : `从「${fromStep}」退回，只改你列的这些，已确认的内容不推翻。`;

  return (
    <Modal
      open
      size={hasOutlinePanel ? "xl" : "md"}
      layer="overlay"
      title={lit ? "补文献" : "退回上一步修改"}
      description={shortDesc}
      dismissOnBackdrop={!busy}
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <>
          <button type="button" className={secondaryActionClass} disabled={busy} onClick={onCancel}>
            {options.length === 0 ? "关闭" : "取消"}
          </button>
          {options.length > 0 && (
            <button
              type="button"
              className={primaryActionClass}
              disabled={!ready}
              onClick={() => {
                const resolvedReason = reason.trim() || (lit ? defaultLitReason : "");
                const base = { reason: resolvedReason, clues: clues.trim() };
                if (order) {
                  onSend({
                    ...base,
                    ...order,
                    scale: order.target === searchTarget && Number.isFinite(scaleNum) && scaleNum > 0 ? scaleNum : null,
                  });
                  return;
                }
                onSend({
                  ...base,
                  target: effectiveTarget,
                  topics: parsed,
                  scale: null,
                  chain: (chainOptions[effectiveTarget] ?? []).filter((st) => chain.includes(st)),
                  reads: [],
                });
              }}
            >
              {busy ? "正在交给上一步…" : lit ? "退回去补" : "退回去改"}
            </button>
          )}
        </>
      }
    >
      <div className={hasOutlinePanel ? "grid grid-cols-1 gap-4 text-xs text-l3 md:grid-cols-[minmax(0,0.88fr)_minmax(0,1.25fr)]" : "space-y-3 text-xs text-l3"}>
        {hasOutlinePanel && (
          <div className="flex min-h-0 flex-col rounded-md border border-hairline bg-inset/50 p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-medium text-l1">大纲章节（{topChapterCount || outlineSections.length}）</span>
              {onOpenOutline && (
                <button
                  type="button"
                  onClick={onOpenOutline}
                  className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-micro text-l3 transition-colors hover:bg-hover hover:text-l1"
                  title="在独立新窗口打开完整 outline.md，方便对照填单"
                >
                  <ExternalLink size={11} strokeWidth={1.8} aria-hidden="true" />
                  新窗口打开
                </button>
              )}
            </div>
            <div className="max-h-[50vh] space-y-1 overflow-y-auto pr-0.5">
              {outlineSections.map((sec) => {
                const mentioned = new RegExp(`(?:^|\\n)\\s*(?:第\\s*)?${sec.num.replace(/\./g, "\\.")}(?![\\d.])`).test(
                  `${showSearch ? searchText : ""}\n${showRead ? readText : ""}`,
                );
                const thin = Boolean(sec.verdict?.startsWith("薄") && !sec.verdict.includes("不补"));
                return (
                  <button
                    key={`${sec.level}-${sec.num}-${sec.label}`}
                    type="button"
                    onClick={() => insertSection(sec)}
                    title="点击填入右侧输入框"
                    className={`block w-full rounded-md text-left transition-colors hover:bg-hover ${
                      sec.level === 2
                        ? `border px-2 py-1.5 ${mentioned ? "border-cta-bd bg-canvas" : "border-hairline/70 bg-canvas/50"}`
                        : `py-1 pl-4 pr-2 ${mentioned ? "bg-canvas text-l1" : "text-l2"}`
                    }`}
                  >
                    <div className="flex items-start justify-between gap-1.5">
                      <span className={sec.level === 2 ? "font-medium leading-snug text-l1" : "text-micro leading-snug"}>
                        {sec.label}
                      </span>
                      {mentioned && (
                        <span className="shrink-0 rounded-full bg-inset px-1.5 py-px text-micro text-l2">已选</span>
                      )}
                    </div>
                    {sec.level === 2 && (sec.writable != null || sec.hint != null || sec.latest) && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-l4 tabular-nums">
                        {sec.writable != null && <span>可写 {sec.writable}</span>}
                        {sec.hint != null && <span>线索 {sec.hint}</span>}
                        {sec.latest && <span>{sec.latest}</span>}
                        {thin && <span className="text-warn-text">薄</span>}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="space-y-3">
        {options.length === 0 && (
          <InlineNotice>「{fromStep}」前面没有可退回的上游步骤；若是刚补入的新 PDF，请直接点「补读新到全文」让精读步原位更新。</InlineNotice>
        )}
        {unplaced.length > 0 && (
          <InlineNotice tone="info">
            大纲覆盖检查里还有 {unplaced.length} 节薄节未标注补检/补读：
            {unplaced.map((u) => (
              <span key={u} className="block">
                · {u}
              </span>
            ))}
          </InlineNotice>
        )}
        {options.length > 1 && (
          <label className="block space-y-1">
            <span className="text-l2">退回到</span>
            <select className={fieldClass} value={mode} onChange={(e) => pickMode(e.target.value)}>
              {options.map((t) => (
                <option key={t} value={t}>
                  {t === LIT ? "补文献（找新文献 / 精读已有的）" : t}
                  {(t === LIT ? litPrefill : prefill[t]) ? "（有待补项）" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {lit && hasBothLit && (
          <div className="inline-flex rounded-lg border border-hairline bg-inset/60 p-0.5" role="tablist" aria-label="补文献方式">
            {(
              [
                { id: "search" as const, label: "找新文献" },
                {
                  id: "read" as const,
                  label: pendingPapers.length > 0 ? `精读已有的 (${pendingPapers.length})` : "精读已有的",
                },
                { id: "both" as const, label: "两样一起补" },
              ]
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={litTab === tab.id}
                onClick={() => {
                  setLitTab(tab.id);
                  if (tab.id !== "both") setActiveLitBox(tab.id);
                }}
                className={`h-7 rounded-md px-2.5 text-xs transition-colors ${
                  litTab === tab.id ? "bg-seg-sel font-medium text-l1" : "text-l3 hover:text-l1"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
        {lit ? (
          <>
            {showSearch && (
              <label className="block space-y-1">
                <span className="font-medium text-l1">找什么新文献</span>
                <textarea
                  ref={searchRef}
                  className={`${fieldClass} min-h-20 resize-y`}
                  value={searchText}
                  onFocus={() => setActiveLitBox("search")}
                  onChange={(e) => {
                    setEdited(true);
                    setSearchText(e.target.value);
                  }}
                  placeholder={hasOutlinePanel ? "点左侧章节或直接写，一行一条。例：4.3：2024 年后高电流界面演化" : "一行一条。例：4.3：2024 年后高电流界面演化"}
                  autoFocus
                />
              </label>
            )}
            {showRead && (
              <div className="space-y-2">
                <label className="block space-y-1">
                  <span className="font-medium text-l1">要精读哪些篇</span>
                  <textarea
                    ref={readRef}
                    className={`${fieldClass} min-h-16 resize-y`}
                    value={readText}
                    onFocus={() => setActiveLitBox("read")}
                    onChange={(e) => {
                      setEdited(true);
                      setReadText(e.target.value);
                    }}
                    placeholder="从下方点选文章，或手写节号与键。例：4.3：[@Su2025]"
                    autoFocus={litTab === "read"}
                  />
                </label>
                {pendingPapers.length > 0 && (
                  <div className="rounded-md border border-hairline bg-inset/50 p-2">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-micro font-medium text-l2">已有全文、尚未精读（{pendingPapers.length} 篇）</span>
                      {pendingPapers.length > 5 && (
                        <input
                          value={paperFilter}
                          onChange={(e) => setPaperFilter(e.target.value)}
                          placeholder="筛作者 / 标题…"
                          className={`${compactFieldClass} h-6 w-36 text-micro`}
                        />
                      )}
                    </div>
                    <div className="max-h-36 space-y-1 overflow-y-auto pr-0.5">
                      {filteredPending.map((p) => {
                        const picked = readText.toLowerCase().includes(`[@${p.bibKey.toLowerCase()}]`);
                        const head = [p.author || p.bibKey, p.year ? `(${p.year})` : "", p.venue].filter(Boolean).join(" ");
                        return (
                          <button
                            key={p.bibKey}
                            type="button"
                            onClick={() => insertPendingPaper(p.bibKey)}
                            title={p.title ? `${head} — ${p.title}` : p.bibKey}
                            className={`block w-full rounded-md border px-2 py-1 text-left transition-colors hover:bg-hover ${
                              picked ? "border-cta-bd bg-canvas" : "border-hairline/70 bg-canvas/50"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-micro font-medium text-l1">{head}</span>
                              {picked && <span className="shrink-0 text-micro text-l2">已选</span>}
                            </div>
                            {p.title && <div className="truncate text-micro text-l3">{p.title}</div>}
                          </button>
                        );
                      })}
                      {filteredPending.length === 0 && (
                        <div className="py-2 text-center text-micro text-l4">没有匹配的篇目</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <label className="block space-y-1">
            <span className="font-medium text-l1">要改的地方（一行一条）</span>
            <textarea
              className={`${fieldClass} min-h-20 resize-y`}
              value={topics}
              onChange={(e) => {
                setEdited(true);
                setTopics(e.target.value);
              }}
              placeholder="例：§3 先讲机理、再讲材料体系"
              autoFocus
            />
          </label>
        )}
        {lit ? (
          <div className="rounded-md border border-hairline/80 bg-inset/40">
            <button
              type="button"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-l2 transition-colors hover:text-l1"
            >
              {moreOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
              <span>{showSearch ? "更多选项（理由 / 线索 / 篇数）" : "更多选项（理由 / 线索）"}</span>
              {(reason.trim() || clues.trim() || scale.trim()) && !moreOpen && (
                <span className="ml-auto text-micro text-l4">已填写</span>
              )}
            </button>
            {moreOpen && (
              <div className="space-y-2.5 border-t border-hairline/70 px-2.5 py-2.5">
                <label className="block space-y-1">
                  <span className="text-l2">为什么要补（可选）</span>
                  <input
                    className={fieldClass}
                    value={reason}
                    onChange={(e) => {
                      setEdited(true);
                      setReason(e.target.value);
                    }}
                    placeholder="例：这一节能写进正文的只有 2 篇，且早于 2021 年"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-l2">线索（关键词 / 参考综述 / 排除方向）</span>
                  <textarea
                    className={`${fieldClass} min-h-12 resize-y`}
                    value={clues}
                    onChange={(e) => setClues(e.target.value)}
                  />
                </label>
                {showSearch && (
                  <label className="flex items-center gap-2">
                    <span className="text-l2">大致补多少篇</span>
                    <input
                      className={`${fieldClass} w-24`}
                      inputMode="numeric"
                      value={scale}
                      onChange={(e) => setScale(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder="按需要"
                    />
                  </label>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-l2">为什么要改（一句话）</span>
              <input
                className={fieldClass}
                value={reason}
                onChange={(e) => {
                  setEdited(true);
                  setReason(e.target.value);
                }}
                placeholder="例：写初稿时发现先讲材料，读者看不出各体系为什么这样设计"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-l2">参考（可选）</span>
              <textarea
                className={`${fieldClass} min-h-12 resize-y`}
                value={clues}
                onChange={(e) => setClues(e.target.value)}
              />
            </label>
          </>
        )}
        {chainList.length > 0 && (
          <fieldset className="space-y-1.5 rounded-md border border-hairline/80 bg-inset/40 px-2.5 py-2">
            <legend className="sr-only">自动跟进步骤</legend>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="text-l4">执行路径：</span>
              <span className="font-medium text-l1">{effectiveTarget}</span>
              {chainList.map((st) => {
                const locked = effectiveNotesLocked && st === notesTarget;
                const checked = locked || chain.includes(st);
                return (
                  <span key={st} className="inline-flex items-center gap-1.5">
                    <span className="text-l4">→</span>
                    <label className="inline-flex cursor-pointer items-center gap-1 text-l2">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={locked}
                        onChange={(e) => setChain((cur) => (e.target.checked ? [...cur, st] : cur.filter((x) => x !== st)))}
                      />
                      <span className={checked ? "text-l1" : "text-l4"}>{st}</span>
                    </label>
                  </span>
                );
              })}
            </div>
          </fieldset>
        )}
        {error && <InlineNotice>{error}</InlineNotice>}
        </div>
      </div>
    </Modal>
  );
}
