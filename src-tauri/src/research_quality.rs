//! 科研复现运行记录与验收决定：与 Git 合并分开，不把报告文字当成通过。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const RUN_TIMEOUT: Duration = Duration::from_secs(600);
const OUTPUT_CAP: usize = 256 * 1024;
const FILE_LIST_CAP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchRunDto {
    pub id: String,
    pub workspace_id: String,
    pub worktree_path: String,
    pub command: Vec<String>,
    pub entry: String,
    pub entry_revision: Option<String>,
    pub input: String,
    pub output_dir: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub outputs: Vec<String>,
    pub result_file: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub result_version: Option<String>,
    #[serde(default)]
    pub source_revision: Option<String>,
    #[serde(default)]
    pub source_changed: bool,
    #[serde(default)]
    pub result_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchAcceptedFile {
    pub path: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchAcceptanceDto {
    pub verdict: String,
    pub step_name: String,
    pub workspace_id: String,
    pub files: Vec<ResearchAcceptedFile>,
    pub conclusion_scope: String,
    pub open_blockers: Vec<String>,
    pub run_id: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub result_version: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub source_revision: Option<String>,
    #[serde(default)]
    pub source_run_id: Option<String>,
    #[serde(default)]
    pub source_root: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSourceDto {
    pub root: String,
    pub project_id: Option<String>,
    pub result_version: String,
    pub revision: String,
    pub warnings: Vec<String>,
}

/// 小文件校内容、大文件校 stat；禁止把「包含某个旧提交」伪装成正在审核那个旧版本。
fn source_at(
    root: &Path,
    result_version: Option<String>,
    project_id: Option<String>,
) -> Result<ResearchSourceDto, String> {
    let root = crate::paths::canonicalize_plain(root).map_err(|e| format!("来源目录无效：{e}"))?;
    let files = crate::task_review::collect_scoped_files(&root, &[".".into()])?;
    let mut hash = Sha256::new();
    let mut large = false;
    let mut hashed_bytes = 0u64;
    for rel in files {
        let path = root.join(&rel);
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        hash.update((rel.len() as u64).to_le_bytes());
        hash.update(rel.as_bytes());
        hash.update(meta.len().to_le_bytes());
        if meta.len() <= 8 * 1024 * 1024
            && hashed_bytes.saturating_add(meta.len()) <= 512 * 1024 * 1024
        {
            hashed_bytes += meta.len();
            hash.update(sha256_file(&path)?.as_bytes());
        } else {
            large = true;
            hash.update(
                meta.modified()
                    .map_err(|e| e.to_string())?
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos()
                    .to_le_bytes(),
            );
        }
    }
    let revision = format!("{:x}", hash.finalize());
    let git_head =
        crate::workspaces::run_git(&root, &["rev-parse", "HEAD"], Duration::from_secs(10)).ok();
    Ok(ResearchSourceDto {
        root: root.to_string_lossy().into_owned(),
        project_id,
        result_version: result_version
            .or(git_head)
            .unwrap_or_else(|| format!("files:{revision}")),
        revision,
        warnings: if large {
            vec!["单文件大于 8 MB 或总内容校验超过 512 MB 的来源按大小与修改时间检测漂移，未宣称已封存全部输入内容。".into()]
        } else {
            Vec::new()
        },
    })
}

fn resolve_source(
    project_root: &str,
    workspace_id: &str,
    worktree_path: &str,
    source_run_id: Option<&str>,
) -> Result<ResearchSourceDto, String> {
    let project = crate::projects::ensure_task_project_root(Path::new(
        &crate::sessions::expand_tilde(project_root),
    ))?;
    let project_id = crate::projects::project_id_at(&project);
    if let Some(run_id) = source_run_id {
        let run = crate::runs::run_get(run_id.into())?.ok_or("来源运行不存在")?;
        if !run
            .project_root
            .as_deref()
            .is_some_and(|p| crate::paths::same_path(p, &project.to_string_lossy()))
        {
            return Err("来源运行不属于当前项目".into());
        }
        if !crate::paths::same_path(worktree_path, &run.isolation_path) {
            return Err("来源路径与运行记录不一致".into());
        }
        return source_at(
            Path::new(&run.isolation_path),
            crate::runs::result_version_for(run_id)?,
            project_id,
        );
    }
    let ws = crate::workspaces::get_workspace(&crate::workspaces::db()?, workspace_id)?;
    if !crate::paths::same_path(&ws.repo_path, &project.to_string_lossy())
        && (ws.project_id.is_none() || ws.project_id != project_id)
    {
        return Err("科研工作区不属于当前项目".into());
    }
    if Path::new(&ws.worktree_path).is_dir() {
        if !crate::paths::same_path(worktree_path, &ws.worktree_path) {
            return Err("科研来源路径已变化，请重新打开".into());
        }
        return source_at(Path::new(&ws.worktree_path), None, project_id);
    }
    if ws.status != "archived" {
        return Err("科研来源目录不存在".into());
    }
    let fact = crate::projects::read_acceptance_log_at(&project)
        .into_iter()
        .rev()
        .find(|e| {
            e.kind == crate::review_contract::KIND_PIPELINE_MERGE
                && e.scene_ref.as_deref() == Some(workspace_id)
        })
        .ok_or("工作区已归档且没有可核对的接受记录")?;
    if !crate::workspaces::git_is_ancestor(&project, &fact.version_id, "HEAD")? {
        return Err("已接受版本不在项目历史中，不能回落项目根复现".into());
    }
    let mut source = source_at(&project, None, project_id)?;
    source
        .warnings
        .push("原工作区已归档，本次使用项目当前版本，不冒充原工作区版本。".into());
    Ok(source)
}

#[tauri::command]
pub async fn research_source(
    project_root: String,
    workspace_id: String,
    worktree_path: String,
    source_run_id: Option<String>,
) -> Result<ResearchSourceDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_source(
            &project_root,
            &workspace_id,
            &worktree_path,
            source_run_id.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn reproductions_root() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("无法确定用户主目录")?
        .join("ccode")
        .join("reproductions"))
}

fn safe_id(value: &str) -> Result<String, String> {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    crate::paths::sanitize_fs_name(&cleaned)
}

fn run_dir(workspace_id: &str, run_id: &str) -> Result<PathBuf, String> {
    Ok(reproductions_root()?
        .join(safe_id(workspace_id)?)
        .join(safe_id(run_id)?))
}

fn run_dir_v2(run_id: &str) -> Result<PathBuf, String> {
    crate::paths::validate_fs_name(run_id)?;
    Ok(reproductions_root()?.join(run_id))
}

fn load_run_any(workspace_id: &str, run_id: &str) -> Result<ResearchRunDto, String> {
    crate::paths::validate_fs_name(run_id)?;
    let old = run_dir(workspace_id, run_id)?.join("run.json");
    let mut run = if old.exists() {
        if let Some(layout) = run_stub_target(&old) {
            if layout != run_id {
                return Err("复现指针与请求运行不一致".into());
            }
            load_run(&run_dir_v2(&layout)?.join("run.json"))?
        } else {
            load_run(&old)?
        }
    } else {
        load_run(&run_dir_v2(run_id)?.join("run.json"))?
    };
    if run.id != run_id || run.workspace_id != workspace_id {
        return Err("复现记录与请求归属不一致".into());
    }
    let expected =
        crate::paths::canonicalize_plain(&reproductions_root()?).map_err(|e| e.to_string())?;
    let output = crate::paths::canonicalize_plain(Path::new(&run.output_dir))
        .map_err(|e| format!("复现输出目录不存在：{e}"))?;
    if !crate::paths::path_within_path(&output, &expected) {
        return Err("复现输出目录不在受管理目录内".into());
    }
    run.stdout = crate::sessions::redact_sensitive_text(&run.stdout);
    run.stderr = crate::sessions::redact_sensitive_text(&run.stderr);
    Ok(run)
}

fn run_stub_target(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    if v.get("layout").and_then(|x| x.as_str()) == Some("v2") {
        v.get("runId")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
    } else {
        None
    }
}

fn load_run(path: &Path) -> Result<ResearchRunDto, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读取运行记录失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("运行记录损坏: {e}"))
}

fn save_run(dir: &Path, run: &ResearchRunDto) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建运行目录失败: {e}"))?;
    crate::profiles::atomic_write(
        &dir.join("run.json"),
        &serde_json::to_string_pretty(run).map_err(|e| e.to_string())?,
    )
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut input = fs::File::open(path).map_err(|e| format!("读取来源失败：{e}"))?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn list_outputs(root: &Path) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    fn walk(
        root: &Path,
        dir: &Path,
        out: &mut Vec<String>,
        visited: &mut usize,
    ) -> Result<(), String> {
        *visited += 1;
        if *visited > 2000 {
            return Err("输出目录层次超过遍历预算".into());
        }
        if out.len() >= FILE_LIST_CAP {
            return Ok(());
        }
        let entries = match fs::read_dir(dir) {
            Ok(v) => v,
            Err(e) => return Err(format!("列举输出失败: {e}")),
        };
        for entry in entries {
            let entry = entry.map_err(|e| format!("列举输出失败: {e}"))?;
            let path = entry.path();
            if path.file_name().and_then(|n| n.to_str()) == Some("run.json") {
                continue;
            }
            if fs::symlink_metadata(&path)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, out, visited)?;
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
            if out.len() >= FILE_LIST_CAP {
                break;
            }
        }
        Ok(())
    }
    walk(root, root, &mut out, &mut 0)?;
    out.sort();
    Ok(out)
}

/// 找真能跑的 Python（dep_check::usable_python，Windows 上 python3 是应用商店占位）
fn python_bin() -> Result<PathBuf, String> {
    crate::dep_check::usable_python()
        .ok_or_else(|| "未找到可用的 Python 3，无法执行复现脚本（设置 → 诊断可一键安装 Python）".into())
}

/// Python 子进程统一强制 UTF-8：中文 Windows 上 stdout 与 open() 默认编码是 cp936，
/// 读写含中文的 UTF-8 数据会 UnicodeDecodeError、输出成乱码。UTF-8 系统上是空操作
fn python_command(python: &Path) -> crate::process::BackgroundCommand {
    let mut cmd = crate::process::background_command(python);
    cmd.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
    cmd
}

#[tauri::command]
pub async fn research_run_reproduce(
    project_root: String,
    source_run_id: Option<String>,
    expected_source_revision: Option<String>,
    workspace_id: String,
    worktree_path: String,
    entry: String,
    subcommand: Option<String>,
    result_file: Option<String>,
) -> Result<ResearchRunDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = resolve_source(
            &project_root,
            &workspace_id,
            &worktree_path,
            source_run_id.as_deref(),
        )?;
        if expected_source_revision.as_deref() != Some(source.revision.as_str()) {
            return Err("科研来源已变化，请刷新后重新确认复现".into());
        }
        let tree = PathBuf::from(&source.root);
        let rel = entry.trim().replace('\\', "/");
        if rel.is_empty()
            || Path::new(&rel).is_absolute()
            || !rel.ends_with(".py")
            || rel.split('/').any(|p| matches!(p, ".." | "." | ""))
        {
            return Err("复现入口必须是项目内相对路径".into());
        }
        let script = tree.join(&rel);
        if !crate::paths::path_within_path(
            &crate::paths::canonicalize_plain(&script).map_err(|e| format!("复现入口无效: {e}"))?,
            &tree,
        ) {
            return Err("复现入口不在工作区内".into());
        }
        if !script.is_file()
            || fs::metadata(&script).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024
        {
            return Err("复现入口必须是 2 MB 以内的 Python 文件".into());
        }
        if subcommand.as_deref().is_some_and(|c| c != "reproduce") {
            return Err("只接受明确的 reproduce 子命令，不能借复现入口执行其它模式".into());
        }
        if subcommand.is_none() {
            let text = fs::read_to_string(&script).map_err(|e| e.to_string())?;
            let raw = text
                .lines()
                .find_map(|line| line.trim_start().strip_prefix("# MESA_REPRODUCE:"))
                .ok_or("无子命令的入口必须声明 MESA_REPRODUCE 约定")?;
            let contract: serde_json::Value =
                serde_json::from_str(raw).map_err(|e| format!("复现约定损坏：{e}"))?;
            if contract.get("interpreter").and_then(|v| v.as_str()) != Some("python")
                || contract.get("outputPlacement").and_then(|v| v.as_str()) != Some("independent")
            {
                return Err("复现约定必须明确 python 与独立输出目录".into());
            }
        }
        let revision = sha256_file(&script)?;
        let run_id = format!("r-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
        let out = run_dir_v2(&run_id)?;
        if out.exists() {
            return Err("运行目录已存在".into());
        }
        let stub_dir = run_dir(&workspace_id, &run_id)?;
        fs::create_dir_all(&stub_dir).map_err(|e| format!("创建运行目录失败: {e}"))?;
        let stub = serde_json::json!({"layout":"v2","runId": run_id});
        crate::profiles::atomic_write(&stub_dir.join("run.json"), &stub.to_string())?;
        if crate::paths::path_within_path(&out, &tree)
            || crate::paths::path_within_path(&tree, &out)
        {
            return Err("输出必须独立于输入项目".into());
        }
        fs::create_dir_all(&out).map_err(|e| format!("创建输出目录失败: {e}"))?;
        let python = python_bin()?;
        let mut args = vec![rel.clone()];
        if let Some(cmd) = subcommand.as_ref().filter(|s| !s.trim().is_empty()) {
            args.push(cmd.trim().to_string());
        }
        args.extend([
            "--input".into(),
            tree.to_string_lossy().into_owned(),
            "--output".into(),
            out.to_string_lossy().into_owned(),
        ]);
        let mut command_line = vec![python.to_string_lossy().into_owned()];
        command_line.extend(args.iter().cloned());
        let started = crate::sessions::now_iso();
        let mut run = ResearchRunDto {
            id: run_id.clone(),
            workspace_id: workspace_id.clone(),
            worktree_path: tree.to_string_lossy().into_owned(),
            command: command_line,
            entry: rel,
            entry_revision: Some(revision),
            input: tree.to_string_lossy().into_owned(),
            output_dir: out.to_string_lossy().into_owned(),
            status: "running".into(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            outputs: Vec::new(),
            result_file: result_file.filter(|s| !s.trim().is_empty()),
            started_at: started,
            finished_at: None,
            project_id: source.project_id,
            result_version: Some(source.result_version.clone()),
            source_revision: Some(source.revision.clone()),
            source_changed: false,
            result_revision: None,
        };
        save_run(&out, &run)?;
        let mut cmd = python_command(&python);
        cmd.current_dir(&tree);
        cmd.args(&args);
        let captured = match crate::process::capture_command(&mut cmd, RUN_TIMEOUT, OUTPUT_CAP) {
            Ok(captured) => captured,
            Err(error) => {
                run.status = "failed".into();
                run.stderr = crate::sessions::redact_sensitive_text(&error);
                run.finished_at = Some(crate::sessions::now_iso());
                save_run(&out, &run)?;
                return Ok(run);
            }
        };
        run.stdout =
            crate::sessions::redact_sensitive_text(&String::from_utf8_lossy(&captured.stdout));
        run.stderr =
            crate::sessions::redact_sensitive_text(&String::from_utf8_lossy(&captured.stderr));
        run.finished_at = Some(crate::sessions::now_iso());
        run.exit_code = captured.status.and_then(|s| s.code());
        run.status = if captured.timed_out {
            "failed".into()
        } else if captured.status.map(|s| s.success()).unwrap_or(false) {
            "succeeded".into()
        } else if run.stderr.contains("BLOCKED:") {
            "blocked".into()
        } else {
            "failed".into()
        };
        if captured.timed_out {
            run.stderr = format!("运行超时（{} 秒）。\n{}", RUN_TIMEOUT.as_secs(), run.stderr);
        }
        run.source_changed = source_at(&tree, run.result_version.clone(), run.project_id.clone())
            .map(|after| after.revision != source.revision)
            .unwrap_or(true);
        if run.source_changed {
            run.stderr
                .push_str("\n复现期间来源文件变化，本次结果不可作为原版本的验收证据。");
        }
        run.outputs = match list_outputs(&out) {
            Ok(outputs) => outputs,
            Err(error) => {
                run.stderr
                    .push_str(&format!("\n输出清单未完整读取：{error}"));
                Vec::new()
            }
        };
        run.result_revision = result_revision_at(&out, run.result_file.as_deref())
            .ok()
            .flatten();
        if run.result_file.is_some() && run.result_revision.is_none() {
            run.status = "failed".into();
            run.stderr.push_str(
                "\n约定结果文件缺失、超出 8 MB 校验预算或路径不安全，不能据此确认复现检查。",
            );
        }
        if run.status == "succeeded" {
            if let Err(error) = verify_result_status(&out, run.result_file.as_deref()) {
                run.status = "failed".into();
                run.stderr.push_str(&format!("\n{error}"));
            }
        }
        save_run(&out, &run)?;
        Ok(run)
    })
    .await
    .map_err(|e| format!("复现运行失败: {e}"))?
}

#[tauri::command]
pub async fn research_get_run(
    workspace_id: String,
    run_id: String,
) -> Result<ResearchRunDto, String> {
    tauri::async_runtime::spawn_blocking(move || load_run_any(&workspace_id, &run_id))
        .await
        .map_err(|e| format!("读取运行记录失败: {e}"))?
}

#[tauri::command]
pub async fn research_read_run_file(
    workspace_id: String,
    run_id: String,
    path: String,
) -> Result<crate::fs_tree::FilePreviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let run = load_run_any(&workspace_id, &run_id)?;
        let dir = PathBuf::from(&run.output_dir);
        if run.result_file.as_deref() == Some(path.as_str())
            && run.result_revision.is_some()
            && result_revision_at(&dir, Some(&path))? != run.result_revision
        {
            return Err("本次复现的结果文件在结束后被修改，不能作为原记录预览".into());
        }
        let rel = path.trim().replace('\\', "/");
        if rel.is_empty()
            || rel.starts_with('/')
            || rel.split('/').any(|p| p == ".." || p.is_empty())
        {
            return Err("结果路径必须是本次输出内的相对路径".into());
        }
        let file = dir.join(&rel);
        let canon =
            crate::paths::canonicalize_plain(&file).map_err(|e| format!("结果文件不存在: {e}"))?;
        let root =
            crate::paths::canonicalize_plain(&dir).map_err(|e| format!("运行目录无效: {e}"))?;
        if !crate::paths::path_within_path(&canon, &root) {
            return Err("结果文件不在本次输出目录内".into());
        }
        crate::fs_tree::read_file_preview_sync(&canon.to_string_lossy(), &root.to_string_lossy())
    })
    .await
    .map_err(|e| format!("读取结果失败: {e}"))?
}

fn verify_result_status(root: &Path, relative: Option<&str>) -> Result<(), String> {
    let Some(relative) = relative else {
        return Ok(());
    };
    result_revision_at(root, Some(relative))?;
    let path = root.join(relative);
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("复现结果不是合法 JSON：{e}"))?;
        if value.get("ok").and_then(|v| v.as_bool()) == Some(false)
            || value
                .get("checks")
                .and_then(|v| v.as_array())
                .is_some_and(|rows| {
                    rows.iter()
                        .any(|row| row.get("passed").and_then(|v| v.as_bool()) == Some(false))
                })
        {
            return Err("复现结果明确报告检查失败，不能仅凭退出码 0 记为成功".into());
        }
    }
    Ok(())
}

fn result_revision_at(root: &Path, relative: Option<&str>) -> Result<Option<String>, String> {
    let Some(relative) = relative else {
        return Ok(None);
    };
    if Path::new(relative).is_absolute()
        || relative
            .replace('\\', "/")
            .split('/')
            .any(|p| matches!(p, ".." | "." | ""))
    {
        return Err("复现结果路径不安全".into());
    }
    let root = crate::paths::canonicalize_plain(root).map_err(|e| e.to_string())?;
    let file = crate::paths::canonicalize_plain(&root.join(relative)).map_err(|e| e.to_string())?;
    if !crate::paths::path_within_path(&file, &root)
        || fs::metadata(&file).map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024
    {
        return Err("复现结果不在独立目录内或超过校验预算".into());
    }
    sha256_file(&file).map(Some)
}

fn validate_reproduction_binding(
    run: &ResearchRunDto,
    source: &ResearchSourceDto,
) -> Result<(), String> {
    if run.status == "running"
        || run.finished_at.is_none()
        || run.project_id != source.project_id
        || run.source_changed
        || run.source_revision.as_deref() != Some(source.revision.as_str())
        || run.result_version.as_deref() != Some(source.result_version.as_str())
    {
        return Err("所关联复现不是当前来源版本，需重新运行或取消关联".into());
    }
    if run.result_file.is_some() {
        let current = result_revision_at(Path::new(&run.output_dir), run.result_file.as_deref())?;
        if run.result_revision.is_none() || current != run.result_revision {
            return Err("复现结果文件未绑定版本或已变化，请重新复现后再关联验收".into());
        }
    }
    Ok(())
}

fn replace_acceptance(rows: &mut Vec<ResearchAcceptanceDto>, saved: ResearchAcceptanceDto) {
    rows.retain(|r| {
        !(r.step_name == saved.step_name
            && r.result_version == saved.result_version
            && r.source_revision == saved.source_revision)
    });
    rows.push(saved);
}

fn acceptance_path(root: &Path) -> PathBuf {
    root.join(".ccode").join("research-acceptance.json")
}

fn load_acceptances(root: &Path) -> Result<Vec<ResearchAcceptanceDto>, String> {
    let path = acceptance_path(root);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取验收记录失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("验收记录损坏: {e}"))
}

#[tauri::command]
pub async fn research_save_acceptance(
    project_root: String,
    record: ResearchAcceptanceDto,
) -> Result<ResearchAcceptanceDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(
            record.verdict.as_str(),
            "accept" | "accept_with_conditions" | "return"
        ) {
            return Err("验收决定必须是接受、有条件接受或退回".into());
        }
        if record.conclusion_scope.len() > 32 * 1024
            || record.open_blockers.len() > 200
            || record.files.len() > 200
        {
            return Err("科研验收记录超过预算，未保存".into());
        }
        if record.verdict == "accept" && record.open_blockers.iter().any(|s| !s.trim().is_empty()) {
            return Err(
                "仍有未关闭阻塞项，不能记为无条件接受；请退回或明确限定为有条件接受".into(),
            );
        }
        if record.conclusion_scope.trim().is_empty() {
            return Err("请写明接受的结论范围".into());
        }
        let root = crate::projects::ensure_task_project_root(Path::new(
            &crate::sessions::expand_tilde(&project_root),
        ))?;
        let _lock = crate::review_contract::apply_lock(&root)?;
        let source_root = record
            .source_root
            .as_deref()
            .ok_or("缺少科研来源，请刷新评审")?;
        let source = resolve_source(
            &project_root,
            &record.workspace_id,
            source_root,
            record.source_run_id.as_deref(),
        )?;
        if record.result_version.as_deref() != Some(source.result_version.as_str())
            || record.source_revision.as_deref() != Some(source.revision.as_str())
        {
            return Err("你看过之后科研来源已变化，请重新检查再记下决定".into());
        }
        if record.verdict != "return" && record.files.is_empty() {
            return Err("接受研究结论必须绑定至少一份完整证据文件".into());
        }
        for file in &record.files {
            let relative = file.path.replace('\\', "/");
            if Path::new(&relative).is_absolute()
                || relative.split('/').any(|p| matches!(p, ".." | "." | ""))
            {
                return Err("证据必须是来源内相对路径".into());
            }
            let path = crate::paths::canonicalize_plain(&Path::new(&source.root).join(&relative))
                .map_err(|e| e.to_string())?;
            if !crate::paths::path_within_path(&path, Path::new(&source.root))
                || sha256_file(&path)? != file.revision
            {
                return Err(format!("证据 {} 已变化或不属于来源", file.path));
            }
        }
        if let Some(run_id) = &record.run_id {
            let run = load_run_any(&record.workspace_id, run_id)?;
            validate_reproduction_binding(&run, &source)?;
        }
        if source_at(
            Path::new(&source.root),
            Some(source.result_version.clone()),
            source.project_id.clone(),
        )?
        .revision
            != source.revision
        {
            return Err("核对期间科研来源变化，未记录验收，请重新检查".into());
        }
        let mut rows = load_acceptances(&root)?;
        let mut saved = record;
        saved.created_at = crate::sessions::now_iso();
        saved.project_id = source.project_id;
        replace_acceptance(&mut rows, saved.clone());
        let dir = root.join(".ccode");
        fs::create_dir_all(&dir).map_err(|e| format!("创建项目记录目录失败: {e}"))?;
        crate::profiles::atomic_write(
            &acceptance_path(&root),
            &serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?,
        )?;
        Ok(saved)
    })
    .await
    .map_err(|e| format!("保存验收决定失败: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamAcceptance {
    pub step_name: String,
    pub verdict: String,
    pub conclusion_scope: String,
    pub open_blockers: Vec<String>,
    pub created_at: String,
    pub result_version: Option<String>,
    pub valid: bool,
    pub changed_files: Vec<String>,
}

fn upstream_acceptances_at(
    root: &Path,
    step_name: &str,
) -> Result<Vec<UpstreamAcceptance>, String> {
    let cfg = crate::projects::read_config_at(root).config;
    let index = cfg
        .steps
        .iter()
        .position(|s| s.name == step_name)
        .ok_or("步骤不存在")?;
    let records = load_acceptances(root)?;
    let mut out = Vec::new();
    for step in &cfg.steps[..index] {
        let Some(record) = records.iter().rev().find(|r| r.step_name == step.name) else {
            continue;
        };
        let mut changed_files = Vec::new();
        let mut bytes = 0u64;
        if record.files.len() > 200 {
            return Err("上游验收文件超过核验预算".into());
        }
        for file in &record.files {
            let relative = file.path.replace('\\', "/");
            let safe = !Path::new(&relative).is_absolute()
                && !relative.split('/').any(|p| matches!(p, "" | "." | ".."));
            let matches = safe
                && crate::paths::canonicalize_plain(&root.join(&relative))
                    .ok()
                    .filter(|p| crate::paths::path_within_path(p, root))
                    .filter(|p| {
                        fs::metadata(p).is_ok_and(|m| {
                            bytes = bytes.saturating_add(m.len());
                            m.len() <= 8 * 1024 * 1024 && bytes <= 64 * 1024 * 1024
                        })
                    })
                    .and_then(|p| sha256_file(&p).ok())
                    .is_some_and(|revision| revision == file.revision);
            if !matches {
                changed_files.push(file.path.clone());
            }
        }
        out.push(UpstreamAcceptance {
            step_name: record.step_name.clone(),
            verdict: record.verdict.clone(),
            conclusion_scope: record.conclusion_scope.clone(),
            open_blockers: record.open_blockers.clone(),
            created_at: record.created_at.clone(),
            result_version: record.result_version.clone(),
            valid: !record.files.is_empty() && changed_files.is_empty(),
            changed_files,
        });
    }
    Ok(out)
}

/// 上游验收只供当前步骤引用；核对主仓证据哈希，不能把旧版本或退回当授权。
#[tauri::command]
pub async fn research_upstream_acceptances(
    project_root: String,
    step_name: String,
) -> Result<Vec<UpstreamAcceptance>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(
            &crate::sessions::expand_tilde(&project_root),
        ))?;
        upstream_acceptances_at(&root, &step_name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_get_acceptance(
    result_version: Option<String>,
    source_revision: Option<String>,
    project_root: String,
    workspace_id: String,
    step_name: String,
) -> Result<Option<ResearchAcceptanceDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(
            &crate::sessions::expand_tilde(&project_root),
        ))?;
        Ok(load_acceptances(&root)?.into_iter().rev().find(|r| {
            r.step_name == step_name
                && match result_version.as_deref() {
                    Some(version) => {
                        r.result_version.as_deref() == Some(version)
                            && r.source_revision == source_revision
                    }
                    None => r.workspace_id == workspace_id,
                }
        }))
    })
    .await
    .map_err(|e| format!("读取验收决定失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reproduction_binding_rejects_changed_source_and_changed_result() {
        let root =
            std::env::temp_dir().join(format!("mesa-result-binding-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("verification.json"), r#"{"ok":true}"#).unwrap();
        let source = ResearchSourceDto {
            root: root.to_string_lossy().into_owned(),
            project_id: Some("p".into()),
            result_version: "r:2".into(),
            revision: "source".into(),
            warnings: Vec::new(),
        };
        let mut run: ResearchRunDto = serde_json::from_value(serde_json::json!({
            "id":"verify", "workspaceId":"w", "worktreePath":"tree", "command":[], "entry":"reproduce.py", "entryRevision":"entry",
            "input":"tree", "outputDir":root.to_string_lossy(), "status":"succeeded", "exitCode":0, "stdout":"", "stderr":"",
            "outputs":["verification.json"], "resultFile":"verification.json", "startedAt":"t1", "finishedAt":"t2",
            "projectId":"p", "resultVersion":"r:2", "sourceRevision":"source", "sourceChanged":false,
            "resultRevision":result_revision_at(&root, Some("verification.json")).unwrap()
        })).unwrap();
        validate_reproduction_binding(&run, &source).unwrap();
        run.source_changed = true;
        assert!(validate_reproduction_binding(&run, &source).is_err());
        run.source_changed = false;
        fs::write(root.join("verification.json"), r#"{"ok":false}"#).unwrap();
        assert!(validate_reproduction_binding(&run, &source)
            .unwrap_err()
            .contains("结果文件"));
        assert!(result_revision_at(&root, Some("../escape")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_result_failure_cannot_become_success_from_exit_code_alone() {
        let root =
            std::env::temp_dir().join(format!("mesa-result-status-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        for bad in [
            r#"{"ok":false}"#,
            r#"{"ok":true,"checks":[{"passed":false}]}"#,
            "invalid",
        ] {
            fs::write(root.join("verification.json"), bad).unwrap();
            assert!(verify_result_status(&root, Some("verification.json")).is_err());
        }
        fs::write(
            root.join("verification.json"),
            r#"{"ok":true,"checks":[{"passed":true}]}"#,
        )
        .unwrap();
        assert!(verify_result_status(&root, Some("verification.json")).is_ok());
        assert!(verify_result_status(&root, Some("missing.json")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn upstream_acceptance_tracks_evidence_hash_and_retains_return_verdict() {
        let root = std::env::temp_dir().join(format!("mesa-upstream-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".ccode")).unwrap();
        fs::write(
            root.join(".ccode/project.toml"),
            "[[steps]]\nname = \"分析\"\n[[steps]]\nname = \"初稿\"\n",
        )
        .unwrap();
        let root = crate::paths::canonicalize_plain(&root).unwrap();
        fs::write(root.join("report.md"), "reviewed").unwrap();
        let row = serde_json::json!({"verdict":"return","stepName":"分析","workspaceId":"w","files":[{"path":"report.md","revision":sha256_file(&root.join("report.md")).unwrap()}],"conclusionScope":"证据不足","openBlockers":["缺复算"],"runId":null,"createdAt":"2026-09-11"});
        fs::write(
            acceptance_path(&root),
            serde_json::to_vec(&vec![row]).unwrap(),
        )
        .unwrap();
        let current = upstream_acceptances_at(&root, "初稿").unwrap();
        assert!(current[0].valid);
        assert_eq!(current[0].verdict, "return");
        fs::write(root.join("report.md"), "changed").unwrap();
        assert!(!upstream_acceptances_at(&root, "初稿").unwrap()[0].valid);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_fingerprint_ignores_internal_logs_but_tracks_input_edits() {
        let root = std::env::temp_dir().join(format!("mesa-source-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".ccode")).unwrap();
        fs::write(root.join("report.md"), "v1").unwrap();
        let first = source_at(&root, Some("commit".into()), Some("project".into())).unwrap();
        fs::write(root.join(".ccode/acceptance-log.jsonl"), "new record").unwrap();
        assert_eq!(
            source_at(&root, Some("commit".into()), Some("project".into()))
                .unwrap()
                .revision,
            first.revision
        );
        fs::write(root.join("report.md"), "v2").unwrap();
        assert_ne!(
            source_at(&root, Some("commit".into()), Some("project".into()))
                .unwrap()
                .revision,
            first.revision
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scientific_acceptance_keeps_separate_content_versions_and_reads_legacy() {
        let old = r#"{"verdict":"accept","stepName":"分析","workspaceId":"w","files":[],"conclusionScope":"旧范围","openBlockers":[],"runId":null,"createdAt":"t"}"#;
        let legacy: ResearchAcceptanceDto = serde_json::from_str(old).unwrap();
        assert!(legacy.result_version.is_none());
        let mut rows = vec![legacy.clone()];
        let mut next = legacy;
        next.result_version = Some("commit".into());
        next.source_revision = Some("v1".into());
        replace_acceptance(&mut rows, next.clone());
        next.source_revision = Some("v2".into());
        replace_acceptance(&mut rows, next.clone());
        replace_acceptance(&mut rows, next);
        assert_eq!(rows.len(), 3);
        assert!(run_dir_v2("../escape").is_err());
    }

    #[test]
    fn python_reproduce_writes_independent_result() {
        let tmp = std::env::temp_dir().join(format!("mesa-repro-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join("experiments")).unwrap();
        let script = tmp.join("experiments/reproduce.py");
        fs::write(
            &script,
            "import argparse, json, pathlib\nparser=argparse.ArgumentParser()\nsub=parser.add_subparsers(dest='command',required=True)\nr=sub.add_parser('reproduce')\nr.add_argument('--input',required=True)\nr.add_argument('--output',required=True)\na=parser.parse_args()\nout=pathlib.Path(a.output)\nout.mkdir(parents=True,exist_ok=True)\n(out/'verification.json').write_text(json.dumps({'ok':True}))\n",
        )
        .unwrap();
        let python = python_bin().unwrap();
        let out = tmp.join("outside");
        let mut cmd = python_command(&python);
        cmd.current_dir(&tmp);
        cmd.args([
            "experiments/reproduce.py",
            "reproduce",
            "--input",
            tmp.to_str().unwrap(),
            "--output",
            out.to_str().unwrap(),
        ]);
        let captured =
            crate::process::capture_command(&mut cmd, Duration::from_secs(20), 4096).unwrap();
        assert!(
            captured.status.unwrap().success(),
            "{}",
            String::from_utf8_lossy(&captured.stderr)
        );
        assert!(out.join("verification.json").is_file());
        assert!(!tmp.join("verification.json").exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 默认编码读 UTF-8 中文文件、打印中文：中文 Windows（cp936）上不强制 UTF-8 会报错或乱码
    #[test]
    fn python_children_use_utf8_for_files_and_stdout() {
        let Ok(python) = python_bin() else {
            return;
        };
        let tmp = std::env::temp_dir().join(format!("mesa-utf8-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("zh.txt"), "镁电池·数据".as_bytes()).unwrap();
        let mut cmd = python_command(&python);
        cmd.current_dir(&tmp);
        cmd.args(["-c", "print(open('zh.txt').read())"]);
        let captured =
            crate::process::capture_command(&mut cmd, Duration::from_secs(20), 4096).unwrap();
        let _ = fs::remove_dir_all(&tmp);
        assert!(
            captured.status.unwrap().success(),
            "{}",
            String::from_utf8_lossy(&captured.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&captured.stdout).trim(), "镁电池·数据");
    }

    #[test]
    fn workspace_ids_with_hyphens_are_safe_directory_names() {
        let name = safe_id("6ba7b810-9dad-11d1-80b4-00c04fd430c8").unwrap();
        assert!(crate::paths::validate_fs_name(&name).is_ok(), "{name}");
        assert_eq!(safe_id("r-abc123").unwrap(), "r-abc123");
    }
}
