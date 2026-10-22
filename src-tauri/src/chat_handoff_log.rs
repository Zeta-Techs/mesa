//! 聊天层转到终端的次数（2026-10-22）：哪家、为什么聊天层接不住、要露出或切到终端。
//!
//! 只记「哪家 / 哪个原因（+细分）/ 哪天 / CLI 版本」的计数，不记屏上文字、会话内容、路径——
//! 用来排聊天层下一步该补什么（设置「诊断」里看，诊断包附计数）。原因是闭集，前端
//! `src/chat-handoff-log.ts` 同名镜像；不认识的原因直接拒，不落库。

use rusqlite::{params, Connection};
use serde::Serialize;

/// 闭集：自动拉起三类 + 用户手动四类（含义见前端 `HANDOFF_REASON_LABEL`）
pub(crate) const REASONS: &[&str] = &[
    "confirm_unrecognized",
    "confirm_no_state",
    "stuck_start",
    "picker",
    "user_decision",
    "user_live",
    "user_stuck",
    "user_switch",
];

/// 保留天数：只为排优先级，太旧的版本不再有参考价值
const KEEP_DAYS: i64 = 180;

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_handoff_events (
          day TEXT NOT NULL,
          agent TEXT NOT NULL,
          cli_version TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (day, agent, cli_version, reason, detail)
        );",
    )
    .map_err(|e| format!("初始化 chat_handoff_events 表失败: {e}"))
}

fn valid_agent(agent: &str) -> bool {
    crate::agent_specs::agent_spec(agent).is_some()
}

/// 细分只收短标识（如确认卡的种类 approval / ask / tui-panel），防止把屏上文字塞进来
fn valid_detail(detail: &str) -> bool {
    detail.len() <= 24
        && detail
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

pub(crate) fn record_at(
    conn: &Connection,
    day: &str,
    agent: &str,
    cli_version: &str,
    reason: &str,
    detail: &str,
) -> Result<(), String> {
    if !REASONS.contains(&reason) {
        return Err(format!("未知原因：{reason}"));
    }
    if !valid_detail(detail) {
        return Err("细分只能是短标识".into());
    }
    if !valid_agent(agent) {
        return Err(format!("未知 agent：{agent}"));
    }
    ensure_schema(conn)?;
    conn.execute(
        "INSERT INTO chat_handoff_events(day, agent, cli_version, reason, detail, count)
         VALUES (?1, ?2, ?3, ?4, ?5, 1)
         ON CONFLICT(day, agent, cli_version, reason, detail) DO UPDATE SET count = count + 1",
        params![day, agent, cli_version, reason, detail],
    )
    .map_err(|e| format!("记录失败: {e}"))?;
    if let Some(cutoff) = day_offset(day, -KEEP_DAYS) {
        let _ = conn.execute(
            "DELETE FROM chat_handoff_events WHERE day < ?1",
            params![cutoff],
        );
    }
    Ok(())
}

fn day_offset(day: &str, delta: i64) -> Option<String> {
    let d = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    Some((d + chrono::Duration::days(delta)).format("%Y-%m-%d").to_string())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatHandoffStat {
    pub agent: String,
    pub reason: String,
    /// 细分（空串 = 不细分）
    pub detail: String,
    pub count: i64,
    pub last_day: String,
    /// 出现过的 CLI 版本，新的在前（查不到版本的不列）
    pub versions: Vec<String>,
}

/// 按 agent + 原因 + 细分合计，次数多的在前；`since` 为 None 时看全部保留期
pub(crate) fn summary_at(
    conn: &Connection,
    since: Option<&str>,
) -> Result<Vec<ChatHandoffStat>, String> {
    ensure_schema(conn)?;
    let since = since.unwrap_or("");
    let mut stmt = conn
        .prepare(
            "SELECT agent, reason, detail, cli_version, SUM(count), MAX(day)
             FROM chat_handoff_events WHERE day >= ?1
             GROUP BY agent, reason, detail, cli_version",
        )
        .map_err(|e| format!("读取失败: {e}"))?;
    let rows = stmt
        .query_map(params![since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| format!("读取失败: {e}"))?;
    let mut out: Vec<ChatHandoffStat> = Vec::new();
    // 版本按最近出现日排，同日按版本串倒序
    let mut ver_days: Vec<(usize, String, String)> = Vec::new();
    for row in rows {
        let (agent, reason, detail, ver, count, last) =
            row.map_err(|e| format!("读取失败: {e}"))?;
        let idx = match out
            .iter()
            .position(|s| s.agent == agent && s.reason == reason && s.detail == detail)
        {
            Some(i) => i,
            None => {
                out.push(ChatHandoffStat {
                    agent,
                    reason,
                    detail,
                    count: 0,
                    last_day: String::new(),
                    versions: Vec::new(),
                });
                out.len() - 1
            }
        };
        let stat = &mut out[idx];
        stat.count += count;
        if last > stat.last_day {
            stat.last_day = last.clone();
        }
        if !ver.is_empty() {
            ver_days.push((idx, ver, last));
        }
    }
    ver_days.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.1.cmp(&a.1)));
    for (idx, ver, _) in ver_days {
        if !out[idx].versions.contains(&ver) {
            out[idx].versions.push(ver);
        }
    }
    out.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| b.last_day.cmp(&a.last_day))
            .then_with(|| a.agent.cmp(&b.agent))
            .then_with(|| a.reason.cmp(&b.reason))
            .then_with(|| a.detail.cmp(&b.detail))
    });
    Ok(out)
}

fn version_text(agent: &str) -> String {
    crate::agents::cli_version(agent)
        .map(|(a, b, c)| format!("{a}.{b}.{c}"))
        .unwrap_or_default()
}

/// 诊断包附带的计数（只有 agent / 原因 / 次数 / 版本 / 日期）；读不到就空表，不挡导出
pub(crate) fn summary_for_bundle() -> serde_json::Value {
    let stats = crate::sessions::open_db()
        .and_then(|conn| summary_at(&conn, None))
        .unwrap_or_default();
    serde_json::json!({
        "note": "聊天层转到终端的次数：哪家、什么原因。只有计数，不含屏上文字与会话内容",
        "keepDays": KEEP_DAYS,
        "stats": stats,
    })
}

#[tauri::command]
pub async fn chat_handoff_record(
    agent: String,
    reason: String,
    detail: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let version = version_text(&agent);
        let conn = crate::sessions::open_db()?;
        let detail = detail.unwrap_or_default();
        record_at(&conn, &crate::usage::today_local(), &agent, &version, &reason, &detail)
    })
    .await
    .map_err(|e| format!("记录任务失败: {e}"))?
}

#[tauri::command]
pub async fn chat_handoff_summary(days: Option<i64>) -> Result<Vec<ChatHandoffStat>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sessions::open_db()?;
        let since = days
            .filter(|d| *d > 0)
            .and_then(|d| day_offset(&crate::usage::today_local(), -(d - 1)));
        summary_at(&conn, since.as_deref())
    })
    .await
    .map_err(|e| format!("读取任务失败: {e}"))?
}

#[tauri::command]
pub async fn chat_handoff_clear() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sessions::open_db()?;
        ensure_schema(&conn)?;
        conn.execute("DELETE FROM chat_handoff_events", [])
            .map(|_| ())
            .map_err(|e| format!("清空失败: {e}"))
    })
    .await
    .map_err(|e| format!("清空任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn counts_merge_and_sort_by_frequency() {
        let c = mem();
        for _ in 0..3 {
            record_at(&c, "2026-10-20", "claude-code", "2.1.300", "confirm_unrecognized", "").unwrap();
        }
        record_at(&c, "2026-10-22", "claude-code", "2.1.306", "confirm_unrecognized", "").unwrap();
        record_at(&c, "2026-10-22", "codex", "", "picker", "").unwrap();
        let s = summary_at(&c, None).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].agent, "claude-code");
        assert_eq!(s[0].count, 4);
        assert_eq!(s[0].last_day, "2026-10-22");
        assert_eq!(s[0].versions, vec!["2.1.306", "2.1.300"]);
        assert_eq!(s[1].reason, "picker");
        assert!(s[1].versions.is_empty());
    }

    #[test]
    fn detail_splits_rows() {
        let c = mem();
        record_at(&c, "2026-10-22", "codex", "", "user_decision", "approval").unwrap();
        record_at(&c, "2026-10-22", "codex", "", "user_decision", "approval").unwrap();
        record_at(&c, "2026-10-22", "codex", "", "user_decision", "tui-panel").unwrap();
        let s = summary_at(&c, None).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].detail.as_str(), s[0].count), ("approval", 2));
    }

    #[test]
    fn since_filters_older_days() {
        let c = mem();
        record_at(&c, "2026-09-01", "qwen", "", "stuck_start", "").unwrap();
        record_at(&c, "2026-10-22", "qwen", "", "stuck_start", "").unwrap();
        let s = summary_at(&c, Some("2026-10-01")).unwrap();
        assert_eq!(s[0].count, 1);
    }

    #[test]
    fn rejects_unknown_reason_and_agent() {
        let c = mem();
        assert!(record_at(&c, "2026-10-22", "claude-code", "", "whatever", "").is_err());
        assert!(record_at(&c, "2026-10-22", "not-an-agent", "", "picker", "").is_err());
        assert!(record_at(&c, "2026-10-22", "codex", "", "user_decision", "Run rm -rf").is_err());
        assert!(summary_at(&c, None).unwrap().is_empty());
    }

    #[test]
    fn old_rows_are_pruned_on_record() {
        let c = mem();
        record_at(&c, "2026-01-01", "kimi", "", "user_live", "").unwrap();
        record_at(&c, "2026-10-22", "kimi", "", "user_live", "").unwrap();
        let s = summary_at(&c, None).unwrap();
        assert_eq!(s[0].count, 1);
        assert_eq!(s[0].last_day, "2026-10-22");
    }

    #[test]
    fn day_offset_counts_back() {
        assert_eq!(day_offset("2026-10-22", -29).as_deref(), Some("2026-09-23"));
    }
}
