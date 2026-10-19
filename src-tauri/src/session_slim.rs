//! 会话瘦身（仅 Claude Code）：解决「网关 413 Request body too large」。
//!
//! 根因：Claude Code 每次提问都把整段历史连同 base64 截图原样重发一遍；做图/做视频这类要反复看画面的
//! 会话，几十张截图就能把请求体推过网关上限（官方 API 单请求 32 MB）。上限按字节算，token 还远没满，
//! 自动压缩不会触发；撞限之后 `/compact` 自己也要带同样的请求体，同样 413。413 本身也不会写进会话文件，
//! 所以检测只能靠估算请求体大小，不能靠错误文字。
//!
//! 两个入口：
//! - `session_slim_inspect`：只读，估算下一次请求体大小、数较早的截图；
//! - `session_slim_apply`：把较早的截图换成一行文字占位、只留最近 N 张，**原地**重写会话文件。
//!   这是「各 CLI 会话目录只读」的例外之一，只在用户点确认后发生；防护见 safety.md「会话瘦身」：
//!   canonicalize 后必须落在 `~/.claude/projects` 内、写前完整备份到 Mesa 备份目录、最近一分钟还有写入就拒绝、
//!   写完前复核源文件没被动过、tmp + rename 原子替换、保持原 mtime（列表顺序与用量标记不变）。
//!
//! 不做副本的原因：副本是新会话，要改每行 sessionId，否则 Mesa 取第一行 sessionId 会与原会话撞 id；
//! 用量按每条 assistant 行累计，副本还会把整段历史再算一遍。

use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use crate::sessions;
use crate::storage;

const AGENT: &str = "claude-code";
/// 默认保留最近几张：够 Claude 接着对照最近几步的画面，又只占约 3 MB
pub(crate) const DEFAULT_KEEP: usize = 6;
/// 文件小于它时请求体必然远低于告警线（请求体只是文件的一部分），免扫描
const SCAN_FLOOR_BYTES: u64 = 8 * 1024 * 1024;
const WARN_BODY_BYTES: u64 = 20 * 1024 * 1024;
const DANGER_BODY_BYTES: u64 = 30 * 1024 * 1024;
/// 与列表「进行中」同口径：最近一分钟还有写入，多半有进程在写，不动它
const RECENT_WRITE_SECS: u64 = 60;
const BACKUPS_KEPT_PER_SESSION: usize = 3;
const IMAGE_PLACEHOLDER: &str = "[Mesa 已移除较早的截图，缩小请求体]";
const DOCUMENT_PLACEHOLDER: &str = "[Mesa 已移除较早的文档附件，缩小请求体]";

/// 同一时刻只做一次瘦身，避免两次点击交错备份/替换同一文件
static SLIM_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlimInspectDto {
    /// 非 Claude Code / 不在会话白名单内 / 读不了：前端不显示任何瘦身入口
    pub supported: bool,
    pub file_bytes: u64,
    /// false = 文件太小，没扫描（数字全是 0，不代表没有图）
    pub scanned: bool,
    /// 下次请求会带上的截图/文档附件张数（只算最近一次压缩之后）
    pub media_count: usize,
    pub media_bytes: u64,
    /// 下次请求体的估算字节数（只算会发出去的 user/assistant 消息）
    pub body_bytes: u64,
    /// ok / warn / danger
    pub level: String,
    /// 按默认保留数，可移除多少张
    pub removable: usize,
    pub keep: usize,
    /// 最近一分钟还有写入：前端提示先停掉那个进程
    pub recently_written: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlimApplyDto {
    pub removed: usize,
    pub kept: usize,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub body_before: u64,
    pub body_after: u64,
    pub backup_path: String,
}

// ===== 扫描 =====

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Scan {
    media_count: usize,
    media_bytes: u64,
    body_bytes: u64,
    /// 最近一次压缩边界所在行；之前的消息不会再发给模型，原样不动
    boundary_line: Option<usize>,
}

fn is_media_block(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    matches!(
        o.get("type").and_then(Value::as_str),
        Some("image" | "document")
    ) && o
        .get("source")
        .and_then(|s| s.get("type"))
        .and_then(Value::as_str)
        == Some("base64")
}

fn media_data_len(v: &Value) -> usize {
    v.get("source")
        .and_then(|s| s.get("data"))
        .and_then(Value::as_str)
        .map_or(0, str::len)
}

/// 压缩边界：`system/compact_boundary` 或压缩摘要消息（`isCompactSummary`）。
/// 格式取自 Claude Code 公开行为，本机没有压缩过的样本，未在真实数据上实测；
/// 认不出时的后果是「把压缩前的图也算进请求体」，只会多提示，不会误删。
fn is_compaction_boundary(v: &Value) -> bool {
    (v.get("type").and_then(Value::as_str) == Some("system")
        && v.get("subtype").and_then(Value::as_str) == Some("compact_boundary"))
        || v.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
}

fn is_chat_line(v: &Value) -> bool {
    matches!(
        v.get("type").and_then(Value::as_str),
        Some("user" | "assistant")
    )
}

fn count_media(v: &Value, scan: &mut Scan) {
    if is_media_block(v) {
        scan.media_count += 1;
        scan.media_bytes += media_data_len(v) as u64;
        return;
    }
    match v {
        Value::Array(a) => a.iter().for_each(|x| count_media(x, scan)),
        Value::Object(o) => o.values().for_each(|x| count_media(x, scan)),
        _ => {}
    }
}

fn scan_reader<R: BufRead>(mut r: R) -> Result<Scan, String> {
    let mut scan = Scan::default();
    let mut buf = Vec::new();
    let mut index = 0usize;
    loop {
        buf.clear();
        let n = r
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("读取会话文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        if let Ok(v) = serde_json::from_slice::<Value>(&buf) {
            if is_compaction_boundary(&v) {
                scan = Scan {
                    boundary_line: Some(index),
                    ..Scan::default()
                };
            }
            if is_chat_line(&v) {
                if let Some(msg) = v.get("message") {
                    scan.body_bytes += serde_json::to_vec(msg).map_or(0, |b| b.len() as u64);
                    count_media(msg, &mut scan);
                }
            }
        }
        index += 1;
    }
    Ok(scan)
}

// ===== 重写 =====

#[derive(Debug, Default, PartialEq, Eq)]
struct RewriteStats {
    removed: usize,
    removed_bytes: u64,
}

struct Strip {
    seen: usize,
    drop_first: usize,
    stats: RewriteStats,
}

/// 按出现顺序把前 drop_first 个媒体块换成文字占位；返回这棵树有没有改动
fn strip_media(v: &mut Value, st: &mut Strip) -> bool {
    if is_media_block(v) {
        st.seen += 1;
        if st.seen > st.drop_first {
            return false;
        }
        let placeholder = if v.get("type").and_then(Value::as_str) == Some("document") {
            DOCUMENT_PLACEHOLDER
        } else {
            IMAGE_PLACEHOLDER
        };
        st.stats.removed += 1;
        st.stats.removed_bytes += media_data_len(v) as u64;
        *v = serde_json::json!({ "type": "text", "text": placeholder });
        return true;
    }
    let mut changed = false;
    match v {
        Value::Array(a) => {
            for x in a.iter_mut() {
                changed |= strip_media(x, st);
            }
        }
        Value::Object(o) => {
            for x in o.values_mut() {
                changed |= strip_media(x, st);
            }
        }
        _ => {}
    }
    changed
}

fn contains_base64(buf: &[u8]) -> bool {
    buf.windows(6).any(|w| w == b"base64")
}

/// 流式重写。没动的行逐字节原样写出；只有被换掉截图的行才重新序列化。
/// `toolUseResult.file.base64` 是同一张图给界面显示用的副本，不发给模型，被换掉截图的行一并去掉，
/// 否则文件里每张图还占着两份。
fn rewrite<R: BufRead, W: Write>(
    mut r: R,
    mut w: W,
    boundary_line: Option<usize>,
    drop_first: usize,
) -> Result<RewriteStats, String> {
    let mut st = Strip {
        seen: 0,
        drop_first,
        stats: RewriteStats::default(),
    };
    let mut buf = Vec::new();
    let mut index = 0usize;
    let io = |e: std::io::Error| format!("写入瘦身文件失败：{e}");
    loop {
        buf.clear();
        let n = r
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("读取会话文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        let dormant = boundary_line.is_some_and(|b| index < b);
        index += 1;
        if dormant || !contains_base64(&buf) {
            w.write_all(&buf).map_err(io)?;
            continue;
        }
        let Ok(mut v) = serde_json::from_slice::<Value>(&buf) else {
            w.write_all(&buf).map_err(io)?;
            continue;
        };
        let mut changed = false;
        if is_chat_line(&v) {
            if let Some(msg) = v.get_mut("message") {
                changed = strip_media(msg, &mut st);
            }
        }
        if !changed {
            w.write_all(&buf).map_err(io)?;
            continue;
        }
        if v.get("toolUseResult")
            .and_then(|t| t.get("file"))
            .and_then(|f| f.get("base64"))
            .is_some_and(Value::is_string)
        {
            if let Some(o) = v.as_object_mut() {
                o.remove("toolUseResult");
            }
        }
        let mut out = serde_json::to_vec(&v).map_err(|e| format!("序列化会话行失败：{e}"))?;
        if buf.ends_with(b"\n") {
            out.push(b'\n');
        }
        w.write_all(&out).map_err(io)?;
    }
    Ok(st.stats)
}

// ===== 备份 =====

fn backup_dir() -> Result<PathBuf, String> {
    Ok(storage::config_root()
        .ok_or("无法确定配置目录")?
        .join("backups")
        .join("session-slim"))
}

fn make_backup(src: &Path, dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("会话文件名无效")?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut dst = dir.join(format!("{stem}-{stamp}.jsonl"));
    let mut n = 1;
    while dst.exists() {
        n += 1;
        dst = dir.join(format!("{stem}-{stamp}-{n}.jsonl"));
    }
    let copied =
        fs::copy(src, &dst).map_err(|e| format!("备份原会话失败（原文件没有改动）：{e}"))?;
    let want = fs::metadata(src).map(|m| m.len()).unwrap_or(copied);
    if copied != want {
        let _ = fs::remove_file(&dst);
        return Err("备份大小与原文件不一致，已放弃（原文件没有改动）".into());
    }
    Ok(dst)
}

/// 同一会话只留最近几份备份（文件名里的时间戳可按字典序排）
fn prune_backups(dir: &Path, stem: &str, keep: usize) {
    let prefix = format!("{stem}-");
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    let mut mine: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".jsonl"))
        })
        .collect();
    mine.sort();
    mine.reverse();
    for old in mine.into_iter().skip(keep) {
        let _ = fs::remove_file(old);
    }
}

// ===== 应用 =====

fn recently_written(mtime: SystemTime, guard_secs: u64) -> bool {
    guard_secs > 0
        && SystemTime::now()
            .duration_since(mtime)
            .map_or(true, |d| d < Duration::from_secs(guard_secs))
}

fn apply_file(
    path: &Path,
    keep: usize,
    backups: &Path,
    guard_secs: u64,
) -> Result<SlimApplyDto, String> {
    let _guard = SLIM_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let meta = fs::metadata(path).map_err(|e| format!("读取会话文件失败：{e}"))?;
    let (len0, mtime0) = (meta.len(), meta.modified().map_err(|e| e.to_string())?);
    if recently_written(mtime0, guard_secs) {
        return Err(
            "这条会话最近一分钟内还有写入，可能有进程正在用它。请先在那边停止并退出这条会话，再来瘦身。".into(),
        );
    }
    let file = File::open(path).map_err(|e| format!("打开会话文件失败：{e}"))?;
    let scan = scan_reader(BufReader::new(file))?;
    if scan.media_count <= keep {
        return Err(format!(
            "这条会话只有 {} 张截图，不超过要保留的 {keep} 张，没有可移除的。",
            scan.media_count
        ));
    }
    let drop_first = scan.media_count - keep;

    let backup = make_backup(path, backups)?;
    let tmp = path.with_file_name(format!(".ccode-slim-{}.tmp", uuid::Uuid::new_v4()));
    let cleanup = |tmp: &Path, backup: &Path| {
        let _ = fs::remove_file(tmp);
        let _ = fs::remove_file(backup);
    };

    let written = (|| -> Result<RewriteStats, String> {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let out = options
            .open(&tmp)
            .map_err(|e| format!("创建临时文件失败：{e}"))?;
        let mut w = BufWriter::new(out);
        let src = File::open(path).map_err(|e| format!("打开会话文件失败：{e}"))?;
        let stats = rewrite(BufReader::new(src), &mut w, scan.boundary_line, drop_first)?;
        w.flush().map_err(|e| format!("写入瘦身文件失败：{e}"))?;
        w.get_ref()
            .sync_all()
            .map_err(|e| format!("写入瘦身文件失败：{e}"))?;
        Ok(stats)
    })();
    let stats = match written {
        Ok(s) => s,
        Err(e) => {
            cleanup(&tmp, &backup);
            return Err(e);
        }
    };

    // 复核源文件在我们读它的这段时间里没被动过；动过说明有进程在写，放弃，原文件一字未改
    let unchanged = fs::metadata(path)
        .ok()
        .is_some_and(|m| m.len() == len0 && m.modified().ok() == Some(mtime0));
    if !unchanged {
        cleanup(&tmp, &backup);
        return Err(
            "瘦身过程中这条会话又有新写入，已放弃（原文件没有改动）。请先停掉正在用它的进程再试。"
                .into(),
        );
    }
    if let Ok(f) = fs::OpenOptions::new().write(true).open(&tmp) {
        let _ = f.set_modified(mtime0);
    }
    if let Err(e) = storage::replace(&tmp, path) {
        cleanup(&tmp, &backup);
        return Err(e);
    }

    let bytes_after = fs::metadata(path).map_or(0, |m| m.len());
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        prune_backups(backups, stem, BACKUPS_KEPT_PER_SESSION);
    }
    Ok(SlimApplyDto {
        removed: stats.removed,
        kept: scan.media_count - stats.removed,
        bytes_before: len0,
        bytes_after,
        body_before: scan.body_bytes,
        body_after: scan.body_bytes.saturating_sub(stats.removed_bytes),
        backup_path: backup.to_string_lossy().into_owned(),
    })
}

// ===== 检测 =====

fn level_of(body_bytes: u64) -> &'static str {
    if body_bytes >= DANGER_BODY_BYTES {
        "danger"
    } else if body_bytes >= WARN_BODY_BYTES {
        "warn"
    } else {
        "ok"
    }
}

fn unsupported() -> SlimInspectDto {
    SlimInspectDto {
        supported: false,
        file_bytes: 0,
        scanned: false,
        media_count: 0,
        media_bytes: 0,
        body_bytes: 0,
        level: "ok".into(),
        removable: 0,
        keep: DEFAULT_KEEP,
        recently_written: false,
    }
}

fn inspect_file(path: &Path) -> SlimInspectDto {
    let Ok(meta) = fs::metadata(path) else {
        return unsupported();
    };
    let mut dto = SlimInspectDto {
        supported: true,
        file_bytes: meta.len(),
        recently_written: meta
            .modified()
            .is_ok_and(|m| recently_written(m, RECENT_WRITE_SECS)),
        ..unsupported()
    };
    if meta.len() < SCAN_FLOOR_BYTES {
        return dto;
    }
    let Ok(file) = File::open(path) else {
        return unsupported();
    };
    let Ok(scan) = scan_reader(BufReader::new(file)) else {
        return unsupported();
    };
    dto.scanned = true;
    dto.media_count = scan.media_count;
    dto.media_bytes = scan.media_bytes;
    dto.body_bytes = scan.body_bytes;
    dto.level = level_of(scan.body_bytes).into();
    dto.removable = scan.media_count.saturating_sub(DEFAULT_KEEP);
    dto
}

/// 只认 `~/.claude/projects/**.jsonl`：canonicalize 后落在该根内（防符号链接绕过），
/// 且同时通过全站会话文件白名单。agent 不是 Claude Code 一律不认。
fn resolve_target(agent: &str, file_path: &str, home: &Path) -> Option<PathBuf> {
    if agent != AGENT {
        return None;
    }
    let canon = Path::new(file_path).canonicalize().ok()?;
    let root = home.join(".claude").join("projects").canonicalize().ok()?;
    let dirs = sessions::session_data_dirs_at(home);
    (canon.starts_with(&root)
        && canon.extension().is_some_and(|e| e == "jsonl")
        && sessions::deletable_session_file(&canon, &dirs))
    .then_some(canon)
}

fn inspect_at(agent: &str, file_path: &str, home: &Path) -> SlimInspectDto {
    resolve_target(agent, file_path, home).map_or_else(unsupported, |p| inspect_file(&p))
}

fn inspect_impl(agent: &str, file_path: &str) -> SlimInspectDto {
    dirs::home_dir().map_or_else(unsupported, |home| inspect_at(agent, file_path, &home))
}

fn apply_impl(agent: &str, file_path: &str, keep: Option<usize>) -> Result<SlimApplyDto, String> {
    let home = dirs::home_dir().ok_or("无法确定用户目录")?;
    let path = resolve_target(agent, file_path, &home)
        .ok_or("只支持 ~/.claude/projects 下的 Claude Code 会话文件")?;
    let result = apply_file(
        &path,
        keep.unwrap_or(DEFAULT_KEEP),
        &backup_dir()?,
        RECENT_WRITE_SECS,
    );
    sessions::invalidate_scan_cache();
    result
}

#[tauri::command]
pub async fn session_slim_inspect(
    agent: String,
    file_path: String,
) -> Result<SlimInspectDto, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_impl(&agent, &file_path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_slim_apply(
    agent: String,
    file_path: String,
    keep: Option<usize>,
) -> Result<SlimApplyDto, String> {
    tauri::async_runtime::spawn_blocking(move || apply_impl(&agent, &file_path, keep))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn img(data: &str) -> Value {
        serde_json::json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":data}})
    }

    /// 一条携带若干截图的 user 行（工具结果里的截图 + 界面用副本）
    fn tool_result_line(id: &str, datas: &[&str]) -> String {
        let content: Vec<Value> = datas.iter().map(|d| img(d)).collect();
        serde_json::json!({
            "type": "user",
            "uuid": id,
            "sessionId": "sid-1",
            "message": {"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":content}]},
            "toolUseResult": {"type":"image","file":{"base64": datas[0]}},
        })
        .to_string()
    }

    fn text_line(kind: &str, text: &str) -> String {
        serde_json::json!({"type":kind,"sessionId":"sid-1","message":{"role":kind,"content":[{"type":"text","text":text}]}})
            .to_string()
    }

    fn jsonl(lines: &[String]) -> String {
        lines.join("\n") + "\n"
    }

    fn media_in(file: &str) -> Vec<String> {
        let mut out = Vec::new();
        for l in file.lines() {
            let v: Value = serde_json::from_str(l).unwrap();
            fn walk(v: &Value, out: &mut Vec<String>) {
                if is_media_block(v) {
                    out.push(v["source"]["data"].as_str().unwrap().to_string());
                    return;
                }
                match v {
                    Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
                    Value::Object(o) => o.values().for_each(|x| walk(x, out)),
                    _ => {}
                }
            }
            if let Some(m) = v.get("message") {
                walk(m, &mut out);
            }
        }
        out
    }

    fn sample() -> String {
        jsonl(&[
            text_line("user", "开工"),
            tool_result_line("a", &["IMG1"]),
            tool_result_line("b", &["IMG2", "IMG3"]),
            text_line("assistant", "看完了"),
            tool_result_line("c", &["IMG4"]),
        ])
    }

    #[test]
    fn scan_counts_media_and_body() {
        let s = sample();
        let scan = scan_reader(Cursor::new(s.as_bytes())).unwrap();
        assert_eq!(scan.media_count, 4);
        assert_eq!(scan.media_bytes, 16);
        assert!(scan.body_bytes > 16);
        assert_eq!(scan.boundary_line, None);
    }

    #[test]
    fn scan_ignores_everything_before_last_compaction_boundary() {
        let s = jsonl(&[
            tool_result_line("a", &["OLD1", "OLD2"]),
            serde_json::json!({"type":"system","subtype":"compact_boundary"}).to_string(),
            serde_json::json!({"type":"user","isCompactSummary":true,"message":{"role":"user","content":"摘要"}})
                .to_string(),
            tool_result_line("b", &["NEW1"]),
        ]);
        let scan = scan_reader(Cursor::new(s.as_bytes())).unwrap();
        assert_eq!(scan.media_count, 1);
        assert_eq!(scan.boundary_line, Some(2));
    }

    #[test]
    fn rewrite_drops_oldest_keeps_latest_and_other_lines_stay_byte_identical() {
        let s = sample();
        let mut out = Vec::new();
        let st = rewrite(Cursor::new(s.as_bytes()), &mut out, None, 3).unwrap();
        assert_eq!(st.removed, 3);
        assert_eq!(st.removed_bytes, 12);
        let out = String::from_utf8(out).unwrap();
        assert_eq!(media_in(&out), vec!["IMG4".to_string()]);
        let before: Vec<&str> = s.lines().collect();
        let after: Vec<&str> = out.lines().collect();
        assert_eq!(before.len(), after.len());
        // 没带图的行与最后一条（保留的图）原样；被换图的行带占位文字
        assert_eq!(before[0], after[0]);
        assert_eq!(before[3], after[3]);
        assert_eq!(before[4], after[4]);
        assert!(after[1].contains(IMAGE_PLACEHOLDER));
        assert!(after[2].contains(IMAGE_PLACEHOLDER));
        // 界面副本一并去掉，否则文件里每张图还占着两份
        assert!(!after[1].contains("toolUseResult"));
        assert!(!after[2].contains("IMG2"));
    }

    #[test]
    fn rewrite_handles_user_pasted_image_and_document() {
        let paste = serde_json::json!({"type":"user","message":{"role":"user","content":[
            {"type":"text","text":"看这张"},
            img("PASTED"),
            {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"PDF"}}
        ]}})
        .to_string();
        let s = jsonl(&[paste, tool_result_line("a", &["IMG1"])]);
        let mut out = Vec::new();
        let st = rewrite(Cursor::new(s.as_bytes()), &mut out, None, 2).unwrap();
        assert_eq!(st.removed, 2);
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains(IMAGE_PLACEHOLDER));
        assert!(out.contains(DOCUMENT_PLACEHOLDER));
        assert_eq!(media_in(&out), vec!["IMG1".to_string()]);
    }

    #[test]
    fn rewrite_leaves_dormant_lines_before_boundary_alone() {
        let s = jsonl(&[
            tool_result_line("a", &["OLD1"]),
            serde_json::json!({"type":"system","subtype":"compact_boundary"}).to_string(),
            tool_result_line("b", &["NEW1", "NEW2"]),
        ]);
        let mut out = Vec::new();
        let st = rewrite(Cursor::new(s.as_bytes()), &mut out, Some(1), 1).unwrap();
        assert_eq!(st.removed, 1);
        let out = String::from_utf8(out).unwrap();
        assert_eq!(media_in(&out), vec!["OLD1".to_string(), "NEW2".to_string()]);
    }

    #[test]
    fn rewrite_keeps_unparseable_lines_verbatim_and_missing_trailing_newline() {
        let s = format!("这行不是 JSON base64\n{}", tool_result_line("a", &["IMG1"]));
        let mut out = Vec::new();
        rewrite(Cursor::new(s.as_bytes()), &mut out, None, 1).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert!(out.starts_with("这行不是 JSON base64\n"));
        assert!(!out.ends_with('\n'));
        assert!(out.contains(IMAGE_PLACEHOLDER));
    }

    fn fake_home() -> (PathBuf, PathBuf) {
        let home = tmp();
        let dir = home.join(".claude").join("projects").join("-tmp-proj");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("1d7dfe92-b5f2-4bd8-a33c-216afa38b8b5.jsonl");
        (home, file)
    }

    fn age(path: &Path, secs: u64) {
        let f = fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs))
            .unwrap();
    }

    #[test]
    fn apply_end_to_end_backs_up_rewrites_and_keeps_mtime() {
        let (home, file) = fake_home();
        let original = sample();
        fs::write(&file, &original).unwrap();
        age(&file, 3600);
        let mtime = fs::metadata(&file).unwrap().modified().unwrap();
        let backups = home.join("backups");

        let r = apply_file(&file, 1, &backups, RECENT_WRITE_SECS).unwrap();
        assert_eq!((r.removed, r.kept), (3, 1));
        assert!(r.bytes_after < r.bytes_before);
        assert!(r.body_after < r.body_before);

        let now = fs::read_to_string(&file).unwrap();
        assert_eq!(media_in(&now), vec!["IMG4".to_string()]);
        assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), mtime);
        // 备份是写前原文，且在备份目录里
        assert_eq!(fs::read_to_string(&r.backup_path).unwrap(), original);
        assert!(Path::new(&r.backup_path).starts_with(&backups));
        // 目录里不留临时文件
        let leftovers: Vec<_> = fs::read_dir(file.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn apply_refuses_recently_written_session_and_touches_nothing() {
        let (home, file) = fake_home();
        fs::write(&file, sample()).unwrap();
        let backups = home.join("backups");
        let err = apply_file(&file, 1, &backups, RECENT_WRITE_SECS).unwrap_err();
        assert!(err.contains("最近一分钟"));
        assert_eq!(fs::read_to_string(&file).unwrap(), sample());
        assert!(!backups.exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn apply_refuses_when_nothing_to_remove() {
        let (home, file) = fake_home();
        fs::write(&file, sample()).unwrap();
        age(&file, 3600);
        let err = apply_file(&file, 6, &home.join("backups"), RECENT_WRITE_SECS).unwrap_err();
        assert!(err.contains("没有可移除"));
        assert_eq!(fs::read_to_string(&file).unwrap(), sample());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn prune_backups_keeps_newest_per_session_only() {
        let d = tmp();
        for stamp in [
            "20261018-100000",
            "20261018-110000",
            "20261018-120000",
            "20261018-130000",
        ] {
            fs::write(d.join(format!("sid-{stamp}.jsonl")), "x").unwrap();
        }
        fs::write(d.join("other-20261018-100000.jsonl"), "x").unwrap();
        prune_backups(&d, "sid", 3);
        let mut names: Vec<String> = fs::read_dir(&d)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "other-20261018-100000.jsonl",
                "sid-20261018-110000.jsonl",
                "sid-20261018-120000.jsonl",
                "sid-20261018-130000.jsonl",
            ]
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn inspect_skips_scan_for_small_files_and_flags_unsupported_targets() {
        let (home, file) = fake_home();
        fs::write(&file, sample()).unwrap();
        let small = inspect_at(AGENT, file.to_str().unwrap(), &home);
        assert!(small.supported && !small.scanned);
        assert_eq!(small.level, "ok");

        assert!(!inspect_at("codex", file.to_str().unwrap(), &home).supported);
        let outside = home.join("elsewhere.jsonl");
        fs::write(&outside, sample()).unwrap();
        assert!(!inspect_at(AGENT, outside.to_str().unwrap(), &home).supported);
        assert!(!inspect_at(AGENT, home.join("nope.jsonl").to_str().unwrap(), &home).supported);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn levels_follow_body_size_not_file_size() {
        assert_eq!(level_of(0), "ok");
        assert_eq!(level_of(WARN_BODY_BYTES - 1), "ok");
        assert_eq!(level_of(WARN_BODY_BYTES), "warn");
        assert_eq!(level_of(DANGER_BODY_BYTES), "danger");
    }

    /// 真实数据干跑（AGENTS.md「动真实数据先干跑」）：不进常规测试。走完整命令层——
    /// HOME 指向临时目录，把真实会话副本放进 <HOME>/.claude/projects 下，依次调 inspect_impl / apply_impl，
    /// 白名单、真实 home 解析、备份目录落点（config_root）都用生产路径。
    /// 用法：CCODE_SLIM_DRYRUN_FILE=<会话文件绝对路径> cargo test real_data_dry_run -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_data_dry_run() {
        let Ok(src) = std::env::var("CCODE_SLIM_DRYRUN_FILE") else {
            panic!("先设 CCODE_SLIM_DRYRUN_FILE");
        };
        let src = PathBuf::from(src);
        let home = tmp();
        let dir = home.join(".claude").join("projects").join("-dryrun");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(src.file_name().unwrap());
        fs::copy(&src, &file).unwrap();
        let mtime = fs::metadata(&src).unwrap().modified().unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        // 只此一个测试在跑（--ignored 单独调用），改 HOME 不会串到别的测试
        std::env::set_var("HOME", &home);
        let path = file.to_str().unwrap();

        let before = inspect_impl(AGENT, path);
        println!("inspect before: {before:?}");
        assert!(before.supported && before.scanned);
        let r = apply_impl(AGENT, path, None).unwrap();
        println!("apply: {r:?}");
        let after = inspect_impl(AGENT, path);
        println!("inspect after: {after:?}");

        assert_eq!(after.media_count, DEFAULT_KEEP.min(before.media_count));
        assert!(after.body_bytes < before.body_bytes);
        assert!(Path::new(&r.backup_path).starts_with(backup_dir().unwrap()));
        assert_eq!(fs::metadata(&r.backup_path).unwrap().len(), r.bytes_before);
        assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), mtime);
        for (i, line) in fs::read_to_string(&file).unwrap().lines().enumerate() {
            assert!(
                serde_json::from_str::<Value>(line).is_ok(),
                "第 {i} 行不是合法 JSON"
            );
        }
        // 白名单：同一个副本放到 .claude/projects 之外一律不认
        let outside = home.join("elsewhere.jsonl");
        fs::copy(&file, &outside).unwrap();
        assert!(apply_impl(AGENT, outside.to_str().unwrap(), None).is_err());
        println!("backup dir: {}", backup_dir().unwrap().display());
        let _ = fs::remove_dir_all(&home);
    }
}
