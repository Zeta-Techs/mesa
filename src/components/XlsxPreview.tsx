import { memo, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import PreviewErrorState from "./PreviewErrorState";
import { useFileVersion } from "../file-watch";
import {
  cellRef,
  colLetter,
  csvDelimiterForPath,
  delimitedSheetPreview,
  sheetCellHidden,
  sheetMergeAt,
  sheetTruncationLabel,
  type SheetMerge,
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

/**
 * Excel / ODS 只读预览：指定工作表、最多 200 行 × 256 列。
 * 列字母/行号冻结，宽表横滑；点格子在顶栏看全文（WKWebView 没有 title 悬浮）。
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
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  // 磁盘上换了一版（清洗脚本重新写出表格）：停在当前工作表就地重读
  const fileVersion = useFileVersion(path);

  useEffect(() => {
    setRequestedSheet(null);
    setSel(null);
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
          const preview = await invoke<{ text: string; truncated: boolean }>(
            "read_file_preview",
            { path, root },
          );
          const parsed = delimitedSheetPreview(
            preview.text,
            csvDelimiterForPath(path),
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
        });
        if (!cancelled) setDto(next);
      } catch (e) {
        if (!cancelled) {
          setDto(null);
          setError(String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint, requestedSheet, retry, fileVersion]);

  const colCount = dto?.rows.reduce((m, r) => Math.max(m, r.length), 0) ?? 0;
  const merges = dto?.merges ?? [];
  const truncLabel = useMemo(() => {
    if (!dto) return null;
    return sheetTruncationLabel({
      shownRows: dto.rows.length,
      shownCols: colCount,
      totalRows: dto.totalRows ?? dto.rows.length,
      totalCols: dto.totalCols ?? colCount,
    });
  }, [dto, colCount]);
  const selectedText =
    sel && dto ? (dto.rows[sel.r]?.[sel.c] ?? "") : null;

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
      {sel && selectedText !== null && (
        <div className="flex shrink-0 items-start gap-2 border-b border-hairline bg-inset px-3 py-1 text-xs">
          <span className="shrink-0 font-mono text-l4">{cellRef(sel.r, sel.c)}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-l2">
            {selectedText || "（空）"}
          </span>
        </div>
      )}
      {error ? (
        <PreviewErrorState error={error} kind="表格" onRetry={() => setRetry((v) => v + 1)} />
      ) : dto === null ? (
        <div className="p-3">
          <p className="text-sm text-l4">正在加载表格…</p>
        </div>
      ) : dto.rows.length === 0 ? (
        <div className="p-3">
          <p className="text-sm text-l4">这张表是空的</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-max border-separate border-spacing-0 text-micro text-l2">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-30 w-10 min-w-10 border-b border-r border-hairline bg-strip px-1 py-0.5" />
                {Array.from({ length: colCount }, (_, ci) => (
                  <th
                    key={ci}
                    className="sticky top-0 z-20 min-w-20 border-b border-r border-hairline bg-strip px-1.5 py-0.5 text-center font-mono font-normal text-l4"
                  >
                    {colLetter(ci)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dto.rows.map((row, ri) => (
                <tr key={ri}>
                  <th className="sticky left-0 z-10 w-10 min-w-10 border-b border-r border-hairline bg-strip px-1 py-0.5 text-right font-mono font-normal tabular-nums text-l4">
                    {ri + 1}
                  </th>
                  {Array.from({ length: colCount }, (_, ci) => {
                    if (sheetCellHidden(merges, ri, ci)) return null;
                    const merge = sheetMergeAt(merges, ri, ci);
                    const active = sel?.r === ri && sel?.c === ci;
                    const headerish = ri === 0 || merge?.r === 0;
                    const spanned = (merge?.rowspan ?? 1) > 1 || (merge?.colspan ?? 1) > 1;
                    return (
                      <td
                        key={ci}
                        rowSpan={merge?.rowspan}
                        colSpan={merge?.colspan}
                        onClick={() => setSel({ r: ri, c: ci })}
                        className={`min-w-20 max-w-[22rem] cursor-default border-b border-r border-hairline px-1.5 py-0.5 ${
                          spanned
                            ? "whitespace-normal text-center align-middle"
                            : "truncate whitespace-nowrap tabular-nums"
                        } ${
                          active
                            ? "bg-seg-sel text-l1"
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
                setSel(null);
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
