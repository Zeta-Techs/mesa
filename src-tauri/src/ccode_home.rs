//! Mesa 家目录：编程工作树 / 科研工作副本 / 定时隔离树的落脚根（默认 `~/ccode`）。
//!
//! 用户可在设置「数据与存储」把它挪到别的盘（Windows 防 C 盘撑满）：选定目录 `B` 后实际根是
//! `B/ccode`——保留 `ccode` 这一层，`runs.rs` / `run-model.ts` 靠路径里的 `/ccode/workspaces/`
//! 等片段推断任务类型，挪位置不能让它们失灵。
//!
//! 只管**新建**：已有工作树/副本的路径存在库里，原地照常使用，不自动搬（git 工作树带内部路径引用）。
//! 因此凡「这个路径是不是 Mesa 自己的」类判定一律用 [`all_sub`]（当前根 + 曾用根 + 默认根），
//! 只有「在哪新建」用 [`current`]。
//!
//! 读设置有文件 IO，会话扫描里逐条调用不起，所以进程内缓存，改位置时 [`invalidate`]。
//! 测试态恒用默认根，不读真实设置（与 storage::config_root 同一口径）。

use std::path::{Path, PathBuf};
use std::sync::RwLock;

const DIR: &str = "ccode";

#[derive(Clone, Default)]
struct Cfg {
    base: Option<PathBuf>,
    history: Vec<PathBuf>,
}

static CACHE: RwLock<Option<Cfg>> = RwLock::new(None);

fn default_home() -> Option<PathBuf> {
    crate::dirs::home_dir().map(|h| h.join(DIR))
}

fn load() -> Cfg {
    if cfg!(test) {
        return Cfg::default();
    }
    let s = crate::settings::read_current();
    let pick = |raw: &str| {
        let t = raw.trim();
        (!t.is_empty()).then(|| PathBuf::from(t))
    };
    Cfg {
        base: s.workspace_root.as_deref().and_then(pick),
        history: s
            .workspace_root_history
            .iter()
            .flatten()
            .filter_map(|p| pick(p))
            .collect(),
    }
}

fn cfg() -> Cfg {
    if let Ok(guard) = CACHE.read() {
        if let Some(c) = guard.as_ref() {
            return c.clone();
        }
    }
    let fresh = load();
    if let Ok(mut guard) = CACHE.write() {
        *guard = Some(fresh.clone());
    }
    fresh
}

pub(crate) fn invalidate() {
    if let Ok(mut guard) = CACHE.write() {
        *guard = None;
    }
}

/// 新建工作树/副本的家目录：自定义位置 `<B>/ccode`，没设就是 `~/ccode`。
/// 自定义位置不可用（盘没挂上等）时由调用方的 create_dir_all 报错——不悄悄回落 C 盘，免得两处各放一半。
pub(crate) fn current() -> Result<PathBuf, String> {
    match cfg().base {
        Some(base) => Ok(base.join(DIR)),
        None => default_home().ok_or_else(|| "无法确定用户主目录".to_string()),
    }
}

/// 所有 Mesa 曾经/正在使用的家目录：当前根在前，其后是曾用根，最后是默认 `~/ccode`；去重。
pub(crate) fn all_roots() -> Vec<PathBuf> {
    let c = cfg();
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        let key = p.to_string_lossy().into_owned();
        if !out
            .iter()
            .any(|q| crate::paths::same_path(&q.to_string_lossy(), &key))
        {
            out.push(p);
        }
    };
    if let Some(base) = &c.base {
        push(base.join(DIR));
    }
    for h in &c.history {
        push(h.join(DIR));
    }
    if let Some(d) = default_home() {
        push(d);
    }
    out
}

/// 各家目录下的某个子目录（`worktrees` / `workspaces` / `watch-worktrees`），顺序同 [`all_roots`]
pub(crate) fn all_sub(name: &str) -> Vec<PathBuf> {
    all_roots().into_iter().map(|r| r.join(name)).collect()
}

/// 校验用户选的基目录，返回规整后的绝对路径（已创建、已探写）。
///
/// 拒绝：非绝对路径、盘符根、落在 `~/ccode` 或配置目录内（会和 Mesa 自管目录套娃）、
/// 本身是个文件、不可写。
pub(crate) fn validate_base(raw: &str) -> Result<PathBuf, String> {
    let expanded = crate::paths::expand_tilde(raw.trim());
    if expanded.is_empty() {
        return Err("请选择一个目录".into());
    }
    let path = PathBuf::from(&expanded);
    if !path.is_absolute() {
        return Err("请填写完整路径（如 D:\\mesa），不要用相对路径".into());
    }
    if path.parent().is_none() {
        return Err("不要直接用盘根目录，请选一个文件夹（如 D:\\mesa）".into());
    }
    std::fs::create_dir_all(&path).map_err(|e| format!("无法创建目录 {}：{e}", path.display()))?;
    let canon = crate::paths::strip_verbatim(
        crate::paths::canonicalize_plain(&path).map_err(|e| format!("目录无法解析：{e}"))?,
    );
    if !canon.is_dir() {
        return Err("所选路径不是目录".into());
    }
    if canon.parent().is_none() {
        return Err("不要直接用盘根目录，请选一个文件夹（如 D:\\mesa）".into());
    }
    let mut owned: Vec<PathBuf> = Vec::new();
    if let Some(d) = default_home() {
        owned.push(d);
    }
    if let Some(c) = crate::dirs::config_dir() {
        owned.push(c.join(DIR));
    }
    if owned.iter().any(|o| crate::paths::path_within_path(&canon, o)) {
        return Err("不能放进 Mesa 自己的数据目录里，请换一个位置".into());
    }
    probe_writable(&canon)?;
    Ok(canon)
}

fn probe_writable(dir: &Path) -> Result<(), String> {
    let probe = dir.join(format!(".ccode-write-probe-{}", std::process::id()));
    std::fs::write(&probe, b"ok").map_err(|e| format!("所选目录不可写：{e}"))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// 换位置后的曾用根名单：把旧的自定义基目录记进去（默认根永远在 [`all_roots`] 里，不必存），
/// 新基目录从名单里剔除，去重、封顶 8 个。
pub(crate) fn next_history(
    old_base: Option<&str>,
    new_base: Option<&str>,
    history: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for h in old_base.into_iter().chain(history.iter().map(String::as_str)) {
        let h = h.trim();
        if h.is_empty() {
            continue;
        }
        if new_base.is_some_and(|n| crate::paths::same_path(n, h)) {
            continue;
        }
        if out.iter().any(|o| crate::paths::same_path(o, h)) {
            continue;
        }
        out.push(h.to_string());
    }
    out.truncate(8);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_remembers_old_and_drops_new() {
        let h = next_history(Some("D:/a"), Some("E:/b"), &["F:/c".into()]);
        assert_eq!(h, vec!["D:/a", "F:/c"]);
        // 换回曾用位置：它从名单里出来
        let h = next_history(Some("E:/b"), Some("D:/a"), &h);
        assert_eq!(h, vec!["E:/b", "F:/c"]);
        // 恢复默认：旧的自定义位置入名单
        let h = next_history(Some("E:/b"), None, &h);
        assert_eq!(h, vec!["E:/b", "F:/c"]);
        // 没有旧位置（原先是默认）
        assert_eq!(next_history(None, Some("D:/a"), &[]), Vec::<String>::new());
    }

    #[test]
    fn history_is_capped() {
        let many: Vec<String> = (0..20).map(|i| format!("/x/{i}")).collect();
        assert_eq!(next_history(Some("/y"), None, &many).len(), 8);
    }

    #[test]
    fn validate_rejects_relative_root_and_owned_dirs() {
        assert!(validate_base("").is_err());
        assert!(validate_base("relative/dir").is_err());
        let inside = crate::dirs::home_dir().unwrap().join("ccode").join("workspaces");
        assert!(validate_base(&inside.to_string_lossy()).is_err());
        let cfg_inside = crate::dirs::config_dir().unwrap().join("ccode").join("x");
        assert!(validate_base(&cfg_inside.to_string_lossy()).is_err());
    }

    #[test]
    fn validate_accepts_writable_dir_and_current_is_default_in_tests() {
        let dir = std::env::temp_dir().join(format!("ccode-home-test-{}", std::process::id()));
        let ok = validate_base(&dir.to_string_lossy()).unwrap();
        assert!(ok.is_dir());
        assert!(current().unwrap().ends_with("ccode"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
