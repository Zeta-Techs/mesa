/** 0 起算的列号 → Excel 列字母（0=A，25=Z，26=AA） */
export function colLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) return "";
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 单元格引用：0 行 0 列 → A1 */
export function cellRef(row: number, col: number): string {
  const letter = colLetter(col);
  if (!letter || !Number.isInteger(row) || row < 0) return "";
  return `${letter}${row + 1}`;
}

/** 工作表合并区（0 起算，含起点，rowspan/colspan ≥ 1） */
export interface SheetMerge {
  r: number;
  c: number;
  rowspan: number;
  colspan: number;
}

/** 把合并区裁进已显示的行×列窗口；1×1 或完全在窗外则丢掉 */
export function clipSheetMerge(
  m: SheetMerge,
  maxRows: number,
  maxCols: number,
): SheetMerge | null {
  if (
    !Number.isInteger(m.r) ||
    !Number.isInteger(m.c) ||
    !Number.isInteger(m.rowspan) ||
    !Number.isInteger(m.colspan) ||
    m.r < 0 ||
    m.c < 0 ||
    m.rowspan < 1 ||
    m.colspan < 1 ||
    maxRows < 1 ||
    maxCols < 1
  ) {
    return null;
  }
  if (m.r >= maxRows || m.c >= maxCols) return null;
  const rowspan = Math.min(m.rowspan, maxRows - m.r);
  const colspan = Math.min(m.colspan, maxCols - m.c);
  if (rowspan < 1 || colspan < 1) return null;
  if (rowspan === 1 && colspan === 1) return null;
  return { r: m.r, c: m.c, rowspan, colspan };
}

/** 该格被别人的合并挡住（自己不是起点）——不渲染 td */
export function sheetCellHidden(
  merges: readonly SheetMerge[],
  r: number,
  c: number,
): boolean {
  return merges.some(
    (m) =>
      !(m.r === r && m.c === c) &&
      r >= m.r &&
      r < m.r + m.rowspan &&
      c >= m.c &&
      c < m.c + m.colspan,
  );
}

export function sheetMergeAt(
  merges: readonly SheetMerge[],
  r: number,
  c: number,
): SheetMerge | undefined {
  return merges.find((m) => m.r === r && m.c === c);
}

export function sheetTruncationLabel(input: {
  shownRows: number;
  shownCols: number;
  totalRows: number;
  totalCols: number;
}): string | null {
  const { shownRows, shownCols, totalRows, totalCols } = input;
  if (totalRows <= shownRows && totalCols <= shownCols) return null;
  return `显示 ${shownRows} 行 × ${shownCols} 列（共 ${totalRows} × ${totalCols}）`;
}

export const CSV_PREVIEW_MAX_ROWS = 200;
export const CSV_PREVIEW_MAX_COLS = 256;

/** RFC 4180 口径：引号字段可含分隔符与换行，`""` 为字面引号。 */
export function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted || field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

export function delimitedSheetPreview(
  text: string,
  delimiter: string,
  maxRows = CSV_PREVIEW_MAX_ROWS,
  maxCols = CSV_PREVIEW_MAX_COLS,
): {
  rows: string[][];
  truncated: boolean;
  totalRows: number;
  totalCols: number;
} {
  const all = parseDelimitedRows(text, delimiter);
  const totalRows = all.length;
  const totalCols = all.reduce((m, r) => Math.max(m, r.length), 0);
  const truncated = totalRows > maxRows || totalCols > maxCols;
  const rows = all.slice(0, maxRows).map((r) => {
    const next = r.slice(0, maxCols);
    while (next.length < Math.min(totalCols, maxCols)) next.push("");
    return next;
  });
  return { rows, truncated, totalRows, totalCols };
}

export function csvDelimiterForPath(path: string): "," | "\t" {
  return /\.tsv$/i.test(path) ? "\t" : ",";
}

// ---------- 排序与框选复制（2026-10-26） ----------

/** 单元格比较：两边都是数（含千分位、百分号、负号）按数比，否则按中文习惯比字；空格排在最后 */
export function compareSheetCells(a: string, b: string): number {
  const ea = a.trim() === "";
  const eb = b.trim() === "";
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const na = sheetNumber(a);
  const nb = sheetNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return a.localeCompare(b, "zh-Hans-CN", { numeric: true });
}

function sheetNumber(s: string): number | null {
  const t = s.trim().replace(/,/g, "");
  const pct = t.endsWith("%");
  const core = pct ? t.slice(0, -1) : t;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(core)) return null;
  const v = Number(core);
  return Number.isFinite(v) ? (pct ? v / 100 : v) : null;
}

/**
 * 按某一列排序后的行下标顺序（返回原行下标，不改数据）。keepHeader = 第一行当表头不参与排序。
 * 同值保持原顺序（稳定）。
 */
export function sortedRowOrder(
  rows: readonly (readonly string[])[],
  col: number,
  dir: "asc" | "desc",
  keepHeader: boolean,
): number[] {
  const idx = rows.map((_, i) => i);
  const head = keepHeader ? idx.slice(0, 1) : [];
  const body = keepHeader ? idx.slice(1) : idx;
  body.sort((x, y) => {
    const c = compareSheetCells(rows[x]?.[col] ?? "", rows[y]?.[col] ?? "");
    return (dir === "asc" ? c : -c) || x - y;
  });
  return [...head, ...body];
}

export interface SheetRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** 两个角 → 规整的矩形（左上到右下） */
export function normRange(a: { r: number; c: number }, b: { r: number; c: number }): SheetRange {
  return {
    r0: Math.min(a.r, b.r),
    c0: Math.min(a.c, b.c),
    r1: Math.max(a.r, b.r),
    c1: Math.max(a.c, b.c),
  };
}

/** 框选区域 → 制表符分隔文字（粘进 Excel / 文本都对得上列）；viewRows 是显示顺序的行 */
export function rangeTsv(viewRows: readonly (readonly string[])[], r: SheetRange): string {
  const lines: string[] = [];
  for (let i = r.r0; i <= r.r1; i++) {
    const row = viewRows[i] ?? [];
    const cells: string[] = [];
    for (let j = r.c0; j <= r.c1; j++) {
      const v = row[j] ?? "";
      // 含换行 / 制表符 / 引号的格按 Excel 的写法加引号
      cells.push(/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    }
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}
