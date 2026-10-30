//! 浏览器桥安装（通道 C 的装机件）：把 NativeMessagingHosts 清单写进各浏览器的
//! 期望位置，指向随应用分发的 `mesa_helper` 二进制。扩展（仓库 `extension/`，
//! ID 固定 `dmjplopfhbdamkihimfllomdmkfainnn`）经 native messaging 调 helper 落 papers/。
//!
//! 路径口径（Chrome 官方文档）：
//! - macOS：`~/Library/Application Support/<Browser>/NativeMessagingHosts/`
//! - Linux：`~/.config/<Browser>/NativeMessagingHosts/`
//! - Windows：清单任意位置 + HKCU 注册表键指向它（写注册表经 background_command，
//!   不闪 conhost）

pub(crate) const HOST_NAME: &str = "dev.ccode.mesa";
/// 与 extension/manifest.json 内置 key 派生的 ID 一致（装错 ID 浏览器会拒连）。
/// 派生口径：SHA-256(manifest key 的 DER) 前 128 bit → 32 位十六进制 → a-p 映射
/// （2026-09-17 修正：旧值 16 字符不是合法 Chrome ID，allowed_origins 永不匹配）
const EXT_ID: &str = "dmjplopfhbdamkihimfllomdmkfainnn";

fn helper_exe_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位当前程序失败: {e}"))?;
    let dir = exe.parent().ok_or_else(|| "定位程序目录失败".to_string())?;
    // 无后缀名在前：dev 下 target/debug/mesa_helper 是真实构建（tauri dev 会把
    // externalBin 占位文件按带后缀名复制进来，不能让 0 字节占位抢在真身前面）；
    // 打包版 sidecar 按 externalBin 约定保留 target-triple 后缀，回落到带后缀名
    let suffix = env!("TAURI_ENV_TARGET_TRIPLE");
    let names: Vec<String> = if cfg!(windows) {
        vec![
            "mesa_helper.exe".into(),
            format!("mesa_helper-{suffix}.exe"),
        ]
    } else {
        vec!["mesa_helper".into(), format!("mesa_helper-{suffix}")]
    };
    let mut saw_placeholder = false;
    for name in &names {
        let p = dir.join(name);
        let Ok(meta) = std::fs::metadata(&p) else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 {
            // build.rs 为过 tauri-build 校验落的 0 字节占位（fresh clone / 只跑过
            // cargo build 主程序时）：当真身写进清单会「安装成功但扩展永远连不上」
            saw_placeholder = true;
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o111 == 0 {
                saw_placeholder = true;
                continue;
            }
        }
        return Ok(p);
    }
    if saw_placeholder {
        return Err(format!(
            "mesa_helper 还只是空占位（cargo build --bin mesa_helper 或 node scripts/stage-sidecar.mjs 生成真身后重试）——目录 {}",
            dir.display()
        ));
    }
    Err(format!(
        "找不到 helper（尝试 {names:?} 于 {}）——开发模式需 cargo build 生成；打包版随应用分发",
        dir.display()
    ))
}

fn host_manifest(helper: &std::path::Path) -> String {
    let helper = helper.to_string_lossy().replace('\\', "\\\\");
    format!(
        r#"{{"name":"{HOST_NAME}","description":"Mesa 文献收货通道","path":"{helper}","type":"stdio","allowed_origins":["chrome-extension://{EXT_ID}/"]}}"#
    )
}

fn write_manifest(dir: &std::path::Path, body: &str) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let path = dir.join(format!("{HOST_NAME}.json"));
    std::fs::write(&path, body).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 各浏览器 NativeMessagingHosts 清单目录（平台分支单一出处）。卸载走同一份。
pub(crate) fn native_host_dirs() -> Vec<(&'static str, std::path::PathBuf)> {
    let Some(base) = crate::dirs::config_dir() else {
        return Vec::new();
    };
    if cfg!(target_os = "macos") {
        vec![
            ("Chrome", base.join("Google/Chrome/NativeMessagingHosts")),
            ("Edge", base.join("Microsoft Edge/NativeMessagingHosts")),
            ("Chromium", base.join("Chromium/NativeMessagingHosts")),
        ]
    } else if cfg!(target_os = "linux") {
        vec![
            ("Chrome", base.join("google-chrome/NativeMessagingHosts")),
            ("Edge", base.join("microsoft-edge/NativeMessagingHosts")),
            ("Chromium", base.join("chromium/NativeMessagingHosts")),
        ]
    } else {
        vec![
            ("Chrome", base.join("Google\\Chrome\\NativeMessagingHosts")),
            ("Edge", base.join("Microsoft\\Edge\\NativeMessagingHosts")),
        ]
    }
}

/// Windows 收货桥的 HKCU 键。安装写入、卸载删除都用这一份。Chromium 没有对应键。
pub(crate) fn windows_bridge_reg_key(browser: &str) -> Option<String> {
    let root = match browser {
        "Chrome" => r"Software\Google\Chrome",
        "Edge" => r"Software\Microsoft\Edge",
        _ => return None,
    };
    Some(format!(r"HKCU\{root}\NativeMessagingHosts\{HOST_NAME}"))
}

/// 桥清单自愈（启动时调用）：清单把安装当时的 helper 绝对路径写死了——用户从
/// DMG 挂载卷/下载夹运行装桥、之后把 app 拖进 /Applications（或 dev→打包切换），
/// path 指向已不存在的位置、connectNative 直接失败。这里读已有清单，path 与当前
/// helper 不一致就幂等重写（2026-09-17 审计）
pub fn selfheal_bridge_manifests() {
    let Ok(helper) = helper_exe_path() else {
        return; // 找不到真身（如 dev 下未 build helper）不动既有清单
    };
    // 比较用**未转义**的真实路径（清单里 serde_json 解析出的 path 是反转义后的；
    // 拿 JSON 转义形式比较在 Windows 下永假，自愈会每启动重写一遍，终检提示）
    let helper_str = helper.to_string_lossy().into_owned();
    for (_browser, dir) in native_host_dirs() {
        let path = dir.join(format!("{HOST_NAME}.json"));
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let current = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("path").and_then(|p| p.as_str()).map(str::to_string));
        match current {
            Some(p) if p == helper_str => {}
            _ => {
                let body = host_manifest(&helper);
                if std::fs::write(&path, body).is_ok() {
                    crate::logbuf::record(
                        "info",
                        "browser-bridge",
                        &format!("桥清单已自愈（path → {}）", helper.display()),
                    );
                }
            }
        }
    }
}

/// 扩展目录就位：打包版资源里的 extension（bundle.resources 的 extension-src/）
/// 或仓库根 extension/（dev），复制到 `<config>/ccode/extension`——装 DMG 的
/// 用户没有仓库，「加载已解压的扩展程序」需要一个本机可点的稳定目录
/// （2026-09-17 审计：旧指引指向 Mesa 仓库的 extension/，打包用户无法完成）
pub fn stage_extension_files() -> Result<std::path::PathBuf, String> {
    let target = crate::dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("extension");
    let mut source: Option<std::path::PathBuf> = None;
    // 候选：打包资源（resource_dir/extension-src，stage-sidecar 打进 bundle）→
    // dev 的仓库目录（current_dir 通常是 src-tauri）
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    // 打包资源：macOS 的 tauri resource_dir = exe_dir/../Resources（Contents/
    // MacOS → Contents/Resources；终检二轮抓出 ../../Resources 多退一级必失败）；
    // Windows/Linux 资源与 exe 同目录，exe_dir/extension-src 直接命中
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("../Resources/extension-src"));
            candidates.push(exe_dir.join("extension-src"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        // dev：仓库活源在前（extension-src 是 build.rs 只拷一次的陈旧副本，
        // 排前面会把改动前的版本装进配置目录——终检二轮）
        candidates.push(cwd.join("../extension"));
        candidates.push(cwd.join("extension"));
        candidates.push(cwd.join("../../extension"));
        candidates.push(cwd.join("extension-src"));
    }
    for c in candidates {
        if c.join("manifest.json").is_file() {
            source = Some(c);
            break;
        }
    }
    let Some(source) = source else {
        return Err("找不到扩展源目录（打包资源或仓库 extension/）".into());
    };
    copy_tree(&source, &target)?;
    Ok(target)
}

/// helper 收货回执监听（常驻轻量线程，2026-09-17 用户实测三连修）：扩展「存到
/// Mesa」经独立 helper 进程落 papers/，不发任何 Tauri 事件——清单开着也只能等
/// 轮询。250ms 增量读 helper-receipts.jsonl（旧 2s 让扩展入库的「已存」比直接
/// 下载慢一截），成功回执变成 `inst-papers-changed`，前端立刻重拉进度。
static RECEIPTS_WATCH_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn spawn_receipts_watch(app: tauri::AppHandle) {
    if RECEIPTS_WATCH_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        let path = match crate::dirs::config_dir() {
            Some(d) => d.join("ccode").join("helper-receipts.jsonl"),
            None => return,
        };
        // 基线 = 当前长度：历史回执不重放（应用关闭期间存的篇目由面板打开时的
        // 既有刷新兜底）
        let mut offset = std::fs::metadata(&path)
            .map(|m| m.len() as usize)
            .unwrap_or(0);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if text.len() < offset {
                // 文件被外部清理/截短：重置基线
                offset = text.len();
                continue;
            }
            if text.len() == offset {
                continue;
            }
            let fresh = &text[offset..];
            let end = match fresh.rfind('\n') {
                Some(i) => i + 1,
                None => continue, // 残行等下一次
            };
            let complete = &fresh[..end];
            offset += end;
            for line in complete.lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
                    continue;
                }
                let project_root = v
                    .get("projectRoot")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if project_root.is_empty() {
                    continue;
                }
                let doi = v.get("doi").and_then(|x| x.as_str()).unwrap_or("");
                let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("");
                let saved = v
                    .get("saved")
                    .or(v.get("note"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                crate::download_inbox::consume_pending_after_helper(&project_root, doi, title);
                let saved =
                    crate::lit_watch::stamp_paper_identity(&project_root, saved, title, doi)
                        .unwrap_or_else(|| saved.to_string());
                use tauri::Emitter as _;
                let _ = app.emit(
                    "inst-papers-changed",
                    serde_json::json!({
                        "projectRoot": project_root,
                        "title": title,
                        "doi": doi,
                        "saved": saved,
                    }),
                );
            }
        }
    });
}

fn copy_tree(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建扩展目录失败: {e}"))?;
    let rd = std::fs::read_dir(src).map_err(|e| format!("读扩展源目录失败: {e}"))?;
    for entry in rd.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("复制扩展文件失败: {e}"))?;
        }
    }
    Ok(())
}

/// 安装浏览器桥：写 NativeMessagingHosts 清单（Chrome/Edge/Chromium）+ 把扩展
/// 目录就位到配置目录。返回各浏览器的安装结果（人话），前端直接展示
#[tauri::command]
pub fn install_browser_bridge() -> Vec<String> {
    let mut out = Vec::new();
    let helper = match helper_exe_path() {
        Ok(h) => h,
        Err(e) => return vec![format!("✗ {e}")],
    };
    let body = host_manifest(&helper);
    if cfg!(target_os = "windows") {
        // Windows：清单放各浏览器配置目录，注册表键（HKCU）指回清单文件
        for (browser, dir) in native_host_dirs() {
            let manifest = match write_manifest(&dir, &body) {
                Ok(p) => p,
                Err(e) => {
                    out.push(format!("{browser}：✗ {e}"));
                    continue;
                }
            };
            let Some(key) = windows_bridge_reg_key(browser) else {
                out.push(format!("{browser}：✗ 没有对应的注册表位置"));
                continue;
            };
            let ok = crate::process::background_command("reg")
                .args(["add", &key, "/ve", "/t", "REG_SZ", "/d", &manifest, "/f"])
                .output()
                .is_ok_and(|o| o.status.success());
            out.push(if ok {
                format!("{browser}：已安装（清单+注册表）")
            } else {
                format!("{browser}：✗ 注册表写入失败（清单在 {manifest}）")
            });
        }
    } else if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        for (browser, dir) in native_host_dirs() {
            match write_manifest(&dir, &body) {
                Ok(p) => out.push(format!("{browser}：已安装（{p}）")),
                Err(e) => out.push(format!("{browser}：✗ {e}")),
            }
        }
    } else {
        out.push("✗ 不支持的平台".into());
    }
    match stage_extension_files() {
        Ok(dir) => out.push(format!(
            "扩展目录已就绪：{} ——在 Chrome/Edge 扩展页开「开发者模式」→「加载已解压的扩展程序」选这个目录",
            dir.display()
        )),
        Err(e) => out.push(format!("扩展目录未能就位：{e}（开发模式请直接用仓库 extension/ 目录）")),
    }
    if !out.is_empty() {
        crate::logbuf::record(
            "info",
            "browser-bridge",
            &format!("浏览器桥安装：{}", out.join("；")),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_manifest_locks_extension_id() {
        let m = host_manifest(std::path::Path::new("/bin/mesa_helper"));
        assert!(m.contains(format!("chrome-extension://{EXT_ID}/").as_str()));
        assert!(m.contains(r#""type":"stdio""#));
        assert!(m.contains("/bin/mesa_helper"));
    }
}
