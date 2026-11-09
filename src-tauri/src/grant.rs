//! 授权范围（2026-11-08，`docs/design-autonomy-roadmap.md` §4）：开工时圈定这件活能写哪里、能不能联网、最多花多少，
//! 范围内 AI 不逐条问，越界的被 CLI 自己的沙箱拦下。v1 落在**定时任务**（无人值守、原先全权限跑）。
//!
//! 能落实到哪一步取决于各家 CLI（design §3.1）：
//! - Codex：系统层沙箱，写只限工作目录 + writable_roots；联网只有开 / 关（学术清单按开）。
//! - Claude Code（macOS / Linux）：`--settings` 的 sandbox 段——bash 在系统沙箱里跑，写只限工作目录 + allowWrite，
//!   联网只放行 allowedDomains；文件工具 acceptEdits 只改工作目录；WebFetch 按域名放行；`--max-budget-usd` 原生预算。
//!   Windows 上它的沙箱不可用 → 退回全权限并如实写明。
//! - 其余各家：没有可用的限制手段 → 照旧全权限，写明「这家做不到」。
//!
//! 真正要紧的门（学校会话、密钥）不靠这里：凭证只在 Mesa 手里，不进 Agent 环境。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Network {
    /// 不联网（只能用 Mesa 的工具出门）
    MesaOnly,
    /// 只放行学术检索与开放获取站点
    #[default]
    Academic,
    /// 不限
    Open,
}

/// 学术检索与开放获取常用站点（Claude 沙箱放行；WebFetch 按域名放行）
pub const ACADEMIC_DOMAINS: &[&str] = &[
    "api.openalex.org",
    "api.crossref.org",
    "export.arxiv.org",
    "arxiv.org",
    "api.unpaywall.org",
    "doi.org",
    "api.semanticscholar.org",
    "eutils.ncbi.nlm.nih.gov",
    "pubmed.ncbi.nlm.nih.gov",
    "www.ncbi.nlm.nih.gov",
    "pmc.ncbi.nlm.nih.gov",
    "europepmc.org",
    "www.ebi.ac.uk",
    "www.biorxiv.org",
    "api.biorxiv.org",
    "www.medrxiv.org",
    "chemrxiv.org",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    #[serde(default)]
    pub network: Network,
    /// 这一次最多花多少（美元，按官方价）；None = 不设
    #[serde(default)]
    pub budget_usd: Option<f64>,
}

impl Grant {
    /// 没设授权的老路径（目标无头运行等）：照旧全权限
    pub fn legacy_open() -> Self {
        Grant { network: Network::Open, budget_usd: None }
    }

    pub fn network_label(&self) -> &'static str {
        match self.network {
            Network::MesaOnly => "不联网",
            Network::Academic => "只访问学术网站",
            Network::Open => "不限制",
        }
    }
}

/// 一家 CLI 按这份授权实际做到的
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GrantPlan {
    /// 取代原先「全权限」那几个参数的参数（加在无头参数里）
    pub args: Vec<String>,
    /// 要并进 Claude `--settings` 覆盖文件的键（sandbox 段）
    pub claude_settings: Option<serde_json::Value>,
    /// 人话：这家落实了什么、没落实什么（记进 Run 事实、显示在界面上）
    pub summary: String,
    /// 系统层是否真的限住了写与联网
    pub enforced: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantPreviewDto {
    pub summary: String,
    pub enforced: bool,
}

/// 界面上「这家按这份授权能做到什么」：与真正启动时同一个 plan_for
#[tauri::command]
pub fn grant_preview(agent: String, grant: Grant) -> GrantPreviewDto {
    let p = plan_for(&agent, &grant, &[], cfg!(windows));
    GrantPreviewDto { summary: p.summary, enforced: p.enforced }
}

/// 预算能落实到哪：Claude 有原生参数；能预先锁定会话 id 的 Mesa 能边跑边算（ai::BudgetWatch）；其余只记录
fn budget_note(g: &Grant, agent: &str) -> String {
    let Some(b) = g.budget_usd else { return String::new() };
    if agent == "claude-code" {
        format!("；花到 ${b:.2} 自己停")
    } else if crate::agent_specs::agent_spec(agent).is_some_and(|s| s.fixed_session_id) {
        format!("；花到 ${b:.2} 由 Mesa 停下")
    } else {
        format!("；这家跑的时候算不出花费，${b:.2} 的上限只记录、不会中途停")
    }
}

/// 定时任务这类「要写文件、没人盯着」的无头运行，按授权给出权限相关参数。
/// `windows` 显式传参（纯函数，单测不随宿主变）。
pub fn plan_for(agent: &str, g: &Grant, write_dirs: &[String], windows: bool) -> GrantPlan {
    match agent {
        "codex" => {
            let net = matches!(g.network, Network::Academic | Network::Open);
            let mut args = vec![
                "-s".into(),
                "workspace-write".into(),
                "-c".into(),
                format!("sandbox_workspace_write.network_access={net}"),
            ];
            if !write_dirs.is_empty() {
                let roots = write_dirs.iter().map(|d| format!("{d:?}")).collect::<Vec<_>>().join(",");
                args.extend(["-c".into(), format!("sandbox_workspace_write.writable_roots=[{roots}]")]);
            }
            let net_text = match g.network {
                Network::MesaOnly => "不联网",
                Network::Academic => "联网不限（Codex 只能整体开关联网，没法只放学术网站）",
                Network::Open => "联网不限",
            };
            GrantPlan {
                args,
                claude_settings: None,
                summary: format!("Codex 会拦住工作副本以外的写入；{net_text}{}", budget_note(g, agent)),
                enforced: true,
            }
        }
        "claude-code" if g.network != Network::Open && !windows => {
            let domains: Vec<&str> = match g.network {
                Network::Academic => ACADEMIC_DOMAINS.to_vec(),
                _ => Vec::new(),
            };
            let mut args = vec!["--permission-mode".into(), "acceptEdits".into()];
            for d in write_dirs {
                args.extend(["--add-dir".into(), d.clone()]);
            }
            // Bash 整体预先放行：命令都在系统沙箱里跑（写只限工作目录、联网只限名单），边界由沙箱守；
            // 不放行时带查询串的 curl（雷达每个接口都有）会被权限层要求确认，无人值守就是直接拒（2026-11-08 真跑实证）
            match g.network {
                Network::Academic => {
                    let mut tools: Vec<String> = vec!["Bash".into()];
                    tools.extend(ACADEMIC_DOMAINS.iter().map(|d| format!("WebFetch(domain:{d})")));
                    tools.push("WebSearch".into());
                    args.push("--allowedTools".into());
                    args.extend(tools);
                }
                _ => {
                    args.extend(["--allowedTools".into(), "Bash".into()]);
                    args.extend(["--disallowedTools".into(), "WebFetch".into(), "WebSearch".into()]);
                }
            }
            if let Some(b) = g.budget_usd {
                args.extend(["--max-budget-usd".into(), format!("{b:.2}")]);
            }
            let settings = serde_json::json!({
                "sandbox": {
                    "enabled": true,
                    "autoAllowBashIfSandboxed": true,
                    "allowUnsandboxedCommands": false,
                    "network": { "allowedDomains": domains },
                    "filesystem": { "allowWrite": write_dirs },
                }
            });
            GrantPlan {
                args,
                claude_settings: Some(settings),
                summary: format!(
                    "Claude Code 会拦住工作副本以外的写入，{}{}",
                    if g.network == Network::Academic { "也拦住学术网站以外的访问" } else { "也不让联网" },
                    budget_note(g, agent)
                ),
                enforced: true,
            }
        }
        "claude-code" => {
            let mut args = vec!["--permission-mode".into(), "bypassPermissions".into()];
            if let Some(b) = g.budget_usd {
                args.extend(["--max-budget-usd".into(), format!("{b:.2}")]);
            }
            let why = if windows && g.network != Network::Open {
                "Claude Code 在 Windows 上拦不住，这次不加限制"
            } else {
                "Claude Code 不加限制"
            };
            GrantPlan { args, claude_settings: None, summary: format!("{why}{}", budget_note(g, agent)), enforced: false }
        }
        "grok" => GrantPlan {
            args: vec!["--yolo".into()],
            claude_settings: None,
            summary: format!("Grok Build 的限制办法还没核对过，这次不加限制{}", budget_note(g, agent)),
            enforced: false,
        },
        other => GrantPlan {
            args: Vec::new(),
            claude_settings: None,
            summary: format!(
                "{} 没有可用的限制办法，这次不加限制{}",
                crate::agent_specs::agent_spec(other).map(|s| s.display_name.to_string()).unwrap_or_else(|| other.to_string()),
                budget_note(g, agent)
            ),
            enforced: false,
        },
    }
}

/// 把 sandbox 段并进 Claude 的 `--settings` 覆盖文件；没有覆盖文件就新建一个并插到参数最前
pub fn merge_claude_settings(args: &mut Vec<String>, extra: &serde_json::Value) -> Result<(), String> {
    if let Some(i) = args.iter().position(|a| a == "--settings") {
        if let Some(path) = args.get(i + 1).cloned() {
            let text = std::fs::read_to_string(&path).map_err(|e| format!("读取 Claude Code 设置覆盖文件失败: {e}"))?;
            let mut v: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("Claude Code 设置覆盖文件损坏: {e}"))?;
            if let (Some(obj), Some(add)) = (v.as_object_mut(), extra.as_object()) {
                for (k, val) in add {
                    obj.insert(k.clone(), val.clone());
                }
            }
            return std::fs::write(&path, v.to_string()).map_err(|e| format!("写入 Claude Code 设置覆盖文件失败: {e}"));
        }
    }
    let path = crate::agents::write_settings_overlay_file_pub("claude-grant", &extra.to_string())?;
    args.insert(0, path);
    args.insert(0, "--settings".into());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs() -> Vec<String> {
        vec!["/cfg/mesa-tool".to_string()]
    }

    #[test]
    fn codex_network_follows_grant_and_tool_dir_is_writable() {
        let p = plan_for("codex", &Grant { network: Network::MesaOnly, budget_usd: None }, &dirs(), false);
        assert!(p.args.contains(&"sandbox_workspace_write.network_access=false".to_string()));
        assert!(p.args.iter().any(|a| a.contains("writable_roots=[\"/cfg/mesa-tool\"]")));
        assert!(p.enforced);
        let p = plan_for("codex", &Grant::default(), &dirs(), false);
        assert!(p.args.contains(&"sandbox_workspace_write.network_access=true".to_string()));
        assert!(p.summary.contains("没法只放学术网站"));
        let p = plan_for("codex", &Grant { network: Network::Academic, budget_usd: Some(1.0) }, &dirs(), false);
        assert!(p.summary.contains("不会中途停"), "Codex 不能预先锁定会话 id，预算不能说成会中途停");
    }

    #[test]
    fn claude_sandbox_replaces_bypass_except_open_or_windows() {
        let g = Grant { network: Network::Academic, budget_usd: Some(2.0) };
        let p = plan_for("claude-code", &g, &dirs(), false);
        assert!(!p.args.contains(&"bypassPermissions".to_string()));
        assert!(p.args.windows(2).any(|w| w[0] == "--permission-mode" && w[1] == "acceptEdits"));
        assert!(p.args.windows(2).any(|w| w[0] == "--max-budget-usd" && w[1] == "2.00"));
        assert!(p.args.iter().any(|a| a == "WebFetch(domain:api.openalex.org)"));
        assert!(p.args.windows(2).any(|w| w[0] == "--allowedTools" && w[1] == "Bash"));
        let s = p.claude_settings.unwrap();
        assert_eq!(s["sandbox"]["enabled"], true);
        assert_eq!(s["sandbox"]["allowUnsandboxedCommands"], false);
        assert!(s["sandbox"]["network"]["allowedDomains"].as_array().unwrap().iter().any(|d| d == "api.crossref.org"));
        assert_eq!(s["sandbox"]["filesystem"]["allowWrite"][0], "/cfg/mesa-tool");
        // 不联网：WebFetch / WebSearch 也拿掉，命令一个域名都不放
        let p = plan_for("claude-code", &Grant { network: Network::MesaOnly, budget_usd: None }, &dirs(), false);
        assert!(p.args.windows(3).any(|w| w == ["--disallowedTools", "WebFetch", "WebSearch"]));
        assert_eq!(p.claude_settings.unwrap()["sandbox"]["network"]["allowedDomains"].as_array().unwrap().len(), 0);
        // Windows / 联网不限：退回全权限，如实写明
        let p = plan_for("claude-code", &g, &dirs(), true);
        assert!(p.args.contains(&"bypassPermissions".to_string()) && !p.enforced && p.summary.contains("Windows"));
        let p = plan_for("claude-code", &Grant::legacy_open(), &dirs(), false);
        assert!(p.args.contains(&"bypassPermissions".to_string()) && p.claude_settings.is_none());
    }

    #[test]
    fn other_agents_say_what_they_cannot_do() {
        let p = plan_for("kimi", &Grant::default(), &dirs(), false);
        assert!(!p.enforced && p.args.is_empty() && p.summary.contains("没有可用的限制办法"));
        assert!(plan_for("grok", &Grant::default(), &dirs(), false).args.contains(&"--yolo".to_string()));
    }

    #[test]
    fn merge_into_existing_overlay_keeps_env() {
        let path = std::env::temp_dir().join(format!("ccode-grant-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, r#"{"env":{"ANTHROPIC_BASE_URL":"x"}}"#).unwrap();
        let mut args = vec!["--settings".to_string(), path.to_string_lossy().into_owned(), "-p".into()];
        merge_claude_settings(&mut args, &serde_json::json!({"sandbox": {"enabled": true}})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "x");
        assert_eq!(v["sandbox"]["enabled"], true);
        assert_eq!(args.len(), 3);
        let _ = std::fs::remove_file(&path);
    }
}
