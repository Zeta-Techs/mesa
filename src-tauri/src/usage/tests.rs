use super::*;

#[test]
fn input_prices_tell_light_tiers_without_name_hints() {
    // 一键配置认轻量靠它：gpt-6-luna 名字里没有 mini / flash，价格远低于同代 sol；
    // 公共库层按统一写法存键（gpt-6-1-sol），目录里写 gpt-6.1-sol 也要对上
    let db = crate::model_registry::keyed(vec![
        ("gpt-6-luna".to_string(), (0.1, 0.5)),
        ("gpt-6-1-sol".to_string(), (2.0, 10.0)),
    ]);
    let chain: PriceChain = [Vec::new(), price_layer(db), Vec::new()];
    let p = input_prices(
        &["gpt-6-luna".into(), "gpt-6.1-sol".into(), "zz-no-such-model".into()],
        &chain,
    );
    assert_eq!(p.get("gpt-6-luna"), Some(&0.1));
    assert_eq!(p.get("gpt-6.1-sol"), Some(&2.0));
    assert!(!p.contains_key("zz-no-such-model"));
}

fn claude_assistant(model: &str) -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"2026-10-24T01:00:00Z","message":{{"model":"{model}","usage":{{"input_tokens":1,"output_tokens":1}}}}}}"#
    )
}

#[test]
fn last_codex_turn_model_reads_turn_context_without_usage() {
    // 一轮都没跑完（请求被拒）的对话没有 token_count，模型只在 turn_context 里
    let dir = std::env::temp_dir().join(format!("ccode-turn-model-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("rollout.jsonl");
    std::fs::write(
        &f,
        [
            r#"{"type":"session_meta","payload":{"id":"x","model_provider":"openai"}}"#,
            r#"{"type":"turn_context","payload":{"model":"gpt-6-luna","effort":"high"}}"#,
            r#"{"type":"event_msg","payload":{"type":"error","message":"boom"}}"#,
            r#"{"type":"turn_context","payload":{"model":"gpt-6-sol","effort":"high"}}"#,
        ]
        .join("\n"),
    )
    .unwrap();
    let path = f.to_string_lossy();
    assert_eq!(last_codex_turn_model(&path).as_deref(), Some("gpt-6-sol"));
    assert_eq!(last_session_model("codex", &path, "x"), None, "用量口径读不到，所以续聊不能用它");
    assert_eq!(last_codex_effort(&path).as_deref(), Some("high"));
    assert_eq!(last_codex_turn_model("/no/such/file.jsonl"), None);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn last_session_model_reads_tail_and_widens_until_found() {
    let dir = std::env::temp_dir().join(format!("ccode-tail-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let filler = format!(r#"{{"type":"user","message":{{"content":"{}"}}}}"#, "x".repeat(4000));
    // 模型在末尾：尾窗一次读到，取最后那个
    let near = dir.join("near.jsonl");
    let mut body = vec![claude_assistant("old-model")];
    body.extend(std::iter::repeat(filler.clone()).take(800));
    body.push(claude_assistant("new-model"));
    std::fs::write(&near, body.join("\n") + "\n").unwrap();
    assert_eq!(
        last_session_model("claude-code", near.to_str().unwrap(), "s").as_deref(),
        Some("new-model")
    );
    // 模型只在文件头、后面 3MB 都没有：窗口一路翻倍到能读到它
    let far = dir.join("far.jsonl");
    let mut body = vec![claude_assistant("only-model")];
    body.extend(std::iter::repeat(filler).take(800));
    std::fs::write(&far, body.join("\n")).unwrap();
    assert_eq!(
        last_session_model("claude-code", far.to_str().unwrap(), "s").as_deref(),
        Some("only-model")
    );
    // Codex：turn_context 在头、token_count 在尾，尾窗里的事件没模型名就继续往前
    let codex = dir.join("codex.jsonl");
    let mut body = vec![
        r#"{"type":"turn_context","payload":{"model":"gpt-5.5","effort":"high"}}"#.to_string(),
    ];
    body.extend(
        std::iter::repeat(format!(r#"{{"type":"response_item","payload":{{"t":"{}"}}}}"#, "y".repeat(4000)))
            .take(400),
    );
    body.push(r#"{"type":"event_msg","timestamp":"2026-10-24T01:00:00Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":3,"output_tokens":1}}}}"#.to_string());
    std::fs::write(&codex, body.join("\n")).unwrap();
    let path = codex.to_str().unwrap();
    assert_eq!(last_session_model("codex", path, "s").as_deref(), Some("gpt-5.5"));
    assert_eq!(last_codex_effort(path).as_deref(), Some("high"));
    std::fs::remove_dir_all(&dir).ok();
}
fn ev(day: &str, model: &str, input: u64, output: u64) -> UsageEvent {
    UsageEvent {
        day: day.into(),
        model: model.into(),
        input,
        output,
        cache_read: 0,
        cache_write: 0,
        cache_write_1h: 0,
        source: SOURCE_CLI.into(),
        internal: false,
        official: false,
    }
}

#[test]
fn aggregate_groups_by_day_model_session() {
    let contribs = vec![
        SessionContrib {
            agent: "codex".into(),
            session_id: "s1".into(),
            project_path: "/p".into(),
            workspace: String::new(),
            events: vec![
                ev("2026-07-01", "gpt-5", 10, 5),
                ev("2026-07-01", "gpt-5", 20, 5),
                ev("2026-07-02", "gpt-5", 1, 1),
            ],
        },
        SessionContrib {
            agent: "codex".into(),
            session_id: "s2".into(),
            project_path: "/p".into(),
            workspace: String::new(),
            events: vec![ev("2026-07-01", "gpt-5", 7, 3)],
        },
        SessionContrib {
            agent: "claude-code".into(),
            session_id: "s3".into(),
            project_path: "/p".into(),
            workspace: String::new(),
            events: vec![], // 无 usage 的会话不产生行
        },
    ];
    let rows = aggregate(&contribs);
    assert_eq!(rows.len(), 3, "(d1,s1)+(d1,s2)+(d2,s1) 三行");
    let d1s1 = rows
        .iter()
        .find(|r| r.day == "2026-07-01" && r.session_id == "s1")
        .unwrap();
    assert_eq!((d1s1.input, d1s1.output), (30, 10));
    let d2 = rows.iter().find(|r| r.day == "2026-07-02").unwrap();
    assert_eq!((d2.input, d2.session_id.as_str()), (1, "s1"));
}

#[test]
fn aggregate_drops_events_without_day() {
    let contribs = vec![SessionContrib {
        agent: "kimi".into(),
        session_id: "s1".into(),
        project_path: "/p".into(),
        workspace: String::new(),
        events: vec![ev("", "kimi-k2", 10, 5), ev("2026-08-01", "kimi-k2", 1, 1)],
    }];
    let rows = aggregate(&contribs);
    assert_eq!(rows.len(), 1, "时间戳缺失的事件不得产出 day=\"\" 噪声行");
    assert_eq!(rows[0].day, "2026-08-01");
    assert_eq!((rows[0].input, rows[0].output), (1, 1));
}

#[test]
fn seen_key_parse_roundtrips_new_format_only() {
    assert_eq!(
        parse_seen_key("seen:codex:s1:live"),
        Some(("codex".into(), "s1".into()))
    );
    assert_eq!(
        parse_seen_key("seen:claude-code:abc:snap"),
        Some(("claude-code".into(), "abc".into()))
    );
    // 旧格式（无来源后缀）与损坏键反解失败，避免误删其他会话的行
    assert_eq!(parse_seen_key("seen:codex:s1"), None);
    assert_eq!(parse_seen_key("seen:onlyone"), None);
    assert_eq!(parse_seen_key("other:x"), None);
}

#[test]
fn opencode_events_streamed_from_db() {
    let dir = std::env::temp_dir().join(format!("ccode-usage-oc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("opencode.db");
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);",
        )
        .unwrap();
        let rows = [
            ("m1", "s1", 1785307071000i64, r#"{"role":"user"}"#),
            (
                "m2",
                "s1",
                1785307072000,
                r#"{"role":"assistant","modelID":"grok-4","tokens":{"input":10,"output":5,"reasoning":2,"cache":{"read":3,"write":1}}}"#,
            ),
            (
                "m3",
                "s2",
                1785307073000,
                r#"{"role":"assistant","tokens":{"input":99,"output":9}}"#,
            ),
        ];
        for (id, sid, t, data) in rows {
            conn.execute(
                "INSERT INTO message VALUES(?1,?2,?3,?4)",
                params![id, sid, t, data],
            )
            .unwrap();
        }
    }
    let events = opencode_events(&db, "s1");
    assert_eq!(events.len(), 1, "只取本会话的 assistant 行");
    assert_eq!(events[0].day, day_of_ms(1785307072000));
    assert_eq!(
        (
            events[0].input,
            events[0].output,
            events[0].cache_read,
            events[0].cache_write
        ),
        (10, 7, 3, 1),
        "reasoning 计入输出侧"
    );
    assert_eq!(events[0].model, "grok-4");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_v2_events_from_session_message() {
    // 2.x：会话在 session_v2，用量在 session_message 的 assistant 行与压缩行，模型是 data.model.id
    let dir = std::env::temp_dir().join(format!("ccode-usage-oc2-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("opencode.db");
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            r#"CREATE TABLE session_v2(id TEXT PRIMARY KEY, time_updated INTEGER);
                   CREATE TABLE session_message(id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
                   INSERT INTO session_v2 VALUES('s1', 1785307072000);
                   INSERT INTO session_message VALUES('m1','s1','user',1,1785307071000,'{"text":"hi"}');
                   INSERT INTO session_message VALUES('m2','s1','assistant',2,1785307072000,'{"model":{"id":"e2e-picked","providerID":"x"},"tokens":{"input":5,"output":1,"reasoning":2,"cache":{"read":3,"write":0}}}');
                   INSERT INTO session_message VALUES('m3','s1','compaction',3,1785307073000,'{"status":"completed","summary":"…","tokens":{"input":40,"output":8}}');
                   INSERT INTO session_message VALUES('m4','s1','idle',4,1785307074000,'{"outcome":"succeeded"}');"#,
        )
        .unwrap();
    }
    let events = opencode_events(&db, "s1");
    assert_eq!(events.len(), 2, "assistant 与压缩各一条，user / idle 不算");
    assert_eq!(events[0].model, "e2e-picked");
    assert_eq!((events[0].input, events[0].output, events[0].cache_read), (5, 3, 3));
    assert_eq!((events[1].input, events[1].output), (40, 8));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pricing_override_ignores_empty_prefix() {
    let dir = std::env::temp_dir().join(format!("ccode-usage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("pricing.json");
    std::fs::write(&p, r#"{"": [9.0, 9.0], "relay-y": [0.5, 0.5]}"#).unwrap();
    let table = load_pricing(Some(&p));
    assert_eq!(
        price_of("totally-unknown-model", &table),
        None,
        "空前缀不得匹配一切模型"
    );
    assert_eq!(price_of("relay-y-x", &table), Some((0.5, 0.5)));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn schema_reset_keeps_rows_that_cannot_be_rebuilt() {
    // 用户拍板：会话文件消失后用量留作历史账；表版本升级时只清能从文件重抽的行
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    conn.execute_batch(
        "INSERT INTO usage_daily(day, agent, model, project_path, session_id, input, output, cache_read, cache_write, source, internal, workspace, official)
               VALUES('2026-08-01','claude-code','m','/p','alive',1,1,0,0,'cli',0,'',0),
                     ('2026-08-01','claude-code','m','/p','gone',2,2,0,0,'cli',0,'',0),
                     ('2026-10-17','codex','m','/tmp/ccode-ai-x','ephemeral-r1',3,3,0,0,'ccode-ai',1,'',0);
             INSERT INTO usage_meta(key, value) VALUES('seen:claude-code:alive:live','t');
             UPDATE usage_meta SET value='6' WHERE key='schema_version';",
    )
    .unwrap();
    ensure_usage_schema(&conn).unwrap();
    let mut ids: Vec<String> = conn
        .prepare("SELECT session_id FROM usage_daily ORDER BY session_id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .flatten()
        .collect();
    ids.sort();
    assert_eq!(ids, vec!["ephemeral-r1".to_string(), "gone".to_string()]);
}

#[test]
fn usage_schema_migration_resets_unclassified_index() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE usage_daily(
               day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
               input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
               PRIMARY KEY(day, agent, model, project_path, session_id));
             CREATE TABLE usage_meta(key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO usage_daily VALUES('2026-08-01','codex','gpt-5','/tmp/manual','s1',1,1,0,0);
             INSERT INTO usage_meta VALUES('initialized','old'),('seen:codex:s1','old');",
    )
    .unwrap();
    ensure_usage_schema(&conn).unwrap();
    let columns = usage_columns(&conn).unwrap();
    assert!(columns.contains("source"));
    assert!(columns.contains("internal"));
    assert!(columns.contains("workspace"), "v5 起补工作区归因列");
    assert!(columns.contains("official"), "v6 起补官方账号标记列");
    assert!(
        table_columns(&conn, "usage_provenance")
            .unwrap()
            .contains("session_id"),
        "v7 起来源登记补会话级列"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM usage_daily", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0,
        "没有来源证据的旧索引必须重建"
    );
    assert_eq!(
        meta_get(&conn, "schema_version").as_deref(),
        Some(USAGE_SCHEMA_VERSION)
    );
    assert!(meta_get(&conn, "initialized").is_none());
}

#[test]
fn usage_schema_v8_reindexes_grok_only() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE usage_daily(
               day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
               input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
               source TEXT, internal INTEGER, workspace TEXT, official INTEGER,
               PRIMARY KEY(day, agent, model, project_path, session_id));
             CREATE TABLE usage_meta(key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE usage_provenance(
               agent TEXT NOT NULL, project_path TEXT NOT NULL,
               session_id TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
               official INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL,
               PRIMARY KEY(agent, project_path, session_id));
             INSERT INTO usage_daily VALUES
               ('2026-09-21','claude-code','opus','/repo','s-claude',10,2,0,0,'cli',0,'',0),
               ('2026-09-21','codex','gpt-5','/repo','s-codex',10,2,0,0,'cli',0,'',0),
               ('2026-09-21','grok','grok-4','/repo','s-grok',0,0,0,0,'cli',0,'',0);
             INSERT INTO usage_meta VALUES
               ('schema_version','7'),
               ('initialized','old'),
               ('seen:claude-code:s-claude:live','old'),
               ('seen:codex:s-codex:live','old'),
               ('seen:grok:s-grok:live','old');",
    )
    .unwrap();
    ensure_usage_schema(&conn).unwrap();
    assert_eq!(
        meta_get(&conn, "schema_version").as_deref(),
        Some(USAGE_SCHEMA_VERSION)
    );
    assert!(meta_get(&conn, "initialized").is_none());
    // v7 直升 v10：Grok（v8）、Codex（v9）、Claude（v10）都重抽
    assert!(meta_get(&conn, "seen:claude-code:s-claude:live").is_none());
    assert!(meta_get(&conn, "seen:codex:s-codex:live").is_none());
    assert!(meta_get(&conn, "seen:grok:s-grok:live").is_none());
    let agents: Vec<String> = conn
        .prepare("SELECT agent FROM usage_daily ORDER BY agent")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(agents.is_empty());
}

#[test]
fn usage_schema_v9_reindexes_cache_inclusive_agents_only() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE usage_daily(
               day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
               input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
               source TEXT, internal INTEGER, workspace TEXT, official INTEGER,
               PRIMARY KEY(day, agent, model, project_path, session_id));
             CREATE TABLE usage_meta(key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE usage_provenance(
               agent TEXT NOT NULL, project_path TEXT NOT NULL,
               session_id TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
               official INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL,
               PRIMARY KEY(agent, project_path, session_id));
             INSERT INTO usage_daily VALUES
               ('2026-10-21','claude-code','opus','/repo','s-claude',10,2,0,0,'cli',0,'',0),
               ('2026-10-21','codex','gpt-5','/repo','s-codex',10,2,4,0,'cli',0,'',0),
               ('2026-10-01','codex','gpt-5','/repo','s-gone',10,2,4,0,'cli',0,'',0),
               ('2026-10-21','qwen','qwen3','/repo','s-qwen',10,2,4,0,'cli',0,'',0),
               ('2026-10-21','grok','grok-4','/repo','s-grok',10,2,0,0,'cli',0,'',0);
             INSERT INTO usage_meta VALUES
               ('schema_version','8'),
               ('initialized','old'),
               ('seen:claude-code:s-claude:live','old'),
               ('seen:codex:s-codex:live','old'),
               ('seen:qwen:s-qwen','old'),
               ('seen:grok:s-grok:live','old');",
    )
    .unwrap();
    ensure_usage_schema(&conn).unwrap();
    assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some(USAGE_SCHEMA_VERSION));
    assert!(meta_get(&conn, "initialized").is_none());
    assert!(meta_get(&conn, "seen:codex:s-codex:live").is_none());
    assert!(meta_get(&conn, "seen:qwen:s-qwen").is_none());
    assert!(meta_get(&conn, "seen:claude-code:s-claude:live").is_none(), "v8 直升 v10 连 Claude 一起重抽");
    assert_eq!(meta_get(&conn, "seen:grok:s-grok:live").as_deref(), Some("old"));
    let left: Vec<String> = conn
        .prepare("SELECT agent || ':' || session_id FROM usage_daily ORDER BY 1")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    // 能重抽的几家行清掉；文件已不在（无 seen）的 Codex 行重抽不回来，留着
    assert_eq!(left, vec!["codex:s-gone", "grok:s-grok"]);
}

#[test]
fn usage_schema_v10_reindexes_claude_only() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE usage_daily(
               day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
               input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
               source TEXT, internal INTEGER, workspace TEXT, official INTEGER,
               PRIMARY KEY(day, agent, model, project_path, session_id));
             CREATE TABLE usage_meta(key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE usage_provenance(
               agent TEXT NOT NULL, project_path TEXT NOT NULL,
               session_id TEXT NOT NULL DEFAULT '',
               source TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
               official INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL,
               PRIMARY KEY(agent, project_path, session_id));
             INSERT INTO usage_daily VALUES
               ('2026-10-30','claude-code','opus','/repo','s-claude',10,2,0,0,'cli',0,'',0),
               ('2026-09-01','claude-code','opus','/repo','s-old',10,2,0,0,'cli',0,'',0),
               ('2026-10-30','claude-code','opus','/repo','ephemeral-x',10,2,0,0,'ccode-ai',1,'',0),
               ('2026-10-30','codex','gpt-5','/repo','s-codex',10,2,4,0,'cli',0,'',0);
             INSERT INTO usage_meta VALUES
               ('schema_version','9'),
               ('initialized','old'),
               ('seen:claude-code:s-claude:live','old'),
               ('seen:codex:s-codex:live','old');",
    )
    .unwrap();
    ensure_usage_schema(&conn).unwrap();
    assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some(USAGE_SCHEMA_VERSION));
    assert!(meta_get(&conn, "seen:claude-code:s-claude:live").is_none());
    assert_eq!(meta_get(&conn, "seen:codex:s-codex:live").as_deref(), Some("old"));
    let left: Vec<String> = conn
        .prepare("SELECT agent || ':' || session_id FROM usage_daily ORDER BY 1")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    // 文件已被清掉的旧行、不落盘的一次性调用行重抽不回来，留着；别家不动
    assert_eq!(left, vec!["claude-code:ephemeral-x", "claude-code:s-old", "codex:s-codex"]);
}

#[test]
fn claude_reply_split_into_blocks_counts_once() {
    let line = |id: &str, block: &str, u: &str| {
        format!(
            r#"{{"type":"assistant","sessionId":"me","timestamp":"2026-10-30T01:00:00Z","message":{{"id":"{id}","model":"m","content":[{{"type":"{block}"}}],"usage":{u}}}}}"#
        )
    };
    let full = r#"{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":300,"cache_creation_input_tokens":20}"#;
    let zero = r#"{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}"#;
    let lines = vec![
        line("msg_a", "thinking", full),
        line("msg_a", "text", full),
        line("msg_a", "tool_use", full),
        // 偶见：头一行全 0 占位，后一行才是真数
        line("msg_b", "thinking", zero),
        line("msg_b", "text", full),
    ];
    let evs = claude_events(&lines, Some("me"));
    assert_eq!(evs.len(), 2, "一次回复只算一次");
    for ev in &evs {
        assert_eq!((ev.input, ev.output, ev.cache_read, ev.cache_write), (10, 5, 300, 20));
    }
}

#[test]
fn cache_inclusive_inputs_are_split_on_ingest() {
    assert_eq!(uncached_input(100, 30, 0), 70);
    assert_eq!(uncached_input(100, 30, 10), 60);
    assert_eq!(uncached_input(20, 30, 0), 20, "缓存比输入还大：字段口径对不上，原样返回");
    // Codex 实机：total_tokens = input + output（缓存含在输入里、推理含在输出里）
    let lines = vec![r#"{"timestamp":"2026-10-22T00:05:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":82770,"cached_input_tokens":34240,"cache_write_input_tokens":0,"output_tokens":356,"reasoning_output_tokens":265,"total_tokens":83126}}}}"#.to_string()];
    let ev = &codex_events(&lines)[0];
    assert_eq!((ev.input, ev.output, ev.cache_read), (48530, 356, 34240));
    // Qwen 实机：totalTokenCount = prompt + candidates
    let q = vec![r#"{"timestamp":"2026-10-22T00:05:00Z","model":"qwen3","usageMetadata":{"promptTokenCount":20911,"cachedContentTokenCount":1152,"candidatesTokenCount":1287,"totalTokenCount":22198,"thoughtsTokenCount":0}}"#.to_string()];
    let qv = &qwen_events(&q)[0];
    assert_eq!((qv.input, qv.output, qv.cache_read), (19759, 1287, 1152));
}

/// 旧的纯路径查询形态：无会话 id、无创建时间、无会话级标记（等价 v7 前行为）
fn prov(conn: &Connection, agent: &str, project_path: &str) -> (String, bool, bool) {
    session_provenance(conn, agent, project_path, "", None, false, false)
}

#[test]
fn internal_provenance_is_exact_not_tmp_path_heuristic() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    register_provenance_impl(
        &conn,
        "codex",
        "/private/tmp/ccode-ai-known",
        "",
        SOURCE_CCODE_AI,
        true,
        false,
    )
    .unwrap();
    assert_eq!(
        prov(&conn, "codex", "/private/tmp/ccode-ai-known"),
        (SOURCE_CCODE_AI.into(), true, false)
    );
    assert_eq!(
        prov(&conn, "codex", "/tmp/user-task"),
        (SOURCE_CLI.into(), false, false),
        "用户主动在 /tmp 运行不得被判成内部活动"
    );
    assert_eq!(
        prov(&conn, "codex", "/tmp/ccode-ai-unregistered"),
        (SOURCE_CLI.into(), false, false),
        "仅路径长得像 Mesa 临时任务也不是来源证据"
    );
    assert_eq!(
        prov(&conn, "claude-code", "/private/tmp/ccode-ai-known"),
        (SOURCE_CLI.into(), false, false),
        "来源登记同时绑定 agent"
    );
    #[cfg(target_os = "macos")]
    {
        register_provenance_impl(
            &conn,
            "kimi",
            "/var/folders/test/ccode-ai-canonical",
            "",
            SOURCE_CCODE_AI,
            true,
            false,
        )
        .unwrap();
        assert_eq!(
            prov(
                &conn,
                "kimi",
                "/private/var/folders/test/ccode-ai-canonical"
            ),
            (SOURCE_CCODE_AI.into(), true, false),
            "macOS 临时目录别名只做路径归一化，不影响来源判定"
        );
    }
}

#[test]
fn provenance_migration_adds_session_column_and_keeps_rows() {
    // v6 旧表（无 session_id、主键 agent+project_path）整表重建迁移：旧行保留为项目级登记
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE usage_daily(day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
               input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
               PRIMARY KEY(day, agent, model, project_path, session_id));
             CREATE TABLE usage_meta(key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE usage_provenance(
               agent TEXT NOT NULL, project_path TEXT NOT NULL,
               source TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
               official INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL,
               PRIMARY KEY(agent, project_path));
             INSERT INTO usage_provenance VALUES('codex','/home/u/proj','cli',0,1,'2026-09-01T00:00:00Z');",
    )
    .unwrap();
    ensure_usage_schema(&conn).unwrap();
    assert!(table_columns(&conn, "usage_provenance")
        .unwrap()
        .contains("session_id"));
    let (sid, official, created): (String, i64, String) = conn
        .query_row(
            "SELECT session_id, official, created_at FROM usage_provenance WHERE agent='codex'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(sid, "", "旧行迁移为项目级登记（session_id=''），历史不丢");
    assert_eq!(official, 1);
    assert_eq!(
        created, "2026-09-01T00:00:00Z",
        "登记时间保留，供旧行命中口径使用"
    );
    // 新主键允许同项目并存项目级旧行与会话级新行
    register_provenance_impl(
        &conn,
        "codex",
        "/home/u/proj",
        "sess-1",
        SOURCE_CLI,
        false,
        true,
    )
    .unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM usage_provenance WHERE agent='codex'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 2);
}

#[test]
fn cards_cost_excludes_official_and_internal_tokens_counted_separately() {
    let table = load_pricing(None);
    let mut rows: Vec<StoredUsageRow> = vec![
        ws_row("/p", "s1", "gpt-5", 1_000_000, 100_000, false, ""),
        ws_row("/p", "s3", "gpt-5", 400_000, 40_000, true, ""),
    ];
    {
        let mut official = ws_row("/p", "s2", "gpt-5", 200_000, 20_000, false, "");
        official.12 = true;
        rows.push(official);
    }
    {
        // 纯官方用量的另一天：当天无可计费行，费用记 0 而非 ~
        let mut only_official = ws_row("/p", "s4", "gpt-5", 10, 10, false, "");
        only_official.0 = "2026-08-02".into();
        only_official.12 = true;
        rows.push(only_official);
    }
    let stats = build_stats(rows, &table, 7.2);
    // gpt-5：1M 输入 ×1.25 + 0.1M 输出 ×10 = 2.25，只有 s1 进计费范围
    let expect = 1.25 + 1.0;
    assert!(
        (stats.cards.cost_usd.unwrap() - expect).abs() < 1e-9,
        "总费用与趋势/榜单同一计费范围：官方账号与内部活动不计费"
    );
    assert!(!stats.cards.cost_partial);
    assert_eq!(stats.cards.input, 1_600_010, "token 总量仍是全部真实用量");
    assert_eq!(stats.cards.output, 160_010);
    assert_eq!(stats.cards.official_tokens, 220_020, "官方用量单列展示");
    assert_eq!(stats.cards.internal_tokens, 440_000, "内部用量单列展示");
    let day1 = stats.daily.iter().find(|d| d.day == "2026-08-01").unwrap();
    assert_eq!(day1.input, 1_600_000, "按天 token 含全部用量");
    assert!(
        (day1.cost_usd.unwrap() - expect).abs() < 1e-9,
        "按天费用同样只含可计费范围"
    );
    let day2 = stats.daily.iter().find(|d| d.day == "2026-08-02").unwrap();
    assert_eq!(
        day2.cost_usd,
        Some(0.0),
        "纯订阅的一天费用记 0（同 usage_trend 口径）"
    );
}

#[test]
fn session_meta_internal_marks_usage_per_session() {
    // 定时巡检/雷达解读按会话 id 写 session_meta.internal，用量索引必须采用：
    // 同项目其它会话不受影响，也无需写入项目级 provenance
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    conn.execute_batch(
        "CREATE TABLE session_meta(agent TEXT, session_id TEXT, internal INTEGER NOT NULL DEFAULT 0, profile_id TEXT);
             INSERT INTO session_meta VALUES('codex', 'watch-1', 1, NULL),
                                            ('codex', 'interactive-1', 0, 'p1');",
    )
    .unwrap();
    let flags = session_meta_flags(&conn);
    let (internal, _) = flags
        .get(&("codex".to_string(), "watch-1".to_string()))
        .cloned()
        .unwrap_or((false, None));
    assert!(internal, "会话级 internal 登记必须被读到");
    assert_eq!(
        session_provenance(
            &conn,
            "codex",
            "/home/u/proj",
            "watch-1",
            None,
            internal,
            false
        ),
        (SOURCE_CCODE_AI.into(), true, false),
        "定时会话按 session 级标记归入内部活动"
    );
    assert_eq!(
        session_provenance(
            &conn,
            "codex",
            "/home/u/proj",
            "interactive-1",
            None,
            false,
            false
        ),
        (SOURCE_CLI.into(), false, false),
        "同项目的交互会话不被误标"
    );
    // meta_official 通道：会话档案的 profile 是官方账号 → official（internal 优先于它）
    assert_eq!(
        session_provenance(&conn, "codex", "/home/u/proj", "s-off", None, false, true),
        (SOURCE_CLI.into(), false, true)
    );
    assert_eq!(
        session_provenance(&conn, "codex", "/home/u/proj", "s-both", None, true, true),
        (SOURCE_CCODE_AI.into(), true, false),
        "internal 优先于 official"
    );
}

#[test]
fn kimi_alias_falls_back_to_launch_model() {
    // Kimi 2.6 起会话文件不写 llm.request：Mesa 开的会话只剩合成别名，建索引时换成启动记下的模型
    let conn = Connection::open_in_memory().unwrap();
    assert!(kimi_launch_models(&conn).is_empty(), "没有 session_meta 表按空处理");
    conn.execute_batch(
        "CREATE TABLE session_meta(agent TEXT, session_id TEXT, launch_model TEXT);
         INSERT INTO session_meta VALUES('kimi', 'k1', 'glm-5.3'), ('kimi', 'k2', ''), ('codex', 'c1', 'gpt-5.5');",
    )
    .unwrap();
    let models = kimi_launch_models(&conn);
    assert_eq!(models.len(), 1, "只认 Kimi 且记下了模型的会话");
    let lines = vec![
        r#"{"type":"usage.record","model":"__kimi_env_model__","usage":{"inputOther":5,"output":1},"time":1785307071000}"#.to_string(),
        r#"{"type":"usage.record","model":"kimi-k2","usage":{"inputOther":5,"output":1},"time":1785307072000}"#.to_string(),
    ];
    let mut evs = kimi_events(&lines);
    fill_kimi_launch_model(&mut evs, models.get("k1"));
    assert_eq!(evs[0].model, "glm-5.3");
    assert_eq!(evs[1].model, "kimi-k2", "文件里本来就是真名的不动");
    let mut evs = kimi_events(&lines);
    fill_kimi_launch_model(&mut evs, models.get("k2"));
    assert_eq!(evs[0].model, "__kimi_env_model__", "启动时没记下模型的保持原样");
}

#[test]
fn schema_v12_upgrade_only_resets_kimi() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    conn.execute_batch(
        "INSERT INTO usage_daily(day, agent, model, project_path, session_id, input, output, cache_read, cache_write, cache_write_1h, source, internal, workspace, official) VALUES
           ('2026-11-12','kimi','__kimi_env_model__','/repo','s-kimi',10,2,0,0,0,'cli',0,'',0),
           ('2026-09-01','kimi','__kimi_env_model__','/repo','s-gone',10,2,0,0,0,'cli',0,'',0),
           ('2026-11-12','codex','gpt-5','/repo','s-codex',10,2,0,0,0,'cli',0,'',0);
         INSERT INTO usage_meta VALUES ('seen:kimi:s-kimi:live','old'), ('seen:codex:s-codex:live','old');
         UPDATE usage_meta SET value='12' WHERE key='schema_version';",
    )
    .unwrap();
    ensure_usage_schema(&conn).unwrap();
    assert_eq!(meta_get(&conn, "schema_version").as_deref(), Some(USAGE_SCHEMA_VERSION));
    assert!(meta_get(&conn, "seen:kimi:s-kimi:live").is_none());
    assert_eq!(meta_get(&conn, "seen:codex:s-codex:live").as_deref(), Some("old"));
    let left: Vec<String> = conn
        .prepare("SELECT agent || ':' || session_id FROM usage_daily ORDER BY 1")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    // 文件已不在的旧行重抽不回来，留着（用量历史永久保留）
    assert_eq!(left, vec!["codex:s-codex", "kimi:s-gone"]);
}

#[test]
fn official_provenance_session_grained_and_legacy_cutoff() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    // 会话级登记（v7 新口径）：命中只认 session_id，不看项目路径
    register_provenance_impl(
        &conn,
        "gemini",
        "/home/u/proj",
        "sess-official",
        SOURCE_CLI,
        false,
        true,
    )
    .unwrap();
    assert_eq!(
        session_provenance(
            &conn,
            "gemini",
            "/home/u/proj",
            "sess-official",
            None,
            false,
            false
        ),
        (SOURCE_CLI.into(), false, true),
        "会话级官方登记命中"
    );
    assert_eq!(
        session_provenance(
            &conn,
            "gemini",
            "/home/u/proj",
            "sess-api",
            None,
            false,
            false
        ),
        (SOURCE_CLI.into(), false, false),
        "同项目后来的 API 会话不再被官方登记粘住"
    );
    // 项目级旧行（v7 前登记，session_id=''）：只回填登记时刻已存在的会话
    conn.execute(
        "INSERT INTO usage_provenance(agent, project_path, session_id, source, internal, official, created_at)
             VALUES('codex', '/home/u/legacy', '', 'cli', 0, 1, '2026-09-01T00:00:00Z')",
        [],
    )
    .unwrap();
    assert_eq!(
        session_provenance(
            &conn,
            "codex",
            "/home/u/legacy",
            "s-old",
            Some("2026-08-20T10:00:00Z"),
            false,
            false,
        ),
        (SOURCE_CLI.into(), false, true),
        "登记时刻之前的旧会话保持历史标记"
    );
    assert_eq!(
        session_provenance(
            &conn,
            "codex",
            "/home/u/legacy",
            "s-new",
            Some("2026-09-05T10:00:00Z"),
            false,
            false,
        ),
        (SOURCE_CLI.into(), false, false),
        "登记之后新建的会话按新口径判定，旧登记不粘住新会话"
    );
    assert_eq!(
        session_provenance(
            &conn,
            "codex",
            "/home/u/legacy",
            "s-unknown",
            None,
            false,
            false
        ),
        (SOURCE_CLI.into(), false, true),
        "创建时间缺失的旧会话按旧行为保留标记（历史不丢）"
    );
}

#[test]
fn official_provenance_marks_rows_and_splits_cost_buckets() {
    // 项目级旧登记（v7 前行）+ 创建时间缺失的会话 → 保持历史 official 标记；
    // 新登记走会话级（见 official_provenance_session_grained_and_legacy_cutoff）
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    register_provenance_impl(&conn, "gemini", "/home/u/proj", "", SOURCE_CLI, false, true)
        .unwrap();
    assert_eq!(
        prov(&conn, "gemini", "/home/u/proj"),
        (SOURCE_CLI.into(), false, true),
        "官方账号登记：source 保持 cli，只标 official"
    );
    assert_eq!(
        prov(&conn, "gemini", "/home/u/other"),
        (SOURCE_CLI.into(), false, false),
        "未登记的项目不受影响"
    );
    assert_eq!(
        prov(&conn, "codex", "/home/u/proj"),
        (SOURCE_CLI.into(), false, false),
        "official 登记同样绑定 agent"
    );
    // 同一 agent 下 official 与普通用量在 agent/项目/工作区维度分桶，费用互不染指
    let rows: Vec<StoredUsageRow> = vec![
        ws_row("/home/u/proj", "s1", "gemini-3-pro", 100, 10, false, ""),
        {
            let mut r = ws_row("/home/u/proj", "s2", "gemini-3-pro", 50, 5, false, "");
            r.12 = true;
            r
        },
        {
            let mut r = ws_row("/home/u/proj", "s3", "gemini-3-pro", 20, 2, false, "task-x");
            r.12 = true;
            r
        },
    ];
    let stats = build_stats(rows, &load_pricing(None), 7.2);
    let official_agent = stats.by_agent.iter().find(|a| a.official).unwrap();
    let normal_agent = stats.by_agent.iter().find(|a| !a.official).unwrap();
    assert_eq!(official_agent.tokens, 50 + 5 + 20 + 2);
    assert_eq!(normal_agent.tokens, 110);
    assert!(normal_agent.cost_usd.is_some(), "普通行仍按官方价估算");
    let official_project = stats.by_project.iter().find(|p| p.official).unwrap();
    assert_eq!(official_project.sessions, 2);
    assert!(stats.by_project.iter().any(|p| !p.official));
    let official_ws = stats.by_workspace.iter().find(|w| w.official).unwrap();
    assert_eq!(official_ws.workspace_name, "task-x");
    assert_eq!(official_ws.tokens_in + official_ws.tokens_out, 22);
}

#[test]
fn session_usage_aggregates_per_session_with_pricing() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    let mut ins = |session: &str, model: &str, i: i64, o: i64, cr: i64, cw: i64| {
        conn.execute(
            "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
                 input, output, cache_read, cache_write) VALUES ('2026-08-17','claude-code',?1,'/p',?2,?3,?4,?5,?6)",
            rusqlite::params![model, session, i, o, cr, cw],
        )
        .unwrap();
    };
    ins("s1", "claude-sonnet-4", 1_000_000, 100_000, 0, 0);
    ins("s1", "gpt-5", 500_000, 50_000, 100_000, 0); // 同会话多模型分组计价
    ins("s1", "unknown-model-x", 10_000, 5_000, 0, 0); // 未命中定价表不计费
    ins("s2", "claude-sonnet-4", 9_999, 1, 0, 0); // 别的会话不混入
    let dto = session_usage_from(&conn, "claude-code", "s1").unwrap();
    assert_eq!(dto.input, 1_510_000);
    assert_eq!(dto.output, 155_000);
    assert_eq!((dto.cache_read, dto.cache_write), (100_000, 0), "缓存单独给出，状态栏合计要算上");
    assert!(dto.priced);
    // sonnet: 1M×3 + 0.1M×15 = 4.5；gpt-5: 0.5M×1.25 + 0.05M×10 + 0.1M×1.25×0.1 = 1.1375
    let expect = 4.5 + 1.1375;
    assert!((dto.cost_usd - expect).abs() < 1e-9, "{}", dto.cost_usd);
    // 未命中定价表时 priced=false（前端只显示 token）
    let dto2 = session_usage_from(&conn, "claude-code", "s-none").unwrap();
    assert_eq!(dto2.input, 0);
    assert!(!dto2.priced);
}

#[test]
fn prune_stale_provenance_keeps_internal_ai_rows() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    let tmp = normalize_provenance_path(&std::env::temp_dir().to_string_lossy());
    let internal_old = format!("{tmp}/ccode-ai-{}", uuid::Uuid::new_v4());
    let cli_old = format!("{tmp}/ccode-prune-cli-{}", uuid::Uuid::new_v4());
    let old = "2020-01-01T00:00:00Z";
    conn.execute(
        "INSERT INTO usage_provenance(agent, project_path, source, internal, created_at)
             VALUES('kimi', ?1, ?2, 1, ?3)",
        params![internal_old.as_str(), SOURCE_CCODE_AI, old],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO usage_provenance(agent, project_path, source, internal, created_at)
             VALUES('kimi', ?1, 'cli', 0, ?2)",
        params![cli_old.as_str(), old],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO usage_provenance(agent, project_path, source, internal, created_at)
             VALUES('kimi', '/ccode-test-real-project', 'cli', 0, ?1)",
        params![old],
    )
    .unwrap();
    prune_stale_provenance(&conn);
    let mut rows: Vec<String> = conn
        .prepare("SELECT project_path FROM usage_provenance")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .flatten()
        .collect();
    rows.sort();
    let mut expected = vec!["/ccode-test-real-project".to_string(), internal_old];
    expected.sort();
    assert_eq!(
        rows, expected,
        "内部 AI 登记保留；非内部且 tmp 下已消失的老行仍清"
    );
}

#[test]
fn ccode_ai_temp_cwd_only_matches_uuid_dir_name() {
    assert!(is_ccode_ai_temp_cwd(
        "/var/folders/xx/T/ccode-ai-2666326a-de4f-48c0-92aa-1979d2e1abcd"
    ));
    assert!(is_ccode_ai_temp_cwd(
        "C:\\Users\\me\\AppData\\Local\\Temp\\ccode-ai-2666326a-de4f-48c0-92aa-1979d2e1abcd"
    ));
    assert!(!is_ccode_ai_temp_cwd("/tmp/ccode-ai-not-a-uuid"));
    assert!(!is_ccode_ai_temp_cwd("/Users/me/Ccode"));
    assert!(!is_ccode_ai_temp_cwd("/tmp/user-task"));
}

#[test]
fn watch_worktree_cwd_only_matches_under_mesa_root() {
    let home = crate::dirs::home_dir().expect("测试机必有 home");
    let inside = home.join("ccode/watch-worktrees/测试项目/f4334054-d77e-4c11-ab56-22bb11a2a83f");
    assert!(is_watch_worktree_cwd(&inside.to_string_lossy()));
    // 根目录本身也命中：与 list_repos 的排除口径（== 或前缀 /）一致
    let root = home.join("ccode/watch-worktrees");
    assert!(is_watch_worktree_cwd(&root.to_string_lossy()));
    // 兄弟目录不算：工作区 worktree 与真实项目仓库不受影响
    assert!(!is_watch_worktree_cwd(
        &home.join("ccode/workspaces/测试项目/lit-search").to_string_lossy()
    ));
    assert!(!is_watch_worktree_cwd(
        &home.join("Desktop/测试项目").to_string_lossy()
    ));
    // 相近前缀不误伤：只是开头同名的目录
    assert!(!is_watch_worktree_cwd(
        &home.join("ccode/watch-worktrees-别家").to_string_lossy()
    ));
    assert!(!is_watch_worktree_cwd(""));
}

#[test]
fn stats_keep_internal_dimension_for_same_model() {
    let rows: Vec<StoredUsageRow> = vec![
        (
            "2026-08-01".into(),
            "codex".into(),
            "gpt-5-codex".into(),
            "/tmp/user-task".into(),
            "normal".into(),
            100,
            10,
            0,
            0,
            SOURCE_CLI.into(),
            false,
            String::new(),
            false,
            0,
        ),
        (
            "2026-08-01".into(),
            "codex".into(),
            "gpt-5-codex".into(),
            "/private/tmp/ccode-ai-known".into(),
            "internal".into(),
            20,
            5,
            0,
            0,
            SOURCE_CCODE_AI.into(),
            true,
            String::new(),
            false,
            0,
        ),
    ];
    let stats = build_stats(rows, &load_pricing(None), 7.2);
    assert_eq!(stats.by_project.len(), 2);
    assert!(stats
        .by_project
        .iter()
        .any(|row| row.project_path == "/tmp/user-task"
            && !row.internal
            && row.source == SOURCE_CLI));
    assert!(stats
        .by_project
        .iter()
        .any(|row| row.internal && row.source == SOURCE_CCODE_AI));
    assert_eq!(
        stats.by_model.len(),
        2,
        "相同模型的普通与内部用量不得混成一行"
    );
    assert!(stats.by_model.iter().any(|row| !row.internal));
    assert!(stats.by_model.iter().any(|row| row.internal));
}

/// 造一行 StoredUsageRow（official 默认 false，workspace 之外参数从简）
fn ws_row(
    project: &str,
    sid: &str,
    model: &str,
    input: i64,
    output: i64,
    internal: bool,
    workspace: &str,
) -> StoredUsageRow {
    (
        "2026-08-01".into(),
        "codex".into(),
        model.into(),
        project.into(),
        sid.into(),
        input,
        output,
        0,
        0,
        SOURCE_CLI.into(),
        internal,
        workspace.into(),
        false,
        0,
    )
}

#[test]
fn workspace_attribution_groups_and_keeps_project_dimension() {
    let rows: Vec<StoredUsageRow> = vec![
        // 工作区会话（扫描已把项目路径改写为真实仓库，workspace 列记工作区名）
        ws_row(
            "/home/u/code/myrepo",
            "s1",
            "gpt-5",
            100,
            10,
            false,
            "feat-x",
        ),
        ws_row("/home/u/code/myrepo", "s2", "gpt-5", 50, 5, false, "feat-x"),
        // 同名工作区在另一个仓库下：各自成行
        ws_row("/home/u/code/other", "s3", "gpt-5", 30, 3, false, "feat-x"),
        // 主仓库 / 非工作区会话：不进 by_workspace，项目维度不受影响
        ws_row("/home/u/code/myrepo", "s4", "gpt-5", 7, 1, false, ""),
        ws_row("/elsewhere", "s5", "gpt-5", 9, 1, false, ""),
    ];
    let stats = build_stats(rows, &load_pricing(None), 7.2);
    assert_eq!(stats.by_workspace.len(), 2, "同名不同仓库的工作区不得合并");
    let feat_myrepo = stats
        .by_workspace
        .iter()
        .find(|r| r.repo_name == "myrepo")
        .unwrap();
    assert_eq!(feat_myrepo.workspace_name, "feat-x");
    assert_eq!((feat_myrepo.tokens_in, feat_myrepo.tokens_out), (150, 15));
    assert_eq!(feat_myrepo.models, 1);
    assert!(feat_myrepo.cost.is_some(), "gpt-5 官方价应可估算");
    assert!(!feat_myrepo.cost_partial);
    assert!(!feat_myrepo.internal);
    assert!(stats
        .by_workspace
        .iter()
        .all(|r| !r.workspace_name.is_empty()));
    // 项目维度保持原样：工作区用量仍计入所属仓库项目行
    let proj = stats
        .by_project
        .iter()
        .find(|p| p.project_path == "/home/u/code/myrepo")
        .unwrap();
    assert_eq!(proj.tokens, 150 + 15 + 7 + 1);
}

#[test]
fn workspace_rows_sorted_by_tokens_and_partial_cost() {
    let rows: Vec<StoredUsageRow> = vec![
        ws_row("/r/a", "s1", "mystery-model", 10, 10, false, "small"),
        ws_row("/r/a", "s2", "gpt-5", 1_000_000, 1_000_000, false, "big"),
        ws_row("/r/a", "s3", "mystery-model", 5, 5, false, "big"),
        // 内部来源落在工作区时与普通行分桶，开关口径与项目排行一致
        ws_row("/r/a", "s4", "gpt-5", 60, 6, true, "big"),
    ];
    let stats = build_stats(rows, &load_pricing(None), 7.2);
    assert_eq!(stats.by_workspace.len(), 3);
    assert_eq!(stats.by_workspace[0].workspace_name, "big", "按 token 降序");
    assert!(!stats.by_workspace[0].internal);
    let big = &stats.by_workspace[0];
    assert!(big.cost.is_some(), "只累加已计价份额");
    assert!(big.cost_partial, "混有不明价模型必须标记 ≥");
    assert_eq!(big.models, 2);
    let big_internal = stats
        .by_workspace
        .iter()
        .find(|r| r.workspace_name == "big" && r.internal)
        .unwrap();
    assert!(!big_internal.cost_partial);
    let small = stats
        .by_workspace
        .iter()
        .find(|r| r.workspace_name == "small")
        .unwrap();
    assert_eq!(small.cost, None, "全部不明价 → 费用 None（前端显示 ~）");
    assert!(small.cost_partial);
}

#[test]
fn pricing_longest_prefix_and_unknown() {
    let table = load_pricing(None);
    assert_eq!(price_of("gpt-5-codex-mini", &table), Some((1.25, 10.0)));
    assert_eq!(
        price_of("claude-sonnet-4-5", &table),
        Some((3.0, 15.0)),
        "旧代 Sonnet 4.x 价"
    );
    assert_eq!(
        price_of("claude-sonnet-5", &table),
        Some((2.0, 10.0)),
        "Sonnet 5 起降价"
    );
    assert_eq!(
        price_of("claude-opus-4-1-20250805", &table),
        Some((15.0, 75.0)),
        "仅 Opus 4.1 为旧高价"
    );
    assert_eq!(price_of("claude-opus-5", &table), Some((5.0, 25.0)));
    assert_eq!(price_of("some-relay-model", &table), None);
    assert_eq!(price_of("", &table), None, "未知模型无价格");
    // 扩充的中转/聚合模型走官方价
    assert_eq!(
        price_of("grok-4.5", &table),
        Some((2.0, 6.0)),
        "grok-4.5 新代价，不再落 grok-4 旧价"
    );
    assert_eq!(
        price_of("grok-4-0709", &table),
        Some((3.0, 15.0)),
        "初代 grok-4 保留旧价"
    );
    assert_eq!(
        price_of("grok-4.1-fast-mini", &table),
        Some((0.2, 0.5)),
        "更长前缀优先于 grok-4"
    );
    assert_eq!(price_of("grok-3-mini-128k", &table), Some((0.3, 0.5)));
    assert_eq!(price_of("grok-code-fast-1", &table), Some((0.2, 1.5)));
    assert_eq!(price_of("glm-4.6-air", &table), Some((0.6, 2.2)));
    assert_eq!(
        price_of("glm-5.2", &table),
        Some((1.4, 4.4)),
        "glm-5 新代官方价已出"
    );
    assert_eq!(
        price_of("qwen3-coder-plus", &table),
        Some((1.0, 5.0)),
        "qwen3-coder 优先于 qwen3"
    );
    assert_eq!(price_of("qwen3-max", &table), Some((1.2, 6.0)));
    assert_eq!(price_of("moonshot-v1-8k", &table), Some((0.6, 3.0)));
    assert_eq!(price_of("gemini-3-pro-preview", &table), Some((2.0, 12.0)));
    assert_eq!(
        price_of("gemini-3.6-flash-lite", &table),
        Some((0.75, 3.75)),
        "3.6-flash 推广价"
    );
    assert_eq!(
        price_of("gemini-2.5-pro", &table),
        Some((1.25, 10.0)),
        "旧条目保留"
    );
    // 新代条目
    assert_eq!(price_of("claude-fable-2", &table), Some((10.0, 50.0)));
    assert_eq!(price_of("gemini-3.5-flash-tts", &table), Some((1.5, 9.0)));
    assert_eq!(
        price_of("gemini-3.1-pro-preview", &table),
        Some((2.0, 12.0))
    );
    assert_eq!(price_of("kimi-k2.6", &table), Some((0.95, 4.0)));
    assert_eq!(price_of("deepseek-v4-pro-0813", &table), Some((1.32, 3.96)));
}

#[test]
fn pricing_layer_precedence_high_layer_wins() {
    // 层序契约：高层任意前缀命中即胜（用户写短前缀即覆盖低层长前缀旧价）；
    // 同层内最长前缀优先
    let chain: PriceChain = [
        price_layer(vec![("m-x".into(), (1.0, 1.0)), ("m-y-pro".into(), (1.0, 1.0))]), // 内置
        price_layer(vec![("m-x".into(), (2.0, 2.0))]),                                 // 公共能力库
        price_layer(vec![("m-x".into(), (3.0, 3.0)), ("m-y".into(), (9.0, 9.0))]),     // 用户覆盖
    ];
    assert_eq!(
        price_of("m-x-pro", &chain),
        Some((3.0, 3.0)),
        "用户覆盖 > 公共库 > 内置"
    );
    assert_eq!(
        price_of("m-y-pro", &chain),
        Some((9.0, 9.0)),
        "高层短前缀覆盖低层长前缀"
    );
    let chain2: PriceChain = [
        price_layer(vec![("m-z".into(), (1.0, 1.0)), ("m-z-pro".into(), (2.0, 2.0))]),
        vec![],
        vec![],
    ];
    assert_eq!(
        price_of("m-z-pro", &chain2),
        Some((2.0, 2.0)),
        "同层最长前缀优先"
    );
}

#[test]
fn pricing_strips_provider_prefix() {
    let table = load_pricing(None);
    // 中转/聚合的 provider 前缀：按最后一个 / 之后的末段匹配
    assert_eq!(
        price_of("accounts/fireworks/models/glm-5p2", &table),
        Some((1.4, 4.4)),
        "glm 前缀命中"
    );
    assert_eq!(price_of("zetatechs/kimi-k3", &table), Some((3.0, 15.0)));
    assert_eq!(
        price_of("openrouter/claude-sonnet-4", &table),
        Some((3.0, 15.0))
    );
    assert_eq!(
        price_of("relay/mystery-x", &table),
        None,
        "末段不明依然不明价"
    );
}

#[test]
fn rate_priority_chain() {
    assert_eq!(load_rate_with(None, None), 7.2, "默认 7.2");
    let dir = std::env::temp_dir().join(format!("ccode-usage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("pricing.json");
    std::fs::write(&p, r#"{"_rate": 7.05, "claude-sonnet": [1.0, 5.0]}"#).unwrap();
    assert_eq!(load_rate_with(None, Some(&p)), 7.05, "_rate 键覆盖默认汇率");
    assert_eq!(
        load_rate_with(Some(7.3), Some(&p)),
        7.3,
        "settings.json 优先于 pricing.json _rate"
    );
    assert_eq!(load_rate_with(Some(7.3), None), 7.3);
    std::fs::write(&p, r#"{"_rate": -1}"#).unwrap();
    assert_eq!(load_rate_with(None, Some(&p)), 7.2, "非法 _rate 回落默认");
    assert_eq!(
        load_rate_with(Some(-2.0), None),
        7.2,
        "非法 settings 汇率同样回落"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pricing_override_merges_over_builtins() {
    let dir = std::env::temp_dir().join(format!("ccode-usage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("pricing.json");
    std::fs::write(
        &p,
        r#"{"claude-sonnet": [1.0, 5.0], "relay-x": [0.1, 0.2]}"#,
    )
    .unwrap();
    let table = load_pricing(Some(&p));
    assert_eq!(
        price_of("claude-sonnet-4", &table),
        Some((1.0, 5.0)),
        "覆盖内置（含低层更长前缀的旧代价）"
    );
    assert_eq!(
        price_of("relay-x-pro", &table),
        Some((0.1, 0.2)),
        "新增自定义前缀"
    );
    assert_eq!(
        price_of("claude-opus-4-1", &table),
        Some((15.0, 75.0)),
        "内置旧代价保留"
    );
    assert_eq!(
        price_of("claude-opus-4-5", &table),
        Some((5.0, 25.0)),
        "内置新代价保留"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn custom_price_cache_and_cny_columns() {
    // 自定义价可单写缓存读 / 写价；按人民币填的按汇率（这里取文件里的 _rate）折成美元
    let dir = std::env::temp_dir().join(format!("ccode-usage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("pricing.json");
    std::fs::write(
        &p,
        r#"{"relay-a": {"input": 2, "output": 8, "cacheRead": 0.5, "cacheWrite": 2.5},
                "relay-b": {"input": 8, "output": 32, "currency": "CNY"}}"#,
    )
    .unwrap();
    let table = load_pricing(Some(&p));
    let a = full_price_of("relay-a-1", &table).unwrap();
    assert_eq!((a.cache_read, a.cache_write), (0.5, 2.5));
    let acc = TokenAcc { input: 1_000_000, output: 0, cache_read: 1_000_000, cache_write: 1_000_000, cache_write_1h: 0 };
    assert!((cost_of(&acc, a) - 5.0).abs() < 1e-9, "2 + 0.5 + 2.5");
    let b = full_price_of("relay-b", &table).unwrap();
    let rate = load_rate(Some(&p));
    assert!((b.input - 8.0 / rate).abs() < 1e-9 && (b.output - 32.0 / rate).abs() < 1e-9);
    assert!((b.cache_read - 0.8 / rate).abs() < 1e-9, "缓存读不填按输入价 1 折");
    assert!(
        (cache_savings_usd("relay-a", 1_000_000, &table).unwrap() - 1.5).abs() < 1e-9,
        "省下的是输入价与缓存读价之差"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn claude_one_hour_cache_write_priced_double_input() {
    // 1 小时缓存写按输入价 2 倍；5 分钟部分按缓存写价（公共库给的 1.25 倍，没给按全价）
    let lines = vec![
        r#"{"type":"assistant","timestamp":"2026-11-01T00:00:00Z","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200}}}}"#.to_string(),
    ];
    let evs = claude_events(&lines, None);
    assert_eq!((evs[0].cache_write, evs[0].cache_write_1h), (300, 200));
    let price: Price = crate::model_registry::DbPrice { input: 4.0, output: 20.0, cache_read: Some(0.2), cache_write: Some(5.0) }.into();
    let acc = TokenAcc { cache_write: 3_000_000, cache_write_1h: 2_000_000, ..Default::default() };
    assert!((cost_of(&acc, price) - (5.0 + 2.0 * 8.0)).abs() < 1e-9);
    assert!((price.cache_read - 0.2).abs() < 1e-9, "公共库给的缓存读价照用，不再一律按 1 折");
}

#[test]
fn pricing_preview_says_base_price_and_matched_models() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    insert_daily(&conn, "2026-10-01", "kimi", "kimi-k3", "/p", "s1", 500, 50, 0, false);
    insert_daily(&conn, "2026-10-02", "kimi", "zetatechs/kimi-k3-turbo", "/p", "s2", 100, 0, 0, false);
    insert_daily(&conn, "2026-10-02", "codex", "gpt-5", "/p", "s3", 100, 0, 0, false);
    let chain: PriceChain = [
        price_layer(vec![("kimi-k3".to_string(), (3.0, 15.0))]),
        vec![],
        price_layer(vec![("kimi-k3".to_string(), (1.0, 1.0))]),
    ];
    let got = pricing_preview_from(&conn, &["Kimi-K3".into(), "".into(), "nope".into()], &chain).unwrap();
    let base = got[0].base.as_ref().unwrap();
    assert_eq!((base.input, base.output, base.source.as_str()), (3.0, 15.0, "builtin"), "不算自定义层本身");
    assert_eq!(got[0].matched_count, 2, "剥中转前缀后同样按前缀命中");
    assert_eq!(got[0].matched[0].model, "kimi-k3");
    assert!(got[1].base.is_none() && got[1].matched.is_empty(), "空前缀什么都不管");
    assert!(got[2].base.is_none() && got[2].matched_count == 0);
}

#[test]
fn range_cutoff_days() {
    let today = NaiveDate::from_ymd_opt(2026, 7, 30).unwrap();
    assert_eq!(
        cutoff_day_from("today", today).as_deref(),
        Some("2026-07-30")
    );
    assert_eq!(
        cutoff_day_from("week", today).as_deref(),
        Some("2026-07-24")
    );
    assert_eq!(
        cutoff_day_from("month", today).as_deref(),
        Some("2026-07-01")
    );
    assert_eq!(cutoff_day_from("all", today), None);
}

#[test]
fn unpriced_models_lists_billed_models_without_price() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    let chain: PriceChain = [price_layer(vec![("gpt-5".to_string(), (1.25, 10.0))]), vec![], vec![]];
    insert_daily(&conn, "2026-10-01", "codex", "gpt-5", "/p", "s1", 100, 10, 0, false);
    insert_daily(&conn, "2026-10-02", "kimi", "kimi-k3", "/p", "s2", 500, 50, 0, false);
    insert_daily(&conn, "2026-10-05", "kimi", "kimi-k3", "/p", "s3", 100, 0, 0, false);
    insert_daily(&conn, "2026-10-03", "grok", "relay-x", "/p", "s4", 10, 0, 0, false);
    // 订阅额度不计费，不该被列出
    insert_daily(&conn, "2026-10-04", "gemini", "gemini-sub", "/p", "s5", 900, 0, 0, true);
    let got = unpriced_models(&conn, &chain).unwrap();
    let names: Vec<&str> = got.iter().map(|m| m.model.as_str()).collect();
    assert_eq!(names, vec!["kimi-k3", "relay-x"], "有价的与订阅的不列，按用量降序");
    assert_eq!(got[0].tokens, 650);
    assert_eq!(got[0].last_day, "2026-10-05");
}

fn insert_daily(
    conn: &Connection,
    day: &str,
    agent: &str,
    model: &str,
    project: &str,
    sid: &str,
    input: i64,
    output: i64,
    cache_read: i64,
    official: bool,
) {
    conn.execute(
        "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
             input, output, cache_read, cache_write, official)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9)",
        rusqlite::params![
            day,
            agent,
            model,
            project,
            sid,
            input,
            output,
            cache_read,
            i64::from(official)
        ],
    )
    .unwrap();
}

#[test]
fn usage_trend_empty_db_fills_month_zeros() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    let today = NaiveDate::from_ymd_opt(2026, 3, 15).unwrap();
    let dto = usage_trend_from(&conn, "month", today, &load_pricing(None), 7.2).unwrap();
    assert_eq!(dto.days.len(), 30, "近 30 天含 today");
    assert_eq!(dto.days[0].day, "2026-02-14");
    assert_eq!(dto.days[29].day, "2026-03-15");
    assert!(dto
        .days
        .iter()
        .all(|d| !d.has_usage && d.cost_usd == Some(0.0)));
}

#[test]
fn usage_trend_fills_today_and_week_length() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    let today = NaiveDate::from_ymd_opt(2026, 3, 15).unwrap();
    let table = load_pricing(None);
    let day = usage_trend_from(&conn, "today", today, &table, 7.2).unwrap();
    assert_eq!(day.days.len(), 1, "今日只填当天");
    assert_eq!(day.days[0].day, "2026-03-15");
    let week = usage_trend_from(&conn, "week", today, &table, 7.2).unwrap();
    assert_eq!(week.days.len(), 7, "近 7 天含 today");
    assert_eq!(week.days[0].day, "2026-03-09");
    assert_eq!(week.days[6].day, "2026-03-15");
}

#[test]
fn usage_trend_fills_across_month_and_skips_official_cost() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    let today = NaiveDate::from_ymd_opt(2026, 3, 5).unwrap();
    insert_daily(
        &conn,
        "2026-02-28",
        "codex",
        "gpt-5",
        "/p",
        "s-api",
        1_000_000,
        0,
        0,
        false,
    );
    insert_daily(
        &conn,
        "2026-02-28",
        "gemini",
        "gemini-3-pro",
        "/p",
        "s-off",
        9_000_000,
        0,
        0,
        true,
    );
    insert_daily(
        &conn,
        "2026-03-05",
        "codex",
        "mystery-x",
        "/p",
        "s-unk",
        100,
        10,
        0,
        false,
    );
    let dto = usage_trend_from(&conn, "month", today, &load_pricing(None), 7.2).unwrap();
    assert_eq!(dto.days.first().map(|d| d.day.as_str()), Some("2026-02-04"));
    let feb = dto.days.iter().find(|d| d.day == "2026-02-28").unwrap();
    assert!(feb.has_usage);
    assert!(
        feb.cost_usd.unwrap() > 0.0,
        "官方账号那行不计费，API 行仍计价"
    );
    let mar = dto.days.iter().find(|d| d.day == "2026-03-05").unwrap();
    assert!(mar.has_usage);
    assert_eq!(mar.cost_usd, None, "当天只有未计价模型 → ~ 而不是 0");
    let gap = dto.days.iter().find(|d| d.day == "2026-03-01").unwrap();
    assert!(!gap.has_usage);
    assert_eq!(gap.cost_usd, Some(0.0));
}

#[test]
fn top_sessions_ranks_billed_skips_official_and_unpriced() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    conn.execute_batch(
        "CREATE TABLE session_meta(
               agent TEXT NOT NULL, session_id TEXT NOT NULL,
               custom_title TEXT, PRIMARY KEY(agent, session_id));",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, custom_title) VALUES('codex','s-big','飞了的长会话')",
        [],
    )
    .unwrap();
    let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
    insert_daily(
        &conn,
        "2026-08-20",
        "codex",
        "gpt-5",
        "/proj/a",
        "s-big",
        2_000_000,
        0,
        0,
        false,
    );
    insert_daily(
        &conn,
        "2026-08-21",
        "codex",
        "gpt-5",
        "/proj/a",
        "s-small",
        100_000,
        0,
        0,
        false,
    );
    insert_daily(
        &conn,
        "2026-08-22",
        "gemini",
        "gemini-3-pro",
        "/proj/b",
        "s-off",
        9_000_000,
        0,
        0,
        true,
    );
    insert_daily(
        &conn,
        "2026-08-23",
        "codex",
        "mystery-x",
        "/proj/c",
        "s-unk",
        9_000_000,
        0,
        0,
        false,
    );
    insert_daily(
        &conn,
        "2026-07-01",
        "codex",
        "gpt-5",
        "/proj/a",
        "s-old",
        9_000_000,
        0,
        0,
        false,
    );
    let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
    assert_eq!(top.len(), 2, "官方与未计价不进榜，区间外的旧会话也不进");
    assert_eq!(top[0].session_id, "s-big");
    assert_eq!(top[0].title.as_deref(), Some("飞了的长会话"));
    assert_eq!(top[1].session_id, "s-small");
    assert!(top[0].cost_usd.unwrap() > top[1].cost_usd.unwrap());
}

#[test]
fn usage_trend_and_top_sessions_skip_internal() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
    insert_daily(
        &conn,
        "2026-08-20",
        "codex",
        "gpt-5",
        "/p",
        "s-user",
        100_000,
        0,
        0,
        false,
    );
    conn.execute(
        "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
             input, output, cache_read, cache_write, official, internal)
             VALUES ('2026-08-21','kimi','kimi-k2','/tmp/ccode-ai','s-radar',9000000,0,0,0,0,1)",
        [],
    )
    .unwrap();
    let dto = usage_trend_from(&conn, "month", today, &load_pricing(None), 7.2).unwrap();
    let radar = dto.days.iter().find(|d| d.day == "2026-08-21").unwrap();
    assert!(!radar.has_usage, "内部活动不得进入花费折线");
    assert_eq!(radar.cost_usd, Some(0.0));
    let user = dto.days.iter().find(|d| d.day == "2026-08-20").unwrap();
    assert!(user.has_usage);
    let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
    assert_eq!(top.len(), 1);
    assert_eq!(top[0].session_id, "s-user");
}

#[test]
fn top_session_title_is_redacted() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    conn.execute_batch(
        "CREATE TABLE session_meta(
               agent TEXT NOT NULL, session_id TEXT NOT NULL,
               custom_title TEXT, PRIMARY KEY(agent, session_id));",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, custom_title)
             VALUES('codex','s-leak','任务 sk-live-secret-987654')",
        [],
    )
    .unwrap();
    let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
    insert_daily(
        &conn,
        "2026-08-20",
        "codex",
        "gpt-5",
        "/p",
        "s-leak",
        1_000_000,
        0,
        0,
        false,
    );
    let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
    let title = top[0].title.as_deref().unwrap();
    assert!(!title.contains("sk-live-secret-987654"));
    assert!(title.contains("已隐藏密钥"));
}

#[test]
fn top_sessions_equal_cost_uses_stable_tiebreak() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
    insert_daily(
        &conn,
        "2026-08-20",
        "codex",
        "gpt-5",
        "/p",
        "s-b",
        1_000_000,
        0,
        0,
        false,
    );
    insert_daily(
        &conn,
        "2026-08-21",
        "codex",
        "gpt-5",
        "/p",
        "s-a",
        1_000_000,
        0,
        0,
        false,
    );
    let top = top_sessions_from(&conn, "month", today, &load_pricing(None)).unwrap();
    assert_eq!(top.len(), 2);
    assert_eq!(top[0].session_id, "s-a", "花费相同按 session_id 升序");
    assert_eq!(top[1].session_id, "s-b");
}

#[test]
fn top_sessions_empty_db() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    let today = NaiveDate::from_ymd_opt(2026, 8, 30).unwrap();
    let top = top_sessions_from(&conn, "all", today, &load_pricing(None)).unwrap();
    assert!(top.is_empty());
}

#[test]
fn cache_savings_priced_only_skips_official() {
    let table = load_pricing(None);
    let rows: Vec<StoredUsageRow> = vec![
        (
            "2026-08-01".into(),
            "codex".into(),
            "gpt-5".into(),
            "/p".into(),
            "s1".into(),
            0,
            0,
            1_000_000,
            0,
            SOURCE_CLI.into(),
            false,
            String::new(),
            false,
            0,
        ),
        (
            "2026-08-01".into(),
            "codex".into(),
            "mystery-x".into(),
            "/p".into(),
            "s2".into(),
            0,
            0,
            1_000_000,
            0,
            SOURCE_CLI.into(),
            false,
            String::new(),
            false,
            0,
        ),
        {
            let mut r = ws_row("/p", "s3", "gpt-5", 0, 0, false, "");
            r.7 = 1_000_000; // cache_read
            r.12 = true; // official
            r
        },
    ];
    let stats = build_stats(rows, &table, 7.2);
    // gpt-5 输入 1.25 / MTok，省 90% → 1.125；未计价与官方不计入
    let saved = stats.cards.cache_savings_usd.unwrap();
    assert!((saved - 1.125).abs() < 1e-9, "{saved}");
}

#[test]
fn bucket_cost_partial_semantics() {
    let table = load_pricing(None);
    // 全计价 → 精确费用，非 partial
    let mut b = Bucket::default();
    b.add(
        "gpt-5",
        "s1",
        TokenAcc {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: 0,
        },
    );
    assert_eq!(b.cost(&table), (Some(1.25 + 10.0), false));
    // 混有不明价 → 只算已计价份额，partial=true
    b.add(
        "mystery",
        "s2",
        TokenAcc {
            input: 5,
            output: 5,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: 0,
        },
    );
    let (cost, partial) = b.cost(&table);
    assert_eq!(cost, Some(11.25), "不明价模型不再毒化整桶");
    assert!(partial);
    // 全不明价 → None（partial 也置位，前端显示 ~）
    let mut c = Bucket::default();
    c.add(
        "mystery",
        "s1",
        TokenAcc {
            input: 5,
            output: 5,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: 0,
        },
    );
    assert_eq!(c.cost(&table), (None, true));
}

#[test]
fn claude_continuation_counts_only_own_lines() {
    // 接续文件开头是上游复制来的历史，那份用量记在上游名下
    let lines = vec![
        r#"{"type":"assistant","sessionId":"up","timestamp":"2026-10-18T01:00:00Z","message":{"model":"m","usage":{"input_tokens":100,"output_tokens":10}}}"#.to_string(),
        r#"{"type":"assistant","sessionId":"me","timestamp":"2026-10-19T01:00:00Z","message":{"model":"m","usage":{"input_tokens":7,"output_tokens":1}}}"#.to_string(),
    ];
    let evs = claude_events(&lines, Some("me"));
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].input, 7);
    assert_eq!(claude_events(&lines, None).len(), 2, "不知道自己 id 时不过滤");
}

#[test]
fn extractors_claude_codex_kimi() {
    // claude：assistant 行的 usage + model
    let lines = vec![
        r#"{"type":"assistant","timestamp":"2026-07-29T01:00:00Z","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}"#.to_string(),
        r#"{"type":"user","message":{"role":"user","content":"q"}}"#.to_string(),
    ];
    let evs = claude_events(&lines, None);
    assert_eq!(evs.len(), 1);
    assert_eq!(
        (evs[0].day.as_str(), evs[0].model.as_str()),
        (
            day_of_iso("2026-07-29T01:00:00Z").as_str(),
            "claude-sonnet-4-5"
        )
    );
    assert_eq!(
        (
            evs[0].input,
            evs[0].output,
            evs[0].cache_read,
            evs[0].cache_write
        ),
        (10, 5, 3, 2)
    );
    // codex：turn_context 定 model，token_count 的 last_token_usage 是本轮增量
    let lines = vec![
        r#"{"timestamp":"2026-07-29T02:00:00Z","type":"turn_context","payload":{"model":"gpt-5-codex"}}"#.to_string(),
        r#"{"timestamp":"2026-07-29T02:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5,"cached_input_tokens":10},"total_token_usage":{"input_tokens":999}}}}"#.to_string(),
    ];
    let evs = codex_events(&lines);
    assert_eq!(evs.len(), 1);
    assert_eq!(
        (evs[0].input, evs[0].output, evs[0].cache_read),
        (90, 20, 10),
        "用增量而非累计；输入拆掉缓存、推理不另加"
    );
    assert_eq!(evs[0].model, "gpt-5-codex");
    // kimi：usage.record
    let lines = vec![
        r#"{"type":"usage.record","model":"kimi-k2","usage":{"inputOther":50,"output":9,"inputCacheRead":4,"inputCacheCreation":1},"time":1785307071000}"#.to_string(),
    ];
    let evs = kimi_events(&lines);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].day, day_of_ms(1785307071000));
    assert_eq!(
        (
            evs[0].input,
            evs[0].output,
            evs[0].cache_read,
            evs[0].cache_write
        ),
        (50, 9, 4, 1)
    );
    assert_eq!(evs[0].model, "kimi-k2", "没有 llm.request 对照时原样用记下的名字");
    // Mesa 启动的会话记的是合成别名：按同一份文件 llm.request 的 modelAlias 换回真名
    let lines = vec![
        r#"{"type":"llm.request","model":"glm-5.3","modelAlias":"__kimi_env_model__","time":1785307070000}"#.to_string(),
        r#"{"type":"usage.record","model":"__kimi_env_model__","usage":{"inputOther":5,"output":1},"time":1785307071000}"#.to_string(),
    ];
    assert_eq!(kimi_events(&lines)[0].model, "glm-5.3");
    // codebuddy：毫秒 epoch 时间戳；无 usage 字段的行（401 实测样本）不产生事件
    let lines = vec![
        r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"say hi"}],"timestamp":1786005441386}"#.to_string(),
        r#"{"type":"message","role":"assistant","content":[{"type":"output_text","text":"401 Unauthorized"}],"timestamp":1786005443775}"#.to_string(),
    ];
    assert!(
        codebuddy_events(&lines).is_empty(),
        "无 usage 字段必须零事件不报错"
    );
    let lines = vec![
        r#"{"type":"message","role":"assistant","model":"glm-5.0","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":2},"timestamp":1786005443775}"#.to_string(),
    ];
    let evs = codebuddy_events(&lines);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].day, day_of_ms(1786005443775));
    assert_eq!(evs[0].model, "glm-5.0");
    assert_eq!(
        (
            evs[0].input,
            evs[0].output,
            evs[0].cache_read,
            evs[0].cache_write
        ),
        (10, 5, 3, 2)
    );
    // cursor：usage 字段未实证，按字段名候选尽力而为；无 usage 字段的行必须零事件不报错
    let lines = vec![
        r#"{"type":"user_message","message":{"content":[{"text":"hi"}]},"timestamp":1786005441386}"#.to_string(),
        r#"{"type":"turn_ended","timestamp":1786005441500}"#.to_string(),
    ];
    assert!(
        cursor_events(&lines).is_empty(),
        "无 usage 字段必须零事件不报错"
    );
    let lines = vec![
        r#"{"type":"turn_ended","model":"claude-opus-4-8","usage":{"inputTokens":20,"outputTokens":7},"timestamp":1786005443775}"#.to_string(),
    ];
    let evs = cursor_events(&lines);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].day, day_of_ms(1786005443775));
    assert_eq!(evs[0].model, "claude-opus-4-8");
    assert_eq!(
        (evs[0].input, evs[0].output),
        (20, 7),
        "camelCase 候选字段名也要能取到"
    );
    // grok：_meta.usage 在 turn 结束通知里（params._meta 与 params.update._meta 两层都探）；
    // 无 usage 的行必须零事件不报错
    let lines = vec![
        r#"{"timestamp":1786005441,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"}}}}"#.to_string(),
        r#"{"timestamp":1786005442,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"你好"}}}}"#.to_string(),
        r#"{"timestamp":1786005443,"method":"session/update","params":{"_meta":{"totalTokens":999},"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}}"#.to_string(),
    ];
    assert!(
        grok_events(&lines).is_empty(),
        "无 usage 对象的行（含流式 _meta.totalTokens）必须零事件不报错"
    );
    // params.update._meta 位置
    let lines = vec![
        r#"{"timestamp":1786005445,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"完成"},"_meta":{"usage":{"input_tokens":120,"output_tokens":30,"total_tokens":150,"cached_read_tokens":40,"modelUsage":{"grok-code-fast-1":{"input_tokens":120,"output_tokens":30,"cached_read_tokens":40}},"numTurns":1,"usageIsIncomplete":false}}}}}"#.to_string(),
    ];
    let evs = grok_events(&lines);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].day, day_of_ms(1786005445 * 1000), "unix 秒转日期");
    assert_eq!(
        evs[0].model, "grok-code-fast-1",
        "modelUsage 第一个键作模型名"
    );
    assert_eq!(
        (
            evs[0].input,
            evs[0].output,
            evs[0].cache_read,
            evs[0].cache_write
        ),
        (120, 30, 40, 0)
    );
    // params._meta 位置（兼容另一层）
    let lines = vec![
        r#"{"timestamp":1786005500,"method":"session/update","params":{"_meta":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"cached_read_tokens":2,"modelUsage":{"grok-4":{}},"numTurns":1}},"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}}"#.to_string(),
    ];
    let evs = grok_events(&lines);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].model, "grok-4");
    assert_eq!((evs[0].input, evs[0].output, evs[0].cache_read), (10, 5, 2));
    // 实机：_x.ai/session/update 的 turn_completed，用量在 params.update.usage（camelCase）。
    // inputTokens 含缓存，入库时拆成未命中输入。
    let lines = vec![
        r#"{"timestamp":1786005600,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":1000,"outputTokens":50,"totalTokens":1050,"cachedReadTokens":400,"cacheCreationTokens":10,"reasoningTokens":80,"modelUsage":{"grok-4.7-build":{"inputTokens":1000,"outputTokens":50,"cachedReadTokens":400,"cacheCreationTokens":10}}}}}}"#.to_string(),
    ];
    let evs = grok_events(&lines);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].day, day_of_ms(1786005600 * 1000));
    assert_eq!(evs[0].model, "grok-4.7-build");
    assert_eq!(
        (
            evs[0].input,
            evs[0].output,
            evs[0].cache_read,
            evs[0].cache_write
        ),
        (590, 50, 400, 10),
        "inputTokens 去掉缓存读和缓存写"
    );
    // 同一回合两个模型各记各的，不把合计塞给第一个键
    let lines = vec![
        r#"{"timestamp":1786005700,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":300,"outputTokens":30,"cachedReadTokens":100,"modelUsage":{"grok-4.6":{"inputTokens":100,"outputTokens":10,"cachedReadTokens":40},"grok-4.6-build":{"inputTokens":200,"outputTokens":20,"cachedReadTokens":60}}}}}}"#.to_string(),
    ];
    let evs = grok_events(&lines);
    assert_eq!(evs.len(), 2);
    assert_eq!(evs[0].model, "grok-4.6");
    assert_eq!(
        (evs[0].input, evs[0].output, evs[0].cache_read),
        (60, 10, 40)
    );
    assert_eq!(evs[1].model, "grok-4.6-build");
    assert_eq!(
        (evs[1].input, evs[1].output, evs[1].cache_read),
        (140, 20, 60)
    );
}

#[test]
fn large_jsonl_and_zstd_sessions_are_streamed() {
    use std::io::{BufWriter, Write};

    let dir = std::env::temp_dir().join(format!("ccode-usage-stream-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let plain = dir.join("large.jsonl");
    let mut writer = BufWriter::new(File::create(&plain).unwrap());
    writeln!(writer, r#"{{"timestamp":"2026-08-04T04:00:00Z","type":"turn_context","payload":{{"model":"gpt-5-codex"}}}}"#).unwrap();
    let ignored = format!("{}\n", "x".repeat(1024));
    for _ in 0..10_300 {
        writer.write_all(ignored.as_bytes()).unwrap();
    }
    writeln!(writer, r#"{{"timestamp":"2026-08-04T04:01:00Z","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5,"cached_input_tokens":10}}}}}}}}"#).unwrap();
    writer.flush().unwrap();
    assert!(std::fs::metadata(&plain).unwrap().len() > 10 * 1024 * 1024);
    let events = extract_file_events("codex", &plain, None);
    assert_eq!(events.len(), 1, "大于旧 10 MB 上限的会话不得整份跳过");
    assert_eq!(
        (events[0].input, events[0].output, events[0].cache_read),
        (90, 20, 10)
    );

    let compressed = dir.join("small.jsonl.zst");
    let raw = std::fs::read(&plain).unwrap();
    std::fs::write(&compressed, zstd::stream::encode_all(&raw[..], 1).unwrap()).unwrap();
    let compressed_events = extract_file_events("codex", &compressed, None);
    assert_eq!(
        compressed_events, events,
        "zstd 会话必须同样流式解码并提取用量"
    );
    std::fs::remove_dir_all(&dir).ok();
}
