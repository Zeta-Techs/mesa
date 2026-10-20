//! 终端字体预设的安装状态检测与一键安装。
//! 检测只扫字体目录文件名（不解析字体文件，小写包含匹配）；安装走 brew cask，
//! 复用 updater 的 PTY 流式机制（防块缓冲、国内镜像加速、key "fonts" 并发互斥、超时）。

use crate::agents;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// 可在应用内安装的字体预设（白名单；SF Mono/Menlo/Consolas 属系统/商业字体，不在范围）
struct FontSpec {
    id: &'static str,
    /// 设置页下拉里的字体名（CSS font-family）
    family: &'static str,
    /// brew cask 名
    cask: &'static str,
    /// 官方发布页：Windows 无 brew，只能指引用户手动下载
    download_url: &'static str,
    /// 文件名小写包含任一关键字即视为已安装
    keywords: &'static [&'static str],
}

static FONT_SPECS: &[FontSpec] = &[
    FontSpec {
        id: "maple",
        family: "Maple Mono NF CN",
        cask: "font-maple-mono-nf-cn",
        download_url: "https://github.com/subframe7536/maple-font/releases",
        keywords: &["maplemono", "maple-mono"],
    },
    FontSpec {
        id: "sarasa",
        family: "Sarasa Mono SC",
        // sarasa-gothic 包含 Mono SC
        cask: "font-sarasa-gothic",
        download_url: "https://github.com/be5invis/Sarasa-Gothic/releases",
        keywords: &["sarasa"],
    },
    FontSpec {
        id: "iosevka",
        family: "Iosevka",
        cask: "font-iosevka",
        download_url: "https://github.com/be5invis/Iosevka/releases",
        keywords: &["iosevka"],
    },
];

fn spec_for(font_id: &str) -> Option<&'static FontSpec> {
    FONT_SPECS.iter().find(|s| s.id == font_id)
}

/// 应用内一键安装只走 brew cask；Windows 没有这条路，前端据 `canInstall` 隐藏「安装」按钮
const CAN_INSTALL: bool = !cfg!(windows);

/// Windows 上的手动安装指引（也是误调 install_font 时的返回文案）
fn manual_install_hint(spec: &FontSpec) -> String {
    format!(
        "Windows 暂不支持在 Mesa 内一键安装字体。请到官方发布页下载 {}：{}
         解压后选中字体文件，右键选「安装」或「为所有用户安装」，装好后回到设置页刷新即可。",
        spec.family, spec.download_url
    )
}

/// 平台字体目录：用户目录走 dirs 抽象；系统目录无 dirs 对应抽象，按 cfg 给标准路径
fn font_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        if let Some(h) = dirs::home_dir() {
            out.push(h.join("Library/Fonts"));
        }
        out.push(PathBuf::from("/Library/Fonts"));
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(d) = dirs::data_local_dir() {
            out.push(d.join("fonts")); // ~/.local/share/fonts
        }
        out.push(PathBuf::from("/usr/share/fonts"));
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(d) = dirs::data_local_dir() {
            out.push(d.join("Microsoft/Windows/Fonts")); // %LOCALAPPDATA%\Microsoft\Windows\Fonts
        }
        let windir = std::env::var_os("WINDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        out.push(windir.join("Fonts"));
    }
    out
}

/// 文件名小写包含任一关键字（只比文件名，不比路径）
fn file_name_matches(file_name: &str, keywords: &[&str]) -> bool {
    let lower = file_name.to_lowercase();
    keywords.iter().any(|k| lower.contains(k))
}

/// 递归扫目录（限深 3 层、限 20000 条目，防异常目录树拖慢），任一文件名命中即 true。
/// 递归是因为 Linux 用户常按字体分子目录存放；目录不存在/不可读按未命中处理
fn dir_has_font(dir: &Path, keywords: &[&str]) -> bool {
    fn walk(dir: &Path, keywords: &[&str], depth: u32, budget: &mut u32) -> bool {
        if depth > 3 || *budget == 0 {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            *budget = budget.saturating_sub(1);
            if *budget == 0 {
                return false;
            }
            let path = entry.path();
            if path.is_dir() {
                if walk(&path, keywords, depth + 1, budget) {
                    return true;
                }
            } else if entry
                .file_name()
                .to_str()
                .is_some_and(|n| file_name_matches(n, keywords))
            {
                return true;
            }
        }
        false
    }
    let mut budget = 20000u32;
    walk(dir, keywords, 0, &mut budget)
}

fn font_installed(spec: &FontSpec) -> bool {
    font_dirs().iter().any(|d| dir_has_font(d, spec.keywords))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontStatusDto {
    pub id: String,
    pub family: String,
    pub installed: bool,
    /// 本平台能否应用内安装（Windows 为 false）
    pub can_install: bool,
    /// 官方下载页，供手动安装
    pub download_url: String,
}

#[tauri::command]
pub fn font_status() -> Vec<FontStatusDto> {
    FONT_SPECS
        .iter()
        .map(|s| FontStatusDto {
            id: s.id.into(),
            family: s.family.into(),
            installed: font_installed(s),
            can_install: CAN_INSTALL,
            download_url: s.download_url.into(),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInstallDto {
    pub ok: bool,
    pub output: String,
}

fn install_font_sync(app: &AppHandle, spec: &'static FontSpec) -> FontInstallDto {
    if font_installed(spec) {
        return FontInstallDto {
            ok: true,
            output: format!("{} 已安装，无需重复安装", spec.family),
        };
    }
    if !CAN_INSTALL {
        return FontInstallDto {
            ok: false,
            output: manual_install_hint(spec),
        };
    }
    if agents::resolve_binary("brew").is_none() {
        return FontInstallDto {
            ok: false,
            output: "未检测到 Homebrew，无法自动安装字体。请先安装 Homebrew（https://brew.sh），或手动下载字体文件放入系统字体目录。".into(),
        };
    }
    let app2 = app.clone();
    let (ok, output) = crate::updater::run_streaming_pty(
        "fonts",
        "brew",
        &["install".into(), "--cask".into(), spec.cask.into()],
        move |text| {
            let _ = app2.emit("font-install-output", text);
        },
    );
    FontInstallDto { ok, output }
}

/// 结果经 `font-install-done` 推送（前端以事件为准，invoke 返回值兜底，同 updater 模式）
fn emit_done(app: &AppHandle, result: FontInstallDto) -> FontInstallDto {
    let _ = app.emit("font-install-done", &result);
    result
}

#[tauri::command]
pub async fn install_font(app: AppHandle, font_id: String) -> Result<FontInstallDto, String> {
    let spec = spec_for(&font_id)
        .ok_or_else(|| format!("不支持安装的字体：{font_id}（仅 maple / sarasa / iosevka）"))?;
    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || install_font_sync(&app2, spec))
        .await
        .map_err(|e| format!("安装失败: {e}"))?;
    Ok(emit_done(&app, result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_maps_ids_to_casks() {
        assert_eq!(spec_for("maple").unwrap().cask, "font-maple-mono-nf-cn");
        assert_eq!(spec_for("sarasa").unwrap().cask, "font-sarasa-gothic");
        assert_eq!(spec_for("iosevka").unwrap().cask, "font-iosevka");
        // 系统/商业字体与未知 id 一律拒绝（白名单精确匹配，大小写敏感）
        assert!(spec_for("sf-mono").is_none());
        assert!(spec_for("menlo").is_none());
        assert!(spec_for("Maple").is_none());
        assert!(spec_for("").is_none());
    }

    #[test]
    fn manual_hint_points_to_official_release_page() {
        for spec in FONT_SPECS {
            assert!(spec.download_url.starts_with("https://github.com/"), "{}", spec.id);
            let hint = manual_install_hint(spec);
            assert!(hint.contains(spec.download_url) && hint.contains(spec.family), "{hint}");
        }
        assert_eq!(CAN_INSTALL, !cfg!(windows));
    }

    #[test]
    fn file_name_matching_is_case_insensitive_contains() {
        let maple = spec_for("maple").unwrap().keywords;
        assert!(file_name_matches("MapleMono-NF-CN-Regular.ttf", maple));
        assert!(file_name_matches("maplemono-nf-cn-bold.otf", maple));
        let sarasa = spec_for("sarasa").unwrap().keywords;
        assert!(file_name_matches("SarasaMonoSC-Regular.ttf", sarasa));
        assert!(file_name_matches("sarasa-mono-sc-nerd.ttf", sarasa));
        let iosevka = spec_for("iosevka").unwrap().keywords;
        assert!(file_name_matches("Iosevka-Regular.ttf", iosevka));
        assert!(file_name_matches("iosevka-term-bold.ttf", iosevka));
        // 内置/系统字体不误命中
        assert!(!file_name_matches("JetBrainsMono-Regular.ttf", maple));
        assert!(!file_name_matches("JetBrainsMono-Regular.ttf", sarasa));
        assert!(!file_name_matches("Menlo.ttc", iosevka));
    }

    #[test]
    fn dir_scan_matches_top_level_and_subdirectory() {
        let base = std::env::temp_dir().join(format!("ccode-fonts-test-{}", uuid::Uuid::new_v4()));
        let sub = base.join("nested").join("deep");
        std::fs::create_dir_all(&sub).unwrap();
        let sarasa = spec_for("sarasa").unwrap().keywords;
        // 空目录 → 未安装
        assert!(!dir_has_font(&base, sarasa));
        // 顶层文件名命中
        std::fs::write(base.join("SarasaMonoSC-Bold.ttf"), b"x").unwrap();
        assert!(dir_has_font(&base, sarasa));
        std::fs::remove_file(base.join("SarasaMonoSC-Bold.ttf")).unwrap();
        // 子目录里的文件也命中（Linux 用户常按字体分目录存放）
        std::fs::write(sub.join("sarasa-fixed-sc-regular.ttf"), b"x").unwrap();
        assert!(dir_has_font(&base, sarasa));
        // 不存在的目录 → false，不 panic
        assert!(!dir_has_font(&base.join("missing"), sarasa));
        std::fs::remove_dir_all(&base).ok();
    }
}
