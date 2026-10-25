fn main() {
    placeholder_for_sidecar();
    ensure_extension_src();
    let attributes = tauri_build::Attributes::new().windows_attributes(windows_manifest());
    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }
}

/// tauri-build 把应用 manifest 编进资源、只链给 bin（rustc-link-arg-bins），lib 的测试 exe 没有 manifest：
/// comctl32 落到 5.82，缺 TaskDialogIndirect，测试进程一启动就报 0xc0000139（本机与 CI 的 Windows runner 都碰上过）。
/// MSVC 下改由链接器把同一份 manifest（tauri-build 默认那份，见 windows-app-manifest.xml）嵌进所有链接产物，
/// 测试 exe 也有；资源里不再放，免得 bin 上两份 manifest 冲突
fn windows_manifest() -> tauri_build::WindowsAttributes {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return tauri_build::WindowsAttributes::new();
    }
    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    // 链接器默认还会补一段 trustInfo（asInvoker）；不要，保持和 tauri-build 原来嵌的一字不差
    println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
    tauri_build::WindowsAttributes::new_without_app_manifest()
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
