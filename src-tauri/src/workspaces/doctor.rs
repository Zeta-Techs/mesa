//! 项目体检（docs/design-project-doctor.md 第一件）：入口动手前把主文件夹和这一步工作副本的异常状态列全。
//! 不丢东西、不替人做判断的直接处理（`fixed` 里写一行）；要人点一下的给按钮（`fix.kind = "click"`，点前说清后果）；
//! 要人看内容做选择的给去处（`fix.kind = "goto"`）。不变式：每条拦人的项都有出口，见 scenarios.rs。
use super::*;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorFix {
    /// click：点了由 workspace_doctor_fix 处理；goto：前端跳到 target 那个界面由人处理
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorFinding {
    pub code: String,
    pub text: String,
    /// 拦不拦这次要做的事（同一状态对不同入口拦法不同）
    pub blocks: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<DoctorFix>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    /// 体检时已经替人处理掉的（一行一件，白话）
    pub fixed: Vec<String>,
    pub findings: Vec<DoctorFinding>,
}

impl DoctorReport {
    pub fn blocked(&self) -> bool {
        self.findings.iter().any(|f| f.blocks)
    }
}

/// 入口：review 打开评审 / save 保存进项目 / round 开一轮（继续、退回修改、补料、跟进、并入最新）/
/// archive 归档 / restore 恢复
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Intent {
    Review,
    Save,
    Round,
    Archive,
    Restore,
}

impl Intent {
    pub fn parse(s: &str) -> Result<Self, String> {
        Ok(match s {
            "review" => Intent::Review,
            "save" => Intent::Save,
            "round" => Intent::Round,
            "archive" => Intent::Archive,
            "restore" => Intent::Restore,
            other => return Err(format!("不认识的入口：{other}")),
        })
    }
}

fn click(label: &str, confirm: Option<String>) -> Option<DoctorFix> {
    Some(DoctorFix { kind: "click".into(), label: label.into(), confirm, target: None })
}

fn goto(label: &str, target: &str) -> Option<DoctorFix> {
    Some(DoctorFix { kind: "goto".into(), label: label.into(), confirm: None, target: Some(target.into()) })
}

fn finding(code: &str, text: impl Into<String>, blocks: bool, fix: Option<DoctorFix>) -> DoctorFinding {
    DoctorFinding { code: code.into(), text: text.into(), blocks, fix }
}

const T: Duration = Duration::from_secs(30);

/// 被删了要从历史放回来的 Mesa 自有档案
const MESA_OWNED_FILES: [&str; 3] = [".gitignore", ".ccode/project.toml", ".ccode/settings.toml"];

fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists() && run_git(dir, &["rev-parse", "--git-dir"], T).is_ok()
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    run_git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], T).is_ok()
}

/// 工作副本还能当这个仓库的 worktree 用吗（.git 文件在、指回这个仓库）
fn worktree_linked(wt: &Path, repo: &Path) -> bool {
    wt.join(".git").is_file()
        && run_git(wt, &["rev-parse", "--git-dir"], T).is_ok()
        && gitdir_matches_repo(wt, repo).is_ok()
}

/// 工作副本最后停在的提交：HEAD 能解析就用它；分支被删后 HEAD 悬空，就读工作副本自己的 HEAD 日志最后一条
fn worktree_last_commit(wt: &Path) -> Option<String> {
    if !wt.is_dir() {
        return None;
    }
    if let Ok(sha) = run_git(wt, &["rev-parse", "-q", "--verify", "HEAD^{commit}"], T) {
        return Some(sha);
    }
    let gitdir = run_git(wt, &["rev-parse", "--absolute-git-dir"], T).ok()?;
    let log = fs::read_to_string(Path::new(&gitdir).join("logs").join("HEAD")).ok()?;
    let sha = log.lines().last()?.split_whitespace().nth(1)?.to_string();
    run_git(wt, &["cat-file", "-e", &format!("{sha}^{{commit}}")], T).ok()?;
    Some(sha)
}

/// 从这一步的分支把工作副本重新放出来（目录不在时）
fn readd_worktree(repo: &Path, w: &WorkspaceDto) -> Result<(), String> {
    let _ = run_git(repo, &["worktree", "prune"], T);
    if let Some(parent) = Path::new(&w.worktree_path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建工作副本目录失败：{e}"))?;
    }
    run_git(repo, &["worktree", "add", &w.worktree_path, &w.branch], Duration::from_secs(60))
        .map_err(|e| format!("重新放出工作副本失败：{e}"))?;
    copy_workspace_restore_files(w)
}

/// 这一步的分支已经在主线里，但不是 Mesa 合并的（人在 Mesa 外 git merge 过）：主线第一父链上找不到它的 tip，
/// 只能经某个合并提交的第二父链走到。返回那个合并提交。AI 没交任何东西（tip 就在第一父链上）不算。
fn outside_merge_commit(repo: &Path, branch: &str, base: &str) -> Option<String> {
    let tip = run_git(repo, &["rev-parse", branch], T).ok()?;
    if !git_is_ancestor(repo, &tip, base).ok()? {
        return None;
    }
    let first_parent = run_git(repo, &["rev-list", "--first-parent", base], Duration::from_secs(60)).ok()?;
    if first_parent.lines().any(|l| l == tip) {
        return None;
    }
    let merges = run_git(
        repo,
        &["rev-list", "--merges", "--ancestry-path", "--reverse", "--parents", &format!("{tip}..{base}")],
        Duration::from_secs(60),
    )
    .ok()?;
    merges
        .lines()
        .find(|l| l.split_whitespace().skip(1).any(|p| p == tip))
        .and_then(|l| l.split_whitespace().next())
        .map(str::to_string)
}

fn has_merge_fact(repo: &Path, w: &WorkspaceDto, tip: &str) -> bool {
    crate::projects::read_acceptance_log_at(repo).into_iter().any(|e| {
        e.kind == crate::review_contract::KIND_PIPELINE_MERGE
            && e.scene_ref.as_deref() == Some(&w.id)
            && e.reviewed_sha.as_deref() == Some(tip)
    })
}

pub(crate) fn diagnose_impl(conn: &Connection, id: &str, intent: Intent) -> Result<DoctorReport, String> {
    let mut report = DoctorReport::default();
    let mut w = get_workspace(conn, id)?;

    // ① 项目文件夹在哪：记下的位置没了、项目表里按 id 找得到新位置 → 跟着改（工作副本的链接一并接上）
    let mut repo = live_repo_in(Some(conn), &w);
    if !is_repo(&repo) {
        report.findings.push(finding(
            "repo_missing",
            "找不到这个项目的文件夹（可能被挪走、改名或删了）",
            true,
            goto("去重新定位", "workspaces"),
        ));
        return Ok(report);
    }
    if !crate::paths::same_path(&repo.to_string_lossy(), &w.repo_path) {
        let old = w.repo_path.clone();
        conn.execute(
            "UPDATE workspaces SET repo_path=?1 WHERE id=?2",
            params![repo.to_string_lossy().as_ref(), id],
        )
        .map_err(|e| format!("更新项目位置失败：{e}"))?;
        if Path::new(&w.worktree_path).exists() {
            let _ = run_git(&repo, &["worktree", "repair", &w.worktree_path], Duration::from_secs(60));
        }
        invalidate_repo_cache();
        w = get_workspace(conn, id)?;
        repo = PathBuf::from(&w.repo_path);
        report.fixed.push(format!("项目文件夹从 {old} 挪到了现在的位置，已跟着改好"));
    }
    let wt = PathBuf::from(&w.worktree_path);

    // ② 上次被打断的 git 留下的锁：够旧就删（年轻的锁说明 git 正在用，不碰）
    let locks = stale_index_locks(&[&repo, &wt]);
    if !locks.is_empty() {
        for lock in &locks {
            fs::remove_file(lock).map_err(|e| format!("删除锁文件 {} 失败：{e}", lock.display()))?;
        }
        report.fixed.push("清掉了上次 git 操作被打断时留下的锁文件".into());
    }

    // ③ 这一步的工作副本
    let active = w.status == "active";
    let mut has_branch = branch_exists(&repo, &w.branch);
    if !has_branch {
        // 分支被删了：工作副本自己的 HEAD 记录还记得最后停在哪个提交，从那里把这一步的记录找回来（一个字不丢）
        if let Some(sha) = worktree_last_commit(&wt) {
            if run_git(&repo, &["branch", &w.branch, &sha], T).is_ok() {
                has_branch = true;
                report.fixed.push("这一步的记录（分支）被删了，已从工作副本里找回".into());
            }
        }
    }
    if !has_branch && matches!(intent, Intent::Restore) {
        report.findings.push(finding(
            "branch_missing",
            format!("这一步的记录（分支 {}）被删掉了，没法恢复", w.branch),
            true,
            click("收起这一步", Some("这一步没法恢复了。之后要再做这一步，从步骤卡重新开工。继续？".into())),
        ));
    }
    if active && !has_branch {
        report.findings.push(finding(
            "branch_missing",
            format!("这一步的记录（分支 {}）被删掉了，AI 在这一步交的东西已经找不回", w.branch),
            !matches!(intent, Intent::Review),
            click(
                "收起这一步",
                Some("把这一步标成已收起。之后要再做这一步，从步骤卡重新开工。继续？".into()),
            ),
        ));
    }
    if active && has_branch {
        if !wt.is_dir() {
            readd_worktree(&repo, &w)?;
            report.fixed.push("这一步的工作副本文件夹不见了，已从这一步的记录重新放出来（没提交过的改动找不回）".into());
        } else if !worktree_linked(&wt, &repo) {
            let _ = run_git(&repo, &["worktree", "repair", &w.worktree_path], Duration::from_secs(60));
            if worktree_linked(&wt, &repo) {
                report.fixed.push("这一步的工作副本和项目断开了联系，已重新接上".into());
            } else {
                report.findings.push(finding(
                    "worktree_broken",
                    "这一步的工作副本坏了（里面的 git 记录丢了），Mesa 认不出它",
                    true,
                    click(
                        "重新放出工作副本",
                        Some("把现在这个文件夹改名留作备份（一个字都不删），再从这一步的记录重新放出一份。没提交过的改动在备份文件夹里。继续？".into()),
                    ),
                ));
            }
        }
        if worktree_linked(&wt, &repo) {
            let head_branch = run_git(&wt, &["symbolic-ref", "--short", "-q", "HEAD"], T).ok();
            if head_branch.as_deref() != Some(&w.branch) {
                let head = run_git(&wt, &["rev-parse", "HEAD"], T).unwrap_or_default();
                if !head.is_empty() && git_is_ancestor(&wt, &w.branch, &head).unwrap_or(false) {
                    run_git(&wt, &["checkout", "-q", "-B", &w.branch], T)
                        .map_err(|e| format!("把工作副本切回这一步失败：{e}"))?;
                    report.fixed.push("工作副本被切到了别的分支上，已切回这一步（那边新做的提交一起带上）".into());
                } else {
                    report.findings.push(finding(
                        "worktree_off_branch",
                        format!(
                            "这一步的工作副本被切到了 {} 上，和这一步的记录分叉了",
                            head_branch.as_deref().unwrap_or("一个没有名字的提交")
                        ),
                        matches!(intent, Intent::Save | Intent::Round | Intent::Archive),
                        click(
                            "切回这一步",
                            Some(format!("把工作副本切回 {}。另一边的提交留在原处，不会出现在评审里。继续？", w.branch)),
                        ),
                    ));
                }
            }
            if run_git(&wt, &["rev-parse", "--verify", "-q", "MERGE_HEAD"], T).is_ok() {
                report.findings.push(finding(
                    "worktree_conflict",
                    "这一步的工作副本里有一次合并停在冲突上",
                    matches!(intent, Intent::Save | Intent::Round | Intent::Archive),
                    goto("去处理冲突", "review"),
                ));
            }
        }
    }

    // ④ 主文件夹
    if let Some(op) = unfinished_operation(&repo) {
        report.findings.push(finding(
            "main_unfinished",
            format!("项目文件夹停在一次没做完的 git {}里", unfinished_word(op)),
            matches!(intent, Intent::Save),
            click(
                "放弃那次操作",
                Some("放弃项目文件夹里那次没做完的 git 操作，回到它开始之前？那次操作里已经做的选择会丢掉；平常的文件改动不受影响。".into()),
            ),
        ));
    } else {
        let cur = run_git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"], T).unwrap_or_default();
        if cur != w.base_branch {
            report.findings.push(finding(
                "main_off_base",
                if cur == "HEAD" {
                    format!("项目文件夹没停在 {} 上", w.base_branch)
                } else {
                    format!("项目文件夹当前在 {cur} 上，不在 {}", w.base_branch)
                },
                matches!(intent, Intent::Save),
                click(
                    &format!("切回 {}", w.base_branch),
                    Some(format!("把项目文件夹切回 {}？现在所在分支上的提交仍留在那个分支上。", w.base_branch)),
                ),
            ));
        }
    }
    // Mesa 自己的档案被删（人清理文件夹时顺手删了）：历史里有就放回来，项目身份和忽略规则都靠它们
    for file in MESA_OWNED_FILES {
        let gone = !repo.join(file).exists()
            && run_git(&repo, &["cat-file", "-e", &format!("HEAD:{file}")], T).is_ok();
        if gone && run_git(&repo, &["checkout", "HEAD", "--", file], T).is_ok() {
            report.fixed.push(format!("项目文件夹里的 {file} 被删了，已从历史里放回来"));
        }
    }
    if matches!(intent, Intent::Review | Intent::Save) {
        if let Ok(out) = crate::projects::commit_bootstrap_at(&repo) {
            if out.committed {
                report.fixed.push("Mesa 自己的项目档案有改动，已替你存进历史".into());
            }
        }
        let dirty = run_git_porcelain(&repo, &["status", "--porcelain", "--untracked-files=all"], T)?;
        let mine: Vec<&str> = dirty
            .lines()
            .filter(|l| !crate::review_contract::is_untracked_ledger_file(l))
            .map(|l| l.get(3..).unwrap_or(l))
            .collect();
        if !mine.is_empty() && unfinished_operation(&repo).is_none() {
            let names = mine.iter().take(3).copied().collect::<Vec<_>>().join("、");
            let more = if mine.len() > 3 { format!(" 等 {} 个", mine.len()) } else { String::new() };
            report.findings.push(finding(
                "main_dirty",
                format!("项目文件夹里还有没保存的改动（{names}{more}）"),
                matches!(intent, Intent::Save),
                goto("提交项目文件夹的改动…", "main-commit"),
            ));
        }
    }

    // ⑤ 这一步已经在 Mesa 外合并进主线、Mesa 没有记录
    if has_branch && w.merged_at.is_none() && matches!(intent, Intent::Review | Intent::Save) {
        if let Some(merge) = outside_merge_commit(&repo, &w.branch, &w.base_branch) {
            let tip = run_git(&repo, &["rev-parse", &w.branch], T).unwrap_or_default();
            if !has_merge_fact(&repo, &w, &tip) {
                report.findings.push(finding(
                    "merged_outside",
                    format!(
                        "这一步的内容已经在 Mesa 外合并进了项目（{}），Mesa 没有这次评审的记录",
                        merge.chars().take(8).collect::<String>()
                    ),
                    true,
                    click(
                        "确认并补记",
                        Some("你确认这一步的内容已经是你要的、进了项目？Mesa 会记一条「在 Mesa 外合并、人工确认」的记录，这一步算保存过。".into()),
                    ),
                ));
            }
        }
    }
    Ok(report)
}

fn unfinished_word(op: &str) -> &'static str {
    match op {
        "merge" => "合并",
        "rebase" => "变基",
        "cherry-pick" => "挑拣提交",
        "revert" => "撤销提交",
        _ => "操作",
    }
}

/// 一键处理（人点了才做，做之前按当下状态复查）
pub(crate) fn fix_impl(conn: &Connection, id: &str, code: &str) -> Result<String, String> {
    let w = get_workspace(conn, id)?;
    let repo = live_repo_in(Some(conn), &w);
    let wt = PathBuf::from(&w.worktree_path);
    match code {
        "main_unfinished" => repair_main_impl(conn, id, "abort_unfinished"),
        "main_off_base" => repair_main_impl(conn, id, "switch_base"),
        "worktree_off_branch" => {
            run_git(&wt, &["switch", &w.branch], T).map_err(|e| {
                if e.contains("would be overwritten") || e.contains("Please commit") {
                    "工作副本里有没提交的改动和这一步的内容冲突，git 不让切换：先在改动面板提交或撤掉它们".to_string()
                } else {
                    format!("切回这一步失败：{e}")
                }
            })?;
            Ok("工作副本已切回这一步".into())
        }
        "worktree_broken" => {
            let stamp = crate::sessions::now_iso().replace([':', '-'], "").chars().take(15).collect::<String>();
            if !wt.exists() {
                readd_worktree(&repo, &w)?;
                return Ok("已重新放出工作副本".into());
            }
            let backup = PathBuf::from(format!("{}.备份-{stamp}", w.worktree_path));
            fs::rename(&wt, &backup).map_err(|e| format!("把坏的工作副本改名备份失败：{e}"))?;
            readd_worktree(&repo, &w)?;
            Ok(format!("已重新放出工作副本；原来的文件在 {}", backup.display()))
        }
        "branch_missing" => {
            if w.status != "active" {
                return Ok("这一步保持收起".into());
            }
            if wt.exists() {
                let _ = run_git(&repo, &["worktree", "remove", "--force", &w.worktree_path], T);
            }
            let _ = run_git(&repo, &["worktree", "prune"], T);
            conn.execute(
                "UPDATE workspaces SET status='archived', archived_at=?2 WHERE id=?1",
                params![id, crate::sessions::now_iso()],
            )
            .map_err(|e| format!("收起这一步失败：{e}"))?;
            Ok("这一步已收起".into())
        }
        "merged_outside" => record_outside_merge(conn, &w, &repo),
        other => Err(format!("这一项没有一键处理：{other}")),
    }
}

/// 在 Mesa 外合并过的一步，人确认后如实补记（2026-11-18 用户拍板）：记录写明「在 Mesa 外合并、人工确认」，
/// 版本是那次外部合并的提交，路径是那次合并带进来的文件
fn record_outside_merge(conn: &Connection, w: &WorkspaceDto, repo: &Path) -> Result<String, String> {
    let merge = outside_merge_commit(repo, &w.branch, &w.base_branch)
        .ok_or("这一步现在不是「在 Mesa 外合并过」的状态，刷新后再看")?;
    let tip = run_git(repo, &["rev-parse", &w.branch], T)?;
    let paths: Vec<String> = run_git(repo, &["diff", "--name-only", &format!("{merge}^1"), &merge], T)?
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let decided_at = crate::sessions::now_iso();
    let fact = crate::projects::AcceptanceLogEntry {
        goal_id: String::new(),
        goal_name: format!("{} / {}", w.name, w.branch),
        run_id: String::new(),
        paths,
        note: format!("在 Mesa 外合并（{}），人工确认后补记", merge.chars().take(8).collect::<String>()),
        frozen: false,
        decided_at: decided_at.clone(),
        kind: crate::review_contract::KIND_PIPELINE_MERGE.into(),
        version_id: merge,
        reviewed_sha: Some(tip),
        project_id: w.project_id.clone().or_else(|| crate::projects::project_id_at(repo)),
        scene_ref: Some(w.id.clone()),
        content_fingerprints: Vec::new(),
    };
    crate::review_contract::record_pending_fact(repo, &w.id, &fact)?;
    conn.execute("UPDATE workspaces SET merged_at=?1 WHERE id=?2", params![decided_at, w.id])
        .map_err(|e| format!("记录已补，但更新这一步的状态失败：{e}"))?;
    Ok("已补记：这一步算保存过".into())
}

#[tauri::command]
pub async fn workspace_doctor(id: String, intent: String) -> Result<DoctorReport, String> {
    tauri::async_runtime::spawn_blocking(move || diagnose_impl(&db()?, &id, Intent::parse(&intent)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_doctor_fix(id: String, code: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fix_impl(&db()?, &id, &code))
        .await
        .map_err(|e| e.to_string())?
}
