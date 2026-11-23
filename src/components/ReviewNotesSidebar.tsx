import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, FileDiff, ListChecks, Pencil, Plus, RotateCcw, Trash2, Type } from "lucide-react";
import AgentModelPicker from "./AgentModelPicker";
import { appendReviewLine } from "../draft-review";
import {
  parseReviewItems,
  readResolvedReviewKeys,
  removeReviewItem,
  updateReviewItemComment,
  writeResolvedReviewKeys,
  type ReviewNoteItem,
  type ReviewNoteKind,
} from "../review-checklist";
import { reviewerOptionKey, type ReviewerOption } from "../cross-review";
import { AGENTS } from "../types";

const agentLabelOf = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

const KIND_LABEL: Record<ReviewNoteKind, string> = {
  quote: "划字",
  image: "框图",
  check: "机检",
  plain: "批注",
};

/**
 * 评审页右侧「批注与验改」栏（2026-11-23）：
 * 体现评审相对普通对话的独特闭环价值——
 * ① 二审/三审回来时把「上次退回的意见」展成可逐条勾销的验改清单，点一条直跳该文件改动 Diff，未改好的一键退回；
 * ② 本轮批注支持「结构化卡片清单 / 纯文本」切换，划字、框图、机检项与研讨结论各自成条，可点跳原文、行内修改与单条删除；
 * ③ 显性露出「换一家模型干净改」入口，避免原对话上下文膨胀越改越糊。
 */
export default function ReviewNotesSidebar({
  worktreePath,
  reviewNotes,
  onChangeNotes,
  lastNotes,
  reviewerChoices,
  returnBy,
  returnByKey,
  onChangeReturnByKey,
  returnBusy,
  canSubmit,
  onReturn,
  onClose,
  onLocateItem,
  onUnresolvedCountChange,
}: {
  worktreePath: string;
  reviewNotes: string;
  onChangeNotes: (next: string) => void;
  lastNotes: string;
  reviewerChoices: ReviewerOption[];
  returnBy: ReviewerOption | null;
  returnByKey: string;
  onChangeReturnByKey: (key: string) => void;
  returnBusy: boolean;
  canSubmit: boolean;
  onReturn: (rewrite: boolean) => void;
  onClose: () => void;
  onLocateItem: (item: ReviewNoteItem, opts?: { diff?: boolean }) => void;
  onUnresolvedCountChange?: (unresolved: number) => void;
}) {
  const [viewMode, setViewMode] = useState<"cards" | "raw">("cards");
  const [quickInput, setQuickInput] = useState("");
  const [editingLine, setEditingLine] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");

  const currentItems = useMemo(() => parseReviewItems(reviewNotes), [reviewNotes]);
  const lastItems = useMemo(() => parseReviewItems(lastNotes), [lastNotes]);

  const [resolvedKeys, setResolvedKeys] = useState<string[]>(() =>
    readResolvedReviewKeys(worktreePath, lastNotes),
  );
  const [lastOpen, setLastOpen] = useState(true);

  useEffect(() => {
    setResolvedKeys(readResolvedReviewKeys(worktreePath, lastNotes));
  }, [worktreePath, lastNotes]);

  const resolvedSet = useMemo(() => new Set(resolvedKeys), [resolvedKeys]);
  const resolvedCount = useMemo(
    () => lastItems.filter((it) => resolvedSet.has(it.key)).length,
    [lastItems, resolvedSet],
  );
  const unresolvedCount = Math.max(0, lastItems.length - resolvedCount);

  useEffect(() => {
    onUnresolvedCountChange?.(unresolvedCount);
  }, [unresolvedCount, onUnresolvedCountChange]);

  function toggleResolved(key: string) {
    setResolvedKeys((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      writeResolvedReviewKeys(worktreePath, lastNotes, next);
      return next;
    });
  }

  function addQuickItem() {
    const trimmed = quickInput.trim();
    if (!trimmed) return;
    const line = /^[-*•]\s+/.test(trimmed) ? trimmed : `- ${trimmed}`;
    onChangeNotes(appendReviewLine(reviewNotes, line));
    setQuickInput("");
  }

  function commitEdit(lineIndex: number) {
    if (editingText.trim()) {
      onChangeNotes(updateReviewItemComment(reviewNotes, lineIndex, editingText));
    }
    setEditingLine(null);
    setEditingText("");
  }

  return (
    <aside aria-label="退回意见" className="flex w-84 shrink-0 flex-col border-l border-hairline bg-strip">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-hairline px-3 text-xs">
        <span className="font-medium text-l1">批注与验改</span>
        {currentItems.length > 0 && (
          <span className="rounded-full bg-inset px-1.5 py-px text-micro tabular-nums text-l3">
            {currentItems.length}
          </span>
        )}
        <div className="ml-auto inline-flex items-center gap-0.5 rounded-md border border-hairline bg-canvas/60 p-0.5">
          <button
            type="button"
            onClick={() => setViewMode("cards")}
            title="结构化卡片清单"
            className={`inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-micro transition-colors ${
              viewMode === "cards" ? "bg-seg-sel text-l1" : "text-l4 hover:text-l1"
            }`}
          >
            <ListChecks size={11} strokeWidth={1.8} aria-hidden="true" />
            清单
          </button>
          <button
            type="button"
            onClick={() => setViewMode("raw")}
            title="纯文本编辑（一行一条）"
            className={`inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-micro transition-colors ${
              viewMode === "raw" ? "bg-seg-sel text-l1" : "text-l4 hover:text-l1"
            }`}
          >
            <Type size={11} strokeWidth={1.8} aria-hidden="true" />
            文本
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="收起批注栏，已写意见会保留"
          className="rounded-sm px-1 text-micro text-l4 hover:bg-hover hover:text-l1"
        >
          收起
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        {/* 上一轮逐条验改清单（二审/三审回来时最核心的评审价值） */}
        {lastItems.length > 0 && (
          <section aria-label="上一轮验改清单" className="rounded-md border border-hairline bg-canvas/60">
            <button
              type="button"
              aria-expanded={lastOpen}
              onClick={() => setLastOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-l2 hover:text-l1"
            >
              {lastOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
              <span className="font-medium text-l1">上一轮验改</span>
              <span
                className={`ml-auto rounded-full px-1.5 py-px text-micro tabular-nums ${
                  unresolvedCount === 0 ? "bg-inset text-ok-text" : "bg-warn text-warn-text"
                }`}
              >
                {resolvedCount}/{lastItems.length} 已核
              </span>
            </button>
            {lastOpen && (
              <div className="space-y-1.5 border-t border-hairline/70 p-2">
                {lastItems.map((item, idx) => {
                  const done = resolvedSet.has(item.key);
                  const readded = reviewNotes
                    .split("\n")
                    .some((line) => line.trim() === item.raw.trim());
                  return (
                    <div
                      key={item.key}
                      className={`rounded-md border px-2 py-1.5 text-xs transition-colors ${
                        done ? "border-hairline/60 bg-inset/40 opacity-65" : "border-hairline bg-canvas"
                      }`}
                    >
                      <div className="flex items-start gap-1.5">
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={done}
                          aria-label={`标记第 ${idx + 1} 条为${done ? "未核" : "已改好"}`}
                          onClick={() => toggleResolved(item.key)}
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors ${
                            done
                              ? "border-ok-text bg-ok-text text-canvas"
                              : "border-field bg-canvas hover:border-l3"
                          }`}
                        >
                          {done && <Check size={11} strokeWidth={2.4} aria-hidden="true" />}
                        </button>
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="text-micro font-mono text-l4">#{idx + 1}</span>
                            {item.file && (
                              <button
                                type="button"
                                onClick={() => onLocateItem(item, { diff: true })}
                                title={`切到 ${item.file} 的改动 Diff 查看这一处改了什么`}
                                className="inline-flex max-w-full items-center gap-1 truncate rounded-sm bg-inset px-1.5 py-px font-mono text-micro text-l2 hover:bg-hover hover:text-l1"
                              >
                                <FileDiff size={10} strokeWidth={1.8} aria-hidden="true" />
                                <span className="truncate">{item.file}</span>
                              </button>
                            )}
                          </div>
                          {item.excerpt && (
                            <p className="line-clamp-2 border-l-2 border-hairline pl-1.5 text-micro text-l4">
                              {item.excerpt}
                            </p>
                          )}
                          <p className={`break-words text-xs leading-snug ${done ? "line-through text-l4" : "text-l2"}`}>
                            {item.comment}
                          </p>
                          {!done && (
                            <div className="flex items-center gap-2 pt-0.5">
                              {item.file && (
                                <button
                                  type="button"
                                  onClick={() => onLocateItem(item, { diff: true })}
                                  className="text-micro text-l3 hover:text-l1 hover:underline"
                                >
                                  看改动 Diff
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={readded}
                                onClick={() => onChangeNotes(appendReviewLine(reviewNotes, item.raw))}
                                className="inline-flex items-center gap-0.5 text-micro text-l3 hover:text-l1 hover:underline disabled:opacity-50"
                                title="这一条还没改好，加进本轮继续退回"
                              >
                                <RotateCcw size={10} strokeWidth={1.8} aria-hidden="true" />
                                {readded ? "已加入本轮" : "未改好 · 退回"}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* 本轮待改批注 */}
        {viewMode === "raw" ? (
          <textarea
            value={reviewNotes}
            onChange={(e) => onChangeNotes(e.target.value)}
            autoFocus={!reviewNotes}
            placeholder={"例如：\n- 5.3 覆盖检查里 @Lu2017 写了两次，换成漏掉的 @Masa2017\n- 拼图 9 换一块不重复的子图"}
            className="min-h-40 w-full flex-1 resize-none rounded-md border border-field bg-canvas px-2.5 py-2 text-xs leading-relaxed text-l2 outline-none placeholder:text-l4 focus:border-l4"
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            {currentItems.length === 0 ? (
              <p className="rounded-md border border-dashed border-hairline px-2.5 py-3 text-micro leading-relaxed text-l4">
                正文划字、图上框选、勾选左侧核验项，都会收成一条条待改卡片；也可直接在下面补充。
              </p>
            ) : (
              <div className="space-y-1.5">
                {currentItems.map((item, idx) => {
                  const isEditing = editingLine === item.lineIndex;
                  return (
                    <div
                      key={`${item.lineIndex}-${item.key}`}
                      className="rounded-md border border-hairline bg-canvas px-2.5 py-2 text-xs"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-micro text-l4">#{idx + 1}</span>
                        <span className="rounded-sm bg-inset px-1.5 py-px text-micro text-l3">
                          {KIND_LABEL[item.kind]}
                        </span>
                        {item.file && (
                          <button
                            type="button"
                            onClick={() => onLocateItem(item, { diff: false })}
                            title={`定位到 ${item.file}`}
                            className="min-w-0 truncate rounded-sm px-1 font-mono text-micro text-l2 hover:bg-hover hover:text-l1"
                          >
                            {item.file}
                            {item.line ? `:${item.line}` : ""}
                          </button>
                        )}
                        <span className="ml-auto flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            aria-label={`编辑第 ${idx + 1} 条`}
                            title="编辑这条意见"
                            onClick={() => {
                              setEditingLine(item.lineIndex);
                              setEditingText(item.comment === "（待补）" ? "" : item.comment);
                            }}
                            className="rounded-sm p-1 text-l4 hover:bg-hover hover:text-l1"
                          >
                            <Pencil size={11} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={`删除第 ${idx + 1} 条`}
                            title="删除这条意见"
                            onClick={() => {
                              if (editingLine === item.lineIndex) setEditingLine(null);
                              onChangeNotes(removeReviewItem(reviewNotes, item.lineIndex));
                            }}
                            className="rounded-sm p-1 text-l4 hover:bg-hover hover:text-err-text"
                          >
                            <Trash2 size={11} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                        </span>
                      </div>
                      {item.excerpt && (
                        <button
                          type="button"
                          onClick={() => onLocateItem(item, { diff: false })}
                          title="点击跳到原文位置"
                          className="mt-1.5 block w-full border-l-2 border-cta-bd/60 pl-2 text-left text-micro leading-snug text-l3 hover:text-l1"
                        >
                          <span className="line-clamp-2">{item.excerpt}</span>
                        </button>
                      )}
                      {isEditing ? (
                        <div className="mt-1.5 flex items-center gap-1">
                          <input
                            autoFocus
                            value={editingText}
                            onChange={(e) => setEditingText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitEdit(item.lineIndex);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setEditingLine(null);
                              }
                            }}
                            onBlur={() => commitEdit(item.lineIndex)}
                            placeholder="输入具体改法，回车保存"
                            className="h-7 min-w-0 flex-1 rounded-sm border border-field bg-strip px-2 text-xs text-l1 outline-none focus:border-l3"
                          />
                        </div>
                      ) : (
                        <p
                          onClick={() => {
                            setEditingLine(item.lineIndex);
                            setEditingText(item.comment === "（待补）" ? "" : item.comment);
                          }}
                          title="点击编辑这条意见"
                          className={`mt-1.5 cursor-text break-words leading-snug ${
                            item.comment === "（待补）" ? "text-warn-text" : "text-l1"
                          }`}
                        >
                          {item.comment}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <form
              className="mt-auto flex items-center gap-1.5 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                addQuickItem();
              }}
            >
              <input
                value={quickInput}
                onChange={(e) => setQuickInput(e.target.value)}
                placeholder="＋ 补充一条意见，回车加入…"
                aria-label="补充一条意见"
                className="h-7 min-w-0 flex-1 rounded-md border border-field bg-canvas px-2 text-xs text-l1 outline-none placeholder:text-l4 focus:border-l3"
              />
              <button
                type="submit"
                disabled={!quickInput.trim()}
                aria-label="加入批注"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-field bg-canvas text-l2 hover:bg-hover hover:text-l1 disabled:opacity-40"
              >
                <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </form>
          </div>
        )}
      </div>

      {/* 底部：交回给谁改（凸显换模型干净改）+ 退回修改 */}
      <div className="shrink-0 space-y-2 border-t border-hairline bg-strip px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-hairline bg-canvas/60 px-2 py-1 text-micro text-l3">
          <span className="shrink-0 text-l4">谁来改</span>
          <AgentModelPicker
            options={reviewerChoices.map((o) => ({ ...o, key: reviewerOptionKey(o) }))}
            selectedKey={returnByKey || null}
            onPick={(o) => onChangeReturnByKey(o.key)}
            title="选择谁来改这一轮"
            hint="默认接回原对话；换另一家会新开干净对话，只照本轮批注清单在现稿上精准改。"
            ariaLabel="选谁来改"
            triggerTitle="默认接回原对话；点击可换另一家模型新开干净对话精修"
            triggerClassName="min-w-0 flex-1 truncate rounded-sm px-1 text-left text-micro font-medium text-l1 hover:bg-hover"
          >
            {returnBy
              ? `${agentLabelOf(returnBy.agentId)} · ${returnBy.model || returnBy.profileName}（换模型干净改）`
              : "原来那段对话（可换模型）"}
          </AgentModelPicker>
          {returnBy && (
            <button
              type="button"
              onClick={() => onChangeReturnByKey("")}
              className="shrink-0 text-l4 underline decoration-dotted underline-offset-2 hover:text-l1"
            >
              回原对话
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={returnBusy || !canSubmit}
            onClick={() => onReturn(false)}
            title={
              returnBy
                ? "新开干净对话，按上面批注清单在现稿上精准修改；不会保存进项目"
                : "接回原来那段对话，让 AI 按上面批注清单修改；不会保存进项目"
            }
            className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-md border border-field bg-canvas px-3 text-xs font-medium text-l1 transition-colors hover:bg-hover disabled:opacity-50"
          >
            {returnBusy ? "交接中…" : currentItems.length > 0 ? `退回修改（${currentItems.length} 条）` : "退回修改"}
          </button>
          <button
            type="button"
            disabled={returnBusy || !canSubmit}
            onClick={() => onReturn(true)}
            title="新开一段对话，按大纲和笔记把这一步整份重写；改动大、现稿方向不对时用"
            className="h-8 rounded-md px-2 text-xs text-l3 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50"
          >
            按意见重写
          </button>
        </div>
      </div>
    </aside>
  );
}
