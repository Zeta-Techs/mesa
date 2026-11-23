import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Check, Copy, ExternalLink, Maximize2, Search, X } from "lucide-react";
import { readResearchFile } from "../research-report-load";
import { researchAbsolutePath } from "../research-report";
import {
  groupPermissionsByPaper,
  PERMISSION_STATUSES,
  parseDeclarations,
  parsePermissionRows,
  setPermissionStatus,
  summarizePermissions,
  writeDeclarations,
  type DeclarationSection,
  type DeclarationsSummary,
  type PermissionGroup,
  type PermissionsSummary,
} from "../handback-files";
import { InlineNotice } from "./PageFrame";

export type { PermissionsSummary, DeclarationsSummary };

export interface DeclarationsFormHandle {
  /** 立即把尚未失焦落盘的修改写回文件（交给 AI 或关闭大窗前调用）。 */
  flushSave: () => Promise<boolean>;
}

/** 读 + 带版本写回同一份文件（save_file_preview 的乐观锁：别处改过就报错，不覆盖） */
function useStepFile(root: string, rel: string, refreshKey?: string) {
  const [text, setText] = useState<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function reload() {
    setError(null);
    try {
      const file = await readResearchFile(root, rel);
      setText(file.text);
      setRevision(file.revision);
    } catch (reason) {
      setError(`读不到 ${rel}：${String(reason)}`);
    }
  }

  useEffect(() => {
    let stale = false;
    setText(null);
    setError(null);
    readResearchFile(root, rel)
      .then((file) => {
        if (stale) return;
        setText(file.text);
        setRevision(file.revision);
      })
      .catch((reason) => !stale && setError(`读不到 ${rel}：${String(reason)}`));
    return () => {
      stale = true;
    };
  }, [root, rel, refreshKey]);

  async function save(next: string) {
    if (!revision) return false;
    setSaving(true);
    setError(null);
    try {
      const nextRevision = await invoke<string>("save_file_preview", {
        path: researchAbsolutePath(root, rel),
        root,
        text: next,
        expectedRevision: revision,
      });
      setText(next);
      setRevision(nextRevision);
      return true;
    } catch (reason) {
      if (String(reason).includes("已被 Agent 或其他程序修改")) {
        await reload();
        setError("文件刚被 AI 更新，已重新读取，请再核对后修改。");
      } else {
        setError(String(reason));
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  return { text, error, saving, save };
}

/** 原文一栏「作者, 年份, *期刊* 卷, 页 — 题名」只取「作者, 年份, 期刊」那段 */
function shortCite(paper: string): string {
  return paper.split(" — ")[0].replace(/\*/g, "").trim();
}

function cleanDoiFromUrl(doiUrl: string | null): string | null {
  if (!doiUrl) return null;
  const trimmed = doiUrl.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
  return trimmed || null;
}

function statusSelectTone(status: string): string {
  if (status === "待申请") return "border-warn-text/45 text-warn-text";
  if (status === "已获许可") return "border-done/50 text-done";
  if (status === "已申请") return "border-cta-bd text-cta-pill-text";
  return "border-field text-l2";
}

type PermissionFilter = "all" | "待申请" | "已申请" | "已获许可" | "无需申请" | "self";

/**
 * 换原图与转载许可：按论文一篇一行（同一篇的几块合在一次申请里），状态下拉一改就存；
 * 支持进度条、按状态筛选、关键词搜索、一键复制 DOI / 图注出处与放大弹层。
 */
export function FigurePermissionsPanel({
  root,
  rel,
  projectRoot,
  fill = false,
  onMeta,
  onEnlarge,
  refreshKey,
}: {
  root: string;
  rel: string;
  projectRoot: string;
  fill?: boolean;
  onMeta?: (meta: PermissionsSummary) => void;
  onEnlarge?: () => void;
  refreshKey?: string;
}) {
  const file = useStepFile(root, rel, refreshKey);
  const groups = useMemo(() => groupPermissionsByPaper(parsePermissionRows(file.text ?? "")), [file.text]);
  const summary = useMemo(() => summarizePermissions(file.text ?? ""), [file.text]);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  const [filter, setFilter] = useState<PermissionFilter>("all");
  const [query, setQuery] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;

  useEffect(() => {
    if (file.text != null) onMetaRef.current?.(summary);
  }, [file.text, summary]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  function copyWithFeedback(key: string, value: string) {
    if (!value || typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopiedKey(key);
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedKey(null), 1600);
    });
  }

  if (file.text == null) {
    return file.error ? (
      <InlineNotice tone="err" size="micro">{file.error}</InlineNotice>
    ) : (
      <p className="text-micro text-l4">读取清单…</p>
    );
  }
  if (groups.length === 0) return <p className="text-micro text-l4">清单里没有拼图块，不用申请。</p>;

  const handled = Math.max(0, summary.paperCount - summary.pending);
  const pct =
    summary.paperCount > 0 ? Math.min(100, Math.round((handled / summary.paperCount) * 100)) : 100;

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleGroups = groups.filter((group) => {
    if (filter === "self" && !group.selfDrawn) return false;
    if (filter !== "all" && filter !== "self") {
      if (group.selfDrawn) return false;
      if (!group.rows.some((row) => row.status === filter)) return false;
    }
    if (terms.length === 0) return true;
    const hay = [
      group.paper,
      group.publisher,
      group.licence,
      group.need,
      group.doiUrl ?? "",
      ...group.rows.map((r) => `${r.figure} ${r.label} ${r.credit} ${r.status}`),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  });

  const filtering = filter !== "all" || terms.length > 0;

  async function setStatus(group: PermissionGroup, status: string) {
    let next = file.text!;
    for (const row of group.rows) next = setPermissionStatus(next, row.line, status);
    await file.save(next);
  }

  async function openOriginals() {
    setFolderNote(null);
    const papers = `${projectRoot.replace(/[\\/]+$/, "")}/papers`;
    await invoke("fs_create_dir", { root: papers, name: "figure-originals" }).catch(() => {});
    await revealItemInDir(`${papers}/figure-originals`).catch((reason) =>
      setFolderNote(`打不开 ${papers}/figure-originals：${String(reason)}`),
    );
  }

  const filterChips: Array<{ id: PermissionFilter; label: string; count?: number }> = [
    { id: "all", label: "全部", count: groups.length },
    ...(summary.pending > 0 ? [{ id: "待申请" as const, label: "仅看待申请", count: summary.pending }] : []),
    ...(summary.applied > 0 ? [{ id: "已申请" as const, label: "已申请", count: summary.applied }] : []),
    ...(summary.granted > 0 ? [{ id: "已获许可" as const, label: "已获许可", count: summary.granted }] : []),
    ...(summary.exempt > 0 ? [{ id: "无需申请" as const, label: "无需申请", count: summary.exempt }] : []),
    ...(summary.selfDrawn > 0 ? [{ id: "self" as const, label: "本稿自绘", count: summary.selfDrawn }] : []),
  ];

  return (
    <div className={fill ? "flex min-h-0 flex-1 flex-col text-xs" : "text-xs"}>
      {/* 顶部固定总览、进度、筛选与搜索 */}
      <div className="mb-2 shrink-0 space-y-1.5 border-b border-hairline pb-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-l3">
          <span className="tabular-nums">
            {summary.paperCount} 篇 · 待申请 {summary.pending} 篇 · 已申请 {summary.applied} · 已获许可 {summary.granted} · 无需申请 {summary.exempt}
            {summary.selfDrawn > 0 ? ` · 本稿自绘 ${summary.selfDrawn} 块` : ""}
          </span>
          {summary.paperCount > 0 && (
            <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-inset" aria-hidden="true">
              <div className="h-full rounded-full bg-done transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void openOriginals()}
              className="rounded-sm border border-field bg-strip px-1.5 py-0.5 text-micro text-l2 transition-colors hover:bg-hover hover:text-l1"
              title="期刊要出版社原图时，下载的高清原图放这里，文件名用「来源键-原图编号」"
            >
              原图文件夹
            </button>
            {!fill && onEnlarge && (
              <button
                type="button"
                onClick={onEnlarge}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-l3 transition-colors hover:bg-hover hover:text-l1"
                title="在大窗口里展开完整转载许可清单，方便搜索与复制图注出处"
              >
                <Maximize2 size={11} strokeWidth={1.8} aria-hidden="true" />
                <span>放大</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {filterChips.length > 2 &&
            filterChips.map((chip) => {
              const active = filter === chip.id;
              return (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => setFilter(active && chip.id !== "all" ? "all" : chip.id)}
                  className={`rounded-full border px-2 py-0.5 text-micro transition-colors ${
                    active
                      ? "border-cta-bd bg-cta-pill font-medium text-cta-pill-text"
                      : "border-hairline bg-inset/60 text-l3 hover:border-field hover:text-l1"
                  }`}
                >
                  {chip.label}
                  {chip.count != null ? ` ${chip.count}` : ""}
                </button>
              );
            })}
          <div className="ccode-search-shell ml-auto flex h-7 min-w-[9rem] max-w-[15rem] flex-1 items-center gap-1.5 rounded-md border border-field bg-inset/60 px-2 transition-colors focus-within:border-l3">
            <Search size={12} strokeWidth={1.8} className="shrink-0 text-l4" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜作者 / 期刊 / 图号 / 出版社…"
              aria-label="搜索许可清单"
              className="min-w-0 flex-1 bg-transparent text-micro text-l1 outline-none placeholder:text-l4 focus:outline-none focus-visible:outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label="清空许可搜索"
                onClick={() => setQuery("")}
                className="shrink-0 text-l4 hover:text-l1"
              >
                <X size={11} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
          {filtering && (
            <button
              type="button"
              onClick={() => {
                setFilter("all");
                setQuery("");
              }}
              className="text-micro text-l4 underline decoration-dotted underline-offset-2 hover:text-l1"
            >
              重置
            </button>
          )}
        </div>
      </div>

      {visibleGroups.length === 0 ? (
        <p className="py-4 text-center text-micro text-l4">
          没有匹配当前筛选条件的拼图来源。
          {filtering && (
            <button
              type="button"
              onClick={() => {
                setFilter("all");
                setQuery("");
              }}
              className="ml-1.5 underline decoration-dotted underline-offset-2 hover:text-l1"
            >
              显示全部
            </button>
          )}
        </p>
      ) : (
        <ul
          className={`${fill ? "min-h-0 flex-1" : "max-h-80"} space-y-2 overflow-y-auto overflow-x-hidden pr-1`}
        >
          {visibleGroups.map((group) => {
            const mixed = new Set(group.rows.map((r) => r.status)).size > 1;
            const status = mixed ? "" : group.rows[0].status;
            const doi = cleanDoiFromUrl(group.doiUrl);
            const credits = [...new Set(group.rows.map((r) => r.credit.trim()).filter(Boolean))];
            const creditText = credits.join("；");
            const doiCopied = copiedKey === `doi:${group.key}`;
            const creditCopied = copiedKey === `credit:${group.key}`;
            return (
              <li
                key={group.key}
                className="border-t border-hairline pt-2 first:border-t-0 first:pt-0"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p
                      className={fill ? "text-xs leading-5 text-l1" : "truncate text-l1"}
                      title={group.paper}
                    >
                      {fill ? group.paper.replace(/\*/g, "") : shortCite(group.paper)}
                    </p>
                    <p
                      className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-micro text-l4"
                      title={group.rows.map((r) => `图 ${r.figure} ← ${r.label}：${r.credit}`).join("\n")}
                    >
                      <span>
                        图 {group.rows.map((r) => r.figure).join("、")} ← {group.rows.map((r) => r.label).join("、")}
                      </span>
                      <span>·</span>
                      <span>
                        {group.selfDrawn
                          ? group.licence
                          : `${group.publisher} · ${group.licence || "许可未查到"}`}
                      </span>
                      {!group.selfDrawn && group.need && (
                        <>
                          <span>·</span>
                          <span className="text-l3">{group.need}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {doi && (
                      <button
                        type="button"
                        onClick={() => copyWithFeedback(`doi:${group.key}`, doi)}
                        title={`复制 DOI：${doi}`}
                        className="inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-micro text-l4 transition-colors hover:bg-hover hover:text-l1"
                      >
                        {doiCopied ? (
                          <Check size={10} strokeWidth={2.2} className="text-done" aria-hidden="true" />
                        ) : (
                          <Copy size={10} strokeWidth={1.8} aria-hidden="true" />
                        )}
                        <span>{doiCopied ? "已复制" : "DOI"}</span>
                      </button>
                    )}
                    {group.doiUrl && (
                      <button
                        type="button"
                        onClick={() => void openUrl(group.doiUrl!).catch(() => {})}
                        title="打开文章页：找 Request permissions / Rights and permissions（多数走 RightsLink）申请；要原图也在这里下载"
                        className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-micro text-l3 transition-colors hover:bg-hover hover:text-l1"
                      >
                        文章页
                        <ExternalLink size={11} strokeWidth={1.8} aria-hidden="true" />
                      </button>
                    )}
                    {group.selfDrawn ? (
                      <span className="shrink-0 px-1.5 py-0.5 text-micro text-l4">无需申请</span>
                    ) : (
                      <select
                        value={status}
                        disabled={file.saving}
                        onChange={(event) => void setStatus(group, event.target.value)}
                        aria-label={`${shortCite(group.paper)} 的状态`}
                        className={`shrink-0 rounded-sm border bg-canvas px-1.5 py-0.5 text-xs outline-none ${statusSelectTone(status)}`}
                      >
                        {mixed && <option value="">各块不同</option>}
                        {PERMISSION_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
                {creditText && (
                  <div className="mt-1 flex items-start gap-2 rounded-sm bg-inset/45 px-2 py-1 text-micro text-l3">
                    <p
                      className={fill ? "min-w-0 flex-1 leading-5" : "min-w-0 flex-1 truncate leading-5"}
                      title={creditText}
                    >
                      <span className="text-l4">图注出处：</span>
                      {creditText}
                    </p>
                    <button
                      type="button"
                      onClick={() => copyWithFeedback(`credit:${group.key}`, creditText)}
                      title="复制图注出处文本"
                      className="inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-micro text-l4 transition-colors hover:bg-hover hover:text-l1"
                    >
                      {creditCopied ? (
                        <Check size={10} strokeWidth={2.2} className="text-done" aria-hidden="true" />
                      ) : (
                        <Copy size={10} strokeWidth={1.8} aria-hidden="true" />
                      )}
                      <span>{creditCopied ? "已复制" : "复制"}</span>
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(file.error || folderNote) && (
        <InlineNotice tone="err" size="micro" className="mt-1.5 shrink-0">
          {file.error ?? folderNote}
        </InlineNotice>
      )}
    </div>
  );
}

/** 按「## 小标题」一节一个框，离开框就存（不用找「保存」，也不会丢）。投稿声明、投稿前清单、数据字典都用它；
 *  文件没分节时显示 fallback（原文编辑） */
export const DeclarationsForm = forwardRef<
  DeclarationsFormHandle,
  {
    root: string;
    rel: string;
    fallback?: ReactNode;
    fill?: boolean;
    onMeta?: (meta: DeclarationsSummary) => void;
    onEnlarge?: () => void;
    refreshKey?: string;
  }
>(function DeclarationsForm(
  { root, rel, fallback, fill = false, onMeta, onEnlarge, refreshKey },
  ref,
) {
  const file = useStepFile(root, rel, refreshKey);
  const parsed = useMemo(() => parseDeclarations(file.text ?? ""), [file.text]);
  const [drafts, setDrafts] = useState<DeclarationSection[] | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [onlyPending, setOnlyPending] = useState(false);
  const sectionRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;
  const fileTextRef = useRef(file.text);
  fileTextRef.current = file.text;
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;

  useEffect(() => {
    setDrafts(parsed);
  }, [parsed]);

  const filledCount = useMemo(
    () => (drafts ?? []).filter((s) => s.body.trim().length > 0).length,
    [drafts],
  );
  const totalCount = drafts?.length ?? 0;
  const pendingCount = Math.max(0, totalCount - filledCount);

  useEffect(() => {
    if (file.text != null && drafts != null) {
      onMetaRef.current?.({ total: totalCount, filled: filledCount, pending: pendingCount });
    }
  }, [file.text, drafts, totalCount, filledCount, pendingCount]);

  async function saveIfChanged(): Promise<boolean> {
    const cur = draftsRef.current;
    const base = parsedRef.current;
    const raw = fileTextRef.current;
    if (!cur || raw == null) return true;
    if (cur.every((s, i) => s.body === base[i]?.body)) return true;
    const ok = await file.save(writeDeclarations(raw, cur));
    if (ok) setSavedAt(new Date().toLocaleTimeString());
    return ok;
  }

  useImperativeHandle(ref, () => ({
    flushSave: () => saveIfChanged(),
  }));

  if (file.text == null || drafts == null) {
    return file.error ? (
      <InlineNotice tone="err" size="micro">{file.error}</InlineNotice>
    ) : (
      <p className="text-micro text-l4">读取声明…</p>
    );
  }
  if (drafts.length === 0) {
    return fallback ?? (
      <p className="text-micro text-l4">这份文件里没有「## 小标题」分节，回对话让 AI 按模板重写。</p>
    );
  }

  const pct = totalCount > 0 ? Math.min(100, Math.round((filledCount / totalCount) * 100)) : 100;
  const shownSections = drafts
    .map((section, idx) => ({ section, idx }))
    .filter(({ section }) => !onlyPending || !section.body.trim());

  function jumpToSection(heading: string) {
    if (onlyPending) setOnlyPending(false);
    window.setTimeout(() => {
      const el = sectionRefs.current[heading];
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus();
    }, 0);
  }

  return (
    <div className={fill ? "flex min-h-0 flex-1 flex-col text-xs" : "text-xs"}>
      {/* 顶部固定进度条 + 各节快捷定位胶囊 */}
      <div className="mb-2 shrink-0 space-y-1.5 border-b border-hairline pb-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-l3">
          <span className="tabular-nums">
            已填 {filledCount} / {totalCount} 节
            {pendingCount > 0 ? <span className="ml-1 text-l4">（待填 {pendingCount}）</span> : null}
          </span>
          <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-inset" aria-hidden="true">
            <div className="h-full rounded-full bg-done transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          {pendingCount > 0 && filledCount > 0 && (
            <button
              type="button"
              onClick={() => setOnlyPending((v) => !v)}
              className={`rounded-full border px-2 py-0.5 text-micro transition-colors ${
                onlyPending
                  ? "border-cta-bd bg-cta-pill font-medium text-cta-pill-text"
                  : "border-hairline bg-inset/60 text-l3 hover:border-field hover:text-l1"
              }`}
            >
              仅看待填 {pendingCount}
            </button>
          )}
          <span className="ml-auto text-micro text-l4">
            {file.saving ? "保存中…" : savedAt ? `已保存 ${savedAt}` : "离开输入框自动保存"}
          </span>
          {!fill && onEnlarge && (
            <button
              type="button"
              onClick={() => {
                void saveIfChanged().then(() => onEnlarge());
              }}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-l3 transition-colors hover:bg-hover hover:text-l1"
              title="在大窗口里展开完整声明表单，方便长段填写与核对"
            >
              <Maximize2 size={11} strokeWidth={1.8} aria-hidden="true" />
              <span>放大</span>
            </button>
          )}
        </div>

        {drafts.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            {drafts.map((section) => {
              const done = section.body.trim().length > 0;
              return (
                <button
                  key={section.heading}
                  type="button"
                  onClick={() => jumpToSection(section.heading)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro transition-colors ${
                    done
                      ? "border-done/35 bg-ok text-ok-text hover:brightness-105"
                      : "border-hairline bg-inset/60 text-l3 hover:border-field hover:text-l1"
                  }`}
                >
                  {done && <Check size={10} strokeWidth={2.4} aria-hidden="true" />}
                  <span>{section.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 各节输入框滚动区 */}
      <div
        className={`${fill ? "min-h-0 flex-1" : "max-h-96"} space-y-2.5 overflow-y-auto pr-1`}
      >
        {shownSections.length === 0 ? (
          <p className="py-4 text-center text-micro text-l4">
            全部 {totalCount} 节已填写。
            <button
              type="button"
              onClick={() => setOnlyPending(false)}
              className="ml-1.5 underline decoration-dotted underline-offset-2 hover:text-l1"
            >
              查看全部
            </button>
          </p>
        ) : (
          shownSections.map(({ section, idx }) => {
            const done = section.body.trim().length > 0;
            const lineCount = section.body.split("\n").length;
            const rows = fill
              ? Math.min(12, Math.max(3, lineCount + 1))
              : Math.min(8, Math.max(2, lineCount + 1));
            return (
              <label key={section.heading} className="block">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <span className="text-micro font-medium text-l2">{section.label}</span>
                  <span
                    className={`rounded-sm px-1 py-px text-micro ${
                      done ? "bg-ok text-ok-text" : "bg-warn text-warn-text"
                    }`}
                  >
                    {done ? "已填" : "待填"}
                  </span>
                </div>
                {section.hint && (
                  <p className="mb-1 text-micro leading-4 text-l4">{section.hint}</p>
                )}
                <textarea
                  ref={(el) => {
                    sectionRefs.current[section.heading] = el;
                  }}
                  value={section.body}
                  rows={rows}
                  placeholder={section.hint || "待填"}
                  onChange={(event) =>
                    setDrafts((cur) =>
                      cur ? cur.map((s, j) => (j === idx ? { ...s, body: event.target.value } : s)) : cur,
                    )
                  }
                  onBlur={() => void saveIfChanged()}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                      event.preventDefault();
                      void saveIfChanged();
                    }
                  }}
                  className="w-full rounded-md border border-field bg-canvas px-2.5 py-1.5 text-xs leading-relaxed text-l1 outline-none placeholder:text-l4 focus:border-cta-bd"
                />
              </label>
            );
          })
        )}
        <p className="text-micro text-l4">
          空着的节会留成「待填」，不进稿件。
        </p>
      </div>

      {file.error && (
        <InlineNotice tone="err" size="micro" className="mt-1.5 shrink-0">
          {file.error}
        </InlineNotice>
      )}
    </div>
  );
});
