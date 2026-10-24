import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  loadSpotIssues,
  saveSpotIssues,
  spotQuote,
  type SpotCheckItemDto,
  type SpotCheckSession,
  type SpotIssue,
} from "../spot-check";

/** 阅读区抽查核对档的状态：当前第几篇、看过哪几篇、每篇解析结果、问题单（按 base 记本机） */
export function useSpotCheck(session: SpotCheckSession | null | undefined) {
  const [index, setIndex] = useState(session?.index ?? 0);
  const [visited, setVisited] = useState<Set<number>>(() => new Set());
  const [items, setItems] = useState<Record<number, SpotCheckItemDto | { error: string }>>({});
  const [issues, setIssues] = useState<SpotIssue[]>([]);
  const base = session?.base ?? "";
  // 换一次抽查（从步骤卡重新点进来）：起点、已看、解析缓存、问题单都按新的来
  useEffect(() => {
    setIndex(session?.index ?? 0);
    setVisited(new Set());
    setItems({});
    setIssues(base ? loadSpotIssues(base) : []);
  }, [session, base]);
  useEffect(() => {
    if (!session) return;
    setVisited((prev) => (prev.has(index) ? prev : new Set(prev).add(index)));
    if (items[index]) return;
    const item = session.items[index];
    if (!item) return;
    let stale = false;
    invoke<SpotCheckItemDto>("spot_check_item", {
      projectRoot: session.projectRoot,
      base: session.base,
      notePath: item.notePath,
      id: item.id,
    })
      .then((dto) => {
        if (!stale) setItems((prev) => ({ ...prev, [index]: dto }));
      })
      .catch((e) => {
        if (!stale) setItems((prev) => ({ ...prev, [index]: { error: String(e) } }));
      });
    return () => {
      stale = true;
    };
  }, [session, index, items]);
  const update = useCallback(
    (next: (prev: SpotIssue[]) => SpotIssue[]) =>
      setIssues((prev) => {
        const value = next(prev);
        saveSpotIssues(base, value);
        return value;
      }),
    [base],
  );
  const addIssue = useCallback(
    (issue: Omit<SpotIssue, "item">) =>
      update((prev) => [...prev, { ...issue, item: index, quote: spotQuote(issue.quote) }]),
    [update, index],
  );
  const current = items[index];
  return {
    index,
    setIndex,
    visited,
    item: current && !("error" in current) ? current : null,
    itemError: current && "error" in current ? current.error : null,
    issues,
    addIssue,
    updateIssue: (at: number, comment: string) =>
      update((prev) => prev.map((issue, i) => (i === at ? { ...issue, comment } : issue))),
    removeIssue: (at: number) => update((prev) => prev.filter((_, i) => i !== at)),
    /** 发出或勾上之后清掉：直接清本机记录——成功后阅读区随即关闭，卸载后的 setState 不再执行 */
    clearIssues: () => {
      saveSpotIssues(base, []);
      setIssues([]);
    },
  };
}

export type SpotCheckState = ReturnType<typeof useSpotCheck>;

/** 核对档顶栏下的一条：第几篇（可切）、全文 / 仅摘要、这篇要看什么 */
export function SpotCheckStrip({
  session,
  spot,
  focus,
}: {
  session: SpotCheckSession;
  spot: SpotCheckState;
  focus: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-strip px-3 py-1.5 text-xs">
      <span className="shrink-0 text-l3">抽查</span>
      <div role="group" aria-label="抽查篇目" className="flex shrink-0 items-center gap-0.5">
        {session.items.map((item, i) => (
          <button
            key={item.notePath}
            type="button"
            aria-pressed={spot.index === i}
            onClick={() => spot.setIndex(i)}
            title={item.notePath}
            className={`flex h-6 min-w-6 items-center justify-center gap-1 rounded-sm px-1.5 tabular-nums ${
              spot.index === i ? "bg-seg-sel text-l1" : "text-l3 hover:bg-hover hover:text-l1"
            }`}
          >
            {i + 1}
            {spot.visited.has(i) && spot.index !== i && <span className="text-micro text-done">✓</span>}
          </button>
        ))}
      </div>
      <span className="shrink-0 rounded-sm border border-field px-1.5 py-px text-micro text-l3">
        {session.items[spot.index]?.fulltext ? "全文" : "仅摘要"}
      </span>
      <span className="min-w-0 flex-1 truncate text-l3" title={focus}>
        {focus}
      </span>
    </div>
  );
}

/** 中栏没有 PDF 时（仅摘要的篇 / 全文没找到）：题名 + 摘要当原文对照 */
export function SpotAbstractPane({
  title,
  abstractText,
  fulltext,
}: {
  title: string | null;
  abstractText: string | null;
  fulltext: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <p className="text-xs text-l4">
          {fulltext
            ? "没找到这篇的全文 PDF（papers/ 里没有、笔记也没写来源），只能对照题录里的摘要。"
            : "这篇只按摘要记，没有全文可对照。下面是题录里的摘要。"}
        </p>
        {title && <h2 className="mt-4 text-base font-medium text-l1">{title}</h2>}
        {abstractText ? (
          <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-l2">{abstractText}</p>
        ) : (
          <p className="mt-3 text-sm text-l3">题录里没有摘要。</p>
        )}
      </div>
    </div>
  );
}

/** 右栏问题单：划段记下的问题按篇列出，可补说明、可删；看完一次交回这一步的 AI，或都没问题直接勾上 */
export function SpotCheckPanel({
  session,
  spot,
  busy,
  error,
  onSend,
  onAllClear,
}: {
  session: SpotCheckSession;
  spot: SpotCheckState;
  busy: boolean;
  error: string | null;
  onSend: () => void;
  onAllClear: () => void;
}) {
  const total = session.items.length;
  const seen = Math.min(spot.visited.size, total);
  const left = total - seen;
  const count = spot.issues.length;
  return (
    <div className="ccode-well mx-2 mb-2 mt-2 flex min-h-0 flex-1 flex-col rounded-lg">
      <div className="flex h-8 shrink-0 items-center gap-2 rounded-t-[7px] border-b border-hairline bg-strip px-2.5 text-micro">
        <span className="text-l2">问题单</span>
        <span className="text-l4">{count > 0 ? `${count} 条` : "还没有"}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {count === 0 ? (
          <p className="text-xs leading-5 text-l4">
            在笔记或原文里划一段，点「记成问题」。没问题就直接看下一篇。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {spot.issues.map((issue, i) => (
              <li key={`${issue.item}-${i}`} className="rounded-md border border-hairline bg-canvas p-2">
                <div className="flex items-center gap-1.5 text-micro text-l4">
                  <button
                    type="button"
                    onClick={() => spot.setIndex(issue.item)}
                    className="rounded-sm px-1 hover:bg-hover hover:text-l2"
                  >
                    第 {issue.item + 1} 篇
                  </button>
                  <span>
                    {issue.source === "pdf" ? `原文${issue.page ? ` p.${issue.page}` : ""}` : "笔记"}
                  </span>
                  <button
                    type="button"
                    aria-label="删掉这条"
                    onClick={() => spot.removeIssue(i)}
                    className="ml-auto flex h-5 w-5 items-center justify-center rounded-sm hover:bg-hover hover:text-l1"
                  >
                    ×
                  </button>
                </div>
                <p className="mt-1 line-clamp-3 text-xs text-l3" title={issue.quote}>
                  「{issue.quote}」
                </p>
                <textarea
                  value={issue.comment}
                  onChange={(e) => spot.updateIssue(i, e.target.value)}
                  rows={2}
                  placeholder="哪里不对（可不写，AI 会对照原文判断）"
                  className="mt-1 w-full resize-y rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4"
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="shrink-0 border-t border-hairline px-2.5 py-2">
        <p className="mb-1.5 text-micro text-l4">
          已看 {seen} / {total} 篇{left > 0 ? `，还有 ${left} 篇没看` : ""}
        </p>
        {error && <p className="mb-1.5 text-micro text-err-text">{error}</p>}
        {count > 0 ? (
          session.ws ? (
            <button
              type="button"
              disabled={busy}
              onClick={onSend}
              className="w-full rounded-md border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-60"
              title="接回这一步原来的对话，把问题单作为一条消息发过去：改这几篇并复查同类。抽查这一项先不勾，改完再抽。"
            >
              {busy ? "正在交回…" : `发给这一步的 AI（${count} 条）`}
            </button>
          ) : (
            <p className="text-micro leading-5 text-l3">
              这一步已经保存进项目，没有可以接着改的对话：直接在笔记里改，或在流程页开下一轮时把问题写进任务书。
            </p>
          )
        ) : (
          <button
            type="button"
            disabled={busy || left > 0}
            onClick={onAllClear}
            className="w-full rounded-md border border-field bg-strip px-3 py-1.5 text-sm text-l2 hover:bg-inset hover:text-l1 disabled:opacity-50"
            title={left > 0 ? "三篇都看过才能勾" : "勾上「抽查笔记」这一项，回到流程页"}
          >
            {busy ? "正在勾上…" : `${total} 篇都没问题，勾上抽查`}
          </button>
        )}
      </div>
    </div>
  );
}
