//! 技能管理（§6.13）：技能库（SSOT）+ 分发到八个 CLI 的技能目录。
//! 库位置 <config>/ccode/skills/<name>/，元数据 skills.json；分发优先 symlink，失败回退 copy。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const MARKER_FILE: &str = ".ccode-copy"; // copy 分发的标记，删除时据此区分用户自有内容
const MAX_READ_PREVIEW: u64 = 64 * 1024;
const ZIP_MAX_ENTRIES: usize = 10_000;
const ZIP_MAX_UNCOMPRESSED: u64 = 128 * 1024 * 1024;
const ZIP_MAX_DOWNLOAD: u64 = 256 * 1024 * 1024;
const BACKUP_KEEP: usize = 5;
/// 目录遍历深度上限：防符号链接环或异常嵌套导致无限递归。
/// 必须低于各平台 OS 的符号链接解析上限（macOS 实测 16 跳即 ELOOP），
/// 保证先命中我们自己的上限而不是依赖 OS 行为
const MAX_WALK_DEPTH: usize = 8;

// ===== DTO =====

/// 合成溯源条目（「AI 优化另存」时记录源技能）：纯审计元数据，绝不做运行时依赖——
/// 源被删/改名后悬空条目按「找不到就静默过滤」处理，合成技能自包含照常工作。
/// digest 二期再补（dir_manifest_hash 口径，记录合成那一刻的源版本）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDerivedFrom {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDto {
    pub id: String,
    pub name: String,
    pub description: String,
    /// 来源标记（删除保护的 origin 口径，单一出处即本字段，不另加 origin 列）：
    /// builtin=内置种子（播种器写入）/ ccode=Mesa 新建 / local=本地目录导入 /
    /// zip=ZIP 导入 / github=GitHub 导入 / discovered=从 agent 目录收编。
    /// fail-safe：ccode 是后加的，旧数据的自建与本地导入同记 local 无法区分，
    /// 前端删除提示一律按「非自建（外部导入）」对待——宁可多提示来源，不错过警告
    pub source: String,
    pub repo: Option<String>,
    #[serde(default)]
    pub repo_ref: Option<String>,
    #[serde(default)]
    pub repo_subdir: Option<String>,
    #[serde(default)]
    pub source_revision: Option<String>,
    #[serde(default)]
    pub apps: HashMap<String, bool>,
    pub installed_at: String,
    /// 用户自定义分类（None = 未分类）
    #[serde(default)]
    pub category: Option<String>,
    /// 用户自定义标签（展示层 pill，最多 4 个；与内部分组字段 category 独立）
    #[serde(default)]
    pub tags: Vec<String>,
    /// copy 分发后库已更新、副本还是旧内容的 agent（不入库文件，list 时现算；
    /// 空数组时序列化省略——前端需用 ?? [] 兜底）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stale_copies: Vec<String>,
    /// 各 agent 的分发形态（"symlink" | "copy"，list 时现算，仅启用的 agent 有键）
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub app_modes: HashMap<String, String>,
    /// SKILL.md 是否提到 MCP（含「推荐 MCP」段）：list 时现算，不入库文件
    #[serde(default)]
    pub mentions_mcp: bool,
    /// SKILL.md frontmatter 声明的产物路径（目录带尾斜杠、文件写全路径）：
    /// list 时现算，不入库文件；空数组 = 未声明（此时看 interface_inferred 是否经正文推断兜底）
    #[serde(default)]
    pub outputs: Vec<String>,
    /// SKILL.md frontmatter 声明的读取路径（口径同 outputs，list 时现算）
    #[serde(default)]
    pub inputs: Vec<String>,
    /// 可顶替的内置技能位（闭集=内置技能名；声明即接口契约。流水线占位 {skill:锚名} 与
    /// 前端行为键按它解析：步骤挂载的技能声明 provides 含某锚名即视作占据该位）。
    /// list 时现算，不入库文件
    #[serde(default)]
    pub provides: Vec<String>,
    /// 合成溯源（「AI 优化另存」新技能记录源技能名单）。只存 skills.json 不进 SKILL.md
    /// frontmatter——compose 重写链会剥字段；消费点只有展示（删除影响面/详情面板），
    /// 禁止任何「源变了合成技能失效」的运行时判定
    #[serde(default)]
    pub derived_from: Option<Vec<SkillDerivedFrom>>,
    /// inputs/outputs 来自正文推断而非 frontmatter 声明（外部技能常见；前端按「推断」口径提示）
    #[serde(default)]
    pub interface_inferred: bool,
    /// 库目录内容摘要（dir_manifest_hash，list 时现算，不入库文件）：
    /// 项目上下文与执行快照以此记录「本次用的是技能的哪个版本」（审计 §4.9）。
    #[serde(default)]
    pub content_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDto {
    pub name: String,
    pub description: String,
    pub path: String,
    pub from_agent: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportConflictDto {
    pub name: String,
    pub existing_id: Option<String>,
    pub source: String,
    pub update_available: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportResultDto {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub skipped: Vec<String>,
    pub conflicts: Vec<SkillImportConflictDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateDto {
    pub id: String,
    pub update_available: bool,
    pub current_revision: Option<String>,
    pub latest_revision: Option<String>,
    pub message: String,
}

// ===== 库与元数据存储 =====

#[derive(Debug, Clone)]
struct SkillStore {
    json_path: PathBuf,
    lib: PathBuf,
}

impl SkillStore {
    fn default_paths() -> Result<Self, String> {
        let dir = dirs::config_dir()
            .ok_or("无法确定平台配置目录")?
            .join("ccode");
        Ok(Self {
            json_path: dir.join("skills.json"),
            lib: dir.join("skills"),
        })
    }

    fn read(&self) -> Vec<SkillDto> {
        fs::read_to_string(&self.json_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn write(&self, skills: &[SkillDto]) -> Result<(), String> {
        let text = serde_json::to_string_pretty(skills).map_err(|e| e.to_string())?;
        crate::profiles::atomic_write(&self.json_path, &text)
    }

    fn skill_dir(&self, name: &str) -> PathBuf {
        self.lib.join(name)
    }
}

/// 九个 agent 的技能目录（§6.13；跟随与 MCP 相同的 *_HOME 搬迁变量）
fn agent_dirs() -> HashMap<String, PathBuf> {
    let mut m = HashMap::new();
    for spec in crate::agent_specs::all_agent_specs() {
        if let Some(dir) = crate::agent_specs::skills_dir_for(spec) {
            m.insert(spec.id.to_string(), dir);
        }
    }
    m
}

fn new_skill(
    name: String,
    description: Option<String>,
    source: &str,
    repo: Option<String>,
) -> SkillDto {
    let mut apps = HashMap::new();
    for spec in crate::agent_specs::all_agent_specs() {
        apps.insert(spec.id.to_string(), false);
    }
    SkillDto {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        description: description.unwrap_or_default(),
        source: source.to_string(),
        repo,
        repo_ref: None,
        repo_subdir: None,
        source_revision: None,
        apps,
        installed_at: crate::sessions::now_iso(),
        category: None,
        tags: Vec::new(),
        stale_copies: Vec::new(),
        app_modes: HashMap::new(),
        mentions_mcp: false,
        outputs: Vec::new(),
        inputs: Vec::new(),
        provides: Vec::new(),
        derived_from: None,
        interface_inferred: false,
        content_digest: None,
    }
}

// ===== 内置技能种子 =====

/// 种子版本：内置技能集合有新增/修订时 +1；启动时 marker 低于此版本才补播缺失项。
/// marker 是库目录下的 . 开头文件（发现逻辑跳过），记录已播种到的版本；
/// 用户删掉某个内置技能后不会被复活——逐技能删除墓碑（BUILTIN_TOMBSTONE_FILE）
/// 记下用户删过的内置技能名，版本升级补播时跳过墓碑项。
const BUILTIN_SEED_VERSION: u32 = 14;
const BUILTIN_SEED_MARKER: &str = ".builtin-seed-version";

/// 内置技能删除墓碑（库目录下 . 开头文件，一行一个技能名）：删除内置技能先落墓碑，
/// 之后任何种子版本升级都不再复活它——兑现删除弹层「内置技能删除后不再复活」的口径。
const BUILTIN_TOMBSTONE_FILE: &str = ".builtin-skill-tombstones";

/// 内置技能表：(技能名, SKILL.md 全文)。内容单一出处在 resources/skills/<name>/SKILL.md，
/// 经 include_str! 编进二进制，dev 与打包行为一致，无需配置 bundle resources。
static BUILTIN_SKILLS: &[(&str, &str)] = &[
    (
        "lit-search",
        include_str!("../resources/skills/lit-search/SKILL.md"),
    ),
    (
        "zotero-sync",
        include_str!("../resources/skills/zotero-sync/SKILL.md"),
    ),
    (
        "lit-notes",
        include_str!("../resources/skills/lit-notes/SKILL.md"),
    ),
    (
        "lit-watch",
        include_str!("../resources/skills/lit-watch/SKILL.md"),
    ),
    (
        "review-framework",
        include_str!("../resources/skills/review-framework/SKILL.md"),
    ),
    (
        "review-writing",
        include_str!("../resources/skills/review-writing/SKILL.md"),
    ),
    (
        "review-figures",
        include_str!("../resources/skills/review-figures/SKILL.md"),
    ),
    (
        "research-writing",
        include_str!("../resources/skills/research-writing/SKILL.md"),
    ),
    (
        "data-clean",
        include_str!("../resources/skills/data-clean/SKILL.md"),
    ),
    (
        "data-eda",
        include_str!("../resources/skills/data-eda/SKILL.md"),
    ),
    (
        "blender-research",
        include_str!("../resources/skills/blender-research/SKILL.md"),
    ),
    (
        "origin-plot",
        include_str!("../resources/skills/origin-plot/SKILL.md"),
    ),
    (
        "quarto-render",
        include_str!("../resources/skills/quarto-render/SKILL.md"),
    ),
    (
        "bib-check",
        include_str!("../resources/skills/bib-check/SKILL.md"),
    ),
    (
        "rebuttal-crafter",
        include_str!("../resources/skills/rebuttal-crafter/SKILL.md"),
    ),
    (
        "stats-check",
        include_str!("../resources/skills/stats-check/SKILL.md"),
    ),
    (
        "figure-forge",
        include_str!("../resources/skills/figure-forge/SKILL.md"),
    ),
    (
        "endnote-bridge",
        include_str!("../resources/skills/endnote-bridge/SKILL.md"),
    ),
    (
        "slides-deck",
        include_str!("../resources/skills/slides-deck/SKILL.md"),
    ),
    (
        "proposal-writer",
        include_str!("../resources/skills/proposal-writer/SKILL.md"),
    ),
    (
        "image-gen",
        include_str!("../resources/skills/image-gen/SKILL.md"),
    ),
];

/// 随技能一起播种/显式更新的驱动脚本，不能只更新 SKILL.md 留下失效入口。
/// lit_records.py 检索步与精读步都用（补字段 / 清单与 RIS / 写引文库），连同它依赖的 bridge.py 与
/// Mesa 期刊缩写兜底表各放一份——单一出处仍是仓库里那一个文件（2026-10-22）
static BUILTIN_SUPPORT: &[(&str, &str, &str)] = &[
    (
        "lit-search",
        "scripts/lit_records.py",
        include_str!("../resources/skills/lit-search/scripts/lit_records.py"),
    ),
    (
        "lit-search",
        "scripts/bridge.py",
        include_str!("../resources/skills/endnote-bridge/scripts/bridge.py"),
    ),
    (
        "lit-search",
        "scripts/journal-abbreviations.csv",
        include_str!("../resources/journal-abbreviations.csv"),
    ),
    (
        "lit-notes",
        "scripts/lit_records.py",
        include_str!("../resources/skills/lit-search/scripts/lit_records.py"),
    ),
    (
        "lit-notes",
        "scripts/bridge.py",
        include_str!("../resources/skills/endnote-bridge/scripts/bridge.py"),
    ),
    (
        "lit-notes",
        "scripts/journal-abbreviations.csv",
        include_str!("../resources/journal-abbreviations.csv"),
    ),
    (
        "endnote-bridge",
        "scripts/journal-abbreviations.csv",
        include_str!("../resources/journal-abbreviations.csv"),
    ),
    (
        "endnote-bridge",
        "scripts/bridge.py",
        include_str!("../resources/skills/endnote-bridge/scripts/bridge.py"),
    ),
    (
        "endnote-bridge",
        "scripts/cite_docx.py",
        include_str!("../resources/skills/endnote-bridge/scripts/cite_docx.py"),
    ),
    (
        "endnote-bridge",
        "scripts/library_match.py",
        include_str!("../resources/skills/endnote-bridge/scripts/library_match.py"),
    ),
    (
        "origin-plot",
        "scripts/plot_origin.py",
        include_str!("../resources/skills/origin-plot/scripts/plot_origin.py"),
    ),
    (
        "blender-research",
        "scripts/build_scene.py",
        include_str!("../resources/skills/blender-research/scripts/build_scene.py"),
    ),
    (
        "review-figures",
        "scripts/extract_figure.py",
        include_str!("../resources/skills/review-figures/scripts/extract_figure.py"),
    ),
    (
        "review-figures",
        "scripts/assemble_panels.py",
        include_str!("../resources/skills/review-figures/scripts/assemble_panels.py"),
    ),
    (
        "review-figures",
        "scripts/figure_sources.py",
        include_str!("../resources/skills/review-figures/scripts/figure_sources.py"),
    ),
    (
        "review-figures",
        "scripts/figure_permissions.py",
        include_str!("../resources/skills/review-figures/scripts/figure_permissions.py"),
    ),
    (
        "quarto-render",
        "ieee.csl",
        include_str!("../resources/skills/quarto-render/ieee.csl"),
    ),
    (
        "quarto-render",
        "author-date.csl",
        include_str!("../resources/skills/quarto-render/author-date.csl"),
    ),
    (
        "quarto-render",
        "scripts/citation_style.py",
        include_str!("../resources/skills/quarto-render/scripts/citation_style.py"),
    ),
    (
        "quarto-render",
        "scripts/manuscript_font.py",
        include_str!("../resources/skills/quarto-render/scripts/manuscript_font.py"),
    ),
    (
        "quarto-render",
        "scripts/references.lua",
        include_str!("../resources/skills/quarto-render/scripts/references.lua"),
    ),
    (
        "quarto-render",
        "scripts/check_pdf_text.py",
        include_str!("../resources/skills/quarto-render/scripts/check_pdf_text.py"),
    ),
    (
        "endnote-bridge",
        "scripts/sync_docx.py",
        include_str!("../resources/skills/endnote-bridge/scripts/sync_docx.py"),
    ),
    (
        "zotero-sync",
        "scripts/zotero_rtf.py",
        include_str!("../resources/skills/zotero-sync/scripts/zotero_rtf.py"),
    ),
    (
        "zotero-sync",
        "scripts/zotero_docx.py",
        include_str!("../resources/skills/zotero-sync/scripts/zotero_docx.py"),
    ),
];

fn builtin_files(name: &str) -> Vec<(&'static str, &'static str)> {
    let mut files = Vec::new();
    if let Some((_, seed)) = BUILTIN_SKILLS.iter().find(|(n, _)| *n == name) {
        files.push(("SKILL.md", *seed));
    }
    files.extend(
        BUILTIN_SUPPORT
            .iter()
            .filter(|(n, _, _)| *n == name)
            .map(|(_, path, text)| (*path, *text)),
    );
    files
}

/// 读内置技能删除墓碑，文件不存在按空表处理。
fn read_builtin_tombstones(store: &SkillStore) -> Vec<String> {
    fs::read_to_string(store.lib.join(BUILTIN_TOMBSTONE_FILE))
        .map(|t| {
            t.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 落一条内置技能删除墓碑（幂等去重、原子写）。
fn record_builtin_tombstone(store: &SkillStore, name: &str) -> Result<(), String> {
    let mut tombstones = read_builtin_tombstones(store);
    if tombstones.iter().any(|n| n == name) {
        return Ok(());
    }
    tombstones.push(name.to_string());
    fs::create_dir_all(&store.lib).map_err(|e| format!("创建技能库目录失败: {e}"))?;
    crate::profiles::atomic_write(
        &store.lib.join(BUILTIN_TOMBSTONE_FILE),
        &format!("{}\n", tombstones.join("\n")),
    )
}

/// 墓碑机制前的老版本删除的内置技能没有墓碑，但删除流程必留 skill-backups 备份：
/// 库里缺名却有同名备份 → 视同用户删过，补播时回填墓碑防复活。
fn deleted_builtin_has_backup(store: &SkillStore, name: &str) -> bool {
    let Some(root) = store.json_path.parent().map(|p| p.join("skill-backups")) else {
        return false;
    };
    let prefix = format!("{name}.");
    fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        })
        .unwrap_or(false)
}

/// 启动时播种内置技能（幂等）：只补库里没有的，同名技能（含用户自建/改过的）一律跳过，
/// 永不覆盖。返回本次新播种的技能名清单（无新增时为空）。
pub fn seed_builtin_skills() -> Result<Vec<String>, String> {
    let store = SkillStore::default_paths()?;
    seed_builtin_skills_impl(&store)
}

fn seed_builtin_skills_impl(store: &SkillStore) -> Result<Vec<String>, String> {
    let marker = store.lib.join(BUILTIN_SEED_MARKER);
    let seeded = fs::read_to_string(&marker)
        .ok()
        .and_then(|t| t.trim().parse::<u32>().ok())
        .unwrap_or(0);
    if seeded >= BUILTIN_SEED_VERSION {
        return Ok(Vec::new());
    }
    let mut skills = store.read();
    let mut tombstones = read_builtin_tombstones(store);
    let mut added = Vec::new();
    for (name, _content) in BUILTIN_SKILLS {
        if skills.iter().any(|s| s.name == *name) || store.skill_dir(name).exists() {
            continue; // 已有同名（含用户自建/改过的）：不覆盖
        }
        // 用户删过的内置技能不复活；墓碑机制前的老删除靠 skill-backups 备份回填墓碑
        if tombstones.iter().any(|n| n == name) {
            continue;
        }
        if deleted_builtin_has_backup(store, name) {
            record_builtin_tombstone(store, name)?;
            tombstones.push(name.to_string());
            continue;
        }
        let dir = store.skill_dir(name);
        fs::create_dir_all(&dir).map_err(|e| format!("创建内置技能目录失败: {e}"))?;
        for (relative, text) in builtin_files(name) {
            crate::profiles::atomic_write(&dir.join(relative), text)?;
        }
        let description = parse_skill_md(&dir.join("SKILL.md")).description;
        skills.push(new_skill(name.to_string(), description, "builtin", None));
        added.push(name.to_string());
    }
    if !added.is_empty() {
        store.write(&skills)?;
    }
    fs::create_dir_all(&store.lib).map_err(|e| format!("创建技能库目录失败: {e}"))?;
    fs::write(&marker, BUILTIN_SEED_VERSION.to_string())
        .map_err(|e| format!("写入种子版本标记失败: {e}"))?;
    if !added.is_empty() {
        crate::logbuf::record(
            "info",
            "skills",
            &format!(
                "内置技能播种：新增 {} 个（{}）",
                added.len(),
                added.join("、")
            ),
        );
    }
    Ok(added)
}

// ===== 内置技能更新（种子增强后老用户库内旧副本的追平通道，播种器永不覆盖的配套出口） =====

static BUILTIN_UPDATE_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct BuiltinUpdateGuard {
    _process: std::sync::MutexGuard<'static, ()>,
    _file: fs::File,
}
fn builtin_update_lock() -> Result<BuiltinUpdateGuard, String> {
    let process = BUILTIN_UPDATE_MUTEX.lock().map_err(|_| "技能更新锁失效")?;
    let file = crate::storage::config_lock("builtin-skills")?;
    Ok(BuiltinUpdateGuard {
        _process: process,
        _file: file,
    })
}

/// 内置技能更新检测：库内 SKILL.md 与内嵌种子逐字节不一致 → 返回技能名。
/// 只提示 skills.json 里 source == "builtin" 的项（同名用户自建技能不算）；
/// 库目录缺失/文件读失败 = 跳过（缺失归播种器管）。用户在内置技能上的自改同样算差异，
/// 照样提示，由用户决定是否更新（更新前自动备份）。
/// 2026-10-16 一次性把存量库早期以 local 进库的 14 个内置技能翻回 builtin 标签后，
/// source 单一口径重新成立，不再需要名单现算比对。
fn check_builtin_skill_updates_impl(store: &SkillStore) -> Vec<String> {
    let skills = store.read();
    let mut outdated = Vec::new();
    for (name, seed) in BUILTIN_SKILLS {
        if !skills
            .iter()
            .any(|s| s.name == *name && s.source == "builtin")
        {
            continue;
        }
        let Ok(current) = fs::read(store.skill_dir(name).join("SKILL.md")) else {
            continue;
        };
        if !bytes_eq_ignore_crlf(&current, seed.as_bytes())
            || builtin_files(name).iter().any(|(path, text)| {
                fs::read(store.skill_dir(name).join(path))
                    .map(|bytes| !bytes_eq_ignore_crlf(&bytes, text.as_bytes()))
                    .unwrap_or(true)
            })
        {
            outdated.push(name.to_string());
        }
    }
    outdated
}

/// 今天日期 yyyymmdd：内置技能更新备份（SKILL.md.bak-<date>）命名用
fn today_yyyymmdd() -> String {
    compact_iso(&crate::sessions::now_iso())
        .chars()
        .take(8)
        .collect()
}

/// 应用内置技能更新：现有 SKILL.md 先备份为同目录 SKILL.md.bak-<yyyymmdd>
/// （同日重复更新追加 -2/-3 防覆盖），再原子写入种子内容，skills.json 描述按新文件重解析。
fn apply_builtin_skill_update_impl(store: &SkillStore, name: &str) -> Result<(), String> {
    let Some((_, _seed)) = BUILTIN_SKILLS.iter().find(|(n, _)| *n == name) else {
        return Err(format!("「{name}」不是内置技能，无法一键更新"));
    };
    let dir = store.skill_dir(name);
    let md = dir.join("SKILL.md");
    if !md.is_file() {
        return Err(format!("库内缺少 {}（重启应用播种后再试）", md.display()));
    }
    let mut skills = store.read();
    let pos = skills
        .iter()
        .position(|s| s.name == name && s.source == "builtin")
        .ok_or("只允许更新已注册的内置技能")?;
    let mut originals: Vec<(PathBuf, Option<Vec<u8>>)> = Vec::new();
    for (relative, _) in builtin_files(name) {
        let path = dir.join(relative);
        if path
            .ancestors()
            .take_while(|p| *p != store.lib)
            .any(|p| fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()))
        {
            return Err(format!("技能文件路径经过符号链接，未覆盖：{relative}"));
        }
        let bytes = if path.exists() {
            Some(fs::read(&path).map_err(|e| format!("读取 {relative} 失败: {e}"))?)
        } else {
            None
        };
        originals.push((path, bytes));
    }
    let date = today_yyyymmdd();
    // 全部备份完成才开始写入；更新失败恢复本批文件，备份继续保留供人工恢复。
    for (path, bytes) in &originals {
        if let Some(bytes) = bytes {
            let base = format!("{}.bak-{date}", path.file_name().unwrap().to_string_lossy());
            let mut backup = path.with_file_name(&base);
            let mut seq = 2;
            while backup.exists() {
                backup = path.with_file_name(format!("{base}-{seq}"));
                seq += 1;
            }
            crate::storage::atomic_write(&backup, bytes, true)?;
        }
    }
    let write_result = (|| -> Result<(), String> {
        for (relative, text) in builtin_files(name) {
            crate::profiles::atomic_write(&dir.join(relative), text)?;
        }
        skills[pos].description = parse_skill_md(&md).description.unwrap_or_default();
        store.write(&skills)
    })();
    if let Err(error) = write_result {
        let mut failures = Vec::new();
        for (path, bytes) in &originals {
            let result = match bytes {
                Some(bytes) => crate::storage::atomic_write(path, bytes, false),
                None if path.exists() => fs::remove_file(path).map_err(|e| e.to_string()),
                None => Ok(()),
            };
            if let Err(e) = result {
                failures.push(e);
            }
        }
        return Err(format!(
            "技能更新失败：{error}；恢复情况：{}",
            if failures.is_empty() {
                "原文件已恢复".into()
            } else {
                failures.join("；")
            }
        ));
    }

    crate::logbuf::record(
        "info",
        "skills",
        &format!(
            "内置技能 {name} 已更新到最新版，原文件备份为 {}",
            format!("*.bak-{date}")
        ),
    );
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinSkillPreview {
    path: String,
    current: String,
    proposed: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinUpdatePreview {
    revision: String,
    files: Vec<BuiltinSkillPreview>,
}

#[tauri::command]
pub async fn preview_builtin_skill_update(name: String) -> Result<BuiltinUpdatePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = builtin_update_lock()?;
        let store = SkillStore::default_paths()?;
        if !store
            .read()
            .iter()
            .any(|s| s.name == name && s.source == "builtin")
        {
            return Err("不是已安装的内置技能".into());
        }
        let dir = store.skill_dir(&name);
        let revision = dir_manifest_hash(&dir).ok_or("无法核对技能版本")?;
        let files = builtin_files(&name)
            .into_iter()
            .map(|(path, proposed)| {
                let p = dir.join(path);
                if p.ancestors()
                    .take_while(|p| *p != store.lib)
                    .any(|p| fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()))
                {
                    return Err("更新路径经过符号链接，未读取".into());
                }
                if p.exists() && fs::metadata(&p).map_err(|e| e.to_string())?.len() > 256 * 1024 {
                    return Err("本机文件过大，请在文件预览中检查".into());
                }
                let current = if p.exists() {
                    fs::read_to_string(p).map_err(|e| e.to_string())?
                } else {
                    String::new()
                };
                Ok(BuiltinSkillPreview {
                    path: path.into(),
                    current,
                    proposed: proposed.into(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        if dir_manifest_hash(&dir).as_deref() != Some(&revision) {
            return Err("读取期间技能发生变化，请重新预览".into());
        }
        Ok(BuiltinUpdatePreview { revision, files })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== SKILL.md 防御式解析（开放标准：frontmatter 取 name/description/outputs/inputs，扩展字段忽略） =====

/// frontmatter 解析结果：outputs = 产物路径、inputs = 读取路径（目录带尾斜杠、文件写全路径）、
/// provides = 可顶替的内置技能位（闭集=内置技能名；声明即接口契约，流水线按它解析占位与行为键）
#[derive(Debug, Default, Clone, PartialEq)]
struct SkillFrontmatter {
    name: Option<String>,
    description: Option<String>,
    outputs: Vec<String>,
    inputs: Vec<String>,
    provides: Vec<String>,
}

/// 多行列表收集态：`outputs:`/`inputs:`/`provides:` 空值行之后连续的 `- item` 行都算条目
#[derive(Clone, Copy, PartialEq)]
enum ListKey {
    Outputs,
    Inputs,
    Provides,
}

fn parse_skill_md(path: &Path) -> SkillFrontmatter {
    let Ok(raw) = fs::read(path) else {
        return SkillFrontmatter::default();
    };
    parse_skill_md_text(&String::from_utf8_lossy(&raw))
}

fn parse_skill_md_text(text: &str) -> SkillFrontmatter {
    // BOM 与 CRLF 都容忍
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines();
    let mut parsed = SkillFrontmatter::default();
    if lines.next().map(|l| l.trim_end()) != Some("---") {
        return parsed;
    }
    let mut collecting: Option<ListKey> = None;
    for line in lines {
        let line = line.trim_end();
        if line == "---" {
            break;
        }
        if let Some(key) = collecting {
            if let Some(item) = line.trim_start().strip_prefix('-') {
                let item = item.trim().trim_matches('"').trim_matches('\'');
                if !item.is_empty() {
                    match key {
                        ListKey::Outputs => parsed.outputs.push(item.to_string()),
                        ListKey::Inputs => parsed.inputs.push(item.to_string()),
                        ListKey::Provides => parsed.provides.push(item.to_string()),
                    }
                }
                continue;
            }
            collecting = None;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        let inline_list = |target: &mut Vec<String>| {
            // 行内写法：`[a, b]` 或裸标量 `a`
            let inner = value
                .strip_prefix('[')
                .and_then(|s| s.strip_suffix(']'))
                .unwrap_or(value);
            target.extend(
                inner
                    .split(',')
                    .map(|s| s.trim().trim_matches('"').trim_matches('\''))
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
            );
        };
        match key.trim() {
            "name" if !value.is_empty() => parsed.name = Some(value.to_string()),
            "description" if !value.is_empty() => parsed.description = Some(value.to_string()),
            "outputs" => {
                if value.is_empty() {
                    collecting = Some(ListKey::Outputs);
                } else {
                    inline_list(&mut parsed.outputs);
                }
            }
            "inputs" => {
                if value.is_empty() {
                    collecting = Some(ListKey::Inputs);
                } else {
                    inline_list(&mut parsed.inputs);
                }
            }
            "provides" => {
                if value.is_empty() {
                    collecting = Some(ListKey::Provides);
                } else {
                    inline_list(&mut parsed.provides);
                }
            }
            _ => {}
        }
    }
    parsed
}

/// SKILL.md 正文（frontmatter 之后的部分）；无 frontmatter 或未闭合时按全文对待。
/// split_inclusive 保留行尾 \r\n，偏移量逐字节精确（CRLF 不错位）
fn skill_md_body(text: &str) -> &str {
    let text = text.trim_start_matches('\u{feff}');
    let mut segments = text.split_inclusive('\n');
    let Some(first) = segments.next() else {
        return text;
    };
    if first.trim_end() != "---" {
        return text;
    }
    let mut offset = first.len();
    for seg in segments {
        offset += seg.len();
        if seg.trim_end() == "---" {
            return &text[offset..];
        }
    }
    text
}

/// 正文路径推断（外部技能 frontmatter 未声明 inputs/outputs 时的兜底）：
/// 逐行找「像路径」的 token（含 / 或已知扩展名，剔除 URL 与中文 token），
/// 按行内动词线索分类读入/产出；行内无线索的不猜（宁缺毋滥，与内置表同原则）。
/// 推断结果只进 DTO（interface_inferred = true），不回写 SKILL.md。
fn infer_interface_from_body(body: &str) -> (Vec<String>, Vec<String>) {
    const OUTPUT_HINTS: &[&str] = &[
        "写入",
        "写到",
        "写出",
        "产出",
        "生成",
        "保存",
        "追加到",
        "输出到",
        "落盘",
        "落在",
        "write",
        "save",
        "creat",
        "produc",
        "generat",
        "append",
        "output",
    ];
    const INPUT_HINTS: &[&str] = &[
        "读取", "读入", "基于", "对照", "输入", "参考", "检查", "read", "load", "review", "check",
        "based on",
    ];
    const KNOWN_EXTS: &[&str] = &[
        ".md", ".bib", ".csv", ".pdf", ".tex", ".yaml", ".yml", ".json", ".toml", ".ris", ".docx",
        ".qmd",
    ];
    /// 路径 token 判定：含 / 或已知扩展名；剔除 URL、过短、含中文（「数据/图片」类误伤）
    fn looks_like_path(t: &str) -> bool {
        if t.len() < 3 || t.starts_with("http") || t.contains("://") {
            return false;
        }
        if t.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)) {
            return false;
        }
        t.contains('/') || KNOWN_EXTS.iter().any(|ext| t.ends_with(ext))
    }
    let mut inputs: Vec<String> = Vec::new();
    let mut outputs: Vec<String> = Vec::new();
    // 上限防噪：推断是兜底提示，不是全量清单
    const CAP: usize = 8;
    for line in body.lines() {
        if inputs.len() >= CAP && outputs.len() >= CAP {
            break;
        }
        let lower = line.to_lowercase();
        let is_output = OUTPUT_HINTS.iter().any(|h| lower.contains(h));
        let is_input = INPUT_HINTS.iter().any(|h| lower.contains(h));
        if is_output == is_input {
            continue; // 两侧都命中或都不命中 = 无线索，不猜
        }
        for token in line.split(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '`' | '"'
                        | '\''
                        | '('
                        | ')'
                        | '（'
                        | '）'
                        | '，'
                        | '。'
                        | '；'
                        | '：'
                        | '、'
                        | ','
                        | ';'
                        | '<'
                        | '>'
                        | '['
                        | ']'
                        | '{'
                        | '}'
                )
        }) {
            // 剥掉紧贴路径的中英文非路径字符（「写入papers/x.md。」「notes/下」这类无空格连写）
            let token = token
                .trim_start_matches(|c: char| {
                    !c.is_ascii_alphanumeric() && !matches!(c, '/' | '.' | '~' | '_')
                })
                .trim_end_matches(|c: char| {
                    !c.is_ascii_alphanumeric() && !matches!(c, '/' | '-' | '_')
                });
            if !looks_like_path(token) {
                continue;
            }
            let target = if is_output { &mut outputs } else { &mut inputs };
            if target.len() < CAP && !target.iter().any(|p| p == token) {
                target.push(token.to_string());
            }
        }
    }
    (inputs, outputs)
}

/// 由名称/描述/正文组成 SKILL.md 全文（frontmatter 写 name/description + 非空的
/// inputs/outputs/provides 多行列表，与解析口径一致）。描述强制单行：换行会破坏
/// frontmatter 的行解析。provides 必须原样保留——「适配到流水线」落盘与编辑器保存
/// 都走这里，漏掉等于把可顶替声明在最后一公里剥掉（2026-10-11 复审实证）
fn compose_skill_md(
    name: &str,
    description: &str,
    content: &str,
    inputs: &[String],
    outputs: &[String],
    provides: &[String],
) -> String {
    let desc = description.replace(['\r', '\n'], " ");
    let mut fm = format!("---\nname: {name}\ndescription: {}\n", desc.trim());
    let mut push_list = |key: &str, items: &[String]| {
        if items.is_empty() {
            return;
        }
        fm.push_str(&format!("{key}:\n"));
        for item in items {
            fm.push_str(&format!("  - {item}\n"));
        }
    };
    push_list("inputs", inputs);
    push_list("outputs", outputs);
    push_list("provides", provides);
    format!("{fm}---\n\n{}\n", content.trim())
}

// ===== 发现：含 SKILL.md 的目录即技能，找到不下钻，跳过 . 开头目录 =====

fn find_skill_dirs(root: &Path, out: &mut Vec<PathBuf>) {
    find_skill_dirs_at(root, out, 0);
}

fn find_skill_dirs_at(root: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > MAX_WALK_DEPTH || !root.is_dir() {
        return;
    }
    if root.join("SKILL.md").is_file() {
        out.push(root.to_path_buf());
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let skip = p
            .file_name()
            .map(|n| n.to_string_lossy().starts_with('.'))
            .unwrap_or(true);
        if !skip {
            find_skill_dirs_at(&p, out, depth + 1);
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    copy_dir_recursive_at(src, dst, 0)
}

fn copy_dir_recursive_at(src: &Path, dst: &Path, depth: usize) -> Result<(), String> {
    if depth > MAX_WALK_DEPTH {
        return Err(format!(
            "目录嵌套超过 {MAX_WALK_DEPTH} 层（疑似符号链接环）: {}",
            src.display()
        ));
    }
    fs::create_dir_all(dst).map_err(|e| format!("创建目录 {} 失败: {e}", dst.display()))?;
    let entries = fs::read_dir(src).map_err(|e| format!("读取目录 {} 失败: {e}", src.display()))?;
    for e in entries.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        // fs::copy 跟随符号链接复制内容（物化），与导入语义一致
        if from.is_dir() {
            copy_dir_recursive_at(&from, &to, depth + 1)?;
        } else if from.is_file() {
            fs::copy(&from, &to).map_err(|e| format!("复制 {} 失败: {e}", from.display()))?;
        }
    }
    Ok(())
}

fn validate_skill_name(name: &str) -> Result<(), String> {
    let path = Path::new(name);
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || path.is_absolute()
        || path.components().count() != 1
        || name.contains(['/', '\\', '\0'])
    {
        return Err(format!("技能名称必须是单个安全目录名: {name:?}"));
    }
    // 全平台同一套落盘规则：技能库要跨机同步，在 macOS 上放行 `图表*` 只会让它到了
    // Windows 建目录时抛 os error 123（用户看到裸系统错误）；尾部点/空格被 Windows
    // 静默剥掉后，skills.json 记的名字与盘上目录名会对不上，发现/漂移检测随之报错名。
    crate::paths::validate_fs_name(name).map_err(|e| format!("技能名称不合法：{e}"))?;
    Ok(())
}

fn backup_library_dir(store: &SkillStore, name: &str) -> Result<Option<PathBuf>, String> {
    let src = store.skill_dir(name);
    if !src.exists() {
        return Ok(None);
    }
    let root = store
        .json_path
        .parent()
        .ok_or("无法确定技能备份目录")?
        .join("skill-backups");
    fs::create_dir_all(&root).map_err(|e| format!("创建技能备份目录失败: {e}"))?;
    let mut dst = root.join(format!("{name}.{}", now_compact()));
    if dst.exists() {
        dst = root.join(format!(
            "{name}.{}-{}",
            now_compact(),
            &uuid::Uuid::new_v4().to_string()[..8]
        ));
    }
    fs::rename(&src, &dst).map_err(|e| format!("覆盖前备份技能 {name} 失败: {e}"))?;
    prune_backups(&root, name);
    Ok(Some(dst))
}

enum ImportDecision {
    Add(String),
    Overwrite,
    Skip,
    Conflict,
}

fn import_decision(
    store: &SkillStore,
    skills: &[SkillDto],
    name: &str,
    resolutions: Option<&HashMap<String, String>>,
) -> Result<ImportDecision, String> {
    validate_skill_name(name)?;
    let exists = skills.iter().any(|skill| skill.name == name) || store.skill_dir(name).exists();
    if !exists {
        return Ok(ImportDecision::Add(name.to_string()));
    }
    match resolutions
        .and_then(|items| items.get(name))
        .map(String::as_str)
    {
        Some("overwrite") => Ok(ImportDecision::Overwrite),
        Some("skip") => Ok(ImportDecision::Skip),
        Some(value) if value.starts_with("rename:") => {
            let target = value.trim_start_matches("rename:").trim();
            validate_skill_name(target)?;
            if skills.iter().any(|skill| skill.name == target) || store.skill_dir(target).exists() {
                return Err(format!("另存为名称已存在: {target}"));
            }
            Ok(ImportDecision::Add(target.to_string()))
        }
        Some(value) => Err(format!("未知冲突处理方式: {value}")),
        None => Ok(ImportDecision::Conflict),
    }
}

fn add_skill_from_dir(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    src_dir: &Path,
    install_name: &str,
    source: &str,
    repo: Option<String>,
) -> Result<(), String> {
    let dst = store.skill_dir(install_name);
    copy_dir_recursive(src_dir, &dst)?;
    let description = parse_skill_md(&dst.join("SKILL.md")).description;
    skills.push(new_skill(
        install_name.to_string(),
        description,
        source,
        repo,
    ));
    if let Err(e) = store.write(skills) {
        skills.pop();
        let _ = fs::remove_dir_all(&dst);
        return Err(e);
    }
    Ok(())
}

fn overwrite_skill_from_dir(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    src_dir: &Path,
    name: &str,
    source: &str,
    repo: Option<String>,
) -> Result<(), String> {
    let existing_pos = skills.iter().position(|skill| skill.name == name);
    let previous = existing_pos.map(|pos| skills[pos].clone());
    let backup = backup_library_dir(store, name)?;
    let dst = store.skill_dir(name);
    if let Err(e) = copy_dir_recursive(src_dir, &dst) {
        let _ = fs::remove_dir_all(&dst);
        if let Some(backup) = &backup {
            let _ = fs::rename(backup, &dst);
        }
        return Err(e);
    }
    let description = parse_skill_md(&dst.join("SKILL.md")).description;
    match existing_pos {
        Some(pos) => {
            skills[pos].description = description.unwrap_or_default();
            skills[pos].source = source.into();
            skills[pos].repo = repo;
            skills[pos].installed_at = crate::sessions::now_iso();
        }
        None => skills.push(new_skill(name.to_string(), description, source, repo)),
    }
    if let Err(e) = store.write(skills) {
        let _ = fs::remove_dir_all(&dst);
        if let Some(backup) = &backup {
            let _ = fs::rename(backup, &dst);
        }
        match (existing_pos, previous) {
            (Some(pos), Some(previous)) => skills[pos] = previous,
            (None, _) => {
                skills.pop();
            }
            _ => {}
        }
        return Err(e);
    }
    Ok(())
}

fn import_one_dir(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    src_dir: &Path,
    requested_name: Option<&str>,
    source: &str,
    repo: Option<String>,
    resolutions: Option<&HashMap<String, String>>,
    result: &mut SkillImportResultDto,
) -> Result<(), String> {
    let name = requested_name
        .map(ToOwned::to_owned)
        .or_else(|| {
            src_dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .ok_or("无法确定技能名称")?;
    match import_decision(store, skills, &name, resolutions)? {
        ImportDecision::Add(target) => {
            add_skill_from_dir(store, skills, src_dir, &target, source, repo)?;
            result.added.push(target);
        }
        ImportDecision::Overwrite => {
            overwrite_skill_from_dir(store, skills, src_dir, &name, source, repo)?;
            result.updated.push(name);
        }
        ImportDecision::Skip => result.skipped.push(name),
        ImportDecision::Conflict => {
            let existing = skills.iter().find(|skill| skill.name == name);
            result.conflicts.push(SkillImportConflictDto {
                name,
                existing_id: existing.map(|skill| skill.id.clone()),
                source: source.into(),
                update_available: source == "github"
                    && existing.and_then(|skill| skill.repo.as_ref()) == repo.as_ref(),
            });
        }
    }
    Ok(())
}

// ===== 分发：symlink 优先，失败回退 copy（带标记文件） =====

fn try_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dst)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(src, dst)
    }
}

/// 目标位置是否由我们管理：symlink 指向库目录，或带 .ccode-copy 标记的副本
fn is_ours(target: &Path, lib: &Path) -> bool {
    if let Ok(link) = fs::read_link(target) {
        return link.starts_with(lib);
    }
    target.join(MARKER_FILE).exists()
}

fn remove_ours(target: &Path, lib: &Path) -> Result<(), String> {
    if let Ok(link) = fs::read_link(target) {
        if link.starts_with(lib) {
            // 符号链接按文件删；Windows 目录符号链接需要 remove_dir
            fs::remove_file(target)
                .or_else(|_| fs::remove_dir(target))
                .map_err(|e| format!("移除链接 {} 失败: {e}", target.display()))?;
            return Ok(());
        }
    }
    if target.join(MARKER_FILE).exists() {
        fs::remove_dir_all(target).map_err(|e| format!("移除 {} 失败: {e}", target.display()))?;
    }
    // 无标记的目录视为用户自有内容，绝不动
    Ok(())
}

/// 卸载用：收回各 agent 技能目录里指向技能库的符号链接——库一进回收站，这些链接就全断了。
/// 带标记的副本自成一份、照样能用，留着；用户自有目录不碰。返回没能收回的项
pub(crate) fn unlink_distributed_for_uninstall() -> Vec<String> {
    match SkillStore::default_paths() {
        Ok(store) => unlink_links_into(&store.lib, &agent_dirs()),
        Err(e) => vec![format!("技能目录里的链接没有检查：{e}")],
    }
}

fn unlink_links_into(lib: &Path, dirs: &HashMap<String, PathBuf>) -> Vec<String> {
    let mut errors = Vec::new();
    let mut seen: Vec<&PathBuf> = Vec::new();
    for dir in dirs.values() {
        // 几家可能共用一个技能目录
        if seen
            .iter()
            .any(|d| crate::paths::same_path(&d.to_string_lossy(), &dir.to_string_lossy()))
        {
            continue;
        }
        seen.push(dir);
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let target = entry.path();
            let Ok(link) = fs::read_link(&target) else {
                continue;
            };
            if !crate::paths::path_within_path(&link, lib) {
                continue;
            }
            // 符号链接按文件删；Windows 目录符号链接需要 remove_dir
            if let Err(e) = fs::remove_file(&target).or_else(|_| fs::remove_dir(&target)) {
                errors.push(format!("技能链接 {} 没能移除：{e}", target.display()));
            }
        }
    }
    errors
}

fn apply_impl(
    store: &SkillStore,
    dirs: &HashMap<String, PathBuf>,
    id: &str,
    agent: &str,
    enabled: bool,
    allow_symlink: bool,
) -> Result<(), String> {
    let mut skills = store.read();
    let pos = skills
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| format!("技能不存在: {id}"))?;
    let name = skills[pos].name.clone();
    let lib_dir = store.skill_dir(&name);
    if !lib_dir.is_dir() {
        return Err(format!("库目录缺失: {}", lib_dir.display()));
    }
    let agent_root = dirs
        .get(agent)
        .ok_or_else(|| format!("未知 agent: {agent}"))?;
    let target = agent_root.join(&name);
    if enabled {
        // 先备好父目录再做删旧建新，缩短「旧分发已删、新分发未建」的窗口
        fs::create_dir_all(agent_root).map_err(|e| format!("创建目录失败: {e}"))?;
        if target.exists() || fs::read_link(&target).is_ok() {
            if !is_ours(&target, &store.lib) {
                return Err(format!(
                    "目标已存在且不是由 Mesa 管理，请先手动处理: {}",
                    target.display()
                ));
            }
            remove_ours(&target, &store.lib)?; // 重复应用 = 先清掉旧分发
        }
        let linked = allow_symlink && try_symlink(&lib_dir, &target).is_ok();
        if !linked {
            // Windows 无权限等场景回退为副本，标记以便日后区分用户自有内容
            let distribute = copy_dir_recursive(&lib_dir, &target).and_then(|_| {
                fs::write(target.join(MARKER_FILE), lib_dir.to_string_lossy().as_ref())
                    .map_err(|e| format!("写入标记失败: {e}"))
            });
            if let Err(e) = distribute {
                // 旧分发已删、新分发未建成：元数据回落为未启用，避免「显示启用但盘上无物」
                skills[pos].apps.insert(agent.to_string(), false);
                let _ = store.write(&skills);
                return Err(e);
            }
        }
    } else {
        remove_ours(&target, &store.lib)?;
    }
    skills[pos].apps.insert(agent.to_string(), enabled);
    store.write(&skills)
}

// ===== 删除与备份（保留每个名字最近 5 份） =====

fn backups_root() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("skill-backups"))
}

/// now_iso "2026-07-30T10:13:37Z" → "20260730-101337"
fn now_compact() -> String {
    compact_iso(&crate::sessions::now_iso())
}

/// 数字不足 9 位（格式漂移）时原样返回，不做硬切片 panic
fn compact_iso(iso: &str) -> String {
    let digits: String = iso.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() > 8 {
        format!("{}-{}", &digits[..8], &digits[8..])
    } else {
        digits
    }
}

fn prune_backups(backups: &Path, name: &str) {
    let Ok(entries) = fs::read_dir(backups) else {
        return;
    };
    let prefix = format!("{name}.");
    let mut mine: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with(&prefix))
                .unwrap_or(false)
        })
        .collect();
    mine.sort(); // 时间戳命名可字典序排序
    while mine.len() > BACKUP_KEEP {
        let _ = fs::remove_dir_all(mine.remove(0));
    }
}

fn bytes_eq_ignore_crlf(a: &[u8], b: &[u8]) -> bool {
    a.iter()
        .copied()
        .filter(|&c| c != b'\r')
        .eq(b.iter().copied().filter(|&c| c != b'\r'))
}

fn delete_impl(
    store: &SkillStore,
    dirs: &HashMap<String, PathBuf>,
    backups: &Path,
    id: &str,
) -> Result<(), String> {
    let mut skills = store.read();
    let pos = skills
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| format!("技能不存在: {id}"))?;
    let name = skills[pos].name.clone();
    // 内置技能先落删除墓碑再动手：墓碑写失败就放弃删除，免得「删了没记」
    // 导致下次种子版本升级把它复活（违背删除弹层「内置不复活」的口径）
    if skills[pos].source == "builtin" {
        record_builtin_tombstone(store, &name)?;
    }
    // 先备份再卸载：Windows 文件锁下 rename 失败时不得留下「显示启用但盘上无物」
    let lib_dir = store.skill_dir(&name);
    if lib_dir.exists() {
        fs::create_dir_all(backups).map_err(|e| format!("创建备份目录失败: {e}"))?;
        let dst = backups.join(format!("{name}.{}", now_compact()));
        fs::rename(&lib_dir, &dst).map_err(|e| format!("备份失败: {e}"))?;
        prune_backups(backups, &name);
    }
    for spec in crate::agent_specs::all_agent_specs() {
        if let Some(root) = dirs.get(spec.id) {
            let _ = remove_ours(&root.join(&name), &store.lib);
        }
    }
    skills.remove(pos);
    store.write(&skills)
}

// ===== ZIP 导入（安全三件套：预算 / 路径穿越 / symlink 物化） =====

fn import_zip_impl(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    zip_path: &Path,
    subdir: Option<&str>,
    source: &str,
    repo: Option<String>,
    resolutions: Option<&HashMap<String, String>>,
    only: Option<&str>,
) -> Result<SkillImportResultDto, String> {
    import_zip_limited(
        store,
        skills,
        zip_path,
        subdir,
        source,
        repo,
        resolutions,
        only,
        ZIP_MAX_UNCOMPRESSED,
    )
}

/// 按实际解压出的字节数累计计费，超过预算即中止（中央目录声明值不可信，防 zip 炸弹）
fn charge_bytes(extracted_total: &mut u64, bytes: usize, budget: u64) -> Result<(), String> {
    *extracted_total += bytes as u64;
    if *extracted_total > budget {
        return Err(format!(
            "ZIP 实际解压体积超过 {}MB 预算，中止解压",
            budget / 1024 / 1024
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn import_zip_limited(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    zip_path: &Path,
    subdir: Option<&str>,
    source: &str,
    repo: Option<String>,
    resolutions: Option<&HashMap<String, String>>,
    only: Option<&str>,
    max_uncompressed: u64,
) -> Result<SkillImportResultDto, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 ZIP 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 ZIP 失败: {e}"))?;
    if archive.len() > ZIP_MAX_ENTRIES {
        return Err(format!(
            "ZIP 条目过多（{} > {ZIP_MAX_ENTRIES}），拒绝解压",
            archive.len()
        ));
    }
    // 中央目录声明值只做快速预检；真实预算靠解压时逐字节累计（声明可能撒谎）
    let total: u64 = (0..archive.len())
        .map(|i| archive.by_index(i).map(|e| e.size()).unwrap_or(0))
        .sum();
    if total > max_uncompressed {
        return Err(format!(
            "ZIP 解压后体积超过 {}MB，拒绝解压",
            max_uncompressed / 1024 / 1024
        ));
    }
    // 找技能根：含 SKILL.md 的目录；嵌套命中的只保留最外层；子目录过滤（github subdir 参数）
    let mut roots: Vec<PathBuf> = Vec::new();
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else {
            continue;
        };
        let Some(name) = entry.enclosed_name() else {
            continue;
        }; // 路径穿越条目直接丢弃
        if name.file_name().map(|n| n == "SKILL.md").unwrap_or(false) {
            let root = name.parent().map(|p| p.to_path_buf()).unwrap_or_default();
            // zipball 有一层 <owner-repo-sha>/ 前缀；subdir 在其下匹配
            if let Some(sub) = subdir {
                let after_top: PathBuf = root.components().skip(1).collect();
                let sub = Path::new(sub);
                if !(after_top == sub || after_top.starts_with(sub)) {
                    continue;
                }
            }
            roots.push(root);
        }
    }
    roots.sort();
    roots.dedup();
    let all = roots.clone();
    roots.retain(|r| !all.iter().any(|o| o != r && r.starts_with(o)));
    // 一键更新只动目标技能：按安装名（= 技能根目录名）过滤，zip 里其他技能一律不碰
    if let Some(only) = only {
        roots.retain(|r| r.file_name().map(|n| n == only).unwrap_or(false));
    }
    let temp = std::env::temp_dir().join(format!("ccode-skill-import-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp).map_err(|e| format!("创建技能导入临时目录失败: {e}"))?;
    let imported = (|| {
        let mut result = SkillImportResultDto::default();
        let mut extracted_total: u64 = 0;
        for (index, root) in roots.into_iter().enumerate() {
            let install_name = root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| {
                    zip_path
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "skill".into())
                });
            let extracted = temp.join(index.to_string());
            for i in 0..archive.len() {
                let Ok(mut entry) = archive.by_index(i) else {
                    continue;
                };
                let Some(name) = entry.enclosed_name() else {
                    continue;
                };
                if name != root && !name.starts_with(&root) {
                    continue;
                }
                let rel = match name.strip_prefix(&root) {
                    Ok(rel) if !rel.as_os_str().is_empty() => rel.to_path_buf(),
                    _ => continue,
                };
                let out_path = extracted.join(&rel);
                if entry.is_dir() {
                    fs::create_dir_all(&out_path).map_err(|e| format!("创建 ZIP 目录失败: {e}"))?;
                    continue;
                }
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("创建 ZIP 文件目录失败: {e}"))?;
                }
                let mut buf = Vec::new();
                // 多读 1 字节探测超限，不按声明大小分配
                let probe = max_uncompressed.saturating_sub(extracted_total) + 1;
                std::io::Read::read_to_end(&mut std::io::Read::take(&mut entry, probe), &mut buf)
                    .map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;
                charge_bytes(&mut extracted_total, buf.len(), max_uncompressed)?;
                fs::write(&out_path, &buf)
                    .map_err(|e| format!("写入 {} 失败: {e}", out_path.display()))?;
            }
            if !extracted.join("SKILL.md").is_file() {
                return Err(format!("ZIP 中技能 {install_name} 缺少 SKILL.md"));
            }
            import_one_dir(
                store,
                skills,
                &extracted,
                Some(&install_name),
                source,
                repo.clone(),
                resolutions,
                &mut result,
            )?;
        }
        Ok(result)
    })();
    let _ = fs::remove_dir_all(&temp);
    imported
}

// ===== 导出 =====

fn export_impl(store: &SkillStore, ids: &[String], dest_path: &str) -> Result<String, String> {
    let skills = store.read();
    let file = fs::File::create(dest_path).map_err(|e| format!("创建导出文件失败: {e}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    let mut exported = 0;
    for id in ids {
        let Some(skill) = skills.iter().find(|s| &s.id == id) else {
            continue;
        };
        let src = store.skill_dir(&skill.name);
        if !src.is_dir() {
            continue;
        }
        let mut stack = vec![src.clone()];
        while let Some(dir) = stack.pop() {
            for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                let p = e.path();
                let rel = p.strip_prefix(&src).map_err(|e| e.to_string())?;
                let zip_name = format!(
                    "{}/{}",
                    skill.name,
                    rel.to_string_lossy().replace('\\', "/")
                );
                if p.is_dir() {
                    stack.push(p);
                } else if p.is_file() {
                    writer
                        .start_file(zip_name, options)
                        .map_err(|e| format!("写入 ZIP 失败: {e}"))?;
                    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
                    std::io::Write::write_all(&mut writer, &bytes).map_err(|e| e.to_string())?;
                }
            }
        }
        exported += 1;
    }
    if exported == 0 {
        return Err("没有可导出的技能".into());
    }
    writer.finish().map_err(|e| format!("完成 ZIP 失败: {e}"))?;
    Ok(dest_path.to_string())
}

// ===== copy 分发漂移检测（symlink 永远新，只有带标记的副本会旧） =====

/// 目录清单哈希：相对路径 + 大小 + 内容哈希（md5）逐文件计入后整体取 md5。
/// 漂移检测不需要抗碰撞；.ccode-copy 标记只有副本侧有，比较时统一排除。
fn dir_manifest_hash(root: &Path) -> Option<String> {
    if !root.is_dir() {
        return None;
    }
    let mut entries: Vec<(String, u64, String)> = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_WALK_DEPTH {
            continue; // 符号链接环等异常嵌套：超出部分不计入清单
        }
        for e in fs::read_dir(&dir).ok()?.flatten() {
            let p = e.path();
            let Ok(rel) = p.strip_prefix(root) else {
                continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                stack.push((p, depth + 1));
            } else if p.is_file() {
                if rel == MARKER_FILE {
                    continue;
                }
                let bytes = fs::read(&p).ok()?;
                entries.push((
                    rel,
                    bytes.len() as u64,
                    format!("{:x}", md5::compute(&bytes)),
                ));
            }
        }
    }
    entries.sort();
    let mut ctx = md5::Context::new();
    for (rel, size, hash) in entries {
        ctx.consume(rel.as_bytes());
        ctx.consume(b"\0");
        ctx.consume(size.to_string().as_bytes());
        ctx.consume(b"\0");
        ctx.consume(hash.as_bytes());
        ctx.consume(b"\0");
    }
    Some(format!("{:x}", ctx.compute()))
}

fn stale_agents(
    store: &SkillStore,
    dirs: &HashMap<String, PathBuf>,
    skill: &SkillDto,
) -> Vec<String> {
    let Some(lib_hash) = dir_manifest_hash(&store.skill_dir(&skill.name)) else {
        return Vec::new();
    };
    let mut stale = Vec::new();
    for (agent, enabled) in &skill.apps {
        if !enabled {
            continue;
        }
        let Some(root) = dirs.get(agent) else {
            continue;
        };
        let target = root.join(&skill.name);
        if !target.join(MARKER_FILE).exists() {
            continue; // symlink 或用户自有目录不在漂移检测范围
        }
        if dir_manifest_hash(&target).as_deref() != Some(lib_hash.as_str()) {
            stale.push(agent.clone());
        }
    }
    stale.sort();
    stale
}

/// 把 stale 的 copy 全部重新分发（保持 copy 形态），返回修复的 agent 列表
fn resync_impl(
    store: &SkillStore,
    dirs: &HashMap<String, PathBuf>,
    id: &str,
) -> Result<Vec<String>, String> {
    let skills = store.read();
    let skill = skills
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("技能不存在: {id}"))?;
    let stale = stale_agents(store, dirs, skill);
    for agent in &stale {
        apply_impl(store, dirs, id, agent, true, false)?;
    }
    Ok(stale)
}

// ===== Tauri commands =====

/// 某 agent 已启用的技能数（启动栏提示用）
#[tauri::command]
pub async fn count_enabled_skills(agent: String) -> usize {
    let store = match SkillStore::default_paths() {
        Ok(s) => s,
        Err(_) => return 0,
    };
    store
        .read()
        .iter()
        .filter(|s| s.apps.get(&agent).copied().unwrap_or(false))
        .count()
}

#[tauri::command]
pub async fn set_skill_category(id: String, category: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = SkillStore::default_paths()?;
        let mut skills = store.read();
        let s = skills
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("技能不存在: {id}"))?;
        s.category = category
            .filter(|c| !c.trim().is_empty())
            .map(|c| c.trim().to_string());
        store.write(&skills)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 无分类的 GitHub 技能批量回填仓库名分类（自动分类 #15 落地前的存量导入没有分类）。
/// 已有分类（含手动设置）一律不动；返回回填条数
fn backfill_categories_impl(store: &SkillStore) -> Result<usize, String> {
    let mut skills = store.read();
    let mut filled = 0usize;
    for s in &mut skills {
        if s.source != "github" || s.category.is_some() {
            continue;
        }
        if let Some(cat) = s.repo.as_deref().and_then(github_repo_category) {
            s.category = Some(cat);
            filled += 1;
        }
    }
    if filled > 0 {
        store.write(&skills)?;
    }
    Ok(filled)
}

#[tauri::command]
pub async fn backfill_skill_categories() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(|| backfill_categories_impl(&SkillStore::default_paths()?))
        .await
        .map_err(|e| e.to_string())?
}

const SKILL_TAG_MAX_COUNT: usize = 4;
const SKILL_TAG_MAX_LEN: usize = 20;

/// 标签校验：trim 后丢弃空项、保序去重、单个 ≤20 字符、总数 ≤4；空数组 = 清除全部标签
fn validate_skill_tags(tags: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in tags {
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if t.chars().count() > SKILL_TAG_MAX_LEN {
            return Err(format!("单个标签最长 {SKILL_TAG_MAX_LEN} 字符"));
        }
        if !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    if out.len() > SKILL_TAG_MAX_COUNT {
        return Err(format!("最多 {SKILL_TAG_MAX_COUNT} 个标签"));
    }
    Ok(out)
}

#[tauri::command]
pub async fn set_skill_tags(id: String, tags: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tags = validate_skill_tags(&tags)?;
        let store = SkillStore::default_paths()?;
        let mut skills = store.read();
        let s = skills
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("技能不存在: {id}"))?;
        s.tags = tags;
        store.write(&skills)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 各启用 agent 的分发形态：带 .ccode-copy 标记 = copy，否则 symlink（apps=true 的都是我们分发的）
fn app_modes(dirs: &HashMap<String, PathBuf>, skill: &SkillDto) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (agent, enabled) in &skill.apps {
        if !enabled {
            continue;
        }
        let Some(root) = dirs.get(agent) else {
            continue;
        };
        let target = root.join(&skill.name);
        if !target.exists() && !target.is_symlink() {
            continue; // 目标已被用户手动删掉
        }
        out.insert(
            agent.clone(),
            if target.join(MARKER_FILE).exists() {
                "copy".into()
            } else {
                "symlink".into()
            },
        );
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillSnapshot {
    pub name: String,
    pub library_digest: String,
    pub runtime_digest: Option<String>,
    pub source_revision: Option<String>,
    pub entry_text: String,
}

pub(crate) fn snapshot_named_skills(
    names: &[String],
    agent: &str,
) -> Result<Vec<SkillSnapshot>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let store = SkillStore::default_paths()?;
    snapshot_named_skills_at(&store, &agent_dirs(), names, agent)
}

fn snapshot_named_skills_at(
    store: &SkillStore,
    dirs: &HashMap<String, PathBuf>,
    names: &[String],
    agent: &str,
) -> Result<Vec<SkillSnapshot>, String> {
    let registry_text =
        fs::read_to_string(&store.json_path).map_err(|e| format!("读取技能库失败：{e}"))?;
    let registry: Vec<SkillDto> =
        serde_json::from_str(&registry_text).map_err(|e| format!("技能库损坏：{e}"))?;
    let runtime = dirs.get(agent);
    let mut out = Vec::new();
    for name in names {
        crate::paths::validate_fs_name(name)?;
        let skill = registry
            .iter()
            .find(|s| &s.name == name)
            .ok_or_else(|| format!("点名技能未安装：{name}"))?;
        let library_digest = dir_manifest_hash(&store.skill_dir(name))
            .ok_or_else(|| format!("无法核对技能版本：{name}"))?;
        let runtime_digest = runtime
            .as_ref()
            .and_then(|dir| dir_manifest_hash(&dir.join(name)));
        if runtime_digest.as_deref() != Some(library_digest.as_str()) {
            return Err(format!(
                "点名技能「{name}」尚未分发到所选 Agent 或副本已漂移，请先在技能页同步"
            ));
        }
        let entry_path = store.skill_dir(name).join("SKILL.md");
        if fs::metadata(&entry_path).map_err(|e| e.to_string())?.len() > 256 * 1024 {
            return Err(format!("技能 {name} 的入口超过 256 KB，未启动"));
        }
        let entry_text =
            fs::read_to_string(&entry_path).map_err(|e| format!("读取点名技能失败：{e}"))?;
        if entry_text.len() > 256 * 1024 {
            return Err(format!("技能 {name} 的入口超过 256 KB，未启动"));
        }
        out.push(SkillSnapshot {
            name: name.clone(),
            library_digest,
            runtime_digest,
            source_revision: skill.source_revision.clone(),
            entry_text,
        });
    }
    Ok(out)
}

/// SKILL.md 是否提到 MCP（「推荐 MCP」段也靠这个子串命中；读不到视为未提及）
fn mentions_mcp(md_path: &Path) -> bool {
    fs::read_to_string(md_path)
        .map(|t| t.contains("MCP"))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn list_skills() -> Vec<SkillDto> {
    let Ok(store) = SkillStore::default_paths() else {
        return Vec::new();
    };
    list_skills_impl(&store, &agent_dirs())
}

fn list_skills_impl(store: &SkillStore, dirs: &HashMap<String, PathBuf>) -> Vec<SkillDto> {
    let mut skills = store.read();
    for s in &mut skills {
        // 内置技能默认归「Mesa 内置」分组：二十来个内置技能全落「未分类」里翻找费劲
        // （2026-10-11 用户拍板）。只补展示层、不写盘——用户自己设过分组的（Some）不动，
        // 清空自定义分组后回落到默认组而不是「未分类」。
        if s.category.is_none() && s.source == "builtin" {
            s.category = Some("Mesa 内置".to_string());
        }
        // 老技能的 apps 表是创建时的注册表快照：后来接入的 agent（codebuddy/cursor/grok）
        // 缺键，前端「一键应用」按 apps 键过滤会永远跳过它们——list 时现算补齐
        // （不写盘；将来再接入新 agent 也免疫，无需迁移）
        for spec in crate::agent_specs::all_agent_specs() {
            s.apps.entry(spec.id.to_string()).or_insert(false);
        }
        s.stale_copies = stale_agents(store, dirs, s);
        s.app_modes = app_modes(dirs, s);
        s.mentions_mcp = mentions_mcp(&store.skill_dir(&s.name).join("SKILL.md"));
        // 版本摘要：执行快照与项目上下文按它记录技能版本（与漂移检测同一哈希口径）
        s.content_digest = dir_manifest_hash(&store.skill_dir(&s.name));
        // 接口口径（outputs/inputs）：frontmatter 声明优先；外部技能未声明时从正文推断兜底
        // （interface_inferred = true 供前端标注「推断」，不回写 SKILL.md）
        let md = store.skill_dir(&s.name).join("SKILL.md");
        let parsed = parse_skill_md(&md);
        s.outputs = parsed.outputs;
        s.inputs = parsed.inputs;
        s.provides = parsed.provides;
        s.interface_inferred = false;
        if s.outputs.is_empty() && s.inputs.is_empty() {
            if let Ok(text) = fs::read_to_string(&md) {
                let (inputs, outputs) = infer_interface_from_body(skill_md_body(&text));
                s.interface_inferred = !inputs.is_empty() || !outputs.is_empty();
                s.inputs = inputs;
                s.outputs = outputs;
            }
        }
    }
    skills
}

/// 技能声明的产物契约（frontmatter outputs；目录带尾斜杠）。定时巡检采纳白名单用（§4.9 后半）。
pub(crate) fn skill_declared_outputs(name: &str) -> Vec<String> {
    let Ok(store) = SkillStore::default_paths() else {
        return Vec::new();
    };
    let md = store.skill_dir(name).join("SKILL.md");
    parse_skill_md(&md).outputs
}

#[tauri::command]
pub async fn resync_skill_copies(id: String) -> Result<Vec<String>, String> {
    let store = SkillStore::default_paths()?;
    resync_impl(&store, &agent_dirs(), &id)
}

/// 各 agent 是否允许 symlink 分发（False = 强制 copy）。
/// 判定单一出处 = agent_specs 的 skill_dist 字段：cursor 的 ~/.cursor/skills-cursor
/// 未验证 CLI 是否真读、且 ~/.cursor 与 IDE 共享，保守走 copy（漂移检测/resync 沿用既有
/// copy 机制），不建 symlink；grok 的 ~/.grok/skills 是独占目录且文档确认读 SKILL.md，
/// 但首版未经实机验证，同样先强制 copy
fn allow_symlink_for(agent: &str) -> bool {
    match crate::agent_specs::agent_spec(agent).map(|s| s.skill_dist) {
        Some(crate::agent_specs::SkillDist::CopyOnly(_)) => false,
        // SymlinkOrCopy 与未知 agent（行为与收敛前一致）都 symlink 优先
        _ => true,
    }
}

#[tauri::command]
pub async fn apply_skill(id: String, agent: String, enabled: bool) -> Result<(), String> {
    let store = SkillStore::default_paths()?;
    apply_impl(
        &store,
        &agent_dirs(),
        &id,
        &agent,
        enabled,
        allow_symlink_for(&agent),
    )
}

/// 定时任务跑前：技能必须在库里且已分发到该 agent。
pub(crate) fn require_skill_distributed(skill_name: &str, agent: &str) -> Result<(), String> {
    let store = SkillStore::default_paths()?;
    require_skill_distributed_at(&store, skill_name, agent)
}

fn require_skill_distributed_at(
    store: &SkillStore,
    skill_name: &str,
    agent: &str,
) -> Result<(), String> {
    let skills = store.read();
    let skill = skills
        .iter()
        .find(|s| s.name == skill_name)
        .ok_or_else(|| format!("技能库没有「{skill_name}」，定时任务找不到规范"))?;
    if skill.apps.get(agent).copied().unwrap_or(false) {
        Ok(())
    } else {
        Err(format!(
            "技能「{skill_name}」未分发到 {agent}，去技能页打开开关"
        ))
    }
}

pub(crate) fn skill_id_by_name(name: &str) -> Result<String, String> {
    let store = SkillStore::default_paths()?;
    store
        .read()
        .into_iter()
        .find(|s| s.name == name)
        .map(|s| s.id)
        .ok_or_else(|| format!("技能库没有「{name}」"))
}

pub(crate) fn apply_skill_by_id(id: &str, agent: &str, enabled: bool) -> Result<(), String> {
    let store = SkillStore::default_paths()?;
    apply_impl(
        &store,
        &agent_dirs(),
        id,
        agent,
        enabled,
        allow_symlink_for(agent),
    )
}

/// 从完整 SKILL.md 落盘进库（确认后才调用）。category 如「巡检」。
pub(crate) fn create_skill_from_full_md(
    full_md: &str,
    fallback_name: &str,
    category: Option<&str>,
    derived_from: Option<Vec<SkillDerivedFrom>>,
) -> Result<SkillDto, String> {
    let store = SkillStore::default_paths()?;
    create_skill_from_full_md_at(&store, full_md, fallback_name, category, derived_from)
}

fn create_skill_from_full_md_at(
    store: &SkillStore,
    full_md: &str,
    fallback_name: &str,
    category: Option<&str>,
    derived_from: Option<Vec<SkillDerivedFrom>>,
) -> Result<SkillDto, String> {
    let text = extract_skill_md(full_md);
    let parsed = parse_skill_md_text(text);
    let body = skill_md_body(text);
    if body.trim().is_empty() {
        return Err("SKILL.md 正文为空，未写入".into());
    }
    let name = parsed
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty() && validate_skill_name(n).is_ok())
        .unwrap_or(fallback_name.trim())
        .to_string();
    validate_skill_name(&name)?;
    let desc = parsed.description.clone().unwrap_or_default();
    let mut skills = store.read();
    create_impl(store, &mut skills, &name, &desc, body)?;
    // provides-only 的稿（只声明顶位、无 inputs/outputs）也要过 update 写回声明——
    // 门槛漏掉会把合成稿的 provides 静默丢掉（2026-10-11 设计审查实证的漏网分支）
    if !parsed.inputs.is_empty() || !parsed.outputs.is_empty() || !parsed.provides.is_empty() {
        if let Err(e) = update_content_impl(
            store,
            &mut skills,
            &name,
            body,
            Some(desc),
            Some((parsed.inputs, parsed.outputs, parsed.provides)),
        ) {
            // 接口回写失败不留半成品：清掉刚建的条目再报错（best-effort，清理失败不掩盖原错误）
            skills.retain(|s| s.name != name);
            let _ = store.write(&skills);
            let _ = std::fs::remove_dir_all(store.skill_dir(&name));
            return Err(e);
        }
    }
    if let Some(src) = derived_from {
        if let Some(s) = skills.iter_mut().find(|s| s.name == name) {
            s.derived_from = Some(src);
            store.write(&skills)?;
        }
    }
    if let Some(cat) = category.map(str::trim).filter(|c| !c.is_empty()) {
        if let Some(s) = skills.iter_mut().find(|s| s.name == name) {
            s.category = Some(cat.to_string());
            store.write(&skills)?;
        }
    }
    store
        .read()
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| "技能已写入但读取失败".into())
}

#[tauri::command]
pub async fn delete_skill(id: String) -> Result<(), String> {
    let store = SkillStore::default_paths()?;
    delete_impl(&store, &agent_dirs(), &backups_root()?, &id)
}

#[tauri::command]
pub async fn import_skills_from_dir(
    path: String,
    resolutions: Option<HashMap<String, String>>,
) -> Result<SkillImportResultDto, String> {
    let store = SkillStore::default_paths()?;
    let root = PathBuf::from(crate::sessions::expand_tilde(&path));
    if !root.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }
    let mut found = Vec::new();
    find_skill_dirs(&root, &mut found);
    let mut skills = store.read();
    let mut result = SkillImportResultDto::default();
    for dir in found {
        import_one_dir(
            &store,
            &mut skills,
            &dir,
            None,
            "local",
            None,
            resolutions.as_ref(),
            &mut result,
        )?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn import_skills_from_zip(
    path: String,
    resolutions: Option<HashMap<String, String>>,
) -> Result<SkillImportResultDto, String> {
    let store = SkillStore::default_paths()?;
    let mut skills = store.read();
    import_zip_impl(
        &store,
        &mut skills,
        Path::new(&path),
        None,
        "zip",
        None,
        resolutions.as_ref(),
        None,
    )
}

fn github_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .user_agent("ccode-skills")
        .build()
        .map_err(|e| format!("创建 GitHub 客户端失败: {e}"))
}

/// 下载仓库 zipball：指定分支只试该 ref；未指定按 默认分支 → main → master 回退
async fn download_github_zipball(
    client: &reqwest::Client,
    repo: &str,
    branch: Option<&str>,
) -> Result<Vec<u8>, String> {
    let refs: Vec<String> = match branch {
        Some(b) => vec![b.to_string()],
        None => vec![String::new(), "main".into(), "master".into()],
    };
    let mut last_err = String::new();
    for r in &refs {
        let url = if r.is_empty() {
            format!("https://api.github.com/repos/{repo}/zipball")
        } else {
            format!("https://api.github.com/repos/{repo}/zipball/{r}")
        };
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => match download_limited(resp).await {
                Ok(bytes) => return Ok(bytes),
                Err(e) => last_err = e,
            },
            Ok(resp) => last_err = format!("GitHub 返回 {}", resp.status()),
            Err(e) => last_err = format!("请求 GitHub 失败: {e}"),
        }
    }
    Err(format!("下载 {repo} 失败: {last_err}"))
}

/// 导入/更新成功后回写 GitHub 来源元数据（ref/subdir/最新 revision/默认分类）
async fn record_github_revision(
    store: &SkillStore,
    repo: &str,
    branch: Option<&str>,
    subdir: Option<&str>,
    changed: std::collections::HashSet<&str>,
) -> Result<(), String> {
    if changed.is_empty() {
        return Ok(());
    }
    let client = github_client(30)?;
    let revision = github_latest_revision(&client, repo, branch).await.ok();
    let mut recorded = store.read();
    for skill in &mut recorded {
        if changed.contains(skill.name.as_str()) {
            skill.repo_ref = branch.map(ToOwned::to_owned);
            skill.repo_subdir = subdir.map(ToOwned::to_owned);
            skill.source_revision = revision.clone();
            // GitHub 导入自动分类（#15）：无分类时默认填仓库名（owner/repo 的 repo 段），已有分类不覆盖
            if skill.category.is_none() {
                skill.category = github_repo_category(repo);
            }
        }
    }
    store
        .write(&recorded)
        .map_err(|e| format!("技能已导入，但记录 GitHub 版本失败，重试导入即可补全: {e}"))
}

#[tauri::command]
pub async fn import_skills_from_github(
    repo: String,
    branch: Option<String>,
    subdir: Option<String>,
    resolutions: Option<HashMap<String, String>>,
) -> Result<SkillImportResultDto, String> {
    let repo = repo.trim().trim_matches('/').to_string();
    if repo.split('/').count() != 2 {
        return Err("仓库格式应为 owner/name".into());
    }
    let branch = branch.filter(|b| !b.trim().is_empty());
    let client = github_client(120)?;
    let bytes = download_github_zipball(&client, &repo, branch.as_deref()).await?;
    let tmp = std::env::temp_dir().join(format!("ccode-gh-{}.zip", uuid::Uuid::new_v4()));
    fs::write(&tmp, &bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    let store = SkillStore::default_paths()?;
    let mut skills = store.read();
    let result = import_zip_impl(
        &store,
        &mut skills,
        &tmp,
        subdir.as_deref(),
        "github",
        Some(repo.clone()),
        resolutions.as_ref(),
        None,
    );
    let _ = fs::remove_file(&tmp);
    let result = result?;
    let changed: std::collections::HashSet<&str> = result
        .added
        .iter()
        .chain(result.updated.iter())
        .map(String::as_str)
        .collect();
    record_github_revision(&store, &repo, branch.as_deref(), subdir.as_deref(), changed).await?;
    Ok(result)
}

/// 一键应用 GitHub 更新：按安装时记录的 repo/ref/subdir 重新下载，只覆盖该技能本身
/// （走既有 overwrite-with-backup 路径），成功后刷新 source_revision 基线。
/// zip 中同仓库的其他技能不新增不覆盖；找不到同名技能时提示改用「重新从 GitHub 导入」。
#[tauri::command]
pub async fn apply_skill_update(id: String) -> Result<SkillImportResultDto, String> {
    let store = SkillStore::default_paths()?;
    let skill = store
        .read()
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("技能不存在，可能已被删除")?;
    if skill.source != "github" || skill.repo.is_none() {
        return Err("该技能没有 GitHub 来源，无法一键更新".into());
    }
    let repo = skill.repo.clone().unwrap_or_default();
    let branch = skill.repo_ref.clone();
    let subdir = skill.repo_subdir.clone();
    let client = github_client(120)?;
    let bytes = download_github_zipball(&client, &repo, branch.as_deref()).await?;
    let tmp = std::env::temp_dir().join(format!("ccode-gh-{}.zip", uuid::Uuid::new_v4()));
    fs::write(&tmp, &bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    let mut skills = store.read();
    // 既有技能必然同名存在 → overwrite 命中覆盖+备份路径；zip 其余内容被 only 过滤
    let resolutions: HashMap<String, String> =
        HashMap::from([(skill.name.clone(), "overwrite".to_string())]);
    let result = import_zip_impl(
        &store,
        &mut skills,
        &tmp,
        subdir.as_deref(),
        "github",
        Some(repo.clone()),
        Some(&resolutions),
        Some(&skill.name),
    );
    let _ = fs::remove_file(&tmp);
    let result = result?;
    if !result.updated.iter().any(|n| n == &skill.name) {
        return Err(format!(
            "仓库 {repo} 最新版本中未找到技能 {}（可能已在上游改名或移动），请改用「重新从 GitHub 导入」",
            skill.name
        ));
    }
    record_github_revision(
        &store,
        &repo,
        branch.as_deref(),
        subdir.as_deref(),
        std::collections::HashSet::from([skill.name.as_str()]),
    )
    .await?;
    Ok(result)
}

/// 内置技能新版检测（best-effort，失败静默）：库副本与内嵌种子不一致的内置技能名列表
#[tauri::command]
pub async fn check_builtin_skill_updates() -> Vec<String> {
    let Ok(store) = SkillStore::default_paths() else {
        return Vec::new();
    };
    check_builtin_skill_updates_impl(&store)
}

/// 更新内置技能后顺带把新版拷给已启用它的 Agent 复制件（Mesa 分发的 copy，带标记文件）。
/// 人点「采用新版」就是要用新版：只更新库、让人再去点「同步副本」，Agent 下一轮读到的还是旧版
/// （2026-10-24 用户：更新完技能卡上又冒出「同步副本」，不知道什么意思）。返回同步了哪些 Agent。
fn apply_builtin_and_resync(
    store: &SkillStore,
    dirs: &HashMap<String, PathBuf>,
    name: &str,
) -> Result<Vec<String>, String> {
    apply_builtin_skill_update_impl(store, name)?;
    let Some(id) = store.read().into_iter().find(|s| s.name == name).map(|s| s.id) else {
        return Ok(Vec::new());
    };
    resync_impl(store, dirs, &id)
}

/// 一键更新内置技能为内嵌种子版（覆盖前原文件自动备份为同目录 SKILL.md.bak-<yyyymmdd>），
/// 并同步已分发的复制件；返回同步了的 Agent
#[tauri::command]
pub async fn apply_builtin_skill_update(
    name: String,
    expected_revision: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = builtin_update_lock()?;
        let store = SkillStore::default_paths()?;
        if dir_manifest_hash(&store.skill_dir(name.trim())).as_deref()
            != Some(expected_revision.as_str())
        {
            return Err("预览后技能发生变化，请重新查看差异再更新".into());
        }
        apply_builtin_and_resync(&store, &agent_dirs(), name.trim())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 边下边计数：content_length 预检 + 实际字节超限即中止（防 zipball 内存炸弹）
async fn download_limited(mut resp: reqwest::Response) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length() {
        if len > ZIP_MAX_DOWNLOAD {
            return Err(format!(
                "ZIP 体积 {}MB 超过 256MB 上限，拒绝下载",
                len / 1024 / 1024
            ));
        }
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载失败: {e}"))? {
        buf.extend_from_slice(&chunk);
        if buf.len() as u64 > ZIP_MAX_DOWNLOAD {
            return Err("ZIP 下载超过 256MB 上限，中止下载".into());
        }
    }
    Ok(buf)
}

/// GitHub 仓库（owner/name，导入入口已校验恰好两段）取 name 段作为默认分类名
fn github_repo_category(repo: &str) -> Option<String> {
    repo.rsplit('/')
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

async fn github_latest_revision(
    client: &reqwest::Client,
    repo: &str,
    reference: Option<&str>,
) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&format!("https://api.github.com/repos/{repo}/commits/"))
        .map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "无法构造 GitHub commit URL".to_string())?
        .pop_if_empty()
        .push(reference.unwrap_or("HEAD"));
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("检查 GitHub 版本失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub 版本接口返回 {}", response.status()));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析 GitHub 版本失败: {e}"))?;
    value
        .get("sha")
        .and_then(|sha| sha.as_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "GitHub 响应缺少 commit SHA".into())
}

#[tauri::command]
pub async fn check_skill_updates() -> Result<Vec<SkillUpdateDto>, String> {
    let store = SkillStore::default_paths()?;
    let skills: Vec<SkillDto> = store
        .read()
        .into_iter()
        .filter(|skill| skill.source == "github" && skill.repo.is_some())
        .collect();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("ccode-skills")
        .build()
        .map_err(|e| format!("创建 GitHub 客户端失败: {e}"))?;
    let mut cache: HashMap<(String, Option<String>), Result<String, String>> = HashMap::new();
    let mut out = Vec::new();
    for skill in skills {
        let repo = skill.repo.clone().unwrap_or_default();
        let key = (repo.clone(), skill.repo_ref.clone());
        let latest = if let Some(cached) = cache.get(&key) {
            cached.clone()
        } else {
            let value = github_latest_revision(&client, &repo, skill.repo_ref.as_deref()).await;
            cache.insert(key, value.clone());
            value
        };
        match latest {
            Ok(latest) => {
                let update_available = skill.source_revision.as_deref() != Some(latest.as_str());
                out.push(SkillUpdateDto {
                    id: skill.id,
                    update_available,
                    current_revision: skill.source_revision.clone(),
                    latest_revision: Some(latest),
                    message: if skill.source_revision.is_some() {
                        if update_available {
                            "GitHub 有新提交，可重新导入并选择覆盖".into()
                        } else {
                            "已是 GitHub 最新版本".into()
                        }
                    } else {
                        "旧记录没有安装版本；建议重新导入一次以建立更新基线".into()
                    },
                });
            }
            Err(message) => out.push(SkillUpdateDto {
                id: skill.id,
                update_available: false,
                current_revision: skill.source_revision,
                latest_revision: None,
                message,
            }),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn discover_unmanaged() -> Vec<DiscoveredDto> {
    let Ok(store) = SkillStore::default_paths() else {
        return Vec::new();
    };
    let skills = store.read();
    let known: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
    let mut roots: Vec<(String, PathBuf)> = agent_dirs().into_iter().collect();
    if let Some(home) = dirs::home_dir() {
        roots.push(("agents".to_string(), home.join(".agents").join("skills")));
    }
    let mut out = Vec::new();
    for (agent, root) in roots {
        let mut found = Vec::new();
        find_skill_dirs(&root, &mut found);
        for dir in found {
            let name = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if name.is_empty() || known.contains(&name.as_str()) {
                continue; // 已在库里的不重复收编
            }
            let description = parse_skill_md(&dir.join("SKILL.md")).description;
            out.push(DiscoveredDto {
                name,
                description: description.unwrap_or_default(),
                path: dir.to_string_lossy().into_owned(),
                from_agent: agent.clone(),
            });
        }
    }
    out
}

#[tauri::command]
pub async fn import_discovered(paths: Vec<String>) -> Result<SkillImportResultDto, String> {
    let store = SkillStore::default_paths()?;
    let mut skills = store.read();
    let mut result = SkillImportResultDto::default();
    for p in paths {
        let dir = PathBuf::from(&p);
        if dir.join("SKILL.md").is_file() {
            import_one_dir(
                &store,
                &mut skills,
                &dir,
                None,
                "discovered",
                None,
                None,
                &mut result,
            )?;
        }
    }
    // 同名冲突不静默吞：随结果透出给前端提示
    Ok(result)
}

#[tauri::command]
pub async fn export_skills(ids: Vec<String>, dest_path: String) -> Result<String, String> {
    let store = SkillStore::default_paths()?;
    export_impl(&store, &ids, &dest_path)
}

#[tauri::command]
pub async fn read_skill_md(id: String) -> Result<String, String> {
    let store = SkillStore::default_paths()?;
    let skills = store.read();
    let skill = skills
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("技能不存在: {id}"))?;
    let path = store.skill_dir(&skill.name).join("SKILL.md");
    let mut file = fs::File::open(&path).map_err(|e| format!("读取 SKILL.md 失败: {e}"))?;
    let mut buf = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(&mut file, MAX_READ_PREVIEW),
        &mut buf,
    )
    .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// ===== 新建 / 编辑（RX3b：用户沉淀自己的工作方法为技能） =====

/// 新建技能：写库目录 SKILL.md + 元数据登记（与 add_skill_from_dir 同口径：
/// 描述从落盘后的 SKILL.md 解析；元数据写失败回滚库目录）。重名拒绝，引导改用编辑。
fn create_impl(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    name: &str,
    description: &str,
    content: &str,
) -> Result<(), String> {
    validate_skill_name(name)?;
    if skills.iter().any(|skill| skill.name == name) || store.skill_dir(name).exists() {
        return Err(format!("技能「{name}」已存在，请改用「编辑内容」修改"));
    }
    let dst = store.skill_dir(name);
    fs::create_dir_all(&dst).map_err(|e| format!("创建技能目录失败: {e}"))?;
    if let Err(e) = fs::write(
        dst.join("SKILL.md"),
        compose_skill_md(name, description, content, &[], &[], &[]),
    ) {
        let _ = fs::remove_dir_all(&dst);
        return Err(format!("写入 SKILL.md 失败: {e}"));
    }
    let parsed_desc = parse_skill_md(&dst.join("SKILL.md")).description;
    // 新建标记 source="ccode"（删除保护的来源分类用；旧数据自建记 local，前端按导入对待）
    skills.push(new_skill(name.to_string(), parsed_desc, "ccode", None));
    if let Err(e) = store.write(skills) {
        skills.pop();
        let _ = fs::remove_dir_all(&dst);
        return Err(e);
    }
    Ok(())
}

/// 编辑技能内容：经临时目录走既有覆盖路径——SKILL.md 之外的辅助文件（模板等）原样保留，
/// 覆盖前备份、失败回滚、元数据描述更新全部复用 overwrite_skill_from_dir。
/// interface = Some((inputs, outputs)) 时改写 frontmatter 接口声明；None 时保留库中现状
/// （编辑正文不该静默丢掉外部技能已声明的 inputs/outputs）。
fn update_content_impl(
    store: &SkillStore,
    skills: &mut Vec<SkillDto>,
    name: &str,
    content: &str,
    description: Option<String>,
    interface: Option<(Vec<String>, Vec<String>, Vec<String>)>,
) -> Result<(), String> {
    validate_skill_name(name)?;
    let existing = skills
        .iter()
        .find(|skill| skill.name == name)
        .cloned()
        .ok_or_else(|| format!("技能不存在: {name}"))?;
    let lib_dir = store.skill_dir(name);
    if !lib_dir.is_dir() {
        return Err(format!("库目录缺失: {}", lib_dir.display()));
    }
    let temp = std::env::temp_dir().join(format!("ccode-skill-edit-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        copy_dir_recursive(&lib_dir, &temp)?;
        let desc = description.unwrap_or_else(|| existing.description.clone());
        let (inputs, outputs, provides) = interface.unwrap_or_else(|| {
            let keep = parse_skill_md(&lib_dir.join("SKILL.md"));
            (keep.inputs, keep.outputs, keep.provides)
        });
        fs::write(
            temp.join("SKILL.md"),
            compose_skill_md(name, &desc, content, &inputs, &outputs, &provides),
        )
        .map_err(|e| format!("写入 SKILL.md 失败: {e}"))?;
        // source/repo 保持原值：编辑不改写来源信息
        overwrite_skill_from_dir(
            store,
            skills,
            &temp,
            name,
            &existing.source,
            existing.repo.clone(),
        )
    })();
    let _ = fs::remove_dir_all(&temp);
    result
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPathDto {
    /// SKILL.md 绝对路径（◈ 优化指令引用）
    pub md_path: String,
    /// 技能库目录（◈ 优化开终端的 cwd）
    pub dir: String,
}

#[tauri::command]
pub async fn create_skill(
    name: String,
    description: String,
    content: String,
) -> Result<(), String> {
    let store = SkillStore::default_paths()?;
    let mut skills = store.read();
    create_impl(&store, &mut skills, name.trim(), &description, &content)
}

#[tauri::command]
pub async fn update_skill_content(
    name: String,
    content: String,
    description: Option<String>,
) -> Result<(), String> {
    let store = SkillStore::default_paths()?;
    let mut skills = store.read();
    update_content_impl(
        &store,
        &mut skills,
        name.trim(),
        &content,
        description,
        None,
    )
}

// ===== 「◈ 适配到流水线」（外部技能 → 流水线接口口径；两阶段：AI 出稿 → 人预览确认才落盘） =====

/// 适配稿 command 返回：技能名 + 改写后的 SKILL.md 全文（已过 redact_and_cap 脱敏截断）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAdaptDto {
    pub name: String,
    pub content: String,
    /// 路径和顶位声明已经符合流水线，没有再叫模型重写。
    pub unchanged: bool,
}

/// 适配 prompt（纯函数，可测）：规范路径表单一出处，改约定只动这里。
/// 口径与 pipeline-presets 模板的 expectedArtifacts/inputs 对齐
pub(crate) fn build_adapt_prompt(name: &str, current: &str) -> String {
    format!(
        "你是技能改写助手。下面是一份 agent 技能文件 SKILL.md「{name}」，和 Mesa 科研工作台的流水线路径约定。\n\n\
         【流水线路径约定（相对项目根）】\n\
         - papers/ 文献检索与筛选：screening.md 初筛、included.md 精读清单（流程正典）、reading-list.md 用户积累账（gitignored，只读进料、不回写不清空）、to-fetch.md 付费墙待办、watchlist.md 监控订阅；工作区 .ccode/handoff-lit-intake.md＝开工冻结的积累进料快照（只读）\n\
         - notes/ 精读笔记与文献雷达收件箱（inbox.md）\n\
         - references.bib 引文库（引用一律用 [@键] 对照它）\n\
         - outline.md 综述/论文大纲\n\
         - manuscript/ 稿件（draft.md、review-final.md、changelog.md、citation-check.md）\n\
         - output/ 渲染产物（draft.pdf、draft.docx）\n\
         - data/ 数据（原始数据只读，禁原地修改）、analysis/ 分析脚本与报告、figures/ 图表\n\n\
         【当前 SKILL.md】\n{current}\n\n\
         【改写要求】\n\
         1. 保持技能的核心方法论与检查清单不变，只把读取/产出路径对齐到上述约定；\
         约定表里没有的新路径可保留，但与约定冲突的一律改按约定；\n\
         2. frontmatter 保留 name/description，并补写 inputs: 与 outputs: 多行列表\
         （`  - 路径` 写法，目录带尾斜杠、文件写全路径；没有的一侧省略）；\n\
         3. 若本技能的职责能顶替某个内置技能位（检索=lit-search、精读=lit-notes、框架=review-framework、\n\
         综述写作=review-writing、拼图=review-figures、论文写作=research-writing、开题=proposal-writer、\n\
         审稿回复=rebuttal-crafter、清洗=data-clean、探索=data-eda、统计审查=stats-check、出图=figure-forge、\n\
         渲染=quarto-render、引用校验=bib-check、汇报=slides-deck、监控=lit-watch、Zotero 同步=zotero-sync、EndNote 桥接=endnote-bridge、Origin 出图=origin-plot、Blender 示意=blender-research），\n\
         在 frontmatter 补写 provides: [位名]——声明后流水线步骤里可用本技能顶替该内置位；\n\
         职责对不上任何内置位就省略 provides，不要硬凑；\n\
         4. 保持单文件轻量规范（约 100 行内），不加脚本/JSON 中间件/lint 体系；\n\
         5. 只输出完整的新版 SKILL.md 全文（含 frontmatter），不要解释、不要代码围栏。"
    )
}

/// 流水线能识别的内置技能位。适配稿里写了别的 provides 会被丢掉，避免声明了却顶不上位。
const PIPELINE_SLOTS: &[&str] = &[
    "lit-search",
    "lit-notes",
    "review-framework",
    "review-writing",
    "review-figures",
    "research-writing",
    "proposal-writer",
    "rebuttal-crafter",
    "data-clean",
    "data-eda",
    "stats-check",
    "figure-forge",
    "quarto-render",
    "bib-check",
    "slides-deck",
    "lit-watch",
    "zotero-sync",
    "endnote-bridge",
    "origin-plot",
    "blender-research",
];

/// 把模型输出收成一份能写回的 SKILL.md。缺 frontmatter、正文为空、或被 64KB 截断时拒绝，
/// 不把半份稿写进技能库。provides 只留流水线认识的位名。
fn usable_adapt_draft(raw: &str) -> Result<String, String> {
    if raw.contains("简报超过 64KB 上限") {
        return Err("适配稿过长被截断，不能写回技能库。请缩短技能后重试".into());
    }
    let text = extract_skill_md(raw).trim();
    if !text.starts_with("---") {
        return Err("适配稿不是完整的 SKILL.md（没有 frontmatter），不能写回。请重试".into());
    }
    let mut parsed = parse_skill_md_text(text);
    let body = skill_md_body(text).trim();
    if body.is_empty() {
        return Err("适配稿正文为空，不能写回".into());
    }
    parsed
        .provides
        .retain(|slot| PIPELINE_SLOTS.iter().any(|known| known == slot));
    let name = parsed
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("skill");
    let desc = parsed.description.unwrap_or_default();
    Ok(compose_skill_md(
        name,
        &desc,
        body,
        &parsed.inputs,
        &parsed.outputs,
        &parsed.provides,
    ))
}

/// AI 输出容错：剥掉首尾代码围栏（模型偶尔无视「不要代码围栏」）
fn strip_code_fence(text: &str) -> &str {
    let t = text.trim();
    let Some(first_nl) = t.find('\n') else {
        return t;
    };
    if !t.starts_with("```") {
        return t;
    }
    let body = &t[first_nl + 1..];
    body.strip_suffix("```").map(str::trim_end).unwrap_or(t)
}

/// 草稿里可能夹着前言和代码围栏：取第一段 `---` frontmatter 起的 SKILL.md。
fn extract_skill_md(text: &str) -> &str {
    let t = strip_code_fence(text).trim();
    let start = if t.starts_with("---") {
        t
    } else if let Some(i) = t.find("\n---") {
        t[i + 1..].trim()
    } else {
        t
    };
    if let Some((head, tail)) = start.rsplit_once("\n```") {
        if tail.trim().is_empty() {
            return head.trim();
        }
    }
    start
}

/// 已有 inputs/outputs，且 provides 是流水线认识的位，或正文已在用约定路径。
/// 这种技能再整篇重写只会卡住，原稿就可以写回。
fn already_pipeline_aligned(text: &str) -> bool {
    let parsed = parse_skill_md_text(text);
    let has_interface = !parsed.inputs.is_empty() || !parsed.outputs.is_empty();
    if !has_interface {
        return false;
    }
    let known = parsed
        .provides
        .iter()
        .any(|slot| PIPELINE_SLOTS.iter().any(|known| known == slot));
    if known {
        return true;
    }
    let body = skill_md_body(text);
    ["papers/", "notes/", "references.bib", "manuscript/", "outline.md"]
        .iter()
        .any(|path| body.contains(path))
}

fn adapt_skill_to_pipeline_impl(
    profiles: Vec<crate::profiles::Profile>,
    id: &str,
) -> Result<SkillAdaptDto, String> {
    let store = SkillStore::default_paths()?;
    let skills = store.read();
    let skill = skills
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("技能不存在: {id}"))?;
    let md_path = store.skill_dir(&skill.name).join("SKILL.md");
    let current = fs::read_to_string(&md_path).map_err(|e| format!("读取 SKILL.md 失败: {e}"))?;
    if already_pipeline_aligned(&current) {
        return Ok(SkillAdaptDto {
            name: skill.name.clone(),
            content: current,
            unchanged: true,
        });
    }
    // 与「◈ 融合进任务书」同口径：超长中段挖空截 24KB，profile 走设置页 distill 功能键
    let prompt = build_adapt_prompt(
        &skill.name,
        &crate::ai::cap_text_middle(&current, 24 * 1024),
    );
    let ai_out = crate::ai::ai_prompt_impl(profiles, None, Some(crate::ai::FN_DISTILL), prompt)?;
    let redacted = crate::handoff::redact_and_cap(&ai_out);
    let content = usable_adapt_draft(&redacted)?;
    Ok(SkillAdaptDto {
        name: skill.name.clone(),
        content,
        unchanged: false,
    })
}

/// 「◈ 适配到流水线」第一阶段：AI 按流水线路径约定改写 SKILL.md（不写盘，前端预览/编辑后确认）
#[tauri::command]
pub async fn adapt_skill_to_pipeline(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    id: String,
) -> Result<SkillAdaptDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || adapt_skill_to_pipeline_impl(profiles, &id))
        .await
        .map_err(|e| format!("适配到流水线失败: {e}"))?
}

/// 整份 SKILL.md 落盘（适配稿确认用）：frontmatter 由后端重新解析组装——
/// name 强制沿用库中条目（目录名不可改），description/inputs/outputs 取稿件解析值，
/// 正文取 frontmatter 之后的部分；写路径复用 update_content_impl（备份/回滚同口径）
#[tauri::command]
pub async fn write_skill_md(name: String, full_text: String) -> Result<(), String> {
    let store = SkillStore::default_paths()?;
    let mut skills = store.read();
    // 确认写回的就是预览里那份能解析的稿：前言、围栏先剥掉，缺结构直接拒绝。
    let full_text = usable_adapt_draft(&full_text)?;
    let parsed = parse_skill_md_text(&full_text);
    let body = skill_md_body(&full_text);
    update_content_impl(
        &store,
        &mut skills,
        name.trim(),
        body,
        parsed.description,
        Some((parsed.inputs, parsed.outputs, parsed.provides)),
    )
}

/// 「AI 优化另存」出稿 prompt（纯函数，可测）：多源合成一份，内置源的流水线落点为骨架、
/// 人的优化方向优先级最高，职责对得上内置位才声明 provides（锚名闭集与 build_adapt_prompt 同表）。
fn build_optimize_prompt(sources: &[(String, String)], direction: &str) -> String {
    let mut body = String::from("你是技能合成助手。下面是若干份 agent 技能文件（SKILL.md）和一条优化方向；把它们优化/合成为一份新的 SKILL.md。\n\n【源技能】\n");
    for (i, (name, text)) in sources.iter().enumerate() {
        body.push_str(&format!("### 源 {}：{name}\n{text}\n\n", i + 1));
    }
    format!(
        "{body}【优化方向（人的要求，优先级最高）】\n{direction}\n\n【合成要求】\n\
         1. 只输出一份完整的新版 SKILL.md 全文（含 frontmatter），不要解释、不要代码围栏；认为该拆成多份时只能作为正文建议写出，不得输出多份；\n\
         2. 方法论融合：多源时融合各源的方法、检查清单与口径，单源时优化它；源是内置技能的，其流水线落点（papers/、notes/、references.bib、manuscript/、output/、data/、analysis/、figures/）与结构为骨架原样保留；与优化方向冲突的一律以方向为准；\n\
         3. frontmatter 写 name/description，补写 inputs: 与 outputs: 多行列表（`  - 路径` 写法，目录带尾斜杠、文件写全路径；没有的一侧省略），description 末尾注明「综合自 各源技能名」；\n\
         4. 职责能顶替内置位时补写 provides: [位名]（检索=lit-search、精读=lit-notes、框架=review-framework、综述写作=review-writing、拼图=review-figures、论文写作=research-writing、开题=proposal-writer、审稿回复=rebuttal-crafter、清洗=data-clean、探索=data-eda、统计审查=stats-check、出图=figure-forge、渲染=quarto-render、引用校验=bib-check、汇报=slides-deck、监控=lit-watch、Zotero 同步=zotero-sync、EndNote 桥接=endnote-bridge、Origin 出图=origin-plot、Blender 示意=blender-research），对不上不硬凑；\n\
         5. name 用小写字母数字连字符、体现优化方向（如 lit-search-enhanced）；保持单文件轻量规范（约 100 行内），不加脚本/JSON 中间件。"
    )
}

/// 多源截断预算（2026-10-11 拍板）：总量 48KB 上限、单源保底 8KB，超出均分。
/// 单源全宽 48KB；源越多每份越窄，但不低于 8KB（源极多时总量允许超 48KB——保底优先）。
fn optimize_source_budget(count: usize) -> usize {
    if count == 0 {
        return 0;
    }
    (48 * 1024 / count).max(8 * 1024)
}

fn optimize_skills_draft_impl(
    profiles: Vec<crate::profiles::Profile>,
    ids: &[String],
    direction: &str,
) -> Result<SkillAdaptDto, String> {
    let store = SkillStore::default_paths()?;
    let skills = store.read();
    let mut sources: Vec<(String, String)> = Vec::new();
    let budget = optimize_source_budget(ids.len());
    for id in ids {
        let skill = skills
            .iter()
            .find(|s| &s.id == id)
            .ok_or_else(|| format!("技能不存在: {id}"))?;
        let md = fs::read_to_string(store.skill_dir(&skill.name).join("SKILL.md"))
            .map_err(|e| format!("读取 {} 失败: {e}", skill.name))?;
        sources.push((skill.name.clone(), crate::ai::cap_text_middle(&md, budget)));
    }
    if sources.is_empty() {
        return Err("没有选择源技能".into());
    }
    let prompt = build_optimize_prompt(&sources, direction);
    let ai_out = crate::ai::ai_prompt_impl(profiles, None, Some(crate::ai::FN_SKILL_OPTIMIZE), prompt)?;
    let redacted = crate::handoff::redact_and_cap(&ai_out);
    let text = extract_skill_md(&redacted);
    if text.trim().is_empty() {
        return Err("AI 没有产出优化稿，请重试".into());
    }
    // AI 建议名（frontmatter name）随稿带回，前端预填、人可改
    let suggested = parse_skill_md_text(text)
        .name
        .filter(|n| validate_skill_name(n).is_ok())
        .unwrap_or_default();
    Ok(SkillAdaptDto {
        name: suggested,
        content: text.to_string(),
        unchanged: false,
    })
}

/// 「AI 优化另存」第一阶段：多源合成出稿（不写盘，前端预览/编辑后确认）
#[tauri::command]
pub async fn optimize_skills_draft(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    ids: Vec<String>,
    direction: String,
) -> Result<SkillAdaptDto, String> {
    let direction = direction.trim().to_string();
    if direction.is_empty() {
        return Err("优化方向不能为空".into());
    }
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || optimize_skills_draft_impl(profiles, &ids, &direction))
        .await
        .map_err(|e| format!("AI 优化出稿失败: {e}"))?
}

/// 「AI 优化另存」第二阶段：整稿落库为新技能（source=ccode、provides 全保留、derivedFrom 溯源）。
/// name 是**权威名**（预览屏输入框的值）：非空合法时覆盖稿内 frontmatter 的 name——
/// 只当 fallback 的话，AI 稿必带合法 frontmatter 名，用户改名会被静默压掉（2026-10-11 复审实证）。
#[tauri::command]
pub async fn create_user_skill(
    full_text: String,
    name: String,
    derived_from: Option<Vec<String>>,
) -> Result<SkillDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = name.trim();
        if name.is_empty() {
            return Err("请填写新技能名（AI 建议名在预览输入框里，可改）".into());
        }
        // 权威名写回 frontmatter：稿内 name 行替换为用户确认的名字
        let rewritten = rewrite_frontmatter_name(&full_text, name);
        let derived = derived_from.map(|names| {
            names
                .into_iter()
                .filter(|n| !n.trim().is_empty())
                .map(|name| SkillDerivedFrom { name, digest: None })
                .collect::<Vec<_>>()
        });
        create_skill_from_full_md(&rewritten, name, None, derived)
    })
    .await
    .map_err(|e| format!("创建技能失败: {e}"))?
}

/// 把 SKILL.md 稿 frontmatter 的 name 行替换为权威名；无 frontmatter 或无 name 行时
/// 原样返回（create_skill_from_full_md_at 的 fallback 兜底）。只动 name 行，其余逐字节保留。
fn rewrite_frontmatter_name(full_md: &str, name: &str) -> String {
    let text = full_md.trim_start_matches('\u{feff}');
    let mut lines = text.lines().peekable();
    if lines.peek() != Some(&"---") {
        return full_md.to_string();
    }
    let mut out: Vec<String> = vec!["---".to_string()];
    let mut in_fm = true;
    let mut replaced = false;
    let mut saw_name = false;
    for line in lines.by_ref().skip(1) {
        if !in_fm {
            out.push(line.to_string());
            continue;
        }
        if line.trim_end() == "---" {
            if !replaced && !saw_name {
                // frontmatter 没有 name 行：插一行（合法位置：首键之前不强求，放最前最稳）
                out.push(format!("name: {name}"));
            }
            out.push(line.to_string());
            in_fm = false;
            continue;
        }
        if let Some((key, _)) = line.split_once(':') {
            if key.trim() == "name" {
                saw_name = true;
                out.push(format!("name: {name}"));
                replaced = true;
                continue;
            }
        }
        out.push(line.to_string());
    }
    if in_fm {
        // frontmatter 未闭合：不动，交给下游解析兜底
        return full_md.to_string();
    }
    let mut body = out.join("\n");
    if !body.ends_with('\n') {
        body.push('\n');
    }
    if !full_md.ends_with('\n') {
        body.pop();
    }
    body
}

#[tauri::command]
pub async fn skill_md_path(id: String) -> Result<SkillPathDto, String> {
    let store = SkillStore::default_paths()?;
    let skills = store.read();
    let skill = skills
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("技能不存在: {id}"))?;
    let dir = store.skill_dir(&skill.name);
    if !dir.is_dir() {
        return Err(format!("库目录缺失: {}", dir.display()));
    }
    Ok(SkillPathDto {
        md_path: dir.join("SKILL.md").to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;


#[test]
    fn optimize_prompt_carries_sources_direction_and_provides_rule() {
        let prompt = build_optimize_prompt(
            &[("lit-search".into(), "内置检索技能正文".into()), ("my-search".into(), "用户技能正文".into())],
            "把我的检索习惯融进去，保留严格档",
        );
        assert!(prompt.contains("### 源 1：lit-search"));
        assert!(prompt.contains("### 源 2：my-search"));
        assert!(prompt.contains("把我的检索习惯融进去，保留严格档"));
        assert!(prompt.contains("优先级最高"));
        assert!(prompt.contains("provides: [位名]"));
        assert!(prompt.contains("不得输出多份"));
    }

    #[test]
    fn optimize_budget_total_cap_single_floor() {
        assert_eq!(optimize_source_budget(0), 0);
        assert_eq!(optimize_source_budget(1), 48 * 1024);
        assert_eq!(optimize_source_budget(6), 8 * 1024);
        // 源极多时保底优先（总量允许超 48KB）
        assert_eq!(optimize_source_budget(10), 8 * 1024);
    }

    #[test]
    fn full_md_provides_only_survives_create() {
        let fx = Fx::new();
        let md = "---\nname: merged-skill\ndescription: 综合自 lit-search\nprovides: [lit-search]\n---\n\n正文\n".replace("\\n", "\n");
        let skill = create_skill_from_full_md_at(&fx.store, &md, "fallback", None, None).unwrap();
        assert_eq!(skill.name, "merged-skill");
        assert!(skill.derived_from.is_none());
        // 落盘文件里 provides 必须在（此前门槛漏掉 provides-only 稿）
        let written = fs::read_to_string(fx.store.skill_dir("merged-skill").join("SKILL.md")).unwrap();
        assert!(written.contains("provides:"));
        let parsed = parse_skill_md_text(&written);
        assert_eq!(parsed.provides, vec!["lit-search".to_string()]);
    }

    #[test]
    fn rewrite_frontmatter_name_authoritative() {
        // 常规稿：frontmatter 有 name 行 → 权威名替换
        let md = "---\nname: ai-name\ndescription: d\nprovides: [lit-search]\n---\n\n正文\n".replace("\\n", "\n");
        let out = rewrite_frontmatter_name(&md, "my-name");
        assert!(out.contains("name: my-name"));
        assert!(!out.contains("ai-name"));
        assert!(out.contains("provides: [lit-search]"));
        // 无 name 行：插入；未闭合 frontmatter：原样返回兜底
        let no_name = "---\ndescription: d\n---\n\n正文\n".replace("\\n", "\n");
        assert!(rewrite_frontmatter_name(&no_name, "x").contains("name: x"));
        let unclosed = "---\nname: ai\n正文".replace("\\n", "\n");
        assert_eq!(rewrite_frontmatter_name(&unclosed, "x"), unclosed);
    }

    #[test]
    fn create_user_skill_name_authoritative_end_to_end() {
        let fx = Fx::new();
        // AI 稿名 ai-name，用户确认时改名 my-name → 落库名必须是 my-name（此前被 frontmatter 名静默压掉）
        let md = "---\nname: ai-name\ndescription: 合成\nprovides: [lit-notes]\n---\n\n正文\n".replace("\\n", "\n");
        let rewritten = rewrite_frontmatter_name(&md, "my-name");
        let skill = create_skill_from_full_md_at(&fx.store, &rewritten, "my-name", None, None).unwrap();
        assert_eq!(skill.name, "my-name");
        let written = fs::read_to_string(fx.store.skill_dir("my-name").join("SKILL.md")).unwrap();
        assert!(written.contains("name: my-name"));
    }

    #[test]
    fn derived_from_roundtrip_stored_in_registry() {
        let fx = Fx::new();
        fx.add_lib_skill("plain-skill", "普通技能");
        let md = "---\nname: merged-2\ndescription: 合成\nprovides: [lit-notes]\n---\n\n正文\n".replace("\\n", "\n");
        let derived = vec![SkillDerivedFrom { name: "lit-notes".into(), digest: None }];
        create_skill_from_full_md_at(&fx.store, &md, "fallback", None, Some(derived)).unwrap();
        let stored = fx.store.read();
        let s = stored.iter().find(|s| s.name == "merged-2").unwrap();
        assert_eq!(
            s.derived_from.as_deref(),
            Some(&[SkillDerivedFrom { name: "lit-notes".into(), digest: None }][..])
        );
        // 旧档兼容：没有 derived_from 键的记录读回 None
        let plain = stored.iter().find(|s| s.name == "plain-skill").unwrap();
        assert!(plain.derived_from.is_none());
    }

    #[test]
    fn frontmatter_provides_parsed_and_listed() {
        let fx = Fx::new();
        fx.add_lib_skill("plain-skill", "不声明 provides 的技能");
        let dir = fx.store.skill_dir("slot-skill");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: slot-skill\ndescription: 顶位技能\nprovides: [lit-search, lit-notes]\noutputs: [papers/x.md]\n---\nbody\n",
        )
        .unwrap();
        let mut skills = fx.store.read();
        skills.push(new_skill("slot-skill".into(), Some("顶位技能".into()), "local", None));
        fx.store.write(&skills).unwrap();
        let listed = list_skills_impl(&fx.store, &HashMap::new());
        let s = listed.iter().find(|s| s.name == "slot-skill").unwrap();
        assert_eq!(s.provides, vec!["lit-search".to_string(), "lit-notes".to_string()]);
        let plain = listed.iter().find(|s| s.name == "plain-skill").unwrap();
        assert!(plain.provides.is_empty());
    }

    #[test]
    fn named_skill_snapshot_requires_matching_runtime_copy() {
        let fx = Fx::new();
        fx.add_lib_skill("science", "科学检查");
        assert!(
            snapshot_named_skills_at(&fx.store, &fx.agents, &["science".into()], "codex").is_err()
        );
        let runtime = fx.agents.get("codex").unwrap().join("science");
        fs::create_dir_all(&runtime).unwrap();
        fs::copy(
            fx.store.skill_dir("science").join("SKILL.md"),
            runtime.join("SKILL.md"),
        )
        .unwrap();
        let snapshot =
            snapshot_named_skills_at(&fx.store, &fx.agents, &["science".into()], "codex").unwrap();
        assert_eq!(
            snapshot[0].runtime_digest.as_deref(),
            Some(snapshot[0].library_digest.as_str())
        );
        assert!(snapshot[0].entry_text.contains("科学检查"));
        fs::write(runtime.join("SKILL.md"), "outdated").unwrap();
        assert!(
            snapshot_named_skills_at(&fx.store, &fx.agents, &["science".into()], "codex")
                .unwrap_err()
                .contains("漂移")
        );
    }

    struct Fx {
        dir: PathBuf,
        store: SkillStore,
        agents: HashMap<String, PathBuf>,
    }

    #[test]
    fn builtin_update_ignores_crlf_vs_lf() {
        assert!(bytes_eq_ignore_crlf(b"a\r\nb\r\n", b"a\nb\n"));
        assert!(bytes_eq_ignore_crlf(b"a\nb\n", b"a\nb\n"));
        assert!(!bytes_eq_ignore_crlf(b"a\nb\n", b"a\nc\n"));
    }

    impl Fx {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("ccode-skills-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            let store = SkillStore {
                json_path: dir.join("skills.json"),
                lib: dir.join("skills"),
            };
            fs::create_dir_all(&store.lib).unwrap();
            let mut agents = HashMap::new();
            for spec in crate::agent_specs::all_agent_specs() {
                agents.insert(spec.id.to_string(), dir.join("agents").join(spec.id));
            }
            Self { dir, store, agents }
        }

        fn add_lib_skill(&self, name: &str, description: &str) -> SkillDto {
            let dir = self.store.skill_dir(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {description}\n---\nbody\n"),
            )
            .unwrap();
            let skill = new_skill(
                name.to_string(),
                Some(description.to_string()),
                "local",
                None,
            );
            let mut skills = self.store.read();
            skills.push(skill.clone());
            self.store.write(&skills).unwrap();
            skill
        }
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn github_repo_category_takes_repo_segment() {
        assert_eq!(
            github_repo_category("anthropics/skills"),
            Some("skills".to_string())
        );
        assert_eq!(github_repo_category("owner/"), None);
    }

    #[test]
    fn list_skills_carries_content_digest_that_tracks_content() {
        let fx = Fx::new();
        fx.add_lib_skill("digest-demo", "版本记录");
        let listed = list_skills_impl(&fx.store, &fx.agents);
        let digest = listed[0].content_digest.clone().expect("list 应带内容摘要");
        assert!(!digest.is_empty());
        // 内容不变摘要不变；改了 SKILL.md 摘要必须变（快照按它认版本）
        let again = list_skills_impl(&fx.store, &fx.agents);
        assert_eq!(again[0].content_digest.as_deref(), Some(digest.as_str()));
        fs::write(
            fx.store.skill_dir("digest-demo").join("SKILL.md"),
            "---\nname: digest-demo\ndescription: v2\n---\nnew body\n",
        )
        .unwrap();
        let after = list_skills_impl(&fx.store, &fx.agents);
        assert_ne!(after[0].content_digest.as_deref(), Some(digest.as_str()));
    }

    #[test]
    fn list_backfills_missing_agent_keys_for_legacy_skills() {
        // 老技能的 apps 表是创建时的注册表快照（后来接入的 agent 缺键）：
        // list 时现算补齐为 false，否则前端「一键应用」按 apps 键过滤会永远跳过新 agent
        let fx = Fx::new();
        let mut skill = fx.add_lib_skill("legacy", "老技能");
        skill.apps = HashMap::from([
            ("claude-code".to_string(), true),
            ("kimi".to_string(), false),
        ]);
        fx.store.write(&[skill]).unwrap();
        let listed = list_skills_impl(&fx.store, &fx.agents);
        assert_eq!(listed.len(), 1);
        let apps = &listed[0].apps;
        for spec in crate::agent_specs::all_agent_specs() {
            assert!(apps.contains_key(spec.id), "list 后 apps 缺 {}", spec.id);
        }
        // 既有键的值不被覆盖（true 保留、显式 false 保留）
        assert_eq!(apps["claude-code"], true);
        assert_eq!(apps["kimi"], false);
        // 现算不写盘：盘上仍是旧快照
        let on_disk = fx.store.read();
        assert_eq!(on_disk[0].apps.len(), 2);
    }

    #[test]
    fn mentions_mcp_detects_keyword_and_tolerates_missing_file() {
        let fx = Fx::new();
        fx.add_lib_skill("plain", "普通技能");
        assert!(!mentions_mcp(&fx.store.skill_dir("plain").join("SKILL.md")));
        // 「推荐 MCP」段命中
        fx.add_lib_skill("with-mcp", "带 MCP 推荐");
        fs::write(
            fx.store.skill_dir("with-mcp").join("SKILL.md"),
            "---\nname: with-mcp\n---\n## 推荐 MCP\n配一个 arxiv 检索 server。\n",
        )
        .unwrap();
        assert!(mentions_mcp(
            &fx.store.skill_dir("with-mcp").join("SKILL.md")
        ));
        // 正文任意处出现 MCP 子串也命中；SKILL.md 缺失/不可读 → false 不报错
        assert!(!mentions_mcp(&fx.dir.join("missing").join("SKILL.md")));
    }

    #[test]
    fn builtin_skill_files_are_well_formed() {
        // 内置 SKILL.md 必须能被解析口径读出 name/description，且 name 与目录名一致；
        // outputs 声明（行内列表）是产物冲突检测的数据源，内置技能必须带
        for (name, content) in BUILTIN_SKILLS {
            // include_str! 嵌入的是工作区字节：Windows 检出（core.autocrlf）是 CRLF，先归一
            let content = content.replace("\r\n", "\n");
            assert!(
                content.starts_with(&format!("---\nname: {name}\n")),
                "{name} 的 frontmatter name 与目录名不一致"
            );
            let fm: Vec<&str> = content
                .lines()
                .skip(1) // 首行 ---
                .take_while(|l| l.trim_end() != "---")
                .collect();
            let has_desc = fm
                .iter()
                .any(|l| l.starts_with("description: ") && l.len() > 14);
            assert!(has_desc, "{name} 缺少 description");
            let has_outputs = fm
                .iter()
                .any(|l| l.starts_with("outputs: [") && l.len() > 11);
            assert!(has_outputs, "{name} 未声明 outputs");
        }
    }

    #[test]
    fn every_bundled_skill_file_is_embedded() {
        // 2026-10-24 实证：figure_permissions.py 进了仓库、SKILL.md 也写了要跑它，但没登记进
        // BUILTIN_SUPPORT，用户装到的技能里就没有这个脚本，定稿步一跑就找不到
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/skills");
        let mut missing = Vec::new();
        for (name, _) in BUILTIN_SKILLS {
            let dir = root.join(name);
            let mut stack = vec![dir.clone()];
            while let Some(d) = stack.pop() {
                for entry in fs::read_dir(&d).unwrap().flatten() {
                    let path = entry.path();
                    let file = entry.file_name().to_string_lossy().into_owned();
                    if path.is_dir() {
                        if file != "__pycache__" {
                            stack.push(path);
                        }
                        continue;
                    }
                    if file == "SKILL.md" || file.ends_with(".pyc") || file.contains(".bak") {
                        continue;
                    }
                    let rel = path.strip_prefix(&dir).unwrap().to_string_lossy().replace('\\', "/");
                    if !BUILTIN_SUPPORT.iter().any(|(s, r, _)| s == name && *r == rel) {
                        missing.push(format!("{name}/{rel}"));
                    }
                }
            }
        }
        assert!(missing.is_empty(), "随包技能文件没登记进 BUILTIN_SUPPORT：{missing:?}");
    }

    #[test]
    fn seed_adds_all_builtin_skills_once() {
        let fx = Fx::new();
        let added = seed_builtin_skills_impl(&fx.store).unwrap();
        assert_eq!(added.len(), BUILTIN_SKILLS.len());
        let skills = fx.store.read();
        for (name, _) in BUILTIN_SKILLS {
            assert!(fx.store.skill_dir(name).join("SKILL.md").is_file());
            let s = skills.iter().find(|s| s.name == *name).unwrap();
            assert_eq!(s.source, "builtin");
            assert!(!s.description.is_empty());
        }
        // 幂等：第二次不再新增
        assert!(seed_builtin_skills_impl(&fx.store).unwrap().is_empty());
    }

    #[test]
    fn builtin_skills_default_to_mesa_group_user_override_wins() {
        let fx = Fx::new();
        seed_builtin_skills_impl(&fx.store).unwrap();
        fx.add_lib_skill("my-local-skill", "本地导入的技能");
        // 2026-10-16 起存量库早期以 local 进库的内置技能已一次性翻回 builtin 标签：
        // 归组只认 source=builtin，local 同名（用户自有版本）不再归「Mesa 内置」
        {
            let mut skills = fx.store.read();
            let old = skills
                .iter_mut()
                .find(|s| s.source == "builtin" && s.name != "zotero-sync")
                .unwrap();
            old.source = "local".to_string();
            // 用户给一个内置技能设了自定义分组：写进库里
            skills
                .iter_mut()
                .find(|s| s.name == "zotero-sync")
                .unwrap()
                .category = Some("我的文献组".to_string());
            fx.store.write(&skills).unwrap();
        }
        let listed = list_skills_impl(&fx.store, &HashMap::new());
        let mesa = listed
            .iter()
            .filter(|s| s.category.as_deref() == Some("Mesa 内置"))
            .count();
        // 21 个内置：19 个默认归组 + zotero-sync 用户自定义 + 被改成 local（用户自有）不归组 = 19
        assert_eq!(mesa, BUILTIN_SKILLS.len() - 2, "除用户自定义与 local 同名（用户自有），其余内置归组");
        assert_eq!(
            listed.iter().filter(|s| s.category.as_deref() == Some("我的文献组")).count(),
            1
        );
        // 非内置技能不动：仍是无分组
        let local = listed.iter().find(|s| s.name == "my-local-skill").unwrap();
        assert!(local.category.is_none());
        // 不写盘：库里的原始记录仍为空分组
        let stored = fx.store.read();
        assert!(stored
            .iter()
            .filter(|s| s.source == "builtin" && s.category.is_none())
            .count() > 0);
    }

    #[test]
    fn seed_never_overwrites_existing_user_skill() {
        let fx = Fx::new();
        let first = BUILTIN_SKILLS[0].0;
        fx.add_lib_skill(first, "用户自己的描述");
        let md = fx.store.skill_dir(first).join("SKILL.md");
        let before = fs::read_to_string(&md).unwrap();
        let added = seed_builtin_skills_impl(&fx.store).unwrap();
        assert!(!added.contains(&first.to_string()));
        assert_eq!(fs::read_to_string(&md).unwrap(), before);
        let skills = fx.store.read();
        assert_eq!(
            skills.iter().find(|s| s.name == first).unwrap().source,
            "local"
        );
    }

    #[test]
    fn seed_marker_prevents_resurrecting_deleted_builtin() {
        let fx = Fx::new();
        seed_builtin_skills_impl(&fx.store).unwrap();
        // 用户删掉一个内置技能：marker 已是最新版本，不应复活
        let first = BUILTIN_SKILLS[0].0;
        fs::remove_dir_all(fx.store.skill_dir(first)).unwrap();
        let mut skills = fx.store.read();
        skills.retain(|s| s.name != first);
        fx.store.write(&skills).unwrap();
        assert!(seed_builtin_skills_impl(&fx.store).unwrap().is_empty());
        assert!(!fx.store.skill_dir(first).exists());
    }

    #[test]
    fn seed_version_bump_does_not_resurrect_deleted_builtin() {
        let fx = Fx::new();
        seed_builtin_skills_impl(&fx.store).unwrap();
        // 走正式删除通道删掉一个内置技能 → 落墓碑
        let first = BUILTIN_SKILLS[0].0;
        let id = fx
            .store
            .read()
            .iter()
            .find(|s| s.name == first)
            .unwrap()
            .id
            .clone();
        let backups = fx.dir.join("skill-backups");
        delete_impl(&fx.store, &fx.agents, &backups, &id).unwrap();
        assert!(read_builtin_tombstones(&fx.store).contains(&first.to_string()));
        // 模拟种子版本升级（marker 拨回旧版）：补播不得复活已删技能
        fs::write(fx.store.lib.join(BUILTIN_SEED_MARKER), "0").unwrap();
        let added = seed_builtin_skills_impl(&fx.store).unwrap();
        assert!(!added.contains(&first.to_string()));
        assert!(!fx.store.skill_dir(first).exists());
        assert!(!fx.store.read().iter().any(|s| s.name == first));
    }

    #[test]
    fn seed_backfills_tombstone_from_legacy_backup() {
        // 墓碑机制前的老版本删除：库里缺名但 skill-backups 留有同名备份 →
        // 升级补播时回填墓碑、不复活
        let fx = Fx::new();
        seed_builtin_skills_impl(&fx.store).unwrap();
        let first = BUILTIN_SKILLS[0].0;
        fs::remove_dir_all(fx.store.skill_dir(first)).unwrap();
        let mut skills = fx.store.read();
        skills.retain(|s| s.name != first);
        fx.store.write(&skills).unwrap();
        let backups = fx.dir.join("skill-backups");
        fs::create_dir_all(backups.join(format!("{first}.20260101-000000"))).unwrap();
        fs::write(fx.store.lib.join(BUILTIN_SEED_MARKER), "0").unwrap();
        let added = seed_builtin_skills_impl(&fx.store).unwrap();
        assert!(!added.contains(&first.to_string()));
        assert!(read_builtin_tombstones(&fx.store).contains(&first.to_string()));
        assert!(!fx.store.skill_dir(first).exists());
    }

    #[test]
    fn deleting_non_builtin_skill_leaves_no_tombstone() {
        let fx = Fx::new();
        let skill = fx.add_lib_skill("mine", "用户自建");
        let backups = fx.dir.join("skill-backups");
        delete_impl(&fx.store, &fx.agents, &backups, &skill.id).unwrap();
        assert!(read_builtin_tombstones(&fx.store).is_empty());
    }

    #[test]
    fn builtin_support_scripts_seed_and_update_together_without_touching_user_files() {
        let fx = Fx::new();
        seed_builtin_skills_impl(&fx.store).unwrap();
        let name = "endnote-bridge";
        let script = fx.store.skill_dir(name).join("scripts/bridge.py");
        assert!(fx.store.skill_dir("quarto-render").join("ieee.csl").is_file());
        assert!(script.is_file());
        fs::write(&script, "user changed script").unwrap();
        let other = fx.store.skill_dir(name).join("my-note.txt");
        fs::write(&other, "keep").unwrap();
        assert!(check_builtin_skill_updates_impl(&fx.store).contains(&name.to_string()));
        apply_builtin_skill_update_impl(&fx.store, name).unwrap();
        assert_eq!(
            fs::read_to_string(&script).unwrap(),
            builtin_files(name)
                .into_iter()
                .find(|(path, _)| *path == "scripts/bridge.py")
                .unwrap()
                .1
        );
        assert_eq!(fs::read_to_string(other).unwrap(), "keep");
        assert!(fs::read_dir(script.parent().unwrap())
            .unwrap()
            .flatten()
            .any(|e| e
                .file_name()
                .to_string_lossy()
                .starts_with("bridge.py.bak-")));
    }

    #[test]
    fn builtin_update_check_and_apply() {
        let fx = Fx::new();
        seed_builtin_skills_impl(&fx.store).unwrap();
        // 库里副本与种子一致 → 无提示
        assert!(check_builtin_skill_updates_impl(&fx.store).is_empty());
        // 库内是旧内容（含用户自改）→ 检出该技能
        let first = BUILTIN_SKILLS[0].0;
        let md = fx.store.skill_dir(first).join("SKILL.md");
        fs::write(&md, "---\nname: old\ndescription: 旧描述\n---\n旧内容\n").unwrap();
        // skills.json 描述也拨旧，验证更新后同步回种子描述
        let mut skills = fx.store.read();
        let pos = skills.iter().position(|s| s.name == first).unwrap();
        skills[pos].description = "旧描述".into();
        fx.store.write(&skills).unwrap();
        assert_eq!(
            check_builtin_skill_updates_impl(&fx.store),
            vec![first.to_string()]
        );
        // 库里缺目录的内置技能不提示（缺失归播种器管）
        let second = BUILTIN_SKILLS[1].0;
        fs::remove_dir_all(fx.store.skill_dir(second)).unwrap();
        assert!(!check_builtin_skill_updates_impl(&fx.store).contains(&second.to_string()));
        // 应用更新：内容 = 种子、备份存在且为旧内容、skills.json 描述同步
        apply_builtin_skill_update_impl(&fx.store, first).unwrap();
        let seed = BUILTIN_SKILLS.iter().find(|(n, _)| *n == first).unwrap().1;
        assert_eq!(fs::read_to_string(&md).unwrap(), seed);
        let backups_of = |fx: &Fx| -> Vec<String> {
            let mut v: Vec<String> = fs::read_dir(fx.store.skill_dir(first))
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("SKILL.md.bak-"))
                .collect();
            v.sort();
            v
        };
        let backups = backups_of(&fx);
        assert_eq!(backups.len(), 1, "应恰好一份备份: {backups:?}");
        assert!(
            fs::read_to_string(fx.store.skill_dir(first).join(&backups[0]))
                .unwrap()
                .contains("旧内容"),
            "备份必须保留更新前内容"
        );
        let saved = fx.store.read();
        let s = saved.iter().find(|s| s.name == first).unwrap();
        let seed_desc = parse_skill_md(&md).description;
        assert_eq!(
            s.description,
            seed_desc.unwrap_or_default(),
            "描述同步为新版"
        );
        assert_ne!(s.description, "旧描述");
        // 追平后检测归零
        assert!(check_builtin_skill_updates_impl(&fx.store).is_empty());
        // 同日再次更新：备份追加 -2 后缀防覆盖
        fs::write(&md, "---\nname: old\ndescription: 旧描述\n---\n旧内容 v2\n").unwrap();
        apply_builtin_skill_update_impl(&fx.store, first).unwrap();
        let backups = backups_of(&fx);
        assert_eq!(backups.len(), 2, "同日重复更新应追加序号: {backups:?}");
        assert!(backups[1].ends_with("-2"), "{backups:?}");
        // 非内置技能名报错
        let err = apply_builtin_skill_update_impl(&fx.store, "not-builtin").unwrap_err();
        assert!(err.contains("不是内置技能"), "{err}");
    }

    #[test]
    fn builtin_update_also_refreshes_distributed_copies() {
        let fx = Fx::new();
        seed_builtin_skills_impl(&fx.store).unwrap();
        let first = BUILTIN_SKILLS[0].0;
        let id = fx.store.read().into_iter().find(|s| s.name == first).unwrap().id;
        // codex 拿的是复制件；库里改旧后复制件跟着旧
        let md = fx.store.skill_dir(first).join("SKILL.md");
        fs::write(&md, "---\nname: old\ndescription: 旧描述\n---\n旧内容\n").unwrap();
        apply_impl(&fx.store, &fx.agents, &id, "codex", true, false).unwrap();
        let copy = fx.agents["codex"].join(first).join("SKILL.md");
        assert!(fs::read_to_string(&copy).unwrap().contains("旧内容"));
        // 采用新版：库和复制件一起追平，不再留「同步副本」
        let synced = apply_builtin_and_resync(&fx.store, &fx.agents, first).unwrap();
        assert_eq!(synced, vec!["codex".to_string()]);
        let seed = BUILTIN_SKILLS.iter().find(|(n, _)| *n == first).unwrap().1;
        assert_eq!(fs::read_to_string(&copy).unwrap(), seed);
        let skill = fx.store.read().into_iter().find(|s| s.id == id).unwrap();
        assert!(stale_agents(&fx.store, &fx.agents, &skill).is_empty());
    }

    #[test]
    fn builtin_update_check_ignores_user_owned_same_name() {
        let fx = Fx::new();
        // 用户自建与内置同名的技能（source=local）：内容与种子不同，但不得提示。
        // 2026-10-16 存量库早期以 local 进库的 14 个内置技能已一次性翻回 builtin 标签，
        // local 同名重新稳定意味着用户自有版本，豁免成立。
        let first = BUILTIN_SKILLS[0].0;
        fx.add_lib_skill(first, "用户自己的版本");
        assert!(
            check_builtin_skill_updates_impl(&fx.store).is_empty(),
            "source 非 builtin 的同名技能不提示"
        );
    }

    #[test]
    fn backfill_fills_only_uncategorized_github_skills() {
        let fx = Fx::new();
        let local = fx.add_lib_skill("pdf", "本地");
        let gh = fx.add_lib_skill("aihot", "x");
        let gh_named = fx.add_lib_skill("neat", "x");
        {
            let mut skills = fx.store.read();
            for s in &mut skills {
                if s.id == gh.id {
                    s.source = "github".into();
                    s.repo = Some("KKKKhazix/khazix-skills".into());
                }
                if s.id == gh_named.id {
                    s.source = "github".into();
                    s.repo = Some("o/r".into());
                    s.category = Some("项目整理".into());
                }
            }
            fx.store.write(&skills).unwrap();
        }
        let filled = backfill_categories_impl(&fx.store).unwrap();
        assert_eq!(filled, 1);
        let after = fx.store.read();
        assert_eq!(
            after
                .iter()
                .find(|s| s.id == gh.id)
                .unwrap()
                .category
                .as_deref(),
            Some("khazix-skills")
        );
        assert_eq!(
            after
                .iter()
                .find(|s| s.id == gh_named.id)
                .unwrap()
                .category
                .as_deref(),
            Some("项目整理"),
            "已有分类不得被覆盖"
        );
        assert!(
            after
                .iter()
                .find(|s| s.id == local.id)
                .unwrap()
                .category
                .is_none(),
            "非 GitHub 来源不动"
        );
        // 幂等：再跑一遍没有可回填的
        assert_eq!(backfill_categories_impl(&fx.store).unwrap(), 0);
    }

    #[test]
    fn skill_tags_trim_dedupe_and_limit() {
        // trim + 丢空 + 保序去重
        let tags = validate_skill_tags(&[
            " 文献 ".into(),
            "".into(),
            "   ".into(),
            "综述".into(),
            "文献".into(),
        ])
        .unwrap();
        assert_eq!(tags, vec!["文献".to_string(), "综述".to_string()]);
        // 空输入 = 清除全部
        assert_eq!(validate_skill_tags(&[]).unwrap(), Vec::<String>::new());
        // 超 4 个拒绝
        let five: Vec<String> = (0..5).map(|i| format!("t{i}")).collect();
        assert!(validate_skill_tags(&five).is_err());
        // 重复折叠后 ≤4 仍放行
        let dup: Vec<String> = ["a", "b", "c", "d", "a"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(validate_skill_tags(&dup).unwrap().len(), 4);
        // 单标签超 20 字符拒绝（按字符数，不按字节）
        assert!(validate_skill_tags(&["字".repeat(20)]).is_ok());
        assert!(validate_skill_tags(&["字".repeat(21)]).is_err());
    }

    #[test]
    fn frontmatter_tolerates_bom_crlf_and_missing_fields() {
        let dir = std::env::temp_dir().join(format!("ccode-skills-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("SKILL.md");
        fs::write(&f, "\u{feff}---\r\nname: pdf\r\ndescription: 处理 PDF 文件\r\nextra: ignored\r\n---\r\n# body\r\n").unwrap();
        let parsed = parse_skill_md(&f);
        assert_eq!(parsed.name.as_deref(), Some("pdf"));
        assert_eq!(parsed.description.as_deref(), Some("处理 PDF 文件"));
        fs::write(&f, "---\nname: only-name\n---\n").unwrap();
        assert_eq!(
            parse_skill_md(&f),
            SkillFrontmatter {
                name: Some("only-name".into()),
                ..Default::default()
            }
        );
        fs::write(&f, "# 没有 frontmatter\n").unwrap();
        assert_eq!(parse_skill_md(&f), SkillFrontmatter::default());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_skills_carries_outputs_from_frontmatter() {
        let fx = Fx::new();
        fx.add_lib_skill("with-outputs", "带产物声明");
        fs::write(
            fx.store.skill_dir("with-outputs").join("SKILL.md"),
            "---\nname: with-outputs\noutputs: [papers/, notes/inbox.md]\n---\nbody\n",
        )
        .unwrap();
        fx.add_lib_skill("no-outputs", "无产物声明");
        let skills = list_skills_impl(&fx.store, &HashMap::new());
        let s = skills.iter().find(|s| s.name == "with-outputs").unwrap();
        assert_eq!(
            s.outputs,
            vec!["papers/".to_string(), "notes/inbox.md".to_string()]
        );
        let s = skills.iter().find(|s| s.name == "no-outputs").unwrap();
        assert!(s.outputs.is_empty(), "未声明 outputs 的技能为空数组");
    }

    #[test]
    fn frontmatter_outputs_inline_and_block_and_missing() {
        let dir = std::env::temp_dir().join(format!("ccode-skills-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("SKILL.md");
        // 行内列表写法
        fs::write(
            &f,
            "---\nname: s\noutputs: [papers/, references.bib]\n---\n# body\n",
        )
        .unwrap();
        assert_eq!(
            parse_skill_md(&f).outputs,
            vec!["papers/".to_string(), "references.bib".to_string()]
        );
        // 多行列表写法（允许缩进与引号）
        fs::write(
            &f,
            "---\nname: s\noutputs:\n  - notes/\n  - \"notes/inbox.md\"\ndescription: d\n---\n",
        )
        .unwrap();
        let parsed = parse_skill_md(&f);
        assert_eq!(
            parsed.outputs,
            vec!["notes/".to_string(), "notes/inbox.md".to_string()]
        );
        assert_eq!(
            parsed.description.as_deref(),
            Some("d"),
            "列表结束后其他字段照常解析"
        );
        // inputs 同样支持多行列表写法
        fs::write(
            &f,
            "---\nname: s\ninputs:\n  - papers/included.md\n  - references.bib\n---\n",
        )
        .unwrap();
        assert_eq!(
            parse_skill_md(&f).inputs,
            vec![
                "papers/included.md".to_string(),
                "references.bib".to_string()
            ]
        );
        // 裸标量写法容忍为单条
        fs::write(&f, "---\nname: s\noutputs: outline.md\n---\n").unwrap();
        assert_eq!(parse_skill_md(&f).outputs, vec!["outline.md".to_string()]);
        // 缺字段 = 空数组
        fs::write(&f, "---\nname: s\ndescription: d\n---\n").unwrap();
        assert!(parse_skill_md(&f).outputs.is_empty());
        // 空行内列表 = 空数组
        fs::write(&f, "---\nname: s\noutputs: []\n---\n").unwrap();
        assert!(parse_skill_md(&f).outputs.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skill_md_body_splits_frontmatter_exactly() {
        assert_eq!(skill_md_body("---\nname: s\n---\n正文\n"), "正文\n");
        // CRLF 不错位
        assert_eq!(
            skill_md_body("---\r\nname: s\r\n---\r\n正文\r\n"),
            "正文\r\n"
        );
        // 无 frontmatter / 未闭合：按全文对待
        assert_eq!(skill_md_body("# 直接正文\n"), "# 直接正文\n");
        assert_eq!(
            skill_md_body("---\nname: s\n没闭合"),
            "---\nname: s\n没闭合"
        );
    }

    #[test]
    fn infer_interface_classifies_paths_by_verb() {
        let (inputs, outputs) = infer_interface_from_body(
            "先读取 papers/included.md 与 references.bib，对照 notes/ 下的笔记。\n\
             筛选结果写入 papers/screening.md，并保存到 papers/included.md。\n\
             详细说明见 https://example.com/docs/x.md。\n\
             读取 papers/a.md 并写入 papers/b.md（双侧动词，不猜）。\n\
             参考文献用 bib 格式（无路径 token，不猜）。",
        );
        assert_eq!(
            inputs,
            vec![
                "papers/included.md".to_string(),
                "references.bib".to_string(),
                "notes/".to_string()
            ]
        );
        assert_eq!(
            outputs,
            vec![
                "papers/screening.md".to_string(),
                "papers/included.md".to_string()
            ]
        );
        // URL、双侧动词行、无路径行都不进结果
        assert!(!inputs
            .iter()
            .chain(outputs.iter())
            .any(|p| p.contains("http")));
        assert!(!inputs
            .iter()
            .chain(outputs.iter())
            .any(|p| p.contains("a.md")));
    }

    #[test]
    fn infer_interface_tolerates_unspaced_cjk_and_caps() {
        // 无空格连写 + 反引号包裹都能认出；每侧最多 8 条防噪
        let (inputs, outputs) = infer_interface_from_body(
            "将结果写入papers/screening.md。\n把笔记追加到`notes/inbox.md`尾部。",
        );
        assert!(inputs.is_empty());
        assert_eq!(
            outputs,
            vec![
                "papers/screening.md".to_string(),
                "notes/inbox.md".to_string()
            ]
        );
    }

    #[test]
    fn list_skills_infers_interface_when_frontmatter_silent() {
        let fx = Fx::new();
        fx.add_lib_skill("external", "外部技能");
        fs::write(
            fx.store.skill_dir("external").join("SKILL.md"),
            "---\nname: external\n---\n读取 references.bib 后开始。\n产出 outline.md 即完成。\n",
        )
        .unwrap();
        let skills = list_skills_impl(&fx.store, &HashMap::new());
        let s = skills.iter().find(|s| s.name == "external").unwrap();
        assert_eq!(s.inputs, vec!["references.bib".to_string()]);
        assert_eq!(s.outputs, vec!["outline.md".to_string()]);
        assert!(s.interface_inferred, "推断兜底必须打标");
        // frontmatter 有声明时不走推断、不打标
        fx.add_lib_skill("declared", "有声明");
        fs::write(
            fx.store.skill_dir("declared").join("SKILL.md"),
            "---\nname: declared\noutputs: [x.md]\n---\n读取 references.bib。\n",
        )
        .unwrap();
        let skills = list_skills_impl(&fx.store, &HashMap::new());
        let s = skills.iter().find(|s| s.name == "declared").unwrap();
        assert_eq!(s.outputs, vec!["x.md".to_string()]);
        assert!(s.inputs.is_empty());
        assert!(!s.interface_inferred);
    }

    #[test]
    fn compose_skill_md_writes_interface_lists() {
        let text = compose_skill_md(
            "s",
            "描述",
            "正文",
            &["papers/".to_string()],
            &["notes/inbox.md".to_string()],
            &["lit-search".to_string()],
        );
        assert!(text.contains("inputs:\n  - papers/\n"));
        assert!(text.contains("outputs:\n  - notes/inbox.md\n"));
        assert!(text.contains("provides:\n  - lit-search\n"));
        // 往返一致：写出来的 frontmatter 能被解析回同样的接口（provides 同口径，编辑不丢声明）
        let parsed = parse_skill_md_text(&text);
        assert_eq!(parsed.inputs, vec!["papers/".to_string()]);
        assert_eq!(parsed.outputs, vec!["notes/inbox.md".to_string()]);
        assert_eq!(parsed.provides, vec!["lit-search".to_string()]);
        // 空接口不写键（保持既有格式不变）
        let plain = compose_skill_md("s", "描述", "正文", &[], &[], &[]);
        assert!(!plain.contains("inputs:") && !plain.contains("outputs:") && !plain.contains("provides:"));
    }

    #[test]
    fn strip_code_fence_unwraps_fenced_output() {
        assert_eq!(
            strip_code_fence("```markdown\n---\nname: s\n---\n正文\n```"),
            "---\nname: s\n---\n正文"
        );
        assert_eq!(
            strip_code_fence("---\nname: s\n---\n正文"),
            "---\nname: s\n---\n正文"
        );
    }

    #[test]
    fn build_adapt_prompt_carries_conventions_and_skill() {
        let prompt = build_adapt_prompt("my-skill", "---\nname: my-skill\n---\n正文");
        assert!(prompt.contains("papers/"), "规范路径表必须在 prompt 里");
        assert!(prompt.contains("screening.md"));
        assert!(prompt.contains("references.bib"));
        assert!(prompt.contains("【当前 SKILL.md】\n---\nname: my-skill\n---\n正文"));
        assert!(prompt.contains("inputs:"), "必须要求补写接口声明");
    }

    #[test]
    fn usable_adapt_draft_strips_preamble_and_drops_unknown_provides() {
        let raw = "下面是改好的稿：\n```markdown\n---\nname: hacked\ndescription: 新描述\ninputs:\n  - papers/included.md\noutputs:\n  - notes/\nprovides: [lit-search, not-a-slot]\n---\n新正文\n```\n";
        let draft = usable_adapt_draft(raw).unwrap();
        let parsed = parse_skill_md_text(&draft);
        assert_eq!(parsed.inputs, vec!["papers/included.md".to_string()]);
        assert_eq!(parsed.outputs, vec!["notes/".to_string()]);
        assert_eq!(parsed.provides, vec!["lit-search".to_string()]);
        assert_eq!(skill_md_body(&draft).trim(), "新正文");
        assert!(usable_adapt_draft("只有一段说明，没有 frontmatter").is_err());
    }

    #[test]
    fn already_aligned_skill_is_detected() {
        let aligned = "---\nname: lit-search\noutputs:\n  - papers/screening.md\nprovides: [lit-search]\n---\n正文\n";
        assert!(already_pipeline_aligned(aligned));
        assert!(!already_pipeline_aligned("---\nname: x\n---\n随便写，没有路径\n"));
    }

    #[test]
    fn write_skill_md_rewrites_interface_and_preserves_name() {
        let fx = Fx::new();
        fx.add_lib_skill("ext", "旧描述");
        let mut skills = fx.store.read();
        // 适配稿：name 字段被篡改也不生效（目录名不可改），description/inputs/outputs 取稿件
        let full = "---\nname: hacked\ndescription: 新描述\ninputs:\n  - papers/included.md\noutputs:\n  - notes/\n---\n新正文\n";
        let parsed = parse_skill_md_text(full);
        update_content_impl(
            &fx.store,
            &mut skills,
            "ext",
            skill_md_body(full),
            parsed.description,
            Some((parsed.inputs, parsed.outputs, parsed.provides)),
        )
        .unwrap();
        let written = fs::read_to_string(fx.store.skill_dir("ext").join("SKILL.md")).unwrap();
        let parsed = parse_skill_md_text(&written);
        assert!(written.contains("name: ext"), "name 强制沿用库中条目");
        assert!(!written.contains("hacked"));
        assert_eq!(parsed.description.as_deref(), Some("新描述"));
        assert_eq!(parsed.inputs, vec!["papers/included.md".to_string()]);
        assert_eq!(parsed.outputs, vec!["notes/".to_string()]);
        assert_eq!(skill_md_body(&written).trim(), "新正文");
    }

    #[test]
    fn update_content_preserves_declared_interface_by_default() {
        let fx = Fx::new();
        fx.add_lib_skill("ext", "带接口");
        fs::write(
            fx.store.skill_dir("ext").join("SKILL.md"),
            "---\nname: ext\ndescription: 带接口\ninputs: [papers/]\noutputs: [notes/]\n---\n旧正文\n",
        )
        .unwrap();
        let mut skills = fx.store.read();
        // 普通编辑（interface = None）：frontmatter 接口声明必须保留，不被静默丢弃
        update_content_impl(&fx.store, &mut skills, "ext", "新正文", None, None).unwrap();
        let written = fs::read_to_string(fx.store.skill_dir("ext").join("SKILL.md")).unwrap();
        let parsed = parse_skill_md_text(&written);
        assert_eq!(parsed.inputs, vec!["papers/".to_string()]);
        assert_eq!(parsed.outputs, vec!["notes/".to_string()]);
        assert_eq!(skill_md_body(&written).trim(), "新正文");
    }

    #[test]
    fn discovery_flattens_nested_and_skips_dot_dirs() {
        let fx = Fx::new();
        // 嵌套技能（找到不下钻）+ dot-dir 里的技能被跳过
        fs::create_dir_all(fx.dir.join("src/skills/doc/docx")).unwrap();
        fs::write(
            fx.dir.join("src/skills/doc/docx/SKILL.md"),
            "---\nname: docx\n---\n",
        )
        .unwrap();
        fs::create_dir_all(fx.dir.join("src/.hidden/secret")).unwrap();
        fs::write(
            fx.dir.join("src/.hidden/secret/SKILL.md"),
            "---\nname: secret\n---\n",
        )
        .unwrap();
        let mut found = Vec::new();
        find_skill_dirs(&fx.dir.join("src"), &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file_name().unwrap(), "docx");
        let mut skills = Vec::new();
        let mut first = SkillImportResultDto::default();
        import_one_dir(
            &fx.store,
            &mut skills,
            &found[0],
            None,
            "local",
            None,
            None,
            &mut first,
        )
        .unwrap();
        assert_eq!(first.added, vec!["docx"]);
        assert_eq!(skills[0].name, "docx", "拍平为末段目录名");
        assert!(fx.store.skill_dir("docx").join("SKILL.md").exists());
        // 同名再导入必须返回结构化冲突，不能静默跳过
        let mut second = SkillImportResultDto::default();
        import_one_dir(
            &fx.store,
            &mut skills,
            &found[0],
            None,
            "local",
            None,
            None,
            &mut second,
        )
        .unwrap();
        assert_eq!(second.conflicts.len(), 1);
        assert_eq!(second.conflicts[0].name, "docx");
    }

    #[test]
    fn import_conflict_can_overwrite_with_backup() {
        let fx = Fx::new();
        fx.add_lib_skill("pdf", "旧版本");
        let incoming = fx.dir.join("incoming/pdf");
        fs::create_dir_all(&incoming).unwrap();
        fs::write(
            incoming.join("SKILL.md"),
            "---\nname: pdf\ndescription: 新版本\n---\nnew body\n",
        )
        .unwrap();
        let mut skills = fx.store.read();
        let resolutions = HashMap::from([("pdf".to_string(), "overwrite".to_string())]);
        let mut result = SkillImportResultDto::default();
        import_one_dir(
            &fx.store,
            &mut skills,
            &incoming,
            None,
            "local",
            None,
            Some(&resolutions),
            &mut result,
        )
        .unwrap();
        assert_eq!(result.updated, vec!["pdf"]);
        assert_eq!(fx.store.read()[0].description, "新版本");
        assert!(
            fs::read_to_string(fx.store.skill_dir("pdf").join("SKILL.md"))
                .unwrap()
                .contains("new body")
        );
        let backup_root = fx.dir.join("skill-backups");
        let backup = fs::read_dir(&backup_root)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("pdf.")
            })
            .expect("覆盖前必须留下备份");
        assert!(fs::read_to_string(backup.join("SKILL.md"))
            .unwrap()
            .contains("旧版本"));
    }

    #[test]
    fn import_conflict_can_save_as_new_name() {
        let fx = Fx::new();
        fx.add_lib_skill("pdf", "旧版本");
        let incoming = fx.dir.join("incoming/pdf");
        fs::create_dir_all(&incoming).unwrap();
        fs::write(
            incoming.join("SKILL.md"),
            "---\nname: pdf\ndescription: 另一个版本\n---\n",
        )
        .unwrap();
        let mut skills = fx.store.read();
        let resolutions =
            HashMap::from([("pdf".to_string(), "rename:pdf-alternative".to_string())]);
        let mut result = SkillImportResultDto::default();
        import_one_dir(
            &fx.store,
            &mut skills,
            &incoming,
            None,
            "zip",
            None,
            Some(&resolutions),
            &mut result,
        )
        .unwrap();
        assert_eq!(result.added, vec!["pdf-alternative"]);
        assert_eq!(fx.store.read().len(), 2);
        assert!(fx.store.skill_dir("pdf").exists());
        assert!(fx.store.skill_dir("pdf-alternative").exists());
    }

    #[test]
    fn create_registers_skill_and_rejects_duplicate() {
        let fx = Fx::new();
        let mut skills = fx.store.read();
        create_impl(
            &fx.store,
            &mut skills,
            "my-method",
            "我的方法",
            "第一步……\n第二步……",
        )
        .unwrap();
        let text = fs::read_to_string(fx.store.skill_dir("my-method").join("SKILL.md")).unwrap();
        assert!(text.contains("name: my-method"), "{text}");
        assert!(text.contains("description: 我的方法"), "{text}");
        assert!(text.contains("第一步……"), "{text}");
        let saved = fx.store.read();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].name, "my-method");
        assert_eq!(
            saved[0].description, "我的方法",
            "元数据描述从落盘 SKILL.md 解析"
        );
        assert_eq!(
            saved[0].source, "ccode",
            "新建技能标记为 Mesa 自建（删除保护来源分类）"
        );
        // 重名拒绝并提示改用编辑（不覆盖、不静默跳过）
        let mut again = fx.store.read();
        let err = create_impl(&fx.store, &mut again, "my-method", "x", "y").unwrap_err();
        assert!(err.contains("已存在"), "{err}");
        // 非法名称（多段路径）拒绝
        let err = create_impl(&fx.store, &mut Vec::new(), "a/b", "x", "y").unwrap_err();
        assert!(err.contains("单个安全目录名"), "{err}");
        assert!(!fx.store.skill_dir("a").exists(), "非法名称不得落盘");
    }

    #[test]
    fn update_content_backs_up_and_preserves_aux_files() {
        let fx = Fx::new();
        let skill = fx.add_lib_skill("pdf", "旧描述");
        // SKILL.md 之外的辅助文件（模板等）编辑后必须保留
        fs::write(fx.store.skill_dir("pdf").join("template.txt"), "模板内容").unwrap();
        let mut skills = fx.store.read();
        update_content_impl(
            &fx.store,
            &mut skills,
            "pdf",
            "新正文",
            Some("新描述".into()),
            None,
        )
        .unwrap();
        let dir = fx.store.skill_dir("pdf");
        assert!(fs::read_to_string(dir.join("SKILL.md"))
            .unwrap()
            .contains("新正文"));
        assert_eq!(
            fs::read_to_string(dir.join("template.txt")).unwrap(),
            "模板内容",
            "辅助文件必须保留"
        );
        let saved = fx.store.read();
        assert_eq!(saved[0].description, "新描述");
        assert_eq!(saved[0].id, skill.id, "编辑不换 id");
        assert_eq!(saved[0].source, "local", "编辑不改写来源信息");
        // 覆盖前备份沿用库目录机制（备份内含旧版 SKILL.md 与辅助文件）
        let backup = fs::read_dir(fx.dir.join("skill-backups"))
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("pdf.")
            })
            .expect("覆盖前必须留下备份");
        assert!(fs::read_to_string(backup.join("SKILL.md"))
            .unwrap()
            .contains("旧描述"));
        assert!(backup.join("template.txt").exists());
        // description 缺省 = 保留原描述；不存在的技能报错
        let mut skills = fx.store.read();
        update_content_impl(&fx.store, &mut skills, "pdf", "第三版", None, None).unwrap();
        assert_eq!(fx.store.read()[0].description, "新描述");
        let err =
            update_content_impl(&fx.store, &mut skills, "ghost", "x", None, None).unwrap_err();
        assert!(err.contains("不存在"), "{err}");
    }

    #[test]
    fn cursor_distribution_forces_copy_mode() {
        // cursor 的 skills 目录未验证 CLI 是否真读，强制 copy 不建 symlink；
        // grok 首版未经实机验证同样强制 copy。取值单一出处 = agent_specs.skill_dist
        use crate::agent_specs::{agent_spec, SkillDist};
        for a in ["cursor", "grok"] {
            assert!(
                matches!(agent_spec(a).unwrap().skill_dist, SkillDist::CopyOnly(r) if !r.is_empty()),
                "{a} 能力表应标 CopyOnly 且带原因"
            );
            assert!(!allow_symlink_for(a), "{a} 应强制 copy");
        }
        for a in [
            "claude-code",
            "codex",
            "gemini",
            "qwen",
            "opencode",
            "kimi",
            "codebuddy",
        ] {
            assert_eq!(
                agent_spec(a).unwrap().skill_dist,
                SkillDist::SymlinkOrCopy,
                "{a} 能力表应保持 symlink 优先"
            );
            assert!(allow_symlink_for(a), "{a} 应保持 symlink 优先");
        }
    }

    #[test]
    fn apply_copy_fallback_marker_protection_and_conflicts() {
        let fx = Fx::new();
        let skill = fx.add_lib_skill("pdf", "处理 PDF");
        let target = fx.agents["codex"].join("pdf");
        // allow_symlink=false 强制 copy 回退：带标记文件
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
        assert!(target.join("SKILL.md").exists());
        assert!(target.join(MARKER_FILE).exists());
        assert!(fx.store.read()[0].apps["codex"]);
        // 关闭：带标记的副本被删除
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", false, false).unwrap();
        assert!(!target.exists());
        // 用户自有目录（无标记）：关闭时绝不动
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), "user's own").unwrap();
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", false, false).unwrap();
        assert!(target.join("SKILL.md").exists(), "无标记目录必须保留");
        // 同名冲突：开启时报错且不覆盖
        let err = apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap_err();
        assert!(err.contains("不是由 Mesa 管理"), "{err}");
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "user's own"
        );
    }

    #[test]
    fn apply_symlink_preferred_on_unix() {
        let fx = Fx::new();
        let skill = fx.add_lib_skill("pdf", "处理 PDF");
        apply_impl(&fx.store, &fx.agents, &skill.id, "claude-code", true, true).unwrap();
        let target = fx.agents["claude-code"].join("pdf");
        #[cfg(unix)]
        assert!(fs::read_link(&target).is_ok(), "Unix 上应优先 symlink");
        // 重复应用（重挂）不出错
        apply_impl(&fx.store, &fx.agents, &skill.id, "claude-code", true, true).unwrap();
        apply_impl(&fx.store, &fx.agents, &skill.id, "claude-code", false, true).unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn delete_backups_up_and_prunes_to_five() {
        let fx = Fx::new();
        let backups = fx.dir.join("backups");
        fs::create_dir_all(&backups).unwrap();
        // 预置 5 份旧备份，删除后总数 6 → 剪掉最旧一份
        for i in 0..5 {
            fs::create_dir_all(backups.join(format!("pdf.2026070{i}-000000"))).unwrap();
        }
        let skill = fx.add_lib_skill("pdf", "x");
        delete_impl(&fx.store, &fx.agents, &backups, &skill.id).unwrap();
        assert!(fx.store.read().is_empty());
        assert!(!fx.store.skill_dir("pdf").exists());
        let remaining: Vec<_> = fs::read_dir(&backups).unwrap().flatten().collect();
        assert_eq!(remaining.len(), 5, "只保留最近 5 份");
        assert!(
            !backups.join("pdf.20260700-000000").exists(),
            "最旧的被剪掉"
        );
    }

    fn build_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opt = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            w.start_file(name, opt).unwrap();
            std::io::Write::write_all(&mut w, data).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn zip_import_groups_skills_and_rejects_traversal() {
        let fx = Fx::new();
        let zip_path = fx.dir.join("in.zip");
        build_zip(
            &zip_path,
            &[
                (
                    "repo-sha/skills/doc/docx/SKILL.md",
                    b"---\ndescription: word\n---\n",
                ),
                ("repo-sha/skills/doc/docx/template.bin", b"\x00\x01"),
                (
                    "repo-sha/skills/pdf/SKILL.md",
                    b"---\ndescription: pdf\n---\n",
                ),
                ("../evil/SKILL.md", b"evil"),
                ("/abs/evil.md", b"evil"),
            ],
        );
        let mut skills = Vec::new();
        let result = import_zip_impl(
            &fx.store,
            &mut skills,
            &zip_path,
            None,
            "zip",
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(result.added.len(), 2);
        assert!(fx.store.skill_dir("docx").join("template.bin").exists());
        assert_eq!(
            skills
                .iter()
                .find(|s| s.name == "docx")
                .unwrap()
                .description,
            "word"
        );
        assert!(!fx.dir.join("evil").exists(), "路径穿越条目不得落盘");
        // subdir 过滤
        let fx2 = Fx::new();
        let result = import_zip_impl(
            &fx2.store,
            &mut Vec::new(),
            &zip_path,
            Some("skills/pdf"),
            "zip",
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(result.added.len(), 1);
        assert!(fx2.store.skill_dir("pdf").exists());
        assert!(!fx2.store.skill_dir("docx").exists());
    }

    #[test]
    fn only_filter_updates_named_skill_and_ignores_rest() {
        // 一键更新的核心语义：zip 里只覆盖同名技能，其余不新增不覆盖
        let fx = Fx::new();
        fx.add_lib_skill("pdf", "旧版");
        let zip_path = fx.dir.join("upd.zip");
        build_zip(
            &zip_path,
            &[
                (
                    "repo-sha/skills/pdf/SKILL.md",
                    b"---\ndescription: new\n---\n",
                ),
                (
                    "repo-sha/skills/docx/SKILL.md",
                    b"---\ndescription: nope\n---\n",
                ),
            ],
        );
        let mut skills = fx.store.read();
        let resolutions = HashMap::from([("pdf".to_string(), "overwrite".to_string())]);
        let result = import_zip_impl(
            &fx.store,
            &mut skills,
            &zip_path,
            Some("skills"),
            "github",
            Some("o/r".to_string()),
            Some(&resolutions),
            Some("pdf"),
        )
        .unwrap();
        assert_eq!(result.updated, vec!["pdf".to_string()]);
        assert!(result.added.is_empty());
        assert!(
            !fx.store.skill_dir("docx").exists(),
            "only 过滤下 zip 其余技能不得进入"
        );
        assert_eq!(fx.store.read()[0].description, "new");
        // 目标不在 zip 中：空结果由调用方（apply_skill_update）转成「未找到」错误
        let result = import_zip_impl(
            &fx.store,
            &mut fx.store.read(),
            &zip_path,
            Some("skills"),
            "github",
            Some("o/r".to_string()),
            None,
            Some("ghost"),
        )
        .unwrap();
        assert!(result.added.is_empty() && result.updated.is_empty());
    }

    #[test]
    fn zip_budget_rejects_too_many_entries() {
        let fx = Fx::new();
        let zip_path = fx.dir.join("many.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opt = zip::write::SimpleFileOptions::default();
        for i in 0..(ZIP_MAX_ENTRIES + 1) {
            w.start_file(format!("f{i}.txt"), opt).unwrap();
        }
        w.finish().unwrap();
        let err = import_zip_impl(
            &fx.store,
            &mut Vec::new(),
            &zip_path,
            None,
            "zip",
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("条目过多"), "{err}");
    }

    #[test]
    fn export_roundtrips_through_zip_flow() {
        let fx = Fx::new();
        fx.add_lib_skill("pdf", "PDF 技能");
        fx.add_lib_skill("docx", "Word 技能");
        let ids: Vec<String> = fx.store.read().iter().map(|s| s.id.clone()).collect();
        let dest = fx.dir.join("out.zip");
        export_impl(&fx.store, &ids, dest.to_str().unwrap()).unwrap();
        // 再按 ZIP 导入流程进另一个库，验证往返一致
        let fx2 = Fx::new();
        let result = import_zip_impl(
            &fx2.store,
            &mut Vec::new(),
            &dest,
            None,
            "zip",
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(result.added.len(), 2);
        assert!(fx2.store.skill_dir("pdf").join("SKILL.md").exists());
        assert!(fx2.store.skill_dir("docx").join("SKILL.md").exists());
        // 空选择报错
        assert!(export_impl(&fx.store, &["nonexistent".into()], dest.to_str().unwrap()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn stale_copy_detected_and_resynced() {
        let fx = Fx::new();
        let skill = fx.add_lib_skill("pdf", "处理 PDF");
        // codex 走 copy（强制），gemini 走 symlink
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
        apply_impl(&fx.store, &fx.agents, &skill.id, "gemini", true, true).unwrap();
        let skill = fx
            .store
            .read()
            .into_iter()
            .find(|s| s.id == skill.id)
            .unwrap();
        assert!(
            stale_agents(&fx.store, &fx.agents, &skill).is_empty(),
            "刚分发完不应有漂移"
        );
        // 库更新 → copy 副本漂移，symlink 不受影响
        fs::write(
            fx.store.skill_dir("pdf").join("SKILL.md"),
            "---\nname: pdf\ndescription: 新版\n---\nbody v2\n",
        )
        .unwrap();
        let stale = stale_agents(&fx.store, &fx.agents, &skill);
        assert_eq!(
            stale,
            vec!["codex".to_string()],
            "symlink 的 gemini 不算漂移"
        );
        let fixed = resync_impl(&fx.store, &fx.agents, &skill.id).unwrap();
        assert_eq!(fixed, vec!["codex".to_string()]);
        assert!(
            stale_agents(&fx.store, &fx.agents, &skill).is_empty(),
            "resync 后漂移清零"
        );
        let copied = fs::read_to_string(fx.agents["codex"].join("pdf").join("SKILL.md")).unwrap();
        assert!(copied.contains("新版"), "副本内容已追平库");
        assert!(
            fx.agents["codex"].join("pdf").join(MARKER_FILE).exists(),
            "仍保持 copy 形态"
        );
    }

    #[test]
    fn stale_detection_covers_whole_manifest() {
        let fx = Fx::new();
        let skill = fx.add_lib_skill("pdf", "处理 PDF");
        fs::write(fx.store.skill_dir("pdf").join("template.txt"), "v1").unwrap();
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
        let skill = fx
            .store
            .read()
            .into_iter()
            .find(|s| s.id == skill.id)
            .unwrap();
        assert!(
            stale_agents(&fx.store, &fx.agents, &skill).is_empty(),
            "副本与库一致时不漂移（.ccode-copy 标记不参与比较）"
        );
        // 只改 SKILL.md 之外的辅助文件也必须检出漂移
        fs::write(fx.store.skill_dir("pdf").join("template.txt"), "v2").unwrap();
        assert_eq!(
            stale_agents(&fx.store, &fx.agents, &skill),
            vec!["codex".to_string()]
        );
        // 库新增文件同样检出
        resync_impl(&fx.store, &fx.agents, &skill.id).unwrap();
        fs::write(fx.store.skill_dir("pdf").join("extra.txt"), "new").unwrap();
        assert_eq!(
            stale_agents(&fx.store, &fx.agents, &skill),
            vec!["codex".to_string()],
            "库新增文件也算漂移"
        );
    }

    #[test]
    fn compact_iso_defensive_on_malformed() {
        assert_eq!(compact_iso("2026-07-30T10:13:37Z"), "20260730-101337");
        // 格式漂移（数字不足 9 位）不得 panic，原样返回已有数字
        assert_eq!(compact_iso("abc"), "");
        assert_eq!(compact_iso("2026"), "2026");
        assert_eq!(compact_iso("2026-07-30"), "20260730");
    }

    #[test]
    fn find_skill_dirs_respects_depth_limit() {
        let fx = Fx::new();
        // 18 层嵌套深处藏一个技能：超过 MAX_WALK_DEPTH 不得被发现
        let deep = (0..18).fold(fx.dir.join("deep"), |p, i| p.join(format!("d{i}")));
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("SKILL.md"), "---\nname: too-deep\n---\n").unwrap();
        let mut found = Vec::new();
        find_skill_dirs(&fx.dir.join("deep"), &mut found);
        assert!(found.is_empty(), "超过深度上限的目录不得下钻");
    }

    #[cfg(unix)]
    #[test]
    fn walks_survive_symlink_loops() {
        let fx = Fx::new();
        // 真实空目录 a + 回指根目录的链接 up：路径解析次数随深度线性增长，
        // 保证命中我们自己的深度上限，而不是依赖 OS 的 ELOOP 行为
        let root = fx.dir.join("loop");
        fs::create_dir_all(root.join("a")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("up")).unwrap();
        let mut found = Vec::new();
        find_skill_dirs(&root, &mut found); // 无深度上限时这里会无限递归
        assert!(found.is_empty());
        let err = copy_dir_recursive(&root, &fx.dir.join("loop-copy")).unwrap_err();
        assert!(err.contains("嵌套超过"), "{err}");
    }

    #[test]
    fn charge_bytes_aborts_over_budget() {
        let mut total = 0;
        charge_bytes(&mut total, 100, 250).unwrap();
        charge_bytes(&mut total, 100, 250).unwrap();
        let err = charge_bytes(&mut total, 100, 250).unwrap_err();
        assert!(err.contains("预算"), "{err}");
    }

    #[test]
    fn zip_budget_uses_injected_limit() {
        let fx = Fx::new();
        let zip_path = fx.dir.join("big.zip");
        build_zip(
            &zip_path,
            &[
                ("skill-a/SKILL.md", b"---\nname: a\n---\n"),
                ("skill-a/blob.bin", &[0u8; 200]),
            ],
        );
        // 声明总量 ~215 超过注入预算 100：预检拒绝
        let err = import_zip_limited(
            &fx.store,
            &mut Vec::new(),
            &zip_path,
            None,
            "zip",
            None,
            None,
            None,
            100,
        )
        .unwrap_err();
        assert!(err.contains("拒绝解压"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn apply_failure_rolls_back_metadata() {
        use std::os::unix::fs::PermissionsExt;
        let fx = Fx::new();
        let skill = fx.add_lib_skill("pdf", "处理 PDF");
        apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap();
        assert!(fx.store.read()[0].apps["codex"]);
        // 库文件不可读 → 重复应用（先删旧分发再建新）的复制阶段必然失败
        let lib_file = fx.store.skill_dir("pdf").join("SKILL.md");
        fs::set_permissions(&lib_file, fs::Permissions::from_mode(0o000)).unwrap();
        let err = apply_impl(&fx.store, &fx.agents, &skill.id, "codex", true, false).unwrap_err();
        fs::set_permissions(&lib_file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(err.contains("复制"), "{err}");
        assert!(
            !fx.store.read()[0].apps["codex"],
            "失败后元数据必须回落为未启用，不能显示启用但盘上无物"
        );
        assert!(!fx.agents["codex"].join("pdf").join(MARKER_FILE).exists());
    }

    #[test]
    fn extract_skill_md_strips_fence_and_preamble() {
        let raw = "好的，我写好了：\n\n```markdown\n---\nname: model-watch\ndescription: 查模型\n---\n\n正文\n```\n";
        let got = extract_skill_md(raw);
        assert!(got.starts_with("---"));
        assert!(got.contains("name: model-watch"));
        assert!(got.contains("正文"));
        assert!(!got.contains("```"));
    }

    #[test]
    fn create_from_full_md_sets_category_and_outputs() {
        let fx = Fx::new();
        let md = "---\nname: model-watch\ndescription: 查各家模型\noutputs:\n  - notes/watch-inbox.md\n---\n\n只追加清单，不改表。\n";
        let skill = create_skill_from_full_md_at(&fx.store, md, "fallback", Some("巡检"), None).unwrap();
        assert_eq!(skill.name, "model-watch");
        assert_eq!(skill.category.as_deref(), Some("巡检"));
        assert_eq!(skill.source, "ccode");
        let parsed = parse_skill_md(&fx.store.skill_dir("model-watch").join("SKILL.md"));
        assert_eq!(parsed.outputs, vec!["notes/watch-inbox.md".to_string()]);
    }

    #[test]
    fn require_distributed_needs_apps_flag() {
        let fx = Fx::new();
        let skill = fx.add_lib_skill("model-watch", "查模型");
        let err = require_skill_distributed_at(&fx.store, "model-watch", "codex").unwrap_err();
        assert!(err.contains("未分发"));
        let mut skills = fx.store.read();
        skills[0].apps.insert("codex".into(), true);
        fx.store.write(&skills).unwrap();
        require_skill_distributed_at(&fx.store, "model-watch", "codex").unwrap();
        let err = require_skill_distributed_at(&fx.store, "ghost", "codex").unwrap_err();
        assert!(err.contains("技能库没有"));
        let _ = skill;
    }

    /// 卸载收回：只删指向技能库的链接；用户自己的链接、带标记的副本、库本身都不动；共用目录只扫一遍
    #[cfg(unix)]
    #[test]
    fn unlink_links_into_removes_only_links_to_library() {
        let root =
            std::env::temp_dir().join(format!("ccode-skills-unlink-{}", uuid::Uuid::new_v4()));
        let lib = root.join("lib");
        let agent = root.join("agent-skills");
        let other = root.join("elsewhere");
        fs::create_dir_all(lib.join("bib-check")).unwrap();
        fs::create_dir_all(&agent).unwrap();
        fs::create_dir_all(&other).unwrap();
        std::os::unix::fs::symlink(lib.join("bib-check"), agent.join("bib-check")).unwrap();
        std::os::unix::fs::symlink(&other, agent.join("user-link")).unwrap();
        fs::create_dir_all(agent.join("copied")).unwrap();
        fs::write(agent.join("copied").join(MARKER_FILE), "x").unwrap();
        let mut dirs = HashMap::new();
        dirs.insert("claude-code".to_string(), agent.clone());
        dirs.insert("codex".to_string(), agent.clone());

        assert!(unlink_links_into(&lib, &dirs).is_empty());
        assert!(fs::symlink_metadata(agent.join("bib-check")).is_err(), "指向库的链接已收回");
        assert!(fs::read_link(agent.join("user-link")).is_ok(), "用户自己的链接不动");
        assert!(agent.join("copied").is_dir(), "副本自成一份，留着");
        assert!(lib.join("bib-check").is_dir(), "库本身不动");
        fs::remove_dir_all(&root).ok();
    }

    /// 干跑：`CCODE_UNLINK_DRYRUN_DIR` 指向用 `cp -RP` 拷出的某家技能目录副本，按本机真实技能库收回
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn real_skill_dir_unlink_dry_run() {
        let dir = PathBuf::from(std::env::var("CCODE_UNLINK_DRYRUN_DIR").expect("设 CCODE_UNLINK_DRYRUN_DIR"));
        let lib = SkillStore::default_paths().unwrap().lib;
        let mut dirs = HashMap::new();
        dirs.insert("dry".to_string(), dir.clone());
        let errors = unlink_links_into(&lib, &dirs);
        assert!(errors.is_empty(), "{errors:?}");
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let link = fs::read_link(entry.path()).ok();
            println!("留下：{} {:?}", entry.file_name().to_string_lossy(), link);
            assert!(!link.is_some_and(|l| crate::paths::path_within_path(&l, &lib)));
        }
    }
}
