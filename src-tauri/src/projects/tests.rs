use super::*;

fn temp_dir(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("ccode-projects-{tag}-{}", uuid::Uuid::new_v4()))
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn sample_config() -> ProjectConfigDto {
    ProjectConfigDto {
        topic: None,
        settings: Vec::new(),
        rules_owned: false,
        protected_paths: Vec::new(),
        skills: Vec::new(),
        artifact_dir: "outputs".into(),
        resources: vec![
            ResourceDto {
                name: "核心论文".into(),
                path: "papers/a.pdf".into(),
                kind: "paper".into(),
                readonly: true,
                note: "先读这篇".into(),
            },
            ResourceDto {
                name: "原始数据".into(),
                path: "data/x.csv".into(),
                kind: "dataset".into(),
                readonly: false,
                note: String::new(),
            },
        ],
        steps: vec![StepDto {
            name: "文献整理".into(),
            workspace_name: "lit".into(),
            brief: "读文献写笔记".into(),
            expected_artifacts: vec!["notes/".into()],
            acceptance_criteria: Vec::new(),
            decision_mode: "auto_continue".into(),
            inputs: Vec::new(),
            optional_inputs: Vec::new(),
            any_of_inputs: Vec::new(),
            skills: vec!["paper-notes".into()],
            required_skills: vec!["paper-notes".into()],
            resources: Vec::new(),
            human_tasks: Vec::new(),
            discussion_seeds: Vec::new(),
            decisions: Vec::new(),
            asks_lit_source: false,
            seed_complete: false,
            role: "ai".into(),
            pack: String::new(),
            params: Vec::new(),
            checks: Vec::new(),
            fan_out: None,
            run: vec![
                StepRunDto {
                    name: "dev".into(),
                    command: "echo hi".into(),
                    is_default: true,
                    command_windows: None,
                },
                StepRunDto {
                    name: "test".into(),
                    command: "echo test".into(),
                    is_default: false,
                    command_windows: Some("Write-Output test".into()),
                },
            ],
        }],
        pipeline_opt_out: false,
        lit_source: "search".into(),
        submission_mode: None,
        submission_round: None,
        lit_watch_filter: None,
        work_mode: "research".into(),
        session_injection_mode: None,
        session_injection_template: None,
    }
}

#[test]
fn lit_watch_filter_round_trip_and_legacy_default() {
    // 旧档案卡没有该字段：serde default → None（不筛选）
    let legacy: ProjectConfigDto = toml::from_str(r#"artifact_dir = "outputs""#).unwrap();
    assert_eq!(legacy.lit_watch_filter, None);
    // 有筛选的档案卡：读回字段齐全；全空筛选在命令层归一为 None（is_inert 判定）
    let with_filter: ProjectConfigDto = toml::from_str(
        r#"artifact_dir = "outputs"
[litWatchFilter]
minIf = 10.0
maxCasQuartile = 2
topOnly = true
"#,
    )
    .unwrap();
    let f = with_filter.lit_watch_filter.clone().unwrap();
    assert_eq!(f.min_if, Some(10.0));
    assert_eq!(f.max_cas_quartile, Some(2));
    assert!(f.top_only);
    assert!(!f.is_inert());
    assert!(LitWatchFilterDto::default().is_inert());
    // 整卡重写必须把筛选写回去。漏写时保存成功、再打开是空的。
    let rendered = render_config(None, &with_filter).unwrap();
    assert!(rendered.contains("litWatchFilter"), "{rendered}");
    assert!(rendered.contains("minIf"), "{rendered}");
    let back = parse_config(&rendered).0.lit_watch_filter.unwrap();
    assert_eq!(back.min_if, Some(10.0));
    assert_eq!(back.max_cas_quartile, Some(2));
    assert!(back.top_only);
    let mut cleared = with_filter;
    cleared.lit_watch_filter = None;
    let rendered = render_config(Some(&rendered), &cleared).unwrap();
    assert!(!rendered.contains("litWatchFilter"), "{rendered}");
}

#[test]
fn parse_full_config_and_render_round_trip() {
    let text = r#"artifact_dir = "outputs"
future_top_key = 42

[[resources]]
name = "核心论文"
path = "papers/a.pdf"
type = "paper"
readonly = true
note = "先读这篇"
unknown_field = "保持宽容"

[[resources]]
name = "原始数据"
path = "data/x.csv"
type = "dataset"

[[steps]]
name = "文献整理"
workspace_name = "lit"
brief = "读文献写笔记"
expected_artifacts = ["notes/"]
skills = ["paper-notes"]
[steps.run]
dev = { command = "echo hi", default = true }
test = { command = "echo test", command_windows = "Write-Output test" }
"#;
    let (config, warnings) = parse_config(text);
    assert!(warnings.is_empty(), "合法配置不应有警告: {warnings:?}");
    assert_eq!(config, sample_config());
    // 往返：渲染后再解析应还原；未知顶层键必须保留
    let rendered = render_config(Some(text), &config).unwrap();
    assert!(
        rendered.contains("future_top_key = 42"),
        "未知顶层键丢失: {rendered}"
    );
    let (back, back_warnings) = parse_config(&rendered);
    assert!(
        back_warnings.is_empty(),
        "回读不应有警告: {back_warnings:?}"
    );
    assert_eq!(back, config);
}

#[test]
fn required_skills_defaults_to_all_and_preserves_explicit_optional_subset() {
    let text = r#"[[steps]]
name = "旧配置"
skills = ["a", "b"]

[[steps]]
name = "部分必需"
skills = ["a", "b"]
required_skills = ["a"]

[[steps]]
name = "全部可选"
skills = ["a", "b"]
required_skills = []
"#;
    let (config, warnings) = parse_config(text);
    assert!(warnings.is_empty(), "合法配置不应有警告: {warnings:?}");
    assert_eq!(config.steps[0].required_skills, vec!["a", "b"]);
    assert_eq!(config.steps[1].required_skills, vec!["a"]);
    assert!(config.steps[2].required_skills.is_empty());
    let rendered = render_config(Some(text), &config).unwrap();
    let (back, back_warnings) = parse_config(&rendered);
    assert!(
        back_warnings.is_empty(),
        "回读不应有警告: {back_warnings:?}"
    );
    assert_eq!(back.steps[2].required_skills, Vec::<String>::new());
}

#[test]
fn parse_tolerates_broken_entries_and_reports() {
    let text = r#"artifact_dir = 42
resources = "not-an-array"
"#;
    let (config, warnings) = parse_config(text);
    assert_eq!(config.artifact_dir, DEFAULT_ARTIFACT_DIR);
    assert!(config.resources.is_empty());
    assert_eq!(warnings.len(), 2, "坏标量与坏数组各一条警告: {warnings:?}");

    let text = r#"[[resources]]
name = "没有 path"
type = "paper"

[[resources]]
name = "类型值非法"
path = "a.pdf"
type = 123

[[resources]]
name = "好资源"
path = "data/x.csv"
type = "xlsx-ish"

[[steps]]
brief = "没有 name 的步骤"

[[steps]]
name = "好步骤"
"#;
    let (config, warnings) = parse_config(text);
    assert_eq!(config.resources.len(), 1, "两条坏资源跳过，只留好的");
    assert_eq!(
        config.resources[0].kind, "other",
        "无法识别的 type 归为 other"
    );
    assert_eq!(config.steps.len(), 1);
    assert_eq!(config.steps[0].name, "好步骤");
    let joined = warnings.join("\n");
    assert!(
        joined.contains("resources[0]"),
        "缺字段条目要报告: {joined}"
    );
    assert!(
        joined.contains("resources[1]"),
        "类型非法条目要报告: {joined}"
    );
    assert!(joined.contains("无法识别"), "未知 type 要报告: {joined}");
    assert!(joined.contains("steps[0]"), "缺 name 步骤要报告: {joined}");
}

#[test]
fn parse_broken_file_falls_back_to_default() {
    let (config, warnings) = parse_config("not [valid toml");
    assert_eq!(config, ProjectConfigDto::default());
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("解析失败"));
}

#[test]
fn structured_inputs_and_human_completion_round_trip() {
    let text = r#"[[steps]]
name = "实验执行"
inputs = ["data/clean.csv"]
optional_inputs = ["notes/" ]
any_of_inputs = [["analysis/report.md", "analysis/report.qmd"]]

[[steps.human_tasks]]
title = "补齐数据授权"
target = ""

[[steps.human_tasks]]
title = "上传实验记录"
target = "records/*.csv"
completion = "all"
expected_count = 3
manifest_path = "records/manifest.txt"
"#;
    let (config, warnings) = parse_config(text);
    assert!(warnings.is_empty(), "结构化字段不应产生警告: {warnings:?}");
    let step = &config.steps[0];
    assert_eq!(step.inputs, vec!["data/clean.csv"]);
    assert_eq!(step.optional_inputs, vec!["notes/"]);
    assert_eq!(
        step.any_of_inputs,
        vec![vec!["analysis/report.md", "analysis/report.qmd"]]
    );
    assert_eq!(step.human_tasks[0].completion, "manual");
    assert_eq!(step.human_tasks[1].expected_count, Some(3));
    assert_eq!(step.human_tasks[1].manifest_path, "records/manifest.txt");

    let rendered = render_config(Some(text), &config).unwrap();
    let (back, back_warnings) = parse_config(&rendered);
    assert!(
        back_warnings.is_empty(),
        "结构化字段回读不应有警告: {back_warnings:?}"
    );
    assert_eq!(back, config);
}

#[test]
fn render_replaces_known_sections_keeps_unknown() {
    let existing = r#"# 用户手写注释
artifact_dir = "old"
custom_pipeline = { foo = "bar" }

[[resources]]
name = "旧资源"
path = "old.pdf"
type = "paper"
"#;
    let config = ProjectConfigDto {
        topic: None,
        settings: Vec::new(),
        rules_owned: false,
        protected_paths: Vec::new(),
        skills: Vec::new(),
        artifact_dir: "new-out".into(),
        resources: vec![ResourceDto {
            name: "新资源".into(),
            path: "new.csv".into(),
            kind: "dataset".into(),
            readonly: false,
            note: String::new(),
        }],
        steps: Vec::new(),
        pipeline_opt_out: false,
        lit_source: "search".into(),
        submission_mode: None,
        submission_round: None,
        lit_watch_filter: None,
        work_mode: "research".into(),
        session_injection_mode: None,
        session_injection_template: None,
    };
    let rendered = render_config(Some(existing), &config).unwrap();
    assert!(
        rendered.contains("# 用户手写注释"),
        "注释必须保留: {rendered}"
    );
    assert!(
        rendered.contains("custom_pipeline"),
        "未知表必须保留: {rendered}"
    );
    assert!(
        !rendered.contains("旧资源"),
        "resources 全量替换: {rendered}"
    );
    let (back, _) = parse_config(&rendered);
    assert_eq!(back, config);
    // 现有文件是坏 TOML 时停止写入，不覆盖未知内容
    assert!(render_config(Some("not [valid"), &config).is_err());
}

#[test]
fn topic_round_trip_and_absent() {
    // 缺失时 None，渲染不写入 topic 行
    let (config, warnings) = parse_config("artifact_dir = \"outputs\"\n");
    assert!(warnings.is_empty());
    assert_eq!(config.topic, None);
    let rendered = render_config(None, &config).unwrap();
    assert!(!rendered.contains("topic"), "空 topic 不应写入: {rendered}");

    // 往返：解析 → 渲染 → 再解析一致；未知顶层键保留
    let text = "topic = \"GLP-1 受体激动剂的心血管结局\"\nfuture_top_key = 42\n";
    let (config, warnings) = parse_config(text);
    assert!(warnings.is_empty());
    assert_eq!(
        config.topic.as_deref(),
        Some("GLP-1 受体激动剂的心血管结局")
    );
    let rendered = render_config(Some(text), &config).unwrap();
    assert!(
        rendered.contains("future_top_key = 42"),
        "未知顶层键丢失: {rendered}"
    );
    let (back, back_warnings) = parse_config(&rendered);
    assert!(
        back_warnings.is_empty(),
        "回读不应有警告: {back_warnings:?}"
    );
    assert_eq!(back, config);

    // 清空：渲染移除已有 topic 行
    let cleared = ProjectConfigDto {
        topic: None,
        ..config
    };
    let rendered = render_config(Some(&rendered), &cleared).unwrap();
    assert!(
        !rendered.contains("topic ="),
        "清空后应移除 topic 行: {rendered}"
    );
    let (back, _) = parse_config(&rendered);
    assert_eq!(back.topic, None);

    // 非字符串 topic：忽略并告警，不阻断
    let (config, warnings) = parse_config("topic = 42\n");
    assert_eq!(config.topic, None);
    assert_eq!(warnings.len(), 1, "坏 topic 要报告: {warnings:?}");
}

#[test]
fn session_injection_round_trip_and_bad_value() {
    let text = r#"session_injection_mode = "custom"
session_injection_template = "你正在项目「{{项目名}}」中工作。\n{{项目规则}}"
"#;
    let (config, warnings) = parse_config(text);
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(config.session_injection_mode.as_deref(), Some("custom"));
    assert!(config
        .session_injection_template
        .as_deref()
        .unwrap()
        .contains("{{项目名}}"));
    let rendered = render_config(Some(text), &config).unwrap();
    let (back, _) = parse_config(&rendered);
    assert_eq!(back.session_injection_mode, config.session_injection_mode);
    assert_eq!(
        back.session_injection_template,
        config.session_injection_template
    );
    // 切到 off：mode 行改写，模板草稿保留
    let switched = ProjectConfigDto {
        session_injection_mode: Some("off".into()),
        ..config
    };
    let rendered = render_config(Some(&rendered), &switched).unwrap();
    assert!(rendered.contains(r#"session_injection_mode = "off""#));
    assert!(rendered.contains("session_injection_template"));
    let (back, _) = parse_config(&rendered);
    assert_eq!(back.session_injection_mode.as_deref(), Some("off"));
    assert_eq!(
        back.session_injection_template,
        switched.session_injection_template
    );
    // 切回 auto：mode 行移除，模板仍保留；空模板 = 清除
    let auto = ProjectConfigDto {
        session_injection_mode: None,
        ..switched
    };
    let rendered = render_config(Some(&rendered), &auto).unwrap();
    assert!(!rendered.contains("session_injection_mode"));
    assert!(rendered.contains("session_injection_template"));
    let cleared = ProjectConfigDto {
        session_injection_template: None,
        ..auto
    };
    let rendered = render_config(Some(&rendered), &cleared).unwrap();
    assert!(!rendered.contains("session_injection_template"));
    // 非法 mode：告警并按 auto；空白模板视为未填写
    let (config, warnings) = parse_config("session_injection_mode = \"loud\"\n");
    assert_eq!(config.session_injection_mode, None);
    assert_eq!(warnings.len(), 1, "坏 mode 要报告: {warnings:?}");
    let (config, warnings) =
        parse_config("session_injection_template = \"  \"\n");
    assert_eq!(config.session_injection_template, None);
    assert!(warnings.is_empty(), "{warnings:?}");
    // 模板首尾空白：parse 存原文（面板读回所见即所存），render 写 trim 后——落盘一轮归一
    let (config, _) = parse_config("session_injection_template = \"  前后空白  \"\n");
    assert_eq!(
        config.session_injection_template.as_deref(),
        Some("  前后空白  ")
    );
    let rendered = render_config(None, &config).unwrap();
    assert!(rendered.contains("\"前后空白\""), "{rendered}");
    let (back, _) = parse_config(&rendered);
    assert_eq!(back.session_injection_template.as_deref(), Some("前后空白"));
    // 非字符串模板：告警不阻断
    let (config, warnings) = parse_config("session_injection_template = 42\n");
    assert_eq!(config.session_injection_template, None);
    assert_eq!(warnings.len(), 1, "坏模板类型要报告: {warnings:?}");
}

#[test]
fn set_session_injection_at_touches_only_its_two_keys() {
    let root = temp_dir("injection-atomic");
    let toml_path = root.join(".ccode").join("project.toml");
    write(
        &toml_path,
        "topic = \"旧主题\"\nsettings = [\"只写中文\"]\n# 用户手写注释\n",
    );
    // 单键原子写：只动两个注入键，topic/settings/手写注释原样保留
    set_session_injection_at(&root, "custom", "你正在项目「{{项目名}}」中工作。").unwrap();
    let text = fs::read_to_string(&toml_path).unwrap();
    assert!(text.contains("topic = \"旧主题\""), "{text}");
    assert!(text.contains("settings = [\"只写中文\"]"), "{text}");
    assert!(text.contains("# 用户手写注释"), "{text}");
    assert!(text.contains("session_injection_mode = \"custom\""), "{text}");
    assert!(text.contains("session_injection_template"), "{text}");
    // off 写行；空白模板 = 显式清除
    set_session_injection_at(&root, "off", "  ").unwrap();
    let text = fs::read_to_string(&toml_path).unwrap();
    assert!(text.contains(r#"session_injection_mode = "off""#), "{text}");
    assert!(!text.contains("session_injection_template"), "{text}");
    // 坏档不覆盖：现有文件解析失败时停止写入
    write(&toml_path, "topic = ");
    assert!(set_session_injection_at(&root, "auto", "").is_err());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn protected_paths_and_rules_owned_round_trip() {
    let text = r#"settings = ["只写中文"]
rules_owned = true
protected_paths = ["数据/raw", "数据/raw/a.csv", "../x"]
"#;
    let (config, warnings) = parse_config(text);
    assert!(warnings.is_empty(), "{warnings:?}");
    assert!(config.rules_owned);
    assert_eq!(config.protected_paths, vec!["数据/raw".to_string()]);
    assert!(!path_is_protected("论文/综述.md", &config.protected_paths));
    assert!(path_is_protected("数据/raw/a.csv", &config.protected_paths));
    let rendered = render_config(Some(text), &config).unwrap();
    let (back, _) = parse_config(&rendered);
    assert_eq!(back.protected_paths, config.protected_paths);
    assert!(back.rules_owned);
    let cleared = ProjectConfigDto {
        rules_owned: false,
        protected_paths: Vec::new(),
        ..config
    };
    let rendered = render_config(Some(&rendered), &cleared).unwrap();
    assert!(!rendered.contains("rules_owned"));
    assert!(!rendered.contains("protected_paths"));
}

#[test]
fn path_is_protected_matches_case_insensitively() {
    // 保护 RAW/ 时，macOS 默认 APFS 上 raw/a.txt 在盘上是同一个文件，必须拦
    let protected = vec!["RAW".to_string()];
    assert!(path_is_protected("raw/a.txt", &protected));
    assert!(path_is_protected("Raw", &protected));
    assert!(!path_is_protected("rawish/a.txt", &protected));
    assert!(!path_is_protected("raw", &[]));
}

#[test]
fn parse_config_warns_on_non_string_protected_path_items() {
    let (config, warnings) = parse_config("protected_paths = [\"raw\", 42]\n");
    assert_eq!(config.protected_paths, vec!["raw".to_string()]);
    assert_eq!(warnings.len(), 1, "混入非字符串项要报告: {warnings:?}");
}

#[test]
fn project_skills_roundtrip_and_empty_omits_line() {
    let (config, warnings) =
        parse_config("skills = [\"lit-search\", \" lit-search \", \"data-eda\"]\n");
    assert!(warnings.is_empty(), "{warnings:?}");
    // 去空白 + 去重
    assert_eq!(
        config.skills,
        vec!["lit-search".to_string(), "data-eda".to_string()]
    );
    let rendered = render_config(None, &config).unwrap();
    assert!(rendered.contains("skills"), "{rendered}");
    let back = parse_config(&rendered).0;
    assert_eq!(back.skills, config.skills);
    // 空名单不写行
    let cleared = ProjectConfigDto {
        skills: Vec::new(),
        ..config
    };
    let rendered = render_config(Some(&rendered), &cleared).unwrap();
    assert!(!rendered.contains("skills"));
    // 非数组类型进 warnings 不阻断
    let (_, warnings) = parse_config("skills = \"oops\"\n");
    assert_eq!(warnings.len(), 1);
}

#[test]
fn register_assigns_stable_id_and_relinks_moved_project() {
    let dir = temp_dir("project-id");
    let proj_a = dir.join("a");
    std::fs::create_dir_all(&proj_a).unwrap();
    let conn = db_at(&dir.join("app.db")).unwrap();
    let first = register_at(&conn, &proj_a, "课题", "2026-09-09T00:00:00Z").unwrap();
    assert!(!first.id.is_empty(), "注册应分配稳定 id");
    // id 写进档案卡，跟随文件夹
    let toml = std::fs::read_to_string(proj_a.join(".ccode/project.toml")).unwrap();
    assert!(toml.contains(&format!("id = \"{}\"", first.id)), "{toml}");
    // 重复注册：id 稳定
    let again = register_at(&conn, &proj_a, "课题", "2026-09-09T01:00:00Z").unwrap();
    assert_eq!(again.id, first.id);
    // 目录移动：同一 id 在新路径注册 = 同一项目（路径改写、不建新行、created_at 保留）
    let proj_b = dir.join("b");
    conn.execute_batch("CREATE TABLE tasks(project_root TEXT, project_id TEXT);")
        .unwrap();
    conn.execute(
        "INSERT INTO tasks(project_root) VALUES(?1)",
        [canonical_key(&proj_a)],
    )
    .unwrap();
    std::fs::rename(&proj_a, &proj_b).unwrap();
    let moved = register_at(&conn, &proj_b, "课题", "2026-09-09T02:00:00Z").unwrap();
    assert_eq!(moved.id, first.id);
    assert_eq!(moved.created_at, first.created_at);
    let list = list_projects_in(&conn).unwrap();
    assert_eq!(list.len(), 1, "移动重连不得产生第二行");
    assert_eq!(list[0].path, canonical_key(&proj_b));
    assert_eq!(list[0].id, first.id);
    let task_id: String = conn
        .query_row("SELECT project_id FROM tasks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(task_id, first.id);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn registering_a_copy_never_takes_over_a_live_project() {
    let dir = temp_dir("project-copy");
    let original = dir.join("original");
    let copy = dir.join("copy");
    std::fs::create_dir_all(&original).unwrap();
    let conn = db_at(&dir.join("app.db")).unwrap();
    let first = register_at(&conn, &original, "原项目", "t1").unwrap();
    std::fs::create_dir_all(copy.join(".ccode")).unwrap();
    let card = std::fs::read(original.join(".ccode/project.toml")).unwrap();
    std::fs::write(copy.join(".ccode/project.toml"), &card).unwrap();
    let error = register_at(&conn, &copy, "副本", "t2").unwrap_err();
    assert!(error.contains("原目录仍存在"), "{error}");
    let projects = list_projects_in(&conn).unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].path, first.path);
    assert_eq!(projects[0].name, first.name);
    assert_eq!(
        std::fs::read(copy.join(".ccode/project.toml")).unwrap(),
        card
    );
    drop(conn);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn write_config_assigns_and_preserves_project_id() {
    let dir = temp_dir("project-id-write");
    let root = dir.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    let config = ProjectConfigDto::default();
    write_config_at(&root, &config).unwrap();
    let id = project_id_at(&root).expect("配置写入应分配 id");
    // 后续改写不丢 id 行
    let changed = ProjectConfigDto {
        topic: Some("t".into()),
        ..config
    };
    write_config_at(&root, &changed).unwrap();
    assert_eq!(project_id_at(&root).as_deref(), Some(id.as_str()));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn protected_paths_at_fail_closed_on_broken_config() {
    // 档案卡不存在 = 没配保护，正常放行
    let dir = temp_dir("protected-ok");
    let root = dir.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    assert_eq!(protected_paths_at(&root).unwrap(), Vec::<String>::new());

    // 正常配置读出保护清单
    std::fs::create_dir_all(root.join(".ccode")).unwrap();
    write(
        &root.join(".ccode/project.toml"),
        "protected_paths = [\"数据/raw\"]\n",
    );
    assert_eq!(
        protected_paths_at(&root).unwrap(),
        vec!["数据/raw".to_string()]
    );

    // 整份解析失败 / 键类型不对 / 数组混入非字符串：保护清单不可信，一律拒绝
    write(
        &root.join(".ccode/project.toml"),
        "protected_paths = [\"raw\"\n",
    );
    let err = protected_paths_at(&root).unwrap_err();
    assert!(err.contains("无法确认保护路径"), "{err}");
    write(
        &root.join(".ccode/project.toml"),
        "protected_paths = \"raw\"\n",
    );
    assert!(protected_paths_at(&root).is_err());
    write(
        &root.join(".ccode/project.toml"),
        "protected_paths = [\"raw\", 42]\n",
    );
    assert!(protected_paths_at(&root).is_err());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn project_status_records_accepted_goals() {
    let dir = temp_dir("project-status");
    let root = dir.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    record_accepted_goal_at(&root, "研究综述", &["论文/综述.md".into()], "引用太少").unwrap();
    record_accepted_goal_at(&root, "研究综述", &["论文/综述.md".into()], "已补").unwrap();
    record_accepted_goal_at(&root, "数据清洗", &["data/clean.csv".into()], "").unwrap();
    let status = read_project_status_at(&root);
    assert_eq!(status.accepted[0].name, "数据清洗");
    assert_eq!(status.accepted[1].name, "研究综述");
    assert_eq!(status.accepted[1].note, "已补");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn project_memory_appends_only_confirmed_entries() {
    let dir = temp_dir("project-memory");
    let root = dir.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    assert_eq!(read_memory_at(&root), "");
    append_project_memory_at(&root, "综述", "结论A：X 显著优于 Y", Some("run-1")).unwrap();
    append_project_memory_at(&root, "综述", "", Some("run-empty")).unwrap(); // 空意见不沉淀
    append_project_memory_at(&root, "综述", "结论A：X 显著优于 Y", Some("run-1")).unwrap(); // 同 Run 幂等
    let text = read_memory_at(&root);
    assert!(text.contains("mesa-memory"));
    assert_eq!(text.matches("结论A").count(), 1);
    assert!(text.contains("\"sourceVersion\":\"run-1\""));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn acceptance_log_appends_and_dedupes_by_run() {
    let dir = temp_dir("acceptance-log");
    let root = dir.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    let entry = |run: &str| AcceptanceLogEntry {
        goal_id: "goal-1".into(),
        goal_name: "研究综述".into(),
        run_id: run.into(),
        paths: vec!["论文/综述.md".into()],
        note: "已补引用".into(),
        frozen: true,
        decided_at: "2026-09-09T00:00:00Z".into(),
        kind: "goal_adopt".into(),
        version_id: format!("{run}:1"),
        ..Default::default()
    };
    append_acceptance_log_at(&root, &entry("run-1")).unwrap();
    // 同一 Run 重试采纳：幂等跳过，不产生重复行
    append_acceptance_log_at(&root, &entry("run-1")).unwrap();
    append_acceptance_log_at(&root, &entry("run-2")).unwrap();
    let log = read_acceptance_log_at(&root);
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].run_id, "run-1");
    assert_eq!(log[1].run_id, "run-2");
    assert!(log[0].frozen);
    assert_eq!(log[0].paths, vec!["论文/综述.md".to_string()]);
    assert_eq!(log[0].kind, "goal_adopt");
    let mut next_version = entry("run-1");
    next_version.version_id = "run-1:2".into();
    append_acceptance_log_at(&root, &next_version).unwrap();
    append_acceptance_log_at(&root, &next_version).unwrap();
    assert_eq!(
        read_acceptance_log_at(&root).len(),
        3,
        "同 Run 的新结果版本必须留下独立接受事实"
    );
    next_version.paths.push("data.csv".into());
    append_acceptance_log_at(&root, &next_version).unwrap();
    next_version.paths.reverse();
    append_acceptance_log_at(&root, &next_version).unwrap();
    assert_eq!(
        read_acceptance_log_at(&root).len(),
        4,
        "补采纳其它文件要记账，选择顺序不制造重复"
    );
    // 旧七字段行必须读回一条
    let legacy = r#"{"goalId":"g","goalName":"旧","runId":"r-old","paths":["a.md"],"note":"","frozen":false,"decidedAt":"t"}"#;
    std::fs::write(acceptance_log_path(&root), format!("{legacy}\n")).unwrap();
    let old = read_acceptance_log_at(&root);
    assert_eq!(old.len(), 1);
    assert_eq!(old[0].run_id, "r-old");
    assert_eq!(old[0].kind, "goal_adopt");
    assert_eq!(old[0].paths, vec!["a.md".to_string()]);
    // 损坏行不拖垮整本账
    std::fs::write(
        acceptance_log_path(&root),
        format!(
            "{}{}",
            std::fs::read_to_string(acceptance_log_path(&root)).unwrap(),
            "not-json\n"
        ),
    )
    .unwrap();
    assert_eq!(read_acceptance_log_at(&root).len(), 1);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn acceptance_log_recovers_after_a_partial_final_line_without_destroying_evidence() {
    let dir = temp_dir("acceptance-torn-tail");
    fs::create_dir_all(dir.join(".ccode")).unwrap();
    let torn = b"{\"goalId\":\"unfinished";
    fs::write(acceptance_log_path(&dir), torn).unwrap();
    let entry = AcceptanceLogEntry {
        goal_id: "goal".into(),
        run_id: "run".into(),
        version_id: "run:1".into(),
        paths: vec!["paper.md".into()],
        ..Default::default()
    };
    append_acceptance_log_at(&dir, &entry).unwrap();
    assert_eq!(read_acceptance_log_at(&dir), vec![entry.clone()]);
    assert!(fs::read(acceptance_log_path(&dir))
        .unwrap()
        .starts_with(torn));
    append_acceptance_log_at(&dir, &entry).unwrap();
    assert_eq!(read_acceptance_log_at(&dir).len(), 1);
    fs::remove_dir_all(dir).unwrap();
}

// ===== 步骤资源绑定（resources 字段与 validate_step） =====

#[test]
fn step_resources_round_trip_and_default_empty() {
    // 缺失 resources 的步骤默认空数组；绑定的步骤精确往返（相对与绝对路径混合）
    let text = r#"[[resources]]
name = "论文A"
path = "papers/a.pdf"

[[resources]]
name = "共享数据"
path = "/shared/data/x.csv"

[[steps]]
name = "文献整理"
brief = "读文献写笔记"

[[steps]]
name = "数据分析"
brief = "跑数据"
resources = ["papers/a.pdf", "/shared/data/x.csv"]
"#;
    let (config, warnings) = parse_config(text);
    assert!(warnings.is_empty(), "合法配置不应有警告: {warnings:?}");
    assert_eq!(
        config.steps[0].resources,
        Vec::<String>::new(),
        "缺失默认空"
    );
    assert_eq!(
        config.steps[1].resources,
        vec!["papers/a.pdf".to_string(), "/shared/data/x.csv".to_string()]
    );
    let rendered = render_config(Some(text), &config).unwrap();
    assert!(
        rendered.contains("resources = ["),
        "绑定必须写回: {rendered}"
    );
    let (back, back_warnings) = parse_config(&rendered);
    assert!(
        back_warnings.is_empty(),
        "回读不应有警告: {back_warnings:?}"
    );
    assert_eq!(back, config);
    // 空数组渲染时省略不写（语义同省略）
    let cleared = StepDto {
        resources: Vec::new(),
        ..config.steps[1].clone()
    };
    let mut cfg = config.clone();
    cfg.steps[1] = cleared;
    let rendered = render_config(Some(&rendered), &cfg).unwrap();
    assert!(
        !rendered.contains("resources ="),
        "空绑定不应写入: {rendered}"
    );
    let (back, _) = parse_config(&rendered);
    assert_eq!(back, cfg);
}

#[test]
fn step_resources_tolerates_bad_values() {
    // 非数组 → 整条忽略并告警，步骤本体保留；非字符串/空白项逐条跳过并告警
    let text = r#"[[steps]]
name = "坏绑定一"
resources = "not-an-array"

[[steps]]
name = "坏绑定二"
resources = [1, "papers/a.pdf", "", 42]
"#;
    let (config, warnings) = parse_config(text);
    assert_eq!(
        config.steps.len(),
        2,
        "坏 resources 不得拖垮步骤: {warnings:?}"
    );
    assert!(config.steps[0].resources.is_empty());
    assert_eq!(config.steps[1].resources, vec!["papers/a.pdf".to_string()]);
    let joined = warnings.join("\n");
    assert!(
        joined.contains("steps[0] 的 resources 不是数组"),
        "{joined}"
    );
    assert!(joined.contains("steps[1] 的 resources[0]"), "{joined}");
    assert!(
        joined.contains("steps[1] 的 resources[2]"),
        "空白项也要报告: {joined}"
    );
    assert!(joined.contains("steps[1] 的 resources[3]"), "{joined}");
}

#[test]
fn validate_step_binding_rules() {
    let resources = vec![
        ResourceDto {
            name: "论文A".into(),
            path: "papers/a.pdf".into(),
            kind: "paper".into(),
            readonly: true,
            note: String::new(),
        },
        ResourceDto {
            name: "共享数据".into(),
            path: "/shared/x.csv".into(),
            kind: "dataset".into(),
            readonly: false,
            note: String::new(),
        },
    ];
    // 规则①：绑定 path 不在 [[resources]] 里 → 提示；精确命中（相对/绝对）与空绑定不提示
    let step = StepDto {
        name: "分析".into(),
        resources: vec![
            "papers/a.pdf".into(),
            "/shared/x.csv".into(),
            "missing.pdf".into(),
        ],
        ..StepDto::default()
    };
    let warnings = validate_step(&step, &resources, &[], true);
    assert_eq!(warnings.len(), 1, "只有不存在的绑定要提示: {warnings:?}");
    assert!(
        warnings[0].contains("绑定的资源不存在：missing.pdf"),
        "{}",
        warnings[0]
    );
    let ok = StepDto {
        resources: vec!["papers/a.pdf".into()],
        ..StepDto::default()
    };
    assert!(
        validate_step(&ok, &resources, &[], true).is_empty(),
        "精确命中不提示"
    );
    let unbound = StepDto::default();
    assert!(
        validate_step(&unbound, &resources, &[], true).is_empty(),
        "空数组 = 不绑定 = 全部资源，不校验"
    );

    // 规则②：brief 引用约定路径，本步产物/上游产物/登记资源三处都查无 → 提示
    // papers/ 已登记为资源（papers/a.pdf 前缀命中）= 输入物料，不报；references.bib 三处皆无 → 报
    let miss = StepDto {
        name: "整理".into(),
        brief: "通读 papers/ 后把笔记写进 notes/，更新 references.bib".into(),
        expected_artifacts: vec!["notes/".into()],
        ..StepDto::default()
    };
    let warnings = validate_step(&miss, &resources, &[], true);
    assert_eq!(warnings.len(), 1, "只有 references.bib 提示: {warnings:?}");
    assert!(warnings[0].contains("「references.bib」"), "{warnings:?}");
    // 上游产物豁免：references.bib 与 papers/ 均由更早步骤产出 → 引用它们是合法输入，不报
    let prior = vec!["references.bib".to_string(), "papers/".to_string()];
    assert!(
        validate_step(&miss, &[], &prior, false).is_empty(),
        "上游产物被引用 = 合法输入，不提示"
    );
    // 只豁免一个时另一个仍报
    let warnings = validate_step(&miss, &[], &["papers/".to_string()], false);
    assert_eq!(warnings.len(), 1, "references.bib 仍提示: {warnings:?}");
    // 本步产物/上游产物/资源三处皆无才提示（miss 去掉资源后 papers/ 也要报）
    assert_eq!(
        validate_step(&miss, &[], &[], true).len(),
        2,
        "papers/ 与 references.bib 各提示一次"
    );
    let optional = StepDto {
        name: "检索".into(),
        brief: "已有 references.bib 不得覆盖".into(),
        optional_inputs: vec!["references.bib".into()],
        ..StepDto::default()
    };
    assert!(
        validate_step(&optional, &[], &[], true).is_empty(),
        "声明过的可选输入被简报提到，不当成缺产物"
    );
    let hit = StepDto {
        brief: "把综述草稿写进 manuscript/ 并同步 outline.md".into(),
        expected_artifacts: vec!["manuscript/draft.md".into(), "outline.md".into()],
        ..StepDto::default()
    };
    assert!(
        validate_step(&hit, &resources, &[], true).is_empty(),
        "目录前缀命中与文件精确命中都不提示"
    );
    let no_ref = StepDto {
        brief: "读文献写笔记".into(),
        ..StepDto::default()
    };
    assert!(
        validate_step(&no_ref, &resources, &[], true).is_empty(),
        "无引用不提示"
    );
}

#[test]
fn bundled_review_template_has_no_step_warnings() {
    // 英文综述模板应用到新项目后不该一进页就挂「!」（2026-11-05：检索步简报提到 notes/ 却没声明输入）
    let steps = demo_review_template().steps;
    let mut prior: Vec<String> = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        let warnings = validate_step(step, &[], &prior, i == 0);
        assert!(warnings.is_empty(), "{}：{warnings:?}", step.name);
        prior.extend(step.expected_artifacts.iter().cloned());
    }
}

#[test]
fn read_config_merges_validation_warnings() {
    // read_project_config 的 warnings 自动并入校验结果
    let dir = temp_dir("validate");
    let project = dir.join("proj");
    fs::create_dir_all(&project).unwrap();
    let text = r#"[[steps]]
name = "分析"
brief = "产出进 notes/"
resources = ["ghost.pdf"]
"#;
    write(&config_path(&project), text);
    let read = read_config_at(&project);
    let joined = read.warnings.join("\n");
    assert!(joined.contains("绑定的资源不存在：ghost.pdf"), "{joined}");
    assert!(joined.contains("「notes/」"), "{joined}");
    // 无问题的配置 warnings 为空
    write_config_at(&project, &sample_config()).unwrap();
    let read = read_config_at(&project);
    assert!(
        read.warnings.is_empty(),
        "干净配置不应有警告: {:?}",
        read.warnings
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn step_names_at_maps_workspace_to_step() {
    let dir = temp_dir("stepnames");
    let project = dir.join("proj");
    fs::create_dir_all(&project).unwrap();
    // 无档案卡：空映射，不报错
    assert!(step_names_at(&project).is_empty());
    write_config_at(&project, &sample_config()).unwrap();
    let map = step_names_at(&project);
    assert_eq!(map.get("lit").map(String::as_str), Some("文献整理"));
    // 无 workspace_name 的步骤不进映射
    let mut config = sample_config();
    config.steps.push(StepDto {
        name: "无工作区步骤".into(),
        ..StepDto::default()
    });
    write_config_at(&project, &config).unwrap();
    let map = step_names_at(&project);
    assert_eq!(map.len(), 1);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn write_then_read_config_through_fs() {
    let dir = temp_dir("rw");
    let project = dir.join("proj");
    fs::create_dir_all(&project).unwrap();
    // 无文件时读默认空配置
    let read = read_config_at(&project);
    assert_eq!(read.config, ProjectConfigDto::default());
    assert!(read.warnings.is_empty());
    // 写入后读回一致（.ccode 目录自动创建）
    let config = sample_config();
    write_config_at(&project, &config).unwrap();
    let read = read_config_at(&project);
    assert_eq!(read.config, config);
    // 再次写入全量替换 resources
    let mut config2 = config.clone();
    config2.resources.clear();
    write_config_at(&project, &config2).unwrap();
    let read = read_config_at(&project);
    assert_eq!(read.config, config2);
    let on_disk = fs::read_to_string(config_path(&project)).unwrap();
    assert!(
        !on_disk.contains("核心论文"),
        "resources 应被全量替换: {on_disk}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn discover_classifies_limits_depth_and_skips_dirs() {
    let dir = temp_dir("discover");
    let root = dir.join("proj");
    let files = [
        ("paper.pdf", "paper"),
        ("data/a.csv", "dataset"),
        ("refs.bib", "reference"),
        ("deep1/deep2/mid.parquet", "dataset"), // 第 3 层，在内
    ];
    for (rel, _) in files {
        write(&root.join(rel), "x");
    }
    // 应被排除：超深、隐藏目录、node_modules、target、artifacts 目录、未识别扩展名
    for rel in [
        "d1/d2/d3/too-deep.pdf",
        ".hidden/secret.pdf",
        "node_modules/dep.pdf",
        "target/build.pdf",
        "artifacts/out.pdf",
        "notes.txt",
    ] {
        write(&root.join(rel), "x");
    }
    // 登记一个已有资源验证 exists 标记
    let mut config = ProjectConfigDto::default();
    config.resources.push(ResourceDto {
        name: "已登记".into(),
        path: "data/a.csv".into(),
        kind: "dataset".into(),
        readonly: false,
        note: String::new(),
    });
    write_config_at(&root, &config).unwrap();

    let found = discover_at(&root).unwrap();
    let got: Vec<(&str, &str, bool)> = found
        .iter()
        .map(|d| (d.path.as_str(), d.kind.as_str(), d.exists))
        .collect();
    assert_eq!(
        got,
        vec![
            ("data/a.csv", "dataset", true),
            ("deep1/deep2/mid.parquet", "dataset", false),
            ("paper.pdf", "paper", false),
            ("refs.bib", "reference", false),
        ],
        "分类、限深与排除目录都要正确"
    );
    assert!(found.iter().all(|d| d.size == 1 && d.mtime.is_some()));
    // 不存在的目录要报错而不是静默空列表
    assert!(discover_at(&root.join("missing")).is_err());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn registry_crud_and_reregister() {
    let dir = temp_dir("db");
    let db_path = dir.join("app.db");
    let conn = db_at(&db_path).unwrap();
    let p1 = dir.join("proj-a");
    let p2 = dir.join("proj-b");
    fs::create_dir_all(&p1).unwrap();
    fs::create_dir_all(&p2).unwrap();

    let d1 = register_at(&conn, &p1, "课题甲", "2026-08-01T00:00:00Z").unwrap();
    register_at(&conn, &p2, "课题乙", "2026-08-02T00:00:00Z").unwrap();
    let list = list_projects_in(&conn).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].name, "课题乙", "按 last_opened_at 降序");
    assert_eq!(list[1].path, d1.path);

    // 重复注册：保留 created_at、更新 name 与 last_opened，行数不变
    let d1b = register_at(&conn, &p1, "课题甲改", "2026-08-03T00:00:00Z").unwrap();
    assert_eq!(d1b.path, d1.path, "同目录不同写法应归并到同一主键");
    assert_eq!(d1b.created_at, d1.created_at);
    assert_eq!(d1b.name, "课题甲改");
    let list = list_projects_in(&conn).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].name, "课题甲改");

    // 移除只删注册记录，目录仍在
    remove_project_at(&conn, &p2).unwrap();
    assert!(p2.exists());
    let list = list_projects_in(&conn).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, d1.path);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn ensure_research_git_inits_research_only_and_gives_head() {
    if crate::agents::resolve_binary("git").is_none() {
        eprintln!("测试环境无 git，跳过");
        return;
    }
    let dir = temp_dir("research-git");
    // 科研项目（档案卡缺省即科研）：自动 init 并有第一笔提交，建得了 worktree
    let research = dir.join("research");
    fs::create_dir_all(&research).unwrap();
    write_config_at(&research, &ProjectConfigDto::default()).unwrap();
    assert!(ensure_research_git(&research).unwrap());
    assert!(crate::workspaces::run_git(&research, &["rev-parse", "--verify", "HEAD"], Duration::from_secs(10)).is_ok());
    // 再调一次：已是仓库且有提交，什么都不做
    assert!(!ensure_research_git(&research).unwrap());
    // 编程项目：不替它 init
    let coding = dir.join("coding");
    fs::create_dir_all(&coding).unwrap();
    let mut cfg = ProjectConfigDto::default();
    cfg.work_mode = "coding".into();
    write_config_at(&coding, &cfg).unwrap();
    assert!(!ensure_research_git(&coding).unwrap());
    assert!(!coding.join(".git").exists());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn ensure_git_repo_idempotent() {
    let dir = temp_dir("git");
    let project = dir.join("proj");
    fs::create_dir_all(&project).unwrap();
    if crate::agents::resolve_binary("git").is_none() {
        eprintln!("测试环境无 git，跳过 ensure_git_repo 用例");
        return;
    }
    let first = ensure_git_at(&project).unwrap();
    assert!(first.initialized && first.gitignore_written);
    assert!(project.join(".git").exists());
    let gitignore = fs::read_to_string(project.join(".gitignore")).unwrap();
    assert!(
        gitignore.contains("/artifacts/"),
        "默认产物目录进 gitignore: {gitignore}"
    );
    assert!(gitignore.contains(".DS_Store"));
    assert!(
        gitignore.contains(".ccode/handoff-*.md"),
        "接力简报规则进默认 gitignore: {gitignore}"
    );

    let coding = dir.join("proj-coding");
    fs::create_dir_all(&coding).unwrap();
    let c = ensure_git_at_mode(&coding, "coding").unwrap();
    assert!(c.initialized && c.gitignore_written);
    let cgi = fs::read_to_string(coding.join(".gitignore")).unwrap();
    assert!(!cgi.contains("*.pdf"), "编程项目不应忽略 pdf: {cgi}");
    assert!(cgi.contains(".DS_Store"));

    // 幂等：已是仓库直接返回，不改写任何文件
    let second = ensure_git_at(&project).unwrap();
    assert!(!second.initialized && !second.gitignore_written);
    assert_eq!(
        fs::read_to_string(project.join(".gitignore")).unwrap(),
        gitignore
    );

    // 自定义 artifact_dir 的项目：gitignore 用配置值
    let project2 = dir.join("proj2");
    fs::create_dir_all(&project2).unwrap();
    let mut config = ProjectConfigDto::default();
    config.artifact_dir = "outputs".into();
    write_config_at(&project2, &config).unwrap();
    let r = ensure_git_at(&project2).unwrap();
    assert!(r.initialized);
    let gitignore2 = fs::read_to_string(project2.join(".gitignore")).unwrap();
    assert!(gitignore2.contains("/outputs/"));
    std::fs::remove_dir_all(&dir).ok();
}

// ===== 开步自动提交（commit_bootstrap_at） =====

fn git_ok(dir: &Path, args: &[&str]) -> String {
    crate::workspaces::run_git(dir, args, Duration::from_secs(30))
        .unwrap_or_else(|e| panic!("git {args:?} 失败: {e}"))
}

fn git_has_head(dir: &Path) -> bool {
    crate::workspaces::run_git(
        dir,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        Duration::from_secs(10),
    )
    .is_ok()
}

#[test]
fn ledger_commit_only_whitelisted_changed_paths() {
    if crate::agents::resolve_binary("git").is_none() {
        return;
    }
    let dir = temp_dir("ledger-commit");
    let project = dir.join("proj");
    fs::create_dir_all(&project).unwrap();
    ensure_git_at(&project).unwrap();
    write(&project.join("papers/included.md"), "v1");
    write(&project.join("papers/to-fetch.md"), "t1");
    git_ok(&project, &["add", "papers"]);
    let ident = crate::git_info::commit_identity_args(&project);
    let mut args: Vec<&str> = ident.iter().map(String::as_str).collect();
    args.extend(["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
    git_ok(&project, &args);
    // 白名单外、路径穿越一律拒绝
    assert!(commit_ledger_at(&project, &["README.md".into()]).is_err());
    assert!(commit_ledger_at(&project, &["papers/../x.md".into()]).is_err());
    // 没改：不提交
    assert!(!commit_ledger_at(&project, &["papers/included.md".into()]).unwrap());
    // 改了 included.md；用户另有暂存与未暂存改动，都不得被带走
    write(&project.join("papers/included.md"), "v2");
    write(&project.join("papers/to-fetch.md"), "t2");
    write(&project.join("staged.txt"), "s");
    git_ok(&project, &["add", "staged.txt"]);
    let head0 = git_ok(&project, &["rev-parse", "HEAD"]);
    assert!(commit_ledger_at(
        &project,
        &["papers\\included.md".into(), "papers/screening.md".into()]
    )
    .unwrap());
    let changed = git_ok(&project, &["diff", "--name-only", &format!("{}..HEAD", head0.trim())]);
    assert_eq!(changed.trim(), "papers/included.md");
    let status = git_ok(&project, &["status", "--porcelain=v1"]);
    assert!(status.lines().any(|l| l.starts_with("A ") && l.contains("staged.txt")), "{status}");
    assert!(status.lines().any(|l| l.contains("papers/to-fetch.md")), "没点名的清单不动: {status}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn bootstrap_commit_only_ccode_paths_and_idempotent() {
    if crate::agents::resolve_binary("git").is_none() {
        eprintln!("测试环境无 git，跳过 commit_bootstrap 用例");
        return;
    }
    let dir = temp_dir("bootstrap");
    let project = dir.join("proj");
    fs::create_dir_all(&project).unwrap();
    ensure_git_at(&project).unwrap(); // git init + 默认 .gitignore
    write_config_at(&project, &sample_config()).unwrap(); // .ccode/project.toml
                                                          // 用户文件：必须保持未跟踪，绝不纳入自动提交
    write(&project.join("paper.pdf"), "pdf");
    write(&project.join("data/notes.txt"), "n");
    // 用户自行暂存的文件也不得被本次提交带走（commit 有 pathspec 限定）
    write(&project.join("staged.txt"), "s");
    git_ok(&project, &["add", "staged.txt"]);

    let r = commit_bootstrap_at(&project).unwrap();
    assert!(r.committed, "untracked 的 .ccode/.gitignore 必须提交");
    assert!(r.paths.contains(&".gitignore".to_string()), "{:?}", r.paths);
    assert!(
        r.paths.contains(&".ccode/project.toml".to_string()),
        "{:?}",
        r.paths
    );
    assert!(
        !r.paths
            .iter()
            .any(|p| p.contains("paper.pdf") || p.contains("notes") || p.contains("staged")),
        "用户文件绝不进提交清单: {:?}",
        r.paths
    );

    // HEAD 树里只有 Mesa 自有路径
    let tree = git_ok(&project, &["ls-tree", "-r", "--name-only", "HEAD"]);
    assert!(
        tree.contains(".gitignore") && tree.contains(".ccode/project.toml"),
        "{tree}"
    );
    assert!(
        !tree.contains("paper.pdf")
            && !tree.contains("notes.txt")
            && !tree.contains("staged.txt"),
        "用户文件绝不进树: {tree}"
    );
    // 用户文件保持原状态：未跟踪的仍 ??，用户暂存的仍 A
    let status = git_ok(
        &project,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    );
    assert!(
        status
            .lines()
            .any(|l| l.starts_with("??") && l.contains("notes.txt")),
        "未跟踪用户文件不动: {status}"
    );
    assert!(
        status
            .lines()
            .any(|l| l.starts_with("A ") && l.contains("staged.txt")),
        "用户暂存文件留在暂存区: {status}"
    );

    // 幂等：第二次 committed=false，用户暂存内容仍不被带走
    let r2 = commit_bootstrap_at(&project).unwrap();
    assert!(
        !r2.committed && r2.paths.is_empty(),
        "第二次必须幂等: {r2:?}"
    );
    let status2 = git_ok(&project, &["status", "--porcelain=v1"]);
    assert!(
        status2
            .lines()
            .any(|l| l.starts_with("A ") && l.contains("staged.txt")),
        "{status2}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn bootstrap_commit_survives_ignored_ledger_files() {
    if crate::agents::resolve_binary("git").is_none() {
        return;
    }
    // 2026-10-22 实测：.gitignore 已忽略验收台账且文件存在时，exclude 点名它们让 git add 整条失败，
    // 每次开工都弹「档案卡自动提交失败」
    let dir = temp_dir("bootstrap-ledger");
    let project = dir.join("proj");
    fs::create_dir_all(&project).unwrap();
    ensure_git_at(&project).unwrap();
    write_config_at(&project, &sample_config()).unwrap();
    write(
        &project.join(".gitignore"),
        "/.ccode/pending-registrations.json\n/.ccode/acceptance-log.jsonl\n/.ccode/acceptance-log.lock\n",
    );
    write(&project.join(".ccode/acceptance-log.jsonl"), "{}\n");
    write(&project.join(".ccode/acceptance-log.lock"), "");
    write(&project.join(".ccode/pending-registrations.json"), "[]");
    let r = commit_bootstrap_at(&project).unwrap();
    assert!(r.committed, "{r:?}");
    let tree = git_ok(&project, &["ls-tree", "-r", "--name-only", "HEAD"]);
    assert!(tree.contains(".ccode/project.toml"), "{tree}");
    assert!(!tree.contains("acceptance-log") && !tree.contains("pending-registrations"), "{tree}");

    // 老项目 .gitignore 没忽略这些：仍靠 exclude 挡住，不提交成 tracked
    let old = dir.join("old");
    fs::create_dir_all(&old).unwrap();
    ensure_git_at(&old).unwrap();
    write_config_at(&old, &sample_config()).unwrap();
    write(&old.join(".gitignore"), "/output/\n");
    write(&old.join(".ccode/acceptance-log.jsonl"), "{}\n");
    let r = commit_bootstrap_at(&old).unwrap();
    assert!(r.committed, "{r:?}");
    let tree = git_ok(&old, &["ls-tree", "-r", "--name-only", "HEAD"]);
    assert!(!tree.contains("acceptance-log"), "{tree}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn bootstrap_commit_picks_up_modified_gitignore() {
    if crate::agents::resolve_binary("git").is_none() {
        eprintln!("测试环境无 git，跳过 commit_bootstrap 用例");
        return;
    }
    let dir = temp_dir("bootstrap-mod");
    let project = dir.join("proj");
    fs::create_dir_all(&project).unwrap();
    ensure_git_at(&project).unwrap();
    // 只存在 .gitignore（无 .ccode）：只提交存在的路径
    let r1 = commit_bootstrap_at(&project).unwrap();
    assert!(
        r1.committed && r1.paths == [".gitignore".to_string()],
        "{r1:?}"
    );

    // 修改已跟踪的 .gitignore：modified 也要被提交
    fs::write(project.join(".gitignore"), "# 用户改过的\n*.pdf\n").unwrap();
    let r2 = commit_bootstrap_at(&project).unwrap();
    assert!(r2.committed, "modified 的 .gitignore 必须提交");
    assert_eq!(r2.paths, [".gitignore".to_string()], "{:?}", r2.paths);

    // 无改动时幂等
    let r3 = commit_bootstrap_at(&project).unwrap();
    assert!(!r3.committed && r3.paths.is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn bootstrap_commit_unborn_repo_and_non_repo() {
    if crate::agents::resolve_binary("git").is_none() {
        eprintln!("测试环境无 git，跳过 commit_bootstrap 用例");
        return;
    }
    let dir = temp_dir("bootstrap-unborn");
    // 非仓库报错（前端开步流程已先走 ensure_git_repo，此处为防御）
    let plain = dir.join("plain");
    fs::create_dir_all(&plain).unwrap();
    assert!(commit_bootstrap_at(&plain).is_err(), "非仓库必须报错");

    // 空仓库（unborn HEAD）：bootstrap 直接落第一个内容提交，无需先跑空初始提交
    let project = dir.join("proj");
    fs::create_dir_all(&project).unwrap();
    ensure_git_at(&project).unwrap();
    assert!(!git_has_head(&project), "前置：仓库应为 unborn");
    write_config_at(&project, &sample_config()).unwrap();
    let r = commit_bootstrap_at(&project).unwrap();
    assert!(r.committed);
    // HEAD 已存在：create_workspace 内的 ensure_initial_commit 见到 HEAD 直接 no-op
    assert!(git_has_head(&project), "bootstrap 后 HEAD 必须存在");
    let tree = git_ok(&project, &["ls-tree", "-r", "--name-only", "HEAD"]);
    assert!(
        tree.contains(".gitignore") && tree.contains(".ccode/project.toml"),
        "{tree}"
    );

    // 空仓库且两个路径都不存在：committed=false，仓库保持 unborn，
    // 由 create_workspace 的 ensure_initial_commit 兜底空提交
    let bare = dir.join("bare");
    fs::create_dir_all(&bare).unwrap();
    git_ok(&bare, &["init"]);
    let r = commit_bootstrap_at(&bare).unwrap();
    assert!(
        !r.committed && r.paths.is_empty(),
        "无内容可提交时必须幂等: {r:?}"
    );
    assert!(!git_has_head(&bare), "无内容时不得凭空制造提交");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn resolve_owner_rules() {
    let outside_res = PathBuf::from("/shared/paper.pdf");
    let projects = vec![
        (PathBuf::from("/proj/a"), vec![outside_res.clone()]),
        (PathBuf::from("/proj/b"), Vec::new()),
        (PathBuf::from("/proj/a/inner"), Vec::new()),
    ];
    // 登记资源精确命中（资源在项目根外也认）
    assert_eq!(resolve_owner(&outside_res, &projects), Some(0));
    // 项目根前缀命中
    assert_eq!(
        resolve_owner(Path::new("/proj/b/docs/x.pdf"), &projects),
        Some(1)
    );
    // 嵌套项目归内层根（最长前缀）
    assert_eq!(
        resolve_owner(Path::new("/proj/a/inner/x.pdf"), &projects),
        Some(2)
    );
    // 前缀混淆（/proj/bb 不是 /proj/b 内）与完全根外都不命中
    assert_eq!(resolve_owner(Path::new("/proj/bb/x.pdf"), &projects), None);
    assert_eq!(resolve_owner(Path::new("/etc/x.pdf"), &projects), None);
}

#[test]
fn append_excerpt_creates_with_header_then_appends() {
    let dir = temp_dir("inbox");
    let wt = dir.join("wt");
    fs::create_dir_all(&wt).unwrap();
    append_excerpt_at(&wt, "## a.pdf · 第 3 页 · 2026-08-05\n\n选段一\n").unwrap();
    let target = wt.join("notes/excerpts.md");
    let text = fs::read_to_string(&target).unwrap();
    assert!(
        text.starts_with("# 文献摘录"),
        "首次写入要有文件头: {text}"
    );
    assert!(text.contains("选段一"));
    // 第二次：追加不覆盖，文件头不重复
    append_excerpt_at(&wt, "## b.pdf · 第 1 页 · 2026-08-05\n\n选段二\n").unwrap();
    let text = fs::read_to_string(&target).unwrap();
    assert!(
        text.contains("选段一") && text.ends_with("选段二\n"),
        "追加语义: {text}"
    );
    assert_eq!(
        text.matches("# 文献摘录").count(),
        1,
        "文件头只出现一次: {text}"
    );
    // 目录不存在要报错而不是静默
    assert!(append_excerpt_at(&dir.join("missing"), "x").is_err());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn terminal_clips_go_to_their_own_file_not_excerpts() {
    let dir = temp_dir("clips");
    let root = dir.join("proj");
    fs::create_dir_all(&root).unwrap();
    append_notes_file_at(&root, CLIPS_FILE, CLIPS_HEADER, "\n## 片段一\n").unwrap();
    append_notes_file_at(&root, CLIPS_FILE, CLIPS_HEADER, "\n## 片段二\n").unwrap();
    let text = fs::read_to_string(root.join("notes/clips.md")).unwrap();
    assert!(text.starts_with("# 摘记"));
    assert_eq!(text.matches("# 摘记").count(), 1);
    assert!(text.ends_with("## 片段二\n"));
    assert!(!root.join("notes/excerpts.md").exists(), "终端输出不混进文献摘录");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn append_excerpt_rejects_oversize() {
    let dir = temp_dir("inbox-cap");
    fs::create_dir_all(&dir).unwrap();
    let big = "x".repeat(64 * 1024 + 1);
    let err = append_excerpt_at(&dir, &big).unwrap_err();
    assert!(err.contains("64 KB"), "{err}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
#[cfg(unix)] // 符号链接语义仅 unix；Windows 无权限创建
fn append_excerpt_rejects_symlink_escape() {
    let dir = temp_dir("inbox-sym");
    let outside = dir.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("inbox.md"), "外部内容").unwrap();
    let wt = dir.join("wt");
    fs::create_dir_all(wt.join("notes")).unwrap();
    std::os::unix::fs::symlink(outside.join("inbox.md"), wt.join("notes/excerpts.md")).unwrap();
    let err = append_excerpt_at(&wt, "追加").unwrap_err();
    assert!(err.contains("拒绝写入"), "{err}");
    // 外部文件未被改动
    assert_eq!(
        fs::read_to_string(outside.join("inbox.md")).unwrap(),
        "外部内容"
    );
    std::fs::remove_dir_all(&dir).ok();
}

fn sample_steps() -> Vec<ProjectStepDto> {
    vec![
        StepDto {
            name: "读文献".into(),
            workspace_name: "lit-notes".into(),
            brief: "整理笔记".into(),
            expected_artifacts: vec!["notes/".into()],
            acceptance_criteria: Vec::new(),
            decision_mode: "auto_continue".into(),
            inputs: Vec::new(),
            optional_inputs: Vec::new(),
            any_of_inputs: Vec::new(),
            skills: vec!["paper-notes".into()],
            required_skills: Vec::new(),
            resources: Vec::new(),
            human_tasks: Vec::new(),
            discussion_seeds: Vec::new(),
            decisions: Vec::new(),
            asks_lit_source: false,
            seed_complete: false,
            role: "ai".into(),
            pack: String::new(),
            params: Vec::new(),
            checks: Vec::new(),
            fan_out: None,
            run: vec![StepRunDto {
                name: "dev".into(),
                command: "echo hi".into(),
                is_default: true,
                command_windows: None,
            }],
        },
        StepDto {
            name: "写论文".into(),
            ..StepDto::default()
        },
    ]
}

// ===== 从模板追加步骤（append_pipeline_steps_at） =====

#[test]
fn append_steps_appends_in_order_and_preserves_unknown_keys() {
    let dir = temp_dir("append-ok");
    let root = dir.join("proj");
    let text = "artifact_dir = \"outputs\"\nfuture_top_key = 42\n\n\
                    [[steps]]\nname = \"初稿\"\nworkspace_name = \"draft\"\n";
    write(&config_path(&root), text);
    let res = append_pipeline_steps_at(&root, sample_steps()).unwrap();
    assert_eq!(res.appended, 2);
    assert!(res.skipped.is_empty());
    let cfg = read_config_at(&root).config;
    let names: Vec<&str> = cfg.steps.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["初稿", "读文献", "写论文"], "追加在末尾且保序");
    // 追加步骤的字段完整落盘（run/简报随步骤走）
    assert_eq!(cfg.steps[1].workspace_name, "lit-notes");
    assert_eq!(cfg.steps[1].run.len(), 1);
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    assert!(raw.contains("future_top_key = 42"), "未知顶层键丢失: {raw}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn work_mode_roundtrip_default_research_omitted() {
    let dir = temp_dir("work-mode");
    let root = dir.join("proj");
    set_work_mode_at(&root, "coding").unwrap();
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    assert!(raw.contains("work_mode = \"coding\""), "{raw}");
    assert!(
        raw.contains("Mesa 项目档案卡"),
        "新建档案卡必须带勿删文件头: {raw}"
    );
    assert_eq!(read_config_at(&root).config.work_mode, "coding");
    set_work_mode_at(&root, "research").unwrap();
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    assert!(!raw.contains("work_mode"), "{raw}");
    assert_eq!(read_config_at(&root).config.work_mode, "research");
    set_work_mode_at(&root, "nope").unwrap();
    assert_eq!(read_config_at(&root).config.work_mode, "research");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn project_toml_header_injected_once_and_keeps_user_comments() {
    let config = ProjectConfigDto {
        work_mode: "coding".into(),
        ..ProjectConfigDto::default()
    };
    let first = render_config(None, &config).unwrap();
    assert!(first.contains("Mesa 项目档案卡"), "{first}");
    assert!(first.contains("按「科研」重新分类"), "{first}");
    assert!(first.contains("work_mode = \"coding\""), "{first}");
    assert_eq!(first.matches("Mesa 项目档案卡").count(), 1);
    let second = render_config(Some(&first), &config).unwrap();
    assert_eq!(
        second.matches("Mesa 项目档案卡").count(),
        1,
        "已有文件头不得重复: {second}"
    );
    let custom = "# 用户手写注释\nartifact_dir = \"out\"\n";
    let mixed = render_config(Some(custom), &config).unwrap();
    assert!(mixed.contains("Mesa 项目档案卡"), "{mixed}");
    assert!(mixed.contains("# 用户手写注释"), "{mixed}");
    assert_eq!(mixed.matches("Mesa 项目档案卡").count(), 1);
    let tasks = render_tasks(Some(custom), &[]).unwrap();
    assert!(tasks.contains("Mesa 项目档案卡"), "{tasks}");
    assert!(tasks.contains("# 用户手写注释"), "{tasks}");
    let legacy =
        "# Ccode 项目档案卡（工作方式 / 研究流程 / 资源清单）。\nwork_mode = \"coding\"\n";
    let kept = render_config(Some(legacy), &config).unwrap();
    assert!(
        kept.contains("Ccode 项目档案卡"),
        "旧文件头必须保留: {kept}"
    );
    assert!(
        !kept.contains("Mesa 项目档案卡"),
        "旧文件头不得再插 Mesa 头: {kept}"
    );
}

// ===== pipeline_opt_out（「不使用研究流程」显式标记） =====

#[test]
fn pipeline_opt_out_roundtrip_and_append_clears_it() {
    let dir = temp_dir("opt-out");
    let root = dir.join("proj");
    // 无 project.toml 起步（已注册项目也允许：write_config_at 会新建）
    set_pipeline_opt_out_at(&root, true).unwrap();
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    assert!(raw.contains("pipeline_opt_out = true"), "{raw}");
    assert!(read_config_at(&root).config.pipeline_opt_out);
    // 清回 false：行移除（false 是缺省，不落盘），未知键保留
    set_pipeline_opt_out_at(&root, false).unwrap();
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    assert!(!raw.contains("pipeline_opt_out"), "{raw}");
    assert!(!read_config_at(&root).config.pipeline_opt_out);
    // 再次置 true 后追加模板步骤：追加成功自动清标记
    set_pipeline_opt_out_at(&root, true).unwrap();
    let res = append_pipeline_steps_at(&root, sample_steps()).unwrap();
    assert_eq!(res.appended, 2);
    assert!(
        !read_config_at(&root).config.pipeline_opt_out,
        "选了模板 = 启用流程，标记必须清掉"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opt_out_clears_steps_keeps_resources() {
    let dir = temp_dir("opt-out-clear-steps");
    let root = dir.join("proj");
    write(
        &config_path(&root),
        "topic = \"旧课题\"\n\n[[resources]]\nname = \"一篇\"\npath = \"papers/a.pdf\"\ntype = \"paper\"\n\n[[steps]]\nname = \"文献精读\"\nworkspace_name = \"lit-notes\"\n",
    );
    set_pipeline_opt_out_at(&root, true).unwrap();
    let cfg = read_config_at(&root).config;
    assert!(cfg.pipeline_opt_out);
    assert!(cfg.steps.is_empty());
    assert_eq!(cfg.topic.as_deref(), Some("旧课题"));
    assert_eq!(cfg.resources.len(), 1);
    assert_eq!(cfg.resources[0].path, "papers/a.pdf");
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    assert!(!raw.contains("[[steps]]"), "{raw}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pipeline_opt_out_preserves_unknown_keys() {
    let dir = temp_dir("opt-out-unknown");
    let root = dir.join("proj");
    write(
        &config_path(&root),
        "artifact_dir = \"outputs\"\nfuture_top_key = 42\n",
    );
    set_pipeline_opt_out_at(&root, true).unwrap();
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    assert!(raw.contains("future_top_key = 42"), "未知顶层键丢失: {raw}");
    assert!(raw.contains("pipeline_opt_out = true"), "{raw}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn append_steps_skips_name_conflicts_and_renames_workspace_conflicts() {
    let dir = temp_dir("append-skip");
    let root = dir.join("proj");
    let text = "[[steps]]\nname = \"读文献\"\nworkspace_name = \"lit-notes\"\n\n\
                    [[steps]]\nname = \"占位\"\nworkspace_name = \"write\"\n";
    write(&config_path(&root), text);
    let mut batch = sample_steps();
    batch[0].expected_artifacts.clear(); // 「读文献」(lit-notes) + 「写论文」(无 workspace_name)
    batch.push(StepDto {
        name: "换个名字".into(),
        workspace_name: "write".into(), // 与既有步骤 workspace_name 撞车
        ..StepDto::default()
    });
    batch.push(StepDto {
        name: "写论文".into(), // 模板内部重复：撞上刚追加进来的同名步骤
        ..StepDto::default()
    });
    let res = append_pipeline_steps_at(&root, batch).unwrap();
    assert_eq!(
        res.appended, 2,
        "重名步骤跳过，工作区名冲突的步骤应自动追加并改名"
    );
    assert_eq!(
        res.skipped,
        vec!["读文献", "写论文"],
        "只因步骤名撞车跳过，workspace_name 撞车不应丢步骤"
    );
    assert_eq!(res.renamed.len(), 1);
    assert_eq!(res.renamed[0].name, "换个名字");
    assert_eq!(res.renamed[0].from, "write");
    assert_eq!(res.renamed[0].to, "write-2");
    let cfg = read_config_at(&root).config;
    assert_eq!(cfg.steps.len(), 4);
    assert_eq!(cfg.steps[2].name, "写论文");
    assert_eq!(cfg.steps[3].workspace_name, "write-2");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn append_conflicting_contract_fails_without_changing_project() {
    let dir = temp_dir("append-contract");
    let root = dir.join("proj");
    write(
        &config_path(&root),
        "[[steps]]\nname = \"论文初稿\"\nexpected_artifacts = [\"manuscript/draft.md\"]\n",
    );
    let before = fs::read(config_path(&root)).unwrap();
    let result = append_pipeline_steps_at(
        &root,
        vec![StepDto {
            name: "论文初稿".into(),
            expected_artifacts: vec!["manuscript/thesis-draft.md".into()],
            ..StepDto::default()
        }],
    );
    assert!(result.unwrap_err().contains("交付不同"));
    assert_eq!(fs::read(config_path(&root)).unwrap(), before);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn append_steps_all_skipped_leaves_file_untouched() {
    let dir = temp_dir("append-allskip");
    let root = dir.join("proj");
    let text = "[[steps]]\nname = \"文献整理\"\nworkspace_name = \"lit\"\n";
    write(&config_path(&root), text);
    let before = fs::read_to_string(config_path(&root)).unwrap();
    let res = append_pipeline_steps_at(
        &root,
        vec![StepDto {
            name: "文献整理".into(),
            ..StepDto::default()
        }],
    )
    .unwrap();
    assert_eq!(res.appended, 0);
    assert_eq!(res.skipped, vec!["文献整理"]);
    assert_eq!(
        fs::read_to_string(config_path(&root)).unwrap(),
        before,
        "全部跳过时不落盘"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn apply_template_merges_settings_and_topic_without_overwriting_real_answers() {
    let dir = temp_dir("apply-settings");
    let root = dir.join("proj");
    write(
        &config_path(&root),
        "pipeline_opt_out = true\ntopic = \"旧主题\"\nsettings = [\"目标读者：专家\", \"综述角度：（待填写）\"]\n",
    );
    let res = apply_pipeline_template_at(
        &root,
        vec![StepDto {
            name: "新增步骤".into(),
            ..StepDto::default()
        }],
        vec![
            "目标读者：专家/小白".into(),
            "综述角度：机制综述".into(),
            "目标期刊：Nature".into(),
        ],
        "append",
        Some("新主题".into()),
        None,
        None,
    )
    .unwrap();
    assert_eq!(res.appended, 1);
    let cfg = read_config_at(&root).config;
    assert_eq!(cfg.topic.as_deref(), Some("新主题"));
    assert_eq!(
        cfg.settings,
        vec![
            "目标读者：专家".to_string(),
            "综述角度：机制综述".to_string(),
            "目标期刊：Nature".to_string(),
        ]
    );
    assert!(!cfg.pipeline_opt_out);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn apply_template_all_skipped_without_metadata_leaves_opt_out_file_untouched() {
    let dir = temp_dir("apply-allskip-optout");
    let root = dir.join("proj");
    write(
        &config_path(&root),
        "pipeline_opt_out = true\n\n[[steps]]\nname = \"已有步骤\"\n",
    );
    let before = fs::read_to_string(config_path(&root)).unwrap();
    let res = apply_pipeline_template_at(
        &root,
        vec![StepDto {
            name: "已有步骤".into(),
            ..StepDto::default()
        }],
        Vec::new(),
        "append",
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(res.appended, 0);
    assert_eq!(fs::read_to_string(config_path(&root)).unwrap(), before);
    assert!(read_config_at(&root).config.pipeline_opt_out);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn replace_template_normalizes_names_and_workspace_conflicts() {
    let dir = temp_dir("replace-normalize");
    let root = dir.join("proj");
    fs::create_dir_all(&root).unwrap();
    let res = apply_pipeline_template_at(
        &root,
        vec![
            StepDto {
                name: "  第一步  ".into(),
                workspace_name: " work ".into(),
                ..StepDto::default()
            },
            StepDto {
                name: "第二步".into(),
                workspace_name: "work".into(),
                ..StepDto::default()
            },
        ],
        Vec::new(),
        "replace",
        None,
        None,
        None,
    )
    .unwrap();
    assert_eq!(res.appended, 2);
    assert_eq!(res.renamed[0].to, "work-2");
    let cfg = read_config_at(&root).config;
    assert_eq!(cfg.steps[0].name, "第一步");
    assert_eq!(cfg.steps[0].workspace_name, "work");
    assert_eq!(cfg.steps[1].workspace_name, "work-2");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn append_submission_writes_branch_metadata_atomically_even_when_steps_skip() {
    let dir = temp_dir("append-submission");
    let root = dir.join("proj");
    write(
        &config_path(&root),
        "pipeline_opt_out = true\n\n[[steps]]\nname = \"读文献\"\n\n[[steps]]\nname = \"写论文\"\n",
    );

    // 模板步骤全部因名称重复跳过，但返修分支仍必须在同一次读-改-原子写中生效。
    let mut steps = sample_steps();
    for step in &mut steps {
        step.expected_artifacts.clear();
    }
    let res = append_pipeline_steps_at_with_submission(&root, steps, Some("revision"), Some(0))
        .unwrap();
    assert_eq!(res.appended, 0);
    assert_eq!(res.skipped, vec!["读文献", "写论文"]);

    let cfg = read_config_at(&root).config;
    assert!(!cfg.pipeline_opt_out, "选择返修分支应清掉 opt-out");
    assert_eq!(cfg.submission_mode.as_deref(), Some("revision"));
    assert_eq!(cfg.submission_round, Some(1), "轮次 0 应归一为第 1 轮");
    assert_eq!(cfg.steps.len(), 2, "全跳过时不应重复追加步骤");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn append_steps_rejects_empty_batch() {
    let dir = temp_dir("append-empty");
    let root = dir.join("proj");
    write(&config_path(&root), "[[steps]]\nname = \"一步\"\n");
    let err = append_pipeline_steps_at(&root, Vec::new()).unwrap_err();
    assert!(err.contains("没有可追加的步骤"), "{err}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn append_steps_rejects_unregistered_project() {
    let dir = temp_dir("append-unreg");
    let plain = dir.join("plain");
    write(&plain.join("a.txt"), "x");
    // 无 .ccode/project.toml 且未注册 → 写门槛拒绝（查询真实注册表，随机路径必未注册）
    let err = ensure_task_project_root(&plain).unwrap_err();
    assert!(err.contains("不是 Mesa 项目"), "{err}");
    assert!(!config_path(&plain).exists(), "拒绝后不得留下档案卡");
    std::fs::remove_dir_all(&dir).ok();
}

// ===== 示例课题（create_demo_at / build_demo_pdf） =====

#[test]
fn demo_pdf_xref_offsets_are_valid() {
    let pdf = build_demo_pdf();
    assert!(pdf.starts_with(b"%PDF-1.4\n"), "PDF 魔数头");
    assert!(pdf.ends_with(b"%%EOF\n"), "EOF 收尾");
    // 全 ASCII：字节偏移可直接按文本解析
    let text = String::from_utf8(pdf.clone()).unwrap();
    let sx = text.rfind("startxref").expect("缺 startxref");
    let xref_pos: usize = text[sx..].lines().nth(1).unwrap().trim().parse().unwrap();
    assert_eq!(
        &pdf[xref_pos..xref_pos + 4],
        b"xref",
        "startxref 必须指向 xref 表"
    );
    // 逐条 n 项的偏移必须精确指向 "N 0 obj"
    let xref = &text[xref_pos..];
    let entries: Vec<&str> = xref.lines().skip(2).take(6).collect();
    assert_eq!(entries.len(), 6, "xref 应有 0..=5 共 6 项");
    assert!(entries[0].ends_with(" f "), "0 号为 free 项");
    for (i, entry) in entries.iter().enumerate().skip(1) {
        // lines() 不含换行符：19 字符 + LF = 固定的 20 字节 xref 项
        assert_eq!(entry.len(), 19, "xref 项固定 20 字节（含 LF）: {entry:?}");
        let off: usize = entry[..10].trim().parse().unwrap();
        assert!(
            pdf[off..].starts_with(format!("{i} 0 obj").as_bytes()),
            "对象 {i} 的 xref 偏移错位"
        );
    }
    assert!(text.contains("trailer\n<< /Size 6 /Root 1 0 R >>"));
}

#[test]
fn create_demo_flow_and_idempotency() {
    if crate::agents::resolve_binary("git").is_none() {
        eprintln!("测试环境无 git，跳过 create_demo 用例");
        return;
    }
    let dir = temp_dir("demo");
    let conn = db_at(&dir.join("app.db")).unwrap();
    let base = dir.join("documents");
    let root = base.join(DEMO_DIR_NAME);

    let p = create_demo_at(&base, &conn).unwrap();
    assert_eq!(p.name, DEMO_PROJECT_NAME);
    assert!(root.join(DEMO_PDF_REL).exists());
    assert!(root.join("notes").is_dir());
    assert!(root.join("references.bib").exists());
    assert!(root.join("README.md").exists());
    let included: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(root.join("papers/included.json")).unwrap())
            .unwrap();
    assert_eq!(included[0]["id"], "leader-2016-demo");
    assert_eq!(included[0]["fulltextStatus"], "demo-only");
    let pdf = fs::read(root.join(DEMO_PDF_REL)).unwrap();
    assert!(
        pdf.starts_with(b"%PDF-") && pdf.ends_with(b"%%EOF\n"),
        "PDF 结构完整"
    );
    // 档案卡 = 当前英文综述模板 + 检索步 seed_complete；不另写一套旧简报
    let text = fs::read_to_string(config_path(&root)).unwrap();
    let (config, _) = parse_config(&text);
    let canon = demo_review_template();
    assert_eq!(
        config.topic.as_deref(),
        Some("GLP-1 受体激动剂的心血管结局（演示课题）")
    );
    assert_eq!(config.steps.len(), canon.steps.len());
    assert_eq!(config.steps[0].workspace_name, "lit-search");
    assert_eq!(
        config.steps[0].skills, canon.steps[0].skills,
        "检索步技能应与英文综述模板一致"
    );
    assert!(config.steps[0].seed_complete);
    assert_eq!(config.steps[0].brief, canon.steps[0].brief);
    assert_eq!(
        config.steps[1].skills, canon.steps[1].skills,
        "精读步技能应与英文综述模板一致"
    );
    assert_eq!(config.steps[1].brief, canon.steps[1].brief);
    assert_eq!(config.steps[3].run.len(), canon.steps[3].run.len());
    assert_eq!(config.steps[4].workspace_name, "polish");
    assert_eq!(config.resources.len(), 2);
    assert!(git_has_head(&root), "bootstrap 应已产生初始提交");
    let cards = task_cards_at(&root);
    assert_eq!(cards.len(), 1, "示例课题应预置一张演示卡片");
    let demo_card = &cards[0];
    assert_eq!(demo_card.name, "示例：开读这一篇");
    assert_eq!(demo_card.step.as_deref(), Some("文献精读与笔记"));
    let draft_text = fs::read_to_string(root.join(".ccode/drafts/lit-notes.md")).unwrap();
    assert!(
        draft_text.starts_with("# 任务书草稿：文献精读与笔记"),
        "{draft_text}"
    );
    for marker in ["想法期讨论沉淀（示范）", "开读这一篇", "综述大纲"] {
        assert!(draft_text.contains(marker), "示范草稿缺内容: {marker}");
    }
    assert!(
        config.steps[0]
            .human_tasks
            .iter()
            .any(|h| h.title.contains("下载付费墙文献全文")),
        "检索步应保留模板的付费墙事项: {:?}",
        config.steps[0].human_tasks
    );

    // 幂等：二次调用返回同一项目，且不覆盖用户改过的内容
    write(&root.join("README.md"), "user edit");
    write(&root.join("papers/included.json"), "user supplied records");
    let p2 = create_demo_at(&base, &conn).unwrap();
    assert_eq!(p2.path, p.path);
    assert_eq!(
        fs::read_to_string(root.join("papers/included.json")).unwrap(),
        "user supplied records"
    );
    assert_eq!(
        fs::read_to_string(root.join("README.md")).unwrap(),
        "user edit"
    );
    assert_eq!(
        task_cards_at(&root).len(),
        1,
        "幂等路径不得重复播种演示卡片"
    );

    // 目录已存在但未注册：档案卡跟当前模板，缺的演示文件才补，已有 README 不动
    remove_project_at(&conn, &root).unwrap();
    fs::remove_file(root.join("references.bib")).unwrap();
    write(
        &config_path(&root),
        "topic = \"旧演示\"\n[[steps]]\nname = \"旧步骤\"\nworkspace_name = \"old\"\nbrief = \"过期简报\"\n",
    );
    let p3 = create_demo_at(&base, &conn).unwrap();
    assert_eq!(p3.path, p.path);
    assert!(root.join("references.bib").exists(), "缺的演示文件应补回");
    assert_eq!(
        fs::read_to_string(root.join("README.md")).unwrap(),
        "user edit",
        "已有 README 不得覆盖"
    );
    let text = fs::read_to_string(config_path(&root)).unwrap();
    let (config, _) = parse_config(&text);
    assert_eq!(config.steps.len(), canon.steps.len());
    assert_eq!(config.steps[0].brief, canon.steps[0].brief);
    assert!(config.steps[0].seed_complete);
    assert_eq!(task_cards_at(&root).len(), 1, "已有演示卡片不得重复播种");

    // 只有旧目录名时继续用它，不在旁边再造「Mesa 示例课题」
    remove_project_at(&conn, &root).unwrap();
    let legacy = base.join(DEMO_DIR_NAME_LEGACY);
    std::fs::rename(&root, &legacy).unwrap();
    let p4 = create_demo_at(&base, &conn).unwrap();
    assert!(
        Path::new(&p4.path).ends_with(DEMO_DIR_NAME_LEGACY),
        "应继续用旧目录，实际 {}",
        p4.path
    );
    assert!(!root.exists(), "旧目录还在时不得另建新目录");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn delete_project_dir_removes_dir_and_registration() {
    let dir = temp_dir("deldir");
    let conn = db_at(&dir.join("app.db")).unwrap();
    let root = dir.join("demo-proj");
    write(&config_path(&root), "artifact_dir = \"artifacts\"\n");
    write(&root.join("notes/x.md"), "x");
    register_at(&conn, &root, "演示", "2026-08-01T00:00:00Z").unwrap();

    let msg = delete_project_dir_impl(&conn, &root).unwrap();
    assert_eq!(msg, "目录已移入回收站，注册记录已删除");
    assert!(!root.exists(), "目录应已移入回收站（原位不再存在）");
    assert!(!is_registered_at(&conn, &root), "注册记录应被移除");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn delete_project_dir_rejects_non_project() {
    let dir = temp_dir("deldir-nonproj");
    let conn = db_at(&dir.join("app.db")).unwrap();
    // 普通目录：无 project.toml、未注册、无工作区 → 拒绝且目录原样保留
    let plain = dir.join("plain");
    write(&plain.join("a.txt"), "x");
    let err = delete_project_dir_impl(&conn, &plain).unwrap_err();
    assert!(err.contains("不是 Mesa 项目"), "{err}");
    assert!(plain.join("a.txt").exists());
    // 不存在的路径：降级为只清库（该项目未注册、无工作区时等于摘注册空操作）
    let gone = dir.join("missing");
    let msg_gone = delete_project_dir_impl(&conn, &gone).unwrap();
    assert!(
        msg_gone.contains("已不在磁盘上"),
        "缺失目录应降级清理: {msg_gone}"
    );
    // 文件而非目录
    let f = dir.join("file.txt");
    write(&f, "x");
    let err3 = delete_project_dir_impl(&conn, &f).unwrap_err();
    assert!(err3.contains("不是目录"), "{err3}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn delete_project_dir_missing_dir_cleans_registration_and_workspaces() {
    let dir = temp_dir("deldir-gone");
    let conn = db_at(&dir.join("app.db")).unwrap();
    let root = dir.join("demo-proj");
    write(&config_path(&root), "artifact_dir = \"artifacts\"\n");
    register_at(&conn, &root, "演示", "2026-08-01T00:00:00Z").unwrap();
    crate::workspaces::workspaces_of_repo(&conn, &root).unwrap(); // 建表
    conn.execute(
        "INSERT INTO workspaces(id, repo_path, name, branch, worktree_path, base_branch, port_base, status, created_at)
             VALUES('w1', ?1, 'lit', 'ccode/lit', ?2, 'main', 4000, 'active', '2026-08-01T00:00:00Z')",
        params![
            root.to_string_lossy().into_owned(),
            dir.join("wt-missing").to_string_lossy().into_owned()
        ],
    )
    .unwrap();
    // 用户在 Finder 里手动删掉项目目录后再来 Mesa 删除：不再报 os error 2，降级只清库
    fs::remove_dir_all(&root).unwrap();

    let msg = delete_project_dir_impl(&conn, &root).unwrap();
    assert_eq!(
        msg,
        "项目目录已不在磁盘上，无法删除目录本身；已移除：注册记录、1 个工作区记录"
    );
    assert!(!is_registered_at(&conn, &root), "注册记录应被移除");
    assert!(
        crate::workspaces::workspaces_of_repo(&conn, &root)
            .unwrap()
            .is_empty(),
        "工作区记录应被清空"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn purge_traces_missing_dir_cleans_registration() {
    let dir = temp_dir("purge-gone");
    let conn = db_at(&dir.join("app.db")).unwrap();
    let root = dir.join("demo-proj");
    write(&config_path(&root), "artifact_dir = \"artifacts\"\n");
    register_at(&conn, &root, "演示", "2026-08-01T00:00:00Z").unwrap();
    fs::remove_dir_all(&root).unwrap();

    let msg = purge_project_traces_impl(&conn, &root).unwrap();
    assert!(msg.contains("已不在磁盘上"), "{msg}");
    assert!(!is_registered_at(&conn, &root));
    std::fs::remove_dir_all(&dir).ok();
}

// ===== 清除 Mesa 痕迹（purge_project_traces，中间档：保留文件夹与用户文件） =====

#[test]
fn purge_traces_removes_ccode_registration_and_workspace_but_keeps_user_files() {
    let dir = temp_dir("purge");
    let conn = db_at(&dir.join("app.db")).unwrap();
    let root = dir.join("demo-proj");
    write(&config_path(&root), "artifact_dir = \"artifacts\"\n");
    write(&root.join(".ccode/brief-20260801T100000Z.md"), "# 简报");
    write(&root.join("notes/x.md"), "用户文件");
    register_at(&conn, &root, "演示", "2026-08-01T00:00:00Z").unwrap();
    // 一条工作区记录（worktree 不存在、目录非 git 仓库也能走删除实现：两者都按缺失容忍）
    crate::workspaces::workspaces_of_repo(&conn, &root).unwrap(); // 顺带建表
    conn.execute(
        "INSERT INTO workspaces(id, repo_path, name, branch, worktree_path, base_branch, port_base, status, created_at)
             VALUES('w1', ?1, 'lit', 'ccode/lit', ?2, 'main', 4000, 'active', '2026-08-01T00:00:00Z')",
        params![
            root.canonicalize().unwrap().to_string_lossy().into_owned(),
            dir.join("wt-missing").to_string_lossy().into_owned()
        ],
    )
    .unwrap();

    let msg = purge_project_traces_impl(&conn, &root).unwrap();
    assert_eq!(msg, "已清除：1 个工作区、档案卡与简报（回收站）、注册记录");
    assert!(root.is_dir(), "项目文件夹必须保留");
    assert_eq!(
        fs::read_to_string(root.join("notes/x.md")).unwrap(),
        "用户文件",
        "用户文件原样保留"
    );
    assert!(!root.join(".ccode").exists(), ".ccode 应已移入回收站");
    assert!(!is_registered_at(&conn, &root), "注册记录应被移除");
    assert!(
        crate::workspaces::workspaces_of_repo(&conn, &root)
            .unwrap()
            .is_empty(),
        "工作区记录应被清空"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn purge_traces_rejects_dir_without_traces() {
    let dir = temp_dir("purge-empty");
    let conn = db_at(&dir.join("app.db")).unwrap();
    // 无 .ccode、无注册、无工作区 → 报错且目录原样保留
    let plain = dir.join("plain");
    write(&plain.join("a.txt"), "x");
    let err = purge_project_traces_impl(&conn, &plain).unwrap_err();
    assert!(err.contains("没有 Mesa 痕迹"), "{err}");
    assert!(plain.join("a.txt").exists());
    // 防护：home 本身拒绝（复用 guard_project_dir 口径）
    let home = crate::dirs::home_dir().unwrap();
    assert!(purge_project_traces_impl(&conn, &home).is_err());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn purge_traces_tolerates_unregistered() {
    let dir = temp_dir("purge-unreg");
    let conn = db_at(&dir.join("app.db")).unwrap();
    let root = dir.join("proj");
    // 只有 .ccode、未注册：照样清，摘注册容忍未注册
    write(&config_path(&root), "artifact_dir = \"artifacts\"\n");
    let msg = purge_project_traces_impl(&conn, &root).unwrap();
    assert_eq!(msg, "已清除：档案卡与简报（回收站）");
    assert!(!root.join(".ccode").exists());
    std::fs::remove_dir_all(&dir).ok();
}

// ===== 步骤推荐技能写回（update_step_skills，v3.67） =====

#[test]
fn update_step_skills_writes_only_skills_and_preserves_rest() {
    let dir = temp_dir("stepskills");
    let root = dir.join("proj");
    let text = "artifact_dir = \"outputs\"\nfuture_top_key = 42\n\n\
                    [[steps]]\nname = \"文献整理\"\nworkspace_name = \"lit\"\nbrief = \"读文献写笔记\"\nskills = [\"paper-notes\"]\n\n\
                    [[steps]]\nname = \"写作\"\nworkspace_name = \"write\"\n";
    write(&config_path(&root), text);
    // 归一：去空白、保序去重
    update_step_skills_at(
        &root,
        "文献整理",
        vec![
            " lit-search ".into(),
            "paper-notes".into(),
            "lit-search".into(),
        ],
    )
    .unwrap();
    let cfg = read_config_at(&root).config;
    assert_eq!(cfg.steps[0].skills, vec!["lit-search", "paper-notes"]);
    // 其余字段与步骤原样；未知顶层键保留（render_config 口径）
    assert_eq!(cfg.steps[0].brief, "读文献写笔记");
    assert_eq!(cfg.steps[1].name, "写作");
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    assert!(raw.contains("future_top_key = 42"), "未知键丢失: {raw}");
    // 步骤不存在 → 报错，文件不动
    let before = fs::read_to_string(config_path(&root)).unwrap();
    let err = update_step_skills_at(&root, "没有这步", vec![]).unwrap_err();
    assert!(err.contains("步骤不存在"), "{err}");
    assert_eq!(fs::read_to_string(config_path(&root)).unwrap(), before);
    std::fs::remove_dir_all(&dir).ok();
}

// ===== 人工事项（steps[].human_tasks）解析/写回 =====

#[test]
fn cleanup_project_db_traces_removes_orphans() {
    // 这个 bug 的特征是「删完当场看不出问题」——下次在同路径建项目才发作
    // （继承上个项目的勾选状态），所以必须有测试盯着
    let dir = temp_dir("orphans");
    let root = dir.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE human_task_checks(project_path TEXT NOT NULL, step TEXT NOT NULL, \
               title TEXT NOT NULL, updated_at TEXT, PRIMARY KEY(project_path, step, title));\
             CREATE TABLE card_claims(agent TEXT NOT NULL, cwd TEXT NOT NULL, \
               task_id TEXT NOT NULL, created_at TEXT, PRIMARY KEY(agent, cwd));\
             CREATE TABLE session_meta(agent TEXT NOT NULL, session_id TEXT NOT NULL, \
               task_id TEXT, PRIMARY KEY(agent, session_id));",
    )
    .unwrap();
    let key = canonical_key(&root);
    conn.execute(
        "INSERT INTO human_task_checks VALUES (?1,'检索筛选','补文献','t')",
        rusqlite::params![key],
    )
    .unwrap();
    // 别的项目的行必须原样留着
    conn.execute(
        "INSERT INTO human_task_checks VALUES ('/other/proj','检索筛选','补文献','t')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO card_claims VALUES ('claude-code',?1,'t-abc','t')",
        rusqlite::params![key],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_meta VALUES ('claude-code','s1','t-abc')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_meta VALUES ('claude-code','s2','t-other')",
        [],
    )
    .unwrap();

    let (cleaned, warn) = cleanup_project_db_traces(&conn, &root, &["t-abc".to_string()]);
    assert!(warn.is_empty(), "{warn:?}");
    assert_eq!(cleaned, 3, "勾选 1 + 认领 1 + 归卡 1");

    let mine: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM human_task_checks WHERE project_path=?1",
            rusqlite::params![key],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(mine, 0, "本项目的勾选记录应清空");
    let others: i64 = conn
        .query_row("SELECT COUNT(*) FROM human_task_checks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(others, 1, "别的项目的勾选记录不该被误删");
    let claims: i64 = conn
        .query_row("SELECT COUNT(*) FROM card_claims", [], |r| r.get(0))
        .unwrap();
    assert_eq!(claims, 0);
    let cleared: Option<String> = conn
        .query_row(
            "SELECT task_id FROM session_meta WHERE session_id='s1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cleared, None, "本项目卡片的归卡标记应清掉");
    let kept: Option<String> = conn
        .query_row(
            "SELECT task_id FROM session_meta WHERE session_id='s2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kept.as_deref(), Some("t-other"), "别的卡片不该被动");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn cleanup_tolerates_lazily_created_tables() {
    // 三张表都是懒建的：用户从没勾过人工事项时表根本不存在。
    // 这时 DELETE 会报 no such table——当成「没有痕迹」而不是错误，
    // 否则新用户第一次删项目就会看到一条莫名其妙的「清理失败」
    let dir = temp_dir("lazytables");
    let root = dir.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    let conn = Connection::open_in_memory().unwrap();
    let (cleaned, warn) = cleanup_project_db_traces(&conn, &root, &["t-abc".to_string()]);
    assert_eq!(cleaned, 0);
    assert!(warn.is_empty(), "表不存在不该报错: {warn:?}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn lit_source_parse_render_roundtrip() {
    let dir = temp_dir("litsource");
    let root = dir.join("proj");
    // 合法值原样保留
    let (cfg, w) = parse_config("lit_source = \"zotero\"\n");
    assert_eq!(cfg.lit_source, "zotero");
    assert!(w.is_empty(), "{w:?}");
    write(&config_path(&root), "x = 1\n");
    write_config_at(&root, &cfg).unwrap();
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    assert!(raw.contains("lit_source"), "{raw}");
    assert_eq!(parse_config(&raw).0.lit_source, "zotero");

    // 缺省 = search，且默认值不写进文件（同 pipeline_opt_out 口径）
    let (d, _) = parse_config("");
    assert_eq!(d.lit_source, "search");
    write_config_at(&root, &d).unwrap();
    let raw2 = fs::read_to_string(config_path(&root)).unwrap();
    assert!(!raw2.contains("lit_source"), "默认值不该落盘: {raw2}");

    // zotero / endnote / folder 都是合法来源（已有文献盘点）；真非法值归一为 search 并留 warning
    let (ok2, _) = parse_config("lit_source = \"endnote\"\n");
    assert_eq!(ok2.lit_source, "endnote");
    let (bad, wb) = parse_config("lit_source = \"wos\"\nartifact_dir = \"out\"\n");
    assert_eq!(bad.lit_source, "search");
    assert_eq!(bad.artifact_dir, "out", "坏字段不该带垮其余解析");
    assert!(wb.iter().any(|x| x.contains("lit_source")), "{wb:?}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn inputs_and_submission_branch_round_trip() {
    let text = r#"submission_mode = "revision"
submission_round = 2

[[steps]]
name = "第 2 轮返修"
workspace_name = "rebuttal-r2"
inputs = ["reviews/round-2.md", "manuscript/revised-r1.md"]
optional_inputs = ["supplementary.csv"]
any_of_inputs = [["manuscript/paper-final.md", "manuscript/review-final.md"]]
"#;
    let (cfg, warnings) = parse_config(text);
    assert!(
        warnings.is_empty(),
        "合法输入/投稿字段不应告警: {warnings:?}"
    );
    assert_eq!(cfg.submission_mode.as_deref(), Some("revision"));
    assert_eq!(cfg.submission_round, Some(2));
    assert_eq!(
        cfg.steps[0].inputs,
        vec!["reviews/round-2.md", "manuscript/revised-r1.md"]
    );
    assert_eq!(cfg.steps[0].optional_inputs, vec!["supplementary.csv"]);
    assert_eq!(
        cfg.steps[0].any_of_inputs,
        vec![vec![
            "manuscript/paper-final.md".to_string(),
            "manuscript/review-final.md".to_string()
        ]]
    );
    let rendered = render_config(Some(text), &cfg).unwrap();
    let (back, back_warnings) = parse_config(&rendered);
    assert!(back_warnings.is_empty(), "回读不应告警: {back_warnings:?}");
    assert_eq!(back, cfg);
    assert!(rendered.contains("submission_mode = \"revision\""));
    assert!(rendered.contains("submission_round = 2"));
}

#[test]
fn project_settings_merge_keeps_answers_and_replaces_placeholders() {
    let mut existing = vec![
        "目标篇幅：6000-8000 词".into(),
        "读者与文风：（偏同行专家 / 偏入门科普）".into(),
    ];
    merge_project_settings(
        &mut existing,
        &[
            "目标篇幅：（如 5000 词）".into(),
            "读者与文风：偏入门科普".into(),
            "去向：（投期刊 / 课程作业）".into(),
        ],
    );
    assert_eq!(existing[0], "目标篇幅：6000-8000 词");
    assert_eq!(existing[1], "读者与文风：偏入门科普");
    assert_eq!(existing[2], "去向：（投期刊 / 课程作业）");
    assert_eq!(existing.len(), 3);
}

#[test]
fn first_step_external_inputs_do_not_create_noise_but_later_missing_inputs_warn() {
    let first = StepDto {
        name: "入口".into(),
        inputs: vec!["upstream/notes/".into(), "analysis-report.md".into()],
        ..StepDto::default()
    };
    assert!(
        validate_step(&first, &[], &[], true).is_empty(),
        "第一步输入可来自上游项目/外部资源，不应制造不可行动警告"
    );
    let later = StepDto {
        name: "后续".into(),
        inputs: vec!["missing/result.md".into()],
        ..StepDto::default()
    };
    let warnings = validate_step(&later, &[], &["previous.md".into()], false);
    assert_eq!(warnings.len(), 1, "后续步骤缺失输入仍应提示: {warnings:?}");
    let warnings = validate_step(&later, &[], &[], false);
    assert_eq!(
        warnings.len(),
        1,
        "即使前一步没有声明产物，后续步骤缺失输入也应提示: {warnings:?}"
    );
}

#[test]
fn review_template_steps_survive_serialization() {
    let dir = temp_dir("review-quality-gate");
    let cfg = demo_project_config();
    write_config_at(&dir, &cfg).unwrap();
    let restored = read_config_at(&dir).config;
    let draft = restored
        .steps
        .iter()
        .find(|s| s.workspace_name == "draft")
        .unwrap();
    // 模板已去掉 draft 步开工前的 hard_pause 质量门槛与决策问题：
    // 范围由人在审阅初稿时拍板，序列化往返后保持 auto_continue 且无决策问题
    assert_eq!(draft.decision_mode, "auto_continue");
    assert!(draft.decisions.is_empty());
    assert!(restored.steps[1]
        .inputs
        .iter()
        .any(|s| s == "papers/included.json"));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn decisions_parse_render_roundtrip() {
    let dir = temp_dir("decisions");
    let root = dir.join("proj");
    // 同一步骤里 decisions（表数组）与 discussion_seeds（内联数组）并存：
    // 渲染顺序必须仍是合法 toml，否则 seeds 会被吸进最后一个 decisions 表
    let text = "[[steps]]\nname = \"检索筛选\"\nworkspace_name = \"lit\"\n\
                    discussion_seeds = [\"范式锚点：借哪篇的结构？\"]\n\n\
                    [[steps.decisions]]\nq = \"综述角度怎么收\"\n\
                    options = [\"领域全景铺开\", \" 聚焦某个子问题 \", \"  \"]\n\n\
                    [[steps.decisions]]\nq = \"  \"\noptions = [\"甲\"]\n\n\
                    [[steps.decisions]]\nq = \"没有选项的题\"\noptions = []\n";
    write(&config_path(&root), text);
    let (cfg, warnings) = parse_config(text);
    // 非空问题都保留；无选项表示需手写依据，空问题仍丢弃。
    assert_eq!(
        cfg.steps[0].decisions.len(),
        2,
        "{:?}",
        cfg.steps[0].decisions
    );
    assert_eq!(cfg.steps[0].decisions[0].q, "综述角度怎么收");
    assert_eq!(
        cfg.steps[0].decisions[0].options,
        vec!["领域全景铺开", "聚焦某个子问题"]
    );
    assert_eq!(cfg.steps[0].decisions[1].q, "没有选项的题");
    assert!(cfg.steps[0].decisions[1].options.is_empty());
    // 讨论种子与待填依据互不影响
    assert_eq!(
        cfg.steps[0].discussion_seeds,
        vec!["范式锚点：借哪篇的结构？"]
    );
    // 写回再读：两个字段都原样回来（证明并存时的 toml 结构合法）
    write_config_at(&root, &cfg).unwrap();
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    let (cfg2, w2) = parse_config(&raw);
    assert_eq!(cfg2.steps[0].decisions, cfg.steps[0].decisions, "{raw}");
    assert_eq!(
        cfg2.steps[0].discussion_seeds, cfg.steps[0].discussion_seeds,
        "{raw}"
    );
    assert!(raw.contains("[[steps.decisions]]"), "{raw}");
    assert!(w2.is_empty(), "{w2:?}");
    assert!(warnings.is_empty(), "{warnings:?}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn asks_lit_source_round_trips_and_defaults_false() {
    let dir = temp_dir("asks-lit");
    let root = dir.join("proj");
    // 缺省不写这一行 → 解析为 false，渲染后也不该冒出来（档案卡保持简洁）
    let plain = "[[steps]]\nname = \"检索\"\nworkspace_name = \"lit\"\n";
    let (cfg0, w0) = parse_config(plain);
    assert!(!cfg0.steps[0].asks_lit_source);
    assert!(w0.is_empty(), "{w0:?}");
    write(&config_path(&root), plain);
    write_config_at(&root, &cfg0).unwrap();
    let raw0 = fs::read_to_string(config_path(&root)).unwrap();
    assert!(!raw0.contains("asks_lit_source"), "{raw0}");

    // 声明为 true → 解析出来，写回后仍在（漏了透传会让编辑器一保存就把声明抹掉，
    // 与 human_tasks.optional 同一类静默丢失）
    let text = "[[steps]]\nname = \"检索\"\nworkspace_name = \"lit\"\n\
                    asks_lit_source = true\n";
    write(&config_path(&root), text);
    let (cfg, warnings) = parse_config(text);
    assert!(cfg.steps[0].asks_lit_source);
    assert!(warnings.is_empty(), "{warnings:?}");
    write_config_at(&root, &cfg).unwrap();
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    let (cfg2, w2) = parse_config(&raw);
    assert!(cfg2.steps[0].asks_lit_source, "{raw}");
    assert!(w2.is_empty(), "{w2:?}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn seed_complete_round_trips_and_defaults_false() {
    let dir = temp_dir("seed-complete");
    let root = dir.join("proj");
    let plain = "[[steps]]\nname = \"检索\"\nworkspace_name = \"lit\"\n";
    let (cfg0, w0) = parse_config(plain);
    assert!(!cfg0.steps[0].seed_complete);
    assert!(w0.is_empty(), "{w0:?}");
    write(&config_path(&root), plain);
    write_config_at(&root, &cfg0).unwrap();
    let raw0 = fs::read_to_string(config_path(&root)).unwrap();
    assert!(!raw0.contains("seed_complete"), "{raw0}");

    let text = "[[steps]]\nname = \"检索\"\nworkspace_name = \"lit\"\n\
                    seed_complete = true\n";
    let (cfg, warnings) = parse_config(text);
    assert!(cfg.steps[0].seed_complete);
    assert!(warnings.is_empty(), "{warnings:?}");
    write_config_at(&root, &cfg).unwrap();
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    let (cfg2, w2) = parse_config(&raw);
    assert!(cfg2.steps[0].seed_complete, "{raw}");
    assert!(w2.is_empty(), "{w2:?}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn inspect_step_inputs_counts_included_lines_and_notes() {
    let dir = temp_dir("inspect-inputs");
    let root = dir.join("proj");
    fs::create_dir_all(root.join("papers")).unwrap();
    fs::create_dir_all(root.join("notes")).unwrap();
    fs::write(
        root.join("papers/included.md"),
        "# skip\nPaper A — a, 2020 — j — doi\nPaper B — b, 2021 — j — doi\n",
    )
    .unwrap();
    fs::write(root.join("notes/a.md"), b"n1").unwrap();
    fs::write(root.join("notes/b.md"), b"n2").unwrap();
    let cfg = ProjectConfigDto {
        steps: vec![StepDto {
            name: "精读".into(),
            workspace_name: "lit-notes".into(),
            inputs: vec!["papers/included.md".into(), "notes/*.md".into()],
            optional_inputs: vec!["outline.md".into()],
            ..StepDto::default()
        }],
        ..ProjectConfigDto::default()
    };
    write_config_at(&root, &cfg).unwrap();
    let chips = inspect_step_inputs_at(&root, "精读").unwrap();
    let included = chips
        .iter()
        .find(|c| c.pattern.ends_with("included.md"))
        .unwrap();
    assert_eq!(included.count, 2);
    assert!(included.present);
    let notes = chips.iter().find(|c| c.pattern.contains("notes")).unwrap();
    assert_eq!(notes.count, 2);
    let missing = chips.iter().find(|c| c.pattern == "outline.md").unwrap();
    assert!(!missing.present);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn human_tasks_parse_render_roundtrip() {
    let dir = temp_dir("humantasks");
    let root = dir.join("proj");
    let text = "[[steps]]\nname = \"检索筛选\"\nworkspace_name = \"lit\"\n\
                    discussion_seeds = [\"角度怎么收？\", \"  \", \"检索哪几个库？\"]\n\n\
                    [[steps.human_tasks]]\ntitle = \"下载付费文献\"\nguidance = \"渠道自选\"\n\
                    target = \"papers/*.pdf\"\ntiming = \"after\"\n\n\
                    [[steps.human_tasks]]\ntitle = \"补充已知文献\"\ntarget = \"papers/\"\n\n\
                    [[steps]]\nname = \"写作\"\n";
    write(&config_path(&root), text);
    let (cfg, warnings) = parse_config(text);
    assert_eq!(
        cfg.steps[0].human_tasks.len(),
        2,
        "{:?}",
        cfg.steps[0].human_tasks
    );
    // 讨论种子：去空白、空项剔除
    assert_eq!(
        cfg.steps[0].discussion_seeds,
        vec!["角度怎么收？", "检索哪几个库？"]
    );
    let h0 = &cfg.steps[0].human_tasks[0];
    assert_eq!(h0.title, "下载付费文献");
    assert_eq!(h0.target, "papers/*.pdf");
    assert_eq!(h0.timing, "after");
    // 缺省 timing = during
    assert_eq!(cfg.steps[0].human_tasks[1].timing, "during");
    // 写回再读：内容不变；during 与空字段省略不写
    write_config_at(&root, &cfg).unwrap();
    let raw = fs::read_to_string(config_path(&root)).unwrap();
    let (cfg2, _) = parse_config(&raw);
    assert_eq!(cfg2.steps[0].human_tasks, cfg.steps[0].human_tasks);
    assert_eq!(
        cfg2.steps[0].discussion_seeds,
        cfg.steps[0].discussion_seeds
    );
    assert!(raw.contains("[[steps.human_tasks]]"), "{raw}");
    assert!(raw.contains("discussion_seeds"), "{raw}");
    assert!(!raw.contains("during"), "默认时机省略不写: {raw}");
    assert!(warnings.is_empty(), "{warnings:?}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn human_tasks_bad_entries_tolerated() {
    // 空标题跳过、非法时机归一 during 并告警、无 human_tasks 段的步骤不受影响
    let text = "[[steps]]\nname = \"检索\"\n\n\
                    [[steps.human_tasks]]\ntitle = \"  \"\n\n\
                    [[steps.human_tasks]]\ntitle = \"下载全文\"\ntiming = \"whenever\"\n";
    let (cfg, warnings) = parse_config(text);
    assert_eq!(cfg.steps[0].human_tasks.len(), 1);
    assert_eq!(cfg.steps[0].human_tasks[0].timing, "during");
    assert!(
        warnings.iter().any(|w| w.contains("标题为空")),
        "{warnings:?}"
    );
    assert!(
        warnings.iter().any(|w| w.contains("whenever")),
        "{warnings:?}"
    );
}

// ===== 任务书草稿（v3.72） =====

#[test]
fn draft_rel_path_prefers_workspace_name() {
    assert_eq!(
        draft_rel_path("文献检索与筛选", "lit-search"),
        ".ccode/drafts/lit-search.md"
    );
    // 无工作区名回落步骤名，不安全字符替换为 -
    assert_eq!(
        draft_rel_path("综述 大纲/初稿", ""),
        ".ccode/drafts/综述-大纲-初稿.md"
    );
    // 回归：注释曾写「workspace_name 已 sanitize」，实际写入链路全程原样落 TOML，
    // 而它来自裸输入框。含 Windows 非法字符时落盘 os error 123，
    // 「聊想法 / 评审沉淀 / 融合进任务书」在该步骤永久不可用。
    assert_eq!(
        draft_rel_path("步骤", "draft:v2"),
        ".ccode/drafts/draft-v2.md"
    );
    assert_eq!(draft_rel_path("步骤", "方案?"), ".ccode/drafts/方案-.md");
    // 路径逃逸（这条 macOS 同样中招）：不锚定 - 的个数，只断言逃不出 drafts 目录
    let escaped = draft_rel_path("步骤", "../../../evil");
    assert!(
        escaped.starts_with(".ccode/drafts/") && !escaped.contains(".."),
        "{escaped}"
    );
    assert_eq!(
        escaped.matches('/').count(),
        2,
        "不得多出目录层级: {escaped}"
    );
    // 保留设备名：拼出的 .ccode/drafts/CON.md 在 Windows 上是设备而非文件
    assert_eq!(draft_rel_path("步骤", "CON"), ".ccode/drafts/CON-.md");
}

#[test]
fn append_step_draft_creates_then_appends() {
    let dir = temp_dir("draft");
    let root = dir.join("proj");
    write(
        &config_path(&root),
        "[[steps]]\nname = \"检索筛选\"\nworkspace_name = \"lit\"\n",
    );
    // 草稿不存在 → 以标题头新建
    let rel = append_step_draft_at(&root, "检索筛选", "上一步评审沉淀", "结论 A 保留").unwrap();
    assert_eq!(rel, ".ccode/drafts/lit.md");
    let text = fs::read_to_string(root.join(&rel)).unwrap();
    assert!(text.starts_with("# 任务书草稿：检索筛选"), "{text}");
    assert!(text.contains("## 上一步评审沉淀"), "{text}");
    assert!(text.contains("结论 A 保留"), "{text}");
    // 再次追加：原有内容保留，新小节在后
    append_step_draft_at(&root, "检索筛选", "二次沉淀", "结论 B").unwrap();
    let text = fs::read_to_string(root.join(&rel)).unwrap();
    assert!(
        text.contains("结论 A 保留") && text.contains("结论 B"),
        "{text}"
    );
    assert!(text.find("结论 A 保留") < text.find("结论 B"), "追加保序");
    // 步骤不存在报错
    assert!(append_step_draft_at(&root, "没有这步", "x", "y").is_err());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn delete_project_dir_rejects_home_and_shallow() {
    let dir = temp_dir("deldir-guard");
    // home 与文档目录本身一律拒绝
    let home = crate::dirs::home_dir().unwrap();
    let err = guard_project_dir(&home).unwrap_err();
    assert!(err.contains("主目录"), "{err}");
    // 回归：Windows 上 canonicalize 带 `\\?\` 前缀，两侧口径不一致会让这道闸静默失效。
    // 两种写法都必须拦下（生产调用方传的正是 canonicalize 后的形式）。
    if let Ok(home_c) = std::fs::canonicalize(&home) {
        let err = guard_project_dir(&home_c).unwrap_err();
        assert!(err.contains("主目录"), "canonicalize 形式也必须拦下: {err}");
    }
    if let Some(docs) = crate::dirs::document_dir() {
        let err = guard_project_dir(&docs).unwrap_err();
        assert!(err.contains("文档目录"), "{err}");
    }
    // 浅层路径：文件系统根（零有效段）拒绝
    #[cfg(unix)]
    {
        let err = guard_project_dir(Path::new("/")).unwrap_err();
        assert!(err.contains("层级过浅"), "{err}");
        // 系统目录
        assert!(guard_project_dir(Path::new("/usr/bin")).is_err());
    }
    // 正常两级以上项目目录放行
    let ok = dir.join("a").join("b");
    fs::create_dir_all(&ok).unwrap();
    assert!(guard_project_dir(&ok.canonicalize().unwrap()).is_ok());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn task_card_kind_inferred_for_legacy_and_written_back() {
    let dir = temp_dir("task-kind");
    let project = dir.join("proj");
    fs::create_dir_all(&project).unwrap();
    // 旧卡（无 kind 字段）：step 非空 → draft，step 空 → idea
    write(
        &config_path(&project),
        "[[tasks]]\nid = \"t-a\"\nname = \"挂步骤旧卡\"\nstep = \"检索筛选\"\ncreated_at = \"2026-01-01\"\n\n\
             [[tasks]]\nid = \"t-b\"\nname = \"未挂旧卡\"\ncreated_at = \"2026-01-01\"\n\n\
             [[tasks]]\nid = \"t-c\"\nname = \"显式想法卡\"\nstep = \"检索筛选\"\nkind = \"idea\"\ncreated_at = \"2026-01-01\"\n\n\
             [[tasks]]\nid = \"t-d\"\nname = \"未知 kind\"\nkind = \"weird\"\ncreated_at = \"2026-01-01\"\n",
    );
    let cards = task_cards_at(&project);
    assert_eq!(cards.len(), 4);
    assert_eq!(cards[0].kind, "draft", "缺 kind + 有 step → draft");
    assert_eq!(cards[1].kind, "idea", "缺 kind + 无 step → idea");
    assert_eq!(
        cards[2].kind, "idea",
        "显式 kind 保留（哪怕与 step 推断相反）"
    );
    assert_eq!(cards[3].kind, "idea", "未知 kind 按缺省规则推断");
    // 写回固化推断值（免迁移脚本）
    write_tasks_at(&project, &cards).unwrap();
    let raw = fs::read_to_string(config_path(&project)).unwrap();
    assert!(raw.contains("kind = \"draft\""), "{raw}");
    assert!(raw.contains("kind = \"idea\""), "{raw}");
    // 新建：显式 kind 生效；缺省按 step 推断
    let idea = create_task_card_at(&project, "新想法", Some("检索筛选"), Some("idea")).unwrap();
    assert_eq!(idea.kind, "idea");
    let draft = create_task_card_at(&project, "新讨论", Some("检索筛选"), None).unwrap();
    assert_eq!(draft.kind, "draft");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn fuse_prompt_branches_on_draft_presence() {
    // 草稿非空：带上现有草稿做去重参照，但只要结论片段
    let p = build_fuse_prompt(
        "选角度",
        "文献检索",
        Some("# 任务书草稿\n\n## 待拍板\n"),
        "[用户] 聊角度",
    );
    assert!(p.contains("文献检索") && p.contains("选角度"));
    assert!(p.contains("当前任务书草稿"));
    assert!(p.contains("已经写过的结论不要重复"));
    assert!(p.contains("[用户] 聊角度"));
    // 草稿为空/缺失：同样只要片段，不要整份草稿
    for empty in [None, Some(""), Some("   ")] {
        let p = build_fuse_prompt("选角度", "文献检索", empty, "讨论内容");
        assert!(p.contains("还没有任务书草稿"), "{p}");
        assert!(p.contains("提炼"), "{p}");
        assert!(!p.contains("已经写过的结论不要重复"), "{p}");
    }
    // 两个分支都不得索要整份草稿：落盘走 append_step_draft 追加，
    // 让 AI 输出全文会诱导它复述已有内容，追加后草稿越滚越重复
    for d in [Some("# 任务书草稿\n"), None] {
        let p = build_fuse_prompt("选角度", "文献检索", d, "讨论内容");
        assert!(!p.contains("全文"), "不该索要整份草稿: {p}");
        assert!(p.contains("不要输出标题行"), "标题由 append 侧生成: {p}");
    }
}

#[test]
fn write_task_draft_at_writes_atomically() {
    let dir = temp_dir("writedraft");
    let root = dir.join("proj");
    write(
        &config_path(&root),
        "[[steps]]\nname = \"检索筛选\"\nworkspace_name = \"lit\"\n",
    );
    let saved =
        write_task_draft_at(&root, "检索筛选", "# 任务书草稿：检索筛选\n", None).unwrap();
    let path = root.join(&saved.rel_path);
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "# 任务书草稿：检索筛选\n"
    );
    assert!(saved.revision.is_some());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn write_task_draft_rejects_stale_revision_and_keeps_disk() {
    let dir = temp_dir("writedraft-rev");
    let root = dir.join("proj");
    write(
        &config_path(&root),
        "[[steps]]\nname = \"检索筛选\"\nworkspace_name = \"lit\"\n",
    );
    let first = write_task_draft_at(&root, "检索筛选", "v1\n", None).unwrap();
    let err = write_task_draft_at(&root, "检索筛选", "v2\n", Some("deadbeef")).unwrap_err();
    assert!(err.contains("未覆盖"), "{err}");
    assert_eq!(
        fs::read_to_string(root.join(&first.rel_path)).unwrap(),
        "v1\n"
    );
    let second =
        write_task_draft_at(&root, "检索筛选", "v2\n", first.revision.as_deref()).unwrap();
    assert_eq!(
        fs::read_to_string(root.join(&second.rel_path)).unwrap(),
        "v2\n"
    );
    std::fs::remove_dir_all(&dir).ok();
}

// ===== 任务卡（[[tasks]]） =====

#[test]
fn task_card_crud_round_trip_and_dup_rejected() {
    let dir = temp_dir("task-crud");
    let project = dir.join("proj");
    fs::create_dir_all(&project).unwrap();
    // 无档案卡时读为空表
    assert!(task_cards_at(&project).is_empty());

    // 创建：id 带 t- 前缀、created_at 非空、step 可选
    let card = create_task_card_at(&project, "文献筛选", Some("文献检索与筛选"), None).unwrap();
    assert!(card.id.starts_with("t-"), "id 前缀: {}", card.id);
    assert!(!card.created_at.is_empty());
    assert_eq!(card.step.as_deref(), Some("文献检索与筛选"));
    assert_eq!(card.workspace, None);
    // 空白 step 视为未挂
    let card2 = create_task_card_at(&project, "数据分析", Some("  "), None).unwrap();
    assert_eq!(card2.step, None);

    // 读回一致；档案卡其余段不受影响（先写一份 resources/steps 再读）
    write_config_at(&project, &sample_config()).unwrap();
    let cards = task_cards_at(&project);
    assert_eq!(cards.len(), 2);
    assert_eq!(cards[0].name, "文献筛选");
    let read = read_config_at(&project);
    assert_eq!(
        read.config,
        sample_config(),
        "tasks 写回不得动 resources/steps"
    );

    // 重名拒绝（大小写敏感：不同大小写允许）
    let err = create_task_card_at(&project, "文献筛选", None, None).unwrap_err();
    assert!(err.contains("同名卡片"), "{err}");
    assert!(
        create_task_card_at(&project, "文献筛选 ", None, None).is_err(),
        "尾随空白去重后仍同名应拒绝"
    );
    // 空名拒绝
    assert!(create_task_card_at(&project, "   ", None, None).is_err());

    // 重命名：改其他卡撞名拒绝；改自己同名放行；不存在的 id 报错
    let err = rename_task_card_at(&project, &card2.id, "文献筛选").unwrap_err();
    assert!(err.contains("同名卡片"), "{err}");
    rename_task_card_at(&project, &card.id, "文献筛选").unwrap();
    assert!(rename_task_card_at(&project, "t-gone", "x").is_err());

    // 删除：少一张；删不存在的 id 报错
    let card3 = create_task_card_at(&project, "润色", None, None).unwrap();
    delete_task_card_at(&project, &card2.id).unwrap();
    let cards = task_cards_at(&project);
    assert_eq!(cards.len(), 2, "删一张后剩两张: {cards:?}");
    assert!(delete_task_card_at(&project, "t-gone").is_err());
    // 全删后 tasks 段从档案卡移除
    delete_task_card_at(&project, &card.id).unwrap();
    delete_task_card_at(&project, &card3.id).unwrap();
    assert!(task_cards_at(&project).is_empty());
    let on_disk = fs::read_to_string(config_path(&project)).unwrap();
    assert!(
        !on_disk.contains("[[tasks]]"),
        "空 tasks 不应落盘: {on_disk}"
    );
    // resources/steps 仍在
    let read = read_config_at(&project);
    assert_eq!(read.config, sample_config());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn task_card_parse_tolerates_broken_and_render_keeps_unknown() {
    // 防御式解析：坏条目跳过、缺字段容忍、空白 step 归 None；
    // 旧版残留的 briefs 字段解析时忽略（类型对错都不阻断），写回自然丢弃
    let text = r#"artifact_dir = "outputs"

[[tasks]]
id = "t-a1"
name = "好卡片"
step = "步骤一"
created_at = "2026-08-11T00:00:00Z"
briefs = [".ccode/brief-1.md"]

[[tasks]]
id = "t-b2"
name = "缺字段容忍"
step = "  "

[[tasks]]
name = "没有 id"

[[tasks]]
id = "t-c3"
name = "坏 briefs 残留也忽略"
briefs = "not-an-array"
"#;
    let cards = parse_task_cards(text);
    assert_eq!(
        cards.len(),
        3,
        "缺 id 的整条跳过；残留 briefs 字段一律忽略: {cards:?}"
    );
    assert_eq!(cards[1].step, None, "空白 step 归 None");
    assert_eq!(cards[1].created_at, "");
    // 整份坏掉 → 空表
    assert!(parse_task_cards("not [valid toml").is_empty());

    // 写回只替换 tasks 段，未知键与注释保留；残留 briefs 写回后自然丢弃
    let existing =
        "# 用户注释\nfuture_top_key = 42\n\n[[tasks]]\nid = \"t-old\"\nname = \"旧卡\"\n";
    let rendered = render_tasks(Some(existing), &cards[..1]).unwrap();
    assert!(rendered.contains("# 用户注释"), "{rendered}");
    assert!(rendered.contains("future_top_key = 42"), "{rendered}");
    assert!(!rendered.contains("旧卡"), "{rendered}");
    assert!(
        !rendered.contains("brief-1.md"),
        "残留 briefs 写回应丢弃: {rendered}"
    );
    let back = parse_task_cards(&rendered);
    assert_eq!(back, cards[..1].to_vec(), "tasks 往返一致");
    // 现有文件是坏 TOML 时停止写入，不覆盖未知内容
    assert!(render_tasks(Some("not [valid"), &cards).is_err());
}

#[test]
fn project_model_must_belong_to_the_connection() {
    let models = vec!["glm-5.3".to_string(), "glm-5.3-flashx".to_string()];
    assert_eq!(accept_project_model(&models, None).unwrap(), None);
    assert_eq!(accept_project_model(&models, Some("  ")).unwrap(), None);
    assert_eq!(
        accept_project_model(&models, Some("glm-5.3-flashx"))
            .unwrap()
            .as_deref(),
        Some("glm-5.3-flashx"),
    );
    assert!(accept_project_model(&models, Some("deepseek-v4-flash-0731")).is_err());
    assert!(accept_project_model(&[], Some("glm-5.3")).is_err());
}

#[test]
fn gitignore_template_covers_ledger_block_and_coding_mode_does_not() {
    let research = gitignore_text("research", "artifacts");
    assert!(research.contains(GITIGNORE_LEDGER_MARKER));
    for path in LEDGER_IGNORE_PATHS {
        assert!(research.contains(path), "模板缺忽略行：{path}");
    }
    // 迁移 marker 块与模板同款，保证幂等判据不会误判老模板
    assert!(research.contains("（日常积累，不进 git；2026-10-13 双台账口径）"));
    // coding 模式没有文献台账，不带积累面
    assert!(!gitignore_text("coding", "artifacts").contains(GITIGNORE_LEDGER_MARKER));
    // 人工请求一步一份、不进 git（2026-10-22：提交进去后一路带到下一步，收件箱里全是上一步答过的问题）
    for mode in ["research", "coding"] {
        assert!(gitignore_text(mode, "artifacts").lines().any(|l| l == ".ccode/help-wanted.md"), "{mode}");
    }
    // 同步到文献库生成的导入文件不进 git（科研项目才有文献库）
    for path in ["/papers/zotero-library.ris", "/papers/endnote-library.ris", "/papers/endnote-journals.txt"] {
        assert!(gitignore_text("research", "artifacts").lines().any(|l| l == path), "{path}");
    }
}


// ===== B1 步骤槽位 =====

#[test]
fn agent_binding_slot_accepts_reader_and_step_prefix_rejects_garbage() {
    assert!(valid_agent_binding_slot("reader"));
    assert!(valid_agent_binding_slot("step:文献检索与筛选"));
    assert!(valid_agent_binding_slot("step:a"));
    // 裸 step 前缀（空步骤名）/未知固定槽/乱写一律拒绝
    assert!(!valid_agent_binding_slot("step:"));
    assert!(!valid_agent_binding_slot("step"));
    assert!(valid_agent_binding_slot("discuss")); // B4 已与消费同批放开
    assert!(valid_agent_binding_slot("chat")); // 项目对话，与 discuss 分开
    assert!(valid_agent_binding_slot("assistant")); // 项目助手（无头问答）
    assert!(!valid_agent_binding_slot(""));
    assert!(!valid_agent_binding_slot("random-slot"));
}

#[test]
fn step_names_must_be_nonempty_and_unique() {
    let mk = |names: &[&str]| {
        names
            .iter()
            .map(|n| StepDto {
                name: (*n).into(),
                ..Default::default()
            })
            .collect::<Vec<_>>()
    };
    assert!(validate_step_names(&mk(&["文献检索与筛选", "综述大纲"])).is_ok());
    // 空名与重名都拦；重名文案点名「专属绑定按步骤名匹配」
    let empty = validate_step_names(&mk(&["甲", " "]));
    assert!(empty.is_err() && empty.unwrap_err().contains("还没有填写步骤名"));
    let dup = validate_step_names(&mk(&["文献精读", "文献精读"]));
    assert!(dup.is_err() && dup.unwrap_err().contains("步骤名重复"));
    assert!(validate_step_names(&[]).is_ok());
}

#[test]
fn ensure_geminiignore_writes_negations_excludes_from_git_and_preserves_user_file() {
    let tmp = temp_dir("geminiignore");
    fs::create_dir_all(&tmp).unwrap();
    // 非 Git 目录不落 .geminiignore
    ensure_geminiignore(&tmp);
    assert!(!tmp.join(".geminiignore").exists());

    let Some(git) = crate::agents::resolve_binary("git") else {
        let _ = fs::remove_dir_all(&tmp);
        return;
    };
    let status = std::process::Command::new(&git)
        .args(["init", "-q"])
        .current_dir(&tmp)
        .status();
    if status.map(|s| !s.success()).unwrap_or(true) {
        let _ = fs::remove_dir_all(&tmp);
        return;
    }

    ensure_geminiignore(&tmp);
    let gi = tmp.join(".geminiignore");
    assert!(gi.is_file());
    let text = fs::read_to_string(&gi).unwrap();
    for expected in ["!TASK.md", "!/.ccode/", "!/.ccode/**", "!/artifacts/**", "!/output/**"] {
        assert!(text.lines().any(|l| l == expected), "missing {expected}");
    }
    let exclude = fs::read_to_string(tmp.join(".git/info/exclude")).unwrap();
    assert!(exclude.lines().any(|l| l.trim() == ".geminiignore"));
    // git status 保持干净
    let out = crate::workspaces::run_git(&tmp, &["status", "-s"], Duration::from_secs(10)).unwrap();
    assert!(out.trim().is_empty(), "git status dirty: {out}");

    // 用户手写的 .geminiignore 不被覆盖
    fs::write(&gi, "secret.txt\n").unwrap();
    ensure_geminiignore(&tmp);
    assert_eq!(fs::read_to_string(&gi).unwrap(), "secret.txt\n");
    let _ = fs::remove_dir_all(&tmp);
}
