fn main() {
    placeholder_for_sidecar();
    ensure_extension_src();
    // Windows MSVC：通用控件 v6 的 manifest 改由链接器嵌进**每个**链接产物（含 lib 的测试 exe），
    // tauri-build 自己那份只进 bins——测试 exe 没有它，comctl32 落到 5.82、缺 TaskDialogIndirect，
    // 一启动就 0xc0000139 退出，一条测试都不跑（2026-10-21 起 CI Windows 一直红在这）。两份都嵌会撞 MANIFEST 资源，所以关掉 tauri-build 那份
    if embed_common_controls_manifest() {
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("failed to run tauri-build");
    } else {
        tauri_build::build()
    }
}

/// 内容与 tauri-build 默认的 windows-app-manifest.xml 相同（只依赖 Common-Controls 6.0.0.0）
fn embed_common_controls_manifest() -> bool {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if os != "windows" || env != "msvc" {
        return false;
    }
    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
        .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    true
}

/// `bundle.resources` 的 extension-src/** 同样每次构建都校验（fresh clone 没有
/// 这个目录直接报错）。dev 构建时从仓库根 extension/ 预拷贝（只在目标没有
/// manifest.json 时拷，不反复覆盖）；没有源（极少数脱离仓库的构建）则落占位
/// 文件保住 glob，打包前 stage-sidecar.mjs 会用真拷贝覆写
fn ensure_extension_src() {
    let dst = std::path::Path::new("extension-src");
    if dst.join("manifest.json").exists() {
        return;
    }
    let src = std::path::Path::new("../extension");
    if src.join("manifest.json").is_file() {
        let _ = copy_tree(src, dst);
        return;
    }
    let _ = std::fs::create_dir_all(dst);
    let _ = std::fs::write(dst.join(".placeholder"), b"");
}

fn copy_tree(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// tauri-build 对 `bundle.externalBin` 做的是**每次 cargo build/test 都跑**的存在性
/// 校验（binaries/mesa_helper-<triple> 不在场直接报错），而真实二进制只能由
/// `scripts/stage-sidecar.mjs` 在打包前 cargo build 出来——先有鸡还是先有蛋。
/// 这里在 tauri-build 校验前落一个占位文件保住裸 cargo 命令（dev / test / check）；
/// `tauri build` 的 beforeBuildCommand 会在打包前用真实二进制覆写同一路径。
fn placeholder_for_sidecar() {
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    if target.is_empty() {
        return;
    }
    let name = if target.contains("windows") {
        format!("mesa_helper-{target}.exe")
    } else {
        format!("mesa_helper-{target}")
    };
    let path = std::path::Path::new("binaries").join(name);
    if !path.exists() {
        let _ = std::fs::create_dir_all("binaries");
        let _ = std::fs::write(&path, b"");
    }
}
