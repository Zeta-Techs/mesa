//! 黄金样本：按「最终渲染文本」锁住能力写入的跨层结论。
//!
//! 与逐写入点单测的分工
//! --------------------
//! `agents.rs` / `global_config.rs` 里的测试各自断自己那一段（env 表里有没有某个键、
//! toml 里有没有某个段），它们**互相不知道对方存在**。kimi 那条错的注释能活下来，
//! 正是因为没有任何一条测试把「注册链对一个模型说了什么」和「CLI 实际收到的文本」
//! 对照起来过。
//!
//! 所以这里断的不是「某个函数返回了什么」，而是**用户可见的最终形态**：
//! 启动 env 表、写盘的 toml/json 文本。样本期望值写在
//! `src-tauri/tests/golden/capability_writes.json`，都是人工核对过的（对二进制实证的
//! 那个缺省集），不是跑一遍录下来的。改写期望值前先确认依据。
//!
//! 为什么断言放在 crate 内而不是 `tests/` 目录
//! ------------------------------------------
//! `patch_kimi_config`、`opencode_provider_json` 等写入点是私有/`pub(crate)`，
//! 集成测试够不到。文件放在 `tests/golden/` 只是**数据**的位置约定，读取由本模块完成。
//! Cargo 不会把 `tests/` 下的 .json 当测试目标编译（只认 .rs），所以放这里不会产生
//! 空的测试 target。

#[cfg(test)]
mod tests {
    use serde_json::Value;

    /// `src-tauri/tests/golden/` 的绝对路径。
    /// `CARGO_MANIFEST_DIR` 在测试期指向 src-tauri/，是唯一稳的锚。
    fn golden_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
    }

    fn load(name: &str) -> Value {
        let path = golden_dir().join(name);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读不到黄金样本 {}：{e}", path.display()));
        serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("黄金样本 {} 不是合法 JSON：{e}", path.display()))
    }

    struct Case<'a> {
        id: &'a str,
        raw: &'a Value,
    }

    impl<'a> Case<'a> {
        fn field(&self, key: &str) -> Option<&'a Value> {
            self.raw.get(key)
        }
        fn string(&self, key: &str) -> Option<&'a str> {
            self.raw.get(key).and_then(|v| v.as_str())
        }
        fn string_list(&self, key: &str) -> Vec<&'a str> {
            self.raw
                .get(key)
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default()
        }
        fn required_string(&self, key: &str) -> &'a str {
            self.string(key)
                .unwrap_or_else(|| panic!("样本 {} 缺字段 {key}", self.id))
        }
        /// 样本自带的说明，失败信息里带上，让人直接看懂这例在锁什么。
        fn why(&self) -> &'a str {
            self.raw.get("why").and_then(|v| v.as_str()).unwrap_or("")
        }
    }

    fn cases<'a>(file: &'a Value, key: &str) -> Vec<Case<'a>> {
        file.get(key)
            .and_then(|v| v.as_array())
            .unwrap_or_else(|| panic!("黄金样本缺 {key} 数组"))
            .iter()
            .map(|raw| Case {
                id: raw.get("id").and_then(|v| v.as_str()).unwrap_or("<无 id>"),
                raw,
            })
            .collect()
    }

    fn profile_for(case: &Case<'_>) -> crate::profiles::Profile {
        let agent = case.required_string("agent");
        crate::profiles::Profile {
            id: "golden".into(),
            agent: agent.into(),
            name: "黄金样本".into(),
            account_type: Default::default(),
            no_auth: false,
            protocol: case.string("protocol").map(str::to_string),
            api_backend: None,
            base_url: case.string("base_url").map(str::to_string),
            models: vec![],
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

    /// 启动 env 通道的黄金样本：断最终 env 表。
    #[test]
    fn launch_env_matches_golden() {
        let file = load("capability_writes.json");
        for case in cases(&file, "cases") {
            let profile = profile_for(&case);
            let model = case.string("model");
            let plan = crate::agents::launch_plan(&profile, None, model).unwrap();

            if let Some(expect) = case.field("expect_env").and_then(|v| v.as_object()) {
                for (key, want) in expect {
                    let want = want.as_str().unwrap_or_default();
                    let got = plan
                        .env
                        .iter()
                        .find(|(k, _)| k == key)
                        .map(|(_, v)| v.as_str());
                    assert_eq!(
                        got,
                        Some(want),
                        "样本 {}：env {key} 期望 {want:?}，实际 {got:?}。理由：{}",
                        case.id,
                        case.why()
                    );
                }
            }

            for key in case.string_list("expect_env_absent") {
                assert!(
                    !plan.env.iter().any(|(k, _)| k == key),
                    "样本 {}：env {key} 不该出现。理由：{}",
                    case.id,
                    case.why()
                );
            }

            for needle in case.string_list("expect_args_absent_substring") {
                let joined = plan.args.join(" ");
                assert!(
                    !joined.contains(needle),
                    "样本 {}：args 里不该含 {needle}（实际 args={joined}）。理由：{}",
                    case.id,
                    case.why()
                );
            }
        }
    }

    /// 「设为全局」写盘文本的黄金样本：断最终 toml/json 文本。
    #[test]
    fn global_config_text_matches_golden() {
        let file = load("capability_writes.json");
        for case in cases(&file, "global_config_cases") {
            let agent = case.required_string("agent");
            let text = render_global_config(agent, &case);
            for needle in case.string_list("expect_contains") {
                assert!(
                    text.contains(needle),
                    "样本 {}：写出的文本里应含 {needle}。\n实际文本：\n{text}\n理由：{}",
                    case.id,
                    case.why()
                );
            }
            for needle in case.string_list("expect_not_contains") {
                assert!(
                    !text.contains(needle),
                    "样本 {}：写出的文本里不该含 {needle}。\n实际文本：\n{text}\n理由：{}",
                    case.id,
                    case.why()
                );
            }
        }
    }

    /// 把某个 agent 的全局配置渲染成文本。只覆盖黄金样本用到的三个 agent；
    /// 其余 agent 没有能力键，加进来会得到一个空壳断言，不如不做。
    fn render_global_config(agent: &str, case: &Case<'_>) -> String {
        const BASE: &str = "https://relay.example.com";
        // 模型取自样本，让「这个模型在内置表里是什么」决定渲染结果。
        let models: Vec<String> = case
            .string_list("models")
            .into_iter()
            .map(str::to_string)
            .collect();
        let models = if models.is_empty() {
            vec!["deepseek-chat".to_string()]
        } else {
            models
        };
        match agent {
            "kimi" => crate::global_config::patch_kimi_config(
                Some(""),
                "openai",
                "黄金样本",
                Some(BASE),
                None,
                &models,
                true,
                crate::provider_id::LEGACY,
                None,
            )
            .expect("kimi 全局配置渲染失败"),
            // None = 文件不存在。注意不能传 Some("")：空串不是合法 JSON，gemini 的写入点会
            // 拒绝落盘（"现有 settings.json 解析失败，已停止写入"）——那是正确的 fail-loud，
            // 不是缺陷：宁可什么都不写，也不覆盖一份读不懂的配置。
            "gemini" => crate::global_config::patch_gemini_settings(None, "黄金样本", &models, None)
                .expect("gemini 全局配置渲染失败"),
            other => panic!("黄金样本里出现了没有渲染器的 agent {other}，请补一条"),
        }
    }

    /// 样本文件本身要自洽：id 唯一、why 非空、至少有一种期望。
    /// 防的是「加了一例但什么都没断」——那种样本看着有覆盖率，实际什么都没锁。
    #[test]
    fn golden_file_is_self_consistent() {
        let file = load("capability_writes.json");
        let mut seen = std::collections::HashSet::new();
        let mut total = 0usize;
        for key in ["cases", "global_config_cases"] {
            for case in cases(&file, key) {
                total += 1;
                assert!(seen.insert(case.id.to_string()), "样本 id 重复：{}", case.id);
                assert!(
                    !case.why().is_empty(),
                    "样本 {} 没写 why——它是给人看的依据，不能省",
                    case.id
                );
                assert!(case.string("agent").is_some(), "样本 {} 缺 agent", case.id);
                let has_expectation = [
                    "expect_env",
                    "expect_env_absent",
                    "expect_args_absent_substring",
                    "expect_contains",
                    "expect_not_contains",
                ]
                .iter()
                .any(|k| case.field(k).is_some());
                assert!(has_expectation, "样本 {} 一条期望都没写", case.id);
            }
        }
        assert!(total >= 8, "黄金样本太少了（{total} 条），覆盖不住跨层路径");
    }
}
