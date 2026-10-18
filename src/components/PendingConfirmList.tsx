import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DirEntryDto } from "./FileTree";
import { researchAbsolutePath } from "../research-report";
import { readResearchFile, readResearchLedger, saveResearchLedger } from "../research-report-load";
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
  includedMdLine,
  includedRecordKey,
  includedRecordMeta,
  arrangeScreeningRows,
  includeAllPendingJson,
  matchPaperPdf,
  patchIncludedJsonMany,
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
}>(function PendingConfirmList({
  worktreePath,
  projectRoot,
  onOpenPdf,
  onChanged,
  onCleared,
  onMeta,
  fill = false,
}, ref) {
  const roots = [...new Set([worktreePath, projectRoot].filter((p): p is string => Boolean(p)))];
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [includingAll, setIncludingAll] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedIncluded, setPickedIncluded] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<ScreeningSort>("listed");
  const [records, setRecords] = useState<IncludedRecord[] | null>(null);
  const [jsonRoot, setJsonRoot] = useState(projectRoot);
  const [jsonText, setJsonText] = useState("");
  const [jsonRevision, setJsonRevision] = useState<string | null>(null);
  const [mdText, setMdText] = useState<string | null>(null);
  const [mdRevision, setMdRevision] = useState<string | null>(null);
  const [pdfFiles, setPdfFiles] = useState<{ name: string; path: string }[]>([]);
  const [metrics, setMetrics] = useState<Map<string, JournalMetricsDto | null>>(new Map());
  const [metricsReady, setMetricsReady] = useState<boolean | null>(null);
  const [metricsUpdate, setMetricsUpdate] = useState<JournalMetricsUpdateDto | null>(null);
  const [metricsNote, setMetricsNote] = useState<string | null>(null);
  const [metricsBusy, setMetricsBusy] = useState(false);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [excludedOpen, setExcludedOpen] = useState(false);
  const onClearedRef = useRef(onCleared);
  onClearedRef.current = onCleared;

  async function load() {
    setError(null);
    const json = await readFirst(roots, "papers/included.json");
    if (!json) {
      setRecords([]);
      setError("还没有纳入清单。Agent 筛完，待确认篇目会出现在这里。");
      return;
    }
    setJsonRoot(json.root);
    setJsonText(json.file.text);
    setJsonRevision(json.file.revision);
    setRecords(parseIncludedRecords(json.file.text));
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
  }, [worktreePath, projectRoot]);

  const pending = (records ?? []).filter((row) => row.decision === "pending");
  function shown(rows: IncludedRecord[]) {
    return arrangeScreeningRows(
      rows,
      (row) => metrics.get(includedRecordKey(row)),
      sortMode,
      null,
    );
  }
  const included = (records ?? []).filter((row) => row.decision === "included");
  const excluded = (records ?? []).filter((row) => row.decision === "excluded");

  useEffect(() => {
    onMeta?.({ count: pending.length, busy: includingAll || busyKey != null });
  }, [pending.length, includingAll, busyKey]);

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
      await saveResearchLedger(file.root, "papers/endnote-import.ris", next, file.file.revision);
    }
    const zotero = await readFirst([file.root, ...roots], "papers/to-fetch.ris");
    if (!zotero?.file.revision) return;
    let znext = zotero.file.text;
    for (const row of rows) znext = appendZoteroImportRecord(znext, row, source);
    if (znext === zotero.file.text) return;
    await saveResearchLedger(zotero.root, "papers/to-fetch.ris", znext, zotero.file.revision);
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
      const nextJsonRev = await saveResearchLedger(jsonRoot, "papers/included.json", nextJson, jsonRevision);
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      const nextRecords = parseIncludedRecords(nextJson);
      setRecords(nextRecords);
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
        const nextMdRev = await saveResearchLedger(jsonRoot, "papers/included.md", nextMd, mdRevision);
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
      const nextJsonRev = await saveResearchLedger(jsonRoot, "papers/included.json", nextJson, jsonRevision);
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      setRecords(parseIncludedRecords(nextJson));
      if (mdText != null && mdRevision) {
        const nextMd = syncIncludedSummary(
          patchIncludedMd(mdText, row.title, "pending", includedMdLine(row)),
          parseIncludedRecords(nextJson),
        );
        const nextMdRev = await saveResearchLedger(jsonRoot, "papers/included.md", nextMd, mdRevision);
        setMdText(nextMd);
        setMdRevision(nextMdRev);
      }
      onChanged?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyKey(null);
    }
  }

  async function confirmRow(row: IncludedRecord, decision: "included" | "excluded") {
    if (!jsonRevision) return;
    const key = includedRecordKey(row);
    setBusyKey(key);
    setError(null);
    const reason = confirmReason(decision, row.reason);
    try {
      const nextJson = patchIncludedJson(jsonText, key, decision, reason);
      const nextJsonRev = await saveResearchLedger(jsonRoot, "papers/included.json", nextJson, jsonRevision);
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      setRecords(parseIncludedRecords(nextJson));
      if (mdText != null && mdRevision) {
        const nextMd = syncIncludedSummary(
        patchIncludedMd(mdText, row.title, decision, includedMdLine(row)),
        parseIncludedRecords(nextJson),
      );
        const nextMdRev = await saveResearchLedger(jsonRoot, "papers/included.md", nextMd, mdRevision);
        setMdText(nextMd);
        setMdRevision(nextMdRev);
      }
      if (decision === "included") {
        await appendImport([row]);
      }
      if (decision === "included" && !paperHasDoiPdf(row, pdfFiles)) {
        const fetch = await readFirst([jsonRoot, ...roots], "papers/to-fetch.md");
        if (!fetch?.file.revision) {
          setError("已纳入，但没有可写入的 to-fetch.md，无法追加待获取。");
        } else {
          const nextFetch = appendToFetchEntry(fetch.file.text, row);
          if (nextFetch !== fetch.file.text) {
            await saveResearchLedger(fetch.root, "papers/to-fetch.md", nextFetch, fetch.file.revision);
          }
        }
      }
      onChanged?.();
      if (pendingConfirmCleared(parseIncludedRecords(nextJson))) onClearedRef.current?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyKey(null);
    }
  }

  async function applyMany(
    rows: IncludedRecord[],
    decision: "included" | "excluded" | "pending",
    reasonFor: (previous: string) => string,
  ) {
    if (!jsonRevision || rows.length === 0) return;
    setIncludingAll(true);
    setError(null);
    try {
      const nextJson = patchIncludedJsonMany(
        jsonText,
        rows.map((row) => includedRecordKey(row)),
        decision,
        reasonFor,
      );
      const nextJsonRev = await saveResearchLedger(jsonRoot, "papers/included.json", nextJson, jsonRevision);
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      setRecords(parseIncludedRecords(nextJson));
      let nextMd = mdText;
      let nextMdRev = mdRevision;
      if (nextMd != null && nextMdRev) {
        for (const row of rows) {
          nextMd = patchIncludedMd(nextMd, row.title, decision, includedMdLine(row));
        }
        nextMd = syncIncludedSummary(nextMd, parseIncludedRecords(nextJson));
        nextMdRev = await saveResearchLedger(jsonRoot, "papers/included.md", nextMd, nextMdRev);
        setMdText(nextMd);
        setMdRevision(nextMdRev);
      }
      if (decision === "included") {
        await appendImport(rows);
        const missing = rows.filter((row) => !paperHasDoiPdf(row, pdfFiles));
        if (missing.length > 0) {
          const fetch = await readFirst([jsonRoot, ...roots], "papers/to-fetch.md");
          if (!fetch?.file.revision) {
            setError("已纳入，但没有可写入的 to-fetch.md，缺 PDF 的篇目没进待获取。");
          } else {
            let nextFetch = fetch.file.text;
            for (const row of missing) nextFetch = appendToFetchEntry(nextFetch, row);
            if (nextFetch !== fetch.file.text) {
              await saveResearchLedger(fetch.root, "papers/to-fetch.md", nextFetch, fetch.file.revision);
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
      setIncludingAll(false);
    }
  }

  async function includeAll() {
    if (!jsonRevision || pending.length === 0) return;
    setIncludingAll(true);
    setError(null);
    try {
      const nextJson = includeAllPendingJson(jsonText);
      const nextJsonRev = await saveResearchLedger(jsonRoot, "papers/included.json", nextJson, jsonRevision);
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      setRecords(parseIncludedRecords(nextJson));
      let nextMd = mdText;
      let nextMdRev = mdRevision;
      if (nextMd != null && nextMdRev) {
        for (const row of pending) {
          nextMd = patchIncludedMd(nextMd, row.title, "included", includedMdLine(row));
        }
        nextMd = syncIncludedSummary(nextMd, parseIncludedRecords(nextJson));
        nextMdRev = await saveResearchLedger(jsonRoot, "papers/included.md", nextMd, nextMdRev);
        setMdText(nextMd);
        setMdRevision(nextMdRev);
      }
      await appendImport(pending);
      const missing = pending.filter((row) => !paperHasDoiPdf(row, pdfFiles));
      if (missing.length > 0) {
        const fetch = await readFirst([jsonRoot, ...roots], "papers/to-fetch.md");
        if (!fetch?.file.revision) {
          setError("已全部纳入，但没有可写入的 to-fetch.md，缺 PDF 的篇目没进待获取。");
        } else {
          let nextFetch = fetch.file.text;
          for (const row of missing) nextFetch = appendToFetchEntry(nextFetch, row);
          if (nextFetch !== fetch.file.text) {
            await saveResearchLedger(fetch.root, "papers/to-fetch.md", nextFetch, fetch.file.revision);
          }
        }
      }
      onChanged?.();
      if (pendingConfirmCleared(parseIncludedRecords(nextJson))) onClearedRef.current?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setIncludingAll(false);
    }
  }

  useImperativeHandle(ref, () => ({ includeAll: () => void includeAll() }));

  if (records == null) return <p className="text-micro text-l4">加载文献清单…</p>;
  if (error && records.length === 0) return <p className="text-micro text-l4">{error}</p>;
  if (records.length === 0) return <p className="text-micro text-l4">清单是空的。</p>;

  const papersDir = `${projectRoot.replace(/[\\/]+$/, "")}/papers`;
  const pendingShown = shown(pending);
  const includedShown = shown(included);
  const excludedShown = shown(excluded);
  const pickedRows = pending.filter((row) => picked.has(includedRecordKey(row)));
  const pickedIncludedRows = included.filter((row) => pickedIncluded.has(includedRecordKey(row)));

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
            className="ml-1 text-cta-pill-text hover:underline disabled:opacity-50"
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

  function toggleIn(set: Dispatch<SetStateAction<Set<string>>>, key: string) {
    set((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** 一篇一行。`side` = 动作放行尾、悬停才现（已纳入的「移出」、已排除的「恢复」——
   *  低频，且勾选 +「移出所选」已能批量做）；待确认的纳入/排除是要做的决定，放标题下常显。 */
  function rowBody(
    row: IncludedRecord,
    actions: ReactNode,
    selection?: { picked: Set<string>; toggle: (key: string) => void },
    side = false,
  ) {
    const key = includedRecordKey(row);
    const pdfPath = matchPaperPdf(row, pdfFiles, papersDir);
    const meta = includedRecordMeta(row);
    const title = displayCitationTitle(row.title);
    const metric = metrics.get(key);
    return (
      <li key={key} className="group flex gap-2 border-t border-hairline pt-2">
        {selection && (
          <label className={`mt-0.5 flex h-4 w-4 shrink-0 ${includingAll ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
            <input
              type="checkbox"
              className="sr-only"
              checked={selection.picked.has(key)}
              disabled={includingAll}
              aria-label={`选择 ${title}`}
              onChange={() => selection.toggle(key)}
            />
            <span
              aria-hidden="true"
              className={`flex h-4 w-4 items-center justify-center rounded-sm border text-micro ${
                selection.picked.has(key)
                  ? "border-cta-bd bg-cta text-cta-text"
                  : "border-field bg-transparent text-transparent"
              }`}
            >
              {selection.picked.has(key) ? "✓" : ""}
            </span>
          </label>
        )}
        <div className="min-w-0 flex-1">
        {pdfPath && onOpenPdf ? (
          <button
            type="button"
            className="text-left text-xs leading-5 text-cta-pill-text hover:underline"
            title="已有 PDF，点击在文件页预览"
            onClick={() => onOpenPdf(pdfPath)}
          >
            {title}
          </button>
        ) : (
          <p className="text-xs leading-5 text-l1">{title}</p>
        )}
        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-micro text-l4">
          {meta && <span title={row.authors || undefined}>{meta}</span>}
          <JournalBadges metric={metric} tableReady={metricsReady} loading={metricsLoading} />
          {/* 有全文只占一个小记号，不再单起一行（标题本身就是打开入口） */}
          {pdfPath && <span className="text-ok-text">· 有 PDF</span>}
        </p>
        {!pdfPath && row.url && (
          <button
            type="button"
            className="mt-0.5 text-left text-micro text-cta-pill-text hover:underline"
            onClick={() => void openUrl(row.url)}
          >
            {doiToken(row.id, row.url) || row.url.replace(/^https?:\/\//, "")}
          </button>
        )}
        {row.reason && <p className="mt-0.5 text-micro leading-5 text-l3">{row.reason}</p>}
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

  return (
    <div className={fill ? "space-y-3" : "max-h-96 space-y-3 overflow-auto"}>
      {metricsReady === false && (
        <p className="text-micro text-l4">
          还没有期刊指标表，影响因子暂时对不上。
          <button
            type="button"
            disabled={metricsBusy}
            onClick={() => void downloadMetrics()}
            className="ml-1 text-cta-pill-text hover:underline disabled:opacity-50"
          >
            {metricsBusy ? "下载中…" : "下载期刊指标表"}
          </button>
        </p>
      )}
      {metricsLoading && (
        <p className="text-micro text-l4">正在按 DOI 补期刊名，影响因子稍后出现。</p>
      )}
      {showListTools && pending.length === 0 && (
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">{listTools}</div>
      )}
      {error && <InlineNotice tone="err" size="micro">{error}</InlineNotice>}
      {pending.length > 0 && (
        <section>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-micro text-l3">待确认 {pendingShown.length}{pendingShown.length === pending.length ? "" : ` / ${pending.length}`}</p>
            <button
              type="button"
              disabled={includingAll}
              onClick={() => {
                const keys = pendingShown.map((row) => includedRecordKey(row));
                const allOn = keys.every((key) => picked.has(key));
                setPicked(allOn ? new Set() : new Set(keys));
              }}
              className="text-micro text-l3 hover:text-l1"
            >
              {pendingShown.every((row) => picked.has(includedRecordKey(row))) ? "取消全选" : "全选"}
            </button>
            <button
              type="button"
              disabled={includingAll || pickedRows.length === 0}
              onClick={() => void applyMany(pickedRows, "included", (previous) => confirmReason("included", previous))}
              className="rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text disabled:opacity-50"
            >
              {includingAll ? "处理中…" : `纳入所选${pickedRows.length > 0 ? ` ${pickedRows.length}` : ""}`}
            </button>
            <button
              type="button"
              disabled={includingAll || pickedRows.length === 0}
              onClick={() => void applyMany(pickedRows, "excluded", (previous) => confirmReason("excluded", previous))}
              className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover disabled:opacity-50"
            >
              排除所选
            </button>
            {showListTools && (
              <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">{listTools}</div>
            )}
          </div>
          <ul className="space-y-2">
            {pendingShown.map((row) => {
              const key = includedRecordKey(row);
              return rowBody(
                row,
                <div className="mt-1 flex flex-wrap gap-1">
                  <button
                    type="button"
                    disabled={busyKey === key || includingAll}
                    onClick={() => void confirmRow(row, "included")}
                    className="rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text disabled:opacity-50"
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
                { picked, toggle: (key) => toggleIn(setPicked, key) },
              );
            })}
          </ul>
        </section>
      )}
      {included.length > 0 && (
        <section>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-micro text-l3">已纳入 {includedShown.length}{includedShown.length === included.length ? "" : ` / ${included.length}`}</p>
            <button
              type="button"
              disabled={includingAll}
              onClick={() => {
                const keys = includedShown.map((row) => includedRecordKey(row));
                const allOn = keys.length > 0 && keys.every((key) => pickedIncluded.has(key));
                setPickedIncluded(allOn ? new Set() : new Set(keys));
              }}
              className="text-micro text-l3 hover:text-l1"
            >
              {includedShown.length > 0 && includedShown.every((row) => pickedIncluded.has(includedRecordKey(row))) ? "取消全选" : "全选"}
            </button>
            <button
              type="button"
              disabled={includingAll || pickedIncludedRows.length === 0}
              onClick={() => void applyMany(pickedIncludedRows, "excluded", removeReason)}
              title="改成排除，并从纳入清单和待获取里拿掉。笔记和引文不动。"
              className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover disabled:opacity-50"
            >
              {includingAll ? "处理中…" : `移出所选${pickedIncludedRows.length > 0 ? ` ${pickedIncludedRows.length}` : ""}`}
            </button>
          </div>
          <ul className="space-y-2">
            {includedShown.map((row) => {
              const key = includedRecordKey(row);
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
                { picked: pickedIncluded, toggle: (key) => toggleIn(setPickedIncluded, key) },
                true,
              );
            })}
          </ul>
        </section>
      )}
      {excluded.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setExcludedOpen((open) => !open)}
            aria-expanded={excludedOpen}
            className="text-micro text-l3 hover:text-l1"
          >
            {excludedOpen ? "收起" : "展开"}已排除 {excluded.length}
          </button>
          {excludedOpen && (
            <ul className="mt-1 space-y-2">
              {excludedShown.map((row) => {
                const key = includedRecordKey(row);
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
