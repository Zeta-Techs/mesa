import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronUp, ExternalLink, Search, X } from "lucide-react";
import type { DirEntryDto } from "./FileTree";
import { confirmDialog } from "./ConfirmDialog";
import { researchAbsolutePath } from "../research-report";
import { readResearchFile, readResearchLedger, saveResearchLedger } from "../research-report-load";
import { commitProjectLedger } from "../ledger-commit";
import { toast } from "../toast";
import {
  cachedJournalMetric,
  forgetJournalMetrics,
  journalMetricTone,
  rememberJournalMetrics,
  type JournalMetricsDto,
  type JournalMetricsStatusDto,
  type JournalMetricsUpdateDto,
} from "../lit-watch";
import {
  appendEndnoteImportRecord,
  appendZoteroImportRecord,
  appendToFetchEntry,
  bibMentionsRecord,
  confirmReason,
  displayCitationTitle,
  doiToken,
  hasReadableAbstract,
  includedMdLine,
  includedRecordKey,
  includedRecordMeta,
  arrangeScreeningRows,
  includeAllPendingJson,
  isSuggestedExclude,
  matchPaperPdf,
  matchesScreeningFilter,
  matchesScreeningQuery,
  patchIncludedJsonMany,
  pickRangeKeys,
  type ScreeningQuickFilter,
  type ScreeningSort,
  notePathForRecord,
  paperHasDoiPdf,
  parseIncludedRecords,
  patchIncludedJson,
  patchIncludedMd,
  pendingConfirmCleared,
  removeReason,
  restorePendingReason,
  syncIncludedSummary,
  type IncludedRecord,
  KIND_LABEL,
  nextKind,
  patchIncludedKind,
  newFirst,
  newRecordKeys,
} from "../screening-review";
import { InlineNotice } from "./PageFrame";

/** 读台账：工作区优先、项目根兜底。走台账通道整份读——预览通道 256 KB 截断后
 *  这里曾把「文件太大」当成「文件不存在」，两百篇的清单显示「还没有 included.json」。 */
async function readFirst(roots: string[], rel: string) {
  for (const root of roots) {
    try {
      const file = await readResearchLedger(root, rel);
      if (!file.truncated) return { root, file };
    } catch {
      /* 试下一处 */
    }
  }
  return null;
}

/** 已纳入先列多少篇；只多出几篇时不折（折了反而多点一下） */
const INCLUDED_PREVIEW = 20;
const INCLUDED_FOLD_SLACK = 5;

interface PendingConfirmCacheEntry {
  records: IncludedRecord[];
  newKeys: Set<string>;
  jsonRoot: string;
  jsonText: string;
  jsonRevision: string | null;
  mdText: string | null;
  mdRevision: string | null;
  pdfFiles: { name: string; path: string }[];
  metricsReady: boolean | null;
}

/** 切步骤时 StepFlow 按 key 重挂，保留最近读到的文献清单快照，首帧直接渲染不闪「加载文献清单…」。 */
const pendingConfirmCache = new Map<string, PendingConfirmCacheEntry>();

function cachedRowMetrics(rows: IncludedRecord[] | null | undefined): Map<string, JournalMetricsDto | null> {
  const out = new Map<string, JournalMetricsDto | null>();
  if (!rows) return out;
  for (const row of rows) {
    const doi = doiToken(row.id, row.url);
    if (!doi) continue;
    const hit = cachedJournalMetric(doi);
    if (hit !== undefined) out.set(includedRecordKey(row), hit);
  }
  return out;
}

export type PendingConfirmHandle = {
  includeAll: () => void;
};

export default forwardRef<PendingConfirmHandle, {
  worktreePath?: string | null;
  projectRoot: string;
  onOpenPdf?: (path: string) => void;
  onChanged?: () => void;
  /** 清单里已经没有待确认时调用。人手取消过勾选的由调用方决定是否忽略。 */
  onCleared?: () => void;
  onMeta?: (meta: { count: number; busy: boolean }) => void;
  /** 审阅清单页占满剩余高度，不再自己截成一块再留出底下空区。 */
  fill?: boolean;
  /** 变了就重读。退回修改后 agent 在同一工作区补文献，项目页常驻不卸载，不重读就一直是旧清单。 */
  refreshKey?: string;
  /** 这一步已保存进项目、清单直接写项目根时为 true：每次改完把动到的台账提交进项目，免得项目一直是脏的 */
  commitToProject?: boolean;
}>(function PendingConfirmList({
  worktreePath,
  projectRoot,
  onOpenPdf,
  onChanged,
  onCleared,
  onMeta,
  fill = false,
  refreshKey,
  commitToProject = false,
}, ref) {
  const roots = [...new Set([worktreePath, projectRoot].filter((p): p is string => Boolean(p)))];
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [includingAll, setIncludingAll] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedIncluded, setPickedIncluded] = useState<Set<string>>(new Set());
  // 排序按项目记在本机：人设好影响因子排序后，移出 / 恢复 / 重开评审都不该回到默认（2026-11-10 HER）
  const sortKey = `mesa.screeningSort:${projectRoot ?? worktreePath ?? ""}`;
  const [sortMode, setSortModeState] = useState<ScreeningSort>(() => {
    try {
      const v = localStorage.getItem(sortKey);
      return v === "if-desc" || v === "if-asc" ? v : "listed";
    } catch {
      return "listed";
    }
  });
  const setSortMode = (next: ScreeningSort) => {
    setSortModeState(next);
    try {
      localStorage.setItem(sortKey, next);
    } catch {
      /* 存不下只是这次有效 */
    }
  };
  const cacheKey = roots.join("\n");
  const cached = pendingConfirmCache.get(cacheKey);
  const [records, setRecords] = useState<IncludedRecord[] | null>(() => cached?.records ?? null);
  // 这一轮新加的篇：评审的工作副本里有、项目根（上一轮保存的）里没有；标「本轮新增」并排前面
  const [newKeys, setNewKeys] = useState<Set<string>>(() => new Set(cached?.newKeys ?? []));
  const [jsonRoot, setJsonRoot] = useState(() => cached?.jsonRoot ?? projectRoot);
  const [jsonText, setJsonText] = useState(() => cached?.jsonText ?? "");
  const [jsonRevision, setJsonRevision] = useState<string | null>(() => cached?.jsonRevision ?? null);
  const [mdText, setMdText] = useState<string | null>(() => cached?.mdText ?? null);
  const [mdRevision, setMdRevision] = useState<string | null>(() => cached?.mdRevision ?? null);
  const [pdfFiles, setPdfFiles] = useState<{ name: string; path: string }[]>(() => cached?.pdfFiles ?? []);
  const [metrics, setMetrics] = useState<Map<string, JournalMetricsDto | null>>(() => cachedRowMetrics(cached?.records));
  const [metricsReady, setMetricsReady] = useState<boolean | null>(() => cached?.metricsReady ?? null);
  const [metricsAutoPreparing, setMetricsAutoPreparing] = useState(false);
  const [metricsUpdate, setMetricsUpdate] = useState<JournalMetricsUpdateDto | null>(null);
  const [metricsNote, setMetricsNote] = useState<string | null>(null);
  const [metricsBusy, setMetricsBusy] = useState(false);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [excludedOpen, setExcludedOpen] = useState(false);
  const [includedAllOpen, setIncludedAllOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [quickFilter, setQuickFilter] = useState<ScreeningQuickFilter>("all");
  const [openAbstracts, setOpenAbstracts] = useState<Set<string>>(new Set());
  const pendingAnchorRef = useRef<string | null>(null);
  const includedAnchorRef = useRef<string | null>(null);
  const pendingSecRef = useRef<HTMLElement | null>(null);
  const includedSecRef = useRef<HTMLElement | null>(null);
  const excludedSecRef = useRef<HTMLElement | null>(null);
  /** 这次展开里逐篇拍过板的篇目，原地留在待确认里改显结果：一抽走，下面每篇都往上窜一行，
   *  连着点时点到的就不是想点的那篇。值是拍板前那一行（理由会加前缀变长，显示用旧的保持行高）。 */
  const [settled, setSettled] = useState<Map<string, IncludedRecord>>(new Map());
  // 这次在「已纳入」里点了移出的：留在原位置、压暗写「已移出」，不让下面的行顶上来（2026-11-10 HER 审阅：移出时顺序跳变）
  const [removedHere, setRemovedHere] = useState<Set<string>>(new Set());
  // 这次在「已排除」里恢复为待确认的：同样留在原位写结果，不让已排除列表跳
  const [restoredHere, setRestoredHere] = useState<Set<string>>(new Set());
  // 这次动作写过项目根的哪些台账（commitToProject 时动作收尾一并提交）
  const touchedRef = useRef<Set<string>>(new Set());
  const onClearedRef = useRef(onCleared);
  onClearedRef.current = onCleared;
  const recordsRef = useRef(records);
  recordsRef.current = records;

  async function load() {
    setError(null);
    setSettled(new Map());
    setRemovedHere(new Set());
    setRestoredHere(new Set());
    const json = await readFirst(roots, "papers/included.json");
    if (!json) {
      setRecords([]);
      setError("还没有纳入清单，AI 筛完才有。");
      return;
    }
    setJsonRoot(json.root);
    setJsonText(json.file.text);
    setJsonRevision(json.file.revision);
    setRecords(parseIncludedRecords(json.file.text));
    const base = sameRoot(json.root, projectRoot)
      ? null
      : await readResearchLedger(projectRoot, "papers/included.json").catch(() => null);
    setNewKeys(newRecordKeys(parseIncludedRecords(json.file.text), base && !base.truncated ? base.text : null));
    const md = await readFirst([json.root, ...roots], "papers/included.md");
    setMdText(md?.file.text ?? null);
    setMdRevision(md?.file.revision ?? null);
    const listed = await Promise.all(
      roots.map((dir) =>
        invoke<DirEntryDto[]>("list_dir", {
          path: `${dir.replace(/[\\/]+$/, "")}/papers`,
          showHidden: false,
          root: dir,
        }).catch(() => [] as DirEntryDto[]),
      ),
    );
    const pdfs: { name: string; path: string }[] = [];
    const seen = new Set<string>();
    for (const entries of listed) {
      for (const entry of entries) {
        if (entry.isDir || !entry.name.toLowerCase().endsWith(".pdf")) continue;
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        pdfs.push({ name: entry.name, path: entry.path });
      }
    }
    setPdfFiles(pdfs);
    if (pendingConfirmCleared(parseIncludedRecords(json.file.text))) onClearedRef.current?.();
    void loadMetrics(parseIncludedRecords(json.file.text));
  }

  async function loadMetrics(rows: IncludedRecord[]) {
    const needsRemote = rows.some(
      (row) => (!row.source || row.source === "待补") && Boolean(doiToken(row.id, row.url)),
    );
    if (needsRemote) setMetricsLoading(true);
    try {
      const status = await invoke<JournalMetricsStatusDto>("journal_metrics_status");
      setMetricsReady(status.available);
      setMetricsAutoPreparing(Boolean(status.downloading));
      if (status.available) void checkMetricsUpdate();
      if (!status.available || rows.length === 0) {
        setMetrics(new Map());
        return;
      }
      const queries = rows.map((row) => ({
        venue: row.source === "待补" ? "" : row.source,
        issn: row.issn === "待补" ? "" : row.issn,
        doi: doiToken(row.id, row.url),
      }));
      const next = new Map<string, JournalMetricsDto | null>();
      const pending: { key: string; query: (typeof queries)[number] }[] = [];
      rows.forEach((row, index) => {
        const key = includedRecordKey(row);
        const hit = cachedJournalMetric(queries[index]?.doi ?? "");
        if (hit !== undefined) next.set(key, hit);
        else pending.push({ key, query: queries[index]! });
      });
      if (pending.length > 0) {
        const found = await invoke<(JournalMetricsDto | null)[]>("lookup_journal_metrics", {
          queries: pending.map((row) => row.query),
        });
        rememberJournalMetrics(pending.map((row) => row.query), found);
        pending.forEach((row, index) => next.set(row.key, found[index] ?? null));
      }
      setMetrics(next);
    } catch {
      setMetricsReady(null);
    } finally {
      setMetricsLoading(false);
    }
  }

  async function checkMetricsUpdate() {
    try {
      const update = await invoke<JournalMetricsUpdateDto>("check_journal_metrics_update");
      setMetricsUpdate(update);
      setMetricsNote(update.hasUpdate ? "上游有新版。" : "已是最新，不用更新。");
    } catch {
      setMetricsUpdate(null);
      setMetricsNote("没能连上上游，看不出有没有新版。");
    }
  }

  async function downloadMetrics() {
    setMetricsBusy(true);
    setMetricsNote(null);
    setError(null);
    try {
      forgetJournalMetrics();
      const status = await invoke<JournalMetricsStatusDto>("download_journal_metrics");
      setMetricsReady(status.available);
      setMetricsNote(`已更新，${status.journalCount} 种期刊。`);
      setMetricsUpdate({ upstreamUpdatedAt: null, hasUpdate: false });
      if (records) await loadMetrics(records);
    } catch (reason) {
      setMetricsNote(`更新失败：${String(reason)}`);
    } finally {
      setMetricsBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [worktreePath, projectRoot, refreshKey]);

  useEffect(() => {
    if (records == null) return;
    pendingConfirmCache.set(cacheKey, {
      records,
      newKeys,
      jsonRoot,
      jsonText,
      jsonRevision,
      mdText,
      mdRevision,
      pdfFiles,
      metricsReady,
    });
  }, [cacheKey, records, newKeys, jsonRoot, jsonText, jsonRevision, mdText, mdRevision, pdfFiles, metricsReady]);

  useEffect(() => {
    let stale = false;
    let unlisten: (() => void) | undefined;
    listen<JournalMetricsStatusDto>("journal-metrics-updated", (e) => {
      if (stale) return;
      forgetJournalMetrics();
      setMetricsAutoPreparing(Boolean(e.payload?.downloading));
      if (e.payload) setMetricsReady(e.payload.available);
      setMetricsUpdate({ upstreamUpdatedAt: null, hasUpdate: false });
      if (recordsRef.current) void loadMetrics(recordsRef.current);
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => {
      stale = true;
      unlisten?.();
    };
  }, []);

  const pending = (records ?? []).filter((row) => row.decision === "pending");
  function shown(rows: IncludedRecord[]) {
    return newFirst(
      arrangeScreeningRows(rows, (row) => metrics.get(includedRecordKey(row)), sortMode, null),
      (row) => newKeys.has(includedRecordKey(row)),
    );
  }
  const included = (records ?? []).filter((row) => row.decision === "included");
  const excluded = (records ?? []).filter((row) => row.decision === "excluded");

  useEffect(() => {
    onMeta?.({ count: pending.length, busy: includingAll || busyKey != null });
  }, [pending.length, includingAll, busyKey]);

  const sameRoot = (a: string, b: string) => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
  /** 写台账并记下写过哪份（只记写在项目根的） */
  async function save(root: string, rel: string, text: string, revision: string): Promise<string> {
    const next = await saveResearchLedger(root, rel, text, revision);
    if (sameRoot(root, projectRoot)) touchedRef.current.add(rel);
    return next;
  }
  /** 动作收尾：已保存的步骤把这次写过的台账提交进项目；失败只提示，不撤销已经做完的改动 */
  async function commitTouched() {
    const touched = [...touchedRef.current];
    touchedRef.current = new Set();
    if (!commitToProject || touched.length === 0) return;
    const note = await commitProjectLedger(projectRoot, touched);
    if (note) setError((prev) => (prev ? `${prev}${note}` : note));
  }

  async function appendImport(rows: IncludedRecord[]) {
    const file = await readFirst([jsonRoot, ...roots], "papers/endnote-import.ris");
    if (!file?.file.revision) return;
    const chunks: string[] = [];
    for (const root of [file.root, ...roots]) {
      const listed = await invoke<DirEntryDto[]>("list_dir", {
        path: researchAbsolutePath(root, "papers/imports"),
        showHidden: false,
        root,
      }).catch(() => [] as DirEntryDto[]);
      for (const entry of listed) {
        if (entry.isDir || !entry.name.toLowerCase().endsWith(".ris")) continue;
        const text = await readResearchFile(root, `papers/imports/${entry.name}`).catch(() => null);
        if (text && !text.truncated) chunks.push(text.text);
      }
      if (chunks.length > 0) break;
    }
    const source = chunks.join("\n");
    let next = file.file.text;
    for (const row of rows) next = appendEndnoteImportRecord(next, row, source);
    if (next !== file.file.text) {
      await save(file.root, "papers/endnote-import.ris", next, file.file.revision);
    }
    const zotero = await readFirst([file.root, ...roots], "papers/to-fetch.ris");
    if (!zotero?.file.revision) return;
    let znext = zotero.file.text;
    for (const row of rows) znext = appendZoteroImportRecord(znext, row, source);
    if (znext === zotero.file.text) return;
    await save(zotero.root, "papers/to-fetch.ris", znext, zotero.file.revision);
  }

  async function dropOne(
    command: "drop_fetch_line" | "drop_ris_record",
    rel: string,
    row: IncludedRecord,
  ): Promise<"ok" | "missing" | "failed"> {
    try {
      await invoke<boolean>(command, {
        path: researchAbsolutePath(jsonRoot, rel),
        root: jsonRoot,
        doi: doiToken(row.id, row.url),
        title: row.title,
      });
      if (sameRoot(jsonRoot, projectRoot)) touchedRef.current.add(rel);
      return "ok";
    } catch (reason) {
      const text = String(reason);
      if (text.includes("文件不存在")) return "missing";
      return "failed";
    }
  }

  /** 纳入清单已经改完之后，再从待获取和两份 RIS 拿掉。大文件不走 256 KB 预览。 */
  async function dropScreeningCopies(rows: IncludedRecord[]): Promise<string> {
    const missing = new Set<string>();
    const failed = new Set<string>();
    for (const row of rows) {
      const jobs: ["drop_fetch_line" | "drop_ris_record", string][] = [
        ["drop_fetch_line", "papers/to-fetch.md"],
        ["drop_ris_record", "papers/to-fetch.ris"],
        ["drop_ris_record", "papers/endnote-import.ris"],
      ];
      for (const [command, rel] of jobs) {
        const result = await dropOne(command, rel, row);
        const name = rel.split("/").pop() ?? rel;
        if (result === "missing") missing.add(name);
        if (result === "failed") failed.add(name);
      }
    }
    const bits = [
      missing.size > 0 ? `项目里没有 ${[...missing].join("、")}。` : "",
      failed.size > 0 ? `${[...failed].join("、")} 没能改掉，纳入清单已经移出。` : "",
    ].filter(Boolean);
    return bits.join("");
  }

  async function leftoverNote(row: IncludedRecord): Promise<string | null> {
    const notes: string[] = [];
    const index = await readFirst([jsonRoot, ...roots], "notes/index.json");
    if (index && notePathForRecord(index.file.text, row.id)) notes.push("笔记");
    const bib = await readFirst([jsonRoot, ...roots], "references.bib");
    if (bib && bibMentionsRecord(bib.file.text, row)) notes.push("引文");
    if (notes.length === 0) return null;
    return `这篇的${notes.join("和")}还在，要清到精读那一步处理。`;
  }

  async function removeRow(row: IncludedRecord) {
    if (!jsonRevision) return;
    const key = includedRecordKey(row);
    setBusyKey(key);
    setError(null);
    try {
      const nextJson = patchIncludedJson(jsonText, key, "excluded", removeReason(row.reason));
      const nextJsonRev = await save(jsonRoot, "papers/included.json", nextJson, jsonRevision);
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      const nextRecords = parseIncludedRecords(nextJson);
      setRecords(nextRecords);
      if (row.decision === "included") setRemovedHere((prev) => new Set(prev).add(key));
      setMetrics((prev) => {
        const copy = new Map(prev);
        if (!copy.has(key)) copy.set(key, null);
        return copy;
      });
      if (mdText != null && mdRevision) {
        const nextMd = syncIncludedSummary(
          patchIncludedMd(mdText, row.title, "excluded", includedMdLine(row)),
          parseIncludedRecords(nextJson),
        );
        const nextMdRev = await save(jsonRoot, "papers/included.md", nextMd, mdRevision);
        setMdText(nextMd);
        setMdRevision(nextMdRev);
      }
      const dropped = await dropScreeningCopies([row]);
      const leftover = await leftoverNote(row);
      const bits = [dropped, leftover ?? ""].filter(Boolean);
      if (bits.length > 0) setError(bits.join(""));
      onChanged?.();
      if (pendingConfirmCleared(nextRecords)) onClearedRef.current?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      await commitTouched();
      setBusyKey(null);
    }
  }

  async function restoreRow(row: IncludedRecord) {
    if (!jsonRevision) return;
    const key = includedRecordKey(row);
    setBusyKey(key);
    setError(null);
    try {
      const nextJson = patchIncludedJson(jsonText, key, "pending", restorePendingReason(row.reason));
      const nextJsonRev = await save(jsonRoot, "papers/included.json", nextJson, jsonRevision);
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      setRecords(parseIncludedRecords(nextJson));
      setRestoredHere((prev) => new Set(prev).add(key));
      setRemovedHere((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      if (mdText != null && mdRevision) {
        const nextMd = syncIncludedSummary(
          patchIncludedMd(mdText, row.title, "pending", includedMdLine(row)),
          parseIncludedRecords(nextJson),
        );
        const nextMdRev = await save(jsonRoot, "papers/included.md", nextMd, mdRevision);
        setMdText(nextMd);
        setMdRevision(nextMdRev);
      }
      onChanged?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      await commitTouched();
      setBusyKey(null);
    }
  }

  /** 改一篇的类型（综述回路三期 §7.1）：只写 included.json 的 kind，清单与 RIS 不变 */
  async function patchKind(row: IncludedRecord, kind: "review" | "research" | "other") {
    if (!jsonRevision) return;
    const key = includedRecordKey(row);
    setBusyKey(key);
    setError(null);
    try {
      const nextJson = patchIncludedKind(jsonText, key, kind);
      const nextJsonRev = await save(jsonRoot, "papers/included.json", nextJson, jsonRevision);
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      setRecords(parseIncludedRecords(nextJson));
    } catch (reason) {
      setError(`改类型失败：${String(reason)}`);
    } finally {
      await commitTouched();
      setBusyKey(null);
    }
  }

  async function confirmRow(row: IncludedRecord, decision: "included" | "excluded", fromUndoRemove = false) {
    if (!jsonRevision) return;
    const key = includedRecordKey(row);
    setBusyKey(key);
    setError(null);
    const reason = confirmReason(decision, row.reason);
    try {
      const nextJson = patchIncludedJson(jsonText, key, decision, reason);
      const nextJsonRev = await save(jsonRoot, "papers/included.json", nextJson, jsonRevision);
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      if (fromUndoRemove) {
        setRemovedHere((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      } else {
        setSettled((prev) => (prev.has(key) ? prev : new Map(prev).set(key, row)));
      }
      setRecords(parseIncludedRecords(nextJson));
      if (mdText != null && mdRevision) {
        const nextMd = syncIncludedSummary(
        patchIncludedMd(mdText, row.title, decision, includedMdLine(row)),
        parseIncludedRecords(nextJson),
      );
        const nextMdRev = await save(jsonRoot, "papers/included.md", nextMd, mdRevision);
        setMdText(nextMd);
        setMdRevision(nextMdRev);
      }
      if (decision === "included" && !paperHasDoiPdf(row, pdfFiles)) {
        await appendImport([row]);
        const fetch = await readFirst([jsonRoot, ...roots], "papers/to-fetch.md");
        if (!fetch?.file.revision) {
          setError("已纳入，但没有可写入的 to-fetch.md，无法追加待获取。");
        } else {
          const nextFetch = appendToFetchEntry(fetch.file.text, row);
          if (nextFetch !== fetch.file.text) {
            await save(fetch.root, "papers/to-fetch.md", nextFetch, fetch.file.revision);
          }
        }
      }
      onChanged?.();
      if (pendingConfirmCleared(parseIncludedRecords(nextJson))) onClearedRef.current?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      await commitTouched();
      setBusyKey(null);
    }
  }

  async function applyMany(
    rows: IncludedRecord[],
    decision: "included" | "excluded" | "pending",
    reasonFor: (previous: string) => string,
    confirmBulkRemove = false,
  ) {
    if (!jsonRevision || rows.length === 0) return;
    if (confirmBulkRemove && rows.length > 5) {
      const ok = await confirmDialog(
        `确定把选中的 ${rows.length} 篇已纳入文献移出清单吗？移出后会移到最下方的「已排除」，随时可以恢复；已有笔记和引文不动。`,
        { confirmText: `移出这 ${rows.length} 篇` },
      );
      if (!ok) return;
    }
    setIncludingAll(true);
    setError(null);
    try {
      const nextJson = patchIncludedJsonMany(
        jsonText,
        rows.map((row) => includedRecordKey(row)),
        decision,
        reasonFor,
      );
      const nextJsonRev = await save(jsonRoot, "papers/included.json", nextJson, jsonRevision);
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      setRecords(parseIncludedRecords(nextJson));
      setSettled(new Map());
      let nextMd = mdText;
      let nextMdRev = mdRevision;
      if (nextMd != null && nextMdRev) {
        for (const row of rows) {
          nextMd = patchIncludedMd(nextMd, row.title, decision, includedMdLine(row));
        }
        nextMd = syncIncludedSummary(nextMd, parseIncludedRecords(nextJson));
        nextMdRev = await save(jsonRoot, "papers/included.md", nextMd, nextMdRev);
        setMdText(nextMd);
        setMdRevision(nextMdRev);
      }
      if (decision === "included") {
        const missing = rows.filter((row) => !paperHasDoiPdf(row, pdfFiles));
        if (missing.length > 0) {
          await appendImport(missing);
          const fetch = await readFirst([jsonRoot, ...roots], "papers/to-fetch.md");
          if (!fetch?.file.revision) {
            setError("已纳入，但没有可写入的 to-fetch.md，缺 PDF 的篇目没进待获取。");
          } else {
            let nextFetch = fetch.file.text;
            for (const row of missing) nextFetch = appendToFetchEntry(nextFetch, row);
            if (nextFetch !== fetch.file.text) {
              await save(fetch.root, "papers/to-fetch.md", nextFetch, fetch.file.revision);
            }
          }
        }
      }
      if (decision === "excluded") {
        const note = await dropScreeningCopies(rows);
        if (note) setError(note);
      }
      setPicked(new Set());
      setPickedIncluded(new Set());
      onChanged?.();
      if (pendingConfirmCleared(parseIncludedRecords(nextJson))) onClearedRef.current?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      await commitTouched();
      setIncludingAll(false);
    }
  }

  async function includeAll() {
    if (!jsonRevision || pending.length === 0) return;
    setIncludingAll(true);
    setError(null);
    try {
      const nextJson = includeAllPendingJson(jsonText);
      const nextJsonRev = await save(jsonRoot, "papers/included.json", nextJson, jsonRevision);
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      setRecords(parseIncludedRecords(nextJson));
      setSettled(new Map());
      let nextMd = mdText;
      let nextMdRev = mdRevision;
      if (nextMd != null && nextMdRev) {
        for (const row of pending) {
          nextMd = patchIncludedMd(nextMd, row.title, "included", includedMdLine(row));
        }
        nextMd = syncIncludedSummary(nextMd, parseIncludedRecords(nextJson));
        nextMdRev = await save(jsonRoot, "papers/included.md", nextMd, nextMdRev);
        setMdText(nextMd);
        setMdRevision(nextMdRev);
      }
      const missing = pending.filter((row) => !paperHasDoiPdf(row, pdfFiles));
      if (missing.length > 0) {
        await appendImport(missing);
        const fetch = await readFirst([jsonRoot, ...roots], "papers/to-fetch.md");
        if (!fetch?.file.revision) {
          setError("已全部纳入，但没有可写入的 to-fetch.md，缺 PDF 的篇目没进待获取。");
        } else {
          let nextFetch = fetch.file.text;
          for (const row of missing) nextFetch = appendToFetchEntry(nextFetch, row);
          if (nextFetch !== fetch.file.text) {
            await save(fetch.root, "papers/to-fetch.md", nextFetch, fetch.file.revision);
          }
        }
      }
      onChanged?.();
      toast(
        `已纳入其余 ${pending.length} 篇待确认${excluded.length > 0 ? `（已排除的 ${excluded.length} 篇未变动）` : ""}`,
        "success",
      );
      if (pendingConfirmCleared(parseIncludedRecords(nextJson))) onClearedRef.current?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      await commitTouched();
      setIncludingAll(false);
    }
  }

  useImperativeHandle(ref, () => ({ includeAll: () => void includeAll() }));

  if (records == null) return <p className="text-micro text-l4">加载文献清单…</p>;
  if (error && records.length === 0) return <p className="text-micro text-l4">{error}</p>;
  if (records.length === 0) return <p className="text-micro text-l4">清单是空的。</p>;

  const papersDir = `${projectRoot.replace(/[\\/]+$/, "")}/papers`;
  const filterCtxOf = (row: IncludedRecord) => {
    const key = includedRecordKey(row);
    const metric = metrics.get(key);
    return {
      hasPdf: Boolean(matchPaperPdf(row, pdfFiles, papersDir)),
      casQuartile: metric?.casQuartile,
      hasMetric: Boolean(metric && (metric.impactFactor || metric.casQuartile != null || metric.top)),
    };
  };
  const filtering = query.trim().length > 0 || quickFilter !== "all";
  const matchRow = (row: IncludedRecord) =>
    matchesScreeningQuery(row, query) && matchesScreeningFilter(row, quickFilter, filterCtxOf(row));
  const pendingShown = shown(pending).filter(matchRow);
  // 待确认区实际画的行：真待确认 + 这次原地拍过板的（顺序不变）
  const pendingView = shown(
    records.filter((row) => row.decision === "pending" || settled.has(includedRecordKey(row))),
  ).filter(matchRow);
  const includedShown = shown(included).filter(matchRow);
  // 实际画的行：已纳入 + 这次原地移出的（顺序不变）
  const includedView = shown(
    records.filter((row) => row.decision === "included" || removedHere.has(includedRecordKey(row))),
  ).filter(matchRow);
  // 已纳入一长串平铺会把下面按钮挤出视野：非筛选态且非大窗时默认先列前 20 篇
  const includedFolded = !fill && !filtering && !includedAllOpen && includedView.length > INCLUDED_PREVIEW + INCLUDED_FOLD_SLACK;
  const includedVisible = includedFolded ? includedView.slice(0, INCLUDED_PREVIEW) : includedView;
  const includedVisibleActive = includedVisible.filter((row) => row.decision === "included");
  const excludedShown = shown(
    records.filter((row) => row.decision === "excluded" || restoredHere.has(includedRecordKey(row))),
  ).filter(matchRow);
  const pickedRows = pending.filter((row) => picked.has(includedRecordKey(row)));
  const pickedIncludedRows = included.filter((row) => pickedIncluded.has(includedRecordKey(row)));
  const activePool = records.filter((r) => r.decision !== "excluded");
  const quickFilterCounts = {
    suggestExclude: pending.filter((r) => isSuggestedExclude(r)).length,
    review: activePool.filter((r) => r.kind === "review").length,
    research: activePool.filter((r) => r.kind === "research").length,
    noPdf: activePool.filter((r) => !filterCtxOf(r).hasPdf).length,
    hasPdf: activePool.filter((r) => filterCtxOf(r).hasPdf).length,
    lowTier: metricsReady === true ? activePool.filter((r) => filterCtxOf(r).casQuartile === 4 || !filterCtxOf(r).hasMetric).length : 0,
  };
  const filterChips: { id: ScreeningQuickFilter; label: string; count?: number }[] = [
    { id: "all", label: "全部" },
    ...(quickFilterCounts.suggestExclude > 0 ? [{ id: "suggest-exclude" as const, label: "建议排除", count: quickFilterCounts.suggestExclude }] : []),
    ...(quickFilterCounts.review > 0 ? [{ id: "review" as const, label: "综述", count: quickFilterCounts.review }] : []),
    ...(quickFilterCounts.research > 0 ? [{ id: "research" as const, label: "研究论文", count: quickFilterCounts.research }] : []),
    ...(quickFilterCounts.noPdf > 0 ? [{ id: "no-pdf" as const, label: "无 PDF", count: quickFilterCounts.noPdf }] : []),
    ...(quickFilterCounts.hasPdf > 0 ? [{ id: "has-pdf" as const, label: "有 PDF", count: quickFilterCounts.hasPdf }] : []),
    ...(quickFilterCounts.lowTier > 0 ? [{ id: "low-tier" as const, label: "4区/未收录", count: quickFilterCounts.lowTier }] : []),
  ];

  const metricsStatus =
    metricsReady === true ? (
      <span className="text-l4">
        {metricsBusy
          ? "指标表更新中…"
          : metricsNote?.startsWith("已是最新")
            ? "指标表已是最新"
            : metricsNote?.startsWith("上游有新版")
              ? "指标表有新版"
              : metricsNote?.startsWith("已更新")
                ? metricsNote
                : metricsNote?.startsWith("更新失败") || metricsNote?.startsWith("没能")
                  ? metricsNote
                  : "正在看指标表…"}
        {(metricsUpdate?.hasUpdate || (metricsNote?.startsWith("没能") ?? false)) && (
          <button
            type="button"
            disabled={metricsBusy}
            onClick={() => void downloadMetrics()}
            className="ml-1 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1 disabled:opacity-50"
          >
            {metricsUpdate?.hasUpdate ? "更新" : "重新下载"}
          </button>
        )}
      </span>
    ) : null;
  const listTools = (
    <>
      {metricsStatus}
      <label className="flex items-center gap-1 text-micro text-l3">
        排序
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as ScreeningSort)}
          className="rounded-sm border border-field bg-canvas px-1 py-0.5 text-l2"
        >
          <option value="listed">清单原序</option>
          <option value="if-desc">影响因子从高到低</option>
          <option value="if-asc">影响因子从低到高</option>
        </select>
      </label>
    </>
  );
  const showListTools = pending.length > 0 || included.length > 0 || metricsReady != null;
  const toolsAt: "pending" | "included" | "top" | null = !showListTools
    ? null
    : pendingView.length > 0 && pending.length > 0
      ? "pending"
      : includedView.length > 0
        ? "included"
        : "top";

  function toggleWithRange(
    set: Dispatch<SetStateAction<Set<string>>>,
    anchorRef: { current: string | null },
    orderedKeys: readonly string[],
    key: string,
    shiftKey: boolean,
  ) {
    set((cur) => {
      const next = new Set(cur);
      if (shiftKey && anchorRef.current) {
        const range = pickRangeKeys(orderedKeys, anchorRef.current, key);
        const turnOn = !cur.has(key);
        for (const k of range) {
          if (turnOn) next.add(k);
          else next.delete(k);
        }
      } else {
        if (next.has(key)) next.delete(key);
        else next.add(key);
      }
      return next;
    });
    anchorRef.current = key;
  }

  function toggleAbstract(key: string) {
    setOpenAbstracts((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const pendingOrderKeys = pendingShown.map((r) => includedRecordKey(r));
  const includedOrderKeys = includedVisibleActive.map((r) => includedRecordKey(r));

  /** 一篇一行。`side` = 动作放行尾、悬停才现（已纳入的「移出」、已排除的「恢复」）；
   *  待确认的纳入/排除是要做的决定，放标题下常显。支持 Shift + 点击区间连选与原地展开摘要。 */
  function rowBody(
    row: IncludedRecord,
    actions: ReactNode,
    selection?: { picked: Set<string>; toggle: (key: string, shiftKey: boolean) => void } | null,
    side = false,
    dim = false,
  ) {
    const key = includedRecordKey(row);
    const pdfPath = matchPaperPdf(row, pdfFiles, papersDir);
    const typed = (records ?? []).some((r) => !!r.kind);
    const meta = includedRecordMeta(row);
    const title = displayCitationTitle(row.title);
    const metric = metrics.get(key);
    const hasAbs = hasReadableAbstract(row.abstract);
    const absOpen = hasAbs && openAbstracts.has(key);
    const checked = Boolean(selection && selection.picked.has(key));
    return (
      <li key={key} className={`group flex gap-2 border-t border-hairline pt-2 first:border-t-0${dim ? " opacity-60" : ""}`}>
        {selection === null && <span aria-hidden="true" className="h-4 w-4 shrink-0" />}
        {selection && (
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            disabled={includingAll}
            aria-label={`选择 ${title}（按住 Shift 可区间连选）`}
            title="点击勾选，按住 Shift 点击可区间连选"
            onClick={(e) => selection.toggle(key, e.shiftKey)}
            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-micro transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              checked
                ? "border-cta-bd bg-cta text-cta-text"
                : "border-field bg-transparent text-transparent hover:border-l3"
            }`}
          >
            {checked ? "✓" : ""}
          </button>
        )}
        <div className="min-w-0 flex-1">
          {pdfPath && onOpenPdf ? (
            <button
              type="button"
              className="text-left text-xs leading-5 text-l1 hover:underline"
              title="已有 PDF，点击在文件页预览"
              onClick={() => onOpenPdf(pdfPath)}
            >
              {title}
            </button>
          ) : (
            <p className="text-xs leading-5 text-l1">{title}</p>
          )}
          <p className="mt-0.5 flex flex-wrap items-center gap-1 text-micro text-l4">
            {newKeys.has(key) && (
              <span
                className="rounded-sm border border-mesa-amber/40 bg-mesa-amber/15 px-1 text-l1"
                title="这一轮新加进清单的（项目里上一次保存的清单还没有它）"
              >
                本轮新增
              </span>
            )}
            {meta && <span title={row.authors || undefined}>{meta}</span>}
            <JournalBadges metric={metric} tableReady={metricsReady} loading={metricsLoading} />
            {pdfPath && <span className="text-ok-text">· 有 PDF</span>}
            {!pdfPath && row.url && (
              <button
                type="button"
                className="inline-flex items-center gap-0.5 text-micro text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                title={row.url}
                onClick={() => void openUrl(row.url)}
              >
                <span>{doiToken(row.id, row.url) ? "DOI" : "链接"}</span>
                <ExternalLink size={10} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            {typed && (
              <button
                type="button"
                disabled={busyKey === key || !jsonRevision}
                onClick={() => void patchKind(row, nextKind(row.kind))}
                title="文献类型：点一下在综述 / 研究论文 / 其他之间换。综述流程的精读第一轮精读综述、速读研究论文"
                className="rounded-sm bg-raised px-1 text-l3 hover:text-l1 disabled:opacity-50"
              >
                {row.kind ? (KIND_LABEL[row.kind] ?? row.kind) : "未标类型"}
              </button>
            )}
          </p>
          {(row.reason || hasAbs) && (
            <p className="mt-0.5 text-micro leading-5 text-l3">
              {row.reason}
              {hasAbs && (
                <button
                  type="button"
                  onClick={() => toggleAbstract(key)}
                  aria-expanded={absOpen}
                  className={`${row.reason ? "ml-1.5" : ""} inline-flex items-center gap-0.5 text-micro text-l4 hover:text-l1`}
                >
                  <span>{absOpen ? "收起摘要" : "看摘要"}</span>
                  {absOpen ? <ChevronUp size={11} aria-hidden="true" /> : <ChevronDown size={11} aria-hidden="true" />}
                </button>
              )}
            </p>
          )}
          {absOpen && (
            <p className="mt-1 rounded-md border border-hairline bg-strip/60 px-2.5 py-1.5 text-micro leading-5 text-l2">
              {row.abstract}
            </p>
          )}
          {!side && actions}
        </div>
        {side && (
          <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {actions}
          </div>
        )}
      </li>
    );
  }

  const pendingToolbar = pendingShown.length > 0 ? (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <p className="text-micro text-l3">
        待确认 {pendingShown.length}
        {pendingShown.length === pending.length ? "" : ` / ${pending.length}`}
      </p>
      <button
        type="button"
        disabled={includingAll}
        onClick={() => {
          const allOn = pendingOrderKeys.every((key) => picked.has(key));
          setPicked((prev) => {
            const next = new Set(prev);
            for (const k of pendingOrderKeys) {
              if (allOn) next.delete(k);
              else next.add(k);
            }
            return next;
          });
        }}
        className="text-micro text-l3 hover:text-l1"
      >
        {pendingOrderKeys.length > 0 && pendingOrderKeys.every((key) => picked.has(key)) ? "取消全选" : "全选"}
      </button>
      <button
        type="button"
        disabled={includingAll || pickedRows.length === 0}
        onClick={() => void applyMany(pickedRows, "included", (previous) => confirmReason("included", previous))}
        className={`rounded-sm border px-1.5 py-0.5 text-micro disabled:opacity-50 ${
          pickedRows.length > 0
            ? "border-cta-bd bg-cta text-cta-text"
            : "border-field text-l2"
        }`}
      >
        {includingAll ? "处理中…" : `纳入所选${pickedRows.length > 0 ? ` ${pickedRows.length}` : ""}`}
      </button>
      <button
        type="button"
        disabled={includingAll || pickedRows.length === 0}
        onClick={() => void applyMany(pickedRows, "excluded", (previous) => confirmReason("excluded", previous))}
        className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover disabled:opacity-50"
      >
        {includingAll ? "处理中…" : `排除所选${pickedRows.length > 0 ? ` ${pickedRows.length}` : ""}`}
      </button>
      {toolsAt === "pending" && (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">{listTools}</div>
      )}
    </div>
  ) : null;

  const includedToolbar = includedView.length > 0 ? (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-micro text-l3">
        已纳入 {includedShown.length}
        {includedShown.length === included.length ? "" : ` / ${included.length}`}
        {included.some((row) => newKeys.has(includedRecordKey(row)))
          ? ` · 本轮新增 ${included.filter((row) => newKeys.has(includedRecordKey(row))).length}（排在最前）`
          : ""}
      </p>
      <button
        type="button"
        disabled={includingAll || includedOrderKeys.length === 0}
        onClick={() => {
          const allOn = includedOrderKeys.length > 0 && includedOrderKeys.every((key) => pickedIncluded.has(key));
          setPickedIncluded((prev) => {
            const next = new Set(prev);
            for (const k of includedOrderKeys) {
              if (allOn) next.delete(k);
              else next.add(k);
            }
            return next;
          });
        }}
        className="text-micro text-l3 hover:text-l1"
      >
        {includedOrderKeys.length > 0 && includedOrderKeys.every((key) => pickedIncluded.has(key))
          ? "取消全选"
          : includedFolded
            ? `全选前 ${includedOrderKeys.length} 篇`
            : "全选"}
      </button>
      <button
        type="button"
        disabled={includingAll || pickedIncludedRows.length === 0}
        onClick={() => void applyMany(pickedIncludedRows, "excluded", removeReason, true)}
        title="改成排除，并从纳入清单和待获取里拿掉。笔记和引文不动。"
        className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover disabled:opacity-50"
      >
        {includingAll ? "处理中…" : `移出所选${pickedIncludedRows.length > 0 ? ` ${pickedIncludedRows.length}` : ""}`}
      </button>
      {toolsAt === "included" && (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">{listTools}</div>
      )}
    </div>
  ) : null;

  const pinnedToolbar = pendingToolbar ?? includedToolbar;
  const includedToolbarPinned = !pendingToolbar && Boolean(includedToolbar);

  return (
    <div className={fill ? "flex min-h-0 flex-1 flex-col" : "flex flex-col"}>
      {/* 顶部总览 + 搜索 + 快捷筛选 + 当前主分组操作条（物理放在滚动区外面，彻底杜绝吸顶透字缝） */}
      <div className="shrink-0 space-y-2 border-b border-hairline pb-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-micro text-l3">
          <button
            type="button"
            onClick={() => pendingSecRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className={`hover:text-l1 ${pending.length > 0 ? "font-medium text-l1" : "text-l4"}`}
          >
            待确认 {pending.length}
          </button>
          <span className="text-l4">·</span>
          <button
            type="button"
            onClick={() => includedSecRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="hover:text-l1"
          >
            已纳入 {included.length}
          </button>
          <span className="text-l4">·</span>
          <button
            type="button"
            onClick={() => {
              setExcludedOpen(true);
              window.setTimeout(() => excludedSecRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
            }}
            className="hover:text-l1"
          >
            已排除 {excluded.length}
          </button>
          <div className="ccode-search-shell ml-auto flex h-7 min-w-[11rem] max-w-[18rem] flex-1 items-center gap-1.5 rounded-md border border-field bg-inset/60 px-2 transition-colors focus-within:border-l3">
            <Search size={12} strokeWidth={1.8} className="shrink-0 text-l4" aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜标题 / 期刊 / 理由 / DOI…"
              className="min-w-0 flex-1 bg-transparent text-micro text-l1 outline-none placeholder:text-l4 focus:outline-none focus-visible:outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => setQuery("")}
                className="shrink-0 text-l4 hover:text-l1"
              >
                <X size={11} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        {filterChips.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            {filterChips.map((chip) => {
              const active = quickFilter === chip.id;
              return (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => setQuickFilter(active && chip.id !== "all" ? "all" : chip.id)}
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
            {filtering && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setQuickFilter("all");
                }}
                className="ml-1 text-micro text-l4 underline decoration-dotted underline-offset-2 hover:text-l1"
              >
                重置筛选
              </button>
            )}
          </div>
        )}
        {metricsReady === false && (
          <p className="text-micro text-l4">
            {metricsAutoPreparing ? (
              "正在后台自动准备期刊指标表，影响因子稍后出现。"
            ) : (
              <>
                期刊指标表暂未就绪，影响因子暂时对不上。
                <button
                  type="button"
                  disabled={metricsBusy}
                  onClick={() => void downloadMetrics()}
                  className="ml-1 text-l3 underline decoration-dotted underline-offset-2 hover:text-l1 disabled:opacity-50"
                >
                  {metricsBusy ? "下载中…" : "下载期刊指标表"}
                </button>
              </>
            )}
          </p>
        )}
        {metricsLoading && (
          <p className="text-micro text-l4">正在按 DOI 补期刊名，影响因子稍后出现。</p>
        )}
        {toolsAt === "top" && (
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">{listTools}</div>
        )}
        {pinnedToolbar && <div className="pt-0.5">{pinnedToolbar}</div>}
        {error && <InlineNotice tone="err" size="micro">{error}</InlineNotice>}
      </div>

      <div className={fill ? "min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden pr-2" : "max-h-96 space-y-3 overflow-y-auto overflow-x-hidden pr-2"}>
      {filtering && pendingView.length === 0 && includedView.length === 0 && excludedShown.length === 0 && (
        <p className="py-3 text-center text-micro text-l4">没有匹配当前筛选条件的文献。</p>
      )}
      {pendingView.length > 0 && (
        <section ref={pendingSecRef}>
          <ul className="space-y-2">
            {pendingView.map((row) => {
              const key = includedRecordKey(row);
              if (row.decision !== "pending") {
                const kept = row.decision === "included";
                return rowBody(
                  settled.get(key) ?? row,
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span className="border border-transparent px-1.5 py-0.5 text-micro text-l2">
                      {kept ? "✓ 已纳入" : "已排除"}
                    </span>
                    <button
                      type="button"
                      disabled={busyKey === key || includingAll}
                      onClick={() => void (kept ? removeRow(row) : confirmRow(row, "included"))}
                      title={kept ? "改成排除，并从纳入清单和待获取里拿掉。笔记和引文不动。" : undefined}
                      className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                    >
                      {busyKey === key ? "处理中…" : kept ? "改为排除" : "改为纳入"}
                    </button>
                  </div>,
                  null,
                  false,
                  true,
                );
              }
              return rowBody(
                row,
                <div className="mt-1 flex flex-wrap gap-1">
                  <button
                    type="button"
                    disabled={busyKey === key || includingAll}
                    onClick={() => void confirmRow(row, "included")}
                    className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l1 hover:bg-hover disabled:opacity-50"
                  >
                    纳入
                  </button>
                  <button
                    type="button"
                    disabled={busyKey === key || includingAll}
                    onClick={() => void confirmRow(row, "excluded")}
                    className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover disabled:opacity-50"
                  >
                    排除
                  </button>
                </div>,
                {
                  picked,
                  toggle: (k, shift) => toggleWithRange(setPicked, pendingAnchorRef, pendingOrderKeys, k, shift),
                },
              );
            })}
          </ul>
        </section>
      )}
      {includedView.length > 0 && (
        <section ref={includedSecRef}>
          {!includedToolbarPinned && includedToolbar && (
            <div className="mb-1.5 border-b border-hairline pb-1.5 pt-1">{includedToolbar}</div>
          )}
          <ul className="space-y-2">
            {includedVisible.map((row) => {
              const key = includedRecordKey(row);
              if (row.decision !== "included") {
                return rowBody(
                  row,
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-micro text-l3">
                    <span>已移出</span>
                    <button
                      type="button"
                      disabled={busyKey === key || includingAll}
                      onClick={() => void confirmRow(row, "included", true)}
                      className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                    >
                      {busyKey === key ? "恢复中…" : "撤销"}
                    </button>
                  </div>,
                  null,
                  false,
                  true,
                );
              }
              return rowBody(
                row,
                <button
                  type="button"
                  disabled={busyKey === key || includingAll}
                  onClick={() => void removeRow(row)}
                  title="改成排除，并从纳入清单和待获取里拿掉。笔记和引文不动。"
                  className="rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                >
                  {busyKey === key ? "移出中…" : "移出"}
                </button>,
                {
                  picked: pickedIncluded,
                  toggle: (k, shift) => toggleWithRange(setPickedIncluded, includedAnchorRef, includedOrderKeys, k, shift),
                },
                true,
              );
            })}
          </ul>
          {includedFolded && (
            <button
              type="button"
              onClick={() => setIncludedAllOpen(true)}
              aria-expanded={false}
              className="mt-1 text-micro text-l3 hover:text-l1"
            >
              展开其余 {includedView.length - INCLUDED_PREVIEW} 篇
            </button>
          )}
          {!fill && !filtering && includedAllOpen && includedView.length > INCLUDED_PREVIEW + INCLUDED_FOLD_SLACK && (
            <button
              type="button"
              onClick={() => setIncludedAllOpen(false)}
              aria-expanded
              className="mt-1 text-micro text-l3 hover:text-l1"
            >
              收起，只看前 {INCLUDED_PREVIEW} 篇
            </button>
          )}
        </section>
      )}
      {excludedShown.length > 0 && (
        <section ref={excludedSecRef}>
          <button
            type="button"
            onClick={() => setExcludedOpen((open) => !open)}
            aria-expanded={excludedOpen}
            className="text-micro text-l3 hover:text-l1"
          >
            {excludedOpen ? "收起" : "展开"}已排除 {excludedShown.length}
            {excludedShown.length === excluded.length ? "" : ` / ${excluded.length}`}
          </button>
          {excludedOpen && (
            <ul className="mt-1 space-y-2">
              {excludedShown.map((row) => {
                const key = includedRecordKey(row);
                if (row.decision !== "excluded") {
                  return rowBody(
                    row,
                    <div className="mt-1 text-micro text-l3">
                      {row.decision === "pending" ? "已恢复为待确认（在上面「待确认」里拍板）" : "已纳入"}
                    </div>,
                    null,
                    false,
                    true,
                  );
                }
                return rowBody(
                  row,
                  <button
                    type="button"
                    disabled={busyKey === key || includingAll}
                    onClick={() => void restoreRow(row)}
                    title="改回待确认。待获取和两份 RIS 不自动写回，再次纳入才会补。"
                    className="rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                  >
                    恢复为待确认
                  </button>,
                  undefined,
                  true,
                );
              })}
            </ul>
          )}
        </section>
      )}
      </div>
    </div>
  );
});

function JournalBadges({
  metric,
  tableReady,
  loading,
}: {
  metric: JournalMetricsDto | null | undefined;
  tableReady: boolean | null;
  loading: boolean;
}) {
  if (tableReady !== true) return null;
  if (loading && metric === undefined) return null;
  if (!metric) return <span className="text-l4">未收录</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {metric.impactFactor && (
        <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("if")}`}>
          IF {metric.impactFactor}
        </span>
      )}
      {metric.casQuartile != null && (
        <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("quartile", metric.casQuartile)}`}>
          {metric.casQuartile}区
        </span>
      )}
      {metric.top && (
        <span className={`rounded-full px-1.5 py-px text-micro ${journalMetricTone("top")}`}>TOP</span>
      )}
      {!metric.impactFactor && metric.casQuartile == null && !metric.top && (
        <span className="text-l4">未收录</span>
      )}
    </span>
  );
}
