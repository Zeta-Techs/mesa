
use super::*;

/// 测试也统一走 resolve_binary（与生产代码同一解析路径）
fn git_bin() -> PathBuf {
    crate::agents::resolve_binary("git").expect("测试环境找不到 git 可执行文件")
}

#[test]
fn delivery_process_files_stay_out_of_review() {
    assert!(is_delivery_process_file("artifacts/search/openalex/Q_OA1_000.json"));
    assert!(is_delivery_process_file("artifacts/search/candidates.jsonl"));
    assert!(is_delivery_process_file("artifacts/raw/openalex/page.json"));
    assert!(is_delivery_process_file("artifacts/cache/hits.tsv"));
    assert!(is_delivery_process_file("output/artifacts/search/run.log"));
    assert!(!is_delivery_process_file("artifacts/figures/fig1.png"));
    assert!(!is_delivery_process_file("artifacts/results.csv"));
    assert!(is_delivery_process_file("artifacts/api-cache/01b30a.json"));
    assert!(is_delivery_process_file("enrich_metadata.py"));
    assert!(is_delivery_process_file(".gitignore"));
    assert!(is_delivery_process_file("papers/included.json"));
    assert!(!is_delivery_process_file("papers/included.md"));
    assert!(!is_delivery_process_file("papers/to-fetch.ris"));
    assert!(!is_delivery_process_file("papers/endnote-import.ris"));
    assert!(is_delivery_process_file("output/figures/fig1.png"));
    assert!(!is_delivery_process_file("output/endnote.docx"));
    assert!(!is_delivery_process_file("figures/fig1.png"));
}

fn git_available() -> bool {
    crate::agents::resolve_binary("git")
        .map(|git| {
            Command::new(git)
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn sh(dir: &Path, args: &[&str]) {
    let out = Command::new(git_bin())
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

/// 带 origin（裸仓库）+ origin/HEAD 的测试仓库，repo 根下放两个 files-to-copy 文件
fn setup_repo(dir: &Path) -> PathBuf {
    let origin = dir.join("origin.git");
    let repo = dir.join("myrepo");
    Command::new(git_bin())
        .args(["init", "--bare"])
        .arg(&origin)
        .output()
        .unwrap();
    Command::new(git_bin())
        .args(["-c", "init.defaultBranch=main", "init"])
        .arg(&repo)
        .output()
        .unwrap();
    sh(&repo, &["config", "user.email", "t@t"]);
    sh(&repo, &["config", "user.name", "t"]);
    // 与宿主 git 配置解耦：Windows 上 core.autocrlf 默认 true（Git for Windows 装机默认），
    // checkout 会把 LF 转成 CRLF，断言文件内容的用例会莫名其妙对不上（"done\r\n" != "done\n"）。
    sh(&repo, &["config", "core.autocrlf", "false"]);
    sh(&repo, &["config", "core.eol", "lf"]);
    fs::write(repo.join("README.md"), "hi").unwrap();
    fs::write(repo.join(".env"), "SECRET=1").unwrap();
    fs::write(repo.join(".envrc"), "export X=1").unwrap();
    sh(&repo, &["add", "README.md"]);
    sh(&repo, &["commit", "-m", "init"]);
    sh(
        &repo,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    sh(&repo, &["push", "-u", "origin", "main"]);
    sh(&repo, &["remote", "set-head", "origin", "main"]);
    repo
}

struct Fixture {
    dir: PathBuf,
    conn: Connection,
    ws_root: PathBuf,
    repo: PathBuf,
}

impl Fixture {
    fn new() -> Option<Self> {
        if !git_available() {
            return None;
        }
        let dir = std::env::temp_dir().join(format!("ccode-ws-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let conn = db_at(&dir.join("app.db")).unwrap();
        let ws_root = dir.join("workspaces");
        let repo = setup_repo(&dir);
        Some(Self {
            dir,
            conn,
            ws_root,
            repo,
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // 先摘掉 worktree 再删目录，避免 git 元数据残留
        let _ = run_git(&self.repo, &["worktree", "prune"], Duration::from_secs(10));
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn sanitize_name_rules() {
    assert_eq!(sanitize_name("fix bug!").unwrap(), "fix-bug");
    assert_eq!(sanitize_name("feat-x").unwrap(), "feat-x");
    assert!(
        sanitize_name("我的").is_err(),
        "全非允许字符清洗后为空要拒绝"
    );
}

// ===== 上游漂移提醒（stale_upstream_for 纯逻辑） =====

fn ws_named(name: &str, created_at: &str, merged_at: Option<&str>) -> WorkspaceDto {
    WorkspaceDto {
        id: name.into(),
        repo_path: "/r".into(),
        repo_name: "r".into(),
        name: name.into(),
        branch: format!("ccode/{name}"),
        worktree_path: format!("/wt/{name}"),
        base_branch: "main".into(),
        port_base: 0,
        status: "active".into(),
        created_at: created_at.into(),
        archived_at: None,
        merged_at: merged_at.map(String::from),
        stale_upstream: None,
        setup_result: None,
        project_id: None,
    }
}

fn step(name: &str, workspace_name: &str) -> crate::projects::StepDto {
    crate::projects::StepDto {
        name: name.into(),
        workspace_name: workspace_name.into(),
        ..Default::default()
    }
}

#[test]
fn stale_upstream_rules() {
    let steps = vec![
        step("查文献", "lit"),
        step("做分析", "ana"),
        step("写论文", "write"),
    ];
    // 无上游：第一步永不标
    let ws = vec![
        ws_named("lit", "2026-08-01T00:00:00Z", Some("2026-08-02T00:00:00Z")),
        ws_named("ana", "2026-08-03T00:00:00Z", None),
    ];
    assert_eq!(stale_upstream_for(&steps, &ws, 0, &std::collections::HashMap::new()), None);
    // 上游合并早于本步推进（本步未合并，推进时间=创建时间）：新鲜
    assert_eq!(stale_upstream_for(&steps, &ws, 1, &std::collections::HashMap::new()), None);
    // 上游晚于本步创建发生合并 → 标出上游步骤名
    let ws = vec![
        ws_named("lit", "2026-08-01T00:00:00Z", Some("2026-08-05T00:00:00Z")),
        ws_named("ana", "2026-08-03T00:00:00Z", None),
    ];
    assert_eq!(
        stale_upstream_for(&steps, &ws, 1, &std::collections::HashMap::new()).as_deref(),
        Some("查文献")
    );
    // 人点过「跟进上游的新增」且晚于上游合并（跟进轮还没保存、或没有要跟进的）→ 不再报
    let mut followed = std::collections::HashMap::new();
    followed.insert(ws[1].id.clone(), "2026-08-05T00:00:00Z".to_string());
    assert_eq!(stale_upstream_for(&steps, &ws, 1, &followed), None);
    // 跟进记录早于上游这次合并：照报
    followed.insert(ws[1].id.clone(), "2026-08-03T12:00:00Z".to_string());
    assert_eq!(stale_upstream_for(&steps, &ws, 1, &followed).as_deref(), Some("查文献"));
    // 本步之后自己保存（merged_at 晚于上游合并）但没并入过：仍待跟进（2026-11-06：保存不算并入）
    let ws = vec![
        ws_named("lit", "2026-08-01T00:00:00Z", Some("2026-08-05T00:00:00Z")),
        ws_named("ana", "2026-08-03T00:00:00Z", Some("2026-08-06T00:00:00Z")),
    ];
    assert_eq!(
        stale_upstream_for(&steps, &ws, 1, &std::collections::HashMap::new()).as_deref(),
        Some("查文献")
    );
    // 并入过（晚于上游合并）→ 恢复新鲜
    let mut synced = std::collections::HashMap::new();
    synced.insert(ws[1].id.clone(), "2026-08-05T12:00:00Z".to_string());
    assert_eq!(stale_upstream_for(&steps, &ws, 1, &synced), None);
    // 多个上游时标最晚合并的那个；未合并/未建工作区的上游不参与
    let ws = vec![
        ws_named("lit", "2026-08-01T00:00:00Z", Some("2026-08-04T00:00:00Z")),
        ws_named("ana", "2026-08-01T00:00:00Z", Some("2026-08-05T00:00:00Z")),
        ws_named("write", "2026-08-03T00:00:00Z", None),
    ];
    assert_eq!(
        stale_upstream_for(&steps, &ws, 2, &std::collections::HashMap::new()).as_deref(),
        Some("做分析")
    );
    // 本步尚未创建工作区 / 步骤未绑定工作区名 → 不标
    assert_eq!(stale_upstream_for(&steps, &ws[..2], 2, &std::collections::HashMap::new()), None);
}

#[test]
fn repo_cache_hit_within_ttl_and_expired() {
    let t0 = Instant::now();
    let ttl = Duration::from_secs(60);
    let cached = Some((
        t0,
        vec![RepoDto {
            path: "/r".into(),
            name: "r".into(),
            last_active: None,
        }],
    ));
    // TTL 内命中，返回缓存副本
    let hit = repo_cache_hit(&cached, t0 + Duration::from_secs(59), ttl).unwrap();
    assert_eq!(hit.len(), 1);
    assert_eq!(hit[0].path, "/r");
    // 到期（含恰好在边界）视为过期 → None，走重扫
    assert!(repo_cache_hit(&cached, t0 + ttl, ttl).is_none());
    assert!(repo_cache_hit(&cached, t0 + Duration::from_secs(120), ttl).is_none());
    // 空缓存 → None
    assert!(repo_cache_hit(&None, t0, ttl).is_none());
    // 时钟回拨按过期处理，不命中也不 panic
    if let Some(earlier) = t0.checked_sub(Duration::from_secs(1)) {
        assert!(repo_cache_hit(&cached, earlier, ttl).is_none());
    }
}

#[test]
fn recent_repos_sort_by_latest_activity_then_name() {
    let mut repos = vec![
        RepoDto {
            path: "/older".into(),
            name: "zeta".into(),
            last_active: Some("2026-08-01T00:00:00Z".into()),
        },
        RepoDto {
            path: "/newer-b".into(),
            name: "Beta".into(),
            last_active: Some("2026-08-04T00:00:00Z".into()),
        },
        RepoDto {
            path: "/newer-a".into(),
            name: "alpha".into(),
            last_active: Some("2026-08-04T00:00:00Z".into()),
        },
    ];
    sort_recent_repos(&mut repos);
    assert_eq!(
        repos
            .iter()
            .map(|repo| repo.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/newer-a", "/newer-b", "/older"]
    );
}

#[test]
fn create_workspace_invalidates_repo_cache() {
    let Some(fx) = Fixture::new() else { return };
    *repo_cache().lock().unwrap() = Some((
        Instant::now(),
        vec![RepoDto {
            path: "/r".into(),
            name: "r".into(),
            last_active: None,
        }],
    ));
    create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "cache-inv",
    )
    .unwrap();
    assert!(
        repo_cache().lock().unwrap().is_none(),
        "create_workspace 成功后 list_repos 缓存必须失效"
    );
}

#[test]
fn same_name_branch_routes_by_owning_row_state() {
    let Some(fx) = Fixture::new() else { return };
    // ① 活动工作区占名：指路「继续/删除」，不再叫人换任务名
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "lit").unwrap();
    let err = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "lit").unwrap_err();
    assert!(err.contains("继续"), "活动工作区占名应指路：{err}");
    assert!(err.contains("删除"), "应说明可删掉旧轮再开：{err}");
    // ② 已归档且已合并：旧轮让位——行清掉、分支重建，新一轮照常创建
    fs::remove_dir_all(&w.worktree_path).unwrap();
    run_git(&fx.repo, &["worktree", "prune"], Duration::from_secs(30)).unwrap();
    fx.conn
        .execute(
            "UPDATE workspaces SET status='archived', archived_at='2026-10-13T00:00:00Z', merged_at='2026-10-13T00:00:00Z' WHERE id=?1",
            params![w.id],
        )
        .unwrap();
    let w2 = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "lit").unwrap();
    assert_ne!(w2.id, w.id);
    // ②' 恢复过（保留 merged_at）又提交、没保存就归档：分支尖不在基准里，不得删分支
    fs::write(Path::new(&w2.worktree_path).join("new.md"), "x").unwrap();
    sh(Path::new(&w2.worktree_path), &["add", "new.md"]);
    sh(Path::new(&w2.worktree_path), &["commit", "-m", "unsaved"]);
    fs::remove_dir_all(&w2.worktree_path).unwrap();
    run_git(&fx.repo, &["worktree", "prune"], Duration::from_secs(30)).unwrap();
    fx.conn
        .execute(
            "UPDATE workspaces SET status='archived', archived_at='2026-10-14T00:00:00Z', merged_at='2026-10-13T00:00:00Z' WHERE id=?1",
            params![w2.id],
        )
        .unwrap();
    let err = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "lit").unwrap_err();
    assert!(err.contains("没保存进项目的提交"), "{err}");
    assert!(
        run_git(&fx.repo, &["rev-parse", "--verify", "--quiet", "ccode/lit"], Duration::from_secs(10)).is_ok(),
        "有没保存提交的分支不得删"
    );
    assert!(
        query_workspaces(&fx.conn)
            .unwrap()
            .iter()
            .all(|x| x.id != w.id),
        "已合并归档的旧行应让位清掉"
    );
    // ③ 悬空分支（没有任何行引用）：清掉残留后照常创建
    run_git(&fx.repo, &["branch", "ccode/orphan"], Duration::from_secs(10)).unwrap();
    let w3 = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "orphan").unwrap();
    assert_eq!(w3.branch, "ccode/orphan");
}

#[test]
fn restored_round_with_new_commits_counts_as_unlanded() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "lit").unwrap();
    assert!(has_unlanded_workspace(&fx.conn, &fx.repo), "没合并的活动轮次是进行中");
    fx.conn
        .execute(
            "UPDATE workspaces SET merged_at='2026-11-05T00:00:00Z' WHERE id=?1",
            params![w.id],
        )
        .unwrap();
    assert!(!has_unlanded_workspace(&fx.conn, &fx.repo), "已合并保留且没新提交：已落地");
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("x.md"), "x").unwrap();
    sh(&wt, &["add", "x.md"]);
    sh(&wt, &["commit", "-m", "after restore"]);
    assert!(has_unlanded_workspace(&fx.conn, &fx.repo), "恢复后又提交：又是进行中");
}

#[test]
fn saved_worktree_requires_merged_and_not_ahead() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "rev").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    assert!(!saved_worktree(Some(&fx.conn), &wt), "没合并过不算已保存");
    fx.conn
        .execute(
            "UPDATE workspaces SET merged_at='2026-11-05T00:00:00Z' WHERE id=?1",
            params![w.id],
        )
        .unwrap();
    assert!(saved_worktree(Some(&fx.conn), &wt), "合并过且分支没前进 = 已保存");
    // 恢复后又提交：分支领先基准，裁决仍看工作区那份
    fs::write(wt.join("x.md"), "x").unwrap();
    sh(&wt, &["add", "x.md"]);
    sh(&wt, &["commit", "-m", "more"]);
    assert!(!saved_worktree(Some(&fx.conn), &wt));
    assert!(!saved_worktree(None, &wt));
}

#[test]
fn papers_dir_for_worktree_maps_active_worktree_to_repo_papers() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "lit").unwrap();
    // macOS /var ↔ /private/var 符号链接：按仓库约定用 ends_with 比路径
    let got = papers_dir_for_worktree_at(&fx.conn, &w.worktree_path).unwrap();
    assert!(Path::new(&got).ends_with("myrepo/papers"), "got {got}");
    // 非工作区路径（如讨论会话在项目根本身）不映射
    assert_eq!(
        papers_dir_for_worktree_at(&fx.conn, fx.repo.to_str().unwrap()),
        None
    );
}

#[test]
fn create_full_flow_then_duplicate_rejected() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "task one").unwrap();
    assert_eq!(w.name, "task-one");
    assert_eq!(w.branch, "ccode/task-one");
    assert_eq!(w.base_branch, "main");
    assert_eq!(w.repo_name, "myrepo");
    assert_eq!(w.status, "active");
    assert_eq!(w.port_base, 4000);
    assert!(Path::new(&w.worktree_path).join("README.md").exists());
    // files-to-copy 进了 worktree
    assert_eq!(
        fs::read_to_string(Path::new(&w.worktree_path).join(".env")).unwrap(),
        "SECRET=1"
    );
    assert!(Path::new(&w.worktree_path).join(".envrc").exists());
    assert!(Path::new(&w.worktree_path).join(".env.local").exists() == false);
    // 分支真实存在
    assert!(run_git(
        &fx.repo,
        &["rev-parse", "--verify", "--quiet", "ccode/task-one"],
        Duration::from_secs(10)
    )
    .is_ok());
    // 第二个工作区拿到下一段端口
    let w2 = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "two").unwrap();
    assert_eq!(w2.port_base, 4010);
    // 同名（同分支）拒绝
    let err =
        create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "task one").unwrap_err();
    assert!(err.contains("已存在"), "{err}");
}

/// git init 后的空仓库（unborn HEAD）：创建流程自动补空初始提交，
/// 分支名尊重 init.defaultBranch（master 形态），且临时身份不写入本地 config
#[test]
fn create_on_unborn_repo_bootstraps_initial_commit() {
    let Some(fx) = Fixture::new() else { return };
    let repo = fx.dir.join("empty-master");
    Command::new(git_bin())
        .args(["-c", "init.defaultBranch=master", "init"])
        .arg(&repo)
        .output()
        .unwrap();
    let w = create_impl(&fx.conn, &fx.ws_root, repo.to_str().unwrap(), "first").unwrap();
    assert_eq!(w.base_branch, "master");
    assert_eq!(w.branch, "ccode/first");
    assert_eq!(w.status, "active");
    assert!(Path::new(&w.worktree_path).exists());
    // 初始提交落在 master 上，HEAD 不再是 unborn
    assert_eq!(
        run_git(
            &repo,
            &["rev-parse", "--abbrev-ref", "HEAD"],
            Duration::from_secs(10)
        )
        .unwrap(),
        "master"
    );
    let subject = run_git(
        &repo,
        &["log", "--format=%s", "-1", "master"],
        Duration::from_secs(10),
    )
    .unwrap();
    assert!(subject.contains("初始化空仓库"), "{subject}");
    // 临时身份只注入本次提交，不得写入仓库本地 config
    assert!(
        run_git(
            &repo,
            &["config", "--local", "--get", "user.name"],
            Duration::from_secs(10)
        )
        .is_err(),
        "不得向本地 config 写 user.name"
    );
    assert!(
        run_git(
            &repo,
            &["config", "--local", "--get", "user.email"],
            Duration::from_secs(10)
        )
        .is_err(),
        "不得向本地 config 写 user.email"
    );
    // 补偿事务完整：同一仓库再起第二个工作区，端口段顺延
    let w2 = create_impl(&fx.conn, &fx.ws_root, repo.to_str().unwrap(), "second").unwrap();
    assert_eq!(w2.port_base, w.port_base + 10);
}

/// 空仓库已配置 user.name/email 时，初始提交沿用该身份，不注入 Mesa 临时身份
#[test]
fn create_on_unborn_repo_uses_configured_identity() {
    let Some(fx) = Fixture::new() else { return };
    let repo = fx.dir.join("empty-main");
    Command::new(git_bin())
        .args(["-c", "init.defaultBranch=main", "init"])
        .arg(&repo)
        .output()
        .unwrap();
    sh(&repo, &["config", "user.name", "Config User"]);
    sh(&repo, &["config", "user.email", "config@example.com"]);
    let w = create_impl(&fx.conn, &fx.ws_root, repo.to_str().unwrap(), "task").unwrap();
    assert_eq!(w.base_branch, "main");
    let author = run_git(
        &repo,
        &["log", "--format=%an <%ae>", "-1"],
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(author, "Config User <config@example.com>");
}

#[test]
fn create_copy_failure_rolls_back_row_worktree_branch_and_port() {
    let Some(fx) = Fixture::new() else { return };
    let err = create_impl_with_copy(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "copy-fail",
        |_src, _dest| Err(std::io::Error::other("forced copy failure")),
    )
    .unwrap_err();
    assert!(err.contains("复制配置文件 .env 失败"), "{err}");
    assert!(err.contains("已回滚"), "{err}");
    assert!(query_workspaces(&fx.conn).unwrap().is_empty());
    assert!(!fx.ws_root.join("myrepo/copy-fail").exists());
    assert!(
        run_git(
            &fx.repo,
            &["rev-parse", "--verify", "--quiet", "ccode/copy-fail"],
            Duration::from_secs(10),
        )
        .is_err(),
        "复制失败后不得残留任务分支"
    );
    let next = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "after-copy-fail",
    )
    .unwrap();
    assert_eq!(next.port_base, 4000, "回滚后应释放预留端口段");
}

#[test]
fn create_activation_failure_rolls_back_row_worktree_branch_and_port() {
    let Some(fx) = Fixture::new() else { return };
    fx.conn
        .execute_batch(
            "CREATE TRIGGER fail_workspace_activation
                 BEFORE UPDATE OF status ON workspaces
                 WHEN NEW.status='active'
                 BEGIN SELECT RAISE(FAIL, 'forced activation failure'); END;",
        )
        .unwrap();
    let err =
        create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "db-fail").unwrap_err();
    assert!(err.contains("激活工作区记录失败"), "{err}");
    assert!(err.contains("已回滚"), "{err}");
    assert!(query_workspaces(&fx.conn).unwrap().is_empty());
    assert!(!fx.ws_root.join("myrepo/db-fail").exists());
    assert!(
        run_git(
            &fx.repo,
            &["rev-parse", "--verify", "--quiet", "ccode/db-fail"],
            Duration::from_secs(10),
        )
        .is_err(),
        "数据库激活失败后不得残留任务分支"
    );
}

#[test]
fn create_rejects_files_to_copy_outside_repo() {
    let Some(fx) = Fixture::new() else { return };
    fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
    fs::write(
        fx.repo.join(".ccode/settings.toml"),
        "files_to_copy = [\"../outside\"]\n",
    )
    .unwrap();
    let err =
        create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "escape").unwrap_err();
    assert!(err.contains("仓库内相对路径"), "{err}");
    assert!(query_workspaces(&fx.conn).unwrap().is_empty());
    assert!(!fx.ws_root.join("myrepo/escape").exists());
}

#[cfg(unix)]
#[test]
fn create_refuses_symlink_escape_in_copy_dest_parent() {
    let Some(fx) = Fixture::new() else { return };
    // 仓库跟踪一个指向树外的符号链接，files_to_copy 引用链接内路径：
    // 复制若不检查会跟随符号链接把文件覆写到 worktree 外
    let outside = fx.dir.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("payload.env"), "ORIGINAL\n").unwrap();
    std::os::unix::fs::symlink(&outside, fx.repo.join("linked")).unwrap();
    sh(&fx.repo, &["add", "linked"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "add symlink"],
    );
    fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
    fs::write(
        fx.repo.join(".ccode/settings.toml"),
        "files_to_copy = [\"linked/payload.env\"]\n",
    )
    .unwrap();
    let err =
        create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "symlnk").unwrap_err();
    assert!(err.contains("符号链接"), "{err}");
    assert!(err.contains("已回滚"), "{err}");
    // 树外文件未被覆写，创建已整体回滚
    assert_eq!(
        fs::read_to_string(outside.join("payload.env")).unwrap(),
        "ORIGINAL\n"
    );
    assert!(query_workspaces(&fx.conn).unwrap().is_empty());
    assert!(!fx.ws_root.join("myrepo/symlnk").exists());
}

#[cfg(unix)]
#[test]
fn create_refuses_symlink_at_copy_dest_itself() {
    let Some(fx) = Fixture::new() else { return };
    // files_to_copy 的目标自身是仓库跟踪的符号链接（指向树外文件）
    let outside = fx.dir.join("outside-dst");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("target.env"), "ORIGINAL\n").unwrap();
    fs::remove_file(fx.repo.join(".env")).unwrap(); // fixture 预置的实体文件让位给符号链接
    std::os::unix::fs::symlink(outside.join("target.env"), fx.repo.join(".env")).unwrap();
    sh(&fx.repo, &["add", ".env"]);
    sh(
        &fx.repo,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "env as symlink",
        ],
    );
    let err =
        create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "dstsym").unwrap_err();
    assert!(err.contains("符号链接"), "{err}");
    assert_eq!(
        fs::read_to_string(outside.join("target.env")).unwrap(),
        "ORIGINAL\n"
    );
    assert!(query_workspaces(&fx.conn).unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn create_via_symlinked_repo_path_stores_canonical_repo_path() {
    let Some(fx) = Fixture::new() else { return };
    // 经符号链接路径创建工作区：落库的 repo_path 必须解析为 canonical 形式
    // （与 register_project 的 canonical_key 同口径），否则前端按路径字符串
    // 归组时工作区会掉出项目分组（macOS /var→/private/var 同理）
    let link = fx.dir.join("repo-link");
    std::os::unix::fs::symlink(&fx.repo, &link).unwrap();
    let w = create_impl(&fx.conn, &fx.ws_root, link.to_str().unwrap(), "canon").unwrap();
    let canonical = fs::canonicalize(&fx.repo).unwrap();
    assert_eq!(w.repo_path, canonical.to_string_lossy().as_ref());
    assert_ne!(w.repo_path, link.to_string_lossy().as_ref());
    // worktree 目录按 canonical 路径末段派生
    assert_eq!(w.repo_name, "myrepo");
}

#[test]
fn archive_restore_delete_lifecycle() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "life").unwrap();
    archive_impl(&fx.conn, &w.id).unwrap();
    let w = get_workspace(&fx.conn, &w.id).unwrap();
    assert_eq!(w.status, "archived");
    assert!(w.archived_at.is_some());
    assert!(
        !Path::new(&w.worktree_path).exists(),
        "归档后 worktree 目录应被移除"
    );
    // 分支保留，可恢复
    restore_impl(&fx.conn, &w.id).unwrap();
    let w = get_workspace(&fx.conn, &w.id).unwrap();
    assert_eq!(w.status, "active");
    assert!(w.archived_at.is_none());
    assert!(Path::new(&w.worktree_path).exists());
    // 删除：分支与行都没了
    delete_impl(&fx.conn, &w.id).unwrap();
    assert!(run_git(
        &fx.repo,
        &["rev-parse", "--verify", "--quiet", "ccode/life"],
        Duration::from_secs(10)
    )
    .is_err());
    assert!(get_workspace(&fx.conn, &w.id).is_err());
}

#[test]
fn archive_refuses_uncommitted_changes_without_force() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "dirty-archive",
    )
    .unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("keep-me.txt"), "important\n").unwrap();
    let err = archive_impl(&fx.conn, &w.id).unwrap_err();
    assert!(err.contains("未提交改动"), "{err}");
    assert_eq!(
        fs::read_to_string(wt.join("keep-me.txt")).unwrap(),
        "important\n"
    );
    assert_eq!(get_workspace(&fx.conn, &w.id).unwrap().status, "active");
}

#[test]
fn archive_tolerates_already_gone_worktree() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "gone").unwrap();
    fs::remove_dir_all(&w.worktree_path).unwrap();
    run_git(&fx.repo, &["worktree", "prune"], Duration::from_secs(10)).unwrap();
    archive_impl(&fx.conn, &w.id).unwrap();
    assert_eq!(get_workspace(&fx.conn, &w.id).unwrap().status, "archived");
}

#[test]
fn workspace_env_block_from_port_base() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "envs").unwrap();
    let env = workspace_env_impl(&fx.conn, &w.worktree_path);
    assert_eq!(env.len(), 10);
    assert_eq!(env[0], ("CCODE_PORT".to_string(), "4000".to_string()));
    assert_eq!(env[9], ("CCODE_PORT_9".to_string(), "4009".to_string()));
    assert!(workspace_env_impl(&fx.conn, "/nonexistent").is_empty());
    // 归档后不再占用端口段，不下发端口 env
    archive_impl(&fx.conn, &w.id).unwrap();
    assert!(
        workspace_env_impl(&fx.conn, &w.worktree_path).is_empty(),
        "归档工作区不得再返回端口 env"
    );
}

#[test]
fn port_blocks_reuse_freed_slots() {
    let Some(fx) = Fixture::new() else { return };
    let a = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "a").unwrap();
    let b = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "b").unwrap();
    assert_eq!((a.port_base, b.port_base), (4000, 4010));
    // a 归档后其端口块释放，新工作区复用最低空闲块
    archive_impl(&fx.conn, &a.id).unwrap();
    let c = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "c").unwrap();
    assert_eq!(c.port_base, 4000);
}

#[test]
fn create_rejects_non_repo() {
    let Some(fx) = Fixture::new() else { return };
    let err = create_impl(&fx.conn, &fx.ws_root, fx.dir.to_str().unwrap(), "x").unwrap_err();
    assert!(err.contains("不是 git 仓库"), "{err}");
}

/// 复刻真实用户仓库形态：默认分支 master、origin/HEAD 未设置
fn setup_master_repo(dir: &Path) -> PathBuf {
    let origin = dir.join("origin.git");
    let repo = dir.join("masterrepo");
    Command::new(git_bin())
        .args(["init", "--bare"])
        .arg(&origin)
        .output()
        .unwrap();
    Command::new(git_bin())
        .args(["-c", "init.defaultBranch=master", "init"])
        .arg(&repo)
        .output()
        .unwrap();
    sh(&repo, &["config", "user.email", "t@t"]);
    sh(&repo, &["config", "user.name", "t"]);
    // 与宿主 git 配置解耦：Windows 上 core.autocrlf 默认 true（Git for Windows 装机默认），
    // checkout 会把 LF 转成 CRLF，断言文件内容的用例会莫名其妙对不上（"done\r\n" != "done\n"）。
    sh(&repo, &["config", "core.autocrlf", "false"]);
    sh(&repo, &["config", "core.eol", "lf"]);
    fs::write(repo.join("README.md"), "hi").unwrap();
    sh(&repo, &["add", "README.md"]);
    sh(&repo, &["commit", "-m", "init"]);
    sh(
        &repo,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    sh(&repo, &["push", "-u", "origin", "master"]);
    // 故意不 set-head：origin/HEAD 不存在
    repo
}

#[test]
fn master_repo_without_origin_head_uses_master_base() {
    if !git_available() {
        return;
    }
    let dir = std::env::temp_dir().join(format!("ccode-ws-master-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let conn = db_at(&dir.join("app.db")).unwrap();
    let ws_root = dir.join("workspaces");
    let repo = setup_master_repo(&dir);

    assert_eq!(detect_base_branch(&repo), "master");
    // 本地未推送的提交：工作区必须带上（从本地基准拉，不用 origin）
    fs::write(repo.join("local-only.txt"), "unpushed").unwrap();
    sh(&repo, &["add", "local-only.txt"]);
    sh(&repo, &["commit", "-m", "local only"]);
    let w = create_impl(&conn, &ws_root, repo.to_str().unwrap(), "on-master").unwrap();
    assert_eq!(w.base_branch, "master");
    assert_eq!(w.branch, "ccode/on-master");
    assert!(Path::new(&w.worktree_path).join("README.md").exists());
    assert!(
        Path::new(&w.worktree_path).join("local-only.txt").exists(),
        "未推送的本地提交必须出现在工作区"
    );
    // worktree 从本地 master 拉出（此时领先 origin/master 一个提交）
    let start = run_git(
        &repo,
        &["rev-parse", "ccode/on-master"],
        Duration::from_secs(10),
    )
    .unwrap();
    let local = run_git(&repo, &["rev-parse", "master"], Duration::from_secs(10)).unwrap();
    let origin = run_git(
        &repo,
        &["rev-parse", "origin/master"],
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(start, local);
    assert_ne!(start, origin);

    let _ = delete_impl(&conn, &w.id);
    let _ = run_git(&repo, &["worktree", "prune"], Duration::from_secs(10));
    let _ = fs::remove_dir_all(&dir);
}

// ===== W2：项目级脚本钩子 =====

// 脚本体是 POSIX 语法：Windows 上 shell_cmd 走 Git Bash（与生产同一条路），三平台同一份用例
#[test]
fn create_runs_setup_script_and_custom_files_to_copy() {
    let Some(fx) = Fixture::new() else { return };
    fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
    fs::write(
        fx.repo.join(".ccode/settings.toml"),
        "files_to_copy = [\".env\"]\n[scripts]\nsetup = \"echo ran > setup-mark.txt && echo port=$CCODE_PORT\"\n",
    )
    .unwrap();
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "hooked").unwrap();
    let res = w.setup_result.as_ref().expect("setup 结果应记录进 DTO");
    assert!(res.ok, "setup 输出: {}", res.output_tail);
    assert!(
        res.output_tail.contains("port=4000"),
        "脚本应拿到端口段 env: {}",
        res.output_tail
    );
    assert_eq!(
        fs::read_to_string(Path::new(&w.worktree_path).join("setup-mark.txt"))
            .unwrap()
            .trim(),
        "ran"
    );
    // 自定义 files_to_copy 生效：只复制 .env，不再复制 .envrc
    assert!(Path::new(&w.worktree_path).join(".env").exists());
    assert!(!Path::new(&w.worktree_path).join(".envrc").exists());
}

#[test]
fn create_survives_setup_failure() {
    let Some(fx) = Fixture::new() else { return };
    fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
    fs::write(
        fx.repo.join(".ccode/settings.toml"),
        "[scripts]\nsetup = \"echo boom >&2 && exit 1\"\n",
    )
    .unwrap();
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "failsetup",
    )
    .unwrap();
    let res = w.setup_result.as_ref().unwrap();
    assert!(!res.ok, "exit 1 的 setup 应记录为失败");
    assert!(
        res.output_tail.contains("boom"),
        "stderr 尾部应保留: {}",
        res.output_tail
    );
    // 失败不阻断创建
    assert_eq!(w.status, "active");
    assert!(Path::new(&w.worktree_path).exists());
}

// 脚本体是 POSIX 语法：Windows 上 shell_cmd 走 Git Bash（与生产同一条路），三平台同一份用例
#[test]
fn archive_script_failure_blocks_removal() {
    let Some(fx) = Fixture::new() else { return };
    let marker = fx.dir.join("archived-mark");
    fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
    fs::write(
        fx.repo.join(".ccode/settings.toml"),
        "[scripts]\narchive = \"exit 1\"\n",
    )
    .unwrap();
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "blockarc").unwrap();
    let err = archive_impl(&fx.conn, &w.id).unwrap_err();
    assert!(err.contains("archive 脚本执行失败"), "{err}");
    assert!(
        Path::new(&w.worktree_path).exists(),
        "脚本失败时 worktree 不得移除"
    );
    assert_eq!(get_workspace(&fx.conn, &w.id).unwrap().status, "active");
    // 脚本改成成功后归档照常（路径写正斜杠、TOML 字面量串：Windows 路径的反斜杠在 TOML 基本串与 bash 里都是转义）
    fs::write(
        fx.repo.join(".ccode/settings.toml"),
        &format!(
            "[scripts]\narchive = 'touch \"{}\"'\n",
            marker.to_string_lossy().replace('\\', "/")
        ),
    )
    .unwrap();
    archive_impl(&fx.conn, &w.id).unwrap();
    assert!(!Path::new(&w.worktree_path).exists());
    assert!(marker.exists(), "archive 脚本应在移除前执行");
    assert_eq!(get_workspace(&fx.conn, &w.id).unwrap().status, "archived");
}

#[test]
fn no_settings_repo_keeps_w1_behavior() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "plain").unwrap();
    assert!(
        w.setup_result.is_none(),
        "无 setup 脚本时 setup_result 为 None"
    );
    // 固定清单仍然生效
    assert!(Path::new(&w.worktree_path).join(".env").exists());
    assert!(Path::new(&w.worktree_path).join(".envrc").exists());
}

// ===== W3：评审与合并 =====

/// 把 worktree 里的全部改动（含复制进来的 .env*）提交掉，返回提交数基准外的 ahead=1
fn commit_all_in_worktree(wt: &Path, msg: &str) {
    sh(wt, &["add", "-A"]);
    sh(wt, &["-c", "commit.gpgsign=false", "commit", "-m", msg]);
}

#[test]
fn health_ready_then_dirty_then_conflicting() {
    let Some(fx) = Fixture::new() else { return };
    // 主仓库保持干净（把 fixture 里未跟踪的 .env* 提交掉，否则 main_dirty 不 ready）
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "health").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("feature.txt"), "v1\n").unwrap();
    commit_all_in_worktree(&wt, "任务改动");
    let h = health_impl(&fx.conn, &w.id).unwrap();
    assert!(!h.uncommitted);
    assert!(!h.main_dirty && !h.main_off_base);
    assert_eq!(h.ahead, 1);
    assert_eq!(h.behind, 0);
    assert_eq!(
        h.conflict,
        Some(false),
        "merge-tree 探测应为干净（git 2.55）"
    );
    assert!(h.ready_to_merge);
    // 主仓库未提交改动 → 不再 ready（删文件恢复干净，不影响后面 behind 计数）
    fs::write(fx.repo.join("main-dirty.txt"), "x\n").unwrap();
    let h = health_impl(&fx.conn, &w.id).unwrap();
    assert!(h.main_dirty);
    assert!(!h.ready_to_merge);
    fs::remove_file(fx.repo.join("main-dirty.txt")).unwrap();
    // 未提交改动 → 不再 ready
    fs::write(wt.join("feature.txt"), "v2\n").unwrap();
    let h = health_impl(&fx.conn, &w.id).unwrap();
    assert!(h.uncommitted);
    assert!(!h.ready_to_merge);
    commit_all_in_worktree(&wt, "v2");
    // 主仓库推进同一文件的同一行并推到 origin → behind + 冲突探测命中
    fs::write(fx.repo.join("feature.txt"), "main 版本\n").unwrap();
    sh(&fx.repo, &["add", "feature.txt"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "主线改动"],
    );
    sh(&fx.repo, &["push", "origin", "main"]);
    let h = health_impl(&fx.conn, &w.id).unwrap();
    assert_eq!(h.behind, 1);
    assert_eq!(h.conflict, Some(true), "同一文件同一行应探出冲突");
    assert_eq!(h.conflict_files, vec!["feature.txt".to_string()]);
    assert!(!h.ready_to_merge);
}

#[test]
fn empty_workspace_is_not_ready_to_merge() {
    let Some(fx) = Fixture::new() else { return };
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "empty").unwrap();
    let health = health_impl(&fx.conn, &w.id).unwrap();
    assert_eq!(health.ahead, 0);
    assert!(!health.uncommitted);
    assert_eq!(health.conflict, Some(false));
    assert!(!health.ready_to_merge, "空工作区不得启用合并");
}

#[test]
fn health_marks_stale_base_when_base_advanced_during_conflict() {
    let Some(fx) = Fixture::new() else { return };
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "stale").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("feature.txt"), "branch\n").unwrap();
    commit_all_in_worktree(&wt, "分支改动");
    fs::write(fx.repo.join("feature.txt"), "main v1\n").unwrap();
    sh(&fx.repo, &["add", "feature.txt"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "主线 v1"],
    );
    // 未在 merge 中：stale_base 恒 false
    assert!(!health_impl(&fx.conn, &w.id).unwrap().stale_base);
    // 开始并入 → 冲突，MERGE_HEAD = 当前基准 tip
    assert!(
        run_git(&wt, &["merge", "main"], Duration::from_secs(60)).is_err(),
        "应产生冲突"
    );
    assert!(
        !health_impl(&fx.conn, &w.id).unwrap().stale_base,
        "MERGE_HEAD 与基准 tip 一致不算落后"
    );
    // 基准继续前进 → 冲突现场落后
    fs::write(fx.repo.join("other.txt"), "v2\n").unwrap();
    sh(&fx.repo, &["add", "other.txt"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "主线 v2"],
    );
    let h = health_impl(&fx.conn, &w.id).unwrap();
    assert!(
        h.stale_base,
        "基准已前进：MERGE_HEAD ≠ tip 应标记 stale_base"
    );
}

#[test]
fn pending_artifact_checks_reports_only_fresh_and_complete() {
    let Some(fx) = Fixture::new() else { return };
    // 步骤绑定工作区 art，预期产物 = 一个文件 + 一个目录
    fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
    fs::write(
        fx.repo.join(".ccode/project.toml"),
        "[[steps]]\nname = \"出图\"\nworkspace_name = \"art\"\nexpected_artifacts = [\"out/result.txt\", \"figs/\"]\n",
    )
    .unwrap();
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "art").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    // 未产出 → 不报
    assert!(pending_artifact_checks_impl(&fx.conn).is_empty());
    // 只产出一半（目录产物还缺）→ 不报
    fs::create_dir_all(wt.join("out")).unwrap();
    fs::write(wt.join("out/result.txt"), "new\n").unwrap();
    assert!(pending_artifact_checks_impl(&fx.conn).is_empty());
    // 目录产物补一个文件 → 全部备齐 → 报
    fs::create_dir_all(wt.join("figs")).unwrap();
    fs::write(wt.join("figs/a.png"), b"png").unwrap();
    let hits = pending_artifact_checks_impl(&fx.conn);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].workspace_id, w.id);
    // 产物 mtime 早于工作区创建 → 不算本任务产出（防 files-to-copy/旧文件误报）
    let f = fs::File::options()
        .write(true)
        .open(wt.join("out/result.txt"))
        .unwrap();
    f.set_modified(SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
    assert!(pending_artifact_checks_impl(&fx.conn).is_empty());
    // 无绑定步骤的工作区永不报
    let _plain =
        create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "plain2").unwrap();
    assert!(pending_artifact_checks_impl(&fx.conn).is_empty());
}

#[test]
fn resolve_flow_sync_conflict_pick_side_finish() {
    let Some(fx) = Fixture::new() else { return };
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "resolve").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    // 分支改 feature.txt 并提交；main 改同一行 → 并入冲突
    fs::write(wt.join("feature.txt"), "branch\n").unwrap();
    commit_all_in_worktree(&wt, "分支改动");
    fs::write(fx.repo.join("feature.txt"), "main\n").unwrap();
    sh(&fx.repo, &["add", "feature.txt"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "主线改动"],
    );
    assert!(
        run_git(&wt, &["merge", "main"], Duration::from_secs(60)).is_err(),
        "应产生冲突"
    );
    // 未解决清单；未解决前拒绝 finish
    let st = unmerged_impl(&wt).unwrap();
    assert!(st.merging);
    assert_eq!(st.files, vec!["feature.txt".to_string()]);
    let drift = workspace_drift_impl(&fx.conn, &w.id).unwrap();
    assert!(drift.can_resolve_merge);
    assert!(drift
        .issues
        .iter()
        .any(|issue| issue.code == "merge_in_progress"));
    let content = conflict_content_impl(&wt, "feature.txt").unwrap();
    assert_eq!(content.ours.as_deref(), Some("branch\n"));
    assert_eq!(content.theirs.as_deref(), Some("main\n"));
    assert!(content.diff.contains("-branch"));
    assert!(content.diff.contains("+main"));
    let archive_err = archive_impl(&fx.conn, &w.id).unwrap_err();
    assert!(archive_err.contains("合并或冲突"), "{archive_err}");
    assert!(wt.exists(), "冲突未解决时归档不得移除工作树");
    assert!(finish_merge_impl(&wt).unwrap_err().contains("未解决"));
    // 选分支版（ours）→ 清单清空，文件内容是分支版（Windows 上 checkout 落盘为 CRLF，断言归一化）
    let st = resolve_file_impl(&wt, "feature.txt", "ours").unwrap();
    assert!(st.files.is_empty());
    assert_eq!(
        fs::read_to_string(wt.join("feature.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "branch\n"
    );
    // finish → merge 提交完成，健康检查通过后可直接合入主仓库
    finish_merge_impl(&wt).unwrap();
    assert!(!unmerged_impl(&wt).unwrap().merging);
    let (conflict, _) = conflict_probe(&wt, "main", "HEAD");
    assert_eq!(conflict, Some(false));
    assert!(health_impl(&fx.conn, &w.id).unwrap().ready_to_merge);
    merge_impl(&fx.conn, &w.id, false).unwrap();
    let merged = get_workspace(&fx.conn, &w.id).unwrap();
    assert!(merged.merged_at.is_some());
    assert_eq!(health_impl(&fx.conn, &w.id).unwrap().ahead, 0);
}

#[test]
fn conflict_sync_uses_main_after_another_workspace_was_merged() {
    let Some(fx) = Fixture::new() else { return };
    fs::write(fx.repo.join("feature.txt"), "base\n").unwrap();
    sh(&fx.repo, &["add", ".env", ".envrc", "feature.txt"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "base"],
    );
    let w1 = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "one").unwrap();
    let w2 = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "two").unwrap();
    let wt1 = PathBuf::from(&w1.worktree_path);
    let wt2 = PathBuf::from(&w2.worktree_path);

    fs::write(wt1.join("feature.txt"), "workspace-one\n").unwrap();
    commit_all_in_worktree(&wt1, "工作区 1 改动");
    fs::write(wt2.join("feature.txt"), "workspace-two\n").unwrap();
    commit_all_in_worktree(&wt2, "工作区 2 改动");

    merge_impl(&fx.conn, &w1.id, false).unwrap();
    // Windows 上 checkout 落盘为 CRLF，断言归一化
    assert_eq!(
        fs::read_to_string(fx.repo.join("feature.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "workspace-one\n"
    );
    assert_eq!(health_impl(&fx.conn, &w2.id).unwrap().conflict, Some(true));

    assert!(sync_base_impl(&wt2, "main", false).is_err());
    let state = unmerged_with_base(&wt2, "main").unwrap();
    assert!(state.merging);
    assert!(!state.stale_base);
    assert_eq!(state.files, vec!["feature.txt".to_string()]);
    assert_eq!(
        conflict_content_impl(&wt2, "feature.txt")
            .unwrap()
            .theirs
            .as_deref(),
        Some("workspace-one\n"),
        "基准侧必须是工作区 1 合并后的最新 main，而不是工作区 2 创建时的旧内容"
    );
}

#[test]
fn incoming_lists_files_base_changed_since_branching() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "incoming").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    assert!(incoming_impl(&wt, "main").unwrap().is_empty(), "刚开出来没有要并的");
    // 分支自己改的不算；基准侧新提交的算
    fs::write(wt.join("mine.txt"), "branch\n").unwrap();
    commit_all_in_worktree(&wt, "分支改动");
    fs::write(fx.repo.join("outline.md"), "# 大纲\n").unwrap();
    sh(&fx.repo, &["add", "outline.md"]);
    sh(&fx.repo, &["-c", "commit.gpgsign=false", "commit", "-m", "大纲"]);
    assert_eq!(incoming_impl(&wt, "main").unwrap(), vec!["outline.md".to_string()]);
    sync_base_impl(&wt, "main", false).unwrap();
    assert!(incoming_impl(&wt, "main").unwrap().is_empty(), "并入后清空");
}

#[test]
fn stale_conflict_restarts_against_latest_base() {
    let Some(fx) = Fixture::new() else { return };
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "stale").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("feature.txt"), "branch\n").unwrap();
    commit_all_in_worktree(&wt, "分支改动");

    fs::write(fx.repo.join("feature.txt"), "main-v1\n").unwrap();
    sh(&fx.repo, &["add", "feature.txt"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "main v1"],
    );
    assert!(sync_base_impl(&wt, "main", false).is_err());
    assert!(!unmerged_with_base(&wt, "main").unwrap().stale_base);
    assert_eq!(
        conflict_content_impl(&wt, "feature.txt")
            .unwrap()
            .theirs
            .as_deref(),
        Some("main-v1\n")
    );

    fs::write(fx.repo.join("feature.txt"), "main-v2\n").unwrap();
    sh(&fx.repo, &["add", "feature.txt"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "main v2"],
    );
    assert!(unmerged_with_base(&wt, "main").unwrap().stale_base);

    assert!(sync_base_impl(&wt, "main", true).is_err());
    assert!(!unmerged_with_base(&wt, "main").unwrap().stale_base);
    assert_eq!(
        conflict_content_impl(&wt, "feature.txt")
            .unwrap()
            .theirs
            .as_deref(),
        Some("main-v2\n")
    );
}

#[test]
fn path_context_classifies_worktree_main_and_other() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "ctx").unwrap();
    let w2 = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "ctx2").unwrap();
    // 工作树内 → worktree（带工作区名与分支）；siblings = 同仓库其他活跃工作区
    let wt_readme = PathBuf::from(&w.worktree_path).join("README.md");
    let c = path_context_impl(&fx.conn, wt_readme.to_str().unwrap()).unwrap();
    assert_eq!(c.kind, "worktree");
    assert_eq!(c.workspace_name.as_deref(), Some("ctx"));
    assert_eq!(c.branch.as_deref(), Some("ccode/ctx"));
    assert_eq!(c.siblings.len(), 1);
    assert_eq!(c.siblings[0].workspace_name, "ctx2");
    // 还不存在的新文件同样命中（父目录 canonicalize，口径与根一致——Windows 曾因
    // 目标保持普通形式、根是 verbatim 而落成 other）
    let new_file = PathBuf::from(&w.worktree_path).join("notes").join("new.md");
    let c = path_context_impl(&fx.conn, new_file.to_str().unwrap()).unwrap();
    assert_eq!(c.kind, "worktree", "不存在的目标也要按工作树归类");
    let new_top = PathBuf::from(&w.worktree_path).join("draft.md");
    let c = path_context_impl(&fx.conn, new_top.to_str().unwrap()).unwrap();
    assert_eq!(c.kind, "worktree");
    #[cfg(windows)]
    {
        // 大小写不同 / verbatim 写法都是同一目录
        let upper = wt_readme.to_string_lossy().to_uppercase();
        assert_eq!(path_context_impl(&fx.conn, &upper).unwrap().kind, "worktree");
        let verbatim = format!(r"\\?\{}", wt_readme.to_string_lossy());
        assert_eq!(path_context_impl(&fx.conn, &verbatim).unwrap().kind, "worktree");
    }
    // 主仓库内 → main（分支给的是基准分支）；siblings = 全部活跃工作区
    let c = path_context_impl(&fx.conn, fx.repo.join("README.md").to_str().unwrap()).unwrap();
    assert_eq!(c.kind, "main");
    assert_eq!(c.branch.as_deref(), Some("main"));
    assert_eq!(c.siblings.len(), 2);
    // 不相关路径 → other；归档后不再命中
    let c = path_context_impl(&fx.conn, "/tmp").unwrap();
    assert_eq!(c.kind, "other");
    archive_impl(&fx.conn, &w.id).unwrap();
    archive_impl(&fx.conn, &w2.id).unwrap();
    let c = path_context_impl(&fx.conn, fx.repo.join("README.md").to_str().unwrap()).unwrap();
    assert_eq!(c.kind, "other", "已归档工作区的主仓库不再标记");
}

#[test]
fn drift_detects_missing_worktree_and_remount_repairs_it() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "drift-remount",
    )
    .unwrap();
    sh(
        &fx.repo,
        &["worktree", "remove", "--force", &w.worktree_path],
    );
    let drift = workspace_drift_impl(&fx.conn, &w.id).unwrap();
    assert!(!drift.healthy);
    assert!(drift.can_remount);
    assert!(drift
        .issues
        .iter()
        .any(|issue| issue.code == "worktree_missing"));

    let repaired = repair_remount_impl(&fx.conn, &w.id).unwrap();
    assert_eq!(repaired.status, "active");
    assert!(Path::new(&repaired.worktree_path).is_dir());
    assert!(workspace_drift_impl(&fx.conn, &w.id).unwrap().healthy);
}

#[test]
fn drift_relocates_moved_repository_without_losing_archived_branch() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "drift-move",
    )
    .unwrap();
    archive_impl(&fx.conn, &w.id).unwrap();
    let moved = fx.dir.join("moved-repo");
    fs::rename(&fx.repo, &moved).unwrap();
    let drift = workspace_drift_impl(&fx.conn, &w.id).unwrap();
    assert!(drift.can_relocate);
    assert!(drift
        .issues
        .iter()
        .any(|issue| issue.code == "repo_missing"));

    let relocated = relocate_repo_impl(&fx.conn, &w.id, moved.to_str().unwrap()).unwrap();
    assert_eq!(relocated.repo_path, moved.to_string_lossy());
    assert_eq!(relocated.status, "archived");
    assert!(workspace_drift_impl(&fx.conn, &w.id).unwrap().healthy);
}

#[test]
fn drift_detects_archived_record_with_live_worktree_and_reactivates() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "drift-mismatch",
    )
    .unwrap();
    fx.conn
        .execute(
            "UPDATE workspaces SET status='archived' WHERE id=?1",
            params![w.id],
        )
        .unwrap();
    let drift = workspace_drift_impl(&fx.conn, &w.id).unwrap();
    assert!(drift
        .issues
        .iter()
        .any(|issue| issue.code == "archived_worktree_present"));
    assert!(drift.can_remount);
    let repaired = repair_remount_impl(&fx.conn, &w.id).unwrap();
    assert_eq!(repaired.status, "active");
    assert!(workspace_drift_impl(&fx.conn, &w.id).unwrap().healthy);
}

#[test]
fn drift_detects_missing_archived_branch() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "drift-branch",
    )
    .unwrap();
    archive_impl(&fx.conn, &w.id).unwrap();
    sh(&fx.repo, &["branch", "-D", &w.branch]);
    let drift = workspace_drift_impl(&fx.conn, &w.id).unwrap();
    assert!(drift
        .issues
        .iter()
        .any(|issue| issue.code == "branch_missing"));
    assert!(!drift.can_remount);
    assert!(drift.can_clean_record);
}

#[test]
fn merge_workspace_happy_path_merges_and_archives() {
    let Some(fx) = Fixture::new() else { return };
    // 主仓库保持干净（把 fixture 里未跟踪的 .env* 提交掉）
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "mergeme").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("feature.txt"), "done\n").unwrap();
    commit_all_in_worktree(&wt, "任务完成");
    let out = merge_impl(&fx.conn, &w.id, true).unwrap();
    assert!(out.merged && out.archived);
    assert!(out.output.contains("已合并并归档"), "{}", out.output);
    // 改动进了主仓库的 main
    assert_eq!(
        fs::read_to_string(fx.repo.join("feature.txt")).unwrap(),
        "done\n"
    );
    // 工作区已归档、worktree 已移除
    let w2 = get_workspace(&fx.conn, &w.id).unwrap();
    assert_eq!(w2.status, "archived");
    assert!(!wt.exists());
}

#[test]
fn merge_success_archive_failure_is_reported_as_partial() {
    let Some(fx) = Fixture::new() else { return };
    fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
    fs::write(
        fx.repo.join(".ccode/settings.toml"),
        "[scripts]\narchive = \"exit 1\"\n",
    )
    .unwrap();
    sh(&fx.repo, &["add", ".env", ".envrc", ".ccode/settings.toml"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "settings"],
    );
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "partial-archive",
    )
    .unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("feature.txt"), "done\n").unwrap();
    commit_all_in_worktree(&wt, "任务完成");

    let result = merge_impl(&fx.conn, &w.id, true).unwrap();
    assert!(result.merged);
    assert!(!result.archived);
    assert_eq!(result.failed_phase.as_deref(), Some("archive"));
    assert!(result.message.contains("代码已合并"));
    assert!(wt.exists(), "归档失败必须保留工作树");
    let saved = get_workspace(&fx.conn, &w.id).unwrap();
    assert_eq!(saved.status, "active");
    assert!(saved.merged_at.is_some());
    assert_eq!(
        fs::read_to_string(fx.repo.join("feature.txt")).unwrap(),
        "done\n"
    );
}

#[test]
fn merge_without_archive_keeps_workspace_active() {
    let Some(fx) = Fixture::new() else { return };
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "keepme").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("feature.txt"), "done\n").unwrap();
    commit_all_in_worktree(&wt, "任务完成");
    let out = merge_impl(&fx.conn, &w.id, false).unwrap();
    assert!(out.merged && !out.archived);
    assert!(out.output.contains("工作区保留"), "{}", out.output);
    // 改动进了 main，但工作区仍活跃、worktree 还在，merged_at 已置位
    assert_eq!(
        fs::read_to_string(fx.repo.join("feature.txt")).unwrap(),
        "done\n"
    );
    let w2 = get_workspace(&fx.conn, &w.id).unwrap();
    assert_eq!(w2.status, "active");
    assert!(w2.merged_at.is_some(), "只合并应记录 merged_at");
    assert!(wt.exists());
    // 之后「合并并归档」：merge 变 no-op，归档照常发生
    let out = merge_impl(&fx.conn, &w.id, true).unwrap();
    assert!(out.archived);
    assert!(out.output.contains("已合并并归档"), "{}", out.output);
    assert!(!wt.exists());
}

#[test]
fn merge_pending_replay_never_merges_new_work_or_changes_original_version() {
    let Some(fx) = Fixture::new() else { return };
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "ledger-replay",
    )
    .unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("first.txt"), "accepted").unwrap();
    commit_all_in_worktree(&wt, "first");
    // 让文件合并成功、账本写入失败；空目录不会污染 git status。
    let blocked = fx.repo.join(".ccode/acceptance-log.jsonl");
    fs::create_dir_all(&blocked).unwrap();
    let first = merge_impl(&fx.conn, &w.id, true).unwrap();
    assert!(first.merged && !first.ledger_written && !first.archived);
    assert!(wt.exists(), "补账前不得归档掉工作区");
    assert!(
        health_impl(&fx.conn, &w.id).unwrap().ledger_pending,
        "重新打开评审也必须看见补账待办"
    );
    fs::remove_dir(&blocked).unwrap();
    fs::write(fx.repo.join("other.txt"), "other work").unwrap();
    commit_all_in_worktree(&fx.repo, "another main commit");
    let main_before_retry =
        run_git(&fx.repo, &["rev-parse", "HEAD"], Duration::from_secs(10)).unwrap();
    fs::write(wt.join("new.txt"), "not reviewed yet").unwrap();
    commit_all_in_worktree(&wt, "next version");
    let retried =
        merge_impl_with_guard(&fx.conn, &w.id, false, &|_| Ok(()), None, None).unwrap();
    assert_eq!(retried.version_id, first.version_id);
    assert!(retried.ledger_written);
    assert!(!health_impl(&fx.conn, &w.id).unwrap().ledger_pending);
    assert!(!fx.repo.join("new.txt").exists(), "补账不能顺便合并下一版");
    assert_eq!(
        run_git(&fx.repo, &["rev-parse", "HEAD"], Duration::from_secs(10)).unwrap(),
        main_before_retry
    );
    let ledger = crate::projects::read_acceptance_log_at(&fx.repo);
    assert_eq!(ledger.len(), 1);
    assert_eq!(Some(&ledger[0].version_id), first.version_id.as_ref());
    assert!(
        merge_impl_with_guard(&fx.conn, &w.id, false, &|_| Ok(()), None, None)
            .unwrap_err()
            .contains("评审")
    );
    // 用户确实看过下一版后，才允许新一次合并。
    let next = merge_impl(&fx.conn, &w.id, false).unwrap();
    assert!(next.merged && next.ledger_written);
    assert!(fx.repo.join("new.txt").exists());
    assert_eq!(crate::projects::read_acceptance_log_at(&fx.repo).len(), 2);
}

#[test]
fn final_merge_conflict_is_aborted_in_main_repo() {
    let Some(fx) = Fixture::new() else { return };
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "abort-main",
    )
    .unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("README.md"), "branch\n").unwrap();
    commit_all_in_worktree(&wt, "branch change");
    fs::write(fx.repo.join("README.md"), "main\n").unwrap();
    sh(&fx.repo, &["add", "README.md"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "main change"],
    );

    let err = merge_impl(&fx.conn, &w.id, false).unwrap_err();
    assert!(err.contains("已自动回退"), "{err}");
    assert!(run_git(
        &fx.repo,
        &["rev-parse", "--verify", "-q", "MERGE_HEAD"],
        Duration::from_secs(10)
    )
    .is_err());
    assert!(run_git(
        &fx.repo,
        &["status", "--porcelain"],
        Duration::from_secs(10)
    )
    .unwrap()
    .is_empty());
    // Windows 上 checkout 落盘为 CRLF，断言归一化
    assert_eq!(
        fs::read_to_string(fx.repo.join("README.md"))
            .unwrap()
            .replace("\r\n", "\n"),
        "main\n"
    );
}

#[test]
fn merge_workspace_refuses_dirty_or_wrong_branch_main_repo() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "guard").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("x.txt"), "x\n").unwrap();
    commit_all_in_worktree(&wt, "x");
    // 主仓库有未跟踪文件（fixture 的 .env*）→ 脏，拒绝
    let err = merge_impl(&fx.conn, &w.id, false).unwrap_err();
    assert!(err.contains("未提交改动"), "{err}");
    assert_eq!(
        get_workspace(&fx.conn, &w.id).unwrap().status,
        "active",
        "拒绝后工作区状态不变"
    );
    assert!(wt.exists());
    // 清掉脏文件但切到别的分支 → 同样拒绝
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    sh(&fx.repo, &["checkout", "-b", "other"]);
    let err = merge_impl(&fx.conn, &w.id, false).unwrap_err();
    assert!(err.contains("不在基准分支"), "{err}");
    // 主仓库 main 上不应有 x.txt（merge 没发生）
    sh(&fx.repo, &["checkout", "main"]);
    assert!(!fx.repo.join("x.txt").exists());
}

#[test]
fn merge_refuses_when_branch_touches_protected_paths() {
    let Some(fx) = Fixture::new() else { return };
    fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
    fs::write(
        fx.repo.join(".ccode/project.toml"),
        "protected_paths = [\"数据/raw\"]\n",
    )
    .unwrap();
    sh(&fx.repo, &["add", ".env", ".envrc", ".ccode/project.toml"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "prot").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    // 任务分支改动了保护路径下的文件（中文路径顺带验证 quotepath 口径）
    fs::create_dir_all(wt.join("数据/raw")).unwrap();
    fs::write(wt.join("数据/raw/a.csv"), "raw\n").unwrap();
    fs::write(wt.join("feature.txt"), "done\n").unwrap();
    commit_all_in_worktree(&wt, "任务完成");

    let err = merge_impl(&fx.conn, &w.id, false).unwrap_err();
    assert!(err.contains("保护路径"), "{err}");
    assert!(err.contains("数据/raw/a.csv"), "{err}");
    // 合并被拒绝：主仓不出现任务改动，工作区保持 active
    assert!(!fx.repo.join("feature.txt").exists());
    assert!(!fx.repo.join("数据/raw/a.csv").exists());
    assert_eq!(get_workspace(&fx.conn, &w.id).unwrap().status, "active");
}

#[test]
fn merge_fail_closed_when_project_config_corrupt() {
    let Some(fx) = Fixture::new() else { return };
    fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
    // 损坏的档案卡：保护清单不可信，必须拒绝合并而不是按「没有保护」继续
    fs::write(
        fx.repo.join(".ccode/project.toml"),
        "protected_paths = [\"raw\"\n",
    )
    .unwrap();
    sh(&fx.repo, &["add", ".env", ".envrc", ".ccode/project.toml"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "corrupt").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("feature.txt"), "done\n").unwrap();
    commit_all_in_worktree(&wt, "任务完成");

    let err = merge_impl(&fx.conn, &w.id, false).unwrap_err();
    assert!(err.contains("无法确认保护路径"), "{err}");
    assert!(!fx.repo.join("feature.txt").exists());
}

/// 打开 commit.gpgsign 且 gpg 程序不存在：应用内自动 merge/commit 必须仍能完成
#[test]
fn auto_merge_and_commit_bypass_gpgsign_config() {
    let Some(fx) = Fixture::new() else { return };
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    // 配置共享给所有 worktree：不带 -c commit.gpgsign=false 的提交必失败
    sh(&fx.repo, &["config", "commit.gpgsign", "true"]);
    sh(
        &fx.repo,
        &["config", "gpg.program", "definitely-missing-gpg"],
    );
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "gpg").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("feature.txt"), "v1\n").unwrap();
    commit_all_in_worktree(&wt, "任务改动");
    // 主仓库推进别的文件形成分叉，sync_base 的干净并入会产生 merge commit
    fs::write(fx.repo.join("other.txt"), "main\n").unwrap();
    sh(&fx.repo, &["add", "other.txt"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "主线改动"],
    );
    sync_base_impl(&wt, "main", false).expect("干净并入应绕过 gpgsign");
    assert!(!unmerged_impl(&wt).unwrap().merging);
    // 冲突并入 → 选边 → finish_merge 的 --no-edit 提交同样绕过 gpgsign
    fs::write(wt.join("feature.txt"), "branch\n").unwrap();
    commit_all_in_worktree(&wt, "分支改动");
    fs::write(fx.repo.join("feature.txt"), "main\n").unwrap();
    sh(&fx.repo, &["add", "feature.txt"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "主线再改"],
    );
    assert!(sync_base_impl(&wt, "main", false).is_err());
    resolve_file_impl(&wt, "feature.txt", "ours").unwrap();
    finish_merge_impl(&wt).expect("完成并入的提交应绕过 gpgsign");
    // 最终 merge --no-ff 进主仓库也绕过 gpgsign
    let out = merge_impl(&fx.conn, &w.id, false).unwrap();
    assert!(out.merged, "{}", out.message);
    // Windows 上 checkout 落盘为 CRLF，断言归一化
    assert_eq!(
        fs::read_to_string(fx.repo.join("feature.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "branch\n"
    );
}

/// 非冲突的 merge 失败（基准引用不存在）不得谎报「并入产生冲突」
#[test]
fn sync_base_non_conflict_failure_reports_git_error() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "badref").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    // 复制进来的 .env* 是未跟踪文件，先提交掉让工作区干净，才能走到 merge 一步
    commit_all_in_worktree(&wt, "副本");
    let err = sync_base_impl(&wt, "no-such-branch", false).unwrap_err();
    assert!(!err.contains("并入产生冲突"), "{err}");
    assert!(err.contains("非冲突"), "{err}");
    assert!(!unmerged_impl(&wt).unwrap().merging);
}

/// 删/改冲突：选定「已删除」侧时 git rm 兜底必须经 ls-files -u 确认后生效
#[test]
fn resolve_modify_delete_conflict_picks_deleted_side() {
    let Some(fx) = Fixture::new() else { return };
    // merge-base 必须先含有 feature.txt：任务分支修改、基准分支删除才构成删/改冲突
    fs::write(fx.repo.join("feature.txt"), "base\n").unwrap();
    sh(&fx.repo, &["add", ".env", ".envrc", "feature.txt"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "moddel").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    // 任务分支修改 feature.txt；基准分支删除它 → 并入产生 modify/delete 冲突
    fs::write(wt.join("feature.txt"), "branch\n").unwrap();
    commit_all_in_worktree(&wt, "分支改动");
    sh(&fx.repo, &["rm", "-q", "feature.txt"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "主线删除"],
    );
    assert!(sync_base_impl(&wt, "main", false).is_err());
    let st = unmerged_impl(&wt).unwrap();
    assert_eq!(st.files, vec!["feature.txt".to_string()]);
    // 选定 theirs（基准侧 = 已删除）：经确认后 git rm 生效，文件从工作区移除
    let st = resolve_file_impl(&wt, "feature.txt", "theirs").unwrap();
    assert!(st.files.is_empty());
    assert!(!wt.join("feature.txt").exists());
    finish_merge_impl(&wt).unwrap();
    assert!(
        run_git(
            &wt,
            &["cat-file", "-e", "HEAD:feature.txt"],
            Duration::from_secs(10)
        )
        .is_err(),
        "选定删除侧后文件不得留在提交里"
    );
}

// ===== 提货单 artifacts.yaml =====

/// 注册往返：条目字段齐全、md5/大小正确，未知顶层内容读写往返原样保留
#[test]
fn artifact_register_roundtrip_preserves_unknown_keys() {
    let Some(fx) = Fixture::new() else { return };
    // 产物保持未跟踪（大产物不进 git）
    let data = fx.repo.join("result.csv");
    fs::write(&data, b"a,b\n1,2\n").unwrap();
    // 预置清单带未知顶层键与注释，验证保留
    fs::write(
        fx.repo.join(ARTIFACTS_FILE),
        "# 手写备注\nupstream: \"https://example.com\"\n",
    )
    .unwrap();
    let entry = register_artifact_impl(&fx.repo, "清洗结果", &data, "data-clean").unwrap();
    assert_eq!(entry.name, "清洗结果");
    assert_eq!(entry.produced_by, "data-clean");
    assert_eq!(entry.size, 8);
    assert_eq!(entry.hash, format!("{:x}", md5::compute(b"a,b\n1,2\n")));
    assert!(!entry.created_at.is_empty());
    assert!(Path::new(&entry.path).is_absolute());
    let text = fs::read_to_string(fx.repo.join(ARTIFACTS_FILE)).unwrap();
    assert!(text.contains("upstream: \"https://example.com\""), "{text}");
    assert!(text.contains("# 手写备注"), "{text}");
    assert_eq!(text.matches(MANIFEST_HEADER).count(), 1, "{text}");
    let entries = read_artifacts_manifest_impl(&fx.repo);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "清洗结果");
    assert_eq!(entries[0].path, entry.path);
    assert_eq!(entries[0].hash, entry.hash);
    // 清单缺失时返回空
    let empty_dir = fx.dir.join("no-manifest");
    fs::create_dir_all(&empty_dir).unwrap();
    assert!(read_artifacts_manifest_impl(&empty_dir).is_empty());
}

/// 同路径重复登记 = 更新条目而非追加；已跟踪文件拒绝登记
#[test]
fn artifact_register_same_path_updates_and_tracked_rejected() {
    let Some(fx) = Fixture::new() else { return };
    let data = fx.repo.join("figure.png");
    fs::write(&data, b"v1").unwrap();
    let first = register_artifact_impl(&fx.repo, "图一", &data, "plot").unwrap();
    fs::write(&data, b"v2-longer").unwrap();
    let second = register_artifact_impl(&fx.repo, "图一（修订）", &data, "plot").unwrap();
    assert_ne!(first.hash, second.hash);
    let entries = read_artifacts_manifest_impl(&fx.repo);
    assert_eq!(entries.len(), 1, "同路径不得重复登记");
    assert_eq!(entries[0].name, "图一（修订）");
    assert_eq!(entries[0].hash, second.hash);
    assert!(!second.path.starts_with(r"\\?\"), "清单路径不得带 verbatim 前缀");
    // 存量清单里是 verbatim 写法的同一文件：再登记仍是更新，不追加重复条目
    let manifest = fx.repo.join(ARTIFACTS_FILE);
    let (preserved, mut old) = parse_manifest(&fs::read_to_string(&manifest).unwrap());
    old[0].path = format!(r"\\?\{}", old[0].path);
    fs::write(&manifest, render_manifest(&preserved, &old)).unwrap();
    let third = register_artifact_impl(&fx.repo, "图一（三）", &data, "plot").unwrap();
    let entries = read_artifacts_manifest_impl(&fx.repo);
    assert_eq!(entries.len(), 1, "跨方言同一文件不得重复登记");
    assert_eq!(entries[0].path, third.path);
    // 已跟踪文件随分支走，登记提货单会误导下一步
    let err =
        register_artifact_impl(&fx.repo, "自述", &fx.repo.join("README.md"), "ws").unwrap_err();
    assert!(err.contains("跟踪"), "{err}");
    // 不存在的文件拒绝
    assert!(register_artifact_impl(&fx.repo, "缺失", &fx.repo.join("nope.bin"), "ws").is_err());
}

/// 损坏/手写不规范的清单：解析容错不 panic，残缺条目剔除，再登记不清空其他内容
#[test]
fn artifact_manifest_corrupt_is_tolerated() {
    let Some(fx) = Fixture::new() else { return };
    fs::write(
        fx.repo.join(ARTIFACTS_FILE),
        "not yaml at all: [{\nartifacts:\n  - name: \"孤儿\"\n  garbage line\n  - name: \"好条目\"\n    path: \"/tmp/ok.bin\"\n    hash: \"abc\"\n    size: not-a-number\n",
    )
    .unwrap();
    let entries = read_artifacts_manifest_impl(&fx.repo);
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].name, "好条目");
    assert_eq!(entries[0].size, 0);
    // 在损坏清单上继续登记：顶层杂行保留，新条目可解析
    let data = fx.repo.join("out.parquet");
    fs::write(&data, b"parquet").unwrap();
    register_artifact_impl(&fx.repo, "数据集", &data, "etl").unwrap();
    let text = fs::read_to_string(fx.repo.join(ARTIFACTS_FILE)).unwrap();
    assert!(text.contains("not yaml at all: [{"), "{text}");
    let entries = read_artifacts_manifest_impl(&fx.repo);
    assert_eq!(entries.len(), 2, "{entries:?}");
    assert!(entries.iter().any(|e| e.name == "数据集"));
}

// ===== 人工事项：落点检测 / 勾选存取 / 交付导入 / HELP-WANTED 解析 =====

#[test]
fn wildcard_match_basics() {
    assert!(wildcard_match("*.bib", "a.bib"));
    assert!(wildcard_match("*.bib", ".bib"));
    assert!(!wildcard_match("*.bib", "a.bib.bak"));
    assert!(wildcard_match("a*", "a"));
    assert!(wildcard_match("*", "任意.txt"));
    assert!(!wildcard_match("a*", "ba"));
    assert!(wildcard_match("s*.pdf", "smith-2024.pdf"));
}

#[test]
fn glob_files_at_matches_exact_glob_and_dir() {
    let dir = std::env::temp_dir().join(format!("ccode-glob-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(dir.join("notes")).unwrap();
    fs::create_dir_all(dir.join("papers")).unwrap();
    fs::write(dir.join("notes/a.md"), b"note").unwrap();
    fs::write(dir.join("notes/b.md"), b"note2").unwrap();
    fs::write(dir.join("notes/skip.txt"), b"x").unwrap();
    fs::write(
        dir.join("papers/included.md"),
        "# x\nPaper A -- a, 2020 -- j -- doi\n",
    )
    .unwrap();
    fs::write(dir.join("papers/empty.md"), b"").unwrap();
    let notes = glob_files_at(&dir, "notes/*.md");
    assert_eq!(notes.len(), 2, "{notes:?}");
    let dir_files = glob_files_at(&dir, "notes/");
    assert_eq!(dir_files.len(), 3, "{dir_files:?}");
    assert_eq!(glob_files_at(&dir, "papers/included.md").len(), 1);
    assert!(glob_files_at(&dir, "papers/empty.md").is_empty());
    assert!(glob_files_at(&dir, "../escape").is_empty());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn machine_acceptance_checks_files_counts_and_content() {
    let dir = std::env::temp_dir().join(format!("ccode-accept-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(dir.join("notes")).unwrap();
    fs::create_dir_all(dir.join("papers")).unwrap();
    fs::write(dir.join("notes/a.md"), b"Paper A\n").unwrap();
    fs::write(dir.join("notes/b.md"), b"Paper B\n").unwrap();
    fs::write(dir.join("papers/included.md"), b"Paper A\nPaper B\n").unwrap();
    let since = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(1))
        .unwrap();
    let criteria = vec![
        "machine:glob:notes/*.md".into(),
        "machine:count:notes/*.md>=2".into(),
        "machine:contains:papers/included.md::Paper B".into(),
    ];
    assert!(machine_acceptance_satisfied(&dir, &criteria, since));
    assert!(!machine_acceptance_satisfied(
        &dir,
        &["machine:count:notes/*.md>=3".into()],
        since
    ));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn explicit_empty_deliverables_do_not_accept_missing_or_malformed_files() {
    let root = std::env::temp_dir().join(format!("mesa-zero-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let since = SystemTime::UNIX_EPOCH;
    let criteria = vec![
        "machine:optional-empty:to-fetch.ris".into(),
        "machine:records-allow-empty:included.json::id,title".into(),
    ];
    assert!(!machine_acceptance_satisfied(&root, &criteria, since));
    fs::write(root.join("to-fetch.ris"), "").unwrap();
    fs::write(root.join("included.json"), "[]").unwrap();
    assert!(machine_acceptance_satisfied(&root, &criteria, since));
    assert!(!machine_acceptance_satisfied(
        &root,
        &["machine:records:included.json::id,title".into()],
        since
    ));
    fs::write(root.join("included.json"), "not json").unwrap();
    assert!(!machine_acceptance_satisfied(&root, &criteria, since));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn machine_acceptance_checks_json_records_and_rejects_duplicate_ids() {
    let dir = std::env::temp_dir().join(format!("ccode-records-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("matrix.json"),
        r#"[{"id":"a","status":"ok","metric":1},{"id":"b","status":"failed","metric":"—"}]"#,
    )
    .unwrap();
    let since = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(1))
        .unwrap();
    assert!(machine_acceptance_satisfied(
        &dir,
        &["machine:records:matrix.json::id,status,metric".into()],
        since
    ));
    fs::write(
        dir.join("matrix.json"),
        r#"[{"id":"a","status":"ok","metric":1},{"id":"a","status":"failed","metric":0}]"#,
    )
    .unwrap();
    assert!(!machine_acceptance_satisfied(
        &dir,
        &["machine:records:matrix.json::id,status,metric".into()],
        since
    ));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn machine_acceptance_same_ids_requires_complete_unique_fresh_delivery() {
    let dir = std::env::temp_dir().join(format!("ccode-coverage-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("plan.json"), r#"[{"id":"a"},{"id":"b"}]"#).unwrap();
    // The plan is allowed to predate the current run (no wall-clock scheduling assertions).
    fs::OpenOptions::new()
        .write(true)
        .open(dir.join("plan.json"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
        .unwrap();
    let rule = vec!["machine:same-ids:plan.json::result.json".into()];
    let since = SystemTime::UNIX_EPOCH + Duration::from_secs(1);
    for valid in [
        r#"[{"id":"b","status":"failed"},{"id":"a","status":"cancelled"}]"#,
        r#"{"items":[{"id":"a"},{"id":"b"}]}"#,
        r#"{"records":[{"id":"a"},{"id":"b"}]}"#,
        r#"{"rows":[{"id":"b"},{"id":"a"}]}"#,
    ] {
        fs::write(dir.join("result.json"), valid).unwrap();
        assert!(machine_acceptance_satisfied(&dir, &rule, since), "{valid}");
    }
    for invalid in [
        r#"[{"id":"a"}]"#,                       // omission
        r#"[{"id":"a"},{"id":"b"},{"id":"c"}]"#, // unplanned addition
        r#"[{"id":"a"},{"id":"a"},{"id":"b"}]"#,
        r#"[{"id":"a"},{"id":1}]"#,
        r#"[{"id":"a"},{"id":" "}]"#,
        r#"[{"id":"a"},{}]"#,
        "[]",
        "not json",
        "{}",
    ] {
        fs::write(dir.join("result.json"), invalid).unwrap();
        assert!(
            !machine_acceptance_satisfied(&dir, &rule, since),
            "{invalid}"
        );
    }
    fs::write(dir.join("result.json"), r#"[{"id":"a"},{"id":"b"}]"#).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(dir.join("result.json"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
        .unwrap();
    assert!(!machine_acceptance_satisfied(&dir, &rule, since));
    for bad in [
        "machine:same-ids:missing.json::result.json",
        "machine:same-ids:plan.json",
        "machine:same-ids:::result.json",
    ] {
        assert!(!machine_acceptance_satisfied(&dir, &[bad.into()], since));
    }
    // A malformed/duplicate/empty reference is not a valid coverage baseline either.
    for invalid in ["[]", r#"[{"id":"a"},{"id":"a"}]"#, r#"[{"id":null}]"#] {
        fs::write(dir.join("plan.json"), invalid).unwrap();
        assert!(!machine_acceptance_satisfied(
            &dir,
            &rule,
            SystemTime::UNIX_EPOCH
        ));
    }
    fs::write(
        dir.join("plan.json"),
        format!(
            "[{}]",
            std::iter::repeat_n(r#"{"id":"a"}"#, 5001)
                .collect::<Vec<_>>()
                .join(",")
        ),
    )
    .unwrap();
    assert!(acceptance_record_ids(&dir, "plan.json", None).is_none());
    fs::write(dir.join("plan.json"), vec![b' '; 4 * 1024 * 1024 + 1]).unwrap();
    assert!(acceptance_record_ids(&dir, "plan.json", None).is_none());
    fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn to_fetch_count_stops_at_rule_after_entries() {
    let text = "# 清单\n\n---\n1. A — 10.1/a\n2. [已补 2026-09-24] B — 10.1/b\n\n---\n\n## 线索\n- C — 说明\n- D — 说明\n";
    assert_eq!(to_fetch_entries_in(text), 2);
}

#[test]
fn merge_tree_conflict_files_ignore_localized_messages() {
    // 中文系统上 git 把说明行本地化；文件列表到第一个空行为止，与语言无关
    let zh = "abc123\nfeature.txt\n\n自动合并 feature.txt\n冲突（添加/添加）：合并冲突于 feature.txt\n";
    assert_eq!(conflict_files_from_merge_tree(zh), vec!["feature.txt"]);
    let en = "abc123\na.txt\nb.txt\na.txt\n\nAuto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\n";
    assert_eq!(conflict_files_from_merge_tree(en), vec!["a.txt", "b.txt"]);
    // --no-messages 时没有说明段
    assert_eq!(conflict_files_from_merge_tree("abc123\nx.md\n"), vec!["x.md"]);
}

#[test]
fn machine_acceptance_skips_excluded_rows_and_count_exceptions() {
    let dir = std::env::temp_dir().join(format!("ccode-excluded-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(dir.join("notes")).unwrap();
    // 评审里排除的篇目留在 included.json：精读索引不必给它建行
    fs::write(
        dir.join("included.json"),
        r#"[{"id":"a","decision":"included"},{"id":"b","decision":"excluded"},{"id":"c","decision":"pending"}]"#,
    )
    .unwrap();
    fs::write(dir.join("index.json"), r#"[{"id":"a"},{"id":"c"}]"#).unwrap();
    let since = SystemTime::UNIX_EPOCH + Duration::from_secs(1);
    let same = vec!["machine:same-ids:included.json::index.json".into()];
    assert!(machine_acceptance_satisfied(&dir, &same, since));
    fs::write(dir.join("index.json"), r#"[{"id":"a"}]"#).unwrap();
    assert!(!machine_acceptance_satisfied(&dir, &same, since), "待确认篇仍要有索引行");
    // 「至少写了 1 篇笔记」不被必交的 handoff.md 自己满足
    fs::write(dir.join("notes/handoff.md"), "## 写作约束\n无\n").unwrap();
    let count = vec!["machine:count:notes/*.md>=1::except=handoff.md,glossary.md".into()];
    assert!(!machine_acceptance_satisfied(&dir, &count, since));
    fs::write(dir.join("notes/01-paper.md"), "笔记").unwrap();
    assert!(machine_acceptance_satisfied(&dir, &count, since));
    // 尾巴不是 except= 的写法一律不认
    let bad = vec!["machine:count:notes/*.md>=1::handoff.md".into()];
    assert!(!machine_acceptance_satisfied(&dir, &bad, since));
    let _ = fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn machine_acceptance_same_ids_rejects_outside_paths_and_symlinks() {
    use std::os::unix::fs::symlink;
    let base =
        std::env::temp_dir().join(format!("ccode-coverage-path-{}", uuid::Uuid::new_v4()));
    let root = base.join("project");
    fs::create_dir_all(&root).unwrap();
    fs::write(base.join("outside.json"), r#"[{"id":"a"}]"#).unwrap();
    fs::write(root.join("local.json"), r#"[{"id":"a"}]"#).unwrap();
    symlink(base.join("outside.json"), root.join("link.json")).unwrap();
    for rule in [
        "machine:same-ids:../outside.json::local.json".to_string(),
        "machine:same-ids:link.json::local.json".into(),
        "machine:same-ids:local.json::link.json".into(),
        format!(
            "machine:same-ids:{}::local.json",
            base.join("outside.json").display()
        ),
    ] {
        assert!(!machine_acceptance_satisfied(
            &root,
            &[rule],
            SystemTime::UNIX_EPOCH
        ));
    }
    fs::remove_dir_all(base).ok();
}

#[test]
fn machine_acceptance_not_contains_rejects_placeholder() {
    let dir = std::env::temp_dir().join(format!("ccode-accept-fig-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("draft.md"), "Figure 1（待绘制）\n").unwrap();
    let since = SystemTime::UNIX_EPOCH;
    let rule = vec!["machine:not-contains:draft.md::待绘制".into()];
    assert!(!machine_acceptance_satisfied(&dir, &rule, since));
    fs::write(dir.join("draft.md"), "见 [@kim2011] Fig. 1\n").unwrap();
    assert!(machine_acceptance_satisfied(&dir, &rule, since));
    assert!(!machine_acceptance_satisfied(
        &dir,
        &["machine:not-contains:missing.md::待绘制".into()],
        since
    ));
    fs::remove_dir_all(dir).ok();
}

#[cfg(unix)]
#[test]
fn machine_acceptance_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;
    let dir = std::env::temp_dir().join(format!("ccode-accept-link-{}", uuid::Uuid::new_v4()));
    let outside =
        std::env::temp_dir().join(format!("ccode-accept-out-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(&outside, b"secret").unwrap();
    symlink(&outside, dir.join("escaped.txt")).unwrap();
    let since = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(1))
        .unwrap();
    assert!(!machine_acceptance_satisfied(
        &dir,
        &["machine:contains:escaped.txt::secret".into()],
        since
    ));
    fs::remove_dir_all(&dir).ok();
    fs::remove_file(&outside).ok();
}

#[test]
fn register_expected_artifacts_skips_tracked_and_fills_yaml() {
    let Some(fx) = Fixture::new() else { return };
    fs::create_dir_all(fx.repo.join("papers")).unwrap();
    fs::write(fx.repo.join("papers/a.pdf"), b"%PDF-1.4 demo").unwrap();
    fs::write(fx.repo.join("notes.md"), b"tracked").unwrap();
    sh(&fx.repo, &["add", "notes.md"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "note"],
    );
    fs::create_dir_all(fx.repo.join(".ccode")).unwrap();
    fs::write(
        fx.repo.join(".ccode/project.toml"),
        "[[steps]]\nname = \"出图\"\nworkspace_name = \"art\"\nexpected_artifacts = [\"papers/*.pdf\", \"notes.md\"]\n",
    )
    .unwrap();
    let note = register_expected_artifacts_at(&fx.repo, "art");
    assert!(note.contains("1 个产物"), "{note}");
    let entries = read_artifacts_manifest_impl(&fx.repo);
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert!(entries[0].path.replace('\\', "/").ends_with("papers/a.pdf"));
}

#[test]
fn artifact_produced_since_supports_file_globs_without_accepting_empty_dirs() {
    let dir =
        std::env::temp_dir().join(format!("ccode-artifact-glob-{}", uuid::Uuid::new_v4()));
    let root = dir.join("proj");
    fs::create_dir_all(root.join("figures")).unwrap();
    let since = SystemTime::now() - Duration::from_secs(1);
    assert!(!artifact_produced_since(&root, "figures/*.png", since));
    fs::write(root.join("figures/result.pdf"), b"pdf").unwrap();
    assert!(!artifact_produced_since(&root, "figures/*.png", since));
    fs::write(root.join("figures/result.png"), b"png").unwrap();
    assert!(artifact_produced_since(&root, "figures/*.png", since));
    assert!(
        artifact_produced_since(&root, "figures/", since),
        "旧配置目录条目仍保持向后兼容"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn human_target_hit_three_forms() {
    let dir = std::env::temp_dir().join(format!("ccode-ht-{}", uuid::Uuid::new_v4()));
    let root = dir.join("proj");
    fs::create_dir_all(root.join("papers/search")).unwrap();
    // 空目录/缺文件 → 未交付
    assert!(!human_target_hit(&root, "papers/"));
    assert!(!human_target_hit(&root, "papers/*.bib"));
    assert!(!human_target_hit(&root, "papers/screening.md"));
    // 目录形态：隐藏文件不算交付
    fs::write(root.join("papers/.keep"), "x").unwrap();
    assert!(!human_target_hit(&root, "papers/"));
    fs::write(root.join("papers/search/wos.bib"), "@article{}").unwrap();
    assert!(human_target_hit(&root, "papers/"));
    assert!(human_target_hit(&root, "papers/search/"));
    // 通配只认最后一段
    assert!(human_target_hit(&root, "papers/search/*.bib"));
    assert!(!human_target_hit(&root, "papers/search/*.pdf"));
    assert!(!human_target_hit(&root, "papers/*/x.bib"), "跨段通配不支持");
    // 精确文件
    fs::write(root.join("papers/screening.md"), "s").unwrap();
    assert!(human_target_hit(&root, "papers/screening.md"));
    // 逃逸/绝对路径一律未交付
    assert!(!human_target_hit(&root, "../outside/"));
    assert!(!human_target_hit(&root, "/etc/hosts"));
    assert!(!human_target_hit(&root, ""));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn human_target_count_matches_files() {
    let dir = std::env::temp_dir().join(format!("ccode-htc-{}", uuid::Uuid::new_v4()));
    let root = dir.join("proj");
    fs::create_dir_all(root.join("papers")).unwrap();
    // 未命中 → None（不是 Some(0)）
    assert_eq!(human_target_count(&root, "papers/*.pdf"), None);
    assert_eq!(human_target_count(&root, "papers/"), None);
    fs::write(root.join("papers/a-2024-x.pdf"), "%PDF").unwrap();
    fs::write(root.join("papers/b-2023-y.pdf"), "%PDF").unwrap();
    fs::write(root.join("papers/screening.md"), "s").unwrap();
    assert_eq!(human_target_count(&root, "papers/*.pdf"), Some(2));
    // 目录形态递归计数，含子目录里的
    fs::create_dir_all(root.join("papers/sub")).unwrap();
    fs::write(root.join("papers/sub/c-2022-z.pdf"), "%PDF").unwrap();
    assert_eq!(human_target_count(&root, "papers/"), Some(4));
    // 精确文件命中 = 1
    assert_eq!(human_target_count(&root, "papers/screening.md"), Some(1));
    // 逃逸/空 target → None
    assert_eq!(human_target_count(&root, "../outside/"), None);
    assert_eq!(human_target_count(&root, ""), None);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn to_fetch_entry_count_rules() {
    let dir = std::env::temp_dir().join(format!("ccode-tf-{}", uuid::Uuid::new_v4()));
    let root = dir.join("proj");
    fs::create_dir_all(root.join("papers")).unwrap();
    // 非 papers/*.pdf 落点不算
    assert_eq!(to_fetch_entry_count(&root, "papers/"), None);
    // 文件不存在 → None
    assert_eq!(to_fetch_entry_count(&root, "papers/*.pdf"), None);
    // 口径与前端 parseToFetchItems 双端镜像（2026-09-16 对齐）：
    // 编号/列表行无链接也算（✓ 剥掉）；裸行必须带「 — DOI/链接」尾巴——
    // 顶部说明文字行与「待补」占位不算，否则「清单共 N」比展开面板多数
    fs::write(
        root.join("papers/to-fetch.md"),
        concat!(
            "# 待获取全文\n",
            "以下为已纳入但项目资源未见对应 PDF 的文献；说明文字不算条目。\n",
            "\n",
            "1. Smith 2024 — 10.1002/abc\n",
            "2. ✓ 张三 2023 — 10.1039/def\n",
            "3. 无链接条目\n",
            "- 列表符号条目 — 10.1002/ghi\n",
            "\n",
            "（无付费文献则本清单为空）\n",
            "Wang 2022 — 10.1002/jkl\n",
            "Easy Scalable (Mg/S)-Batteries — 待补\n",
            "仅说明没有尾巴\n",
        ),
    )
    .unwrap();
    // = 编号 3 行 + 列表 1 行 + 裸行带 DOI 1 行
    assert_eq!(to_fetch_entry_count(&root, "papers/*.pdf"), Some(5));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn to_fetch_entry_line_mirror_edges() {
    // 前缀后无空白不算编号/列表，但裸行带尾巴仍算（前端正则 \s+ 与裸行回落同款）
    assert!(to_fetch_line_is_entry("1.无空格编号 — 10.1002/x"));
    assert!(!to_fetch_line_is_entry("1."));
    assert!(!to_fetch_line_is_entry("-"));
    assert!(to_fetch_line_is_entry("Bare — https://example.com/a.pdf"));
    assert!(to_fetch_line_is_entry("带 doi 前缀 — doi:10.1002/x"));
    assert!(!to_fetch_line_is_entry("数字不足 — 10.1/abc"));
    assert!(to_fetch_line_is_entry("+ 加号也是列表 — 10.1002/y"));
    assert!(to_fetch_line_is_entry("✓ 开头裸行 — 10.1002/z"));
    // DOI 在空白处截断，段内仍有合法 DOI，裸行算一条（与前端 \S+ 截断一致）
    assert!(to_fetch_line_is_entry("尾巴带空格 — 10.1002/a b"));
    assert!(!to_fetch_line_is_entry("只有说明 — 没有链接"));
    // DOI 后面再挂刊名、标记，裸行仍是一条，不能当成说明文字丢掉
    assert!(to_fetch_line_is_entry(
        "Boride review — 10.1002/adfm.201906481 — Advanced Functional Materials〔OA〕"
    ));
    assert!(to_fetch_looks_link("10.1002/adfm.201906481 — Advanced Functional Materials〔OA〕"));
    assert!(!to_fetch_looks_link("Advanced Functional Materials〔缩写：Adv. Funct. Mater.〕"));
}

#[test]
fn completion_modes_do_not_treat_file_presence_as_manual_confirmation() {
    let dir = std::env::temp_dir().join(format!("ccode-completion-{}", uuid::Uuid::new_v4()));
    let root = dir.join("proj");
    fs::create_dir_all(root.join("submission")).unwrap();
    fs::write(root.join("submission/checklist.md"), "作者：待填\n").unwrap();
    assert!(
        !human_target_satisfied(
            &root,
            "submission/checklist.md",
            "manual",
            Some(1),
            None,
            "",
        ),
        "manual 必须由人确认，文件出现不能自动完成"
    );
    assert!(
        !human_target_satisfied(
            &root,
            "submission/checklist.md",
            "no_placeholders",
            Some(1),
            None,
            "",
        ),
        "no_placeholders 发现待填占位时不能完成"
    );
    fs::write(root.join("submission/checklist.md"), "作者：张三\n").unwrap();
    assert!(human_target_satisfied(
        &root,
        "submission/checklist.md",
        "no_placeholders",
        Some(1),
        None,
        "",
    ));
    fs::create_dir_all(root.join("papers")).unwrap();
    fs::write(
        root.join("papers/to-fetch.md"),
        "# 待获取\n\n（无付费文献则本清单为空）\n",
    )
    .unwrap();
    assert!(human_target_satisfied(
        &root,
        "papers/*.pdf",
        "all",
        None,
        Some(0),
        "",
    ));
    fs::create_dir_all(root.join("manuscript")).unwrap();
    fs::write(
        root.join("manuscript/review-report.md"),
        "## 严重问题\n\nR001 位置：draft.md:3\n决定：接受\n\nR002 位置：draft.md:9\n决定：修改：改回原文数字\n",
    )
    .unwrap();
    assert!(human_target_satisfied(
        &root,
        "manuscript/review-report.md",
        "decisions_cleared",
        None,
        None,
        "",
    ));
    fs::write(
        root.join("manuscript/review-report.md"),
        "R001 位置：draft.md:3\n决定：修改：\n",
    )
    .unwrap();
    assert!(!human_target_satisfied(
        &root,
        "manuscript/review-report.md",
        "decisions_cleared",
        None,
        None,
        "",
    ));
    fs::write(
        root.join("manuscript/review-report.md"),
        "R001 位置：draft.md:3\n决定：接受\n\nR002 位置：draft.md:9\n问题：还没决定。\n",
    )
    .unwrap();
    assert!(
        !human_target_satisfied(
            &root,
            "manuscript/review-report.md",
            "decisions_cleared",
            None,
            None,
            "",
        ),
        "只决定了一条，其余空着不算完成"
    );
    fs::write(
        root.join("manuscript/verification-decisions.md"),
        "- V001 | 位置：review-final.md:4 | 裁决：确认 | 依据：\n- V002 | 位置：review-final.md:8 | 裁决：改正为12% | 依据：原文\n",
    )
    .unwrap();
    assert!(human_target_satisfied(
        &root,
        "manuscript/verification-decisions.md",
        "decisions_cleared",
        None,
        None,
        "",
    ));
    fs::write(
        root.join("manuscript/verification-decisions.md"),
        "- V001 | 裁决：待裁决 | 依据：\n",
    )
    .unwrap();
    assert!(!human_target_satisfied(
        &root,
        "manuscript/verification-decisions.md",
        "decisions_cleared",
        None,
        None,
        "",
    ));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn dest_for_target_forms() {
    let root = Path::new("/proj");
    let src = Path::new("/downloads/smith-2024.pdf");
    assert_eq!(
        dest_for_target(root, "papers/", src).unwrap(),
        PathBuf::from("/proj/papers/smith-2024.pdf")
    );
    assert_eq!(
        dest_for_target(root, "papers/*.pdf", src).unwrap(),
        PathBuf::from("/proj/papers/smith-2024.pdf")
    );
    // 精确文件 = 允许改名交付
    assert_eq!(
        dest_for_target(root, "papers/list.md", src).unwrap(),
        PathBuf::from("/proj/papers/list.md")
    );
    assert!(dest_for_target(root, "../x/", src).is_err());
    assert!(dest_for_target(root, "", src).is_err());
}

/// 显式取消后，即便落点检测命中也不得自动勾回（v3.89 实测 bug：用户「取消不了」）
#[test]
fn explicit_uncheck_beats_detection() {
    let dir = std::env::temp_dir().join(format!("ccode-unchk-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let conn = db_at(&dir.join("app.db")).unwrap();
    ensure_human_task_checks_table(&conn).unwrap();
    let proj = dir.join("p").to_string_lossy().into_owned();
    let key = ("检索".to_string(), "下载付费墙文献全文".to_string());

    // 勾上
    conn.execute(
        "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at, checked)
             VALUES(?1,?2,?3,?4,1)",
        params![proj, key.0, key.1, "2026-08-16T00:00:00Z"],
    )
    .unwrap();
    assert_eq!(manual_checks_at(&conn, &proj).get(&key), Some(&true));

    // 取消：留痕为 false，而不是消失
    conn.execute(
        "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at, checked)
             VALUES(?1,?2,?3,?4,0)",
        params![proj, key.0, key.1, "2026-08-16T00:01:00Z"],
    )
    .unwrap();
    let m = manual_checks_at(&conn, &proj);
    assert_eq!(
        m.get(&key),
        Some(&false),
        "取消必须留痕；删行会让检测命中把它自动勾回来",
    );
    // done 判定：Some(false) 一律不完成，不看 detected
    let done = match m.get(&key).copied() {
        Some(v) => v,
        None => true, // 假设检测命中
    };
    assert!(!done, "显式取消后，检测命中也不算完成");
    std::fs::remove_dir_all(&dir).ok();
}

/// 勾选存取（行在 = 人勾了）：upsert/delete 往返 + 项目间隔离
#[test]
fn human_task_checks_roundtrip() {
    let dir = std::env::temp_dir().join(format!("ccode-htc-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let conn = db_at(&dir.join("app.db")).unwrap();
    ensure_human_task_checks_table(&conn).unwrap();
    let proj = dir.join("p1").to_string_lossy().into_owned();
    conn.execute(
        "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at) VALUES(?1,?2,?3,?4)",
        params![proj, "检索", "下载全文", "2026-08-12T00:00:00Z"],
    )
    .unwrap();
    let set = manual_checks_at(&conn, &proj);
    // 旧行（无 checked 列时写入）默认视为已勾选，向后兼容
    assert_eq!(set.get(&("检索".into(), "下载全文".into())), Some(&true));
    // 其他项目隔离
    let other = dir.join("p2").to_string_lossy().into_owned();
    assert!(manual_checks_at(&conn, &other).is_empty());
    // 取消勾选 = 落 checked=0（**不删行**）：删行会回落检测口径，
    // 落点里有文件时立刻自动勾回来，用户取消不掉（v3.89 修）
    conn.execute(
        "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at, checked)
             VALUES(?1,?2,?3,?4,0)",
        params![proj, "检索", "下载全文", "2026-08-12T00:00:00Z"],
    )
    .unwrap();
    assert_eq!(
        manual_checks_at(&conn, &proj).get(&("检索".into(), "下载全文".into())),
        Some(&false),
        "显式取消要留痕，不能删行",
    );
    fs::remove_dir_all(&dir).ok();
}

/// 勾选按项目路径跨方言匹配：Windows 上读侧曾用 verbatim、写侧用普通形式，勾完刷新即丢
#[test]
fn human_task_checks_match_across_path_dialects() {
    let dir = std::env::temp_dir().join(format!("ccode-htcd-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let conn = db_at(&dir.join("app.db")).unwrap();
    ensure_human_task_checks_table(&conn).unwrap();
    let proj = dir.join("p1").to_string_lossy().into_owned();
    let verbatim = format!(r"\\?\{proj}");
    let ins = |path: &str, title: &str, checked: i64, at: &str| {
        conn.execute(
            "INSERT OR REPLACE INTO human_task_checks(project_path, step, title, updated_at, checked)
                 VALUES(?1,?2,?3,?4,?5)",
            params![path, "检索", title, at, checked],
        )
        .unwrap();
    };
    // 存量 verbatim 行：普通形式查询也要读到
    ins(&verbatim, "下载全文", 1, "2026-10-01T00:00:00Z");
    let m = manual_checks_at(&conn, &proj);
    assert_eq!(m.get(&("检索".into(), "下载全文".into())), Some(&true));
    // 同一事项两种写法并存：精确键优先（即便另一行更新）
    ins(&proj, "下载全文", 0, "2026-09-01T00:00:00Z");
    let m = manual_checks_at(&conn, &proj);
    assert_eq!(m.get(&("检索".into(), "下载全文".into())), Some(&false));
    // 段边界：p1 的行不串到 p10
    let other = dir.join("p10").to_string_lossy().into_owned();
    assert!(manual_checks_at(&conn, &other).is_empty());
    #[cfg(windows)]
    {
        let upper = proj.to_uppercase();
        // 两行都不是精确键 → 取最新一行（verbatim 行 10-01 勾上）
        assert_eq!(
            manual_checks_at(&conn, &upper).get(&("检索".into(), "下载全文".into())),
            Some(&true),
            "NTFS 大小写不敏感，大小写不同也是同一项目",
        );
    }
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn project_root_deliverable_target_covers_papers_and_pdf() {
    let pdf = Path::new("/tmp/foo.pdf");
    let csv = Path::new("/tmp/foo.csv");
    assert!(project_root_deliverable_target("papers/*.pdf", pdf));
    assert!(project_root_deliverable_target("papers/", csv));
    assert!(project_root_deliverable_target("papers/imports/", csv));
    assert!(project_root_deliverable_target("manuscript/x.pdf", csv));
    assert!(project_root_deliverable_target("figures/plot.png", pdf));
    assert!(!project_root_deliverable_target("cleaning/rules.md", csv));
    assert!(!project_root_deliverable_target("", csv));
}

#[test]
fn copy_untracked_deliverables_skips_existing_and_stays_in_tree() {
    let dir = std::env::temp_dir().join(format!("ccode-salvage-{}", uuid::Uuid::new_v4()));
    let wt = dir.join("wt");
    let repo = dir.join("repo");
    fs::create_dir_all(wt.join("papers")).unwrap();
    fs::create_dir_all(repo.join("papers")).unwrap();
    fs::create_dir_all(wt.join("output")).unwrap();
    fs::write(wt.join("papers/a.pdf"), b"new-a").unwrap();
    fs::write(repo.join("papers/a.pdf"), b"old-a").unwrap();
    fs::write(wt.join("papers/b.pdf"), b"new-b").unwrap();
    fs::write(wt.join("output/main.pdf"), b"pdf").unwrap();
    fs::write(wt.join("secret.txt"), b"nope").unwrap();
    sh(&wt, &["init", "-b", "main"]);
    let note = apply_delivery_review(
        &freeze_deliverables_at(&uuid::Uuid::new_v4().to_string(), &wt, &repo, &[]).unwrap(),
        &repo,
        &[],
    )
    .note();
    assert!(note.contains("2 个文件"), "{note}");
    assert_eq!(fs::read(repo.join("papers/a.pdf")).unwrap(), b"old-a");
    assert_eq!(fs::read(repo.join("papers/b.pdf")).unwrap(), b"new-b");
    assert_eq!(fs::read(repo.join("output/main.pdf")).unwrap(), b"pdf");
    assert!(!repo.join("secret.txt").exists());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn copy_untracked_deliverables_skips_protected_paths() {
    let dir = std::env::temp_dir().join(format!("ccode-salvage-prot-{}", uuid::Uuid::new_v4()));
    let wt = dir.join("wt");
    let repo = dir.join("repo");
    fs::create_dir_all(wt.join("papers/raw")).unwrap();
    fs::create_dir_all(wt.join("papers/notes")).unwrap();
    fs::create_dir_all(repo.join("papers/raw")).unwrap();
    fs::write(wt.join("papers/raw/new.csv"), b"new").unwrap();
    fs::write(wt.join("papers/notes/ok.md"), b"ok").unwrap();
    sh(&wt, &["init", "-b", "main"]);
    let note = apply_delivery_review(
        &freeze_deliverables_at(
            &uuid::Uuid::new_v4().to_string(),
            &wt,
            &repo,
            &["papers/raw".into()],
        )
        .unwrap(),
        &repo,
        &["papers/raw".into()],
    )
    .note();
    assert!(note.contains("1 个文件"), "{note}");
    assert!(
        !repo.join("papers/raw/new.csv").exists(),
        "保护路径下的文件不得拷进主仓"
    );
    assert_eq!(fs::read(repo.join("papers/notes/ok.md")).unwrap(), b"ok");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn copy_untracked_deliverables_names_conflicts_instead_of_silent_skip() {
    let dir =
        std::env::temp_dir().join(format!("ccode-salvage-conflict-{}", uuid::Uuid::new_v4()));
    let wt = dir.join("wt");
    let repo = dir.join("repo");
    fs::create_dir_all(wt.join("papers")).unwrap();
    fs::create_dir_all(repo.join("papers")).unwrap();
    fs::write(wt.join("papers/dup.pdf"), b"worktree-version").unwrap();
    fs::write(repo.join("papers/dup.pdf"), b"main-version").unwrap();
    fs::write(wt.join("papers/new.pdf"), b"new").unwrap();
    sh(&wt, &["init", "-b", "main"]);
    let note = apply_delivery_review(
        &freeze_deliverables_at(&uuid::Uuid::new_v4().to_string(), &wt, &repo, &[]).unwrap(),
        &repo,
        &[],
    )
    .note();
    assert!(note.contains("1 个文件"), "{note}");
    assert!(note.contains("papers/dup.pdf"), "{note}");
    assert!(note.contains("未覆盖"), "{note}");
    // 冲突文件保持主仓版本，不被工作区覆盖
    assert_eq!(
        fs::read(repo.join("papers/dup.pdf")).unwrap(),
        b"main-version"
    );
    assert_eq!(fs::read(repo.join("papers/new.pdf")).unwrap(), b"new");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn merge_copies_worktree_pdf_into_main() {
    let Some(fx) = Fixture::new() else { return };
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "pdf-salvage",
    )
    .unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("feature.txt"), "done\n").unwrap();
    commit_all_in_worktree(&wt, "任务完成");
    fs::create_dir_all(wt.join("papers")).unwrap();
    fs::write(wt.join("papers/paper.pdf"), b"%PDF-fake").unwrap();
    let out = merge_impl(&fx.conn, &w.id, false).unwrap();
    assert!(out.merged);
    assert!(out.output.contains("拷到主文件夹"), "{}", out.output);
    assert_eq!(
        fs::read(fx.repo.join("papers/paper.pdf")).unwrap(),
        b"%PDF-fake"
    );
    let fact = crate::projects::read_acceptance_log_at(&fx.repo)
        .pop()
        .unwrap();
    let fingerprint = fact
        .content_fingerprints
        .iter()
        .find(|f| f.path == "papers/paper.pdf")
        .unwrap();
    assert_eq!(
        fingerprint.sha256.as_deref(),
        Some(
            delivery_hash(&wt.join("papers/paper.pdf"))
                .unwrap()
                .1
                .as_str()
        )
    );
}

#[test]
fn delivery_review_rejects_changed_bytes_even_when_git_head_did_not_change() {
    let Some(fx) = Fixture::new() else { return };
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "delivery-version",
    )
    .unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("feature.txt"), "code").unwrap();
    commit_all_in_worktree(&wt, "feature");
    fs::create_dir_all(wt.join("papers")).unwrap();
    fs::write(wt.join("papers/result.pdf"), b"reviewed-pdf").unwrap();
    let review = freeze_deliverables(&w, &fx.repo).unwrap();
    let tip = run_git(&wt, &["rev-parse", "HEAD"], Duration::from_secs(10)).unwrap();
    fs::write(wt.join("papers/result.pdf"), b"unreviewed-pdf").unwrap();
    let error = merge_impl_with_guard(
        &fx.conn,
        &w.id,
        false,
        &|_| Ok(()),
        Some(&tip),
        Some(&review.token),
    )
    .unwrap_err();
    assert!(error.contains("看过之后"), "{error}");
    assert!(
        !fx.repo.join("feature.txt").exists(),
        "产物版本不匹配须在 Git 合并之前拒绝"
    );
    assert_eq!(
        fs::read(Path::new(&review.payload_dir).join("papers/result.pdf")).unwrap(),
        b"reviewed-pdf"
    );
    let result = apply_delivery_review(&review, &fx.repo, &[]);
    assert!(result.failed.is_empty());
    assert_eq!(
        fs::read(fx.repo.join("papers/result.pdf")).unwrap(),
        b"reviewed-pdf",
        "应用源只认所审副本"
    );
    assert!(assert_deliverables_retained(&w, &fx.repo)
        .unwrap_err()
        .contains("仍保留"));
}

#[test]
fn unticked_deliverable_stays_out_and_does_not_block_archive() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "delivery-skip",
    )
    .unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::create_dir_all(wt.join("papers")).unwrap();
    fs::create_dir_all(wt.join("artifacts/jabref")).unwrap();
    fs::write(wt.join("papers/result.pdf"), b"keep-me").unwrap();
    fs::write(wt.join("artifacts/jabref/acs.csv"), b"scratch").unwrap();
    let review = freeze_deliverables(&w, &fx.repo).unwrap();
    // 勾掉 JabRef 缩写表（2026-10-22 实测：Agent 的中间文件混在产物里）
    let review = set_delivery_skip(&w, &fx.repo, &review.token, "artifacts/jabref/acs.csv", true).unwrap();
    let disposition = |r: &DeliverableReviewDto, p: &str| {
        r.files.iter().find(|f| f.path == p).unwrap().disposition.clone()
    };
    assert_eq!(disposition(&review, "artifacts/jabref/acs.csv"), "skipped");
    // 保存进项目只带回勾着的
    let checked = load_delivery_review(&w.id, &review.token).unwrap();
    let report = apply_delivery_review(&checked, &fx.repo, &[]);
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(fs::read(fx.repo.join("papers/result.pdf")).unwrap(), b"keep-me");
    assert!(!fx.repo.join("artifacts/jabref/acs.csv").exists());
    // 勾掉的那一版不挡归档
    assert_deliverables_retained(&w, &fx.repo).unwrap();
    // 刷新评审（重新冻结）照样勾掉
    let again = freeze_deliverables(&w, &fx.repo).unwrap();
    assert_eq!(disposition(&again, "artifacts/jabref/acs.csv"), "skipped");
    // 文件变了就是没看过的新版：回到带回，归档也重新拦
    fs::write(wt.join("artifacts/jabref/acs.csv"), b"scratch-v2").unwrap();
    let fresh = freeze_deliverables(&w, &fx.repo).unwrap();
    assert_eq!(disposition(&fresh, "artifacts/jabref/acs.csv"), "copy");
    assert!(assert_deliverables_retained(&w, &fx.repo).is_err());
    // 冲突 / 保护等不在带回清单里的不能勾
    assert!(set_delivery_skip(&w, &fx.repo, &fresh.token, "papers/nope.pdf", true).is_err());
    // 流程要用的（papers/ 下的文献资料、这一步的预期产物）不能勾掉，界面也标出来
    let err = set_delivery_skip(&w, &fx.repo, &fresh.token, "papers/result.pdf", true).unwrap_err();
    assert!(err.contains("流程要用"), "{err}");
    let pdf = fresh.files.iter().find(|f| f.path == "papers/result.pdf").unwrap();
    assert!(pdf.required);
    assert!(!fresh.files.iter().find(|f| f.path == "artifacts/jabref/acs.csv").unwrap().required);
}

#[test]
fn reopening_review_keeps_only_latest_snapshots() {
    let Some(fx) = Fixture::new() else { return };
    let w = create_impl(&fx.conn, &fx.ws_root, fx.repo.to_str().unwrap(), "delivery-prune").unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::create_dir_all(wt.join("output")).unwrap();
    fs::write(wt.join("output/draft.pdf"), b"pdf").unwrap();
    let mut tokens = Vec::new();
    for _ in 0..5 {
        tokens.push(freeze_deliverables(&w, &fx.repo).unwrap().token);
        std::thread::sleep(Duration::from_millis(20));
    }
    let left: Vec<String> = fs::read_dir(delivery_review_root(&w.id).unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left.len(), 3, "{left:?}");
    for token in &tokens[2..] {
        assert!(load_delivery_review(&w.id, token).is_ok(), "最新的几份还在");
    }
    assert!(load_delivery_review(&w.id, &tokens[0]).is_err());
}

#[test]
fn pipeline_recovery_finds_original_merge_after_crash_before_commit_id_was_saved() {
    let Some(fx) = Fixture::new() else { return };
    sh(&fx.repo, &["add", ".env", ".envrc"]);
    sh(
        &fx.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "env"],
    );
    let w = create_impl(
        &fx.conn,
        &fx.ws_root,
        fx.repo.to_str().unwrap(),
        "merge-recover",
    )
    .unwrap();
    let wt = PathBuf::from(&w.worktree_path);
    fs::write(wt.join("feature.txt"), "accepted code").unwrap();
    commit_all_in_worktree(&wt, "feature");
    fs::create_dir_all(wt.join("papers")).unwrap();
    fs::write(wt.join("papers/result.pdf"), b"accepted-pdf").unwrap();
    let blocked = fx.repo.join(".ccode/acceptance-log.jsonl");
    fs::create_dir_all(&blocked).unwrap();
    let first = merge_impl(&fx.conn, &w.id, false).unwrap();
    assert!(!first.ledger_written);
    let mut pending = read_delivery_pending(&w.id).unwrap().unwrap();
    pending.fact.version_id.clear(); // 模拟 merge 已成功、记录合并 SHA 前退出。
    pending.files_applied = false;
    save_delivery_pending(&w.id, &pending).unwrap();
    fs::remove_dir(&blocked).unwrap();
    fs::remove_file(fx.repo.join("papers/result.pdf")).unwrap();
    fs::write(wt.join("papers/result.pdf"), b"later-pdf").unwrap();
    fs::write(fx.repo.join("later.txt"), "later main work").unwrap();
    commit_all_in_worktree(&fx.repo, "later main");
    let head = run_git(&fx.repo, &["rev-parse", "HEAD"], Duration::from_secs(10)).unwrap();
    let recovered =
        merge_impl_with_guard(&fx.conn, &w.id, false, &|_| Ok(()), None, None).unwrap();
    assert!(recovered.ledger_written);
    assert_eq!(recovered.version_id, first.version_id);
    assert_eq!(
        run_git(&fx.repo, &["rev-parse", "HEAD"], Duration::from_secs(10)).unwrap(),
        head
    );
    assert_eq!(
        fs::read(fx.repo.join("papers/result.pdf")).unwrap(),
        b"accepted-pdf"
    );
    assert!(read_delivery_pending(&w.id).unwrap().is_none());
}
