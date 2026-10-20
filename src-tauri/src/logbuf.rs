// 诊断日志：进程内环形缓冲（不落盘），供设置页「诊断」分区查看
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use crate::sessions::now_iso;

const CAP: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntryDto {
    pub ts: String,
    pub level: String, // info | warn | error
    pub source: String,
    pub message: String,
}

fn buf() -> &'static Mutex<VecDeque<LogEntryDto>> {
    static BUF: OnceLock<Mutex<VecDeque<LogEntryDto>>> = OnceLock::new();
    BUF.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAP)))
}

/// level 归一化为 info/warn/error，超长消息截断防刷屏
fn make_entry(level: &str, source: &str, message: &str) -> LogEntryDto {
    let level = match level {
        "warn" | "error" => level,
        _ => "info",
    };
    LogEntryDto {
        ts: now_iso(),
        level: level.into(),
        source: source.into(),
        message: message.chars().take(2000).collect(),
    }
}

/// 满 CAP 丢最旧一条再追加
fn push_capped(q: &mut VecDeque<LogEntryDto>, entry: LogEntryDto) {
    if q.len() >= CAP {
        q.pop_front();
    }
    q.push_back(entry);
}

/// 取最近 limit 条（上限 CAP）
fn tail(q: &VecDeque<LogEntryDto>, limit: usize) -> Vec<LogEntryDto> {
    let limit = limit.min(CAP);
    q.iter().skip(q.len().saturating_sub(limit)).cloned().collect()
}

/// 出缓冲前脱敏（只作用于副本）
fn redacted(entries: Vec<LogEntryDto>) -> Vec<LogEntryDto> {
    entries
        .into_iter()
        .map(|mut entry| {
            entry.source = crate::sessions::redact_sensitive_text(&entry.source);
            entry.message = crate::sessions::redact_sensitive_text(&entry.message);
            entry
        })
        .collect()
}

/// 追加一条日志
pub fn record(level: &str, source: &str, message: &str) {
    let entry = make_entry(level, source, message);
    if let Ok(mut q) = buf().lock() {
        push_capped(&mut q, entry);
    }
}

#[tauri::command]
pub fn get_app_log(limit: usize) -> Vec<LogEntryDto> {
    let entries = match buf().lock() {
        Ok(q) => tail(&q, limit),
        Err(_) => return Vec::new(),
    };
    redacted(entries)
}

#[tauri::command]
pub fn clear_app_log() {
    if let Ok(mut q) = buf().lock() {
        q.clear();
    }
}

/// 导出当前缓冲到 ~/Downloads/ccode-logs-<时间戳>.txt，返回文件路径
#[tauri::command]
pub fn export_app_log() -> Result<String, String> {
    let entries = get_app_log(CAP);
    let text = entries
        .iter()
        .map(|l| format!("{} [{}] {}: {}", l.ts, l.level, l.source, l.message))
        .collect::<Vec<_>>()
        .join("\n");
    let dir = dirs::download_dir()
        .ok_or("无法确定下载目录")?
        .join("ccode-exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
    let path = dir.join(format!(
        "ccode-logs-{}.txt",
        now_iso().replace([':', '.'], "-")
    ));
    crate::profiles::atomic_write(&path, &text)?;
    Ok(path.to_string_lossy().into_owned())
}

/// 前端上报入口（window.onerror / unhandledrejection）
#[tauri::command]
pub fn log_event(level: String, source: String, message: String) {
    record(&level, &source, &message);
    #[cfg(debug_assertions)]
    eprintln!(
        "[{level}] {}: {}",
        crate::sessions::redact_sensitive_text(&source),
        crate::sessions::redact_sensitive_text(&message)
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    // 全局缓冲被其他测试（经 record 记日志的代码路径）并行写入，断言只针对本地缓冲上的纯逻辑
    fn local(entries: impl IntoIterator<Item = LogEntryDto>) -> VecDeque<LogEntryDto> {
        let mut q = VecDeque::new();
        for e in entries {
            push_capped(&mut q, e);
        }
        q
    }

    #[test]
    fn ring_buffer_caps_normalizes_and_truncates() {
        let q = local([make_entry("error", "test", "key sk-syntheticlogsecret123456")]);
        assert!(!redacted(tail(&q, 1))[0].message.contains("sk-syntheticlogsecret"));

        let q = local((0..(CAP + 20)).map(|i| make_entry("info", "test", &format!("m{i}"))));
        let all = tail(&q, CAP);
        assert_eq!(all.len(), CAP, "超过容量时只留最新 {CAP} 条");
        assert_eq!(all[0].message, "m20");
        assert_eq!(all[all.len() - 1].message, format!("m{}", CAP + 19));
        // limit 取最近 N 条；超过 CAP 的 limit 按 CAP 截
        let last3 = tail(&q, 3);
        assert_eq!(last3.len(), 3);
        assert_eq!(last3[2].message, format!("m{}", CAP + 19));
        assert_eq!(tail(&q, CAP * 2).len(), CAP);

        // 未知级别归一为 info；超长消息截断
        let all = tail(
            &local([make_entry("debug", "test", "x"), make_entry("error", "test", &"y".repeat(5000))]),
            10,
        );
        assert_eq!(all[0].level, "info");
        assert_eq!(all[1].level, "error");
        assert_eq!(all[1].message.chars().count(), 2000);
    }

    /// 全局入口：按唯一 source 标签找回自己写的那条并确认已脱敏，不假设缓冲里只有自己
    #[test]
    fn record_and_read_back_through_global_buffer() {
        let tag = format!("logbuf-test-pid{}", std::process::id());
        record("warn", &tag, "key sk-syntheticlogsecret654321");
        let mine: Vec<_> = get_app_log(CAP).into_iter().filter(|e| e.source == tag).collect();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].level, "warn");
        assert!(!mine[0].message.contains("sk-syntheticlogsecret"));
    }
}
