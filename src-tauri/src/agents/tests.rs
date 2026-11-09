use super::*;

#[test]
fn codex_config_provider_names_parses_table() {
    let text = "model = \"gpt-5\"\n\n[model_providers.custom]\nbase_url = \"https://a\"\n\n[model_providers.ccode]\nrequires_openai_auth = true\n";
    assert_eq!(codex_config_provider_names(text, false), vec!["custom", "ccode"]);
    assert!(codex_config_provider_names("", false).is_empty());
    assert!(codex_config_provider_names("not toml [[[", false).is_empty());
    assert!(codex_config_provider_names("model = \"gpt-5\"\n", false).is_empty());
    // provider 上的 http_headers 客户端加载失败，不当成已注册，单独列出
    let stale = "[model_providers.ccode-x]\nbase_url = \"https://a\"\n\n[model_providers.ccode-x.http_headers]\nAuthorization = \"Bearer sk\"\n";
    assert!(codex_config_provider_names(stale, false).is_empty());
    assert_eq!(codex_config_provider_names(stale, true), vec!["ccode-x"]);
    assert!(codex_config_provider_names(text, true).is_empty());
}

fn profile(agent: &str, base_url: Option<&str>) -> Profile {
    Profile {
        id: "test".into(),
        agent: agent.into(),
        name: "测试".into(),
        account_type: Default::default(),
        no_auth: false,
        protocol: None,
        api_backend: None,
        base_url: base_url.map(|s| s.into()),
        models: vec![],
        role_models: Default::default(),
        extra_env: std::collections::HashMap::new(),
        request_policy: crate::profiles::RequestPolicy::default(),
        key_hint: None,
        model: None,
        last_used_at: None,
        has_key: false,
        gateway_id: None,
        slot_missing: false,
        connection_status: String::new(),
        model_sync_status: String::new(),
        model_sync_note: None,
        provider_override: None,
    }
}

thread_local! {
    pub(super) static TEST_SHARED_ENV: std::cell::RefCell<std::collections::BTreeMap<String, String>> =
        const { std::cell::RefCell::new(std::collections::BTreeMap::new()) };
    pub(super) static TEST_CODEX_CONFIG: std::cell::RefCell<Option<toml::Value>> =
        const { std::cell::RefCell::new(None) };
    pub(super) static TEST_CLAUDE_TOP_KEYS: std::cell::RefCell<Vec<String>> =
        const { std::cell::RefCell::new(Vec::new()) };
    pub(super) static TEST_CLAUDE_TOP_MODEL: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
    pub(super) static TEST_OFFICIAL_MODELS: std::cell::RefCell<Vec<String>> =
        const { std::cell::RefCell::new(Vec::new()) };
    pub(super) static TEST_KIMI_CONFIG: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
    pub(super) static TEST_CLAUDE_USER_KEYS: std::cell::RefCell<Vec<String>> =
        const { std::cell::RefCell::new(Vec::new()) };
    // 默认当作已选 API Key（其余 gemini 单测测的是注入本身）
    pub(super) static TEST_GEMINI_AUTH: std::cell::RefCell<Option<String>> =
        std::cell::RefCell::new(Some("gemini-api-key".into()));
}

#[test]
fn gemini_api_binding_refuses_when_cli_auth_ignores_env() {
    // 端到端实测：oauth-personal 时 Mesa 注入的密钥和地址全被无视；没选认证方式但带地址时 CLI 报 Invalid auth
    assert!(gemini_auth_blocker_for(Some("oauth-personal"), true, false).unwrap().contains("Google 账号"));
    assert!(gemini_auth_blocker_for(None, true, false).is_some());
    assert!(gemini_auth_blocker_for(Some("gemini-api-key"), true, true).is_none());
    // 无头运行不带地址：环境变量兜底就够，不拦
    assert!(gemini_auth_blocker_for(None, false, false).is_none(), "官方 Gemini API（不带地址）无头靠环境变量就行");
    // 在终端里起、刚装好没选过认证方式：不带地址也拦（第一次进门先问认证、再要存钥匙串，2026-10-27 空 HOME 实录）
    let fresh = gemini_auth_blocker_for(None, false, true).unwrap();
    assert!(fresh.contains("还没选认证方式") && fresh.contains(GEMINI_AUTH_MARK));
    assert!(gemini_auth_blocker_for(Some("oauth-personal"), false, true).unwrap().contains(GEMINI_AUTH_MARK));
    // 前端按这句认卡（src/terminal-wait.ts GEMINI_AUTH_MARK）：两边同字
    let ts = include_str!("../../../src/terminal-wait.ts");
    assert!(ts.contains(&format!("GEMINI_AUTH_MARK = \"{GEMINI_AUTH_MARK}\"")));
    let p = profile("gemini", Some("https://gw.example"));
    TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("oauth-personal".into()));
    let err = launch_plan(&p, Some("sk".into()), Some("m")).unwrap_err();
    TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("gemini-api-key".into()));
    assert!(err.contains("设为全局默认"));
}

#[test]
fn claude_fills_empty_slots_and_blocks_global_leaks() {
    // 两个模型的绑定：HAIKU / FABLE 槽原先空着，用户全局的 glm-5.3 会漏进会话标题、小模型任务
    let mut p = profile("claude-code", Some("https://gw.example/anthropic"));
    p.models = vec!["m1".into(), "m2".into()];
    let plan = launch_plan(&p, Some("sk".into()), Some("m2")).unwrap();
    let settings = read_settings_override(&plan);
    assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"], "m1");
    assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"], "m2");
    assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "m2", "空槽用这次选的模型补");
    assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"], "m2");
    assert_eq!(settings["env"]["ANTHROPIC_SMALL_FAST_MODEL"], "m2");
    // 用户全局没设子 agent 模型：不盖，保留 Claude 原生继承
    assert!(settings["env"].get("CLAUDE_CODE_SUBAGENT_MODEL").is_none());
    // 用户全局设了（实测会把子 agent 请求带到全局模型上）：盖成这次的模型；上下文窗口写回默认 200K
    TEST_CLAUDE_USER_KEYS.with(|k| {
        *k.borrow_mut() = vec![
            "CLAUDE_CODE_SUBAGENT_MODEL".into(),
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(),
        ]
    });
    let plan = launch_plan(&p, Some("sk".into()), Some("m2")).unwrap();
    TEST_CLAUDE_USER_KEYS.with(|k| k.borrow_mut().clear());
    let settings = read_settings_override(&plan);
    assert_eq!(settings["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "m2");
    assert_eq!(settings["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "200000");
    assert_eq!(settings["env"]["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "200000");
}

#[test]
fn claude_declares_windows_smaller_than_assumed() {
    // 128K 的模型以前不声明，被 Claude 当成 200K：会话没压缩就先撞上网关上限（2026-11-01）
    assert_eq!(
        claude_window_env(128_000),
        vec![
            ("CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(), "128000".to_string()),
            ("CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(), "128000".to_string()),
        ]
    );
    // 压缩窗口只收 100K 起：更小的只声明窗口，Claude 按它压缩
    assert_eq!(
        claude_window_env(64_000),
        vec![("CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(), "64000".to_string())]
    );
    let mut p = profile("claude-code", Some("https://gw.example/anthropic"));
    p.models = vec!["kimi-k2".into()];
    let plan = launch_plan(&p, Some("sk".into()), Some("kimi-k2")).unwrap();
    let settings = read_settings_override(&plan);
    assert_eq!(settings["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "131072", "内置表确知 128K");
    assert_eq!(settings["env"]["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "131072");
}

#[test]
fn claude_slots_match_shared_fixture() {
    // 与 src/role-models.ts claudeAliasMap / claudeCustomOption 共读同一份样例（tests/role-models.test.ts）
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/claude-slots.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut p = profile("claude-code", Some("https://gw"));
        p.models = serde_json::from_value(case["models"].clone()).unwrap();
        p.role_models = serde_json::from_value(case["roles"].clone()).unwrap();
        let fill = case["fill"].as_str();
        let got: std::collections::BTreeMap<&str, Option<String>> =
            claude_slot_models(&p, fill).into_iter().collect();
        for slot in ["sonnet", "opus", "haiku", "fable"] {
            assert_eq!(got[slot].as_deref(), case["expect"][slot].as_str(), "{name}：{slot}");
        }
        assert_eq!(claude_custom_option(&p, fill).as_deref(), case["custom"].as_str(), "{name}：另加项");
    }
}

#[test]
fn claude_display_names_override_picker_labels() {
    let mut p = profile("claude-code", Some("https://gw"));
    p.models = vec!["glm-5.3".into()];
    p.role_models.display_names.insert("glm-5.3".into(), "GLM 5.3".into());
    let env = claude_model_env(&p, Some("glm-5.3"), &[]);
    assert!(env.contains(&("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME".into(), "GLM 5.3".into())));
}

#[test]
fn role_models_route_small_and_subagent_per_agent() {
    let roles = crate::profiles::RoleModels {
        small: Some("cheap".into()),
        subagent: Some("sub".into()),
        ..Default::default()
    };
    // Claude：haiku 槽 + SMALL_FAST 用后台小模型；子 Agent 显式写
    let mut p = profile("claude-code", Some("https://gw.example/anthropic"));
    p.models = vec!["main".into(), "cheap".into(), "sub".into()];
    p.role_models = roles.clone();
    let plan = launch_plan(&p, Some("sk".into()), Some("main")).unwrap();
    let settings = read_settings_override(&plan);
    assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "cheap");
    assert_eq!(settings["env"]["ANTHROPIC_SMALL_FAST_MODEL"], "cheap");
    assert_eq!(settings["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "sub");
    // Grok：会话标题 / 输入提示钉到后台小模型；没指定时钉主模型（防用户全局指到别家网关）
    let mut g = profile("grok", Some("https://gw.example/v1"));
    g.models = vec!["main".into(), "cheap".into()];
    g.role_models = roles.clone();
    let overlay = grok_config_overlay(&g, Some("main")).unwrap();
    assert_eq!(overlay["models"]["session_summary"], "cheap");
    assert_eq!(overlay["models"]["prompt_suggestion"], "cheap");
    g.role_models = Default::default();
    let overlay = grok_config_overlay(&g, Some("main")).unwrap();
    assert_eq!(overlay["models"]["session_summary"], "main");
    // OpenCode：small_model
    let mut o = profile("opencode", Some("https://gw.example/v1"));
    o.models = vec!["main".into(), "cheap".into()];
    o.role_models = roles;
    let plan = launch_plan(&o, Some("sk".into()), Some("main")).unwrap();
    let cfg: serde_json::Value = serde_json::from_str(
        &plan.env.iter().find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT").unwrap().1,
    )
    .unwrap();
    assert!(cfg["small_model"].as_str().unwrap().ends_with("/cheap"));
}

#[test]
fn claude_skips_thinking_for_models_declared_non_thinking() {
    // deepseek-chat 内置能力表确知不会思考：不发 adaptive thinking（不收的网关会 400）
    let mut p = profile("claude-code", Some("https://gw.example/anthropic"));
    p.models = vec!["deepseek-chat".into()];
    let plan = launch_plan(&p, Some("sk".into()), Some("deepseek-chat")).unwrap();
    let settings = read_settings_override(&plan);
    assert_eq!(settings["env"]["MAX_THINKING_TOKENS"], "0");
    let mut p = profile("claude-code", Some("https://gw.example/anthropic"));
    p.models = vec!["glm-5.3".into()];
    let plan = launch_plan(&p, Some("sk".into()), Some("glm-5.3")).unwrap();
    assert!(read_settings_override(&plan)["env"].get("MAX_THINKING_TOKENS").is_none());
}

/// 手动跑的端到端核对（2026-10-17 用户：查清各家 CLI 里 Mesa 能否正确配置模型）：
/// 按假网关地址给每家生成真实启动计划，写成 JSON，由 scripts/e2e-model-routing/drive.py 拿去真起 CLI，
/// 看请求里带的模型、打到的路径对不对。`E2E_BASE=http://127.0.0.1:端口 E2E_OUT=计划.json
/// cargo test --lib e2e_dump_launch_plans -- --ignored`
/// 续聊核对（2026-11-03）：按 Mesa 内嵌终端「点开老对话接着聊」的同一套拼法（pty.rs spawn 的恢复分支），
/// 给本机真实对话生成启动计划，交 `scripts/e2e-model-routing/resume-drive.py` 拉起真 CLI 问一句。
/// `E2E_CFG` = 真实配置根的一份拷贝（连接、密钥、绑定都从拷贝读，不碰真实目录），`E2E_OUT` 输出（含密钥，0600），
/// `E2E_PER_AGENT` 每家几条（默认 2），`E2E_SKIP` 逗号分隔的不测会话 id
#[test]
#[ignore = "手动跑：配合 scripts/e2e-model-routing/resume-drive.py"]
fn e2e_dump_resume_plans() {
    let cfg = std::env::var("E2E_CFG").expect("E2E_CFG");
    let out = std::env::var("E2E_OUT").expect("E2E_OUT");
    let per: usize = std::env::var("E2E_PER_AGENT").ok().and_then(|v| v.parse().ok()).unwrap_or(2);
    let skip: Vec<String> = std::env::var("E2E_SKIP").unwrap_or_default().split(',').map(|s| s.trim().to_string()).collect();
    CODEX_VERSION_FOR_TEST.with(|c| c.set(cli_version_uncached_ok("codex")));
    // 测试态的 Gemini 认证方式是注入的：按本机真实 settings.json 填，拦不拦才和 Mesa 一致
    let gemini_auth = crate::dirs::home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".gemini/settings.json")).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.pointer("/security/auth/selectedType").and_then(|x| x.as_str()).map(str::to_string));
    TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = gemini_auth);
    // Codex 同理：磁盘渠道带不带 auth 决定注不注 env_key
    let codex_cfg = crate::dirs::home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".codex/config.toml")).ok())
        .and_then(|t| t.parse::<toml::Value>().ok());
    tests::TEST_CODEX_CONFIG.with(|k| *k.borrow_mut() = codex_cfg);
    let store = ProfileStore::new_for_test(std::path::Path::new(&cfg));
    let mut sessions = crate::sessions::scan_with_meta();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let mut picked: std::collections::HashMap<String, usize> = Default::default();
    let mut all = Vec::new();
    for s in sessions {
        let Some(pid) = s.profile_id.clone() else { continue };
        let cwd = s.cwd.clone().unwrap_or_else(|| s.project_path.clone());
        if s.internal || skip.contains(&s.session_id) || !std::path::Path::new(&cwd).is_dir() {
            continue;
        }
        let n = picked.entry(s.agent.clone()).or_default();
        if *n >= per {
            continue;
        }
        // 同前端点开老对话：session_resume_config 给的模型，连接的模型名单里没有就用连接默认（resumeModelChoice）
        let recorded = crate::sessions::session_resume_config_sync(&s.agent, &s.session_id, &s.file_path).model;
        let built = (|| -> Result<serde_json::Value, String> {
            let listed = store.get_with_model(&pid, None)?.models;
            let model = recorded.clone().filter(|m| listed.is_empty() || listed.contains(m));
            let mut profile = store.get_with_model(&pid, model.as_deref())?;
            if profile.agent != s.agent {
                return Err("profile 与 agent 不匹配".into());
            }
            profile.apply_session_provider(s.provider.as_deref());
            let key = crate::profiles::get_key_for_profile(&profile)?;
            ensure_launch_credentials(&profile, key.as_deref())?;
            let model = model.clone().or_else(|| profile.models.first().cloned());
            crate::combo::apply_to_profile(&mut profile, model.as_deref());
            validate_launch_compatibility(&profile, model.as_deref())?;
            if let Some(msg) = gemini_interactive_blocker(&profile, key.is_some()) {
                return Err(format!("Mesa 拦下并给出设置卡：{msg}"));
            }
            let mut plan = launch_plan_with_prompt(&profile, key, model.as_deref(), None)?;
            let mut extra = prepare_launch(&profile)?;
            if s.agent == "codex" {
                let thread_model = codex_foreign_thread_provider(s.provider.as_deref())
                    .and_then(|_| crate::sessions::codex_thread_model(&s.session_id));
                codex_resume_on_thread_provider(&mut plan, &mut extra, s.provider.as_deref(), thread_model.as_deref());
            }
            let (prepend, resume) = resume_args(&s.agent, &s.session_id);
            let mut args = Vec::new();
            if prepend {
                args.extend(resume.iter().cloned());
            }
            args.extend(plan.args.iter().cloned());
            args.extend(extra);
            if !prepend {
                args.extend(resume);
            }
            Ok(serde_json::json!({
                "profile": profile.name, "model": model, "recorded_model": recorded, "args": args,
                "env": plan.env, "env_remove": plan.env_remove,
            }))
        })();
        let mut row = serde_json::json!({
            "agent": s.agent, "sid": s.session_id, "cwd": cwd, "file": s.file_path,
            "provider": s.provider, "title": s.custom_title.or(s.title),
        });
        match built {
            Ok(v) => row.as_object_mut().unwrap().extend(v.as_object().unwrap().clone()),
            Err(e) => row["error"] = serde_json::json!(e),
        }
        all.push(row);
        *n += 1;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&all).unwrap()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[test]
#[ignore = "手动跑：配合 scripts/e2e-model-routing/"]
fn e2e_dump_launch_plans() {
    let base = std::env::var("E2E_BASE").expect("E2E_BASE");
    let out = std::env::var("E2E_OUT").expect("E2E_OUT");
    // 测试态 Codex 版本默认取桩（None = 当旧版）：端到端要按本机真实版本拼参数（--no-daemon、计划工具）
    CODEX_VERSION_FOR_TEST.with(|c| c.set(cli_version_uncached_ok("codex")));
    // (agent, 协议, base_url 后缀)：Anthropic 协议的 base 不带 /v1（CLI 自己拼 /v1/messages），
    // OpenAI / Responses 协议带 /v1，Gemini 由 CLI 拼 /v1beta
    let cases: [(&str, Option<&str>, &str); 9] = [
        ("claude-code", None, ""),
        ("codebuddy", None, "/v1"),
        ("codex", None, "/v1"),
        ("qwen", Some("openai"), "/v1"),
        ("kimi", Some("openai"), "/v1"),
        ("opencode", None, "/v1"),
        ("grok", None, "/v1"),
        ("gemini", None, ""),
        ("cursor", None, ""),
    ];
    let mut all = serde_json::Map::new();
    for (agent, proto, suffix) in cases {
        let mut p = profile(agent, Some(&format!("{base}/{agent}{suffix}")));
        // 端到端要看真实机器上的全局配置会不会漏进来：读本机 ~/.claude/settings.json 的键名
        let keys = read_claude_user_settings_env_keys(&p);
        TEST_CLAUDE_USER_KEYS.with(|k| *k.borrow_mut() = keys);
        p.protocol = proto.map(Into::into);
        p.name = "E2E".into();
        p.models = vec!["e2e-default".into(), "e2e-picked".into()];
        // E2E_SMALL=e2e-default：核对「模型分工」的后台小模型是否真被用于标题 / 摘要
        if let Ok(small) = std::env::var("E2E_SMALL") {
            p.role_models.small = Some(small);
        }
        // E2E_EFFORT=high：同时核对思考档在各家线上的形态（别家模型能不能吃到）
        if let Ok(effort) = std::env::var("E2E_EFFORT") {
            p.request_policy.reasoning_effort = Some(effort);
        }
        let plan = launch_plan(&p, Some("sk-e2e-test".into()), Some("e2e-picked"));
        all.insert(
            agent.into(),
            match plan {
                Ok(plan) => {
                    // 启动前准备追加的参数（Codex 的模型目录 catalog、计划工具、--no-daemon），同 pty.rs：
                    // 接在计划参数（含权限档）后面——缺了它端到端和金丝雀核对的就不是 Mesa 真实的启动
                    // （2026-10-21：catalog 的提示词与 update_plan 都没被核对到）
                    let extra = prepare_launch(&p).unwrap_or_default();
                    let with_extra = |mut a: Vec<String>| {
                        a.extend(extra.iter().cloned());
                        a
                    };
                    // 聊天层权限四档的启动参数（pty.rs 同一处拼法），第三期逐家抓屏用；
                    // 只讨论走 readonly_args（2026-10-26 补：Claude 计划模式出完方案后的「要不要开工」菜单要抓）
                    let mut tiers: serde_json::Map<String, serde_json::Value> = ["ask", "auto", "full"]
                        .iter()
                        .filter_map(|m| {
                            permission_launch_args(agent, &plan.args, m)
                                .map(|a| ((*m).to_string(), serde_json::json!(with_extra(a))))
                        })
                        .collect();
                    // 要看版本的家（Qwen / OpenCode）测试态查不到版本：设 MESA_E2E_REAL_CLI=1 按本机版本出
                    let mut discuss_env = plan.env.clone();
                    if let Some(a) = readonly_launch_args(agent, &plan.args) {
                        tiers.insert("discuss".into(), serde_json::json!(with_extra(a)));
                        readonly_launch_env(agent, &mut discuss_env);
                    }
                    serde_json::json!({
                        "env": plan.env,
                        "args": with_extra(plan.args.clone()),
                        "env_remove": plan.env_remove,
                        "permission": tiers,
                        // 只讨论另加的环境（OpenCode 计划模式开关与 plan agent 权限，readonly_launch_env）
                        "discuss_env": discuss_env,
                    })
                }
                Err(e) => serde_json::json!({ "error": e }),
            },
        );
    }
    std::fs::write(out, serde_json::to_string_pretty(&all).unwrap()).unwrap();
}

#[test]
fn claude_non_claude_model_turns_off_tool_search() {
    let mut p = profile("claude-code", Some("https://open.bigmodel.cn/api/anthropic"));
    p.models = vec!["glm-5.3-flash".into()];
    let env = claude_model_env(&p, Some("glm-5.3-flash"), &[]);
    assert!(env.contains(&("ENABLE_TOOL_SEARCH".into(), "false".into())));
    assert!(env.contains(&("CLAUDE_CODE_ENABLE_TODO_TOOLS".into(), "1".into())));
    // Claude 自家模型照 Claude Code 默认；用户自己设过不动
    let env = claude_model_env(&p, Some("claude-sonnet-4-5"), &[]);
    assert!(!env.iter().any(|(k, _)| k == "ENABLE_TOOL_SEARCH" || k == "CLAUDE_CODE_ENABLE_TODO_TOOLS"));
    let env = claude_model_env(&p, Some("glm-5.3"), &["ENABLE_TOOL_SEARCH".into(), "CLAUDE_CODE_ENABLE_TODO_TOOLS".into()]);
    assert!(!env.iter().any(|(k, _)| k == "ENABLE_TOOL_SEARCH" || k == "CLAUDE_CODE_ENABLE_TODO_TOOLS"));
}

#[test]
fn claude_plan_registers_models_into_picker() {
    let mut p = profile("claude-code", None);
    p.models = vec![
        "m1".into(),
        "m2".into(),
        "m3".into(),
        "m4".into(),
        "m5".into(),
    ];
    let plan = launch_plan(&p, None, Some("m1")).unwrap();
    assert!(plan
        .env
        .contains(&("ANTHROPIC_DEFAULT_SONNET_MODEL".into(), "m1".into())));
    // _NAME 槽是选择器显示名：带 profile 名（配置名 · 模型）
    assert!(plan.env.contains(&(
        "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME".into(),
        "测试 · m2".into()
    )));
    assert!(plan
        .env
        .contains(&("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), "m3".into())));
    assert!(plan
        .env
        .contains(&("ANTHROPIC_DEFAULT_FABLE_MODEL".into(), "m4".into())));
    assert!(plan
        .env
        .contains(&("ANTHROPIC_CUSTOM_MODEL_OPTION".into(), "m5".into())));
    assert!(plan.env.contains(&(
        "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".into(),
        "测试 · m5".into()
    )));
    // 用户全局没设子 agent 模型时，不被 Mesa 固定到绑定列表中的任意模型，保留 Claude 原生选择链
    assert!(!plan
        .env
        .iter()
        .any(|(k, _)| k == "CLAUDE_CODE_SUBAGENT_MODEL"));
    // --settings 现在传的是 0600 临时文件的路径（密钥不进 argv），内容从文件读回
    let settings = read_settings_override(&plan);
    assert_eq!(settings["env"]["ANTHROPIC_MODEL"], "m1");
    assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "m3");
}

/// 取 `--settings` 覆盖层的内容：参数是文件路径，读回并解析（测试用）
fn read_settings_override(plan: &LaunchPlan) -> serde_json::Value {
    let path = plan
        .args
        .windows(2)
        .find(|pair| pair[0] == "--settings")
        .map(|pair| pair[1].clone())
        .expect("启动计划里应有 --settings");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不到设置覆盖文件 {path}: {e}"));
    serde_json::from_str(&text).expect("设置覆盖文件不是合法 JSON")
}

#[test]
fn claude_plan_declares_context_over_200k() {
    // 注册链确知 >200K（kimi-k3 = 1M 内置表）→ 成对注入 MAX_CONTEXT_TOKENS +
    // AUTO_COMPACT_WINDOW（同值）；未知模型（兜底 128K）两个都不注入
    let mut p = profile("claude-code", None);
    p.models = vec!["kimi-k3".into()];
    let plan = launch_plan(&p, None, Some("kimi-k3")).unwrap();
    assert!(plan
        .env
        .contains(&("CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(), "1048576".into())));
    assert!(plan
        .env
        .contains(&("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), "1048576".into())));
    let mut p2 = profile("claude-code", None);
    p2.models = vec!["unknown-model".into()];
    let plan2 = launch_plan(&p2, None, Some("unknown-model")).unwrap();
    assert!(!plan2
        .env
        .iter()
        .any(|(k, _)| k == "CLAUDE_CODE_MAX_CONTEXT_TOKENS"
            || k == "CLAUDE_CODE_AUTO_COMPACT_WINDOW"));
    // 不再注入子 agent 覆盖
    assert!(!plan2
        .env
        .iter()
        .any(|(k, _)| k == "CLAUDE_CODE_SUBAGENT_MODEL"));
}

#[test]
fn extra_env_appended_last_for_override() {
    let mut p = profile("claude-code", Some("https://relay.example.com"));
    p.extra_env
        .insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
    p.extra_env.insert(
        "ANTHROPIC_BASE_URL".into(),
        "https://override.example.com".into(),
    );
    let plan = launch_plan(&p, None, None).unwrap();
    assert!(plan
        .env
        .contains(&("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into())));
    // 与 adapter 内置值重复时，extra_env 排在后面（CommandBuilder 后者生效）
    let last = plan
        .env
        .iter()
        .rposition(|(k, _)| k == "ANTHROPIC_BASE_URL")
        .unwrap();
    assert_eq!(plan.env[last].1, "https://override.example.com");
}

#[test]
fn claude_plan_sets_only_present_fields() {
    let p = profile("claude-code", Some("https://relay.example.com"));
    let plan = launch_plan(&p, Some("sk-secret".into()), None).unwrap();
    assert!(plan.args.windows(2).any(|pair| pair[0] == "--settings"));
    assert!(plan.env.contains(&(
        "ANTHROPIC_BASE_URL".into(),
        "https://relay.example.com".into()
    )));
    assert!(plan
        .env
        .contains(&("ANTHROPIC_AUTH_TOKEN".into(), "sk-secret".into())));
    // 2026-09-27：base_url 与 token 必须在 --settings 层成对出现。只提 base_url 会让
    // 磁盘 ~/.claude/settings.json 里残留的旧 token 胜出，请求带着别家令牌打到本网关（401）。
    let settings = read_settings_override(&plan);
    assert_eq!(settings["env"]["ANTHROPIC_BASE_URL"], "https://relay.example.com");
    assert_eq!(settings["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-secret");
    assert!(!plan.env.iter().any(|(k, _)| k == "ANTHROPIC_MODEL"));
    // 带密钥时 claude.ai 连接器本来不加载，明说不加载，免得 CLI 往 stderr 写告警夹进画面
    assert!(plan.env.contains(&("ENABLE_CLAUDEAI_MCP_SERVERS".into(), "0".into())));
}

#[test]
fn claude_plan_without_key_omits_token() {
    let p = profile("claude-code", None);
    let plan = launch_plan(&p, None, Some("claude-sonnet-4")).unwrap();
    assert_eq!(plan.env.len(), 1);
    assert!(plan.args.windows(2).any(|pair| pair[0] == "--model"));
    assert!(plan
        .env
        .contains(&("ANTHROPIC_MODEL".into(), "claude-sonnet-4".into())));
    // 无密钥时覆盖层也不该凭空造一个 token 键出来
    let settings = read_settings_override(&plan);
    assert!(settings["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
}

#[test]
fn claude_request_policy_injects_verified_channels() {
    let mut p = profile("claude-code", None);
    p.request_policy.temperature = Some(0.7);
    p.request_policy.top_p = Some(0.9);
    p.request_policy.max_output_tokens = Some(8192);
    p.request_policy.reasoning_effort = Some("high".into());
    p.request_policy
        .header_env
        .insert("X-Region".into(), "MODEL_REGION".into());
    p.request_policy
        .header_env
        .insert("X-Miss".into(), "MISSING_VAR".into());
    let mut plan = LaunchPlan::default();
    apply_request_policy_env(&mut plan, "claude-code", &p.request_policy, &|k| {
        (k == "MODEL_REGION").then(|| "cn-1".to_string())
    });
    // temperature/top_p 合并进同一个 EXTRA_BODY JSON（只含填了的字段）
    let body = plan
        .env
        .iter()
        .find(|(k, _)| k == "CLAUDE_CODE_EXTRA_BODY")
        .map(|(_, v)| v.clone())
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["temperature"], 0.7);
    assert_eq!(v["top_p"], 0.9);
    assert!(plan
        .env
        .contains(&("CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), "8192".into())));
    assert!(plan
        .env
        .contains(&("CLAUDE_CODE_EFFORT_LEVEL".into(), "high".into())));
    // 解析不到的环境变量跳过该 header，不注空值
    assert!(plan
        .env
        .contains(&("ANTHROPIC_CUSTOM_HEADERS".into(), "X-Region: cn-1".into())));
}

#[test]
fn codebuddy_request_policy_uses_own_prefix_and_skips_unverified() {
    let mut p = profile("codebuddy", None);
    p.request_policy.temperature = Some(0.7); // 无 EXTRA_BODY 通道：不注
    p.request_policy.max_output_tokens = Some(4096);
    p.request_policy.reasoning_effort = Some("high".into()); // unknown：不注
    p.request_policy
        .header_env
        .insert("X-Region".into(), "MODEL_REGION".into());
    let mut plan = LaunchPlan::default();
    apply_request_policy_env(&mut plan, "codebuddy", &p.request_policy, &|k| {
        (k == "MODEL_REGION").then(|| "cn-1".to_string())
    });
    assert_eq!(plan.env.len(), 2);
    assert!(plan
        .env
        .contains(&("CODEBUDDY_CODE_MAX_OUTPUT_TOKENS".into(), "4096".into())));
    assert!(plan
        .env
        .contains(&("CODEBUDDY_CUSTOM_HEADERS".into(), "X-Region: cn-1".into())));
}

#[test]
fn gemini_custom_headers_are_comma_joined() {
    let mut p = profile("gemini", None);
    p.request_policy.header_env.insert("X-A".into(), "VA".into());
    p.request_policy.header_env.insert("X-B".into(), "VB".into());
    let mut plan = LaunchPlan::default();
    apply_request_policy_env(&mut plan, "gemini", &p.request_policy, &|k| Some(format!("v-{k}")));
    assert_eq!(plan.env, vec![("GEMINI_CLI_CUSTOM_HEADERS".into(), "X-A: v-VA, X-B: v-VB".into())]);
}

#[test]
fn kimi_request_policy_goes_through_env_model_overrides() {
    // 2026-11-04 假网关实测 2.4.1：三种协议都发温度 / top_p / 输出上限，请求头每行「名: 值」
    let mut p = profile("kimi", None);
    p.request_policy.temperature = Some(0.33);
    p.request_policy.top_p = Some(0.77);
    p.request_policy.max_output_tokens = Some(1234);
    p.request_policy
        .header_env
        .insert("X-Region".into(), "MODEL_REGION".into());
    let mut plan = LaunchPlan::default();
    apply_request_policy_env(&mut plan, "kimi", &p.request_policy, &|k| {
        (k == "MODEL_REGION").then(|| "cn-1".to_string())
    });
    for pair in [
        ("KIMI_MODEL_TEMPERATURE", "0.33"),
        ("KIMI_MODEL_TOP_P", "0.77"),
        ("KIMI_MODEL_MAX_COMPLETION_TOKENS", "1234"),
        ("KIMI_CODE_CUSTOM_HEADERS", "X-Region: cn-1"),
    ] {
        assert!(plan.env.contains(&(pair.0.into(), pair.1.into())), "{pair:?}");
    }
}

#[test]
fn codebuddy_launch_uses_current_effort_and_model_flags() {
    let mut p = profile("codebuddy", Some("https://relay.example.com/anthropic"));
    p.request_policy.reasoning_effort = Some("high".into());
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("m1")).unwrap();
    assert!(plan
        .args
        .windows(2)
        .any(|pair| pair[0] == "--model" && pair[1] == "m1"));
    assert!(plan
        .args
        .windows(2)
        .any(|pair| pair[0] == "--effort" && pair[1] == "high"));
}

#[test]
fn request_policy_not_injected_for_unverified_agents_or_official() {
    // 未实证 agent（codex）：任何策略字段都不产生 env
    let mut p = profile("codex", None);
    p.request_policy.temperature = Some(0.2);
    let plan = launch_plan(&p, None, None).unwrap();
    assert!(!plan.env.iter().any(|(k, _)| {
        k.contains("EXTRA_BODY")
            || k.contains("EFFORT")
            || k.contains("CUSTOM_HEADERS")
            || k.contains("MAX_OUTPUT_TOKENS")
    }));
    // 官方账号模式：early-return 路径不经过策略注入
    let mut p = profile("claude-code", None);
    p.account_type = crate::profiles::AccountType::Official;
    p.request_policy.max_output_tokens = Some(8192);
    let plan = launch_plan(&p, None, None).unwrap();
    assert!(!plan
        .env
        .iter()
        .any(|(k, _)| k == "CLAUDE_CODE_MAX_OUTPUT_TOKENS"));
}

#[test]
fn extra_env_overrides_policy_injection() {
    // 用户 extra_env 与策略注入同键时排在最后（CommandBuilder 后者生效）
    let mut p = profile("claude-code", None);
    p.request_policy.temperature = Some(0.7);
    p.extra_env.insert(
        "CLAUDE_CODE_EXTRA_BODY".into(),
        "{\"temperature\":0.1}".into(),
    );
    let plan = launch_plan(&p, None, None).unwrap();
    let last = plan
        .env
        .iter()
        .rposition(|(k, _)| k == "CLAUDE_CODE_EXTRA_BODY")
        .unwrap();
    assert_eq!(plan.env[last].1, "{\"temperature\":0.1}");
}

#[test]
fn codex_request_policy_injects_effort_and_env_headers() {
    let mut p = profile("codex", Some("https://relay.example.com/v1"));
    p.request_policy.reasoning_effort = Some("high".into());
    p.request_policy.temperature = Some(0.2); // 无通道：不注
    p.request_policy
        .header_env
        .insert("X-Region".into(), "MODEL_REGION".into());
    let plan = launch_plan(&p, None, Some("gpt-x")).unwrap();
    assert!(plan
        .args
        .iter()
        .any(|a| a == r#"model_reasoning_effort="high""#));
    assert!(plan
        .args
        .iter()
        .any(|a| a == r#"model_providers.ccode.env_http_headers."X-Region"="MODEL_REGION""#));
    // 无 base_url = 无内联 provider 可挂，headers 不注；effort 是全局键照常
    let mut p2 = profile("codex", None);
    p2.request_policy
        .header_env
        .insert("X-Region".into(), "MODEL_REGION".into());
    let plan2 = launch_plan(&p2, None, None).unwrap();
    assert!(!plan2.args.iter().any(|a| a.contains("env_http_headers")));
}

#[test]
fn opencode_request_policy_merges_into_inline_config() {
    let mut p = profile("opencode", Some("https://relay.example.com/v1"));
    p.models = vec!["m1".into()];
    p.request_policy.temperature = Some(0.3);
    p.request_policy.max_output_tokens = Some(4096);
    p.request_policy.reasoning_effort = Some("low".into());
    let plan = launch_plan(&p, None, Some("m1")).unwrap();
    let raw = plan
        .env
        .iter()
        .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
        .unwrap()
        .1
        .clone();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let opts = &v["provider"]["ccode"]["models"]["m1"]["options"];
    assert_eq!(opts["temperature"], 0.3);
    assert_eq!(opts["maxOutputTokens"], 4096);
    assert_eq!(opts["reasoningEffort"], "low");
    // headers 引用的环境变量未设置时不进配置（不落空值/密文）
    assert!(v["provider"]["ccode"]["options"].get("headers").is_none());
}

#[test]
fn kimi_request_policy_effort_only_on_kimi_channel() {
    let mut p = profile("kimi", Some("https://api.moonshot.cn"));
    p.request_policy.reasoning_effort = Some("High".into());
    let plan = launch_plan(&p, None, Some("kimi-k3")).unwrap();
    assert!(plan
        .env
        .contains(&("KIMI_MODEL_THINKING_EFFORT".into(), "high".into())));
    // anthropic 兼容通道该 env 被 CLI 静默忽略——干脆不注
    p.protocol = Some("anthropic".into());
    let plan = launch_plan(&p, None, Some("kimi-k3")).unwrap();
    assert!(!plan
        .env
        .iter()
        .any(|(k, _)| k == "KIMI_MODEL_THINKING_EFFORT"));
}

#[test]
fn codebuddy_plan_injects_codebuddy_env() {
    let p = profile("codebuddy", Some("https://api.deepseek.com/anthropic"));
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("deepseek-v3-2-volc")).unwrap();
    assert!(plan.env.contains(&(
        "CODEBUDDY_BASE_URL".into(),
        "https://api.deepseek.com/anthropic".into()
    )));
    assert!(plan
        .env
        .contains(&("CODEBUDDY_API_KEY".into(), "sk-secret".into())));
    assert!(plan
        .env
        .contains(&("CODEBUDDY_MODEL".into(), "deepseek-v3-2-volc".into())));
    // 初始 prompt 是位置参数（一键开步注入）
    let plan = launch_plan_with_prompt(&p, Some("sk-secret".into()), None, Some("干活")).unwrap();
    assert_eq!(plan.prompt_args, vec!["干活"]);
}

#[test]
fn codebuddy_official_plan_purges_api_env() {
    // 官方账号拉起：不注入 API env，且必须 env_remove 残留密钥变量（env 优先压账号，实测 401）
    let p = official_profile("codebuddy");
    let plan = launch_plan(&p, None, None).unwrap();
    assert!(!plan.env.iter().any(|(k, _)| k.starts_with("CODEBUDDY_")));
    assert!(plan.env_remove.contains(&"CODEBUDDY_API_KEY".to_string()));
    assert!(plan
        .env_remove
        .contains(&"CODEBUDDY_AUTH_TOKEN".to_string()));
}

#[test]
fn grok_plan_injects_xai_env() {
    let mut p = profile("grok", Some("https://relay.example.com/v1"));
    p.models = vec!["grok-code-fast-1".into(), "grok-4.5".into()];
    let plan = launch_plan(&p, Some("xai-secret".into()), Some("grok-code-fast-1")).unwrap();
    assert!(plan.env.contains(&(
        "GROK_MODELS_BASE_URL".into(),
        "https://relay.example.com/v1".into()
    )));
    assert!(plan
        .env
        .contains(&("XAI_API_KEY".into(), "xai-secret".into())));
    assert!(plan
        .env
        .contains(&("GROK_DEFAULT_MODEL".into(), "grok-code-fast-1".into())));
    assert!(plan
        .args
        .windows(2)
        .any(|pair| pair[0] == "-m" && pair[1] == "grok-code-fast-1"));
    // 第三方网关：内置 web_search 拿网关钥匙去 xAI 鉴权必 401，关掉；xAI 官方地址保留
    assert!(plan.args.iter().any(|a| a == "--disable-web-search"));
    let mut official = p.clone();
    official.base_url = Some("https://api.x.ai/v1".into());
    let plan_official = launch_plan(&official, Some("xai-secret".into()), Some("grok-code-fast-1")).unwrap();
    assert!(!plan_official.args.iter().any(|a| a == "--disable-web-search"));
    // 模型列表经 GROK_CONFIG overlay 收敛进选择器（allowed_models）
    let grok_config = plan
        .env
        .iter()
        .find(|(k, _)| k == "GROK_CONFIG")
        .map(|(_, v)| v.clone())
        .expect("grok 有模型列表时必须注入 GROK_CONFIG");
    let v: serde_json::Value = serde_json::from_str(&grok_config).unwrap();
    assert_eq!(
        v["models"]["allowed_models"],
        serde_json::json!(["grok-code-fast-1", "grok-4.5"])
    );
    // overlay 同时把本次启动模型写成 [models].default：1.0.34 先拿 config 的 default 比对
    // allowed_models，不匹配就拒启动（GROK_DEFAULT_MODEL 偏好在之后才生效）
    assert_eq!(
        v["models"]["default"],
        serde_json::json!("grok-code-fast-1")
    );
    // 初始 prompt 是位置参数（一键开步注入）
    let plan = launch_plan_with_prompt(&p, Some("xai-secret".into()), None, Some("干活")).unwrap();
    assert_eq!(plan.prompt_args, vec!["干活"]);
    // 空模型列表不注入 GROK_CONFIG（allowed_models 空 = fail-closed 全不匹配）
    let empty = profile("grok", Some("https://relay.example.com/v1"));
    let plan = launch_plan(&empty, Some("xai-secret".into()), None).unwrap();
    assert!(!plan.env.iter().any(|(k, _)| k == "GROK_CONFIG"));
}

#[test]
fn grok_plan_falls_back_to_first_binding_model() {
    // 未选模型时用绑定清单第一个兜底：防回落 config.toml 第一方默认直连 xAI 代理
    let mut p = profile("grok", Some("https://open.bigmodel.cn/api/paas/v4"));
    p.models = vec!["glm-5.3".into(), "glm-5.2".into()];
    let plan = launch_plan(&p, Some("k".into()), None).unwrap();
    assert!(plan
        .env
        .contains(&("GROK_DEFAULT_MODEL".into(), "glm-5.3".into())));
    assert!(plan
        .args
        .windows(2)
        .any(|pair| pair[0] == "-m" && pair[1] == "glm-5.3"));
}

#[test]
fn grok_model_fallback_scoped_to_grok() {
    // 空模型清单不兜底（维持原行为）
    let empty = profile("grok", Some("https://relay.example.com/v1"));
    let plan = launch_plan(&empty, Some("k".into()), None).unwrap();
    assert!(!plan.env.iter().any(|(k, _)| k == "GROK_DEFAULT_MODEL"));
    assert!(!plan.args.iter().any(|a| a == "-m"));

    // 显式选模永远优先于兜底（不被清单第一个覆盖）
    let mut p = profile("grok", Some("https://open.bigmodel.cn/api/paas/v4"));
    p.models = vec!["glm-5.3".into(), "glm-5.2".into()];
    let plan = launch_plan(&p, Some("k".into()), Some("glm-5.2")).unwrap();
    assert!(plan
        .env
        .contains(&("GROK_DEFAULT_MODEL".into(), "glm-5.2".into())));
    assert!(!plan
        .env
        .contains(&("GROK_DEFAULT_MODEL".into(), "glm-5.3".into())));
}

#[test]
fn grok_overlay_default_overrides_stale_global_default() {
    // 回归（2026-09-20 用户实机）：~/.grok/config.toml 的 [models].default 若是别家绑定
    // 「设为全局默认」留下的模型（本例 grok-4.6），1.0.34 会先拿它比对本次 allowed_models
    // 并直接拒启动。overlay 写 default=本次启动模型可让这道门通过。
    let mut p = profile("grok", Some("https://relay.example.com/v1"));
    p.models = vec!["deepseek-v4-flash-0731".into()];
    let overlay_of = |plan: &LaunchPlan| -> serde_json::Value {
        serde_json::from_str(
            &plan
                .env
                .iter()
                .find(|(k, _)| k == "GROK_CONFIG")
                .map(|(_, v)| v.clone())
                .expect("有模型时必须注入 GROK_CONFIG"),
        )
        .unwrap()
    };
    // 显式选模
    let plan = launch_plan(&p, Some("k".into()), Some("deepseek-v4-flash-0731")).unwrap();
    let v = overlay_of(&plan);
    assert_eq!(
        v["models"]["default"],
        serde_json::json!("deepseek-v4-flash-0731")
    );
    assert_eq!(
        v["models"]["allowed_models"],
        serde_json::json!(["deepseek-v4-flash-0731"])
    );
    // 未选模型 → 兜底绑定清单第一个，default 与 -m 同为它
    let plan = launch_plan(&p, Some("k".into()), None).unwrap();
    let v = overlay_of(&plan);
    assert_eq!(
        v["models"]["default"],
        serde_json::json!("deepseek-v4-flash-0731")
    );
}

#[test]
fn grok_empty_model_is_treated_as_unselected() {
    // 前端 buildAskAiPending 会带空串模型占位：必须按「未选」处理——兜底绑定清单第一个，
    // 不得把空串写进 GROK_DEFAULT_MODEL / allowed_models / [models].default
    let mut p = profile("grok", Some("https://relay.example.com/v1"));
    p.models = vec!["glm-5.3".into()];
    for empty in [Some(""), Some("   ")] {
        let plan = launch_plan(&p, Some("k".into()), empty).unwrap();
        assert!(
            plan.env
                .contains(&("GROK_DEFAULT_MODEL".into(), "glm-5.3".into())),
            "空模型必须回落绑定清单第一个"
        );
        assert!(!plan.env.iter().any(|(_, v)| v.is_empty()));
        let v: serde_json::Value = serde_json::from_str(
            &plan
                .env
                .iter()
                .find(|(k, _)| k == "GROK_CONFIG")
                .map(|(_, v)| v.clone())
                .expect("有模型时必须注入 GROK_CONFIG"),
        )
        .unwrap();
        assert_eq!(
            v["models"]["allowed_models"],
            serde_json::json!(["glm-5.3"])
        );
        assert_eq!(v["models"]["default"], serde_json::json!("glm-5.3"));
        assert!(plan
            .args
            .windows(2)
            .any(|pair| pair[0] == "-m" && pair[1] == "glm-5.3"));
    }
}

#[test]
fn grok_non_default_backend_fails_closed_before_spawn() {
    let mut p = profile("grok", Some("https://relay.example.com/v1"));
    p.api_backend = Some("responses".into());
    assert!(validate_launch_compatibility(&p, None).is_err());
}

#[test]
fn opencode_v2_inline_config_uses_native_providers() {
    let mut p = profile("opencode", Some("https://relay.example.com/v1"));
    p.models = vec!["deepseek-v4".into(), "plain-model".into()];
    p.request_policy.reasoning_effort = Some("xhigh".into());
    p.request_policy.temperature = Some(0.3);
    let plan = launch_plan(&p, Some("sk-test".into()), Some("deepseek-v4")).unwrap();
    let raw = plan.env.iter().find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT").unwrap().1.clone();
    let mut cfg: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let pid = p.provider_name();
    let reasoning = cfg["provider"][&pid]["models"]["deepseek-v4"]["reasoning"] == true;
    opencode_inline_config_v2(&mut cfg, Some("xhigh"));
    assert!(cfg.get("provider").is_none(), "1.x 的 provider 整体换掉");
    let prov = &cfg["providers"][&pid];
    assert_eq!(prov["package"], "aisdk:@ai-sdk/openai-compatible");
    assert_eq!(prov["settings"]["apiKey"], "sk-test");
    assert_eq!(prov["settings"]["baseURL"], "https://relay.example.com/v1");
    let m = &prov["models"]["deepseek-v4"];
    assert_eq!(m["settings"]["reasoningEffort"], "xhigh", "思考档留在请求外的 settings");
    assert_eq!(m["body"]["temperature"], 0.3, "其余参数进请求体（2.x 对 1.x 写法同样处理）");
    assert!(m["limit"]["context"].as_i64().unwrap() > 0);
    if reasoning {
        assert_eq!(m["capabilities"]["reasoning"]["supported"], true);
        let efforts: Vec<&str> =
            m["capabilities"]["reasoning"]["effort"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(efforts, vec!["low", "medium", "high", "xhigh"], "连接选的档补进可选档位");
    }
    assert_eq!(prov["models"]["plain-model"]["capabilities"]["input"], serde_json::json!(["text"]), "没声明视觉的只收文本");
    assert_eq!(cfg["model"], format!("{pid}/deepseek-v4"), "顶层 model 2.x 照读，不动");
}

#[test]
fn opencode_v2_readonly_env_sets_default_agent_and_global_rules() {
    let mut env = vec![("OPENCODE_CONFIG_CONTENT".to_string(), r#"{"model":"ccode/m"}"#.to_string())];
    opencode_readonly_env_v2(&mut env);
    assert!(!env.iter().any(|(k, _)| k == "OPENCODE_EXPERIMENTAL_PLAN_MODE"), "2.x 没有这个开关");
    let cfg: serde_json::Value = serde_json::from_str(&env[0].1).unwrap();
    assert_eq!(cfg["model"], "ccode/m");
    assert_eq!(cfg["default_agent"], "plan", "主命令不认 --agent，改由配置定");
    let perm = &cfg["permission"];
    assert_eq!(perm.as_object().unwrap().keys().next().map(String::as_str), Some("*"), "先兜底");
    assert_eq!(perm["*"], "ask");
    let edit: Vec<(&String, &serde_json::Value)> = perm["edit"].as_object().unwrap().iter().collect();
    assert_eq!(edit[0], (&"*".to_string(), &serde_json::json!("deny")));
    assert_eq!(edit[1], (&"~/.opencode/plan/*".to_string(), &serde_json::json!("allow")), "2.x 方案目录在家目录下");
}

#[test]
fn grok_model_config_match_requires_backend_and_endpoint() {
    let text = r#"
[model."kimi-k3"]
model = "kimi-k3"
base_url = "https://relay.example.com/v1"
api_backend = "responses"
"#;
    assert!(grok_model_config_matches(
        text,
        "kimi-k3",
        "responses",
        Some("https://relay.example.com/v1/")
    ));
    assert!(!grok_model_config_matches(
        text,
        "kimi-k3",
        "chat_completions",
        Some("https://relay.example.com/v1")
    ));
}

#[test]
fn grok_overlay_carries_models_defaults_from_policy() {
    // 请求策略 → overlay [models] 全局默认（白名单实证只放行 [models] 全局块，
    // [model.<id>] 注不进）；注意键名 max_completion_tokens / default_reasoning_effort
    let mut p = profile("grok", Some("https://relay.example.com/v1"));
    p.request_policy.temperature = Some(0.7);
    p.request_policy.top_p = Some(0.95);
    p.request_policy.max_output_tokens = Some(8192);
    p.request_policy.reasoning_effort = Some("high".into());
    p.request_policy
        .header_env
        .insert("X-Tenant".into(), "TENANT_TOKEN".into());
    // 空模型列表 + 有策略：仍注入（overlay 不止 allowed_models 一个用途）
    let plan = launch_plan(&p, Some("xai-secret".into()), None).unwrap();
    let grok_config = plan
        .env
        .iter()
        .find(|(k, _)| k == "GROK_CONFIG")
        .map(|(_, v)| v.clone())
        .expect("有请求策略时必须注入 GROK_CONFIG");
    let v: serde_json::Value = serde_json::from_str(&grok_config).unwrap();
    // 无模型列表 → 不注 allowed_models（fail-closed 全不匹配）
    assert!(v["models"].get("allowed_models").is_none());
    assert_eq!(v["models"]["temperature"], serde_json::json!(0.7));
    assert_eq!(v["models"]["top_p"], serde_json::json!(0.95));
    assert_eq!(
        v["models"]["max_completion_tokens"],
        serde_json::json!(8192)
    );
    assert_eq!(
        v["models"]["default_reasoning_effort"],
        serde_json::json!("high")
    );
    // Header 是 $VAR 引用（grok 进程内展开），密文不进 env 值
    assert_eq!(
        v["models"]["extra_headers"],
        serde_json::json!({ "X-Tenant": "$TENANT_TOKEN" })
    );
    p.request_policy.reasoning_effort = Some("hign/xhign".into());
    let plan = launch_plan(&p, Some("xai-secret".into()), Some("gpt-6-sol")).unwrap();
    let grok_config = plan
        .env
        .iter()
        .find(|(k, _)| k == "GROK_CONFIG")
        .map(|(_, v)| v.clone())
        .expect("温度等策略仍在，overlay 还要注入");
    let v: serde_json::Value = serde_json::from_str(&grok_config).unwrap();
    assert!(v["models"].get("default_reasoning_effort").is_none());
    assert!(!plan.args.iter().any(|a| a == "--reasoning-effort"));
    // 无策略、无模型 → 完全不注
    let bare = profile("grok", Some("https://relay.example.com/v1"));
    let plan = launch_plan(&bare, None, None).unwrap();
    assert!(!plan.env.iter().any(|(k, _)| k == "GROK_CONFIG"));
}

#[test]
fn grok_official_plan_purges_api_env() {
    // 官方账号拉起：不注入 API env，且必须 env_remove 残留密钥变量（凭证优先级 api_key > env_key > 登录 token）
    let p = official_profile("grok");
    let plan = launch_plan(&p, None, None).unwrap();
    assert!(!plan
        .env
        .iter()
        .any(|(k, _)| k.starts_with("XAI_") || k.starts_with("GROK_")));
    assert!(plan.env_remove.contains(&"XAI_API_KEY".to_string()));
    assert!(plan
        .env_remove
        .contains(&"GROK_CODE_XAI_API_KEY".to_string()));
}

#[test]
fn cursor_plan_injects_key_endpoint_env_and_model_flag() {
    let p = profile("cursor", Some("https://api2.cursor.sh"));
    let plan = launch_plan(
        &p,
        Some("key-secret".into()),
        Some("claude-opus-4-8[context=1m,effort=high]"),
    ).unwrap();
    assert!(plan
        .env
        .contains(&("CURSOR_API_KEY".into(), "key-secret".into())));
    assert!(plan.env.contains(&(
        "CURSOR_API_ENDPOINT".into(),
        "https://api2.cursor.sh".into()
    )));
    // 模型走 --model flag（bracket 参数化原样透传），不是 env
    assert_eq!(
        plan.args,
        vec!["--model", "claude-opus-4-8[context=1m,effort=high]"]
    );
    assert!(!plan.env.iter().any(|(k, _)| k.contains("MODEL")));
    // 空字段不注入：无 base_url/密钥/模型时 env 与 args 都为空
    let bare = launch_plan(&profile("cursor", None), None, None).unwrap();
    assert!(bare.env.is_empty());
    assert!(bare.args.is_empty());
    // 初始 prompt 是位置参数（一键开步注入）
    let plan = launch_plan_with_prompt(&p, Some("key-secret".into()), None, Some("干活")).unwrap();
    assert_eq!(plan.prompt_args, vec!["干活"]);
    assert!(!plan.prompt_dropped);
}

#[test]
fn cursor_plan_rejects_gateway_key_on_third_party_endpoint() {
    let p = profile("cursor", Some("https://open.bigmodel.cn/api/paas/v4"));
    let err = launch_plan(&p, Some("gateway-key".into()), Some("glm-5.3")).unwrap_err();
    assert!(err.contains("官方账号"));
    assert!(err.contains("cursor-agent login"));
}

#[test]
fn cursor_official_plan_purges_key_but_keeps_model_flag() {
    // 官方账号拉起：不注入 CURSOR_API_KEY（且 env_remove 残留），模型 flag 照常可用
    let p = official_profile("cursor");
    let plan = launch_plan(&p, Some("key-secret".into()), Some("gpt-5")).unwrap();
    assert!(!plan.env.iter().any(|(k, _)| k.starts_with("CURSOR_")));
    assert_eq!(plan.args, vec!["--model", "gpt-5"]);
    assert!(plan.env_remove.contains(&"CURSOR_API_KEY".to_string()));
    // 模型为空：无任何参数
    let bare = launch_plan(&p, None, None).unwrap();
    assert!(bare.args.is_empty());
    assert!(bare.env.is_empty());
}

#[test]
fn permission_launch_args_per_agent() {
    assert_eq!(
        permission_launch_args("claude-code", &[], "full").unwrap(),
        vec!["--permission-mode", "bypassPermissions"]
    );
    assert_eq!(
        permission_launch_args("claude-code", &[], "auto").unwrap(),
        vec!["--permission-mode", "auto"]
    );
    assert_eq!(
        permission_launch_args("qwen", &[], "auto").unwrap(),
        vec!["--approval-mode", "auto"]
    );
    assert_eq!(permission_launch_args("kimi", &[], "auto").unwrap(), vec!["--yolo"]);
    assert_eq!(permission_launch_args("cursor", &[], "auto").unwrap(), vec!["--auto-review"]);
    // 没有该档：拒绝，不静默退回本机默认
    assert!(permission_launch_args("cursor", &[], "ask").is_none());
    assert!(permission_launch_args("gemini", &[], "auto").is_none());
    assert!(permission_launch_args("opencode", &[], "auto").is_none());
    // 旧的「自动改文件」档已并掉
    assert!(permission_launch_args("claude-code", &[], "auto_edit").is_none());
    // codex：ask 保留默认沙箱；auto（--approve-for-me 自带 workspace-write，与 -s 互斥）与 full 换掉 -s workspace-write
    let base: Vec<String> = vec!["-c".into(), "x=1".into(), "-s".into(), "workspace-write".into()];
    assert_eq!(
        permission_launch_args("codex", &base, "ask").unwrap(),
        vec!["-c", "x=1", "-s", "workspace-write", "-a", "on-request"]
    );
    assert_eq!(
        permission_launch_args("codex", &base, "auto").unwrap(),
        vec!["-c", "x=1", "--approve-for-me"]
    );
    assert_eq!(
        permission_launch_args("codex", &base, "full").unwrap(),
        vec!["-c", "x=1", "-a", "never", "-s", "danger-full-access"]
    );
}

#[test]
fn readonly_launch_args_per_agent() {
    // 硬保护矩阵（注册表 readonly_args）：六家有只读/计划模式参数
    assert_eq!(
        readonly_launch_args("claude-code", &[]).unwrap(),
        vec!["--permission-mode", "plan"]
    );
    assert_eq!(
        readonly_launch_args("gemini", &[]).unwrap(),
        vec!["--approval-mode", "plan"]
    );
    assert_eq!(readonly_launch_args("kimi", &[]).unwrap(), vec!["--plan"]);
    assert_eq!(readonly_launch_args("cursor", &[]).unwrap(), vec!["--plan"]);
    assert_eq!(
        readonly_launch_args("codebuddy", &[]).unwrap(),
        vec!["--permission-mode", "plan"]
    );
    // grok：dontAsk（CI 严格白名单）+ sandbox read-only（OS 级只读）
    assert_eq!(
        readonly_launch_args("grok", &[]).unwrap(),
        vec!["--permission-mode", "dontAsk", "--sandbox", "read-only"]
    );
    // codex：只读替换默认的 -s workspace-write（先剔除原沙箱参数对再追加）
    let base: Vec<String> = vec![
        "-c".into(),
        "x=1".into(),
        "-s".into(),
        "workspace-write".into(),
    ];
    assert_eq!(
        readonly_launch_args("codex", &base).unwrap(),
        vec!["-c", "x=1", "-s", "read-only"]
    );
    // 要看版本的家（qwen / opencode）：测试态查不到本机版本 = 当没有只讨论；未知 agent 也是 None
    assert!(readonly_launch_args("qwen", &[]).is_none());
    assert!(readonly_launch_args("opencode", &[]).is_none());
    assert!(readonly_launch_args("nope", &[]).is_none());
}

#[test]
fn readonly_supported_follows_min_version() {
    let qwen = agent_spec("qwen").unwrap();
    assert_eq!(qwen.readonly_args, &["--approval-mode", "plan"]);
    assert!(readonly_supported_at(qwen, Some("0.25.3")));
    assert!(readonly_supported_at(qwen, Some("Qwen Code 0.26.1")));
    assert!(!readonly_supported_at(qwen, Some("0.25.2")));
    assert!(!readonly_supported_at(qwen, None), "查不到版本不冒险");
    let oc = agent_spec("opencode").unwrap();
    assert_eq!(oc.readonly_args, &["--agent", "plan"]);
    assert!(readonly_supported_at(oc, Some("1.19.3")));
    assert!(!readonly_supported_at(oc, Some("1.18.10")));
    // 不看版本的家照旧
    assert!(readonly_supported_at(agent_spec("claude-code").unwrap(), None));
    assert!(readonly_supported_at(agent_spec("cursor").unwrap(), None));
}

#[test]
fn readonly_env_tightens_opencode_plan_agent() {
    let mut env = vec![
        ("OPENCODE_CONFIG_CONTENT".to_string(), r#"{"model":"ccode/m","agent":{"build":{"x":1}}}"#.to_string()),
        ("OPENCODE_DISABLE_AUTOUPDATE".to_string(), "1".to_string()),
    ];
    readonly_launch_env("opencode", &mut env);
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    assert_eq!(get("OPENCODE_EXPERIMENTAL_PLAN_MODE").as_deref(), Some("1"));
    let cfg: serde_json::Value = serde_json::from_str(&get("OPENCODE_CONFIG_CONTENT").unwrap()).unwrap();
    assert_eq!(cfg["model"], "ccode/m", "原有配置保留");
    assert_eq!(cfg["agent"]["build"]["x"], 1);
    let perm = &cfg["agent"]["plan"]["permission"];
    assert_eq!(perm["*"], "ask", "bash / 子任务 / MCP 一律先问");
    assert_eq!(perm["edit"]["*"], "deny");
    assert_eq!(perm["edit"]["*opencode/plans/*.md"], "allow", "方案文件能写");
    assert_eq!(perm["plan_exit"], "allow");
    // 第一个键必须是 *：OpenCode 按顺序后来者优先，先兜底再放行（serde_json 按键名排序，* 排在字母前）
    assert_eq!(perm.as_object().unwrap().keys().next().map(String::as_str), Some("*"));
    // 没有内联配置也补一份；别家不动
    let mut bare = Vec::new();
    readonly_launch_env("opencode", &mut bare);
    assert!(bare.iter().any(|(k, _)| k == "OPENCODE_CONFIG_CONTENT"));
    let mut other = vec![("A".to_string(), "1".to_string())];
    readonly_launch_env("qwen", &mut other);
    assert_eq!(other.len(), 1);
}

#[test]
fn codex_modern_drops_service_tier_and_adds_no_daemon_only_when_interactive() {
    // 2026-10-19 用户：Codex 终端 3 条 warning，其中两条是 Mesa 的参数引起的（本机 0.163 PTY 实录）
    assert_eq!(parse_cli_semver("codex-cli 0.163.0"), Some((0, 163, 0)));
    assert_eq!(parse_cli_semver("codex-cli 0.98.1-beta"), Some((0, 98, 1)));
    assert_eq!(parse_cli_semver("unknown"), None);
    let p = profile("codex", Some("https://relay.example.com/v1"));
    let set = |v| CODEX_VERSION_FOR_TEST.with(|c| c.set(v));
    // 新版：不塞 service_tier；交互式启动（prepare_launch）带 --no-daemon
    set(Some((0, 163, 0)));
    let joined = launch_plan(&p, Some("sk".into()), Some("glm-5.3")).unwrap().args.join(" ");
    assert!(!joined.contains("service_tier"));
    assert!(joined.contains(r#"web_search="disabled""#));
    assert!(!joined.contains("--no-daemon"), "launch_plan 也给 exec 用，exec 不认 --no-daemon");
    assert!(prepare_launch(&p).unwrap().contains(&"--no-daemon".to_string()));
    // 旧版与查不到版本：照旧塞 auto、不带 --no-daemon（旧版不认这个参数，带了起不来）
    for v in [Some((0, 154, 0)), None] {
        set(v);
        let joined = launch_plan(&p, Some("sk".into()), Some("glm-5.3")).unwrap().args.join(" ");
        assert!(joined.contains(r#"service_tier="auto""#));
        assert!(!prepare_launch(&p).unwrap().contains(&"--no-daemon".to_string()));
    }
    // 别家不受影响
    set(Some((0, 163, 0)));
    assert!(!prepare_launch(&profile("claude-code", Some("https://x"))).unwrap().contains(&"--no-daemon".to_string()));
    set(None);
}

#[test]
fn codex_interactive_launch_turns_off_its_own_update_prompt() {
    // 新旧版本都带（本机 0.143 / 0.165 都认这个键）；只在交互式启动的命令行上，exec 用的 launch_plan 不带
    let p = profile("codex", Some("https://relay.example.com/v1"));
    let set = |v| CODEX_VERSION_FOR_TEST.with(|c| c.set(v));
    for v in [Some((0, 165, 0)), Some((0, 143, 0)), None] {
        set(v);
        let args = prepare_launch(&p).unwrap();
        assert!(
            args.windows(2).any(|w| w[0] == "-c" && w[1] == "check_for_update_on_startup=false"),
            "{v:?}: {args:?}"
        );
        let joined = launch_plan(&p, Some("sk".into()), Some("glm-5.3")).unwrap().args.join(" ");
        assert!(!joined.contains("check_for_update_on_startup"));
    }
    assert!(!prepare_launch(&profile("claude-code", Some("https://x")))
        .unwrap()
        .iter()
        .any(|a| a.contains("check_for_update_on_startup")));
    set(None);
}

#[test]
fn codex_plan_inlines_provider_via_c_args() {
    let p = profile("codex", Some("https://relay.example.com/v1"));
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("gpt-5-codex")).unwrap();
    assert!(plan
        .env
        .contains(&("CODEX_API_KEY".into(), "sk-secret".into())));
    let joined = plan.args.join(" ");
    assert!(joined.contains(r#"model_providers.ccode.base_url="https://relay.example.com/v1""#));
    assert!(joined.contains(r#"model_providers.ccode.wire_api="responses""#));
    assert!(joined.contains(r#"model_provider="ccode""#));
    assert!(joined.contains("-m gpt-5-codex"));
    assert!(joined.contains(r#"web_search="disabled""#));
    assert!(joined.contains(r#"service_tier="auto""#));
    assert!(!joined.contains("features.apps=false"));
    assert!(joined.contains("plugins.codex-app-tools@openai-bundled.enabled=false"));
    // 窗口未确知 → 不写 -c 覆盖：gpt-5-codex 在内置表里 context=None（只标了会思考），
    // 单测里用户覆盖/网关实测/公共库均为空，declared 视图返回 None。此时写 128K 猜测
    // 会把 codex 自带 registry 里的真实窗口压低，比不覆盖更坏。
    assert!(!joined.contains("model_context_window"));
    assert!(!joined.contains("model_auto_compact_token_limit"));
    // 会话内自省：模型显示名随启动注入（配置名 · 模型），agent 可查
    assert!(plan.env.contains(&(
        "CCODE_MODEL_DISPLAY_NAME".into(),
        format!("{} · gpt-5-codex", p.name),
    )));
}

#[test]
fn codex_plan_without_model_has_no_display_name_env() {
    let p = profile("codex", Some("https://relay.example.com/v1"));
    let plan = launch_plan(&p, Some("sk-secret".into()), None).unwrap();
    assert!(!plan
        .env
        .iter()
        .any(|(k, _)| k == "CCODE_MODEL_DISPLAY_NAME"));
}

#[test]
fn codex_plan_without_base_url_has_no_provider_args() {
    let p = profile("codex", None);
    let plan = launch_plan(&p, None, None).unwrap();
    // 无 provider 参数，只有默认沙箱参数 + 沙箱内联网放开
    assert_eq!(
        plan.args,
        vec![
            "-s",
            "workspace-write",
            "-c",
            "sandbox_workspace_write.network_access=true"
        ]
    );
    assert!(plan.env.is_empty());
}

#[test]
fn gemini_plan_sets_only_present_fields() {
    let p = profile("gemini", Some("https://relay.example.com"));
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("gemini-3-pro")).unwrap();
    assert!(plan.args.is_empty());
    assert!(plan
        .env
        .contains(&("GEMINI_API_KEY".into(), "sk-secret".into())));
    assert!(plan.env.contains(&(
        "GOOGLE_GEMINI_BASE_URL".into(),
        "https://relay.example.com".into()
    )));
    assert!(plan
        .env
        .contains(&("GEMINI_MODEL".into(), "gemini-3-pro".into())));

    let bare = launch_plan(&p, None, None).unwrap();
    assert!(bare.env.contains(&(
        "GOOGLE_GEMINI_BASE_URL".into(),
        "https://relay.example.com".into()
    )));
    assert!(!bare.env.iter().any(|(k, _)| k == "GEMINI_API_KEY"));
    assert!(!bare.env.iter().any(|(k, _)| k == "GEMINI_MODEL"));
}

// ===== 官方账号模式（P1a）=====

fn official_profile(agent: &str) -> Profile {
    let mut p = profile(agent, Some("https://relay.example.com"));
    p.account_type = crate::profiles::AccountType::Official;
    p
}

#[test]
fn official_plan_injects_no_credentials_and_purges_residual_env() {
    let p = official_profile("claude-code");
    let plan = launch_plan(&p, Some("sk-secret".into()), None).unwrap();
    // 密钥/base_url 一律不注入，模型为空也不注入模型 env
    assert!(plan.env.is_empty());
    assert!(!plan.env.iter().any(|(_, v)| v.contains("sk-secret")));
    assert!(plan.env_remove.contains(&"ANTHROPIC_AUTH_TOKEN".into()));
    assert!(plan.env_remove.contains(&"ANTHROPIC_API_KEY".into()));
    assert!(plan.env_remove.contains(&"ANTHROPIC_BASE_URL".into()));
    // 磁盘 settings.json env 盖过进程 env：--settings 内联把端点 / 密钥写成空串，不含任何密钥
    assert_eq!(plan.args[0], "--settings");
    let v: serde_json::Value = serde_json::from_str(&plan.args[1]).unwrap();
    for k in ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] {
        assert_eq!(v["env"][k], "", "{k}");
    }
    assert!(!plan.args[1].contains("sk-secret"));
    // 用户全局设过的模型槽也写空；选了模型时模型键写这次的模型
    tests::TEST_CLAUDE_USER_KEYS.with(|k| *k.borrow_mut() = vec!["ANTHROPIC_DEFAULT_OPUS_MODEL".into(), "ANTHROPIC_MODEL".into()]);
    let plan = launch_plan(&p, None, Some("claude-opus-5")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1]).unwrap();
    assert_eq!(v["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"], "");
    assert_eq!(v["env"]["ANTHROPIC_MODEL"], "claude-opus-5");
    tests::TEST_CLAUDE_USER_KEYS.with(|k| k.borrow_mut().clear());
}

#[test]
fn codebuddy_and_qwen_official_override_disk_auth() {
    let plan = launch_plan(&official_profile("codebuddy"), None, None).unwrap();
    assert_eq!(plan.args[0], "--settings");
    let v: serde_json::Value = serde_json::from_str(&plan.args[1]).unwrap();
    assert_eq!(v["env"]["CODEBUDDY_BASE_URL"], "");
    assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "");
    let plan = launch_plan(&official_profile("qwen"), None, None).unwrap();
    let i = plan.args.iter().position(|a| a == "--auth-type").unwrap();
    assert_eq!(plan.args[i + 1], "qwen-oauth");
    // 这三家的磁盘残留不再挡启动
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(".codebuddy")).unwrap();
    std::fs::write(dir.join(".codebuddy/settings.json"), r#"{"env":{"CODEBUDDY_API_KEY":"sk"}}"#).unwrap();
    assert!(official_launch_conflicts(&dir, &official_profile("codebuddy")).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn codex_official_lists_cached_models_and_never_launches_without_model() {
    let cache = r#"{"models":[{"slug":"gpt-reserve","visibility":"hide","priority":4},{"slug":"gpt-5.6-terra","visibility":"list","priority":8},{"slug":"gpt-6-luna","visibility":"list","priority":5}]}"#;
    assert_eq!(codex_listed_models(cache), vec!["gpt-6-luna", "gpt-5.6-terra"]);
    assert!(codex_listed_models("not json").is_empty());
    let mut p = official_profile("codex");
    p.models.clear();
    tests::TEST_OFFICIAL_MODELS.with(|k| *k.borrow_mut() = vec!["gpt-6-luna".into()]);
    // 选的是中转模型（被滤掉）：仍带官方第一个，不让磁盘里的 deepseek 顶上
    let plan = launch_plan(&p, None, Some("deepseek-v4-flash-0731")).unwrap();
    let i = plan.args.iter().position(|a| a == "-m").unwrap();
    assert_eq!(plan.args[i + 1], "gpt-6-luna");
    tests::TEST_OFFICIAL_MODELS.with(|k| k.borrow_mut().clear());
}

#[test]
fn official_claude_blanks_relay_top_model_and_other_agents_gate_relay_models() {
    let p = official_profile("claude-code");
    tests::TEST_CLAUDE_TOP_MODEL.with(|k| *k.borrow_mut() = Some("glm-5.3[1m]".into()));
    let plan = launch_plan(&p, None, None).unwrap();
    let ov = &plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1];
    let v: serde_json::Value = serde_json::from_str(ov).unwrap();
    assert_eq!(v["model"], "", "空串 = Claude 自己的默认");
    // 用户顶层设的是官方别名：不动
    tests::TEST_CLAUDE_TOP_MODEL.with(|k| *k.borrow_mut() = Some("opus".into()));
    let plan = launch_plan(&p, None, None).unwrap();
    let ov = &plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1];
    assert!(serde_json::from_str::<serde_json::Value>(ov).unwrap().get("model").is_none());
    // 选了模型走 --model
    let plan = launch_plan(&p, None, Some("claude-opus-5")).unwrap();
    let i = plan.args.iter().position(|a| a == "--model").unwrap();
    assert_eq!(plan.args[i + 1], "claude-opus-5");
    tests::TEST_CLAUDE_TOP_MODEL.with(|k| *k.borrow_mut() = None);

    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(".grok")).unwrap();
    std::fs::create_dir_all(dir.join(".gemini")).unwrap();
    std::fs::write(dir.join(".grok/config.toml"), "[models]\ndefault = \"glm-5.3-flash\"\n").unwrap();
    let mut grok = official_profile("grok");
    grok.base_url = None;
    assert!(official_launch_conflicts(&dir, &grok)[0].contains("glm-5.3-flash"));
    std::fs::write(dir.join(".grok/config.toml"), "[models]\ndefault = \"grok-4.5\"\n").unwrap();
    assert!(official_launch_conflicts(&dir, &grok).is_empty());
    std::fs::write(dir.join(".gemini/.env"), "GEMINI_MODEL=\"relay-glm\"\n").unwrap();
    let gemini = official_profile("gemini");
    tests::TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("oauth-personal".into()));
    assert!(official_launch_conflicts(&dir, &gemini)[0].contains("relay-glm"));
    std::fs::write(dir.join(".gemini/.env"), "GEMINI_MODEL=gemini-3.5-pro\n").unwrap();
    assert!(official_launch_conflicts(&dir, &gemini).is_empty());
    tests::TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("gemini-api-key".into()));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn official_identity_reads_plan_and_email() {
    let claude = serde_json::json!({ "oauthAccount": { "emailAddress": "a@b.com", "organizationType": "claude_max" } });
    assert_eq!(claude_identity(&claude), (Some("Max".into()), Some("a@b.com".into())));
    assert_eq!(claude_identity(&serde_json::json!({})), (None, None));

    use base64::Engine as _;
    let claims = serde_json::json!({ "email": "c@d.com", "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" } });
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
    let auth = serde_json::json!({ "tokens": { "id_token": format!("h.{payload}.sig"), "access_token": "secret" } });
    assert_eq!(codex_identity(&auth), (Some("Plus".into()), Some("c@d.com".into())));
    // API Key 模式没有 id_token
    assert_eq!(codex_identity(&serde_json::json!({ "OPENAI_API_KEY": "sk-x" })), (None, None));
    assert_eq!(codex_identity(&serde_json::json!({ "tokens": { "id_token": "garbage" } })), (None, None));

    assert_eq!(cursor_email("✓ Logged in as e@f.com").as_deref(), Some("e@f.com"));
    assert_eq!(cursor_email("✓ Logged in"), None);

    let about = "About Cursor CLI\n\nCLI Version         2026.10.22\nSubscription Tier   Pro\nUser Email          e@f.com\n";
    assert_eq!(cursor_about_identity(about), (Some("Pro".into()), Some("e@f.com".into())));

    let grok_auth = serde_json::json!({ "https://auth.x.ai::u1": { "auth_mode": "oidc", "email": "g@h.com", "key": "secret" } });
    assert_eq!(grok_email(&grok_auth).as_deref(), Some("g@h.com"));
    let payload = serde_json::json!({ "settings": { "subscription_tier": null, "subscription_tier_display": "SuperGrok" } });
    let cache = serde_json::json!({ "payload": payload.to_string() });
    assert_eq!(grok_plan(&cache).as_deref(), Some("SuperGrok"));
    assert_eq!(grok_plan(&serde_json::json!({ "payload": "{}" })), None);
}

#[test]
fn codex_relay_launch_points_side_models_at_this_model() {
    let cfg: toml::Value = toml::from_str("review_model = \"gpt-6-sol\"\n[agents]\ndefault_subagent_model = \"gpt-6-luna\"\n[memories]\nextract_model = \"m1\"\n").unwrap();
    let args = codex_relay_model_args(Some(&cfg), "m1");
    assert_eq!(args, vec!["-c", "review_model=\"m1\"", "-c", "agents.default_subagent_model=\"m1\""]);
    assert!(codex_relay_model_args(None, "m1").is_empty());
    tests::TEST_CODEX_CONFIG.with(|k| *k.borrow_mut() = Some(cfg));
    let plan = launch_plan(&profile("codex", Some("https://relay.example.com/v1")), Some("sk".into()), Some("deepseek-v4")).unwrap();
    assert!(plan.args.iter().any(|a| a == "review_model=\"deepseek-v4\""));
    tests::TEST_CODEX_CONFIG.with(|k| *k.borrow_mut() = None);
}

#[test]
fn gateway_compat_reaches_claude_overlay_and_codex_provider() {
    let mut p = profile("claude-code", Some("https://gw.example.com"));
    p.request_policy.compat = crate::profiles::GatewayCompat {
        timeout_secs: Some(600),
        no_experimental_betas: true,
        no_thinking: false,
    };
    tests::TEST_CLAUDE_USER_KEYS.with(|k| *k.borrow_mut() = vec!["CLAUDE_CODE_DISABLE_THINKING".into()]);
    let plan = launch_plan(&p, Some("sk".into()), Some("m1")).unwrap();
    let path = &plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1];
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(v["env"]["API_TIMEOUT_MS"], "600000");
    assert_eq!(v["env"]["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"], "1");
    assert_eq!(v["env"]["CLAUDE_CODE_DISABLE_THINKING"], "", "上一家留下的开关写空");
    tests::TEST_CLAUDE_USER_KEYS.with(|k| k.borrow_mut().clear());
    let mut c = profile("codex", Some("https://relay.example.com/v1"));
    c.request_policy.compat.timeout_secs = Some(300);
    let plan = launch_plan(&c, Some("sk".into()), Some("m1")).unwrap();
    assert!(plan.args.iter().any(|a| a.ends_with(".stream_idle_timeout_ms=300000")));
}

#[test]
fn shared_env_goes_in_before_connection_extra_env() {
    tests::TEST_SHARED_ENV.with(|k| {
        *k.borrow_mut() = [("DISABLE_TELEMETRY", "1"), ("MY_FLAG", "shared"), ("OPENAI_API_KEY", "sk-sneak")]
            .into_iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    });
    let mut p = profile("codex", Some("https://relay.example.com/v1"));
    p.extra_env.insert("MY_FLAG".into(), "conn".into());
    let plan = launch_plan(&p, Some("sk".into()), Some("m1")).unwrap();
    let last = |k: &str| plan.env.iter().rev().find(|(x, _)| x == k).map(|(_, v)| v.clone());
    assert_eq!(last("DISABLE_TELEMETRY").as_deref(), Some("1"));
    assert_eq!(last("MY_FLAG").as_deref(), Some("conn"), "连接的附加环境变量覆盖共用的");
    assert!(!plan.env.iter().any(|(_, v)| v == "sk-sneak"), "像密钥的键读时也拦");
    let off = launch_plan(&official_profile("codex"), None, None).unwrap();
    assert!(off.env.iter().any(|(k, _)| k == "DISABLE_TELEMETRY"), "官方账号也带");
    tests::TEST_SHARED_ENV.with(|k| k.borrow_mut().clear());
    assert!(crate::settings::shared_env_rejection("GEMINI_SANDBOX").is_none());
    for bad in ["ANTHROPIC_AUTH_TOKEN", "OPENAI_BASE_URL", "GEMINI_MODEL", "HTTPS_PROXY", "PATH", "1BAD", "A-B"] {
        assert!(crate::settings::shared_env_rejection(bad).is_some(), "{bad}");
    }
}

#[test]
fn grok_official_pins_models_and_skips_relay_sections() {
    let out = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  - grok-4.5\n  * grok-4.7 (default)\n";
    assert_eq!(parse_grok_models(out), vec!["grok-4.7", "grok-4.5"]);
    let cfg = "[model.\"grok-4.5\"]\nbase_url = \"https://relay.example.com/v1\"\n[model.grok-4.7]\nbase_url = \"https://api.x.ai/v1\"\n";
    assert_eq!(grok_relay_sections_in(cfg), vec!["grok-4.5"]);
    let mut p = official_profile("grok");
    p.models.clear();
    tests::TEST_OFFICIAL_MODELS.with(|k| *k.borrow_mut() = vec!["grok-4.7".into()]);
    let plan = launch_plan(&p, None, None).unwrap();
    let overlay = plan.env.iter().find(|(k, _)| k == "GROK_CONFIG").map(|(_, v)| v.clone()).unwrap();
    let v: serde_json::Value = serde_json::from_str(&overlay).unwrap();
    assert_eq!(v["models"]["default"], "grok-4.7");
    assert_eq!(v["models"]["session_summary"], "grok-4.7");
    assert!(plan.env.iter().any(|(k, v)| k == "GROK_DEFAULT_MODEL" && v == "grok-4.7"));
    // 能定出官方模型：磁盘默认是中转模型也不拦
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(".grok")).unwrap();
    std::fs::write(dir.join(".grok/config.toml"), "[models]\ndefault = \"glm-5.3-flash\"\n").unwrap();
    assert!(official_launch_conflicts(&dir, &p).is_empty());
    tests::TEST_OFFICIAL_MODELS.with(|k| k.borrow_mut().clear());
    assert!(!official_launch_conflicts(&dir, &p).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn claude_official_models_append_additional_options() {
    let text = r#"{"additionalModelOptionsCache":[{"value":"claude-fable-5-1[1m]","label":"Fable"},{"value":"opus"},{"label":"x"}]}"#;
    let extra = claude_additional_models(text);
    assert_eq!(extra, vec!["claude-fable-5-1[1m]", "opus"]);
    assert_eq!(
        claude_official_models(extra),
        vec!["default", "fable", "opus", "sonnet", "haiku", "claude-fable-5-1[1m]"]
    );
    assert!(claude_additional_models("{}").is_empty());
}

#[test]
fn official_model_lists_parse_cursor_and_kimi() {
    let out = "Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex - Codex 5.3\nclaude-opus-5-thinking-high - Claude Opus 5 1M Thinking\n";
    assert_eq!(parse_cursor_models(out), vec!["auto", "gpt-5.3-codex", "claude-opus-5-thinking-high"]);
    let cfg = "default_model = \"kimi-code/k3\"\n[models.\"kimi-code/k2\"]\nprovider = \"managed:kimi-code\"\n[models.\"kimi-code/k3\"]\nprovider = \"managed:kimi-code\"\n[models.relay]\nprovider = \"ccode-x\"\n";
    assert_eq!(kimi_managed_aliases(cfg), vec!["kimi-code/k3", "kimi-code/k2"]);
    assert!(kimi_managed_aliases("[models.relay]\nprovider = \"x\"\n").is_empty());
}

#[test]
fn kimi_official_without_model_uses_login_alias() {
    let cfg = "default_model = \"relay-k3\"\n[models.relay-k3]\nprovider = \"ccode-x\"\n[models.\"kimi-code/k3\"]\nprovider = \"managed:kimi-code\"\n";
    assert_eq!(kimi_managed_alias(cfg).as_deref(), Some("kimi-code/k3"));
    assert_eq!(kimi_managed_alias("default_model = \"a\"\n[models.a]\nprovider = \"x\"\n"), None);
    let mut p = official_profile("kimi");
    p.models.clear();
    tests::TEST_KIMI_CONFIG.with(|k| *k.borrow_mut() = Some(cfg.into()));
    let plan = launch_plan(&p, None, None).unwrap();
    let i = plan.args.iter().position(|a| a == "-m").unwrap();
    assert_eq!(plan.args[i + 1], "kimi-code/k3");
    assert!(official_launch_conflicts(std::path::Path::new("/nonexistent"), &p).is_empty());
    // 没登录过：拦下并说清楚
    tests::TEST_KIMI_CONFIG.with(|k| *k.borrow_mut() = Some("default_model = \"a\"\n".into()));
    assert!(official_launch_conflicts(std::path::Path::new("/nonexistent"), &p)[0].contains("kimi login"));
    tests::TEST_KIMI_CONFIG.with(|k| *k.borrow_mut() = None);
}

#[test]
fn kimi_official_plan_purges_synth_channel_and_uses_model_flag() {
    let p = official_profile("kimi");
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("kimi-code/k3")).unwrap();
    // KIMI_MODEL_* 合成通道会抢 OAuth 登录态：一律 env_remove 且不注入任何 env
    assert!(plan.env.is_empty());
    for var in [
        "KIMI_MODEL_NAME",
        "KIMI_MODEL_PROVIDER_TYPE",
        "KIMI_MODEL_API_KEY",
        "KIMI_MODEL_BASE_URL",
        "KIMI_MODEL_DISPLAY_NAME",
        "KIMI_MODEL_CAPABILITIES",
        "KIMI_MODEL_MAX_CONTEXT_SIZE",
        "KIMI_API_KEY",
        "KIMI_BASE_URL",
    ] {
        assert!(plan.env_remove.contains(&var.into()), "purge 缺 {var}");
    }
    // 模型走 -m flag（与认证方式无关），密钥绝不出现
    assert_eq!(plan.args, vec!["-m", "kimi-code/k3"]);
    assert!(!plan.args.iter().any(|a| a.contains("sk-secret")));
    let blocked = launch_plan(&p, None, Some("deepseek-chat"));
    assert!(blocked.unwrap().args.is_empty());
}

#[test]
fn official_plan_injects_model_only_when_selected() {
    let p = official_profile("claude-code");
    let plan = launch_plan(&p, None, Some("claude-sonnet-4")).unwrap();
    assert_eq!(
        plan.env,
        vec![("ANTHROPIC_MODEL".to_string(), "claude-sonnet-4".to_string())]
    );
    // 模型槽位注册（ANTHROPIC_DEFAULT_*）只在 api 模式做
    assert!(!plan
        .env
        .iter()
        .any(|(k, _)| k.starts_with("ANTHROPIC_DEFAULT_")));
    // purge 列表照常
    assert!(!plan.env_remove.is_empty());
}

#[test]
fn official_plan_keeps_extra_env_as_escape_hatch() {
    let mut p = official_profile("claude-code");
    p.extra_env
        .insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
    let plan = launch_plan(&p, None, None).unwrap();
    assert_eq!(
        plan.env,
        vec![(
            "HTTPS_PROXY".to_string(),
            "http://127.0.0.1:7890".to_string()
        )]
    );
}

#[test]
fn official_codex_plan_overrides_provider_to_chatgpt_and_keeps_sandbox() {
    let p = official_profile("codex");
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("gpt-5-codex")).unwrap();
    assert!(plan.env.is_empty());
    let joined = plan.args.join(" ");
    // 不写中转 provider 块；只把本进程默认渠道切到内置 ChatGPT
    assert!(!joined.contains("model_providers"));
    assert!(joined.contains(r#"model_provider="openai""#));
    assert!(!joined.contains(r#"web_search="disabled""#));
    assert!(!joined.contains(r#"service_tier="auto""#));
    // 官方账号保留内置 codex_apps（ChatGPT 订阅的 apps 功能可用），不跟着网关关
    assert!(!joined.contains("features.apps=false"));
    assert!(!joined.contains("enable_mcp_apps"));
    assert!(joined.contains("-m gpt-5-codex"));
    // 默认沙箱与认证方式无关，官方账号同样生效；沙箱内联网同步放开
    assert!(joined.contains("-s workspace-write"));
    assert!(joined.contains("sandbox_workspace_write.network_access=true"));
    assert!(plan.env_remove.contains(&"CODEX_API_KEY".into()));
    assert!(plan.env_remove.contains(&"OPENAI_API_KEY".into()));
    // 模型为空：沙箱 + 本进程切 ChatGPT 渠道
    let bare = launch_plan(&p, None, None).unwrap();
    assert_eq!(
        bare.args,
        vec![
            "-s",
            "workspace-write",
            "-c",
            "sandbox_workspace_write.network_access=true",
            "-c",
            r#"model_provider="openai""#,
        ]
    );
}

#[test]
fn official_codex_drops_deepseek_model() {
    let p = official_profile("codex");
    let plan = launch_plan(&p, None, Some("deepseek-v4-flash-0731")).unwrap();
    assert!(
        !plan.args.iter().any(|a| a.contains("deepseek")),
        "{:?}",
        plan.args
    );
    assert!(!plan.args.iter().any(|a| a == "-m"));
    assert!(plan
        .args
        .iter()
        .any(|a| a.contains(r#"model_provider="openai""#)));
}

#[test]
fn official_gemini_plan_purges_gateway_env() {
    let p = official_profile("gemini");
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("gemini-3-pro")).unwrap();
    // base URL（GATEWAY 模式）与密钥都不注入，只注入模型
    assert_eq!(
        plan.env,
        vec![("GEMINI_MODEL".to_string(), "gemini-3-pro".to_string())]
    );
    assert!(plan.env_remove.contains(&"GEMINI_API_KEY".into()));
    assert!(plan.env_remove.contains(&"GOOGLE_GEMINI_BASE_URL".into()));
}

#[test]
fn official_plan_for_unsupported_agent_is_inert() {
    // 规格未填官方账号的 agent（opencode）：purge 为空、不注入任何凭证/模型，不崩溃
    let p = official_profile("opencode");
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("m1")).unwrap();
    assert!(plan.env.is_empty());
    assert!(plan.args.is_empty());
    assert!(plan.env_remove.is_empty());
}

// ===== 初始 prompt 注入（一键开步首条指令）=====

#[test]
fn prompt_inject_positional_and_flag_shapes() {
    // claude/codex：位置参数（单元素，pty_spawn 追加在命令行最后）
    let p = profile("claude-code", None);
    let plan =
        launch_plan_with_prompt(&p, None, Some("m1"), Some("读 TASK.md，按简报开始执行"))
            .unwrap();
    assert_eq!(plan.prompt_args, vec!["读 TASK.md，按简报开始执行"]);
    assert!(!plan.prompt_dropped);
    // 位置参数不在 plan.args 里（保证 codex 沙箱/-c、claude --session-id 都在它前面）
    assert!(!plan.args.iter().any(|a| a.contains("TASK.md")));
    // gemini/qwen：-i <prompt>（执行后继续交互）
    for agent in ["gemini", "qwen"] {
        let p = profile(agent, None);
        let plan = launch_plan_with_prompt(&p, None, None, Some("开始干活")).unwrap();
        assert_eq!(
            plan.prompt_args,
            vec!["-i", "开始干活"],
            "{agent} 应为 -i 形态"
        );
        assert!(!plan.prompt_dropped);
    }
}

#[test]
fn prompt_inject_coexists_with_codex_sandbox_args() {
    // codex 特殊变体：既有 -c/-m/沙箱参数保持原顺序，prompt 单列在 prompt_args 末尾追加
    let p = profile("codex", Some("https://relay.example.com/v1"));
    let plan = launch_plan_with_prompt(
        &p,
        Some("sk-secret".into()),
        Some("gpt-5-codex"),
        Some("开工"),
    ).unwrap();
    assert_eq!(plan.prompt_args, vec!["开工"]);
    let joined = plan.args.join(" ");
    assert!(joined.contains("-s workspace-write"));
    assert!(joined.contains(r#"model_provider="ccode""#));
    assert!(joined.contains("-m gpt-5-codex"));
    assert!(!joined.contains("开工"), "prompt 不得混入既有参数序列");
}

#[test]
fn prompt_inject_unsupported_marks_dropped() {
    // kimi 没有可用于交互新会话的初始 prompt 参数：不注入 + 标记。
    let p = profile("kimi", None);
    let plan = launch_plan_with_prompt(&p, None, None, Some("开工")).unwrap();
    assert!(plan.prompt_args.is_empty(), "kimi 不得注入");
    assert!(plan.prompt_dropped, "kimi 应置 dropped 标记");
    // OpenCode 1.18.x 的 --prompt 是交互会话可用的显式参数。
    let p = profile("opencode", None);
    let plan = launch_plan_with_prompt(&p, None, None, Some("开工")).unwrap();
    assert_eq!(plan.prompt_args, vec!["--prompt", "开工"]);
    assert!(!plan.prompt_dropped);
    // 未知 agent：无从注入，同样标记
    let p = profile("no-such-agent", None);
    let plan = launch_plan_with_prompt(&p, None, None, Some("开工")).unwrap();
    assert!(plan.prompt_dropped);
}

#[test]
fn prompt_inject_applies_to_official_account_too() {
    // api / 官方账号两种模式都注入（prompt 与认证方式无关）；purge/凭证语义不受影响
    let p = official_profile("claude-code");
    let plan = launch_plan_with_prompt(&p, Some("sk-secret".into()), None, Some("开工")).unwrap();
    assert_eq!(plan.prompt_args, vec!["开工"]);
    assert!(plan.env_remove.contains(&"ANTHROPIC_AUTH_TOKEN".into()));
    assert!(!plan.env.iter().any(|(_, v)| v.contains("sk-secret")));
}

#[test]
fn prompt_inject_skips_empty_and_blank_prompt() {
    let p = profile("claude-code", None);
    for prompt in [None, Some(""), Some("   ")] {
        let plan = launch_plan_with_prompt(&p, None, None, prompt).unwrap();
        assert!(plan.prompt_args.is_empty());
        assert!(!plan.prompt_dropped);
    }
    // 前后空白先裁剪再注入
    let plan = launch_plan_with_prompt(&p, None, None, Some("  开工  ")).unwrap();
    assert_eq!(plan.prompt_args, vec!["开工"]);
}

// ===== auth 文件只读探测（防御式）=====

fn probe_temp(name: &str, content: &str, api_key_fields: &[&str]) -> Option<AuthProbe> {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, content).unwrap();
    let probe = probe_auth_file(&path, api_key_fields);
    std::fs::remove_dir_all(&dir).ok();
    probe
}

#[test]
fn auth_probe_detects_codex_chatgpt_and_apikey_shapes() {
    // ChatGPT 账号：tokens.access_token
    let probe = probe_temp(
        "auth.json",
        r#"{"OPENAI_API_KEY":null,"tokens":{"id_token":"x","access_token":"tok","refresh_token":"r"},"last_refresh":"2026-01-01T00:00:00Z"}"#,
        &["OPENAI_API_KEY"],
    );
    assert_eq!(probe, Some(AuthProbe::Connected));
    // API key 模式：顶层 OPENAI_API_KEY（官方 --api-key 与第三方中转同一形状），
    // 不算官方账号连接
    let probe = probe_temp(
        "auth.json",
        r#"{"OPENAI_API_KEY":"sk-x","tokens":null}"#,
        &["OPENAI_API_KEY"],
    );
    assert_eq!(probe, Some(AuthProbe::ApiKeyMode));
    // 规格没声明 api_key_fields 时同样形状回落 Unrecognized（不误判已连接）
    let probe = probe_temp("auth.json", r#"{"OPENAI_API_KEY":"sk-x"}"#, &[]);
    assert_eq!(probe, Some(AuthProbe::Unrecognized));
}

#[test]
fn auth_probe_detects_nested_claude_and_flat_gemini_shapes() {
    // claude：凭证嵌套在 claudeAiOauth 下（camelCase）
    let probe = probe_temp(
        ".credentials.json",
        r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":123}}"#,
        &[],
    );
    assert_eq!(probe, Some(AuthProbe::Connected));
    // gemini：google-auth-library Credentials 扁平结构
    let probe = probe_temp(
        "oauth_creds.json",
        r#"{"access_token":"tok","refresh_token":"r","scope":"s","token_type":"Bearer","expiry_date":123}"#,
        &[],
    );
    assert_eq!(probe, Some(AuthProbe::Connected));
}

#[test]
fn auth_probe_is_defensive_on_missing_corrupt_and_unrecognized() {
    // 缺失 → None
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    assert_eq!(probe_auth_file(&dir.join("nope.json"), &[]), None);
    // 损坏（截断的 JSON）→ Corrupt，不误判为已连接
    let probe = probe_temp("auth.json", r#"{"tokens":{"access_token":"to"#, &[]);
    assert_eq!(probe, Some(AuthProbe::Corrupt));
    // 合法 JSON 但无凭证字段 → Unrecognized
    let probe = probe_temp("auth.json", r#"{"foo":"bar","n":1}"#, &[]);
    assert_eq!(probe, Some(AuthProbe::Unrecognized));
    // 空字符串凭证不算命中
    let probe = probe_temp("auth.json", r#"{"access_token":""}"#, &[]);
    assert_eq!(probe, Some(AuthProbe::Unrecognized));
}

// ===== auth 候选展开（/* 目录扫描）=====

#[test]
fn auth_candidates_expand_dir_scan_and_skip_subdirs_and_non_json() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let cred = dir.join(".kimi-code/credentials");
    std::fs::create_dir_all(cred.join("mcp")).unwrap();
    // 文件名取 Windows 也合法的形式（kimi 实际命名含冒号，仅 unix 能建）
    std::fs::write(cred.join("managed-kimi-code.json"), "{}").unwrap();
    std::fs::write(cred.join("notes.txt"), "{}").unwrap();
    std::fs::write(cred.join("mcp/server.json"), "{}").unwrap();
    let oa = crate::agent_specs::OfficialAccountSpec {
        login_cmd: &["login"],
        auth_file_paths: &[".kimi-code/credentials/*"],
        env_purge_list: &["KIMI_API_KEY"],
        conflict_probes: &[],
        detection_note: None,
        api_key_fields: &[],
        route_probe: None,
    };
    let found = auth_probe_candidates(&dir, &oa);
    // 只命中直接子级 .json：mcp/ 子目录与 .txt 都排除
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0, ".kimi-code/credentials/managed-kimi-code.json");
    assert!(found[0].1.ends_with("managed-kimi-code.json"));
    // 目录缺失 → 无候选（按未检出处理，不报错）
    std::fs::remove_dir_all(&cred).ok();
    assert!(auth_probe_candidates(&dir, &oa).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn auth_candidates_pass_plain_paths_through() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let spec = crate::agent_specs::agent_spec("qwen").unwrap();
    let oa = spec.official_account.as_ref().unwrap();
    let found = auth_probe_candidates(&dir, oa);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].0, ".qwen/oauth_creds.json");
    assert!(found[0].1.ends_with(".qwen/oauth_creds.json"));
    std::fs::remove_dir_all(&dir).ok();
}

// ===== 配置冲突探测（.env / settings.json）=====

const CONFLICT_KEYS: &[&str] = &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"];

#[test]
fn dotenv_probe_tolerates_comments_blank_lines_and_export_prefix() {
    let text = "# 注释\n\nGEMINI_API_KEY=sk-live-secret-123\nexport GOOGLE_GEMINI_BASE_URL = https://relay.example.com\n  # 缩进注释\nNOT_A_KEY=x\n";
    let hits = dotenv_conflict_keys(text, CONFLICT_KEYS);
    assert_eq!(hits, vec!["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"]);
    // 只报变量名，密钥值绝不进结果
    assert!(!hits.iter().any(|h| h.contains("sk-live-secret-123")));
}

#[test]
fn dotenv_probe_is_case_sensitive_and_skips_malformed_lines() {
    // 小写变体不算（env 变量名大小写敏感，CLI 不会把它读成同一变量）
    assert!(dotenv_conflict_keys("gemini_api_key=x\n", CONFLICT_KEYS).is_empty());
    // 无等号的行、空键名都不命中
    assert!(dotenv_conflict_keys("GEMINI_API_KEY\n=value\n", CONFLICT_KEYS).is_empty());
}

#[test]
fn settings_json_probe_reads_only_top_level_env_object() {
    // env 对象内命中；env 之外的同名键（如 mcpServers 里）不命中
    let text = r#"{"env":{"ANTHROPIC_API_KEY":"sk-ant-secret"},"mcpServers":{"x":{"env":{"ANTHROPIC_API_KEY":"y"}}}}"#;
    let keys = &["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];
    assert_eq!(
        settings_env_conflict_keys(text, keys),
        vec!["ANTHROPIC_API_KEY"]
    );
}

#[test]
fn settings_json_probe_is_defensive_on_non_object_corrupt_and_missing_env() {
    let keys = &["ANTHROPIC_API_KEY"];
    // env 不是对象
    assert!(settings_env_conflict_keys(r#"{"env":"ANTHROPIC_API_KEY"}"#, keys).is_empty());
    // 损坏的 JSON
    assert!(settings_env_conflict_keys(r#"{"env":{"ANTHROPIC_API_KEY":"x""#, keys).is_empty());
    // 没有 env 键
    assert!(settings_env_conflict_keys(r#"{"model":"opus"}"#, keys).is_empty());
}

#[test]
fn probe_conflicts_reports_file_and_key_only_and_skips_missing_files() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(".gemini")).unwrap();
    std::fs::write(
        dir.join(".gemini/.env"),
        "GEMINI_API_KEY=sk-super-secret-value\n",
    )
    .unwrap();
    let spec = crate::agent_specs::agent_spec("gemini").unwrap();
    let oa = spec.official_account.as_ref().unwrap();
    let conflicts = probe_conflicts(&dir, oa);
    assert_eq!(conflicts.len(), 1);
    assert!(conflicts[0].contains("~/.gemini/.env"));
    assert!(conflicts[0].contains("GEMINI_API_KEY"));
    // DTO 文案不得含密钥值
    assert!(!conflicts[0].contains("sk-super-secret-value"));
    // 文件缺失静默跳过：claude 的 settings.json 探测在该目录无文件，不产生冲突
    let claude = crate::agent_specs::agent_spec("claude-code").unwrap();
    assert!(probe_conflicts(&dir, claude.official_account.as_ref().unwrap()).is_empty());
    // codex 保守留空：永不产生冲突
    let codex = crate::agent_specs::agent_spec("codex").unwrap();
    assert!(probe_conflicts(&dir, codex.official_account.as_ref().unwrap()).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn official_launch_conflicts_block_settings_env_residuals() {
    // 官方账号启动防线：进程级盖不过的磁盘残留（Grok config.toml 的 api_key）必须拦在启动前，
    // 否则「官方账号」会话实际走 API 计费；Claude 的 settings.json env 改由 --settings 空串盖过，不再拦
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(".claude")).unwrap();
    std::fs::create_dir_all(dir.join(".grok")).unwrap();
    std::fs::write(
        dir.join(".claude/settings.json"),
        r#"{"env": {"ANTHROPIC_BASE_URL": "https://gw.example.com", "ANTHROPIC_AUTH_TOKEN": "sk-disk-secret"}}"#,
    )
    .unwrap();
    std::fs::write(dir.join(".grok/config.toml"), "api_key = \"sk-disk-secret\"\n").unwrap();
    let mut claude = profile("claude-code", None);
    claude.account_type = crate::profiles::AccountType::Official;
    assert!(official_launch_conflicts(&dir, &claude).is_empty());
    let mut grok = profile("grok", None);
    grok.account_type = crate::profiles::AccountType::Official;
    let joined = official_launch_conflicts(&dir, &grok).join("；");
    assert!(joined.contains("~/.grok/config.toml") && joined.contains("api_key"));
    assert!(!joined.contains("sk-disk-secret"), "只报变量名不读值");
    // API 连接不触发该防线（API 模式本来就注入这些变量）
    let api = profile("grok", Some("https://gw.example.com"));
    assert!(official_launch_conflicts(&dir, &api).is_empty());
    // codex 官方账号无探测项（启动用 -c model_provider 盖过）
    let mut codex = profile("codex", None);
    codex.account_type = crate::profiles::AccountType::Official;
    assert!(official_launch_conflicts(&dir, &codex).is_empty());
    // Gemini：认证方式不是 Google 账号登录就拦
    let mut gemini = profile("gemini", None);
    gemini.account_type = crate::profiles::AccountType::Official;
    assert!(official_launch_conflicts(&dir, &gemini)[0].contains("gemini-api-key"));
    tests::TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("oauth-personal".into()));
    assert!(official_launch_conflicts(&dir, &gemini).is_empty());
    tests::TEST_GEMINI_AUTH.with(|k| *k.borrow_mut() = Some("gemini-api-key".into()));
    std::fs::remove_dir_all(&dir).ok();
}

/// 全局 settings.json 里留着中转令牌时，claude auth status 会误报已登录：识别出来才换环境重问
#[test]
fn settings_relay_token_shadows_claude_login_detection() {
    assert!(settings_text_shadows_login(r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"x","ANTHROPIC_BASE_URL":"https://r"}}"#));
    assert!(settings_text_shadows_login(r#"{"env":{"ANTHROPIC_API_KEY":"x"}}"#));
    assert!(!settings_text_shadows_login(r#"{"env":{"ANTHROPIC_BASE_URL":"https://r"},"model":"m"}"#));
    assert!(!settings_text_shadows_login(r#"{"permissions":{}}"#));
    assert!(!settings_text_shadows_login("not json"));
}

#[test]
fn official_launch_conflicts_empty_when_settings_clean() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(".claude")).unwrap();
    std::fs::write(dir.join(".claude/settings.json"), r#"{"model": "opus"}"#).unwrap();
    let mut official = profile("claude-code", None);
    official.account_type = crate::profiles::AccountType::Official;
    assert!(official_launch_conflicts(&dir, &official).is_empty());
    // 文件缺失同样放行（probe 语义：缺失/不可读静默跳过）
    std::fs::remove_dir_all(&dir).ok();
    assert!(official_launch_conflicts(&dir, &official).is_empty());
}

#[test]
fn api_launch_notes_flag_disk_residuals_without_blocking() {
    // API 连接的提醒：磁盘残留会盖过本次注入——只提示，不进 ensure_launch_credentials 的
    // Err 路径（那种连接今天本来就能用，硬拦会打断既有工作流）
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(".gemini")).unwrap();
    std::fs::create_dir_all(dir.join(".claude")).unwrap();
    std::fs::write(dir.join(".gemini/.env"), "GEMINI_API_KEY=sk-disk-secret\n").unwrap();
    let api = profile("gemini", Some("https://relay.example.com"));
    let notes = api_launch_conflict_notes(&dir, &api);
    assert_eq!(notes.len(), 1);
    assert!(notes[0].contains("~/.gemini/.env"));
    assert!(notes[0].contains("GEMINI_API_KEY"));
    assert!(!notes[0].contains("sk-disk-secret"), "只报变量名不读值");
    // 提醒归提醒，凭证检查对带密钥的 API 连接照常放行
    assert!(ensure_launch_credentials(&api, Some("sk-secret")).is_ok());
    // Claude / CodeBuddy 的连接键由 --settings 覆盖层盖过，不再提醒
    std::fs::write(dir.join(".claude/settings.json"), r#"{"env": {"ANTHROPIC_AUTH_TOKEN": "sk"}}"#).unwrap();
    let claude = profile("claude-code", Some("https://open.bigmodel.cn/api/anthropic"));
    assert!(api_launch_conflict_notes(&dir, &claude).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn api_overlay_blanks_other_providers_connection_keys() {
    let p = profile("claude-code", Some("https://gw.example.com"));
    tests::TEST_CLAUDE_USER_KEYS.with(|k| {
        *k.borrow_mut() = vec![
            "ANTHROPIC_API_KEY".into(),
            "ANTHROPIC_CUSTOM_HEADERS".into(),
            "CLAUDE_CODE_USE_BEDROCK".into(),
            "AWS_PROFILE".into(),
            "DISABLE_TELEMETRY".into(),
        ]
    });
    tests::TEST_CLAUDE_TOP_KEYS.with(|k| *k.borrow_mut() = vec!["apiKeyHelper".into(), "hooks".into()]);
    let plan = launch_plan(&p, Some("sk-mesa".into()), Some("m1")).unwrap();
    let path = &plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1];
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-mesa");
    assert_eq!(v["env"]["ANTHROPIC_API_KEY"], "");
    assert_eq!(v["env"]["ANTHROPIC_CUSTOM_HEADERS"], "");
    assert_eq!(v["env"]["CLAUDE_CODE_USE_BEDROCK"], "");
    assert!(v["env"].get("AWS_PROFILE").is_none() && v["env"].get("DISABLE_TELEMETRY").is_none());
    assert_eq!(v["apiKeyHelper"], "");
    assert!(v.get("hooks").is_none());
    tests::TEST_CLAUDE_USER_KEYS.with(|k| k.borrow_mut().clear());
    tests::TEST_CLAUDE_TOP_KEYS.with(|k| k.borrow_mut().clear());

    // CodeBuddy：五个连接键都进覆盖文件，磁盘那家的盖不过来
    let p = profile("codebuddy", Some("https://gw.example.com/v1"));
    let plan = launch_plan(&p, Some("sk-mesa".into()), Some("m1")).unwrap();
    let path = &plan.args[plan.args.iter().position(|a| a == "--settings").unwrap() + 1];
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(v["env"]["CODEBUDDY_BASE_URL"], "https://gw.example.com/v1");
    assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "sk-mesa");
    assert_eq!(v["env"]["CODEBUDDY_MODEL"], "m1");
    assert_eq!(v["env"]["CODEBUDDY_AUTH_TOKEN"], "");
    assert!(!plan.args.iter().any(|a| a.contains("sk-mesa")), "密钥不进命令行");
}

#[test]
fn external_ps1_script_text_carries_no_env_or_credentials() {
    // audit P0：ps1 只含自删 + 启动命令；密钥走 start 环境块继承，不落脚本
    let text =
        external_ps1_script_text("C:\\tools\\claude.cmd", &["读 简报".into(), "it's".into()]);
    assert!(
        text.starts_with('\u{FEFF}'),
        "powershell 5.1 GBK 解码坑：BOM 不能丢"
    );
    assert!(text.contains("& 'C:\\tools\\claude.cmd'"));
    assert!(text.contains("'it''s'"), "单引号加倍转义");
    assert!(!text.contains("$env:"), "脚本不得写环境变量");
    assert!(
        !text.contains("Remove-Item Env:"),
        "env_remove 也在父进程环境块完成"
    );
}

#[test]
fn sweep_stale_external_wrappers_removes_only_old_launch_files() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let stale = dir.join("launch-old.sh");
    let fresh = dir.join("launch-fresh.sh");
    let other = dir.join("keep.txt");
    std::fs::write(&stale, "x").unwrap();
    std::fs::write(&fresh, "x").unwrap();
    std::fs::write(&other, "x").unwrap();
    let file = std::fs::File::options().write(true).open(&stale).unwrap();
    file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(600))
        .unwrap();
    drop(file);
    sweep_stale_external_wrappers(&dir);
    assert!(!stale.exists(), "超龄 launch- 文件被清扫");
    assert!(fresh.exists(), "新 wrapper 不动（终端可能还没读到）");
    assert!(other.exists(), "非 launch- 前缀不动");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn qwen_conflict_probe_flags_dotenv_residual_keys() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(".qwen")).unwrap();
    std::fs::write(
        dir.join(".qwen/.env"),
        "OPENAI_API_KEY=sk-super-secret-value\nDASHSCOPE_API_KEY=sk-other\n",
    )
    .unwrap();
    let spec = crate::agent_specs::agent_spec("qwen").unwrap();
    let oa = spec.official_account.as_ref().unwrap();
    let conflicts = probe_conflicts(&dir, oa);
    assert_eq!(conflicts.len(), 1);
    assert!(conflicts[0].contains("~/.qwen/.env"));
    assert!(conflicts[0].contains("OPENAI_API_KEY"));
    // DASHSCOPE_API_KEY 不在探测清单（是否压 OAuth 未核实，见注册表注释）
    assert!(!conflicts[0].contains("DASHSCOPE_API_KEY"));
    assert!(!conflicts[0].contains("sk-super-secret-value"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn qwen_plan_defaults_to_openai_protocol() {
    let p = profile(
        "qwen",
        Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    );
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("qwen3-coder")).unwrap();
    assert!(plan
        .env
        .contains(&("OPENAI_API_KEY".into(), "sk-secret".into())));
    assert!(plan.env.contains(&(
        "OPENAI_BASE_URL".into(),
        "https://dashscope.aliyuncs.com/compatible-mode/v1".into()
    )));
    assert!(plan
        .env
        .contains(&("OPENAI_MODEL".into(), "qwen3-coder".into())));
    assert!(!plan.env.iter().any(|(k, _)| k.starts_with("ANTHROPIC_")));
    assert_eq!(plan.args, vec!["--auth-type", "openai"]);
}

#[test]
fn codex_relay_launch_overrides_forced_chatgpt_login() {
    // forced_login_method = chatgpt 时不盖：Codex 拒绝注入的 API key 还把 auth.json 删掉（2026-11-01 实测）
    let cfg: toml::Value = toml::from_str("forced_login_method = \"chatgpt\"").unwrap();
    assert_eq!(codex_login_method_args(Some(&cfg)), ["-c", r#"forced_login_method="api""#]);
    let api: toml::Value = toml::from_str("forced_login_method = \"api\"").unwrap();
    assert!(codex_login_method_args(Some(&api)).is_empty());
    assert!(codex_login_method_args(None).is_empty());
    TEST_CODEX_CONFIG.with(|k| *k.borrow_mut() = Some(cfg));
    let plan = launch_plan(&profile("codex", Some("https://relay.example.com/v1")), Some("sk".into()), Some("m")).unwrap();
    TEST_CODEX_CONFIG.with(|k| *k.borrow_mut() = None);
    assert!(plan.args.windows(2).any(|w| w[0] == "-c" && w[1] == r#"forced_login_method="api""#));
}

#[test]
fn grok_launch_blocks_same_name_model_section_of_another_connection() {
    let dir = std::env::temp_dir().join(format!("mesa-grok-sec-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut p = profile("grok", Some("https://relay.example.com/v1"));
    p.gateway_id = Some("gw1234abcd".into());
    std::fs::write(
        dir.join("config.toml"),
        "[model.\"glm-5\"]\nbase_url = \"https://other/v1\"\napi_key = \"k\"\n\
             [model.mine]\nbase_url = \"https://relay.example.com/v1/\"\n\
             [model.wrong-gw]\nbase_url = \"https://relay.example.com/v1\"\nauth_provider = \"mesa-other123\"\n\
             [model.ok-gw]\nbase_url = \"https://relay.example.com/v1\"\nauth_provider = \"mesa-gw1234ab\"\n\
             [model.nourl]\nname = \"x\"\n",
    )
    .unwrap();
    let msg = grok_model_section_conflict(&dir, &p, "glm-5").expect("别家地址的同名段要拦");
    assert!(msg.contains("https://other/v1"));
    assert!(grok_model_section_conflict(&dir, &p, "mine").is_none(), "同一地址放行");
    assert!(grok_model_section_conflict(&dir, &p, "wrong-gw").is_some(), "同地址但取的是别的网关的钥");
    assert!(grok_model_section_conflict(&dir, &p, "ok-gw").is_none());
    assert!(grok_model_section_conflict(&dir, &p, "nourl").is_none(), "段没写地址不管");
    assert!(grok_model_section_conflict(&dir, &p, "absent").is_none());
    assert!(grok_model_section_conflict(&dir, &official_profile("grok"), "glm-5").is_none());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn grok_launch_blocks_pinned_endpoint_of_another_gateway() {
    let dir = std::env::temp_dir().join(format!("mesa-grok-ep-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = profile("grok", Some("https://relay.example.com/v1"));
    assert!(grok_endpoint_conflict(&dir, &p).is_none(), "没有配置文件不拦");
    std::fs::write(dir.join("config.toml"), "[endpoints]\nmodels_base_url = \"https://relay.example.com/v1/\"\n").unwrap();
    assert!(grok_endpoint_conflict(&dir, &p).is_none(), "同一地址不拦");
    std::fs::write(dir.join("config.toml"), "[endpoints]\nmodels_base_url = \"https://other/v1\"\n").unwrap();
    let msg = grok_endpoint_conflict(&dir, &p).expect("别家地址要拦：会带着这条连接的密钥发过去");
    assert!(msg.contains("https://other/v1"));
    assert!(grok_endpoint_conflict(&dir, &official_profile("grok")).is_none(), "官方账号不走这条");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn claude_login_expiry_note_only_in_last_ten_days() {
    let now = 1_800_000_000;
    assert_eq!(expiry_epoch_secs(&serde_json::json!((now + 3 * 86_400) * 1000)), Some(now + 3 * 86_400));
    assert_eq!(expiry_epoch_secs(&serde_json::json!("2027-01-15T00:00:00Z")), Some(1_799_971_200));
    assert_eq!(expiry_epoch_secs(&serde_json::json!(null)), None);
    assert!(login_expiry_note(Some(now + 3 * 86_400 + 60), now).unwrap().contains("还有 3 天"));
    assert!(login_expiry_note(Some(now + 3600), now).unwrap().contains("今天到期"));
    assert_eq!(login_expiry_note(Some(now + 30 * 86_400), now), None);
    assert_eq!(login_expiry_note(Some(now - 10), now), None);
    assert_eq!(login_expiry_note(None, now), None);
}

#[test]
fn qwen_effort_goes_where_each_protocol_reads_it() {
    // 2026-11-04 假网关实测（Qwen 0.26.5）：anthropic 协议只认条目 generationConfig.reasoning.effort
    //（请求里出 output_config.effort），samplingParams.reasoning_effort 被忽略；openai 协议认后者（请求里扁平 reasoning_effort）
    let mut p = profile("qwen", Some("https://relay.example.com/v1"));
    p.models = vec!["m".into()];
    p.request_policy.reasoning_effort = Some("high".into());
    let a = qwen_system_settings_body(&p, "anthropic", Some("m"), "ANTHROPIC_API_KEY", None);
    let ea = &a["modelProviders"]["anthropic"][0]["generationConfig"];
    assert_eq!(ea["reasoning"]["effort"], "high");
    assert!(ea.get("samplingParams").is_none());
    let o = qwen_system_settings_body(&p, "openai", Some("m"), "OPENAI_API_KEY", None);
    let eo = &o["modelProviders"]["openai"][0]["generationConfig"];
    assert_eq!(eo["samplingParams"]["reasoning_effort"], "high");
    assert!(eo.get("reasoning").is_none());
}

#[test]
fn qwen_plan_pins_connection_over_user_settings() {
    // 用户 settings.json 的 model.name / 同名 modelProviders 条目会盖过环境变量（2026-11-01 实测）：
    // 启动计划经系统设置覆盖层钉住本次连接，文件里只有变量名、没有密钥
    let mut p = profile("qwen", Some("https://relay.example.com/v1"));
    p.models = vec!["a".into(), "b".into()];
    p.request_policy.temperature = Some(0.3);
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("b")).unwrap();
    let path = plan
        .env
        .iter()
        .find(|(k, _)| k == "QWEN_CODE_SYSTEM_SETTINGS_PATH")
        .map(|(_, v)| v.clone())
        .expect("API 连接必须带覆盖层");
    let text = std::fs::read_to_string(&path).unwrap();
    let _ = std::fs::remove_file(&path);
    assert!(!text.contains("sk-secret"), "覆盖层不得含密钥");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["security"]["auth"]["selectedType"], "openai");
    assert_eq!(v["model"]["name"], "b");
    let entries = v["modelProviders"]["openai"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    let b = entries.iter().find(|e| e["id"] == "b").unwrap();
    assert_eq!(b["envKey"], "OPENAI_API_KEY");
    assert_eq!(b["baseUrl"], "https://relay.example.com/v1");
    assert_eq!(b["generationConfig"]["samplingParams"]["temperature"], 0.3);
    let a = entries.iter().find(|e| e["id"] == "a").unwrap();
    assert!(a.get("generationConfig").map_or(true, |g| g.get("samplingParams").is_none()), "策略只给所选模型");
}

#[test]
fn qwen_overlay_keeps_existing_system_settings() {
    let p = profile("qwen", Some("https://relay.example.com"));
    let base = serde_json::json!({"security": {"folderTrust": {"enabled": true}}, "model": {"name": "x", "maxSessionTurns": 9}, "modelProviders": {"anthropic": [{"id": "k"}]}});
    let v = qwen_system_settings_body(&p, "anthropic", Some("m"), "ANTHROPIC_API_KEY", Some(base));
    assert_eq!(v["security"]["folderTrust"]["enabled"], true, "管理员的系统设置留着");
    assert_eq!(v["security"]["auth"]["selectedType"], "anthropic");
    assert_eq!(v["model"]["name"], "m");
    assert_eq!(v["model"]["maxSessionTurns"], 9);
    assert_eq!(v["modelProviders"]["anthropic"][0]["id"], "m");
    assert_eq!(v["modelProviders"]["anthropic"][0]["envKey"], "ANTHROPIC_API_KEY");
}

#[test]
fn qwen_official_account_has_no_overlay() {
    let plan = launch_plan(&official_profile("qwen"), None, None).unwrap();
    assert!(!plan.env.iter().any(|(k, _)| k == "QWEN_CODE_SYSTEM_SETTINGS_PATH"));
}

#[test]
fn qwen_plan_anthropic_protocol() {
    let mut p = profile("qwen", Some("https://relay.example.com"));
    p.protocol = Some("anthropic".into());
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("claude-sonnet-4")).unwrap();
    assert!(plan
        .env
        .contains(&("ANTHROPIC_API_KEY".into(), "sk-secret".into())));
    assert!(plan.env.contains(&(
        "ANTHROPIC_BASE_URL".into(),
        "https://relay.example.com".into()
    )));
    assert!(plan
        .env
        .contains(&("ANTHROPIC_MODEL".into(), "claude-sonnet-4".into())));
    assert!(!plan.env.iter().any(|(k, _)| k.starts_with("OPENAI_")));
    assert_eq!(plan.args, vec!["--auth-type", "anthropic"]);
}

#[test]
fn qwen_interactive_launch_skips_update_check_others_untouched() {
    let skip = ("QWEN_CODE_SKIP_UPDATE_CHECK_ONCE".to_string(), "true".to_string());
    // 交互启动带不带首条指令都关（内嵌终端 / 外部终端都经 launch_plan_with_prompt）；官方账号同样
    for p in [profile("qwen", Some("https://relay.example.com")), official_profile("qwen")] {
        for prompt in [None, Some("开工")] {
            let plan = launch_plan_with_prompt(&p, Some("sk".into()), Some("qwen3-coder"), prompt).unwrap();
            assert!(plan.env.contains(&skip), "{prompt:?}");
        }
    }
    // 后台静默更新的家保持原样（用户拍板只关会弹进对话的）
    for agent in ["claude-code", "gemini", "kimi", "codebuddy", "cursor", "grok"] {
        let plan = launch_plan_with_prompt(&official_profile(agent), None, None, None).unwrap();
        assert!(
            !plan.env.iter().any(|(k, _)| k.contains("AUTOUPDATE") || k.contains("AUTO_UPDATE") || k.contains("SKIP_UPDATE")),
            "{agent}"
        );
    }
}

#[test]
fn opencode_plan_inlines_config_json() {
    let mut p = profile("opencode", Some("https://openrouter.ai/api/v1"));
    p.models = vec!["m1".into(), "m2".into()];
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("m2")).unwrap();
    assert!(plan
        .env
        .contains(&("OPENCODE_DISABLE_AUTOUPDATE".into(), "1".into())));
    let (k, v) = plan
        .env
        .iter()
        .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
        .expect("OPENCODE_CONFIG_CONTENT 应存在");
    assert_eq!(k, "OPENCODE_CONFIG_CONTENT");
    let config: serde_json::Value = serde_json::from_str(v).expect("应为合法 JSON");
    let ccode = &config["provider"]["ccode"];
    assert_eq!(ccode["npm"], "@ai-sdk/openai-compatible");
    assert_eq!(ccode["options"]["baseURL"], "https://openrouter.ai/api/v1");
    assert_eq!(ccode["options"]["apiKey"], "sk-secret");
    assert!(ccode["models"]["m1"].is_object());
    assert!(ccode["models"]["m2"].is_object());
    assert_eq!(config["model"], "ccode/m2");
}

#[test]
fn opencode_plan_without_model_omits_top_level_model() {
    let p = profile("opencode", None);
    let plan = launch_plan(&p, None, None).unwrap();
    let (_, v) = plan
        .env
        .iter()
        .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
        .unwrap();
    let config: serde_json::Value = serde_json::from_str(v).unwrap();
    assert!(config.get("model").is_none());
    // 没有 key/base_url 时 options 里不放这两个字段
    assert!(config["provider"]["ccode"]["options"]
        .get("apiKey")
        .is_none());
    assert!(config["provider"]["ccode"]["options"]
        .get("baseURL")
        .is_none());
}

#[test]
fn kimi_plan_sets_both_env_groups() {
    let p = profile("kimi", Some("https://api.moonshot.cn/v1"));
    let plan = launch_plan(&p, Some("sk-secret".into()), Some("kimi-k2")).unwrap();
    // 新版合成通道
    assert!(plan
        .env
        .contains(&("KIMI_MODEL_NAME".into(), "kimi-k2".into())));
    assert!(plan
        .env
        .contains(&("KIMI_MODEL_PROVIDER_TYPE".into(), "kimi".into())));
    assert!(plan
        .env
        .contains(&("KIMI_MODEL_API_KEY".into(), "sk-secret".into())));
    assert!(plan.env.contains(&(
        "KIMI_MODEL_BASE_URL".into(),
        "https://api.moonshot.cn/v1".into()
    )));
    // 旧版 Python CLI
    assert!(plan
        .env
        .contains(&("KIMI_API_KEY".into(), "sk-secret".into())));
    assert!(plan
        .env
        .contains(&("KIMI_BASE_URL".into(), "https://api.moonshot.cn/v1".into())));
    // 合成模型元数据：显示名 = profile 名 · 模型；上下文按模型映射（k2 = 128K）
    assert!(plan
        .env
        .contains(&("KIMI_MODEL_DISPLAY_NAME".into(), "测试 · kimi-k2".into())));
    assert!(plan
        .env
        .contains(&("KIMI_MODEL_MAX_CONTEXT_SIZE".into(), "131072".into())));
    // kimi 官方协议不注入 CAPABILITIES（CLI 默认 ["image_in","thinking"] 已合理）
    assert!(!plan.env.iter().any(|(k, _)| k == "KIMI_MODEL_CAPABILITIES"));
    assert_eq!(plan.args, kimi_env_model_args(kimi_variant()));
}

#[test]
fn kimi_env_channel_names_synthetic_alias_except_legacy() {
    // 续聊（-S）按会话里存的模型走，换连接要靠 -m 点名合成别名才生效
    assert_eq!(kimi_env_model_args(Some("new")), vec!["-m", "__kimi_env_model__"]);
    assert_eq!(kimi_env_model_args(None), vec!["-m", "__kimi_env_model__"]);
    assert!(kimi_env_model_args(Some("legacy")).is_empty());
}

#[test]
fn kimi_plan_thinking_model_declares_capabilities_on_compat_protocol() {
    let mut p = profile("kimi", Some("https://relay.example.com/v1"));
    p.protocol = Some("openai".into());
    let plan = launch_plan(&p, None, Some("kimi-k2-thinking")).unwrap();
    // 兼容协议通道：确知思考 → 加 thinking；视觉未确知 → 保留 env 缺省里的 image_in
    // （缺省 ["image_in","thinking"]，见 agents.rs 正文注释的二进制实证）。
    // 该数组是完备声明，未确知就保留缺省成员，不替 CLI 摘掉它。
    assert!(plan
        .env
        .contains(&("KIMI_MODEL_CAPABILITIES".into(), "tool_use,thinking,image_in".into())));
    assert!(plan.env.contains(&(
        "KIMI_MODEL_DISPLAY_NAME".into(),
        "测试 · kimi-k2-thinking".into()
    )));
}

#[test]
fn kimi_plan_plain_model_declares_capabilities_union_with_default() {
    // 非思考模型：thinking 确知为假 → 摘掉；视觉未确知 → 保留。
    // env 通道缺省是已知有限集 ["image_in","thinking"]，含 image_in 但**不含 tool_use**，
    // 而该数组是完备声明（CLI 用 some(===) 判成员），故这里写的是
    // 「缺省集去掉确知为假的成员，再加回缺省本就欠的 tool_use」——
    // 只做加法与「确知为假才摘」，估值层猜测不参与。
    let mut p = profile("kimi", Some("https://relay.example.com/v1"));
    p.protocol = Some("openai".into());
    let plan = launch_plan(&p, None, Some("deepseek-chat")).unwrap();
    assert!(plan
        .env
        .contains(&("KIMI_MODEL_CAPABILITIES".into(), "tool_use,image_in".into())));
    // 显示名照常注入；上下文窗口**不写**——deepseek-chat 在内置表里 context=None
    // （只标了不思考），单测其余三层为空。env 通道未设时 kimi 走
    // `parsePositiveInt(raw) ?? DEFAULT_MAX_CONTEXT_SIZE` 兜底，不报错，
    // 所以不写是安全的；写 128K 猜测反而会让真实窗口被按 128K 算。
    assert!(plan.env.contains(&(
        "KIMI_MODEL_DISPLAY_NAME".into(),
        "测试 · deepseek-chat".into()
    )));
    assert!(!plan
        .env
        .iter()
        .any(|(k, _)| k == "KIMI_MODEL_MAX_CONTEXT_SIZE"));
}

#[test]
fn kimi_plan_vision_model_declares_image_in_on_compat_protocol() {
    // 多模态思考模型（kimi-k3）：tool_use + thinking + image_in
    let mut p = profile("kimi", Some("https://relay.example.com/v1"));
    p.protocol = Some("openai".into());
    let plan = launch_plan(&p, None, Some("kimi-k3")).unwrap();
    assert!(plan.env.contains(&(
        "KIMI_MODEL_CAPABILITIES".into(),
        "tool_use,thinking,image_in".into()
    )));
    // 纯视觉非思考模型（gpt-4o）：tool_use + image_in，不带 thinking
    let mut p = profile("kimi", Some("https://relay.example.com/v1"));
    p.protocol = Some("openai".into());
    let plan = launch_plan(&p, None, Some("gpt-4o")).unwrap();
    assert!(plan
        .env
        .contains(&("KIMI_MODEL_CAPABILITIES".into(), "tool_use,image_in".into())));
    // kimi 官方协议通道：CLI 缺省 ["image_in","thinking"] 已合理，不注入
    let p = profile("kimi", None);
    let plan = launch_plan(&p, None, Some("kimi-k3")).unwrap();
    assert!(!plan.env.iter().any(|(k, _)| k == "KIMI_MODEL_CAPABILITIES"));
}

#[test]
fn kimi_plan_respects_protocol_for_provider_type() {
    let mut p = profile("kimi", None);
    p.protocol = Some("anthropic".into());
    let plan = launch_plan(&p, None, Some("claude-sonnet-4")).unwrap();
    assert!(plan
        .env
        .contains(&("KIMI_MODEL_PROVIDER_TYPE".into(), "anthropic".into())));
}

#[test]
fn kimi_plan_without_model_skips_synthetic_channel() {
    let p = profile("kimi", Some("https://api.moonshot.cn/v1"));
    let plan = launch_plan(&p, Some("sk-secret".into()), None).unwrap();
    assert!(!plan.env.iter().any(|(k, _)| k.starts_with("KIMI_MODEL_")));
    // 没有合成模型就不能点名它的别名
    assert!(!plan.args.iter().any(|a| a == KIMI_ENV_MODEL_ALIAS));
    // 旧版组不受模型缺失影响
    assert!(plan
        .env
        .contains(&("KIMI_API_KEY".into(), "sk-secret".into())));
    assert!(plan
        .env
        .contains(&("KIMI_BASE_URL".into(), "https://api.moonshot.cn/v1".into())));
}

#[test]
fn opencode_inject_json_registers_every_profile_model() {
    let mut p = profile("opencode", Some("https://openrouter.ai/api/v1"));
    p.models = vec!["m1".into(), "m2".into(), "m3".into()];
    let plan = launch_plan(&p, None, Some("m2")).unwrap();
    let (_, v) = plan
        .env
        .iter()
        .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
        .unwrap();
    let config: serde_json::Value = serde_json::from_str(v).unwrap();
    let models = config["provider"]["ccode"]["models"].as_object().unwrap();
    for m in ["m1", "m2", "m3"] {
        assert!(models.contains_key(m), "provider.ccode.models 缺 {m}");
        // 每个条目带显示名（配置名 · 模型）与 limit.context（注册表保守默认 128K）
        // + limit.output（opencode 1.18 起 schema 必填，缺省 8192）
        assert_eq!(
            models[m]["name"].as_str(),
            Some(format!("测试 · {m}").as_str())
        );
        assert_eq!(models[m]["limit"]["context"].as_i64(), Some(131_072));
        assert_eq!(models[m]["limit"]["output"].as_i64(), Some(8192));
    }
    // provider 级 name = profile 名（选择器不再显示内部 id "ccode"）
    assert_eq!(config["provider"]["ccode"]["name"].as_str(), Some("测试"));
    // 表外未知模型不声明 reasoning
    assert!(models["m1"].get("reasoning").is_none());
    // 视觉模型补 modalities（input 含 image）；非视觉模型不声明
    let v2 = opencode_provider_json(
        &{
            let mut p2 = profile("opencode", Some("https://openrouter.ai/api/v1"));
            p2.models = vec!["kimi-k3".into(), "deepseek-chat".into()];
            p2
        },
        None,
        None,
    );
    let models2 = v2["models"].as_object().unwrap();
    assert_eq!(
        models2["kimi-k3"]["modalities"]["input"],
        serde_json::json!(["text", "image"])
    );
    assert!(models2["deepseek-chat"].get("modalities").is_none());
}

#[test]
fn opencode_inject_marks_thinking_model_reasoning() {
    // 注册表命中思考模型 → models 条目带 reasoning: true
    let mut p = profile("opencode", Some("https://openrouter.ai/api/v1"));
    p.models = vec!["deepseek-reasoner".into()];
    let plan = launch_plan(&p, None, None).unwrap();
    let (_, v) = plan
        .env
        .iter()
        .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
        .unwrap();
    let config: serde_json::Value = serde_json::from_str(v).unwrap();
    assert_eq!(
        config["provider"]["ccode"]["models"]["deepseek-reasoner"]["reasoning"],
        true
    );
}

#[test]
fn codex_catalog_contains_every_model_with_template_shape() {
    let v = codex_catalog_json("测试", &["gpt-5-codex".into(), "gpt-5.1".into()]);
    let models = v["models"].as_array().unwrap();
    assert_eq!(models.len(), 2);
    let e = &models[0];
    assert_eq!(e["slug"], "gpt-5-codex");
    // display_name 带 profile 名（选择器不再是裸模型 id）
    assert_eq!(e["display_name"], "测试 · gpt-5-codex");
    assert_eq!(models[1]["slug"], "gpt-5.1");
    // 关键枚举拼写与打包条目一致（codex-rs models-manager/models.json）
    assert_eq!(e["shell_type"], "shell_command");
    assert_eq!(e["visibility"], "list");
    // 不写默认思考档时 Codex 按 none 发，推理模型 400
    assert_eq!(e["default_reasoning_level"], "medium");
    // freeform apply_patch 会中转被拒（cc-switch 实证）→ 不声明，走 shell 版
    assert!(e.get("apply_patch_tool_type").is_none());
    // base_instructions 用 Codex 自己的默认提示词（教模型用 apply_patch），不是一句话占位
    let bi = e["base_instructions"].as_str().unwrap();
    assert!(bi.starts_with("You are a coding agent running in the Codex CLI"));
    assert!(bi.contains("apply_patch") && !bi.contains('\r'));
    assert_eq!(bi.contains("shell: \"bash\""), cfg!(windows), "Windows 补充只在 Windows 上带");
    assert_eq!(e["truncation_policy"]["mode"], "tokens");
    assert_eq!(e["default_verbosity"], "low");
    assert_eq!(e["supported_in_api"], true);
    let efforts: Vec<&str> = e["supported_reasoning_levels"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l["effort"].as_str())
        .collect();
    assert_eq!(efforts, ["low", "medium", "high", "xhigh", "ultra", "max"]);
    // 能力字段：有效上下文 95%（自动压缩阈值）、如实声明无 search tool
    assert_eq!(e["effective_context_window_percent"], 95);
    assert_eq!(e["supports_search_tool"], false);
    assert_eq!(e["supports_reasoning_summaries"], true);
    assert_eq!(e["service_tiers"], serde_json::json!([]));
    // 窗口与图像输入都是 catalog 的**可选**字段（codex 解析器只强制
    // supports_reasoning_summaries/base_instructions）→ 未确知就不写，
    // 让 codex 用自己的默认值，而不是替它断言一个猜测值。
    // gpt-5 系在内置表里 context=None、vision=None，单测里其余三层为空 → 两个键都缺
    assert!(e.get("context_window").is_none());
    assert!(e.get("max_context_window").is_none());
    assert!(e.get("input_modalities").is_none());
    // 确知多模态且确知窗口（kimi-k3）→ 两个键都写
    let v2 = codex_catalog_json("测试", &["kimi-k3".into()]);
    assert_eq!(
        v2["models"][0]["input_modalities"],
        serde_json::json!(["text", "image"])
    );
    assert_eq!(v2["models"][0]["context_window"], serde_json::json!(1_048_576));
}

#[test]
fn codex_instructions_read_from_rollout_first_line() {
    let body = format!("You are a coding agent.\r\nUse `apply_patch`.\r\n{}", "x".repeat(3000));
    let meta = serde_json::json!({"type":"session_meta","payload":{"base_instructions":{"text": body}}});
    let text = format!("{meta}\n{{\"type\":\"turn_context\"}}\n");
    let got = codex_instructions_from_rollout(&text).unwrap();
    assert!(got.starts_with("You are a coding agent.\nUse `apply_patch`.\n"), "换行统一成 LF");
    // 首行不是 session_meta、内容太短或不像提示词：不收（不能把它缓存下来）
    assert!(codex_instructions_from_rollout("{\"type\":\"turn_context\"}\n").is_none());
    let short = serde_json::json!({"type":"session_meta","payload":{"base_instructions":{"text":"You are a coding agent."}}});
    assert!(codex_instructions_from_rollout(&short.to_string()).is_none());
    // 随包兜底本身得过同一道门
    assert!(plausible_codex_instructions(CODEX_BASE_INSTRUCTIONS));
}

/// 手动跑：真起本机 codex 取默认提示词（不联网、临时目录用完即删）。`cargo test --lib codex_instructions_extract_real -- --ignored --nocapture`
#[test]
#[ignore = "需要本机装着 codex"]
fn codex_instructions_extract_real() {
    let t = std::time::Instant::now();
    let text = extract_codex_base_instructions().expect("取不到");
    eprintln!("{} 字，用时 {:?}，开头：{}", text.chars().count(), t.elapsed(), &text[..80]);
    assert!(plausible_codex_instructions(&text));
    // 临时目录（后台重试删）几秒内清干净
    std::thread::sleep(std::time::Duration::from_secs(4));
    let tmp = crate::storage::config_root().unwrap().join("tmp");
    let left = std::fs::read_dir(&tmp)
        .map(|d| d.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("codex-instructions-")).count())
        .unwrap_or(0);
    assert_eq!(left, 0, "临时目录没删干净");
}

#[test]
fn codex_catalog_written_atomically() {
    let dir = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let path = dir.join("catalogs").join("codex-p1.json");
    write_codex_catalog_to(&path, "测试", &["m1".into()], None).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["models"][0]["slug"], "m1");
    assert_eq!(v["models"][0]["display_name"], "测试 · m1");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn codex_plan_tool_follows_instructions() {
    let on = vec!["-c".to_string(), "tools.update_plan.enabled=true".to_string()];
    let prompt = "You have access to an `update_plan` tool";
    assert_eq!(codex_plan_tool_args(prompt, true, None), on);
    // 提示词没提、旧版 Codex、用户自己配过：都不加
    assert!(codex_plan_tool_args("no plan here", true, None).is_empty());
    assert!(codex_plan_tool_args(prompt, false, None).is_empty());
    let user: toml::Value = toml::from_str("[tools.update_plan]\nenabled = false\n").unwrap();
    assert!(codex_plan_tool_args(prompt, true, Some(&user)).is_empty());
    let other: toml::Value = toml::from_str("[windows]\nsandbox = \"elevated\"\n").unwrap();
    assert_eq!(codex_plan_tool_args(prompt, true, Some(&other)), on);
    // 内嵌的默认提示词确实提到它（本机取不到时用这份）
    assert!(CODEX_BASE_INSTRUCTIONS.contains("update_plan"));
}

#[test]
fn codex_launch_skips_env_key_when_disk_block_takes_token_from_command() {
    // Codex 不许 auth 与 env_key 并存（0.166 实测整份配置加载失败）
    let cfg: toml::Value = toml::from_str(
        "[model_providers.ccode-a1b2c3d4.auth]\ncommand = \"/cfg/bin/mesa_helper\"\nargs = [\"codex-token\", \"g\"]\n",
    )
    .unwrap();
    assert!(codex_disk_provider_has_auth(Some(&cfg), "ccode-a1b2c3d4"));
    assert!(!codex_disk_provider_has_auth(Some(&cfg), "ccode-ffffffff"));
    let with = codex_inline_provider_args("https://r/v1", "CODEX_API_KEY", "ccode-a1b2c3d4", true).join(" ");
    assert!(!with.contains("env_key") && with.contains("base_url"));
    let without = codex_inline_provider_args("https://r/v1", "CODEX_API_KEY", "ccode-a1b2c3d4", false).join(" ");
    assert!(without.contains(r#"env_key="CODEX_API_KEY""#));
}

#[test]
fn codex_catalog_arg_is_toml_quoted() {
    let args = catalog_args(std::path::Path::new(
        "/Users/x/Library/Application Support/ccode/catalogs/codex-1.json",
    ));
    assert_eq!(args.len(), 2);
    assert_eq!(args[0], "-c");
    assert!(
        args[1].starts_with(r#"model_catalog_json=""#) && args[1].ends_with('"'),
        "路径必须是 TOML 字符串（带引号）: {}",
        args[1]
    );
    assert!(args[1].contains("codex-1.json"));
}

#[test]
fn codex_catalog_arg_uses_forward_slashes() {
    // TOML 基本字符串里 `\U` 是非法转义；Windows 路径必须改成正斜杠
    let args = catalog_args(std::path::Path::new(
        r"C:\Users\x\AppData\Roaming\ccode\catalogs\codex-1.json",
    ));
    assert!(!args[1].contains('\\'), "不得残留反斜杠: {}", args[1]);
    assert!(
        args[1].contains("C:/Users/x/AppData/Roaming/ccode/catalogs/codex-1.json"),
        "{}",
        args[1]
    );
}

#[test]
fn find_in_dirs_picks_first_existing_candidate() {
    let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    let d1 = base.join("d1");
    let d2 = base.join("d2");
    std::fs::create_dir_all(&d1).unwrap();
    std::fs::create_dir_all(&d2).unwrap();
    std::fs::write(d1.join("tool"), "x").unwrap();
    std::fs::write(d2.join("tool"), "x").unwrap();
    // 两个目录都有同名文件时排前的目录胜出
    assert_eq!(
        find_in_dirs("tool", &[d1.clone(), d2.clone()]),
        Some(d1.join("tool"))
    );
    // 只在后一个候选目录存在也能找到（前面的目录 miss 不阻断）
    assert_eq!(
        find_in_dirs("tool", &[base.join("nope"), d2.clone()]),
        Some(d2.join("tool"))
    );
    // 目录不存在 / 文件不存在 → None
    assert_eq!(find_in_dirs("tool", &[base.join("nope")]), None);
    assert_eq!(find_in_dirs("ghost", &[d1.clone(), d2.clone()]), None);
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn extended_path_appends_existing_candidates_in_order() {
    let p = |s: &str| PathBuf::from(s);
    let gui = std::env::join_paths([p("/usr/bin"), p("/bin"), p("/usr/local/bin")]).unwrap();
    let candidates = [p("/home/u/.local/bin"), p("/nope"), p("/opt/homebrew/bin"), p("/usr/local/bin")];
    let exists = |d: &Path| d != Path::new("/nope");
    let next = extended_path(Some(&gui), &candidates, exists).expect("有要补的目录");
    // 原有顺序不动，存在的候选按候选顺序追加；不存在的、已在 PATH 上的不补
    assert_eq!(
        std::env::split_paths(&next).collect::<Vec<_>>(),
        [p("/usr/bin"), p("/bin"), p("/usr/local/bin"), p("/home/u/.local/bin"), p("/opt/homebrew/bin")]
    );
    // 从终端启动（候选都已在 PATH 上）→ 不改
    assert_eq!(extended_path(Some(&next), &candidates, exists), None);
    // 没有 PATH 时只剩候选
    let only = extended_path(None, &candidates[..1], exists).unwrap();
    assert_eq!(std::env::split_paths(&only).collect::<Vec<_>>(), [p("/home/u/.local/bin")]);
}

#[cfg(windows)]
#[test]
fn find_in_dirs_matches_exe_and_cmd_shims_on_windows() {
    let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    // npm 全局包在 Windows 上是 .cmd shim：裸名找不到、带扩展名能命中
    std::fs::write(base.join("tool.cmd"), "x").unwrap();
    assert_eq!(
        find_in_dirs("tool", &[base.clone()]),
        Some(base.join("tool.cmd"))
    );
    // 裸名（shell 脚本）与 .cmd 并存时 .cmd 胜出：裸名在 Windows 上不可执行（os error 193）
    std::fs::write(base.join("tool2"), "x").unwrap();
    std::fs::write(base.join("tool2.cmd"), "x").unwrap();
    assert_eq!(
        find_in_dirs("tool2", &[base.clone()]),
        Some(base.join("tool2.cmd"))
    );
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn resolve_binary_returns_none_for_unknown_name() {
    // 名字足够独特：PATH 与各平台候选目录都不会有
    assert!(resolve_binary("ccode-no-such-binary-9f8e7d6c").is_none());
}

#[test]
fn resume_command_line_formats_per_agent() {
    // 安全字符不加引号（cc-switch 风格）；codex 的 resume 子命令在最前
    assert_eq!(
        resume_command_line("codex", "019fbd46-bdc5", "/tmp/proj").unwrap(),
        "cd /tmp/proj && codex resume 019fbd46-bdc5"
    );
    assert_eq!(
        resume_command_line("claude-code", "abc", "/tmp/proj").unwrap(),
        "cd /tmp/proj && claude -r abc"
    );
    assert_eq!(
        resume_command_line("kimi", "abc", "/tmp/proj").unwrap(),
        "cd /tmp/proj && kimi -S abc"
    );
    assert_eq!(
        resume_command_line("opencode", "abc", "/tmp/proj").unwrap(),
        "cd /tmp/proj && opencode --session abc"
    );
    assert_eq!(
        resume_command_line("codebuddy", "abc", "/tmp/proj").unwrap(),
        "cd /tmp/proj && codebuddy -r abc"
    );
    assert_eq!(
        resume_command_line("cursor", "abc", "/tmp/proj").unwrap(),
        "cd /tmp/proj && cursor-agent --resume abc"
    );
    assert_eq!(
        resume_command_line("grok", "abc", "/tmp/proj").unwrap(),
        "cd /tmp/proj && grok -r abc"
    );
    // 路径含空格/中文 → 单引号包裹
    assert_eq!(
        resume_command_line("codex", "abc", "/tmp/我的 项目").unwrap(),
        "cd '/tmp/我的 项目' && codex resume abc"
    );
    // 未知 agent 报错
    assert!(resume_command_line("no-such", "abc", "/tmp").is_err());
    // 外部拉起变体：给定绝对路径直接用
    assert_eq!(
        resume_command_line_with("kimi", "abc", "/tmp", "/Users/x/.kimi-code/bin/kimi", &[])
            .unwrap(),
        "cd /tmp && /Users/x/.kimi-code/bin/kimi -S abc"
    );
    // 绝对路径含空格 → binary 也必须 shell 转义（否则命令行在空格处断裂）
    assert_eq!(
        resume_command_line_with("kimi", "abc", "/tmp", "/Users/x/My Apps/bin/kimi", &[])
            .unwrap(),
        "cd /tmp && '/Users/x/My Apps/bin/kimi' -S abc"
    );
}

#[test]
fn resume_command_with_codex_inline_provider() {
    // codex 内联 provider 会话（rollout 记 model_provider="ccode"）外部恢复必须带 -c 定义，
    // 否则报 "Model provider `ccode` not found"；定义只含 base_url/env_key 引用，不含密钥
    let extra = resume_extra_args("codex", Some("https://relay.example.com/v1"), None);
    let cmd = resume_command_line_with("codex", "abc", "/tmp/proj", "codex", &extra).unwrap();
    // kv 值含双引号 → 单引号包裹（sh_quote_if_needed），语义无损
    assert!(
        cmd.contains(r#"-c 'model_providers.ccode.base_url="https://relay.example.com/v1"'"#)
    );
    assert!(cmd.contains(r#"-c 'model_provider="ccode"'"#));
    assert!(cmd.contains(r#"-c 'web_search="disabled"'"#));
    assert!(cmd.contains(r#"-c 'service_tier="auto"'"#));
    assert!(!cmd.contains("features.apps=false"));
    assert!(cmd.contains("plugins.codex-app-tools@openai-bundled.enabled=false"));
    assert!(cmd.starts_with("cd /tmp/proj && codex resume abc"));
    // 非 codex / 无 base_url：不追加任何定义（env 注入型 agent 裸 resume 即可）
    assert!(resume_extra_args("claude-code", Some("https://x"), None).is_empty());
    assert!(resume_extra_args("codex", None, None).is_empty());
    assert!(resume_extra_args("codex", Some("  "), None).is_empty());
    let bare = resume_command_line_with(
        "codex",
        "abc",
        "/tmp/proj",
        "codex",
        &resume_extra_args("codex", None, None),
    )
    .unwrap();
    assert_eq!(bare, "cd /tmp/proj && codex resume abc");
    let derived = resume_extra_args(
        "codex",
        Some("https://relay.example.com/v1"),
        Some("ccode-a1b2c3d4"),
    );
    let derived_cmd =
        resume_command_line_with("codex", "abc", "/tmp/proj", "codex", &derived).unwrap();
    assert!(derived_cmd.contains(
        r#"-c 'model_providers.ccode-a1b2c3d4.base_url="https://relay.example.com/v1"'"#
    ));
    assert!(derived_cmd.contains(r#"-c 'model_provider="ccode-a1b2c3d4"'"#));
    assert!(!derived_cmd.contains(r#"model_provider="ccode""#));
    // 客户端里开的（custom）/ 官方（openai）对话：只指回它自己的渠道，不带这条连接的定义（Codex 0.166 渠道校验）
    for p in ["custom", "openai"] {
        let extra = resume_extra_args("codex", Some("https://relay.example.com/v1"), Some(p));
        assert_eq!(extra, vec!["-c".to_string(), format!(r#"model_provider="{p}""#)]);
    }
    assert_eq!(resume_extra_args("codex", None, Some("custom")).len(), 2, "没有地址的连接也指回");
}

#[test]
fn codex_resume_follows_thread_provider() {
    let plan_of = || LaunchPlan {
        env: vec![("CODEX_API_KEY".into(), "sk".into()), ("CCODE_MODEL_DISPLAY_NAME".into(), "x".into())],
        args: [
            "-c", r#"model_providers.ccode-a1b2c3d4.base_url="https://r""#,
            "-c", r#"model_provider="ccode-a1b2c3d4""#,
            "-c", r#"web_search="disabled""#,
            "-c", r#"forced_login_method="api""#,
            "-m", "glm-5",
            "-c", r#"review_model="glm-5""#,
            "-c", "model_context_window=128000",
            "-c", r#"model_reasoning_effort="high""#,
            "-s", "workspace-write",
        ]
        .map(String::from)
        .to_vec(),
        env_remove: vec![],
        prompt_args: vec![],
        prompt_dropped: false,
    };
    let joined = |p: &LaunchPlan| p.args.join(" ");
    // Mesa 自己的 ccode-… 对话：不动
    let mut plan = plan_of();
    let mut extra = vec!["-c".to_string(), "model_catalog_json=/x.json".to_string()];
    assert!(!codex_resume_on_thread_provider(&mut plan, &mut extra, Some("ccode-a1b2c3d4"), Some("glm-5.3-flash")));
    assert!(joined(&plan).contains("-m glm-5") && extra.len() == 2);
    // 客户端里开的 custom 对话：指回 custom，这条连接的模型 / 上下文 / 目录 / 密钥不带，中转兼容项留着
    let mut plan = plan_of();
    let mut extra = vec!["-c".to_string(), "model_catalog_json=/x.json".to_string(), "--no-daemon".to_string()];
    assert!(codex_resume_on_thread_provider(&mut plan, &mut extra, Some("custom"), Some("deepseek-v4-flash")));
    let s = joined(&plan);
    // 模型换成对话自己最后一轮的：不带 -m 时 codex 发全局默认模型，老渠道报「模型不存在」
    assert!(s.ends_with(r#"-c model_provider="custom" -m deepseek-v4-flash"#));
    assert_eq!(s.matches("model_provider=").count(), 1);
    assert_eq!(s.matches("-m ").count(), 1, "连接自己的 -m glm-5 不该留");
    for gone in ["model_providers.", "model_context_window", "review_model", "forced_login_method"] {
        assert!(!s.contains(gone), "{gone} 不该带");
    }
    assert!(s.contains(r#"web_search="disabled""#) && s.contains("model_reasoning_effort") && s.contains("-s workspace-write"));
    assert_eq!(extra, vec!["--no-daemon".to_string()]);
    assert!(plan.env.is_empty());
    // 官方对话：走 ChatGPT 登录，撤残留密钥变量，官方的网页搜索不关
    let mut plan = plan_of();
    assert!(codex_resume_on_thread_provider(&mut plan, &mut vec![], Some("openai"), None));
    assert!(!joined(&plan).contains("web_search"));
    assert!(!joined(&plan).contains("-m "), "读不到对话模型就不带 -m，用 codex 自己的默认");
    assert!(plan.env_remove.contains(&"CODEX_API_KEY".to_string()) && plan.env_remove.contains(&"OPENAI_API_KEY".to_string()));
    // 记不到渠道、或名字不是裸键：不动
    assert!(!codex_resume_on_thread_provider(&mut plan_of(), &mut vec![], None, Some("glm-5")));
    assert!(!codex_resume_on_thread_provider(&mut plan_of(), &mut vec![], Some("a\"b"), None));
}

#[test]
fn windows_resume_line_uses_powershell_dialect() {
    // PowerShell：Set-Location + & 调用操作符；单引号包裹路径
    assert_eq!(
        windows_resume_command_line(
            "claude-code",
            "abc",
            r"C:\work\my proj",
            r"C:\tools\claude.cmd",
            &[]
        )
        .unwrap(),
        r#"Set-Location 'C:\work\my proj'; & 'C:\tools\claude.cmd' -r 'abc'"#
    );
    let line =
        windows_resume_command_line("kimi", "abc", r"C:\it's\proj", "kimi", &[]).unwrap();
    assert_eq!(line, r#"Set-Location 'C:\it''s\proj'; & 'kimi' -S 'abc'"#);
    assert!(windows_resume_command_line("no-such", "abc", r"C:\x", "x", &[]).is_err());
    let with_provider = windows_resume_command_line(
        "codex",
        "abc",
        r"C:\p",
        "codex",
        &resume_extra_args("codex", Some("https://relay.example.com/v1"), None),
    )
    .unwrap();
    assert!(with_provider.contains("-c"));
    assert!(
        with_provider.contains(r#"model_provider="ccode""#)
            || with_provider.contains("'model_provider=")
    );
}

#[test]
fn digest_command_line_formats_per_agent() {
    let prompt = "读 .ccode/handoff-x.md 接力简报，继续完成任务";
    // Positional：prompt 追加为位置参数（含空格/中文 → 单引号包裹）
    assert_eq!(
        digest_command_line_with("claude-code", "/tmp/proj", prompt, "claude").unwrap(),
        format!("cd /tmp/proj && claude '{prompt}'")
    );
    assert_eq!(
        digest_command_line_with("codex", "/tmp/proj", prompt, "codex").unwrap(),
        format!("cd /tmp/proj && codex '{prompt}'")
    );
    // Flag：-i '<prompt>'
    assert_eq!(
        digest_command_line_with("gemini", "/tmp/proj", prompt, "gemini").unwrap(),
        format!("cd /tmp/proj && gemini -i '{prompt}'")
    );
    // Unsupported（kimi）与未知 agent 报错；OpenCode 1.18.x 已支持 --prompt
    assert!(digest_command_line_with("kimi", "/tmp/proj", prompt, "kimi").is_err());
    assert_eq!(
        digest_command_line_with("opencode", "/tmp/proj", prompt, "opencode").unwrap(),
        format!("cd /tmp/proj && opencode --prompt '{prompt}'")
    );
    assert!(digest_command_line_with("no-such", "/tmp", prompt, "x").is_err());
    // cwd 与绝对路径二进制的转义（同 resume 口径）
    assert_eq!(
        digest_command_line_with(
            "qwen",
            "/tmp/我的 项目",
            prompt,
            "/Users/x/My Apps/bin/qwen"
        )
        .unwrap(),
        format!("cd '/tmp/我的 项目' && '/Users/x/My Apps/bin/qwen' -i '{prompt}'")
    );
    // prompt 内嵌单引号 → POSIX 转义
    let quoted =
        digest_command_line_with("claude-code", "/tmp", "读 it's 简报", "claude").unwrap();
    assert_eq!(quoted, "cd /tmp && claude '读 it'\\''s 简报'");
}

#[test]
fn external_plan_reuses_profile_injections_without_putting_key_in_args() {
    let mut p = profile("codex", Some("https://relay.example.com/v1"));
    p.models = vec!["deepseek-v4".into()];
    let (args, env, _) = external_launch_args(
        "codex",
        &p,
        Some("sk-secret".into()),
        Some("deepseek-v4"),
        Some("session-1"),
        None,
        None,
    )
    .unwrap();
    assert!(args.iter().any(|a| a == "model_provider=\"ccode\""));
    assert!(args.iter().any(|a| a == "deepseek-v4"));
    assert!(env
        .iter()
        .any(|(k, v)| k == "CODEX_API_KEY" && v == "sk-secret"));
    assert!(!args.iter().any(|a| a.contains("sk-secret")));
}

#[test]
fn external_launch_requires_an_explicit_profile_id() {
    assert!(require_external_profile_id(None).is_err());
    assert!(require_external_profile_id(Some("  ")).is_err());
    assert_eq!(require_external_profile_id(Some(" p1 ")).unwrap(), "p1");
}

#[test]
fn no_auth_profile_cleans_inherited_credentials() {
    let mut p = profile("codex", Some("http://127.0.0.1:11434/v1"));
    p.no_auth = true;
    let plan = launch_plan(&p, None, Some("local-model")).unwrap();
    assert!(plan.env_remove.contains(&"OPENAI_API_KEY".to_string()));
    assert!(plan.env_remove.contains(&"CODEX_API_KEY".to_string()));
}

#[test]
fn external_digest_locks_fixed_session_agents_to_a_new_session_id() {
    let mut p = profile("claude-code", Some("https://relay.example.com"));
    p.models = vec!["sonnet-custom".into()];
    let (args, _, _) = external_launch_args(
        "claude-code",
        &p,
        Some("sk-secret".into()),
        Some("sonnet-custom"),
        None,
        None,
        Some("读取简报继续"),
    )
    .unwrap();
    let pos = args.iter().position(|a| a == "--session-id").unwrap();
    assert!(!args[pos + 1].is_empty());
    assert_eq!(args.last().map(String::as_str), Some("读取简报继续"));
}

#[cfg(unix)]
#[test]
fn external_wrapper_is_private_and_contains_no_secret_in_path() {
    use std::os::unix::fs::PermissionsExt;
    let wrapper = write_external_wrapper(
        "/bin/echo",
        &["hello world".into()],
        &[("CCODE_TEST_SECRET".into(), "sk-secret".into())],
        &["NO_COLOR".into()],
    )
    .unwrap();
    let mode = std::fs::metadata(&wrapper).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert!(!wrapper.to_string_lossy().contains("sk-secret"));
    let body = std::fs::read_to_string(&wrapper).unwrap();
    assert!(body.contains("CCODE_TEST_SECRET='sk-secret'"));
    assert!(body.contains("exec '/bin/echo' 'hello world'"));
    let _ = std::fs::remove_file(wrapper);
}

#[cfg(unix)]
#[test]
fn external_wrapper_executes_and_removes_itself_before_agent_start() {
    let wrapper =
        write_external_wrapper("/usr/bin/printf", &["%s".into(), "ok".into()], &[], &[])
            .unwrap();
    let out = std::process::Command::new("/bin/sh")
        .arg(&wrapper)
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "ok");
    assert!(!wrapper.exists());
}

#[test]
fn windows_digest_line_uses_powershell_dialect() {
    let line = windows_digest_command_line(
        "claude-code",
        r"C:\work\my proj",
        "读简报",
        r"C:\tools\claude.cmd",
    )
    .unwrap();
    assert_eq!(
        line,
        r#"Set-Location 'C:\work\my proj'; & 'C:\tools\claude.cmd' '读简报'"#
    );
    let line = windows_digest_command_line("gemini", r"C:\x", "读简报", "gemini").unwrap();
    assert_eq!(line, r#"Set-Location 'C:\x'; & 'gemini' -i '读简报'"#);
    assert!(windows_digest_command_line("kimi", r"C:\x", "读简报", "kimi").is_err());
}

#[test]
fn windows_external_cmd_host_quotes_and_skips_powershell() {
    let line = windows_external_start_line_cmd(
        r"C:\work\my proj",
        r"C:\tools\claude.cmd",
        &["-r".into(), "abc".into()],
    );
    assert_eq!(
        line,
        r#"start "Mesa" /D "C:\work\my proj" cmd.exe /S /K "C:\tools\claude.cmd -r abc""#
    );
    assert!(!line.contains("powershell"));
    let spaced = windows_external_start_line_cmd(
        r"C:\work",
        r"C:\Program Files\kimi\kimi.exe",
        &["-S".into(), "sid".into()],
    );
    // /S 只剥最外一对引号：路径自己的引号完整留给内层 cmd
    assert!(spaced.ends_with(r#"cmd.exe /S /K ""C:\Program Files\kimi\kimi.exe" -S sid""#));
    assert_eq!(cmd_quote_arg(r#"a"b"#), r#""a""b""#);
    // 内联命令行上 %% 不是转义：cmd_quote_arg 不再加倍，批处理正文才加倍
    assert_eq!(cmd_quote_arg("a%PATH%"), r#""a%PATH%""#);
    assert_eq!(batch_quote_arg("a%PATH%"), r#""a%%PATH%%""#);
    assert_eq!(batch_quote_arg("l1\r\nl2\nl3"), r#""l1 l2 l3""#);
}

#[test]
fn windows_external_cmd_escapes_outer_layer_and_routes_percent_to_wrapper() {
    // 外层 cmd /C 看来内层引号里的内容是裸露的：特殊字符要加 ^，路径括号也算
    let line = windows_external_start_line_cmd(
        r"C:\w",
        r"C:\Program Files (x86)\n\codex.cmd",
        &["a&b".into(), "plain".into()],
    );
    assert!(
        line.ends_with(r#"/S /K ""C:\Program Files ^(x86^)\n\codex.cmd" "a^&b" plain""#),
        "{line}"
    );
    assert_eq!(
        windows_external_cmd_inline(r"C:\w", "codex", &["-r".into(), "id".into()]),
        Some(r#"start "Mesa" /D "C:\w" cmd.exe /S /K "codex -r id""#.to_string())
    );
    for bad in ["100%", "%PATH%", "l1\nl2", "a\rb"] {
        assert!(
            windows_external_cmd_inline(r"C:\w", "codex", &[bad.into()]).is_none(),
            "{bad:?} 必须改走批处理包装"
        );
    }
    assert!(windows_external_cmd_inline(r"C:\w", r"C:\100%\codex.cmd", &[]).is_none());
    let long = "x".repeat(WINDOWS_START_LINE_MAX);
    assert!(windows_external_cmd_inline(r"C:\w", "codex", &[long]).is_none());
    let body = external_cmd_wrapper_body(r"C:\Program Files\c.cmd", &["50% off".into()]);
    assert_eq!(
        body,
        "@echo off\r\nchcp 65001 >nul\r\n\"C:\\Program Files\\c.cmd\" \"50%% off\"\r\n"
    );
}

/// 真机：外层 cmd /C start（与生产同一 spawn_windows_start）→ 内层 cmd /S，程序在含空格和括号的
/// 目录里，参数含空格/&/|/^/括号/引号；包装器路径验证 % 原样到达。用 /B /WAIT + /C 不开可见窗口
#[cfg(windows)]
#[test]
fn windows_cmd_start_line_survives_real_cmd() {
    let root = std::env::temp_dir().join(format!("ccode-start-{}", uuid::Uuid::new_v4()));
    let bin_dir = root.join("Program Files (x86)").join("my tool");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let out = bin_dir.join("out.txt");
    let echo = bin_dir.join("echo args.cmd");
    std::fs::write(&echo, "@echo %*> \"%~dp0out.txt\"\r\n").unwrap();
    let echo_s = echo.to_string_lossy().into_owned();
    let cwd = root.to_string_lossy().into_owned();

    let args: Vec<String> = [
        "a b", "x&y", "a^b", "p|q", "(paren)", "<lt>", r#"say "hi""#, "plain",
    ]
    .map(String::from)
    .to_vec();
    let line = windows_cmd_start_line_with(&cwd, "/B /WAIT", "/C", &echo_s, &args);
    spawn_windows_start(&line, &[], &[]).unwrap();
    assert_eq!(
        std::fs::read_to_string(&out).unwrap().trim_end(),
        r#""a b" "x&y" "a^b" "p|q" "(paren)" "<lt>" "say ""hi""" plain"#
    );

    std::fs::remove_file(&out).unwrap();
    let wrapper = bin_dir.join("launch wrapper.cmd");
    let pct: Vec<String> = ["100%", "%PATH%", "l1\nl2"].map(String::from).to_vec();
    std::fs::write(&wrapper, external_cmd_wrapper_body(&echo_s, &pct)).unwrap();
    let line =
        windows_cmd_start_line_with(&cwd, "/B /WAIT", "/C", &wrapper.to_string_lossy(), &[]);
    spawn_windows_start(&line, &[], &[]).unwrap();
    assert_eq!(
        std::fs::read_to_string(&out).unwrap().trim_end(),
        r#""100%" "%PATH%" "l1 l2""#
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn windows_external_powershell_host_uses_noexit_file() {
    let line = windows_external_start_line_ps(
        r"C:\work\my proj",
        Path::new(r"C:\Users\x\AppData\Roaming\ccode\external-launch\launch-1.ps1"),
    );
    assert_eq!(
        line,
        "start \"Mesa\" /D \"C:\\work\\my proj\" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File \"C:\\Users\\x\\AppData\\Roaming\\ccode\\external-launch\\launch-1.ps1\""
    );
    assert!(line.contains("-NoExit"));
    assert!(!line.contains("cmd.exe /K"));
}

#[cfg(unix)]
#[test]
fn version_with_timeout_reads_first_line() {
    let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let bin = base.join("fake-cli");
    std::fs::write(&bin, "#!/bin/sh\necho '1.2.3 (Fake CLI)'\necho second\n").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert_eq!(
        version_with_timeout(&bin, std::time::Duration::from_secs(5)),
        Some("1.2.3 (Fake CLI)".into())
    );
    // 空输出 → None
    std::fs::write(&bin, "#!/bin/sh\nexit 0\n").unwrap();
    assert_eq!(
        version_with_timeout(&bin, std::time::Duration::from_secs(5)),
        None
    );
    std::fs::remove_dir_all(&base).ok();
}

#[cfg(unix)]
#[test]
fn gemini_version_probe_uses_mesa_scratch_home() {
    let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    // 叫 gemini 的假 CLI：版本行里回显它看到的 GEMINI_CLI_HOME
    let gemini = base.join("gemini");
    let other = base.join("qwen");
    for bin in [&gemini, &other] {
        std::fs::write(bin, "#!/bin/sh\necho \"9.9.9 ${GEMINI_CLI_HOME:-unset}\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let probe_home = std::env::temp_dir().join("ccode-gemini-probe");
    assert_eq!(
        version_with_timeout(&gemini, std::time::Duration::from_secs(5)),
        Some(format!("9.9.9 {}", probe_home.display()))
    );
    // 预放的登记文件在 Mesa 的临时目录里，Gemini 因此不再写 projects.json.*.tmp
    assert!(probe_home.join(".gemini").join("projects.json").is_file());
    // 别家 CLI 不受影响（环境里本来没有就还是没有）
    if std::env::var_os("GEMINI_CLI_HOME").is_none() {
        assert_eq!(
            version_with_timeout(&other, std::time::Duration::from_secs(5)),
            Some("9.9.9 unset".into())
        );
    }
    std::fs::remove_dir_all(&base).ok();
}

#[cfg(unix)]
#[test]
fn version_with_timeout_kills_hung_cli() {
    let base = std::env::temp_dir().join(format!("ccode-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let bin = base.join("hung-cli");
    // --version 永不返回：超时后必须杀掉并返回 None（不能无限阻塞）
    std::fs::write(&bin, "#!/bin/sh\nsleep 60\n").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert_eq!(
        version_with_timeout(&bin, std::time::Duration::from_millis(300)),
        None
    );
    // 子进程已被杀掉（防挂死兜底之外不做墙钟时序硬断言）
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn sh_quote_if_needed_escapes_single_quote() {
    assert_eq!(sh_quote_if_needed("plain-1.x"), "plain-1.x");
    assert_eq!(sh_quote_if_needed("it's"), "'it'\\''s'");
}

#[test]
fn expand_home_path_resolves_tilde_before_shell_quoting() {
    let home = crate::dirs::home_dir().unwrap();
    assert_eq!(expand_home_path("~"), home.to_string_lossy());
    assert_eq!(
        expand_home_path("~/Mesa project"),
        home.join("Mesa project").to_string_lossy()
    );
    assert_eq!(expand_home_path("/tmp/project"), "/tmp/project");
}

#[cfg(unix)]
#[test]
fn iterm_script_writes_into_the_window_it_created() {
    let cmd = r#"cd '/Users/a/Mesa project' && /bin/sh '/x/launch "q".sh'"#;
    let warm = iterm_script(cmd, true);
    assert!(warm.contains(&"set w to (create window with default profile)".to_string()));
    assert!(!warm.iter().any(|l| l.contains("current window")), "不能写进当前焦点窗口");
    let last = &warm[warm.len() - 2];
    assert!(last.starts_with("tell current session of w to write text \""));
    assert!(last.contains(r#"launch \"q\".sh"#), "双引号要转义：{last}");
    // 冷启动：等 iTerm 自己开的窗口，不另建第二个
    let cold = iterm_script(cmd, false);
    assert!(cold.iter().any(|l| l == "set w to current window"));
    assert!(cold.iter().any(|l| l.starts_with("repeat 30 times")));
}

#[cfg(unix)]
#[test]
fn external_wrapper_command_does_not_single_quote_tilde() {
    let wrapper = Path::new("/tmp/ccode-wrapper.sh");
    let cmd = external_wrapper_command("~/Mesa project", wrapper);
    assert!(cmd.starts_with("cd "));
    assert!(!cmd.contains("cd '~"));
    assert!(cmd.contains("Mesa project"));
}

#[cfg(target_os = "macos")]
#[test]
fn candidate_dirs_cover_homebrew_prefixes() {
    let dirs = crate::agent_specs::binary_candidate_dirs();
    assert!(dirs
        .iter()
        .any(|d| d == std::path::Path::new("/opt/homebrew/bin")));
    assert!(dirs
        .iter()
        .any(|d| d == std::path::Path::new("/usr/local/bin")));
    // MacTeX/TeXLive（latexmk）：GUI 短 PATH 兜底，批次 E LaTeX 编译链
    assert!(dirs
        .iter()
        .any(|d| d == std::path::Path::new("/Library/TeX/texbin")));
    // node 版本管理器（volta/mise）固定 shim 目录：GUI 短 PATH 兜底
    assert!(dirs.iter().any(|d| d.ends_with(".volta/bin")));
    assert!(dirs.iter().any(|d| d.ends_with(".local/share/mise/shims")));
}

#[cfg(target_os = "linux")]
#[test]
fn candidate_dirs_cover_node_manager_shims() {
    let dirs = crate::agent_specs::binary_candidate_dirs();
    // node 版本管理器（volta/mise）固定 shim 目录
    assert!(dirs.iter().any(|d| d.ends_with(".volta/bin")));
    assert!(dirs.iter().any(|d| d.ends_with(".local/share/mise/shims")));
}

#[cfg(windows)]
#[test]
fn paste_binary_avoids_ps1_shims() {
    // 解析得到的必须是 .exe / .cmd 绝对路径（不经 npm 的 .ps1，躲开 Restricted 执行策略）
    let node = windows_paste_binary("node");
    assert!(
        node.to_ascii_lowercase().ends_with("node.exe"),
        "{node}"
    );
    // 解析不到就退回裸名
    assert_eq!(windows_paste_binary("ccode-no-such-cli-7f3a"), "ccode-no-such-cli-7f3a");
}

#[cfg(windows)]
#[test]
fn candidate_dirs_cover_git_for_windows() {
    let dirs = crate::agent_specs::binary_candidate_dirs();
    // winget Git.Git / 官方安装器默认落点 %ProgramFiles%\Git\cmd
    assert!(dirs
        .iter()
        .any(|d| d.ends_with(std::path::Path::new("Git").join("cmd"))));
    // PowerShell 7 MSI 默认落点：Mesa 开着时装上，不重启也能认出
    assert!(dirs
        .iter()
        .any(|d| d.ends_with(std::path::Path::new("PowerShell").join("7"))));
}

#[cfg(windows)]
#[test]
fn git_bash_paths_cover_per_user_install() {
    let paths = git_bash_default_paths();
    let per_user = crate::dirs::data_local_dir().unwrap().join("Programs").join("Git").join("bin").join("bash.exe");
    assert!(paths.contains(&per_user), "「仅为我安装」的 Git Bash");
    // 全机安装排在前面
    assert!(paths.first().unwrap().ends_with(std::path::Path::new("Git").join("bin").join("bash.exe")));
    assert_ne!(paths.first(), Some(&per_user));
}

#[cfg(windows)]
#[test]
fn candidate_dirs_cover_tinytex_from_quarto() {
    let dirs = crate::agent_specs::binary_candidate_dirs();
    // quarto install tinytex 落点 %APPDATA%\TinyTeX\bin\windows（旧版 win32）
    let tinytex = std::path::Path::new("TinyTeX").join("bin");
    assert!(dirs.iter().any(|d| d.ends_with(tinytex.join("windows"))));
    assert!(dirs.iter().any(|d| d.ends_with(tinytex.join("win32"))));
}
