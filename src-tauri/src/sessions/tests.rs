/// 聊天区量测（scripts/chat-layout-measure）的样本：从本机一个 Claude Code 项目目录里按文件大小取中位、九成位、最大三段，
/// 解析成聊天层拿到的样子写进 harness.local/（gitignored，是真实对话，不进仓库）。只在手动量测时跑：
/// MESA_CHAT_SAMPLES=~/.claude/projects/<项目目录> cargo test --lib dump_chat_layout_samples -- --ignored
#[test]
#[ignore]
fn dump_chat_layout_samples() {
    let dir = std::env::var("MESA_CHAT_SAMPLES").expect("设 MESA_CHAT_SAMPLES 为一个 Claude Code 项目会话目录");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .map(|p| (std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0), p))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "目录里没有会话文件");
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../harness.local");
    std::fs::create_dir_all(&out).unwrap();
    let n = files.len();
    for (name, idx) in [("p50", n / 2), ("p90", n * 9 / 10), ("max", n - 1)] {
        let msgs = super::conversation_impl("claude-code", files[idx].1.to_str().unwrap());
        std::fs::write(out.join(format!("conv-{name}.json")), serde_json::to_string(&msgs).unwrap()).unwrap();
    }
}

/// qwen 退出后 runtime.json 不清理：只有进程还在、同一台机器、PID 没被复用才算进行中
#[test]
fn qwen_sidecar_live_requires_a_real_running_process() {
    let json = |host: &str, pid: u64, started: f64| {
        format!(
            r#"{{"schema_version":1,"pid":{pid},"session_id":"s","hostname":"{host}","started_at":{started}}}"#
        )
    };
    let t0 = 1_787_550_648_u64;
    let running = |_: u32| Some(t0 - 30); // 进程比会话早启动：正常
    let gone = |_: u32| None;
    let reused = |_: u32| Some(t0 + 86_400); // 同号进程是之后才起的：PID 被复用
    let text = json("my-mac", 38762, t0 as f64);
    assert!(qwen_sidecar_text_live(&text, Some("my-mac"), running));
    assert!(!qwen_sidecar_text_live(&text, Some("my-mac"), gone), "进程已不在（残留文件）");
    assert!(!qwen_sidecar_text_live(&text, Some("my-mac"), reused), "PID 被复用");
    assert!(!qwen_sidecar_text_live(&text, Some("other-pc"), running), "别的机器同步来的");
    assert!(qwen_sidecar_text_live(&text, None, running), "取不到本机名时不因主机名误杀");
    assert!(!qwen_sidecar_text_live("not json", Some("my-mac"), running));
    assert!(!qwen_sidecar_text_live(r#"{"hostname":"my-mac"}"#, Some("my-mac"), running), "缺 pid");
}

use super::*;

fn s(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|l| l.to_string()).collect()
}

// ===== 增量缓存 =====

#[test]
fn cached_plain_skips_parse_when_sig_unchanged() {
    let dir = std::env::temp_dir().join(format!("ccode-sig-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let f = dir.join("a.jsonl");
    fs::write(&f, br#"{"type":"user","cwd":"/tmp/p","sessionId":"s1","message":{"role":"user","content":"hi"}}"#).unwrap();

    let mut cache: HashMap<String, (FileSig, SessionMetaDto)> = HashMap::new();
    let calls = std::cell::Cell::new(0usize);
    let first = cached_plain(vec![f.clone()], &mut cache, |p| {
        calls.set(calls.get() + 1);
        claude_file_meta(p, true)
    });
    assert_eq!(first.len(), 1);
    assert_eq!(calls.get(), 1);

    // 同一文件未变：不再调 parse
    let second = cached_plain(vec![f.clone()], &mut cache, |p| {
        calls.set(calls.get() + 1);
        claude_file_meta(p, true)
    });
    assert_eq!(second.len(), 1);
    assert_eq!(calls.get(), 1, "指纹未变必须命中缓存");
    assert_eq!(second[0].session_id, "s1");

    // 内容变了（长度不同）：重解析
    fs::write(&f, br#"{"type":"user","cwd":"/tmp/p","sessionId":"s2-changed","message":{"role":"user","content":"yo"}}"#).unwrap();
    let third = cached_plain(vec![f.clone()], &mut cache, |p| {
        calls.set(calls.get() + 1);
        claude_file_meta(p, true)
    });
    assert_eq!(calls.get(), 2, "指纹变了必须重解析");
    assert_eq!(third[0].session_id, "s2-changed");

    // 文件消失：条目被淘汰
    let gone = cached_plain(vec![], &mut cache, |p| claude_file_meta(p, true));
    assert!(gone.is_empty());
    assert!(cache.is_empty(), "消失的文件不许留在缓存里");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cached_chained_keeps_parent_across_hits() {
    let dir = std::env::temp_dir().join(format!("ccode-chain-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let f = dir.join("rollout-2026-09-01-x.jsonl");
    fs::write(&f, br#"{"type":"session_meta","payload":{"id":"c1","cwd":"/tmp/p","forked_from_id":"root0"}}"#).unwrap();

    let mut cache: HashMap<String, (FileSig, SessionMetaDto, Option<String>)> = HashMap::new();
    let first = cached_chained(vec![f.clone()], &mut cache, |p| {
        codex_file_meta(p, true, false)
    });
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].1.as_deref(), Some("root0"));

    let second = cached_chained(vec![f.clone()], &mut cache, |p| {
        codex_file_meta(p, true, false)
    });
    assert_eq!(
        second[0].1.as_deref(),
        Some("root0"),
        "链父 id 命中缓存不丢"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn dir_listing_sig_changes_with_content() {
    let dir = std::env::temp_dir().join(format!("ccode-dlsig-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let f = dir.join("x.jsonl");
    fs::write(&f, b"one").unwrap();
    let sig1 = dir_listing_sig(&[f.clone()]);
    fs::write(&f, b"one-longer").unwrap();
    let sig2 = dir_listing_sig(&[f.clone()]);
    assert_ne!(sig1, sig2, "长度变 = 指纹变");
    let sig3 = dir_listing_sig(&[dir.join("absent.jsonl")]);
    assert_ne!(sig2, sig3, "清单成员变 = 指纹变");
    let _ = fs::remove_dir_all(&dir);
}

// ===== Claude 解析 =====

#[test]
fn claude_parse_user_assistant_tool_flow() {
    let lines = s(&[
        r#"{"type":"summary","summary":"忽略我"}"#,
        r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-stdout>x</local-command-stdout>"}}"#,
        r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"支线"}}"#,
        r#"{"type":"user","cwd":"/tmp/proj","sessionId":"s1","version":"1.0.0","message":{"role":"user","content":"帮我修 bug"},"timestamp":"2026-07-01T00:00:01Z"}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"想想"},{"type":"text","text":"好的"},{"type":"tool_use","name":"Read","input":{"file_path":"/a"}}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}},"timestamp":"2026-07-01T00:00:02Z"}"#,
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"file body"}]},"timestamp":"2026-07-01T00:00:03Z"}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":"#, // 截断末行
    ]);
    let msgs = parse_claude(&lines);
    assert_eq!(msgs.len(), 2, "summary/isMeta/sidechain/截断行都要跳过");
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].blocks[0].text, "帮我修 bug");
    assert_eq!(msgs[0].timestamp.as_deref(), Some("2026-07-01T00:00:01Z"));
    assert_eq!(msgs[1].role, "assistant");
    // thinking + text + tool_use + 并入的 tool_result
    assert_eq!(msgs[1].blocks.len(), 4);
    assert_eq!(msgs[1].blocks[0].kind, "thinking");
    assert_eq!(msgs[1].blocks[1].kind, "text");
    assert_eq!(msgs[1].blocks[2].kind, "tool_use");
    assert_eq!(msgs[1].blocks[2].tool_name.as_deref(), Some("Read"));
    assert_eq!(msgs[1].blocks[3].kind, "tool_result");
    assert_eq!(msgs[1].blocks[3].text, "file body");
    let u = msgs[1].usage.as_ref().unwrap();
    assert_eq!(
        (u.input, u.output, u.cache_read, u.cache_write),
        (10, 5, 3, 2)
    );
}

#[test]
fn claude_slash_command_and_output_become_one_command_row() {
    // 2.1.292 实录：命令行与输出行都不标 isMeta，输出带 ANSI 暗色转义
    let lines = s(&[
        r#"{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>glm-5.2</command-args>"}}"#,
        r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to `glm-5.2` and saved as your default for new sessions\u001b[2m\u001b[22m\n\u001b[2m     ANTHROPIC_MODEL is set to \u001b[22m`glm-5.3-flash`\u001b[2m — new sessions use that while it is set\u001b[22m</local-command-stdout>"}}"#,
        r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
        r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout></local-command-stdout>"}}"#,
        r#"{"type":"user","message":{"role":"user","content":"<bash-input>ls</bash-input>"}}"#,
        r#"{"type":"user","message":{"role":"user","content":"<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>"}}"#,
        r#"{"type":"user","message":{"role":"user","content":"真正的问题"}}"#,
    ]);
    let msgs = parse_claude(&lines);
    assert_eq!(msgs.len(), 4);
    assert_eq!(msgs[0].blocks[0].kind, "command");
    assert_eq!(msgs[0].blocks[0].text, "/model glm-5.2");
    assert_eq!(msgs[0].blocks[1].kind, "command_output");
    let out = &msgs[0].blocks[1].text;
    assert!(out.starts_with("Set model to `glm-5.2`"));
    assert!(!out.contains('\u{1b}') && !out.contains("[2m"), "ANSI 要剥干净：{out}");
    assert_eq!(msgs[1].blocks.len(), 1, "空输出不留块");
    assert_eq!(msgs[1].blocks[0].text, "/clear");
    assert_eq!(msgs[2].blocks[0].text, "! ls");
    assert_eq!(msgs[2].blocks[1].text, "a.txt");
    assert_eq!(msgs[3].blocks[0].kind, "text");
}

#[test]
fn claude_mid_turn_message_is_a_user_message() {
    // 2.1.292：这一轮还在跑时发的话记成 attachment/queued_command（下一步工具调用时交给模型）；
    // 后台任务通知、别的会话发来的同样是 queued_command，不算用户说的
    let lines = s(&[
        r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"跑一下测试"}}"#,
        r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]}}"#,
        r#"{"type":"queue-operation","operation":"enqueue","content":"顺便看看 lint"}"#,
        r#"{"type":"attachment","uuid":"q1","timestamp":"2026-10-21T15:37:14.538Z","attachment":{"type":"queued_command","prompt":"顺便看看 lint","commandMode":"prompt","origin":{"kind":"human"},"humanTurn":true}}"#,
        r#"{"type":"queue-operation","operation":"remove","content":"顺便看看 lint","reason":"absorbed_mid_turn"}"#,
        r#"{"type":"attachment","uuid":"q2","attachment":{"type":"queued_command","prompt":"<task-notification>x</task-notification>","commandMode":"task-notification","origin":{"kind":"task-notification"}}}"#,
        r#"{"type":"attachment","uuid":"q3","attachment":{"type":"queued_command","prompt":"别的会话发来的","commandMode":"prompt","origin":{"kind":"peer"}}}"#,
        r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
    ]);
    let msgs = parse_claude(&lines);
    let users: Vec<_> = msgs
        .iter()
        .filter(|m| m.role == "user" && m.blocks.iter().any(|b| b.kind == "text"))
        .map(|m| (m.blocks[0].text.as_str(), m.id.as_deref()))
        .collect();
    assert_eq!(users, vec![("跑一下测试", Some("u1")), ("顺便看看 lint", Some("q1"))]);
}

#[test]
fn claude_idle_task_notification_is_not_user_message() {
    // Agent 闲着时到的后台通知（后台命令跑完、Monitor 事件）是普通 user 行：origin.kind = task-notification、
    // promptSource = system、不标 isMeta（本机 2.1.30x 实录形状）。不算用户说的，也不进起名 / 接力用的用户原话
    let lines = s(&[
        r#"{"type":"user","uuid":"u1","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"盯一下构建日志"}}"#,
        r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"开了监视，有动静告诉你"}]}}"#,
        r#"{"type":"user","uuid":"n1","origin":{"kind":"task-notification"},"promptSource":"system","message":{"role":"user","content":"<task-notification>\n<task-id>m1</task-id>\n<output>Build failed</output>\n</task-notification>"}}"#,
        r#"{"type":"user","uuid":"n2","origin":{"kind":"task-notification"},"promptSource":"system","message":{"role":"user","content":[{"type":"text","text":"<task-notification>m2</task-notification>"}]}}"#,
        r#"{"type":"assistant","uuid":"a2","message":{"role":"assistant","content":[{"type":"text","text":"构建失败了"}]}}"#,
        r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"旧版没有 origin 的照旧算"}}"#,
    ]);
    let msgs = parse_claude(&lines);
    let users: Vec<_> = msgs
        .iter()
        .filter(|m| m.role == "user")
        .map(|m| (m.blocks[0].text.as_str(), m.id.as_deref()))
        .collect();
    assert_eq!(users, vec![("盯一下构建日志", Some("u1")), ("旧版没有 origin 的照旧算", Some("u2"))]);
    assert_eq!(msgs.iter().filter(|m| m.role == "assistant").count(), 2, "助手对通知的回复照常显示");
    assert!(!crate::ai::user_title_material(&msgs, false).contains("task-notification"));
}

#[test]
fn claude_assistant_carries_line_cwd() {
    // 2026-10-30 实证：Agent 在 shell 里 cd 进 out/promo 后写 [x.mp4](x.mp4)，相对路径要按这一行的 cwd 解析
    let lines = s(&[
        r#"{"type":"user","uuid":"u1","cwd":"/p","message":{"role":"user","content":"做个视频"}}"#,
        r#"{"type":"assistant","uuid":"a1","cwd":"/p/out/promo","message":{"role":"assistant","content":[{"type":"text","text":"见 [x.mp4](x.mp4)"}]}}"#,
        r#"{"type":"assistant","uuid":"a2","message":{"role":"assistant","content":[{"type":"text","text":"旧版没有 cwd"}]}}"#,
    ]);
    let msgs = parse_claude(&lines);
    let cwds: Vec<_> = msgs.iter().map(|m| (m.role.as_str(), m.cwd.as_deref())).collect();
    assert_eq!(cwds, vec![("user", None), ("assistant", Some("/p/out/promo")), ("assistant", None)]);
}

#[test]
fn claude_local_command_output_settles_tail() {
    let lines = s(&[
        r#"{"type":"user","message":{"role":"user","content":"<command-name>/effort</command-name><command-args>high</command-args>"}}"#,
        r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set effort level to high (saved as your default for new sessions)</local-command-stdout>"}}"#,
    ]);
    assert_eq!(claude_tail_state(&lines), "settled");
    let pending = s(&[
        r#"{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name>"}}"#,
    ]);
    assert_eq!(claude_tail_state(&pending), "working", "/init 这类会让模型干活的命令仍算进行中");
}

#[test]
fn claude_image_attachments_restore_source_paths() {
    // 2.1.308 实测：聊天层发「正文 + 两行图片路径」，落盘成前置占位 + base64 图，路径另记一条 isMeta 来源行
    let lines = s(&[
        r#"{"type":"user","promptId":"p1","imagePasteIds":[1,2],"message":{"role":"user","content":[{"type":"text","text":"[Image #1] [Image #2]第一行文字\n第二行"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBO"}},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBO"}}]}}"#,
        r#"{"type":"user","promptId":"p1","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"[Image: source: /tmp/a.png]"},{"type":"text","text":"[Image: source: /tmp/b.png]"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"红色"}]}}"#,
    ]);
    let msgs = parse_claude(&lines);
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].blocks[0].text, "第一行文字\n第二行\n/tmp/a.png\n/tmp/b.png");

    // 终端里直接贴的剪贴板图没有来源行：占位原样留着
    let pasted = s(&[
        r#"{"type":"user","promptId":"p2","message":{"role":"user","content":[{"type":"text","text":"[Image #3] 看这个"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBO"}}]}}"#,
    ]);
    assert_eq!(parse_claude(&pasted)[0].blocks[0].text, "[Image #3] 看这个");
}

#[test]
fn strip_claude_image_placeholders_only_takes_numbered_tags() {
    assert_eq!(strip_claude_image_placeholders("[Image #12] 正文"), ("正文".to_string(), 1));
    assert_eq!(strip_claude_image_placeholders("[Image #x] [Image #]"), ("[Image #x] [Image #]".to_string(), 0));
}

#[test]
fn claude_mixed_user_blocks_stay_user_message() {
    let lines = s(&[
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"out"},{"type":"text","text":"补充说明"}]}}"#,
    ]);
    let msgs = parse_claude(&lines);
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].blocks.len(), 2);
    assert_eq!(msgs[0].blocks[0].kind, "tool_result");
}

#[test]
fn claude_tool_result_without_prior_assistant_becomes_user() {
    let lines = s(&[
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"out"}]}}"#,
    ]);
    let msgs = parse_claude(&lines);
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].blocks[0].kind, "tool_result");
}

#[test]
fn claude_meta_reads_cwd_title_and_ai_title_override() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("11111111-2222-3333-4444-555555555555.jsonl");
    let content = concat!(
        r#"{"type":"user","cwd":"/tmp/proj","sessionId":"sid-1","version":"1.2.3","timestamp":"2026-07-01T00:00:00Z","message":{"role":"user","content":"<command-name>/init</command-name>"}}"#,
        "\n",
        r#"{"type":"user","timestamp":"2026-07-01T00:01:00Z","message":{"role":"user","content":"真正的第一条消息"}}"#,
        "\n",
        r#"{"type":"ai-title","aiTitle":"AI 起的标题","sessionId":"sid-1"}"#,
        "\n",
    );
    std::fs::write(&file, content).unwrap();
    let m = claude_file_meta(&file, true).unwrap();
    assert_eq!(m.project_path, "/tmp/proj");
    // 文件名是 uuid 时以文件名为准（Claude 接续文件开头的 sessionId 是上游的）
    assert_eq!(m.session_id, "11111111-2222-3333-4444-555555555555");
    assert_eq!(m.cli_version.as_deref(), Some("1.2.3"));
    assert_eq!(m.created_at.as_deref(), Some("2026-07-01T00:00:00Z"));
    assert_eq!(
        m.title.as_deref(),
        Some("AI 起的标题"),
        "ai-title 应覆盖首条用户消息"
    );
    assert!(m.updated_at.is_some());
    assert!(m.alive);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn title_truncates_to_24_wide_chars() {
    let long = "啊".repeat(100);
    assert_eq!(truncate_title(&long).chars().count(), 25); // 24 + 省略号
    // 英文两个字母算一个字
    let en = truncate_title("Greeting in Chinese, no task specified yet, waiting for the user");
    assert_eq!(en, "Greeting in Chinese, no task specified yet, wait…");
    assert_eq!(truncate_title("修复统计页今日用量"), "修复统计页今日用量");
}

#[test]
fn title_quality_rejects_placeholders_and_collapses_whitespace() {
    assert_eq!(usable_title("New Session"), None);
    assert_eq!(usable_title("未命名对话"), None);
    assert_eq!(
        usable_title("  修复统计页\n\n今日用量  ").as_deref(),
        Some("修复统计页 今日用量")
    );
}

#[test]
fn title_quality_rejects_bare_greetings_but_keeps_greeting_with_content() {
    // 纯问候语拒识（解析器守卫会顺势跳到下一条 user 消息）
    for g in [
        "你好",
        "您好",
        "嗨",
        "在吗",
        "hi",
        "HI",
        "Hello!",
        "hey~",
        "你好。",
        "喂？",
    ] {
        assert_eq!(usable_title(g), None, "{g} 不该成为列表标题");
    }
    // 问候 + 正事同一条消息的不误伤
    assert_eq!(
        usable_title("你好，帮我看看这个 bug").as_deref(),
        Some("你好，帮我看看这个 bug")
    );
    assert_eq!(
        usable_title("<user_query>\n把文献综述的第二章压缩到 800 字\n</user_query>").as_deref(),
        Some("把文献综述的第二章压缩到 800 字")
    );
    assert_eq!(usable_title("<user_query>你好</user_query>"), None);
}

#[test]
fn claude_meta_skips_greeting_and_takes_next_substantive_prompt() {
    // 首句是「你好」时标题取第二条实质 prompt（用户拍板：列表里一排「你好」没法区分）
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("s-greet.jsonl");
    std::fs::write(
        &f,
        concat!(
            r#"{"type":"user","cwd":"/tmp/proj","sessionId":"sid-g","timestamp":"2026-07-01T00:00:00Z","message":{"content":"你好"}}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"你好！有什么可以帮你？"}]}}"#,
            "\n",
            r#"{"type":"user","message":{"content":"把文献综述的第二章压缩到 800 字"}}"#,
            "\n",
        ),
    )
    .unwrap();
    let m = claude_file_meta(&f, true).unwrap();
    assert_eq!(m.title.as_deref(), Some("把文献综述的第二章压缩到 800 字"));
    std::fs::remove_dir_all(&dir).ok();
}

// ===== CodeBuddy 解析（v2.132.0 实测样本行） =====

#[test]
fn codebuddy_parse_reads_tool_calls_and_results() {
    // 2.172.1 金丝雀抓到的原样（ptc 模式：工具是 REPL，参数里是一段 JS）
    let lines = s(&[
        r#"{"id":"m1","timestamp":1792672349272,"type":"message","role":"user","content":[{"type":"input_text","text":"TRIGGER_TOOL 跑一下"}],"sessionId":"s"}"#,
        r#"{"id": "f1", "timestamp": 1792672349362, "type": "function_call", "callId": "call_probe", "name": "REPL", "arguments": "{\"code\": \"return await Bash({ command: \\\"echo mesa > mesa_probe.txt\\\" })\", \"description\": \"写一个探针文件\"}", "sessionId": "s"}"#,
        r#"{"id": "r1", "timestamp": 1792672352936, "type": "function_call_result", "name": "REPL", "callId": "call_probe", "status": "completed", "output": {"type": "text", "text": "{\"stdout\":\"\"}"}, "sessionId": "s"}"#,
        r#"{"id":"m2","timestamp":1792672352954,"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}],"sessionId":"s"}"#,
    ]);
    let msgs = parse_codebuddy(&lines);
    let blocks: Vec<_> = msgs.iter().flat_map(|m| m.blocks.iter()).collect();
    let call = blocks.iter().find(|b| b.kind == "tool_use").expect("读到工具调用");
    assert_eq!(call.tool_name.as_deref(), Some("REPL"));
    assert_eq!(call.call_id.as_deref(), Some("call_probe"));
    assert!(call.text.contains("写一个探针文件"));
    let result = blocks.iter().find(|b| b.kind == "tool_result").expect("读到工具结果");
    assert_eq!(result.call_id.as_deref(), Some("call_probe"));
    assert_eq!(result.text, r#"{"stdout":""}"#);
    assert!(!result.is_error);
    assert_eq!(msgs.last().unwrap().blocks[0].text, "done");
    // 调用了工具、回答还没写：在干活
    assert_eq!(codebuddy_tail_state(&lines[..3]), "working");
    assert_eq!(codebuddy_tail_state(&lines), "done");
}

#[test]
fn codebuddy_parse_messages_skips_event_lines() {
    let lines = s(&[
        r#"{"id":"m1","timestamp":1786005441386,"type":"message","role":"user","content":[{"type":"input_text","text":"say hi"}],"providerData":{"agent":"cli"},"sessionId":"sid-cb","cwd":"/private/tmp/cbtest"}"#,
        r#"{"id":"s1","timestamp":1786005441391,"type":"file-history-snapshot","isSnapshotUpdate":false,"snapshot":{"messageId":"m1","trackedFileBackups":{}},"cwd":"/private/tmp/cbtest"}"#,
        r#"{"id":"m2","parentId":"m1","timestamp":1786005443775,"type":"message","role":"assistant","content":[{"type":"output_text","text":"你好！"}],"status":"incomplete","sessionId":"sid-cb","cwd":"/private/tmp/cbtest"}"#,
        r#"{"id":"m3","type":"unknown-future-event","foo":1}"#,
        r#"{"id":"m4","type":"message","role":"assistant","content":"#, // 截断末行
    ]);
    let msgs = parse_codebuddy(&lines);
    assert_eq!(
        msgs.len(),
        2,
        "file-history-snapshot/未知类型/截断行都要跳过"
    );
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].blocks[0].text, "say hi");
    assert_eq!(
        msgs[0].timestamp.as_deref(),
        Some("2026-08-06T08:37:21Z"),
        "毫秒 epoch 应转 ISO"
    );
    assert_eq!(msgs[1].role, "assistant");
    assert_eq!(msgs[1].blocks[0].text, "你好！");
}

#[test]
fn codebuddy_meta_reads_cwd_session_and_title() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let proj = dir.join("-private-tmp-cbtest");
    std::fs::create_dir_all(&proj).unwrap();
    let file = proj.join("df3ac35f-6338-4875-bcb8-7ac811794538.jsonl");
    let content = concat!(
        r#"{"id":"m1","timestamp":1786005441386,"type":"message","role":"user","content":[{"type":"input_text","text":"say hi"}],"providerData":{"agent":"cli"},"sessionId":"df3ac35f-6338-4875-bcb8-7ac811794538","cwd":"/private/tmp/cbtest"}"#,
        "\n",
        r#"{"id":"s1","timestamp":1786005441391,"type":"file-history-snapshot","isSnapshotUpdate":false,"snapshot":{"messageId":"m1","trackedFileBackups":{}},"cwd":"/private/tmp/cbtest"}"#,
        "\n",
    );
    std::fs::write(&file, content).unwrap();
    let m = codebuddy_file_meta(&file, true).unwrap();
    assert_eq!(m.agent, "codebuddy");
    assert_eq!(m.project_path, "/private/tmp/cbtest");
    assert_eq!(m.session_id, "df3ac35f-6338-4875-bcb8-7ac811794538");
    assert_eq!(m.title.as_deref(), Some("say hi"));
    assert!(m.created_at.is_some());
    assert!(m.alive);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn codebuddy_meta_falls_back_to_slug_dir_name() {
    // 行里没有 cwd/sessionId 时：项目归属回落 slug 目录名（同 Claude 规则），session id 回落文件名
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let proj = dir.join("-Users-x-proj");
    std::fs::create_dir_all(&proj).unwrap();
    let file = proj.join("aaaaaaaa-0000-0000-0000-000000000000.jsonl");
    std::fs::write(
        &file,
        r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}"#,
    )
    .unwrap();
    let m = codebuddy_file_meta(&file, true).unwrap();
    assert_eq!(m.project_path, "-Users-x-proj");
    assert_eq!(m.session_id, "aaaaaaaa-0000-0000-0000-000000000000");
    std::fs::remove_dir_all(&dir).ok();
}

// ===== cursor 解析器（样本行按源码枚举构造：user_message/tool_call/tool_result/
// turn_ended/turn_id/message_id；完整字段样本未验证，防御式）=====

#[test]
fn cursor_parse_skips_event_lines_unknown_types_and_truncation() {
    let lines = s(&[
        r#"{"type":"turn_id","id":"t1"}"#,
        r#"{"type":"user_message","message":{"content":[{"text":"写一个 hello world"}]},"timestamp":1786005441386}"#,
        r#"{"type":"message_id","id":"m1"}"#,
        r#"{"type":"tool_call","name":"read_file","timestamp":1786005441400}"#,
        r#"{"type":"tool_result","timestamp":1786005441450}"#,
        r#"{"type":"user_message","message":{"content":"纯字符串 content 也要能提取"},"time":1786005441460}"#,
        r#"{"type":"turn_ended","timestamp":1786005441500}"#,
        r#"{"type":"future_unknown_type","foo":1}"#,
        r#"{"type":"user_message","message":{"con"#, // 截断末行
    ]);
    let msgs = parse_cursor(&lines);
    assert_eq!(msgs.len(), 2, "事件行/未知类型/截断行都要跳过");
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].blocks[0].text, "写一个 hello world");
    assert_eq!(
        msgs[0].timestamp.as_deref(),
        Some("2026-08-06T08:37:21Z"),
        "毫秒 epoch 应转 ISO"
    );
    assert_eq!(msgs[1].blocks[0].text, "纯字符串 content 也要能提取");
    assert_eq!(msgs[1].timestamp.as_deref(), Some("2026-08-06T08:37:21Z"));
}

#[test]
fn cursor_meta_reads_title_and_falls_back_to_encoded_dir() {
    // 结构 projects/<编码cwd>/agent-transcripts/<uuid>/<uuid>.jsonl；
    // 行里没有 cwd 字段时：项目归属回落上三级编码目录名（有损不解码），session id 回落文件名
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let sess = dir
        .join("-Users-x-proj")
        .join("agent-transcripts")
        .join("bbbbbbbb-0000-0000-0000-000000000000");
    std::fs::create_dir_all(&sess).unwrap();
    let file = sess.join("bbbbbbbb-0000-0000-0000-000000000000.jsonl");
    let content = concat!(
        r#"{"type":"turn_id","id":"t1"}"#,
        "\n",
        r#"{"type":"user_message","message":{"content":[{"text":"帮我看这份数据"}]},"timestamp":1786005441386}"#,
        "\n",
    );
    std::fs::write(&file, content).unwrap();
    let m = cursor_file_meta(&file, true).unwrap();
    assert_eq!(m.agent, "cursor");
    assert_eq!(m.project_path, "-Users-x-proj");
    assert_eq!(m.session_id, "bbbbbbbb-0000-0000-0000-000000000000");
    assert_eq!(m.title.as_deref(), Some("帮我看这份数据"));
    assert!(m.created_at.is_some());
    assert!(m.alive);
    // 行里带 cwd 字段时优先用真实路径
    std::fs::write(
        &file,
        r#"{"type":"user_message","message":{"content":[{"text":"hi"}]},"cwd":"/Users/x/proj","timestamp":1786005441386}"#,
    )
    .unwrap();
    let m = cursor_file_meta(&file, true).unwrap();
    assert_eq!(m.project_path, "/Users/x/proj");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn tail_state_cursor() {
    let working = s(&[
        r#"{"type":"turn_ended"}"#,
        r#"{"type":"user_message","message":{"content":[{"text":"继续"}]}}"#,
    ]);
    assert_eq!(
        cursor_tail_state(&working),
        "working",
        "发了消息还没回合结束"
    );
    let tool = s(&[r#"{"type":"tool_call","name":"read_file"}"#]);
    assert_eq!(cursor_tail_state(&tool), "working");
    let done = s(&[
        r#"{"type":"user_message","message":{"content":[{"text":"hi"}]}}"#,
        r#"{"type":"future_unknown_type"}"#, // 未知 type 跳过，不算最新状态
        r#"{"type":"turn_ended"}"#,
    ]);
    assert_eq!(cursor_tail_state(&done), "settled");
    assert_eq!(cursor_tail_state(&[]), "unknown");
}

#[test]
fn cursor_deletable_whitelist_limits_to_agent_transcripts() {
    // projects_root 由调用方 canonicalize；测试里直接用临时目录
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let root = dir.join("projects");
    let ok = root
        .join("-tmp-x")
        .join("agent-transcripts")
        .join("u1")
        .join("u1.jsonl");
    assert!(
        cursor_deletable(&ok, &root),
        "agent-transcripts 下的 .jsonl 放行"
    );
    assert!(
        !cursor_deletable(&root.join("-tmp-x").join("other.jsonl"), &root),
        "agent-transcripts 之外的 jsonl 必须拒绝"
    );
    assert!(
        !cursor_deletable(
            &root
                .join("-tmp-x")
                .join("agent-transcripts")
                .join("u1")
                .join("meta.json"),
            &root
        ),
        "agent-transcripts 下的非 .jsonl 必须拒绝"
    );
    assert!(
        !cursor_deletable(&root.join("-tmp-x").join("agent-transcripts"), &root),
        "agent-transcripts 本身（下面没有文件）必须拒绝"
    );
    assert!(
        !cursor_deletable(&dir.join("auth.json"), &root),
        "projects 之外（同根 auth.json）必须拒绝"
    );
    std::fs::remove_dir_all(&dir).ok();
}

// ===== Grok Build 解析（updates.jsonl 的 ACP session/update 行） =====

#[test]
fn grok_parse_messages_skips_unknown_update_types_and_truncation() {
    let lines = s(&[
        r#"{"timestamp":1786005441,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"写一个 hello world"}}}}"#,
        r#"{"timestamp":1786005442,"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"read_file"}}}"#,
        r#"{"timestamp":1786005443,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"好的，已写好"}}}}"#,
        r#"{"timestamp":1786005444,"method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[]}}}"#,
        r#"{"timestamp":1786005445,"method":"_x.ai/custom","params":{"foo":1}}"#,
        r#"{"timestamp":1786005446,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"#, // 截断末行
    ]);
    let msgs = parse_grok(&lines);
    assert_eq!(msgs.len(), 2, "tool_call/plan/扩展通知/截断行都要跳过");
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].blocks[0].text, "写一个 hello world");
    assert_eq!(
        msgs[0].timestamp.as_deref(),
        Some("2026-08-06T08:37:21Z"),
        "unix 秒应转 ISO"
    );
    assert_eq!(msgs[1].role, "assistant");
    assert_eq!(msgs[1].blocks[0].text, "好的，已写好");
}

#[test]
fn grok_parse_unwraps_user_query_in_chunks() {
    let lines = s(&[
        r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"<user_query>\n你好\n</user_query>"}}}}"#,
    ]);
    let msgs = parse_grok(&lines);
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].blocks[0].text, "你好");
}

#[test]
fn grok_parse_merges_streaming_chunks_and_tool_calls_split_runs() {
    let lines = s(&[
        r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"我来"}}}}"#,
        r#"{"timestamp":2,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"查一下。"}}}}"#,
        r#"{"timestamp":3,"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1"}}}"#,
        r#"{"timestamp":4,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"查到了。"}}}}"#,
        r#"{"timestamp":5,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"好"}}}}"#,
        r#"{"timestamp":6,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"，继续"}}}}"#,
    ]);
    let msgs = parse_grok(&lines);
    assert_eq!(msgs.len(), 3, "连续同角色 chunk 合并；tool_call 打断");
    assert_eq!(msgs[0].blocks[0].text, "我来查一下。");
    assert_eq!(msgs[0].timestamp.as_deref().is_some(), true);
    assert_eq!(msgs[1].blocks[0].text, "查到了。");
    assert_eq!(msgs[2].role, "user");
    assert_eq!(msgs[2].blocks[0].text, "好，继续");
}

#[test]
fn grok_history_prefers_canonical_prompts_and_skips_runtime_context() {
    let lines = s(&[
        r#"{"type":"system","content":"context"}"#,
        r#"{"type":"user","content":"runtime context"}"#,
        r#"{"type":"user","synthetic_reason":"system_reminder","content":"hidden"}"#,
        r#"{"type":"user","prompt_index":0,"content":[{"type":"text","text":"第一问"}]}"#,
        r#"{"type":"assistant","content":"第一答"}"#,
        r#"{"type":"tool_result","content":"并进上一条助手消息"}"#,
        r#"{"type":"user","prompt_index":1,"content":[{"type":"text","text":"第二问"},{"type":"image","data":"..."}]}"#,
        r#"{"type":"assistant","content":"第二答"}"#,
    ]);
    let messages = parse_grok_history(&lines);
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].blocks[0].text, "第一问");
    assert_eq!(messages[3].blocks[0].text, "第二答");
}

/// Grok 1.0.62 chat_history.jsonl 的原样形状（2026-10-20 Windows 实跑「新建→改→删」，路径脱敏）：
/// 助手行只有 tool_calls、content 为空；tool_result 带 tool_call_id
#[test]
fn grok_history_keeps_tool_calls_and_results_paired() {
    let lines = s(&[
        r#"{"type":"user","prompt_index":0,"content":[{"type":"text","text":"<user_query>\n新建 notes.txt 再把 banana 改成 blueberry\n</user_query>"}]}"#,
        r#"{"type":"reasoning","id":"r1","summary":""}"#,
        r#"{"type":"assistant","content":"","tool_calls":[{"id":"call_1","name":"write","arguments":"{\"content\":\"apple\\nbanana\\n\",\"file_path\":\"C:\\\\w\\\\notes.txt\"}"}],"model_id":"glm-5.3-flash"}"#,
        r#"{"type":"tool_result","tool_call_id":"call_1","content":"The file C:\\w\\notes.txt has been created."}"#,
        r#"{"type":"assistant","content":"","tool_calls":[{"id":"call_2","name":"search_replace","arguments":"{\"file_path\":\"C:\\\\w\\\\notes.txt\",\"new_string\":\"blueberry\",\"old_string\":\"banana\"}"}]}"#,
        r#"{"type":"tool_result","tool_call_id":"call_2","content":"The file C:\\w\\notes.txt has been updated successfully."}"#,
        r#"{"type":"assistant","content":"完成。","tool_calls":[{"id":"call_3","function":{"name":"run_terminal_command","arguments":{"command":"Remove-Item notes.txt"}}}]}"#,
    ]);
    let messages = parse_grok_history(&lines);
    assert_eq!(messages.len(), 4, "一问 + 三条助手消息，工具结果并进各自的助手消息");
    assert_eq!(messages[0].blocks[0].text, "新建 notes.txt 再把 banana 改成 blueberry");
    let call = &messages[1].blocks[0];
    assert_eq!((call.kind.as_str(), call.tool_name.as_deref()), ("tool_use", Some("write")));
    assert!(call.text.contains("\"file_path\""), "参数原样保留给前端画差异：{}", call.text);
    assert_eq!(call.call_id.as_deref(), Some("call_1"));
    let result = &messages[1].blocks[1];
    assert_eq!((result.kind.as_str(), result.call_id.as_deref()), ("tool_result", Some("call_1")));
    assert_eq!(messages[2].blocks[0].tool_name.as_deref(), Some("search_replace"));
    // 有文字也有工具调用：文字在前；function 包一层、参数是对象的也认
    assert_eq!(messages[3].blocks[0].text, "完成。");
    assert_eq!(messages[3].blocks[1].tool_name.as_deref(), Some("run_terminal_command"));
    assert!(messages[3].blocks[1].text.contains("Remove-Item"));
}

/// chat_history 不带时间：回合起止取自事件流，从尾部对齐（事件流窗口可能丢了更早的回合）
#[test]
fn grok_history_gets_turn_times_from_updates() {
    let updates = s(&[
        r#"{"timestamp":1000,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"窗口外残留"}}}}"#,
        r#"{"timestamp":1100,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"第二问"}}}}"#,
        r#"{"timestamp":1101,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"text":"续"}}}}"#,
        r#"{"timestamp":1110,"method":"session/update","params":{"update":{"sessionUpdate":"tool_call"}}}"#,
        r#"{"timestamp":1190,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"答"}}}}"#,
    ]);
    let spans = grok_turn_spans(&updates);
    assert_eq!(spans.len(), 1, "没有提问开头的残留事件不算回合");
    assert_eq!(spans[0].0, iso_from_unix(1100));
    assert_eq!(spans[0].1, iso_from_unix(1190));
    let lines = s(&[
        r#"{"type":"user","prompt_index":0,"content":"第一问"}"#,
        r#"{"type":"assistant","content":"第一答"}"#,
        r#"{"type":"user","prompt_index":1,"content":"第二问"}"#,
        r#"{"type":"assistant","content":"","tool_calls":[{"id":"c1","name":"read","arguments":"{}"}]}"#,
        r#"{"type":"tool_result","tool_call_id":"c1","content":"x"}"#,
        r#"{"type":"assistant","content":"第二答"}"#,
    ]);
    let mut messages = parse_grok_history(&lines);
    stamp_grok_history(&mut messages, &spans);
    assert_eq!(messages[0].timestamp, None, "事件流窗口外的旧回合不标");
    assert_eq!(messages[1].timestamp, None);
    assert_eq!(messages[2].timestamp.as_deref(), Some(iso_from_unix(1100).as_str()));
    assert_eq!(messages[3].timestamp, None, "回合中间的助手消息不标");
    assert_eq!(messages[4].timestamp.as_deref(), Some(iso_from_unix(1190).as_str()));
}

#[test]
fn grok_history_unwraps_user_query_tags() {
    let lines = s(&[
        r#"{"type":"user","prompt_index":0,"content":"<user_query>\n你好\n</user_query>"}"#,
        r#"{"type":"assistant","content":"你好，需要我做什么？"}"#,
    ]);
    let messages = parse_grok_history(&lines);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].blocks[0].text, "你好");
    assert!(
        !messages[0].blocks[0].text.contains("user_query"),
        "回放不得露出 <user_query>"
    );
}

#[test]
fn grok_strips_turn_aborted_marker() {
    assert_eq!(
        unwrap_prompt_tags(
            "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"
        ),
        ""
    );
    assert_eq!(
        unwrap_prompt_tags("先说一句。<turn_aborted>\naborted\n</turn_aborted>"),
        "先说一句。"
    );
    let history = parse_grok_history(&s(&[
        r#"{"type":"user","prompt_index":0,"content":"你好"}"#,
        r#"{"type":"assistant","content":"<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"}"#,
        r#"{"type":"user","prompt_index":1,"content":"你好"}"#,
    ]));
    assert_eq!(history.len(), 2, "纯暂停标记不当成助手回复");
    assert_eq!(history[0].role, "user");
    assert_eq!(history[1].role, "user");
    let chunks = parse_grok(&s(&[
        r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"你好"}}}}"#,
        r#"{"timestamp":2,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"<turn_aborted>\ninterrupted\n</turn_aborted>"}}}}"#,
    ]));
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].role, "user");
}

#[test]
fn pasted_content_wrapper_is_unwrapped_for_user_text_and_titles() {
    // 2026-10-19 用户实测：聊天里发多行提问，气泡里露出 <pasted_content id="79fb">
    let raw = "\n\n<pasted_content id=\"79fb\">\n不要调用任何工具。\n1. 三个标题\n</pasted_content id=\"79fb\">";
    assert_eq!(unwrap_pasted_content(raw), "不要调用任何工具。\n1. 三个标题");
    // 前后还有别的话、多段粘贴、缺收尾（尾部截断）
    assert_eq!(
        unwrap_pasted_content("先看这个：<pasted_content id=\"a\">\nA\n</pasted_content id=\"a\">，再看<pasted_content id=\"b\">\nB\n</pasted_content id=\"b\">"),
        "先看这个：A，再看B"
    );
    assert_eq!(unwrap_pasted_content("<pasted_content id=\"c\">\n只有开头"), "只有开头");
    // 无包装原样返回（缩进不动）；正文里谈到这个词（不是完整标签）也不动
    assert_eq!(unwrap_pasted_content("  缩进保留\n第二行"), "  缩进保留\n第二行");
    assert_eq!(unwrap_pasted_content("<pasted_content_x>不是</pasted_content_x>"), "<pasted_content_x>不是</pasted_content_x>");
    assert_eq!(unwrap_pasted_content("用 <pasted_content 这种写法"), "用 <pasted_content 这种写法");
    // 宽度会变的字符不能 panic
    assert_eq!(unwrap_pasted_content("İ<PASTED_CONTENT id=\"x\">ß好</PASTED_CONTENT id=\"x\">"), "İß好");
    // 只对用户消息生效；助手正文原样
    assert_eq!(clean_block_text("user", raw), "不要调用任何工具。\n1. 三个标题");
    assert_eq!(clean_block_text("assistant", raw), raw.trim());
    // 标题取包装里的第一句，而不是被当成「<」开头的占位丢掉
    assert_eq!(
        usable_title(raw).as_deref(),
        Some("不要调用任何工具。 1. 三个标题")
    );
}

#[test]
fn claude_new_style_local_command_rows_replay_as_command_blocks() {
    // 新版 Claude（2026-10-19 实测）：本地命令记成 system/local_command，不是 user 行
    let lines = s(&[
        r#"{"type":"user","timestamp":"2026-10-19T07:00:00Z","message":{"role":"user","content":"你好"}}"#,
        r#"{"type":"system","subtype":"local_command","timestamp":"2026-10-19T07:01:00Z","content":"<command-name>/usage</command-name>\n            <command-message>usage</command-message>\n            <command-args></command-args>","isMeta":false}"#,
        r#"{"type":"system","subtype":"local_command","timestamp":"2026-10-19T07:01:05Z","content":"<local-command-stdout>Settings dialog dismissed</local-command-stdout>","isMeta":false,"commandRun":{"command":"usage","args":""}}"#,
        r#"{"type":"system","subtype":"turn_duration","timestamp":"2026-10-19T07:01:06Z"}"#,
    ]);
    let msgs = parse_claude(&lines);
    assert_eq!(msgs.len(), 2, "命令与输出并成一条：{msgs:?}");
    assert_eq!(msgs[1].role, "user");
    assert_eq!(msgs[1].timestamp.as_deref(), Some("2026-10-19T07:01:00Z"));
    let kinds: Vec<_> = msgs[1].blocks.iter().map(|b| (b.kind.as_str(), b.text.as_str())).collect();
    assert_eq!(
        kinds,
        vec![("command", "/usage"), ("command_output", "Settings dialog dismissed")]
    );
    // 其他 system 子类型（turn_duration 等）不进对话
    assert!(msgs.iter().all(|m| m.blocks.iter().all(|b| b.kind != "text" || !b.text.contains("turn_duration"))));
}

#[test]
fn claude_new_style_local_command_output_settles_tail() {
    // 会话第一件事就是 /cost：没有 turn_duration，只有两行 system/local_command
    let only_cmd = s(&[
        r#"{"type":"system","subtype":"local_command","content":"<command-name>/usage</command-name>\n<command-args></command-args>"}"#,
    ]);
    assert_eq!(claude_tail_state(&only_cmd), "unknown", "面板还开着、输出没写：不判收尾");
    let done = s(&[
        r#"{"type":"system","subtype":"local_command","content":"<command-name>/usage</command-name>\n<command-args></command-args>"}"#,
        r#"{"type":"system","subtype":"local_command","content":"<local-command-stdout>Settings dialog dismissed</local-command-stdout>"}"#,
    ]);
    assert_eq!(claude_tail_state(&done), "settled");
}

#[test]
fn claude_turn_end_after_sees_interrupt_and_ignores_older_turns() {
    // 2026-10-21 用户实测的形状：拒绝两个工具后只有打断标记与 turn_duration，没有 Stop hook
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("s.jsonl");
    let lines = [
        r#"{"type":"system","subtype":"turn_duration","timestamp":"2026-10-21T02:48:09.000Z"}"#,
        r#"{"type":"user","timestamp":"2026-10-21T02:49:22.000Z","message":{"role":"user","content":"在当前目录依次完成"}}"#,
        r#"{"type":"user","timestamp":"2026-10-21T02:50:05.100Z","message":{"role":"user","content":[{"type":"tool_result","is_error":true,"content":"The user doesn't want to proceed"}]}}"#,
        r#"{"type":"user","timestamp":"2026-10-21T02:50:05.200Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#,
        r#"{"type":"system","subtype":"turn_duration","timestamp":"2026-10-21T02:50:05.300Z"}"#,
    ];
    std::fs::write(&f, lines.join("\n") + "\n").unwrap();
    let ms = |t: &str| chrono::DateTime::parse_from_rfc3339(t).unwrap().timestamp_millis();
    // 这一轮 02:49:22 开始：打断标记在后面 → interrupted
    assert_eq!(claude_turn_end_after(&f, ms("2026-10-21T02:49:22.000Z")), Some("interrupted"));
    // 上一轮的 turn_duration 不算这一轮的收尾
    std::fs::write(&f, lines[..2].join("\n") + "\n").unwrap();
    assert_eq!(claude_turn_end_after(&f, ms("2026-10-21T02:49:22.000Z")), None);
    // 正常结束只有 turn_duration
    let normal = [lines[1], lines[4]];
    std::fs::write(&f, normal.join("\n") + "\n").unwrap();
    assert_eq!(claude_turn_end_after(&f, ms("2026-10-21T02:49:22.000Z")), Some("end_turn"));
    // 2026-11-09「立即发送」：打断标记后 15ms 就是新提问，新一轮开始的时刻早于标记也不算这一轮被打断；它说完才收
    let send_now = [
        r#"{"type":"user","timestamp":"2026-11-09T07:04:48.774Z","message":{"role":"user","content":"好的"}}"#,
        r#"{"type":"user","timestamp":"2026-11-09T07:05:03.543Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
        r#"{"type":"user","timestamp":"2026-11-09T07:05:03.558Z","message":{"role":"user","content":"检索不满意 我可以回来修改吗"}}"#,
        r#"{"type":"assistant","timestamp":"2026-11-09T07:05:25.965Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"…"}]}}"#,
    ];
    std::fs::write(&f, send_now.join("\n") + "\n").unwrap();
    assert_eq!(claude_turn_end_after(&f, ms("2026-11-09T07:05:03.500Z")), None);
    let done = [send_now[0], send_now[1], send_now[2], send_now[3], r#"{"type":"system","subtype":"turn_duration","timestamp":"2026-11-09T07:05:31.598Z"}"#];
    std::fs::write(&f, done.join("\n") + "\n").unwrap();
    assert_eq!(claude_turn_end_after(&f, ms("2026-11-09T07:05:03.500Z")), Some("end_turn"));
    // 2026-11-09 排队：上一段说完写了 turn_duration，排着的那句还没取出 → 不算收尾；取出后当新一轮，说完才算
    let queued = [
        r#"{"type":"user","timestamp":"2026-11-09T07:40:00.000Z","message":{"role":"user","content":"做检索"}}"#,
        r#"{"type":"queue-operation","operation":"enqueue","timestamp":"2026-11-09T07:51:26.055Z","content":"我在 Mesa 里答了"}"#,
        r#"{"type":"system","subtype":"turn_duration","timestamp":"2026-11-09T07:51:35.641Z"}"#,
        r#"{"type":"queue-operation","operation":"dequeue","timestamp":"2026-11-09T07:51:35.772Z"}"#,
        r#"{"type":"user","timestamp":"2026-11-09T07:51:35.989Z","message":{"role":"user","content":"我在 Mesa 里答了"}}"#,
        r#"{"type":"system","subtype":"turn_duration","timestamp":"2026-11-09T07:54:14.431Z"}"#,
    ];
    let start = ms("2026-11-09T07:40:00.000Z");
    std::fs::write(&f, queued[..3].join("\n") + "\n").unwrap();
    assert_eq!(claude_turn_end_after(&f, start), None, "排着的还没取出");
    std::fs::write(&f, queued[..5].join("\n") + "\n").unwrap();
    assert_eq!(claude_turn_end_after(&f, start), None, "取出来当新一轮在跑");
    std::fs::write(&f, queued.join("\n") + "\n").unwrap();
    assert_eq!(claude_turn_end_after(&f, start), Some("end_turn"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn claude_tool_result_is_error_flag_passes_through() {
    // 2026-10-19 实测：WebFetch 被拦「Unable to verify if domain … is safe to fetch」开头不像报错，只有 is_error 标着
    let lines = s(&[
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"WebFetch","input":{"url":"https://crates.io"}}]}}"#,
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"Unable to verify if domain crates.io is safe to fetch."}]}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"echo ok"}}]}}"#,
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","is_error":false,"content":"ok"}]}}"#,
    ]);
    let msgs = parse_claude(&lines);
    let flags: Vec<bool> = msgs
        .iter()
        .flat_map(|m| m.blocks.iter().filter(|b| b.kind == "tool_result").map(|b| b.is_error))
        .collect();
    assert_eq!(flags, vec![true, false]);
    let json = serde_json::to_string(&msgs).unwrap();
    assert_eq!(json.matches("isError").count(), 1, "没出错的块不带这个字段：{json}");
}

/// 消息 id 与工具调用 id 透传给前端（聊天层按 id 配对调用和结果、当稳定身份；docs/design-chat-structured-channels.md §4）
#[test]
fn message_and_call_ids_pass_through() {
    let lines = s(&[
        r#"{"type":"user","uuid":"u-1","message":{"role":"user","content":"跑一下"}}"#,
        r#"{"type":"assistant","uuid":"a-1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
        r#"{"type":"user","uuid":"u-2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
    ]);
    let msgs = parse_claude(&lines);
    assert_eq!(msgs[0].id.as_deref(), Some("u-1"));
    assert_eq!(msgs[1].id.as_deref(), Some("a-1"));
    let calls: Vec<Option<&str>> = msgs[1].blocks.iter().map(|b| b.call_id.as_deref()).collect();
    assert_eq!(calls, vec![Some("t1"), Some("t1")], "结果并进调用那条消息，两头都带 id");
    let codex = s(&[
        r#"{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"c1"}}"#,
        r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}"#,
    ]);
    let msgs = parse_codex(&codex);
    assert!(msgs
        .iter()
        .flat_map(|m| &m.blocks)
        .all(|b| b.call_id.as_deref() == Some("c1")));
    // 没有 id 的来源不带这个字段
    let json = serde_json::to_string(&parse_claude(&s(&[
        r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
    ])))
    .unwrap();
    assert!(!json.contains("\"id\"") && !json.contains("callId"), "{json}");
}

#[test]
fn claude_permission_mode_reads_latest_switch() {
    // 2026-10-19 用户会话：审批时选了切到 auto，文件尾部写 permission-mode auto
    let lines = s(&[
        r#"{"type":"permission-mode","permissionMode":"default"}"#,
        r#"{"type":"user","permissionMode":"default","message":{"role":"user","content":"Mesa是什么"}}"#,
        r#"{"type":"mode","mode":"normal"}"#,
        r#"{"type":"permission-mode","permissionMode":"auto"}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好"}]}}"#,
    ]);
    assert_eq!(claude_permission_mode(&lines).as_deref(), Some("auto"));
    assert_eq!(claude_permission_mode(&s(&[r#"{"type":"assistant","message":{}}"#])), None);
}

#[test]
fn claude_interrupt_marker_is_not_a_user_bubble() {
    let lines = s(&[
        r#"{"type":"user","message":{"role":"user","content":"运行 rm 一下"}}"#,
        r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#,
        r#"{"type":"user","message":{"role":"user","content":"[Request interrupted by user]"}}"#,
        r#"{"type":"user","message":{"role":"user","content":"[Request interrupted by user] 但这句有别的话"}}"#,
    ]);
    let msgs = parse_claude(&lines);
    let texts: Vec<_> = msgs.iter().flat_map(|m| m.blocks.iter().map(|b| b.text.as_str())).collect();
    assert_eq!(texts, vec!["运行 rm 一下", "[Request interrupted by user] 但这句有别的话"]);
}

// 2026-10-26 审查（本机实录形状）：分叉提示作为 <system-reminder> 段和用户原话放在同一条消息里，只留原话
#[test]
fn claude_system_reminder_part_is_not_user_text() {
    let lines = s(&[
        r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>\nThe user forked this conversation from an earlier message into session local_x.\n</system-reminder>\n\n"},{"type":"text","text":"现在可以了，你看一下"}]}}"#,
    ]);
    let msgs = parse_claude(&lines);
    let texts: Vec<_> = msgs.iter().flat_map(|m| m.blocks.iter().map(|b| b.text.as_str())).collect();
    assert_eq!(texts, vec!["现在可以了，你看一下"]);
}

#[test]
fn claude_pasted_prompt_replays_without_wrapper() {
    let lines = s(&[
        r#"{"type":"user","message":{"role":"user","content":"\n\n<pasted_content id=\"79fb\">\n第一行\n第二行\n</pasted_content id=\"79fb\">"}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"收到"}]}}"#,
    ]);
    let mut msgs = parse_claude(&lines);
    redact_conversation(&mut msgs);
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].blocks[0].text, "第一行\n第二行");
    assert!(!msgs[0].blocks[0].text.contains("pasted_content"));
}

#[test]
fn tagged_block_ascii_ci_match_never_panics_on_width_changing_chars() {
    // İ/ß 这类字符 to_ascii_lowercase 后长度会变：旧实现用小写串下标切原串必 panic，
    // ASCII 逐字节比较返回的原串下标在任何多字节文本旁都安全。
    assert_eq!(unwrap_prompt_tags("İ<USER_QUERY>ß好</USER_QUERY>"), "İß好");
    assert_eq!(unwrap_prompt_tags("ẞ<turn_aborted>x</TURN_ABORTED>ß"), "ẞß");
}

#[test]
fn grok_history_page_loads_older_messages_by_message_cursor() {
    let dir = std::env::temp_dir().join(format!("ccode-grok-history-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let updates = dir.join("updates.jsonl");
    std::fs::write(&updates, "{}\n").unwrap();
    let mut history = String::new();
    for index in 0..85 {
        history.push_str(&format!(
            r#"{{"type":"user","prompt_index":{index},"content":"问 {index}"}}"#,
        ));
        history.push('\n');
    }
    std::fs::write(dir.join("chat_history.jsonl"), history).unwrap();
    let latest = grok_conversation_page(&updates, None).unwrap();
    assert_eq!(latest.messages.len(), 80);
    assert_eq!(latest.messages[0].blocks[0].text, "问 5");
    assert_eq!(latest.cursor, Some(5));
    let older = grok_conversation_page(&updates, latest.cursor).unwrap();
    assert_eq!(older.messages.len(), 5);
    assert_eq!(older.messages[0].blocks[0].text, "问 0");
    assert_eq!(older.cursor, None);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn grok_meta_reads_summary_json_and_falls_back_to_dir_name() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let sess = dir
        .join("sessions")
        .join("%2FUsers%2Fx%2Fproj")
        .join("018f7c2a-0000-7000-8000-000000000000");
    std::fs::create_dir_all(&sess).unwrap();
    let file = sess.join("updates.jsonl");
    std::fs::write(
        &file,
        r#"{"timestamp":1786005441,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"帮我看这份数据"}}}}"#,
    )
    .unwrap();
    // summary.json 提供 info.cwd/generated_title/current_model_id（比解码目录名可靠）
    std::fs::write(
        sess.join("summary.json"),
        r#"{"info":{"id":"018f7c2a-0000-7000-8000-000000000000","cwd":"/Users/x/proj"},"generated_title":"看数据","created_at":1786005441,"updated_at":1786005500,"num_messages":2,"current_model_id":"grok-code-fast-1"}"#,
    )
    .unwrap();
    let (m, parent) = grok_file_meta(&file, true).unwrap();
    assert_eq!(m.agent, "grok");
    assert_eq!(m.project_path, "/Users/x/proj", "info.cwd 优先于目录名");
    assert_eq!(m.session_id, "018f7c2a-0000-7000-8000-000000000000");
    assert_eq!(m.title.as_deref(), Some("看数据"));
    assert_eq!(m.created_at.as_deref(), Some("2026-08-06T08:37:21Z"));
    assert_eq!(m.updated_at.as_deref(), Some("2026-08-06T08:38:20Z"));
    assert!(parent.is_none());
    // summary.json 缺失时：项目归属回落 encoded-cwd 目录名（不解码），标题从 updates.jsonl 首条用户消息提取
    std::fs::remove_file(sess.join("summary.json")).unwrap();
    let (m, parent) = grok_file_meta(&file, true).unwrap();
    assert!(parent.is_none());
    assert_eq!(m.project_path, "%2FUsers%2Fx%2Fproj");
    assert_eq!(m.title.as_deref(), Some("帮我看这份数据"));
    assert!(m.created_at.is_some(), "行内 timestamp 兜底 created_at");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn grok_parent_session_merges_resume_chain() {
    let (child, parent) = grok_file_meta_from_summary(
        r#"{"info":{"id":"child","cwd":"/p"},"generated_title":"同题","parent_session_id":"parent","created_at":1786005441,"updated_at":1786005500}"#,
    );
    assert_eq!(child.session_id, "child");
    assert_eq!(parent.as_deref(), Some("parent"));
    let metas = vec![
        (
            SessionMetaDto {
                agent: "grok".into(),
                session_id: "parent".into(),
                project_path: "/p".into(),
                cwd: Some("/p".into()),
                title: Some("同题".into()),
                created_at: None,
                updated_at: Some("2026-08-06T08:00:00Z".into()),
                file_path: "/p/parent/updates.jsonl".into(),
                token_usage: None,
                cli_version: None,
                pinned: false,
                archived: false,
                custom_title: None,
                tags: Vec::new(),
                alive: true,
                chain_count: 1,
                workspace: None,
                step_name: None,
                summary: None,
                live: false,
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
                step_meta: Default::default(),
                title_by_user: false,
            },
            None,
        ),
        (child, parent),
    ];
    let (merged, members) = merge_codex_chains(metas);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].chain_count, 2);
    assert_eq!(merged[0].session_id, "child");
    assert_eq!(members.get("child").map(|v| v.len()), Some(2));
}

fn grok_file_meta_from_summary(summary: &str) -> (SessionMetaDto, Option<String>) {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let sess = dir.join("sessions").join("cwd").join("child");
    std::fs::create_dir_all(&sess).unwrap();
    let file = sess.join("updates.jsonl");
    std::fs::write(&file, "{}\n").unwrap();
    std::fs::write(sess.join("summary.json"), summary).unwrap();
    let pair = grok_file_meta(&file, true).unwrap();
    std::fs::remove_dir_all(&dir).ok();
    pair
}

#[test]
fn tail_state_grok() {
    // 用户消息发出后还没等到助手输出 → working
    let working = s(&[
        r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"已完成"}}}}"#,
        r#"{"timestamp":2,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"继续"}}}}"#,
    ]);
    assert_eq!(grok_tail_state(&working), "working");
    // 工具调用进行中 → working
    let tool = s(&[
        r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1"}}}"#,
    ]);
    assert_eq!(grok_tail_state(&tool), "working");
    // 助手输出收尾：问句判 confirm，陈述判 done；未知类型跳过不算最新状态
    let confirm = s(&[
        r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"}}}}"#,
        r#"{"timestamp":2,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"要我继续吗？"}}}}"#,
    ]);
    assert_eq!(grok_tail_state(&confirm), "confirm");
    let done = s(&[
        r#"{"timestamp":1,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"已完成。"}}}}"#,
        r#"{"timestamp":2,"method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[]}}}"#,
    ]);
    assert_eq!(
        grok_tail_state(&done),
        "done",
        "plan 等事件行跳过，不算最新状态"
    );
    assert_eq!(grok_tail_state(&[]), "unknown");
}

#[test]
fn grok_deletable_whitelist_limits_to_sessions_subdir() {
    // 白名单目录 = ~/.grok/sessions；同根的 auth.json/config.toml 与
    // sessions 根的 session_search.sqlite 均不在放行范围（目录闸 + .jsonl 后缀闸）
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let sessions = dir.join("sessions");
    let ok = sessions.join("%2Ftmp%2Fx").join("u1").join("updates.jsonl");
    assert!(
        ok.ends_with("updates.jsonl") && ok.starts_with(&sessions),
        "会话文件在 sessions 子目录内"
    );
    // deletable_session_file 需要 canonicalize 存在，建真文件验证
    std::fs::create_dir_all(ok.parent().unwrap()).unwrap();
    std::fs::write(&ok, "{}\n").unwrap();
    let dirs = vec![(sessions.clone(), false)];
    assert!(
        deletable_session_file(&ok, &dirs),
        "sessions/*/*/updates.jsonl 放行"
    );
    let summary = ok.parent().unwrap().join("summary.json");
    std::fs::write(&summary, "{}").unwrap();
    assert!(
        !deletable_session_file(&summary, &dirs),
        "同目录 summary.json（.json 不放行）必须拒绝"
    );
    let auth = dir.join("auth.json");
    std::fs::write(&auth, "{}").unwrap();
    assert!(
        !deletable_session_file(&auth, &dirs),
        "sessions 之外的 auth.json 必须拒绝"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn plain_conversation_page_loads_long_session_in_windows() {
    let dir = std::env::temp_dir().join(format!("ccode-page-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("long.jsonl");
    let mut content = String::new();
    for index in 0..4000 {
        content.push_str(&format!(
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"消息 {index:04} {}\"}},\"timestamp\":\"2026-07-01T00:00:00Z\"}}\n",
            "x".repeat(80)
        ));
    }
    std::fs::write(&file, &content).unwrap();
    let latest = plain_conversation_page("claude-code", &file, None, None).unwrap();
    assert!(latest.cursor.is_some(), "长会话首屏应提供更早页 cursor");
    assert!(latest
        .messages
        .last()
        .is_some_and(|message| message.blocks[0].text.contains("消息 3999")));
    let older = plain_conversation_page("claude-code", &file, latest.cursor, None).unwrap();
    assert!(!older.messages.is_empty());
    assert_ne!(
        older.messages.last().unwrap().blocks[0].text,
        latest.messages.first().unwrap().blocks[0].text
    );

    let needle = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"消息 0100 ";
    let at = content.find(needle).expect("early message") as u64;
    let mid = plain_conversation_page("claude-code", &file, None, Some(at)).unwrap();
    assert!(
        mid.messages
            .iter()
            .any(|m| m.blocks[0].text.contains("消息 0100")),
        "around 窗口应包含命中那一条"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn conversation_rest_gives_everything_before_the_first_page() {
    let dir = std::env::temp_dir().join(format!("ccode-rest-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("long.jsonl");
    let mut content = String::new();
    for index in 0..4000 {
        content.push_str(&format!(
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"消息 {index:04} {}\"}},\"timestamp\":\"2026-07-01T00:00:00Z\"}}\n",
            "x".repeat(80)
        ));
    }
    std::fs::write(&file, &content).unwrap();
    let path = file.to_str().unwrap();
    let latest = conversation_page_impl("claude-code", path, None, None).unwrap();
    let rest = conversation_rest_impl("claude-code", path, latest.cursor.unwrap()).unwrap();
    assert_eq!(rest.cursor, None);
    // 拼起来正好是全文，不重不漏
    let joined: Vec<String> = rest
        .messages
        .iter()
        .chain(latest.messages.iter())
        .map(|m| m.blocks[0].text.clone())
        .collect();
    let full: Vec<String> = conversation_impl("claude-code", path)
        .iter()
        .map(|m| m.blocks[0].text.clone())
        .collect();
    assert_eq!(joined.len(), 4000);
    assert_eq!(joined, full);
    std::fs::remove_dir_all(&dir).ok();
}

fn claude_user_line(text: &str) -> String {
    format!(
        "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{text}\"}},\"timestamp\":\"2026-07-01T00:00:00Z\"}}\n"
    )
}

#[test]
fn plain_conversation_page_reaches_past_huge_prompt_snapshot() {
    // Claude 2.1.x 每轮写一行几百 KB 的 prompt_snapshot：首屏不能只剩最后一句提问（2026-10-17 用户截图）
    let dir = std::env::temp_dir().join(format!("ccode-snapshot-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("s.jsonl");
    let mut content = String::new();
    // 24 轮 = 48 条 + 最新一问：够 40 条要往前读二十来行快照（约 5MB），验证窗口翻倍能读到
    for turn in 0..24 {
        content.push_str(&claude_user_line(&format!("问题 {turn}")));
        content.push_str(&format!(
            "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"回答 {turn}\"}}]}}}}\n"
        ));
        content.push_str(&format!(
            "{{\"type\":\"attachment\",\"attachment\":{{\"type\":\"prompt_snapshot\",\"systemPrompt\":[\"{}\"]}}}}\n",
            "p".repeat(260 * 1024)
        ));
    }
    content.push_str(&claude_user_line("最新的问题"));
    std::fs::write(&file, &content).unwrap();
    let latest = plain_conversation_page("claude-code", &file, None, None).unwrap();
    let texts: Vec<&str> = latest.messages.iter().map(|m| m.blocks[0].text.as_str()).collect();
    assert!(texts.len() >= CONVERSATION_PAGE_MIN_MESSAGES, "{texts:?}");
    assert_eq!(texts.last(), Some(&"最新的问题"));
    assert!(texts.contains(&"回答 23"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn plain_conversation_page_skips_oversized_jsonl_line() {
    // Codex 工具行经常 >192KB：旧分页会把 cursor 钉在超长行尾，加载更早死循环。
    let dir = std::env::temp_dir().join(format!("ccode-huge-line-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("huge.jsonl");
    let huge = "H".repeat(300_000);
    let mut content = String::new();
    // 首屏要攒够 CONVERSATION_PAGE_MIN_MESSAGES 条才停，窗口还会翻倍到 1.5MB：
    // 前面多放几屏的早消息，才有「更早一页」
    for i in 0..12000 {
        content.push_str(&claude_user_line(&format!("early-msg {i:05} {}", "e".repeat(80))));
    }
    content.push_str(&claude_user_line(&huge));
    content.push_str(&claude_user_line("late-msg"));
    std::fs::write(&file, &content).unwrap();

    let latest = plain_conversation_page("claude-code", &file, None, None).unwrap();
    assert!(
        latest
            .messages
            .iter()
            .any(|m| m.blocks[0].text.contains("late-msg")),
        "尾页应有最后一条短消息: {:?}",
        latest
            .messages
            .iter()
            .map(|m| &m.blocks[0].text)
            .collect::<Vec<_>>()
    );
    assert!(
        latest
            .messages
            .iter()
            .all(|m| !m.blocks[0].text.contains(&huge)),
        "超长行不应整页塞进回放"
    );
    let cursor = latest.cursor.expect("尾页后面还有更早内容");
    let older = plain_conversation_page("claude-code", &file, Some(cursor), None).unwrap();
    assert_ne!(
        older.cursor, latest.cursor,
        "cursor 必须前进，不能钉在超长行尾"
    );
    assert!(
        older
            .messages
            .iter()
            .any(|m| m.blocks[0].text.contains("early-msg")),
        "一次加载更早应跳过超长行读到更早消息: {:?}",
        older
            .messages
            .iter()
            .map(|m| &m.blocks[0].text)
            .collect::<Vec<_>>()
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn plain_conversation_page_skips_empty_event_windows() {
    let dir = std::env::temp_dir().join(format!("ccode-empty-win-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("events.jsonl");
    let mut content = String::new();
    for i in 0..2000 {
        content.push_str(&claude_user_line(&format!("early-msg {i:04} {}", "e".repeat(80))));
    }
    let filler = "{\"type\":\"ignore\",\"payload\":{}}\n";
    while content.len() < 250_000 {
        content.push_str(filler);
    }
    content.push_str(&claude_user_line("late-msg"));
    std::fs::write(&file, &content).unwrap();

    let latest = plain_conversation_page("claude-code", &file, None, None).unwrap();
    assert!(latest
        .messages
        .iter()
        .any(|m| m.blocks[0].text.contains("late-msg")));
    let cursor = latest.cursor.expect("中间有填充行，应还能往前");
    let older = plain_conversation_page("claude-code", &file, Some(cursor), None).unwrap();
    assert!(
        older
            .messages
            .iter()
            .any(|m| m.blocks[0].text.contains("early-msg")),
        "空窗（无对话行）应在同一次请求里连跳: {:?}",
        older
            .messages
            .iter()
            .map(|m| &m.blocks[0].text)
            .collect::<Vec<_>>()
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn redaction_masks_saved_secrets_everywhere() {
    let secret = "sk-stored-secret-123456".to_string();
    let text = format!("标题 {secret}，正文再次出现 {secret}");
    let redacted = redact_sensitive_text_with(&text, &[secret.clone()]);
    assert!(!redacted.contains(&secret));
    assert_eq!(redacted.matches("[已隐藏密钥 ···3456]").count(), 2);
}

#[test]
fn redaction_masks_common_secret_prefixes_without_saved_key() {
    let text = "Bearer sk-live-secret-987654, OPENAI_API_KEY=sk_second_secret_123456";
    let redacted = redact_sensitive_text_with(text, &[]);
    assert!(!redacted.contains("sk-live-secret-987654"));
    assert!(!redacted.contains("sk_second_secret_123456"));
    assert!(redacted.contains("Bearer [已隐藏密钥 ···7654],"));
    assert!(redacted.contains("OPENAI_API_KEY=[已隐藏密钥 ···3456]"));
    assert_eq!(redact_sensitive_text_with("sk-short", &[]), "sk-short");
}

#[test]
fn conversation_hides_turn_aborted_marker() {
    let mut messages = vec![
        ChatMessageDto {
            role: "user".into(),
            blocks: vec![text_block("你好".into())],
            timestamp: None,
            usage: None,
            id: None,
            cwd: None,
        },
        ChatMessageDto {
            role: "assistant".into(),
            blocks: vec![text_block(
                "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>"
                    .into(),
            )],
            timestamp: None,
            usage: None,
            id: None,
            cwd: None,
        },
    ];
    redact_conversation(&mut messages);
    assert_eq!(messages.len(), 1, "暂停标记不得当成助手回复");
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].blocks[0].text, "你好");
}

// ===== Codex 解析 =====

#[test]
fn codex_parse_messages_tools_and_usage() {
    let lines = s(&[
        r#"{"timestamp":"2026-07-20T00:00:00Z","type":"session_meta","payload":{"id":"019f-test","timestamp":"2026-07-20T00:00:00Z","cwd":"/tmp/proj","cli_version":"0.20.0"}}"#,
        r#"{"timestamp":"2026-07-20T00:00:01Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"指令跳过"}]}}"#,
        r#"{"timestamp":"2026-07-20T00:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi codex"}]}}"#,
        r#"{"timestamp":"2026-07-20T00:00:03Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}"#,
        r#"{"timestamp":"2026-07-20T00:00:04Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}"#,
        r#"{"timestamp":"2026-07-20T00:00:05Z","type":"response_item","payload":{"type":"function_call_output","output":"total 0"}}"#,
        r#"{"timestamp":"2026-07-20T00:00:06Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1599907,"output_tokens":12313,"reasoning_output_tokens":6571,"cached_input_tokens":1479104,"cache_write_input_tokens":0},"last_token_usage":{"input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5,"cached_input_tokens":10,"cache_write_input_tokens":0}}}}"#,
    ]);
    let msgs = parse_codex(&lines);
    assert_eq!(msgs.len(), 3, "developer 消息跳过，tool_result 并入上一条");
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].blocks[0].text, "hi codex");
    assert_eq!(msgs[1].role, "assistant");
    assert_eq!(msgs[1].blocks[0].text, "hello");
    assert_eq!(msgs[2].role, "assistant");
    assert_eq!(msgs[2].blocks[0].kind, "tool_use");
    assert_eq!(msgs[2].blocks[0].tool_name.as_deref(), Some("shell"));
    assert_eq!(msgs[2].blocks[1].kind, "tool_result");
    assert_eq!(msgs[2].blocks[1].text, "total 0");
    // 最后一次请求（last_token_usage）挂在最后一条 assistant 上，不是整场累计（total 那 160 万）；
    // input 去掉缓存命中的部分（codex 的 input 含 cached）；reasoning 已含在 output_tokens 里，不另加
    let u = msgs[2].usage.as_ref().unwrap();
    assert_eq!(
        (u.input, u.output, u.cache_read, u.cache_write),
        (90, 20, 10, 0)
    );
}

// 2026-10-26 审查（Codex 0.164 实录形状）：推理条目进「思考」；摘要优先，没摘要用原始推理；只有加密内容的不出
#[test]
fn codex_reasoning_becomes_thinking_block() {
    let lines = s(&[
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"测试一下"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"reasoning","id":"rs_1","summary":[],"content":[{"type":"reasoning_text","text":"The user wants a quick test."}],"encrypted_content":null}}"#,
        r#"{"type":"response_item","payload":{"type":"reasoning","id":"rs_2","summary":[{"type":"summary_text","text":"**规划步骤**\n\n先看目录"}],"content":[{"type":"reasoning_text","text":"raw"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"reasoning","id":"rs_3","summary":[],"encrypted_content":"gAAAA"}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好的"}]}}"#,
    ]);
    let msgs = parse_codex(&lines);
    let kinds: Vec<(&str, &str)> = msgs.iter().map(|m| (m.role.as_str(), m.blocks[0].kind.as_str())).collect();
    assert_eq!(kinds, [("user", "text"), ("assistant", "thinking"), ("assistant", "thinking"), ("assistant", "text")]);
    assert_eq!(msgs[1].blocks[0].text, "The user wants a quick test.");
    assert_eq!(msgs[2].blocks[0].text, "**规划步骤**\n\n先看目录", "有摘要用摘要");
}

// 2026-10-26 审查：中途换权限后 Codex 补写的 <environment_context> 不是用户说的话
#[test]
fn codex_skips_mid_session_environment_context() {
    let lines = s(&[
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"第一问"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <current_date>2026-10-26</current_date>\n</environment_context>"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"第二问"}]}}"#,
    ]);
    let texts: Vec<String> = parse_codex(&lines).iter().map(|m| m.blocks[0].text.clone()).collect();
    assert_eq!(texts, ["第一问", "第二问"]);
}

#[test]
fn codex_legacy_event_msg_fallback() {
    let lines = s(&[
        r#"{"type":"event_msg","payload":{"type":"user_message","message":"老格式提问"}}"#,
        r#"{"type":"event_msg","payload":{"type":"agent_message","message":"老格式回答"}}"#,
    ]);
    let msgs = parse_codex(&lines);
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[1].role, "assistant");
}

#[test]
fn codex_response_item_wins_over_legacy_dup() {
    let lines = s(&[
        r#"{"type":"event_msg","payload":{"type":"user_message","message":"重复的"}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"新的"}]}}"#,
    ]);
    let msgs = parse_codex(&lines);
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].blocks[0].text, "新的");
}

#[test]
fn codex_parse_skips_injected_agents_context_but_keeps_real_user_message() {
    let lines = s(&[
        r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n\n<INSTRUCTIONS>\nengineering rules\n</INSTRUCTIONS>"}]}}"##,
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"请分析这个项目"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好的"}]}}"#,
    ]);
    let msgs = parse_codex(&lines);
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].blocks[0].text, "请分析这个项目");
    assert_eq!(msgs[1].blocks[0].text, "好的");
}

#[test]
fn codex_meta_reads_session_meta_and_tail_usage() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file =
        dir.join("rollout-2026-07-20T00-00-00-019f8039-8bed-7323-8c9d-853c1e7a9edf.jsonl");
    let content = concat!(
        r#"{"timestamp":"2026-07-20T00:00:00Z","type":"session_meta","payload":{"id":"019f8039-8bed-7323-8c9d-853c1e7a9edf","timestamp":"2026-07-20T00:00:00Z","cwd":"/tmp/proj","cli_version":"0.20.0"}}"#,
        "\n",
        r#"{"timestamp":"2026-07-20T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"做点事"}]}}"#,
        "\n",
        r#"{"timestamp":"2026-07-20T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":50,"output_tokens":8,"cached_input_tokens":4,"cache_write_input_tokens":2}}}}"#,
        "\n",
    );
    std::fs::write(&file, content).unwrap();
    let (m, fork) = codex_file_meta(&file, true, false).unwrap();
    assert_eq!(m.project_path, "/tmp/proj");
    assert_eq!(m.session_id, "019f8039-8bed-7323-8c9d-853c1e7a9edf");
    assert_eq!(m.cli_version.as_deref(), Some("0.20.0"));
    assert_eq!(m.title.as_deref(), Some("做点事"));
    assert_eq!(m.chain_count, 1);
    assert!(!m.archived);
    assert_eq!(fork, None);
    let u = m.token_usage.unwrap();
    assert_eq!(
        (u.input, u.output, u.cache_read, u.cache_write),
        (46, 8, 4, 2),
        "整场累计同样拆掉缓存读（input_tokens 含 cached_input_tokens）"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn codex_archived_flag_comes_from_directory() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("rollout-x.jsonl");
    std::fs::write(
        &file,
        r#"{"type":"session_meta","payload":{"id":"t1","cwd":"/tmp/p","forked_from_id":"t0"}}"#,
    )
    .unwrap();
    let (m, fork) = codex_file_meta(&file, true, true).unwrap();
    assert!(
        m.archived,
        "archived_sessions 目录扫描出的文件必须带 archived 标记"
    );
    assert!(m.alive, "归档不等于已失效");
    assert_eq!(fork.as_deref(), Some("t0"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn codex_title_skips_pasted_history_blob() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("rollout-x.jsonl");
    let content = concat!(
        r#"{"type":"session_meta","payload":{"id":"t1","cwd":"/tmp/p"}}"#,
        "\n",
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"The following is the Codex agent history whose request actions..."}]}}"#,
        "\n",
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"真正的提问"}]}}"#,
        "\n",
    );
    std::fs::write(&file, content).unwrap();
    let (m, _) = codex_file_meta(&file, true, false).unwrap();
    assert_eq!(
        m.title.as_deref(),
        Some("真正的提问"),
        "粘贴的导出历史不能作标题"
    );

    let file2 = dir.join("rollout-y.jsonl");
    let content2 = concat!(
        r#"{"type":"session_meta","payload":{"id":"t2","cwd":"/tmp/p"}}"#,
        "\n",
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"The following is the Claude Code history..."}]}}"#,
        "\n",
    );
    std::fs::write(&file2, content2).unwrap();
    let (m2, _) = codex_file_meta(&file2, true, false).unwrap();
    assert_eq!(m2.title, None, "全是粘贴历史时标题为空");
    std::fs::remove_dir_all(&dir).ok();
}

// ===== Codex resume/fork 链合并 =====

fn codex_meta(id: &str, updated: &str, fork: Option<&str>) -> (SessionMetaDto, Option<String>) {
    (
        SessionMetaDto {
            agent: "codex".into(),
            session_id: id.into(),
            project_path: "/tmp/p".into(),
            cwd: Some("/tmp/p".into()),
            title: None,
            created_at: None,
            updated_at: Some(updated.into()),
            file_path: format!("/rollout-{id}.jsonl"),
            token_usage: None,
            cli_version: None,
            pinned: false,
            archived: false,
            custom_title: None,
            tags: Vec::new(),
            alive: true,
            chain_count: 1,
            workspace: None,
            step_name: None,
            summary: None,
            live: false,
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
            step_meta: Default::default(),
            title_by_user: false,
        },
        fork.map(String::from),
    )
}

#[test]
fn mesa_fork_stays_its_own_row_pointing_back_to_parent() {
    // t2 是 Mesa 分叉出来的（扫描时已去掉它的上游指针），t3 是在分叉上接着聊另存的；
    // 原会话 t1 自己又接着聊出 t4
    let metas = vec![
        codex_meta("t1", "2026-07-01T00:00:00Z", None),
        codex_meta("t2", "2026-07-02T00:00:00Z", None),
        codex_meta("t3", "2026-07-03T00:00:00Z", Some("t2")),
        codex_meta("t4", "2026-07-04T00:00:00Z", Some("t1")),
    ];
    let (mut merged, members) = merge_codex_chains(metas);
    apply_session_forks(
        &mut merged,
        &members,
        &[("codex".into(), "t2".into(), "t1".into()), ("codex".into(), "x".into(), "x".into())],
    );
    assert_eq!(merged.len(), 2, "分叉单列，原对话不被藏掉");
    let fork = merged.iter().find(|m| m.session_id == "t3").unwrap();
    assert_eq!(fork.forked_from.as_deref(), Some("t4"), "指回原对话那一行（链代表）");
    let parent = merged.iter().find(|m| m.session_id == "t4").unwrap();
    assert_eq!(parent.forked_from, None);
}

#[test]
fn codex_chain_merges_to_newest_representative() {
    let metas = vec![
        codex_meta("t1", "2026-07-01T00:00:00Z", None),
        codex_meta("t2", "2026-07-02T00:00:00Z", Some("t1")),
        codex_meta("t3", "2026-07-03T00:00:00Z", Some("t2")),
        codex_meta("u1", "2026-07-01T12:00:00Z", None), // 无关会话不受影响
    ];
    let (merged, members) = merge_codex_chains(metas);
    assert_eq!(merged.len(), 2);
    let rep = merged.iter().find(|m| m.chain_count == 3).unwrap();
    assert_eq!(rep.session_id, "t3", "代表是 updated_at 最新的文件");
    assert_eq!(rep.file_path, "/rollout-t3.jsonl");
    let single = merged.iter().find(|m| m.session_id == "u1").unwrap();
    assert_eq!(single.chain_count, 1);
    assert_eq!(
        members.get("t3").map(|v| v.len()),
        Some(3),
        "成员表记录链上全部 id 供 db meta 反查"
    );
    assert!(!members.contains_key("u1"), "单文件会话不进成员表");
}

const CA: &str = "aaaaaaaa-0000-4000-8000-000000000001";
const CB: &str = "bbbbbbbb-0000-4000-8000-000000000002";
const CC: &str = "cccccccc-0000-4000-8000-000000000003";

fn claude_line(sid: &str, ts: &str, kind: &str, text: &str) -> String {
    if kind == "user" {
        format!(
            r#"{{"type":"user","cwd":"/tmp/p","sessionId":"{sid}","timestamp":"{ts}","message":{{"role":"user","content":"{text}"}}}}"#
        )
    } else {
        format!(
            r#"{{"type":"assistant","sessionId":"{sid}","timestamp":"{ts}","message":{{"model":"m","content":[{{"type":"text","text":"{text}"}}],"usage":{{"input_tokens":10,"output_tokens":1}}}}}}"#
        )
    }
}

fn write_claude(dir: &Path, id: &str, lines: &[String]) -> PathBuf {
    let f = dir.join(format!("{id}.jsonl"));
    fs::write(&f, lines.join("\n") + "\n").unwrap();
    f
}

fn parse_claude_files(files: &[PathBuf]) -> Vec<(SessionMetaDto, ClaudeLineage)> {
    files
        .iter()
        .map(|f| claude_file_meta_lineage(f, true).unwrap())
        .collect()
}

/// 2026-10-21 实证结构：桌面版「继续」新开文件，先复制上游全部行（sessionId 仍是上游）
#[test]
fn claude_continuation_file_uses_file_name_as_id() {
    let dir = std::env::temp_dir().join(format!("ccode-cl-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let a = vec![
        claude_line(CA, "2026-10-18T01:00:00Z", "user", "第一句"),
        claude_line(CA, "2026-10-18T01:01:00Z", "assistant", "好"),
    ];
    let mut b = a.clone();
    b.push(claude_line(CB, "2026-10-19T08:01:00Z", "user", "继续"));
    let fb = write_claude(&dir, CB, &b);
    let (m, lin) = claude_file_meta_lineage(&fb, true).unwrap();
    assert_eq!(m.session_id, CB, "id 取文件名，不取开头复制来的上游 id");
    assert_eq!(m.title.as_deref(), Some("第一句"));
    assert_eq!(lin.parent.as_deref(), Some(CA));
    assert_eq!(lin.branch_at.as_deref(), Some("2026-10-19T08:01:00Z"));
    assert_eq!(lin.last_at.as_deref(), Some("2026-10-19T08:01:00Z"));
    assert_eq!(lin.own_title.as_deref(), Some("继续"));
    // 非 uuid 文件名（旧测试样本、手工文件）仍按内容 id
    let plain = dir.join("a.jsonl");
    fs::write(&plain, claude_line(CA, "2026-10-18T01:00:00Z", "user", "x")).unwrap();
    assert_eq!(claude_file_meta(&plain, true).unwrap().session_id, CA);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn claude_linear_continuations_merge_to_chain_tail() {
    let dir = std::env::temp_dir().join(format!("ccode-cl-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let a = vec![claude_line(CA, "2026-10-18T09:00:00Z", "user", "做宣传片")];
    let mut b = a.clone();
    b.push(claude_line(CB, "2026-10-18T16:01:00Z", "user", "继续完成"));
    let mut c = b.clone();
    c.push(claude_line(CC, "2026-10-19T01:18:00Z", "user", "再改一版"));
    let files = [
        write_claude(&dir, CA, &a),
        write_claude(&dir, CB, &b),
        write_claude(&dir, CC, &c),
    ];
    let metas = parse_claude_files(&files);
    assert_eq!(metas[2].1.parent.as_deref(), Some(CB), "直接上游是 B，不是最早的 A");
    let (reps, members, hidden) = merge_claude_chains(metas);
    assert_eq!(reps.len(), 1);
    assert_eq!(reps[0].session_id, CC, "代表是链尾，「继续」才接得上最新内容");
    assert_eq!(reps[0].chain_count, 3);
    assert_eq!(reps[0].forked_from, None);
    assert_eq!(members[CC].len(), 3);
    assert_eq!(hidden.len(), 2);
    assert!(hidden.iter().all(|(rep, _)| rep == CC));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn claude_fork_keeps_both_rows_and_marks_source() {
    let dir = std::env::temp_dir().join(format!("ccode-cl-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let shared = vec![claude_line(CA, "2026-10-16T17:00:00Z", "user", "思考过程显示")];
    // 上游在分叉之后还在写
    let mut a = shared.clone();
    a.push(claude_line(CA, "2026-10-18T04:24:00Z", "assistant", "后来的内容"));
    let mut b = shared.clone();
    b.push(claude_line(CB, "2026-10-17T15:18:00Z", "user", "终端是 iterm 怎么办"));
    let files = [write_claude(&dir, CA, &a), write_claude(&dir, CB, &b)];
    let (reps, members, hidden) = merge_claude_chains(parse_claude_files(&files));
    assert_eq!(reps.len(), 2, "两边各有对方没有的内容，不能合并");
    assert!(members.is_empty() && hidden.is_empty());
    let fork = reps.iter().find(|m| m.session_id == CB).unwrap();
    assert_eq!(fork.forked_from.as_deref(), Some(CA));
    assert_eq!(fork.title.as_deref(), Some("终端是 iterm 怎么办"), "分叉行用分叉后第一句当标题");
    let orig = reps.iter().find(|m| m.session_id == CA).unwrap();
    assert_eq!(orig.forked_from, None);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn claude_second_continuation_from_same_point_is_a_fork() {
    let dir = std::env::temp_dir().join(format!("ccode-cl-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let a = vec![claude_line(CA, "2026-10-18T09:00:00Z", "user", "起点")];
    let mut b = a.clone();
    b.push(claude_line(CB, "2026-10-18T10:00:00Z", "user", "第一次接着聊"));
    let mut c = a.clone();
    c.push(claude_line(CC, "2026-10-18T11:00:00Z", "user", "第二次接着聊"));
    let files = [
        write_claude(&dir, CA, &a),
        write_claude(&dir, CB, &b),
        write_claude(&dir, CC, &c),
    ];
    let (reps, _, hidden) = merge_claude_chains(parse_claude_files(&files));
    assert_eq!(reps.len(), 2);
    assert_eq!(hidden.len(), 1, "A 并进第一次接续 B");
    let second = reps.iter().find(|m| m.session_id == CC).unwrap();
    assert_eq!(
        second.forked_from.as_deref(),
        Some(CB),
        "分叉来源指向上游所在那一行（A 已并进 B）"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn codex_chain_survives_missing_parent_file() {
    // 父线程文件已被清理：forked_from_id 指向不存在的线程，链内剩余文件仍合并
    let metas = vec![
        codex_meta("t2", "2026-07-02T00:00:00Z", Some("t1")),
        codex_meta("t3", "2026-07-01T00:00:00Z", Some("t2")),
    ];
    let (merged, _) = merge_codex_chains(metas);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].chain_count, 2);
    assert_eq!(merged[0].session_id, "t2");
}

#[test]
fn meta_written_for_chain_member_applies_to_rep() {
    // 用户归档了旧代表 t2，链换人后代表变 t3：t3 没有自己的 meta 行时要按成员 id 找回
    let metas = vec![
        codex_meta("t2", "2026-07-02T00:00:00Z", Some("t1")),
        codex_meta("t3", "2026-07-03T00:00:00Z", Some("t2")),
    ];
    let (mut merged, members) = merge_codex_chains(metas);
    let mut meta: HashMap<(String, String), MetaRow> = HashMap::new();
    meta.insert(
        ("codex".to_string(), "t2".to_string()),
        MetaRow {
            pinned: true,
            archived: true,
            custom_title: Some("旧代表上的标题".into()),
            tags: vec!["重要".into()],
            summary: None,
            handoff_from: None,
            task_id: None,
            step_name: None,
            profile_id: None,
            project_path: None,
            internal: false,
            title_by_user: false,
        },
    );
    apply_meta(&mut merged, &members, &meta);
    let rep = merged.iter().find(|m| m.session_id == "t3").unwrap();
    assert!(rep.pinned);
    assert!(rep.archived);
    assert_eq!(rep.custom_title.as_deref(), Some("旧代表上的标题"));
    assert_eq!(rep.tags, vec!["重要".to_string()]);
}

// ===== zstd / 路径 / 时间 =====

#[test]
fn zstd_roundtrip_parses() {
    let raw =
        b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello zst\"}}\n"
            .to_vec();
    let compressed = zstd::stream::encode_all(&raw[..], 3).unwrap();
    assert!(compressed.starts_with(&ZSTD_MAGIC));
    let bytes = maybe_decompress(&compressed);
    let msgs = parse_claude(&to_lines(&String::from_utf8_lossy(&bytes)));
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].blocks[0].text, "hello zst");
}

#[test]
fn snapshot_path_sanitizes_and_keeps_zst() {
    let p = snapshot_path("codex", "abc/def.json", true).unwrap();
    assert!(p.ends_with("snapshots/codex/abc_def_json.jsonl.zst"));
    let p2 = snapshot_path("claude-code", "sid-1", false).unwrap();
    assert!(p2.ends_with("snapshots/claude-code/sid-1.jsonl"));
}

#[test]
fn iso_from_unix_formats_utc() {
    assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
    assert_eq!(iso_from_unix(1700000000), "2023-11-14T22:13:20Z");
}

#[test]
fn head_tail_splits_large_files() {
    let mut bytes = Vec::new();
    for i in 0..1000 {
        bytes.extend_from_slice(format!("{{\"n\":{i}}}\n").as_bytes());
    }
    let (head, tail) = head_tail_lines(&bytes, 1024);
    assert!(head.len() < 1000 && !head.is_empty());
    assert!(tail.len() < 1000 && !tail.is_empty());
    assert!(head
        .iter()
        .all(|l| serde_json::from_str::<Value>(l).is_ok()));
    assert!(tail
        .iter()
        .all(|l| serde_json::from_str::<Value>(l).is_ok()));
}

#[test]
fn read_head_tail_matches_full_read_plain_and_zstd() {
    // 构造 >2×budget 的文件：前 100 行小行 + 中间大行 + 后 100 行
    let mut text = String::new();
    for i in 0..100 {
        text.push_str(&format!("{{\"n\":{i}}}\n"));
    }
    text.push_str(&"x".repeat(600 * 1024));
    text.push('\n');
    for i in 100..200 {
        text.push_str(&format!("{{\"n\":{i}}}\n"));
    }
    let dir = std::env::temp_dir().join(format!("ccode-ht-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // 普通文件：窗口化读取的头尾与全量读取的头尾一致
    let plain = dir.join("a.jsonl");
    std::fs::write(&plain, &text).unwrap();
    let (h1, t1) = read_head_tail(&plain, 64 * 1024).unwrap();
    let full = std::fs::read(&plain).unwrap();
    let (h2, t2) = head_tail_lines(&full, 64 * 1024);
    assert_eq!(h1, h2);
    assert_eq!(t1, t2);
    // zstd 压缩：流式解码的头尾与全量解压的头尾一致
    let zst = dir.join("a.jsonl.zst");
    let mut enc = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
    std::io::Write::write_all(&mut enc, text.as_bytes()).unwrap();
    let compressed = enc.finish().unwrap();
    std::fs::write(&zst, &compressed).unwrap();
    let (h3, t3) = read_head_tail(&zst, 64 * 1024).unwrap();
    let (h4, t4) = head_tail_lines(&maybe_decompress(&compressed), 64 * 1024);
    assert_eq!(h3, h4, "zstd 头窗应与全量解压一致");
    assert_eq!(t3, t4, "zstd 尾窗应与全量解压一致");
    // 懒解压（归档 zst 头窗专用）：头窗与全量解压的头窗一致，不解剩余流
    let h5 = read_head_only(&zst, 64 * 1024).unwrap();
    assert_eq!(h5, h4, "read_head_only 头窗应与全量解压一致");
    // 明文路径同口径
    let h6 = read_head_only(&plain, 64 * 1024).unwrap();
    assert_eq!(h6, h2, "read_head_only 明文头窗应与全量读取一致");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn last_lines_reads_tail_window_for_large_files() {
    let dir = std::env::temp_dir().join(format!("ccode-ll-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // 大文件（>2×budget）：返回对齐后的尾窗，不是全量
    let big = dir.join("big.jsonl");
    let mut text = String::new();
    for i in 0..4000 {
        text.push_str(&format!("{{\"n\":{i},\"pad\":\"{}\"}}\n", "x".repeat(60)));
    }
    std::fs::write(&big, &text).unwrap();
    assert!(text.len() > 128 * 1024);
    let lines = last_lines(&big, 64 * 1024);
    assert!(!lines.is_empty());
    assert!(lines.len() < 4000, "大文件只回尾窗，不全量");
    assert!(
        lines
            .iter()
            .all(|l| serde_json::from_str::<Value>(l).is_ok()),
        "尾窗对齐后每行都是完整 JSON"
    );
    assert!(
        lines.last().is_some_and(|l| l.contains("\"n\":3999")),
        "尾窗必须含文件末尾"
    );
    // 小文件照旧全量
    let small = dir.join("small.jsonl");
    std::fs::write(&small, "{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n").unwrap();
    assert_eq!(last_lines(&small, 64 * 1024).len(), 3);
    std::fs::remove_dir_all(&dir).ok();
}

// ===== Gemini =====

#[test]
fn gemini_parse_rewind_truncates_and_tokens_map() {
    let lines = s(&[
        r#"{"sessionId":"g1","startTime":"2026-07-21T02:46:00Z","lastUpdated":"..."}"#,
        r#"{"id":"m1","timestamp":"2026-07-21T02:46:01Z","type":"user","content":"第一问"}"#,
        r#"{"id":"m2","timestamp":"2026-07-21T02:46:02Z","type":"gemini","content":"第一答","tokens":{"input":100,"output":20,"cached":10,"thoughts":5,"tool":0,"total":135},"model":"gemini-3"}"#,
        r#"{"id":"m3","timestamp":"2026-07-21T02:46:03Z","type":"user","content":"第二问（被回滚）"}"#,
        r#"{"$rewindTo":"m2"}"#,
        r#"{"id":"m4","timestamp":"2026-07-21T02:46:04Z","type":"user","content":"改问这个"}"#,
        r#"{"id":"m5","timestamp":"2026-07-21T02:46:05Z","type":"gemini","content":[{"text":"part1"},{"text":"part2"}],"toolCalls":[{"name":"read_file","args":{"path":"/a"},"result":"file body"}]}"#,
        r#"{"id":"m6","timestamp":"2026-07-21T02:46:06Z","type":"info","content":"忽略"}"#,
        r#"{"id":"m7","timestamp":"2026-07-21T02:46:07Z","type":"gemini","content":"截断"#, // 截断末行
    ]);
    let msgs = parse_gemini(&lines);
    // m2 起的消息被 $rewindTo 删除，之后 m4/m5 正常接续
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0].blocks[0].text, "第一问");
    assert_eq!(msgs[1].blocks[0].text, "改问这个");
    let g = &msgs[2];
    assert_eq!(g.role, "assistant");
    assert_eq!(g.blocks[0].text, "part1\npart2");
    assert_eq!(g.blocks[1].kind, "tool_use");
    assert_eq!(g.blocks[1].tool_name.as_deref(), Some("read_file"));
    assert_eq!(g.blocks[2].kind, "tool_result");
    assert_eq!(g.blocks[2].text, "file body");
    // tokens 映射来自被回滚前 m2 之外——这里验证 m5 无 tokens 时 usage 为空，
    // 另起一条只含 tokens 的场景验证映射
    assert!(g.usage.is_none());
    let with_tokens = parse_gemini(&s(&[
        // 实机口径（~/.gemini 实录 2026-09-20）：total = input + output + thoughts，cached 含在 input 里
        r#"{"id":"a","type":"gemini","content":"答","tokens":{"input":100,"output":20,"cached":10,"thoughts":5,"tool":0,"total":125}}"#,
    ]));
    let u = with_tokens[0].usage.as_ref().unwrap();
    assert_eq!(
        (u.input, u.output, u.cache_read, u.cache_write),
        (90, 20, 10, 0)
    );
}

#[test]
fn gemini_parse_hides_session_context_and_collapses_rerecorded_ids() {
    // 形状取自 gemini 0.64 实录（~/.gemini/tmp/scratch/chats，2026-10-20）
    let lines = s(&[
        r#"{"sessionId":"g1","projectHash":"h","startTime":"2026-10-20T03:23:18Z","kind":"main"}"#,
        r#"{"id":"c0","type":"user","content":[{"text":"<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\n</session_context>"}]}"#,
        r#"{"id":"h0","type":"user","content":"  <hook_context>来自 hook</hook_context>"}"#,
        r#"{"id":"u1","type":"user","content":[{"text":"新建 hello.py"}]}"#,
        r#"{"id":"a1","type":"gemini","content":""}"#,
        r#"{"id":"a1","type":"gemini","content":"","toolCalls":[{"id":"t1","name":"write_file","args":{"path":"hello.py"}}]}"#,
        r#"{"id": "r1", "timestamp": 1792672352936, "type": "function_call_result", "name": "REPL", "callId": "call_probe", "status": "completed", "output": {"type": "text", "text": "{\"stdout\":\"\"}"}, "sessionId": "s"}"#,
        r#"{"id":"a2","type":"gemini","content":"1. 已新建 hello.py"}"#,
        r#"{"id":"a2","type":"gemini","content":"1. 已新建 hello.py","toolCalls":[{"id":"t2","name":"list_directory","args":{}}]}"#,
        r#"{"id":"u2","type":"user","content":"展开后的 @a.md 全文","displayContent":[{"text":"看看 @a.md"}]}"#,
    ]);
    let msgs = parse_gemini(&lines);
    let texts: Vec<(&str, &str)> = msgs
        .iter()
        .map(|m| (m.role.as_str(), m.blocks[0].text.as_str()))
        .collect();
    assert_eq!(
        texts,
        vec![
            ("user", "新建 hello.py"),
            ("assistant", r#"{"path":"hello.py"}"#),
            ("assistant", "1. 已新建 hello.py"),
            ("user", "看看 @a.md"),
        ]
    );
    // 重记的那条带着后来补上的工具调用
    assert_eq!(msgs[2].blocks[1].tool_name.as_deref(), Some("list_directory"));
}

#[test]
fn gemini_slug_map_from_projects_json_and_marker() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let tmp = dir.join(".gemini").join("tmp");
    std::fs::create_dir_all(tmp.join("slug-a")).unwrap();
    std::fs::create_dir_all(tmp.join("slug-b")).unwrap();
    std::fs::write(
        dir.join(".gemini").join("projects.json"),
        r#"{"projects":{"/abs/path/a":"slug-a"}}"#,
    )
    .unwrap();
    std::fs::write(tmp.join("slug-b").join(".project_root"), "/abs/path/b\n").unwrap();
    let map = gemini_slug_map(&tmp);
    assert_eq!(map.get("slug-a").map(String::as_str), Some("/abs/path/a"));
    assert_eq!(map.get("slug-b").map(String::as_str), Some("/abs/path/b"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn gemini_meta_summary_title_and_directories_fallback() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let chats = dir.join("tmp").join("some-slug").join("chats");
    std::fs::create_dir_all(&chats).unwrap();
    let file = chats.join("session-x.jsonl");
    let content = concat!(
        r#"{"sessionId":"g1","startTime":"2026-07-21T02:46:00Z","directories":["/abs/proj"]}"#,
        "\n",
        r#"{"id":"m1","timestamp":"2026-07-21T02:46:01Z","type":"user","content":"问点什么"}"#,
        "\n",
        r#"{"$set":{"summary":"AI 摘要标题","lastUpdated":"2026-07-21T03:00:00Z"}}"#,
        "\n",
    );
    std::fs::write(&file, content).unwrap();
    // 空映射 → 走 metadata.directories 兜底
    let m = gemini_file_meta(&file, true, &HashMap::new()).unwrap();
    assert_eq!(m.project_path, "/abs/proj");
    assert_eq!(m.session_id, "g1");
    assert_eq!(
        m.title.as_deref(),
        Some("AI 摘要标题"),
        "$set 的 summary 优先于首条用户消息"
    );
    assert_eq!(m.created_at.as_deref(), Some("2026-07-21T02:46:00Z"));
    // slug 映射命中时优先于 directories；映射和 directories 都没有则跳过该会话
    let mut map = HashMap::new();
    map.insert("some-slug".to_string(), "/mapped/proj".to_string());
    let m2 = gemini_file_meta(&file, true, &map).unwrap();
    assert_eq!(m2.project_path, "/mapped/proj");
    let file2 = chats.join("session-y.jsonl");
    std::fs::write(&file2, r#"{"sessionId":"g2","startTime":"t"}"#).unwrap();
    assert!(gemini_file_meta(&file2, true, &HashMap::new()).is_none());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn gemini_duplicate_files_collapse_by_session_id() {
    let older = claim_test_session(
        "gemini",
        "same-session",
        "/tmp/project",
        "2026-08-21T07:00:00Z",
    );
    let newer = claim_test_session(
        "gemini",
        "same-session",
        "/tmp/project",
        "2026-08-21T07:04:00Z",
    );
    let mut out = dedupe_gemini_sessions(vec![newer, older]);
    assert_eq!(out.len(), 1);
    assert_eq!(
        out.pop().unwrap().updated_at.as_deref(),
        Some("2026-08-21T07:04:00Z")
    );

    let different = claim_test_session(
        "gemini",
        "different-session",
        "/tmp/project",
        "2026-08-21T07:05:00Z",
    );
    assert_eq!(dedupe_gemini_sessions(vec![different]).len(), 1);
}

// ===== Qwen =====

#[test]
fn qwen_parse_blocks_usage_and_sidechain() {
    let lines = s(&[
        r#"{"uuid":"1","sessionId":"q1","timestamp":"2026-07-01T00:00:00Z","type":"user","cwd":"/tmp/proj","version":"0.10.0","message":{"role":"user","parts":[{"text":"帮我写代码"}]}}"#,
        r#"{"uuid":"2","sessionId":"q1","type":"assistant","message":{"role":"model","parts":[{"text":"想想","thought":true},{"text":"好的"},{"functionCall":{"name":"write_file","args":{"path":"/a"}}}]},"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":10,"cachedContentTokenCount":5}}"#,
        r#"{"uuid":"3","sessionId":"q1","type":"tool_result","message":{"role":"tool","parts":[{"functionResponse":{"name":"write_file","response":{"ok":true}}}]}}"#,
        r#"{"uuid":"4","sessionId":"q1","type":"user","isSidechain":true,"message":{"role":"user","parts":[{"text":"支线"}]}}"#,
        r#"{"uuid":"5","sessionId":"q1","type":"system","subtype":"custom_title","systemPayload":{"customTitle":"自定义标题"}}"#,
        r#"{"uuid":"6","sessionId":"q1","type":"assistant","message":{"role":"model","parts":[{"text":"截断"#, // 截断末行
    ]);
    let msgs = parse_qwen(&lines);
    assert_eq!(
        msgs.len(),
        2,
        "sidechain/system/截断行跳过，tool_result 并入上一条"
    );
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].blocks[0].text, "帮我写代码");
    let a = &msgs[1];
    assert_eq!(a.role, "assistant");
    assert_eq!(a.blocks[0].kind, "thinking");
    assert_eq!(a.blocks[1].kind, "text");
    assert_eq!(a.blocks[2].kind, "tool_use");
    assert_eq!(a.blocks[2].tool_name.as_deref(), Some("write_file"));
    assert_eq!(a.blocks[3].kind, "tool_result");
    let u = a.usage.as_ref().unwrap();
    assert_eq!(
        (u.input, u.output, u.cache_read, u.cache_write),
        (45, 10, 5, 0),
        "promptTokenCount 含缓存，拆成没命中的部分"
    );
}

#[test]
fn qwen_meta_custom_title_cwd_version_and_archive() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let chats = dir
        .join("projects")
        .join("-tmp-proj")
        .join("chats")
        .join("archive");
    std::fs::create_dir_all(&chats).unwrap();
    let file = chats.join("q1.jsonl");
    let content = concat!(
        r#"{"uuid":"1","sessionId":"q1","timestamp":"2026-07-01T00:00:00Z","type":"user","cwd":"/tmp/proj","version":"0.10.0","message":{"role":"user","parts":[{"text":"首条提问"}]}}"#,
        "\n",
        r#"{"uuid":"2","sessionId":"q1","type":"system","subtype":"custom_title","systemPayload":{"customTitle":"我的会话"}}"#,
        "\n",
        r#"{"uuid":"3","sessionId":"q1","type":"assistant","message":{"role":"model","parts":[{"text":"答"}]},"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":3}}"#,
        "\n",
    );
    std::fs::write(&file, content).unwrap();
    let m = qwen_file_meta(&file, true, true).unwrap();
    assert_eq!(
        m.project_path, "/tmp/proj",
        "项目归属以首条记录 cwd 为准，不解码目录名"
    );
    assert_eq!(m.session_id, "q1");
    assert_eq!(m.cli_version.as_deref(), Some("0.10.0"));
    assert_eq!(
        m.title.as_deref(),
        Some("我的会话"),
        "custom_title 覆盖首条用户消息"
    );
    assert!(m.archived);
    assert!(m.alive);
    let u = m.token_usage.unwrap();
    assert_eq!((u.input, u.output), (9, 3));
    std::fs::remove_dir_all(&dir).ok();
}

// ===== Kimi =====

#[test]
fn kimi_wire_parse_dedup_injection_tools_usage() {
    let lines = s(&[
        r#"{"type":"metadata","protocol_version":"1.4","created_at":1785307071000}"#,
        r#"{"type":"turn.prompt","input":[{"type":"text","text":"第一问"}],"origin":{"kind":"user"},"time":1785307072000}"#,
        r#"{"type":"context.append_message","message":{"role":"user","origin":{"kind":"user"},"content":[{"type":"text","text":"第一问"}]},"time":1785307072001}"#, // prompt 回显，去重
        r#"{"type":"context.append_message","message":{"role":"user","origin":{"kind":"injection"},"content":[{"type":"text","text":"<system-reminder>注入</system-reminder>"}]},"time":1785307072002}"#,
        r#"{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"think","think":"想想"},{"type":"text","text":"好的"}],"toolCalls":[{"function":{"name":"Read","arguments":"{\"path\":\"/a\"}"}}]},"time":1785307073000}"#,
        r#"{"type":"context.append_message","message":{"role":"tool","content":[{"type":"text","text":"file body"}]},"time":1785307074000}"#,
        r#"{"type":"usage.record","usage":{"inputOther":100,"output":20,"inputCacheRead":10,"inputCacheCreation":5},"time":1785307075000}"#,
        r#"{"type":"turn.prompt","input":[{"type":"text","text":"slash 命令"}],"origin":{"kind":"slash"},"time":1785307076000}"#, // 非 user 来源跳过
        r#"{"type":"turn.prompt","input":[{"type":"text","text":"截断"#, // 截断末行
    ]);
    let msgs = parse_kimi(&lines);
    assert_eq!(msgs.len(), 2, "回显/注入/slash/截断行都要处理掉");
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].blocks[0].text, "第一问");
    assert_eq!(msgs[0].timestamp.as_deref(), Some("2026-07-29T06:37:52Z"));
    let a = &msgs[1];
    assert_eq!(a.role, "assistant");
    assert_eq!(a.blocks[0].kind, "thinking");
    assert_eq!(a.blocks[1].kind, "text");
    assert_eq!(a.blocks[2].kind, "tool_use");
    assert_eq!(a.blocks[2].tool_name.as_deref(), Some("Read"));
    assert_eq!(a.blocks[2].text, "{\"path\":\"/a\"}");
    assert_eq!(a.blocks[3].kind, "tool_result");
    assert_eq!(a.blocks[3].text, "file body");
    let u = a.usage.as_ref().unwrap();
    assert_eq!(
        (u.input, u.output, u.cache_read, u.cache_write),
        (100, 20, 10, 5)
    );
}

#[test]
fn kimi_wire_parse_loop_events() {
    // 新协议：assistant 输出走 append_loop_event 流式事件（step.begin/content.part/tool.call/tool.result/step.end）
    let lines = s(&[
        r#"{"type":"metadata","protocol_version":"1.4","created_at":1785307071000}"#,
        r#"{"type":"turn.prompt","input":[{"type":"text","text":"跑一下测试"}],"origin":{"kind":"user"},"time":1785307072000}"#,
        r#"{"type":"context.append_loop_event","event":{"type":"step.begin","step":1},"time":1785307072100}"#,
        r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"think","think":"先想"}},"time":1785307072200}"#,
        r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"我来跑"}},"time":1785307072300}"#,
        r#"{"type":"context.append_loop_event","event":{"type":"tool.call","name":"Bash","args":{"command":"cargo test"}},"time":1785307072400}"#,
        r#"{"type":"context.append_loop_event","event":{"type":"tool.result","result":{"output":"ok 70 passed"}},"time":1785307072500}"#,
        r#"{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":500,"output":60,"inputCacheRead":7,"inputCacheCreation":3}},"time":1785307072600}"#,
        r#"{"type":"context.append_loop_event","event":{"type":"step.begin","step":2},"time":1785307072700}"#,
        r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"全绿"}},"time":1785307072800}"#,
    ]);
    let msgs = parse_kimi(&lines);
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0].role, "user");
    let a1 = &msgs[1];
    assert_eq!(a1.blocks[0].kind, "thinking");
    assert_eq!(a1.blocks[1].kind, "text");
    assert_eq!(a1.blocks[2].kind, "tool_use");
    assert_eq!(a1.blocks[2].tool_name.as_deref(), Some("Bash"));
    assert_eq!(a1.blocks[2].text, "{\"command\":\"cargo test\"}");
    assert_eq!(a1.blocks[3].kind, "tool_result");
    assert_eq!(a1.blocks[3].text, "ok 70 passed");
    let u = a1.usage.as_ref().unwrap();
    assert_eq!(
        (u.input, u.output, u.cache_read, u.cache_write),
        (500, 60, 7, 3)
    );
    assert_eq!(
        msgs[2].blocks[0].text, "全绿",
        "第二个 step 是独立的一条 assistant 消息"
    );
}

#[test]
fn kimi_wire_meta_title_from_state_json() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let main = dir.join("session_abc").join("agents").join("main");
    std::fs::create_dir_all(&main).unwrap();
    let wire = main.join("wire.jsonl");
    std::fs::write(
        &wire,
        concat!(
            r#"{"type":"metadata","protocol_version":"1.4","created_at":1785307071000}"#,
            "\n",
            r#"{"type":"turn.prompt","input":[{"type":"text","text":"首条输入"}],"origin":{"kind":"user"},"time":1785307072000}"#,
            "\n",
            r#"{"type":"usage.record","usage":{"inputOther":7,"output":3}}"#,
            "\n",
        ),
    )
    .unwrap();
    std::fs::write(
        dir.join("session_abc").join("state.json"),
        r#"{"createdAt":1785307071000,"title":"AI 起的标题"}"#,
    )
    .unwrap();
    let state: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("session_abc").join("state.json")).unwrap(),
    )
    .unwrap();
    let m = kimi_wire_file_meta(&wire, true, "abc", "/proj/x".into(), Some(&state)).unwrap();
    assert_eq!(m.agent, "kimi");
    assert_eq!(m.project_path, "/proj/x");
    assert_eq!(
        m.title.as_deref(),
        Some("AI 起的标题"),
        "state.json 标题优先"
    );
    assert_eq!(m.created_at.as_deref(), Some("2026-07-29T06:37:51Z"));
    let u = m.token_usage.unwrap();
    assert_eq!((u.input, u.output), (7, 3));
    // 无 state 时回落首条用户输入
    let m2 = kimi_wire_file_meta(&wire, true, "abc", "/proj/x".into(), None).unwrap();
    assert_eq!(m2.title.as_deref(), Some("首条输入"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn kimi_legacy_parse_and_buckets() {
    // md5("/tmp/proj") 预计算值，验证 bucket 反查规则
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let kimi_json = dir.join("kimi.json");
    std::fs::write(&kimi_json, r#"{"work_dirs":[{"path":"/tmp/proj"}]}"#).unwrap();
    let buckets = kimi_workdir_buckets(&kimi_json);
    assert_eq!(
        buckets
            .get("d5ebc5292b750d2bb41a2557ca31bcac")
            .map(String::as_str),
        Some("/tmp/proj")
    );
    std::fs::remove_dir_all(&dir).ok();

    let lines = s(&[
        r#"{"role":"_init","content":"内部记录"}"#,
        r#"{"role":"user","content":"旧版提问"}"#,
        r#"{"role":"assistant","content":[{"type":"text","text":"旧版回答"}],"tool_calls":[{"function":{"name":"Bash","arguments":"{\"cmd\":\"ls\"}"}}]}"#,
        r#"{"role":"tool","content":"total 0"}"#,
        r#"{"role":"_usage","usage":{"input_tokens":42,"output_tokens":9}}"#,
    ]);
    let msgs = parse_kimi_legacy(&lines);
    assert_eq!(msgs.len(), 2, "_ 开头的内部角色跳过，tool 并入上一条");
    assert_eq!(msgs[0].blocks[0].text, "旧版提问");
    let a = &msgs[1];
    assert_eq!(a.blocks[1].kind, "tool_use");
    assert_eq!(a.blocks[1].tool_name.as_deref(), Some("Bash"));
    assert_eq!(a.blocks[2].kind, "tool_result");
    let u = a.usage.as_ref().unwrap();
    assert_eq!((u.input, u.output), (42, 9));
}

#[test]
fn kimi_variant_sniffing() {
    assert!(kimi_looks_like_wire(&s(&[r#"{"type":"metadata"}"#])));
    assert!(!kimi_looks_like_wire(&s(&[
        r#"{"role":"user","content":"x"}"#
    ])));
}

// ===== 会话根目录认搬迁变量 =====

fn scratch_home() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ccode-roots-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn session_roots_default_to_home_layout() {
    let home = scratch_home();
    let r = SessionRoots::at(&home);
    assert_eq!(r.claude_projects(), home.join(".claude").join("projects"));
    assert_eq!(r.codex_dirs()[1], home.join(".codex").join("archived_sessions"));
    assert_eq!(r.gemini, home.join(".gemini"));
    assert_eq!(r.qwen, home.join(".qwen"));
    assert_eq!(r.kimi_index(), home.join(".kimi-code").join("session_index.jsonl"));
    assert_eq!(r.kimi_legacy_json(), home.join(".kimi").join("kimi.json"));
    assert_eq!(r.codebuddy, home.join(".codebuddy"));
    assert_eq!(r.cursor_projects(), home.join(".cursor").join("projects"));
    assert_eq!(r.grok, home.join(".grok"));
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn session_roots_follow_relocation_vars() {
    let home = scratch_home();
    let moved = |v: &str| home.join("moved").join(v);
    let env = |v: &str| Some(moved(v));
    let r = SessionRoots::with(&home, &env);
    assert_eq!(r.claude, moved("CLAUDE_CONFIG_DIR"));
    assert_eq!(r.codex, moved("CODEX_HOME"));
    // GEMINI_CLI_HOME 顶替家目录，会话仍在其下 .gemini/
    assert_eq!(r.gemini, moved("GEMINI_CLI_HOME").join(".gemini"));
    assert_eq!(r.qwen, moved("QWEN_RUNTIME_DIR"));
    assert_eq!(r.kimi_code, moved("KIMI_CODE_HOME"));
    assert_eq!(r.kimi_legacy, moved("KIMI_SHARE_DIR"));
    assert_eq!(r.codebuddy, moved("CODEBUDDY_CONFIG_DIR"));
    assert_eq!(r.cursor, moved("CURSOR_DATA_DIR"));
    assert_eq!(r.grok, moved("GROK_HOME"));
    // 删除白名单跟着走：搬走的目录放行，家目录默认位置不再放行
    let dirs = session_data_dirs_at(&r);
    let grok_dir = moved("GROK_HOME").join("sessions").join("-tmp-x").join("s1");
    std::fs::create_dir_all(&grok_dir).unwrap();
    let grok_file = grok_dir.join("updates.jsonl");
    std::fs::write(&grok_file, "{}").unwrap();
    let grok_auth = moved("GROK_HOME").join("auth.json");
    std::fs::write(&grok_auth, "{}").unwrap();
    let home_dir = home.join(".grok").join("sessions").join("-tmp-x").join("s2");
    std::fs::create_dir_all(&home_dir).unwrap();
    let home_file = home_dir.join("updates.jsonl");
    std::fs::write(&home_file, "{}").unwrap();
    assert!(deletable_session_file(&grok_file, &dirs));
    assert!(!deletable_session_file(&grok_auth, &dirs), "搬走的根上的凭证照样拒绝");
    assert!(!deletable_session_file(&home_file, &dirs));
    // 链成员查找按同一组根
    assert_eq!(
        grok_member_files_in(&[r.grok.join("sessions")], &["s1".to_string()]),
        vec![grok_file.clone()]
    );
    // Cursor 精确闸认 CURSOR_DATA_DIR 下的 projects
    let transcript = r
        .cursor_projects()
        .join("-tmp-x")
        .join("agent-transcripts")
        .join("u1");
    std::fs::create_dir_all(&transcript).unwrap();
    let cursor_file = transcript.join("u1.jsonl");
    std::fs::write(&cursor_file, "{}").unwrap();
    assert!(cursor_deletable(
        &cursor_file.canonicalize().unwrap(),
        &r.cursor_projects().canonicalize().unwrap()
    ));
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn qwen_runtime_root_reads_env_then_settings() {
    let home = scratch_home();
    let qwen_home = home.join("qh");
    std::fs::create_dir_all(&qwen_home).unwrap();
    let env_with = |runtime: Option<PathBuf>| {
        let qwen_home = qwen_home.clone();
        move |v: &str| match v {
            "QWEN_HOME" => Some(qwen_home.clone()),
            "QWEN_RUNTIME_DIR" => runtime.clone(),
            _ => None,
        }
    };
    // 只有 QWEN_HOME：会话跟配置根走
    assert_eq!(SessionRoots::with(&home, &env_with(None)).qwen, qwen_home);
    // settings 的 advanced.runtimeOutputDir（JSONC 注释容错，~ 展开到家目录）
    std::fs::write(
        qwen_home.join("settings.json"),
        "{\n  // 运行时输出\n  \"advanced\": { \"runtimeOutputDir\": \"~/qwen-run\" },\n}\n",
    )
    .unwrap();
    assert_eq!(SessionRoots::with(&home, &env_with(None)).qwen, home.join("qwen-run"));
    // QWEN_RUNTIME_DIR 优先于 settings
    let rt = home.join("rt");
    assert_eq!(SessionRoots::with(&home, &env_with(Some(rt.clone()))).qwen, rt);
    // 相对路径 Qwen 按自己的 cwd 解析，Mesa 不猜：退回配置根
    assert_eq!(
        SessionRoots::with(&home, &env_with(Some(PathBuf::from("rel/dir")))).qwen,
        qwen_home
    );
    std::fs::write(
        qwen_home.join("settings.json"),
        r#"{"advanced":{"runtimeOutputDir":".qwen-local"}}"#,
    )
    .unwrap();
    assert_eq!(SessionRoots::with(&home, &env_with(None)).qwen, qwen_home);
    std::fs::remove_dir_all(&home).ok();
}

// ===== 删除路径校验 =====

#[test]
fn delete_refuses_paths_outside_session_data_dirs() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("x.jsonl");
    std::fs::write(&f, "{}").unwrap();
    let err = delete_source_file(f.to_str().unwrap()).unwrap_err();
    assert!(
        err.contains("拒绝删除"),
        "会话数据目录外的文件必须拒绝: {err}"
    );
    assert!(f.exists(), "被拒绝的文件不能被删");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn deletable_session_file_requires_data_dir_and_session_suffix() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    // 模拟 ~/.codex、~/.kimi-code、opencode legacy storage 的布局
    let codex_chats = dir
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("08")
        .join("04");
    std::fs::create_dir_all(&codex_chats).unwrap();
    let rollout = codex_chats.join("rollout-x.jsonl");
    std::fs::write(&rollout, "{}").unwrap();
    let auth = dir.join(".codex").join("auth.json");
    std::fs::write(&auth, "{}").unwrap();
    let kimi_main = dir
        .join(".kimi-code")
        .join("sessions")
        .join("s1")
        .join("agents")
        .join("main");
    std::fs::create_dir_all(&kimi_main).unwrap();
    let wire = kimi_main.join("wire.jsonl");
    std::fs::write(&wire, "{}").unwrap();
    let index = dir.join(".kimi-code").join("session_index.jsonl");
    std::fs::write(&index, "{}").unwrap();
    let state = dir
        .join(".kimi-code")
        .join("sessions")
        .join("s1")
        .join("state.json");
    std::fs::write(&state, "{}").unwrap();
    let storage = dir.join("storage").join("session").join("p1");
    std::fs::create_dir_all(&storage).unwrap();
    let ses_json = storage.join("ses_1.json");
    std::fs::write(&ses_json, "{}").unwrap();
    let cb_proj = dir.join(".codebuddy").join("projects").join("-tmp-x");
    std::fs::create_dir_all(&cb_proj).unwrap();
    let cb_session = cb_proj.join("u1.jsonl");
    std::fs::write(&cb_session, "{}").unwrap();
    let cb_creds = dir.join(".codebuddy").join(".credentials.json");
    std::fs::write(&cb_creds, "{}").unwrap();
    let notes = codex_chats.join("notes.txt");
    std::fs::write(&notes, "x").unwrap();
    let dirs = vec![
        (dir.join(".codex").join("sessions"), false),
        (dir.join(".kimi-code").join("sessions"), false),
        (dir.join("storage"), true),
        (dir.join(".codebuddy").join("projects"), false),
    ];
    assert!(deletable_session_file(&rollout, &dirs));
    assert!(deletable_session_file(&wire, &dirs));
    assert!(
        deletable_session_file(&ses_json, &dirs),
        "legacy storage 放行 .json"
    );
    assert!(
        deletable_session_file(&cb_session, &dirs),
        "codebuddy projects/<slug>/*.jsonl 放行"
    );
    assert!(
        !deletable_session_file(&cb_creds, &dirs),
        ".codebuddy 根上的凭证文件必须拒绝"
    );
    assert!(
        !deletable_session_file(&auth, &dirs),
        "同 CLI 根下的 auth.json 必须拒绝"
    );
    assert!(
        !deletable_session_file(&index, &dirs),
        "根上的 session_index.jsonl 必须拒绝"
    );
    assert!(
        !deletable_session_file(&state, &dirs),
        "未放行 .json 的目录里 state.json 必须拒绝"
    );
    assert!(!deletable_session_file(&notes, &dirs), "后缀不符必须拒绝");
    assert!(
        !deletable_session_file(&codex_chats.join("ghost.jsonl"), &dirs),
        "不存在的路径（canonicalize 失败）必须拒绝"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn codex_member_files_match_rollout_tail_uuid() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let chats = dir.join("sessions").join("2026").join("08").join("04");
    std::fs::create_dir_all(&chats).unwrap();
    let id = "019f8039-8bed-7323-8c9d-853c1e7a9edf";
    let f1 = chats.join(format!("rollout-2026-08-04T00-00-00-{id}.jsonl"));
    let f2 = chats.join(format!("rollout-2026-08-04T01-00-00-{id}.jsonl.zst"));
    let other =
        chats.join("rollout-2026-08-04T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    for f in [&f1, &f2, &other] {
        std::fs::write(f, "{}").unwrap();
    }
    let roots = vec![dir.join("sessions")];
    let found = codex_member_files_in(&roots, &[id.to_string()]);
    assert_eq!(
        found.len(),
        2,
        "同 uuid 的 .jsonl 与 .jsonl.zst 都命中: {found:?}"
    );
    assert!(found.contains(&f1) && found.contains(&f2));
    assert!(!found.contains(&other), "无关 uuid 不能命中");
    assert!(codex_member_files_in(&roots, &[]).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_delete_removes_rows_and_rejects_unknown_db() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = opencode_fixture_db(&dir);
    // 非已知 OpenCode 库候选：整批拒绝且行不动
    let err = delete_opencode_rows(&db, "ses_1").unwrap_err();
    assert!(err.contains("拒绝"), "未知库必须拒绝: {err}");
    assert!(
        !opencode_parse_db(&db, "ses_1").is_empty(),
        "被拒绝后行必须还在"
    );
    // 删行本身：session/message/part 三表清掉目标会话，其他会话不受影响
    delete_opencode_rows_impl(&db, "ses_1").unwrap();
    let conn = open_opencode_db(&db).unwrap();
    assert!(query_rows(&conn, "SELECT * FROM session WHERE id='ses_1'", &[]).is_empty());
    assert!(
        query_rows(&conn, "SELECT * FROM message WHERE session_id='ses_1'", &[]).is_empty()
    );
    assert!(query_rows(&conn, "SELECT * FROM part WHERE session_id='ses_1'", &[]).is_empty());
    assert_eq!(
        query_rows(&conn, "SELECT * FROM session WHERE id='ses_2'", &[]).len(),
        1,
        "其他会话不受影响"
    );
    drop(conn);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_db_candidates_include_platform_paths() {
    let cands = opencode_db_candidates();
    assert!(!cands.is_empty());
    assert!(opencode_db_path().is_some());
    #[cfg(windows)]
    {
        if let Some(local) = crate::dirs::data_local_dir() {
            let root = local.join("opencode");
            assert!(
                cands
                    .iter()
                    .any(|p| crate::paths::path_within_path(p, &root)),
                "Windows 应探 %LOCALAPPDATA%\\opencode: {cands:?}"
            );
        }
    }
    if let Some(h) = crate::dirs::home_dir() {
        assert!(
            cands.iter().any(|p| p.ends_with(
                std::path::Path::new(".local")
                    .join("share")
                    .join("opencode")
                    .join("opencode.db")
            ) || crate::paths::path_within_path(
                p,
                &h.join(".local").join("share").join("opencode")
            )),
            "应保留 unix 形态回落: {cands:?}"
        );
    }
}

#[test]
fn expand_tilde_accepts_forward_and_backslash() {
    let home = crate::dirs::home_dir().unwrap().to_string_lossy().into_owned();
    assert_eq!(expand_tilde("~"), home);
    assert_eq!(expand_tilde("~/x"), format!("{home}/x"));
    assert_eq!(
        expand_tilde("~\\x"),
        format!("{home}\\x"),
        "Windows 风格 ~\\ 也要展开"
    );
    assert_eq!(expand_tilde("/abs/path"), "/abs/path");
    assert_eq!(
        expand_tilde("~other"),
        "~other",
        "~other 不是当前用户家目录，不展开"
    );
}

#[test]
fn worktree_sessions_rewrite_to_real_repo() {
    let rows = vec![
        crate::workspaces::WorktreeRow {
            id: "ws-1".into(),
            worktree_path: "/home/u/ccode/workspaces/myrepo/feat-x".into(),
            repo_path: "/home/u/code/myrepo".into(),
            name: "feat-x".into(),
            branch: "ccode/feat-x".into(),
            base_branch: "main".into(),
        },
        crate::workspaces::WorktreeRow {
            id: "ws-2".into(),
            worktree_path: "/home/u/ccode/workspaces/other/task".into(),
            repo_path: "/home/u/code/other".into(),
            name: "task".into(),
            branch: "ccode/task".into(),
            base_branch: "main".into(),
        },
    ];
    // worktree 根命中
    let hit = resolve_worktree_project("/home/u/ccode/workspaces/myrepo/feat-x", &rows);
    assert_eq!(hit, Some(("/home/u/code/myrepo".into(), "feat-x".into())));
    // worktree 子目录也命中
    let sub = resolve_worktree_project("/home/u/ccode/workspaces/other/task/src", &rows);
    assert_eq!(sub, Some(("/home/u/code/other".into(), "task".into())));
    // 普通项目路径不受影响；相似前缀（feat-xy）不误判
    assert!(resolve_worktree_project("/home/u/code/myrepo", &rows).is_none());
    assert!(
        resolve_worktree_project("/home/u/ccode/workspaces/myrepo/feat-xy", &rows).is_none()
    );
    assert!(resolve_worktree_project("/anywhere", &[]).is_none());
}

#[test]
fn worktree_resolve_accepts_backslash_separator() {
    // Windows：worktree 路径与会话 cwd 都用 '\'（且 worktree 路径可能带尾部分隔符）
    let rows = vec![crate::workspaces::WorktreeRow {
        id: "ws-w".into(),
        worktree_path: "C:\\ccode\\workspaces\\myrepo\\feat-x\\".into(),
        repo_path: "C:\\code\\myrepo".into(),
        name: "feat-x".into(),
        branch: "ccode/feat-x".into(),
        base_branch: "main".into(),
    }];
    let hit = resolve_worktree_project("C:\\ccode\\workspaces\\myrepo\\feat-x\\src", &rows);
    assert_eq!(hit, Some(("C:\\code\\myrepo".into(), "feat-x".into())));
    let root = resolve_worktree_project("C:\\ccode\\workspaces\\myrepo\\feat-x", &rows);
    assert!(root.is_some(), "尾部 '\\' 已归一，根路径本身也命中");
    assert!(
        resolve_worktree_project("C:\\ccode\\workspaces\\myrepo\\feat-xy", &rows).is_none()
    );
}

fn live_meta(agent: &str, updated_at: Option<&str>, live: bool) -> SessionMetaDto {
    SessionMetaDto {
        agent: agent.into(),
        session_id: "s1".into(),
        project_path: "/p".into(),
        cwd: Some("/p".into()),
        title: None,
        created_at: None,
        updated_at: updated_at.map(str::to_string),
        file_path: "/p/s1.jsonl".into(),
        token_usage: None,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive: true,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live,
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
        step_meta: Default::default(),
        title_by_user: false,
    }
}

#[test]
fn refresh_live_flag_does_not_freeze_stale_cache() {
    let now = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut stale = live_meta(
        "codex",
        Some(&iso_from_unix(now.saturating_sub(3600))),
        true,
    );
    refresh_live_flag(&mut stale);
    assert!(!stale.live, "一小时前的 updated_at 不得继续亮绿点");

    let mut fresh = live_meta("codex", Some(&iso_from_unix(now)), false);
    refresh_live_flag(&mut fresh);
    assert!(fresh.live, "60 秒内的 updated_at 应判 live");

    let mut dead = live_meta("codex", Some(&iso_from_unix(now)), true);
    dead.alive = false;
    refresh_live_flag(&mut dead);
    assert!(!dead.live, "源文件已失效即使时间新也不 live");
}

#[test]
fn refresh_live_flag_ignores_metadata_writes_after_turn_end() {
    // Claude 闲着也补写元数据行（away_summary / cost-state）：文件是新的，但回合早已收尾
    let dir = std::env::temp_dir().join(format!("ccode-livemeta-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("s1.jsonl");
    let ended = [
        r#"{"type":"user","message":{"role":"user","content":"你好"}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好的，已处理。"}]}}"#,
        r#"{"type":"system","subtype":"turn_duration","durationMs":3000}"#,
        r#"{"type":"system","subtype":"away_summary"}"#,
        r#"{"type":"cost-state"}"#,
    ];
    fs::write(&path, ended.join("\n")).unwrap();
    let now = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut meta = live_meta("claude-code", Some(&iso_from_unix(now)), true);
    meta.file_path = path.to_string_lossy().into_owned();
    refresh_live_flag(&mut meta);
    assert!(!meta.live, "回合已收尾，补写元数据不算在干活");

    // 又发了一句：回到 live
    fs::write(
        &path,
        format!("{}\n{}", ended.join("\n"), r#"{"type":"user","message":{"role":"user","content":"再改一下"}}"#),
    )
    .unwrap();
    refresh_live_flag(&mut meta);
    assert!(meta.live, "收尾后又发了一句，算在干活");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn live_flag_from_fresh_mtime() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("s1.jsonl");
    std::fs::write(
        &file,
        r#"{"type":"user","cwd":"/tmp/p","sessionId":"s1","timestamp":"2026-07-01T00:00:00Z","message":{"role":"user","content":"hi"}}"#,
    )
    .unwrap();
    // 刚写的文件 → live
    let m = claude_file_meta(&file, true).unwrap();
    assert!(m.live, "60 秒内的 mtime 应判 live");
    // 把 mtime 拨到一小时前 → 不 live
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let m = claude_file_meta(&file, true).unwrap();
    assert!(!m.live);
    // 死会话（alive=false）即使 mtime 新也不 live
    let m = claude_file_meta(&file, false).unwrap();
    assert!(!m.live);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn qwen_live_via_runtime_sidecar() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("q1.jsonl");
    std::fs::write(
        &file,
        r#"{"uuid":"1","sessionId":"q1","type":"user","cwd":"/tmp/p","message":{"role":"user","parts":[{"text":"hi"}]}}"#,
    )
    .unwrap();
    // 旧 mtime + 无 sidecar → 不 live
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(old)
        .unwrap();
    assert!(!qwen_file_meta(&file, true, false).unwrap().live);
    // sidecar 记的进程不存在（qwen 退出后残留）→ 不 live
    let sidecar = |pid: u32| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();
        let host = sysinfo::System::host_name().unwrap_or_default();
        format!(
            r#"{{"schema_version":1,"pid":{pid},"session_id":"q1","hostname":"{host}","started_at":{now}}}"#
        )
    };
    std::fs::write(dir.join("q1.runtime.json"), sidecar(0x7fff_fff0)).unwrap();
    assert!(
        !qwen_file_meta(&file, true, false).unwrap().live,
        "进程已不在的残留 sidecar 不应判 live"
    );
    // 进程还在（用本测试进程自己充当 qwen）→ live
    std::fs::write(dir.join("q1.runtime.json"), sidecar(std::process::id())).unwrap();
    assert!(
        qwen_file_meta(&file, true, false).unwrap().live,
        "进程在的 runtime sidecar 应判 live"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn session_meta_summary_migration_and_merge() {
    // 模拟旧库：没有 summary/summary_at 列，迁移应幂等补上
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let conn = Connection::open(dir.join("app.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
    )
    .unwrap();
    migrate_session_meta(&conn);
    migrate_session_meta(&conn); // 第二次不报错（幂等）
    conn.execute(
        "INSERT INTO session_meta(agent, session_id, summary, summary_at)
             VALUES('codex', 's1', 'AI 摘要内容', '2026-07-30T00:00:00Z')",
        [],
    )
    .unwrap();
    let meta = read_all_meta(&conn);
    let row = meta.get(&("codex".to_string(), "s1".to_string())).unwrap();
    assert_eq!(row.summary.as_deref(), Some("AI 摘要内容"));
    // apply_meta 合并进 DTO
    let (mut merged, _) =
        merge_codex_chains(vec![codex_meta("s1", "2026-07-03T00:00:00Z", None)]);
    apply_meta(&mut merged, &HashMap::new(), &meta);
    assert_eq!(merged[0].summary.as_deref(), Some("AI 摘要内容"));
    drop(conn);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn mesa_launch_pack_is_not_a_title() {
    let composed = "你正在项目「测试项目」中工作。\n工作方式：科研\n\n----\n\n帮我整理 HER 硼化物文献";
    assert_eq!(strip_mesa_launch_pack(composed), "帮我整理 HER 硼化物文献");
    assert_eq!(usable_title(composed).as_deref(), Some("帮我整理 HER 硼化物文献"));
    // 只发了包（2026-10-24 前项目 ＋ 新对话会这样自己开跑）：不当标题
    assert_eq!(strip_mesa_launch_pack("你正在项目「测试项目」中工作。\n工作方式：科研"), "");
    assert_eq!(usable_title("你正在项目「测试项目」中工作。\n工作方式：科研"), None);
    // 别的话原样
    assert_eq!(strip_mesa_launch_pack("看看这个\n----\n分隔"), "看看这个\n----\n分隔");
}

#[test]
fn resume_config_prefers_file_model_and_falls_back_to_launch_record() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
    )
    .unwrap();
    migrate_session_meta(&conn);
    let dir = std::env::temp_dir().join(format!("ccode-resume-config-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Claude：文件里最后一轮的模型说了算（中途换过的也算），Claude 自补的 <synthetic> 不算；思考档只有启动记录
    let claude = dir.join("c1.jsonl");
    std::fs::write(
        &claude,
        [
            r#"{"type":"assistant","sessionId":"c1","timestamp":"2026-10-23T01:00:00Z","message":{"model":"glm-4.7","usage":{"input_tokens":1,"output_tokens":1}}}"#,
            r#"{"type":"assistant","sessionId":"c1","timestamp":"2026-10-23T02:00:00Z","message":{"model":"glm-5.3","usage":{"input_tokens":1,"output_tokens":1}}}"#,
            r#"{"type":"assistant","sessionId":"c1","timestamp":"2026-10-23T03:00:00Z","message":{"model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}}"#,
        ]
        .join("\n"),
    )
    .unwrap();
    set_session_profile_at(&conn, "claude-code", "c1", "p-glm", Some(("glm-4.7", "high"))).unwrap();
    let cfg = session_resume_config_at(&conn, "claude-code", "c1", claude.to_str().unwrap());
    assert_eq!(cfg.model.as_deref(), Some("glm-5.3"));
    assert_eq!(cfg.effort.as_deref(), Some("high"));

    // 再启动一次用默认思考档：记成「默认」；模型空串不覆盖上次记下的
    set_session_profile_at(&conn, "claude-code", "c1", "p-glm", Some(("", ""))).unwrap();
    let cfg = session_resume_config_at(&conn, "claude-code", "c1", "/no/such/file.jsonl");
    assert_eq!(cfg.model.as_deref(), Some("glm-4.7"), "文件读不到用启动记录");
    assert_eq!(cfg.effort, None);

    // Codex：思考档以 rollout 每轮的 turn_context 为准
    let codex = dir.join("x1.jsonl");
    std::fs::write(
        &codex,
        [
            r#"{"type":"turn_context","payload":{"model":"gpt-5.5","effort":"medium"}}"#,
            r#"{"type":"turn_context","payload":{"model":"gpt-5.5","effort":"xhigh"}}"#,
            r#"{"type":"event_msg","timestamp":"2026-10-23T01:00:00Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":5,"output_tokens":1}}}}"#,
        ]
        .join("\n"),
    )
    .unwrap();
    set_session_profile_at(&conn, "codex", "x1", "p-codex", Some(("gpt-5.4", "low"))).unwrap();
    let cfg = session_resume_config_at(&conn, "codex", "x1", codex.to_str().unwrap());
    assert_eq!(cfg.model.as_deref(), Some("gpt-5.5"));
    assert_eq!(cfg.effort.as_deref(), Some("xhigh"));

    // 旧调用只记连接：不动已记的模型
    set_session_profile_at(&conn, "codex", "x1", "p-codex-2", None).unwrap();
    let cfg = session_resume_config_at(&conn, "codex", "x1", "/no/such/file.jsonl");
    assert_eq!(cfg.model.as_deref(), Some("gpt-5.4"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn kimi_resume_model_maps_config_alias_to_real_name() {
    let cfg = "default_model = \"zetatechs/kimi-k3\"\n[models.\"zetatechs/kimi-k3\"]\nprovider = \"zetatechs\"\nmodel = \"kimi-k3\"\n[models.kimi-k2]\nprovider = \"ccode\"\n";
    assert_eq!(kimi_model_from_alias("zetatechs/kimi-k3", cfg).as_deref(), Some("kimi-k3"));
    // 别名段没写 model、或配置里没有：原样（老会话直接记真名的情况）
    assert_eq!(kimi_model_from_alias("kimi-k2", cfg).as_deref(), Some("kimi-k2"));
    assert_eq!(kimi_model_from_alias("kimi-k3", "").as_deref(), Some("kimi-k3"));
    // Mesa 启动时合成的别名换不回真名
    assert_eq!(kimi_model_from_alias("__kimi_env_model__", cfg), None);
}

#[test]
fn session_meta_task_id_migration_assign_and_clear() {
    // 模拟旧库：没有 task_id 列，迁移幂等补上
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
    )
    .unwrap();
    migrate_session_meta(&conn);
    migrate_session_meta(&conn); // 第二次不报错（幂等）

    // 归卡 → 移出（None 与空白串等价）→ 再归卡
    assign_session_task_at(&conn, "codex", "s1", Some("t-a1")).unwrap();
    let meta = read_all_meta(&conn);
    assert_eq!(
        meta.get(&("codex".to_string(), "s1".to_string()))
            .unwrap()
            .task_id
            .as_deref(),
        Some("t-a1")
    );
    assign_session_task_at(&conn, "codex", "s1", None).unwrap();
    assign_session_task_at(&conn, "codex", "s1", Some("   ")).unwrap();
    let meta = read_all_meta(&conn);
    assert_eq!(
        meta.get(&("codex".to_string(), "s1".to_string()))
            .unwrap()
            .task_id,
        None
    );

    // 归卡不影响其他整理字段（upsert 只动 task_id）
    assign_session_task_at(&conn, "codex", "s1", Some("t-a1")).unwrap();
    assign_session_task_at(&conn, "claude-code", "s2", Some("t-a1")).unwrap();
    // 删卡清理：该卡所有会话摘掉失效 id，其他卡不动
    assign_session_task_at(&conn, "codex", "s3", Some("t-b2")).unwrap();
    clear_task_assignment(&conn, "t-a1").unwrap();
    let meta = read_all_meta(&conn);
    assert_eq!(
        meta.get(&("codex".to_string(), "s1".to_string()))
            .unwrap()
            .task_id,
        None
    );
    assert_eq!(
        meta.get(&("claude-code".to_string(), "s2".to_string()))
            .unwrap()
            .task_id,
        None
    );
    assert_eq!(
        meta.get(&("codex".to_string(), "s3".to_string()))
            .unwrap()
            .task_id
            .as_deref(),
        Some("t-b2"),
        "其他卡片的归卡不受影响"
    );

    // apply_meta 把 task_id 合并进 DTO
    let (mut merged, _) =
        merge_codex_chains(vec![codex_meta("s3", "2026-07-03T00:00:00Z", None)]);
    apply_meta(&mut merged, &HashMap::new(), &meta);
    assert_eq!(merged[0].task_id.as_deref(), Some("t-b2"));
}

/// 卡片认领：登记 → 扫描命中新会话并固化 task_id → 消费登记；
/// 登记前旧会话/异 agent/已归卡会话不误命中，消费后同目录新会话不再误归
#[test]
fn card_claim_applies_once_and_consumes() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
    )
    .unwrap();
    migrate_session_meta(&conn);
    claim_test_register(&conn, "codex", "/tmp/proj", "t-card1");

    // 登记前的旧会话 / 登记后的新会话 / 异 agent / 已手动归卡
    let old = claim_test_session("codex", "old", "/tmp/proj", "2000-01-01T00:00:00Z");
    let new = claim_test_session("codex", "new", "/tmp/proj", "2999-01-01T00:00:00Z");
    let other = claim_test_session("gemini", "g1", "/tmp/proj", "2999-01-01T00:00:00Z");
    let mut taken = claim_test_session("codex", "taken", "/tmp/proj", "2999-02-01T00:00:00Z");
    taken.task_id = Some("t-other".into());
    let mut sessions = vec![old, new, other, taken];
    apply_card_claims(&conn, &mut sessions);

    assert_eq!(sessions[0].task_id, None, "登记前的旧会话不得归卡");
    assert_eq!(sessions[1].task_id.as_deref(), Some("t-card1"));
    assert_eq!(sessions[2].task_id, None, "agent 不匹配不得归卡");
    assert_eq!(
        sessions[3].task_id.as_deref(),
        Some("t-other"),
        "已归卡会话不被抢占"
    );
    // 固化进 session_meta（下次列表经 apply_meta 读到）
    let meta = read_all_meta(&conn);
    assert_eq!(
        meta.get(&("codex".to_string(), "new".to_string()))
            .unwrap()
            .task_id
            .as_deref(),
        Some("t-card1")
    );
    // 登记已消费：同目录之后更新的会话不再误归
    assert!(read_card_claims(&conn).is_empty());
    let newer = claim_test_session("codex", "newer", "/tmp/proj", "2999-06-01T00:00:00Z");
    let mut sessions = vec![newer];
    apply_card_claims(&conn, &mut sessions);
    assert_eq!(sessions[0].task_id, None, "消费后登记失效");

    // 无登记的目录不受影响
    let stray = claim_test_session("codex", "stray", "/tmp/other", "2999-01-01T00:00:00Z");
    let mut sessions = vec![stray];
    apply_card_claims(&conn, &mut sessions);
    assert_eq!(sessions[0].task_id, None);
}

/// 同 agent+cwd 重复登记：后一次覆盖前一次（以最后一次发起为准）
#[test]
fn card_claim_overwrites_same_target() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
    )
    .unwrap();
    migrate_session_meta(&conn);
    claim_test_register(&conn, "kimi", "/tmp/p", "t-a");
    claim_test_register(&conn, "kimi", "/tmp/p", "t-b");
    let claims = read_card_claims(&conn);
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].task_id, "t-b");
}

/// 测试内登记认领（command 本体走全局库，这里直写内存库）
fn claim_test_register(conn: &Connection, agent: &str, cwd: &str, task_id: &str) {
    ensure_card_claim_table(conn).unwrap();
    conn.execute(
        "INSERT INTO card_claims(agent, cwd, task_id, created_at) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(agent, cwd) DO UPDATE SET task_id=?3, created_at=?4",
        params![agent, cwd, task_id, now_iso()],
    )
    .unwrap();
}

fn claim_test_session(agent: &str, id: &str, path: &str, updated: &str) -> SessionMetaDto {
    SessionMetaDto {
        agent: agent.into(),
        session_id: id.into(),
        project_path: path.into(),
        cwd: Some(path.into()),
        title: None,
        created_at: None,
        updated_at: Some(updated.into()),
        file_path: format!("/{id}.jsonl"),
        token_usage: None,
        cli_version: None,
        pinned: false,
        archived: false,
        custom_title: None,
        tags: Vec::new(),
        alive: true,
        chain_count: 1,
        workspace: None,
        step_name: None,
        summary: None,
        live: false,
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
        step_meta: Default::default(),
        title_by_user: false,
    }
}

#[test]
fn claim_successor_follows_clear_only_when_unambiguous() {
    let ctx = |since: &str, excluded: &[&str]| SessionClaimContext {
        agent: "gemini".into(),
        project_path: "/p".into(),
        since_iso: since.into(),
        excluded: excluded.iter().map(|s| s.to_string()).collect(),
    };
    let s = |id: &str, t: &str| claim_test_session("gemini", id, "/p", t);
    let mut reg = SessionClaimRegistry::default();
    reg.contexts.insert("tab1".into(), ctx("2026-10-20T10:00:00Z", &["old"]));
    reg.assignments.insert("tab1".into(), ("gemini".into(), "s1".into()));
    let all = || {
        vec![
            s("old", "2026-10-20T11:00:00Z"), // 启动前就有：不认（时间新也不认）
            s("s1", "2026-10-20T10:00:05Z"),
            s("s2", "2026-10-20T10:05:00Z"),
            claim_test_session("kimi", "k1", "/p", "2026-10-20T10:06:00Z"), // 别家
            claim_test_session("gemini", "x1", "/q", "2026-10-20T10:07:00Z"), // 别的目录
        ]
    };
    // 没有更新的会话：不动
    assert!(pick_claim_successor(&mut reg, "tab1", vec![s("s1", "2026-10-20T10:00:05Z")]).is_none());
    // /clear 后出现 s2：改认它，旧的记为用过
    let next = pick_claim_successor(&mut reg, "tab1", all()).unwrap();
    assert_eq!(next.session_id, "s2");
    assert_eq!(reg.assignments["tab1"].1, "s2");
    assert!(reg.used_sessions.contains(&("gemini".into(), "s1".into())));
    // 再问一次：已经是最新，不再跳
    assert!(pick_claim_successor(&mut reg, "tab1", all()).is_none());
    // 同目录同家还有别的标签登记着：分不清是谁开的新对话，不猜
    let mut reg2 = SessionClaimRegistry::default();
    reg2.contexts.insert("tab1".into(), ctx("2026-10-20T10:00:00Z", &["old"]));
    reg2.contexts.insert("tab2".into(), ctx("2026-10-20T10:01:00Z", &["old"]));
    reg2.assignments.insert("tab1".into(), ("gemini".into(), "s1".into()));
    assert!(pick_claim_successor(&mut reg2, "tab1", all()).is_none());
    // 别的标签已认领的会话不抢
    let mut reg3 = SessionClaimRegistry::default();
    reg3.contexts.insert("tab1".into(), ctx("2026-10-20T10:00:00Z", &["old"]));
    reg3.assignments.insert("tab1".into(), ("gemini".into(), "s1".into()));
    reg3.used_sessions.insert(("gemini".into(), "s2".into()));
    assert!(pick_claim_successor(&mut reg3, "tab1", all()).is_none());
}

#[test]
fn sessions_belonging_to_filters_by_card_and_sorts_asc() {
    // 「◈ 融合进任务书」取材范围 = 该卡名下会话（task_id 口径），不碰其他会话
    let mut a = claim_test_session("codex", "s-a", "/p", "2026-07-01T00:00:00Z");
    a.task_id = Some("t-card".into());
    let mut b = claim_test_session("claude-code", "s-b", "/p", "2026-07-03T00:00:00Z");
    b.task_id = Some("t-card".into());
    let mut other = claim_test_session("codex", "s-c", "/p", "2026-07-02T00:00:00Z");
    other.task_id = Some("t-other".into());
    let unassigned = claim_test_session("codex", "s-d", "/p", "2026-07-04T00:00:00Z");
    let out = sessions_belonging_to(vec![b.clone(), other, unassigned, a.clone()], "t-card");
    let ids: Vec<&str> = out.iter().map(|s| s.session_id.as_str()).collect();
    assert_eq!(ids, vec!["s-a", "s-b"], "只取当前卡，按活跃时间升序");
    assert!(sessions_belonging_to(vec![a, b], "t-nobody").is_empty());
}

#[test]
fn apply_task_names_fills_and_tolerates_deleted_card() {
    // 卡片名按项目档案卡回填；卡片已删时 task_name=None 且 task_id 保留
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let project = dir.join("proj");
    std::fs::create_dir_all(&project).unwrap();
    let card = crate::projects::create_task_card_at(&project, "文献筛选", None, None).unwrap();

    let mut hit = codex_meta("s1", "2026-07-03T00:00:00Z", None).0;
    hit.project_path = project.to_string_lossy().into_owned();
    hit.task_id = Some(card.id.clone());
    let mut gone = codex_meta("s2", "2026-07-03T00:00:00Z", None).0;
    gone.project_path = project.to_string_lossy().into_owned();
    gone.task_id = Some("t-deleted".into());
    let mut none = codex_meta("s3", "2026-07-03T00:00:00Z", None).0;
    none.project_path = project.to_string_lossy().into_owned();

    let mut sessions = vec![hit, gone, none];
    apply_task_names(&mut sessions);
    assert_eq!(sessions[0].task_name.as_deref(), Some("文献筛选"));
    assert_eq!(sessions[1].task_name, None, "卡片已删容忍为 None");
    assert_eq!(sessions[1].task_id.as_deref(), Some("t-deleted"));
    assert_eq!(sessions[2].task_name, None);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn apply_step_claims_fills_consumes_and_does_not_preempt() {
    // 「跟 AI 商量一下」等按步骤上下文发起的会话：落在项目根也能归到该步骤，同时不抢占
    // 既有 worktree 步骤归属、不把登记前的旧会话误归、不跨项目归。
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_meta(
              agent TEXT NOT NULL, session_id TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
              custom_title TEXT, tags TEXT NOT NULL DEFAULT '[]',
              note TEXT, pinned_at TEXT,
              PRIMARY KEY(agent, session_id));",
    )
    .unwrap();
    migrate_session_meta(&conn);
    ensure_step_claim_table(&conn).unwrap();
    conn.execute(
        "INSERT INTO step_claims(agent, cwd, step_name, created_at)
             VALUES('codex', '/proj', '文献检索与筛选', '2026-07-02T00:00:00Z')",
        [],
    )
    .unwrap();

    // 命中：agent+cwd 匹配、登记之后有活动、无既有步骤归属
    let mut hit = codex_meta("s-hit", "2026-07-03T00:00:00Z", None).0;
    hit.project_path = "/proj".into();
    // 登记前的旧会话：updated_at < created_at，不命中
    let mut old = codex_meta("s-old", "2026-07-01T00:00:00Z", None).0;
    old.project_path = "/proj".into();
    // 已有 worktree 步骤归属：不抢占
    let mut owned = codex_meta("s-owned", "2026-07-05T00:00:00Z", None).0;
    owned.project_path = "/proj".into();
    owned.step_name = Some("文献精读与笔记".into());
    // 其它项目：cwd 不匹配
    let mut elsewhere = codex_meta("s-else", "2026-07-05T00:00:00Z", None).0;
    elsewhere.project_path = "/other".into();

    let mut sessions = vec![elsewhere, owned, old, hit];
    apply_step_claims(&conn, &mut sessions);
    assert_eq!(sessions[3].step_name.as_deref(), Some("文献检索与筛选"));
    assert_eq!(sessions[2].step_name, None, "登记前的旧会话不归该步骤");
    assert_eq!(
        sessions[1].step_name.as_deref(),
        Some("文献精读与笔记"),
        "既有 worktree 步骤归属不被抢占"
    );
    assert_eq!(sessions[0].step_name, None, "别项目会话不归");
    // 消费：登记行已删，再次 apply 不重复生效
    apply_step_claims(&conn, &mut sessions);
    assert!(read_step_claims(&conn).is_empty(), "认领消费后登记清空");

    // 持久化：归属已固化进 session_meta——下一轮列表（全新扫描、step_name 全空）
    // 由 apply_meta 从持久列回填，对话页 8s 轮询不会丢归属
    let mut next_round = vec![{
        let mut s = codex_meta("s-hit", "2026-07-03T00:00:00Z", None).0;
        s.project_path = "/proj".into();
        s
    }];
    assert_eq!(next_round[0].step_name, None);
    let meta = read_all_meta(&conn);
    apply_meta(&mut next_round, &HashMap::new(), &meta);
    assert_eq!(
        next_round[0].step_name.as_deref(),
        Some("文献检索与筛选"),
        "步骤归属持久化进 session_meta，后续轮次由 apply_meta 回填"
    );
    // worktree 命中（扫描侧已填）优先于持久列，不被旧归属覆盖
    next_round[0].step_name = Some("数据清洗".into());
    apply_meta(&mut next_round, &HashMap::new(), &meta);
    assert_eq!(
        next_round[0].step_name.as_deref(),
        Some("数据清洗"),
        "worktree 步骤归属优先于持久列"
    );
}

// ===== OpenCode =====

/// 按 matrix §5 模式建临时 SQLite：project/session/message/part 四表 + fixture 行
fn opencode_fixture_db(dir: &Path) -> PathBuf {
    let db = dir.join("opencode.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE project(id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT,
               title TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
               tokens_cache_read INTEGER, tokens_cache_write INTEGER, agent TEXT, model TEXT,
               version TEXT, time_created INTEGER, time_updated INTEGER);
             CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
             INSERT INTO project VALUES('p1','/repo/x'),('global','');
             INSERT INTO session VALUES('ses_1','p1',NULL,'/fallback','修复登录 bug',0.1,100,20,5,10,2,'build','{}','0.9.0',1785307071000,1785307072000);
             INSERT INTO session VALUES('ses_2','global',NULL,'/tmp/dir2','',0,0,0,0,0,0,'build','{}',NULL,1785307080000,1785307080000);
             INSERT INTO message VALUES('msg_1','ses_1',1785307071100,'{\"role\":\"user\",\"summary\":{\"body\":\"帮我修 bug\"}}');
             INSERT INTO message VALUES('msg_2','ses_1',1785307071200,'{\"role\":\"assistant\",\"tokens\":{\"input\":100,\"output\":20,\"reasoning\":5,\"cache\":{\"read\":10,\"write\":2}}}');
             INSERT INTO part VALUES('prt_1','msg_2','ses_1',1785307071201,'{\"type\":\"reasoning\",\"text\":\"想想\"}');
             INSERT INTO part VALUES('prt_2','msg_2','ses_1',1785307071202,'{\"type\":\"text\",\"text\":\"好的\"}');
             INSERT INTO part VALUES('prt_3','msg_2','ses_1',1785307071203,'{\"type\":\"tool\",\"tool\":\"bash\",\"state\":{\"status\":\"completed\",\"input\":{\"cmd\":\"ls\"},\"output\":\"ok\"}}');
             INSERT INTO part VALUES('prt_4','msg_2','ses_1',1785307071204,'{\"type\":\"tool\",\"tool\":\"edit\",\"state\":{\"status\":\"error\",\"input\":{\"file\":\"/a\"},\"error\":\"写入失败\"}}');
             INSERT INTO part VALUES('prt_5','msg_2','ses_1',1785307071205,'{\"type\":\"step-start\"}');",
    )
    .unwrap();
    db
}

/// 升级过的库：1.x 四表（opencode_fixture_db）+ 2.x 新表（建表语句照 2.2.5 实库）。
/// ses_1 升级时复制进 session_v2 后在 2.x 里续聊过（time_updated 更新）；ses_3 只在 2.x，内容在 session_part；ses_2 只在 1.x
fn opencode_v2_fixture_db(dir: &Path) -> PathBuf {
    let db = opencode_fixture_db(dir);
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        r#"CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
                 slug text NOT NULL, directory text NOT NULL, path text, title text, version text NOT NULL,
                 cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
                 tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
                 tokens_cache_write integer DEFAULT 0 NOT NULL, agent text, model text,
                 time_created integer NOT NULL, time_updated integer NOT NULL);
               CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
                 time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
                 CONSTRAINT fk_sm FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
               CREATE TABLE session_part (message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL, type text NOT NULL,
                 call_id text, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
                 CONSTRAINT session_part_pk PRIMARY KEY(message_id, ordinal),
                 CONSTRAINT fk_sp_m FOREIGN KEY (message_id) REFERENCES session_message(id) ON DELETE CASCADE,
                 CONSTRAINT fk_sp_s FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
               CREATE TABLE session_inbox (id text PRIMARY KEY, session_id text NOT NULL,
                 CONSTRAINT fk_si FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
               CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY NOT NULL, seq integer NOT NULL, owner_id text);
               INSERT INTO session_v2 VALUES('ses_1','p1',NULL,NULL,'kind-forest','/fallback','','修复登录 bug（续）','2.2.5',0,130,30,5,10,2,'build',NULL,1785307071000,1785307099000);
               INSERT INTO session_v2 VALUES('ses_3','global',NULL,NULL,'calm-lake','/tmp/dir3','',NULL,'2.2.5',0,0,0,0,0,0,NULL,NULL,1785307095000,1785307096000);
               INSERT INTO session_message VALUES('msg_1','ses_1','user',4,1785307071100,1785307071100,'{"time":{"created":1785307071100},"text":"帮我修 bug","files":[]}');
               INSERT INTO session_message VALUES('msg_v2a','ses_1','assistant',7,1785307098000,1785307098100,'{"time":{"created":1785307098000,"completed":1785307098100},"agent":"build","model":{"id":"e2e-picked","providerID":"ccode-abc12345"},"content":[{"type":"reasoning","text":"想想"},{"type":"tool","id":"call_probe","name":"shell","state":{"status":"completed","input":{"command":"ls"},"content":[{"type":"text","text":"ok"}]},"time":{"created":1785307098010}},{"type":"tool","id":"call_e","name":"edit","state":{"status":"error","input":{"file":"/a"},"error":{"type":"unknown","message":"写入失败"}},"time":{"created":1785307098020}},{"type":"text","text":"好了"}],"finish":"stop","tokens":{"input":30,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}}');
               INSERT INTO session_message VALUES('msg_idle','ses_1','idle',12,1785307098200,1785307098200,'{"time":{"created":1785307098200},"outcome":"succeeded"}');
               INSERT INTO session_message VALUES('msg_3u','ses_3','user',4,1785307095100,1785307095100,'{"time":{"created":1785307095100},"text":"看看这个目录","files":[]}');
               INSERT INTO session_message VALUES('msg_3sys','ses_3','model-switched',5,1785307095150,1785307095150,'{"time":{"created":1785307095150},"model":{"id":"m2","providerID":"x"}}');
               INSERT INTO session_message VALUES('msg_3a','ses_3','assistant',7,1785307095200,1785307095200,'{"time":{"created":1785307095200},"agent":"build","model":{"id":"m2","providerID":"x"},"content":[{"type":"text","text":"旧的内联内容"}]}');
               INSERT INTO session_part VALUES('msg_3a','ses_3',0,'text',NULL,1785307095201,1785307095201,'{"type":"text","text":"部件里的内容"}');
               INSERT INTO session_inbox VALUES('inb_1','ses_1');
               INSERT INTO event_sequence VALUES('ses_1',12,NULL);"#,
    )
    .unwrap();
    db
}

#[test]
fn opencode_v2_scan_merges_tables_and_dedupes() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = opencode_v2_fixture_db(&dir);
    let metas = opencode_scan_db(&db);
    let ids: Vec<&str> = metas.iter().map(|m| m.session_id.as_str()).collect();
    assert_eq!(ids.len(), 3, "两套表合读、同 id 只留一条: {ids:?}");
    let m1 = metas.iter().find(|m| m.session_id == "ses_1").unwrap();
    assert_eq!(m1.title.as_deref(), Some("修复登录 bug（续）"), "升级后续聊过的取 2.x 那份");
    assert_eq!(m1.cli_version.as_deref(), Some("2.2.5"));
    assert_eq!(m1.project_path, "/repo/x");
    let m3 = metas.iter().find(|m| m.session_id == "ses_3").unwrap();
    assert_eq!(m3.title.as_deref(), Some("看看这个目录"), "2.x 无标题时取首条用户话");
    assert_eq!(m3.project_path, "/tmp/dir3");
    assert!(metas.iter().any(|m| m.session_id == "ses_2"), "只在 1.x 的照旧在");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_v2_parse_page_export_tail() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = opencode_v2_fixture_db(&dir);
    let conn = open_opencode_db(&db).unwrap();
    assert_eq!(opencode_store_of(&conn, "ses_1"), OpencodeStore::V2);
    assert_eq!(opencode_store_of(&conn, "ses_2"), OpencodeStore::V1);
    drop(conn);
    let msgs = opencode_parse_db(&db, "ses_1");
    assert_eq!(msgs.len(), 2, "idle 行不进对话");
    assert_eq!(msgs[0].blocks[0].text, "帮我修 bug");
    let kinds: Vec<&str> = msgs[1].blocks.iter().map(|b| b.kind.as_str()).collect();
    assert_eq!(
        kinds,
        vec!["thinking", "tool_use", "tool_result", "tool_use", "tool_result", "text"]
    );
    assert_eq!(msgs[1].blocks[1].tool_name.as_deref(), Some("shell"));
    assert_eq!(msgs[1].blocks[2].text, "ok", "工具结果取 state.content[] 的文本");
    assert_eq!(msgs[1].blocks[4].text, "写入失败", "失败取 state.error.message");
    let u = msgs[1].usage.as_ref().unwrap();
    assert_eq!((u.input, u.output), (30, 10));
    let m3 = opencode_parse_db(&db, "ses_3");
    assert_eq!(m3.len(), 2, "切模型行不进对话");
    assert_eq!(m3[1].blocks[0].text, "部件里的内容", "有 session_part 时以 part 为准");
    // 分页读同一套表
    let page = opencode_conversation_page(&db, "ses_1", None, None).unwrap();
    assert_eq!(page.messages.len(), 2);
    assert!(page.cursor.is_none());
    // 快照导出成 1.x 形状，回放与读库一致
    let exported = opencode_export_session(&db, "ses_1").unwrap();
    assert_eq!(get_str(exported.get("session").unwrap(), "version"), Some("2.2.5"));
    let snap = opencode_parse_snapshot(&exported);
    assert_eq!(snap.len(), msgs.len());
    assert_eq!(snap[1].blocks.len(), msgs[1].blocks.len());
    // 最后一行是 idle：回合确定结束
    assert_eq!(opencode_tail_state(&db, "ses_1"), "settled");
    assert_eq!(opencode_tail_state(&db, "ses_3"), "working", "assistant 没完成算在干活");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_v2_delete_clears_both_tables() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = opencode_v2_fixture_db(&dir);
    delete_opencode_rows_impl(&db, "ses_1").unwrap();
    delete_opencode_rows_impl(&db, "ses_3").unwrap();
    let conn = open_opencode_db(&db).unwrap();
    for sql in [
        "SELECT * FROM session WHERE id='ses_1'",
        "SELECT * FROM message WHERE session_id='ses_1'",
        "SELECT * FROM session_v2 WHERE id IN ('ses_1','ses_3')",
        "SELECT * FROM session_message WHERE session_id IN ('ses_1','ses_3')",
        "SELECT * FROM session_part WHERE session_id='ses_3'",
        "SELECT * FROM session_inbox WHERE session_id='ses_1'",
        "SELECT * FROM event_sequence WHERE aggregate_id='ses_1'",
    ] {
        assert!(query_rows(&conn, sql, &[]).is_empty(), "没删干净: {sql}");
    }
    assert_eq!(query_rows(&conn, "SELECT * FROM session WHERE id='ses_2'", &[]).len(), 1);
    drop(conn);
    let ids: Vec<String> = opencode_scan_db(&db).into_iter().map(|m| m.session_id).collect();
    assert_eq!(ids, vec!["ses_2".to_string()], "删掉 2.x 那份后旧副本不能再冒出来");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_cache_sees_sessions_still_in_wal() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = opencode_fixture_db(&dir);
    // 照 OpenCode：WAL 模式、写连接一直开着、还没到检查点
    let writer = Connection::open(&db).unwrap();
    writer
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    let (entry, rows) = opencode_rows_cached(&db, None);
    assert_eq!(rows.len(), 2);
    let main_before = file_sig(&db);
    writer
        .execute(
            "INSERT INTO session VALUES('ses_new','global',NULL,'/tmp/new','',0,0,0,0,0,0,'build','{}',NULL,1785307090000,1785307090000)",
            [],
        )
        .unwrap();
    assert!(file_sig(&db) == main_before, "新会话只进了 -wal，主库指纹不变（缺陷成因）");
    let (_, rows) = opencode_rows_cached(&db, entry.as_ref());
    assert!(rows.iter().any(|m| m.session_id == "ses_new"), "-wal 变了就重扫");
    drop(writer);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn opencode_scan_maps_db_rows() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = opencode_fixture_db(&dir);
    let metas = opencode_scan_db(&db);
    assert_eq!(metas.len(), 2);
    let m1 = metas.iter().find(|m| m.session_id == "ses_1").unwrap();
    assert_eq!(m1.agent, "opencode");
    assert_eq!(m1.project_path, "/repo/x", "project_id → project.worktree");
    assert_eq!(m1.title.as_deref(), Some("修复登录 bug"));
    assert_eq!(
        m1.created_at.as_deref(),
        Some("2026-07-29T06:37:51Z"),
        "epoch ms → ISO"
    );
    assert_eq!(m1.cli_version.as_deref(), Some("0.9.0"));
    assert!(m1.file_path.ends_with("#ses_1"));
    assert!(m1.alive);
    let u = m1.token_usage.as_ref().unwrap();
    assert_eq!(
        (u.input, u.output, u.cache_read, u.cache_write),
        (100, 25, 10, 2)
    );
    let m2 = metas.iter().find(|m| m.session_id == "ses_2").unwrap();
    assert_eq!(
        m2.project_path, "/tmp/dir2",
        "global 项目回落 session.directory"
    );
    assert_eq!(m2.title, None, "空标题按 None 处理");
    assert!(m2.token_usage.is_none());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_scan_backfills_placeholder_title_lazily() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = opencode_fixture_db(&dir);
    // 占位标题的会话：从首条真实用户消息补标题
    let conn = Connection::open(&db).unwrap();
    conn.execute(
        "INSERT INTO session VALUES('ses_new','p1',NULL,'/repo/x','New Session',0,0,0,0,0,0,'build','{}','0.9.0',1785307090000,1785307090000)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO message VALUES('msg_n','ses_new',1785307090100,'{\"role\":\"user\",\"summary\":{\"body\":\"帮我写个脚本\"}}')",
        [],
    )
    .unwrap();
    drop(conn);
    let metas = opencode_scan_db(&db);
    let m = metas.iter().find(|m| m.session_id == "ses_new").unwrap();
    assert_eq!(
        m.title.as_deref(),
        Some("帮我写个脚本"),
        "占位标题应惰性回补"
    );
    let m1 = metas.iter().find(|m| m.session_id == "ses_1").unwrap();
    assert_eq!(
        m1.title.as_deref(),
        Some("修复登录 bug"),
        "真实标题不走回补"
    );
    let m2 = metas.iter().find(|m| m.session_id == "ses_2").unwrap();
    assert_eq!(m2.title, None, "没有用户消息的占位会话回补不到也不编");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_snapshot_collected_and_mapped() {
    // pin 快照回补：opencode 快照是 .json，必须进收集与解析
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let snap_root = dir.join("snapshots");
    std::fs::create_dir_all(snap_root.join("opencode")).unwrap();
    std::fs::create_dir_all(snap_root.join("codex")).unwrap();
    let json = snap_root.join("opencode").join("ses_x.json");
    std::fs::write(
        &json,
        r#"{"session":{"id":"ses_x","title":"快照标题","directory":"/proj/x","time_created":1785307071000,"time_updated":1785307072000,"tokens_input":7,"tokens_output":3}}"#,
    )
    .unwrap();
    let codex_snap = snap_root.join("codex").join("rollout-y.jsonl");
    std::fs::write(&codex_snap, "{}").unwrap();
    let oc_files = snapshot_files(&snap_root, "opencode");
    assert_eq!(oc_files.len(), 1, "opencode 的 .json 快照必须被收集");
    assert_eq!(oc_files[0], json);
    let cx_files = snapshot_files(&snap_root, "codex");
    assert_eq!(cx_files.len(), 1, "其他 agent 仍只收 .jsonl[.zst]");
    let m = opencode_snapshot_meta(&json, "ses_x").unwrap();
    assert_eq!(m.session_id, "ses_x");
    assert_eq!(m.title.as_deref(), Some("快照标题"));
    assert_eq!(m.project_path, "/proj/x");
    assert!(!m.alive);
    assert_eq!(m.created_at.as_deref(), Some("2026-07-29T06:37:51Z"));
    assert_eq!(m.token_usage.map(|u| (u.input, u.output)), Some((7, 3)));
    assert!(
        opencode_snapshot_meta(&codex_snap, "y").is_none(),
        "非导出 JSON 不产生条目"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_parse_db_messages_blocks_usage() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = opencode_fixture_db(&dir);
    let msgs = opencode_parse_db(&db, "ses_1");
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].blocks[0].text, "帮我修 bug");
    let a = &msgs[1];
    let kinds: Vec<&str> = a.blocks.iter().map(|b| b.kind.as_str()).collect();
    assert_eq!(
        kinds,
        vec![
            "thinking",
            "text",
            "tool_use",
            "tool_result",
            "tool_use",
            "tool_result"
        ]
    );
    assert_eq!(a.blocks[2].tool_name.as_deref(), Some("bash"));
    assert_eq!(a.blocks[3].text, "ok");
    assert_eq!(
        a.blocks[5].text, "写入失败",
        "error 状态的 state.error 进 tool_result"
    );
    let u = a.usage.as_ref().unwrap();
    assert_eq!(
        (u.input, u.output, u.cache_read, u.cache_write),
        (100, 25, 10, 2),
        "reasoning 计入 output"
    );
    assert_eq!(a.timestamp.as_deref(), Some("2026-07-29T06:37:51Z"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_scan_tolerates_minimal_columns() {
    // drizzle 迁移漂移：只有最小列集也得能扫
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("opencode.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
             INSERT INTO session VALUES('ses_min','只有标题','/dir');",
    )
    .unwrap();
    drop(conn);
    let metas = opencode_scan_db(&db);
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].project_path, "/dir");
    assert!(metas[0].created_at.is_none());
    assert!(metas[0].token_usage.is_none());
    assert!(
        opencode_parse_db(&db, "ses_min").is_empty(),
        "缺 message/part 表 → 空消息列表"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_export_snapshot_roundtrip() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = opencode_fixture_db(&dir);
    let exported = opencode_export_session(&db, "ses_1").unwrap();
    assert_eq!(
        get_str(exported.get("session").unwrap(), "title"),
        Some("修复登录 bug")
    );
    let msgs = opencode_parse_snapshot(&exported);
    let db_msgs = opencode_parse_db(&db, "ses_1");
    assert_eq!(msgs.len(), db_msgs.len());
    assert_eq!(
        msgs[1].blocks.len(),
        db_msgs[1].blocks.len(),
        "快照回放与读库一致"
    );
    assert_eq!(msgs[1].blocks[3].text, "ok");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn opencode_legacy_flat_json_scan_and_parse() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let storage = dir.join("storage");
    std::fs::create_dir_all(storage.join("session/p1")).unwrap();
    std::fs::create_dir_all(storage.join("message/ses_9")).unwrap();
    std::fs::create_dir_all(storage.join("part/msg_2")).unwrap();
    std::fs::write(
        storage.join("session/p1/ses_9.json"),
        r#"{"id":"ses_9","title":"旧会话","directory":"/old/dir","time":{"created":1785307071000,"updated":1785307072000},"tokens_input":7,"tokens_output":3}"#,
    )
    .unwrap();
    std::fs::write(
        storage.join("message/ses_9/msg_1.json"),
        r#"{"role":"user","time":{"created":1785307071100},"summary":{"body":"旧问题"}}"#,
    )
    .unwrap();
    std::fs::write(
        storage.join("message/ses_9/msg_2.json"),
        r#"{"role":"assistant","time":{"created":1785307071200},"tokens":{"input":7,"output":3}}"#,
    )
    .unwrap();
    std::fs::write(
        storage.join("part/msg_2/prt_1.json"),
        r#"{"type":"text","text":"旧回答"}"#,
    )
    .unwrap();
    let metas = opencode_scan_legacy(&storage);
    assert_eq!(metas.len(), 1);
    let m = &metas[0];
    assert_eq!(m.session_id, "ses_9");
    assert_eq!(m.project_path, "/old/dir");
    assert_eq!(m.title.as_deref(), Some("旧会话"));
    assert_eq!(m.created_at.as_deref(), Some("2026-07-29T06:37:51Z"));
    assert_eq!(
        m.token_usage.as_ref().map(|u| (u.input, u.output)),
        Some((7, 3))
    );
    let msgs = opencode_parse_legacy(&storage.join("session/p1/ses_9.json"));
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].blocks[0].text, "旧问题");
    assert_eq!(msgs[1].blocks[0].text, "旧回答");
    std::fs::remove_dir_all(&dir).ok();
}

// ===== 注意力标记 v1 =====

#[test]
fn tail_state_claude_variants() {
    // 文本收尾 → done；问句收尾 → confirm
    let done = s(&[
        r#"{"type":"user","message":{"role":"user","content":"问"}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"已完成修复。"}]}}"#,
    ]);
    assert_eq!(claude_tail_state(&done), "done");
    let confirm = s(&[
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"我需要删除这个文件，可以继续吗？"}]}}"#,
    ]);
    assert_eq!(claude_tail_state(&confirm), "confirm");
    // 尾部工具调用未回 → working；user 刚发 → working；meta/支线不算
    let tool = s(&[
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}"#,
    ]);
    assert_eq!(claude_tail_state(&tool), "working");
    let user = s(&[
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好"}]}}"#,
        r#"{"type":"user","message":{"role":"user","content":"再改一下"}}"#,
        r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-stdout>x</local-command-stdout>"}}"#,
    ]);
    assert_eq!(claude_tail_state(&user), "working");
    // 回合收尾标记：正文 + system/turn_duration（后面再跟几行元数据）→ settled
    let settled = s(&[
        r#"{"type":"user","message":{"role":"user","content":"你好"}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"..."}]}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"你好！都可以直接说。"}]}}"#,
        r#"{"type":"system","subtype":"turn_duration","durationMs":3000}"#,
        r#"{"type":"last-prompt"}"#,
        r#"{"type":"ai-title"}"#,
    ]);
    assert_eq!(claude_tail_state(&settled), "settled");
    // 收尾后用户又发了一条：回到 working
    let mut again = settled.clone();
    again.push(r#"{"type":"user","message":{"role":"user","content":"明天天气如何"}}"#.into());
    assert_eq!(claude_tail_state(&again), "working");
    // 问句收尾即便有收尾标记仍是 confirm
    let ask = s(&[
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"要我继续删除吗？"}]}}"#,
        r#"{"type":"system","subtype":"turn_duration","durationMs":3000}"#,
    ]);
    assert_eq!(claude_tail_state(&ask), "confirm");
}

#[test]
fn tail_state_codex_variants() {
    let done = s(&[
        r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"完成"}]}}"#,
        r#"{"type":"event_msg","payload":{"type":"token_count","info":{}}}"#, // token_count 等事件不算
    ]);
    assert_eq!(codex_tail_state(&done), "done");
    let working = s(&[
        r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}"#,
    ]);
    assert_eq!(codex_tail_state(&working), "working");
    let user = s(&[
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"干活"}]}}"#,
    ]);
    assert_eq!(codex_tail_state(&user), "working");
    // 工具输出之后的中途 agent_message 不是收尾
    let mid = s(&[
        r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"1"}}"#,
        r#"{"type":"event_msg","payload":{"type":"agent_message","message":"改名完成"}}"#,
    ]);
    assert_eq!(codex_tail_state(&mid), "working");
    let complete = s(&[
        r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好"}]}}"#,
        r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
    ]);
    assert_eq!(codex_tail_state(&complete), "settled");
    // Codex 0.163 一轮的真实尾巴（2026-10-18 本机会话，节选）：回答后跟用量与 task_complete
    let real = s(&[
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"你好"}]}}"#,
        r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage"}}}"#,
        r#"{"type":"response_item","payload":{"type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"你好！有什么需要我做的吗？比如：\n\n- 查看代码"}]}}"#,
        r#"{"type":"token_usage_record","payload":{}}"#,
        r#"{"type":"event_msg","payload":{"type":"token_count","info":{}}}"#,
        r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","root_turn_id":"t1"}}"#,
    ]);
    assert_eq!(codex_tail_state(&real), "settled");
    // 问句收尾即便回合结束仍是 confirm；按 Esc 打断（只有提问没有回答）也算收尾
    let ask = s(&[
        r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"要删吗？"}]}}"#,
        r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
    ]);
    assert_eq!(codex_tail_state(&ask), "confirm");
    let aborted = s(&[
        r#"{"type":"event_msg","payload":{"type":"user_message","message":"干活"}}"#,
        r#"{"type":"event_msg","payload":{"type":"turn_aborted"}}"#,
    ]);
    assert_eq!(codex_tail_state(&aborted), "settled");
    // 收尾之后又发了一句：新一轮在跑
    let next = s(&[
        r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
        r#"{"type":"event_msg","payload":{"type":"user_message","message":"再来"}}"#,
    ]);
    assert_eq!(codex_tail_state(&next), "working");
}

#[test]
fn tail_state_gemini_qwen_kimi() {
    let g_user = s(&[r#"{"id":"m1","type":"user","content":"在吗"}"#]);
    assert_eq!(gemini_tail_state(&g_user), "working");
    let g_done = s(&[
        r#"{"id":"m1","type":"gemini","content":"做完了"}"#,
        r#"{"$set":{"lastUpdated":"x"}}"#, // 控制记录跳过
    ]);
    assert_eq!(gemini_tail_state(&g_done), "done");
    let g_confirm = s(&[r#"{"id":"m1","type":"gemini","content":"要我继续吗？"}"#]);
    assert_eq!(gemini_tail_state(&g_confirm), "confirm");
    // 刚开会话只有环境上下文、还没提问：不算干活中
    let g_fresh = s(&[
        r#"{"id":"c0","type":"user","content":[{"text":"<session_context>\nThis is the Gemini CLI.\n</session_context>"}]}"#,
        r#"{"id":"i1","type":"info","content":"Waiting for MCP servers"}"#,
    ]);
    assert_eq!(gemini_tail_state(&g_fresh), "unknown");

    let q_user = s(&[r#"{"type":"user","message":{"role":"user","parts":[{"text":"问"}]}}"#]);
    assert_eq!(qwen_tail_state(&q_user), "working");
    let q_done =
        s(&[r#"{"type":"assistant","message":{"role":"model","parts":[{"text":"答"}]}}"#]);
    assert_eq!(qwen_tail_state(&q_done), "done");

    let k_working = s(&[
        r#"{"type":"turn.prompt","input":[{"type":"text","text":"干活"}],"origin":{"kind":"user"},"time":1}"#,
    ]);
    assert_eq!(kimi_tail_state(&k_working), "working");
    let k_done = s(&[
        r#"{"type":"context.append_loop_event","event":{"type":"step.end","usage":{}},"time":2}"#,
    ]);
    assert_eq!(kimi_tail_state(&k_done), "done");
    let k_tool = s(&[
        r#"{"type":"context.append_loop_event","event":{"type":"tool.call","name":"Bash","args":{}},"time":2}"#,
    ]);
    assert_eq!(kimi_tail_state(&k_tool), "working");
    // Kimi Code 2.1 一轮的真实尾巴（2026-10-18 本机 wire.jsonl）：turn.ended 之后还有几行记账
    let k_settled = s(&[
        r#"{"type":"context.append_loop_event","event":{"type":"step.end","usage":{}},"time":2}"#,
        r#"{"type":"agent.message.appended","time":3}"#,
        r#"{"type":"agent.turn.ended","time":3}"#,
        r#"{"type":"turn.ended","time":3}"#,
        r#"{"type":"token_counting.turn_recorded","time":3}"#,
        r#"{"type":"prompt.completed","time":3}"#,
        r#"{"type":"file_history.checkpoint","time":3}"#,
    ]);
    assert_eq!(kimi_tail_state(&k_settled), "settled");
}

#[test]
fn tail_state_codebuddy() {
    let working = s(&[
        r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"干活"}],"timestamp":1786005441386}"#,
    ]);
    assert_eq!(codebuddy_tail_state(&working), "working");
    let done = s(&[
        r#"{"type":"message","role":"assistant","content":[{"type":"output_text","text":"做完了"}]}"#,
        r#"{"type":"file-history-snapshot","snapshot":{}}"#, // 事件行不算数
    ]);
    assert_eq!(codebuddy_tail_state(&done), "done");
    let confirm = s(&[
        r#"{"type":"message","role":"assistant","content":[{"type":"output_text","text":"要我继续吗？"}]}"#,
    ]);
    assert_eq!(codebuddy_tail_state(&confirm), "confirm");
    assert_eq!(codebuddy_tail_state(&[]), "unknown");
}

#[test]
fn tail_state_opencode_and_unknown() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = opencode_fixture_db(&dir);
    // fixture：最后一条 part 是 step-start（回落到消息角色），最后消息是 assistant → done
    assert_eq!(opencode_tail_state(&db, "ses_1"), "done");
    // 加一条 pending 工具 → working
    let conn = Connection::open(&db).unwrap();
    conn.execute("INSERT INTO part VALUES('prt_9','msg_2','ses_1',1785307071300,'{\"type\":\"tool\",\"tool\":\"bash\",\"state\":{\"status\":\"running\",\"input\":{}}}')", []).unwrap();
    drop(conn);
    assert_eq!(opencode_tail_state(&db, "ses_1"), "working");
    // 最后消息是 user → working
    let conn = Connection::open(&db).unwrap();
    conn.execute("INSERT INTO message VALUES('msg_9','ses_1',1785307071400,'{\"role\":\"user\",\"summary\":{\"body\":\"再来\"}}')", []).unwrap();
    drop(conn);
    assert_eq!(opencode_tail_state(&db, "ses_1"), "working");
    // 不存在的会话 / 不存在的库 → unknown
    assert_eq!(opencode_tail_state(&db, "ses_none"), "unknown");
    assert_eq!(
        opencode_tail_state(&dir.join("none.db"), "ses_1"),
        "unknown"
    );
    std::fs::remove_dir_all(&dir).ok();
    // 文件缺失 → unknown
    assert_eq!(
        tail_state_impl("claude-code", "/nonexistent/x.jsonl"),
        "unknown"
    );
}

// ===== 导出 Markdown =====

fn msg(
    role: &str,
    blocks: Vec<(&str, &str, Option<&str>)>,
    ts: Option<&str>,
) -> ChatMessageDto {
    ChatMessageDto {
        role: role.into(),
        blocks: blocks
            .into_iter()
            .map(|(kind, text, tool)| BlockDto {
                kind: kind.into(),
                text: text.into(),
                tool_name: tool.map(|t| t.into()),
                is_error: false,
                call_id: None,
            })
            .collect(),
        timestamp: ts.map(|t| t.into()),
        usage: None,
        id: None,
        cwd: None,
    }
}

#[test]
fn render_markdown_header_and_sections() {
    let msgs = vec![
        msg(
            "user",
            vec![("text", "帮我修 bug", None)],
            Some("2026-07-01T00:00:01Z"),
        ),
        msg(
            "assistant",
            vec![
                ("thinking", "想想", None),
                ("text", "好的", None),
                ("tool_use", "{\"file_path\":\"/a\"}", Some("Read")),
                ("tool_result", "file body", None),
            ],
            Some("2026-07-01T00:00:02Z"),
        ),
    ];
    let md = render_markdown("claude-code", "abcdef123456", "修 bug", &msgs);
    assert!(md.starts_with("# 修 bug\n"));
    assert!(md.contains("- Agent: claude-code\n"));
    assert!(md.contains("- Session: abcdef123456\n"));
    assert!(md.contains("- 时间: 2026-07-01T00:00:01Z → 2026-07-01T00:00:02Z\n"));
    assert!(md.contains("- 消息数: 2\n"));
    assert!(md.contains("## 用户 · 2026-07-01T00:00:01Z\n"));
    assert!(md.contains("## 助手 · 2026-07-01T00:00:02Z\n"));
    assert!(md.contains("**思考**\n\n```text\n想想\n```\n"));
    assert!(md.contains("**工具调用: Read**\n\n```\n{\"file_path\":\"/a\"}\n```\n"));
    assert!(md.contains("**工具结果**\n\n```\nfile body\n```\n"));
}

#[test]
fn render_markdown_fence_grows_with_backticks() {
    let msgs = vec![msg(
        "assistant",
        vec![("tool_result", "```js\ncode\n```", None)],
        None,
    )];
    let md = render_markdown("claude-code", "s", "t", &msgs);
    // 内容含 ``` 时围栏必须是 ````，保证原样保留
    assert!(md.contains("````\n```js\ncode\n```\n````\n"));
    // 无时间戳时头部不出现时间行，消息头不带时间
    assert!(!md.contains("- 时间:"));
    assert!(md.contains("## 助手\n"));
}

#[test]
fn sanitize_export_name_filters_illegal_chars() {
    assert_eq!(sanitize_export_name("修 bug"), "修 bug");
    assert_eq!(
        sanitize_export_name("a/b\\c:d*e?f\"g<h>i|j"),
        "a-b-c-d-e-f-g-h-i-j"
    );
    assert_eq!(sanitize_export_name(""), "session");
    assert_eq!(sanitize_export_name("..."), "session");
    assert_eq!(
        sanitize_export_name("x".repeat(100).as_str())
            .chars()
            .count(),
        60
    );
}

// ===== 会话 watcher 目标过滤 =====

#[test]
fn session_watch_targets_plain_file_listens_parent_and_exact_file() {
    let (dir, targets) = session_watch_targets("/tmp/ccode/session.jsonl");
    assert_eq!(dir, PathBuf::from("/tmp/ccode"));
    assert_eq!(targets, vec!["/tmp/ccode/session.jsonl"]);
    assert!(watch_event_matches(
        &[PathBuf::from("/tmp/ccode/session.jsonl")],
        &targets
    ));
    assert!(!watch_event_matches(
        &[PathBuf::from("/tmp/ccode/session-other.jsonl")],
        &targets
    ));
}

#[test]
fn session_watch_targets_opencode_db_includes_wal_but_filters_other_files() {
    let (dir, targets) = session_watch_targets("/tmp/ccode/opencode.db#ses_1");
    assert_eq!(dir, PathBuf::from("/tmp/ccode"));
    assert_eq!(
        targets,
        vec![
            "/tmp/ccode/opencode.db".to_string(),
            "/tmp/ccode/opencode.db-wal".to_string(),
            "/tmp/ccode".to_string()
        ]
    );
    assert!(watch_event_matches(
        &[PathBuf::from("/tmp/ccode/opencode.db-wal")],
        &targets
    ));
    assert!(watch_event_matches(
        &[PathBuf::from("/tmp/ccode")],
        &targets
    ));
    assert!(!watch_event_matches(
        &[PathBuf::from("/tmp/ccode/opencode.db-shm")],
        &targets
    ));
}

#[test]
fn step_index_is_one_based_position_by_name() {
    let order = vec!["文献检索与筛选".to_string(), "文献精读与笔记".to_string()];
    assert_eq!(step_index_in(&order, "文献检索与筛选"), Some(1));
    assert_eq!(step_index_in(&order, "文献精读与笔记"), Some(2));
    assert_eq!(step_index_in(&order, "已删的步骤"), None);
}
