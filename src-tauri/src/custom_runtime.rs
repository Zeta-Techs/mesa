//! 自定义 Runtime：用户登记的命令，在隔离目录里直接运行。无会话恢复、无会话解析。

use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS custom_runtimes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          command TEXT NOT NULL,
          args TEXT NOT NULL DEFAULT '[]',
          env TEXT NOT NULL DEFAULT '{}',
          cwd TEXT,
          created_at TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("初始化 custom_runtimes 表失败: {e}"))?;
    let _ = conn.execute(
        "ALTER TABLE custom_runtimes ADD COLUMN env TEXT NOT NULL DEFAULT '{}'",
        [],
    );
    let _ = conn.execute("ALTER TABLE custom_runtimes ADD COLUMN cwd TEXT", []);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRuntimeDto {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
    pub created_at: String,
}

fn parse_args(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

pub(crate) fn is_scratch_cwd(path: &str) -> bool {
    let k = crate::paths::path_key(path);
    k.ends_with("/ccode/scratch") || k.contains("/ccode/scratch/")
}

/// 标签 cwd 为空或随手聊 scratch 时启用登记的默认目录；项目根/工作树不覆盖。
pub(crate) fn resolve_custom_cwd(
    tab_cwd: &str,
    default_cwd: Option<&str>,
) -> Result<String, String> {
    let tab = crate::sessions::expand_tilde(tab_cwd.trim());
    let fallback = default_cwd
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(crate::sessions::expand_tilde);
    if tab.is_empty() {
        return fallback.ok_or_else(|| "未指定工作目录".to_string());
    }
    if let Some(fallback) = fallback {
        if is_scratch_cwd(&tab) {
            return Ok(fallback);
        }
    }
    Ok(tab)
}

pub(crate) fn is_relative_command(cmd: &str) -> bool {
    let t = cmd.trim();
    t.starts_with("./") || t.starts_with(".\\") || t.starts_with("../") || t.starts_with("..\\")
}

fn validate_command(command: &str) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("命令不能为空".into());
    }
    if command.contains('\0') {
        return Err("命令不能包含 NUL 字符".into());
    }
    if is_relative_command(command) {
        return Err("相对路径命令不能跨目录跑，请改成绝对路径或已在 PATH 里的命令名".into());
    }
    if command.contains('/') || command.contains('\\') {
        let p = std::path::Path::new(command);
        if !p.is_absolute() {
            return Err("命令若含路径必须是绝对路径".into());
        }
        if !p.is_file() {
            return Err(format!("找不到命令：{command}"));
        }
        return Ok(command.to_string());
    }
    crate::agents::resolve_binary(command)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| format!("找不到命令：{command}（PATH 与常见安装目录均无）"))
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CustomRuntimeDto> {
    let args_raw: String = row.get(3)?;
    let env_raw: String = row.get(4)?;
    Ok(CustomRuntimeDto {
        id: row.get(0)?,
        name: row.get(1)?,
        command: row.get(2)?,
        args: parse_args(&args_raw),
        env: serde_json::from_str(&env_raw).unwrap_or_default(),
        cwd: row.get(5)?,
        created_at: row.get(6)?,
    })
}

pub(crate) fn get_custom_runtime(id: &str) -> Result<CustomRuntimeDto, String> {
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    conn.query_row(
        "SELECT id, name, command, args, env, cwd, created_at FROM custom_runtimes WHERE id=?1",
        params![id],
        map_row,
    )
    .map_err(|e| format!("读取自定义运行时失败：{e}"))
}

#[tauri::command]
pub async fn list_custom_runtimes() -> Result<Vec<CustomRuntimeDto>, String> {
    tauri::async_runtime::spawn_blocking(list_custom_runtimes_sync)
        .await
        .map_err(|e| e.to_string())?
}
fn list_custom_runtimes_sync() -> Result<Vec<CustomRuntimeDto>, String> {
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, command, args, env, cwd, created_at FROM custom_runtimes ORDER BY created_at DESC",
        )
        .map_err(|e| format!("读取自定义运行时失败: {e}"))?;
    let rows = stmt
        .query_map([], map_row)
        .map_err(|e| format!("读取自定义运行时失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取自定义运行时失败: {e}"))
}

#[tauri::command]
pub async fn save_custom_runtime(
    id: Option<String>,
    name: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
) -> Result<CustomRuntimeDto, String> {
    tauri::async_runtime::spawn_blocking(move || save_custom_runtime_sync(id, name, command, args, env, cwd))
        .await
        .map_err(|e| e.to_string())?
}
fn save_custom_runtime_sync(
    id: Option<String>,
    name: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
) -> Result<CustomRuntimeDto, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    let resolved = validate_command(&command)?;
    for arg in &args {
        if arg.contains('\0') {
            return Err("参数不能包含 NUL 字符".into());
        }
    }
    let args_json = serde_json::to_string(&args).unwrap_or_else(|_| "[]".into());
    let env = env.unwrap_or_default();
    for (key, value) in &env {
        if !is_valid_env_key(key) {
            return Err(format!("环境变量名无效：{key}"));
        }
        if value.contains('\0') {
            return Err(format!("环境变量 {key} 的值不能包含 NUL 字符"));
        }
    }
    let cwd = cwd.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if cwd.as_deref().is_some_and(|v| v.contains('\0')) {
        return Err("工作目录不能包含 NUL 字符".into());
    }
    if let Some(ref cwd) = cwd {
        let expanded = crate::sessions::expand_tilde(cwd);
        if !std::path::Path::new(&expanded).is_dir() {
            return Err(format!("默认工作目录不存在：{expanded}"));
        }
    }
    let env_json = serde_json::to_string(&env).unwrap_or_else(|_| "{}".into());
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    let id = id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = now_rfc3339();
    conn.execute(
        "INSERT INTO custom_runtimes (id, name, command, args, env, cwd, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET name=?2, command=?3, args=?4, env=?5, cwd=?6",
        params![id, name, resolved, args_json, env_json, cwd, now],
    )
    .map_err(|e| format!("保存自定义运行时失败: {e}"))?;
    Ok(CustomRuntimeDto {
        id,
        name: name.to_string(),
        command: resolved,
        args,
        env,
        cwd,
        created_at: now,
    })
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

#[tauri::command]
pub async fn delete_custom_runtime(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_custom_runtime_sync(id))
        .await
        .map_err(|e| e.to_string())?
}
fn delete_custom_runtime_sync(id: String) -> Result<(), String> {
    let conn = crate::sessions::open_db()?;
    ensure_schema(&conn)?;
    conn.execute("DELETE FROM custom_runtimes WHERE id=?1", params![id])
        .map_err(|e| format!("删除自定义运行时失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_custom_cwd_uses_default_on_empty_or_scratch() {
        assert_eq!(resolve_custom_cwd("", Some("/proj")).unwrap(), "/proj");
        assert_eq!(
            resolve_custom_cwd("/Users/u/ccode/scratch", Some("/proj")).unwrap(),
            "/proj"
        );
        assert_eq!(
            resolve_custom_cwd("/Users/u/papers/p", Some("/proj")).unwrap(),
            "/Users/u/papers/p"
        );
        assert!(resolve_custom_cwd("", None).is_err());
    }

    #[test]
    fn relative_commands_rejected() {
        assert!(is_relative_command("./foo"));
        assert!(is_relative_command("../foo"));
        assert!(is_relative_command(".\\foo"));
        assert!(!is_relative_command("git"));
        assert!(!is_relative_command("/usr/bin/git"));
    }
}
