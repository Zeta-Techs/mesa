use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

// ===== 解析模型（未知键忽略，前向兼容） =====

#[derive(Debug, Default, Deserialize)]
struct LayerSettings {
    files_to_copy: Option<Vec<String>>,
    run_mode: Option<String>,
    scripts: Option<Scripts>,
}

#[derive(Debug, Default, Deserialize)]
struct Scripts {
    setup: Option<String>,
    archive: Option<String>,
    run: Option<BTreeMap<String, RunScript>>,
}

#[derive(Debug, Clone, Deserialize)]
struct RunScript {
    command: String,
    #[serde(default)]
    default: bool,
}

// ===== 前端 DTO =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptDto {
    pub name: String,
    pub command: String,
    #[serde(rename = "default")]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsSettingsDto {
    pub files_to_copy: Vec<String>,
    pub run_mode: String,
    pub setup: Option<String>,
    pub archive: Option<String>,
    pub run: Vec<RunScriptDto>,
}

// ===== 生效来源标注（config_dump 自省快照用）：记录每个生效键来自哪一层 =====

/// files_to_copy 单项的来源层（并集语义：同一文件可被多层定义，层名按合并顺序列出）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredFileDto {
    pub value: String,
    /// "user" / "repo" / "local"
    pub layers: Vec<&'static str>,
}

/// run 脚本生效条目的来源层
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSourceDto {
    pub name: String,
    /// "user" / "repo" / "local"
    pub layer: &'static str,
}

/// 三层合并的来源标注：标量键记录最终生效值来自哪一层（None = 三层都没定义，走缺省）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsTraceDto {
    pub files_to_copy: Vec<LayeredFileDto>,
    pub run_mode: Option<&'static str>,
    pub setup: Option<&'static str>,
    pub archive: Option<&'static str>,
    pub run: Vec<RunSourceDto>,
}

/// 合并后的内部形态：files_to_copy 为 None 表示三层都没定义（调用方回落 W1 固定清单）
#[derive(Debug, Default)]
pub(crate) struct MergedSettings {
    pub files_to_copy: Option<Vec<String>>,
    pub run_mode: Option<String>,
    pub setup: Option<String>,
    pub archive: Option<String>,
    pub run: Vec<RunScriptDto>,
}

fn parse_layer(path: &Path) -> Option<LayerSettings> {
    let text = fs::read_to_string(path).ok()?;
    toml::from_str(&text).ok()
}

/// 单层并入累计结果：标量后层覆盖，files_to_copy 并集去重，run 按名字覆盖；
/// trace 同步记录每个生效键的来源层（config_dump 自省快照用）
fn merge_into(
    acc: &mut MergedSettings,
    layer: LayerSettings,
    layer_name: &'static str,
    trace: &mut WsTraceDto,
) {
    if let Some(files) = layer.files_to_copy {
        let acc_files = acc.files_to_copy.get_or_insert_with(Vec::new);
        for f in files {
            if f.is_empty() {
                continue;
            }
            if !acc_files.contains(&f) {
                acc_files.push(f.clone());
            }
            match trace.files_to_copy.iter_mut().find(|t| t.value == f) {
                Some(t) => {
                    if !t.layers.contains(&layer_name) {
                        t.layers.push(layer_name);
                    }
                }
                None => trace.files_to_copy.push(LayeredFileDto {
                    value: f,
                    layers: vec![layer_name],
                }),
            }
        }
    }
    if let Some(run_mode) = layer.run_mode {
        acc.run_mode = Some(run_mode);
        trace.run_mode = Some(layer_name);
    }
    if let Some(scripts) = layer.scripts {
        if scripts.setup.is_some() {
            acc.setup = scripts.setup;
            trace.setup = Some(layer_name);
        }
        if scripts.archive.is_some() {
            acc.archive = scripts.archive;
            trace.archive = Some(layer_name);
        }
        if let Some(run) = scripts.run {
            for (name, script) in run {
                let dto = RunScriptDto {
                    name: name.clone(),
                    command: script.command,
                    is_default: script.default,
                };
                if let Some(existing) = acc.run.iter_mut().find(|r| r.name == name) {
                    *existing = dto; // 同名后层覆盖
                } else {
                    acc.run.push(dto);
                }
                match trace.run.iter_mut().find(|r| r.name == name) {
                    Some(t) => t.layer = layer_name,
                    None => trace.run.push(RunSourceDto {
                        name,
                        layer: layer_name,
                    }),
                }
            }
        }
    }
}

/// 三层合并：用户 ~/.config/ccode/settings.toml → 仓库 .ccode/settings.toml → .ccode/settings.local.toml
pub(crate) fn merged_settings(repo: &Path) -> MergedSettings {
    merged_settings_traced(repo).0
}

/// 同 merged_settings，附带每个生效键的来源层标注（config_dump 自省快照用）
pub(crate) fn merged_settings_traced(repo: &Path) -> (MergedSettings, WsTraceDto) {
    let user = crate::dirs::config_dir().map(|d| d.join("ccode").join("settings.toml"));
    merged_settings_traced_with_user(repo, user.as_deref())
}

/// user 层路径参数化，便于测试隔离
fn merged_settings_traced_with_user(
    repo: &Path,
    user_layer: Option<&Path>,
) -> (MergedSettings, WsTraceDto) {
    let mut paths: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(u) = user_layer {
        paths.push((u.to_path_buf(), "user"));
    }
    paths.push((repo.join(".ccode").join("settings.toml"), "repo"));
    paths.push((repo.join(".ccode").join("settings.local.toml"), "local"));
    let mut acc = MergedSettings::default();
    let mut trace = WsTraceDto::default();
    for (p, name) in paths {
        if let Some(layer) = parse_layer(&p) {
            merge_into(&mut acc, layer, name, &mut trace);
        }
    }
    (acc, trace)
}

pub(crate) fn to_dto(m: MergedSettings, fallback_files: &[&str]) -> WsSettingsDto {
    WsSettingsDto {
        files_to_copy: m
            .files_to_copy
            .unwrap_or_else(|| fallback_files.iter().map(|s| s.to_string()).collect()),
        run_mode: m.run_mode.unwrap_or_else(|| "concurrent".into()),
        setup: m.setup,
        archive: m.archive,
        run: m.run,
    }
}

#[tauri::command]
pub async fn workspace_settings(repo_path: String) -> WsSettingsDto {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(crate::sessions::expand_tilde(&repo_path));
        to_dto(merged_settings(&repo), &crate::workspaces::FILES_TO_COPY)
    })
    .await
    .unwrap_or_else(|_| to_dto(MergedSettings::default(), &crate::workspaces::FILES_TO_COPY))
}

// ===== 项目层 run 脚本写入（P4：一键开步把 step.run 落进仓库层 settings.toml） =====

/// 前端传入的 run 脚本（与 projects.rs StepRunDto 同形：name/command/default）
#[derive(Debug, Deserialize)]
pub struct RunScriptInput {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub default: bool,
}

/// 新建 settings.toml 时的头注释：标明本文件在三层合并中的层级
const SETTINGS_HEADER: &str = "# Mesa 项目层设置：ws_settings 三层合并的仓库层\n\
     # 用户层 ~/.config/ccode/settings.toml，本机层 .ccode/settings.local.toml（优先级更高）\n";

/// toml_edit 补丁式 upsert：同名覆盖、其余键原样保留；文件不存在则创建（含头注释）。
/// 解析失败/路径非法直接报错，不动用户文件；写盘走 atomic_write（tmp+rename）。
fn upsert_run_scripts_at(repo: &Path, scripts: &[RunScriptInput]) -> Result<(), String> {
    for s in scripts {
        let name = s.name.trim();
        if name.is_empty() || name.chars().any(|c| c.is_control()) {
            return Err(format!("run 脚本名非法: {:?}", s.name));
        }
        if s.command.trim().is_empty() {
            return Err(format!("run 脚本「{name}」命令为空"));
        }
    }
    let dir = repo.join(".ccode");
    let path = dir.join("settings.toml");
    // 新建时头注释在写盘时手动拼到最前：空文档里裸注释会被 toml_edit 当作根表尾饰，
    // 序列化时排到新建表之后；已存在文件的头注释附着于首个表的前饰，往返不丢
    let existed = path.exists();
    let text = if existed {
        fs::read_to_string(&path).map_err(|e| format!("读取 settings.toml 失败: {e}"))?
    } else {
        String::new()
    };
    let mut doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("settings.toml 解析失败，未写入: {e}"))?;
    // scripts / scripts.run 缺失时补建；已存在但不是表时拒绝，避免覆盖用户手误
    let scripts_item = &mut doc["scripts"];
    if scripts_item.is_none() {
        *scripts_item = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let scripts_tbl = scripts_item
        .as_table_mut()
        .ok_or("settings.toml 中 scripts 不是表，未写入")?;
    let run_item = &mut scripts_tbl["run"];
    if run_item.is_none() {
        *run_item = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let run_tbl = run_item
        .as_table_like_mut()
        .ok_or("settings.toml 中 scripts.run 不是表，未写入")?;
    for s in scripts {
        let mut entry = toml_edit::InlineTable::new();
        entry.insert("command", s.command.trim().into());
        if s.default {
            entry.insert("default", true.into());
        }
        run_tbl.insert(
            s.name.trim(),
            toml_edit::Item::Value(toml_edit::Value::InlineTable(entry)),
        );
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    let body = doc.to_string();
    let out = if existed {
        body
    } else {
        format!("{SETTINGS_HEADER}{body}")
    };
    crate::profiles::atomic_write(&path, &out)
}

/// 一键开步（P4）：把步骤预设的 run 脚本写进仓库层 .ccode/settings.toml，规则见 upsert_run_scripts_at。
#[tauri::command]
pub async fn upsert_project_run_scripts(
    repo_path: String,
    scripts: Vec<RunScriptInput>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(crate::sessions::expand_tilde(&repo_path));
        upsert_run_scripts_at(&repo, &scripts)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn three_layer_merge_precedence_and_union() {
        let dir = std::env::temp_dir().join(format!("ccode-wss-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        let user = dir.join("user-settings.toml");
        write(
            &user,
            r#"files_to_copy = [".env", ".userrc"]
run_mode = "concurrent"
[scripts]
setup = "user setup"
archive = "user archive"
[scripts.run]
web = { command = "user dev", default = true }
"#,
        );
        write(
            &repo.join(".ccode").join("settings.toml"),
            r#"files_to_copy = [".env.local"]
[scripts]
setup = "repo setup"
[scripts.run]
web = { command = "repo dev" }
test = { command = "repo test" }
"#,
        );
        write(
            &repo.join(".ccode").join("settings.local.toml"),
            r#"files_to_copy = [".env", ".secrets"]
run_mode = "nonconcurrent"
[scripts.run]
test = { command = "local test" }
"#,
        );
        let (m, _) = merged_settings_traced_with_user(&repo, Some(&user));
        // files_to_copy：三层并集去重，保持出现顺序
        assert_eq!(
            m.files_to_copy.unwrap(),
            vec![".env", ".userrc", ".env.local", ".secrets"]
        );
        // 标量后层覆盖；未被覆盖的保留浅层值
        assert_eq!(m.run_mode.as_deref(), Some("nonconcurrent"));
        assert_eq!(m.setup.as_deref(), Some("repo setup"));
        assert_eq!(m.archive.as_deref(), Some("user archive"));
        // run 按名字合并：web 被 repo 层覆盖，test 被 local 层覆盖
        assert_eq!(m.run.len(), 2);
        let web = m.run.iter().find(|r| r.name == "web").unwrap();
        assert_eq!(web.command, "repo dev");
        assert!(!web.is_default, "覆盖条目整体替换（default 也随之替换）");
        let test = m.run.iter().find(|r| r.name == "test").unwrap();
        assert_eq!(test.command, "local test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_layers_yield_defaults() {
        let dir = std::env::temp_dir().join(format!("ccode-wss-{}", uuid::Uuid::new_v4()));
        let (m, _) = merged_settings_traced_with_user(&dir, None);
        assert!(
            m.files_to_copy.is_none(),
            "三层都没定义时由调用方回落固定清单"
        );
        let dto = to_dto(m, &[".env", ".envrc"]);
        assert_eq!(dto.files_to_copy, vec![".env", ".envrc"]);
        assert_eq!(dto.run_mode, "concurrent");
        assert!(dto.setup.is_none() && dto.run.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_keys_and_broken_files_tolerated() {
        let dir = std::env::temp_dir().join(format!("ccode-wss-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        write(
            &repo.join(".ccode").join("settings.toml"),
            "future_key = 42\n[scripts]\nsetup = \"ok\"\n",
        );
        write(
            &repo.join(".ccode").join("settings.local.toml"),
            "not [valid toml",
        );
        let (m, _) = merged_settings_traced_with_user(&repo, None);
        assert_eq!(
            m.setup.as_deref(),
            Some("ok"),
            "坏掉的 local 层不影响有效层"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== upsert_project_run_scripts（P4） =====

    fn input(name: &str, command: &str, default: bool) -> RunScriptInput {
        RunScriptInput {
            name: name.into(),
            command: command.into(),
            default,
        }
    }

    #[test]
    fn upsert_creates_file_and_feeds_project_layer() {
        let dir = std::env::temp_dir().join(format!("ccode-wss-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        upsert_run_scripts_at(
            &repo,
            &[input(
                "render-draft",
                "quarto render manuscript/draft.md --to pdf",
                true,
            )],
        )
        .unwrap();
        let text = fs::read_to_string(repo.join(".ccode").join("settings.toml")).unwrap();
        assert!(
            text.starts_with("# Mesa 项目层设置"),
            "新建文件必须带头注释: {text}"
        );
        // 合并链路确实吃项目层：merged_settings 能读到刚写入的脚本
        let (m, _) = merged_settings_traced_with_user(&repo, None);
        assert_eq!(m.run.len(), 1);
        assert_eq!(m.run[0].name, "render-draft");
        assert_eq!(
            m.run[0].command,
            "quarto render manuscript/draft.md --to pdf"
        );
        assert!(m.run[0].is_default);
        // 二次 upsert：头注释附着于首个表前饰，往返后仍在顶部
        upsert_run_scripts_at(&repo, &[input("render-final", "quarto render x.md", false)])
            .unwrap();
        let text2 = fs::read_to_string(repo.join(".ccode").join("settings.toml")).unwrap();
        assert!(
            text2.starts_with("# Mesa 项目层设置"),
            "往返后头注释不得丢失: {text2}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn upsert_overwrites_same_name_preserves_others() {
        let dir = std::env::temp_dir().join(format!("ccode-wss-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        write(
            &repo.join(".ccode").join("settings.toml"),
            r#"files_to_copy = [".env"]
[scripts]
setup = "make setup"
[scripts.run]
render-draft = { command = "old render", default = true }
web = { command = "npm run dev" }
"#,
        );
        upsert_run_scripts_at(
            &repo,
            &[
                input(
                    "render-draft",
                    "quarto render manuscript/draft.md --to pdf",
                    false,
                ),
                input(
                    "render-final",
                    "quarto render manuscript/paper-final.md --to pdf",
                    true,
                ),
            ],
        )
        .unwrap();
        let text = fs::read_to_string(repo.join(".ccode").join("settings.toml")).unwrap();
        assert!(text.contains("files_to_copy"), "其余顶层键保留: {text}");
        assert!(text.contains("make setup"), "scripts 其余键保留: {text}");
        assert!(text.contains("npm run dev"), "其余 run 条目保留: {text}");
        assert!(!text.contains("old render"), "同名命令被覆盖: {text}");
        let (m, _) = merged_settings_traced_with_user(&repo, None);
        assert_eq!(m.run.len(), 3);
        let draft = m.run.iter().find(|r| r.name == "render-draft").unwrap();
        assert_eq!(draft.command, "quarto render manuscript/draft.md --to pdf");
        assert!(!draft.is_default, "覆盖条目整体替换（default 也随之替换）");
        assert!(
            m.run
                .iter()
                .find(|r| r.name == "render-final")
                .unwrap()
                .is_default
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn upsert_rejects_invalid_input_and_broken_file() {
        let dir = std::env::temp_dir().join(format!("ccode-wss-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        // 空名 / 空命令 / 控制字符一律拒绝，且不落盘
        assert!(upsert_run_scripts_at(&repo, &[input("", "cmd", false)]).is_err());
        assert!(upsert_run_scripts_at(&repo, &[input("ok", "  ", false)]).is_err());
        assert!(upsert_run_scripts_at(&repo, &[input("a\nb", "cmd", false)]).is_err());
        assert!(!repo.join(".ccode").join("settings.toml").exists());
        // 坏掉的既有文件：报错且不改写
        write(
            &repo.join(".ccode").join("settings.toml"),
            "not [valid toml",
        );
        assert!(upsert_run_scripts_at(&repo, &[input("render", "cmd", false)]).is_err());
        assert_eq!(
            fs::read_to_string(repo.join(".ccode").join("settings.toml")).unwrap(),
            "not [valid toml"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn trace_records_layer_sources() {
        let dir = std::env::temp_dir().join(format!("ccode-wss-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        let user = dir.join("user-settings.toml");
        write(
            &user,
            r#"files_to_copy = [".env", ".userrc"]
run_mode = "concurrent"
[scripts]
setup = "user setup"
archive = "user archive"
[scripts.run]
web = { command = "user dev", default = true }
"#,
        );
        write(
            &repo.join(".ccode").join("settings.toml"),
            r#"files_to_copy = [".env.local"]
[scripts]
setup = "repo setup"
[scripts.run]
web = { command = "repo dev" }
test = { command = "repo test" }
"#,
        );
        write(
            &repo.join(".ccode").join("settings.local.toml"),
            r#"files_to_copy = [".env", ".secrets"]
run_mode = "nonconcurrent"
[scripts.run]
test = { command = "local test" }
"#,
        );
        let (_, trace) = merged_settings_traced_with_user(&repo, Some(&user));
        // files_to_copy：并集语义，多层定义的文件记全部来源层（按合并顺序）
        let layers_of = |v: &str| {
            trace
                .files_to_copy
                .iter()
                .find(|f| f.value == v)
                .unwrap()
                .layers
                .clone()
        };
        assert_eq!(layers_of(".env"), vec!["user", "local"]);
        assert_eq!(layers_of(".userrc"), vec!["user"]);
        assert_eq!(layers_of(".env.local"), vec!["repo"]);
        assert_eq!(layers_of(".secrets"), vec!["local"]);
        // 标量键记录最终生效值来自哪一层
        assert_eq!(trace.run_mode, Some("local"));
        assert_eq!(trace.setup, Some("repo"), "setup 被 repo 层覆盖");
        assert_eq!(trace.archive, Some("user"), "archive 只有 user 层定义");
        // run 按名记录生效条目来源：web 被 repo 覆盖，test 被 local 覆盖
        assert_eq!(
            trace.run.iter().find(|r| r.name == "web").unwrap().layer,
            "repo"
        );
        assert_eq!(
            trace.run.iter().find(|r| r.name == "test").unwrap().layer,
            "local"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn trace_empty_when_no_layer_defines_anything() {
        let dir = std::env::temp_dir().join(format!("ccode-wss-{}", uuid::Uuid::new_v4()));
        let (_, trace) = merged_settings_traced_with_user(&dir, None);
        assert!(trace.files_to_copy.is_empty());
        assert_eq!(
            trace.run_mode, None,
            "三层都没定义 = None（调用方回落缺省）"
        );
        assert_eq!(trace.setup, None);
        assert_eq!(trace.archive, None);
        assert!(trace.run.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
