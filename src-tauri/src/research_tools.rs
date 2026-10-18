//! 科研外部工具开工检查：只探测，不安装、不写个人库、不启动 GUI。
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCheck {
    name: String,
    status: String,
    detail: String,
    blocking: bool,
}
fn check(name: &str, status: &str, detail: impl Into<String>, blocking: bool) -> ToolCheck {
    ToolCheck {
        name: name.into(),
        status: status.into(),
        detail: detail.into(),
        blocking,
    }
}

/// Zotero 本地通道判定：HTTP 状态码 → (状态, 白话)。None = 请求失败。
/// 任何非明确成功/403 的响应都归 unknown，不猜测写入能力（宁缺毋滥）。
fn zotero_channel(status: Option<u16>) -> (&'static str, &'static str) {
    match status {
        Some(code) if (200..300).contains(&code) => (
            "readable",
            "本地 API 可访问；未请求写库授权，版本与写入权限仍需逐批核对",
        ),
        Some(403) => (
            "disabled",
            "Zotero 本机通信未开启；可继续使用已导入题录/PDF，写库未授权",
        ),
        Some(_) => (
            "unknown",
            "本地服务响应不兼容；不猜测写入能力，使用文件流程",
        ),
        None => (
            "offline",
            "未连到 Zotero；已导入文件仍可用，不阻塞离线文献工作",
        ),
    }
}

/// Origin 门槛：只做 Windows 实机（Mac 虚拟机方案已否决）；非 Windows 且该技能为步骤必需 = 阻塞开工。
fn origin_blocking(windows: bool, required: bool) -> bool {
    !windows && required
}

#[tauri::command]
pub async fn research_tool_preflight(
    project_root: String,
    step_name: String,
    agent: String,
) -> Result<Vec<ToolCheck>, String> {
    let root = crate::projects::ensure_task_project_root(Path::new(
        &crate::sessions::expand_tilde(&project_root),
    ))?;
    let read = crate::projects::read_config_at(&root);
    let parse_warnings: Vec<_> = read
        .warnings
        .iter()
        .filter(|w| !w.starts_with("步骤「"))
        .collect();
    if !parse_warnings.is_empty() {
        return Err(format!(
            "项目配置需先修复：{}",
            parse_warnings
                .into_iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("；")
        ));
    }
    let step = read
        .config
        .steps
        .iter()
        .find(|s| s.name == step_name)
        .ok_or("步骤不存在，请刷新")?;
    let library = crate::skills::list_skills().await;
    let mut out = read
        .warnings
        .iter()
        .enumerate()
        .map(|(i, warning)| check(&format!("步骤提示 {}", i + 1), "advisory", warning, false))
        .collect::<Vec<_>>();
    for name in &step.skills {
        let required = step.required_skills.contains(name);
        let skill = library.iter().find(|s| s.name == *name);
        let available = skill
            .is_some_and(|s| s.apps.get(&agent) == Some(&true) && !s.stale_copies.contains(&agent))
            && crate::skills::snapshot_named_skills(&[name.clone()], &agent).is_ok();
        out.push(check(
            name,
            if available { "available" } else { "missing" },
            if available {
                "已启用到所选 Agent；实际调用仍以运行结果为准"
            } else {
                "技能未安装、未启用到所选 Agent 或副本过期；到技能页检查分发"
            },
            required && !available,
        ));
    }
    if step.skills.iter().any(|s| s == "zotero-sync") {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|e| e.to_string())?;
        let code = client
            .get("http://127.0.0.1:23119/api/")
            .send()
            .await
            .ok()
            .map(|response| response.status().as_u16());
        let (status, detail) = zotero_channel(code);
        out.push(check("Zotero 本地通道", status, detail, false));
    }
    if step.skills.iter().any(|s| s == "origin-plot") {
        let windows = cfg!(windows);
        out.push(check("Origin 执行环境", if windows { "needs-probe" } else { "unsupported" },
            if windows { "Windows 平台符合；运行随包脚本 --probe，再核对 Origin 2021+ 与许可证。此处不会启动 Origin" }
            else { "Origin 执行要求有授权的 Windows 本机；不能在当前平台悄悄替换为 Python 图" }, origin_blocking(windows, step.required_skills.iter().any(|s| s == "origin-plot"))));
    }
    if step.skills.iter().any(|s| s == "blender-research") {
        let probe = crate::mcp_blender::probe_blender_mcp_setup().await?;
        out.push(check(
            "Blender 安装",
            &probe.blender.status,
            probe
                .blender
                .detail
                .unwrap_or_else(|| "未检测到 Blender；可在工具参数里指定安装路径".into()),
            probe.blender.status == "too_old"
                && step.required_skills.iter().any(|s| s == "blender-research"),
        ));
        out.push(check("Blender MCP（交互可选）", &probe.running.status,
            "端口存在不等于目标工程握手。交互需到 MCP 页检测并在新工程核对；后台脚本不依赖 MCP。MCP 无 OS 沙箱", false));
    }
    if step.skills.iter().any(|s| s == "endnote-bridge") {
        out.push(check(
            "EndNote 文件桥",
            "manual-review",
            "转换器不依赖桌面安装；XML/RIS 导入、附件与 Word 插件必须人工验收，不自动控制 EndNote",
            false,
        ));
    }
    if step.skills.iter().any(|s| s == "quarto-render") {
        // 不挡开工（写稿用不到 Quarto），但要在写完才渲染失败之前就说出来
        let quarto = crate::dep_check::probe_quarto();
        // 能找到不等于 Agent 能用：终端里的 Agent 只认 PATH（which），候选目录兜底它看不到
        let on_path = which::which("quarto").is_ok();
        let (status, mut detail) = quarto_check_detail(
            &quarto.status,
            quarto.version.as_deref(),
            quarto.path.as_deref(),
            on_path,
        );
        // 残留环境变量导致的「跑不起来」：照实说原因，别让人去重装
        if let Some(note) = quarto.note {
            detail = note;
        }
        out.push(check("Quarto 渲染", status, detail, false));
    }
    Ok(out)
}

/// Quarto 检查的白话（纯函数，单测钉住）
fn quarto_check_detail(
    status: &str,
    version: Option<&str>,
    path: Option<&str>,
    on_path: bool,
) -> (&'static str, String) {
    match status {
        "ok" if !on_path => (
            "not-on-path",
            format!(
                "Quarto 装在 {}，但不在 PATH 上，终端里的 Agent 调不到 quarto；在 ~/.local/bin 建一个指向它的链接后重开终端",
                path.unwrap_or("未知路径")
            ),
        ),
        "ok" => (
            "available",
            format!("Quarto {}；渲染前仍按技能先跑 quarto check", version.unwrap_or("")),
        ),
        "broken" => (
            "broken",
            format!(
                "找到的 quarto（{}）跑不起来，最后的 PDF/Word 渲染会失败；先装好官方 Quarto，并让它排在这个之前（设置页「依赖」可查）",
                path.unwrap_or("未知路径")
            ),
        ),
        _ => (
            "missing",
            "没装 Quarto，最后的 PDF/Word 渲染会失败；可以先开工写稿，渲染前到设置页「依赖」安装".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quarto_preflight_names_the_broken_binary() {
        assert_eq!(quarto_check_detail("ok", Some("1.6.40"), None, true).0, "available");
        let (status, detail) =
            quarto_check_detail("broken", None, Some("/opt/conda/bin/quarto"), true);
        assert_eq!(status, "broken");
        assert!(detail.contains("/opt/conda/bin/quarto"));
        assert_eq!(quarto_check_detail("missing", None, None, false).0, "missing");
        // 官方 pkg 的 /usr/local/bin 链接没建出来：Mesa 找得到，终端里的 Agent 找不到
        let (status, detail) = quarto_check_detail(
            "ok",
            Some("1.10.19"),
            Some("/Applications/quarto/bin/quarto"),
            false,
        );
        assert_eq!(status, "not-on-path");
        assert!(detail.contains("/Applications/quarto/bin/quarto"));
    }

    #[test]
    fn zotero_channel_maps_status_codes_without_guessing_write() {
        let (status, _) = zotero_channel(Some(200));
        assert_eq!(status, "readable");
        let (status, _) = zotero_channel(Some(204));
        assert_eq!(status, "readable");
        // 403 = 服务在但通信未开启：可用已导入文件，不阻塞
        let (status, _) = zotero_channel(Some(403));
        assert_eq!(status, "disabled");
        // 其他响应不猜测写入能力
        let (status, _) = zotero_channel(Some(500));
        assert_eq!(status, "unknown");
        let (status, _) = zotero_channel(None);
        assert_eq!(status, "offline");
    }

    #[test]
    fn origin_blocks_only_off_windows_with_required_skill() {
        // Windows 实机永不因平台阻塞（后续 probe 才核对版本/许可证）
        assert!(!origin_blocking(true, true));
        assert!(!origin_blocking(true, false));
        // 可选技能在非 Windows 只是提示，不拦开工
        assert!(!origin_blocking(false, false));
        // 非 Windows + 步骤必需 = 明确失败，不悄悄换 Python 图
        assert!(origin_blocking(false, true));
    }

    #[test]
    fn tool_check_serializes_camel_case_for_frontend() {
        let c = check(
            "Origin 执行环境",
            "unsupported",
            "需要授权的 Windows 本机",
            true,
        );
        let json = serde_json::to_value(&c).unwrap();
        assert_eq!(json["name"], "Origin 执行环境");
        assert_eq!(json["status"], "unsupported");
        assert_eq!(json["detail"], "需要授权的 Windows 本机");
        assert_eq!(json["blocking"], serde_json::Value::Bool(true));
    }
}
