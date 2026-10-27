use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

// 端口运行时监控：列出本机 LISTEN 端口（号/协议/pid/进程名/cwd），标注归属
// （工作区 worktree / 注册项目 / CCODE_PORT 分配段 / 系统其他），支持一键终止。
// 面向科研场景：工作区里跑 jupyter / quarto preview / 本地服务后查谁占了哪个端口。
// 归属判定只读（lsof/netstat + app.db）；kill 前重新校验该 pid 仍是监听进程，防 pid 复用误杀。

// ===== DTO =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfoDto {
    pub port: u16,
    pub protocol: String, // v1 只收 TCP
    pub pid: u32,
    pub process: String,
    /// 进程工作目录（Windows 无轻量获取手段，恒为 None）
    pub cwd: Option<String>,
    /// workspace | project | range | other
    pub owner_kind: String,
    /// 白话归属文案，前端直接展示
    pub owner_label: String,
}

#[derive(Debug, Clone, PartialEq)]
struct Listener {
    pid: u32,
    process: String,
    port: u16,
    protocol: String,
}

// ===== 子进程执行（同 workspaces.rs run_cmd_full 模式：双流读空防管道死锁 + 超时 kill） =====

/// 返回 (是否退出码 0, stdout, stderr)；超时 kill 后报错
fn run_capture(
    mut cmd: crate::process::BackgroundCommand,
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("无法启动进程: {e}"))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stdout.take() {
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stderr.take() {
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
        }
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = out_handle.join().unwrap_or_default();
                let err = err_handle.join().unwrap_or_default();
                return Ok((
                    status.success(),
                    String::from_utf8_lossy(&out).into_owned(),
                    String::from_utf8_lossy(&err).into_owned(),
                ));
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_handle.join();
                    let _ = err_handle.join();
                    return Err("读取端口列表超时".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待进程失败: {e}")),
        }
    }
}

// ===== 输出解析（纯函数，平台无关，可直接测试） =====

/// 解析 `lsof +c 0 -nP -iTCP -sTCP:LISTEN` 输出。
/// 列：COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME；末列为 `地址:端口 (LISTEN)`。
/// 防御式：表头/截断行/未知格式一律跳过；同 (pid, port) 的 IPv4/IPv6 双栈行合并为一条。
// 运行路径仅 unix（Windows 走 netstat）；测试跨平台喂样本文本
#[cfg_attr(not(any(unix, test)), allow(dead_code))]
fn parse_lsof_listeners(text: &str) -> Vec<Listener> {
    let mut out: Vec<Listener> = Vec::new();
    for line in text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // 监听行的最后一个 token 固定是 "(LISTEN)"，地址:端口 在倒数第二列
        if tokens.len() < 3 || tokens[tokens.len() - 1] != "(LISTEN)" {
            continue;
        }
        let Ok(pid) = tokens[1].parse::<u32>() else {
            continue;
        };
        let name = tokens[tokens.len() - 2];
        let Some(port_str) = name.rsplit(':').next() else {
            continue;
        };
        let Ok(port) = port_str.parse::<u16>() else {
            continue;
        };
        if out.iter().any(|l| l.pid == pid && l.port == port) {
            continue;
        }
        out.push(Listener {
            pid,
            process: tokens[0].to_string(),
            port,
            protocol: "TCP".into(),
        });
    }
    out
}

/// 解析 `netstat -ano -p tcp` / `-p tcpv6`（Windows）：监听行取本地端口与 pid。
/// 只按列位置判定，不认本地化文字：状态列在德/法等语言版 Windows 上会被翻译（如 ABHÖREN），
/// 而监听套接字的外部地址端口恒为 0（`0.0.0.0:0` / `[::]:0`），以此作为语言无关的判据。
/// cfg：生产路径仅 Windows 调用；保留 test 变体让解析测试在 unix CI 上也能跑
#[cfg(any(windows, test))]
fn parse_netstat_listeners(text: &str) -> Vec<Listener> {
    let mut out: Vec<Listener> = Vec::new();
    for line in text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // 列：协议 本地地址 外部地址 状态 PID
        if tokens.len() != 5 || !tokens[0].eq_ignore_ascii_case("tcp") {
            continue;
        }
        let listening = tokens[3].eq_ignore_ascii_case("listening")
            || tokens[2].rsplit(':').next() == Some("0");
        if !listening {
            continue;
        }
        let Ok(pid) = tokens[4].parse::<u32>() else {
            continue;
        };
        let Some(port_str) = tokens[1].rsplit(':').next() else {
            continue;
        };
        let Ok(port) = port_str.parse::<u16>() else {
            continue;
        };
        if port == 0 || out.iter().any(|l| l.pid == pid && l.port == port) {
            continue;
        }
        out.push(Listener {
            pid,
            process: String::new(), // 进程名由 tasklist 补
            port,
            protocol: "TCP".into(),
        });
    }
    out
}

/// 解析 `tasklist /fo csv /nh`（Windows）："name.exe","pid",... → pid → 进程名
#[cfg(any(windows, test))]
fn parse_tasklist(text: &str) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() < 2 {
            continue;
        }
        let name = fields[0].trim_matches('"');
        let Ok(pid) = fields[1].trim_matches('"').parse::<u32>() else {
            continue;
        };
        out.insert(pid, name.to_string());
    }
    out
}

// ===== 平台采集 =====

#[cfg(unix)]
fn lsof_path() -> Option<PathBuf> {
    if let Some(p) = crate::agents::resolve_binary("lsof") {
        return Some(p);
    }
    // GUI 短 PATH 兜底：lsof 是系统工具，查固定候选（macOS /usr/sbin，Linux 常在 /usr/bin）
    ["/usr/sbin/lsof", "/usr/bin/lsof", "/bin/lsof"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

#[cfg(unix)]
fn collect_listeners() -> Result<Vec<Listener>, String> {
    let lsof = lsof_path().ok_or("找不到 lsof（端口列表依赖它）")?;
    let mut cmd = crate::process::background_command(lsof);
    // +c 0：进程名不截断；-nP：不做主机/端口名解析（快且输出稳定）
    cmd.args(["+c", "0", "-nP", "-iTCP", "-sTCP:LISTEN"]);
    let (ok, out, err) = run_capture(cmd, Duration::from_secs(15))?;
    if !ok {
        // lsof 无匹配监听时退出码 1 且无输出——视为空列表而非错误
        if out.trim().is_empty() {
            return Ok(Vec::new());
        }
        return Err(format!("lsof 执行失败: {}", err.trim()));
    }
    Ok(parse_lsof_listeners(&out))
}

/// Windows：netstat 取端口/pid，tasklist 补进程名；cwd 无轻量等价接口，v1 不取（段归属仍可用）
#[cfg(windows)]
fn collect_listeners() -> Result<Vec<Listener>, String> {
    // netstat/tasklist 是 System32 系统组件（同 workspaces.rs 的 cmd），不经 resolve_binary
    // `-p tcp` 只列 IPv4；Node 17+ 的 localhost 默认绑 [::1]，必须再查 tcpv6 才看得见
    let mut text = String::new();
    for proto in ["tcp", "tcpv6"] {
        let mut cmd = crate::process::background_command("netstat");
        cmd.args(["-ano", "-p", proto]);
        let (ok, out, err) = run_capture(cmd, Duration::from_secs(15))?;
        if !ok {
            return Err(format!("netstat 执行失败: {}", err.trim()));
        }
        text.push_str(&out);
        text.push('\n');
    }
    let mut listeners = parse_netstat_listeners(&text);
    let mut cmd = crate::process::background_command("tasklist");
    cmd.args(["/fo", "csv", "/nh"]);
    // tasklist 失败时保留空进程名展示，不阻断端口列表
    if let Ok((true, out, _)) = run_capture(cmd, Duration::from_secs(15)) {
        let names = parse_tasklist(&out);
        for l in &mut listeners {
            if let Some(n) = names.get(&l.pid) {
                l.process = n.clone();
            }
        }
    }
    Ok(listeners)
}

/// 进程 cwd 走 sysinfo（macOS proc_pidinfo、Linux /proc），不用 `lsof -d cwd`：
/// 打包版从访达启动没有 LANG，lsof 把中文路径转义成 `\xe7…`，归属前缀永远对不上（2026-10-27）
#[cfg(unix)]
fn cwd_map(listeners: &[Listener]) -> HashMap<u32, PathBuf> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut pids: Vec<Pid> = listeners.iter().map(|l| Pid::from_u32(l.pid)).collect();
    pids.sort_unstable();
    pids.dedup();
    if pids.is_empty() {
        return HashMap::new();
    }
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    pids.iter()
        .filter_map(|pid| {
            let cwd = sys.process(*pid)?.cwd()?;
            (!cwd.as_os_str().is_empty()).then(|| (pid.as_u32(), canon(cwd)))
        })
        .collect()
}

#[cfg(windows)]
fn cwd_map(_listeners: &[Listener]) -> HashMap<u32, PathBuf> {
    HashMap::new()
}

// ===== 归属判定 =====

struct WsOwner {
    name: String,
    path: PathBuf, // canonical
    port_base: i64,
    active: bool,
}

/// canonicalize 失败回落原路径（目录可能刚被删），前缀比较因此总能进行
fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// 归属数据源：全部工作区（cwd 判定不分状态）+ 注册项目根；读取失败降级为空，
/// 只影响标注文案，不阻断端口列表本身
fn owner_roots() -> (Vec<WsOwner>, Vec<(String, PathBuf)>) {
    let workspaces = crate::workspaces::db()
        .and_then(|conn| {
            let mut stmt = conn
                .prepare("SELECT name, worktree_path, port_base, status FROM workspaces")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            Ok(rows
                .flatten()
                .map(|(name, path, port_base, status)| WsOwner {
                    name,
                    path: canon(Path::new(&path)),
                    port_base,
                    active: status == "active",
                })
                .collect())
        })
        .unwrap_or_default();
    let projects = crate::projects::registered_project_rows()
        .into_iter()
        .map(|(path, name)| (name, canon(Path::new(&path))))
        .collect();
    (workspaces, projects)
}

/// 最长前缀命中（项目嵌套时归内层）；input 均按 canonical 处理过
fn longest_prefix<'a>(cwd: &Path, roots: &[(&'a str, &Path)]) -> Option<&'a str> {
    roots
        .iter()
        .filter(|(_, root)| cwd.starts_with(root))
        .max_by_key(|(_, root)| root.components().count())
        .map(|(name, _)| *name)
}

/// 归属优先级：cwd 落在工作区 worktree 内 → 工作区；落在注册项目内 → 项目；
/// 否则端口落在活跃工作区的 CCODE_PORT 段（port_base..=port_base+9）→ 段归属；其余系统/其他
fn attribute(
    port: u16,
    cwd: Option<&Path>,
    workspaces: &[WsOwner],
    projects: &[(String, PathBuf)],
) -> (&'static str, String) {
    if let Some(cwd) = cwd {
        let roots: Vec<(&str, &Path)> = workspaces
            .iter()
            .map(|w| (w.name.as_str(), w.path.as_path()))
            .collect();
        if let Some(name) = longest_prefix(cwd, &roots) {
            return ("workspace", format!("工作区 · {name}"));
        }
        let roots: Vec<(&str, &Path)> = projects
            .iter()
            .map(|(name, path)| (name.as_str(), path.as_path()))
            .collect();
        if let Some(name) = longest_prefix(cwd, &roots) {
            return ("project", format!("项目 · {name}"));
        }
    }
    // 端口段归属只认活跃工作区：端口 env 只对 active 下发
    let port = i64::from(port);
    if let Some(w) = workspaces
        .iter()
        .find(|w| w.active && (w.port_base..=w.port_base + 9).contains(&port))
    {
        return (
            "range",
            format!("端口段 {}–{} · {}", w.port_base, w.port_base + 9, w.name),
        );
    }
    ("other", "系统/其他".into())
}

// ===== 终止 =====

/// kill 前置校验：重新列举后该 pid 必须仍在监听——否则说明进程已退出且 pid 可能被复用，
/// 此时再发信号会误杀无关进程。纯函数，不真实 kill。
fn ensure_still_listening(listeners: &[Listener], pid: u32) -> Result<(), String> {
    if listeners.iter().any(|l| l.pid == pid) {
        Ok(())
    } else {
        Err("该进程已不在监听任何端口（可能已退出），已取消终止；请刷新列表".into())
    }
}

/// v1 只发 TERM（优雅退出）；进程不退时由用户稍候重试，不自动升级 KILL
#[cfg(unix)]
fn terminate(pid: u32) -> Result<(), String> {
    // /bin/kill 是系统组件固定路径（同 workspaces.rs 的 cmd），不经 resolve_binary
    let mut cmd = crate::process::background_command("/bin/kill");
    cmd.args(["-TERM", &pid.to_string()]);
    let (ok, _, err) = run_capture(cmd, Duration::from_secs(10))?;
    if ok {
        Ok(())
    } else {
        Err(format!("终止进程失败: {}", err.trim()))
    }
}

/// 必须 /T /F：不带 /F 的 taskkill 只向窗口发 WM_CLOSE，无窗口的控制台进程（node/python 服务）
/// 直接拒绝退出；/T 连带子进程。pid 复用已由调用方 ensure_still_listening 重新校验。
#[cfg(windows)]
fn terminate(pid: u32) -> Result<(), String> {
    let mut cmd = crate::process::background_command("taskkill");
    cmd.args(["/T", "/F", "/PID", &pid.to_string()]);
    let (ok, out, err) = run_capture(cmd, Duration::from_secs(10))?;
    if ok {
        Ok(())
    } else {
        Err(format!(
            "终止进程失败: {}",
            if err.trim().is_empty() {
                out.trim()
            } else {
                err.trim()
            }
        ))
    }
}

// ===== 命令实现 =====

fn list_impl() -> Result<Vec<PortInfoDto>, String> {
    let listeners = collect_listeners()?;
    let cwds = cwd_map(&listeners);
    let (workspaces, projects) = owner_roots();
    let mut out: Vec<PortInfoDto> = listeners
        .into_iter()
        .map(|l| {
            let cwd = cwds.get(&l.pid);
            let (kind, label) = attribute(l.port, cwd.map(|p| p.as_path()), &workspaces, &projects);
            PortInfoDto {
                port: l.port,
                protocol: l.protocol,
                pid: l.pid,
                process: l.process,
                cwd: cwd.map(|p| p.to_string_lossy().into_owned()),
                owner_kind: kind.into(),
                owner_label: label,
            }
        })
        .collect();
    out.sort_by(|a, b| a.port.cmp(&b.port).then(a.pid.cmp(&b.pid)));
    Ok(out)
}

fn kill_impl(pid: u32) -> Result<(), String> {
    if pid <= 1 {
        return Err("非法 pid，已拒绝".into());
    }
    let listeners = collect_listeners()?;
    ensure_still_listening(&listeners, pid)?;
    terminate(pid)
}

#[tauri::command]
pub async fn list_listening_ports() -> Result<Vec<PortInfoDto>, String> {
    tauri::async_runtime::spawn_blocking(list_impl)
        .await
        .map_err(|e| format!("读取端口列表失败: {e}"))?
}

#[tauri::command]
pub async fn kill_port_process(pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || kill_impl(pid))
        .await
        .map_err(|e| format!("终止进程失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listener(pid: u32, port: u16) -> Listener {
        Listener {
            pid,
            process: "node".into(),
            port,
            protocol: "TCP".into(),
        }
    }

    #[test]
    fn parses_lsof_listen_output() {
        let sample = "\
COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      81234 tz      23u  IPv6 0x8f3a1b2c4d5e6f70      0t0  TCP *:4000 (LISTEN)
node      81234 tz      24u  IPv4 0x1a2b3c4d5e6f7080      0t0  TCP 127.0.0.1:4000 (LISTEN)
python3   81299 tz       7u  IPv4 0xaabbccddeeff0011      0t0  TCP 127.0.0.1:8888 (LISTEN)
jupyter   81300 tz       9u  IPv6 0x00ffaabbccddee11      0t0  TCP [::1]:8889 (LISTEN)
bad line here
";
        let got = parse_lsof_listeners(sample);
        // 双栈同端口合并为一条；表头与畸形行跳过
        assert_eq!(
            got,
            vec![
                Listener {
                    pid: 81234,
                    process: "node".into(),
                    port: 4000,
                    protocol: "TCP".into()
                },
                Listener {
                    pid: 81299,
                    process: "python3".into(),
                    port: 8888,
                    protocol: "TCP".into()
                },
                Listener {
                    pid: 81300,
                    process: "jupyter".into(),
                    port: 8889,
                    protocol: "TCP".into()
                },
            ]
        );
    }

    #[test]
    fn parses_netstat_listen_output() {
        let sample = "\
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    0.0.0.0:4000           0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:4000         0.0.0.0:0              LISTENING       1234
  TCP    [::]:3000              [::]:0                 LISTENING       5678
  TCP    192.168.1.2:50000      10.0.0.1:443           ESTABLISHED     999
";
        let got = parse_netstat_listeners(sample);
        assert_eq!(
            got.iter().map(|l| (l.pid, l.port)).collect::<Vec<_>>(),
            vec![(1234, 4000), (5678, 3000)]
        );
    }

    #[test]
    fn parses_netstat_ipv6_and_localized_states() {
        // `-p tcp` 与 `-p tcpv6` 输出拼接；状态列为德语（ABHÖREN）时按外部端口 0 识别监听
        let sample = "\
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN         1100
  TCP    127.0.0.1:52000        127.0.0.1:52001        HERGESTELLT     2200

Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    [::1]:5173             [::]:0                 LISTENING       4321
  TCP    [::]:135               [::]:0                 ABHÖREN         1100
  TCP    [fe80::1%12]:7680      [::]:0                 LISTENING       880
  TCP    [::1]:5173             [::1]:60123            ESTABLISHED     4321
  TCP    [::1]:60123            [::1]:5173             TIME_WAIT       0
";
        let got = parse_netstat_listeners(sample);
        assert_eq!(
            got.iter().map(|l| (l.pid, l.port)).collect::<Vec<_>>(),
            vec![(1100, 135), (4321, 5173), (880, 7680)]
        );
    }

    #[test]
    fn parses_tasklist_csv() {
        let sample = "\"node.exe\",\"1234\",\"Console\",\"1\",\"120,000 K\"\n\"python.exe\",\"5678\",\"Console\",\"1\",\"80,000 K\"\n";
        let got = parse_tasklist(sample);
        assert_eq!(got.get(&1234).map(String::as_str), Some("node.exe"));
        assert_eq!(got.get(&5678).map(String::as_str), Some("python.exe"));
    }

    fn owners() -> (Vec<WsOwner>, Vec<(String, PathBuf)>) {
        (
            vec![
                WsOwner {
                    name: "lit-notes".into(),
                    path: PathBuf::from("/ws/myrepo/lit-notes"),
                    port_base: 4000,
                    active: true,
                },
                WsOwner {
                    name: "old-task".into(),
                    path: PathBuf::from("/ws/myrepo/old-task"),
                    port_base: 4010,
                    active: false,
                },
            ],
            vec![
                ("myrepo".into(), PathBuf::from("/work/myrepo")),
                ("nested".into(), PathBuf::from("/work/myrepo/sub")),
            ],
        )
    }

    #[test]
    fn attributes_by_cwd_workspace_then_project_longest_prefix() {
        let (ws, projects) = owners();
        // cwd 落在工作区 worktree 内
        assert_eq!(
            attribute(
                9999,
                Some(Path::new("/ws/myrepo/lit-notes/src")),
                &ws,
                &projects
            ),
            ("workspace", "工作区 · lit-notes".to_string())
        );
        // cwd 落在注册项目内（嵌套项目取最长前缀归内层）
        assert_eq!(
            attribute(
                9999,
                Some(Path::new("/work/myrepo/sub/data")),
                &ws,
                &projects
            ),
            ("project", "项目 · nested".to_string())
        );
        // 组件级前缀：myrepo2 不算 myrepo 的子路径
        assert_eq!(
            attribute(9999, Some(Path::new("/work/myrepo2")), &ws, &projects).0,
            "other"
        );
    }

    #[test]
    fn attributes_by_port_range_only_for_active() {
        let (ws, projects) = owners();
        // 无 cwd 命中时回落段归属（活跃工作区 4000–4009）
        assert_eq!(
            attribute(4005, Some(Path::new("/elsewhere")), &ws, &projects),
            ("range", "端口段 4000–4009 · lit-notes".to_string())
        );
        // 非活跃工作区的段不标注（端口 env 只对 active 下发）
        assert_eq!(attribute(4015, None, &ws, &projects).0, "other");
        // 段外且 cwd 无命中 → 系统/其他
        assert_eq!(
            attribute(9999, None, &ws, &projects),
            ("other", "系统/其他".to_string())
        );
    }

    #[test]
    fn kill_guard_requires_still_listening() {
        let listeners = vec![listener(100, 4000), listener(200, 8888)];
        assert!(ensure_still_listening(&listeners, 200).is_ok());
        // pid 不在监听集合（已退出/被复用）→ 拒绝
        assert!(ensure_still_listening(&listeners, 300).is_err());
        assert!(ensure_still_listening(&[], 100).is_err());
    }
}
