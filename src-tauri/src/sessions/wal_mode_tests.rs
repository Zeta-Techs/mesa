use super::*;

#[test]
fn ensure_wal_mode_switches_once_and_persists() {
    let path = std::env::temp_dir().join(format!("ccode-wal-{}.db", uuid::Uuid::new_v4()));
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE t(x INTEGER);").unwrap();
    let mode = |c: &Connection| c.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0)).unwrap();
    assert_eq!(mode(&conn), "delete");
    ensure_wal_mode(&conn);
    ensure_wal_mode(&conn);
    assert_eq!(mode(&conn), "wal");
    // 写进库文件：新连接不用再设
    let again = Connection::open(&path).unwrap();
    assert_eq!(mode(&again), "wal");
    // 写事务进行中，读连接立刻读到提交前的数据、不被挡
    conn.execute_batch("INSERT INTO t VALUES (1); BEGIN IMMEDIATE; INSERT INTO t VALUES (2);").unwrap();
    again.busy_timeout(std::time::Duration::from_millis(0)).unwrap();
    let n: i64 = again.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    conn.execute_batch("ROLLBACK").unwrap();
    drop((conn, again));
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
    }
}
