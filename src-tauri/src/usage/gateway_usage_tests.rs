use super::*;
use crate::profiles::{Binding, BindingKind, Gateway, ProtocolSlots};

fn gw(id: &str, name: &str) -> Gateway {
    Gateway {
        id: id.into(),
        name: name.into(),
        no_auth: false,
        key_hint: None,
        wallet_user_id: None,
        wallet_key_hint: None,
        slots: ProtocolSlots::default(),
        header_env: Default::default(),
        models: vec![],
        catalog_fetched_at: None,
        catalog_from_slot: None,
        last_probe: vec![],
        slot_probes: vec![],
        revision: String::new(),
        compat: Default::default(),
    }
}

fn bind(id: &str, agent: &str, gid: Option<&str>, kind: BindingKind) -> Binding {
    Binding {
        id: id.into(),
        agent: agent.into(),
        name: id.into(),
        kind,
        gateway_id: gid.map(|s| s.into()),
        protocol: None,
        api_backend: None,
        models: vec![],
        role_models: Default::default(),
        extra_env: Default::default(),
        last_used_at: None,
    }
}

#[test]
fn usage_join_three_missing_buckets_and_live_gateway() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE usage_daily(day TEXT, agent TEXT, model TEXT, project_path TEXT, session_id TEXT,
             input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, official INTEGER,
             cache_write_1h INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE session_meta(agent TEXT, session_id TEXT, profile_id TEXT);
             INSERT INTO usage_daily(day, agent, model, project_path, session_id, input, output, cache_read, cache_write, official) VALUES
             ('2026-08-30','claude-code','m','/p','s-gw',10,1,0,0,0),
             ('2026-08-30','codex','m','/p','s-none',20,2,0,0,0),
             ('2026-08-30','claude-code','m','/p','s-dead',30,3,0,0,0),
             ('2026-08-30','gemini','m','/p','s-off',40,4,0,0,1),
             ('2026-08-30','claude-code','m','/p','s-del',50,5,0,0,0);
             INSERT INTO session_meta VALUES
             ('claude-code','s-gw','b-live'),
             ('claude-code','s-dead','gone'),
             ('claude-code','s-del','b-del');",
    )
    .unwrap();
    let gws = vec![gw("g-live", "Zeta")];
    let bindings = vec![
        bind("b-live", "claude-code", Some("g-live"), BindingKind::Api),
        bind("b-del", "claude-code", Some("g-gone"), BindingKind::Api),
    ];
    let rows = usage_by_gateway_impl(&conn, "all", &bindings, &gws).unwrap();
    let live = rows.iter().find(|r| r.bucket == "gateway").unwrap();
    assert_eq!(live.gateway_name, "Zeta");
    assert_eq!(live.tokens_in, 10);
    let unlinked = rows.iter().find(|r| r.bucket == "unlinked").unwrap();
    assert_eq!(unlinked.tokens_in, 20 + 30); // no meta + deleted binding id
    let official = rows.iter().find(|r| r.bucket == "official").unwrap();
    assert_eq!(official.tokens_in, 40);
    let deleted = rows.iter().find(|r| r.bucket == "deleted").unwrap();
    assert!(deleted.gateway_name.contains("已删除网关"));
    assert_eq!(deleted.tokens_in, 50);
}

// ===== usage_activity（活跃度热力图） =====

/// 直插一行 usage_daily：比 insert_daily 多 internal 与 cache_write 维度
fn insert_activity_row(
    conn: &Connection,
    day: &str,
    agent: &str,
    model: &str,
    sid: &str,
    i: i64,
    o: i64,
    cr: i64,
    cw: i64,
    internal: bool,
    official: bool,
) {
    conn.execute(
        "INSERT INTO usage_daily(day, agent, model, project_path, session_id,
             input, output, cache_read, cache_write, internal, official)
             VALUES (?1,?2,?3,'/p',?4,?5,?6,?7,?8,?9,?10)",
        rusqlite::params![
            day,
            agent,
            model,
            sid,
            i,
            o,
            cr,
            cw,
            i64::from(internal),
            i64::from(official),
        ],
    )
    .unwrap();
}

#[test]
fn usage_activity_empty_db() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    let dto =
        usage_activity_from(&conn, NaiveDate::from_ymd_opt(2026, 3, 15).unwrap(), &load_pricing(None))
            .unwrap();
    assert!(dto.days.is_empty());
    assert_eq!(dto.first_day, None);
    assert_eq!(dto.today, "2026-03-15");
    assert!(!dto.stale);
}

#[test]
fn usage_activity_sums_main_and_splits_internal_official() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    // 同日：两个可计费会话（不同模型）+ 一条官方订阅行 + 一条内部行
    insert_activity_row(&conn, "2026-08-14", "codex", "gpt-5", "s1", 100, 10, 1000, 0, false, false);
    insert_activity_row(&conn, "2026-08-14", "claude-code", "claude-sonnet-4", "s2", 50, 5, 500, 0, false, false);
    insert_activity_row(&conn, "2026-08-14", "kimi", "kimi-k2", "s3", 30, 3, 300, 0, false, true);
    insert_activity_row(&conn, "2026-08-14", "claude-code", "claude-sonnet-4", "s4", 999, 99, 999, 9, true, false);
    let dto =
        usage_activity_from(&conn, NaiveDate::from_ymd_opt(2026, 8, 20).unwrap(), &load_pricing(None))
            .unwrap();
    assert_eq!(dto.days.len(), 1);
    let d = &dto.days[0];
    // 主量只计非 internal（billed + official 都在内）
    assert_eq!((d.input, d.output, d.cache_read, d.cache_write), (180, 18, 1800, 0));
    // 按天会话数 = 非 internal 不重复会话（billed 2 + official 1）
    assert_eq!(d.sessions, 3);
    // 官方/内部并列子计量（四类合计）
    assert_eq!(d.official_tokens, 333);
    assert_eq!(d.internal_tokens, 2106);
    assert_eq!(d.internal_sessions, 1);
    // 费用只计可计费行，且 > 0
    assert!(d.cost_usd.unwrap() > 0.0);
    assert_eq!(dto.first_day.as_deref(), Some("2026-08-14"));
}

#[test]
fn usage_activity_skips_blank_and_future_days_and_keeps_ascending() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    insert_activity_row(&conn, "2026-08-02", "codex", "gpt-5", "s1", 10, 1, 0, 0, false, false);
    insert_activity_row(&conn, "2026-08-01", "codex", "gpt-5", "s1", 20, 2, 0, 0, false, false);
    // 空日（防御）与未来日（CLI 时钟漂移）都不得出现
    insert_activity_row(&conn, "", "codex", "gpt-5", "s2", 1, 1, 0, 0, false, false);
    insert_activity_row(&conn, "2026-09-05", "codex", "gpt-5", "s3", 1, 1, 0, 0, false, false);
    let dto =
        usage_activity_from(&conn, NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(), &load_pricing(None))
            .unwrap();
    let days: Vec<&str> = dto.days.iter().map(|d| d.day.as_str()).collect();
    assert_eq!(days, vec!["2026-08-01", "2026-08-02"], "乱序插入仍升序，空/未来日被截掉");
    assert_eq!(dto.first_day.as_deref(), Some("2026-08-01"));
}

#[test]
fn usage_activity_internal_only_day_stays_but_costs_zero() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    insert_activity_row(&conn, "2026-08-01", "claude-code", "claude-sonnet-4", "s1", 10, 1, 0, 0, true, false);
    let dto =
        usage_activity_from(&conn, NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(), &load_pricing(None))
            .unwrap();
    assert_eq!(dto.days.len(), 1, "纯 internal 日保留行（开关打开时前端注记），主量为 0");
    let d = &dto.days[0];
    assert_eq!((d.input, d.sessions, d.internal_tokens), (0, 0, 11));
    assert_eq!(d.cost_usd, Some(0.0));
}

#[test]
fn usage_activity_costs_none_when_unpriced_and_zero_when_official_only() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    // 全未计价模型：费用 None（前端 ~），不是 0
    insert_activity_row(&conn, "2026-08-01", "codex", "mystery-x", "s1", 100, 10, 0, 0, false, false);
    // 纯订阅日：无可计费行记 Some(0.0)
    insert_activity_row(&conn, "2026-08-02", "kimi", "kimi-k2", "s2", 30, 3, 300, 0, false, true);
    let dto =
        usage_activity_from(&conn, NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(), &load_pricing(None))
            .unwrap();
    assert_eq!(dto.days[0].cost_usd, None);
    assert_eq!(dto.days[1].cost_usd, Some(0.0));
    assert!(dto.days[1].official_tokens > 0);
}

#[test]
fn usage_day_detail_totals_match_activity_and_ranks_sessions() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    let table = load_pricing(None);
    // 与 usage_activity_sums 同款数据：两会话可计费 + 一订阅 + 一内部
    insert_activity_row(&conn, "2026-08-14", "codex", "gpt-5", "s1", 100, 10, 1000, 0, false, false);
    insert_activity_row(&conn, "2026-08-14", "claude-code", "claude-sonnet-4", "s2", 50, 5, 500, 0, false, false);
    insert_activity_row(&conn, "2026-08-14", "kimi", "kimi-k2", "s3", 30, 3, 300, 0, false, true);
    insert_activity_row(&conn, "2026-08-14", "claude-code", "claude-sonnet-4", "s4", 999, 99, 999, 9, true, false);
    let today = NaiveDate::from_ymd_opt(2026, 8, 20).unwrap();
    let act = usage_activity_from(&conn, today, &table).unwrap();
    let det = usage_day_detail_from(&conn, "2026-08-14", &table).unwrap();
    // 总量与热力图格同口径
    assert_eq!(det.totals.input, act.days[0].input);
    assert_eq!(det.totals.sessions, act.days[0].sessions);
    assert_eq!(det.totals.official_tokens, act.days[0].official_tokens);
    assert_eq!(det.totals.internal_tokens, act.days[0].internal_tokens);
    assert_eq!(det.totals.cost_usd, act.days[0].cost_usd);
    // by_agent 只含非 internal，tokens 降序；codex(1110) > claude(555) > kimi(333)
    assert_eq!(
        det.by_agent.iter().map(|r| (r.agent.as_str(), r.tokens)).collect::<Vec<_>>(),
        vec![("codex", 1110), ("claude-code", 555), ("kimi", 333)]
    );
    // 会话四类合计降序、internal 沉底
    assert_eq!(
        det.sessions.iter().map(|s| s.session_id.as_str()).collect::<Vec<_>>(),
        vec!["s1", "s2", "s3", "s4"]
    );
    let s4 = det.sessions.last().unwrap();
    assert!(s4.internal && s4.cost_usd.is_none(), "内部会话不算费用");
    let s3 = det.sessions.iter().find(|s| s.session_id == "s3").unwrap();
    assert!(s3.official && s3.cost_usd.is_none(), "订阅会话不算费用");
    let s1 = det.sessions.iter().find(|s| s.session_id == "s1").unwrap();
    assert!(s1.cost_usd.unwrap() > 0.0);
    assert_eq!(s1.title, None, "无 session_meta 表时标题安全回落 None");
    // 空日：不炸、全零
    let empty = usage_day_detail_from(&conn, "2026-08-19", &table).unwrap();
    assert_eq!(empty.totals.sessions, 0);
    assert!(empty.sessions.is_empty());
}

#[test]
fn usage_activity_agents_window_and_internal_excluded() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_usage_schema(&conn).unwrap();
    insert_activity_row(&conn, "2025-12-31", "codex", "gpt-5", "s1", 10, 1, 0, 0, false, false);
    insert_activity_row(&conn, "2026-01-02", "codex", "gpt-5", "s2", 20, 2, 0, 0, false, false);
    insert_activity_row(&conn, "2026-01-02", "claude-code", "claude-sonnet-4", "s3", 40, 4, 0, 0, false, false);
    insert_activity_row(&conn, "2026-01-05", "kimi", "kimi-k2", "s4", 30, 3, 0, 0, false, false);
    insert_activity_row(&conn, "2026-01-06", "claude-code", "claude-sonnet-4", "s5", 999, 9, 0, 0, true, false);
    insert_activity_row(&conn, "2026-01-07", "codex", "gpt-5", "s6", 5, 0, 0, 0, false, false); // 未来日
    let dto = usage_activity_agents_from(
        &conn,
        2026,
        NaiveDate::from_ymd_opt(2026, 1, 6).unwrap(),
    )
    .unwrap();
    assert_eq!(dto.year, 2026);
    // agent 按年总量降序：claude(44) > kimi(33) > codex(22)；internal 与未来日不进
    assert_eq!(dto.agents, vec!["claude-code", "kimi", "codex"]);
    let d2 = dto.days.iter().find(|d| d.day == "2026-01-02").unwrap();
    assert_eq!(
        d2.by_agent.iter().map(|r| (r.agent.as_str(), r.tokens)).collect::<Vec<_>>(),
        vec![("claude-code", 44), ("codex", 22)]
    );
    assert!(!dto.days.iter().any(|d| d.day == "2026-01-07"), "未来日不进矩阵");
}
