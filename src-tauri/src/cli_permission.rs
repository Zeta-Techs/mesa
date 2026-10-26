//! 各家 CLI 本机默认权限的只读探查（聊天权限菜单用，2026-10-17）。
//!
//! 聊天权限菜单四档（先出方案 / 请求批准 / 帮我批准 / 完全访问）。用户没手动选时按这家 CLI 本机设置启动，
//! 菜单要如实标出本机设置对应哪一档——例：用户本机 Claude 设了 bypassPermissions，「完全访问」打勾并标「本机设置」。
//! 只读：CLI 配置目录一律只读（AGENTS.md），这里不改任何设置。读不到 / 没设返回 None。

use std::path::{Path, PathBuf};

/// tier = 对应聊天权限菜单的哪一档（discuss / ask / auto / full），认不出对应哪档为 None（菜单不打勾，只在底部写本机设置）；
/// short = 徽标上的两三个字；detail = 悬浮 / 菜单里的整句
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CliPermissionNote {
    pub tier: Option<String>,
    pub short: String,
    pub detail: String,
}

fn note(tier: Option<&str>, short: &str, detail: &str) -> Option<CliPermissionNote> {
    Some(CliPermissionNote {
        tier: tier.map(str::to_string),
        short: short.into(),
        detail: detail.into(),
    })
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn claude_note(config_dir: &Path) -> Option<CliPermissionNote> {
    let text = std::fs::read_to_string(config_dir.join("settings.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let mode = v.get("permissions")?.get("defaultMode")?.as_str()?;
    match mode {
        "bypassPermissions" => note(
            Some("full"),
            "完全访问",
            "本机 Claude Code 设为自动批准全部操作：改文件、跑命令都不先问",
        ),
        "auto" => note(
            Some("auto"),
            "帮我批准",
            "本机 Claude Code 设为自动判断：普通操作直接做，有风险的才问你",
        ),
        "default" | "manual" => note(Some("ask"), "请求批准", "本机 Claude Code 设为改文件、跑命令前都先问"),
        "plan" => note(Some("discuss"), "先出方案", "本机 Claude Code 默认计划模式：先出方案，你点头再动手"),
        "acceptEdits" => note(None, "自动改文件", "本机 Claude Code 设为自动接受改文件，跑命令仍会先问"),
        "dontAsk" => note(None, "不问就拒绝", "本机 Claude Code 设为 dontAsk：白名单外的操作直接拒绝"),
        _ => None,
    }
}

/// Mesa 启动 Codex 一律带 `-s workspace-write`（agents.rs 默认沙箱），本机 sandbox_mode 被盖掉，
/// 只有 approval_policy 还算数：原先把「never + danger-full-access」报成完全访问是错的
fn codex_note(codex_home: &Path) -> Option<CliPermissionNote> {
    let text = std::fs::read_to_string(codex_home.join("config.toml")).ok()?;
    let v: toml::Value = toml::from_str(&text).ok()?;
    match v.get("approval_policy").and_then(|x| x.as_str())? {
        "never" => note(
            None,
            "不审批",
            "本机 Codex 设为不审批：在 Mesa 的默认沙箱（只能改当前目录）里不问就做",
        ),
        "on-request" | "untrusted" => note(Some("ask"), "请求批准", "本机 Codex 设为需要时先问你"),
        "on-failure" => note(None, "失败才问", "本机 Codex 设为命令失败时才问你"),
        _ => None,
    }
}

/// Grok 的默认权限在 ~/.grok/config.toml 的 [ui].permission_mode / [ui].yolo（1.0.62 本机实例：
/// permission_mode = "always-approve"，即每个 Grok 会话都不经确认就动手）
fn grok_note(grok_home: &Path) -> Option<CliPermissionNote> {
    let text = std::fs::read_to_string(grok_home.join("config.toml")).ok()?;
    let v: toml::Value = toml::from_str(&text).ok()?;
    let ui = v.get("ui")?;
    if ui.get("yolo").and_then(|x| x.as_bool()) == Some(true) {
        return note(Some("full"), "完全访问", "本机 Grok 设为 yolo：改文件、跑命令都不先问");
    }
    match ui.get("permission_mode").and_then(|x| x.as_str())? {
        "always-approve" | "bypassPermissions" => note(
            Some("full"),
            "完全访问",
            "本机 Grok 设为全部自动批准：改文件、跑命令都不先问",
        ),
        "auto" => note(Some("auto"), "帮我批准", "本机 Grok 设为自动判断：普通操作直接做，有风险的才问你"),
        "acceptEdits" => note(None, "自动改文件", "本机 Grok 设为自动接受改文件，跑命令仍会先问"),
        "default" | "ask" => note(Some("ask"), "请求批准", "本机 Grok 设为改文件、跑命令前都先问"),
        "plan" => note(Some("discuss"), "先出方案", "本机 Grok 默认计划模式：先出方案，不直接动手"),
        _ => None,
    }
}

fn note_at(home: &Path, agent: &str) -> Option<CliPermissionNote> {
    match agent {
        "grok" => grok_note(&env_dir("GROK_HOME").unwrap_or_else(|| home.join(".grok"))),
        "claude-code" => {
            claude_note(&env_dir("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude")))
        }
        "codex" => codex_note(&env_dir("CODEX_HOME").unwrap_or_else(|| home.join(".codex"))),
        _ => None,
    }
}

#[tauri::command]
pub fn cli_default_permission(agent: String) -> Option<CliPermissionNote> {
    note_at(&dirs::home_dir()?, &agent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-cliperm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn claude_default_mode_maps_to_menu_tier() {
        let home = scratch();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let write = |mode: &str| {
            std::fs::write(
                home.join(".claude/settings.json"),
                format!(r#"{{"permissions":{{"defaultMode":"{mode}"}}}}"#),
            )
            .unwrap();
            claude_note(&home.join(".claude"))
        };
        let full = write("bypassPermissions").unwrap();
        assert_eq!((full.tier.as_deref(), full.short.as_str()), (Some("full"), "完全访问"));
        assert!(full.detail.contains("自动批准全部"));
        assert_eq!(write("auto").unwrap().tier.as_deref(), Some("auto"));
        assert_eq!(write("manual").unwrap().tier.as_deref(), Some("ask"));
        // acceptEdits 不对应四档里任何一档：不打勾，只写本机设置
        let edits = write("acceptEdits").unwrap();
        assert_eq!((edits.tier, edits.short.as_str()), (None, "自动改文件"));
        std::fs::write(home.join(".claude/settings.json"), r#"{"permissions":{}}"#).unwrap();
        assert_eq!(claude_note(&home.join(".claude")), None);
    }

    #[test]
    fn codex_only_approval_policy_counts_because_mesa_forces_sandbox() {
        let home = scratch();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(
            home.join(".codex/config.toml"),
            "approval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\n",
        )
        .unwrap();
        let n = codex_note(&home.join(".codex")).unwrap();
        assert_eq!(n.tier, None, "Mesa 带 -s workspace-write 启动，本机 danger-full-access 不生效，不能报完全访问");
        assert_eq!(n.short, "不审批");
        std::fs::write(home.join(".codex/config.toml"), "approval_policy = \"on-request\"\n").unwrap();
        assert_eq!(codex_note(&home.join(".codex")).unwrap().tier.as_deref(), Some("ask"));
        std::fs::write(home.join(".codex/config.toml"), "model = \"x\"\n").unwrap();
        assert_eq!(codex_note(&home.join(".codex")), None);
        assert_eq!(note_at(&home, "gemini"), None);
    }

    #[test]
    fn grok_ui_permission_mode_is_reported() {
        let home = scratch();
        std::fs::create_dir_all(home.join(".grok")).unwrap();
        std::fs::write(home.join(".grok/config.toml"), "[ui]\npermission_mode = \"always-approve\"\n").unwrap();
        let n = grok_note(&home.join(".grok")).unwrap();
        assert_eq!((n.tier.as_deref(), n.short.as_str()), (Some("full"), "完全访问"));
        std::fs::write(home.join(".grok/config.toml"), "[ui]\nyolo = false\n").unwrap();
        assert_eq!(grok_note(&home.join(".grok")), None);
    }
}
