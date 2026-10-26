//! Excel / ODS 表格预览：白名单读字节后用 calamine 抽指定工作表前若干行。
//! 只读、截断，不当电子表格编辑器。

use crate::pdf::read_whitelisted_sync;
use calamine::{Data, Dimensions, Reader};
use serde::Serialize;
use std::io::{Cursor, Read, Seek};
use zip::ZipArchive;

const XLSX_CAP: u64 = 20 * 1024 * 1024;
const MAX_ROWS: usize = 200;
const MAX_COLS: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetMergeDto {
    pub r: usize,
    pub c: usize,
    pub rowspan: usize,
    pub colspan: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPreviewDto {
    pub sheet: String,
    pub sheets: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub merges: Vec<SheetMergeDto>,
    pub truncated: bool,
    pub size: u64,
    pub total_rows: usize,
    pub total_cols: usize,
}

/// 把工作表绝对合并区裁进预览窗口（相对 range 起点、已截断的行×列）。
fn clip_merge(
    d: &Dimensions,
    origin: (u32, u32),
    max_rows: usize,
    max_cols: usize,
) -> Option<SheetMergeDto> {
    if max_rows == 0 || max_cols == 0 {
        return None;
    }
    let (or, oc) = origin;
    if d.end.0 < or || d.end.1 < oc {
        return None;
    }
    let r0 = d.start.0.saturating_sub(or) as usize;
    let c0 = d.start.1.saturating_sub(oc) as usize;
    if r0 >= max_rows || c0 >= max_cols {
        return None;
    }
    let r1 = (d.end.0.saturating_sub(or) as usize).min(max_rows - 1);
    let c1 = (d.end.1.saturating_sub(oc) as usize).min(max_cols - 1);
    if r1 < r0 || c1 < c0 {
        return None;
    }
    let rowspan = r1 + 1 - r0;
    let colspan = c1 + 1 - c0;
    if rowspan <= 1 && colspan <= 1 {
        return None;
    }
    Some(SheetMergeDto {
        r: r0,
        c: c0,
        rowspan,
        colspan,
    })
}

/// A1 或 A1:B2 → 0 起算行列。给 xlsx mergeCell ref 用（Excel 常写自闭合标签，calamine 只认 Start）。
fn parse_a1_cell(s: &str) -> Option<(u32, u32)> {
    let s = s.trim();
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut col = 0u32;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        col = col * 26 + u32::from(bytes[i].to_ascii_uppercase() - b'A' + 1);
        i += 1;
    }
    if i == 0 || col == 0 {
        return None;
    }
    let row: u32 = s[i..].parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, col - 1))
}

fn parse_a1_range(s: &str) -> Option<Dimensions> {
    let s = s.trim();
    if let Some((a, b)) = s.split_once(':') {
        Some(Dimensions::new(parse_a1_cell(a)?, parse_a1_cell(b)?))
    } else {
        let p = parse_a1_cell(s)?;
        Some(Dimensions::new(p, p))
    }
}

fn parse_merge_refs(xml: &str) -> Vec<Dimensions> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find("mergeCell") {
        rest = &rest[i + 9..];
        let Some(j) = rest.find("ref=\"") else {
            continue;
        };
        if j > 64 {
            continue;
        }
        rest = &rest[j + 5..];
        let Some(e) = rest.find('"') else { break };
        if let Some(d) = parse_a1_range(&rest[..e]) {
            out.push(d);
        }
        rest = &rest[e + 1..];
    }
    out
}

fn zip_file_string(zip: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn attr_near(xml: &str, needle: &str, key: &str, window: usize) -> Option<String> {
    let i = xml.find(needle)?;
    let lo = i.saturating_sub(window);
    let hi = (i + needle.len() + window).min(xml.len());
    let slice = &xml[lo..hi];
    let pat = format!("{key}=\"");
    let k = slice.find(&pat)?;
    let rest = &slice[k + pat.len()..];
    let e = rest.find('"')?;
    Some(rest[..e].to_string())
}

fn xlsx_merges_from_bytes(bytes: &[u8], sheet: &str) -> Vec<Dimensions> {
    let Ok(mut zip) = ZipArchive::new(Cursor::new(bytes)) else {
        return Vec::new();
    };
    let Some(wb) = zip_file_string(&mut zip, "xl/workbook.xml") else {
        return Vec::new();
    };
    let needle = format!("name=\"{}\"", sheet);
    let Some(rid) = attr_near(&wb, &needle, "r:id", 120) else {
        return Vec::new();
    };
    let Some(rels) = zip_file_string(&mut zip, "xl/_rels/workbook.xml.rels") else {
        return Vec::new();
    };
    let Some(target) = attr_near(&rels, &format!("Id=\"{rid}\""), "Target", 160) else {
        return Vec::new();
    };
    let path = if target.starts_with('/') {
        target.trim_start_matches('/').to_string()
    } else if target.starts_with("xl/") {
        target
    } else {
        format!("xl/{target}")
    };
    let Some(ws) = zip_file_string(&mut zip, &path) else {
        return Vec::new();
    };
    parse_merge_refs(&ws)
}

fn excel_datetime_text(dt: &calamine::ExcelDateTime) -> String {
    if dt.is_duration() {
        if let Some(d) = dt.as_duration() {
            let secs = d.num_seconds();
            let sign = if secs < 0 { "-" } else { "" };
            let s = secs.abs();
            return format!("{sign}{}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60);
        }
    } else if let Some(t) = dt.as_datetime() {
        use chrono::Timelike;
        // 只有时间（日期部分是 Excel 的 0 日）：只写时间
        if dt.as_f64().abs() < 1.0 {
            return t.format("%H:%M:%S").to_string();
        }
        if t.hour() == 0 && t.minute() == 0 && t.second() == 0 {
            return t.format("%Y-%m-%d").to_string();
        }
        if t.second() == 0 {
            return t.format("%Y-%m-%d %H:%M").to_string();
        }
        return t.format("%Y-%m-%d %H:%M:%S").to_string();
    }
    dt.to_string()
}

fn cell_text(d: &Data) -> String {
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{f:.0}")
            } else {
                format!("{f}")
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => {
            if *b {
                "TRUE".into()
            } else {
                "FALSE".into()
            }
        }
        Data::Error(e) => format!("#{e:?}"),
        // 日期 / 时间格的值是 Excel 序列号（45123.5 这种），按单元格类型换成看得懂的写法（2026-10-26）
        Data::DateTime(dt) => excel_datetime_text(dt),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
    }
}

/// 「加载更多行」的上限：再多就该用 Excel / 脚本看了
const MAX_ROWS_CAP: usize = 20_000;

fn read_sheet_preview_sync(
    path: &str,
    cwd_hint: Option<&str>,
    sheet_name: Option<&str>,
    max_rows: Option<usize>,
) -> Result<SheetPreviewDto, String> {
    let max_rows = max_rows.unwrap_or(MAX_ROWS).clamp(1, MAX_ROWS_CAP);
    let (bytes, size) = read_whitelisted_sync(path, cwd_hint, XLSX_CAP, |mb| {
        format!("表格超过 20 MB（{mb:.1} MB），暂不支持内嵌预览")
    })?;
    let cursor = Cursor::new(bytes.as_slice());
    let mut workbook = open_auto(cursor, path)?;
    let sheets = workbook.sheet_names();
    if sheets.is_empty() {
        return Err("这个表格里没有工作表".into());
    }
    let want = sheet_name.map(str::trim).filter(|s| !s.is_empty());
    let sheet = if let Some(name) = want {
        if !sheets.iter().any(|s| s == name) {
            return Err(format!("没有名为「{name}」的工作表"));
        }
        name.to_string()
    } else {
        sheets[0].clone()
    };
    let range = workbook
        .worksheet_range(&sheet)
        .map_err(|e| format!("读取工作表失败: {e}"))?;
    let total_cols = range.width();
    let total_rows = range.height();
    let truncated = total_rows > max_rows || total_cols > MAX_COLS;
    let width = total_cols.min(MAX_COLS);
    let take_rows = total_rows.min(max_rows);
    let origin = range.start().unwrap_or((0, 0));
    let mut rows = Vec::with_capacity(take_rows);
    for r in 0..take_rows {
        let mut row = Vec::with_capacity(width);
        for c in 0..width {
            row.push(range.get((r, c)).map(cell_text).unwrap_or_default());
        }
        rows.push(row);
    }
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let merges = if ext == "xlsx" || ext == "xlsm" {
        xlsx_merges_from_bytes(&bytes, &sheet)
            .iter()
            .filter_map(|d| clip_merge(d, origin, take_rows, width))
            .collect()
    } else {
        Vec::new()
    };
    Ok(SheetPreviewDto {
        sheet,
        sheets,
        rows,
        merges,
        truncated,
        size,
        total_rows,
        total_cols,
    })
}

fn open_auto<RS: Read + Seek + Send>(
    cursor: RS,
    path: &str,
) -> Result<calamine::Sheets<RS>, String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "xlsx" | "xlsm" => calamine::open_workbook_from_rs::<calamine::Xlsx<_>, _>(cursor)
            .map(calamine::Sheets::Xlsx)
            .map_err(|e| format!("无法解析 xlsx: {e}")),
        "xls" => calamine::open_workbook_from_rs::<calamine::Xls<_>, _>(cursor)
            .map(calamine::Sheets::Xls)
            .map_err(|e| format!("无法解析 xls: {e}")),
        "ods" => calamine::open_workbook_from_rs::<calamine::Ods<_>, _>(cursor)
            .map(calamine::Sheets::Ods)
            .map_err(|e| format!("无法解析 ods: {e}")),
        _ => Err("只支持 .xlsx / .xls / .ods 表格预览".into()),
    }
}

#[tauri::command]
pub async fn read_sheet_preview(
    path: String,
    cwd_hint: Option<String>,
    sheet: Option<String>,
    max_rows: Option<usize>,
) -> Result<SheetPreviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_sheet_preview_sync(&path, cwd_hint.as_deref(), sheet.as_deref(), max_rows)
    })
    .await
    .map_err(|e| format!("读取表格失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    /// 最小合法 xlsx：一张表、A1=hello。calamine 对残缺包会失败，这里只测白名单拒读。
    #[test]
    fn sheet_preview_rejects_outside_whitelist() {
        let dir = std::env::temp_dir().join(format!("ccode-xlsx-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.xlsx");
        fs::write(&f, b"PK\x03\x04not-a-real-xlsx").unwrap();
        let err = read_sheet_preview_sync(f.to_str().unwrap(), None, None, None).unwrap_err();
        assert!(
            err.contains("拒绝") || err.contains("范围") || err.contains("不存在"),
            "{err}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_a1_and_merge_refs() {
        assert_eq!(parse_a1_cell("A1"), Some((0, 0)));
        assert_eq!(parse_a1_cell("B12"), Some((11, 1)));
        assert_eq!(parse_a1_cell("AA1"), Some((0, 26)));
        let d = parse_a1_range("C1:F2").unwrap();
        assert_eq!(d.start, (0, 2));
        assert_eq!(d.end, (1, 5));
        let xml = r#"<mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="C2:C3"></mergeCell></mergeCells>"#;
        let ms = parse_merge_refs(xml);
        assert_eq!(ms.len(), 2);
        assert_eq!(ms[0].start, (0, 0));
        assert_eq!(ms[0].end, (0, 1));
        assert_eq!(ms[1].start, (1, 2));
        assert_eq!(ms[1].end, (2, 2));
    }

    #[test]
    fn excel_dates_show_as_dates_not_serial_numbers() {
        use calamine::{ExcelDateTime, ExcelDateTimeType};
        let d = |v: f64| excel_datetime_text(&ExcelDateTime::new(v, ExcelDateTimeType::DateTime, false));
        assert_eq!(d(45292.0), "2024-01-01");
        assert_eq!(d(45292.5), "2024-01-01 12:00");
        assert_eq!(d(0.75), "18:00:00");
        let dur = ExcelDateTime::new(1.5, ExcelDateTimeType::TimeDelta, false);
        assert_eq!(excel_datetime_text(&dur), "36:00:00");
    }

    #[test]
    fn clip_merge_crops_to_window() {
        let d = Dimensions::new((0, 0), (1, 2));
        let m = clip_merge(&d, (0, 0), 10, 10).unwrap();
        assert_eq!((m.r, m.c, m.rowspan, m.colspan), (0, 0, 2, 3));
        assert!(clip_merge(&d, (0, 0), 1, 1).is_none()); // 裁成 1×1
        let edge = clip_merge(&Dimensions::new((8, 8), (20, 20)), (0, 0), 10, 10).unwrap();
        assert_eq!((edge.r, edge.c, edge.rowspan, edge.colspan), (8, 8, 2, 2));
        assert!(clip_merge(&Dimensions::new((10, 0), (12, 1)), (0, 0), 10, 10).is_none());
    }

    #[test]
    fn sheet_preview_reads_merged_cells() {
        let dir = std::env::temp_dir().join(format!("ccode-xlsx-merge-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.xlsx");
        write_minimal_xlsx(&f, "hello", true);
        let dto = read_sheet_preview_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap()), None, None)
            .expect("parse");
        assert!(
            dto.merges
                .iter()
                .any(|m| m.r == 0 && m.c == 0 && m.rowspan >= 1 && m.colspan >= 2),
            "{dto:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sheet_preview_reads_minimal_xlsx() {
        let dir = std::env::temp_dir().join(format!("ccode-xlsx-ok-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.xlsx");
        write_minimal_xlsx(&f, "hello", false);
        let dto = read_sheet_preview_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap()), None, None)
            .expect("parse");
        assert!(!dto.rows.is_empty());
        assert!(dto.total_rows >= 1);
        assert!(dto.total_cols >= 1);
        assert!(
            dto.rows
                .iter()
                .any(|r| r.iter().any(|c| c.contains("hello"))),
            "{dto:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn write_minimal_xlsx(path: &std::path::Path, cell: &str, merge_ab: bool) {
        // 手写一份 calamine 能读的最小 worksheet；共享字符串走 inlineStr 免 sst。
        let file = fs::File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let opt = SimpleFileOptions::default();
        zip.start_file("[Content_Types].xml", opt).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#,
        )
        .unwrap();
        zip.start_file("_rels/.rels", opt).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
        )
        .unwrap();
        zip.start_file("xl/_rels/workbook.xml.rels", opt).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#,
        )
        .unwrap();
        zip.start_file("xl/workbook.xml", opt).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
        )
        .unwrap();
        zip.start_file("xl/worksheets/sheet1.xml", opt).unwrap();
        let merge = if merge_ab {
            // calamine 只认 Start，不用自闭合
            "<mergeCells count=\"1\"><mergeCell ref=\"A1:B1\"></mergeCell></mergeCells>"
        } else {
            ""
        };
        let b1 = if merge_ab {
            r#"<c r="B1" t="inlineStr"><is><t></t></is></c>"#
        } else {
            ""
        };
        let sheet = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{}</t></is></c>{b1}</row></sheetData>
{merge}
</worksheet>"#,
            cell
        );
        zip.write_all(sheet.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
}
