//! 本机文件持久化原语：跨进程读改写锁、私有临时文件、安全替换。
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 配置根目录（`<平台配置目录>/ccode`）。网关、绑定、密钥、锁、各 agent 的全局配置
/// 全从这里派生，所以「测试不碰真实配置」只需要在这一处成立。
///
/// 测试里由 `ProfileStore::new_for_test` 重定向到临时目录（见 `use_test_config_root`）。
/// 2026-09-26 之前这里没有一个统一入口：`ProfileStore` 只把 `profiles.json` 挪进了临时
/// 目录，`gateway_store` 的自由函数和 `keys_path()` 照旧读写真配置目录——于是每跑一轮
/// `cargo test` 就往真实 `gateways.json` 里塞 4 条 `api.example.com` 假网关（实测累计 68 条），
/// 而且 `ensure_split_locked` 的密钥认领分支还可能改写真实 `keys.json`。
pub(crate) fn config_root() -> Option<PathBuf> {
    test_config_root().or_else(|| dirs::config_dir().map(|dir| dir.join("ccode")))
}

#[cfg(test)]
fn test_config_root() -> Option<PathBuf> {
    TEST_CONFIG_ROOT.with(|root| root.borrow().last().cloned())
}

/// 生产构建里没有重定向这回事：编译期就返回 None，运行期零开销。
#[cfg(not(test))]
fn test_config_root() -> Option<PathBuf> {
    None
}

#[cfg(test)]
thread_local! {
    /// 当前线程的测试配置根覆盖栈。用栈而不是单值，是为了嵌套构造
    /// （测试内再建一个 store）也能正确回退到外层。
    static TEST_CONFIG_ROOT: std::cell::RefCell<Vec<PathBuf>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// 持有配置根覆盖的守卫，drop 时弹回上一层。
///
/// 线程局部 + RAII 两重保证，是为了两种跑法都对：并行（libtest 每个测试一个线程）
/// 时各线程互不干扰；`--test-threads=1` 时靠 drop 把根还给下一个测试，
/// 不会让某个测试的临时目录漏给后续用例。
/// 这是**测试专用**接缝，生产侧没有对应的「切换配置根」能力。
#[cfg(test)]
pub(crate) struct TestConfigRoot {
    /// 是否接管了一层覆盖：`inert_config_root()` 造的守卫不能弹栈，
    /// 否则会替别人把根还回去。
    owned: bool,
}

#[cfg(test)]
impl TestConfigRoot {
    pub(crate) const INERT: Self = Self { owned: false };

    pub(crate) fn redirect_to(dir: &Path) -> Self {
        TEST_CONFIG_ROOT.with(|root| root.borrow_mut().push(dir.to_path_buf()));
        Self { owned: true }
    }
}

#[cfg(test)]
impl Drop for TestConfigRoot {
    fn drop(&mut self) {
        if self.owned {
            TEST_CONFIG_ROOT.with(|root| {
                root.borrow_mut().pop();
            });
        }
    }
}

/// 挂在 `ProfileStore` 上的守卫字段类型。生产构建下是零大小占位，
/// 这样 `profiles.rs` 的构造字面量不必写成两份 cfg 分叉。
#[cfg(test)]
pub(crate) type ConfigRootGuard = TestConfigRoot;
#[cfg(not(test))]
pub(crate) type ConfigRootGuard = ();

/// 不接管任何覆盖的守卫：生产构造用，以及测试里刻意不带隔离的构造用。
/// 构造函数的字面量要有个值填进字段，这就是那个值。
#[cfg(test)]
pub(crate) fn inert_config_root() -> ConfigRootGuard {
    TestConfigRoot::INERT
}

#[cfg(not(test))]
pub(crate) fn inert_config_root() -> ConfigRootGuard {}

/// 把配置根重定向到 `dir`，返回的守卫 drop 时还原。
#[cfg(test)]
pub(crate) fn redirect_config_root(dir: &Path) -> ConfigRootGuard {
    TestConfigRoot::redirect_to(dir)
}

pub(crate) fn config_lock(name: &str) -> Result<File, String> {
    let dir = config_root().ok_or("无法确定配置目录")?.join("locks");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    lock_at(&dir.join(format!("{name}.lock")))
}

pub(crate) fn lock_at(path: &Path) -> Result<File, String> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("打开文件锁失败：{e}"))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(e) => return Err(format!("配置正在被其他实例使用或无法加锁，请稍后重试：{e}")),
        }
    }
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8], private: bool) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".ccode-write-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        if !private {
            if let Ok(meta) = fs::metadata(path) {
                fs::set_permissions(&tmp, meta.permissions()).map_err(|e| e.to_string())?;
            }
        }
        drop(file);
        replace(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("保存 {} 失败：{e}", path.display()))
}

pub(crate) fn replace(tmp: &Path, path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // MoveFileEx 对只读目标拒绝；仅临时调整属性，不删除原文件。
        let original = fs::metadata(path).ok().map(|m| m.permissions());
        let readonly = original.as_ref().is_some_and(|p| p.readonly());
        if readonly {
            let mut writable = original.clone().unwrap();
            writable.set_readonly(false);
            fs::set_permissions(path, writable).map_err(|e| e.to_string())?;
        }
        let mut attempt = 0;
        let result = loop {
            match fs::rename(tmp, path) {
                Ok(()) => break Ok(()),
                Err(e) => match replace_retry_delay(e.raw_os_error(), attempt) {
                    Some(delay) => {
                        std::thread::sleep(delay);
                        attempt += 1;
                    }
                    None => break Err(e),
                },
            }
        };
        if readonly {
            if let Some(permissions) = original {
                let _ = fs::set_permissions(path, permissions);
            }
        }
        return result.map_err(|e| e.to_string());
    }
    #[cfg(not(windows))]
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

/// Windows 上 rename 的瞬时失败码：5 拒绝访问 / 32 共享冲突 / 33 锁冲突——
/// Defender、索引器、OneDrive 同步或 Office 刚好打开目标文件时的典型表现，稍等即可成功。
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const TRANSIENT_REPLACE_ERRORS: [i32; 3] = [5, 32, 33];
/// 重试退避（毫秒）：首次失败后最多再试这么多次，总等待约 0.7s，有界不死等
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const REPLACE_BACKOFF_MS: [u64; 5] = [30, 60, 120, 200, 250];

/// 第 attempt 次（从 0 计）失败后是否重试、等多久；非瞬时错误或次数用尽返回 None
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn replace_retry_delay(raw_os_error: Option<i32>, attempt: usize) -> Option<std::time::Duration> {
    let code = raw_os_error?;
    if !TRANSIENT_REPLACE_ERRORS.contains(&code) {
        return None;
    }
    REPLACE_BACKOFF_MS
        .get(attempt)
        .map(|ms| std::time::Duration::from_millis(*ms))
}

// ===== 有界读取（慢/无响应文件系统防线） =====
//
// 背景（2026-09-13 实证，2026-09-26 补产品侧）：注册项目的 `.ccode/project.toml` 若落在
// 无响应的文件系统上——iCloud 「桌面与文档」处于未落地态、网络盘断连——`open()` 会在内核里
// 阻塞，连 `O_NONBLOCK` 都堵。当时只修了测试侧（`projects::project_roots_and_resources` 加
// `cfg!(test)` 空返回），产品侧没修：`list_projects_in` 回填 id、PDF/citation 白名单聚合都会
// 同步读每个注册项目的档案卡，任一个卡住就把项目列表/引用检查/PDF 预览整个挂死。
//
// 为什么超时必须靠「换线程」：阻塞发生在 syscall 内部，Rust 侧没有任何可中断点，
// 原线程上的 deadline 永远等不到。只能把读放到别的线程、调用方按时放弃等待。
// 放弃等待**不等于**那个线程结束了——它会一直挂在 syscall 上直到文件系统恢复。
// 所以同一路径超时后进 `stuck_reads`，后续调用直接返回 `StillStuck` 而不新起线程，
// 否则前端每轮询一次就多一组挂死线程（2s 轮询、2 个坏路径 = 一小时 3600 个）。
// 线程读完会置 done 标志，下次调用据此把路径移出表——文件系统恢复后自动重新可读。

/// 有界读取的结果。三档失败必须分开：只有 `TimedOut`/`StillStuck` 是环境病，
/// `Unreadable` 是普通的文件不存在/权限问题，混在一起会让日志指向错误的因果。
#[derive(Debug)]
pub(crate) enum BoundedRead {
    Ok(String),
    /// 文件不存在或读不出（普通 I/O 错误）。
    Unreadable,
    /// 超时：路径所在文件系统无响应。线程仍挂在 syscall 上，路径已记入 `stuck_reads`。
    TimedOut,
    /// 该路径此前的读取仍未返回，本次没有新起线程（避免线程无界增长）。
    StillStuck,
}

impl BoundedRead {
    /// 取到内容，否则 None。调用方沿用原有「读不到就跳过」语义时用这个。
    pub(crate) fn text(&self) -> Option<&str> {
        match self {
            BoundedRead::Ok(text) => Some(text),
            _ => None,
        }
    }
}

/// 已判定卡住、线程仍在 syscall 里的路径；值是「该线程已读完」标志。
/// 只在**超时之后**才留在这里，所以表的大小上界是「同时卡住的路径数」。
fn stuck_reads() -> &'static Mutex<HashMap<PathBuf, Arc<AtomicBool>>> {
    static STUCK: OnceLock<Mutex<HashMap<PathBuf, Arc<AtomicBool>>>> = OnceLock::new();
    STUCK.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stuck_guard() -> std::sync::MutexGuard<'static, HashMap<PathBuf, Arc<AtomicBool>>> {
    // 锁只护着一张记账表，中毒也不该让整个读取路径失败：取回内部值继续用。
    stuck_reads().lock().unwrap_or_else(|e| e.into_inner())
}

/// 一次在飞的读取（`read_many_within` 用，避免逐个阻塞等待）。
struct InFlight {
    path: PathBuf,
    done: Arc<AtomicBool>,
    rx: std::sync::mpsc::Receiver<std::io::Result<String>>,
}

/// 起读一个路径。返回 None = 该路径此前已卡住且线程未返回，调用方不得再起一个。
fn begin_read<F>(path: &Path, read: Arc<F>) -> Option<InFlight>
where
    F: Fn(&Path) -> std::io::Result<String> + Send + Sync + 'static,
{
    {
        let mut stuck = stuck_guard();
        match stuck.get(path) {
            // 已卡住且线程没回来：不再新起线程。
            Some(done) if !done.load(Ordering::SeqCst) => return None,
            // 线程回来了：文件系统已恢复，移出记账表后正常起读。
            Some(_) => {
                stuck.remove(path);
            }
            None => {}
        }
    }
    let done = Arc::new(AtomicBool::new(false));
    let thread_done = Arc::clone(&done);
    let owned = path.to_path_buf();
    let thread_path = owned.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = read(&thread_path);
        // 先发送再置标志：观察者看到标志为真，就能确定值已在通道里，
        // 于是那条「超时与读完的竞态」分支可以无阻塞地收回来。
        let _ = tx.send(result);
        thread_done.store(true, Ordering::SeqCst);
    });
    Some(InFlight {
        path: owned,
        done,
        rx,
    })
}

/// 收一个在飞读取的结果，最多等 `remaining`。
fn finish_read(flight: InFlight, remaining: Duration) -> BoundedRead {
    match flight.rx.recv_timeout(remaining) {
        Ok(Ok(text)) => {
            stuck_guard().remove(&flight.path);
            BoundedRead::Ok(text)
        }
        Ok(Err(_)) => {
            stuck_guard().remove(&flight.path);
            BoundedRead::Unreadable
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // 超时与「线程刚好读完」之间有个窗口：超时返回不代表线程还挂在 syscall 上。
            // 拿着标志在锁下判定，避免把一个已经读完的路径永久留在记账表里
            //（留在这里的代价是它再也不会被重新读取）。
            let mut stuck = stuck_guard();
            if flight.done.load(Ordering::SeqCst) {
                // 标志为真 ⇒ 值已在通道里（发送先于置标志），直接取回不阻塞。
                drop(stuck);
                let outcome = match flight.rx.try_recv() {
                    Ok(Ok(text)) => BoundedRead::Ok(text),
                    _ => BoundedRead::Unreadable,
                };
                stuck_guard().remove(&flight.path);
                outcome
            } else {
                // 真卡住：线程仍挂在 syscall 上，留在表里。
                // 后续调用直接 StillStuck，不会为同一路径反复新起挂死线程。
                stuck.insert(flight.path.clone(), Arc::clone(&flight.done));
                BoundedRead::TimedOut
            }
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            stuck_guard().remove(&flight.path);
            BoundedRead::Unreadable
        }
    }
}

/// 注入读取函数的单路径有界读。**仅测试用**：生产侧没有单路径调用方——
/// 调用方正在操作的那个项目挂住是合理的（用户在等它），要防的是**聚合**遍历
/// （一个坏路径拖垮整批），那是 `read_many_within`。这里存在只为让测试能模拟
/// 「永不返回的读」，不必真造一个坏文件系统。
#[cfg(test)]
fn read_within_using<F>(path: &Path, timeout: Duration, read: F) -> BoundedRead
where
    F: Fn(&Path) -> std::io::Result<String> + Send + Sync + 'static,
{
    match begin_read(path, Arc::new(read)) {
        Some(flight) => finish_read(flight, timeout),
        None => BoundedRead::StillStuck,
    }
}

/// 读多个路径，**总时长不随路径数增长**：所有读同时起，共享同一个 `budget`。
/// 逐个 `read_to_string_within` 会让「N 个坏路径」把等待变成 N×timeout，
/// 前端每轮询一次就卡这么久。返回顺序与入参一致。
pub(crate) fn read_many_within(paths: &[PathBuf], budget: Duration) -> Vec<BoundedRead> {
    read_many_using(paths, budget, |p| fs::read_to_string(p))
}

fn read_many_using<F>(paths: &[PathBuf], budget: Duration, read: F) -> Vec<BoundedRead>
where
    F: Fn(&Path) -> std::io::Result<String> + Send + Sync + 'static,
{
    let deadline = Instant::now() + budget;
    let read = Arc::new(read);
    // 第一遍：全部起读（`None` = 该路径已卡住，不再新起线程）。
    let slots: Vec<Option<InFlight>> = paths
        .iter()
        .map(|path| begin_read(path, Arc::clone(&read)))
        .collect();
    // 第二遍：按**剩余总预算**逐个收，所以总时长上界是 budget 而不是 N×budget。
    slots
        .into_iter()
        .map(|slot| match slot {
            Some(flight) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                finish_read(flight, remaining)
            }
            None => BoundedRead::StillStuck,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 原子替换重试：只认瞬时错误码、次数有界、退避递增
    #[test]
    fn replace_retry_only_transient_and_bounded() {
        for code in [5, 32, 33] {
            assert_eq!(
                replace_retry_delay(Some(code), 0),
                Some(std::time::Duration::from_millis(30))
            );
        }
        // 非瞬时错误（如 2 文件不存在、183 已存在）与无系统码：不重试
        assert_eq!(replace_retry_delay(Some(2), 0), None);
        assert_eq!(replace_retry_delay(Some(183), 0), None);
        assert_eq!(replace_retry_delay(None, 0), None);
        // 有界：总尝试 = 1 + 退避次数，用尽即放弃，不死循环
        let delays: Vec<_> = (0..20)
            .map_while(|i| replace_retry_delay(Some(32), i))
            .collect();
        assert_eq!(delays.len(), REPLACE_BACKOFF_MS.len());
        assert!(delays.windows(2).all(|w| w[0] <= w[1]), "退避应单调不减");
        assert!(delays.iter().map(|d| d.as_millis()).sum::<u128>() < 1000);
    }

    #[test]
    fn concurrent_read_modify_write_lock_preserves_both_updates() {
        let dir = std::env::temp_dir().join(format!("ccode-lock-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let value = dir.join("value");
        atomic_write(&value, b"0", false).unwrap();
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        let _guard = lock_at(&dir.join("state.lock")).unwrap();
                        let path = dir.join("value");
                        let n: u32 = fs::read_to_string(&path).unwrap().parse().unwrap();
                        atomic_write(&path, (n + 1).to_string().as_bytes(), false).unwrap();
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(fs::read_to_string(value).unwrap(), "40");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_replace_leaves_old_file_on_failure_and_no_temporary_residue() {
        let dir = std::env::temp_dir().join(format!("ccode-storage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("file");
        atomic_write(&path, b"old", false).unwrap();
        atomic_write(&path, b"new", false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(replace(&dir.join("missing"), &path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn preserves_executable_mode_and_private_mode_from_creation() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("ccode-mode-{}", uuid::Uuid::new_v4()));
        let path = dir.join("file");
        atomic_write(&path, b"one", true).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        atomic_write(&path, b"two", false).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o755
        );
        atomic_write(&path, b"private", true).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(dir).unwrap();
    }

    // ===== 有界读取 =====
    //
    // 这些用例都用**唯一路径**（不进真实文件系统时不共享 stuck_reads 记账表），
    // 且模拟卡住时用「等释放信号」而不是 `sleep(∞)`：测试结束能干净收场，
    // 不会留下挂死线程把后续用例拖住。

    fn unique(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ccode-bounded-{}-{name}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn bounded_read_returns_file_contents() {
        let dir = unique("ok");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("card.toml");
        fs::write(&path, "id = \"abc\"").unwrap();
        let got = read_within_using(&path, Duration::from_secs(5), |p| fs::read_to_string(p));
        assert_eq!(got.text(), Some("id = \"abc\""));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bounded_read_reports_missing_file_as_unreadable_not_stuck() {
        // 不存在 ≠ 卡住：前者是普通 I/O 错误，后者是环境病。混成一档会让日志
        // 把「文件没有」说成「文件系统无响应」，指向错误的因果。
        let path = unique("missing");
        let got = read_within_using(&path, Duration::from_secs(5), |p| fs::read_to_string(p));
        assert!(matches!(got, BoundedRead::Unreadable), "实际：{got:?}");
        assert!(!got.text().is_some());
    }

    #[test]
    fn bounded_read_times_out_on_a_read_that_never_returns() {
        let path = unique("stuck");
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let gate_in_thread = Arc::clone(&gate);
        let got = read_within_using(&path, Duration::from_millis(120), move |_| {
            let (lock, cv) = &*gate_in_thread;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            Ok("终于读到了".to_string())
        });
        assert!(matches!(got, BoundedRead::TimedOut), "实际：{got:?}");
        // 放行挂着的线程，避免它对后续用例（共享记账表）产生干扰
        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }

    #[test]
    fn bounded_read_does_not_start_a_second_thread_for_a_stuck_path() {
        // 这是记账表存在的**直接原因**：前端按 2s 轮询，不做这层去重的话
        // 一个坏路径每小时会攒下 1800 个挂死线程。
        let path = unique("dedup");
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let gate_in_thread = Arc::clone(&gate);
        let holds = Arc::new(AtomicBool::new(false));
        let holds_in_thread = Arc::clone(&holds);

        let first = read_within_using(&path, Duration::from_millis(80), move |_| {
            let (lock, cv) = &*gate_in_thread;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            Ok("late".to_string())
        });
        assert!(matches!(first, BoundedRead::TimedOut), "首读应超时：{first:?}");

        let second = read_within_using(&path, Duration::from_millis(80), move |_| {
            holds_in_thread.store(true, Ordering::SeqCst);
            Ok("不应该被调用".to_string())
        });
        assert!(
            matches!(second, BoundedRead::StillStuck),
            "同一路径卡住时不得再起线程，实际：{second:?}"
        );
        assert!(
            !holds.load(Ordering::SeqCst),
            "第二个读取函数被调用了：说明没有去重，又起了一个线程"
        );

        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }

    #[test]
    fn bounded_read_many_shares_one_budget_across_stuck_paths() {
        // 逐个读会让 N 个坏路径把等待变成 N×timeout；共享预算则上界恒为 budget。
        // 这里 6 个坏路径 + 400ms 预算：若退化成逐个等，最少也要 6×400ms=2.4s。
        let paths: Vec<PathBuf> = (0..6).map(|i| unique(&format!("many-{i}"))).collect();
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let gate_in_thread = Arc::clone(&gate);
        let start = Instant::now();
        let results = read_many_using(&paths, Duration::from_millis(400), move |_| {
            let (lock, cv) = &*gate_in_thread;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            Ok("late".to_string())
        });
        let elapsed = start.elapsed();
        assert_eq!(results.len(), paths.len(), "返回数量应与入参一致");
        assert!(
            results.iter().all(|r| matches!(r, BoundedRead::TimedOut)),
            "全部应为超时"
        );
        assert!(
            elapsed < Duration::from_millis(1200),
            "总耗时 {elapsed:?} 超出共享预算（退化成了逐个等待？）"
        );
        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }

    #[test]
    fn bounded_read_recovers_once_the_stuck_thread_finishes() {
        // 恢复必须是自动的：线程读完置标志，下次调用据此把路径移出记账表。
        // 否则一次 iCloud 抖动会让该项目**永久**读不到（只剩重启一条路）。
        let dir = unique("recover");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("card.toml");
        fs::write(&path, "id = \"恢复\"").unwrap();

        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let gate_in_thread = Arc::clone(&gate);
        let stuck_path = path.clone();
        let first = read_within_using(&path, Duration::from_millis(60), move |_| {
            let (lock, cv) = &*gate_in_thread;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            fs::read_to_string(&stuck_path)
        });
        assert!(matches!(first, BoundedRead::TimedOut), "首次应超时：{first:?}");

        // 放行挂着的线程并等它真正脱离 syscall
        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_all();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if !stuck_guard().contains_key(&path) {
                break;
            }
            // 记账表清理由下一次 begin_read 触发，这里直接调一次读取来推进
            let _ = read_within_using(&path, Duration::from_millis(50), |p| fs::read_to_string(p));
        }

        let after = read_within_using(&path, Duration::from_secs(5), |p| fs::read_to_string(p));
        assert_eq!(
            after.text(),
            Some("id = \"恢复\""),
            "线程读完后该路径应重新可读（自动恢复），实际：{after:?}"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

/// 网络响应的实际解压字节预算，不能只相信 Content-Length。
pub(crate) async fn response_bytes(
    mut response: reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|len| len > cap as u64)
    {
        return Err(format!("响应超过 {} MB 安全上限", cap / 1024 / 1024));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?
    {
        if chunk.len() > cap.saturating_sub(bytes.len()) {
            return Err(format!("响应超过 {} MB 安全上限", cap / 1024 / 1024));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
