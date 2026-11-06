use super::*;

// ===== Qwen Code =====

pub(super) fn qwen_usage(u: &Value) -> TokenUsageDto {
    let num = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    TokenUsageDto {
        // promptTokenCount 含 cachedContentTokenCount，拆成没命中的部分（同 usage.rs）
        input: crate::usage::uncached_input(num("promptTokenCount"), num("cachedContentTokenCount"), 0),
        output: num("candidatesTokenCount"),
        cache_read: num("cachedContentTokenCount"),
        cache_write: 0,
    }
}

/// genai Content {role, parts[]} → 块列表；thought 部分映射为 thinking
pub(super) fn qwen_parts_blocks(msg: &Value) -> Vec<BlockDto> {
    let mut blocks = Vec::new();
    let Some(parts) = msg.get("parts").and_then(|p| p.as_array()) else {
        return blocks;
    };
    for p in parts {
        if let Some(fc) = p.get("functionCall") {
            blocks.push(BlockDto {
                kind: "tool_use".into(),
                text: fc.get("args").map(|a| a.to_string()).unwrap_or_default(),
                tool_name: get_str(fc, "name").map(String::from),
                is_error: false,
                call_id: get_str(fc, "id").map(String::from),
            });
        } else if let Some(fr) = p.get("functionResponse") {
            let text = stringify_payload(fr.get("response"));
            blocks.push(BlockDto {
                kind: "tool_result".into(),
                text: if text.is_empty() {
                    fr.to_string()
                } else {
                    text
                },
                tool_name: None,
                is_error: false,
                call_id: get_str(fr, "id").map(String::from),
            });
        } else if let Some(t) = get_str(p, "text") {
            let kind = if p.get("thought").and_then(|x| x.as_bool()) == Some(true) {
                "thinking"
            } else {
                "text"
            };
            blocks.push(BlockDto {
                kind: kind.into(),
                text: t.to_string(),
                tool_name: None,
                is_error: false,
                call_id: None,
            });
        }
    }
    blocks
}

pub(super) fn qwen_content_text(msg: &Value) -> Option<String> {
    let parts = msg.get("parts")?.as_array()?;
    let text = parts
        .iter()
        .filter(|p| p.get("thought").and_then(|x| x.as_bool()) != Some(true))
        .filter_map(|p| get_str(p, "text"))
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// qwen 运行时标记：会话目录里的 <sessionId>.runtime.json sidecar。
/// qwen 退出（尤其被杀 / 崩溃）后不会清掉它，实测 8 月的残留文件仍在——只看「文件存在」会让
/// 早已结束的对话永远显示「进行中」，所以必须核对里面记的进程：同一台机器、进程还在、
/// 且不是 PID 被后来的进程复用（进程启动时间不得晚于 sidecar 的 started_at）。
pub(super) fn qwen_runtime_sidecar_path(path: &Path) -> Option<PathBuf> {
    let sid = path.file_stem()?.to_string_lossy();
    let candidate = path.parent()?.join(format!("{sid}.runtime.json"));
    candidate.exists().then_some(candidate)
}

/// 纯判定（进程与主机名由调用方注入，便于测试）：process_start(pid) = 该 pid 的进程启动 unix 秒，不存在 None
pub(super) fn qwen_sidecar_text_live(
    text: &str,
    local_host: Option<&str>,
    process_start: impl Fn(u32) -> Option<u64>,
) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    if let (Some(local), Some(host)) = (local_host, v.get("hostname").and_then(|h| h.as_str())) {
        if !local.eq_ignore_ascii_case(host) {
            return false; // 别的机器同步过来的目录，进程不在本机
        }
    }
    let Some(pid) = v.get("pid").and_then(|p| p.as_u64()).and_then(|p| u32::try_from(p).ok()) else {
        return false;
    };
    let Some(started) = process_start(pid) else {
        return false;
    };
    match v.get("started_at").and_then(|t| t.as_f64()) {
        // 会话开始时这个进程必须已经在了；留 5 秒时钟误差
        Some(session_started) => (started as f64) <= session_started + 5.0,
        None => true,
    }
}

pub(super) fn qwen_runtime_sidecar(path: &Path) -> Option<PathBuf> {
    let sidecar = qwen_runtime_sidecar_path(path)?;
    let text = std::fs::read_to_string(&sidecar).ok()?;
    let host = sysinfo::System::host_name();
    let live = qwen_sidecar_text_live(&text, host.as_deref(), |pid| {
        let pid = sysinfo::Pid::from_u32(pid);
        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        sys.process(pid).map(|p| p.start_time())
    });
    live.then_some(sidecar)
}

pub(super) fn qwen_file_meta(path: &Path, alive: bool, archived: bool) -> Option<SessionMetaDto> {
    let (head, tail) = read_head_tail(path, 64 * 1024)?;
    let (mut cwd, mut created, mut session_id, mut version, mut title, mut custom_title) =
        (None, None, None, None, None, None);
    for line in head.iter().chain(&tail) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        if cwd.is_none() {
            cwd = get_str(&v, "cwd").map(String::from);
        }
        if created.is_none() {
            created = get_str(&v, "timestamp").map(String::from);
        }
        if session_id.is_none() {
            session_id = get_str(&v, "sessionId").map(String::from);
        }
        if version.is_none() {
            version = get_str(&v, "version").map(String::from);
        }
        // system 记录只关心 custom_title（目录名会碰撞，标题以它为准）
        if get_str(&v, "type") == Some("system") && get_str(&v, "subtype") == Some("custom_title") {
            if let Some(t) = v
                .get("systemPayload")
                .and_then(|p| get_str(p, "customTitle"))
            {
                if let Some(candidate) = usable_title(t) {
                    custom_title = Some(candidate);
                }
            }
        }
        if title.is_none() && get_str(&v, "type") == Some("user") {
            if let Some(t) = v.get("message").and_then(qwen_content_text) {
                title = title_from_text(&t);
            }
        }
    }
    let tail_src = if tail.is_empty() { &head } else { &tail };
    let token_usage = tail_src.iter().rev().find_map(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|v| v.get("usageMetadata").map(qwen_usage))
    });
    let session_id = session_id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Some(SessionMetaDto {
        agent: "qwen".into(),
        session_id,
        project_path: cwd.clone().unwrap_or_default(),
        cwd,
        title: custom_title.or(title),
        created_at: created,
        updated_at: mtime_iso(path),
        file_path: path.to_string_lossy().into_owned(),
        token_usage,
        cli_version: version,
        pinned: false,
        archived,
        custom_title: None,
        tags: Vec::new(),
        alive,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live: alive && (mtime_fresh(path, 60) || qwen_runtime_sidecar(path).is_some()),
        source: default_session_source(),
        internal: false,
        handoff_from_agent: None,
        handoff_from_session: None,
        task_id: None,
        task_name: None,
        provider: None,
        profile_id: None,
        forked_from: None,
        reader: false,
        reader_pdf: None,
    })
}

pub(super) fn parse_qwen(lines: &[String]) -> Vec<ChatMessageDto> {
    let mut msgs = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let ts = get_str(&v, "timestamp").map(String::from);
        match get_str(&v, "type") {
            Some(role @ ("user" | "assistant")) => {
                let Some(msg) = v.get("message") else {
                    continue;
                };
                let blocks = qwen_parts_blocks(msg);
                if blocks.is_empty() {
                    continue;
                }
                msgs.push(ChatMessageDto {
                    role: role.into(),
                    blocks,
                    timestamp: ts,
                    usage: v.get("usageMetadata").map(qwen_usage),
                    id: get_str(&v, "uuid").map(String::from),
                    cwd: None,
                });
            }
            // 独立 tool_result 记录并入上一条 assistant（视觉跟随调用）
            Some("tool_result") => {
                let blocks: Vec<BlockDto> = v
                    .get("message")
                    .map(qwen_parts_blocks)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|b| b.kind == "tool_result")
                    .collect();
                if !blocks.is_empty() {
                    push_tool_result(&mut msgs, blocks, ts);
                }
            }
            _ => {} // system 等记录不进对话（custom_title 只用于列表标题）
        }
    }
    msgs
}
