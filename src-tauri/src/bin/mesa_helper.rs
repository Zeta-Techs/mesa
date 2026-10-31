//! Mesa 浏览器桥 helper（通道 C 的本机端，独立进程）：
//! 浏览器扩展经 native messaging（stdin：4 字节小端长度 + JSON）发来
//! `{kind:"mesa-save-pdf", doi, title, url, bytesB64}`；helper 解码校验后调主程序
//! 的入库函数落**当前活跃项目** papers/（项目根由主程序写 helper-context.json 告知），
//! 回 `{ok, saved}` / `{ok:false, error}`。循环处理直到 stdin 关闭。
//!
//! 安全边界：stdin/stdout 只对本机浏览器；不监听网络；浏览器桥与 hook 模式不读密钥
//! （image 出图模式例外，见 main 里的说明与 image_gen.rs）；
//! 入库走主程序同一套口径（ensure_task_project_root + save_paper_bytes + 60MB/魔数）。

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

fn read_frame(stdin: &mut impl Read) -> Option<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    stdin.read_exact(&mut len_buf).ok()?;
    let len = u32::from_le_bytes(len_buf) as usize;
    // 60MB PDF ≈ 80MB base64 + JSON 包裹；上限 192MB 让「超过 60MB」的解码后
    // 校验有机会回话（上限卡死 = 读帧失败退出循环，浏览器只见断连没有原因）
    if len == 0 || len > 192 * 1024 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; len];
    stdin.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// 写回执；管道断开返回 Err——调用方应退出循环（旧实现吞错继续空转读 stdin，
/// 浏览器侧只见 60s 超时，实际早已无人接收，2026-09-17 审计）
fn write_frame(stdout: &mut impl Write, obj: &serde_json::Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(obj).unwrap_or_default();
    let len = (body.len() as u32).to_le_bytes();
    stdout.write_all(&len)?;
    stdout.write_all(&body)?;
    stdout.flush()
}

fn helper_context_path() -> Option<std::path::PathBuf> {
    ccode_lib::dirs::config_dir().map(|d| d.join("ccode").join("helper-context.json"))
}

/// 收货回执日志（追加式 JSONL，0600）：helper 是独立进程、stderr 被 Chrome 吞掉，
/// 「点存到 Mesa 没反应」时双方都无据可查——落一条最小回执供报障归因
fn append_receipt(entry: &serde_json::Value) {
    let Some(dir) = ccode_lib::dirs::config_dir().map(|d| d.join("ccode")) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("helper-receipts.jsonl");
    let mut line = entry.to_string();
    line.push('\n');
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
}

struct HelperCtx {
    project_root: String,
    title: String,
    doi: String,
}

fn load_helper_ctx() -> Result<HelperCtx, String> {
    let path = helper_context_path().ok_or("无法确定配置目录")?;
    let text = std::fs::read_to_string(&path).map_err(|_| {
        "Mesa 里还没有「当前项目」——先在待获取清单点一次「在浏览器打开」".to_string()
    })?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("helper 语境损坏: {e}"))?;
    // 语境有效期（2026-09-17 审计）：helper-context 是「最近一次浏览器打开」留下
    // 的，永不过期时用户隔几天点扩展，PDF 静默落进旧项目、Mesa 侧零痕迹
    if let Some(at) = v
        .get("updatedAt")
        .and_then(|x| x.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    {
        let age = chrono::Utc::now().signed_duration_since(at);
        if age > chrono::Duration::hours(24) {
            return Err("上次「浏览器打开」已超过 24 小时——先在 Mesa 里对目标项目点一次「浏览器打开」，再回来存这篇".into());
        }
    }
    let project_root = v
        .get("projectRoot")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Mesa 里还没有「当前项目」".to_string())?;
    Ok(HelperCtx {
        project_root,
        title: v
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        doi: v
            .get("doi")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

fn main() {
    // `mesa_helper hook <日志路径> <截断字节数>`：Windows 上给 CLI hooks 写状态日志（代替每次起一个
    // PowerShell，~1 秒 → 几十毫秒）。浏览器拉起 native messaging 时第一个参数是扩展来源，不会是 hook
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("hook") {
        std::process::exit(run_hook(&args[2..]));
    }
    // `mesa_helper image --prompt … --out …`：Agent 出图（技能 image-gen 经 MESA_IMAGE_TOOL 调用）。
    // 与浏览器桥不同，这条路会读 keys.json 取出图网关的密钥——只在本机进程里用，不打印、不进环境变量
    if args.get(1).map(String::as_str) == Some("image") {
        std::process::exit(ccode_lib::helper_image(&args[2..]));
    }
    // `mesa_helper codex-token <网关 id>`：Codex 渠道定义块的 `auth.command`，现取 keys.json 里的密钥打到 stdout，
    // config.toml 里不落明文（Codex 客户端续 Mesa 开的对话靠它）
    if args.get(1).map(String::as_str) == Some("codex-token") {
        std::process::exit(ccode_lib::helper_codex_token(&args[2..]));
    }
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    while let Some(frame) = read_frame(&mut stdin) {
        let msg: serde_json::Value = match serde_json::from_slice(&frame) {
            Ok(v) => v,
            Err(_) => {
                if write_frame(
                    &mut stdout,
                    &serde_json::json!({"ok": false, "error": "消息解析失败"}),
                )
                .is_err()
                {
                    break;
                }
                continue;
            }
        };
        if msg.get("kind").and_then(|k| k.as_str()) == Some("mesa-report-download") {
            // 扩展上报自己触发的下载的最终落盘路径（浏览器下载位置不在系统
            // Downloads 时目录监听看不见——路径直报绕过目录假定，2026-09-17 审计 #17）。
            // 只追加到 dl-reports.jsonl 由主程序收货链消费，helper 自己不动文件
            let reply = handle_report_download(&msg);
            let receipt = serde_json::json!({
                "at": chrono::Utc::now().to_rfc3339(),
                "kind": "report-download",
                "ok": reply.get("ok").cloned().unwrap_or(serde_json::json!(false)),
            });
            append_receipt(&receipt);
            if write_frame(&mut stdout, &reply).is_err() {
                break;
            }
            continue;
        }
        if msg.get("kind").and_then(|k| k.as_str()) != Some("mesa-save-pdf") {
            if write_frame(
                &mut stdout,
                &serde_json::json!({"ok": false, "error": "未知消息类型"}),
            )
            .is_err()
            {
                break;
            }
            continue;
        }
        let reply = handle(&msg);
        let receipt = serde_json::json!({
            "at": chrono::Utc::now().to_rfc3339(),
            "title": reply.get("title").or(msg.get("title")).and_then(|v| v.as_str()).unwrap_or(""),
            "doi": reply.get("doi").cloned().unwrap_or(serde_json::json!("")),
            "ok": reply.get("ok").cloned().unwrap_or(serde_json::json!(false)),
            "saved": reply.get("saved").cloned().unwrap_or(serde_json::json!("")),
            "note": reply.get("error").or(reply.get("saved")).cloned().unwrap_or(serde_json::json!(null)),
            "projectRoot": reply.get("projectRoot").cloned().unwrap_or(serde_json::json!("")),
        });
        append_receipt(&receipt);
        if write_frame(&mut stdout, &reply).is_err() {
            break;
        }
    }
}

/// 扩展上报的下载路径 → `<config>/ccode/dl-reports.jsonl`（主程序收货链增量消费，
/// 见 download_inbox::drain_dl_reports）。文件保序追加，超 400 行截尾防无限增长
fn handle_report_download(msg: &serde_json::Value) -> serde_json::Value {
    let Some(path) = msg
        .get("path")
        .and_then(|p| p.as_str())
        .filter(|p| !p.is_empty())
    else {
        return serde_json::json!({"ok": false, "error": "缺 path"});
    };
    let Some(dir) = ccode_lib::dirs::config_dir().map(|d| d.join("ccode")) else {
        return serde_json::json!({"ok": false, "error": "无法确定配置目录"});
    };
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("dl-reports.jsonl");
    let mut line =
        serde_json::json!({ "at": chrono::Utc::now().to_rfc3339(), "path": path }).to_string();
    line.push('\n');
    use std::io::Write;
    let wrote = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .and_then(|mut f| f.write_all(line.as_bytes()));
    if wrote.is_err() {
        return serde_json::json!({"ok": false, "error": "写入 dl-reports 失败"});
    }
    // 截尾：超过 400 行时保留后半（低频动作，简单粗暴即可）
    if let Ok(text) = std::fs::read_to_string(&file) {
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() > 400 {
            let kept = lines[lines.len() - 200..].join("\n");
            let _ = std::fs::write(&file, format!("{kept}\n"));
        }
    }
    serde_json::json!({"ok": true})
}

fn handle(msg: &serde_json::Value) -> serde_json::Value {
    let bytes_b64 = msg.get("bytesB64").and_then(|v| v.as_str()).unwrap_or("");
    let bytes = match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, bytes_b64)
    {
        Ok(b) => b,
        Err(e) => return serde_json::json!({"ok": false, "error": format!("解码失败: {e}")}),
    };
    if bytes.is_empty() || bytes.len() > 60 * 1024 * 1024 {
        return serde_json::json!({"ok": false, "error": "内容为空或超过 60MB"});
    }
    if !bytes.starts_with(b"%PDF-") {
        return serde_json::json!({"ok": false, "error": "内容不是有效 PDF"});
    }
    let ctx = match load_helper_ctx() {
        Ok(c) => c,
        Err(e) => return serde_json::json!({"ok": false, "error": e}),
    };
    let page_title = msg.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let page_doi = msg.get("doi").and_then(|v| v.as_str()).unwrap_or("");
    let page_url = msg.get("url").and_then(|v| v.as_str()).unwrap_or("");
    // PDF 阅读器页常没有 citation_title，旧口径会落成 paper.pdf / paper-5.pdf，
    // 待获取清单短边 ≥8 对不上「已存」。用 Mesa 打开时记下的标题/DOI。
    let doi_key = if !page_doi.trim().is_empty() {
        page_doi
    } else {
        page_url
    };
    let pending = ccode_lib::helper_pending_for_doi(doi_key);
    let ident_title;
    let ident_doi;
    let root;
    if let Some((t, d, r)) = pending {
        ident_title = t;
        ident_doi = d;
        root = r;
    } else {
        ident_title =
            ccode_lib::helper_paper_name_hint(page_title, page_doi, page_url, &ctx.title, &ctx.doi);
        ident_doi = if !page_doi.trim().is_empty() {
            page_doi.to_string()
        } else {
            ctx.doi.clone()
        };
        root = ctx.project_root.clone();
    }
    let hint = ident_title.as_str();
    match ccode_lib::helper_ingest_ident(&root, hint, hint, &ident_doi, &bytes) {
        Ok((saved, dedup)) => {
            // 回执带项目名（2026-09-17）：helper-context 是上次「在浏览器打开」留下的
            // 语境，可能已过期——入库落进哪个项目必须当场可见，错存能立刻发现。
            // dedup 一并带回（字节级重复不再静默「成功」），projectRoot 供主程序
            // 的回执监听把 papers/ 变化广播给清单/雷达
            let project = std::path::Path::new(&root)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            serde_json::json!({
                "ok": true,
                "saved": saved,
                "dedup": dedup,
                "project": project,
                "projectRoot": root,
                "title": if ident_title.is_empty() { page_title } else { ident_title.as_str() },
                "doi": ident_doi,
            })
        }
        Err(e) => serde_json::json!({"ok": false, "error": e}),
    }
}
