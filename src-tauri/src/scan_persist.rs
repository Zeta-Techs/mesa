//! 扫描缓存的落盘层（app.db 表 `scan_meta_cache`，2026-10-16）。
//!
//! 进程内 `SCAN_FILE_CACHE` 只活在进程生命期里，重启即清零——冷启动要把全部会话文件
//! 重新解析一遍（Codex 归档 zst 还得解压）。本模块把五张 meta 缓存表
//! （plain / chained / kimi / snapshot / kimi_snapshot）按「键 + 文件指纹」整表落进
//! app.db，新进程首轮扫描**前**装回：指纹未变的文件直接沿用旧 meta，一个字节不重读。
//!
//! 正确性完全复用既有口径：落盘行只是「解析结果」，消费端仍走 `file_sig` 指纹比对，
//! 文件变了自然 miss 重解析。**版本升级靠 `SCAN_CACHE_VER` 整表作废**（serde 对缺
//! 字段是静默取默认值不是报错，逐行跳过拦不住 schema 演进）；真坏行（JSON 损坏）
//! 逐行跳过自愈；app.db 打不开 / 写不进 = 静默退回无落盘行为，绝不阻塞扫描主路径。
//! opencode_db / opencode_legacy / grok_summary 三栏不落盘（各有外部状态指纹、
//! 解析本身便宜，不值得为它们加列）。
//!
//! 已知局限（2026-10-16 实测口径）：`cached_plain` 是**每段整表替换**共享 map 的
//! 既有语义，扫描跑完 plain 表只剩最后一个 section 的条目——落盘因此只对
//! chained（codex/grok，大头）与 kimi 完整生效；claude/gemini 等明文段每进程
//! 重走 seek 头窗读（亚秒级）。实测冷扫描 3.2s → ~0.8s；要吃掉明文段需把
//! plain 改成按段累积，动的是共享热路径，收益 <0.6s，暂不做。

use rusqlite::{params, Connection};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::sessions::{FileSig, ScanFileCache, SessionMetaDto};

static LOADED: AtomicBool = AtomicBool::new(false);
static SAVED: AtomicBool = AtomicBool::new(false);

/// 落表内容的结构版本：SessionMetaDto 增删/改派生字段时必须 bump。serde 对缺字段
/// （带 #[serde(default)] 或 Option）是静默取默认值而非报错——没有版本戳的话，
/// 旧版本落盘的行会被新版本「成功」读出并带着错误默认值永久命中缓存且被回写固化。
/// 对照 usage.rs USAGE_SCHEMA_VERSION 先例；不符即整表不装，save_to 本就是
/// DELETE 后整表重写，下轮落盘自愈。
const SCAN_CACHE_VER: i64 = 1;

fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS scan_meta_cache(
          key TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          len INTEGER NOT NULL,
          mtime_ns INTEGER NOT NULL,
          state_len INTEGER,
          state_mtime_ns INTEGER,
          meta TEXT NOT NULL,
          parent TEXT);
         CREATE TABLE IF NOT EXISTS scan_meta_cache_ver(ver INTEGER NOT NULL);",
    )
}

/// 版本不符（含无版本表）= 整表作废
fn version_ok(conn: &Connection) -> bool {
    conn.query_row("SELECT ver FROM scan_meta_cache_ver", [], |r| r.get::<_, i64>(0))
        .map(|v| v == SCAN_CACHE_VER)
        .unwrap_or(false)
}

/// 装回落盘缓存（纯逻辑，注入连接供测试）。版本不符整表不装；
/// 坏行（缺必填字段/JSON 损坏）跳过；同键取首行（表本身主键去重）。
fn load_from(conn: &Connection, cache: &mut ScanFileCache) {
    if !version_ok(conn) {
        return;
    }
    let Ok(mut stmt) = conn
        .prepare("SELECT key, kind, len, mtime_ns, state_len, state_mtime_ns, meta, parent FROM scan_meta_cache")
    else {
        return;
    };
    let Ok(mut rows) = stmt.query([]) else { return };
    while let Ok(Some(r)) = rows.next() {
        let (Ok(key), Ok(kind)) = (r.get::<_, String>(0), r.get::<_, String>(1)) else { continue };
        let (Ok(len), Ok(mtime_ns)) = (r.get::<_, i64>(2), r.get::<_, i64>(3)) else { continue };
        let sig = FileSig {
            len: len as u64,
            mtime_ns,
        };
        let Ok(meta_json) = r.get::<_, String>(6) else { continue };
        let Ok(meta) = serde_json::from_str::<SessionMetaDto>(&meta_json) else { continue };
        let parent = r.get::<_, Option<String>>(7).ok().flatten();
        match kind.as_str() {
            "plain" => {
                cache.plain.entry(key).or_insert((sig, meta));
            }
            "chained" => {
                cache.chained.entry(key).or_insert((sig, meta, parent));
            }
            "kimi" => {
                let state = match (
                    r.get::<_, Option<i64>>(4).ok().flatten(),
                    r.get::<_, Option<i64>>(5).ok().flatten(),
                ) {
                    (Some(l), Some(m)) => Some(FileSig {
                        len: l as u64,
                        mtime_ns: m,
                    }),
                    _ => None,
                };
                cache.kimi.entry(key).or_insert((sig, state, meta));
            }
            "snapshot" => {
                cache.snapshot.entry(key).or_insert((sig, meta));
            }
            "kimi_snapshot" => {
                cache.kimi_snapshot.entry(key).or_insert((sig, meta));
            }
            _ => {} // 未知 kind（未来版本写的）：跳过，不误装
        }
    }
}

/// 整表落盘（纯逻辑，注入连接供测试）：先清后写，单事务。表内容 = 本轮扫描后的
/// 缓存快照，天然不含已删除文件的键。
fn save_to(conn: &Connection, cache: &ScanFileCache) -> rusqlite::Result<()> {
    ensure_table(conn)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM scan_meta_cache", [])?;
    tx.execute("DELETE FROM scan_meta_cache_ver", [])?;
    tx.execute(
        "INSERT INTO scan_meta_cache_ver (ver) VALUES (?1)",
        params![SCAN_CACHE_VER],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO scan_meta_cache
             (key, kind, len, mtime_ns, state_len, state_mtime_ns, meta, parent)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        let mut row = |key: &str,
                       kind: &str,
                       sig: &FileSig,
                       state: Option<&FileSig>,
                       meta: &SessionMetaDto,
                       parent: Option<&str>|
         -> rusqlite::Result<()> {
            let meta_json = serde_json::to_string(meta)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            stmt.execute(params![
                key,
                kind,
                sig.len as i64,
                sig.mtime_ns,
                state.map(|s| s.len as i64),
                state.map(|s| s.mtime_ns),
                meta_json,
                parent,
            ])?;
            Ok(())
        };
        for (k, (sig, meta)) in &cache.plain {
            row(k, "plain", sig, None, meta, None)?;
        }
        for (k, (sig, meta, parent)) in &cache.chained {
            row(k, "chained", sig, None, meta, parent.as_deref())?;
        }
        for (k, (sig, state, meta)) in &cache.kimi {
            row(k, "kimi", sig, state.as_ref(), meta, None)?;
        }
        for (k, (sig, meta)) in &cache.snapshot {
            row(k, "snapshot", sig, None, meta, None)?;
        }
        for (k, (sig, meta)) in &cache.kimi_snapshot {
            row(k, "kimi_snapshot", sig, None, meta, None)?;
        }
    }
    tx.commit()
}

/// app.db 连接（打开/建表失败 = 本次落盘停用，静默）
fn app_conn() -> Option<Connection> {
    let conn = crate::sessions::open_db().ok()?;
    ensure_table(&conn).ok()?;
    Some(conn)
}

/// 新进程首轮扫描前装回落盘缓存（每进程一次；失败静默跳过——等价于没有缓存）。
/// 必须在拿到 SCAN_FILE_CACHE 锁之后、任何 section 消费缓存表之前调用。
pub(crate) fn load_once(cache: &mut ScanFileCache) {
    if LOADED.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(conn) = app_conn() {
        load_from(&conn, cache);
    }
}

/// 首轮扫描后整表落盘（每进程一次）。out 为空是异常态（home 都没了），不落——
/// 防止把好数据清成空表。
pub(crate) fn save_once(cache: &ScanFileCache, out_len: usize) {
    if SAVED.swap(true, Ordering::SeqCst) || out_len == 0 {
        return;
    }
    if let Some(conn) = app_conn() {
        let _ = save_to(&conn, cache);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(agent: &str, sid: &str) -> SessionMetaDto {
        SessionMetaDto {
            agent: agent.into(),
            session_id: sid.into(),
            project_path: "/p".into(),
            cwd: Some("/p".into()),
            title: Some("t".into()),
            created_at: Some("2026-10-16T00:00:00Z".into()),
            updated_at: None,
            file_path: "/p/f.jsonl".into(),
            token_usage: None,
            cli_version: None,
            pinned: false,
            archived: false,
            custom_title: None,
            tags: vec![],
            alive: true,
            chain_count: 1,
            workspace: None,
            step_name: None,
            summary: None,
            live: false,
            source: "cli".into(),
            internal: false,
            handoff_from_agent: None,
            handoff_from_session: None,
            task_id: None,
            task_name: None,
            provider: None,
            profile_id: None,
        }
    }

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_table(&conn).unwrap();
        conn
    }

    #[test]
    fn 五表往返一致() {
        let conn = mem_conn();
        let mut src = ScanFileCache::default();
        src.plain.insert(
            "k-plain".into(),
            (FileSig { len: 1, mtime_ns: 2 }, meta("claude-code", "a")),
        );
        src.chained.insert(
            "k-chain".into(),
            (FileSig { len: 3, mtime_ns: 4 }, meta("codex", "b"), Some("parent-1".into())),
        );
        src.kimi.insert(
            "k-kimi".into(),
            (
                FileSig { len: 5, mtime_ns: 6 },
                Some(FileSig { len: 7, mtime_ns: 8 }),
                meta("kimi", "c"),
            ),
        );
        src.snapshot.insert(
            "k-snap".into(),
            (FileSig { len: 9, mtime_ns: 10 }, meta("grok", "d")),
        );
        src.kimi_snapshot.insert(
            "k-ksnap".into(),
            (FileSig { len: 11, mtime_ns: 12 }, meta("kimi", "e")),
        );
        save_to(&conn, &src).unwrap();

        let mut dst = ScanFileCache::default();
        load_from(&conn, &mut dst);
        assert_eq!(dst.plain.len(), 1);
        assert_eq!(dst.plain["k-plain"].0.len, 1);
        assert_eq!(dst.plain["k-plain"].1.session_id, "a");
        assert_eq!(dst.chained["k-chain"].2.as_deref(), Some("parent-1"));
        assert_eq!(dst.kimi["k-kimi"].1.as_ref().unwrap().mtime_ns, 8);
        assert_eq!(dst.snapshot["k-snap"].1.agent, "grok");
        assert_eq!(dst.kimi_snapshot["k-ksnap"].1.session_id, "e");
    }

    #[test]
    fn 版本不符整表不装() {
        let conn = mem_conn();
        // 手工写一份「旧版本」数据：只有 meta 表、没有版本表
        conn.execute(
            "INSERT INTO scan_meta_cache (key, kind, len, mtime_ns, state_len, state_mtime_ns, meta, parent)
             VALUES ('stale', 'plain', 1, 1, NULL, NULL, '{}', NULL)",
            [],
        )
        .unwrap();
        let mut dst = ScanFileCache::default();
        load_from(&conn, &mut dst);
        assert!(dst.plain.is_empty(), "无版本戳 = 整表作废");

        // 正常 save 写入当前版本后可装回；改坏版本号后再次整表失效
        let mut src = ScanFileCache::default();
        src.plain.insert(
            "good".into(),
            (FileSig { len: 1, mtime_ns: 2 }, meta("claude-code", "x")),
        );
        save_to(&conn, &src).unwrap();
        let mut dst2 = ScanFileCache::default();
        load_from(&conn, &mut dst2);
        assert_eq!(dst2.plain.len(), 1);

        conn.execute("UPDATE scan_meta_cache_ver SET ver = 999", []).unwrap();
        let mut dst3 = ScanFileCache::default();
        load_from(&conn, &mut dst3);
        assert!(dst3.plain.is_empty(), "版本不符 = 整表作废，且旧行残留无害（下轮 save 全表重写）");
    }

    #[test]
    fn 坏行与未知kind跳过且清表生效() {
        let conn = mem_conn();
        // 先落当前版本戳，让行级容错真正被测到（而不是被版本闸门整表挡掉）
        conn.execute(
            "INSERT INTO scan_meta_cache_ver (ver) VALUES (?1)",
            params![SCAN_CACHE_VER],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO scan_meta_cache (key, kind, len, mtime_ns, state_len, state_mtime_ns, meta, parent)
             VALUES ('bad', 'plain', 1, 1, NULL, NULL, '{不是json', NULL),
                    ('future', 'new-kind', 1, 1, NULL, NULL, '{}', NULL)",
            [],
        )
        .unwrap();
        let mut dst = ScanFileCache::default();
        load_from(&conn, &mut dst);
        assert!(dst.plain.is_empty(), "坏行与未知 kind 都不该装进缓存");

        // 再存一份好数据：整表替换，坏行残留被清掉
        let mut src = ScanFileCache::default();
        src.plain.insert(
            "good".into(),
            (FileSig { len: 1, mtime_ns: 2 }, meta("claude-code", "x")),
        );
        save_to(&conn, &src).unwrap();
        let mut dst2 = ScanFileCache::default();
        load_from(&conn, &mut dst2);
        assert_eq!(dst2.plain.len(), 1);
        assert!(dst2.plain.contains_key("good"));
    }
}
