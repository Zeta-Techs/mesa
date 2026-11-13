use super::*;

#[test]
fn gemini_auth_only_touches_just_selected_type() {
    // 刚装好没有文件：只写认证方式
    let v: Value = serde_json::from_str(&patch_gemini_auth_only(None).unwrap()).unwrap();
    assert_eq!(v, json!({ "security": { "auth": { "selectedType": "gemini-api-key" } } }));
    // 已有设置（带注释的 JSONC）：别的字段原样保留，Google 登录改成 API Key，不写模型名单
    let existing = r#"{
          // 用户自己的
          "ui": { "theme": "GitHub" },
          "security": { "auth": { "selectedType": "oauth-personal", "useExternal": false }, "folderTrust": { "enabled": true } },
          "mcpServers": { "x": { "command": "y" } },
        }"#;
    let v: Value = serde_json::from_str(&patch_gemini_auth_only(Some(existing)).unwrap()).unwrap();
    assert_eq!(v["security"]["auth"]["selectedType"], "gemini-api-key");
    assert_eq!(v["security"]["auth"]["useExternal"], false);
    assert_eq!(v["security"]["folderTrust"]["enabled"], true);
    assert_eq!(v["ui"]["theme"], "GitHub");
    assert_eq!(v["mcpServers"]["x"]["command"], "y");
    assert!(v.get("modelConfigs").is_none() && v.get("experimental").is_none());
    // 坏文件不写
    assert!(patch_gemini_auth_only(Some("{ not json")).is_err());
    assert!(patch_gemini_auth_only(Some("[1]")).is_err());
}

/// 测试用：按旧参数拼一个 Claude 连接再走 patch_claude_settings
fn pc(
    existing: Option<&str>,
    base_url: Option<&str>,
    key: Option<&str>,
    models: &[String],
    gateway_id: Option<&str>,
    effort: Option<&str>,
) -> Result<String, String> {
    let mut p = profile("claude-code");
    p.base_url = base_url.map(String::from);
    p.models = models.to_vec();
    p.gateway_id = gateway_id.map(String::from);
    p.request_policy.reasoning_effort = effort.map(String::from);
    patch_claude_settings(existing, &p, key)
}

fn tmpdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ccode-gcfg-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn profile(agent: &str) -> Profile {
    Profile {
        id: "test".into(),
        agent: agent.into(),
        name: "测试".into(),
        account_type: Default::default(),
        no_auth: false,
        protocol: None,
        api_backend: None,
        base_url: Some("https://relay.example.com".into()),
        models: vec!["m1".into()],
        role_models: Default::default(),
        extra_env: Default::default(),
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

#[test]
fn claude_patch_preserves_unrelated_fields() {
    let existing = r#"{"env": {"OTHER": "1"}, "theme": "dark"}"#;
    let out = pc(
        Some(existing),
        Some("https://relay.example.com"),
        Some("sk-secret"),
        &["claude-sonnet-4".to_string(), "m2".to_string()],
        None,
        None,
    )
    .unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://relay.example.com");
    assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-secret");
    // 主模型写顶层 model（用户在外面 /model 能改），不写压过一切的 ANTHROPIC_MODEL
    assert_eq!(v["model"], "claude-sonnet-4");
    assert!(v["env"].get("ANTHROPIC_MODEL").is_none());
    // 模型列表注册进 /model 选择器的别名槽（显示名同启动：配置名 · 模型）
    assert_eq!(
        v["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],
        "claude-sonnet-4"
    );
    assert_eq!(v["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"], "测试 · m2");
    assert_eq!(v["env"]["OTHER"], "1");
    assert_eq!(v["theme"], "dark");
}

#[test]
fn claude_patch_writes_user_layer_and_clears_previous_connection() {
    let existing = r#"{"fallbackModel":"glm-old","effortLevel":"low","env":{"ANTHROPIC_BASE_URL":"https://old","CLAUDE_CODE_EFFORT_LEVEL":"high","MAX_THINKING_TOKENS":"0","ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION":"x"}}"#;
    let out = pc(Some(existing), None, Some("sk"), &["claude-opus-5-5".to_string()], None, Some("xhigh")).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["env"].get("ANTHROPIC_BASE_URL").is_none(), "这条连接没有地址：上一家的地址撤掉");
    assert!(v.get("fallbackModel").is_none());
    assert_eq!(v["effortLevel"], "xhigh");
    assert!(v["env"].get("CLAUDE_CODE_EFFORT_LEVEL").is_none(), "env 的思考档压过用户 /effort，不写");
    assert!(v["env"].get("MAX_THINKING_TOKENS").is_none(), "上一家写的 0 撤掉");
    assert!(v["env"].get("ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION").is_none());
    // max 不进 effortLevel（只收四档），走 env
    let out = pc(Some(&out), None, None, &["m".to_string()], None, Some("max")).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v.get("effortLevel").is_none());
    assert_eq!(v["env"]["CLAUDE_CODE_EFFORT_LEVEL"], "max");
    // 没列模型：上一家的中转模型名撤掉，官方别名留着
    let v: Value = serde_json::from_str(&pc(Some(r#"{"model":"glm-5"}"#), None, None, &[], None, None).unwrap()).unwrap();
    assert!(v.get("model").is_none());
    let v: Value = serde_json::from_str(&pc(Some(r#"{"model":"opus"}"#), None, None, &[], None, None).unwrap()).unwrap();
    assert_eq!(v["model"], "opus");
}

#[test]
fn claude_patch_replaces_model_slots_instead_of_leaving_previous() {
    let existing = r#"{
          "env": {
            "ANTHROPIC_MODEL": "old-default",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "m1",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "m1",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "m2",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "m2",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "m3",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "m3",
            "ANTHROPIC_DEFAULT_FABLE_MODEL": "m4",
            "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "m4",
            "ANTHROPIC_CUSTOM_MODEL_OPTION": "m5",
            "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "m5"
          }
        }"#;
    let out = pc(
        Some(existing),
        None,
        None,
        &["only-one".to_string()],
        None,
        None,
    )
    .unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["model"], "only-one");
    assert!(v["env"].get("ANTHROPIC_MODEL").is_none());
    // 与启动同口径：名单不够四个，空槽用主模型补（haiku 槽是后台小任务用的，留着官方名会打到中转上失败）
    for slot in ["SONNET", "OPUS", "HAIKU", "FABLE"] {
        assert_eq!(v["env"][format!("ANTHROPIC_DEFAULT_{slot}_MODEL")], "only-one", "{slot}");
    }
    assert_eq!(v["env"]["ANTHROPIC_SMALL_FAST_MODEL"], "only-one");
    assert!(v["env"].get("ANTHROPIC_CUSTOM_MODEL_OPTION").is_none());
    assert!(v["env"].get("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME").is_none());
}

#[test]
fn codex_patch_clears_effort_and_empty_catalog() {
    let existing = "model = \"old-model\"\nmodel_catalog_json = \"/old.json\"\nmodel_reasoning_effort = \"high\"\nmodel_provider = \"ccode\"\n";
    let out = patch_codex_config(
        Some(existing),
        Some("https://r.example.com/v1"),
        None,
        None,
        None,
        "sk-secret",
    )
    .unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    assert!(doc.get("model").is_none());
    assert!(doc.get("model_catalog_json").is_none());
    assert!(doc.get("model_reasoning_effort").is_none());
    assert_eq!(doc["model_provider"].as_str(), Some("custom"));
    assert_eq!(doc["web_search"].as_str(), Some("disabled"));
    // 设过的 /review、子 agent 模型改成这次的模型，没设的不建
    let out = patch_codex_config(Some("review_model = \"gpt-6-sol\"\n[agents]\nmax_threads = 4\n"), Some("https://r/v1"), Some("m1"), None, None, "sk").unwrap();
    let d: toml::Value = toml::from_str(&out).unwrap();
    assert_eq!(d["review_model"].as_str(), Some("m1"));
    assert!(d["agents"].get("default_subagent_model").is_none());
    assert_eq!(d["agents"]["max_threads"].as_integer(), Some(4));
}

#[test]
fn read_existing_stops_on_undecodable_file() {
    let dir = tmpdir("read-existing-binary");
    let path = dir.join("settings.json");
    fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
    let err = read_existing(&path).unwrap_err();
    assert!(err.contains("已停止写入"), "{err}");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn bom_prefixed_configs_are_patched_not_rejected() {
    // PowerShell 5.1 Set-Content -Encoding UTF8 / 旧记事本会给配置加 UTF-8 BOM
    let dir = tmpdir("read-existing-bom");
    let path = dir.join("settings.json");
    fs::write(&path, "\u{feff}{\"keep\": 1}").unwrap();
    let text = read_existing(&path).unwrap().unwrap();
    assert!(!text.starts_with('\u{feff}'));
    let out = pc(Some(&text), Some("https://x"), None, &[], None, None)
        .unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["keep"], 1);
    assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://x");
    fs::remove_dir_all(&dir).ok();
    // 解析函数自身也容忍（调用方没走 read_existing 时）
    let out =
        pc(Some("\u{feff}{\"keep\": 2}"), None, None, &[], None, None)
            .unwrap();
    assert!(!out.starts_with('\u{feff}'));
    let out = patch_gemini_settings(Some("\u{feff}{\"keep\": 3}"), "n", &[], None).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["keep"], 3);
    let doc = parse_toml_doc(Some("\u{feff}model = \"m\"\n")).unwrap();
    assert_eq!(doc["model"].as_str(), Some("m"));
    assert!(codex_other_switcher_marks("\u{feff}model_provider = \"custom\"\n"));
}

#[test]
fn claude_patch_from_missing_file_creates_env_only() {
    let out = pc(None, None, None, &[], None, None).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["env"].is_object());
    assert_eq!(v["env"].as_object().unwrap().len(), 0);
}

#[test]
fn claude_patch_writes_max_context_only_when_beyond_default_assumption() {
    // 注册表确知 >200K 的模型（kimi-k3 = 1M）：必须显式声明，否则 claude 按 200K 假设提前 compact；
    // AUTO_COMPACT_WINDOW 与上限同值成对写（压缩触发点跟随声明窗口）
    let out =
        pc(None, None, None, &["kimi-k3".to_string()], None, None).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "1048576");
    assert_eq!(v["env"]["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "1048576");
    // ≤200K 的模型：不写；已有旧值时两键都清掉（防上一个 profile 的 1M 残留误导）
    let out = pc(
        Some(
            r#"{"env": {"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1048576", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1048576"}}"#,
        ),
        None,
        None,
        &["claude-sonnet-4".to_string()],
        None,
        None,
    )
    .unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["env"].get("CLAUDE_CODE_MAX_CONTEXT_TOKENS").is_none());
    assert!(v["env"].get("CLAUDE_CODE_AUTO_COMPACT_WINDOW").is_none());
}

#[test]
fn codex_config_patch_preserves_other_tables() {
    // 共用渠道上一家（cc-switch / 官方形态）留下的残键；旧 ccode 块删、别的网关块留
    let existing = "[other]\nkeep = 1\n\n[model_providers.custom]\nname = \"OpenAI\"\nold = \"x\"\nrequires_openai_auth = true\nsupports_websockets = true\nenv_key = \"CODEX_API_KEY\"\nhttp_headers = { Authorization = \"Bearer sk-stale\" }\n\n[model_providers.ccode]\nname = \"Mesa\"\n\n[model_providers.ccode-abc]\nname = \"Mesa\"\n";
    let out = patch_codex_config(
        Some(existing),
        Some("https://r.example.com/v1"),
        Some("gpt-5"),
        Some(std::path::Path::new("/cfg/ccode/catalogs/codex-p1.json")),
        None,
        "sk-secret",
    )
    .unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    assert_eq!(doc["other"]["keep"].as_integer(), Some(1));
    assert!(doc["model_providers"].get("ccode").is_none());
    assert!(doc["model_providers"].get("ccode-abc").is_some());
    let ccode = &doc["model_providers"]["custom"];
    assert_eq!(ccode["name"].as_str(), Some("Mesa"));
    assert!(ccode.get("supports_websockets").is_none());
    assert_eq!(ccode["base_url"].as_str(), Some("https://r.example.com/v1"));
    // 认证走 experimental_bearer_token；旧 env_key / http_headers 清掉，不写 auth.json
    assert!(ccode.get("env_key").is_none());
    assert!(ccode.get("http_headers").is_none());
    assert_eq!(ccode["requires_openai_auth"].as_bool(), Some(false));
    assert_eq!(
        ccode["experimental_bearer_token"].as_str(),
        Some("sk-secret")
    );
    assert_eq!(ccode["wire_api"].as_str(), Some("responses"));
    // 共用渠道整块换掉，上一家的键不带过来
    assert!(ccode.get("old").is_none());
    assert_eq!(doc["model_provider"].as_str(), Some("custom"));
    assert_eq!(doc["model"].as_str(), Some("gpt-5"));
    assert_eq!(
        doc["model_catalog_json"].as_str(),
        Some("/cfg/ccode/catalogs/codex-p1.json")
    );
}

#[test]
fn gateway_compat_written_on_global_and_cleared_when_off() {
    let on = crate::profiles::GatewayCompat { timeout_secs: Some(600), no_experimental_betas: true, no_thinking: true };
    let v: Value = serde_json::from_str(&patch_claude_compat(r#"{"env":{"API_TIMEOUT_MS":"1"}}"#, &on).unwrap()).unwrap();
    assert_eq!(v["env"]["API_TIMEOUT_MS"], "600000");
    assert_eq!(v["env"]["CLAUDE_CODE_DISABLE_THINKING"], "1");
    let off = crate::profiles::GatewayCompat::default();
    let v: Value = serde_json::from_str(&patch_claude_compat(&v.to_string(), &off).unwrap()).unwrap();
    assert!(v["env"].get("CLAUDE_CODE_DISABLE_THINKING").is_none() && v["env"].get("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS").is_none());
    assert_eq!(v["env"]["API_TIMEOUT_MS"], "600000", "超时没设不动");
    let out = patch_codex_compat("model_provider = \"custom\"\n[model_providers.custom]\nname = \"Mesa\"\n", &on).unwrap();
    let d: toml::Value = toml::from_str(&out).unwrap();
    assert_eq!(d["model_providers"]["custom"]["stream_idle_timeout_ms"].as_integer(), Some(600000));
}

#[test]
fn claude_global_write_drops_other_providers_connection_keys() {
    let existing = r#"{"apiKeyHelper":"echo sk","hooks":{"Stop":[]},"env":{"ANTHROPIC_API_KEY":"sk-other","ANTHROPIC_CUSTOM_HEADERS":"X: y","CLAUDE_CODE_USE_BEDROCK":"1","CLAUDE_CODE_OAUTH_TOKEN":"oat","DISABLE_TELEMETRY":"1","AWS_PROFILE":"work"}}"#;
    let out = pc(Some(existing), Some("https://gw"), Some("sk-mesa"), &["m1".into()], None, None).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    let env = &v["env"];
    assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "sk-mesa");
    assert_eq!(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], "m1");
    for k in ["ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK"] {
        assert!(env.get(k).is_none(), "{k}");
    }
    for k in ["CLAUDE_CODE_OAUTH_TOKEN", "DISABLE_TELEMETRY", "AWS_PROFILE"] {
        assert!(env.get(k).is_some(), "{k} 留着");
    }
    assert!(v.get("apiKeyHelper").is_none());
    assert!(v.get("hooks").is_some());
    // 官方：别家的请求头、协议开关也撤
    let off: Value = serde_json::from_str(&patch_claude_settings_official(existing).unwrap()).unwrap();
    assert!(off["env"].get("ANTHROPIC_CUSTOM_HEADERS").is_none() && off["env"].get("CLAUDE_CODE_USE_BEDROCK").is_none());
    assert_eq!(off["env"]["CLAUDE_CODE_OAUTH_TOKEN"], "oat");
    assert!(off.get("apiKeyHelper").is_none());
}

#[test]
fn qwen_uses_mesa_key_env_and_writes_effort() {
    let mut p = profile("qwen");
    p.models = vec!["glm-5".into()];
    p.request_policy.reasoning_effort = Some("high".into());
    let out = patch_qwen_settings(None, Some("sk-q"), &p).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["env"][QWEN_MESA_KEY_ENV], "sk-q");
    let entry = &v["modelProviders"]["openai"][0];
    assert_eq!(entry["envKey"], QWEN_MESA_KEY_ENV, "项目 .env 的 OPENAI_API_KEY 顶不掉");
    assert_eq!(entry["generationConfig"]["samplingParams"]["reasoning_effort"], "high");
}

#[test]
fn gemini_extras_write_model_name_and_own_overrides_only() {
    let mut p = profile("gemini");
    p.models = vec!["glm-5".into(), "k3".into()];
    p.request_policy.temperature = Some(0.4);
    let existing = r#"{"modelConfigs":{"customOverrides":[
            {"match":{"model":"glm-5"},"modelConfig":{"generateContentConfig":{"temperature":1}}},
            {"match":{"model":"glm-5","overrideScope":"core"},"modelConfig":{}},
            {"match":{"model":"gemini-3-pro"},"modelConfig":{}}
        ]}}"#;
    let v: Value = serde_json::from_str(&patch_gemini_extras(existing, &p).unwrap()).unwrap();
    assert_eq!(v["model"]["name"], "glm-5");
    let arr = v["modelConfigs"]["customOverrides"].as_array().unwrap();
    // 用户的两条留着，Mesa 的旧条目换成新的（每个模型一条）
    assert_eq!(arr.len(), 4);
    assert!(arr.iter().any(|o| o["match"]["model"] == "gemini-3-pro"));
    assert!(arr.iter().any(|o| o["match"]["overrideScope"] == "core"));
    let ours: Vec<_> = arr.iter().filter(|o| o["match"].as_object().unwrap().len() == 1 && o["match"]["model"] != "gemini-3-pro").collect();
    assert_eq!(ours.len(), 2);
    assert!(ours.iter().all(|o| o["modelConfig"]["generateContentConfig"]["temperature"] == 0.4));
    // 没有策略时不新建 modelConfigs
    let mut bare = profile("gemini");
    bare.models = vec!["glm-5".into()];
    let v: Value = serde_json::from_str(&patch_gemini_extras("{}", &bare).unwrap()).unwrap();
    assert!(v.get("modelConfigs").is_none());
}

#[test]
fn codex_relay_extras_replace_stale_window_and_disable_app_tools() {
    // 未知模型：上一家留下的窗口撤掉；app-tools 插件关掉；用户别的插件不动
    let stale = "model_context_window = 1000000\nmodel_auto_compact_token_limit = 950000\n[plugins.\"other@x\"]\nenabled = true\n";
    let mut hdr = BTreeMap::new();
    hdr.insert("X-Region".to_string(), "MODEL_REGION".to_string());
    let out = patch_codex_relay_extras(stale, Some("relay-unknown-xyz"), None, &hdr).unwrap();
    let doc: toml::Value = toml::from_str(&out).unwrap();
    assert!(doc.get("model_context_window").is_none());
    assert!(doc.get("model_auto_compact_token_limit").is_none());
    assert_eq!(doc["plugins"]["codex-app-tools@openai-bundled"]["enabled"].as_bool(), Some(false));
    assert_eq!(doc["plugins"]["other@x"]["enabled"].as_bool(), Some(true));
    assert_eq!(doc["model_providers"]["custom"]["env_http_headers"]["X-Region"].as_str(), Some("MODEL_REGION"));
    // 官方切回：关掉的插件、写进去的窗口撤掉，别的插件留着
    let back = patch_codex_config_official(Some(&out)).unwrap();
    let doc: toml::Value = toml::from_str(&back).unwrap();
    assert!(doc["plugins"].get("codex-app-tools@openai-bundled").is_none());
    assert_eq!(doc["plugins"]["other@x"]["enabled"].as_bool(), Some(true));
    let only = patch_codex_config_official(Some("model_context_window = 5\n[plugins.\"codex-app-tools@openai-bundled\"]\nenabled = false\n")).unwrap();
    assert_eq!(only.trim(), "");
}

#[test]
fn codex_official_falls_back_to_builtin_openai_and_keeps_custom() {
    let existing = r#"model_provider = "custom"
model = "deepseek-v4"
model_catalog_json = "/cfg/ccode/catalogs/codex-p1.json"
model_reasoning_effort = "high"

[model_providers.custom]
name = "Mesa"
base_url = "https://relay.example.com/v1"
experimental_bearer_token = "sk-k"
requires_openai_auth = false

[model_providers.ccode-abc]
name = "Mesa"
base_url = "https://relay.example.com/v1"

[mcp_servers.x]
command = "y"

[projects."/w"]
trust_level = "trusted"
"#;
    let out = patch_codex_config_official(Some(existing)).unwrap();
    let doc: toml::Value = toml::from_str(&out).unwrap();
    // 回落内置 openai；共用渠道块原样留着，中转跑过的老对话照旧走原连接
    assert!(doc.get("model_provider").is_none());
    let side = patch_codex_config_official(Some("openai_base_url = \"https://x\"\nweb_search = \"disabled\"\nreview_model = \"deepseek-v4\"\n[agents]\ndefault_subagent_model = \"gpt-6-luna\"\n")).unwrap();
    let sd: toml::Value = toml::from_str(&side).unwrap();
    assert!(sd.get("openai_base_url").is_none() && sd.get("web_search").is_none() && sd.get("review_model").is_none());
    assert_eq!(sd["agents"]["default_subagent_model"].as_str(), Some("gpt-6-luna"), "官方模型名留着");
    let blk = &doc["model_providers"]["custom"];
    assert_eq!(blk["name"].as_str(), Some("Mesa"));
    assert_eq!(blk["base_url"].as_str(), Some("https://relay.example.com/v1"));
    assert!(doc.get("model_catalog_json").is_none());
    assert!(doc.get("model").is_none(), "中转模型名不能留给官方账号");
    assert_eq!(doc["model_reasoning_effort"].as_str(), Some("high"));
    // 别的渠道定义块留着（客户端打开旧对话要查得到），其余配置原样
    assert!(doc["model_providers"].get("ccode-abc").is_some());
    assert_eq!(doc["mcp_servers"]["x"]["command"].as_str(), Some("y"));
    assert_eq!(doc["projects"]["/w"]["trust_level"].as_str(), Some("trusted"));
    // 官方模型名保留；幂等（托盘 dry-run 靠它判当前就是官方）
    let kept = patch_codex_config_official(Some("model = \"gpt-6-astra\"\n")).unwrap();
    assert!(kept.contains("model = \"gpt-6-astra\""));
    assert_eq!(patch_codex_config_official(Some(&kept)).unwrap(), kept);
}

#[test]
fn official_plans_drop_only_api_keys_per_agent() {
    let home = tmpdir("official-all");
    let w = |rel: &str, body: &str| {
        let p = home.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    };
    let off = |agent: &str| {
        let mut p = profile(agent);
        p.account_type = crate::profiles::AccountType::Official;
        p.base_url = None;
        plan_writes(&home, &p, None, &[]).unwrap()
    };
    // 文件都不存在：无事可写
    for a in ["codex", "claude-code", "gemini", "qwen", "codebuddy", "kimi", "grok"] {
        assert!(off(a).is_empty(), "{a}");
    }
    assert!(official_global_is_patch("grok") && !official_global_is_patch("opencode"));

    w(".claude/settings.json", r#"{"theme":"dark","env":{"ANTHROPIC_BASE_URL":"https://r","ANTHROPIC_AUTH_TOKEN":"sk","ANTHROPIC_MODEL":"glm-5","ANTHROPIC_DEFAULT_OPUS_MODEL":"glm-5","CLAUDE_CODE_EFFORT_LEVEL":"high","MY_VAR":"1"}}"#);
    let v: Value = serde_json::from_str(&off("claude-code")[0].content).unwrap();
    assert_eq!(v["env"], json!({"CLAUDE_CODE_EFFORT_LEVEL":"high","MY_VAR":"1"}));
    assert_eq!(v["theme"], "dark");
    w(".claude/settings.json", r#"{"env":{"ANTHROPIC_MODEL":"opus"}}"#);
    let v: Value = serde_json::from_str(&off("claude-code")[0].content).unwrap();
    assert_eq!(v["env"]["ANTHROPIC_MODEL"], "opus");
    w(".claude/settings.json", r#"{"model":"glm-5.3[1m]","env":{}}"#);
    let v: Value = serde_json::from_str(&off("claude-code")[0].content).unwrap();
    assert!(v.get("model").is_none(), "顶层中转模型也撤");

    w(".codebuddy/settings.json", r#"{"env":{"CODEBUDDY_BASE_URL":"https://r","CODEBUDDY_API_KEY":"sk","CODEBUDDY_MODEL":"deepseek-v4"}}"#);
    let v: Value = serde_json::from_str(&off("codebuddy")[0].content).unwrap();
    assert_eq!(v["env"], json!({}));

    w(".qwen/settings.json", r#"{"security":{"auth":{"selectedType":"openai"}},"env":{"OPENAI_API_KEY":"sk","MESA_QWEN_API_KEY":"sk","OPENAI_BASE_URL":"https://r","OPENAI_MODEL":"glm-5"},"model":{"name":"glm-5"},"modelProviders":{"openai":{"models":[{"id":"glm-5"}]}}}"#);
    let v: Value = serde_json::from_str(&off("qwen")[0].content).unwrap();
    assert!(v["security"]["auth"].get("selectedType").is_none(), "Qwen OAuth 已停用：撤掉 Mesa 写的协议名，不改成 qwen-oauth");
    assert_eq!(v["env"], json!({}));
    assert!(v["model"].get("name").is_none());
    assert!(v["modelProviders"]["openai"].is_object(), "官方切回不改用户条目的写法");

    w(".gemini/.env", "GEMINI_API_KEY=sk\nGOOGLE_GEMINI_BASE_URL=https://r\nGEMINI_MODEL=glm-5\nOTHER=1\n");
    w(".gemini/settings.json", "{ // jsonc\n \"security\": {\"auth\": {\"selectedType\": \"gemini-api-key\"}}, \"model\": {\"name\": \"glm-5\"}, \"ui\": {\"theme\": \"x\"} }");
    let plans = off("gemini");
    assert_eq!(plans[0].content, "OTHER=1\n");
    let v: Value = serde_json::from_str(&plans[1].content).unwrap();
    assert!(v["security"]["auth"].get("selectedType").is_none(), "撤掉 Mesa 写的 API Key 认证，不写死 Google 登录");
    assert!(v["model"].get("name").is_none());
    // 用户自己选的（比如 Vertex）不动
    w(".gemini/settings.json", r#"{"security":{"auth":{"selectedType":"vertex-ai"}}}"#);
    let v: Value = serde_json::from_str(&off("gemini")[1].content).unwrap();
    assert_eq!(v["security"]["auth"]["selectedType"], "vertex-ai");
    w(".gemini/settings.json", "{ // jsonc\n \"security\": {\"auth\": {\"selectedType\": \"gemini-api-key\"}}, \"ui\": {\"theme\": \"x\"} }");
    let v: Value = serde_json::from_str(&off("gemini")[1].content).unwrap();
    assert_eq!(v["ui"]["theme"], "x");

    w(".kimi-code/config.toml", "default_model = \"kimi-k3\"\n[providers.ccode-x]\ntype = \"openai\"\n[models.kimi-k3]\nprovider = \"ccode-x\"\n[models.\"kimi-code/k3\"]\nprovider = \"managed:kimi-code\"\n");
    let doc: toml::Value = toml::from_str(&off("kimi")[0].content).unwrap();
    assert_eq!(doc["default_model"].as_str(), Some("kimi-code/k3"));
    assert!(doc["providers"].get("ccode-x").is_some());
    w(".kimi-code/config.toml", "default_model = \"kimi-k3\"\n[models.kimi-k3]\nprovider = \"ccode-x\"\n");
    let doc: toml::Value = toml::from_str(&off("kimi")[0].content).unwrap();
    assert!(doc.get("default_model").is_none(), "没登录过就撤默认模型");

    w(".grok/config.toml", "api_key = \"sk\"\n[endpoints]\nmodels_base_url = \"https://r/v1\"\n[models]\ndefault = \"glm-5\"\ntemperature = 0.3\n[model.glm-5]\nbase_url = \"https://r/v1\"\n[model.grok-4]\nbase_url = \"https://api.x.ai/v1\"\n[model.k3]\nname = \"中转 · k3\"\nbase_url = \"https://r/v1\"\napi_key = \"sk\"\n[model.byok]\nname = \"我的\"\nbase_url = \"https://mine/v1\"\nenv_key = \"MINE_KEY\"\n[mcp_servers.m]\ncommand = \"c\"\n");
    let doc: toml::Value = toml::from_str(&off("grok")[0].content).unwrap();
    assert!(doc.get("api_key").is_none() && doc.get("endpoints").is_none());
    assert!(doc["models"].get("default").is_none());
    assert_eq!(doc["models"]["temperature"].as_float(), Some(0.3));
    assert!(doc["model"].get("glm-5").is_none() && doc["model"].get("grok-4").is_some());
    assert!(doc["model"].get("k3").is_some(), "带自己密钥的中转段留着（Mesa 写的也留，老会话还要续）");
    assert!(doc["model"].get("byok").is_some(), "用户手写、带自己密钥的段留着");
    assert!(doc["mcp_servers"].get("m").is_some());

    // 每家补丁幂等：写完再算一遍计划，整份比对一致
    for a in ["claude-code", "gemini", "qwen", "codebuddy", "kimi", "grok"] {
        let plans = off(a);
        apply_plans(a, &home.join("bk").join(a), &home, &plans).unwrap();
        assert!(disk_equals_plans(&off(a)), "{a}");
    }
    fs::remove_dir_all(&home).ok();
}

#[test]
fn model_picked_in_the_cli_is_the_users_choice_not_drift() {
    // Codex 客户端里换模型会写回顶层 model；连接本身（地址）被改才算漂移
    let home = tmpdir("user-choice");
    let p = profile("codex");
    let key = Some("sk-secret-abcdef");
    let plans = plan_writes(&home, &p, key, &p.models).unwrap();
    apply_plans("codex", &home.join("bk"), &home, &plans).unwrap();
    let cfg = home.join(".codex/config.toml");
    let text = fs::read_to_string(&cfg).unwrap().replace("model = \"m1\"", "model = \"gpt-6-luna\"");
    assert!(text.contains("gpt-6-luna"));
    fs::write(&cfg, &text).unwrap();
    assert!(drift_files(&home, &p, key).unwrap().is_empty());
    let plans = plan_writes(&home, &p, key, &p.models).unwrap();
    assert!(plans_match_disk(&p, &plans));
    fs::write(&cfg, text.replace("https://relay.example.com", "https://other.example.com")).unwrap();
    assert!(!drift_files(&home, &p, key).unwrap().is_empty());
    fs::remove_dir_all(&home).ok();
}

#[test]
fn codex_catalog_tail_added_by_continuity_layer_is_not_drift() {
    // 续聊层在全局目录尾部追加老对话的模型：漂移比对数组整组比，不认这条就一直报「外部改过」，按 Mesa 重写也消不掉
    let home = tmpdir("catalog-tail");
    let p = profile("codex");
    let key = Some("sk-secret-abcdef");
    let plans = plan_writes(&home, &p, key, &p.models).unwrap();
    apply_plans("codex", &home.join("bk"), &home, &plans).unwrap();
    let cat = agents::codex_global_catalog_path().unwrap();
    let mut v: Value = serde_json::from_str(&fs::read_to_string(&cat).unwrap()).unwrap();
    v["models"].as_array_mut().unwrap().push(json!({"slug": "old-thread-model"}));
    fs::write(&cat, v.to_string()).unwrap();
    assert!(drift_files(&home, &p, key).unwrap().is_empty());
    let plans = plan_writes(&home, &p, key, &p.models).unwrap();
    assert!(disk_matches_plans(&plans));
    // 开头的条目被改了才算
    v["models"][0]["display_name"] = json!("别人改的");
    fs::write(&cat, v.to_string()).unwrap();
    assert!(!drift_files(&home, &p, key).unwrap().is_empty());
    fs::remove_dir_all(&home).ok();
}

#[test]
fn drift_files_reports_mesa_keys_only_for_api() {
    let home = tmpdir("drift-detail");
    let p = profile("codex");
    let key = Some("sk-secret-abcdef");
    let plans = plan_writes(&home, &p, key, &p.models).unwrap();
    apply_plans("codex", &home.join("bk"), &home, &plans).unwrap();
    assert!(drift_files(&home, &p, key).unwrap().is_empty());
    // 外部把地址改了、又加了自己的键：只报地址，密钥不出明文
    let cfg = home.join(".codex/config.toml");
    let text = fs::read_to_string(&cfg).unwrap()
        .replace("https://relay.example.com", "https://other.example.com")
        .replace("experimental_bearer_token = \"sk-secret-abcdef\"", "experimental_bearer_token = \"sk-other-999999\"");
    fs::write(&cfg, format!("approval_policy = \"never\"\n{text}")).unwrap();
    let files = drift_files(&home, &p, key).unwrap();
    let changes = &files.iter().find(|f| f.tag == "config.toml").unwrap().changes;
    assert!(changes.iter().all(|c| c.op != "add"));
    assert!(changes.iter().any(|c| c.path.ends_with("base_url") && c.after.as_deref().unwrap_or("").contains("other.example.com")));
    let json = serde_json::to_string(&files).unwrap();
    assert!(!json.contains("sk-secret-abcdef") && !json.contains("sk-other-999999"));
    // 官方：磁盘多出的键（又被写回的中转渠道）也报
    let mut off = profile("codex");
    off.account_type = crate::profiles::AccountType::Official;
    let plans = plan_writes(&home, &off, None, &[]).unwrap();
    apply_plans("codex", &home.join("bk2"), &home, &plans).unwrap();
    // 官方计划留着 Mesa 的全局目录引用（续聊层按需撤），这里换成别人的目录
    let text: String = fs::read_to_string(&cfg)
        .unwrap()
        .lines()
        .filter(|l| !l.starts_with("model_catalog_json"))
        .map(|l| format!("{l}\n"))
        .collect();
    fs::write(&cfg, format!("model_catalog_json = \"/x.json\"\n{text}")).unwrap();
    let files = drift_files(&home, &off, None).unwrap();
    assert!(files[0].changes.iter().any(|c| c.op == "add" && c.path == "model_catalog_json"));
    fs::remove_dir_all(&home).ok();
}

#[test]
fn official_match_is_exact_not_subset() {
    // 删键计划用子集比对永远为真（托盘会两项都打勾），官方必须整份比
    let home = tmpdir("official-exact");
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(home.join(".codex/config.toml"), "model_provider = \"ccode-x\"\n").unwrap();
    let mut p = profile("codex");
    p.account_type = crate::profiles::AccountType::Official;
    let plans = plan_writes(&home, &p, None, &[]).unwrap();
    assert!(!disk_equals_plans(&plans));
    apply_plans("codex", &home.join("bk"), &home, &plans).unwrap();
    assert!(disk_equals_plans(&plan_writes(&home, &p, None, &[]).unwrap()));
    fs::remove_dir_all(&home).ok();
}

#[test]
fn codex_plan_writes_does_not_touch_auth_json() {
    let home = tmpdir("codex-no-auth");
    let mut p = profile("codex");
    p.models.clear();
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(
        home.join(".codex/auth.json"),
        r#"{"tokens":{"id_token":"keep"}}"#,
    )
    .unwrap();
    let plans = plan_writes(&home, &p, Some("sk-secret"), &[]).unwrap();
    assert!(
        plans.iter().all(|w| !w.path.ends_with("auth.json")),
        "设为全局不得改 auth.json"
    );
    let cfg = plans
        .iter()
        .find(|w| w.path.ends_with("config.toml"))
        .expect("应写 config.toml");
    assert!(cfg.content.contains("experimental_bearer_token"));
    assert!(cfg.content.contains("sk-secret"));
    assert!(cfg.content.contains("model_provider"));
    assert!(!cfg.content.contains("http_headers"));
    assert_eq!(
        fs::read_to_string(home.join(".codex/auth.json")).unwrap(),
        r#"{"tokens":{"id_token":"keep"}}"#,
        "plan 阶段不得改磁盘 auth.json"
    );
    fs::remove_dir_all(&home).ok();
}

#[test]
fn codex_register_patch_writes_definition_without_switching_default() {
    // 注册到客户端：只写 provider 定义块（含块内静态认证头），顶层默认渠道与模型原样不动
    let existing = "model_provider = \"custom\"\nmodel = \"gpt-5.6-luna\"\n\n[model_providers.custom]\nbase_url = \"https://old.example.com/v1\"\n\n[model_providers.ccode-a1b2c3d4]\nrequires_openai_auth = true\nenv_key = \"CODEX_API_KEY\"\n";
    let out = patch_codex_config_register(
        Some(existing),
        Some("https://relay.example.com/v1"),
        "ccode-a1b2c3d4",
        "sk-relay-key",
    )
    .unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    assert_eq!(
        doc["model_provider"].as_str(),
        Some("custom"),
        "默认渠道不动"
    );
    assert_eq!(doc["model"].as_str(), Some("gpt-5.6-luna"), "默认模型不动");
    assert_eq!(
        doc["model_providers"]["custom"]["base_url"].as_str(),
        Some("https://old.example.com/v1"),
        "既有 provider 块不动"
    );
    let blk = &doc["model_providers"]["ccode-a1b2c3d4"];
    assert_eq!(
        blk["base_url"].as_str(),
        Some("https://relay.example.com/v1")
    );
    // 认证 = experimental_bearer_token；旧 requires_openai_auth=true / env_key 被清掉
    assert_eq!(
        blk["experimental_bearer_token"].as_str(),
        Some("sk-relay-key")
    );
    assert_eq!(blk["requires_openai_auth"].as_bool(), Some(false));
    assert!(blk.get("env_key").is_none());
    assert!(blk.get("http_headers").is_none());
    assert_eq!(blk["wire_api"].as_str(), Some("responses"));
    // 空文档也能建块；无 model_provider 的文档不会被补出开关行
    let out2 =
        patch_codex_config_register(None, Some("https://r.example.com/v1"), "ccode-x", "sk-k")
            .unwrap();
    let doc2: toml_edit::DocumentMut = out2.parse().unwrap();
    assert!(doc2.get("model_provider").is_none());
    assert_eq!(
        doc2["model_providers"]["ccode-x"]["base_url"].as_str(),
        Some("https://r.example.com/v1")
    );
}

#[test]
fn codex_other_switcher_marks_catalog_and_custom() {
    assert!(codex_other_switcher_marks(
        "model_catalog_json = \"cc-switch-model-catalog.json\"\n"
    ));
    assert!(codex_other_switcher_marks(
        "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://a\"\n"
    ));
    assert!(codex_other_switcher_marks(
        "[model_providers.custom]\nbase_url = \"https://a\"\n"
    ));
    assert!(!codex_other_switcher_marks(
        "model_provider = \"ccode-abcd\"\n[model_providers.ccode-abcd]\nbase_url = \"https://a\"\n"
    ));
    assert!(!codex_other_switcher_marks("model = \"gpt-5\"\n"));
    // 共用渠道名：Mesa 写的、ChatGPT 登录形态的都不算别家
    assert!(!codex_other_switcher_marks(
        "model_provider = \"custom\"\n[model_providers.custom]\nname = \"Mesa\"\nbase_url = \"https://a\"\n"
    ));
    assert!(!codex_other_switcher_marks(
        "model_provider = \"custom\"\n[model_providers.custom]\nname = \"OpenAI\"\nrequires_openai_auth = true\n"
    ));
    assert!(codex_other_switcher_marks(
        "model_provider = \"custom\"\n[model_providers.custom]\nname = \"NewAPI\"\nbase_url = \"https://a\"\n"
    ));
}

#[test]
fn set_global_conflict_reason_all_agents() {
    let cc: &[&str] = &["cc-switch"];
    for agent in ["claude-code", "gemini", "qwen", "kimi", "grok"] {
        assert!(set_global_conflict_reason(agent, cc, None).is_some());
    }
    assert!(set_global_conflict_reason("claude-code", &[], None).is_none());
    assert!(set_global_conflict_reason("cursor", cc, None).is_none());
    assert_eq!(
        set_global_conflict_reason("codex", cc, None).as_deref(),
        Some(CODEX_SET_GLOBAL_CONFLICT)
    );
    assert_eq!(
        set_global_conflict_reason(
            "codex",
            &[],
            Some("[model_providers.custom]\nbase_url = \"https://a\"\n")
        )
        .as_deref(),
        Some(CODEX_SET_GLOBAL_CONFLICT)
    );
    assert!(set_global_conflict_reason("codex", &[], Some("model = \"gpt-5\"\n")).is_none());
    assert_eq!(
        set_global_conflict_reason("opencode", cc, None),
        Some(switcher_conflict_message(cc))
    );
}

#[test]
fn magpie_counts_as_other_switcher() {
    let home = tmpdir("switchers");
    assert!(other_switchers_present(&home).is_empty());
    std::fs::create_dir_all(home.join(".config").join("magpie")).unwrap();
    assert_eq!(other_switchers_present(&home), vec!["magpie"]);
    std::fs::create_dir_all(home.join(".cc-switch")).unwrap();
    assert_eq!(other_switchers_present(&home), vec!["cc-switch", "magpie"]);

    let magpie: &[&str] = &["magpie"];
    let msg = set_global_conflict_reason("claude-code", magpie, None).unwrap();
    assert!(msg.contains("本机检测到 magpie"));
    // 只装 magpie：Codex 不套 cc-switch 的 custom 渠道说明
    let codex = set_global_conflict_reason("codex", magpie, Some("model = \"gpt-5\"\n")).unwrap();
    assert!(codex.contains("magpie") && !codex.contains("cc-switch"));
}

#[test]
fn gemini_settings_patch_adds_selected_type_and_tolerates_jsonc() {
    // 从无到有
    let v: Value =
        serde_json::from_str(&patch_gemini_settings(None, "测试", &[], None).unwrap()).unwrap();
    assert_eq!(v["security"]["auth"]["selectedType"], "gemini-api-key");
    // 无模型名单时不写 experimental 段
    assert!(v.get("experimental").is_none());
    // JSONC 容错（注释 + 尾逗号），既有字段保留
    let existing = "{\n  // 主题\n  \"theme\": \"dark\",\n}\n";
    let v: Value = serde_json::from_str(
        &patch_gemini_settings(Some(existing), "测试", &[], None).unwrap(),
    )
    .unwrap();
    assert_eq!(v["theme"], "dark");
    assert_eq!(v["security"]["auth"]["selectedType"], "gemini-api-key");
    // 损坏文件拒写（fail-loud），不静默覆盖
    assert!(patch_gemini_settings(Some("{ not json"), "测试", &[], None).is_err());
}

#[test]
fn gemini_settings_patch_registers_custom_models_for_picker() {
    // /model 选择器登记（0.46.0 bundle 实证）：experimental 开关 + modelDefinitions，
    // isVisible 必显式 true，tier=custom；既有字段与用户条目保留
    let existing = r#"{"modelConfigs": {"modelDefinitions": {"user-one": {"tier": "custom", "isVisible": true}}}}"#;
    let out = patch_gemini_settings(
        Some(existing),
        "我的网关",
        &["gemini-3-pro".into(), "kimi-k3".into()],
        None,
    )
    .unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["experimental"]["dynamicModelConfiguration"], true);
    let defs = &v["modelConfigs"]["modelDefinitions"];
    assert_eq!(defs["gemini-3-pro"]["tier"], "custom");
    assert_eq!(defs["gemini-3-pro"]["isVisible"], true);
    assert_eq!(
        defs["gemini-3-pro"]["displayName"],
        "我的网关 · gemini-3-pro"
    );
    // 用户手维护的条目不动
    assert_eq!(defs["user-one"]["isVisible"], true);
    // kimi-k3 注册链确知思考+视觉 → features 声明；gemini-3-pro 视觉确知
    assert_eq!(defs["kimi-k3"]["features"]["thinking"], true);
    assert_eq!(defs["gemini-3-pro"]["features"]["multimodalToolUse"], true);
}

#[test]
fn gemini_env_patch_replaces_only_our_keys() {
    let existing = "# comment\nGEMINI_API_KEY=old\nOTHER=1\n";
    let pairs = vec![
        ("GEMINI_API_KEY".to_string(), "new-key".to_string()),
        ("GEMINI_MODEL".to_string(), "gemini-3-pro".to_string()),
    ];
    let out = patch_env_file(Some(existing), &pairs).unwrap();
    assert!(out.contains("GEMINI_API_KEY=new-key"));
    assert!(out.contains("GEMINI_MODEL=gemini-3-pro"));
    assert!(out.contains("OTHER=1"));
    assert!(out.contains("# comment"));
    assert!(!out.contains("old"));
}

#[test]
fn gemini_env_patch_rejects_multiline_values() {
    let pairs = vec![("GEMINI_API_KEY".to_string(), "k1\nINJECTED=1".to_string())];
    let err = patch_env_file(None, &pairs).unwrap_err();
    assert!(err.contains("换行符"), "{err}");
    let pairs_cr = vec![("GEMINI_MODEL".to_string(), "m\rx".to_string())];
    assert!(patch_env_file(None, &pairs_cr).is_err());
}

#[test]
fn qwen_patch_openai_protocol() {
    let existing = r#"{"security": {"auth": {"other": true}}}"#;
    let mut p = profile("qwen");
    p.base_url = Some("https://dashscope.aliyuncs.com/compatible-mode/v1".into());
    p.models = vec!["qwen3-coder".into(), "qwen3-max".into()];
    let out = patch_qwen_settings(Some(existing), Some("sk-secret"), &p).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["security"]["auth"]["selectedType"], "openai");
    assert_eq!(v["security"]["auth"]["other"], true);
    assert_eq!(v["env"]["OPENAI_API_KEY"], "sk-secret");
    assert_eq!(v["env"]["OPENAI_MODEL"], "qwen3-coder");
    assert_eq!(v["model"]["name"], "qwen3-coder");
    assert!(v["env"].get("ANTHROPIC_API_KEY").is_none());
    // modelProviders.openai（数组）：TUI /model 对话框的数据源
    let models = v["modelProviders"]["openai"].as_array().unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0]["id"], "qwen3-coder");
    assert_eq!(models[0]["name"], "qwen3-coder");
    assert_eq!(
        models[0]["baseUrl"],
        "https://dashscope.aliyuncs.com/compatible-mode/v1"
    );
    assert_eq!(models[0]["envKey"], QWEN_MESA_KEY_ENV);
    assert_eq!(models[1]["id"], "qwen3-max");
    // 无策略时不写 generationConfig
    assert!(models[0].get("generationConfig").is_none());
}

#[test]
fn qwen_patch_entries_carry_generation_config_from_policy() {
    // generationConfig.samplingParams（0.22.0 bundle 实证，snake_case 线格式键名），
    // 逐模型取各模型的策略值
    let mut p = profile("qwen");
    p.models = vec!["qwen3-coder".into(), "qwen3-max".into()];
    p.request_policy.temperature = Some(0.6);
    p.request_policy.top_p = Some(0.95);
    p.request_policy.max_output_tokens = Some(8192);
    let out = patch_qwen_settings(None, Some("sk-secret"), &p).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    let models = v["modelProviders"]["openai"].as_array().unwrap();
    let sp = &models[0]["generationConfig"]["samplingParams"];
    assert_eq!(sp["temperature"], 0.6);
    assert_eq!(sp["top_p"], 0.95);
    assert_eq!(sp["max_tokens"], 8192);
    assert!(sp.get("topP").is_none(), "键名必须是 snake_case 线格式");
}

/// 跨层一致性：agent_specs::request_policy_support 的通道表和本文件的补丁函数是两处
/// 手写知识。加一个 agent、改一档通道，两边都不会编译失败——只有这个测试会响。
///
/// 只断言表里说「写盘可达」（persist）的部分：
/// - persist ⇒ 该字段必须真的落到写出的配置里；
/// - unsupported ⇒ 即使设了值，写出的文本里也不该出现（防补丁函数偷偷多写一条表不知道的路径）。
/// **不断言 inject。** 表的取值按入口记账，inject 指的是启动注入（agents::apply_request_policy_env），
/// 本来就**不该**进配置文件；把「inject ⇒ 写盘」写成断言，等于把当初 persist 拆分要修的那个
/// 混淆（见 agent_specs.rs 里 qwen 那条注释）重新钉进测试。启动注入那半边归 agents.rs 的测试管。
#[test]
fn policy_channel_table_agrees_with_patch_functions() {
    use crate::agent_specs::request_policy_support;

    // 探针值取得足够怪：在输出里按子串找它们，撞上别的字段的概率可以忽略。
    // 三个字段各用不同数量级，便于区分是谁漏出来的。
    const PROBE_TEMP: f64 = 0.123456;
    const PROBE_TOP_P: f64 = 0.654321;
    const PROBE_MAX: u64 = 987654;

    // 表里五个字段名，与 RequestPolicySupportDto 的字段一一对应。
    const FIELDS: [&str; 5] = [
        "temperature",
        "top_p",
        "max_output_tokens",
        "reasoning_effort",
        "custom_headers",
    ];

    let field_value = |field: &str| -> Value {
        match field {
            "temperature" => json!(PROBE_TEMP),
            "top_p" => json!(PROBE_TOP_P),
            "max_output_tokens" => json!(PROBE_MAX),
            "reasoning_effort" => json!("probeEffort7"),
            "custom_headers" => json!("PROBE_HEADER_ENV_7"),
            other => panic!("表里出现了测试不认识的字段 {other}，请同步本测试"),
        }
    };
    let field_status = |agent: &str, field: &str| match field {
        "temperature" => request_policy_support(agent).temperature,
        "top_p" => request_policy_support(agent).top_p,
        "max_output_tokens" => request_policy_support(agent).max_output_tokens,
        "reasoning_effort" => request_policy_support(agent).reasoning_effort,
        "custom_headers" => request_policy_support(agent).custom_headers,
        other => panic!("表里出现了测试不认识的字段 {other}"),
    };

    // 只把该字段设上，其余留空——这样输出里出现的探针值一定来自这个字段。
    let only = |agent: &str, field: &str| -> (Profile, String) {
        let mut p = profile(agent);
        p.models = vec!["probe-model-7".into()];
        let value = field_value(field);
        match field {
            "temperature" => p.request_policy.temperature = Some(value.as_f64().unwrap()),
            "top_p" => p.request_policy.top_p = Some(value.as_f64().unwrap()),
            "max_output_tokens" => {
                p.request_policy.max_output_tokens = Some(value.as_u64().unwrap())
            }
            "reasoning_effort" => {
                p.request_policy.reasoning_effort = Some(value.as_str().unwrap().into())
            }
            "custom_headers" => {
                p.request_policy
                    .header_env
                    .insert("X-Probe".into(), "PROBE_HEADER_ENV_7".into());
            }
            other => panic!("字段 {other} 没有探针"),
        }
        // 在写出的文本里找这个子串。字符串字段用裸文本（配置里会带引号，
        // 裸串仍是其子串）；数值字段直接用 JSON 记法。
        let text = match value.as_str() {
            Some(s) => s.to_string(),
            None => value.to_string(),
        };
        (p, text)
    };

    // 跑「设为全局」的写盘路径，返回要落盘的文本。每个 agent 一条，缺了就 panic——
    // 将来加了 agent，这里必须显式补一条，不能悄悄漏测。
    let written = |p: &Profile| -> String {
        let key = Some("sk-probe");
        match p.agent.as_str() {
            "claude-code" => {
                pc(None, p.base_url.as_deref(), key, &p.models, None, None)
            }
            "qwen" => patch_qwen_settings(None, key, p),
            "gemini" => patch_gemini_settings(None, &p.name, &p.models, None)
                .and_then(|c| patch_gemini_extras(&c, p)),
            "codex" => patch_codex_config(
                None,
                p.base_url.as_deref(),
                p.models.first().map(String::as_str),
                None,
                None,
                "sk-probe",
            ),
            "opencode" => {
                let mut provider = crate::agents::opencode_provider_json(p, key, None);
                overlay_opencode_per_model(&mut provider, p);
                patch_opencode_config(None, provider, None, None, "ccode-probe", false)
            }
            "kimi" => patch_kimi_config(
                None,
                "kimi",
                &p.name,
                p.base_url.as_deref(),
                key,
                &p.models,
                true,
                "ccode-probe",
                None,
            ),
            "grok" => patch_grok_config(None, key, p),
            "codebuddy" => patch_codebuddy_settings(
                None,
                p.base_url.as_deref(),
                key,
                p.models.first().map(String::as_str),
                p.request_policy.max_output_tokens,
            ),
            other => panic!("新增了 agent {other}，请在跨层一致性测试里补一条写盘路径"),
        }
        .unwrap_or_else(|e| panic!("{} 写盘失败: {e}", p.agent))
    };

    // 表里声明「设为全局写盘可达」的格子。改动这张表时这个测试会要求你同时改补丁函数
    // （或反过来），这正是它的用处——它不该被顺手放宽。
    let agents = [
        "claude-code",
        "codebuddy",
        "gemini",
        "codex",
        "opencode",
        "kimi",
        "qwen",
        "grok",
    ];
    let mut persist_cells = Vec::new();
    let mut failures = Vec::new();
    for agent in agents {
        for field in FIELDS {
            let status = field_status(agent, field);
            let (p, probe) = only(agent, field);
            let text = written(&p);
            let present = text.contains(&probe);
            match status {
                "persist" => {
                    persist_cells.push(format!("{agent}.{field}"));
                    if !present {
                        failures.push(format!(
                            "{agent} 的 {field} 声明为 persist（设为全局可达），\
                                 但写出的配置里没有这个值——补丁函数漏写了，或表该降级"
                        ));
                    }
                }
                "unsupported" => {
                    if present {
                        failures.push(format!(
                            "{agent} 的 {field} 声明为 unsupported（CLI 无入口），\
                                 却出现在了写出的配置里——补丁函数多了一条表不知道的写盘路径"
                        ));
                    }
                }
                // inject 属于启动注入那半边，tui/unknown 本就不该落盘；这里不表态。
                _ => {}
            }
        }
    }
    assert!(
        failures.is_empty(),
        "通道表与写盘函数不一致：\n{}",
        failures.join("\n")
    );

    // 表里 persist 的格子：gemini 三项采样（customOverrides）。qwen 采样 + 思考档 2026-11-01 起启动也能注
    //（系统设置覆盖层），表里是 inject，「设为全局」照写 samplingParams。
    // 这条防的是「表被悄悄扩了 persist 而没人实现」——真出现了，上面 failures 会先响，这里再说明该去看哪。
    assert_eq!(
        persist_cells,
        [
            "gemini.temperature",
            "gemini.top_p",
            "gemini.max_output_tokens",
        ]
        .map(String::from)
        .to_vec(),
        "persist 格子变了：确认补丁函数跟上后，同步更新这里"
    );
}

#[test]
fn qwen_patch_anthropic_protocol() {
    let mut p = profile("qwen");
    p.protocol = Some("anthropic".into());
    p.base_url = Some("https://r.example.com".into());
    p.models = vec![];
    let out = patch_qwen_settings(None, Some("k"), &p).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["security"]["auth"]["selectedType"], "anthropic");
    assert_eq!(v["env"]["ANTHROPIC_API_KEY"], "k");
    assert!(v["env"].get("OPENAI_API_KEY").is_none());
    assert!(v.get("model").is_none());
    assert!(v.get("modelProviders").is_none());
}

#[test]
fn qwen_patch_model_providers_preserves_other_protocols() {
    let existing = r#"{"$version": 4, "modelProviders": {"gemini": [{"id": "g1"}], "openai": [{"id": "mine", "envKey": "K"}]}}"#;
    let mut p = profile("qwen");
    p.base_url = None;
    p.models = vec!["qwen3-coder".into()];
    let out = patch_qwen_settings(Some(existing), None, &p).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    // 其他协议原样保留；本协议写成数组（带 $version 4 时 Qwen 不认包一层的旧写法），用户条目留在后面
    assert_eq!(v["$version"], 4);
    assert_eq!(v["modelProviders"]["gemini"][0]["id"], "g1");
    let models = v["modelProviders"]["openai"].as_array().unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[1]["id"], "mine");
    assert_eq!(models[0]["id"], "qwen3-coder");
    assert!(
        models[0].get("baseUrl").is_none(),
        "无 base_url 时不写该字段"
    );
}

#[test]
fn qwen_global_write_keeps_users_own_model_entries() {
    // 规则 3：只管自己写的条目。以前整组换掉，用户自己配的 DashScope 模型被一起删了
    // 旧版 Mesa 写的是包一层 {"models": [...]}：读出来按数组写回
    let existing = r#"{"modelProviders": {"openai": {"models": [
            {"id": "my-own", "envKey": "DASHSCOPE_API_KEY", "baseUrl": "https://dashscope"},
            {"id": "old-mesa", "envKey": "MESA_QWEN_API_KEY", "baseUrl": "https://old-relay"},
            {"id": "m1", "envKey": "OPENAI_API_KEY"}
        ]}}}"#;
    let p = profile("qwen");
    let out = patch_qwen_settings(Some(existing), Some("sk-new"), &p).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    let ids: Vec<&str> = v["modelProviders"]["openai"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["m1", "my-own"], "这次的在前；上一份 Mesa 条目撤掉；同名的换成这次的");
    // 官方切回：Mesa 条目（指着被撤的 MESA_QWEN_API_KEY）撤掉，用户的留着，默认模型若是 Mesa 的一并撤
    let mut doc: Value = serde_json::from_str(&out).unwrap();
    doc["model"]["name"] = json!("m1");
    let off = patch_qwen_settings_official(&doc.to_string()).unwrap();
    let v: Value = serde_json::from_str(&off).unwrap();
    let ids: Vec<&str> = v["modelProviders"]["openai"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["my-own"]);
    assert!(v.pointer("/model/name").is_none());
}

#[test]
fn opencode_patch_preserves_other_providers() {
    let existing = r#"{
          // jsonc 注释
          "provider": {"other": {"npm": "x"}, "ccode-old1": {"options": {"apiKey": "sk-old"}}},
          "small_model": "ccode-old1/tiny", "theme": "dark",
        }"#;
    let p = profile("opencode");
    let provider = agents::opencode_provider_json(&p, Some("sk-secret"), Some("m1"));
    let out = patch_opencode_config(Some(existing), provider, Some("m1"), None, "ccode-new2", false).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["provider"]["other"]["npm"], "x");
    assert!(v["provider"].get("ccode-old1").is_none(), "上一份 Mesa 渠道连同明文密钥撤掉");
    assert_eq!(v["provider"]["ccode-new2"]["npm"], "@ai-sdk/openai-compatible");
    assert_eq!(v["model"], "ccode-new2/m1");
    assert!(v.get("small_model").is_none(), "指着 Mesa 旧渠道的小模型撤掉");
    assert!(v.get("autoupdate").is_none(), "不改用户自己用 OpenCode 时的更新行为");
    assert_eq!(v["theme"], "dark");
}

#[test]
fn opencode_v2_writes_native_providers_and_drops_own_legacy_copy() {
    // 本机是 2.x：写原生 providers（同启动注入的转换），同名 1.x 块撤掉；用户自己的块（两种写法）与引用文件还在的 Mesa 老渠道照留
    let home = tmpdir("oc-v2");
    let alive = home.join("alive.key");
    fs::write(&alive, "sk-a").unwrap();
    let alive_ref = format!("{{file:{}}}", alive.to_string_lossy());
    let existing = json!({
        "provider": {
            "mine": {"npm": "x"},
            "ccode-new2": {"options": {"apiKey": "sk-stale"}},
            "ccode-old1": {"options": {"apiKey": alive_ref}}
        },
        "providers": {
            "user-native": {"package": "aisdk:y"},
            "ccode-gone": {"settings": {"apiKey": format!("{{file:{}}}", home.join("gone.key").to_string_lossy())}},
            "ccode-alive2": {"settings": {"apiKey": alive_ref}}
        }
    })
    .to_string();
    let mut p = profile("opencode");
    p.models = vec!["m1".into()];
    let mut provider = agents::opencode_provider_json(&p, Some("{file:/k}"), Some("m1"));
    provider["models"]["m1"]["reasoning"] = json!(true);
    provider["models"]["m1"]["options"] = json!({"reasoningEffort": "xhigh", "temperature": 0.2});
    let out = patch_opencode_config(Some(&existing), provider, Some("m1"), None, "ccode-new2", true).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v["provider"].get("ccode-new2").is_none(), "同名 1.x 块撤掉，只留原生那份");
    assert_eq!(v["provider"]["mine"]["npm"], "x", "用户的 1.x 块不动");
    assert!(v["provider"].get("ccode-old1").is_some(), "引用文件还在的老渠道留着");
    let blk = &v["providers"]["ccode-new2"];
    assert_eq!(blk["package"], "aisdk:@ai-sdk/openai-compatible");
    assert_eq!(blk["settings"]["apiKey"], "{file:/k}", "密钥照旧是文件引用");
    let m = &blk["models"]["m1"];
    assert_eq!(m["settings"]["reasoningEffort"], "xhigh");
    assert_eq!(m["body"]["temperature"], 0.2);
    let efforts: Vec<&str> = m["capabilities"]["reasoning"]["effort"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(efforts, vec!["low", "medium", "high", "xhigh"], "模型自己的档进可选档位（2.x 默认只有前三档）");
    assert_eq!(v["providers"]["user-native"]["package"], "aisdk:y", "用户的原生块不动");
    assert!(v["providers"].get("ccode-gone").is_none(), "引用文件不在的原生 Mesa 块也撤");
    assert!(v["providers"].get("ccode-alive2").is_some());
    assert_eq!(v["model"], "ccode-new2/m1");
    // 1.x 的块只剩用户自己的与老渠道时照留；全是 Mesa 本渠道时整段撤掉
    let only_own = json!({"provider": {"ccode-new2": {"options": {"apiKey": "sk"}}}}).to_string();
    let p2 = agents::opencode_provider_json(&p, None, Some("m1"));
    let out = patch_opencode_config(Some(&only_own), p2, Some("m1"), None, "ccode-new2", true).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v.get("provider").is_none());
    fs::remove_dir_all(&home).ok();
}

#[test]
fn grok_mesa_sessions_get_their_model_section_for_resume_outside_mesa() {
    let home = tmpdir("grok-cont");
    let _root = crate::storage::TestConfigRoot::redirect_to(&home.join("mesa"));
    fs::create_dir_all(home.join("mesa")).unwrap();
    fs::write(home.join("mesa/keys.json"), r#"{"gw-old": "sk-old"}"#).unwrap();
    let conn = rusqlite::Connection::open(home.join("mesa/app.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE session_meta(agent TEXT, session_id TEXT, profile_id TEXT);
             INSERT INTO session_meta VALUES('grok','s-old','b-old'),('grok','s-new','b-new'),('codex','s-old','b-old');",
    )
    .unwrap();
    for (sid, m) in [("s-old", "old-m"), ("s-new", "new-m")] {
        let d = home.join(".grok/sessions/%2Fx").join(sid);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("summary.json"), format!(r#"{{"current_model_id":"{m}"}}"#)).unwrap();
    }
    fs::write(home.join(".grok/config.toml"), "[models]\ndefault = \"new-m\"\n").unwrap();
    let mut old = profile("grok");
    old.id = "b-old".into();
    old.name = "老连接".into();
    old.gateway_id = Some("gw-old".into());
    old.base_url = Some("https://old.example.com/v1".into());
    let mut cur = profile("grok");
    cur.id = "b-new".into();
    cur.models = vec!["new-m".into()];
    let mut plans = Vec::new();
    extend_grok_plans(&home, &mut plans, &[old, cur.clone()], Some(&cur)).unwrap();
    let doc: toml::Value = toml::from_str(&plans[0].content).unwrap();
    let sec = &doc["model"]["old-m"];
    assert_eq!(sec["base_url"].as_str(), Some("https://old.example.com/v1"));
    assert_eq!(sec["api_key"].as_str(), Some("sk-old"));
    assert_eq!(sec["name"].as_str(), Some("老连接 · old-m"));
    assert!(doc["model"].get("new-m").is_none(), "这次连接自己的模型不补（会把新会话拉去老连接）");
    fs::remove_dir_all(&home).ok();
}

#[test]
fn grok_official_keeps_relay_sections_with_their_own_key() {
    // 会话记着 current_model_id：带自己密钥的中转段（Mesa 写的也算）留着，老会话还能续；没密钥的撤（防官方令牌发去中转）
    let existing = "api_key = \"sk-top\"\n\n[model.relay-a]\nname = \"测试 · relay-a\"\nbase_url = \"https://relay.example.com/v1\"\napi_key = \"sk-a\"\n\n[model.keyless]\nbase_url = \"https://relay.example.com/v1\"\n";
    let out = patch_grok_config_official(existing).unwrap();
    let doc: toml::Value = toml::from_str(&out).unwrap();
    assert!(doc.get("api_key").is_none());
    assert_eq!(doc["model"]["relay-a"]["api_key"].as_str(), Some("sk-a"));
    assert!(doc["model"].get("keyless").is_none());
}

#[test]
fn opencode_keeps_old_mesa_providers_whose_key_file_exists() {
    // 老对话还要用：引用着的密钥文件在就留；文件没了的整份配置会加载失败（1.19.5 实测），撤
    let home = tmpdir("oc-keep");
    let alive = home.join("alive.key");
    fs::write(&alive, "sk-a").unwrap();
    let existing = json!({
        "provider": {
            "ccode-alive": {"options": {"apiKey": format!("{{file:{}}}", alive.to_string_lossy())}},
            "ccode-gone": {"options": {"apiKey": format!("{{file:{}}}", home.join("gone.key").to_string_lossy())}},
            "ccode-plain": {"options": {"apiKey": "sk-plain"}}
        }
    })
    .to_string();
    let p = profile("opencode");
    let provider = agents::opencode_provider_json(&p, None, Some("m1"));
    let out = patch_opencode_config(Some(&existing), provider, Some("m1"), None, "ccode-new2", false).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    let keys: Vec<&String> = v["provider"].as_object().unwrap().keys().collect();
    assert!(keys.iter().any(|k| *k == "ccode-alive"));
    assert!(!keys.iter().any(|k| *k == "ccode-gone" || *k == "ccode-plain"));
    fs::remove_dir_all(&home).ok();
}

#[test]
fn kimi_writes_effort_for_kimi_protocol_and_clears_key_on_official() {
    let mut p = profile("kimi");
    p.protocol = Some("kimi".into());
    p.models = vec!["kimi-k3".into()];
    p.request_policy.reasoning_effort = Some("high".into());
    let pid = p.provider_name();
    let base = patch_kimi_config(None, "kimi", &p.name, Some("https://k/v1"), Some("sk"), &p.models, true, &pid, None).unwrap();
    let out = patch_kimi_effort(&base, &p, "kimi").unwrap();
    let doc: toml::Value = toml::from_str(&out).unwrap();
    assert_eq!(doc["models"]["kimi-k3"]["default_effort"].as_str(), Some("high"));
    // 只写 default_effort 不起作用，要连档位表一起声明
    let levels: Vec<_> = doc["models"]["kimi-k3"]["support_efforts"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    assert!(levels.contains(&"high"));
    // 别的协议不写（Kimi 原样发给中转），写过的撤掉
    let other = patch_kimi_effort(&out, &p, "openai").unwrap();
    let doc: toml::Value = toml::from_str(&other).unwrap();
    assert!(doc["models"]["kimi-k3"].get("default_effort").is_none());
    // 官方切回：渠道、别名连同密钥留着（老会话按别名续，撤了密钥一续就失败）
    let off = patch_kimi_config_official(&out).unwrap();
    let doc: toml::Value = toml::from_str(&off).unwrap();
    assert_eq!(doc["providers"][&pid]["api_key"].as_str(), Some("sk"));
    assert!(doc["models"].get("kimi-k3").is_some());
    // Mesa 开的会话存的别名：全局里指到这次的连接
    let aliased = patch_kimi_env_alias(&out, &p, &pid).unwrap();
    let doc: toml::Value = toml::from_str(&aliased).unwrap();
    assert_eq!(doc["models"]["__kimi_env_model__"]["provider"].as_str(), Some(pid.as_str()));
    assert_eq!(doc["models"]["__kimi_env_model__"]["model"].as_str(), Some("kimi-k3"));
    // 还有别名指着旧版 ccode 渠道时不撤它
    let legacy = "[providers.ccode]\ntype = \"openai\"\n[models.old]\nprovider = \"ccode\"\nmodel = \"x\"\n";
    let kept = patch_kimi_config(Some(legacy), "kimi", &p.name, Some("https://k/v1"), Some("sk"), &p.models, true, &pid, None).unwrap();
    assert!(kept.contains("[providers.ccode]"));
}

/// CLI 金丝雀「全局配置」层（scripts/cli-canary）：按 Mesa 真实的设为全局写计划，把某家的配置写进
/// E2E_GLOBAL_HOME（临时家目录），之后由脚本不经 Mesa 直接拉起 CLI，看假网关收到的模型和密钥是不是这条连接的。
/// 写到家目录外的文件（Codex 模型目录）改放到临时家目录下，引用一并改写；不碰本机任何配置
#[test]
#[ignore]
fn e2e_write_global_config() {
    let base = std::env::var("E2E_BASE").expect("E2E_BASE");
    let home = PathBuf::from(std::env::var("E2E_GLOBAL_HOME").expect("E2E_GLOBAL_HOME"));
    let agent = std::env::var("E2E_AGENT").expect("E2E_AGENT");
    // base_url 后缀同 agents::e2e_dump_launch_plans：Anthropic 协议不带 /v1，Gemini 由 CLI 拼 /v1beta
    let (proto, suffix) = match agent.as_str() {
        "claude-code" | "gemini" => (None, ""),
        "qwen" | "kimi" => (Some("openai"), "/v1"),
        _ => (None, "/v1"),
    };
    let mut p = profile(&agent);
    p.id = format!("e2e-global-{agent}");
    p.name = "E2E".into();
    p.base_url = Some(format!("{base}/{agent}{suffix}"));
    p.protocol = proto.map(Into::into);
    p.models = vec!["e2e-global".into()];
    // 手动核对思考档时用：E2E_GLOBAL_MODEL 换成能力库认得的思考模型，E2E_GLOBAL_EFFORT 给这条连接设思考档
    if let Ok(m) = std::env::var("E2E_GLOBAL_MODEL") {
        p.models = vec![m];
    }
    if let Ok(e) = std::env::var("E2E_GLOBAL_EFFORT") {
        p.request_policy.reasoning_effort = Some(e);
    }
    let mut plans = plan_writes(&home, &p, Some("sk-e2e-global"), &p.models).expect("写计划");
    let moved: Vec<(String, PathBuf)> = plans
        .iter()
        .filter(|w| !w.path.starts_with(&home))
        .map(|w| {
            let to = home.join("mesa-config").join(w.path.file_name().unwrap());
            (w.path.to_string_lossy().into_owned(), to)
        })
        .collect();
    for w in plans.iter_mut() {
        for (from, to) in &moved {
            let to_s = to.to_string_lossy().into_owned();
            if w.path.to_string_lossy() == from.as_str() {
                w.path = to.clone();
            }
            w.content = w
                .content
                // TOML / JSON 里 Windows 路径的反斜杠是转义过的，两种写法都换
                .replace(&from.replace('\\', "\\\\"), &to_s.replace('\\', "\\\\"))
                .replace(from.as_str(), &to_s);
        }
    }
    let mut written = Vec::new();
    for w in &plans {
        fs::create_dir_all(w.path.parent().unwrap()).unwrap();
        fs::write(&w.path, &w.content).unwrap();
        written.push(w.path.to_string_lossy().into_owned());
    }
    println!("E2E_GLOBAL_WRITTEN {}", serde_json::to_string(&written).unwrap());
}

#[test]
fn override_notes_name_only_exported_shell_vars() {
    let has = |v: &str| matches!(v, "GEMINI_MODEL" | "GROK_DEFAULT_MODEL");
    let gemini = override_notes_with("gemini", &has);
    assert!(gemini[0].contains("GEMINI_MODEL") && !gemini[0].contains("GEMINI_API_KEY"), "{gemini:?}");
    assert!(gemini.iter().any(|n| n.contains(".env")), "Gemini 的 .env 只读一份要说");
    assert!(override_notes_with("grok", &has)[0].contains("GROK_DEFAULT_MODEL"));
    assert!(override_notes_with("kimi", &has).is_empty(), "没导出的不报");
}

#[test]
fn opencode_plan_uses_key_file_ref_and_jsonc_when_present() {
    let home = tmpdir("opencode-plan");
    let dir = home.join(".config/opencode");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("opencode.jsonc"), "{ // mine\n \"theme\": \"x\" }").unwrap();
    let mut p = profile("opencode");
    p.models = vec!["m1".into()];
    p.request_policy.header_env.insert("X-Org".into(), "ORG_TOKEN".into());
    let plans = plan_writes(&home, &p, Some("sk-plain"), &p.models).unwrap();
    let key = plans.iter().find(|w| w.tag == "opencode-key").unwrap();
    assert_eq!(key.content, "sk-plain");
    let cfg = plans.iter().find(|w| w.tag == "opencode.jsonc").expect("有 .jsonc 就写它");
    assert!(!cfg.content.contains("sk-plain"), "opencode 配置里不出明文密钥");
    let v: Value = serde_json::from_str(&cfg.content).unwrap();
    let pid = p.provider_name();
    assert_eq!(v["provider"][&pid]["options"]["apiKey"], format!("{{file:{}}}", key.path.to_string_lossy()));
    assert_eq!(v["provider"][&pid]["options"]["headers"]["X-Org"], "{env:ORG_TOKEN}");
    assert_eq!(v["theme"], "x");
    // 预览不出密钥值
    let preview = preview_plans(&home, "opencode", &plans, vec![], vec![]);
    let shown: Vec<_> = preview.files.iter().flat_map(|f| f.changes.iter().filter_map(|c| c.after.clone())).collect();
    assert!(!shown.iter().any(|a| a.contains("sk-plain")), "{shown:?}");
    fs::remove_dir_all(&home).ok();
}

#[test]
fn codebuddy_patch_writes_env_block_and_preserves_rest() {
    let existing = r#"{"env": {"OTHER": "1"}, "theme": "dark"}"#;
    let out = patch_codebuddy_settings(
        Some(existing),
        Some("https://api.deepseek.com/anthropic"),
        Some("sk-secret"),
        Some("deepseek-v3-2-volc"),
        Some(8192),
    )
    .unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        v["env"]["CODEBUDDY_BASE_URL"],
        "https://api.deepseek.com/anthropic"
    );
    assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "sk-secret");
    assert_eq!(v["env"]["CODEBUDDY_MODEL"], "deepseek-v3-2-volc");
    assert_eq!(v["env"]["CODEBUDDY_CODE_MAX_OUTPUT_TOKENS"], "8192");
    assert_eq!(v["env"]["OTHER"], "1", "无关 env 必须保留");
    assert_eq!(v["theme"], "dark", "无关字段必须保留");
    // 缺省（文件不存在）：只创建 env 块
    let out = patch_codebuddy_settings(None, None, Some("sk-secret"), None, None).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["env"]["CODEBUDDY_API_KEY"], "sk-secret");
    assert!(v["env"].get("CODEBUDDY_BASE_URL").is_none());
    // 上一条连接的地址 / 模型 / 输出上限这次没有就撤，不跟着新密钥一起生效
    let prev = r#"{"env":{"CODEBUDDY_BASE_URL":"https://old","CODEBUDDY_MODEL":"old-m","CODEBUDDY_CODE_MAX_OUTPUT_TOKENS":"1"}}"#;
    let v: Value = serde_json::from_str(&patch_codebuddy_settings(Some(prev), None, Some("sk"), None, None).unwrap()).unwrap();
    for k in ["CODEBUDDY_BASE_URL", "CODEBUDDY_MODEL", "CODEBUDDY_CODE_MAX_OUTPUT_TOKENS"] {
        assert!(v["env"].get(k).is_none(), "{k}");
    }
    // 顶层 model 压过 env：写成这次的模型；没有模型时撤上一家的非官方模型名
    let prev = r#"{"model":"gpt-6-astra","env":{}}"#;
    let v: Value = serde_json::from_str(&patch_codebuddy_settings(Some(prev), None, Some("sk"), Some("glm-5.3"), None).unwrap()).unwrap();
    assert_eq!(v["model"], "glm-5.3");
    // 没列模型：上一家中转的模型名撤掉，官方也认的留着（同 official_model_kept）
    let relay = r#"{"model":"deepseek-v4-flash","env":{}}"#;
    let v: Value = serde_json::from_str(&patch_codebuddy_settings(Some(relay), None, Some("sk"), None, None).unwrap()).unwrap();
    assert!(v.get("model").is_none());
    let kept = official_model_kept("codebuddy", "gpt-6-astra");
    let v: Value = serde_json::from_str(&patch_codebuddy_settings(Some(prev), None, Some("sk"), None, None).unwrap()).unwrap();
    assert_eq!(v.get("model").is_some(), kept);
}

#[test]
fn codebuddy_models_json_owns_only_mesa_entries() {
    let mut p = profile("codebuddy");
    p.base_url = Some("https://gw.example/v1/".into());
    p.models = vec!["glm-5".into(), "kimi-k3".into()];
    let existing = r#"{"availableModels":["glm-5"],"models":[
            {"id":"old","name":"旧连接 · old","apiKey":"${CODEBUDDY_API_KEY}","url":"https://old/chat/completions"},
            {"id":"older","name":"更旧 · older","apiKey":"sk-prev","url":"https://old/chat/completions"},
            {"id":"mine","name":"我的","apiKey":"${MY_KEY}","url":"https://mine/chat/completions"},
            {"id":"mine2","name":"自己的 · mine2","apiKey":"sk-user-own","url":"https://mine/chat/completions"},
            {"id":"glm-5","name":"手写同名","url":"https://x"}
        ]}"#;
    let out = patch_codebuddy_models(Some(existing), &p, &["sk-prev", "sk-new"]).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    let ids: Vec<_> = v["models"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["mine", "mine2", "glm-5", "kimi-k3"], "上一份 Mesa 条目（引用或旧明文）撤、同 id 由这次接管、用户条目留");
    let glm = &v["models"][2];
    // 不写地址和密钥：条目自带的会压过 Mesa 按连接启动注入的（同名模型被带到全局连接）
    assert!(glm.get("url").is_none());
    assert!(glm.get("apiKey").is_none());
    assert!(!out.contains("sk-new"), "models.json 不落密钥");
    assert_eq!(glm["vendor"], "Mesa");
    assert_eq!(glm["name"], "测试 · glm-5");
    assert_eq!(v["availableModels"], json!(["glm-5"]), "用户的下拉过滤不动");
    // 再写一次：自己上次写的条目认得出（vendor），不重复
    let again: Value = serde_json::from_str(&patch_codebuddy_models(Some(&out), &p, &[]).unwrap()).unwrap();
    assert_eq!(again["models"].as_array().unwrap().len(), 4);
    // 官方切回：Mesa 条目撤，用户条目留
    let off: Value =
        serde_json::from_str(&patch_codebuddy_models_official(&v.to_string(), Some("sk-new")).unwrap()).unwrap();
    let ids: Vec<_> = off["models"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["mine", "mine2"]);
}

#[test]
fn kimi_patch_writes_alias_table_per_model() {
    let existing = "[providers.other]\ntype = \"openai\"\n";
    let out = patch_kimi_config(
        Some(existing),
        "kimi",
        "Zetatechs",
        Some("https://api.moonshot.cn/v1"),
        Some("sk-secret"),
        &[
            "kimi-k3".into(),
            "kimi.k2.5 turbo".into(),
            "deepseek-chat".into(),
        ],
        true,
        "ccode",
        None,
    )
    .unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    assert_eq!(doc["providers"]["other"]["type"].as_str(), Some("openai"));
    let ccode = &doc["providers"]["ccode"];
    assert_eq!(ccode["type"].as_str(), Some("kimi"));
    assert_eq!(
        ccode["base_url"].as_str(),
        Some("https://api.moonshot.cn/v1")
    );
    assert_eq!(ccode["api_key"].as_str(), Some("sk-secret"));
    // 每个模型一个 [models.<alias>] 表；非法字符清洗为 _
    assert_eq!(doc["models"]["kimi-k3"]["provider"].as_str(), Some("ccode"));
    assert_eq!(doc["models"]["kimi-k3"]["model"].as_str(), Some("kimi-k3"));
    // 0.31+ 必填 max_context_size：k3 = 1M；「kimi.k2.5 turbo」统一写法后认作 k2.5 系（256K，2026-10-28 能力库点号当横杠），
    // 真不认识的（deepseek-chat 内置表没给上下文）= 128K 保守默认
    assert_eq!(
        doc["models"]["kimi-k3"]["max_context_size"].as_integer(),
        Some(1_048_576)
    );
    assert_eq!(
        doc["models"]["kimi_k2_5_turbo"]["max_context_size"].as_integer(),
        Some(262_144)
    );
    assert_eq!(
        doc["models"]["deepseek-chat"]["max_context_size"].as_integer(),
        Some(131_072)
    );
    assert_eq!(
        doc["models"]["kimi_k2_5_turbo"]["model"].as_str(),
        Some("kimi.k2.5 turbo")
    );
    // display_name 用 profile 名 + 模型名（选择器 label 优先 display_name）
    assert_eq!(
        doc["models"]["kimi-k3"]["display_name"].as_str(),
        Some("Zetatechs · kimi-k3")
    );
    // 推断为思考模型的写 capabilities；普通模型不写（走 CLI registry 默认）
    let caps = &doc["models"]["kimi-k3"]["capabilities"];
    assert_eq!(
        caps.as_array().map(|a| a.len()),
        Some(3),
        "kimi-k3 应声明 tool_use + thinking + image_in（多模态思考）"
    );
    assert_eq!(
        doc["models"]["kimi-k3"]["capabilities"][1].as_str(),
        Some("thinking")
    );
    assert_eq!(
        doc["models"]["kimi-k3"]["capabilities"][2].as_str(),
        Some("image_in")
    );
    assert!(doc["models"]["deepseek-chat"].get("capabilities").is_none());
    // default_model = 首个模型的别名
    assert_eq!(doc["default_model"].as_str(), Some("kimi-k3"));
}

#[test]
fn kimi_patch_without_models_keeps_single_ccode_alias() {
    let out =
        patch_kimi_config(None, "openai", "P", None, None, &[], true, "ccode", None).unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    assert_eq!(doc["providers"]["ccode"]["type"].as_str(), Some("openai"));
    assert_eq!(doc["models"]["ccode"]["provider"].as_str(), Some("ccode"));
    assert_eq!(
        doc["models"]["ccode"]["max_context_size"].as_integer(),
        Some(131_072)
    );
    assert_eq!(doc["default_model"].as_str(), Some("ccode"));
}

#[test]
fn kimi_patch_legacy_variant_omits_context_size() {
    // 旧版 kimi-cli（~/.kimi）：不写 max_context_size/display_name/capabilities，
    // 防止老版本解析未知字段报错
    let out = patch_kimi_config(
        None,
        "kimi",
        "P",
        None,
        None,
        &["kimi-k3".into()],
        false,
        "ccode",
        None,
    )
    .unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    assert!(doc["models"]["kimi-k3"].get("max_context_size").is_none());
    assert!(doc["models"]["kimi-k3"].get("display_name").is_none());
    assert!(doc["models"]["kimi-k3"].get("capabilities").is_none());
}

#[test]
fn kimi_alias_sanitizes_to_bare_key_charset() {
    assert_eq!(kimi_model_alias("kimi-k2"), "kimi-k2");
    assert_eq!(kimi_model_alias("a.b/c d"), "a_b_c_d");
}

#[test]
fn grok_config_patch_writes_and_preserves() {
    // 既有 [mcp_servers] 段与外来键原样保留；写入面 = 逐模型 base_url / api_key（顶层旧 api_key 撤掉）+
    // [models].default/策略全局默认；白名单并进绑定模型；不写 [endpoints]
    let existing = "api_key = \"old\"\ntheme = \"dark\"\n\n[mcp_servers.fs]\ncommand = \"npx\"\n\n[models]\nallowed_models = [\"grok-4.5\"]\n";
    let mut p = profile("grok");
    p.models = vec!["grok-code-fast-1".into()];
    p.request_policy.temperature = Some(0.7);
    p.request_policy.top_p = Some(0.95);
    p.request_policy.max_output_tokens = Some(8192);
    p.request_policy.reasoning_effort = Some("high".into());
    p.request_policy
        .header_env
        .insert("X-Tenant".into(), "TENANT_TOKEN".into());
    let out = patch_grok_config(Some(existing), Some("xai-secret"), &p).unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    assert!(doc.get("api_key").is_none(), "顶层 api_key Grok 不读，不写");
    assert_eq!(doc["model"]["grok-code-fast-1"]["api_key"].as_str(), Some("xai-secret"));
    assert!(doc.get("endpoints").is_none(), "不写 [endpoints]：它压过 Mesa 启动注入的地址");
    assert_eq!(doc["model"]["grok-code-fast-1"]["base_url"].as_str(), Some("https://relay.example.com"));
    let models = &doc["models"];
    assert_eq!(models["default"].as_str(), Some("grok-code-fast-1"));
    assert_eq!(models["temperature"].as_float(), Some(0.7));
    assert_eq!(models["top_p"].as_float(), Some(0.95));
    assert_eq!(models["max_completion_tokens"].as_integer(), Some(8192));
    assert_eq!(models["default_reasoning_effort"].as_str(), Some("high"));
    // Header 是 $VAR 引用（grok 读盘时展开），密文不落盘
    assert_eq!(
        models["extra_headers"]["X-Tenant"].as_str(),
        Some("$TENANT_TOKEN")
    );
    // 用户既有内容一律不动
    assert_eq!(doc["theme"].as_str(), Some("dark"));
    assert_eq!(doc["mcp_servers"]["fs"]["command"].as_str(), Some("npx"));
    // allowed_models 属用户选择器过滤，不接管；只并进默认模型（不在名单里 Grok 拒绝启动）
    let allowed: Vec<_> = models["allowed_models"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(allowed, ["grok-4.5", "grok-code-fast-1"]);
    // 每个绑定模型都建段并写推理菜单（中转目录不带档位时 /effort 才出得来）
    let entry = &doc["model"]["grok-code-fast-1"];
    assert_eq!(entry["supports_reasoning_effort"].as_bool(), Some(true));
    assert_eq!(entry["reasoning_effort"].as_str(), Some("high"));
    let efforts = entry["reasoning_efforts"].as_array_of_tables().unwrap();
    assert_eq!(efforts.len(), 4);
    assert_eq!(efforts.get(0).unwrap()["value"].as_str(), Some("xhigh"));
    assert_eq!(efforts.get(1).unwrap()["value"].as_str(), Some("high"));
    assert_eq!(efforts.get(1).unwrap()["default"].as_bool(), Some(true));
    assert_eq!(efforts.get(3).unwrap()["value"].as_str(), Some("low"));
    // 斜杠串不是一个档位，不能写进 default_reasoning_effort（Grok 会拒启动）
    p.request_policy.reasoning_effort = Some("hign/xhign".into());
    let out = patch_grok_config(Some(existing), Some("xai-secret"), &p).unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    assert!(doc["models"].get("default_reasoning_effort").is_none());
}

#[test]
fn grok_relay_write_points_title_model_at_this_connection() {
    let mut p = profile("grok");
    p.base_url = Some("https://relay.example.com/v1".into());
    p.models = vec!["glm-5".into(), "glm-5-flash".into()];
    let out = patch_grok_config(Some("[models]\nsession_summary = \"other-relay-claude\"\n"), Some("sk"), &p).unwrap();
    let d: toml::Value = toml::from_str(&out).unwrap();
    assert_eq!(d["models"]["session_summary"].as_str(), Some("glm-5"));
    assert_eq!(d["models"]["prompt_suggestion"].as_str(), Some("glm-5"));
    p.role_models.small = Some("glm-5-flash".into());
    let d: toml::Value = toml::from_str(&patch_grok_config(None, Some("sk"), &p).unwrap()).unwrap();
    assert_eq!(d["models"]["session_summary"].as_str(), Some("glm-5-flash"));
    // xAI 官方地址不动
    p.base_url = Some("https://api.x.ai/v1".into());
    let d: toml::Value = toml::from_str(&patch_grok_config(Some("[models]\nsession_summary = \"grok-4.6\"\n"), Some("sk"), &p).unwrap()).unwrap();
    assert_eq!(d["models"]["session_summary"].as_str(), Some("grok-4.6"));
}

#[test]
fn grok_config_patch_set_only_never_removes_user_keys() {
    // [models] 是通用键表：策略未设时只设不删——用户手写的 temperature 保留
    //（过期 Mesa 值靠「撤销上次写入/恢复初始状态」兜底，不靠静默删除）
    let existing = "[models]\ntemperature = 0.3\ndefault = \"grok-4.5\"\n";
    let mut p = profile("grok");
    p.models = vec!["grok-code-fast-1".into()];
    let out = patch_grok_config(Some(existing), Some("xai-secret"), &p).unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    assert_eq!(doc["models"]["temperature"].as_float(), Some(0.3));
    assert_eq!(doc["models"]["default"].as_str(), Some("grok-code-fast-1"));
    assert!(doc["models"].get("top_p").is_none());
    assert!(doc["models"].get("extra_headers").is_none());
    // 无 base_url / 无密钥 / 无模型时不建对应键
    p.base_url = None;
    p.models = vec![];
    let out = patch_grok_config(None, None, &p).unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    assert!(doc.get("api_key").is_none());
    assert!(doc.get("endpoints").is_none());
}

#[test]
fn grok_config_patch_writes_per_model_sections_with_api_backend() {
    // 绑定设了 API 后端 → 逐模型建 [model.<id>] 段（api_backend + name）；
    // 含 / 的模型 id 依赖 toml_edit 自动加引号，round-trip 解析验证合法且键名原样
    let mut p = profile("grok");
    p.name = "我的中转".into();
    p.models = vec!["openai/gpt-5.1".into(), "grok-4.5".into()];
    p.api_backend = Some("responses".into());
    let existing = "[model.\"openai/gpt-5.1\"]\ndescription = \"用户手写\"\n";
    let out = patch_grok_config(Some(existing), Some("xai-secret"), &p).unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    let gpt = &doc["model"]["openai/gpt-5.1"];
    assert_eq!(gpt["api_backend"].as_str(), Some("responses"));
    assert_eq!(gpt["name"].as_str(), Some("我的中转 · openai/gpt-5.1"));
    // 用户手写的同段其他字段不动
    assert_eq!(gpt["description"].as_str(), Some("用户手写"));
    assert_eq!(
        doc["model"]["grok-4.5"]["api_backend"].as_str(),
        Some("responses")
    );
    // 权威层（用户覆盖/网关实测）在测试环境为空 → 不写 context_window
    assert!(gpt.get("context_window").is_none());
    assert_eq!(gpt["supports_reasoning_effort"].as_bool(), Some(true));
    assert_eq!(
        gpt["reasoning_efforts"]
            .as_array_of_tables()
            .unwrap()
            .len(),
        4
    );
}

#[test]
fn grok_config_patch_keeps_existing_reasoning_menu() {
    // 手写菜单与显式关闭不覆盖；缺菜单的模型仍补上
    let existing = "\
[model.\"grok-4.7\"]
supports_reasoning_effort = true
reasoning_effort = \"low\"

[[model.\"grok-4.7\".reasoning_efforts]]
value = \"low\"
label = \"Low\"

[model.\"no-think\"]
supports_reasoning_effort = false
";
    let mut p = profile("grok");
    p.models = vec!["grok-4.7".into(), "no-think".into(), "fresh".into()];
    let out = patch_grok_config(Some(existing), None, &p).unwrap();
    let doc: toml_edit::DocumentMut = out.parse().unwrap();
    let kept = doc["model"]["grok-4.7"]["reasoning_efforts"]
        .as_array_of_tables()
        .unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept.get(0).unwrap()["value"].as_str(), Some("low"));
    assert_eq!(
        doc["model"]["grok-4.7"]["reasoning_effort"].as_str(),
        Some("low")
    );
    // 中转目录的显式 false 会压掉菜单，设为全局时改回 true 并补档位
    assert_eq!(
        doc["model"]["no-think"]["supports_reasoning_effort"].as_bool(),
        Some(true)
    );
    assert_eq!(
        doc["model"]["no-think"]["reasoning_efforts"]
            .as_array_of_tables()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(
        doc["model"]["fresh"]["reasoning_efforts"]
            .as_array_of_tables()
            .unwrap()
            .len(),
        4
    );
}

#[test]
fn grok_helper_auth_replaces_plaintext_key() {
    let mut p = profile("grok");
    p.models = vec!["m1".into(), "m2".into()];
    let existing = "[model.mine]\nname = \"我的\"\napi_key = \"sk-user\"\n";
    let out = patch_grok_config(Some(existing), Some("sk-secret"), &p).unwrap();
    let helper = Path::new("/Users/x/Library/Application Support/ccode/bin/mesa_helper");
    let out = grok_helper_auth(&out, helper, "gw-1234abcd-ef", "sk-secret").unwrap();
    assert!(!out.contains("sk-secret"), "明文密钥不落盘");
    let doc: toml::Value = toml::from_str(&out).unwrap();
    for m in ["m1", "m2"] {
        assert_eq!(doc["model"][m]["auth_provider"].as_str(), Some("mesa-gw1234ab"));
        assert!(doc["model"][m].get("api_key").is_none());
    }
    assert_eq!(doc["model"]["mine"]["api_key"].as_str(), Some("sk-user"), "用户自己的段不动");
    let ap = &doc["auth_provider"]["mesa-gw1234ab"];
    assert_eq!(ap["command"].as_str(), Some("/Users/x/Library/Application Support/ccode/bin/mesa_helper"));
    assert_eq!(ap["args"].as_array().unwrap().len(), 2);
    assert_eq!(ap["args"][1].as_str(), Some("gw-1234abcd-ef"));
    // 官方切回：带 auth_provider 的中转段与带自己密钥的一样留着（老会话续聊要用）
    let off: toml::Value = toml::from_str(&patch_grok_config_official(&out).unwrap()).unwrap();
    assert!(off["model"].get("m1").is_some());
}

#[test]
fn grok_patch_removes_only_mesa_written_endpoint() {
    let mut p = profile("grok");
    p.models = vec!["m1".into()];
    // 以前 Mesa 写的（等于这次连接的地址）撤，连同空了的 [endpoints]
    let old = "[endpoints]\nmodels_base_url = \"https://relay.example.com/\"\n";
    let doc: toml_edit::DocumentMut = patch_grok_config(Some(old), Some("k"), &p).unwrap().parse().unwrap();
    assert!(doc.get("endpoints").is_none());
    // 等于 Mesa 模型段（「配置名 · 模型」）地址的也是 Mesa 的；用户自己设的另一个地址与同表别的键不动
    let other = "[endpoints]\nmodels_base_url = \"https://old-relay/v1\"\n[model.x]\nname = \"旧连接 · x\"\nbase_url = \"https://old-relay/v1\"\n";
    let doc: toml_edit::DocumentMut = patch_grok_config(Some(other), Some("k"), &p).unwrap().parse().unwrap();
    assert!(doc.get("endpoints").is_none());
    let user = "[endpoints]\nmodels_base_url = \"https://mine/v1\"\nfeedback_base_url = \"https://f\"\n";
    let doc: toml_edit::DocumentMut = patch_grok_config(Some(user), Some("k"), &p).unwrap().parse().unwrap();
    assert_eq!(doc["endpoints"]["models_base_url"].as_str(), Some("https://mine/v1"));
}

#[test]
fn grok_plan_writes_targets_grok_config_toml() {
    let home = tmpdir("grok-plan");
    let p = profile("grok");
    let plans = plan_writes(&home, &p, Some("xai-secret"), &["m1".to_string()]).unwrap();
    assert_eq!(plans.len(), 1);
    assert!(plans[0].path.ends_with(".grok/config.toml"));
    let doc: toml::Value = toml::from_str(&plans[0].content).unwrap();
    assert_eq!(doc["model"]["m1"]["api_key"].as_str(), Some("xai-secret"));
    assert!(doc.get("api_key").is_none());
    assert!(!plans[0].content.contains("models_base_url"));
    fs::remove_dir_all(&home).ok();
}

#[test]
fn kimi_plan_writes_existing_variant_dirs() {
    let home = tmpdir("kimi-dirs");
    let p = profile("kimi");
    // 都不存在 → 只写新版目录
    let plans = plan_writes(&home, &p, None, &["m1".to_string()]).unwrap();
    assert_eq!(plans.len(), 1);
    assert!(plans[0].path.ends_with(".kimi-code/config.toml"));
    // 只有旧版目录 → 只写旧版
    fs::create_dir_all(home.join(".kimi")).unwrap();
    let plans = plan_writes(&home, &p, None, &["m1".to_string()]).unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].tag, "legacy-config.toml");
    assert!(plans[0].content.contains("max_context_size"), "旧版官方文档同样要求 max_context_size");
    // 两者都有 → 都写
    fs::create_dir_all(home.join(".kimi-code")).unwrap();
    let plans = plan_writes(&home, &p, None, &["m1".to_string()]).unwrap();
    assert_eq!(plans.len(), 2);
    fs::remove_dir_all(&home).ok();
}

#[test]
fn apply_creates_backup_and_restore_brings_back_newest() {
    let home = tmpdir("apply-home");
    let backups = tmpdir("apply-bak");
    let target_dir = home.join(".claude");
    fs::create_dir_all(&target_dir).unwrap();
    let target = target_dir.join("settings.json");
    fs::write(&target, r#"{"env": {"OTHER": "1"}}"#).unwrap();

    let p = profile("claude-code");
    let plans = plan_writes(&home, &p, Some("sk-secret"), &["m1".to_string()]).unwrap();
    let written = apply_plans("claude-code", &backups, &home, &plans).unwrap();
    assert_eq!(written, vec!["~/.claude/settings.json".to_string()]);
    // 原文件被备份，新内容已写入
    let baks = list_backups(&backups, "settings.json");
    assert_eq!(baks.len(), 1);
    let new_content = fs::read_to_string(&target).unwrap();
    assert!(new_content.contains("ANTHROPIC_AUTH_TOKEN"));
    // 再改一次并重新应用：第二批清单记录 v2，restore 应按完整批次恢复它
    fs::write(&target, r#"{"v": 2}"#).unwrap();
    let plans = plan_writes(&home, &p, Some("sk-secret-2"), &["m1".to_string()]).unwrap();
    apply_plans("claude-code", &backups, &home, &plans).unwrap();
    let restored = restore_from(&backups, &home, "claude-code").unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(fs::read_to_string(&target).unwrap(), r#"{"v": 2}"#);
    // 恢复前的当前状态也生成一批备份；原恢复点不会被消费，可再次恢复撤销本次操作
    assert!(list_backups(&backups, "settings.json").len() >= 3);
    assert!(manifest_files(&backups).len() >= 3);
    fs::remove_dir_all(&home).ok();
    fs::remove_dir_all(&backups).ok();
}

#[test]
fn transaction_rolls_back_all_targets_when_later_replace_fails() {
    let dir = tmpdir("rollback");
    let a = dir.join("a.json");
    let b = dir.join("b.json");
    fs::write(&a, "old-a").unwrap();
    fs::write(&b, "old-b").unwrap();
    let actions = vec![
        TxAction {
            tag: "a".into(),
            path: a.clone(),
            content: Some(b"new-a".to_vec()),
        },
        TxAction {
            tag: "b".into(),
            path: b.clone(),
            content: Some(b"new-b".to_vec()),
        },
    ];
    let id = batch_id();
    let originals = actions
        .iter()
        .map(|a| fs::read(&a.path).ok())
        .collect::<Vec<_>>();
    let staged = stage_actions(&actions, &id).unwrap();
    let err = commit_actions_with(&actions, &staged, &originals, &id, |from, to, i| {
        if i == 1 {
            Err(std::io::Error::other("injected failure"))
        } else {
            fs::rename(from, to)
        }
    })
    .unwrap_err();
    assert!(err.contains("已自动回滚全部目标文件"), "{err}");
    assert_eq!(fs::read_to_string(&a).unwrap(), "old-a");
    assert_eq!(fs::read_to_string(&b).unwrap(), "old-b");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn restore_removes_file_that_did_not_exist_before_apply() {
    let home = tmpdir("restore-absent-home");
    let backups = tmpdir("restore-absent-bak");
    let target = home.join(".gemini/.env");
    let p = profile("gemini");
    let plans = plan_writes(&home, &p, Some("secret"), &["m1".to_string()]).unwrap();
    apply_plans("gemini", &backups, &home, &plans).unwrap();
    assert!(target.exists());
    restore_from(&backups, &home, "gemini").unwrap();
    assert!(!target.exists(), "应用前不存在的文件恢复时应被移除");
    fs::remove_dir_all(&home).ok();
    fs::remove_dir_all(&backups).ok();
}

#[test]
fn original_snapshot_survives_rotations_and_restores_first_write_state() {
    let home = tmpdir("orig-home");
    let backups = tmpdir("orig-bak");
    let target_dir = home.join(".claude");
    fs::create_dir_all(&target_dir).unwrap();
    let target = target_dir.join("settings.json");
    // Mesa 动手前的原始内容
    fs::write(&target, r#"{"env": {"OTHER": "1"}}"#).unwrap();
    let p = profile("claude-code");
    // 连续 7 次 apply：常规批次窗口（5 份）被烧穿，原始快照必须始终在场
    for _ in 0..7 {
        let plans = plan_writes(&home, &p, Some("sk-secret"), &["m1".to_string()]).unwrap();
        apply_plans("claude-code", &backups, &home, &plans).unwrap();
    }
    assert!(list_backups(&backups, "settings.json").len() <= 5);
    assert_eq!(
        fs::read_to_string(original_dir(&backups).join("settings.json")).unwrap(),
        r#"{"env": {"OTHER": "1"}}"#,
        "原始快照必须保持首次写入前的内容"
    );
    // 恢复初始状态 = 回到首次写入前
    restore_from_original(&backups, &home).unwrap();
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        r#"{"env": {"OTHER": "1"}}"#
    );
    // 原始快照不被恢复动作消耗，可再次恢复
    assert!(original_dir(&backups).join("manifest.json").is_file());
    fs::remove_dir_all(&home).ok();
    fs::remove_dir_all(&backups).ok();
}

#[test]
fn restore_original_removes_file_created_by_first_apply() {
    let home = tmpdir("orig-absent-home");
    let backups = tmpdir("orig-absent-bak");
    let target = home.join(".gemini/.env");
    let p = profile("gemini");
    let plans = plan_writes(&home, &p, Some("secret"), &["m1".to_string()]).unwrap();
    apply_plans("gemini", &backups, &home, &plans).unwrap();
    assert!(target.exists());
    restore_from_original(&backups, &home).unwrap();
    assert!(
        !target.exists(),
        "首次写入前不存在的文件，恢复初始状态时应删除"
    );
    fs::remove_dir_all(&home).ok();
    fs::remove_dir_all(&backups).ok();
}

#[test]
fn backup_rotation_keeps_newest_five() {
    let dir = tmpdir("rotation");
    let target = dir.join("f.json");
    fs::write(&target, "{}").unwrap();
    for i in 0..7 {
        backup_file_with_ts(&dir, "f.json", &target, &format!("2026010{i}-000000")).unwrap();
    }
    let mut baks = list_backups(&dir, "f.json");
    baks.sort();
    assert_eq!(baks.len(), 5);
    assert_eq!(baks[0], "f.json.20260102-000000.bak");
    assert_eq!(baks[4], "f.json.20260106-000000.bak");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn timestamp_formats_utc() {
    let (y, m, d) = civil_from_days(20454); // 2026-01-01
    assert_eq!((y, m, d), (2026, 1, 1));
    assert_eq!(timestamp_now().len(), 15); // yyyymmdd-hhmmss
}

#[test]
fn disk_matches_plans_uses_json_subset_not_full_trim() {
    let dir = tmpdir("dry-subset");
    let path = dir.join("settings.json");
    fs::write(
        &path,
        "{\n  \"env\": {\"A\": \"1\"},\n  \"theme\": \"dark\"\n}\n",
    )
    .unwrap();
    let planned = PlannedWrite {
        tag: "settings.json",
        path: path.clone(),
        content: "{\"env\":{\"A\":\"1\"}}".into(),
    };
    assert!(disk_matches_plans(&[planned]), "CLI 多出来的键不算漂移");
    fs::write(&path, "{\"env\":{\"A\":\"2\"}}").unwrap();
    let planned2 = PlannedWrite {
        tag: "settings.json",
        path,
        content: "{\"env\":{\"A\":\"1\"}}".into(),
    };
    assert!(!disk_matches_plans(&[planned2]));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn preview_lists_removed_claude_slots_and_redacts_token() {
    let dir = tmpdir("preview-claude");
    let path = dir.join(".claude/settings.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{
          "env": {
            "ANTHROPIC_MODEL": "old-default",
            "ANTHROPIC_AUTH_TOKEN": "sk-secret-abcdef",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "m1",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "m2",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "m3"
          }
        }"#,
    )
    .unwrap();
    let planned = pc(
        Some(&fs::read_to_string(&path).unwrap()),
        None,
        Some("sk-secret-abcdef"),
        &["only-one".to_string()],
        None,
        None,
    )
    .unwrap();
    let preview = preview_plans(
        &dir,
        "claude-code",
        &[PlannedWrite {
            tag: "settings.json",
            path: path.clone(),
            content: planned,
        }],
        vec![],
        vec![],
    );
    assert_eq!(preview.files.len(), 1);
    assert_eq!(preview.files[0].action, "modify");
    assert!(preview.files[0]
        .changes
        .iter()
        .any(|c| { c.path == "env.ANTHROPIC_MODEL" && c.op == "remove" }));
    assert!(preview.files[0]
        .changes
        .iter()
        .any(|c| { c.path == "env.ANTHROPIC_DEFAULT_OPUS_MODEL" && c.op == "modify" }));
    let token = preview.files[0]
        .changes
        .iter()
        .find(|c| c.path.contains("AUTH_TOKEN"));
    if let Some(c) = token {
        assert_eq!(c.after.as_deref(), Some("（已脱敏）"));
    }
    assert!(preview.restart_note.contains("新开"));
    assert!(preview.scope_note.contains("不会改 Mesa 启动栏"));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn skipped_policy_notes_cover_tui_and_extra_env() {
    let mut p = profile("kimi");
    p.protocol = Some("openai".into());
    p.request_policy.reasoning_effort = Some("high".into());
    p.extra_env
        .insert("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into());
    let notes = skipped_policy_notes(&p);
    assert!(notes.iter().any(|n| n.contains("思考档")));
    assert!(notes.iter().any(|n| n.contains("附加环境变量")));
}

#[test]
fn merge_jsonc_keys_keeps_comments_and_order() {
    let original = r#"{
  // 用户自己的主题
  "ui": { "theme": "GitHub" },
  /* Mesa 管的 */
  "model": { "name": "old" },
  "stale": 1,
}"#;
    let new_content = r#"{"ui":{"theme":"GitHub"},"model":{"name":"m1"},"fresh":true}"#;
    let out = merge_jsonc_keys(original, new_content).unwrap();
    assert!(out.contains("// 用户自己的主题") && out.contains("/* Mesa 管的 */"));
    assert!(out.find("\"ui\"").unwrap() < out.find("\"model\"").unwrap());
    assert!(!out.contains("stale") && out.contains("\"m1\"") && out.contains("\"fresh\""));
    let back: Value = serde_json::from_str(&crate::mcp::strip_jsonc(&out)).unwrap();
    assert_eq!(back, serde_json::from_str::<Value>(new_content).unwrap());
    assert!(merge_jsonc_keys("[1]", new_content).is_err());
    // 只有头部注释的空配置也能原地补出根对象并保留注释
    let comment_only = merge_jsonc_keys("// 头部注释\n", r#"{"a":1}"#).unwrap();
    assert!(comment_only.contains("// 头部注释"));
    assert_eq!(
        serde_json::from_str::<Value>(&crate::mcp::strip_jsonc(&comment_only)).unwrap(),
        json!({"a": 1})
    );
}

#[test]
fn apply_plans_keeps_jsonc_comments_but_rewrites_strict_json() {
    let home = tmpdir("jsonc-keep");
    let commented = home.join("settings.json");
    let strict_agent = home.join("claude-settings.json");
    let plain = home.join("opencode.json");
    fs::write(&commented, "{\n  // 留着\n  \"x\": 1,\n}\n").unwrap();
    fs::write(&strict_agent, "{\n  // Claude 不认注释\n  \"x\": 1,\n}\n").unwrap();
    fs::write(&plain, "{\"x\": 1}").unwrap();
    let gemini_plans = vec![PlannedWrite {
        tag: "settings.json",
        path: commented.clone(),
        content: r#"{"x":2}"#.into(),
    }];
    apply_plans("gemini", &home.join("bk-g"), &home, &gemini_plans).unwrap();
    let a = fs::read_to_string(&commented).unwrap();
    assert!(a.contains("// 留着") && a.contains('2'));
    assert!(disk_equals_plans(&gemini_plans));

    // Claude Code 等只认严格 JSON 的目标绝不保留注释
    let claude_plans = vec![PlannedWrite {
        tag: "settings.json",
        path: strict_agent.clone(),
        content: r#"{"x":2}"#.into(),
    }];
    apply_plans("claude-code", &home.join("bk-c"), &home, &claude_plans).unwrap();
    assert_eq!(fs::read_to_string(&strict_agent).unwrap(), r#"{"x":2}"#);

    let oc_plans = vec![PlannedWrite {
        tag: "opencode.json",
        path: plain.clone(),
        content: r#"{"x":2}"#.into(),
    }];
    apply_plans("opencode", &home.join("bk-o"), &home, &oc_plans).unwrap();
    assert_eq!(fs::read_to_string(&plain).unwrap(), r#"{"x":2}"#);
    fs::remove_dir_all(&home).ok();
}

#[test]
fn qwen_and_preview_handle_jsonc_and_redact_secrets_per_field() {
    let home = tmpdir("jsonc-qwen-preview");
    let qwen_dir = home.join(".qwen");
    fs::create_dir_all(&qwen_dir).unwrap();
    let settings = qwen_dir.join("settings.json");
    fs::write(
        &settings,
        "{\n  // 用户备注\n  \"ui\": { \"theme\": \"dark\", },\n}\n",
    )
    .unwrap();
    let p = profile("qwen");
    let mut plans = plan_writes(&home, &p, Some("custom-relay-secret-9999"), &p.models).unwrap();
    keep_jsonc_layout_in_preview("qwen", &mut plans);
    assert!(plans[0].content.contains("// 用户备注"));
    let preview = preview_plans(&home, "qwen", &plans, vec![], vec![]);
    let changes = &preview.files[0].changes;
    assert!(
        !changes.iter().any(|c| c.path == "(全文)"),
        "JSONC 必须按键展开而非退回 (全文)"
    );
    let dumped = serde_json::to_string(&preview).unwrap();
    assert!(
        !dumped.contains("custom-relay-secret-9999"),
        "非标准前缀密钥也必须按字段名脱敏: {dumped}"
    );
    apply_plans("qwen", &home.join("bk-q"), &home, &plans).unwrap();
    let on_disk = fs::read_to_string(&settings).unwrap();
    assert!(on_disk.contains("// 用户备注"));
    let off = patch_qwen_settings_official(&on_disk).unwrap();
    assert!(!off.contains("custom-relay-secret-9999"));

    // opencode.jsonc 整份比对与按键展开同样认 .jsonc 后缀
    let oc = home.join("opencode.jsonc");
    fs::write(&oc, "{\n  // note\n  \"model\": \"m1\",\n}\n").unwrap();
    let oc_plan = PlannedWrite {
        tag: "opencode.jsonc",
        path: oc.clone(),
        content: "{\"model\":\"m1\"}\n".into(),
    };
    assert!(disk_equals_plans(&[oc_plan]));
    let flat = flatten_content(&oc, &fs::read_to_string(&oc).unwrap());
    assert_eq!(flat.get("model").map(String::as_str), Some("m1"));
    fs::remove_dir_all(&home).ok();
}
