use super::*;

// ===== B2 目标级模型 =====

/// map_task 按位置索引读列（TASK_COLS 的第 20 列）——model 追加队尾后，
/// agent/profile_id/model 三列必须互不串位。内存库跑真实 SELECT {TASK_COLS}
/// + map_task，列序错位会直接在这里炸（拿不到值或张冠李戴）
#[test]
fn task_model_round_trips_without_column_shift() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO tasks(id,identity_key,project_root,kind,task_ref,name,status,created_at,updated_at,agent,profile_id,model)
             VALUES('t1','user:t1','/p/proj','free_research','t1','试目标','pending','now','now','claude-code','pf-1','glm-4.7')",
        [],
    )
    .unwrap();
    // 旧行无 model（ALTER 前的存量）：NULL 回落不报错
    conn.execute(
        "INSERT INTO tasks(id,identity_key,project_root,kind,task_ref,name,status,created_at,updated_at,agent)
             VALUES('t2','user:t2','/p/proj','free_research','t2','旧目标','pending','now','now','codex')",
        [],
    )
    .unwrap();
    let t1: TaskDto = conn
        .query_row(
            &format!("SELECT {TASK_COLS} FROM tasks WHERE id='t1'"),
            [],
            map_task,
        )
        .unwrap();
    assert_eq!(t1.agent.as_deref(), Some("claude-code"));
    assert_eq!(t1.profile_id.as_deref(), Some("pf-1"));
    assert_eq!(t1.model.as_deref(), Some("glm-4.7"));
    let t2: TaskDto = conn
        .query_row(
            &format!("SELECT {TASK_COLS} FROM tasks WHERE id='t2'"),
            [],
            map_task,
        )
        .unwrap();
    assert_eq!(t2.agent.as_deref(), Some("codex"));
    assert_eq!(t2.profile_id, None);
    assert_eq!(t2.model, None);
}

fn goal_edit(name: &str) -> GoalEdit {
    GoalEdit {
        name: name.into(),
        description: format!("{name}，详细要求"),
        inputs: vec!["data".into()],
        outputs: vec![".".into()],
        review_required: true,
        agent: None,
        profile_id: None,
        model: None,
        skills: vec!["data-clean".into()],
    }
}

/// 记下未开始的目标可改要求、资料、技能与绑定；跑过 / 归档 / 非人声明的一律拒改
#[test]
fn goal_edit_only_before_first_run() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    for (id, identity, status, archived) in [
        ("fresh", "user:fresh", "pending", None),
        ("ran", "user:ran", "pending", None),
        ("stopped", "user:stopped", "stopped", None),
        ("archived", "user:archived", "pending", Some("now")),
        ("auto", "/p/proj", "pending", None),
    ] {
        conn.execute(
            "INSERT INTO tasks(id,identity_key,project_root,kind,task_ref,name,status,created_at,updated_at,agent,profile_id,archived_at)
                 VALUES(?1,?2,'/p/proj','office_doc',?1,'旧目标',?3,'now','now','codex','pf-1',?4)",
            params![id, identity, status, archived],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO runs(id,task_id,task_kind,project_root,isolation_path,runtime,agent,permission,status,created_at)
             VALUES('r1','ran','office_doc','/p/proj','/iso','local_cli','codex','write_tree','failed','now')",
        [],
    )
    .unwrap();

    apply_task_update(&conn, "fresh", goal_edit("整理周报")).unwrap();
    let (name, desc, inputs, skills, profile): (String, String, String, String, Option<String>) = conn
        .query_row(
            "SELECT name,description,input_paths,skills,profile_id FROM tasks WHERE id='fresh'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(name, "整理周报");
    assert_eq!(desc, "整理周报，详细要求");
    assert_eq!(inputs, r#"["data"]"#);
    assert_eq!(skills, r#"["data-clean"]"#);
    assert_eq!(profile, None, "清掉绑定 = 跟随项目默认");

    for id in ["ran", "stopped", "archived", "auto"] {
        assert!(apply_task_update(&conn, id, goal_edit("改")).is_err(), "{id} 不应可改");
    }
    assert!(apply_task_update(&conn, "fresh", goal_edit("  ")).is_err());
    assert!(apply_task_update(&conn, "missing", goal_edit("改")).is_err());
}

#[test]
fn goal_scope_rejects_mixed_and_mismatched_permission() {
    let root = std::env::temp_dir().join(format!("mesa-goal-scope-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("data/raw")).unwrap();
    // 生产侧的根来自 validate_existing_dir（已规范化）；macOS 临时目录 /var → /private/var
    let root_s = validate_existing_dir(&root.to_string_lossy(), "项目根目录").unwrap();
    let (inputs, outputs, review) = normalize_goal_scope(
        &root_s,
        &["data".into(), "data/raw".into()],
        &[".".into()],
        None,
    )
    .unwrap();
    assert_eq!(inputs, vec!["data".to_string()]);
    assert_eq!(outputs, vec![".".to_string()]);
    assert!(review);
    assert!(normalize_goal_scope(&root_s, &[".".into(), "data".into()], &[".".into()], None).is_err());
    assert!(normalize_goal_scope(&root_s, &[], &[".".into()], Some("discuss")).is_err());
    assert!(normalize_goal_scope(&root_s, &[], &[], Some("write_tree")).is_err());
    assert!(normalize_goal_scope(&root_s, &["../x".into()], &[], Some("discuss")).is_err());
    let _ = fs::remove_dir_all(&root);
}

fn journal_fixture() -> (PathBuf, PathBuf, PathBuf, Connection, GoalApplyJournal) {
    let base =
        std::env::temp_dir().join(format!("mesa-accept-recovery-{}", uuid::Uuid::new_v4()));
    let project = base.join("project");
    let review = base.join("review");
    let payload = review.join("payload");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&payload).unwrap();
    fs::write(project.join("a.md"), "old report").unwrap();
    fs::write(project.join("paper.md"), "protected paper").unwrap();
    fs::write(payload.join("a.md"), "reviewed report").unwrap();
    fs::write(payload.join("b.csv"), "reviewed data").unwrap();
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute("INSERT INTO tasks(id,identity_key,kind,name,review_required,status,created_at,updated_at) VALUES('goal','user:recovery','free_research','整理实验记录',1,'pending_review','now','now')", []).unwrap();
    let mut fact = crate::review_contract::fact_from_goal_adopt(
        &project,
        "goal",
        "整理实验记录",
        "run",
        Some(1),
        vec!["a.md".into(), "b.csv".into()],
        "仅接受已审版本".into(),
        true,
        "original-time".into(),
    );
    fact.content_fingerprints = fact
        .paths
        .iter()
        .map(|path| crate::projects::ContentFingerprint {
            path: path.clone(),
            size: fs::metadata(payload.join(path)).unwrap().len(),
            sha256: read_regular_optional(&payload.join(path), "test").unwrap(),
        })
        .collect();
    let journal = prepare_goal_journal(&review, &payload, &project, fact, false).unwrap();
    (base, project, review, conn, journal)
}

#[test]
fn interrupted_acceptance_resumes_exact_original_version_after_reload() {
    let (base, project, review, conn, mut journal) = journal_fixture();
    let mut writes = 0;
    let result = apply_goal_journal_with_writer(&review, &project, &mut journal, |src, dst| {
        writes += 1;
        if writes == 2 {
            return Err("simulated crash".into());
        }
        copy_adopt_file(src, dst)
    });
    assert!(result.is_err());
    assert_eq!(fs::read(project.join("a.md")).unwrap(), b"reviewed report");
    assert!(!project.join("b.csv").exists());
    fs::write(review.join("snapshot.json"), r#"{"seq":99}"#).unwrap();
    let mut recovered = read_goal_journal(&review).unwrap().unwrap();
    finish_goal_journal(&conn, &review, &project, &mut recovered).unwrap();
    assert_eq!(fs::read(project.join("b.csv")).unwrap(), b"reviewed data");
    assert_eq!(
        fs::read(project.join("paper.md")).unwrap(),
        b"protected paper"
    );
    assert_eq!(task_by_id(&conn, "goal").unwrap().status, "completed");
    assert!(read_goal_journal(&review).unwrap().is_none());
    let facts = crate::projects::read_acceptance_log_at(&project);
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].version_id, "run:1");
    assert_eq!(facts[0].decided_at, "original-time");
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn journal_retries_ledger_and_state_without_overwriting_later_edits() {
    let (base, project, review, conn, mut journal) = journal_fixture();
    let blocked = project.join(".ccode/acceptance-log.jsonl");
    fs::create_dir_all(&blocked).unwrap();
    assert!(finish_goal_journal(&conn, &review, &project, &mut journal).is_err());
    let mut recovered = read_goal_journal(&review).unwrap().unwrap();
    assert_eq!(recovered.phase, "files_applied");
    fs::write(project.join("a.md"), "user edit after application").unwrap();
    fs::remove_dir(&blocked).unwrap();
    // 在账本之后模拟数据库失败；文件阶段不得重跑，目标更新与事件同事务。
    conn.execute("DROP TABLE run_events", []).unwrap();
    assert!(finish_goal_journal(&conn, &review, &project, &mut recovered).is_err());
    assert_eq!(task_by_id(&conn, "goal").unwrap().status, "pending_review");
    assert_eq!(crate::projects::read_acceptance_log_at(&project).len(), 1);
    ensure_schema(&conn).unwrap();
    let mut recovered = read_goal_journal(&review).unwrap().unwrap();
    assert_eq!(recovered.phase, "recorded");
    assert!(rollback_goal_journal(&review, &project, &recovered).is_err());
    finish_goal_journal(&conn, &review, &project, &mut recovered).unwrap();
    assert_eq!(
        fs::read(project.join("a.md")).unwrap(),
        b"user edit after application"
    );
    assert_eq!(crate::projects::read_acceptance_log_at(&project).len(), 1);
    assert!(read_goal_journal(&review).unwrap().is_none());
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn journal_rollback_keeps_external_edits_and_can_restore_partial_apply() {
    let (base, project, review, _conn, mut journal) = journal_fixture();
    let mut count = 0;
    assert!(
        apply_goal_journal_with_writer(&review, &project, &mut journal, |src, dst| {
            count += 1;
            if count > 1 {
                return Err("stop".into());
            }
            copy_adopt_file(src, dst)
        })
        .is_err()
    );
    fs::write(project.join("b.csv"), "other user's data").unwrap();
    let journal = read_goal_journal(&review).unwrap().unwrap();
    assert!(rollback_goal_journal(&review, &project, &journal)
        .unwrap_err()
        .contains("外部修改"));
    assert_eq!(fs::read(project.join("a.md")).unwrap(), b"reviewed report");
    fs::remove_file(project.join("b.csv")).unwrap();
    rollback_goal_journal(&review, &project, &journal).unwrap();
    assert_eq!(fs::read(project.join("a.md")).unwrap(), b"old report");
    assert!(!project.join("b.csv").exists());
    assert!(read_goal_journal(&review).unwrap().is_none());
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn interrupted_rollback_cannot_be_mistaken_for_acceptance() {
    let (base, project, review, conn, mut journal) = journal_fixture();
    apply_goal_journal_with_writer(&review, &project, &mut journal, copy_adopt_file).unwrap();
    journal.phase = "rolling_back".into();
    write_goal_journal(&review, &journal).unwrap();
    copy_adopt_file(
        &Path::new(&journal.backup_dir).join("files/a.md"),
        &project.join("a.md"),
    )
    .unwrap();
    let mut recovered = read_goal_journal(&review).unwrap().unwrap();
    assert!(
        finish_goal_journal(&conn, &review, &project, &mut recovered)
            .unwrap_err()
            .contains("继续恢复")
    );
    rollback_goal_journal(&review, &project, &recovered).unwrap();
    assert_eq!(fs::read(project.join("a.md")).unwrap(), b"old report");
    assert!(!project.join("b.csv").exists());
    assert!(crate::projects::read_acceptance_log_at(&project).is_empty());
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn input_preflight_rejects_over_budget_before_any_copy() {
    let root = std::env::temp_dir().join(format!("mesa-preflight-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::File::create(root.join(".git/noise"))
        .unwrap()
        .set_len(MAX_TASK_INPUT_BYTES * 2)
        .unwrap();
    fs::write(root.join("small.md"), "ok").unwrap();
    assert!(estimate_task_inputs(&root, &[".".into()]).unwrap().allowed);
    fs::File::create(root.join("large.dat"))
        .unwrap()
        .set_len(MAX_TASK_INPUT_BYTES + 1)
        .unwrap();
    let estimate = estimate_task_inputs(&root, &[".".into()]).unwrap();
    assert_eq!(estimate.files, 2);
    assert!(!estimate.allowed);
    assert!(
        estimate_task_inputs(&root, &["small.md".into()])
            .unwrap()
            .allowed
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn closing_a_run_never_reopens_an_accepted_goal() {
    for status in ["completed", "failed", "stopped"] {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO tasks(id,identity_key,kind,name,review_required,status,created_at,updated_at) VALUES('task','user:accepted','free_research','已接受目标',1,'completed','now','now')", []).unwrap();
        conn.execute("INSERT INTO runs(id,task_id,task_kind,isolation_path,runtime,agent,permission,created_at,status) VALUES('run','task','free_research','/tmp','local_cli','test','write_tree','now','running')", []).unwrap();
        close_at(&conn, "run", None, status, None, None).unwrap();
        assert_eq!(
            task_by_id(&conn, "task").unwrap().status,
            "completed",
            "Run {status} 不得覆盖人的接受决定"
        );
        continue_active_goal(&conn, "task", "run", Some("请修改措辞")).unwrap();
        assert_eq!(
            task_by_id(&conn, "task").unwrap().status,
            "running",
            "用户显式返修应重开目标"
        );
    }
}

#[test]
fn moved_project_resolves_goal_and_run_without_rewriting_history() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute_batch("CREATE TABLE projects(path TEXT PRIMARY KEY,id TEXT);
            INSERT INTO projects VALUES('/new-project','project-id');
            INSERT INTO tasks(id,identity_key,kind,name,project_id,project_root,created_at,updated_at)
            VALUES('task','user:moved','free_research','目标','project-id','/old-project','now','now');
            INSERT INTO runs(id,task_id,task_kind,project_id,project_root,isolation_path,runtime,agent,permission,created_at,status)
            VALUES('run','task','free_research','project-id','/old-project','/isolated-run','local_cli','test','write_tree','now','running');").unwrap();
    assert_eq!(
        task_by_id(&conn, "task").unwrap().project_root.as_deref(),
        Some("/new-project")
    );
    let run = get_run_at(&conn, "run").unwrap().unwrap();
    assert_eq!(run.project_root.as_deref(), Some("/new-project"));
    assert_eq!(run.isolation_path, "/isolated-run");
    conn.execute(
        "UPDATE runs SET isolation_path='/old-project' WHERE id='run'",
        [],
    )
    .unwrap();
    assert_eq!(
        query_runs(&conn, "WHERE id='run'", []).unwrap()[0].isolation_path,
        "/new-project"
    );
    let historical: String = conn
        .query_row("SELECT project_root FROM runs WHERE id='run'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(historical, "/old-project");
    conn.execute(
        "INSERT INTO projects VALUES('/another-copy','project-id')",
        [],
    )
    .unwrap();
    assert!(task_by_id(&conn, "task").unwrap_err().contains("多个位置"));
}

#[test]
fn output_events_are_bounded_without_deleting_lifecycle_events() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    record_event(&conn, "r", "run.started", None).unwrap();
    for i in 0..OUTPUT_EVENT_CAP + 5 {
        persist_output(&conn, "r", &format!("line {i}\n")).unwrap();
    }
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM run_events WHERE run_id='r' AND event_type='run.output'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, OUTPUT_EVENT_CAP as i64);
    let lifecycle: i64 = conn
        .query_row(
            "SELECT count(*) FROM run_events WHERE event_type='run.started'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(lifecycle, 1);
    assert!(output_tail("sk-partial").is_empty());
    assert!(!output_tail("sk-supersecrettoken123456\n").contains("sk-supersecrettoken"));
}

#[test]
fn interactive_start_reclaims_zombie_starting_or_running() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO tasks(id,identity_key,kind,name,created_at,updated_at) VALUES('task','task','scratch','task','now','now')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO runs(id,task_id,task_kind,isolation_path,runtime,agent,permission,created_at,status) VALUES('run','task','scratch','/tmp','local_cli','test','discuss','now','running')",
        [],
    )
    .unwrap();
    mark_starting_for_interactive(&conn, "run").unwrap();
    let status: String = conn
        .query_row("SELECT status FROM runs WHERE id='run'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(status, "starting");
    conn.execute(
        "UPDATE runs SET status='completed', closed_at='now' WHERE id='run'",
        [],
    )
    .unwrap();
    let err = mark_starting_for_interactive(&conn, "run").unwrap_err();
    assert!(err.contains("已结束"), "{err}");
}

#[test]
fn run_lease_distinguishes_live_from_stale_and_releases_on_drop() {
    let dir = std::env::temp_dir().join(format!("ccode-run-lease-{}", uuid::Uuid::new_v4()));
    let live = try_run_lease(&dir, "run1").unwrap().unwrap();
    assert!(try_run_lease(&dir, "run1").unwrap().is_none());
    assert!(try_run_lease(&dir, "run2").unwrap().is_some());
    drop(live);
    assert!(try_run_lease(&dir, "run1").unwrap().is_some());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn review_status_promotes_failed_run_only_with_adoptable_changes() {
    // 失败/停止 + 有可审成果 → 待验收；没有成果保持原状；completed 不走这条提升
    assert_eq!(review_status_for("failed", true), Some("pending_review"));
    assert_eq!(review_status_for("stopped", true), Some("pending_review"));
    assert_eq!(review_status_for("failed", false), None);
    assert_eq!(review_status_for("stopped", false), None);
    assert_eq!(review_status_for("completed", true), None);
    assert_eq!(review_status_for("running", true), None);
}

#[test]
fn failed_prepare_cleanup_never_deletes_reused_isolation_dir() {
    let base =
        std::env::temp_dir().join(format!("ccode-prepare-cleanup-{}", uuid::Uuid::new_v4()));
    let reused = base.join("reused");
    let staging = base.join("staging");
    fs::create_dir_all(&reused).unwrap();
    fs::create_dir_all(&staging).unwrap();
    fs::write(reused.join("draft.md"), "旧成果").unwrap();
    // 复用上一版目录（reuse_isolation=true）：启动失败不得删旧成果
    cleanup_failed_prepare(false, &reused);
    assert!(reused.join("draft.md").is_file());
    // 本次新建的 staging：失败时照常清理
    cleanup_failed_prepare(true, &staging);
    assert!(!staging.exists());
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn startup_reconciliation_skips_live_run_and_closes_stale_run() {
    let dir =
        std::env::temp_dir().join(format!("ccode-run-reconcile-{}", uuid::Uuid::new_v4()));
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute("INSERT INTO tasks(id,identity_key,kind,name,created_at,updated_at) VALUES('task','task','scratch','task','now','now')", []).unwrap();
    for id in ["live", "stale"] {
        conn.execute("INSERT INTO runs(id,task_id,task_kind,isolation_path,runtime,agent,permission,created_at,status) VALUES(?1,'task','scratch','/tmp','local_cli','test','discuss','now','running')", [id]).unwrap();
    }
    let live = try_run_lease(&dir, "live").unwrap().unwrap();
    assert_eq!(
        reconcile_ids(&conn, &dir, &["live".into(), "stale".into()]).unwrap(),
        1
    );
    let status = |id| {
        conn.query_row("SELECT status FROM runs WHERE id=?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .unwrap()
    };
    assert_eq!(status("live"), "running");
    assert_eq!(status("stale"), "failed");
    drop(live);
    assert_eq!(reconcile_ids(&conn, &dir, &["live".into()]).unwrap(), 1);
    assert_eq!(status("live"), "failed");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn resume_by_id_tolerates_unspecified_identity_fields() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute("INSERT INTO tasks(id,identity_key,kind,name,created_at,updated_at) VALUES('task','user:目标','free_research','目标X','now','now')", []).unwrap();
    conn.execute("INSERT INTO runs(id,task_id,task_kind,task_ref,isolation_path,runtime,agent,permission,created_at,status,reuse_key) VALUES('run','task','free_research','目标X','/tmp/ccode-task-runs/task/x','local_cli','claude-code','write_tree','now','running','task:task')", []).unwrap();
    let input = |kind: Option<&str>, task_ref: Option<&str>| OpenRunInput {
        id: Some("run".into()),
        task_id: None,
        project_root: None,
        task_kind: kind.map(Into::into),
        task_ref: task_ref.map(Into::into),
        isolation_path: "/tmp/ccode-task-runs/task/x".into(),
        runtime: Some("local_cli".into()),
        agent: "claude-code".into(),
        profile_id: None,
        permission: Some("write_tree".into()),
        reuse_key: Some("task:task".into()),
        session_id: None,
        custom_runtime_id: None,
        internal: Some(false),
        sentinel: Some(false),
    };
    // 恢复带 id 且未显式给 kind/ref（open_run_impl 对 id 命中不再推断）：
    // 不与已登记值比较，直接复用同一 Run
    let resumed = open_at(&conn, input(None, None)).unwrap();
    assert_eq!(resumed.id, "run");
    assert_eq!(resumed.task_kind, "free_research");
    // 显式给了不一致身份（修复前推断结果就是 scratch/目录名）仍拒绝
    let err = open_at(&conn, input(Some("scratch"), Some("x"))).unwrap_err();
    assert!(err.contains("不一致"), "{err}");
}

#[test]
fn custom_runtime_on_scratch_is_not_isolated_write() {
    assert!(!requires_isolated_write_tree("scratch", false));
    assert!(!requires_isolated_write_tree("office_doc", false));
    assert!(!requires_isolated_write_tree("free_research", false));
    assert!(requires_isolated_write_tree("coding_lane", false));
    assert!(requires_isolated_write_tree("pipeline_step", false));
    assert!(requires_isolated_write_tree("watch", false));
    assert!(!requires_isolated_write_tree("watch", true));
}

#[test]
fn unwritten_session_is_replaced_so_the_run_reopens_fresh() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute("INSERT INTO runs(id,task_kind,isolation_path,runtime,agent,permission,created_at,status,closed_at,session_id) VALUES('run','chat','/tmp/ccode-x','local_cli','claude-code','write_tree','now','failed','later','s1')", []).unwrap();
    // 旧 id 对不上、Run 上的会话又是真实对话：不动
    replace_unwritten_session_at(&conn, "run", "other", "s2", |_| false).unwrap();
    let sid: String = conn.query_row("SELECT session_id FROM runs WHERE id='run'", [], |r| r.get(0)).unwrap();
    assert_eq!(sid, "s1");
    replace_unwritten_session_at(&conn, "run", "s1", "s2", |_| false).unwrap();
    // 标签重启又拿最初的 s1 来恢复，而 Run 上的 s2 同样没落盘：照样换掉
    replace_unwritten_session_at(&conn, "run", "s1", "s3", |sid| sid == "s2").unwrap();
    let sid: String = conn.query_row("SELECT session_id FROM runs WHERE id='run'", [], |r| r.get(0)).unwrap();
    assert_eq!(sid, "s3");
    let input = OpenRunInput {
        id: Some("run".into()),
        task_id: None,
        project_root: None,
        task_kind: None,
        task_ref: None,
        isolation_path: "/tmp/ccode-x".into(),
        runtime: Some("local_cli".into()),
        agent: "claude-code".into(),
        profile_id: None,
        permission: Some("write_tree".into()),
        reuse_key: None,
        session_id: Some("s3".into()),
        custom_runtime_id: None,
        internal: Some(false),
        sentinel: Some(false),
    };
    // 换过会话后同一条 Run 能以新会话重新打开，不再报「恢复会话与原 Run 不一致」
    let reopened = open_at(&conn, input).unwrap();
    assert_eq!(reopened.id, "run");
    assert_eq!(reopened.session_id.as_deref(), Some("s3"));
}

#[test]
fn resume_adopts_session_when_run_never_attached() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    // 交互 Run 停下时还没登记会话（2026-10-21 Gemini 存量）
    conn.execute("INSERT INTO runs(id,task_kind,isolation_path,runtime,agent,permission,created_at,status,closed_at) VALUES('run','scratch','/tmp/ccode-x','local_cli','gemini','write_tree','now','stopped','later')", []).unwrap();
    let input = |sid: &str| OpenRunInput {
        id: Some("run".into()),
        task_id: None,
        project_root: None,
        task_kind: None,
        task_ref: None,
        isolation_path: "/tmp/ccode-x".into(),
        runtime: Some("local_cli".into()),
        agent: "gemini".into(),
        profile_id: None,
        permission: Some("write_tree".into()),
        reuse_key: None,
        session_id: Some(sid.into()),
        custom_runtime_id: None,
        internal: Some(false),
        sentinel: Some(false),
    };
    let reopened = open_at(&conn, input("g1")).unwrap();
    assert_eq!(reopened.session_id.as_deref(), Some("g1"));
    assert!(reopened.closed_at.is_none());
    // 认下之后照旧：别的会话来恢复仍拒绝
    conn.execute("UPDATE runs SET closed_at='later2',status='stopped' WHERE id='run'", []).unwrap();
    let err = open_at(&conn, input("g2")).unwrap_err();
    assert!(err.contains("不一致"), "{err}");
}

#[test]
fn resume_returns_goal_task_to_running() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute("INSERT INTO tasks(id,identity_key,kind,name,status,created_at,updated_at) VALUES('task','user:目标','free_research','目标X','failed','now','now')", []).unwrap();
    conn.execute("INSERT INTO runs(id,task_id,task_kind,task_ref,isolation_path,runtime,agent,permission,created_at,status,closed_at,session_id,reuse_key) VALUES('run','task','free_research','目标X','/tmp/ccode-task-runs/task/x','local_cli','claude-code','write_tree','now','failed','later','s1','task:task')", []).unwrap();
    let input = OpenRunInput {
        id: Some("run".into()),
        task_id: None,
        project_root: None,
        task_kind: None,
        task_ref: None,
        isolation_path: "/tmp/ccode-task-runs/task/x".into(),
        runtime: Some("local_cli".into()),
        agent: "claude-code".into(),
        profile_id: None,
        permission: Some("write_tree".into()),
        reuse_key: Some("task:task".into()),
        session_id: Some("s1".into()),
        custom_runtime_id: None,
        internal: Some(false),
        sentinel: Some(false),
    };
    let resumed = open_at(&conn, input).unwrap();
    assert_eq!(resumed.id, "run");
    let status: String = conn
        .query_row("SELECT status FROM tasks WHERE id='task'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(status, "running", "恢复 Run 后目标不能停在 failed/重试");
}

#[test]
fn project_id_backfills_from_projects_by_path() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute_batch("CREATE TABLE IF NOT EXISTS projects(path TEXT PRIMARY KEY, name TEXT NOT NULL, id TEXT);").unwrap();
    conn.execute(
        "INSERT INTO projects(path,name,id) VALUES('/p','课题','pid-1')",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('t','user:x','free_research','x','/p','n','n')", []).unwrap();
    conn.execute("INSERT INTO runs(id,task_id,task_kind,isolation_path,runtime,agent,permission,created_at,status,project_root) VALUES('r','t','free_research','/tmp/x','local_cli','a','write_tree','n','completed','/p')", []).unwrap();
    backfill_project_ids(&conn).unwrap();
    let tid: Option<String> = conn
        .query_row("SELECT project_id FROM tasks WHERE id='t'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let rid: Option<String> = conn
        .query_row("SELECT project_id FROM runs WHERE id='r'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tid.as_deref(), Some("pid-1"));
    assert_eq!(rid.as_deref(), Some("pid-1"));
    // 无 projects 表的纯净库跳过不报错
    let bare = Connection::open_in_memory().unwrap();
    ensure_schema(&bare).unwrap();
}

/// db() 每次调用都过 ensure_schema；别的连接正持有写锁（后台落库）时，它不能再去申请写锁，
/// 否则主线程上的轮询命令会等满 busy_timeout。回填 UPDATE 命中 0 行也要写锁，这里钉住「无事可做就不写」
#[test]
fn ensure_schema_needs_no_write_lock_when_nothing_to_backfill() {
    let path = std::env::temp_dir().join(format!("ccode-schema-lock-{}.db", uuid::Uuid::new_v4()));
    let writer = Connection::open(&path).unwrap();
    ensure_schema(&writer).unwrap();
    writer
        .execute_batch("CREATE TABLE projects(path TEXT PRIMARY KEY, name TEXT NOT NULL, id TEXT);")
        .unwrap();
    // 有项目表、有行但都已有归属 / 都没有匹配项目：都不该触发写
    writer.execute("INSERT INTO projects(path,name,id) VALUES('/p','课题','pid-1')", []).unwrap();
    writer.execute("INSERT INTO tasks(id,identity_key,kind,name,project_root,project_id,created_at,updated_at) VALUES('t1','user:a','free_research','a','/p','pid-1','n','n')", []).unwrap();
    writer.execute("INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('t2','user:b','free_research','b','/unregistered','n','n')", []).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let reader = Connection::open(&path).unwrap();
    reader.busy_timeout(std::time::Duration::from_millis(0)).unwrap();
    let result = ensure_schema(&reader);
    writer.execute_batch("ROLLBACK").unwrap();
    drop((writer, reader));
    let _ = std::fs::remove_file(&path);
    assert!(result.is_ok(), "写锁被占时 ensure_schema 不该失败：{result:?}");
}

/// 回填判断不能把真正需要回填的行漏掉
#[test]
fn backfill_still_runs_when_a_registered_project_matches() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute_batch("CREATE TABLE projects(path TEXT PRIMARY KEY, name TEXT NOT NULL, id TEXT);").unwrap();
    conn.execute("INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('t','user:x','free_research','x','/late','n','n')", []).unwrap();
    backfill_project_ids(&conn).unwrap();
    let none: Option<String> = conn.query_row("SELECT project_id FROM tasks WHERE id='t'", [], |r| r.get(0)).unwrap();
    assert_eq!(none, None, "项目还没登记，不该凭空分配");
    conn.execute("INSERT INTO projects(path,name,id) VALUES('/late','迟到','pid-late')", []).unwrap();
    backfill_project_ids(&conn).unwrap();
    let got: Option<String> = conn.query_row("SELECT project_id FROM tasks WHERE id='t'", [], |r| r.get(0)).unwrap();
    assert_eq!(got.as_deref(), Some("pid-late"));
}

#[test]
fn task_list_hides_archived_unless_asked() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('live','user:活','free_research','活目标','/p','n','n')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tasks(id,identity_key,kind,name,project_root,archived_at,created_at,updated_at) VALUES('old','user:旧','free_research','旧目标','/p','2026-09-09T00:00:00Z','n','n')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('other','user:旁','office_doc','旁项目','/q','n','n')",
        [],
    )
    .unwrap();
    let active = list_tasks_at(&conn, Some("/p"), false).unwrap();
    assert_eq!(
        active.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["live"]
    );
    let all = list_tasks_at(&conn, Some("/p"), true).unwrap();
    assert_eq!(all.len(), 2);
    archive_goal_at(&conn, "live").unwrap();
    assert_eq!(list_tasks_at(&conn, Some("/p"), false).unwrap().len(), 0);
    let restored = unarchive_goal_at(&conn, "old").unwrap();
    assert!(restored.archived_at.is_none());
    assert_eq!(list_tasks_at(&conn, Some("/p"), false).unwrap().len(), 1);
    unarchive_goal_at(&conn, "old").unwrap(); // 幂等
    purge_archived_goal_at(&conn, "other").unwrap_err();
    purge_archived_goal_at(&conn, "live").unwrap();
    assert!(list_tasks_at(&conn, Some("/p"), true)
        .unwrap()
        .iter()
        .all(|task| task.id != "live"));
}

#[test]
fn archive_and_restore_wait_for_cleanup_pending_review_still_allowed() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO tasks(id,identity_key,kind,name,status,project_root,review_required,created_at,updated_at) VALUES('t','user:归档','free_research','归档目标','pending_review','/p',1,'n','n')",
        [],
    )
    .unwrap();
    archive_goal_at(&conn, "t").unwrap();
    let archived: Option<String> = conn
        .query_row("SELECT archived_at FROM tasks WHERE id='t'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(archived.is_some());
    conn.execute("UPDATE tasks SET archived_at=NULL, status='completed'", [])
        .unwrap();
    conn.execute(
        "INSERT INTO goal_storage_pending(task_id,payload) VALUES('t','{}')",
        [],
    )
    .unwrap();
    assert!(archive_goal_at(&conn, "t")
        .unwrap_err()
        .contains("副本清理"));
    conn.execute("UPDATE tasks SET archived_at='now'", [])
        .unwrap();
    assert!(unarchive_goal_at(&conn, "t")
        .unwrap_err()
        .contains("副本清理"));
    conn.execute("DELETE FROM goal_storage_pending", [])
        .unwrap();
    assert!(unarchive_goal_at(&conn, "t").unwrap().archived_at.is_none());
}

#[test]
fn task_list_by_project_id_does_not_scan_whole_table() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects(path TEXT PRIMARY KEY, name TEXT NOT NULL, id TEXT);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO projects(path,name,id) VALUES('/new','课题','pid-1')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tasks(id,identity_key,kind,name,project_root,project_id,created_at,updated_at) VALUES('t1','user:a','free_research','旧路径目标','/old','pid-1','n','n')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tasks(id,identity_key,kind,name,project_root,created_at,updated_at) VALUES('t2','user:b','free_research','旁项目','/other','n','n')",
        [],
    )
    .unwrap();
    let moved = list_tasks_at(&conn, Some("/new"), true).unwrap();
    assert_eq!(moved.len(), 1);
    assert_eq!(moved[0].id, "t1");
    let unknown = list_tasks_at(&conn, Some("/other"), true).unwrap();
    assert_eq!(unknown.len(), 1);
    assert_eq!(unknown[0].id, "t2");
    let all = list_tasks_at(&conn, None, true).unwrap();
    assert_eq!(all.len(), 2);
}

#[test]
fn scratch_and_reader_runs_have_no_goal_task() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    let input = |kind: &str, path: &str| OpenRunInput {
        id: None,
        task_id: None,
        project_root: None,
        task_kind: Some(kind.into()),
        task_ref: None,
        isolation_path: path.into(),
        runtime: Some("local_cli".into()),
        agent: "claude-code".into(),
        profile_id: None,
        permission: Some("write_tree".into()),
        reuse_key: None,
        session_id: None,
        custom_runtime_id: None,
        internal: Some(false),
        sentinel: Some(false),
    };
    // 随手聊/阅读/办公文件闲聊：Run 可以没有 Goal，不再自动登记 Task 行
    for (kind, path) in [
        ("scratch", "/tmp/ccode-scratch/a"),
        ("reader", "/tmp/ccode-reader/b"),
        ("office_doc", "/tmp/ccode-office/c"),
    ] {
        let run = open_at(&conn, input(kind, path)).unwrap();
        assert!(run.task_id.is_empty(), "{kind} 不应有 Task");
    }
    let count: i64 = conn
        .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "无目标执行不得在 tasks 表留行");
    // 归属类执行（科研步骤/编程车道）仍登记 Task
    let lane = open_at(&conn, input("coding_lane", "/tmp/ccode-worktrees/r/feat")).unwrap();
    assert!(!lane.task_id.is_empty());
}

#[test]
fn reader_key_carries_paper() {
    assert_eq!(reader_pdf_of_key("reader:/p\n/p/papers/a.pdf").as_deref(), Some("/p/papers/a.pdf"));
    // 旧键按项目一个：认得出是精读对话，认不出读的哪篇
    assert_eq!(reader_pdf_of_key("reader:/p"), None);
    assert_eq!(reader_pdf_of_key("lane:/p\n/x.pdf"), None);
    assert_eq!(infer_project_root("reader:/p\n/p/a.pdf", "/p").as_deref(), Some("/p"));
}

#[test]
fn infer_task_kind_prefixes() {
    assert_eq!(infer_task_kind("login:claude-code", "/x"), "login");
    assert_eq!(infer_task_kind("reader:/p", "/p"), "reader");
    assert_eq!(infer_task_kind("reader:/p\n/p/papers/a.pdf", "/p"), "reader");
    assert_eq!(infer_task_kind("watch:s1:/p", "/p"), "watch");
    assert_eq!(infer_task_kind("office:/p:file", "/p"), "office_doc");
    assert_eq!(infer_task_kind("free:/p:task", "/p"), "free_research");
    assert_eq!(infer_task_kind("ws:/wt", "/wt"), "pipeline_step");
    assert_eq!(canonicalize_reuse_key("wt:/t"), "lane:/t");
    assert_eq!(infer_task_kind("wt:/t", "/t"), "coding_lane");
    assert_eq!(infer_task_kind("lane:/t", "/t"), "coding_lane");
    assert_eq!(
        infer_task_kind(
            "custom:r1:/Users/me/ccode/worktrees/r/feat",
            "/Users/me/ccode/worktrees/r/feat"
        ),
        "coding_lane"
    );
    assert_eq!(
        infer_task_kind("coding:/repo:project", "/repo"),
        "coding_lane"
    );
    assert_eq!(infer_task_kind("headless:ai-prompt:x", "/tmp"), "scratch");
    assert_eq!(infer_task_kind("", "/Users/me/ccode/scratch/a"), "scratch");
    assert_eq!(
        infer_task_kind("", "/Users/me/ccode/workspaces/r/lit"),
        "pipeline_step"
    );
    assert_eq!(
        infer_task_kind("", "/Users/me/ccode/worktrees/r/feat"),
        "coding_lane"
    );
}

#[test]
fn watch_is_internal() {
    assert!(is_internal_kind("watch", "watch:1:/p"));
    assert!(is_internal_kind("scratch", "headless:ai-prompt:x"));
    assert!(!is_internal_kind("pipeline_step", "ws:/x"));
}

#[test]
fn prune_nested_rel_paths_keeps_parent() {
    assert_eq!(
        prune_nested_rel_paths(&["notes/a.md".into(), "notes".into(), "papers/a.pdf".into()]),
        vec!["notes".to_string(), "papers/a.pdf".to_string()]
    );
    assert_eq!(
        prune_nested_rel_paths(&[".".into(), "notes".into()]),
        vec![".".to_string()]
    );
}

#[test]
fn project_scope_copy_skips_ccode_and_dependency_directories() {
    let root = std::env::temp_dir().join(format!("ccode-task-scope-{}", uuid::Uuid::new_v4()));
    let target = root.join("target");
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::create_dir_all(root.join(".ccode")).unwrap();
    std::fs::create_dir_all(root.join("node_modules")).unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join(".git/config"), "secret").unwrap();
    std::fs::write(root.join(".ccode/project.toml"), "secret").unwrap();
    std::fs::write(root.join("node_modules/pkg.js"), "dependency").unwrap();
    std::fs::write(root.join("src/main.ts"), "export {}").unwrap();
    copy_project_contents(&root, &target, &mut TaskCopyBudget::default()).unwrap();
    assert!(target.join("src/main.ts").is_file());
    assert!(!target.join(".git").exists());
    assert!(!target.join(".ccode").exists());
    assert!(!target.join("node_modules").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn list_output_changes_marks_added_and_modified() {
    let root = std::env::temp_dir().join(format!("ccode-task-review-{}", uuid::Uuid::new_v4()));
    let source = root.join("run");
    let target = root.join("project");
    std::fs::create_dir_all(source.join("notes")).unwrap();
    std::fs::create_dir_all(target.join("notes")).unwrap();
    std::fs::write(source.join("notes/changed.md"), "new").unwrap();
    std::fs::write(target.join("notes/changed.md"), "old").unwrap();
    std::fs::write(source.join("notes/new.md"), "added").unwrap();
    std::fs::write(source.join("notes/same.md"), "same").unwrap();
    std::fs::write(target.join("notes/same.md"), "same").unwrap();

    let changes = list_output_changes(&source, &target, &[".".to_string()]).unwrap();
    assert_eq!(
        changes
            .iter()
            .map(|item| (item.path.as_str(), item.kind.as_str()))
            .collect::<Vec<_>>(),
        vec![("notes/changed.md", "modified"), ("notes/new.md", "added")]
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn adopt_selected_files_overwrites_after_review() {
    let root = std::env::temp_dir().join(format!("ccode-task-adopt-{}", uuid::Uuid::new_v4()));
    let source = root.join("run");
    let target = root.join("project");
    std::fs::create_dir_all(source.join("notes")).unwrap();
    std::fs::create_dir_all(target.join("notes")).unwrap();
    std::fs::write(source.join("notes/keep.md"), "new-keep").unwrap();
    std::fs::write(target.join("notes/keep.md"), "old-keep").unwrap();
    std::fs::write(source.join("notes/skip.md"), "new-skip").unwrap();
    std::fs::write(target.join("notes/skip.md"), "old-skip").unwrap();
    std::fs::write(source.join("notes/extra.md"), "added").unwrap();

    copy_adopt_file(&source.join("notes/keep.md"), &target.join("notes/keep.md")).unwrap();
    copy_adopt_file(
        &source.join("notes/extra.md"),
        &target.join("notes/extra.md"),
    )
    .unwrap();

    assert_eq!(
        std::fs::read_to_string(target.join("notes/keep.md")).unwrap(),
        "new-keep"
    );
    assert_eq!(
        std::fs::read_to_string(target.join("notes/skip.md")).unwrap(),
        "old-skip"
    );
    assert_eq!(
        std::fs::read_to_string(target.join("notes/extra.md")).unwrap(),
        "added"
    );
    #[cfg(unix)]
    {
        let link = target.join("notes/link.md");
        std::os::unix::fs::symlink(target.join("notes/keep.md"), &link).unwrap();
        assert!(copy_adopt_file(&source.join("notes/keep.md"), &link).is_err());
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn adopt_second_file_failure_rolls_back_first() {
    let root =
        std::env::temp_dir().join(format!("ccode-task-adopt-rb-{}", uuid::Uuid::new_v4()));
    let source = root.join("run");
    let target = root.join("project");
    let adopt = root.join("adopt-state");
    std::fs::create_dir_all(source.join("notes")).unwrap();
    std::fs::create_dir_all(target.join("notes")).unwrap();
    std::fs::write(source.join("notes/first.md"), "new-first").unwrap();
    std::fs::write(target.join("notes/first.md"), "old-first").unwrap();
    std::fs::write(source.join("notes/second.md"), "new-second").unwrap();
    std::fs::write(target.join("notes/second.md"), "old-second").unwrap();
    TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = Some(adopt));
    let mut remaining = 1;
    let result = adopt_selected_with_writer(
        "run-1",
        &source,
        &target,
        &["notes/first.md".into(), "notes/second.md".into()],
        |src, dst| {
            if remaining == 0 {
                return Err("injected failure".into());
            }
            remaining -= 1;
            copy_adopt_file(src, dst)
        },
    );
    TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = None);
    assert!(result.unwrap_err().contains("injected failure"));
    assert_eq!(
        std::fs::read_to_string(target.join("notes/first.md")).unwrap(),
        "old-first"
    );
    assert_eq!(
        std::fs::read_to_string(target.join("notes/second.md")).unwrap(),
        "old-second"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn adopt_detects_concurrent_change_and_rolls_back() {
    let root =
        std::env::temp_dir().join(format!("ccode-task-adopt-race-{}", uuid::Uuid::new_v4()));
    let source = root.join("run");
    let target = root.join("project");
    let adopt = root.join("adopt-state");
    std::fs::create_dir_all(source.join("notes")).unwrap();
    std::fs::create_dir_all(target.join("notes")).unwrap();
    std::fs::write(source.join("notes/first.md"), "new-first").unwrap();
    std::fs::write(target.join("notes/first.md"), "old-first").unwrap();
    std::fs::write(source.join("notes/second.md"), "new-second").unwrap();
    std::fs::write(target.join("notes/second.md"), "old-second").unwrap();
    TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = Some(adopt));
    let second = target.join("notes/second.md");
    let result = adopt_selected_with_writer(
        "run-2",
        &source,
        &target,
        &["notes/first.md".into(), "notes/second.md".into()],
        |src, dst| {
            copy_adopt_file(src, dst)?;
            if dst.ends_with("first.md") {
                std::fs::write(&second, "external").unwrap();
            }
            Ok(())
        },
    );
    TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = None);
    assert!(result.unwrap_err().contains("采纳期间变化"));
    assert_eq!(
        std::fs::read_to_string(target.join("notes/first.md")).unwrap(),
        "old-first"
    );
    assert_eq!(std::fs::read_to_string(&second).unwrap(), "external");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn specified_output_existing_file_is_modified_not_rejected() {
    let root =
        std::env::temp_dir().join(format!("ccode-task-specified-{}", uuid::Uuid::new_v4()));
    let source = root.join("run");
    let target = root.join("project");
    std::fs::create_dir_all(source.join("notes")).unwrap();
    std::fs::create_dir_all(target.join("notes")).unwrap();
    std::fs::write(source.join("notes/result.md"), "new").unwrap();
    std::fs::write(target.join("notes/result.md"), "old").unwrap();
    let changes =
        list_output_changes(&source, &target, &["notes/result.md".to_string()]).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, "notes/result.md");
    assert_eq!(changes[0].kind, "modified");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn protected_paths_block_descendant_files() {
    let protected = vec!["数据/raw".to_string()];
    assert!(crate::projects::path_is_protected(
        "数据/raw/a.csv",
        &protected
    ));
    assert!(!crate::projects::path_is_protected(
        "论文/综述.md",
        &protected
    ));
}

#[test]
fn adopt_rolls_back_a_file_even_if_writer_fails_after_replacing_it() {
    let root =
        std::env::temp_dir().join(format!("ccode-adopt-after-write-{}", uuid::Uuid::new_v4()));
    let source = root.join("run");
    let target = root.join("project");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::write(source.join("file.md"), "new").unwrap();
    fs::write(target.join("file.md"), "old").unwrap();
    TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = Some(root.join("adopt")));
    let result =
        adopt_selected_with_writer("run", &source, &target, &["file.md".into()], |src, dst| {
            copy_adopt_file(src, dst)?;
            Err("failure after replace".into())
        });
    TEST_ADOPT_ROOT.with(|c| *c.borrow_mut() = None);
    assert!(result.unwrap_err().contains("failure after replace"));
    assert_eq!(fs::read(target.join("file.md")).unwrap(), b"old");
    assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn goal_headless_capability_gate() {
    assert!(goal_headless_block_reason("claude-code", "write_tree").is_none());
    assert!(goal_headless_block_reason("qwen", "write_tree").is_some(), "qwen 无头写盘未验证");
    assert!(goal_headless_block_reason("codex", "discuss").is_none());
    assert!(goal_headless_block_reason("gemini", "discuss").is_some(), "只读形态没保证的不无头");
    assert!(goal_headless_block_reason("no-such-agent", "write_tree").is_some());
}

/// 子进程里跑的端到端用例靠它认出自己是被调起的（直接 `--ignored` 跑不会动真实配置目录）
#[cfg(unix)]
const GOAL_HEADLESS_E2E_ENV: &str = "MESA_GOAL_HEADLESS_E2E";

/// 目标无头运行整条后端链路：新建目标 → task_prepare_run → 无头起桩 Agent → 收尾冻结 → 待验收；
/// 另含失败、用户停止、同副本接着做。整条链读写 app.db 与任务副本目录，测试进程不能碰真实配置，
/// 所以把用例放到 HOME 指向临时目录的子进程里跑（dirs 在 unix 上按 HOME 取配置目录）
#[cfg(unix)]
#[test]
fn goal_headless_end_to_end_in_isolated_home() {
    let home = std::env::temp_dir().join(format!("mesa-goal-headless-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&home).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "runs::tests::goal_headless_e2e_child",
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("HOME", &home)
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("OPENCODE_CONFIG_DIR")
        .env_remove("MESA_SANDBOX_HOME")
        .env(GOAL_HEADLESS_E2E_ENV, "1")
        .output()
        .unwrap();
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let _ = fs::remove_dir_all(&home);
    assert!(output.status.success(), "{text}");
    assert!(text.contains("1 passed"), "子进程用例没有真正跑到：{text}");
}

#[cfg(unix)]
#[test]
#[ignore = "由 goal_headless_end_to_end_in_isolated_home 在临时 HOME 的子进程里调起"]
fn goal_headless_e2e_child() {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};
    if std::env::var_os(GOAL_HEADLESS_E2E_ENV).is_none() {
        return;
    }
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    let project = home.join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("notes.md"), "原始笔记\n").unwrap();
    let root = validate_existing_dir(&project.to_string_lossy(), "项目根目录").unwrap();
    tauri::async_runtime::block_on(crate::projects::register_project(root.clone(), "课题".into()))
        .unwrap();
    let bin = home.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let stub = |name: &str, body: &str| {
        let path = bin.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    let goal = |name: &str| {
        task_create_sync(CreateTaskInput {
            project_root: root.clone(),
            kind: "free_research".into(),
            name: name.into(),
            description: None,
            input_paths: vec![".".into()],
            output_paths: vec![".".into()],
            permission: Some("write_tree".into()),
            agent: None,
            profile_id: None,
            model: None,
            skills: vec![],
        })
        .unwrap()
    };
    let prepare = |task: &TaskDto, reuse: bool| {
        task_prepare_run_impl(PrepareTaskRunInput {
            task_id: task.id.clone(),
            agent: "claude-code".into(),
            profile_id: "stub-profile".into(),
            reuse_isolation: Some(reuse),
            feedback: None,
            context_text: Some(format!("目标：{}", task.name)),
        })
        .unwrap()
    };
    // 桩 Agent 代替真实 CLI：在隔离副本里按脚本干活（真实链路里的参数拼装与定时任务共用，另有测试）
    let launch = |run: &RunDto, script: &Path| {
        let (run, _) = headless_goal_target(&run.id).unwrap();
        let mut cmd = crate::process::background_command("/bin/sh");
        cmd.arg(script).current_dir(&run.isolation_path);
        let job = crate::ai::HeadlessCommand { cmd, host: None, lock_id: None, grant_summary: None };
        launch_goal_headless(run, job, Duration::from_secs(300)).unwrap()
    };
    let wait_closed = |id: &str| {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let run = run_get_sync(id.into()).unwrap().unwrap();
            if run.closed_at.is_some() {
                return run;
            }
            assert!(Instant::now() < deadline, "运行一直没收尾：{run:?}");
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    let task_status = |id: &str| task_by_id(&db().unwrap(), id).unwrap().status;
    let events = |id: &str| run_events_sync(id.into()).unwrap();

    // 一、正常完成：写出成果、退出码 0 → completed，目标待验收，快照列出成果
    let task = goal("整理报告");
    let run = prepare(&task, false);
    assert_eq!(run.runtime, "local_cli");
    let ok = stub("ok.sh", "printf '# 报告\\n' > report.md\necho 已写好 report.md\necho 进度：完成 >&2\nexit 0");
    let started = launch(&run, &ok);
    assert_eq!(started.runtime, "headless", "转成无头：停止走 run_cancel");
    assert!(!started.internal, "人派的目标不当内部运行");
    let closed = wait_closed(&run.id);
    assert_eq!(closed.status, "completed", "{closed:?}");
    assert_eq!(closed.exit_code, Some(0));
    assert_eq!(task_status(&task.id), "pending_review");
    // 冻结在账本收尾之后做（与交互终端同序），宽松等到它落盘
    let review_dir = task_review_dir(&task.id, &run.id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    let snapshot = loop {
        if let Some(snapshot) = crate::task_review::load_snapshot(&review_dir).unwrap() {
            break snapshot;
        }
        assert!(Instant::now() < deadline, "收尾应冻结评审快照");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(snapshot.changes.iter().any(|c| c.path == "report.md" && c.kind == "added"), "{:?}", snapshot.changes);
    let deadline = Instant::now() + Duration::from_secs(60);
    while !events(&run.id).iter().any(|e| e.event_type == "task.snapshot_frozen") {
        assert!(Instant::now() < deadline, "没有记下冻结事件");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(headless_goal_target(&run.id).is_err(), "收尾后不能再无头启动");
    // 进度按行写进运行记录（后台批量落库，宽松等待）
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let output: String = events(&run.id)
            .into_iter()
            .filter(|e| e.event_type == "run.output")
            .filter_map(|e| e.payload)
            .collect();
        if output.contains("已写好") && output.contains("进度：完成") {
            break;
        }
        assert!(Instant::now() < deadline, "运行记录里没有输出：{output}");
        std::thread::sleep(Duration::from_millis(100));
    }

    // 二、同一副本接着做：reuse_isolation 再登记一版、再无头跑，看得到上一版的成果
    let again = prepare(&task, true);
    assert_ne!(again.id, run.id);
    assert_eq!(again.isolation_path, run.isolation_path, "接着做沿用同一副本");
    let more = stub("more.sh", "test -f report.md || exit 7\necho 补充 >> report.md\necho 接着做完了");
    launch(&again, &more);
    let closed = wait_closed(&again.id);
    assert_eq!(closed.status, "completed", "{closed:?}");
    assert_eq!(task_status(&task.id), "pending_review");
    assert!(fs::read_to_string(Path::new(&run.isolation_path).join("report.md")).unwrap().contains("补充"));

    // 三、非零退出且没有成果 → failed，原因写明退出码，目标失败
    let task = goal("会失败的目标");
    let run = prepare(&task, false);
    let bad = stub("bad.sh", "echo 'ERROR: 网关不可用' >&2\nexit 3");
    launch(&run, &bad);
    let closed = wait_closed(&run.id);
    assert_eq!(closed.status, "failed", "{closed:?}");
    assert_eq!(closed.exit_code, Some(3));
    let reason = closed.close_reason.unwrap_or_default();
    assert!(reason.contains("退出码 3") && reason.contains("网关不可用"), "{reason}");
    assert_eq!(task_status(&task.id), "failed");

    // 四、用户停止：既有 run_cancel 杀进程树，按「用户主动停止」收尾，目标已停止
    let task = goal("会被停下的目标");
    let run = prepare(&task, false);
    let slow = stub("slow.sh", "echo 开始\nsleep 120");
    launch(&run, &slow);
    let deadline = Instant::now() + Duration::from_secs(60);
    while !crate::process::capture_active(&run.id) {
        assert!(Instant::now() < deadline, "无头进程一直没登记");
        std::thread::sleep(Duration::from_millis(20));
    }
    run_cancel_sync(run.id.clone()).unwrap();
    let closed = wait_closed(&run.id);
    assert_eq!(closed.status, "stopped", "{closed:?}");
    assert_eq!(closed.close_reason.as_deref(), Some("用户主动停止"));
    assert_eq!(task_status(&task.id), "stopped");
}

// ===== 侧栏流程对话角色（2026-11-10）=====

fn step_run(key: &str, iso: &str, at: &str) -> StepRunRow {
    StepRunRow { reuse_key: key.into(), isolation_path: iso.into(), created_at: at.into() }
}

#[test]
fn step_role_reads_discuss_lane_work_and_merge_from_reuse_keys() {
    let ws = "/ws/HER/lit-notes";
    let all = vec![
        step_run("discuss:/p/HER:.ccode/drafts/lit-notes.md", "/p/HER", "2026-11-10T10:32:39+08:00"),
        step_run("ws:/ws/HER/lit-search", "/ws/HER/lit-search", "2026-11-09T15:20:03+08:00"),
        step_run(&format!("ws:{ws}#lane-2"), ws, "2026-11-10T10:59:19+08:00"),
        step_run(&format!("ws:{ws}#lane-12"), ws, "2026-11-10T10:59:21+08:00"),
        step_run(&format!("ws:{ws}"), ws, "2026-11-10T11:34:53+08:00"),
        step_run(&format!("ws:{ws}"), ws, "2026-11-10T09:00:00+08:00"),
        step_run("research:/p/HER:project:x", "/p/HER", "2026-11-10T11:12:00+08:00"),
        step_run("ws:/ws/HER/lit-notes#lane-x", ws, "2026-11-10T11:00:00+08:00"),
    ];
    let role = |i: usize| step_role_of(&all[i], &all);
    assert_eq!(role(0), Some(("discuss", None)));
    assert_eq!(role(1), Some(("work", None)), "别的工作区开过分路不算");
    assert_eq!(role(2), Some(("lane", Some(2))));
    assert_eq!(role(3), Some(("lane", Some(12))));
    assert_eq!(role(4), Some(("merge", None)), "同一工作区里更早开过分路 = 收尾");
    assert_eq!(role(5), Some(("work", None)), "分路之前开的那段是干活");
    assert_eq!(role(6), None, "认不出的复用键不起角色");
    assert_eq!(role(7), None, "分路号不是数字的不认");
}

#[test]
fn round_kind_matches_same_worktree_within_window() {
    let run = step_run("ws:/w", "/w", "2026-11-10T16:08:48+08:00");
    let hit = |w: &str, kind: &str, at: &str| RoundHit { worktree: w.into(), kind: kind.into(), at: at.into() };
    let rounds = vec![
        hit("/other", "rework", "2026-11-10T08:08:50Z"),
        hit("/w", "catchup", "2026-11-10T07:00:00Z"),
        hit("/w", "followup", "2026-11-10T08:09:00Z"),
    ];
    assert_eq!(round_kind_of(&run, &rounds), Some("followup"));
    assert_eq!(round_kind_of(&run, &rounds[..2]), None, "别的工作树、一小时前的轮次都不算");
}

#[test]
fn step_role_compares_times_across_offsets() {
    // 同一时刻不同时区写法：按真实先后比，不按字符串
    let all = vec![
        step_run("ws:/w#lane-1", "/w", "2026-11-10T03:00:00Z"),
        step_run("ws:/w", "/w", "2026-11-10T10:30:00+08:00"),
    ];
    assert_eq!(step_role_of(&all[1], &all), Some(("work", None)), "10:30+08 早于 03:00Z");
}

#[test]
fn apply_step_runs_marks_sessions_and_lane_done_from_marks() {
    let dir = std::env::temp_dir().join(format!("mesa-step-roles-{}", uuid::Uuid::new_v4()));
    let ws = dir.to_string_lossy().into_owned();
    std::fs::create_dir_all(dir.join(".ccode").join("fanout")).unwrap();
    std::fs::write(dir.join(".ccode").join("fanout").join("lane-1.done"), "").unwrap();
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE runs(agent TEXT, session_id TEXT, reuse_key TEXT, isolation_path TEXT, created_at TEXT, internal INTEGER)",
    )
    .unwrap();
    for (sid, key, at) in [
        ("l1", format!("ws:{ws}#lane-1"), "2026-11-10T10:00:00+08:00"),
        ("l2", format!("ws:{ws}#lane-2"), "2026-11-10T10:00:01+08:00"),
        ("m", format!("ws:{ws}"), "2026-11-10T11:00:00+08:00"),
        ("f", format!("ws:{ws}"), "2026-11-10T16:08:48+08:00"),
    ] {
        conn.execute(
            "INSERT INTO runs VALUES('codex', ?1, ?2, ?3, ?4, 0)",
            params![sid, key, ws, at],
        )
        .unwrap();
    }
    let mut sessions: Vec<crate::sessions::SessionMetaDto> = ["l1", "l2", "m", "other", "f"]
        .iter()
        .map(|sid| {
            let mut s: crate::sessions::SessionMetaDto = serde_json::from_value(serde_json::json!({
                "agent": "codex", "sessionId": sid, "projectPath": ws, "title": null, "createdAt": null,
                "updatedAt": null, "filePath": "/f", "tokenUsage": null, "cliVersion": null, "pinned": false,
                "archived": false, "customTitle": null, "tags": [], "alive": true, "chainCount": 1, "workspace": null,
            }))
            .unwrap();
            s.session_id = sid.to_string();
            s
        })
        .collect();
    // 跟进轮：Run 建好后十几秒记的轮次（UTC 写法）；收尾那段没有对应轮次
    let rounds = vec![RoundHit { worktree: ws.clone(), kind: "followup".into(), at: "2026-11-10T08:09:02Z".into() }];
    apply_step_runs_with(&conn, &mut sessions, &HashMap::new(), &rounds);
    let meta = |i: usize| sessions[i].step_meta.clone();
    assert_eq!(meta(4).step_role.as_deref(), Some("round"), "解冲突后的跟进轮不是第二个收尾");
    assert_eq!(meta(4).round_kind.as_deref(), Some("followup"));
    assert_eq!(meta(2).round_kind, None);
    assert_eq!(meta(0).step_role.as_deref(), Some("lane"));
    assert_eq!(meta(0).lane_no, Some(1));
    assert!(meta(0).lane_done);
    assert_eq!(meta(1).lane_no, Some(2));
    assert!(!meta(1).lane_done, "没有做完标记");
    assert_eq!(meta(2).step_role.as_deref(), Some("merge"));
    assert_eq!(meta(3), Default::default());
    let wire = serde_json::to_value(&sessions[0]).unwrap();
    assert_eq!(wire["stepRole"], "lane");
    assert_eq!(wire["laneNo"], 1);
    assert_eq!(wire["laneDone"], true);
    assert!(wire.get("stepMeta").is_none(), "拍平出线，不嵌一层");
    let _ = std::fs::remove_dir_all(&dir);
}
