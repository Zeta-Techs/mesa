//! Mesa 的随包小助手（独立进程）：给 Agent 与各家 CLI 用的几件本机小事，按第一个参数分派——
//! hook（Windows 上写 hooks 状态日志）、image（出图）、peek / tell（同项目看一眼、留话）、
//! svg-render（科研做图）、codex-token（Codex 渠道现取密钥）、launch（不开 Mesa 在终端按连接直接起 CLI）。
//!
//! 安全边界：不监听网络；除 image、codex-token、launch 外不读密钥（launch 只在本机进程内注入给子进程，不打印、不落明文）。
//! 2026-11-09 起不再做浏览器扩展的 native messaging 宿主（扩展与「存到 Mesa」已撤）。

use std::io::{Read, Write};

/// hook 模式：读 stdin 的事件 JSON（超过 cap 字节截断、其余读掉），删回车换行，前缀
/// 「unix 秒 + 标签号」后一次追加到日志——与 hooks.rs 的 unix 命令、ccode-hook.ps1 同一语义。
/// 只用标准库：每次工具调用都要起一次，启动要快。`--probe` 只回 ok，主程序据此确认这份 helper 认 hook 模式。
fn run_hook(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("--probe") {
        println!("ok");
        return 0;
    }
    let Some(log) = args.first() else {
        return 2;
    };
    let cap: usize = args.get(1).and_then(|c| c.parse().ok()).unwrap_or(65536);
    let mut payload = Vec::new();
    let mut buf = [0u8; 8192];
    let mut stdin = std::io::stdin().lock();
    loop {
        match stdin.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = cap.saturating_sub(payload.len());
                payload.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
    payload.retain(|b| *b != b'\r' && *b != b'\n');
    let tab = std::env::var("CCODE_TAB_ID")
        .ok()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "-".into());
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut line = format!("{ts} {tab} ").into_bytes();
    line.extend_from_slice(&payload);
    line.push(b'\n');
    let path = std::path::Path::new(log);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // 追加句柄一次 write：多个 hook 进程同时写也不会互相穿插；打开失败（杀毒 / 索引短暂占用）稍等重试
    for i in 0..60u64 {
        let opened = std::fs::OpenOptions::new().create(true).append(true).open(path);
        if let Ok(mut f) = opened {
            if f.write_all(&line).is_ok() {
                return 0;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10 + (i * 7) % 31));
    }
    1
}

fn main() {
    // `mesa_helper hook <日志路径> <截断字节数>`：Windows 上给 CLI hooks 写状态日志（代替每次起一个
    // PowerShell，~1 秒 → 几十毫秒）
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("hook") {
        std::process::exit(run_hook(&args[2..]));
    }
    // `mesa_helper image --prompt … --out …`：Agent 出图（技能 image-gen 经 MESA_IMAGE_TOOL 调用）。
    // 这条路会读 keys.json 取出图网关的密钥——只在本机进程里用，不打印、不进环境变量
    if args.get(1).map(String::as_str) == Some("image") {
        std::process::exit(ccode_lib::helper_image(&args[2..]));
    }
    // `mesa_helper codex-token <网关 id>`：Codex 渠道定义块的 `auth.command`，现取 keys.json 里的密钥打到 stdout，
    // config.toml 里不落明文（Codex 客户端续 Mesa 开的对话靠它）
    // `mesa_helper peek agents|runs|changes`：同项目的 Agent 只读看彼此（经 MESA_PEEK_TOOL 调用，peek.rs）
    if args.get(1).map(String::as_str) == Some("peek") {
        std::process::exit(ccode_lib::helper_peek(&args[2..]));
    }
    // `mesa_helper svg-render --in 图纸.svg --out 图.png --out 图.pdf`：科研做图把图纸 SVG 转 PNG / PDF
    // （经 MESA_FIGURE_TOOL 调用，svg_render.rs）；不联网、不读密钥
    // `mesa_helper journal papers/included.json`：按 Mesa 的期刊指标表查影响因子与分区（经 MESA_JOURNAL_TOOL，journal_metrics.rs）；只读
    if args.get(1).map(String::as_str) == Some("journal") {
        std::process::exit(ccode_lib::helper_journal(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("svg-render") {
        std::process::exit(ccode_lib::helper_svg_render(&args[2..]));
    }
    // `mesa_helper tell --to 名 "…"`：给同项目另一段工作留话（写自己工作目录的发件箱，project_mail.rs）
    if args.get(1).map(String::as_str) == Some("tell") {
        std::process::exit(ccode_lib::helper_peek(&args[1..]));
    }
    if args.get(1).map(String::as_str) == Some("codex-token") {
        std::process::exit(ccode_lib::helper_codex_token(&args[2..]));
    }
    // `mesa_helper launch <连接 ID 或名称> [-- <CLI 参数…>]`：不开 Mesa 在任意终端现取 keys.json 起 CLI（尤其 agy API 连接）
    if args.get(1).map(String::as_str) == Some("launch") {
        std::process::exit(ccode_lib::helper_launch(&args[2..]));
    }
    eprintln!("用法：mesa_helper hook|image|peek|tell|svg-render|journal|codex-token|launch …");
    std::process::exit(2);
}
