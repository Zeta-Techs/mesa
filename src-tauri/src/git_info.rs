//! 改动面板（§6.9）：git 状态查询与提交/推送。
//! 全部走 std::process::Command 参数数组（无 shell），阻塞调用放 spawn_blocking。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Component, Path};
use std::process::{Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const FILE_DIFF_CAP: usize = 200_000;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusDto {
    pub is_repo: bool,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileDto>,
    pub total_add: u64,
    pub total_del: u64,
    /// 正在 merge（MERGE_HEAD 存在）：改动面板给取消合并出口
    pub merging: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDto {
    pub path: String,
    /// "M" | "A" | "D" | "R" | "??" | "U"（冲突未合并）
    pub status: String,
    /// 二进制文件为 None（numstat 显示 -\t-）
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

fn expand_tilde(path: &str) -> String {
    crate::paths::expand_tilde(path)
}

/// 平台 git 配置：Windows 打开 core.longpaths（MAX_PATH 260），深目录下的工作树/检出才不会报
/// "Filename too long"。命令行 -c 只作用于这次调用，不改用户 gitconfig；其它平台为空，行为不变。
pub(crate) const PLATFORM_GIT_CONFIG: &[&str] = if cfg!(windows) {
    &["-c", "core.longpaths=true"]
} else {
    &[]
};

pub(crate) fn run_git(cwd: &str, args: &[&str]) -> Result<Output, String> {
    let git = crate::agents::resolve_binary("git").ok_or("找不到 git 可执行文件，请先安装 git")?;
    crate::process::background_command(git)
        .arg("-C")
        .arg(cwd)
        .args(["-c", "core.quotepath=false"])
        .args(PLATFORM_GIT_CONFIG)
        .args(args)
        .output()
        .map_err(|e| format!("执行 git 失败: {e}"))
}

// ===== 「是否 git 仓库」探测负缓存 =====
// 改动面板按 8s × 挂载标签数轮询 git_status，cwd 不是仓库时每轮都会真 spawn 一次
// git（诊断包实测：Windows 安装版 85 秒内对同一 home 目录探测 73 次）。非仓库结果
// 在 TTL 内直接复用；只缓存否定结果——仓库被删除等正向变化仍由后续 git 调用即时报错，
// 行为不变。应用内 git init 成功后必须调 invalidate_repo_probe 主动失效。

const REPO_PROBE_TTL: Duration = Duration::from_secs(30);
const REPO_PROBE_CACHE_CAP: usize = 256;

fn repo_probe_cache() -> &'static Mutex<HashMap<String, Instant>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, Instant>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// cwd 是否 git 工作树；非仓库结果带 30s 负缓存（键为 expand_tilde 后的调用方字符串）
fn probe_is_work_tree(cwd: &str) -> Result<bool, String> {
    if let Ok(guard) = repo_probe_cache().lock() {
        if guard
            .get(cwd)
            .is_some_and(|ts| ts.elapsed() < REPO_PROBE_TTL)
        {
            return Ok(false);
        }
    }
    let check = run_git(cwd, &["rev-parse", "--is-inside-work-tree"])?;
    let inside = check.status.success();
    if !inside {
        if let Ok(mut guard) = repo_probe_cache().lock() {
            // 有界：先清过期项，仍满则清空重建（ TTL 只有 30s，重建代价低）
            if guard.len() >= REPO_PROBE_CACHE_CAP {
                guard.retain(|_, ts| ts.elapsed() < REPO_PROBE_TTL);
                if guard.len() >= REPO_PROBE_CACHE_CAP {
                    guard.clear();
                }
            }
            guard.insert(cwd.to_string(), Instant::now());
        }
    }
    Ok(inside)
}

/// git init 等「非仓库 → 仓库」转变后主动失效负缓存（外部变更靠 TTL 自然过期）
pub(crate) fn invalidate_repo_probe(cwd: &str) {
    if let Ok(mut guard) = repo_probe_cache().lock() {
        guard.remove(cwd);
    }
}

/// stdout+stderr 合并取尾部 ~20 行，作为命令结果/错误展示
fn output_tail(o: &Output) -> String {
    let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
    let err = String::from_utf8_lossy(&o.stderr);
    if !s.is_empty() && !err.is_empty() {
        s.push('\n');
    }
    s.push_str(&err);
    tail_lines(&s, 20)
}

fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.trim_end().lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// 解析 `git status --porcelain=v1 -b`：
/// 返回 (branch, ahead, behind, [(status, path)])
fn parse_porcelain(text: &str) -> (String, u32, u32, Vec<(String, String)>) {
    let mut branch = String::new();
    let (mut ahead, mut behind) = (0, 0);
    let mut files = Vec::new();
    for line in text.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            // "main...origin/main [ahead 1, behind 2]" / "main" / "No commits yet on main"
            if let Some(b) = h.strip_prefix("No commits yet on ") {
                branch = b.trim().to_string();
                continue;
            }
            let (b, rest) = match h.split_once("...") {
                Some((b, r)) => (b, r),
                None => (h, ""),
            };
            branch = b.trim().to_string();
            if let Some(start) = rest.find('[') {
                if let Some(end) = rest[start..].find(']') {
                    for part in rest[start + 1..start + end].split(',') {
                        let part = part.trim();
                        if let Some(n) = part.strip_prefix("ahead ") {
                            ahead = n.trim().parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix("behind ") {
                            behind = n.trim().parse().unwrap_or(0);
                        }
                    }
                }
            }
            continue;
        }
        if line.len() < 3 {
            continue;
        }
        let xy = &line[..2];
        if xy == "!!" {
            continue; // gitignore 忽略的条目
        }
        // unmerged：DD/AU/UD/UA/DU/AA/UU。不能压成单字母，否则 AA 会被当成新增。
        const UNMERGED: &[&str] = &["DD", "AU", "UD", "UA", "DU", "AA", "UU"];
        let status = if xy == "??" {
            "??".to_string()
        } else if UNMERGED.contains(&xy) {
            "U".to_string()
        } else {
            xy.chars()
                .find(|c| !c.is_whitespace())
                .unwrap_or('M')
                .to_string()
        };
        let mut path = line[3..].to_string();
        // 重命名条目形如 "old -> new"，取新名；整体被引号包住时先解外层再切
        if path.starts_with('"') && !path.contains(" -> \"") {
            if let Some(unq) = unquote_diff_path(&path) {
                path = unq;
            }
        }
        if let Some((_, new)) = path.split_once(" -> ") {
            path = new.to_string();
        }
        // 含非 ASCII/特殊字符的路径 git 会 C 风格加引号并把字节转八进制（core.quotepath 默认开），
        // 只剥引号会留下 \ooo 字面量导致按错路径读文件，必须完整反转义
        if let Some(unq) = unquote_diff_path(&path) {
            path = unq;
        }
        files.push((status, path));
    }
    (branch, ahead, behind, files)
}

/// 解析 `git diff --numstat HEAD`：path → (add, del)；二进制行（-\t-）跳过
fn parse_numstat(text: &str) -> HashMap<String, (u64, u64)> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if let (Ok(a), Ok(d)) = (a.parse::<u64>(), d.parse::<u64>()) {
            map.insert(p.to_string(), (a, d));
        }
    }
    map
}

/// 已知二进制扩展名：内容可能是纯 ASCII 开头（部分 PDF 无 NUL 字节），按扩展名直接排除
const BINARY_EXTS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svgz", "zip", "gz", "tar", "zst",
    "xz", "bz2", "7z", "rar", "parquet", "xlsx", "xls", "docx", "doc", "pptx", "ppt", "mp4", "mov",
    "avi", "mp3", "wav", "flac", "ttf", "otf", "woff", "woff2", "eot", "sqlite", "db", "pyc", "so",
    "dylib", "dll", "exe", "bin", "dat", "sav", "dta", "rds",
];

/// 未跟踪文件的行数作为 additions（best effort：二进制/超大/目录/不可读 → None。
/// 二进制必须探测——PDF 这类文件的换行字节会把面板总增删数顶到几十万）
fn count_lines(cwd: &str, rel: &str) -> Option<u64> {
    use std::io::Read;
    const MAX_SIZE: u64 = 32 * 1024 * 1024;
    const SNIFF: usize = 8192;
    let path = Path::new(cwd).join(rel);
    // 已知二进制扩展名直接排除（内容探测对纯 ASCII 开头的 PDF 会漏判）
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if ext.is_some_and(|e| BINARY_EXTS.contains(&e.as_str())) {
        return None;
    }
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_SIZE {
        return None;
    }
    // 头部含 NUL 或不是合法 UTF-8（截断的尾字符除外）即按二进制处理，不计行数
    let mut file = std::fs::File::open(&path).ok()?;
    let mut head = [0u8; SNIFF];
    let n = file.read(&mut head).ok()?;
    let sample = &head[..n];
    if sample.contains(&0) {
        return None;
    }
    if let Err(e) = std::str::from_utf8(sample) {
        // 样本末尾截断多字节字符不算二进制；中途出现非法序列才算
        if e.error_len().is_some() {
            return None;
        }
    }
    let bytes = std::fs::read(&path).ok()?;
    Some(bytes.iter().filter(|b| **b == b'\n').count() as u64)
}

pub(crate) fn git_status_sync(cwd: &str) -> Result<GitStatusDto, String> {
    let cwd = expand_tilde(cwd);
    // cwd 已不存在（工作区被归档/删除后标签页仍指着旧路径）要与「目录在但不是仓库」区分开，
    // 否则 git rev-parse 的 128 会被误显示为「该目录不是 git 仓库」
    if !Path::new(&cwd).is_dir() {
        return Err(format!("目录不存在（可能已被归档或删除）：{cwd}"));
    }
    if !probe_is_work_tree(&cwd)? {
        return Ok(GitStatusDto::default()); // is_repo = false，其余默认
    }
    let status_out = run_git(
        &cwd,
        &["status", "--porcelain=v1", "-b", "--untracked-files=all"],
    )?;
    if !status_out.status.success() {
        return Err(output_tail(&status_out));
    }
    let (branch, ahead, behind, raw_files) =
        parse_porcelain(&String::from_utf8_lossy(&status_out.stdout));
    // 空仓库（无 HEAD）numstat 会失败，此时 tracked 增量拿不到，按 None 处理
    let numstat = run_git(&cwd, &["diff", "--numstat", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_numstat(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();

    let mut files = Vec::new();
    let (mut total_add, mut total_del) = (0, 0);
    for (status, path) in raw_files {
        let (additions, deletions) = if status == "??" {
            (count_lines(&cwd, &path), Some(0))
        } else {
            match numstat.get(&path) {
                Some((a, d)) => (Some(*a), Some(*d)),
                None => (None, None),
            }
        };
        total_add += additions.unwrap_or(0);
        total_del += deletions.unwrap_or(0);
        files.push(GitFileDto {
            path,
            status,
            additions,
            deletions,
        });
    }
    let merging = run_git(&cwd, &["rev-parse", "--verify", "-q", "MERGE_HEAD"])
        .map(|o| o.status.success())
        .unwrap_or(false);
    Ok(GitStatusDto {
        is_repo: true,
        branch,
        ahead,
        behind,
        files,
        total_add,
        total_del,
        merging,
    })
}

/// 文件树 git 装饰（P4）：变更/未跟踪文件的绝对路径 → 状态字母；非仓库返回空表
fn git_status_map_sync(cwd: &str) -> Result<std::collections::HashMap<String, String>, String> {
    let cwd = expand_tilde(cwd);
    if !probe_is_work_tree(&cwd)? {
        return Ok(std::collections::HashMap::new());
    }
    let out = run_git(&cwd, &["status", "--porcelain=v1"])?;
    if !out.status.success() {
        return Err(output_tail(&out));
    }
    let (_, _, _, files) = parse_porcelain(&String::from_utf8_lossy(&out.stdout));
    let mut map = std::collections::HashMap::new();
    for (status, rel) in files {
        let abs = Path::new(&cwd).join(&rel).to_string_lossy().into_owned();
        map.insert(abs, status);
    }
    Ok(map)
}

fn branch_name(cwd: &str) -> Option<String> {
    let o = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    if !o.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&o.stdout).trim().to_string();
    if b.is_empty() {
        None
    } else {
        Some(b)
    }
}

fn do_push(cwd: &str) -> Result<String, String> {
    let p = run_git(cwd, &["push"])?;
    if p.status.success() {
        return Ok(output_tail(&p));
    }
    let text = output_tail(&p);
    // 没有上游分支时按 git 自己的提示补 -u origin <branch> 重试
    let lower = text.to_lowercase();
    if lower.contains("no upstream") || lower.contains("set-upstream") {
        let branch = branch_name(cwd).unwrap_or_else(|| "HEAD".into());
        let p2 = run_git(cwd, &["push", "-u", "origin", &branch])?;
        let text2 = output_tail(&p2);
        return if p2.status.success() {
            Ok(text2)
        } else {
            Err(text2)
        };
    }
    Err(text)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResultDto {
    pub committed: bool,
    pub pushed: bool,
    pub failed_phase: Option<String>,
    pub message: String,
    pub output: String,
    /// 提交短哈希（rev-parse --short HEAD；取不到为 None）
    pub hash: Option<String>,
}

pub(crate) fn validate_selected_paths(cwd: &str, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("请至少选择一个要提交的文件".into());
    }
    let changed: HashSet<String> = git_status_sync(cwd)?
        .files
        .into_iter()
        .map(|f| f.path)
        .collect();
    let mut seen = HashSet::new();
    let mut validated = Vec::new();
    for path in paths {
        let candidate = Path::new(path);
        if path.trim().is_empty()
            || candidate.is_absolute()
            || candidate.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(format!("提交路径必须是仓库内相对路径: {path:?}"));
        }
        if !changed.contains(path) {
            return Err(format!("文件已不在当前改动清单中，请刷新后重试: {path}"));
        }
        if seen.insert(path.clone()) {
            validated.push(path.clone());
        }
    }
    Ok(validated)
}

fn run_git_owned(cwd: &str, args: &[String]) -> Result<Output, String> {
    let git = crate::agents::resolve_binary("git").ok_or("找不到 git 可执行文件，请先安装 git")?;
    crate::process::background_command(git)
        .arg("-C")
        .arg(cwd)
        .args(["-c", "core.quotepath=false"])
        .args(PLATFORM_GIT_CONFIG)
        .args(args)
        .output()
        .map_err(|e| format!("执行 git 失败: {e}"))
}

fn git_commit_sync(
    cwd: &str,
    message: &str,
    push: bool,
    paths: Option<&[String]>,
) -> Result<GitCommitResultDto, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("提交信息不能为空".into());
    }
    let cwd = expand_tilde(cwd);
    let mut log = String::new();
    let selected = paths
        .map(|paths| validate_selected_paths(&cwd, paths))
        .transpose()?;
    // 勾选文件里含「部分暂存」（暂存区内容 ≠ 工作树内容）时不能用 `commit -- paths`——
    // 它是工作树语义，会把未暂存的块一起带走，破坏逐 hunk 暂存的粒度；改走临时索引提交
    let partial = match &selected {
        Some(sel) => partially_staged_paths(&cwd, sel)?,
        None => Vec::new(),
    };
    let commit = if let Some(selected) = &selected {
        if !partial.is_empty() {
            commit_selected_with_index(&cwd, message, selected, &partial)?
        } else {
            let mut args = vec![
                "--literal-pathspecs".into(),
                "add".into(),
                "-A".into(),
                "--".into(),
            ];
            args.extend(selected.iter().cloned());
            // 已从磁盘删除的文件不能再 add。update-index --remove 记下删除。
            let add = run_git_owned(&cwd, &args)?;
            if !add.status.success() {
                let mut removed = vec![
                    "--literal-pathspecs".into(),
                    "update-index".into(),
                    "--remove".into(),
                    "--".into(),
                ];
                removed.extend(selected.iter().cloned());
                let retry = run_git_owned(&cwd, &removed)?;
                if !retry.status.success() {
                    return Err(output_tail(&add));
                }
            }
            if !add.status.success() {
                return Err(output_tail(&add));
            }
            let mut args = vec![
                "--literal-pathspecs".into(),
                "commit".into(),
                "-m".into(),
                message.into(),
                "--".into(),
            ];
            args.extend(selected.iter().cloned());
            run_git_owned(&cwd, &args)?
        }
    } else {
        let add = run_git(&cwd, &["add", "-A"])?;
        if add.status.success() {
            // 退回意见只留在工作区，不进这次提交。
            let _ = run_git(
                &cwd,
                &[
                    "reset",
                    "-q",
                    "HEAD",
                    "--",
                    ".ccode/review-notes.md",
                ],
            );
        }
        if !add.status.success() {
            return Err(output_tail(&add));
        }
        run_git(&cwd, &["commit", "-m", message])?
    };
    log.push_str(&output_tail(&commit));
    if !commit.status.success() {
        return Err(tail_lines(&log, 20));
    }
    // 提交哈希（状态栏「✓ Pushed [a1b2c3d]」用；取不到不阻塞主流程）
    let hash = run_git(&cwd, &["rev-parse", "--short", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|h| !h.is_empty());
    if push {
        match do_push(&cwd) {
            Ok(t) => {
                if !t.is_empty() {
                    log.push('\n');
                    log.push_str(&t);
                }
            }
            Err(t) => {
                log.push('\n');
                log.push_str(&t);
                let output = tail_lines(&log, 20);
                return Ok(GitCommitResultDto {
                    committed: true,
                    pushed: false,
                    failed_phase: Some("push".into()),
                    message: "提交已完成，但推送失败；可直接重试推送，无需再次提交".into(),
                    output,
                    hash,
                });
            }
        }
    }
    let output = tail_lines(&log, 20);
    Ok(GitCommitResultDto {
        committed: true,
        pushed: push,
        failed_phase: None,
        message: if push {
            "提交并推送成功"
        } else {
            "提交成功"
        }
        .into(),
        output,
        hash,
    })
}

/// 勾选路径中「部分暂存」的子集：已在暂存区有内容、且工作树与暂存区仍有差异。
/// 整块暂存（工作树 == 暂存区）的不算——按工作树内容提交结果一致，走普通路径即可。
fn partially_staged_paths(cwd: &str, paths: &[String]) -> Result<Vec<String>, String> {
    let staged_out = run_git(cwd, &["diff", "--cached", "--name-only"])?;
    if !staged_out.status.success() {
        return Err(output_tail(&staged_out));
    }
    let staged: HashSet<String> = String::from_utf8_lossy(&staged_out.stdout)
        .lines()
        .map(|l| l.to_string())
        .collect();
    let mut partial = Vec::new();
    for p in paths {
        if !staged.contains(p) {
            continue;
        }
        // diff --quiet 退出码 1 = 工作树与暂存区有差异（即只暂存了一部分块）
        let quiet = run_git(cwd, &["diff", "--quiet", "--", p])?;
        if !quiet.status.success() {
            partial.push(p.clone());
        }
    }
    Ok(partial)
}

/// 含部分暂存文件的选择提交：临时索引从 HEAD 出发组装提交内容——
/// 普通勾选文件按工作树状态 add；部分暂存文件复制真实索引里的暂存条目——
/// 然后以临时索引直接 commit（HEAD 前移）。真实索引与工作树全程不动：
/// 已提交的暂存块随之与 HEAD 相抵，未暂存的块保持未暂存；中途失败不留痕迹。
fn commit_selected_with_index(
    cwd: &str,
    message: &str,
    paths: &[String],
    partial: &[String],
) -> Result<Output, String> {
    let git = crate::agents::resolve_binary("git").ok_or("找不到 git 可执行文件，请先安装 git")?;
    let tmp = std::env::temp_dir().join(format!("ccode-index-{}", uuid::Uuid::new_v4()));
    let index_file = tmp.to_string_lossy().into_owned();
    let result = (|| {
        let run = |args: &[&str]| -> Result<Output, String> {
            crate::process::background_command(&git)
                .arg("-C")
                .arg(cwd)
                .env("GIT_INDEX_FILE", &index_file)
                .args(args)
                .output()
                .map_err(|e| format!("执行 git 失败: {e}"))
        };
        // 初始提交（无 HEAD）从空索引开始
        let head = run_git(cwd, &["rev-parse", "--verify", "HEAD"])?;
        let tree = if head.status.success() {
            run(&["read-tree", "HEAD"])?
        } else {
            run(&["read-tree", "--empty"])?
        };
        if !tree.status.success() {
            return Err(output_tail(&tree));
        }
        let partial_set: HashSet<&str> = partial.iter().map(|s| s.as_str()).collect();
        let fresh: Vec<&String> = paths
            .iter()
            .filter(|p| !partial_set.contains(p.as_str()))
            .collect();
        if !fresh.is_empty() {
            let mut args = vec![
                "--literal-pathspecs".into(),
                "add".into(),
                "-A".into(),
                "--".into(),
            ];
            args.extend(fresh.iter().map(|p| (*p).clone()));
            let add = crate::process::background_command(&git)
                .arg("-C")
                .arg(cwd)
                .env("GIT_INDEX_FILE", &index_file)
                .args(&args)
                .output()
                .map_err(|e| format!("执行 git 失败: {e}"))?;
            if !add.status.success() {
                return Err(output_tail(&add));
            }
        }
        for p in partial {
            // 真实索引的暂存条目复制进临时索引；无条目 = 暂存的删除，从临时索引移除
            let entries = crate::process::background_command(&git)
                .arg("-C")
                .arg(cwd)
                .args(["--literal-pathspecs", "ls-files", "-s", "-z", "--", p])
                .output()
                .map_err(|e| format!("执行 git 失败: {e}"))?;
            if !entries.status.success() {
                return Err(output_tail(&entries));
            }
            // ls-files -s -z 记录形如 "mode sha stage\tpath\0"，转成 --index-info 的 "mode sha\tpath\0"
            let mut input = Vec::new();
            for rec in entries.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()) {
                let tab = rec
                    .iter()
                    .position(|b| *b == b'\t')
                    .ok_or("解析暂存条目失败")?;
                let meta = String::from_utf8_lossy(&rec[..tab]).into_owned();
                let mut parts = meta.split(' ');
                let (Some(mode), Some(sha), Some(stage)) =
                    (parts.next(), parts.next(), parts.next())
                else {
                    return Err("解析暂存条目失败".into());
                };
                if stage != "0" {
                    return Err(format!("文件存在未解决的冲突，请先在终端解决: {p}"));
                }
                input.extend_from_slice(format!("{mode} {sha}\t").as_bytes());
                input.extend_from_slice(&rec[tab + 1..]);
                input.push(0);
            }
            if input.is_empty() {
                let rm = run(&[
                    "--literal-pathspecs",
                    "rm",
                    "--cached",
                    "--ignore-unmatch",
                    "-q",
                    "--",
                    p,
                ])?;
                if !rm.status.success() {
                    return Err(output_tail(&rm));
                }
            } else {
                let mut child = crate::process::background_command(&git)
                    .arg("-C")
                    .arg(cwd)
                    .env("GIT_INDEX_FILE", &index_file)
                    .args(["update-index", "-z", "--index-info"])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("执行 git 失败: {e}"))?;
                child
                    .stdin
                    .take()
                    .expect("stdin 已接管")
                    .write_all(&input)
                    .map_err(|e| format!("写入暂存条目失败: {e}"))?;
                let out = child
                    .wait_with_output()
                    .map_err(|e| format!("执行 git 失败: {e}"))?;
                if !out.status.success() {
                    return Err(output_tail(&out));
                }
            }
        }
        let mut commit = run(&["commit", "-m", message])?;
        if commit.status.success() {
            // 真实索引里这些勾选路径仍是旧条目（落后于新 HEAD），status 会出现幻影 MM——
            // 按路径把真实索引同步回 HEAD（不碰工作树、不碰未勾选文件的暂存内容）
            let mut args = vec![
                "--literal-pathspecs".to_string(),
                "reset".into(),
                "-q".into(),
                "HEAD".into(),
                "--".into(),
            ];
            args.extend(paths.iter().cloned());
            let sync = crate::process::background_command(&git)
                .arg("-C")
                .arg(cwd)
                .args(&args)
                .output()
                .map_err(|e| format!("执行 git 失败: {e}"))?;
            if !sync.status.success() {
                // 提交已成功的事实必须保留；同步失败只追加提示
                commit.stderr.extend_from_slice(
                    format!(
                        "\n（提交已成功，但同步暂存区状态失败，请刷新检查）\n{}",
                        output_tail(&sync)
                    )
                    .as_bytes(),
                );
            }
        }
        Ok(commit)
    })();
    std::fs::remove_file(&tmp).ok();
    result
}
pub(crate) fn git_push_sync(cwd: &str) -> Result<String, String> {
    do_push(&expand_tilde(cwd))
}

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<GitStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_sync(&cwd))
        .await
        .map_err(|e| format!("查询 git 状态失败: {e}"))?
}

#[tauri::command]
pub async fn git_status_map(
    cwd: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_map_sync(&cwd))
        .await
        .map_err(|e| format!("查询 git 状态失败: {e}"))?
}

#[tauri::command]
pub async fn git_commit(
    cwd: String,
    message: String,
    push: bool,
    paths: Option<Vec<String>>,
) -> Result<GitCommitResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_commit_sync(&cwd, &message, push, paths.as_deref())
    })
    .await
    .map_err(|e| format!("提交失败: {e}"))?
}

#[tauri::command]
pub async fn git_push(cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_push_sync(&cwd))
        .await
        .map_err(|e| format!("推送失败: {e}"))?
}

#[tauri::command]
pub async fn git_abort_merge(cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = expand_tilde(&cwd);
        crate::workspaces::run_git(
            Path::new(&cwd),
            &["merge", "--abort"],
            Duration::from_secs(30),
        )
        .map_err(|e| format!("取消合并失败: {e}"))
    })
    .await
    .map_err(|e| format!("取消合并失败: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffDto {
    pub text: String,
    pub binary: bool,
    pub truncated: bool,
}

fn truncate_utf8(mut text: String, cap: usize) -> (String, bool) {
    if text.len() <= cap {
        return (text, false);
    }
    let mut end = cap;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n…（diff 过大已截断）");
    (text, true)
}

fn synthetic_untracked_diff(path: &str, bytes: &[u8], source_truncated: bool) -> GitFileDiffDto {
    if bytes.contains(&0) {
        return GitFileDiffDto {
            text: "二进制文件，无法显示文本 diff".into(),
            binary: true,
            truncated: false,
        };
    }
    let content = String::from_utf8_lossy(bytes);
    let mut text = format!("--- /dev/null\n+++ b/{path}\n");
    for line in content.lines() {
        text.push('+');
        text.push_str(line);
        text.push('\n');
        if text.len() > FILE_DIFF_CAP {
            break;
        }
    }
    let (text, capped) = truncate_utf8(text, FILE_DIFF_CAP);
    GitFileDiffDto {
        text,
        binary: false,
        truncated: capped || source_truncated,
    }
}

fn git_file_diff_sync(cwd: &str, path: &str) -> Result<GitFileDiffDto, String> {
    let cwd = expand_tilde(cwd);
    let validated = validate_selected_paths(&cwd, &[path.to_string()])?;
    let path = validated.first().ok_or("文件已不在当前改动清单中")?;
    let status = git_status_sync(&cwd)?
        .files
        .into_iter()
        .find(|file| file.path == *path)
        .ok_or_else(|| format!("文件已不在当前改动清单中，请刷新后重试: {path}"))?;

    if status.status == "??" {
        let full = Path::new(&cwd).join(path);
        let file = std::fs::File::open(&full).map_err(|e| format!("读取 {path} 失败: {e}"))?;
        let mut bytes = Vec::with_capacity(FILE_DIFF_CAP + 1);
        file.take((FILE_DIFF_CAP + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取 {path} 失败: {e}"))?;
        let source_truncated = bytes.len() > FILE_DIFF_CAP;
        if source_truncated {
            bytes.truncate(FILE_DIFF_CAP);
        }
        return Ok(synthetic_untracked_diff(path, &bytes, source_truncated));
    }

    let out = run_git(&cwd, &["diff", "HEAD", "--", path])?;
    let mut text = if out.status.success() {
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else {
        String::new()
    };
    if !out.status.success() || text.trim().is_empty() {
        let staged = run_git(&cwd, &["diff", "--cached", "--", path])?;
        if !staged.status.success() {
            return Err(if out.status.success() {
                output_tail(&staged)
            } else {
                output_tail(&out)
            });
        }
        text = String::from_utf8_lossy(&staged.stdout).into_owned();
    }
    let binary = text
        .lines()
        .any(|line| line.starts_with("Binary files ") || line.starts_with("GIT binary patch"));
    if text.trim().is_empty() {
        return Ok(GitFileDiffDto {
            text: "该文件没有可显示的文本 diff".into(),
            binary,
            truncated: false,
        });
    }
    let (text, truncated) = truncate_utf8(text, FILE_DIFF_CAP);
    Ok(GitFileDiffDto {
        text,
        binary,
        truncated,
    })
}

/// 普通仓库单文件 diff：仅允许读取当前 git status 中的安全相对路径。
#[tauri::command]
pub async fn git_file_diff(cwd: String, path: String) -> Result<GitFileDiffDto, String> {
    tauri::async_runtime::spawn_blocking(move || git_file_diff_sync(&cwd, &path))
        .await
        .map_err(|e| format!("读取 diff 失败: {e}"))?
}

// ===== 逐 hunk 验收 v1（§6.9：未提交改动按块丢弃/暂存） =====
// 口径：只覆盖未提交改动，hunks 一律取「未暂存 diff」（工作树 vs 暂存区）——
// 丢弃 = git apply -R 回工作树、暂存 = git apply --cached 上暂存区，两种操作都干净。
// 已提交的累计 diff（评审覆盖层 merge-base diff）不做逐 hunk，那是 rebase/revert 语义。

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHunkDto {
    pub index: usize,
    /// @@ 行（前端展示用）
    pub header: String,
    /// 含完整文件头（diff --git/---/+++）的单块补丁，可直接喂 git apply
    pub patch: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileHunksDto {
    pub hunks: Vec<GitHunkDto>,
    /// 该文件是否已有暂存内容（部分暂存时前端提示提交粒度）
    pub staged: bool,
}

/// 把单文件 unified diff 按 @@ 切成 hunk；每个 patch 都带完整文件头，可单独 git apply。
/// split_inclusive 保留行尾换行，逐字节回拼不丢内容（含 "\ No newline" 标记行）。
fn split_hunks(diff: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = diff.split_inclusive('\n').collect();
    let Some(first) = lines.iter().position(|l| l.starts_with("@@ ")) else {
        return Vec::new();
    };
    let preamble: String = lines[..first].concat();
    let mut hunks: Vec<(String, String)> = Vec::new();
    for line in &lines[first..] {
        if line.starts_with("@@ ") {
            hunks.push((line.trim_end().to_string(), preamble.clone()));
        }
        if let Some((_, patch)) = hunks.last_mut() {
            patch.push_str(line);
        }
    }
    hunks
}

/// git diff 风格路径引用：含引号/反斜杠/控制字符/非 ASCII 时按 C 风格转义并加引号
fn quote_diff_path(p: &str) -> String {
    let needs = p
        .bytes()
        .any(|b| b < 0x20 || b > 0x7e || b == b'"' || b == b'\\');
    if !needs {
        return p.to_string();
    }
    let mut out = String::from("\"");
    for b in p.bytes() {
        match b {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            0x20..=0x7e => out.push(b as char),
            _ => out.push_str(&format!("\\{b:03o}")),
        }
    }
    out.push('"');
    out
}

/// 解析补丁文件头里的路径（可能 C 风格加引号），去引号/反转义还原
fn unquote_diff_path(s: &str) -> Option<String> {
    let s = s.trim();
    if !s.starts_with('"') {
        return Some(s.to_string());
    }
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 1;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' {
            break;
        }
        if b == b'\\' && i + 1 < bytes.len() {
            let n = bytes[i + 1];
            if n.is_ascii_digit() {
                // \ooo 三位八进制
                let oct = std::str::from_utf8(bytes.get(i + 1..i + 4)?).ok()?;
                out.push(u8::from_str_radix(oct, 8).ok()?);
                i += 4;
                continue;
            }
            out.push(n);
            i += 2;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 校验补丁只针对白名单内的单个文件：只扫描 @@ 之前的文件头（hunk 内容行可能以 --- 开头），
/// ---/+++ 两侧非 /dev/null 的路径必须等于该文件，且只有一个 diff --git 头。
/// 防调用方传入指向其他文件的补丁绕过路径白名单。
fn patch_targets_single_file(patch: &str, path: &str) -> Result<(), String> {
    // diff --git 头数全补丁扫描（多文件补丁的第二个头在 hunk 之后，只扫文件头会漏）
    let diff_git = patch
        .lines()
        .filter(|l| l.starts_with("diff --git "))
        .count();
    if diff_git > 1 {
        return Err("补丁必须只包含一个文件".into());
    }
    // ---/+++ 只扫 @@ 之前的文件头（hunk 内容行可能以 --- 开头，不能误判）
    let head: String = patch
        .split_inclusive('\n')
        .take_while(|l| !l.starts_with("@@ "))
        .collect();
    let header_lines: Vec<&str> = head.lines().collect();
    let mut checked = 0;
    for line in &header_lines {
        let Some(rest) = line
            .strip_prefix("--- ")
            .or_else(|| line.strip_prefix("+++ "))
        else {
            continue;
        };
        let rest = rest.trim();
        if rest == "/dev/null" {
            continue;
        }
        let p = unquote_diff_path(rest).ok_or("无法解析补丁中的路径")?;
        let p = p
            .strip_prefix("a/")
            .or_else(|| p.strip_prefix("b/"))
            .unwrap_or(&p)
            .to_string();
        if p != path {
            return Err(format!("补丁目标 {p} 与文件 {path} 不一致"));
        }
        checked += 1;
    }
    if checked == 0 {
        return Err("补丁缺少 ---/+++ 文件头".into());
    }
    Ok(())
}

/// 未跟踪新文件构造合法的新文件补丁（/dev/null 形式），可直接 git apply / -R / --cached
fn untracked_file_patch(path: &str, content: &str) -> String {
    let a = quote_diff_path(&format!("a/{path}"));
    let b = quote_diff_path(&format!("b/{path}"));
    let mut text = format!("diff --git {a} {b}\nnew file mode 100644\n--- /dev/null\n+++ {b}\n");
    let lines: Vec<&str> = content.lines().collect();
    if !lines.is_empty() {
        text.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
        for (i, line) in lines.iter().enumerate() {
            text.push('+');
            text.push_str(line);
            text.push('\n');
            if i == lines.len() - 1 && !content.ends_with('\n') {
                text.push_str("\\ No newline at end of file\n");
            }
        }
    }
    text
}

fn git_file_hunks_sync(cwd: &str, path: &str) -> Result<GitFileHunksDto, String> {
    let cwd = expand_tilde(cwd);
    let validated = validate_selected_paths(&cwd, &[path.to_string()])?;
    let path = validated.first().ok_or("文件已不在当前改动清单中")?;
    let status = git_status_sync(&cwd)?
        .files
        .into_iter()
        .find(|file| file.path == *path)
        .ok_or_else(|| format!("文件已不在当前改动清单中，请刷新后重试: {path}"))?;
    // 部分暂存提示：暂存区相对 HEAD 有差异（diff --cached --quiet 退出码 1）
    let staged = run_git(&cwd, &["diff", "--cached", "--quiet", "--", path])
        .map(|o| !o.status.success())
        .unwrap_or(false);

    if status.status == "??" {
        let full = Path::new(&cwd).join(path);
        // 整个文件视为一个 hunk。非 UTF-8/含 NUL 一律按二进制拒绝——
        // lossy 转换会让暂存进索引的内容与工作树不一致，必须整块有效
        let bytes = std::fs::read(&full).map_err(|e| format!("读取 {path} 失败: {e}"))?;
        if bytes.len() > FILE_DIFF_CAP {
            return Err("文件过大，不支持按块操作（可整体勾选提交或在终端处理）".into());
        }
        let content = String::from_utf8(bytes)
            .map_err(|_| "二进制或非 UTF-8 文件，不支持按块操作".to_string())?;
        if content.contains('\0') {
            return Err("二进制或非 UTF-8 文件，不支持按块操作".into());
        }
        let patch = untracked_file_patch(path, &content);
        let header = patch
            .lines()
            .find(|l| l.starts_with("@@ "))
            .unwrap_or("新文件（空文件）")
            .to_string();
        return Ok(GitFileHunksDto {
            hunks: vec![GitHunkDto {
                index: 0,
                header,
                patch,
            }],
            staged,
        });
    }

    // 已跟踪文件：未暂存 diff（工作树 vs 暂存区），按 @@ 切 hunk
    let out = run_git(&cwd, &["diff", "--", path])?;
    if !out.status.success() {
        return Err(output_tail(&out));
    }
    if out.stdout.len() > FILE_DIFF_CAP {
        return Err("diff 过大，不支持按块操作（请在审阅视图或终端处理）".into());
    }
    let text = String::from_utf8(out.stdout)
        .map_err(|_| "非 UTF-8 编码文件，不支持按块操作".to_string())?;
    if text
        .lines()
        .any(|line| line.starts_with("Binary files ") || line.starts_with("GIT binary patch"))
    {
        return Err("二进制文件，不支持按块操作".into());
    }
    let hunks = split_hunks(&text)
        .into_iter()
        .enumerate()
        .map(|(index, (header, patch))| GitHunkDto {
            index,
            header,
            patch,
        })
        .collect();
    Ok(GitFileHunksDto { hunks, staged })
}

/// 未提交改动的逐 hunk 拆分：普通仓库/工作区未提交文件均可，白名单同 git_file_diff。
#[tauri::command]
pub async fn git_file_hunks(cwd: String, path: String) -> Result<GitFileHunksDto, String> {
    tauri::async_runtime::spawn_blocking(move || git_file_hunks_sync(&cwd, &path))
        .await
        .map_err(|e| format!("读取改动块失败: {e}"))?
}

fn apply_hunk_sync(cwd: &str, path: &str, patch: &str, mode: &str) -> Result<GitStatusDto, String> {
    let flag = match mode {
        "stage" => "--cached",
        "discard" => "-R",
        _ => return Err(format!("未知的按块操作模式: {mode}")),
    };
    let cwd = expand_tilde(cwd);
    // 路径白名单与 git_file_diff 相同：必须在当前 status 改动清单内的安全相对路径
    let validated = validate_selected_paths(&cwd, &[path.to_string()])?;
    let path = validated.first().ok_or("文件已不在当前改动清单中")?;
    if patch.len() > FILE_DIFF_CAP {
        return Err("补丁过大，已拒绝".into());
    }
    // 补丁本身也要校验：git apply 只认补丁里的路径，必须确保它没指向白名单外的文件
    patch_targets_single_file(patch, path)?;
    let git = crate::agents::resolve_binary("git").ok_or("找不到 git 可执行文件，请先安装 git")?;
    let mut child = crate::process::background_command(git)
        .arg("-C")
        .arg(&cwd)
        .args(["apply", "--whitespace=nowarn", flag])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("执行 git apply 失败: {e}"))?;
    child
        .stdin
        .take()
        .expect("stdin 已接管")
        .write_all(patch.as_bytes())
        .map_err(|e| format!("写入补丁失败: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("执行 git apply 失败: {e}"))?;
    if !out.status.success() {
        // git apply 按文件原子：失败不改动文件，如实透出并引导刷新
        return Err(format!(
            "{}\n（应用失败：文件可能已被其他程序改动或这块改动已处理过，请刷新后重试）",
            output_tail(&out)
        ));
    }
    git_status_sync(&cwd)
}

/// 按块操作：mode = stage（git apply --cached 上暂存区）/ discard（git apply -R 回工作树）。
/// 成功后返回最新 status 供前端立即刷新。
#[tauri::command]
pub async fn apply_hunk(
    cwd: String,
    path: String,
    patch: String,
    mode: String,
) -> Result<GitStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || apply_hunk_sync(&cwd, &path, &patch, &mode))
        .await
        .map_err(|e| format!("应用改动块失败: {e}"))?
}

// ===== 工作区任务 diff（§6.10 阶段 C：基准从 HEAD 改为 merge-base） =====

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiffDto {
    pub in_workspace: bool,
    pub workspace_id: String,
    pub workspace_name: String,
    pub branch: String,
    pub worktree_path: String,
    pub base_branch: String,
    pub merge_base: String,
    pub files: Vec<GitFileDto>,
    pub total_add: u64,
    pub total_del: u64,
    /// 定时/无头 Run 的隔离树没有科研 workspaces 行；仍允许只读进入评审。
    pub review_only: bool,
}

fn review_diff_for_run(wt: &str, run: &crate::runs::RunDto) -> Result<WorkspaceDiffDto, String> {
    let branch = run_git(wt, &["branch", "--show-current"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(detached)".into());
    let mut files = Vec::new();
    let mut total_add = 0;
    let mut total_del = 0;
    if let Ok(out) = run_git(wt, &["diff", "--numstat", "HEAD"]) {
        if out.status.success() {
            for (path, (a, d)) in parse_numstat(&String::from_utf8_lossy(&out.stdout)) {
                total_add += a;
                total_del += d;
                files.push(GitFileDto {
                    path,
                    status: "M".into(),
                    additions: Some(a),
                    deletions: Some(d),
                });
            }
        }
    }
    if let Ok(out) = run_git(wt, &["status", "--porcelain=v1", "--untracked-files=all"]) {
        if out.status.success() {
            let (_, _, _, raw) = parse_porcelain(&String::from_utf8_lossy(&out.stdout));
            for (status, path) in raw {
                if status != "??" {
                    continue;
                }
                let additions = count_lines(wt, &path);
                total_add += additions.unwrap_or(0);
                files.push(GitFileDto {
                    path,
                    status,
                    additions,
                    deletions: Some(0),
                });
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(WorkspaceDiffDto {
        in_workspace: true,
        workspace_id: format!("run:{}", run.id),
        workspace_name: run.task_ref.clone().unwrap_or_else(|| "定时 Run".into()),
        branch,
        worktree_path: run.isolation_path.clone(),
        base_branch: "HEAD".into(),
        merge_base: "HEAD".into(),
        files,
        total_add,
        total_del,
        review_only: true,
    })
}

/// 累计任务改动 = diff merge-base（已提交 + 未提交的已跟踪部分）+ 未跟踪文件行数。
/// rows 参数化以便测试注入；命中不到工作区时返回默认（前端回落普通 git_status）
fn find_worktree_row<'a>(
    wt: &str,
    rows: &'a [crate::workspaces::WorktreeRow],
) -> Option<&'a crate::workspaces::WorktreeRow> {
    // 按路径分量比，不做字符串前缀拼接：DB 里的 worktree_path 在 Windows 上是全反斜杠，
    // 而原先的 `format!("{p}/")` 只认正斜杠 ⇒ 工作树**子目录**（文件树导航进去、
    // 或从子目录开终端）永远匹配不到，改动面板静默退回普通 git_status。
    // Path::starts_with 按分量匹配、正反斜杠混写都认，与 workspaces.rs:2322 口径一致。
    let target = std::path::Path::new(wt);
    rows.iter().find(|r| {
        let p = std::path::Path::new(r.worktree_path.trim_end_matches(['/', '\\']));
        target == p || target.starts_with(p)
    })
}

fn workspace_diff_with_rows(
    worktree_path: &str,
    rows: &[crate::workspaces::WorktreeRow],
) -> Result<WorkspaceDiffDto, String> {
    let wt = expand_tilde(worktree_path);
    let Some(row) = find_worktree_row(&wt, rows) else {
        return Ok(WorkspaceDiffDto::default());
    };
    // 与 §6.10 生命周期一致：基准固定为本地分支（worktree 即从本地基准拉出，
    // 用 origin 会把基准上未推送的提交误算进任务改动）
    let base_ref = row.base_branch.clone();
    let mb = run_git(&wt, &["merge-base", &base_ref, "HEAD"])?;
    if !mb.status.success() {
        return Err(output_tail(&mb));
    }
    let merge_base = String::from_utf8_lossy(&mb.stdout).trim().to_string();
    // 三次 git 互不依赖，并行跑（Windows 上每起一个 git 要 100–150ms，打开评审要等它）
    let (numstat, ns, porc) = std::thread::scope(|s| {
        let numstat = s.spawn(|| run_git(&wt, &["diff", "--numstat", &merge_base]));
        let ns = s.spawn(|| run_git(&wt, &["diff", "--name-status", &merge_base]));
        let porc =
            s.spawn(|| run_git(&wt, &["status", "--porcelain=v1", "--untracked-files=all"]));
        (numstat.join(), ns.join(), porc.join())
    });
    let numstat = numstat
        .ok()
        .and_then(|r| r.ok())
        .filter(|o| o.status.success())
        .map(|o| parse_numstat(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    // name-status 给每个文件的改动类型（R 取新名）
    let mut status_map: HashMap<String, String> = HashMap::new();
    if let Some(Ok(ns)) = ns.ok() {
        if ns.status.success() {
            for line in String::from_utf8_lossy(&ns.stdout).lines() {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() >= 2 {
                    let letter = parts[0].chars().next().unwrap_or('M').to_string();
                    let path = parts.last().map_or("", |v| v).to_string();
                    status_map.insert(path, letter);
                }
            }
        }
    }
    let mut files = Vec::new();
    let (mut total_add, mut total_del) = (0u64, 0u64);
    for (path, (a, d)) in &numstat {
        total_add += a;
        total_del += d;
        files.push(GitFileDto {
            path: path.clone(),
            status: status_map.get(path).cloned().unwrap_or_else(|| "M".into()),
            additions: Some(*a),
            deletions: Some(*d),
        });
    }
    // 未跟踪文件：numstat 覆盖不到，行数当 additions（与 git_status 同一口径）
    if let Some(Ok(porc)) = porc.ok() {
        if porc.status.success() {
            let (_, _, _, raw) = parse_porcelain(&String::from_utf8_lossy(&porc.stdout));
            for (status, path) in raw {
                if status != "??" {
                    continue;
                }
                let additions = count_lines(&wt, &path);
                total_add += additions.unwrap_or(0);
                files.push(GitFileDto {
                    path,
                    status: "??".into(),
                    additions,
                    deletions: Some(0),
                });
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(WorkspaceDiffDto {
        in_workspace: true,
        workspace_id: row.id.clone(),
        workspace_name: row.name.clone(),
        branch: row.branch.clone(),
        worktree_path: row.worktree_path.clone(),
        base_branch: row.base_branch.clone(),
        merge_base,
        files,
        total_add,
        total_del,
        review_only: false,
    })
}

#[tauri::command]
pub async fn workspace_diff(worktree_path: String) -> Result<WorkspaceDiffDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rows = crate::workspaces::worktree_rows();
        let diff = workspace_diff_with_rows(&worktree_path, &rows)?;
        if diff.in_workspace {
            return Ok(diff);
        }
        let wt = expand_tilde(&worktree_path);
        let runs = crate::runs::run_list(None)?;
        let run = runs
            .into_iter()
            .find(|run| crate::paths::same_path(&run.isolation_path, &wt));
        run.map(|run| review_diff_for_run(&wt, &run))
            .unwrap_or(Ok(diff))
    })
    .await
    .map_err(|e| format!("计算工作区 diff 失败: {e}"))?
}

/// 单文件任务 diff 的实现（worktree 路径 + 基准分支直给，便于测试）：
/// 未跟踪新文件 git diff 为空 → 读全文按全新增返回（400 行截断）；大 diff 200KB 截断
fn file_diff_impl(wt: &str, base_branch: &str, path: &str) -> Result<String, String> {
    let mb = run_git(wt, &["merge-base", base_branch, "HEAD"])?;
    if !mb.status.success() {
        return Err(output_tail(&mb));
    }
    let mb = String::from_utf8_lossy(&mb.stdout).trim().to_string();
    let out = run_git(wt, &["diff", &mb, "--", path])?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.trim().is_empty() {
        let full = std::path::Path::new(wt).join(path);
        let file = std::fs::File::open(&full).map_err(|e| format!("读取 {path} 失败: {e}"))?;
        let mut bytes = Vec::with_capacity(FILE_DIFF_CAP + 1);
        file.take((FILE_DIFF_CAP + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取 {path} 失败: {e}"))?;
        let source_truncated = bytes.len() > FILE_DIFF_CAP;
        if source_truncated {
            bytes.truncate(FILE_DIFF_CAP);
        }
        if bytes.contains(&0) {
            return Ok("二进制文件，无法显示文本 diff".into());
        }
        let content = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = content.lines().collect();
        text = lines
            .iter()
            .take(400)
            .map(|l| format!("+{l}"))
            .collect::<Vec<_>>()
            .join("\n");
        if source_truncated {
            text.push_str("\n…（文件过大，已截断）");
        } else if lines.len() > 400 {
            text.push_str(&format!("\n…（共 {} 行，已截断）", lines.len()));
        }
    }
    Ok(truncate_utf8(text, FILE_DIFF_CAP).0)
}

/// 单文件任务 diff 内容（工作区「评审」面板展开用）
#[tauri::command]
pub async fn workspace_file_diff(worktree_path: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let wt = expand_tilde(&worktree_path);
        let rows = crate::workspaces::worktree_rows();
        let current = workspace_diff_with_rows(&wt, &rows)?;
        let row = find_worktree_row(&wt, &rows);
        if row.is_none() {
            let run = crate::runs::run_list(None)?
                .into_iter()
                .find(|run| crate::paths::same_path(&run.isolation_path, &wt))
                .ok_or("该目录不在任何工作区或 Run 隔离树内")?;
            let review = review_diff_for_run(&wt, &run)?;
            if !review.files.iter().any(|file| file.path == path) {
                return Err(format!(
                    "文件已不在当前任务改动清单中，请刷新后重试: {path}"
                ));
            }
            return file_diff_impl(&wt, "HEAD", &path);
        }
        let row = row.unwrap();
        if !current.files.iter().any(|file| file.path == path) {
            return Err(format!(
                "文件已不在当前任务改动清单中，请刷新后重试: {path}"
            ));
        }
        file_diff_impl(&wt, &row.base_branch, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 图片双栏评审（P3 图片评审）：基准版 vs 当前版字节对 =====

/// 单文件上限：图片必须完整传输，超限直接拒绝（同 pdf.rs 的「截断无意义」口径）
const IMAGE_PAIR_CAP: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitImagePairDto {
    /// base64 编码的基准版字节；基准中不存在（新增图片）→ None
    pub base: Option<String>,
    /// base64 编码的当前版字节；文件已删除 → None
    pub current: Option<String>,
    pub base_label: String,
    pub current_label: String,
}

/// 图片扩展名判定（与前端 ImagePairView 的 isImagePath 保持同一清单）
fn is_image_path(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase());
    matches!(
        ext.as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp")
    )
}

/// 取 `git show <spec>` 的原始字节；对象不存在 → None（新增图片的基准侧）
fn git_show_image(cwd: &str, spec: &str) -> Result<Option<Vec<u8>>, String> {
    // 先查对象大小，避免超大图片整个读进内存才发现超限
    let size = run_git(cwd, &["cat-file", "-s", spec])?;
    if !size.status.success() {
        return Ok(None);
    }
    let size: u64 = String::from_utf8_lossy(&size.stdout)
        .trim()
        .parse()
        .map_err(|_| format!("无法解析 {spec} 的对象大小"))?;
    if size > IMAGE_PAIR_CAP {
        return Err(format!(
            "图片超过 20 MB（{:.1} MB），暂不支持双栏查看",
            size as f64 / 1024.0 / 1024.0
        ));
    }
    let out = run_git(cwd, &["show", spec])?;
    if !out.status.success() {
        return Err(output_tail(&out));
    }
    Ok(Some(out.stdout))
}

/// 读工作树当前文件字节；文件不存在 → None（删除图片的当前侧）
fn read_current_image(root: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let full = Path::new(root).join(path);
    if !full.is_file() {
        return Ok(None);
    }
    let size = std::fs::metadata(&full)
        .map_err(|e| format!("读取 {path} 失败: {e}"))?
        .len();
    if size > IMAGE_PAIR_CAP {
        return Err(format!(
            "图片超过 20 MB（{:.1} MB），暂不支持双栏查看",
            size as f64 / 1024.0 / 1024.0
        ));
    }
    std::fs::read(&full)
        .map(Some)
        .map_err(|e| format!("读取 {path} 失败: {e}"))
}

fn encode_base64(bytes: Vec<u8>) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn image_pair_sync(cwd: &str, path: &str) -> Result<GitImagePairDto, String> {
    let cwd = expand_tilde(cwd);
    if !is_image_path(path) {
        return Err(format!("不是可双栏查看的图片文件: {path}"));
    }
    let rows = crate::workspaces::worktree_rows();
    // 白名单沿用 diff 安全规则：工作区 = 任务 diff 清单内；普通仓库 = status 中的安全相对路径
    let (root, base_spec, base_label) = if let Some(row) = find_worktree_row(&cwd, &rows) {
        let diff = workspace_diff_with_rows(&cwd, &rows)?;
        if !diff.files.iter().any(|file| file.path == path) {
            return Err(format!(
                "文件已不在当前任务改动清单中，请刷新后重试: {path}"
            ));
        }
        (
            row.worktree_path.clone(),
            format!("{}:{path}", diff.merge_base),
            format!("基准 {}", row.base_branch),
        )
    } else {
        let validated = validate_selected_paths(&cwd, &[path.to_string()])?;
        let path = validated.first().ok_or("文件已不在当前改动清单中")?;
        (cwd.clone(), format!("HEAD:{path}"), "HEAD".to_string())
    };
    let base = git_show_image(&cwd, &base_spec)?;
    let current = read_current_image(&root, path)?;
    Ok(GitImagePairDto {
        base: base.map(encode_base64),
        current: current.map(encode_base64),
        base_label,
        current_label: "当前".into(),
    })
}

/// 图片文件双栏评审：基准版（普通仓库 = HEAD，工作区 = merge-base）vs 当前版。
/// base64 传输（macOS Raw 响应退化为逐字节 JSON，理由同 pdf.rs）。
#[tauri::command]
pub async fn git_image_pair(cwd: String, path: String) -> Result<GitImagePairDto, String> {
    tauri::async_runtime::spawn_blocking(move || image_pair_sync(&cwd, &path))
        .await
        .map_err(|e| format!("读取图片失败: {e}"))?
}

// ===== 历史时间线（保存历史视图）：当前分支 --first-parent 提交主线 =====
// 取舍：只看 first-parent 主线——工作区分支上的过程提交不进主时间线，
// 它们通过 merge commit 的「验收合并」条目体现，保持时间线简洁可读。

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryDto {
    /// 短 hash（技术层信息，前端小字 mono 展示）
    pub hash: String,
    /// 提交时间（ISO 8601，%cI）
    pub time: String,
    pub author: String,
    /// 提交信息首行
    pub message: String,
    /// numstat 汇总：改动文件数与总增删行（merge commit 无 diff，恒为 0）
    pub files: u64,
    pub additions: u64,
    pub deletions: u64,
    /// 是否 merge commit（父提交 ≥ 2）
    pub merge: bool,
    /// 并入的分支名（从 "Merge branch 'X'" 类信息解析；解析不到为空串）
    pub merged_branch: String,
}

/// 从 merge commit 信息首行解析并入的分支名：
/// "Merge branch 'X'" / "Merge branch 'X' into Y" / "Merge remote-tracking branch 'X'"
fn parse_merged_branch(subject: &str) -> String {
    for prefix in ["Merge branch '", "Merge remote-tracking branch '"] {
        if let Some(rest) = subject.strip_prefix(prefix) {
            if let Some(end) = rest.find('\'') {
                return rest[..end].to_string();
            }
        }
    }
    String::new()
}

/// 解析 `git log --format=%x1e... --numstat` 输出：\x1e 分隔提交，\x1f 分隔字段，
/// 头行之后是 numstat 行（二进制 "-\t-" 计文件数但不计增删）
fn parse_history_log(text: &str) -> Vec<HistoryEntryDto> {
    let mut entries = Vec::new();
    for record in text.split('\x1e') {
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        let mut lines = record.lines();
        let Some(header) = lines.next() else { continue };
        let fields: Vec<&str> = header.split('\x1f').collect();
        if fields.len() < 5 {
            continue; // 防御式：格式漂移时跳过该行提交
        }
        let parents: Vec<&str> = fields[4].split_whitespace().collect();
        let merge = parents.len() >= 2;
        let (mut files, mut additions, mut deletions) = (0u64, 0u64, 0u64);
        for line in lines {
            let mut parts = line.splitn(3, '\t');
            let (Some(a), Some(d), Some(p)) = (parts.next(), parts.next(), parts.next()) else {
                continue;
            };
            if p.trim().is_empty() {
                continue;
            }
            files += 1;
            if let (Ok(a), Ok(d)) = (a.parse::<u64>(), d.parse::<u64>()) {
                additions += a;
                deletions += d;
            }
        }
        let message = fields[3].to_string();
        let merged_branch = if merge {
            parse_merged_branch(&message)
        } else {
            String::new()
        };
        entries.push(HistoryEntryDto {
            hash: fields[0].to_string(),
            time: fields[1].to_string(),
            author: fields[2].to_string(),
            message,
            files,
            additions,
            deletions,
            merge,
            merged_branch,
        });
    }
    entries
}

fn project_history_sync(repo_path: &str, limit: u32) -> Result<Vec<HistoryEntryDto>, String> {
    let cwd = expand_tilde(repo_path);
    let check = run_git(&cwd, &["rev-parse", "--is-inside-work-tree"])?;
    if !check.status.success() {
        return Err("该目录不是 git 仓库，暂无保存历史".into());
    }
    // 空仓库（无 HEAD）：log 会失败，先判 HEAD 再决定空表还是报错
    let head = run_git(&cwd, &["rev-parse", "--verify", "-q", "HEAD"])?;
    if !head.status.success() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 500);
    let out = run_git(
        &cwd,
        &[
            "log",
            "--first-parent",
            "-n",
            &limit.to_string(),
            "--format=%x1e%h%x1f%cI%x1f%an%x1f%s%x1f%P",
            "--numstat",
        ],
    )?;
    if !out.status.success() {
        return Err(output_tail(&out));
    }
    Ok(parse_history_log(&String::from_utf8_lossy(&out.stdout)))
}

/// 项目保存历史：当前分支 first-parent 主线提交（白话时间线的数据层）。
#[tauri::command]
pub async fn project_history(
    repo_path: String,
    limit: Option<u32>,
) -> Result<Vec<HistoryEntryDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_history_sync(&repo_path, limit.unwrap_or(100))
    })
    .await
    .map_err(|e| format!("读取保存历史失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 测试也统一走 resolve_binary（与生产代码同一解析路径）
    fn git_bin() -> PathBuf {
        crate::agents::resolve_binary("git").expect("测试环境找不到 git 可执行文件")
    }

    fn git_available() -> bool {
        crate::agents::resolve_binary("git")
            .map(|git| {
                crate::process::background_command(git)
                    .arg("--version")
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-git-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = crate::process::background_command(git_bin())
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} 失败: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(name: &str) -> PathBuf {
        let dir = tmpdir(name);
        git(&dir, &["init", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@t.dev"]);
        git(&dir, &["config", "user.name", "t"]);
        dir
    }

    #[test]
    fn status_parses_modified_and_untracked() {
        if !git_available() {
            return;
        }
        let dir = init_repo("status");
        fs::write(dir.join("a.txt"), "l1\n").unwrap();
        git(&dir, &["add", "."]);
        git(
            &dir,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        fs::write(dir.join("a.txt"), "l1\nl2\n").unwrap();
        fs::write(dir.join("b.txt"), "x\ny\nz\n").unwrap();

        let s = git_status_sync(dir.to_str().unwrap()).unwrap();
        assert!(s.is_repo);
        assert_eq!(s.branch, "main");
        let a = s.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.status, "M");
        assert_eq!(a.additions, Some(1));
        assert_eq!(a.deletions, Some(0));
        let b = s.files.iter().find(|f| f.path == "b.txt").unwrap();
        assert_eq!(b.status, "??");
        assert_eq!(b.additions, Some(3));
        assert_eq!(b.deletions, Some(0));
        assert_eq!(s.total_add, 4);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn status_untracked_binary_not_counted() {
        if !git_available() {
            return;
        }
        let dir = init_repo("status-binary");
        git(
            &dir,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        // 含 NUL 的伪 PDF 二进制：换行字节极多，但不得计入增删统计
        let mut blob = b"%PDF-1.7 fake".to_vec();
        blob.extend_from_slice(&[0u8; 16]);
        blob.extend(std::iter::repeat(b'\n').take(5000));
        fs::write(dir.join("paper.pdf"), &blob).unwrap();
        fs::write(dir.join("notes.md"), "a\nb\n").unwrap();

        let s = git_status_sync(dir.to_str().unwrap()).unwrap();
        let pdf = s.files.iter().find(|f| f.path == "paper.pdf").unwrap();
        assert_eq!(pdf.additions, None, "二进制未跟踪文件不应计行数");
        let md = s.files.iter().find(|f| f.path == "notes.md").unwrap();
        assert_eq!(md.additions, Some(2));
        assert_eq!(s.total_add, 2, "总数不得被二进制换行字节污染");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn status_untracked_ascii_header_pdf_not_counted() {
        if !git_available() {
            return;
        }
        let dir = init_repo("status-ascii-pdf");
        git(
            &dir,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        // 纯 ASCII 开头、无 NUL 的 PDF（真实世界存在）：靠扩展名拦截，内容探测会漏
        let mut blob = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n".to_vec();
        for _ in 0..1000 {
            blob.extend_from_slice(b"ascii stream line\n");
        }
        fs::write(dir.join("clean.pdf"), &blob).unwrap();

        let s = git_status_sync(dir.to_str().unwrap()).unwrap();
        let pdf = s.files.iter().find(|f| f.path == "clean.pdf").unwrap();
        assert_eq!(pdf.additions, None, "ASCII 开头的 PDF 也不应计行数");
        assert_eq!(s.total_add, 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_flow_leaves_clean_status() {
        if !git_available() {
            return;
        }
        let dir = init_repo("commit");
        fs::write(dir.join("a.txt"), "hello\n").unwrap();
        let result = git_commit_sync(dir.to_str().unwrap(), "初始提交", false, None).unwrap();
        assert!(result.committed);
        assert!(!result.pushed);
        assert!(result.failed_phase.is_none());
        let s = git_status_sync(dir.to_str().unwrap()).unwrap();
        assert!(s.is_repo);
        assert!(s.files.is_empty(), "提交后工作区应干净: {:?}", s.files);
        assert!(git_commit_sync(dir.to_str().unwrap(), "   ", false, None).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_success_push_failure_is_partial_success() {
        if !git_available() {
            return;
        }
        let dir = init_repo("commit-push-partial");
        fs::write(dir.join("a.txt"), "hello\n").unwrap();
        let result = git_commit_sync(dir.to_str().unwrap(), "提交但无远端", true, None).unwrap();
        assert!(result.committed);
        assert!(!result.pushed);
        assert_eq!(result.failed_phase.as_deref(), Some("push"));
        assert!(result.message.contains("无需再次提交"));
        assert!(git_status_sync(dir.to_str().unwrap())
            .unwrap()
            .files
            .is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn selective_commit_leaves_unselected_changes_untouched() {
        if !git_available() {
            return;
        }
        let dir = init_repo("selective-commit");
        fs::write(dir.join("a.txt"), "base-a\n").unwrap();
        fs::write(dir.join("b.txt"), "base-b\n").unwrap();
        git(&dir, &["add", "."]);
        git(
            &dir,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        fs::write(dir.join("a.txt"), "changed-a\n").unwrap();
        fs::write(dir.join("b.txt"), "changed-b\n").unwrap();

        let selected = vec!["a.txt".to_string()];
        let result =
            git_commit_sync(dir.to_str().unwrap(), "只提交 a", false, Some(&selected)).unwrap();
        assert!(result.committed);
        let status = git_status_sync(dir.to_str().unwrap()).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "b.txt");
        let head_a = run_git(dir.to_str().unwrap(), &["show", "HEAD:a.txt"]).unwrap();
        let head_b = run_git(dir.to_str().unwrap(), &["show", "HEAD:b.txt"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&head_a.stdout), "changed-a\n");
        assert_eq!(String::from_utf8_lossy(&head_b.stdout), "base-b\n");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn selective_commit_rejects_path_escape_and_stale_file() {
        if !git_available() {
            return;
        }
        let dir = init_repo("selective-invalid");
        fs::write(dir.join("a.txt"), "a\n").unwrap();
        let escape = vec!["../outside".to_string()];
        assert!(
            git_commit_sync(dir.to_str().unwrap(), "bad", false, Some(&escape))
                .unwrap_err()
                .contains("相对路径")
        );
        let stale = vec!["missing.txt".to_string()];
        assert!(
            git_commit_sync(dir.to_str().unwrap(), "bad", false, Some(&stale))
                .unwrap_err()
                .contains("不在当前改动清单")
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn not_a_repo_returns_default() {
        let dir = tmpdir("norepo");
        let s = git_status_sync(dir.to_str().unwrap()).unwrap();
        assert!(!s.is_repo);
        assert!(s.files.is_empty());
        assert_eq!(s.total_add, 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_dir_returns_distinct_error() {
        // 工作区归档/删除后标签页仍指旧路径：必须报「目录不存在」而非误判为「不是 git 仓库」
        let dir = tmpdir("gone");
        fs::remove_dir_all(&dir).ok();
        let err = git_status_sync(dir.to_str().unwrap()).unwrap_err();
        assert!(err.contains("目录不存在"), "err = {err}");
    }

    #[test]
    fn status_map_marks_changed_and_untracked() {
        if !git_available() {
            return;
        }
        let dir = init_repo("status-map");
        fs::write(dir.join("a.txt"), "l1\n").unwrap();
        git(&dir, &["add", "."]);
        git(
            &dir,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        fs::write(dir.join("a.txt"), "l1\nl2\n").unwrap();
        fs::write(dir.join("b.txt"), "new\n").unwrap();
        let map = git_status_map_sync(dir.to_str().unwrap()).unwrap();
        assert_eq!(
            map.get(dir.join("a.txt").to_str().unwrap()),
            Some(&"M".to_string())
        );
        assert_eq!(
            map.get(dir.join("b.txt").to_str().unwrap()),
            Some(&"??".to_string())
        );
        assert!(!map.contains_key(dir.join("c.txt").to_str().unwrap()));
        // 非仓库 → 空表
        let plain = tmpdir("status-map-plain");
        assert!(git_status_map_sync(plain.to_str().unwrap())
            .unwrap()
            .is_empty());
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&plain).ok();
    }

    #[test]
    fn porcelain_header_parses_branch_ahead_behind() {
        let (branch, ahead, behind, files) =
            parse_porcelain("## main...origin/main [ahead 2, behind 3]\n M a.rs\n?? new.txt\n");
        assert_eq!((branch.as_str(), ahead, behind), ("main", 2, 3));
        assert_eq!(files.len(), 2);
        assert_eq!(files[1], ("??".to_string(), "new.txt".to_string()));

        let (b2, a2, b22, _) = parse_porcelain("## No commits yet on dev\n");
        assert_eq!((b2.as_str(), a2, b22), ("dev", 0, 0));

        let (_, _, _, files3) = parse_porcelain("R  old.rs -> new.rs\n");
        assert_eq!(files3[0], ("R".to_string(), "new.rs".to_string()));

        // 非 ASCII 文件名：git 默认 core.quotepath 把字节转八进制并整体加引号，必须反转义还原
        // 「文献分类索引.md」的 porcelain 输出形态
        let (_, _, _, files4) =
            parse_porcelain("?? \"\\346\\226\\207\\347\\214\\256\\345\\210\\206\\347\\261\\273\\347\\264\\242\\345\\274\\225.md\"\n");
        assert_eq!(files4[0], ("??".to_string(), "文献分类索引.md".to_string()));
        // 重命名 + 非 ASCII：两侧各自加引号
        let (_, _, _, files5) =
            parse_porcelain("R  old.rs -> \"\\346\\226\\207\\346\\221\\230.md\"\n");
        assert_eq!(files5[0], ("R".to_string(), "文摘.md".to_string()));

        let (_, _, _, files6) = parse_porcelain("UU conflict.rs\nAA both.rs\nDU deleted.rs\n");
        assert_eq!(files6[0], ("U".to_string(), "conflict.rs".to_string()));
        assert_eq!(files6[1], ("U".to_string(), "both.rs".to_string()));
        assert_eq!(files6[2], ("U".to_string(), "deleted.rs".to_string()));
    }

    #[test]
    fn workspace_diff_accumulates_committed_uncommitted_untracked() {
        if !git_available() {
            return;
        }
        let dir = tmpdir("wsdiff");
        let repo = dir.join("repo");
        git(&dir, &["init", "-b", "main", "repo"]);
        git(&repo, &["config", "user.email", "t@t.dev"]);
        git(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("a.txt"), "l1\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "init"]);
        let origin = dir.join("origin.git");
        git(&dir, &["init", "--bare", "origin.git"]);
        git(
            &repo,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        git(&repo, &["push", "-u", "origin", "main"]);
        let wt = dir.join("wt");
        git(
            &repo,
            &[
                "worktree",
                "add",
                wt.to_str().unwrap(),
                "-b",
                "ccode/t1",
                "origin/main",
            ],
        );
        // 累计改动：已提交 +2 行、未提交 +1 行、未跟踪 3 行
        fs::write(wt.join("a.txt"), "l1\nl2\nl3\n").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-m", "task"]);
        fs::write(wt.join("a.txt"), "l1\nl2\nl3\nl4\n").unwrap();
        fs::write(wt.join("new.txt"), "x\ny\nz\n").unwrap();
        let rows = vec![crate::workspaces::WorktreeRow {
            id: "ws-1".into(),
            worktree_path: wt.to_string_lossy().into_owned(),
            repo_path: repo.to_string_lossy().into_owned(),
            name: "t1".into(),
            branch: "ccode/t1".into(),
            base_branch: "main".into(),
        }];
        let d = workspace_diff_with_rows(wt.to_str().unwrap(), &rows).unwrap();
        assert!(d.in_workspace);
        assert_eq!(d.workspace_id, "ws-1");
        assert_eq!(d.workspace_name, "t1");
        assert_eq!(d.branch, "ccode/t1");
        assert_eq!(d.base_branch, "main");
        assert!(!d.merge_base.is_empty());
        let a = d.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(
            a.additions,
            Some(3),
            "merge-base 起累计：已提交 2 行 + 未提交 1 行"
        );
        assert_eq!(a.status, "M");
        let n = d.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(n.status, "??");
        assert_eq!(n.additions, Some(3));
        assert_eq!(d.total_add, 6);
        // 非工作区路径：in_workspace=false，前端回落普通 git_status
        let outside = workspace_diff_with_rows(repo.to_str().unwrap(), &rows).unwrap();
        assert!(!outside.in_workspace);
        git(
            &repo,
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_diff_shows_tracked_changes_and_untracked_as_all_added() {
        if !git_available() {
            return;
        }
        let dir = tmpdir("wsfdiff");
        let repo = dir.join("repo");
        git(&dir, &["init", "-b", "main", "repo"]);
        git(&repo, &["config", "user.email", "t@t.dev"]);
        git(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("a.txt"), "l1\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "init"]);
        let wt = dir.join("wt");
        git(
            &repo,
            &[
                "worktree",
                "add",
                wt.to_str().unwrap(),
                "-b",
                "ccode/t1",
                "main",
            ],
        );
        // 已跟踪文件：改一行 → diff 含 +/-；未跟踪文件 → 全文按新增
        fs::write(wt.join("a.txt"), "l1\nl2\n").unwrap();
        fs::write(wt.join("new.txt"), "x\ny\n").unwrap();
        let tracked = file_diff_impl(wt.to_str().unwrap(), "main", "a.txt").unwrap();
        assert!(
            tracked.contains("-l1") || tracked.contains(" l1"),
            "{tracked}"
        );
        assert!(tracked.contains("+l2"), "{tracked}");
        let untracked = file_diff_impl(wt.to_str().unwrap(), "main", "new.txt").unwrap();
        assert_eq!(untracked, "+x\n+y");
        git(
            &repo,
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn generic_file_diff_is_safe_and_handles_binary_untracked_files() {
        if !git_available() {
            return;
        }
        let repo = init_repo("generic-file-diff");
        fs::write(repo.join("a.txt"), "before\n").unwrap();
        git(&repo, &["add", "."]);
        git(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        fs::write(repo.join("a.txt"), "after\n").unwrap();
        fs::write(repo.join("image.bin"), [0, 1, 2, 3]).unwrap();

        let tracked = git_file_diff_sync(repo.to_str().unwrap(), "a.txt").unwrap();
        assert!(tracked.text.contains("-before"));
        assert!(tracked.text.contains("+after"));
        let binary = git_file_diff_sync(repo.to_str().unwrap(), "image.bin").unwrap();
        assert!(binary.binary);
        assert!(git_file_diff_sync(repo.to_str().unwrap(), "../outside").is_err());
        fs::remove_dir_all(&repo).ok();
    }

    fn decode(dto_data: &Option<String>) -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(dto_data.as_ref().expect("应有 base64 数据"))
            .unwrap()
    }

    #[test]
    fn image_pair_normal_repo_base_and_current() {
        if !git_available() {
            return;
        }
        let repo = init_repo("img-pair");
        fs::write(repo.join("pic.png"), b"\x89PNG-v1").unwrap();
        git(&repo, &["add", "."]);
        git(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        fs::write(repo.join("pic.png"), b"\x89PNG-v2").unwrap();

        let dto = image_pair_sync(repo.to_str().unwrap(), "pic.png").unwrap();
        assert_eq!(dto.base_label, "HEAD");
        assert_eq!(dto.current_label, "当前");
        assert_eq!(decode(&dto.base), b"\x89PNG-v1");
        assert_eq!(decode(&dto.current), b"\x89PNG-v2");
        // 白名单：不在 status 中的路径与逃逸路径都拒绝
        assert!(image_pair_sync(repo.to_str().unwrap(), "missing.png").is_err());
        assert!(image_pair_sync(repo.to_str().unwrap(), "../outside.png").is_err());
        // 非图片扩展名拒绝
        let err = image_pair_sync(repo.to_str().unwrap(), "notes.txt").unwrap_err();
        assert!(err.contains("不是可双栏查看的图片文件"), "{err}");
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn image_pair_added_and_deleted_have_single_empty_side() {
        if !git_available() {
            return;
        }
        let repo = init_repo("img-sides");
        fs::write(repo.join("old.png"), b"\x89PNG-old").unwrap();
        git(&repo, &["add", "."]);
        git(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        // 新增（未跟踪）：base 为空
        fs::write(repo.join("new.png"), b"\x89PNG-new").unwrap();
        let added = image_pair_sync(repo.to_str().unwrap(), "new.png").unwrap();
        assert!(added.base.is_none());
        assert_eq!(decode(&added.current), b"\x89PNG-new");
        // 删除：current 为空
        fs::remove_file(repo.join("old.png")).unwrap();
        let deleted = image_pair_sync(repo.to_str().unwrap(), "old.png").unwrap();
        assert_eq!(decode(&deleted.base), b"\x89PNG-old");
        assert!(deleted.current.is_none());
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn image_pair_rejects_oversize() {
        if !git_available() {
            return;
        }
        let repo = init_repo("img-cap");
        let f = repo.join("huge.png");
        // 稀疏文件置长度，避免真的写 20MB
        let file = fs::File::create(&f).unwrap();
        file.set_len(IMAGE_PAIR_CAP + 1).unwrap();
        drop(file);
        let err = image_pair_sync(repo.to_str().unwrap(), "huge.png").unwrap_err();
        assert!(err.contains("20 MB"), "{err}");
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn image_pair_workspace_base_is_merge_base() {
        if !git_available() {
            return;
        }
        let dir = tmpdir("img-ws");
        let repo = dir.join("repo");
        git(&dir, &["init", "-b", "main", "repo"]);
        git(&repo, &["config", "user.email", "t@t.dev"]);
        git(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("pic.png"), b"\x89PNG-v1").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "init"]);
        let wt = dir.join("wt");
        git(
            &repo,
            &[
                "worktree",
                "add",
                wt.to_str().unwrap(),
                "-b",
                "ccode/t1",
                "main",
            ],
        );
        // 任务分支上改图并提交：基准应取 merge-base（即 main 的 v1）
        fs::write(wt.join("pic.png"), b"\x89PNG-v2").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-m", "task"]);
        let rows = vec![crate::workspaces::WorktreeRow {
            id: "ws-1".into(),
            worktree_path: wt.to_string_lossy().into_owned(),
            repo_path: repo.to_string_lossy().into_owned(),
            name: "t1".into(),
            branch: "ccode/t1".into(),
            base_branch: "main".into(),
        }];
        // image_pair_sync 走全局 worktree_rows()，测试里直接验证内部判定逻辑：
        // 白名单用任务 diff 清单、基准用 merge-base
        let diff = workspace_diff_with_rows(wt.to_str().unwrap(), &rows).unwrap();
        assert!(diff.files.iter().any(|f| f.path == "pic.png"));
        let base = git_show_image(
            wt.to_str().unwrap(),
            &format!("{}:pic.png", diff.merge_base),
        )
        .unwrap()
        .unwrap();
        assert_eq!(base, b"\x89PNG-v1");
        let current = read_current_image(&wt.to_string_lossy(), "pic.png")
            .unwrap()
            .unwrap();
        assert_eq!(current, b"\x89PNG-v2");
        git(
            &repo,
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
        fs::remove_dir_all(&dir).ok();
    }

    // ===== 逐 hunk 验收 v1 =====

    /// 造一个含两个相距较远 hunk 的修改文件（30 行，改第 2 行与第 28 行），b.txt 附带一处改动
    fn two_hunk_repo(name: &str) -> PathBuf {
        let repo = init_repo(name);
        let base: String = (1..=30).map(|i| format!("l{i:02}\n")).collect();
        fs::write(repo.join("a.txt"), &base).unwrap();
        fs::write(repo.join("b.txt"), "base-b\n").unwrap();
        git(&repo, &["add", "."]);
        git(
            &repo,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        let changed =
            base.replacen("l02\n", "top-changed\n", 1)
                .replacen("l28\n", "bottom-changed\n", 1);
        fs::write(repo.join("a.txt"), &changed).unwrap();
        fs::write(repo.join("b.txt"), "changed-b\n").unwrap();
        repo
    }

    fn diff_cached(repo: &Path, path: &str) -> String {
        let out = run_git(repo.to_str().unwrap(), &["diff", "--cached", "--", path]).unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn diff_unstaged(repo: &Path, path: &str) -> String {
        let out = run_git(repo.to_str().unwrap(), &["diff", "--", path]).unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn hunks_split_multi_hunk_and_new_file() {
        if !git_available() {
            return;
        }
        let repo = two_hunk_repo("hunks-split");
        fs::write(repo.join("new.txt"), "x\ny\n").unwrap();

        let dto = git_file_hunks_sync(repo.to_str().unwrap(), "a.txt").unwrap();
        assert_eq!(dto.hunks.len(), 2, "相距较远的两处修改应拆成两个 hunk");
        assert!(!dto.staged);
        for h in &dto.hunks {
            assert!(
                h.header.starts_with("@@ "),
                "header 应是 @@ 行: {}",
                h.header
            );
            assert!(h.patch.starts_with("diff --git "), "patch 必须带完整文件头");
            assert!(h.patch.contains("--- a/a.txt"));
            assert!(h.patch.contains("+++ b/a.txt"));
            assert_eq!(
                h.patch.lines().filter(|l| l.starts_with("@@ ")).count(),
                1,
                "每个 patch 只含一个 hunk"
            );
        }
        assert!(dto.hunks[0].patch.contains("+top-changed"));
        assert!(!dto.hunks[0].patch.contains("+bottom-changed"));
        assert!(dto.hunks[1].patch.contains("+bottom-changed"));

        // 新文件：整个文件一个 hunk，/dev/null 新文件形式
        let new = git_file_hunks_sync(repo.to_str().unwrap(), "new.txt").unwrap();
        assert_eq!(new.hunks.len(), 1);
        assert!(new.hunks[0].patch.contains("--- /dev/null"));
        assert!(new.hunks[0].patch.contains("+++ b/new.txt"));
        assert!(new.hunks[0].patch.contains("new file mode"));
        assert!(new.hunks[0].patch.contains("@@ -0,0 +1,2 @@"));
        // 白名单：逃逸与未变更路径都拒绝
        assert!(git_file_hunks_sync(repo.to_str().unwrap(), "../outside").is_err());
        assert!(git_file_hunks_sync(repo.to_str().unwrap(), "missing.txt").is_err());
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn hunks_empty_file_and_binary_rejected() {
        if !git_available() {
            return;
        }
        let repo = init_repo("hunks-edge");
        git(
            &repo,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        // 空文件：一个 hunk（无 @@ 头的新文件补丁），暂存后应进索引
        fs::write(repo.join("empty.txt"), "").unwrap();
        let dto = git_file_hunks_sync(repo.to_str().unwrap(), "empty.txt").unwrap();
        assert_eq!(dto.hunks.len(), 1);
        apply_hunk_sync(
            repo.to_str().unwrap(),
            "empty.txt",
            &dto.hunks[0].patch,
            "stage",
        )
        .unwrap();
        let ls = run_git(repo.to_str().unwrap(), &["ls-files", "--", "empty.txt"]).unwrap();
        assert!(
            String::from_utf8_lossy(&ls.stdout).contains("empty.txt"),
            "空新文件暂存后应出现在索引中"
        );
        // 二进制：报错提示
        fs::write(repo.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
        let err = git_file_hunks_sync(repo.to_str().unwrap(), "bin.dat").unwrap_err();
        assert!(err.contains("二进制"), "{err}");
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn stage_hunk_moves_only_that_hunk_to_index() {
        if !git_available() {
            return;
        }
        let repo = two_hunk_repo("hunk-stage");
        let dto = git_file_hunks_sync(repo.to_str().unwrap(), "a.txt").unwrap();
        let status = apply_hunk_sync(
            repo.to_str().unwrap(),
            "a.txt",
            &dto.hunks[0].patch,
            "stage",
        )
        .unwrap();
        assert!(status.files.iter().any(|f| f.path == "a.txt"));
        let staged = diff_cached(&repo, "a.txt");
        assert!(
            staged.contains("+top-changed"),
            "暂存区应含第一块: {staged}"
        );
        assert!(!staged.contains("+bottom-changed"), "第二块不应进暂存区");
        let unstaged = diff_unstaged(&repo, "a.txt");
        assert!(unstaged.contains("+bottom-changed"));
        assert!(!unstaged.contains("+top-changed"));
        // 工作树两块改动都还在
        let content = fs::read_to_string(repo.join("a.txt")).unwrap();
        assert!(content.contains("top-changed") && content.contains("bottom-changed"));
        // 再次拉取：staged 标记置位，hunks 只剩未暂存的一块
        let after = git_file_hunks_sync(repo.to_str().unwrap(), "a.txt").unwrap();
        assert!(after.staged);
        assert_eq!(after.hunks.len(), 1);
        assert!(after.hunks[0].patch.contains("+bottom-changed"));
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn discard_hunk_removes_only_that_hunk() {
        if !git_available() {
            return;
        }
        let repo = two_hunk_repo("hunk-discard");
        let dto = git_file_hunks_sync(repo.to_str().unwrap(), "a.txt").unwrap();
        apply_hunk_sync(
            repo.to_str().unwrap(),
            "a.txt",
            &dto.hunks[0].patch,
            "discard",
        )
        .unwrap();
        let content = fs::read_to_string(repo.join("a.txt")).unwrap();
        assert!(!content.contains("top-changed"), "第一块应从工作树消失");
        assert!(content.contains("bottom-changed"), "第二块必须保留");
        let unstaged = diff_unstaged(&repo, "a.txt");
        assert!(unstaged.contains("+bottom-changed"));
        assert!(!unstaged.contains("+top-changed"));
        assert!(diff_cached(&repo, "a.txt").is_empty());
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn apply_hunk_rejects_escape_stale_and_foreign_patch() {
        if !git_available() {
            return;
        }
        let repo = two_hunk_repo("hunk-reject");
        let dto = git_file_hunks_sync(repo.to_str().unwrap(), "a.txt").unwrap();
        // 逃逸路径 / 未知模式
        assert!(
            apply_hunk_sync(repo.to_str().unwrap(), "../x", &dto.hunks[0].patch, "stage").is_err()
        );
        assert!(apply_hunk_sync(
            repo.to_str().unwrap(),
            "a.txt",
            &dto.hunks[0].patch,
            "bogus"
        )
        .is_err());
        // 补丁指向其他文件：b.txt 在改动清单内，但补丁是 a.txt 的
        let err = apply_hunk_sync(
            repo.to_str().unwrap(),
            "b.txt",
            &dto.hunks[0].patch,
            "stage",
        )
        .unwrap_err();
        assert!(err.contains("不一致"), "{err}");
        // 过期补丁：丢弃成功后再次丢弃同一块 → 失败且文件不被破坏
        apply_hunk_sync(
            repo.to_str().unwrap(),
            "a.txt",
            &dto.hunks[0].patch,
            "discard",
        )
        .unwrap();
        let before = fs::read_to_string(repo.join("a.txt")).unwrap();
        let err = apply_hunk_sync(
            repo.to_str().unwrap(),
            "a.txt",
            &dto.hunks[0].patch,
            "discard",
        )
        .unwrap_err();
        assert!(err.contains("应用失败"), "{err}");
        assert!(err.contains("请刷新"), "{err}");
        assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), before);
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn untracked_hunk_stage_and_discard() {
        if !git_available() {
            return;
        }
        let repo = init_repo("hunk-untracked");
        git(
            &repo,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        fs::write(repo.join("keep.txt"), "x\ny\n").unwrap();
        fs::write(repo.join("drop.txt"), "gone\n").unwrap();

        let keep = git_file_hunks_sync(repo.to_str().unwrap(), "keep.txt").unwrap();
        let status = apply_hunk_sync(
            repo.to_str().unwrap(),
            "keep.txt",
            &keep.hunks[0].patch,
            "stage",
        )
        .unwrap();
        let k = status.files.iter().find(|f| f.path == "keep.txt").unwrap();
        assert_eq!(k.status, "A", "新文件暂存后应显示为新增");
        assert!(repo.join("keep.txt").is_file(), "暂存不动工作树文件");
        let ls = run_git(repo.to_str().unwrap(), &["ls-files", "--", "keep.txt"]).unwrap();
        assert!(String::from_utf8_lossy(&ls.stdout).contains("keep.txt"));

        let drop = git_file_hunks_sync(repo.to_str().unwrap(), "drop.txt").unwrap();
        apply_hunk_sync(
            repo.to_str().unwrap(),
            "drop.txt",
            &drop.hunks[0].patch,
            "discard",
        )
        .unwrap();
        assert!(
            !repo.join("drop.txt").exists(),
            "丢弃新文件 = 删除工作树文件"
        );
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn partial_staging_commit_keeps_unstaged_hunks() {
        if !git_available() {
            return;
        }
        let repo = two_hunk_repo("hunk-partial-commit");
        let dto = git_file_hunks_sync(repo.to_str().unwrap(), "a.txt").unwrap();
        apply_hunk_sync(
            repo.to_str().unwrap(),
            "a.txt",
            &dto.hunks[0].patch,
            "stage",
        )
        .unwrap();
        // 勾选 a.txt + b.txt 提交：a.txt 只能带走已暂存的第一块
        let selected = vec!["a.txt".to_string(), "b.txt".to_string()];
        let result = git_commit_sync(
            repo.to_str().unwrap(),
            "部分暂存提交",
            false,
            Some(&selected),
        )
        .unwrap();
        assert!(result.committed);
        let head_a = run_git(repo.to_str().unwrap(), &["show", "HEAD:a.txt"]).unwrap();
        let head_a = String::from_utf8_lossy(&head_a.stdout).into_owned();
        assert!(head_a.contains("top-changed"), "已暂存块应进提交: {head_a}");
        assert!(!head_a.contains("bottom-changed"), "未暂存块不得进提交");
        let head_b = run_git(repo.to_str().unwrap(), &["show", "HEAD:b.txt"]).unwrap();
        assert_eq!(String::from_utf8_lossy(&head_b.stdout), "changed-b\n");
        // 未暂存块保持未暂存；暂存区已随提交清空；工作树不被改动
        let unstaged = diff_unstaged(&repo, "a.txt");
        assert!(unstaged.contains("+bottom-changed"));
        assert!(diff_cached(&repo, "a.txt").is_empty());
        let content = fs::read_to_string(repo.join("a.txt")).unwrap();
        assert!(content.contains("top-changed") && content.contains("bottom-changed"));
        let status = git_status_sync(repo.to_str().unwrap()).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "a.txt");
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn split_hunks_quote_and_patch_target_checks() {
        // 纯函数：拆分/引用/补丁目标校验
        let diff = "diff --git a/f.txt b/f.txt\nindex 111..222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n@@ -8,1 +8,1 @@\n-a\n+b\n";
        let hunks = split_hunks(diff);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].0, "@@ -1,2 +1,2 @@");
        assert!(hunks[0].1.starts_with("diff --git a/f.txt"));
        assert!(hunks[0].1.contains("+new\n"));
        assert!(!hunks[0].1.contains("+b\n"));
        assert!(split_hunks("no hunks here\n").is_empty());

        // 引用往返：空格不引用；引号/反斜杠/非 ASCII 走 C 风格转义
        assert_eq!(quote_diff_path("a/plain.txt"), "a/plain.txt");
        assert_eq!(quote_diff_path("a/with space.txt"), "a/with space.txt");
        let quoted = quote_diff_path("a/引\"号\\中文.txt");
        assert!(quoted.starts_with('"') && quoted.ends_with('"'));
        assert_eq!(
            unquote_diff_path(&quoted).as_deref(),
            Some("a/引\"号\\中文.txt")
        );

        // 目标校验：匹配放行；目标不符 / 多文件 / 缺文件头都拒绝
        patch_targets_single_file(&hunks[0].1, "f.txt").unwrap();
        assert!(patch_targets_single_file(&hunks[0].1, "other.txt").is_err());
        let two_files = format!("{}{}", hunks[0].1, hunks[0].1.replace("f.txt", "g.txt"));
        assert!(patch_targets_single_file(&two_files, "f.txt").is_err());
        assert!(patch_targets_single_file("@@ -1 +1 @@\n+x\n", "f.txt").is_err());
    }

    #[test]
    fn history_parses_commits_and_numstat() {
        if !git_available() {
            return;
        }
        let dir = init_repo("history");
        fs::write(dir.join("a.txt"), "l1\n").unwrap();
        git(&dir, &["add", "."]);
        git(
            &dir,
            &["-c", "commit.gpgsign=false", "commit", "-m", "init"],
        );
        fs::write(dir.join("a.txt"), "l1\nl2\n").unwrap();
        fs::write(dir.join("b.txt"), "x\ny\nz\n").unwrap();
        git(&dir, &["add", "."]);
        git(
            &dir,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "Mesa: 项目档案卡与 gitignore 自动提交",
            ],
        );

        let entries = project_history_sync(dir.to_str().unwrap(), 100).unwrap();
        assert_eq!(entries.len(), 2);
        let latest = &entries[0];
        assert_eq!(latest.message, "Mesa: 项目档案卡与 gitignore 自动提交");
        assert!(!latest.merge);
        assert!(latest.merged_branch.is_empty());
        assert!(
            !latest.hash.is_empty() && latest.hash.len() < 40,
            "应为短 hash"
        );
        assert!(
            latest.time.contains('T'),
            "时间应为 ISO 格式: {}",
            latest.time
        );
        // numstat 汇总：a.txt +1、b.txt +3 → 2 个文件 +4 −0
        assert_eq!(latest.files, 2);
        assert_eq!(latest.additions, 4);
        assert_eq!(latest.deletions, 0);
        assert_eq!(entries[1].message, "init");
        assert_eq!(entries[1].files, 1);
        // limit 生效
        assert_eq!(
            project_history_sync(dir.to_str().unwrap(), 1)
                .unwrap()
                .len(),
            1
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn history_parses_merge_commit_first_parent() {
        if !git_available() {
            return;
        }
        let dir = init_repo("history-merge");
        fs::write(dir.join("a.txt"), "base\n").unwrap();
        git(&dir, &["add", "."]);
        git(
            &dir,
            &["-c", "commit.gpgsign=false", "commit", "-m", "base"],
        );
        // 工作区分支上的过程提交：不进 first-parent 主时间线
        git(&dir, &["checkout", "-b", "ccode/lit-notes"]);
        fs::write(dir.join("notes.md"), "n1\n").unwrap();
        git(&dir, &["add", "."]);
        git(
            &dir,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "工作区过程提交",
            ],
        );
        git(&dir, &["checkout", "main"]);
        git(
            &dir,
            &[
                "-c",
                "commit.gpgsign=false",
                "merge",
                "--no-ff",
                "ccode/lit-notes",
            ],
        );

        let entries = project_history_sync(dir.to_str().unwrap(), 100).unwrap();
        assert_eq!(entries.len(), 2, "工作区分支的过程提交不进主时间线");
        let merge = &entries[0];
        assert!(merge.merge);
        assert_eq!(merge.merged_branch, "ccode/lit-notes");
        assert!(entries.iter().all(|e| e.message != "工作区过程提交"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn history_empty_repo_and_non_repo() {
        if !git_available() {
            return;
        }
        // 空仓库（已 init、无提交）→ 空表
        let empty = init_repo("history-empty");
        let entries = project_history_sync(empty.to_str().unwrap(), 100).unwrap();
        assert!(entries.is_empty());
        fs::remove_dir_all(&empty).ok();
        // 非仓库 → 报错
        let plain = tmpdir("history-plain");
        assert!(project_history_sync(plain.to_str().unwrap(), 100).is_err());
        fs::remove_dir_all(&plain).ok();
    }

    #[test]
    fn history_parse_merged_branch_variants() {
        assert_eq!(
            parse_merged_branch("Merge branch 'ccode/data-clean'"),
            "ccode/data-clean"
        );
        assert_eq!(
            parse_merged_branch("Merge branch 'ccode/x' into main"),
            "ccode/x"
        );
        assert_eq!(
            parse_merged_branch("Merge remote-tracking branch 'origin/main'"),
            "origin/main"
        );
        assert!(parse_merged_branch("普通提交信息").is_empty());
    }

    // ===== 工作树归属（路径方言） =====

    fn wt_row(path: &str) -> crate::workspaces::WorktreeRow {
        crate::workspaces::WorktreeRow {
            id: "id".into(),
            worktree_path: path.into(),
            repo_path: "repo".into(),
            name: "task".into(),
            branch: "ccode/task".into(),
            base_branch: "main".into(),
        }
    }

    #[test]
    fn worktree_row_matches_subdirectories_in_native_separator() {
        // 回归：原先用 format!("{p}/") 拼前缀，只认正斜杠。Windows 的 worktree_path
        // 是全反斜杠 ⇒ 子目录恒不命中，改动面板静默退回普通 git_status。
        #[cfg(windows)]
        let (root, sub, other) = (
            r"C:\Users\u\ccode\workspaces\repo\task",
            r"C:\Users\u\ccode\workspaces\repo\task\manuscript",
            r"C:\Users\u\ccode\workspaces\repo\other",
        );
        #[cfg(not(windows))]
        let (root, sub, other) = (
            "/Users/u/ccode/workspaces/repo/task",
            "/Users/u/ccode/workspaces/repo/task/manuscript",
            "/Users/u/ccode/workspaces/repo/other",
        );
        let rows = vec![wt_row(root)];
        assert!(find_worktree_row(root, &rows).is_some(), "工作树根必须命中");
        assert!(find_worktree_row(sub, &rows).is_some(), "子目录必须命中");
        assert!(
            find_worktree_row(other, &rows).is_none(),
            "同级目录不得命中"
        );
    }

    #[test]
    fn worktree_row_does_not_match_sibling_with_shared_prefix() {
        // task2 与 task 共享字符串前缀，但不是子目录——按分量比才不会误判
        #[cfg(windows)]
        let (root, sibling) = (r"C:\ws\task", r"C:\ws\task2");
        #[cfg(not(windows))]
        let (root, sibling) = ("/ws/task", "/ws/task2");
        let rows = vec![wt_row(root)];
        assert!(find_worktree_row(sibling, &rows).is_none());
    }
}
