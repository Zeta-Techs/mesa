//! 路径方言归一：Windows 上同一个目录有两种写法，跨方言比较是本仓库反复踩的坑。
//!
//! - **verbatim 形式** `\\?\C:\Users\x`：`fs::canonicalize` 在 Windows 的返回值。
//!   `PathBuf` 按分量比较，`Prefix(VerbatimDisk)` ≠ `Prefix(Disk)`，所以它与普通形式
//!   **永不相等**；直接显示给用户也很难看。
//! - **普通形式** `C:\Users\x`：`crate::dirs::home_dir()`、子进程报告的 cwd、用户手输的路径。
//!
//! 落库与显示走 [`strip_verbatim`]（只剥前缀，保留分隔符与大小写，结果仍可直接用于
//! 文件操作）；任何**跨来源比较**走 [`path_key`]（额外统一分隔符，并在 Windows 上
//! 折叠大小写——NTFS 大小写不敏感，`C:\Users` 与 `c:\users` 是同一个目录）。
//!
//! 约定见 docs/conventions/safety.md「跨路径比较先统一 canonicalize 口径」。

use std::path::PathBuf;

/// 波浪号展开：`~` / `~/` / `~\`（Windows cmd/PowerShell 不展开 ~，用户常写后者，
/// 与 `~/` 同等处理）→ 家目录前缀。各入口（会话 cwd、项目根、文件树、git）共用这一份，
/// 勿再按文件复制本地版本——那正是三份窄一份宽漂移的来源。
pub(crate) fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") || path.starts_with("~\\") {
        if let Some(home) = crate::dirs::home_dir() {
            return format!("{}{}", home.to_string_lossy(), &path[1..]);
        }
    }
    path.to_string()
}

/// 剥掉 Windows `canonicalize` 产生的 verbatim 前缀，其余原样返回。
/// `\\?\UNC\server\share` 还原为 `\\server\share`（UNC 的 verbatim 写法另有一套）。
/// 非 Windows 平台不会出现这些前缀，本函数是恒等变换。
pub(crate) fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    drop(text);
    path
}

/// 跨来源路径比较键：剥 verbatim 前缀 + 分隔符统一为 `/` + 去尾分隔符，
/// Windows 上再折叠大小写。
///
/// **只用于比较，不要拿它回写或显示**——它是有损的（大小写、分隔符都被改了）。
/// 存量 DB 里仍可能是 canonicalize 原样（含 `\\?\`），所以凡是把库里的路径与
/// 会话/终端 cwd/用户输入相比的地方都必须走这里，只改写入侧是不够的。
pub(crate) fn path_key(path: &str) -> String {
    let stripped = strip_verbatim(PathBuf::from(path));
    let text = stripped.to_string_lossy().replace('\\', "/");
    let trimmed = if text.len() > 1 {
        text.trim_end_matches('/').to_string()
    } else {
        text
    };
    #[cfg(windows)]
    let trimmed = trimmed.to_lowercase();
    trimmed
}

/// 两条路径是否指向同一位置（跨方言）。
pub(crate) fn same_path(a: &str, b: &str) -> bool {
    path_key(a) == path_key(b)
}

/// 大小写不敏感的比较键：安全闸（如保护路径）要跟文件系统默认语义对齐——
/// macOS 默认 APFS、Windows NTFS 都按大小写不敏感解析，仅大小写不同的两条路径
/// 在盘上是同一个文件（保护 `RAW/` 会被 `raw/a.txt` 绕过），必须折叠后比较。
/// Linux 大小写敏感文件系统上折叠属于偏保守方向（宁可误拦，不可漏拦）。
pub(crate) fn path_key_folded(path: &str) -> String {
    path_key(path).to_lowercase()
}

/// `child` 是否落在 `root` 之内（含 root 自身），按路径分量判定，跨方言。
/// 不用字符串前缀：那会让 `/ws/task2` 误命中 `/ws/task`。
pub(crate) fn path_within(child: &str, root: &str) -> bool {
    let (child, root) = (path_key(child), path_key(root));
    child == root || child.starts_with(&format!("{root}/"))
}

/// [`path_within`] 的 `Path` 包装，供 canonicalize 结果与剥过 verbatim 的根比较。
pub(crate) fn path_within_path(child: &std::path::Path, root: &std::path::Path) -> bool {
    path_within(&child.to_string_lossy(), &root.to_string_lossy())
}

/// canonicalize 后再剥 Windows verbatim 前缀。macOS/Linux 上与 `canonicalize` 相同。
/// 门檻函数返回值、以及随后的 `starts_with`/`strip_prefix` 都应走这里，避免
/// `\\?\C:\…` 与 `C:\…` 按分量永不相等。
pub(crate) fn canonicalize_plain(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    Ok(strip_verbatim(std::fs::canonicalize(path)?))
}

/// Windows 文件名非法字符（macOS/Linux 上除 `/` 与 NUL 外都合法）
const FS_ILLEGAL: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Windows 保留设备名：这些名字（连同任意扩展名，如 `CON.md`）在 Win32 命名空间里
/// 被当成设备。实测 Rust std 能正常创建 `con.md`（std 自动加 `\\?\` 绕过转换），
/// 但**子进程拿不到**——`git worktree add` 建 `refs/heads/ccode/CON.lock` 会直接
/// `Invalid argument` 失败。判定按第一个点之前那段做，大小写不敏感。
const FS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 校验单个文件/目录名是否可以安全**原样落盘**。**全平台同一套规则**：技能库、草稿会跨机
/// 同步，在 macOS 上允许 `方案?.md` 只会让它到了 Windows 无法落盘（os error 123）。
///
/// 校验的是传进来的原值，不替调用方 trim —— 尾部空格本身就是要拦的东西之一，
/// 调用方若想容忍用户多打的空格，请先自行 `trim()` 再传入。
///
/// 只在**新建/重命名**时调用，不回改已有数据——mac 上历史遗留的名字照常读写。
pub(crate) fn validate_fs_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("名称不能为空".into());
    }
    // 必须是单个路径分量：顺带挡掉 `..`、`a/b`、以及 Windows 的 `C:evil`
    //（Path::push 遇到带盘符前缀的名字会整体替换，能逃出根目录）
    let mut comps = std::path::Path::new(name).components();
    let single =
        matches!(comps.next(), Some(std::path::Component::Normal(_))) && comps.next().is_none();
    if !single {
        return Err("名称只能是单层名字，不能含路径分隔符、`..` 或盘符".into());
    }
    if let Some(bad) = name.chars().find(|c| FS_ILLEGAL.contains(c)) {
        return Err(format!("名称不能含字符 {bad}（Windows 文件名非法）"));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err("名称不能含控制字符".into());
    }
    // Windows 会静默剥掉尾部的点与空格：`my.` 落盘变成 `my`，
    // 而登记表里记的还是 `my.` ⇒ 之后按名字比对会认成两个不同的条目
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("名称结尾不能是点或空格（Windows 会静默丢弃）".into());
    }
    let stem = name.split('.').next().unwrap_or(name);
    if FS_RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Err(format!("{stem} 是系统保留名，请换一个"));
    }
    Ok(())
}

/// 把任意文本清洗成可安全落盘的单层名字（非法字符替换为 `-`，尾部点/空格去掉，
/// 保留名加后缀）。用于**自动生成**文件名的场景；用户直接输入的名字用
/// [`validate_fs_name`] 报明确错误，不要静默改写用户输入。
pub(crate) fn sanitize_fs_name(name: &str) -> Result<String, String> {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_control() || FS_ILLEGAL.contains(&c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() {
        return Err("名称清洗后为空，请换一个名字".into());
    }
    let stem = cleaned.split('.').next().unwrap_or(cleaned);
    if FS_RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Ok(format!("{cleaned}-"));
    }
    Ok(cleaned.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_verbatim_handles_disk_unc_and_plain() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\Users\x")),
            PathBuf::from(r"C:\Users\x")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\srv\share\p")),
            PathBuf::from(r"\\srv\share\p")
        );
        // 普通路径与 POSIX 路径原样返回（macOS 上本函数恒等）
        assert_eq!(
            strip_verbatim(PathBuf::from(r"C:\Users\x")),
            PathBuf::from(r"C:\Users\x")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from("/Users/x")),
            PathBuf::from("/Users/x")
        );
    }

    #[test]
    fn path_key_folds_dialects() {
        // 回归：canonicalize 的 verbatim 形式与普通形式此前永不相等，
        // 导致「已注册项目的会话被当成随手聊」「worktree 被误判为仓库候选」等一串症状
        assert_eq!(path_key(r"\\?\C:\Users\x"), path_key(r"C:\Users\x"));
        assert_eq!(path_key(r"C:\Users\x"), path_key("C:/Users/x"));
        assert_eq!(path_key("/Users/x/"), path_key("/Users/x"));
    }

    #[cfg(windows)]
    #[test]
    fn path_key_is_case_insensitive_on_windows() {
        // NTFS 大小写不敏感：盘符或任一段大小写不同都是同一个目录
        assert_eq!(path_key(r"C:\Users\Foo"), path_key(r"c:\users\foo"));
        assert!(same_path(r"\\?\C:\Users\Foo", r"c:\users\foo"));
    }

    #[cfg(not(windows))]
    #[test]
    fn path_key_is_case_sensitive_on_posix() {
        // POSIX 上大小写是有意义的，不能折叠
        assert_ne!(path_key("/Users/Foo"), path_key("/users/foo"));
    }

    #[test]
    fn path_key_folded_is_case_insensitive_everywhere() {
        // 保护路径等安全闸全平台折叠：APFS/NTFS 上大小写不同也是同一个文件
        assert_eq!(path_key_folded("/Users/Foo"), path_key_folded("/users/foo"));
        assert_eq!(path_key_folded("RAW/a.txt"), path_key_folded("raw/A.TXT"));
        assert_ne!(path_key_folded("raw/a.txt"), path_key_folded("raw/b.txt"));
    }

    #[test]
    fn canonicalize_plain_strips_verbatim_prefix() {
        let p = std::env::temp_dir();
        let plain = canonicalize_plain(&p).unwrap();
        let text = plain.to_string_lossy();
        assert!(
            !text.starts_with(r"\\?\"),
            "canonicalize_plain 不得残留 verbatim 前缀: {text}"
        );
    }

    #[test]
    fn path_within_matches_by_component_not_string_prefix() {
        #[cfg(windows)]
        let (root, sub, sibling) = (r"C:\ws\task", r"C:\ws\task\a\b", r"C:\ws\task2");
        #[cfg(not(windows))]
        let (root, sub, sibling) = ("/ws/task", "/ws/task/a/b", "/ws/task2");
        assert!(path_within(root, root), "root 自身算在内");
        assert!(path_within(sub, root));
        assert!(!path_within(sibling, root), "共享字符串前缀但不是子目录");
        // 跨方言同样成立
        assert!(path_within(&format!(r"\\?\{sub}"), root) || !cfg!(windows));
    }

    // ===== 文件名可落盘性（全平台同一套规则） =====

    #[test]
    fn validate_fs_name_rejects_windows_illegal_chars() {
        // 这些字符在 macOS 上合法，但到 Windows 落盘是 os error 123，
        // 而技能库/草稿要跨机同步，所以两端用同一套规则
        for bad in ["a<b", "a>b", "a:b", "a\"b", "a|b", "a?b", "a*b"] {
            assert!(validate_fs_name(bad).is_err(), "{bad} 应被拒绝");
        }
        assert!(validate_fs_name("正常名字").is_ok());
        assert!(validate_fs_name("draft-v2.md").is_ok());
    }

    #[test]
    fn validate_fs_name_rejects_path_escapes() {
        for bad in ["..", "a/b", r"a\b", "/abs", r"C:evil", ""] {
            assert!(validate_fs_name(bad).is_err(), "{bad:?} 应被拒绝");
        }
    }

    #[test]
    fn validate_fs_name_rejects_trailing_dot_space_and_reserved() {
        // Windows 静默剥尾部点/空格：登记表记 "my." 而盘上是 "my"，之后按名字比会分裂
        assert!(validate_fs_name("my.").is_err());
        assert!(validate_fs_name("my ").is_err());
        // 保留设备名：git 建 refs/heads/ccode/CON.lock 会 Invalid argument
        for bad in ["CON", "con", "AUX", "com1", "LPT9", "NUL.md", "con.txt"] {
            assert!(validate_fs_name(bad).is_err(), "{bad} 是保留名");
        }
        assert!(
            validate_fs_name("console").is_ok(),
            "只有整段相等才算保留名"
        );
        assert!(validate_fs_name("com10").is_ok());
    }

    #[test]
    fn sanitize_fs_name_replaces_and_defuses() {
        assert_eq!(sanitize_fs_name("draft:v2").unwrap(), "draft-v2");
        assert_eq!(sanitize_fs_name("  方案?  ").unwrap(), "方案-");
        assert_eq!(sanitize_fs_name("trail.").unwrap(), "trail");
        // 保留名加后缀而不是报错——自动生成路径不该因为用户取名 CON 就整条失败
        assert_eq!(sanitize_fs_name("CON").unwrap(), "CON-");
        assert!(sanitize_fs_name("...").is_err());
        // 清洗结果本身必须可落盘
        for raw in ["a<b>c", "CON", "trail. ", "x|y"] {
            let out = sanitize_fs_name(raw).unwrap();
            assert!(validate_fs_name(&out).is_ok(), "{raw} → {out} 仍不合法");
        }
    }
}
