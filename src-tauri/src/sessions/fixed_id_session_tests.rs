use super::*;

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ccode-fixedsid-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn unwritten_claude_session_is_reported_missing() {
    let home = scratch();
    let project = home.as_path().join(".claude").join("projects").join("-tmp-demo");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("written.jsonl"), "{}\n").unwrap();
    assert_eq!(
        fixed_id_session_exists_at(home.as_path(), "claude-code", "written", &[]),
        Some(true)
    );
    // 启动即退出：Run 记着 id，盘上没有
    assert_eq!(
        fixed_id_session_exists_at(home.as_path(), "claude-code", "never-written", &[]),
        Some(false)
    );
}

#[test]
fn relocated_config_dir_counts_and_unknown_agents_are_not_judged() {
    let home = scratch();
    let moved = scratch();
    let project = moved.as_path().join("projects").join("-tmp-demo");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("abc.jsonl"), "{}\n").unwrap();
    let env = vec![(
        "CLAUDE_CONFIG_DIR".to_string(),
        moved.as_path().to_string_lossy().into_owned(),
    )];
    assert_eq!(
        fixed_id_session_exists_at(home.as_path(), "claude-code", "abc", &env),
        Some(true)
    );
    assert_eq!(fixed_id_session_exists_at(home.as_path(), "qwen", "abc", &[]), None);
    assert_eq!(fixed_id_session_exists_at(home.as_path(), "claude-code", "../x", &[]), None);
}
