//! 对话里选的出图模型与出图调用记录（2026-11-24，聊天输入框「出图」胶囊，前端 components/ChatImageGen.tsx）。
//!
//! - 选择：`<配置根>/image-gen-chats.json`，按 Mesa 标签 id 记网关 + 模型，顺带记会话 id（标签从侧栏重开时按会话找回）。
//!   Mesa 起 Agent 时注入 `MESA_IMAGE_TAB=<标签 id>`（pty.rs），出图工具每次调用按它现读，
//!   顺序 `--model` > 本对话选的 > 连接页默认（image_gen.rs resolve_target_for_chat）。连接页默认不动。
//! - 调用记录：`<配置根>/image-gen-calls.jsonl`，出图工具开始 / 出完 / 失败各追加一行（标签、模型、网关名、存到哪），
//!   不记描述原文、不记密钥。聊天据此在图下写模型名、认出「这一轮没调用出图工具」。超过上限滚成 `.1.jsonl` 一份。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const TAB_ENV: &str = "MESA_IMAGE_TAB";
const CHOICES_FILE: &str = "image-gen-chats.json";
const CALLS_FILE: &str = "image-gen-calls.jsonl";
const CALLS_OLD_FILE: &str = "image-gen-calls.1.jsonl";
/// 记多少个对话的选择（按最近改的留）
const MAX_CHOICES: usize = 300;
const CALLS_ROTATE_BYTES: u64 = 512 * 1024;
/// 一次给前端多少条（同一标签、最近的）
const MAX_CALLS_RETURNED: usize = 200;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatChoice {
    pub gateway_id: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ChoicesFile {
    #[serde(default)]
    tabs: BTreeMap<String, ChatChoice>,
}

/// 出图工具每调用一次记的一行（前端 chat-image-gen.ts ImageGenCall）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCall {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    pub at: u64,
    /// start | done | failed
    pub phase: String,
    pub model: String,
    #[serde(default)]
    pub gateway_name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

/// 标签 id 只认字母、数字、`-`、`_`（同 terminal-tab-persistence.ts parseTab），别的不当 id
pub fn clean_tab(raw: &str) -> Option<String> {
    let t = raw.trim();
    (!t.is_empty()
        && t.len() <= 80
        && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then(|| t.to_string())
}

fn clean_session(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .map(str::to_string)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn root() -> Result<PathBuf, String> {
    crate::storage::config_root().ok_or_else(|| "无法确定配置目录".to_string())
}

/// 读不出、坏了都当空表：这份只记「对话里换过的模型」，丢了就回到连接页默认
fn read_choices_at(path: &Path) -> ChoicesFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_choices_at(path: &Path, f: &ChoicesFile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(f).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(path, text.as_bytes(), false)
}

fn prune(f: &mut ChoicesFile) {
    if f.tabs.len() <= MAX_CHOICES {
        return;
    }
    let mut order: Vec<(u64, String)> = f.tabs.iter().map(|(k, v)| (v.updated_at, k.clone())).collect();
    order.sort();
    let drop = order.len() - MAX_CHOICES;
    for (_, k) in order.into_iter().take(drop) {
        f.tabs.remove(&k);
    }
}

/// 标签有记录就用它，会话 id 跟着标签现在挂的会话走（第一次知道时补上；换了会话就改记新的——
/// 2026-11-24 用户实例：标签先挂着一段旧对话时选了模型，Agent 随后新开会话，选择不该留在旧对话名下）；
/// 标签没记录就按会话找最近一次选择，记到这个标签上
fn sync_in(f: &mut ChoicesFile, tab: &str, session: Option<&str>, now: u64) -> (Option<ChatChoice>, bool) {
    if let Some(entry) = f.tabs.get_mut(tab) {
        let mut changed = false;
        if let Some(s) = session.filter(|s| entry.session_id.as_deref() != Some(*s)) {
            entry.session_id = Some(s.to_string());
            entry.updated_at = now;
            changed = true;
        }
        return (Some(entry.clone()), changed);
    }
    let Some(s) = session else {
        return (None, false);
    };
    let found = f
        .tabs
        .values()
        .filter(|c| c.session_id.as_deref() == Some(s))
        .max_by_key(|c| c.updated_at)
        .cloned();
    match found {
        Some(mut c) => {
            c.updated_at = now;
            f.tabs.insert(tab.to_string(), c.clone());
            prune(f);
            (Some(c), true)
        }
        None => (None, false),
    }
}

/// 选了一个模型就记下；None = 跟着连接页默认走，这个对话（同会话的旧标签一并）的记录清掉
fn set_in(f: &mut ChoicesFile, tab: &str, session: Option<&str>, pick: Option<(&str, &str)>, now: u64) {
    match pick {
        Some((gateway_id, model)) => {
            let session_id = session
                .map(str::to_string)
                .or_else(|| f.tabs.get(tab).and_then(|c| c.session_id.clone()));
            f.tabs.insert(
                tab.to_string(),
                ChatChoice {
                    gateway_id: gateway_id.to_string(),
                    model: model.to_string(),
                    session_id,
                    updated_at: now,
                },
            );
            prune(f);
        }
        None => {
            let sid = session
                .map(str::to_string)
                .or_else(|| f.tabs.get(tab).and_then(|c| c.session_id.clone()));
            f.tabs.remove(tab);
            if let Some(sid) = sid {
                f.tabs.retain(|_, c| c.session_id.as_deref() != Some(sid.as_str()));
            }
        }
    }
}

/// 出图工具读：这个标签选过的模型。只读不加锁：写入走原子替换，读到的总是一整份
pub fn choice_for_tab(tab: &str) -> Option<ChatChoice> {
    let tab = clean_tab(tab)?;
    let path = root().ok()?.join(CHOICES_FILE);
    read_choices_at(&path)
        .tabs
        .get(&tab)
        .cloned()
        .filter(|c| !c.model.trim().is_empty())
}

/// 出图工具这次在哪个对话里跑（Mesa 起 Agent 时注入的标签；Mesa 外、无头任务里没有）
pub fn current_tab() -> Option<String> {
    std::env::var(TAB_ENV).ok().as_deref().and_then(clean_tab)
}

fn sync_choice(tab: &str, session: Option<&str>) -> Result<Option<ChatChoice>, String> {
    let _lock = crate::storage::config_lock("image-gen-chats")?;
    let path = root()?.join(CHOICES_FILE);
    let mut f = read_choices_at(&path);
    let (choice, changed) = sync_in(&mut f, tab, session, now_ms());
    if changed {
        write_choices_at(&path, &f)?;
    }
    Ok(choice)
}

fn set_choice(tab: &str, session: Option<&str>, pick: Option<(&str, &str)>) -> Result<(), String> {
    let _lock = crate::storage::config_lock("image-gen-chats")?;
    let path = root()?.join(CHOICES_FILE);
    let mut f = read_choices_at(&path);
    set_in(&mut f, tab, session, pick, now_ms());
    write_choices_at(&path, &f)
}

fn append_call_at(dir: &Path, call: &ImageCall) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(CALLS_FILE);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > CALLS_ROTATE_BYTES) {
        // 两个出图工具同时滚动时最多丢几行，不影响出图
        let _ = crate::storage::replace(&path, &dir.join(CALLS_OLD_FILE));
    }
    let mut line = serde_json::to_string(call).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// 记一次调用；没有标签（Mesa 外、无头任务）不记。尽力而为：记不下不影响出图
pub fn record_call(call: &ImageCall) {
    if call.tab.is_none() {
        return;
    }
    if let Ok(dir) = root() {
        let _ = append_call_at(&dir, call);
    }
}

fn calls_at(dir: &Path, tab: &str, since: u64) -> Vec<ImageCall> {
    let mut out: Vec<ImageCall> = Vec::new();
    for name in [CALLS_OLD_FILE, CALLS_FILE] {
        let Ok(text) = std::fs::read_to_string(dir.join(name)) else {
            continue;
        };
        out.extend(
            text.lines()
                .filter_map(|l| serde_json::from_str::<ImageCall>(l).ok())
                .filter(|c| c.tab.as_deref() == Some(tab) && c.at >= since),
        );
    }
    out.sort_by_key(|c| c.at);
    let skip = out.len().saturating_sub(MAX_CALLS_RETURNED);
    out.split_off(skip)
}

// ===== Tauri 命令 =====

/// 这个对话选过的出图模型（没有 = 跟着连接页默认）；标签是从侧栏重开的，按会话找回并记到这个标签上
#[tauri::command]
pub async fn image_gen_chat_sync(tab_id: String, session_id: Option<String>) -> Result<Option<ChatChoice>, String> {
    let tab = clean_tab(&tab_id).ok_or("标签 id 不对")?;
    let session = clean_session(session_id.as_deref());
    tauri::async_runtime::spawn_blocking(move || sync_choice(&tab, session.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// 输入框胶囊里换模型：只管这个对话；gateway_id / model 任一为空 = 回到连接页默认
#[tauri::command]
pub async fn image_gen_chat_set(
    tab_id: String,
    session_id: Option<String>,
    gateway_id: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let tab = clean_tab(&tab_id).ok_or("标签 id 不对")?;
    let session = clean_session(session_id.as_deref());
    let gateway_id = gateway_id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let model = model.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    tauri::async_runtime::spawn_blocking(move || {
        let pick = gateway_id.as_deref().zip(model.as_deref());
        set_choice(&tab, session.as_deref(), pick)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 这个对话里出图工具的调用（最近的 200 条，旧的在前）
#[tauri::command]
pub async fn image_gen_chat_calls(tab_id: String, since_ms: Option<u64>) -> Result<Vec<ImageCall>, String> {
    let Some(tab) = clean_tab(&tab_id) else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        Ok(root().map(|dir| calls_at(&dir, &tab, since_ms.unwrap_or(0))).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用临时目录，drop 时删掉
    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> TempDir {
        let dir = std::env::temp_dir().join(format!("ccode-image-chat-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn choice(model: &str, session: Option<&str>, at: u64) -> ChatChoice {
        ChatChoice {
            gateway_id: "gw".into(),
            model: model.into(),
            session_id: session.map(str::to_string),
            updated_at: at,
        }
    }

    #[test]
    fn tab_ids_only_take_safe_characters() {
        assert_eq!(clean_tab(" tab-1_a "), Some("tab-1_a".into()));
        assert_eq!(clean_tab("../x"), None);
        assert_eq!(clean_tab(""), None);
        assert_eq!(clean_tab(&"a".repeat(81)), None);
    }

    #[test]
    fn sync_fills_session_then_finds_choice_from_reopened_tab() {
        let mut f = ChoicesFile::default();
        set_in(&mut f, "t1", None, Some(("gw", "gemini-3-pro-image")), 10);
        // 会话后来才关联上：补记会话 id
        let (c, changed) = sync_in(&mut f, "t1", Some("s1"), 20);
        assert!(changed);
        assert_eq!(c.unwrap().session_id.as_deref(), Some("s1"));
        let (_, again) = sync_in(&mut f, "t1", Some("s1"), 21);
        assert!(!again, "已记过会话 id 不再写盘");
        // 标签换了会话（先挂着旧对话、Agent 新开了一段）：改记到新会话，旧会话不再带着这个选择
        let (c, moved) = sync_in(&mut f, "t1", Some("s-new"), 22);
        assert!(moved);
        assert_eq!(c.unwrap().session_id.as_deref(), Some("s-new"));
        assert_eq!(sync_in(&mut f, "t-old", Some("s0"), 23), (None, false));
        let (_, back) = sync_in(&mut f, "t1", Some("s1"), 24);
        assert!(back, "又换回来也跟着改");
        // 从侧栏重开成新标签：按会话找回，记到新标签上
        let (c, changed) = sync_in(&mut f, "t2", Some("s1"), 30);
        assert!(changed);
        assert_eq!(c.unwrap().model, "gemini-3-pro-image");
        assert_eq!(f.tabs["t2"].updated_at, 30);
        // 不相干的会话找不到
        assert_eq!(sync_in(&mut f, "t3", Some("s9"), 40), (None, false));
        assert_eq!(sync_in(&mut f, "t4", None, 40), (None, false));
    }

    #[test]
    fn clearing_choice_forgets_whole_conversation() {
        let mut f = ChoicesFile::default();
        f.tabs.insert("old".into(), choice("gpt-image-2.5", Some("s1"), 1));
        f.tabs.insert("other".into(), choice("grok-imagine-image", Some("s2"), 1));
        set_in(&mut f, "new", Some("s1"), Some(("gw", "doubao-seedream-4-0")), 5);
        assert_eq!(f.tabs["new"].model, "doubao-seedream-4-0");
        set_in(&mut f, "new", None, None, 6);
        assert!(!f.tabs.contains_key("new"));
        assert!(!f.tabs.contains_key("old"), "同一会话的旧标签一并清掉");
        assert!(f.tabs.contains_key("other"));
    }

    #[test]
    fn choices_are_capped_keeping_recent() {
        let mut f = ChoicesFile::default();
        for i in 0..(MAX_CHOICES as u64 + 5) {
            set_in(&mut f, &format!("t{i}"), None, Some(("gw", "m")), i);
        }
        assert_eq!(f.tabs.len(), MAX_CHOICES);
        assert!(!f.tabs.contains_key("t0"));
        assert!(f.tabs.contains_key(&format!("t{}", MAX_CHOICES as u64 + 4)));
    }

    #[test]
    fn choices_round_trip_through_config_root() {
        let dir = tempdir();
        let _root = crate::storage::redirect_config_root(dir.path());
        set_choice("t1", Some("s1"), Some(("gw", "gpt-image-2.5"))).unwrap();
        assert_eq!(choice_for_tab("t1").unwrap().model, "gpt-image-2.5");
        assert_eq!(sync_choice("t9", Some("s1")).unwrap().unwrap().model, "gpt-image-2.5");
        set_choice("t9", Some("s1"), None).unwrap();
        assert!(choice_for_tab("t1").is_none());
        // 坏文件当空表，不报错
        std::fs::write(dir.path().join(CHOICES_FILE), "{oops").unwrap();
        assert!(choice_for_tab("t1").is_none());
        set_choice("t1", None, Some(("gw", "m"))).unwrap();
        assert_eq!(choice_for_tab("t1").unwrap().model, "m");
    }

    fn call(tab: Option<&str>, at: u64, phase: &str) -> ImageCall {
        ImageCall {
            id: format!("c{at}"),
            tab: tab.map(str::to_string),
            at,
            phase: phase.into(),
            model: "gpt-image-2.5".into(),
            gateway_name: "中转".into(),
            paths: if phase == "done" { vec![format!("/p/figures/{at}.png")] } else { Vec::new() },
        }
    }

    #[test]
    fn calls_filter_by_tab_and_time_across_rotation() {
        let dir = tempdir();
        append_call_at(dir.path(), &call(Some("t1"), 1, "start")).unwrap();
        append_call_at(dir.path(), &call(Some("t2"), 2, "start")).unwrap();
        // 滚动后旧文件照样读
        std::fs::rename(dir.path().join(CALLS_FILE), dir.path().join(CALLS_OLD_FILE)).unwrap();
        append_call_at(dir.path(), &call(Some("t1"), 3, "done")).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(dir.path().join(CALLS_FILE))
            .unwrap()
            .write_all(b"not json\n")
            .unwrap();
        let got = calls_at(dir.path(), "t1", 0);
        assert_eq!(got.iter().map(|c| c.at).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(got[1].paths, vec!["/p/figures/3.png".to_string()]);
        assert_eq!(calls_at(dir.path(), "t1", 2).len(), 1);
        assert!(calls_at(dir.path(), "t9", 0).is_empty());
    }

    #[test]
    fn calls_without_tab_are_not_recorded() {
        let dir = tempdir();
        let _root = crate::storage::redirect_config_root(dir.path());
        record_call(&call(None, 1, "start"));
        assert!(!dir.path().join(CALLS_FILE).exists());
        record_call(&call(Some("t1"), 2, "start"));
        assert_eq!(calls_at(dir.path(), "t1", 0).len(), 1);
    }

    #[test]
    fn big_call_log_rolls_over() {
        let dir = tempdir();
        std::fs::write(dir.path().join(CALLS_FILE), vec![b'x'; CALLS_ROTATE_BYTES as usize + 1]).unwrap();
        append_call_at(dir.path(), &call(Some("t1"), 5, "start")).unwrap();
        assert!(dir.path().join(CALLS_OLD_FILE).exists());
        assert_eq!(calls_at(dir.path(), "t1", 0).len(), 1);
    }
}
