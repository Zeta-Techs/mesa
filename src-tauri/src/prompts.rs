//! 常用提示词（2026-10-30 用户：「存一些提示词，一段话那种」）：存在配置根 `prompts.json`，
//! 对话输入框「+」菜单与 `/` 面板里一点就填进输入框。只是 Mesa 自己的一份文本库，
//! 不写任何 CLI 的配置目录、不跟项目走（换项目照样能用）。
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 一段提示词正文的上限：够放一整段说明，挡住误粘进来的整篇文件
const MAX_BODY_CHARS: usize = 20_000;
const MAX_TITLE_CHARS: usize = 60;
const MAX_PROMPTS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptDto {
    pub id: String,
    /// 可空：界面拿正文第一行顶上
    #[serde(default)]
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptFile {
    #[serde(default)]
    prompts: Vec<PromptDto>,
}

fn prompts_path() -> Result<PathBuf, String> {
    Ok(crate::storage::config_root()
        .ok_or("无法确定配置目录")?
        .join("prompts.json"))
}

fn read_file() -> Result<PromptFile, String> {
    let path = prompts_path()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("提示词文件读不出来（{}）：{e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PromptFile::default()),
        Err(e) => Err(format!("读提示词失败：{e}")),
    }
}

fn write_file(file: &PromptFile) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(&prompts_path()?, &bytes, true)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn list_impl() -> Result<Vec<PromptDto>, String> {
    Ok(read_file()?.prompts)
}

/// 新建（id 为空）放到最前；编辑原地改、位置不动
fn save_impl(id: Option<String>, title: String, body: String) -> Result<PromptDto, String> {
    let title = title.trim().to_string();
    // 正文只去掉首尾空行，段内缩进与换行原样保留
    let body = body.trim_matches(|c| c == '\n' || c == '\r').to_string();
    if body.trim().is_empty() {
        return Err("提示词内容不能为空".into());
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(format!("提示词太长了（上限 {MAX_BODY_CHARS} 字）"));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("名称太长了（上限 {MAX_TITLE_CHARS} 字）"));
    }
    let _lock = crate::storage::config_lock("prompts")?;
    let mut file = read_file()?;
    let saved = match id.filter(|s| !s.is_empty()) {
        Some(id) => {
            let hit = file
                .prompts
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or("这条提示词已经被删掉了")?;
            hit.title = title;
            hit.body = body;
            hit.updated_at = now_ms();
            hit.clone()
        }
        None => {
            if file.prompts.len() >= MAX_PROMPTS {
                return Err(format!("提示词已经存了 {MAX_PROMPTS} 条，先删掉一些"));
            }
            let item = PromptDto {
                id: uuid::Uuid::new_v4().to_string(),
                title,
                body,
                updated_at: now_ms(),
            };
            file.prompts.insert(0, item.clone());
            item
        }
    };
    write_file(&file)?;
    Ok(saved)
}

fn delete_impl(id: &str) -> Result<(), String> {
    let _lock = crate::storage::config_lock("prompts")?;
    let mut file = read_file()?;
    let before = file.prompts.len();
    file.prompts.retain(|p| p.id != id);
    if file.prompts.len() != before {
        write_file(&file)?;
    }
    Ok(())
}

/// 按给定 id 顺序重排；没列到的（别处刚加的）按原顺序接在后面
fn reorder_impl(ids: &[String]) -> Result<Vec<PromptDto>, String> {
    let _lock = crate::storage::config_lock("prompts")?;
    let mut file = read_file()?;
    let mut rest = std::mem::take(&mut file.prompts);
    let mut ordered = Vec::with_capacity(rest.len());
    for id in ids {
        if let Some(pos) = rest.iter().position(|p| &p.id == id) {
            ordered.push(rest.remove(pos));
        }
    }
    ordered.extend(rest);
    file.prompts = ordered;
    write_file(&file)?;
    Ok(file.prompts)
}

#[tauri::command]
pub async fn list_prompts() -> Result<Vec<PromptDto>, String> {
    tauri::async_runtime::spawn_blocking(list_impl)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_prompt(
    id: Option<String>,
    title: String,
    body: String,
) -> Result<PromptDto, String> {
    tauri::async_runtime::spawn_blocking(move || save_impl(id, title, body))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_prompt(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_impl(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reorder_prompts(ids: Vec<String>) -> Result<Vec<PromptDto>, String> {
    tauri::async_runtime::spawn_blocking(move || reorder_impl(&ids))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-prompts-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_edit_delete_round_trip() {
        let tmp = temp_root("crud");
        let _root = crate::storage::redirect_config_root(&tmp);
        assert!(list_impl().unwrap().is_empty());

        let a = save_impl(None, "".into(), "\n先读 TASK.md\n  再动手\n\n".into()).unwrap();
        assert_eq!(a.body, "先读 TASK.md\n  再动手", "只去首尾空行，段内缩进保留");
        let b = save_impl(None, " 润色 ".into(), "帮我润色这段".into()).unwrap();
        assert_eq!(b.title, "润色");
        let ids: Vec<_> = list_impl().unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec![b.id.clone(), a.id.clone()], "新建的在最前");

        let edited = save_impl(Some(a.id.clone()), "读任务书".into(), "先读 TASK.md".into()).unwrap();
        assert_eq!(edited.title, "读任务书");
        let ids: Vec<_> = list_impl().unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec![b.id.clone(), a.id.clone()], "编辑不挪位置");

        let reordered = reorder_impl(&[a.id.clone()]).unwrap();
        assert_eq!(reordered[0].id, a.id);
        assert_eq!(reordered[1].id, b.id, "没列到的接在后面，不丢");

        delete_impl(&b.id).unwrap();
        assert_eq!(list_impl().unwrap().len(), 1);
        assert!(save_impl(Some(b.id), "".into(), "x".into()).is_err(), "删掉的不能再编辑");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rejects_empty_and_oversized() {
        let tmp = temp_root("limits");
        let _root = crate::storage::redirect_config_root(&tmp);
        assert!(save_impl(None, "".into(), "  \n ".into()).is_err());
        assert!(save_impl(None, "".into(), "字".repeat(MAX_BODY_CHARS + 1)).is_err());
        assert!(save_impl(None, "名".repeat(MAX_TITLE_CHARS + 1), "x".into()).is_err());
        assert!(list_impl().unwrap().is_empty(), "被拒的不落盘");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
