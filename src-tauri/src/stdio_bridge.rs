//! 原生模式的 stdio 桥（docs/design-chat-native-mode.md 公共件 1）：`mesa_helper stdio-bridge -- <CLI> <参数…>`。
//!
//! 协议模式的 CLI（Kimi `acp`、Claude `-p` 双向 stream-json）只认标准输入输出，没有终端界面。Mesa 照旧在 PTY 里起一个进程，
//! 起的是这座桥：桥连回 Mesa 在 127.0.0.1 上开的一次性监听口（地址与能力令牌只经环境变量 MESA_BRIDGE_ADDR /
//! MESA_BRIDGE_TOKEN 给，命令行里没有），先发一行令牌，再把 CLI 的标准输入输出原样接到这条连接上；CLI 的标准错误与几行
//! 状态打到桥自己的标准输出，也就是终端页里看得到的那一屏。这样标签的起停、退出码、关标签收进程树、Mesa 退出清理都沿用 PTY 那一套。
//!
//! 安全边界：只连 127.0.0.1、不监听；不读密钥（CLI 要的连接环境变量由 Mesa 照常注入 PTY 环境、原样传给 CLI）；
//! 令牌不传给 CLI。连接断了就收掉 CLI 退出，CLI 退出就关连接、按它的退出码退出。只用标准库。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(not(windows))]
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;

pub const ADDR_ENV: &str = "MESA_BRIDGE_ADDR";
pub const TOKEN_ENV: &str = "MESA_BRIDGE_TOKEN";

/// `args` = `stdio-bridge` 之后的参数：`--probe`，或 `-- <程序> <参数…>`
pub fn helper_stdio_bridge_cli(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("--probe") {
        println!("ok");
        return 0;
    }
    let rest: Vec<String> = match args.iter().position(|a| a == "--") {
        Some(i) => args[i + 1..].to_vec(),
        None => args.to_vec(),
    };
    let Some((program, cli_args)) = rest.split_first() else {
        eprintln!("用法：mesa_helper stdio-bridge -- <程序> <参数…>");
        return 2;
    };
    let addr = std::env::var(ADDR_ENV).ok().and_then(|a| a.parse::<SocketAddr>().ok());
    let token = std::env::var(TOKEN_ENV).unwrap_or_default();
    let Some(addr) = addr.filter(|a| a.ip().is_loopback()) else {
        eprintln!("Mesa 原生模式：没有拿到本机连接地址，退出");
        return 2;
    };
    let stream = match connect(addr) {
        Some(s) => s,
        None => {
            println!("Mesa 原生模式：连不上 Mesa（{addr}），退出");
            return 1;
        }
    };
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return 1,
    };
    if writer.write_all(format!("{token}\n").as_bytes()).is_err() {
        return 1;
    }
    #[cfg(windows)]
    let spawned = {
        let mut cmd = crate::process::background_command(program);
        cmd.args(cli_args)
            .env_remove(ADDR_ENV)
            .env_remove(TOKEN_ENV)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.spawn_tied_to_app()
    };
    #[cfg(not(windows))]
    let spawned = Command::new(program)
        .args(cli_args)
        .env_remove(ADDR_ENV)
        .env_remove(TOKEN_ENV)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            println!("Mesa 原生模式：起不来 {program}：{e}");
            return 1;
        }
    };
    let name = std::path::Path::new(program)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.clone());
    println!("Mesa 原生模式：{name} 已在协议模式下运行，对话在聊天里进行；这里只显示它的运行日志。");
    println!("要用终端界面，请在右上角 ⋯ 菜单里选择「改用终端模式打开」。");
    let _ = std::io::stdout().flush();

    // CLI 标准输出 → 连接
    let mut cli_out = child.stdout.take();
    let to_mesa = std::thread::spawn(move || {
        if let Some(out) = cli_out.as_mut() {
            let _ = std::io::copy(out, &mut writer);
        }
        let _ = writer.shutdown(std::net::Shutdown::Write);
    });
    // 连接 → CLI 标准输入；连接断了（Mesa 关标签、崩溃）就收掉 CLI
    let mut cli_in = child.stdin.take();
    let mut reader = stream;
    let from_mesa = std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let ok = cli_in.as_mut().map(|w| w.write_all(&buf[..n]).and_then(|_| w.flush()).is_ok());
                    if ok != Some(true) {
                        break;
                    }
                }
            }
        }
        drop(cli_in);
    });
    // CLI 标准错误 → 终端页（逐行，免得和状态行混在一行里）
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                println!("{line}");
            }
        });
    }
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(1),
            Ok(None) => {
                if from_mesa.is_finished() {
                    // Mesa 那头断了：等 CLI 自己收尾一小会儿（标准输入关了，协议 CLI 会退出），不退就收掉
                    std::thread::sleep(Duration::from_millis(1500));
                    if matches!(child.try_wait(), Ok(None)) {
                        // 连带收掉 CLI 自己拉起的子命令进程树，免得留后台孤儿（AGENTS.md 进程树约束）
                        #[cfg(unix)]
                        crate::pty::kill_descendants(child.id());
                        #[cfg(windows)]
                        crate::pty::kill_process_tree(child.id());
                        let _ = child.kill();
                    }
                    break child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => break 1,
        }
    };
    let _ = to_mesa.join();
    println!("Mesa 原生模式：{name} 已退出（{code}）。");
    code
}

/// Mesa 起 PTY 前就在监听；PTY 里的桥起来要一点时间，连接失败稍等重试
fn connect(addr: SocketAddr) -> Option<TcpStream> {
    for _ in 0..50 {
        if let Ok(s) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
            let _ = s.set_nodelay(true);
            return Some(s);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;
    use std::net::TcpListener;

    /// 桥把 CLI 的标准输入输出原样接到连接上，先送令牌；连接这头关了 CLI 就收掉
    #[cfg(unix)]
    #[test]
    fn bridge_relays_stdio_after_token_and_exits_with_cli() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        std::env::set_var(ADDR_ENV, addr.to_string());
        std::env::set_var(TOKEN_ENV, "tok-123");
        // 「CLI」：读一行、原样回一行再退出
        let bridge = std::thread::spawn(|| {
            helper_stdio_bridge_cli(&[
                "--".into(),
                "/bin/sh".into(),
                "-c".into(),
                "read line; echo \"got:$line\"; exit 3".into(),
            ])
        });
        let (conn, _) = listener.accept().unwrap();
        let mut r = BufReader::new(conn.try_clone().unwrap());
        let mut first = String::new();
        r.read_line(&mut first).unwrap();
        assert_eq!(first, "tok-123\n");
        (&conn).write_all(b"{\"ping\":1}\n").unwrap();
        let mut back = String::new();
        r.read_line(&mut back).unwrap();
        assert_eq!(back, "got:{\"ping\":1}\n");
        assert_eq!(bridge.join().unwrap(), 3, "按 CLI 的退出码退出");
        std::env::remove_var(ADDR_ENV);
        std::env::remove_var(TOKEN_ENV);
    }

    /// Windows 专项：npm `.cmd` shim 深化直启、带空格/引号/中文参数与 UTF-8 双向流，以及断连后进程树连带清理
    #[cfg(windows)]
    #[test]
    fn windows_bridge_handles_cmd_shim_utf8_quoting_and_kills_process_tree() {
        let dir = std::env::temp_dir().join(format!("ccode-bridge-win-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let js = dir.join("mock_cli.js");
        let shim = dir.join("mock_cli.cmd");
        std::fs::write(
            &js,
            concat!(
                "const fs = require('fs');\n",
                "const cp = require('child_process');\n",
                "const mode = process.argv[2];\n",
                "if (mode === 'echo') {\n",
                "  let buf = '';\n",
                "  process.stdin.setEncoding('utf8');\n",
                "  process.stdin.on('data', (c) => {\n",
                "    buf += c;\n",
                "    const nl = buf.indexOf('\\n');\n",
                "    if (nl !== -1) {\n",
                "      process.stdout.write(JSON.stringify({ arg: process.argv[3], line: buf.slice(0, nl) }) + '\\n');\n",
                "      process.exit(5);\n",
                "    }\n",
                "  });\n",
                "} else if (mode === 'tree') {\n",
                "  const grand = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });\n",
                "  process.stdout.write(JSON.stringify({ child: process.pid, grand: grand.pid }) + '\\n');\n",
                "  setInterval(() => {}, 10000);\n",
                "}\n",
            ),
        )
        .unwrap();
        // 典型 npm .cmd shim 格式（background_command 会解析并改为 node 直启，不经 cmd /c 破坏引号）
        std::fs::write(&shim, "@ECHO off\r\n\"node\" \"%~dp0\\mock_cli.js\" %*\r\n").unwrap();

        // 1) .cmd shim + 引号/空格/中文参数 + 中文 UTF-8 往返
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        std::env::set_var(ADDR_ENV, addr.to_string());
        std::env::set_var(TOKEN_ENV, "tok-win-1");
        let shim_arg = shim.to_string_lossy().into_owned();
        let tagged = "含空格 \"引号\" 中文|a&b%PATH%";
        let tagged_owned = tagged.to_string();
        let bridge = std::thread::spawn(move || {
            helper_stdio_bridge_cli(&["--".into(), shim_arg, "echo".into(), tagged_owned])
        });
        let (conn, _) = listener.accept().unwrap();
        let mut r = BufReader::new(conn.try_clone().unwrap());
        let mut first = String::new();
        r.read_line(&mut first).unwrap();
        assert_eq!(first, "tok-win-1\n");
        (&conn).write_all("{\"msg\":\"你好，世界\"}\n".as_bytes()).unwrap();
        let mut back = String::new();
        r.read_line(&mut back).unwrap();
        let v: serde_json::Value = serde_json::from_str(back.trim()).unwrap();
        assert_eq!(v["arg"], tagged);
        assert_eq!(v["line"], "{\"msg\":\"你好，世界\"}");
        assert_eq!(bridge.join().unwrap(), 5);

        // 2) 断连后 kill_process_tree 连带清掉孙进程
        let listener2 = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr2 = listener2.local_addr().unwrap();
        std::env::set_var(ADDR_ENV, addr2.to_string());
        std::env::set_var(TOKEN_ENV, "tok-win-2");
        let shim_arg2 = shim.to_string_lossy().into_owned();
        let bridge2 = std::thread::spawn(move || {
            helper_stdio_bridge_cli(&["--".into(), shim_arg2, "tree".into()])
        });
        let (conn2, _) = listener2.accept().unwrap();
        let mut r2 = BufReader::new(conn2.try_clone().unwrap());
        let mut tok2 = String::new();
        r2.read_line(&mut tok2).unwrap();
        assert_eq!(tok2, "tok-win-2\n");
        let mut pids_line = String::new();
        r2.read_line(&mut pids_line).unwrap();
        let pids: serde_json::Value = serde_json::from_str(pids_line.trim()).unwrap();
        let child_pid = pids["child"].as_u64().unwrap() as u32;
        let grand_pid = pids["grand"].as_u64().unwrap() as u32;
        let _ = conn2.shutdown(std::net::Shutdown::Both);
        drop(r2);
        drop(conn2);
        let _ = bridge2.join().unwrap();
        let alive = |pid: u32| {
            let out = crate::process::background_command("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default();
            out.contains(&format!("\"{pid}\""))
        };
        assert!(!alive(child_pid), "断连后 CLI 子进程应已清理（pid={child_pid}）");
        assert!(!alive(grand_pid), "断连后 CLI 孙进程应已清理（pid={grand_pid}）");

        std::env::remove_var(ADDR_ENV);
        std::env::remove_var(TOKEN_ENV);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
