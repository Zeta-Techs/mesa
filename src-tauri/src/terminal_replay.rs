//! 终端画面的本地回放。只给重启后的占位标签看上次离开时的字，不是会话档案。
//! 出站副本先过会话脱敏。单标签 256KB，目录只留 replay-*。

use std::path::PathBuf;

const MAX_BYTES: usize = 256 * 1024;

fn replay_dir() -> Result<PathBuf, String> {
    Ok(crate::dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("terminal-replay"))
}

fn replay_path(tab_id: &str) -> Result<PathBuf, String> {
    if tab_id.len() > 80
        || !tab_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("标签编号无效".into());
    }
    Ok(replay_dir()?.join(format!("replay-{tab_id}.txt")))
}

#[tauri::command]
pub fn save_terminal_replay(tab_id: String, text: String) -> Result<(), String> {
    let path = replay_path(&tab_id)?;
    let dir = path.parent().ok_or("回放目录无效")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let redacted = crate::sessions::redact_sensitive_text(&text);
    let bytes = redacted.as_bytes();
    let keep = if bytes.len() > MAX_BYTES {
        let mut start = bytes.len() - MAX_BYTES;
        while start < bytes.len() && (bytes[start] & 0b1100_0000) == 0b1000_0000 {
            start += 1;
        }
        &bytes[start..]
    } else {
        bytes
    };
    std::fs::write(&path, keep).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
pub fn load_terminal_replay(tab_id: String) -> Result<String, String> {
    let path = replay_path(&tab_id)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub fn drop_terminal_replay(tab_id: String) -> Result<(), String> {
    let path = replay_path(&tab_id)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

/// 启动恢复完成后清孤儿：只保留传入标签集合的回放文件。
/// 崩溃/强退残留的 replay-* 没有对应标签，永远没人读，不清则无限堆积。
#[tauri::command]
pub fn prune_terminal_replays(tab_ids: Vec<String>) -> Result<u32, String> {
    let dir = replay_dir()?;
    let mut keep = std::collections::HashSet::new();
    for id in tab_ids {
        if id.len() <= 80
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            keep.insert(format!("replay-{id}.txt"));
        }
    }
    prune_dir(&dir, &keep)
}

fn prune_dir(dir: &std::path::Path, keep: &std::collections::HashSet<String>) -> Result<u32, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(err) => return Err(err.to_string()),
    };
    let mut removed = 0u32;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("replay-")
            && name.ends_with(".txt")
            && !keep.contains(name.as_ref())
        {
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_keeps_current_tabs_and_removes_orphans() {
        let dir = std::env::temp_dir().join(format!(
            "ccode-replay-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["replay-a1.txt", "replay-b2.txt", "replay-orphan.txt"] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        // 非 replay-* 的文件不碰；replay- 前缀但非法 id 形态的也不碰（只按名单删）
        std::fs::write(dir.join("other.txt"), "x").unwrap();
        let keep: std::collections::HashSet<String> =
            ["replay-a1.txt".to_string()].into();
        let removed = prune_dir(&dir, &keep).unwrap();
        assert_eq!(removed, 2);
        assert!(dir.join("replay-a1.txt").exists());
        assert!(!dir.join("replay-b2.txt").exists());
        assert!(!dir.join("replay-orphan.txt").exists());
        assert!(dir.join("other.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}