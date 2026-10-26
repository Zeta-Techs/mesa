import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import PreviewErrorState from "./PreviewErrorState";
import { useFileVersion } from "../file-watch";
import {
  cellRef,
  colLetter,
  CSV_PREVIEW_MAX_ROWS,
  csvDelimiterForPath,
  delimitedSheetPreview,
  normRange,
  rangeTsv,
  sheetCellHidden,
  sheetMergeAt,
  sheetTruncationLabel,
  sortedRowOrder,
  type SheetMerge,
  type SheetRange,
} from "../sheet-preview";

interface SheetPreviewDto {
  sheet: string;
  sheets: string[];
  rows: string[][];
  merges?: SheetMerge[];
  truncated: boolean;
  size: number;
  totalRows?: number;
  totalCols?: number;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 每次「加载更多」多读的行数；后端封顶 2 万行 */
const MORE_ROWS = 1000;
const ROWS_CAP = 20_000;

/**
 * Excel / ODS / CSV 只读预览：指定工作表、默认前 200 行 × 256 列，可「加载更多」（每次 1000 行，最多 2 万行）。
 * 列字母/行号冻结，宽表横滑。点列字母按这一列排序（再点倒序、第三下复原；第一行当表头不动；有合并格时不排）；
 * 点格子在顶栏看全文，按住拖动或 Shift+点框选一块，⌘C / Ctrl+C 或顶栏「复制」得到制表符分隔的文字。
 * compact：外层已有文件名（办公弹层），本组件不再重复。
 */
function XlsxPreview({
  path,
  cwdHint,
  compact,
}: {
  path: string;
  cwdHint: string | null;
  compact?: boolean;
}) {
  const [requestedSheet, setRequestedSheet] = useState<string | null>(null);
  const [dto, setDto] = useState<SheetPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [rowLimit, setRowLimit] = useState(CSV_PREVIEW_MAX_ROWS);
  const [loadingMore, setLoadingMore] = useState(false);
  /** 框选：anchor 是按下的格，focus 是拖到的格（都是显示顺序下的行号） */
  const [anchor, setAnchor] = useState<{ r: number; c: number } | null>(null);
  const [focus, setFocus] = useState<{ r: number; c: number } | null>(null);
  const draggingRef = useRef(false);
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const [copied, setCopied] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  // 磁盘上换了一版（清洗脚本重新写出表格）：停在当前工作表就地重读
  const fileVersion = useFileVersion(path);

  useEffect(() => {
    setRequestedSheet(null);
    setAnchor(null);
    setFocus(null);
    setSort(null);
    setRowLimit(CSV_PREVIEW_MAX_ROWS);
    setDto(null);
    setError(null);
  }, [path, cwdHint]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        if (/\.(csv|tsv)$/i.test(path)) {
          const root =
            cwdHint && cwdHint.length > 0
              ? cwdHint
              : path.replace(/[\\/][^\\/]*$/, "") || path;
          // 整份读（32 MB 封顶，GBK 等编码后端认好），不再只看前 256 KB
          const preview = await invoke<{ text: string; truncated: boolean }>(
            "read_text_document",
            { path, root },
          );
          const parsed = delimitedSheetPreview(
            preview.text,
            csvDelimiterForPath(path),
            rowLimit,
          );
          if (!cancelled) {
            setDto({
              sheet: "Sheet1",
              sheets: ["Sheet1"],
              rows: parsed.rows,
              truncated: parsed.truncated || preview.truncated,
              size: preview.text.length,
              totalRows: parsed.totalRows,
              totalCols: parsed.totalCols,
            });
          }
          return;
        }
        const next = await invoke<SheetPreviewDto>("read_sheet_preview", {
          path,
          cwdHint,
          sheet: requestedSheet,
          maxRows: rowLimit,
        });
        if (!cancelled) setDto(next);
      } catch (e) {
        if (!cancelled) {
          setDto(null);
          setError(String(e));
        }
      } finally {
        if (!cancelled) setLoadingMore(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint, requestedSheet, retry, fileVersion, rowLimit]);

  const colCount = dto?.rows.reduce((m, r) => Math.max(m, r.length), 0) ?? 0;
  const merges = dto?.merges ?? [];
  const canSort = merges.length === 0;
  /** 显示顺序（排序后）对应的原行下标 */
  const order = useMemo(() => {
    if (!dto) return [];
    if (!sort || !canSort) return dto.rows.map((_, i) => i);
    return sortedRowOrder(dto.rows, sort.col, sort.dir, true);
  }, [dto, sort, canSort]);
  const viewRows = useMemo(() => order.map((i) => dto?.rows[i] ?? []), [order, dto]);
  const range: SheetRange | null = anchor && focus ? normRange(anchor, focus) : null;
  const truncLabel = useMemo(() => {
    if (!dto) return null;
    return sheetTruncationLabel({
      shownRows: dto.rows.length,
      shownCols: colCount,
      totalRows: dto.totalRows ?? dto.rows.length,
      totalCols: dto.totalCols ?? colCount,
    });
  }, [dto, colCount]);
  const moreRows =
    dto && (dto.totalRows ?? dto.rows.length) > dto.rows.length && rowLimit < ROWS_CAP;
  const selectedText = anchor && dto ? (viewRows[anchor.r]?.[anchor.c] ?? "") : null;
  const multi = range && (range.r1 > range.r0 || range.c1 > range.c0);

  function inRange(r: number, c: number): boolean {
    return !!range && r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;
  }

  function copyRange() {
    if (!range) return;
    void navigator.clipboard.writeText(rangeTsv(viewRows, range)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }

  function cycleSort(col: number) {
    if (!canSort) return;
    setAnchor(null);
    setFocus(null);
    setSort((cur) =>
      !cur || cur.col !== col ? { col, dir: "asc" } : cur.dir === "asc" ? { col, dir: "desc" } : null,
    );
  }

  useEffect(() => {
    const stop = () => {
      draggingRef.current = false;
    };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!compact && (
        <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
          <span className="truncate text-l3" title={path}>
            {basename(path)}
          </span>
          {truncLabel && <span className="shrink-0 text-l4">{truncLabel}</span>}
        </div>
      )}
      {compact && truncLabel && (
        <div className="shrink-0 px-3 py-1 text-micro text-l4">{truncLabel}</div>
      )}
      {anchor && selectedText !== null && (
        <div className="flex shrink-0 items-start gap-2 border-b border-hairline bg-inset px-3 py-1 text-xs">
          <span className="shrink-0 font-mono text-l4">
            {range && multi
              ? `${cellRef(range.r0, range.c0)}:${cellRef(range.r1, range.c1)}`
              : cellRef(anchor.r, anchor.c)}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-l2">
            {multi
              ? `${range!.r1 - range!.r0 + 1} 行 × ${range!.c1 - range!.c0 + 1} 列`
              : selectedText || "（空）"}
          </span>
          <button
            type="button"
            onClick={copyRange}
            title={`复制（${/mac/i.test(navigator.platform) ? "⌘" : "Ctrl+"}C），制表符分隔，可直接粘进 Excel`}
            className="shrink-0 rounded-sm px-1.5 text-l3 hover:bg-hover hover:text-l1"
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      )}
      {error ? (
        <PreviewErrorState error={error} kind="表格" path={path} onRetry={() => setRetry((v) => v + 1)} />
      ) : dto === null ? (
        <div className="p-3">
          <p className="text-sm text-l4">正在加载表格…</p>
        </div>
      ) : dto.rows.length === 0 ? (
        <div className="p-3">
          <p className="text-sm text-l4">这张表是空的</p>
        </div>
      ) : (
        <div
          ref={tableRef}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-auto outline-none"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c" && range) {
              // 有文字选区时让系统复制原样
              if (window.getSelection()?.toString()) return;
              e.preventDefault();
              copyRange();
            }
          }}
        >
          <table className="w-max select-none border-separate border-spacing-0 text-micro text-l2">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-30 w-10 min-w-10 border-b border-r border-hairline bg-strip px-1 py-0.5" />
                {Array.from({ length: colCount }, (_, ci) => (
                  <th
                    key={ci}
                    onClick={() => cycleSort(ci)}
                    title={
                      canSort
                        ? "点一下按这一列升序，再点降序，第三下复原（第一行当表头不动；只排已载入的行）"
                        : "有合并单元格的表不排序"
                    }
                    className={`sticky top-0 z-20 min-w-20 border-b border-r border-hairline bg-strip px-1.5 py-0.5 text-center font-mono font-normal ${
                      sort?.col === ci ? "text-l1" : "text-l4"
                    } ${canSort ? "cursor-pointer hover:text-l2" : ""}`}
                  >
                    {colLetter(ci)}
                    {sort?.col === ci ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {viewRows.map((row, ri) => (
                <tr key={order[ri]}>
                  <th className="sticky left-0 z-10 w-10 min-w-10 border-b border-r border-hairline bg-strip px-1 py-0.5 text-right font-mono font-normal tabular-nums text-l4">
                    {(order[ri] ?? ri) + 1}
                  </th>
                  {Array.from({ length: colCount }, (_, ci) => {
                    const src = order[ri] ?? ri;
                    if (sheetCellHidden(merges, src, ci)) return null;
                    const merge = sheetMergeAt(merges, src, ci);
                    const active = anchor?.r === ri && anchor?.c === ci;
                    const picked = !active && multi && inRange(ri, ci);
                    const headerish = src === 0 || merge?.r === 0;
                    const spanned = (merge?.rowspan ?? 1) > 1 || (merge?.colspan ?? 1) > 1;
                    return (
                      <td
                        key={ci}
                        rowSpan={merge?.rowspan}
                        colSpan={merge?.colspan}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          tableRef.current?.focus({ preventScroll: true });
                          if (e.shiftKey && anchor) {
                            setFocus({ r: ri, c: ci });
                            return;
                          }
                          draggingRef.current = true;
                          setAnchor({ r: ri, c: ci });
                          setFocus({ r: ri, c: ci });
                        }}
                        onPointerEnter={() => {
                          if (draggingRef.current) setFocus({ r: ri, c: ci });
                        }}
                        className={`min-w-20 max-w-[22rem] cursor-default border-b border-r border-hairline px-1.5 py-0.5 ${
                          spanned
                            ? "whitespace-normal text-center align-middle"
                            : "truncate whitespace-nowrap tabular-nums"
                        } ${
                          active
                            ? "bg-seg-sel text-l1"
                            : picked
                              ? "bg-hover text-l1"
                              : headerish
                                ? "bg-inset"
                                : "bg-canvas"
                        }`}
                      >
                        {row[ci] ?? ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {moreRows && (
            <div className="sticky left-0 flex items-center gap-2 px-3 py-2 text-xs">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  setRowLimit((n) => Math.min(ROWS_CAP, n + MORE_ROWS));
                }}
                className="rounded-sm border border-line px-2 py-0.5 text-l2 hover:bg-hover disabled:opacity-50"
              >
                {loadingMore ? "加载中…" : `再载入 ${MORE_ROWS} 行`}
              </button>
              <span className="text-l4">
                已显示 {dto.rows.length} / {dto.totalRows} 行{rowLimit + MORE_ROWS > ROWS_CAP ? "（最多 2 万行，再多请用 Excel 打开）" : ""}
              </span>
            </div>
          )}
        </div>
      )}
      {dto && dto.sheets.length > 1 && (
        <div className="flex shrink-0 gap-0.5 overflow-x-auto border-t border-hairline bg-strip px-1 py-0.5">
          {dto.sheets.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => {
                if (name === (requestedSheet ?? dto.sheet)) return;
                setAnchor(null);
                setFocus(null);
                setSort(null);
                setRowLimit(CSV_PREVIEW_MAX_ROWS);
                setRequestedSheet(name);
              }}
              className={`shrink-0 rounded-sm px-2 py-0.5 text-micro ${
                name === (requestedSheet ?? dto.sheet)
                  ? "bg-seg-sel text-l1"
                  : "text-l3 hover:bg-hover hover:text-l1"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(XlsxPreview);
