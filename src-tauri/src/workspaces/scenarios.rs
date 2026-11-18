//! 乱操作场景（docs/design-project-doctor.md 第三件）：真 git 仓库里走一步的完整生命周期，
//! 每两步之间注入一种人可能做的奇怪操作，看各入口是走通、被拦且有出口，还是撞上没有出口的死结。
use super::*;
use std::process::Command;

pub(super) struct Proj {
    pub dir: PathBuf,
    pub conn: Connection,
    pub ws_root: PathBuf,
    pub repo: PathBuf,
}

impl Drop for Proj {
    fn drop(&mut self) {
        let _ = run_git(&self.repo, &["worktree", "prune"], Duration::from_secs(10));
        let _ = fs::remove_dir_all(&self.dir);
    }
}

pub(super) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(crate::agents::resolve_binary("git").ok_or("无 git")?)
        .arg("-C")
        .arg(dir)
        .args(["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"])
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

fn ok(dir: &Path, args: &[&str]) {
    git(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"));
}

/// 一个像 Mesa 建出来的科研项目：档案卡（随机 id）、模板 .gitignore、已跟踪的笔记与清单，已提交
pub(super) fn research_project() -> Option<Proj> {
    crate::agents::resolve_binary("git")?;
    let dir = std::env::temp_dir().join(format!("ccode-scn-{}", uuid::Uuid::new_v4()));
    let repo = dir.join("课题");
    fs::create_dir_all(repo.join(".ccode")).unwrap();
    fs::create_dir_all(repo.join("notes")).unwrap();
    fs::create_dir_all(repo.join("papers")).unwrap();
    ok(&repo, &["-c", "init.defaultBranch=main", "init"]);
    ok(&repo, &["config", "core.autocrlf", "false"]);
    fs::write(
        repo.join(".ccode/project.toml"),
        format!("id = \"{}\"\nwork_mode = \"research\"\n", uuid::Uuid::new_v4()),
    )
    .unwrap();
    fs::write(repo.join(".gitignore"), crate::projects::gitignore_text("research", "artifacts")).unwrap();
    fs::write(repo.join("notes/a.md"), "一\n二\n三\n四\n五\n六\n").unwrap();
    fs::write(repo.join("papers/included.md"), "- 甲\n").unwrap();
    ok(&repo, &["add", "-A"]);
    ok(&repo, &["commit", "-m", "init"]);
    let conn = db_at(&dir.join("app.db")).unwrap();
    Some(Proj { ws_root: dir.join("ws"), dir, conn, repo })
}

impl Proj {
    pub fn start_step(&self, name: &str) -> WorkspaceDto {
        create_impl(&self.conn, &self.ws_root, self.repo.to_str().unwrap(), name).unwrap()
    }
    /// AI 在工作副本里写文件并提交
    pub fn ai_writes(&self, w: &WorkspaceDto, path: &str, text: &str) {
        let wt = Path::new(&w.worktree_path);
        if let Some(parent) = wt.join(path).parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(wt.join(path), text).unwrap();
        ok(wt, &["add", "-A"]);
        ok(wt, &["commit", "-m", "AI 交付"]);
    }
    pub fn save(&self, w: &WorkspaceDto) -> Result<WorkspaceMergeResultDto, String> {
        merge_impl(&self.conn, &w.id, false)
    }
    pub fn bring_latest(&self, w: &WorkspaceDto) -> Result<String, String> {
        sync_base_impl(Path::new(&w.worktree_path), &w.base_branch, false)
    }
    pub fn health(&self, w: &WorkspaceDto) -> Result<WsHealthDto, String> {
        health_impl(&self.conn, &w.id)
    }
}

/// 人可能做的奇怪操作（随发现增补）。apply 在「这一步 AI 已交付、还没保存」时注入
#[derive(Clone, Copy, Debug)]
pub(super) enum Mess {
    MainNoteEdit,
    MainNoteEditSameAsStep,
    MainTrackedLedgerEdit,
    MainUserCommit,
    MainUserFile,
    MainOtherBranch,
    MainDetached,
    MainMergeHalf,
    MainRebaseHalf,
    MainStaleLock,
    MainGitignoreDeleted,
    MainManualMergeOfStep,
    WtDirDeleted,
    WtGitFileDeleted,
    WtOtherBranch,
    WtDirty,
    WtStaleLock,
    WtMergeHalf,
    ProjectMoved,
    OldProjectNoIdOldIgnore,
}

pub(super) const ALL_MESS: &[Mess] = &[
    Mess::MainNoteEdit,
    Mess::MainNoteEditSameAsStep,
    Mess::MainTrackedLedgerEdit,
    Mess::MainUserCommit,
    Mess::MainUserFile,
    Mess::MainOtherBranch,
    Mess::MainDetached,
    Mess::MainMergeHalf,
    Mess::MainRebaseHalf,
    Mess::MainStaleLock,
    Mess::MainGitignoreDeleted,
    Mess::MainManualMergeOfStep,
    Mess::WtDirDeleted,
    Mess::WtGitFileDeleted,
    Mess::WtOtherBranch,
    Mess::WtDirty,
    Mess::WtStaleLock,
    Mess::WtMergeHalf,
    Mess::ProjectMoved,
    Mess::OldProjectNoIdOldIgnore,
];

fn age(path: &Path) {
    let old = std::time::SystemTime::now() - Duration::from_secs(120);
    fs::File::options().write(true).open(path).unwrap().set_modified(old).unwrap();
}

/// 在主文件夹做一次撞车的合并 / 变基，停在冲突上
fn half_operation(repo: &Path, rebase: bool) {
    ok(repo, &["checkout", "-q", "-b", "side"]);
    fs::write(repo.join("papers/included.md"), "- 乙\n").unwrap();
    ok(repo, &["commit", "-qam", "side"]);
    ok(repo, &["checkout", "-q", "main"]);
    fs::write(repo.join("papers/included.md"), "- 丙\n").unwrap();
    ok(repo, &["commit", "-qam", "main"]);
    if rebase {
        ok(repo, &["checkout", "-q", "side"]);
        let _ = git(repo, &["rebase", "main"]);
    } else {
        let _ = git(repo, &["merge", "side"]);
    }
}

impl Mess {
    pub fn apply(self, p: &mut Proj, w: &WorkspaceDto) {
        let repo = p.repo.clone();
        let wt = PathBuf::from(&w.worktree_path);
        match self {
            Mess::MainNoteEdit => fs::write(repo.join("notes/b.md"), "人在主文件夹新写的笔记\n").unwrap(),
            Mess::MainNoteEditSameAsStep => {
                fs::write(repo.join("notes/a.md"), "一（人改）\n二\n三\n四\n五\n六\n").unwrap()
            }
            Mess::MainTrackedLedgerEdit => {
                fs::write(repo.join(".ccode/record.jsonl"), "{}\n").unwrap();
                ok(&repo, &["add", "-f", ".ccode/record.jsonl"]);
                ok(&repo, &["commit", "-qm", "老版本把记录提交进了历史"]);
                fs::write(repo.join(".ccode/record.jsonl"), "{}\n{}\n").unwrap();
            }
            Mess::MainUserCommit => {
                fs::write(repo.join("我的草稿.md"), "x\n").unwrap();
                ok(&repo, &["add", "我的草稿.md"]);
                ok(&repo, &["commit", "-qm", "人自己提交"]);
            }
            Mess::MainUserFile => fs::write(repo.join("我的草稿.docx"), "x").unwrap(),
            Mess::MainOtherBranch => ok(&repo, &["checkout", "-q", "-b", "试试"]),
            Mess::MainDetached => ok(&repo, &["checkout", "-q", "--detach"]),
            Mess::MainMergeHalf => half_operation(&repo, false),
            Mess::MainRebaseHalf => half_operation(&repo, true),
            Mess::MainStaleLock => {
                let lock = repo.join(".git/index.lock");
                fs::write(&lock, "").unwrap();
                age(&lock);
            }
            Mess::MainGitignoreDeleted => fs::remove_file(repo.join(".gitignore")).unwrap(),
            Mess::MainManualMergeOfStep => ok(&repo, &["merge", "-q", "--no-ff", "-m", "人手动合并", &w.branch]),
            Mess::WtDirDeleted => fs::remove_dir_all(&wt).unwrap(),
            Mess::WtGitFileDeleted => fs::remove_file(wt.join(".git")).unwrap(),
            Mess::WtOtherBranch => ok(&wt, &["checkout", "-q", "-b", "ai-side"]),
            Mess::WtDirty => fs::write(wt.join("notes/没提交.md"), "x\n").unwrap(),
            Mess::WtStaleLock => {
                let gitdir = git(&wt, &["rev-parse", "--absolute-git-dir"]).unwrap();
                let lock = PathBuf::from(gitdir.trim()).join("index.lock");
                fs::write(&lock, "").unwrap();
                age(&lock);
            }
            Mess::WtMergeHalf => {
                fs::write(repo.join("papers/included.md"), "- 主线改\n").unwrap();
                ok(&repo, &["commit", "-qam", "主线改清单"]);
                fs::write(wt.join("papers/included.md"), "- 这一步改\n").unwrap();
                ok(&wt, &["commit", "-qam", "这一步改清单"]);
                let _ = git(&wt, &["merge", "main"]);
            }
            Mess::ProjectMoved => {
                let to = p.dir.join("挪走的课题");
                fs::rename(&repo, &to).unwrap();
                p.repo = to;
            }
            Mess::OldProjectNoIdOldIgnore => {
                fs::write(repo.join(".ccode/project.toml"), "work_mode = \"research\"\n").unwrap();
                fs::write(repo.join(".gitignore"), "/artifacts/\n.DS_Store\n*.pdf\n").unwrap();
                ok(&repo, &["commit", "-qam", "老项目的样子"]);
            }
        }
    }
}

fn short(r: &Result<String, String>) -> String {
    match r {
        Ok(_) => "通".into(),
        Err(e) => format!("拦：{}", e.lines().next().unwrap_or("").chars().take(70).collect::<String>()),
    }
}

/// 现状普查（手动跑、看输出）：`cargo test mess_census -- --ignored --nocapture`
#[test]
#[ignore]
fn mess_census() {
    for &mess in ALL_MESS {
        let Some(mut p) = research_project() else { return };
        let w = p.start_step("lit-notes");
        p.ai_writes(&w, "notes/a.md", "一\n二\n三\n四\n五\n六（AI 改）\n");
        mess.apply(&mut p, &w);
        let health = p.health(&w).map(|h| {
            let mut v: Vec<&str> = Vec::new();
            if h.stale_lock { v.push("锁") }
            if h.main_unfinished.is_some() { v.push("没做完") }
            if h.main_dirty { v.push("主脏") }
            if h.main_off_base { v.push("不在主分支") }
            if h.gitdir_detached { v.push("脱节") }
            if h.uncommitted { v.push("工作区脏") }
            if h.conflict == Some(true) { v.push("冲突") }
            if h.ahead == 0 { v.push("ahead=0") }
            format!("{} ready={}", v.join(","), h.ready_to_merge)
        });
        let save = p.save(&w).map(|r| r.message);
        let latest = p.bring_latest(&w);
        let next = create_impl(&p.conn, &p.ws_root, p.repo.to_str().unwrap(), "outline").map(|_| String::new());
        let archive = archive_impl(&p.conn, &w.id).map(|_| String::new());
        let restore = restore_impl(&p.conn, &w.id).map(|_| String::new());
        println!(
            "{:<24} 体检[{}]\n{:<24} 保存[{}] 并入最新[{}]\n{:<24} 开下一步[{}] 归档[{}] 恢复[{}]\n",
            format!("{mess:?}"),
            match &health { Ok(h) => h.clone(), Err(_) => short(&health.clone().map(|_| String::new())) },
            "",
            short(&save),
            short(&latest),
            "",
            short(&next),
            short(&archive),
            short(&restore),
        );
    }
}
