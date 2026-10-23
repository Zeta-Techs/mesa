use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

// 项目档案卡与项目注册（§11.3 机制一、§11.4 P1b 后端部分）：
// - 注册表：app.db 的 projects 表，只记 path/name/时间戳，不碰磁盘；
// - 档案卡：项目目录下 .ccode/project.toml，资源清单 + 流水线定义，跟着 git 走；
// - 资源自动发现与 git 引导为纯只读/幂等辅助，供「添加项目」流程组合调用。

const DEFAULT_ARTIFACT_DIR: &str = "artifacts";
const RESOURCE_TYPES: [&str; 4] = ["paper", "dataset", "reference", "other"];

// ===== 前端 DTO =====

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    /// 稳定身份（审计 §4.6）：project.toml 顶层 `id`（uuid），跟随文件夹移动/备份；
    /// 空串 = 旧项目尚未分配（注册/配置写入时补齐）。路径只是当前位置，不是永久身份。
    #[serde(default)]
    pub id: String,
    pub path: String, // canonical 绝对路径，注册表主键
    pub name: String,
    pub created_at: Option<String>,
    pub last_opened_at: Option<String>,
    /// research / coding / office；读自 project.toml，缺省 research
    pub work_mode: String,
    /// 项目级默认 Agent；密钥与 profile 仍只存全局配置。
    pub default_agent: Option<String>,
    /// Agent id → 项目默认 profile id；只保存引用，不保存密钥。
    pub default_profiles: BTreeMap<String, String>,
    /// Agent id → 本项目选用的模型 id。须属于该默认连接的模型名单；空 = 用名单第一个。
    #[serde(default)]
    pub default_models: BTreeMap<String, String>,
    /// 槽位 → 专属 Agent 绑定（见 ProjectAgentBinding）：某个固定用途不吃项目默认、
    /// 单独指一条连接+模型。槽位是稳定 key（reader = 沉浸阅读会话），按需扩展。
    #[serde(default)]
    pub task_bindings: BTreeMap<String, ProjectAgentBinding>,
}

/// 项目槽位的专属 Agent 绑定：agent 不单存，跟随 profile 所属 CLI。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectAgentBinding {
    /// 绑定的 profile id（连接被删时读取侧按未绑定回落，写入侧有清理）
    pub profile: String,
    /// 该连接里选用的模型 id；空/不在名单 = 用名单第一个
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ResourceDto {
    pub name: String,
    pub path: String,
    // type 是 Rust 关键字；TOML 与 JSON 两侧都叫 type
    #[serde(rename = "type")]
    pub kind: String,
    pub readonly: bool,
    pub note: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StepRunDto {
    pub name: String,
    pub command: String,
    #[serde(rename = "default")]
    pub is_default: bool,
    /// Windows 上给 Agent 用的 PowerShell 写法（command 是 bash 写法）。人点「运行脚本」
    /// 仍走 Git Bash + command；这一份只进 TASK.md，供命令工具是 PowerShell 的 Agent 照跑
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_windows: Option<String>,
}

/// 人工事项（步骤的一等属性，人机分工清单）：人要做的事 + 引导说明 + 交付落点 + 时机。
/// 引擎不识语义（科研语义只进模板），只做文本/路径透传；状态由落点检测 + 手动勾选派生，
/// 不在步骤定义里存任何状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HumanTaskDto {
    /// 一句话说明（checklist 条目文本）
    pub title: String,
    /// 引导说明（渠道选项等，只告知不推荐）；可空
    pub guidance: String,
    /// 交付落点（相对项目根/工作树）：目录（结尾 /）、精确文件、或「目录/通配」（如
    /// papers/search/*.bib）；空 = 纯脑力事项，只能靠手动勾选
    pub target: String,
    /// 时机：before（开工前）| during（并行）| after（收尾）；非法值解析期归一为 during
    pub timing: String,
    /// 可选事项：不做也不影响这一步跑完（如「下载付费墙文献全文」——拿不到全文时 agent 按摘要写）。
    /// 流程线标「可选」并从「N 件待做」里排除，免得摆出一个永远做不完的必办项。
    /// 缺省 false = 必办（旧档案卡与旧模板照原样按必办处理）
    pub optional: bool,
    /// 完成判定：exists（默认）| manual | all | no_placeholders。
    pub completion: String,
    /// `all` 的显式目标总数；缺省时仅对 papers/*.pdf 从 to-fetch.md 推导。
    pub expected_count: Option<usize>,
    /// `all` 的目标清单；每行一个目标，空行与 # 注释行不计数。
    pub manifest_path: String,
}

/// 步骤决策项（模板预置的「开工前要拍板的选择题」）。
/// 与 discussion_seeds 的分工：答案可枚举的走 decisions（点一下就答完，不开会话），
/// 真正开放、需要来回讨论的留在 discussion_seeds（点了去聊）。
/// 同样只做透传、不进 TASK.md——答案由人选定后落进任务书草稿，草稿才是开工合同。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DecisionDto {
    /// 问题（短句；不带问号更好渲染成一行）
    pub q: String,
    /// 可选答案，首项即推荐值（「全部用推荐值」按首项一键应用）；
    /// 空 options 保留为需人填写依据的决策，不提供推荐值；讨论种子不算已答决策。
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StepDto {
    pub name: String,
    pub workspace_name: String,
    pub brief: String,
    pub expected_artifacts: Vec<String>,
    /// 内容级验收条件；不改变旧档案卡的路径验收兼容性。
    pub acceptance_criteria: Vec<String>,
    /// 决策暂停策略：auto_continue（默认）| soft_pause（提醒）| hard_pause（未答不可开工）。
    #[serde(default = "default_decision_mode")]
    pub decision_mode: String,
    /// 结构化输入依赖；缺省兼容旧档案卡。
    pub inputs: Vec<String>,
    /// 可选输入：存在则读取，不存在不阻断步骤。
    pub optional_inputs: Vec<String>,
    /// 输入二选一/多选一组：每组至少满足一项即可。
    pub any_of_inputs: Vec<Vec<String>>,
    pub skills: Vec<String>,
    pub required_skills: Vec<String>,
    // 资源绑定：[[resources]] 条目的 path 精确匹配（相对/绝对均可）；
    // 空数组 = 不绑定 = 全部资源（向后兼容旧档案卡）
    pub resources: Vec<String>,
    pub run: Vec<StepRunDto>,
    pub human_tasks: Vec<HumanTaskDto>,
    /// 讨论种子（模板预置的「开工前建议想清楚的问题」）：卡片区按步骤列出，点击即聊；
    /// 引擎只做透传，不进 TASK.md（种子是给人的入口，不是给 agent 的合同）
    pub discussion_seeds: Vec<String>,
    /// 决策项（可枚举的拍板点，点选即答）：见 DecisionDto
    pub decisions: Vec<DecisionDto>,
    /// 这一步主要由谁出场：ai（AI 干活，你验收）| you（要你出场）| both（协作）。
    /// 缺省 ai。只影响界面上的角色标记与「轮到谁」提示，不参与任何流程判定
    /// （科研语义进模板不进引擎：引擎不认识「检索」「写作」，只认识这个中性字段）。
    pub role: String,
    /// 「这一步要先拍板文献从哪来」（模板声明，引擎只做透传）。
    /// true = 该步骤的「定方向」节点里出现文献来源选择器 + 就地导入入口，答案写 config.lit_source。
    /// 语义进模板不进引擎：哪一步该问由模板说了算，引擎不去猜（曾评估过按 skills 含 lit-search
    /// 推断，属隐式魔法，用户删个技能就没了，否决）。
    pub asks_lit_source: bool,
    /// 预置完成：本步产物已在主仓（示例课题的检索步），步进器视为已完成。
    /// 一旦用户真的建了该步工作区，以工作区状态为准。缺省 false。
    pub seed_complete: bool,
}

fn default_decision_mode() -> String {
    "auto_continue".into()
}

/// 文献雷达筛选（可选，存 project.toml）：新命中的展示与推送计数按期刊指标过滤。
/// 全空 = 不筛选（写盘时归一为 None，toml 不留空段）；指标未知的条目一律放行不误伤
/// （判定口径在 lit_watch.rs::metrics_pass_filter，前端 lit-watch.ts 有镜像）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LitWatchFilterDto {
    /// 只看 IF ≥ 此值的期刊；None = 不限
    pub min_if: Option<f64>,
    /// 只收中科院 N 区及以上（1 = 仅 1 区 … 4 = 不限）；None = 不限
    pub max_cas_quartile: Option<u8>,
    /// 只要中科院 Top 期刊
    pub top_only: bool,
}

impl LitWatchFilterDto {
    /// 全空 = 不筛选
    pub fn is_inert(&self) -> bool {
        self.min_if.is_none() && self.max_cas_quartile.is_none() && !self.top_only
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectConfigDto {
    // 课题主题：一键开步写进 TASK.md「课题主题」段；可省
    pub topic: Option<String>,
    /// 全局设定（v3.89）：贯穿全程的决定——如综述角度、目标篇幅、读者与文风、投稿去向。
    /// 它们决定后面每一步，摆在某个步骤的决策项里属层级错配（用户实测反馈）。
    /// 每条一行「问题：答案」，随 TASK.md 下发给每一步。引擎不认识内容，只做透传。
    pub settings: Vec<String>,
    /// 人在规则编辑器里保存过完整列表。未置位时启动仍补工作方式默认规则。
    pub rules_owned: bool,
    /// 验收写回时拒绝覆盖的相对路径（目录或文件）。
    /// 有研究步骤的科研界面不展示；合并/定时采纳仍认（去掉流程后设置回来）。
    pub protected_paths: Vec<String>,
    pub artifact_dir: String,
    pub resources: Vec<ResourceDto>,
    pub steps: Vec<StepDto>,
    /// 「不使用研究流程」显式标记：true = 用户明确不要流水线（隐藏模板引导横幅与定时任务区块），
    /// 与「稍后再选」（不写标记、保留引导）区分；追加模板步骤时自动清回 false
    pub pipeline_opt_out: bool,
    /// 文献来源：search = 让 agent 系统检索（默认，缺省即此）；
    /// zotero / endnote / folder = 用户已有文献，检索这一步降级为「盘点已有 + 查漏补缺」。
    /// 纯透传标记——引擎不认科研语义，怎么变形由模板简报自述（§11.1 纪律一）
    pub lit_source: String,
    /// 投稿流程分支：initial = 首投，revision = 返修；缺省表示尚未选择。
    pub submission_mode: Option<String>,
    /// 当前返修轮次；首投不使用。缺省按第 1 轮返修处理。
    pub submission_round: Option<u32>,
    /// 文献雷达筛选：新命中展示与推送计数按期刊指标过滤；None/全空 = 不筛选
    pub lit_watch_filter: Option<LitWatchFilterDto>,
    /// 工作方式：research / coding / office。缺省 research（旧档案卡 = 科研）
    pub work_mode: String,
    /// 项目技能池（技能库 name，审计 §4.9）：无流程科研 / 办公 / 编程进上下文包；
    /// 有研究步骤的科研不用此字段（技能以 steps[].skills 为准）。空 = 不写行。
    pub skills: Vec<String>,
    /// 对话注入（2026-10-16 拍板）：＋新对话 / 问 AI 的 session 包开关。
    /// auto = 自动生成（缺省）；custom = 按模板；off = 不注入。
    /// 只管 session 包；开工任务书 / 验收后写入 / 编程车道 goal 的目标包不受影响。
    pub session_injection_mode: Option<String>,
    /// 自定义模板全文；占位符（{{课题主题}} 等，清单见前端 project-context.ts）
    /// 开对话时按项目当时数据填入。空模板按 auto 处理；非空即写盘（切 mode 不清草稿）。
    pub session_injection_template: Option<String>,
}

/// 文献来源合法值；非法值解析期归一为 search
pub const LIT_SOURCES: [&str; 4] = ["search", "zotero", "endnote", "folder"];
pub const SUBMISSION_MODES: [&str; 2] = ["initial", "revision"];
pub const WORK_MODES: [&str; 3] = ["research", "coding", "office"];
/// 对话注入合法值；非法值解析期按 auto（现状行为）
pub const SESSION_INJECTION_MODES: [&str; 3] = ["auto", "custom", "off"];

pub(crate) fn normalize_work_mode(value: &str) -> String {
    let v = value.trim();
    if WORK_MODES.contains(&v) {
        v.to_string()
    } else {
        "research".into()
    }
}

impl Default for ProjectConfigDto {
    fn default() -> Self {
        Self {
            topic: None,
            settings: Vec::new(),
            rules_owned: false,
            protected_paths: Vec::new(),
            artifact_dir: DEFAULT_ARTIFACT_DIR.into(),
            resources: Vec::new(),
            steps: Vec::new(),
            pipeline_opt_out: false,
            lit_source: "search".into(),
            submission_mode: None,
            submission_round: None,
            lit_watch_filter: None,
            work_mode: "research".into(),
            skills: Vec::new(),
            session_injection_mode: None,
            session_injection_template: None,
        }
    }
}

/// 读档案卡结果：坏字段不阻断，逐条进 warnings 告知前端
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigReadDto {
    pub config: ProjectConfigDto,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredResourceDto {
    pub path: String, // 相对项目根，统一正斜杠
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
    pub mtime: Option<String>,
    pub exists: bool, // 已在 project.toml 资源清单里登记过
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnsureGitDto {
    pub initialized: bool,       // 本次执行了 git init
    pub gitignore_written: bool, // 本次新建了 .gitignore
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapCommitDto {
    pub committed: bool,    // 本次是否产生了提交
    pub paths: Vec<String>, // 实际提交的文件（相对仓库根）
}

// ===== 注册表（app.db projects 表；建表风格同 workspaces::db_at） =====

fn app_db_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("app.db"))
}

fn db_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("打开 app.db 失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置 app.db 等待时间失败: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects(
          path TEXT PRIMARY KEY, name TEXT NOT NULL,
          created_at TEXT, last_opened_at TEXT);",
    )
    .map_err(|e| format!("初始化 projects 表失败: {e}"))?;
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(projects)")
        .map_err(|e| format!("读取 projects 表结构失败: {e}"))?
        .query_map([], |r| r.get(1))
        .map_err(|e| format!("读取 projects 表结构失败: {e}"))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("读取 projects 表结构失败: {e}"))?;
    if !columns.iter().any(|c| c == "default_agent") {
        conn.execute("ALTER TABLE projects ADD COLUMN default_agent TEXT", [])
            .map_err(|e| format!("升级 projects 表失败: {e}"))?;
    }
    if !columns.iter().any(|c| c == "default_profiles") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN default_profiles TEXT NOT NULL DEFAULT '{}'",
            [],
        )
        .map_err(|e| format!("升级 projects 表失败: {e}"))?;
    }
    if !columns.iter().any(|c| c == "default_models") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN default_models TEXT NOT NULL DEFAULT '{}'",
            [],
        )
        .map_err(|e| format!("升级 projects 表失败: {e}"))?;
    }
    if !columns.iter().any(|c| c == "task_bindings") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN task_bindings TEXT NOT NULL DEFAULT '{}'",
            [],
        )
        .map_err(|e| format!("升级 projects 表失败: {e}"))?;
    }
    // §4.6：稳定项目身份；旧行在注册/配置写入/列表读到档案卡 id 时回填
    if !columns.iter().any(|c| c == "id") {
        conn.execute("ALTER TABLE projects ADD COLUMN id TEXT", [])
            .map_err(|e| format!("升级 projects 表失败: {e}"))?;
    }
    Ok(conn)
}

fn db() -> Result<Connection, String> {
    db_at(&app_db_path()?)
}

/// 注册用主键：能 canonicalize 就用 canonical 路径，不同写法指向同一目录时去重
/// （pub(crate)：workspaces.rs 人工事项检测根归属同一口径）
pub(crate) fn canonical_key(path: &Path) -> String {
    // 剥掉 canonicalize 在 Windows 带出的 `\\?\` 前缀再落库：verbatim 形式与普通形式
    // （子进程报告的 cwd、dirs::home_dir()、用户手输）按 PathBuf 分量比永不相等，
    // 直接进库会让「已注册项目的会话被当成随手聊」「worktree 被误判为仓库候选」
    // 这一串跨方言比较全部失效，界面上还会直接显示 `\\?\C:\Users\...`。
    // 剥完仍是可直接用于文件操作的合法路径；macOS 上是恒等变换。
    crate::paths::strip_verbatim(fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))
        .to_string_lossy()
        .into_owned()
}

fn register_at(
    conn: &Connection,
    path: &Path,
    name: &str,
    now: &str,
) -> Result<ProjectDto, String> {
    let key = canonical_key(path);
    // 名称为空时回落目录 basename，避免注册表出现无意义空名
    let name = if name.trim().is_empty() {
        Path::new(&key)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| key.clone())
    } else {
        name.trim().to_string()
    };
    // 稳定身份（§4.6）：档案卡 id 跟随文件夹；同一 id 出现在新路径 = 目录被移动过，
    // 把注册行改到新路径（保留 created_at 与项目默认配置），不建新行
    let toml_id = project_id_at(path);
    if let Some(pid) = toml_id.as_deref() {
        let moved: Option<String> = conn
            .query_row(
                "SELECT path FROM projects WHERE id=?1 AND path<>?2",
                params![pid, key],
                |r| r.get(0),
            )
            .ok();
        if let Some(old) = moved.as_deref() {
            if !crate::paths::same_path(old, &key)
                && Path::new(old)
                    .try_exists()
                    .map_err(|e| format!("无法确认原项目位置：{e}"))?
            {
                return Err(format!("同一项目身份的原目录仍存在：{old}。这是副本或另一个检出，不会自动当作搬家；请先明确项目身份，原项目与历史记录未改动"));
            }
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开始项目重定位失败：{e}"))?;
            tx.execute(
                "UPDATE projects SET path=?2, name=?3, last_opened_at=?4 WHERE id=?1",
                params![pid, key, name, now],
            )
            .map_err(|e| format!("重连已移动项目失败: {e}"))?;
            for table in ["tasks", "runs"] {
                let columns: Vec<String> = tx
                    .prepare(&format!("PRAGMA table_info({table})"))
                    .map_err(|e| e.to_string())?
                    .query_map([], |r| r.get(1))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<_, _>>()
                    .map_err(|e| e.to_string())?;
                if columns.iter().any(|c| c == "project_id")
                    && columns.iter().any(|c| c == "project_root")
                {
                    tx.execute(&format!("UPDATE {table} SET project_id=?1 WHERE project_id IS NULL AND project_root=?2"), params![pid, old])
                        .map_err(|e| format!("关联旧任务项目身份失败：{e}"))?;
                }
            }
            tx.commit()
                .map_err(|e| format!("保存项目重定位失败：{e}"))?;
            if let Some(old) = moved.as_deref() {
                let _ = crate::workspaces::relocate_repo_paths(pid, old, &key);
                let _ = crate::coding::relocate_lane_repo_paths(pid, old, &key);
            }
            let created_at: Option<String> = conn
                .query_row(
                    "SELECT created_at FROM projects WHERE path=?1",
                    params![key],
                    |r| r.get(0),
                )
                .ok();
            return Ok(attach_work_mode(ProjectDto {
                id: pid.to_string(),
                path: key.clone(),
                name,
                created_at,
                last_opened_at: Some(now.to_string()),
                work_mode: "research".into(),
                default_agent: conn
                    .query_row(
                        "SELECT default_agent FROM projects WHERE path=?1",
                        params![key],
                        |r| r.get(0),
                    )
                    .ok()
                    .flatten(),
                default_profiles: project_string_map(&conn, &key, "default_profiles"),
                default_models: project_string_map(&conn, &key, "default_models"),
                task_bindings: project_task_bindings(&conn, &key),
            }));
        }
    }
    let id = match toml_id {
        Some(pid) => pid,
        None => ensure_project_id_at(path)?,
    };
    // 重复注册：保留 created_at，更新 name 与 last_opened_at
    conn.execute(
        "INSERT INTO projects(path, name, created_at, last_opened_at, id) VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET name=?2, last_opened_at=?4, id=?5",
        params![key, name, now, now, id],
    )
    .map_err(|e| format!("注册项目失败: {e}"))?;
    let created_at: Option<String> = conn
        .query_row(
            "SELECT created_at FROM projects WHERE path=?1",
            params![key],
            |r| r.get(0),
        )
        .ok();
    Ok(attach_work_mode(ProjectDto {
        id,
        path: key.clone(),
        name,
        created_at,
        last_opened_at: Some(now.to_string()),
        work_mode: "research".into(),
        default_agent: conn
            .query_row(
                "SELECT default_agent FROM projects WHERE path=?1",
                params![key],
                |r| r.get(0),
            )
            .ok()
            .flatten(),
        default_profiles: project_string_map(&conn, &key, "default_profiles"),
        default_models: project_string_map(&conn, &key, "default_models"),
        task_bindings: project_task_bindings(&conn, &key),
    }))
}

/// 项目名册默认（Agents 页「项目默认」）：默认 Agent + 名册给这家绑的连接与点选模型。
/// 定时任务未钉连接时据此取连接（scheduler::pick_project_default）。
pub(crate) struct ProjectDefaultPrefs {
    pub agent: String,
    pub profile: Option<String>,
    pub model: Option<String>,
}

/// 读项目默认；项目没注册或没设默认 Agent 返回 None。
pub(crate) fn project_default_prefs(root: &Path) -> Option<ProjectDefaultPrefs> {
    let conn = db().ok()?;
    let key = canonical_key(root);
    let agent: Option<String> = conn
        .query_row(
            "SELECT default_agent FROM projects WHERE path=?1",
            params![key],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let agent = agent.map(|a| a.trim().to_string()).filter(|a| !a.is_empty())?;
    let pick = |column: &str| {
        project_string_map(&conn, &key, column)
            .get(&agent)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let profile = pick("default_profiles");
    let model = pick("default_models");
    Some(ProjectDefaultPrefs {
        agent,
        profile,
        model,
    })
}

fn project_string_map(conn: &Connection, path: &str, column: &str) -> BTreeMap<String, String> {
    let sql = match column {
        "default_profiles" => "SELECT default_profiles FROM projects WHERE path=?1",
        "default_models" => "SELECT default_models FROM projects WHERE path=?1",
        _ => return BTreeMap::new(),
    };
    conn.query_row(sql, params![path], |row| row.get::<_, String>(0))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// task_bindings 列（槽位 → ProjectAgentBinding 的 JSON map）；坏值按空处理
fn project_task_bindings(
    conn: &Connection,
    path: &str,
) -> BTreeMap<String, ProjectAgentBinding> {
    conn.query_row(
        "SELECT task_bindings FROM projects WHERE path=?1",
        params![path],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|raw| serde_json::from_str(&raw).ok())
    .unwrap_or_default()
}

/// 项目只记住连接名单里的一个模型 id。空 = 用名单第一个；不在名单里的拒绝写入。
pub(crate) fn accept_project_model(
    models: &[String],
    model: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if models.iter().any(|item| item == model) {
        return Ok(Some(model.to_string()));
    }
    Err("这个模型不在所选连接里".into())
}

fn attach_work_mode(mut p: ProjectDto) -> ProjectDto {
    p.work_mode = normalize_work_mode(&read_config_at(Path::new(&p.path)).config.work_mode);
    p
}

pub(crate) fn list_projects_in(conn: &Connection) -> Result<Vec<ProjectDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT path, name, created_at, last_opened_at, default_agent, default_profiles, id, default_models, task_bindings FROM projects
             ORDER BY last_opened_at DESC, path ASC",
        )
        .map_err(|e| format!("读取项目列表失败: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ProjectDto {
                id: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                path: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                last_opened_at: r.get(3)?,
                work_mode: "research".into(),
                default_agent: r.get(4)?,
                default_profiles: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
                default_models: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
                task_bindings: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("读取项目列表失败: {e}"))?;
    let mut projects: Vec<ProjectDto> = rows.flatten().collect();
    // 旧行 id 回填：档案卡里已有 id 的只补注册表（纯 DB 写，不动文件）；
    // 档案卡也没有 id 的保持空串，等注册/配置写入时分配（list 不做文件副作用）
    //
    // 只对**缺 id 的行**读档案卡，且批量 + 有界：这是列表路径，前端按 2s 轮询，
    // 逐个同步读会让一个卡在云同步的文件系统把项目列表整个挂死
    //（2026-09-26 修；2026-09-13 只修了测试侧，产品侧一直没修）。
    let needs_id: Vec<usize> = projects
        .iter()
        .enumerate()
        .filter(|(_, p)| p.id.is_empty())
        .map(|(i, _)| i)
        .collect();
    if !needs_id.is_empty() {
        let roots: Vec<PathBuf> = needs_id
            .iter()
            .map(|i| PathBuf::from(&projects[*i].path))
            .collect();
        for (&i, text) in needs_id.iter().zip(cards_bounded(&roots)) {
            let Some(pid) = text.as_deref().and_then(project_id_in_text) else {
                continue;
            };
            let _ = conn.execute(
                "UPDATE projects SET id=?2 WHERE path=?1",
                params![projects[i].path, pid],
            );
            projects[i].id = pid;
        }
    }
    Ok(projects.into_iter().map(attach_work_mode).collect())
}

/// 注册项目根：cwd 落在哪个项目里（最长前缀）。scratch / 未注册返回 None。
pub(crate) fn project_root_containing(path: &str) -> Option<String> {
    let Ok(conn) = db() else {
        return None;
    };
    let Ok(list) = list_projects_in(&conn) else {
        return None;
    };
    let mut best: Option<(usize, String)> = None;
    for p in list {
        if crate::paths::path_within(path, &p.path) {
            let len = p.path.len();
            if best.as_ref().map(|(l, _)| len > *l).unwrap_or(true) {
                best = Some((len, p.path));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// 删除 profile 时清理项目默认配置引用；不影响项目默认 Agent。
/// 槽位专属绑定（task_bindings）里指向该连接的槽位一并清掉（读取侧也有失效回落，
/// 这里是写侧收口，避免列表里挂着死引用）。
pub(crate) fn clear_project_default_profile(profile_id: &str) {
    let Ok(conn) = db() else {
        return;
    };
    let Ok(mut stmt) = conn
        .prepare("SELECT path, default_profiles, default_models, task_bindings FROM projects")
    else {
        return;
    };
    let rows: Vec<(String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default();
    drop(stmt);
    if rows.is_empty() {
        return;
    }
    for (path, raw, raw_models, raw_bindings) in rows {
        let mut defaults: BTreeMap<String, String> = serde_json::from_str(&raw).unwrap_or_default();
        let removed: Vec<String> = defaults
            .iter()
            .filter(|(_, id)| id.as_str() == profile_id)
            .map(|(agent, _)| agent.clone())
            .collect();
        let mut bindings: BTreeMap<String, ProjectAgentBinding> =
            serde_json::from_str(&raw_bindings).unwrap_or_default();
        let bound_slots: Vec<String> = bindings
            .iter()
            .filter(|(_, b)| b.profile == profile_id)
            .map(|(slot, _)| slot.clone())
            .collect();
        if removed.is_empty() && bound_slots.is_empty() {
            continue;
        }
        defaults.retain(|_, id| id != profile_id);
        let mut models: BTreeMap<String, String> =
            serde_json::from_str(&raw_models).unwrap_or_default();
        for agent in &removed {
            models.remove(agent);
        }
        for slot in &bound_slots {
            bindings.remove(slot);
        }
        let Ok(encoded) = serde_json::to_string(&defaults) else {
            continue;
        };
        let Ok(encoded_models) = serde_json::to_string(&models) else {
            continue;
        };
        let Ok(encoded_bindings) = serde_json::to_string(&bindings) else {
            continue;
        };
        let _ = conn.execute(
            "UPDATE projects SET default_profiles=?2, default_models=?3, task_bindings=?4 WHERE path=?1",
            params![path, encoded, encoded_models, encoded_bindings],
        );
    }
}

/// P2a PDF 白名单用（pdf.rs）：全部注册项目根 + 各项目 project.toml 登记资源的绝对路径。
/// 资源相对路径按项目根解析；读不到配置的项目静默跳过（白名单宁缺勿滥）。
pub(crate) fn project_roots_and_resources() -> (Vec<PathBuf>, Vec<PathBuf>) {
    if cfg!(test) {
        // 单测不读本机真实注册表：注册项目的档案卡可能落在 iCloud 等慢文件系统上，
        // open() 内核级阻塞会把整条测试线挂死（2026-09-13 实证）；需要白名单的测试
        // 自行注入临时根（同 model_registry cfg!(test) 不读本机缓存的先例）
        return (Vec::new(), Vec::new());
    }
    let Ok(conn) = db() else {
        return (Vec::new(), Vec::new());
    };
    let roots: Vec<PathBuf> = list_projects_in(&conn)
        .unwrap_or_default()
        .into_iter()
        .map(|p| PathBuf::from(&p.path))
        .collect();
    // 档案卡批量有界读取：坏路径只让**该项目**的资源缺席，不再拖垮整批
    //（2026-09-26 修：此前逐个同步读，一个卡住的云同步项目会让引用检查/PDF 预览一起挂死）
    let mut resources = Vec::new();
    for (root, text) in roots.iter().zip(cards_bounded(&roots)) {
        let Some(text) = text else { continue };
        let (config, _) = parse_config(&text);
        for r in config.resources {
            let rp = PathBuf::from(&r.path);
            resources.push(if rp.is_absolute() { rp } else { root.join(&rp) });
        }
    }
    (roots, resources)
}

/// portwatch 归属判定用：注册项目 (path, name) 清单；读取失败降级为空（标注缺失不阻断端口列表）
pub(crate) fn registered_project_rows() -> Vec<(String, String)> {
    let Ok(conn) = db() else {
        return Vec::new();
    };
    list_projects_in(&conn)
        .unwrap_or_default()
        .into_iter()
        .map(|p| (p.path, p.name))
        .collect()
}

/// 当前已注册项目的路径清单（定时任务孤儿清理用）。读库失败上抛，
/// 调用方不得把失败当成「零项目」——否则会把全部 schedules 清掉。
pub(crate) fn registered_path_keys() -> Result<Vec<String>, String> {
    let conn = db()?;
    Ok(list_projects_in(&conn)?
        .into_iter()
        .map(|p| p.path)
        .collect())
}

/// 只删注册记录，磁盘上的项目目录一概不动
fn remove_project_at(conn: &Connection, path: &Path) -> Result<(), String> {
    let key = canonical_key(path);
    conn.execute("DELETE FROM projects WHERE path=?1", params![key])
        .map_err(|e| format!("移除项目注册失败: {e}"))?;
    // 定时任务挂在应用级 schedules.json，不跟项目目录走；摘注册后 UI 管不到它，
    // 不删就会继续巡检、收件箱还拿已删项目的「N 条新命中」来烦。失败只记日志，
    // 主路径已经成功（同 cleanup_project_db_traces 口径）。
    if let Err(e) = crate::scheduler::delete_schedules_for_project(path) {
        crate::logbuf::record("warn", "projects", &format!("清理定时任务失败: {e}"));
    }
    Ok(())
}

/// 是否在 projects 表有注册记录（读取失败按未注册处理，防护宁严勿宽）
fn is_registered_at(conn: &Connection, path: &Path) -> bool {
    let key = canonical_key(path);
    conn.query_row(
        "SELECT COUNT(*) FROM projects WHERE path=?1",
        params![key],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

// ===== 项目目录删除（工作区页右键「删除项目目录…」） =====
// 与「移除注册」相反：删全部工作区 + 目录本身 + 注册记录。主目录走系统回收站（可反悔），
// 工作区 worktree/分支是 git 元数据只能彻底删。防护宁严勿宽：必须是 Mesa 项目、
// 拒绝主目录/文档目录/浅层路径/系统目录。

/// 目录删除防护：拒绝 home/document_dir 本身、少于两级的浅层路径（防误传 ~/Documents
/// 这类）、系统与关键用户目录（复用 fs_tree 的重要路径黑名单，含 canonicalize 双校验）。
/// 回收站入口（测试态直删）。单测里走真实 trash 会在开发机上驱动 Finder
/// （AppleScript）：慢、与用户桌面上的回收站操作互相争抢，还会把瞬态
/// -47「正在使用中」带进测试结果（2026-10-12 实证：全量测试与用户界面
/// 同分钟报同款错）。trash 库行为不是被测对象——测试里直删即可。
#[allow(unused)]
fn trash_to_recycle_bin(path: &Path) -> Result<(), trash::Error> {
    #[cfg(test)]
    {
        let r = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        return r.map_err(|e| trash::Error::Unknown {
            description: format!("测试直删失败: {e}"),
        });
    }
    #[cfg(not(test))]
    {
        trash::delete(path)
    }
}

/// 移入系统回收站（带重试）。macOS 上 trash 走 Finder AppleScript，目录刚经历
/// 大批文件操作后（如清痕迹先删全部 worktree）、或系统元数据服务尚未放手时，
/// Finder 会瞬时返回 -47「正在使用中」——实测连单测都会偶发。重试两轮（300ms /
/// 1s）吃掉瞬态；仍失败则给可执行提示（常见占用方：打开该目录的终端/编辑器/
/// Finder 窗口、工作目录在其内的运行中 agent）。
pub(crate) fn trash_delete_retry(path: &Path, what: &str) -> Result<(), String> {
    let mut last = None;
    for attempt in 0..3 {
        match trash_to_recycle_bin(path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(
                        if attempt == 0 { 300 } else { 1000 },
                    ));
                }
            }
        }
    }
    Err(format!(
        "{what}移入回收站失败（目录被占用：常见于打开它的终端 / 编辑器 / Finder 窗口，或工作目录在其内的运行中 agent；关掉后重试）: {}",
        last.map(|e| e.to_string()).unwrap_or_default()
    ))
}

fn guard_project_dir(dir: &Path) -> Result<(), String> {
    // 两侧都归一到 canonicalize 口径再比。调用方（:464 / :501）传进来的是 canonicalize
    // 过的路径，Windows 上带 `\\?\` verbatim 前缀，而 home_dir()/document_dir() 是普通形式，
    // 只归一一侧就永远比不中、这两道闸静默失效（workspaces.rs:3156 同款修法）。
    // dir 也归一是为了兼容直接传普通路径的调用（含单测）。
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let dir_c = canon(dir);
    if dirs::home_dir().is_some_and(|h| dir_c == canon(&h)) {
        return Err("不能删除用户主目录".to_string());
    }
    if dirs::document_dir().is_some_and(|d| dir_c == canon(&d)) {
        return Err("不能删除文档目录本身".to_string());
    }
    // 规范化路径的有效段数（去掉根/盘符）少于 2 拒绝，如 /tmp、C:\proj
    let depth = dir
        .components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .count();
    if depth < 2 {
        return Err("路径层级过浅，为避免误删拒绝操作".to_string());
    }
    if crate::fs_tree::is_protected_path(&dir.to_string_lossy()) {
        return Err("系统/重要目录受保护，拒绝删除".to_string());
    }
    Ok(())
}

/// 清掉项目在 app.db 里留下的行（删项目 / 清痕迹共用）。
///
/// 这三张表都以「项目路径」或「卡片 id」为键，删项目时不清就永久变孤儿：
/// `human_task_checks` 会让同路径的新项目继承上一个项目的勾选状态；
/// `session_meta.task_id` / `card_claims` 会让会话永远挂着已不存在的卡片 id。
/// （`delete_task_card` 早就记得清 session_meta，只是项目级删除漏了这一步。）
///
/// best-effort：主删除流程已经成功，清理失败不该把整个操作判失败——
/// 但逐条记进 warnings 由调用方拼进摘要，不静默吞掉。
///
/// 返回 (清掉的行数, warnings)。行数为 0 时调用方不提这件事：
/// 三张表都是懒建的（用户没勾过人工事项就没有 human_task_checks），
/// 表不存在 = 本来就没有痕迹，不是错误。
fn cleanup_project_db_traces(
    conn: &Connection,
    dir: &Path,
    task_ids: &[String],
) -> (usize, Vec<String>) {
    let mut warnings = Vec::new();
    let mut cleaned = 0usize;
    let key = canonical_key(dir);
    /// 懒建表未创建时的错误一律当「没有痕迹」处理，不回报给用户
    fn missing_table(e: &rusqlite::Error) -> bool {
        e.to_string().contains("no such table")
    }
    let mut run = |sql: &str, p: &[&dyn rusqlite::ToSql], what: &str| match conn.execute(sql, p) {
        Ok(n) => cleaned += n,
        Err(e) if missing_table(&e) => {}
        Err(e) => warnings.push(format!("{what}清理失败: {e}")),
    };
    run(
        "DELETE FROM human_task_checks WHERE project_path = ?1",
        &[&key],
        "人工事项勾选记录",
    );
    run(
        "DELETE FROM card_claims WHERE cwd = ?1",
        &[&key],
        "卡片认领登记",
    );
    for id in task_ids {
        match conn.execute(
            "UPDATE session_meta SET task_id=NULL WHERE task_id=?1",
            rusqlite::params![id],
        ) {
            Ok(n) => cleaned += n,
            Err(e) if missing_table(&e) => {}
            Err(e) => warnings.push(format!("会话归卡标记清理失败（{id}）: {e}")),
        }
    }
    (cleaned, warnings)
}

/// 目录已不在磁盘上时的降级清理：摘注册记录 + 清工作区行（只清库不动磁盘）+
/// 人工事项/卡片勾选痕迹。定时任务由 remove_project_at 顺带清。
/// 只在 fs::canonicalize 报 NotFound 时才进这条路——目录都没了，worktree/分支没有可操作
/// 对象，只能清库。权限/IO 错误由调用方报错，不误判成「目录不在」（磁盘上可能还有文件）。
fn cleanup_records_for_missing_dir(conn: &Connection, path: &Path) -> Result<String, String> {
    // 工作区行按 repo_path 匹配删除。workspaces_of_repo 对缺失目录用原样路径比对，
    // 与落库时的 canonical_key 口径一致（canonicalize 失败才回落原样）。
    let workspaces = crate::workspaces::workspaces_of_repo(conn, path)?;
    for w in &workspaces {
        conn.execute("DELETE FROM workspaces WHERE id=?1", params![w.id])
            .map_err(|e| format!("清理工作区记录失败: {e}"))?;
    }
    remove_project_at(conn, path)?;
    let (cleaned, warn) = cleanup_project_db_traces(conn, path, &[]);
    let mut parts: Vec<String> = vec!["注册记录".to_string()];
    if !workspaces.is_empty() {
        parts.push(format!("{} 个工作区记录", workspaces.len()));
    }
    if cleaned > 0 {
        parts.push("勾选与归卡记录".to_string());
    }
    Ok(format!(
        "项目目录已不在磁盘上，无法删除目录本身；已移除：{}{}",
        parts.join("、"),
        warn.first().map(|w| format!("；{w}")).unwrap_or_default()
    ))
}

/// 删除项目目录：全部工作区（含已归档，彻底删）→ 主目录移入系统回收站（可反悔）→ 注册记录。
/// 工作区任一删除失败即中止，已删的不回滚（错误信息由 workspaces 层说明已删哪些）。
/// 目录已不在磁盘上时降级为只清库（注册记录 + 工作区行 + 痕迹），报「目录不在」而非 os error 2。
fn delete_project_dir_impl(conn: &Connection, path: &Path) -> Result<String, String> {
    let dir = match fs::canonicalize(path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return cleanup_records_for_missing_dir(conn, path);
        }
        // 权限不足/IO 错误时磁盘上可能仍有文件，按「目录不在」降级会留孤儿数据
        Err(e) => return Err(format!("无法访问项目目录（未做清理）: {e}")),
    };
    if !dir.is_dir() {
        return Err("目标不是目录，拒绝删除".to_string());
    }
    // Mesa 项目判定：档案卡、注册记录、工作区记录三者有其一
    let has_card = config_path(&dir).exists();
    let has_workspaces = !crate::workspaces::workspaces_of_repo(conn, &dir)?.is_empty();
    if !has_card && !is_registered_at(conn, &dir) && !has_workspaces {
        return Err(
            "该目录不是 Mesa 项目（无 .ccode/project.toml、注册或工作区记录），拒绝删除"
                .to_string(),
        );
    }
    guard_project_dir(&dir)?;
    // 卡片 id 必须在目录还在时读出来：删完 .ccode/project.toml 就没地方查了
    let task_ids: Vec<String> = task_cards_at(&dir).into_iter().map(|c| c.id).collect();
    let deleted = crate::workspaces::delete_workspaces_for_repo(conn, &dir)?;
    // 主目录走系统回收站可反悔；工作区 worktree/分支属 git 元数据，回收站管不了，仍为彻底删除
    trash_delete_retry(&dir, "")?;
    remove_project_at(conn, &dir)?;
    let (_, warn) = cleanup_project_db_traces(conn, &dir, &task_ids);
    let tail = warn.first().map(|w| format!("；{w}")).unwrap_or_default();
    if deleted.is_empty() {
        Ok(format!("目录已移入回收站，注册记录已删除{tail}"))
    } else {
        Ok(format!(
            "目录已移入回收站，已删除 {} 个工作区{tail}",
            deleted.len()
        ))
    }
}

/// 清除 Mesa 痕迹（中间档：保留项目文件夹与用户的全部文件，其余 Mesa 痕迹清掉）：
/// 全部工作区（worktree + 分支 + 记录，彻底删——同删除项目目录口径）→ `.ccode/` 移入系统
/// 回收站（可反悔）→ 摘注册记录。**不自动 git rm/提交**：.ccode 若被 git 跟踪过，删除会显在
/// 改动面板，由用户自行提交（自动提交用户仓库违反既有纪律；摘要文案里提示）。
/// 目录已不在磁盘上时与删除项目目录同口径降级：只清库。
fn purge_project_traces_impl(conn: &Connection, path: &Path) -> Result<String, String> {
    let dir = match fs::canonicalize(path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return cleanup_records_for_missing_dir(conn, path);
        }
        // 权限不足/IO 错误时磁盘上可能仍有痕迹，按「目录不在」降级会留孤儿数据
        Err(e) => return Err(format!("无法访问项目目录（未做清理）: {e}")),
    };
    if !dir.is_dir() {
        return Err("目标不是目录，拒绝操作".to_string());
    }
    guard_project_dir(&dir)?;
    let has_ccode = dir.join(".ccode").is_dir();
    let registered = is_registered_at(conn, &dir);
    let has_workspaces = !crate::workspaces::workspaces_of_repo(conn, &dir)?.is_empty();
    if !has_ccode && !registered && !has_workspaces {
        return Err("该目录没有 Mesa 痕迹（无 .ccode、注册或工作区记录）".to_string());
    }
    // 工作区任一删除失败即中止（已删的不回滚），错误信息由 workspaces 层说明已删哪些
    let deleted = crate::workspaces::delete_workspaces_for_repo(conn, &dir)?;
    // 卡片 id 在 .ccode 还在时读出来（下面就要把它移进回收站了）
    let task_ids: Vec<String> = task_cards_at(&dir).into_iter().map(|c| c.id).collect();
    if has_ccode {
        trash_delete_retry(&dir.join(".ccode"), "工作区已清理，但 .ccode ")?;
    }
    remove_project_at(conn, &dir)?;
    let (cleaned, warn) = cleanup_project_db_traces(conn, &dir, &task_ids);
    let mut parts: Vec<String> = Vec::new();
    if !deleted.is_empty() {
        parts.push(format!("{} 个工作区", deleted.len()));
    }
    if has_ccode {
        parts.push("档案卡与简报（回收站）".to_string());
    }
    if registered {
        parts.push("注册记录".to_string());
    }
    // 只在真清掉行时才提：没勾过任何事项的项目提这句纯属噪音
    if cleaned > 0 {
        parts.push("勾选与归卡记录".to_string());
    }
    Ok(format!(
        "已清除：{}{}",
        parts.join("、"),
        warn.first().map(|w| format!("；{w}")).unwrap_or_default()
    ))
}

// ===== 档案卡 .ccode/project.toml =====

fn config_path(project: &Path) -> PathBuf {
    project.join(".ccode").join("project.toml")
}

/// 档案卡文件头。Git 客户端把未跟踪的 `.ccode/` 当普通改动，丢弃后
/// `work_mode` 丢失，已添加项目按科研重分类。写入时缺则补、已有不重复。
const PROJECT_TOML_HEADER: &str = "\
# Mesa 项目档案卡（工作方式 / 研究流程 / 资源清单）。\n\
# 删掉此文件后，已添加的项目会按「科研」重新分类。请勿在 Git 客户端里丢弃未跟踪的 .ccode/。\n";

fn with_project_toml_header(text: String) -> String {
    if text.contains("Mesa 项目档案卡") || text.contains("Ccode 项目档案卡") {
        return text;
    }
    if text.is_empty() {
        return PROJECT_TOML_HEADER.to_string();
    }
    let rest = text.trim_start_matches('\n');
    format!("{PROJECT_TOML_HEADER}\n{rest}")
}

/// 档案卡读取预算（聚合路径用）。健康文件系统上是亚毫秒级，这个值只管
/// 「无响应」那一档；共享总预算，所以项目数再多也只等这么久。
const CARD_READ_BUDGET: Duration = Duration::from_secs(2);

/// 批量读档案卡，总时长受 `CARD_READ_BUDGET` 约束，返回与入参同序。
///
/// 为什么不像以前那样逐个 `fs::read_to_string`：注册项目可能落在无响应的文件系统上
/// （云同步未落地、网络盘断连），`open()` 会在内核里阻塞，一个坏路径就能把
/// 项目列表 / 引用检查 / PDF 预览整个挂死。这里改用有界读取——超时就跳过该项目，
/// 并把路径记进 `storage` 的卡住表，后续调用直接返回不再新建线程（细节见 storage.rs）。
///
/// 跳过是**显性**的：首次判定卡住时记一条 warn（`StillStuck` 是重复观察，不再记，
/// 否则前端每 2s 轮询一次就把日志刷爆）。
fn cards_bounded(roots: &[PathBuf]) -> Vec<Option<String>> {
    let paths: Vec<PathBuf> = roots.iter().map(|r| config_path(r)).collect();
    crate::storage::read_many_within(&paths, CARD_READ_BUDGET)
        .into_iter()
        .zip(roots)
        .map(|(outcome, root)| {
            if matches!(outcome, crate::storage::BoundedRead::TimedOut) {
                crate::logbuf::record(
                    "warn",
                    "projects",
                    &format!(
                        "档案卡读取超时，本次跳过「{}」：路径所在文件系统无响应\
                         （云同步未落地或网络盘断连）。文件系统恢复后自动重新可读，无需手动操作",
                        root.display()
                    ),
                );
            }
            outcome.text().map(str::to_string)
        })
        .collect()
}

/// 从档案卡文本里取稳定项目 id（无 id 行 = None）。
fn project_id_in_text(text: &str) -> Option<String> {
    let value = text.parse::<toml::Value>().ok()?;
    value
        .get("id")?
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// 读档案卡里的稳定项目 id（无文件/无 id 行 = None）。
///
/// 单项目路径用这个（调用方正在操作那个项目，挂住是合理的——用户在等它）。
/// 遍历全部注册项目的**聚合**路径请走 `cards_bounded`，否则一个坏路径拖垮整批。
pub(crate) fn project_id_at(project: &Path) -> Option<String> {
    let text = fs::read_to_string(config_path(project)).ok()?;
    project_id_in_text(&text)
}

/// 读取或分配项目 id：分配即在档案卡顶部加 `id` 行（原子写，其余内容不动）。
pub(crate) fn ensure_project_id_at(project: &Path) -> Result<String, String> {
    if let Some(id) = project_id_at(project) {
        return Ok(id);
    }
    if !project.is_dir() {
        return Err("项目目录不存在，无法分配项目 id".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let path = config_path(project);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let mut doc = existing
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("project.toml 解析失败，无法写入项目 id: {e}"))?;
    doc["id"] = toml_edit::value(id.clone());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(&path, &with_project_toml_header(doc.to_string()))?;
    Ok(id)
}

// 解析模型：未知键忽略（前向兼容），风格同 ws_settings.rs
// 坏字段不整体失败：先解析成 toml::Value，再逐条 try_into，坏条目跳过并记 warning。

#[derive(Debug, Deserialize)]
struct TomlResource {
    name: String,
    path: String,
    #[serde(rename = "type", default = "default_resource_type")]
    kind: String,
    #[serde(default)]
    readonly: bool,
    #[serde(default)]
    note: String,
}

fn default_resource_type() -> String {
    "other".into()
}

#[derive(Debug, Deserialize)]
struct TomlStepRun {
    command: String,
    #[serde(default)]
    default: bool,
    #[serde(default)]
    command_windows: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TomlHumanTask {
    title: String,
    #[serde(default)]
    guidance: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    timing: String,
    #[serde(default)]
    optional: bool,
    #[serde(default)]
    completion: String,
    #[serde(default)]
    expected_count: Option<usize>,
    #[serde(default)]
    manifest_path: String,
}

#[derive(Debug, Deserialize)]
struct TomlStep {
    name: String,
    #[serde(default)]
    workspace_name: String,
    #[serde(default)]
    brief: String,
    #[serde(default)]
    expected_artifacts: Vec<String>,
    #[serde(default)]
    acceptance_criteria: Vec<String>,
    #[serde(default)]
    decision_mode: String,
    #[serde(default)]
    inputs: Vec<String>,
    #[serde(default)]
    optional_inputs: Vec<String>,
    #[serde(default)]
    any_of_inputs: Vec<Vec<String>>,
    #[serde(default)]
    skills: Vec<String>,
    /// None = 旧配置未声明，兼容为 skills 全部必需；Some([]) = 明确全部可选。
    #[serde(default)]
    required_skills: Option<Vec<String>>,
    #[serde(default)]
    run: BTreeMap<String, TomlStepRun>,
    #[serde(default)]
    human_tasks: Vec<TomlHumanTask>,
    #[serde(default)]
    discussion_seeds: Vec<String>,
    #[serde(default)]
    decisions: Vec<TomlDecision>,
    #[serde(default)]
    asks_lit_source: bool,
    #[serde(default)]
    seed_complete: bool,
    #[serde(default)]
    role: String,
}

#[derive(Debug, Deserialize)]
struct TomlDecision {
    #[serde(default)]
    q: String,
    #[serde(default)]
    options: Vec<String>,
}

/// 人工事项时机归一：before/during/after 之外一律按 during（并行），不阻断
fn normalize_human_timing(timing: &str) -> String {
    match timing.trim() {
        "before" | "after" | "during" => timing.trim().to_string(),
        _ => "during".into(),
    }
}

/// 人工事项完成判定归一：未知值按 exists 处理，保证旧 project.toml 可读。
pub(crate) fn normalize_human_completion(completion: &str) -> String {
    match completion.trim() {
        "manual" | "all" | "no_placeholders" | "decisions_cleared" => completion.trim().to_string(),
        _ => "exists".into(),
    }
}

fn normalize_resource_type(kind: &str) -> String {
    if RESOURCE_TYPES.contains(&kind) {
        kind.to_string()
    } else {
        "other".into()
    }
}

fn normalize_protected_paths(raw: &[String]) -> Vec<String> {
    let mut unique = Vec::new();
    for path in raw {
        let path = path.trim().replace('\\', "/");
        let path = path.trim_matches('/').to_string();
        if path.is_empty() || path == "." {
            continue;
        }
        if path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        {
            continue;
        }
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    unique.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
    let mut kept = Vec::new();
    for path in unique {
        if kept
            .iter()
            .any(|parent: &String| path == *parent || path.starts_with(&format!("{parent}/")))
        {
            continue;
        }
        kept.push(path);
    }
    kept
}

/// 保护路径命中判定：按文件系统默认语义折叠大小写（macOS 默认 APFS / Windows NTFS
/// 都大小写不敏感，仅改大小写的路径在盘上是同一个文件），防止 `raw/` 绕过 `RAW/` 保护。
pub(crate) fn path_is_protected(relative: &str, protected: &[String]) -> bool {
    let path = relative.replace('\\', "/");
    let path = path.trim_matches('/');
    if path.is_empty() {
        return false;
    }
    let key = crate::paths::path_key_folded(path);
    protected.iter().any(|item| {
        let parent = item.replace('\\', "/");
        let parent = parent.trim_matches('/');
        if parent.is_empty() {
            return false;
        }
        let parent = crate::paths::path_key_folded(parent);
        key == parent || key.starts_with(&format!("{parent}/"))
    })
}

fn parse_config(text: &str) -> (ProjectConfigDto, Vec<String>) {
    let mut warnings = Vec::new();
    let value: toml::Value = match toml::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            // 整份文件坏掉：回落空配置，错误进 warnings，不谎报「无配置」
            return (
                ProjectConfigDto::default(),
                vec![format!("project.toml 解析失败，已按空配置处理: {e}")],
            );
        }
    };
    let mut config = ProjectConfigDto::default();
    match value.get("topic") {
        None => {}
        // 空白字符串视为未填写，不告警
        Some(toml::Value::String(s)) => {
            let t = s.trim();
            if !t.is_empty() {
                config.topic = Some(t.to_string());
            }
        }
        Some(_) => warnings.push("topic 不是有效字符串，已忽略".to_string()),
    }
    // 全局设定：字符串数组，逐项去空白丢空（防御式，同 discussion_seeds 口径）
    match value.get("settings") {
        None => {}
        Some(toml::Value::Array(arr)) => {
            config.settings = arr
                .iter()
                .filter_map(|v| v.as_str())
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect();
        }
        Some(_) => warnings.push("settings 不是字符串数组，已忽略".to_string()),
    }
    match value.get("rules_owned") {
        None => {}
        Some(toml::Value::Boolean(b)) => config.rules_owned = *b,
        Some(_) => warnings.push("rules_owned 不是布尔值，已忽略".to_string()),
    }
    match value.get("protected_paths") {
        None => {}
        Some(toml::Value::Array(arr)) => {
            if arr.iter().any(|v| v.as_str().is_none()) {
                warnings.push("protected_paths 含非字符串项，已忽略这些项".to_string());
            }
            config.protected_paths = normalize_protected_paths(
                &arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>(),
            );
        }
        Some(_) => warnings.push("protected_paths 不是字符串数组，已忽略".to_string()),
    }
    match value.get("skills") {
        None => {}
        Some(toml::Value::Array(arr)) => {
            if arr.iter().any(|v| v.as_str().is_none()) {
                warnings.push("skills 含非字符串项，已忽略这些项".to_string());
            }
            let mut skills: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_str())
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect();
            skills.dedup();
            config.skills = skills;
        }
        Some(_) => warnings.push("skills 不是字符串数组，已忽略".to_string()),
    }
    // 对话注入：非法值告警并按 auto（现状行为），不阻断开对话
    match value.get("session_injection_mode") {
        None => {}
        Some(toml::Value::String(s)) if SESSION_INJECTION_MODES.contains(&s.trim()) => {
            config.session_injection_mode = Some(s.trim().to_string())
        }
        Some(toml::Value::String(s)) => warnings.push(format!(
            "session_injection_mode 取值无效（{s}），已按自动生成处理"
        )),
        Some(_) => warnings.push("session_injection_mode 不是字符串，已忽略".to_string()),
    }
    // 模板空白视为未填写（同 topic 口径，不告警）
    match value.get("session_injection_template") {
        None => {}
        Some(toml::Value::String(s)) if !s.trim().is_empty() => {
            config.session_injection_template = Some(s.clone())
        }
        Some(toml::Value::String(_)) => {}
        Some(_) => warnings.push("session_injection_template 不是字符串，已忽略".to_string()),
    }
    match value.get("artifact_dir") {
        None => {}
        Some(toml::Value::String(s)) if !s.trim().is_empty() => config.artifact_dir = s.clone(),
        Some(_) => warnings.push(format!(
            "artifact_dir 不是有效字符串，已使用默认值 {DEFAULT_ARTIFACT_DIR}"
        )),
    }
    // 「不使用研究流程」显式标记：非布尔容错忽略，缺省 false
    match value.get("pipeline_opt_out") {
        None => {}
        Some(toml::Value::Boolean(b)) => config.pipeline_opt_out = *b,
        Some(_) => warnings.push("pipeline_opt_out 不是布尔值，已忽略".to_string()),
    }
    match value.get("work_mode") {
        None => {}
        Some(toml::Value::String(s)) if WORK_MODES.contains(&s.trim()) => {
            config.work_mode = s.trim().to_string();
        }
        Some(toml::Value::String(s)) => {
            warnings.push(format!("work_mode 取值无效（{s}），已按 research 处理"));
            config.work_mode = "research".into();
        }
        Some(_) => warnings.push("work_mode 不是字符串，已忽略".to_string()),
    }
    // 文献来源：非法值归一为 search（同 resource type 口径，坏字段不阻断整份解析）
    match value.get("lit_source") {
        None => {}
        Some(toml::Value::String(s)) if LIT_SOURCES.contains(&s.trim()) => {
            config.lit_source = s.trim().to_string()
        }
        Some(toml::Value::String(s)) => {
            warnings.push(format!("lit_source 取值无效（{s}），已按 search 处理"))
        }
        Some(_) => warnings.push("lit_source 不是字符串，已忽略".to_string()),
    }
    // 投稿/返修分支：结构化保存，非法值不阻断旧档案卡读取。
    match value.get("submission_mode") {
        None => {}
        Some(toml::Value::String(s)) if SUBMISSION_MODES.contains(&s.trim()) => {
            config.submission_mode = Some(s.trim().to_string());
        }
        Some(toml::Value::String(s)) => {
            warnings.push(format!("submission_mode 取值无效（{s}），已忽略"))
        }
        Some(_) => warnings.push("submission_mode 不是字符串，已忽略".to_string()),
    }
    match value.get("submission_round") {
        None => {}
        Some(toml::Value::Integer(n)) if *n >= 1 && *n <= u32::MAX as i64 => {
            config.submission_round = Some(*n as u32);
        }
        Some(_) => warnings.push("submission_round 必须是大于等于 1 的整数，已忽略".to_string()),
    }
    if let Some(resources) = value.get("resources").and_then(|v| v.as_array()) {
        for (i, item) in resources.iter().enumerate() {
            match item.clone().try_into::<TomlResource>() {
                Ok(r) => {
                    let kind = normalize_resource_type(&r.kind);
                    if kind != r.kind {
                        warnings.push(format!(
                            "resources[{i}]（{}）的 type「{}」无法识别，已归为 other",
                            r.name, r.kind
                        ));
                    }
                    config.resources.push(ResourceDto {
                        name: r.name,
                        path: r.path,
                        kind,
                        readonly: r.readonly,
                        note: r.note,
                    });
                }
                Err(e) => warnings.push(format!("resources[{i}] 字段无效，已跳过: {e}")),
            }
        }
    } else if value.get("resources").is_some() {
        warnings.push("resources 不是表数组，已忽略".to_string());
    }
    if let Some(steps) = value.get("steps").and_then(|v| v.as_array()) {
        for (i, item) in steps.iter().enumerate() {
            match item.clone().try_into::<TomlStep>() {
                Ok(s) => {
                    // resources 不进 TomlStep 由 serde 解析：非数组/非字符串项要逐条容错跳过，
                    // 避免一个坏绑定拖垮整个步骤（风格同其他字段的 warning 文案）
                    let mut bound = Vec::new();
                    match item.get("resources") {
                        None => {}
                        Some(toml::Value::Array(arr)) => {
                            for (j, v) in arr.iter().enumerate() {
                                match v.as_str() {
                                    Some(p) if !p.trim().is_empty() => bound.push(p.to_string()),
                                    _ => warnings.push(format!(
                                        "steps[{i}] 的 resources[{j}] 不是有效字符串，已跳过"
                                    )),
                                }
                            }
                        }
                        Some(_) => {
                            warnings.push(format!("steps[{i}] 的 resources 不是数组，已忽略"))
                        }
                    }
                    // 人工事项：title 空白整条跳过；timing 非法值归一 warning（不拖垮步骤）
                    let mut human_tasks = Vec::new();
                    for (j, h) in s.human_tasks.into_iter().enumerate() {
                        let title = h.title.trim().to_string();
                        if title.is_empty() {
                            warnings
                                .push(format!("steps[{i}] 的 human_tasks[{j}] 标题为空，已跳过"));
                            continue;
                        }
                        let timing = normalize_human_timing(&h.timing);
                        if !h.timing.trim().is_empty() && timing != h.timing.trim() {
                            warnings.push(format!(
                                "steps[{i}] 的人工事项「{title}」时机「{}」无法识别，已按 during 处理",
                                h.timing.trim()
                            ));
                        }
                        let completion = if h.target.trim().is_empty() {
                            "manual".to_string()
                        } else {
                            normalize_human_completion(&h.completion)
                        };
                        if !h.completion.trim().is_empty() && completion != h.completion.trim() {
                            warnings.push(format!(
                                "步骤[{i}] 的人工事项「{title}」完成判定「{}」无法识别，已按 exists 处理",
                                h.completion.trim()
                            ));
                        }
                        human_tasks.push(HumanTaskDto {
                            title,
                            guidance: h.guidance.trim().to_string(),
                            target: h.target.trim().to_string(),
                            timing,
                            optional: h.optional,
                            completion,
                            expected_count: h.expected_count,
                            manifest_path: h.manifest_path.trim().to_string(),
                        });
                    }
                    let step_skills = s.skills;
                    let required_skills = s.required_skills;
                    config.steps.push(StepDto {
                        name: s.name,
                        workspace_name: s.workspace_name,
                        brief: s.brief,
                        expected_artifacts: s.expected_artifacts,
                        acceptance_criteria: s
                            .acceptance_criteria
                            .into_iter()
                            .map(|x| x.trim().to_string())
                            .filter(|x| !x.is_empty())
                            .collect(),
                        decision_mode: match s.decision_mode.trim() {
                            "soft_pause" | "hard_pause" => s.decision_mode.trim().to_string(),
                            _ => "auto_continue".into(),
                        },
                        inputs: s
                            .inputs
                            .into_iter()
                            .map(|x| x.trim().to_string())
                            .filter(|x| !x.is_empty())
                            .collect(),
                        optional_inputs: s
                            .optional_inputs
                            .into_iter()
                            .map(|x| x.trim().to_string())
                            .filter(|x| !x.is_empty())
                            .collect(),
                        any_of_inputs: s
                            .any_of_inputs
                            .into_iter()
                            .map(|group| {
                                group
                                    .into_iter()
                                    .map(|x| x.trim().to_string())
                                    .filter(|x| !x.is_empty())
                                    .collect::<Vec<_>>()
                            })
                            .filter(|group| !group.is_empty())
                            .collect(),
                        skills: step_skills.clone(),
                        required_skills: required_skills
                            .map(|skills| {
                                skills
                                    .into_iter()
                                    .map(|x| x.trim().to_string())
                                    .filter(|x| !x.is_empty())
                                    .collect()
                            })
                            .unwrap_or(step_skills),
                        resources: bound,
                        run: s
                            .run
                            .into_iter()
                            .map(|(name, r)| StepRunDto {
                                name,
                                command: r.command,
                                is_default: r.default,
                                command_windows: r
                                    .command_windows
                                    .filter(|c| !c.trim().is_empty()),
                            })
                            .collect(),
                        human_tasks,
                        discussion_seeds: s
                            .discussion_seeds
                            .into_iter()
                            .map(|d| d.trim().to_string())
                            .filter(|d| !d.is_empty())
                            .collect(),
                        // 空选项是需人工填写的依据；不能在持久化后静默删除硬暂停条件。
                        decisions: s
                            .decisions
                            .into_iter()
                            .map(|d| DecisionDto {
                                q: d.q.trim().to_string(),
                                options: d
                                    .options
                                    .into_iter()
                                    .map(|o| o.trim().to_string())
                                    .filter(|o| !o.is_empty())
                                    .collect(),
                            })
                            .filter(|d| !d.q.is_empty())
                            .collect(),
                        asks_lit_source: s.asks_lit_source,
                        seed_complete: s.seed_complete,
                        role: match s.role.trim() {
                            "you" => "you".to_string(),
                            "both" => "both".to_string(),
                            _ => "ai".to_string(),
                        },
                    });
                }
                Err(e) => warnings.push(format!("steps[{i}] 字段无效，已跳过: {e}")),
            }
        }
    } else if value.get("steps").is_some() {
        warnings.push("steps 不是表数组，已忽略".to_string());
    }
    // 雷达筛选。整份反序列化走的是上面的逐项读取，不读这一段时保存后再打开是空的。
    match value.get("litWatchFilter").or_else(|| value.get("lit_watch_filter")) {
        None => {}
        Some(toml::Value::Table(table)) => {
            let mut filter = LitWatchFilterDto::default();
            match table.get("minIf").or_else(|| table.get("min_if")) {
                None => {}
                Some(toml::Value::Float(n)) if *n >= 0.0 => filter.min_if = Some(*n),
                Some(toml::Value::Integer(n)) if *n >= 0 => filter.min_if = Some(*n as f64),
                Some(_) => warnings.push("litWatchFilter.minIf 不是非负数字，已忽略".into()),
            }
            match table
                .get("maxCasQuartile")
                .or_else(|| table.get("max_cas_quartile"))
            {
                None => {}
                Some(toml::Value::Integer(n)) if (1..=4).contains(n) => {
                    filter.max_cas_quartile = Some(*n as u8);
                }
                Some(_) => {
                    warnings.push("litWatchFilter.maxCasQuartile 要是 1 到 4，已忽略".into())
                }
            }
            match table.get("topOnly").or_else(|| table.get("top_only")) {
                None => {}
                Some(toml::Value::Boolean(b)) => filter.top_only = *b,
                Some(_) => warnings.push("litWatchFilter.topOnly 不是布尔值，已忽略".into()),
            }
            if !filter.is_inert() {
                config.lit_watch_filter = Some(filter);
            }
        }
        Some(_) => warnings.push("litWatchFilter 不是表，已忽略".into()),
    }
    // 语义级校验（绑定资源、结构化输入、简报产物引用）并入 warnings，read_project_config 自动产出
    // prior_artifacts 按步骤顺序累计：简报引用上游产物 = 合法输入，不报（见 validate_step ②）
    let mut prior_artifacts: Vec<String> = Vec::new();
    for (index, step) in config.steps.iter().enumerate() {
        warnings.extend(validate_step(
            step,
            &config.resources,
            &prior_artifacts,
            index == 0,
        ));
        prior_artifacts.extend(step.expected_artifacts.iter().cloned());
    }
    (config, warnings)
}

// ===== 步骤资源绑定的轻量校验（纯函数，供 read 流程与后续 command 复用） =====

/// brief 里约定俗成的产物路径引用：引用了但 expectedArtifacts 没有对应项时提示
const BRIEF_ARTIFACT_REFS: [&str; 5] = [
    "papers/",
    "notes/",
    "references.bib",
    "outline.md",
    "manuscript/",
];

/// 校验单个步骤，返回中文提示文案（不做翻译层）：
/// ① 绑定值必须在 [[resources]] 的 path 里精确存在；空数组 = 不绑定，不触发；
/// ② inputs 中的路径必须由上游产物或项目资源覆盖；
/// ③ brief 引用了约定产物路径，但本步产物、上游、登记资源和已声明输入都查无对应项时提示。
pub(crate) fn validate_step(
    step: &StepDto,
    resources: &[ResourceDto],
    prior_artifacts: &[String],
    is_first_step: bool,
) -> Vec<String> {
    let mut warnings = Vec::new();
    fn glob_match(pattern: &str, value: &str) -> bool {
        let p: Vec<char> = pattern.chars().collect();
        let v: Vec<char> = value.chars().collect();
        let (mut pi, mut vi) = (0usize, 0usize);
        let (mut star, mut retry) = (None, None);
        while vi < v.len() {
            if pi < p.len() && p[pi] == v[vi] {
                pi += 1;
                vi += 1;
            } else if pi < p.len() && p[pi] == '*' {
                star = Some(pi);
                retry = Some(vi);
                pi += 1;
            } else if let (Some(star), Some(retry_at)) = (star, retry) {
                pi = star + 1;
                vi = retry_at + 1;
                retry = Some(vi);
            } else {
                return false;
            }
        }
        while pi < p.len() && p[pi] == '*' {
            pi += 1;
        }
        pi == p.len()
    }
    let path_match = |candidate: &str, pattern: &str| {
        let candidate = candidate.trim().replace('\\', "/");
        let pattern = pattern.trim().replace('\\', "/");
        if candidate.is_empty() || pattern.is_empty() {
            return false;
        }
        let pattern_is_dir = pattern.ends_with('/');
        let candidate = candidate.trim_end_matches('/');
        let pattern = pattern.trim_end_matches('/');
        glob_match(pattern, candidate)
            || (pattern_is_dir
                && (candidate == pattern || candidate.starts_with(&format!("{pattern}/"))))
    };
    for bound in &step.resources {
        if !resources.iter().any(|r| r.path == *bound) {
            warnings.push(format!("步骤「{}」绑定的资源不存在：{bound}", step.name));
        }
    }
    let covered_by_known = |input: &str| {
        prior_artifacts
            .iter()
            .any(|e| path_match(e, input) || path_match(input, e))
            || resources
                .iter()
                .any(|r| path_match(&r.path, input) || path_match(input, &r.path))
    };
    for input in &step.inputs {
        // 第一步的输入允许来自模板外部（上游项目、用户资源或尚未登记的主仓文件）。
        // 没有上游步骤时给出“输入不存在”只会制造不可行动的噪声；从第二步起再严格检查链路。
        if !is_first_step && !covered_by_known(input) {
            warnings.push(format!(
                "步骤「{}」声明的输入不存在上游产物或项目资源：{input}",
                step.name
            ));
        }
    }
    for group in &step.any_of_inputs {
        if !is_first_step && !group.iter().any(|input| covered_by_known(input)) {
            warnings.push(format!(
                "步骤「{}」的任一输入组未接到上游产物或项目资源：{}",
                step.name,
                group.join(" 或 ")
            ));
        }
    }
    for token in BRIEF_ARTIFACT_REFS {
        if !step.brief.contains(token) {
            continue;
        }
        let covered = |e: &String| path_match(e, token) || path_match(token, e);
        let own = step.expected_artifacts.iter().any(covered);
        let upstream = prior_artifacts.iter().any(covered);
        let resourced = resources.iter().any(|r| covered(&r.path));
        let declared = step
            .inputs
            .iter()
            .chain(step.optional_inputs.iter())
            .any(covered);
        if !(own || upstream || resourced || declared) {
            warnings.push(format!(
                "步骤「{}」的简报引用了「{token}」，但 expectedArtifacts 未包含对应产物",
                step.name
            ));
        }
    }
    warnings
}

pub(crate) fn read_config_at(project: &Path) -> ProjectConfigReadDto {
    let path = config_path(project);
    if !path.exists() {
        return ProjectConfigReadDto {
            config: ProjectConfigDto::default(),
            warnings: Vec::new(),
        };
    }
    match fs::read_to_string(&path) {
        Ok(text) => {
            let (config, warnings) = parse_config(&text);
            ProjectConfigReadDto { config, warnings }
        }
        Err(e) => ProjectConfigReadDto {
            config: ProjectConfigDto::default(),
            warnings: vec![format!("读取 project.toml 失败，已按空配置处理: {e}")],
        },
    }
}

/// 验收写回/验收合并专用的保护路径读取（fail-closed）：`read_config_at` 的容错口径
/// 是「坏字段进 warnings、按空配置继续展示」，但写回主仓前不能按「没有保护」继续——
/// project.toml 存在却读不出/解析失败、或 protected_paths 键类型不对（含数组里混
/// 非字符串项）时，保护清单不可信，必须拒绝本次写回，由用户先修复档案卡。
pub(crate) fn protected_paths_at(project: &Path) -> Result<Vec<String>, String> {
    let path = config_path(project);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("读取 project.toml 失败，无法确认保护路径，已拒绝本次写回: {e}"))?;
    let value: toml::Value = toml::from_str(&text)
        .map_err(|e| format!("project.toml 解析失败，无法确认保护路径，已拒绝本次写回: {e}"))?;
    match value.get("protected_paths") {
        None => Ok(Vec::new()),
        Some(toml::Value::Array(arr)) => {
            let mut raw = Vec::with_capacity(arr.len());
            for item in arr {
                match item.as_str() {
                    Some(s) => raw.push(s.to_string()),
                    None => {
                        return Err(
                            "protected_paths 含非字符串项，无法确认保护路径，已拒绝本次写回".into(),
                        )
                    }
                }
            }
            Ok(normalize_protected_paths(&raw))
        }
        Some(_) => Err("protected_paths 不是字符串数组，无法确认保护路径，已拒绝本次写回".into()),
    }
}

/// RX3a 对话步骤化：workspace_name → 步骤名映射（会话列表按步骤标注/搜索/分组用）。
/// 读不到配置返回空映射，与 read_project_config 的容错风格一致（宁缺勿阻断）。
pub(crate) fn step_names_at(project: &Path) -> std::collections::HashMap<String, String> {
    read_config_at(project)
        .config
        .steps
        .into_iter()
        .filter(|s| !s.workspace_name.is_empty())
        .map(|s| (s.workspace_name, s.name))
        .collect()
}

/// 生成写入文本：以现有文件为底用 toml_edit 打补丁（同 global_config.rs 的 TOML 补丁风格），
/// 只全量替换 topic/artifact_dir/resources/steps 四个已知部分，其余未知键、注释、格式原样保留。
/// 现有文件无法解析时停止写入并报错，宁可让用户手工修复也不覆盖未知内容。
fn render_config(existing: Option<&str>, config: &ProjectConfigDto) -> Result<String, String> {
    use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};
    let mut doc = existing
        .unwrap_or("")
        .parse::<DocumentMut>()
        .map_err(|e| format!("现有 project.toml 解析失败，已停止写入: {e}"))?;
    match config.topic.as_deref().map(str::trim) {
        Some(topic) if !topic.is_empty() => {
            doc["topic"] = value(topic);
        }
        // 空 topic 视为清除：移除已有行，不写空字符串
        _ => {
            doc.remove("topic");
        }
    }
    // 全局设定：同 topic 口径，空则清除
    let settings: Vec<&str> = config
        .settings
        .iter()
        .map(|x| x.trim())
        .filter(|x| !x.is_empty())
        .collect();
    if settings.is_empty() {
        doc.remove("settings");
    } else {
        let mut arr = toml_edit::Array::new();
        for x in &settings {
            arr.push(*x);
        }
        doc["settings"] = value(arr);
    }
    if config.rules_owned {
        doc["rules_owned"] = value(true);
    } else {
        doc.remove("rules_owned");
    }
    let protected_paths = normalize_protected_paths(&config.protected_paths);
    if protected_paths.is_empty() {
        doc.remove("protected_paths");
    } else {
        let mut arr = toml_edit::Array::new();
        for path in &protected_paths {
            arr.push(path.as_str());
        }
        doc["protected_paths"] = value(arr);
    }
    // skills 空 = 不写行（同 protected_paths 口径）
    if config.skills.is_empty() {
        doc.remove("skills");
    } else {
        let mut arr = toml_edit::Array::new();
        for skill in &config.skills {
            arr.push(skill.as_str());
        }
        doc["skills"] = value(arr);
    }
    // 对话注入：auto 是缺省不写行（同 pipeline_opt_out 口径）；
    // 模板非空就写、不随 mode 清（切到 off/auto 保留草稿，切回来不丢）
    match config
        .session_injection_mode
        .as_deref()
        .map(str::trim)
        .filter(|mode| SESSION_INJECTION_MODES.contains(mode) && *mode != "auto")
    {
        Some(mode) => {
            doc["session_injection_mode"] = value(mode);
        }
        None => {
            doc.remove("session_injection_mode");
        }
    }
    match config
        .session_injection_template
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        Some(text) => {
            doc["session_injection_template"] = value(text);
        }
        None => {
            doc.remove("session_injection_template");
        }
    }
    let artifact_dir = if config.artifact_dir.trim().is_empty() {
        DEFAULT_ARTIFACT_DIR
    } else {
        config.artifact_dir.trim()
    };
    doc["artifact_dir"] = value(artifact_dir);
    // false 是缺省：清回 false 时移除该行，保持档案卡简洁（同 topic 清除口径）
    if config.pipeline_opt_out {
        doc["pipeline_opt_out"] = value(true);
    } else {
        doc.remove("pipeline_opt_out");
    }
    let work_mode = normalize_work_mode(&config.work_mode);
    if work_mode != "research" {
        doc["work_mode"] = value(work_mode);
    } else {
        doc.remove("work_mode");
    }
    if config.lit_source != "search" {
        doc["lit_source"] = value(config.lit_source.as_str());
    } else {
        doc.remove("lit_source");
    }
    match config.submission_mode.as_deref() {
        Some(mode) if SUBMISSION_MODES.contains(&mode) => {
            doc["submission_mode"] = value(mode);
        }
        _ => {
            doc.remove("submission_mode");
        }
    }
    match config.submission_round {
        Some(round) if round >= 1 => {
            doc["submission_round"] = value(round as i64);
        }
        _ => {
            doc.remove("submission_round");
        }
    }
    // 全空 = 不筛选，清掉已有段。漏写这一段时，保存筛选会在下一次整卡重写里消失，
    // 弹层再打开是空的，列表也不会变。
    match config.lit_watch_filter.as_ref().filter(|f| !f.is_inert()) {
        Some(filter) => {
            let mut t = Table::new();
            if let Some(min_if) = filter.min_if {
                t["minIf"] = value(min_if);
            }
            if let Some(max_q) = filter.max_cas_quartile {
                t["maxCasQuartile"] = value(max_q as i64);
            }
            if filter.top_only {
                t["topOnly"] = value(true);
            }
            doc["litWatchFilter"] = Item::Table(t);
        }
        None => {
            doc.remove("litWatchFilter");
        }
    }
    if config.resources.is_empty() {
        doc.remove("resources");
    } else {
        let mut arr = ArrayOfTables::new();
        for r in &config.resources {
            let mut t = Table::new();
            t["name"] = value(&r.name);
            t["path"] = value(&r.path);
            t["type"] = value(normalize_resource_type(&r.kind));
            if r.readonly {
                t["readonly"] = value(true);
            }
            if !r.note.is_empty() {
                t["note"] = value(&r.note);
            }
            arr.push(t);
        }
        doc["resources"] = Item::ArrayOfTables(arr);
    }
    if config.steps.is_empty() {
        doc.remove("steps");
    } else {
        let mut arr = ArrayOfTables::new();
        for s in &config.steps {
            let mut t = Table::new();
            t["name"] = value(&s.name);
            if !s.workspace_name.is_empty() {
                t["workspace_name"] = value(&s.workspace_name);
            }
            if !s.brief.is_empty() {
                t["brief"] = value(&s.brief);
            }
            if !s.expected_artifacts.is_empty() {
                let mut artifacts = toml_edit::Array::new();
                for a in &s.expected_artifacts {
                    artifacts.push(a.as_str());
                }
                t["expected_artifacts"] = value(artifacts);
            }
            if !s.acceptance_criteria.is_empty() {
                let mut criteria = toml_edit::Array::new();
                for criterion in &s.acceptance_criteria {
                    criteria.push(criterion.as_str());
                }
                t["acceptance_criteria"] = value(criteria);
            }
            if s.decision_mode != "auto_continue" {
                t["decision_mode"] = value(&s.decision_mode);
            }
            if !s.inputs.is_empty() {
                let mut inputs = toml_edit::Array::new();
                for input in &s.inputs {
                    inputs.push(input.as_str());
                }
                t["inputs"] = value(inputs);
            }
            if !s.optional_inputs.is_empty() {
                let mut inputs = toml_edit::Array::new();
                for input in &s.optional_inputs {
                    inputs.push(input.as_str());
                }
                t["optional_inputs"] = value(inputs);
            }
            if !s.any_of_inputs.is_empty() {
                let mut groups = toml_edit::Array::new();
                for group in &s.any_of_inputs {
                    let mut values = toml_edit::Array::new();
                    for input in group {
                        values.push(input.as_str());
                    }
                    groups.push(values);
                }
                t["any_of_inputs"] = value(groups);
            }
            if !s.skills.is_empty() {
                let mut skills = toml_edit::Array::new();
                for k in &s.skills {
                    skills.push(k.as_str());
                }
                t["skills"] = value(skills);
            }
            if !s.required_skills.is_empty() || !s.skills.is_empty() {
                let mut required = toml_edit::Array::new();
                for skill in &s.required_skills {
                    required.push(skill.as_str());
                }
                t["required_skills"] = value(required);
            }
            // 空数组省略不写：空 = 不绑定 = 全部资源，与省略同语义，档案卡更简洁
            if !s.resources.is_empty() {
                let mut resources = toml_edit::Array::new();
                for r in &s.resources {
                    resources.push(r.as_str());
                }
                t["resources"] = value(resources);
            }
            if !s.run.is_empty() {
                let mut run = Table::new();
                for r in &s.run {
                    let mut entry = Table::new();
                    entry["command"] = value(&r.command);
                    if r.is_default {
                        entry["default"] = value(true);
                    }
                    if let Some(win) = r.command_windows.as_deref().filter(|c| !c.trim().is_empty()) {
                        entry["command_windows"] = value(win);
                    }
                    run[&r.name] = Item::Table(entry);
                }
                t["run"] = Item::Table(run);
            }
            // 人工事项：空数组省略不写；timing 为默认 during 时省略该键，档案卡更简洁
            if !s.human_tasks.is_empty() {
                let mut hts = ArrayOfTables::new();
                for h in &s.human_tasks {
                    let mut ht = Table::new();
                    ht["title"] = value(&h.title);
                    if !h.guidance.is_empty() {
                        ht["guidance"] = value(&h.guidance);
                    }
                    if !h.target.is_empty() {
                        ht["target"] = value(&h.target);
                    }
                    if h.timing != "during" {
                        ht["timing"] = value(&h.timing);
                    }
                    // 默认值（必办）省略不写，同 timing 口径
                    if h.optional {
                        ht["optional"] = value(true);
                    }
                    if h.completion != "exists" && !h.completion.is_empty() {
                        ht["completion"] = value(h.completion.as_str());
                    }
                    if let Some(expected) = h.expected_count {
                        ht["expected_count"] = value(expected as i64);
                    }
                    if !h.manifest_path.trim().is_empty() {
                        ht["manifest_path"] = value(h.manifest_path.trim());
                    }
                    hts.push(ht);
                }
                t["human_tasks"] = Item::ArrayOfTables(hts);
            }
            // 讨论种子：空数组省略不写（同 skills 口径）
            if !s.discussion_seeds.is_empty() {
                let mut seeds = toml_edit::Array::new();
                for d in &s.discussion_seeds {
                    seeds.push(d.as_str());
                }
                t["discussion_seeds"] = value(seeds);
            }
            // 决策项：空数组省略；options 可为空，表示必须手写依据而非选择推荐值。
            if !s.decisions.is_empty() {
                let mut ds = ArrayOfTables::new();
                for d in &s.decisions {
                    let mut dt = Table::new();
                    dt["q"] = value(&d.q);
                    let mut opts = toml_edit::Array::new();
                    for o in &d.options {
                        opts.push(o.as_str());
                    }
                    dt["options"] = value(opts);
                    ds.push(dt);
                }
                t["decisions"] = Item::ArrayOfTables(ds);
            }
            // 缺省 false 时不写这一行（同 pipeline_opt_out 的清除口径，档案卡保持简洁）
            if s.asks_lit_source {
                t["asks_lit_source"] = value(true);
            }
            if s.seed_complete {
                t["seed_complete"] = value(true);
            }
            if s.role != "ai" && !s.role.is_empty() {
                t["role"] = value(s.role.as_str());
            }
            arr.push(t);
        }
        doc["steps"] = Item::ArrayOfTables(arr);
    }
    Ok(with_project_toml_header(doc.to_string()))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AcceptedGoalStatusDto {
    pub name: String,
    pub outputs: Vec<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectStatusDto {
    pub accepted: Vec<AcceptedGoalStatusDto>,
}

fn project_status_path(root: &Path) -> PathBuf {
    root.join(".ccode").join("project-status.json")
}

pub(crate) fn read_project_status_at(root: &Path) -> ProjectStatusDto {
    let path = project_status_path(root);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return ProjectStatusDto::default(),
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub(crate) fn record_accepted_goal_at(
    root: &Path,
    name: &str,
    outputs: &[String],
    note: &str,
) -> Result<(), String> {
    let mut status = read_project_status_at(root);
    let name = name.trim();
    if name.is_empty() {
        return Ok(());
    }
    status.accepted.retain(|item| item.name != name);
    status.accepted.insert(
        0,
        AcceptedGoalStatusDto {
            name: name.to_string(),
            outputs: outputs
                .iter()
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty() && item != ".")
                .collect(),
            note: note.trim().to_string(),
        },
    );
    status.accepted.truncate(20);
    let dir = root.join(".ccode");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    let text = serde_json::to_string_pretty(&status).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(&project_status_path(root), &text)
}

/// 长期接受账本（`.ccode/acceptance-log.jsonl`，append-only JSONL）：
/// project-status.json 是按目标名替换、最多 20 条的「最近摘要」，会轮换、曾被目标删除连带清掉；
/// 账本回答「这份文件是哪次验收写进来的」——目标删除、摘要轮换都不动它。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContentFingerprint {
    pub path: String,
    pub size: u64,
    #[serde(default)]
    pub sha256: Option<String>,
}

fn default_kind_goal_adopt() -> String {
    "goal_adopt".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceLogEntry {
    pub goal_id: String,
    pub goal_name: String,
    pub run_id: String,
    pub paths: Vec<String>,
    pub note: String,
    /// true = 采纳的是冻结快照（review-freeze），false = 旧路径目录现读。
    pub frozen: bool,
    pub decided_at: String,
    #[serde(default = "default_kind_goal_adopt")]
    pub kind: String,
    #[serde(default)]
    pub version_id: String,
    #[serde(default)]
    pub reviewed_sha: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub scene_ref: Option<String>,
    #[serde(default)]
    pub content_fingerprints: Vec<ContentFingerprint>,
}

impl Default for AcceptanceLogEntry {
    fn default() -> Self {
        Self {
            goal_id: String::new(),
            goal_name: String::new(),
            run_id: String::new(),
            paths: Vec::new(),
            note: String::new(),
            frozen: false,
            decided_at: String::new(),
            kind: default_kind_goal_adopt(),
            version_id: String::new(),
            reviewed_sha: None,
            project_id: None,
            scene_ref: None,
            content_fingerprints: Vec::new(),
        }
    }
}

pub(crate) fn acceptance_log_path(root: &Path) -> PathBuf {
    root.join(".ccode").join("acceptance-log.jsonl")
}

// ===== 项目长期知识（memory.md，审计 §8 Memory Proposal 的最小闭环） =====
// 只进人确认过的内容：验收时人勾选「沉淀」才把意见写进来；Agent 自称的结论不进。
// 上下文包注入这份文件 = 已确认知识；未确认的讨论留在会话里。

pub(crate) fn memory_path(root: &Path) -> PathBuf {
    root.join(".ccode").join("memory.md")
}

#[cfg(test)]
pub(crate) fn read_memory_at(root: &Path) -> String {
    crate::project_memory::read_raw(root).unwrap()
}

pub(crate) fn append_project_memory_at(
    root: &Path,
    goal_name: &str,
    text: &str,
    run_id: Option<&str>,
) -> Result<(), String> {
    crate::project_memory::append_confirmed(root, goal_name, text, run_id)
}

#[tauri::command]
pub async fn read_project_memory(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(crate::sessions::expand_tilde(&path));
        crate::project_memory::context_at(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn read_acceptance_log(path: String) -> Result<Vec<AcceptanceLogEntry>, String> {
    let root = PathBuf::from(crate::sessions::expand_tilde(&path));
    Ok(read_acceptance_log_at(&root))
}

pub(crate) fn read_acceptance_log_at(root: &Path) -> Vec<AcceptanceLogEntry> {
    let Ok(text) = fs::read_to_string(acceptance_log_path(root)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<AcceptanceLogEntry>(line) {
            Ok(entry) => out.push(entry),
            Err(error) => {
                crate::logbuf::record(
                    "warn",
                    "projects",
                    &format!("验收账本第 {} 行无法解析，已跳过：{error}", index + 1),
                );
            }
        }
    }
    out
}

fn fact_already_recorded(existed: &[AcceptanceLogEntry], entry: &AcceptanceLogEntry) -> bool {
    let kind = if entry.kind.is_empty() {
        "goal_adopt"
    } else {
        entry.kind.as_str()
    };
    existed.iter().any(|item| {
        let item_kind = if item.kind.is_empty() {
            "goal_adopt"
        } else {
            item.kind.as_str()
        };
        match kind {
            "watch_adopt" => item_kind == "watch_adopt" && item.run_id == entry.run_id,
            "pipeline_merge" | "coding_merge" => {
                item_kind == kind
                    && item.version_id == entry.version_id
                    && !entry.version_id.is_empty()
            }
            _ => {
                let mut old_paths = item.paths.clone();
                let mut new_paths = entry.paths.clone();
                old_paths.sort();
                new_paths.sort();
                item_kind == kind
                    && item.run_id == entry.run_id
                    && item.goal_id == entry.goal_id
                    && item.version_id == entry.version_id
                    && old_paths == new_paths
                    && item.note == entry.note
            }
        }
    })
}

/// 追加一条接受记录；去重键按 kind 分化（见 review_contract）。
/// 调用方应经 `review_contract::commit_fact` 持项目锁。
pub(crate) fn append_acceptance_log_at(
    root: &Path,
    entry: &AcceptanceLogEntry,
) -> Result<(), String> {
    use std::io::Write;
    // 上次进程可能在 JSONL 一行写到一半时退出；保留原字节但必须隔开尾行，不能把新事实接进坏 JSON。
    let previous = match fs::read(acceptance_log_path(root)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("读取原接受记录失败，未追加：{e}")),
    };
    let existed = read_acceptance_log_at(root);
    if fact_already_recorded(&existed, entry) {
        return Ok(());
    }
    let dir = root.join(".ccode");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    let mut line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    line.push('\n');
    if !previous.is_empty() && !previous.ends_with(b"\n") {
        line.insert(0, '\n');
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(acceptance_log_path(root))
        .map_err(|e| format!("打开接受记录失败: {e}"))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("写入接受记录失败: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("落盘接受记录失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn read_project_status(path: String) -> Result<ProjectStatusDto, String> {
    let root = PathBuf::from(crate::sessions::expand_tilde(&path));
    // 项目打开时回放流程期间暂缓的 PDF 资源登记（幂等 best-effort）
    crate::lit_watch::replay_pending_registrations(&root);
    Ok(read_project_status_at(&root))
}

static PROJECT_CONFIG_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) struct ProjectConfigGuard {
    _process: std::sync::MutexGuard<'static, ()>,
    _file: fs::File,
}

pub(crate) fn project_config_lock(root: &Path) -> Result<ProjectConfigGuard, String> {
    let process = PROJECT_CONFIG_MUTEX.lock().map_err(|_| "项目配置锁失效")?;
    let canonical = crate::paths::canonicalize_plain(root).map_err(|e| e.to_string())?;
    let key = format!(
        "project-{:x}",
        md5::compute(crate::paths::path_key(&canonical.to_string_lossy()))
    );
    let file = crate::storage::config_lock(&key)?;
    Ok(ProjectConfigGuard {
        _process: process,
        _file: file,
    })
}

pub(crate) fn write_config_at(project: &Path, config: &ProjectConfigDto) -> Result<(), String> {
    // 配置写入是档案卡的写时刻：项目目录真实存在时先保证稳定 id（新建卡片不能没有身份）；
    // 目录不存在的是纯拼装调用方（模板渲染/测试），跳过分配。render_config 基于现有文档
    // 增量编辑，id 行在后续改写中天然保留
    if project.is_dir() {
        ensure_project_id_at(project)?;
    }
    let path = config_path(project);
    let existing = if path.exists() {
        Some(
            fs::read_to_string(&path)
                .map_err(|e| format!("读取现有 project.toml 失败，已停止写入: {e}"))?,
        )
    } else {
        None
    };
    let text = render_config(existing.as_deref(), config)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(&path, &text)
}

// ===== 任务书草稿（v3.72：讨论直接服务于 TASK.md，砍掉「提炼→定稿→钉卡→拼装」中间层） =====
// 每个步骤一份草稿 .ccode/drafts/<workspace_name>.md（项目根，随 .ccode 进 git——草稿是源、
// 工作区 TASK.md 是开工那一刻的产物）；聊想法 = agent 只允许改这一个文件；开工弹层预览
// 草稿优先于模板拼装；评审沉淀从「钉卡」改为追加进下一步草稿。

/// 草稿相对路径（单一出处）：文件名取 workspace_name，空则回落步骤名。
/// **两个分支都必须清洗**——原注释写「workspace_name 已 sanitize」但写入链路
/// （write_project_config → render_config）全程原样落 TOML，从未清洗过，
/// 而它来自 PipelineEditor 的裸输入框。含 `: ? * |` 时在 Windows 上落盘直接
/// os error 123，「聊想法 / 评审沉淀 / 融合进任务书」在该步骤永久不可用；
/// `../../evil` 更会写到项目根之外（这一条 macOS 同样中招）。
pub(crate) fn draft_rel_path(step_name: &str, workspace_name: &str) -> String {
    let raw = if !workspace_name.trim().is_empty() {
        workspace_name
    } else {
        step_name
    };
    // 沿用既有口径：只留字母数字（含中文）与 - _，其余（含空格）换成 -。
    // 草稿路径会被写进给 agent 的 prompt，不留空格省得两边都要加引号。
    let narrowed: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    // 再过一道通用落盘校验兜底（保留设备名、尾部点/空格）；全非法时回落固定名，
    // 不让整条草稿链路因为一个名字失败
    let base = crate::paths::sanitize_fs_name(&narrowed).unwrap_or_else(|_| "draft".to_string());
    format!(".ccode/drafts/{base}.md")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDraftDto {
    /// 相对项目根路径（正斜杠）
    pub rel_path: String,
    /// 草稿全文；不存在为 null
    pub text: Option<String>,
    /// 完整 UTF-8 内容的 SHA-256；文件不存在为 null，保存必须带回同一版本
    pub revision: Option<String>,
}

fn draft_revision(text: Option<&str>) -> Option<String> {
    text.map(|t| format!("{:x}", Sha256::digest(t.as_bytes())))
}

/// 读步骤任务书草稿（list 口径无门槛：非项目/无草稿返回 text=null）
#[tauri::command]
pub async fn read_task_draft(
    project_root: String,
    step_name: String,
) -> Result<TaskDraftDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = fs::canonicalize(crate::sessions::expand_tilde(&project_root))
            .map_err(|e| format!("项目目录无效: {e}"))?;
        let cfg = read_config_at(&root).config;
        let step = cfg
            .steps
            .iter()
            .find(|s| s.name == step_name)
            .ok_or_else(|| format!("步骤不存在: {step_name}"))?;
        let rel = draft_rel_path(&step.name, &step.workspace_name);
        let text = fs::read_to_string(root.join(&rel)).ok();
        let revision = draft_revision(text.as_deref());
        Ok(TaskDraftDto {
            rel_path: rel,
            text,
            revision,
        })
    })
    .await
    .map_err(|e| format!("读取任务书草稿失败: {e}"))?
}

/// 评审沉淀追加进下一步草稿（读-改-原子写；不存在则以标题头新建）
#[tauri::command]
pub async fn append_step_draft(
    project_root: String,
    step_name: String,
    heading: String,
    content: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        append_step_draft_at(&root, &step_name, &heading, &content)
    })
    .await
    .map_err(|e| format!("写入任务书草稿失败: {e}"))?
}

/// 追加实现（root 需已过项目门槛校验；测试直接调这里）。返回草稿相对路径
pub(crate) fn append_step_draft_at(
    root: &Path,
    step_name: &str,
    heading: &str,
    content: &str,
) -> Result<String, String> {
    let cfg = read_config_at(root).config;
    let step = cfg
        .steps
        .iter()
        .find(|s| s.name == step_name)
        .ok_or_else(|| format!("步骤不存在: {step_name}"))?;
    let rel = draft_rel_path(&step.name, &step.workspace_name);
    let path = root.join(&rel);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let body = if existing.trim().is_empty() {
        format!("# 任务书草稿：{}\n", step.name)
    } else {
        existing.trim_end().to_string()
    };
    let next = format!(
        "{body}\n\n## {}（{}）\n{}\n",
        heading.trim(),
        crate::sessions::now_iso(),
        content.trim()
    );
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建草稿目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(&path, &next)?;
    Ok(rel)
}

// ===== 任务卡（project.toml 的 [[tasks]] 段） =====
// 卡片 = 对话/会话的归档夹：只增删改名，无独立状态机，不碰工作区/评审流程。
// tasks 段与 resources/steps 相互独立：
// write_project_config 的 toml_edit 补丁不触碰 tasks（未知段原样保留），
// 任务卡写回同样只替换 tasks 段，档案卡其余内容原样保留。

use crate::models::TaskCardDto;

#[derive(Debug, Deserialize)]
struct TomlTask {
    id: String,
    name: String,
    #[serde(default)]
    step: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    created_at: String,
    // 旧版残留的 briefs = [...] 由 serde 默认忽略，下次写回自然丢弃
}

/// 卡片种类推断：只认显式 "idea"/"draft"；缺省/未知值按 step 推断
/// （step 非空 → draft，否则 idea——正好等于引入 kind 前的两种行为，免迁移脚本）
fn infer_task_kind(kind: Option<String>, step: &Option<String>) -> String {
    match kind.as_deref().map(str::trim) {
        Some("idea") => "idea",
        Some("draft") => "draft",
        _ => {
            if step.is_some() {
                "draft"
            } else {
                "idea"
            }
        }
    }
    .to_string()
}

/// 防御式解析：整份坏掉或单条坏字段都不阻断，坏条目跳过（风格同 parse_config）
fn parse_task_cards(text: &str) -> Vec<TaskCardDto> {
    let Ok(value) = toml::from_str::<toml::Value>(text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(arr) = value.get("tasks").and_then(|v| v.as_array()) {
        for item in arr {
            let Ok(t) = item.clone().try_into::<TomlTask>() else {
                continue;
            };
            let id = t.id.trim().to_string();
            let name = t.name.trim().to_string();
            if id.is_empty() || name.is_empty() {
                continue;
            }
            let clean =
                |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            let step = clean(t.step);
            let kind = infer_task_kind(t.kind, &step);
            out.push(TaskCardDto {
                id,
                name,
                step,
                workspace: clean(t.workspace),
                kind,
                created_at: t.created_at,
            });
        }
    }
    out
}

/// 读项目根下的任务卡清单；无档案卡/无 tasks 段返回空表
pub(crate) fn task_cards_at(root: &Path) -> Vec<TaskCardDto> {
    let Ok(text) = fs::read_to_string(config_path(root)) else {
        return Vec::new();
    };
    parse_task_cards(&text)
}

/// 会话列表回填用：task_id → 卡片名（sessions.rs 按项目根缓存一次）
pub(crate) fn task_names_at(root: &Path) -> std::collections::HashMap<String, String> {
    task_cards_at(root)
        .into_iter()
        .map(|t| (t.id, t.name))
        .collect()
}

/// 写回 tasks 段：以现有文件为底用 toml_edit 打补丁（同 render_config），
/// 只全量替换 tasks，其余键、注释、格式原样保留；现有文件无法解析时停止写入。
fn render_tasks(existing: Option<&str>, tasks: &[TaskCardDto]) -> Result<String, String> {
    use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};
    let mut doc = existing
        .unwrap_or("")
        .parse::<DocumentMut>()
        .map_err(|e| format!("现有 project.toml 解析失败，已停止写入: {e}"))?;
    if tasks.is_empty() {
        doc.remove("tasks");
    } else {
        let mut arr = ArrayOfTables::new();
        for t in tasks {
            let mut tab = Table::new();
            tab["id"] = value(&t.id);
            tab["name"] = value(&t.name);
            if let Some(step) = &t.step {
                tab["step"] = value(step);
            }
            if let Some(ws) = &t.workspace {
                tab["workspace"] = value(ws);
            }
            // kind 恒写回（含旧卡推断值——读时现算，写回固化，免迁移脚本）
            tab["kind"] = value(&t.kind);
            tab["created_at"] = value(&t.created_at);
            arr.push(tab);
        }
        doc["tasks"] = Item::ArrayOfTables(arr);
    }
    Ok(with_project_toml_header(doc.to_string()))
}

fn write_tasks_at(root: &Path, tasks: &[TaskCardDto]) -> Result<(), String> {
    let path = config_path(root);
    let existing = if path.exists() {
        Some(
            fs::read_to_string(&path)
                .map_err(|e| format!("读取现有 project.toml 失败，已停止写入: {e}"))?,
        )
    } else {
        None
    };
    let text = render_tasks(existing.as_deref(), tasks)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 .ccode 目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(&path, &text)
}

/// 任务卡写入门槛：已注册项目或含 .ccode/project.toml（沿用项目删除的判定口径）。
/// 返回 canonical 项目根。list 不需要门槛（无档案卡读为空表），写操作一律先过这里。
pub(crate) fn ensure_task_project_root(project_root: &Path) -> Result<PathBuf, String> {
    // 剥 verbatim：Windows canonicalize 带 `\\?\`，与 strip 过的项目根 / 前端路径
    // 按分量永不相等，reader/lit_watch/citation 的前缀判定会误报「不在项目内」。
    // macOS/Linux 上 strip_verbatim 是恒等变换。
    let root =
        crate::paths::canonicalize_plain(project_root).map_err(|e| format!("项目目录无效: {e}"))?;
    if !root.is_dir() {
        return Err("项目路径不是目录".into());
    }
    let conn = db()?;
    if !is_registered_at(&conn, &root) && !config_path(&root).exists() {
        return Err("该目录不是 Mesa 项目（未注册且无 .ccode/project.toml）".into());
    }
    Ok(root)
}

/// 卡片 id：t-<8 位随机十六进制>（项目内唯一由 uuid 随机性保证，重名拒绝按 name 判定）
fn new_task_id() -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("t-{}", hex.chars().take(8).collect::<String>())
}

pub(crate) fn create_task_card_at(
    root: &Path,
    name: &str,
    step: Option<&str>,
    kind: Option<&str>,
) -> Result<TaskCardDto, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("卡片名不能为空".into());
    }
    let mut tasks = task_cards_at(root);
    if tasks.iter().any(|t| t.name == name) {
        return Err(format!("已存在同名卡片「{name}」"));
    }
    let step = step.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let card = TaskCardDto {
        id: new_task_id(),
        name: name.to_string(),
        // kind 缺省 = 推断规则（step 非空 → draft，否则 idea），与旧卡解析口径一致
        kind: infer_task_kind(kind.map(str::to_string), &step),
        step,
        workspace: None,
        created_at: crate::sessions::now_iso(),
    };
    tasks.push(card.clone());
    write_tasks_at(root, &tasks)?;
    Ok(card)
}

fn rename_task_card_at(root: &Path, task_id: &str, new_name: &str) -> Result<(), String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("卡片名不能为空".into());
    }
    let mut tasks = task_cards_at(root);
    if tasks.iter().any(|t| t.id != task_id && t.name == new_name) {
        return Err(format!("已存在同名卡片「{new_name}」"));
    }
    let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) else {
        return Err("卡片不存在（可能已被删除）".into());
    };
    task.name = new_name.to_string();
    write_tasks_at(root, &tasks)
}

fn delete_task_card_at(root: &Path, task_id: &str) -> Result<(), String> {
    let mut tasks = task_cards_at(root);
    let before = tasks.len();
    tasks.retain(|t| t.id != task_id);
    if tasks.len() == before {
        return Err("卡片不存在（可能已被删除）".into());
    }
    write_tasks_at(root, &tasks)
}

// ===== 资源自动发现（只读 stat，不读文件内容） =====

fn classify_extension(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "pdf" => Some("paper"),
        "csv" | "tsv" | "parquet" | "xlsx" | "sav" | "dta" => Some("dataset"),
        "bib" | "ris" | "enw" => Some("reference"),
        _ => None,
    }
}

/// 路径规范化比较键：统一正斜杠、去 ./ 前缀与尾部斜杠（三平台路径混写都能对上）
fn norm_path_key(p: &str) -> String {
    p.replace('\\', "/")
        .trim_start_matches("./")
        .trim_end_matches('/')
        .to_string()
}

fn walk_discover(
    dir: &Path,
    root: &Path,
    depth: usize,
    artifact_dir: &str,
    registered: &[String],
    out: &mut Vec<DiscoveredResourceDto>,
) {
    const MAX_DEPTH: usize = 3;
    let Ok(entries) = fs::read_dir(dir) else {
        return; // 无权限等子目录跳过，不阻断整体扫描
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // file_type 不跟随符号链接：链接环不会导致无限递归，链接指向的目录也不会下钻
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if depth >= MAX_DEPTH
                || name.starts_with('.')
                || name == "node_modules"
                || name == "target"
                || name == artifact_dir
            {
                continue;
            }
            walk_discover(
                &entry.path(),
                root,
                depth + 1,
                artifact_dir,
                registered,
                out,
            );
        } else {
            let ext = entry
                .path()
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_default();
            let Some(kind) = classify_extension(&ext) else {
                continue;
            };
            let entry_path = entry.path();
            let Ok(rel) = entry_path.strip_prefix(root) else {
                continue;
            };
            let rel_key = norm_path_key(&rel.to_string_lossy());
            let abs_key = norm_path_key(&entry_path.to_string_lossy());
            let exists = registered.iter().any(|r| *r == rel_key || *r == abs_key);
            let (size, mtime) = match entry.metadata() {
                Ok(m) => (
                    m.len(),
                    m.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| crate::sessions::iso_from_unix(d.as_secs())),
                ),
                Err(_) => (0, None),
            };
            out.push(DiscoveredResourceDto {
                path: rel_key,
                kind: kind.to_string(),
                size,
                mtime,
                exists,
            });
        }
    }
}

fn discover_at(project: &Path) -> Result<Vec<DiscoveredResourceDto>, String> {
    if !project.is_dir() {
        return Err(format!("项目目录不存在或不是目录: {}", project.display()));
    }
    let read = read_config_at(project);
    let registered: Vec<String> = read
        .config
        .resources
        .iter()
        .map(|r| norm_path_key(&r.path))
        .collect();
    let mut out = Vec::new();
    walk_discover(
        project,
        project,
        1,
        read.config.artifact_dir.trim(),
        &registered,
        &mut out,
    );
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

// ===== git 引导（幂等：已是仓库直接返回） =====

fn gitignore_text(work_mode: &str, artifact_dir: &str) -> String {
    if work_mode == "coding" {
        return "# Mesa 生成：系统垃圾与过程文件不进 git\n\
             .DS_Store\n\
             \n\
             # Mesa 过程文件（人工请求一步一份、只放没答的问题）\n\
             .ccode/handoff-*.md\n\
             .ccode/help-wanted.md\n\
             /output/\n"
            .into();
    }
    format!(
        "# Mesa 生成：产物与系统垃圾不进 git\n\
         /{artifact_dir}/\n\
         .DS_Store\n\
         \n\
         # Mesa 接力简报与人工请求：过程文件，不进版本库（人工请求一步一份、只放没答的问题）\n\
         .ccode/handoff-*.md\n\
         .ccode/help-wanted.md\n\
         \n\
         # 同步到文献库时 Mesa 按引文库生成的导入文件：每次重写，不进 git\n\
         /papers/zotero-library.ris\n\
         /papers/endnote-library.ris\n\
         \n\
         # 文献 PDF 等大文件登记为资源引用，不进 git\n\
         *.pdf\n\
         \n\
         # Mesa 雷达与积累台账（日常积累，不进 git；2026-10-13 双台账口径）\n\
         /papers/reading-list.md\n\
         /notes/inbox.md\n\
         /papers/watch-seen.md\n\
         /papers/watch-followup.md\n\
         /.ccode/watch-explains.json\n\
         /.ccode/pending-registrations.json\n\
         /.ccode/acceptance-log.jsonl\n\
         /.ccode/acceptance-log.lock\n\
         /.ccode/watch/\n\
         \n\
         # 常见数据/产物目录（按需取消注释）\n\
         # /data/\n\
         /output/\n\
         # /results/\n\
         # /figures/\n"
    )
}

/// 台账 marker 段名（gitignore_text 里的积累台账段用；模板钉住测试断言它存在）。
/// 2026-10-13 迁移命令按「未发布无用即删」拍板移除——存量项目当日已手工迁移完。
pub(crate) const GITIGNORE_LEDGER_MARKER: &str = "# Mesa 雷达与积累台账";

/// gitignore 模板里的台账忽略路径清单（模板钉住测试逐条断言，二者必须同步改）。
pub(crate) const LEDGER_IGNORE_PATHS: [&str; 9] = [
    "/papers/reading-list.md",
    "/notes/inbox.md",
    "/papers/watch-seen.md",
    "/papers/watch-followup.md",
    "/.ccode/watch-explains.json",
    "/.ccode/pending-registrations.json",
    "/.ccode/acceptance-log.jsonl",
    "/.ccode/acceptance-log.lock",
    "/.ccode/watch/",
];

fn ensure_git_at(project: &Path) -> Result<EnsureGitDto, String> {
    ensure_git_at_mode(project, "research")
}

fn ensure_git_at_mode(project: &Path, work_mode: &str) -> Result<EnsureGitDto, String> {
    if !project.is_dir() {
        return Err(format!("项目目录不存在或不是目录: {}", project.display()));
    }
    // git 缺失与「不是仓库」要分开：先解析二进制，缺失直接报错，不误判成未初始化
    if crate::agents::resolve_binary("git").is_none() {
        return Err("找不到 git 可执行文件，请先安装 git".to_string());
    }
    let inside = crate::workspaces::run_git(
        project,
        &["rev-parse", "--is-inside-work-tree"],
        Duration::from_secs(10),
    )
    .map(|out| out.trim() == "true")
    .unwrap_or(false);
    if inside {
        return Ok(EnsureGitDto {
            initialized: false,
            gitignore_written: false,
        });
    }
    crate::workspaces::run_git(project, &["init"], Duration::from_secs(30))
        .map_err(|e| format!("git init 失败: {e}"))?;
    // 改动面板的非仓库负缓存可能刚记过这个目录，init 成功后立即失效
    crate::git_info::invalidate_repo_probe(&project.to_string_lossy());
    let gitignore = project.join(".gitignore");
    let mut gitignore_written = false;
    if !gitignore.exists() {
        // 已有 .gitignore 不覆盖，避免清掉用户既有规则
        let read = read_config_at(project);
        let artifact_dir = read.config.artifact_dir.trim().trim_matches('/');
        let artifact_dir = if artifact_dir.is_empty() {
            DEFAULT_ARTIFACT_DIR
        } else {
            artifact_dir
        };
        let text = gitignore_text(work_mode, artifact_dir);
        crate::profiles::atomic_write(&gitignore, &text)
            .map_err(|e| format!("写入 .gitignore 失败: {e}"))?;
        gitignore_written = true;
    }
    Ok(EnsureGitDto {
        initialized: true,
        gitignore_written,
    })
}

// ===== 开步自动提交：只把 .ccode 与 .gitignore 两个 Mesa 自有路径提交进主仓库 =====
// 背景：git init 后档案卡（.ccode/project.toml）与 .gitignore 长期未跟踪，
// 工作区评审合并会被「主仓库有未提交改动」拦截。此命令只碰这两个路径，
// 用户其他文件（PDF 等）绝不纳入——commit 同样带 pathspec，防止扫进用户已暂存的内容。

/// 开步自动提交只处理的两个 Mesa 自有路径（literal pathspec，无 glob 展开）
const BOOTSTRAP_PATHS: [&str; 2] = [".ccode", ".gitignore"];

fn commit_bootstrap_at(repo: &Path) -> Result<BootstrapCommitDto, String> {
    const T: Duration = Duration::from_secs(30);
    if !repo.is_dir() {
        return Err(format!("项目目录不存在或不是目录: {}", repo.display()));
    }
    if crate::agents::resolve_binary("git").is_none() {
        return Err("找不到 git 可执行文件，请先安装 git".to_string());
    }
    let inside = crate::workspaces::run_git(repo, &["rev-parse", "--is-inside-work-tree"], T)
        .map(|out| out.trim() == "true")
        .unwrap_or(false);
    if !inside {
        return Err("不是 git 仓库，请先在项目页执行 git 初始化".to_string());
    }
    // 只处理磁盘上存在的路径：git add 对不存在的 pathspec 会整体失败，先过滤
    let existing: Vec<&str> = BOOTSTRAP_PATHS
        .into_iter()
        .filter(|p| repo.join(p).exists())
        .collect();
    if existing.is_empty() {
        return Ok(BootstrapCommitDto {
            committed: false,
            paths: Vec::new(),
        });
    }
    // 暂存这两个路径下的全部改动（untracked / modified / 已暂存）。
    // 排除雷达/验收台账缓存（2026-10-13 双台账口径）：老项目 .gitignore 还没有忽略行，
    // 不排除的话这一把会把台账提交成 tracked——Mesa 自己制造自己要拦的合并阻塞。
    // 用 pathspec exclude magic，故这一步不用 --literal-pathspecs（路径本身无通配，等价）
    const BOOTSTRAP_EXCLUDES: [&str; 5] = [
        ":(exclude).ccode/watch-explains.json",
        ":(exclude).ccode/pending-registrations.json",
        ":(exclude).ccode/acceptance-log.jsonl",
        ":(exclude).ccode/acceptance-log.lock",
        ":(exclude).ccode/watch",
    ];
    let mut add_args: Vec<&str> = vec!["add", "--"];
    add_args.extend(existing.iter().copied());
    add_args.extend(BOOTSTRAP_EXCLUDES);
    crate::workspaces::run_git(repo, &add_args, T)
        .map_err(|e| format!("暂存 .ccode/.gitignore 失败: {e}"))?;
    // 有暂存内容才提交；空仓库（unborn HEAD）下 diff --cached 与空树比较，也能列出新增文件
    let mut staged_args: Vec<&str> = vec![
        "--literal-pathspecs",
        "diff",
        "--cached",
        "--name-only",
        "--",
    ];
    staged_args.extend(existing.iter().copied());
    let staged = crate::workspaces::run_git(repo, &staged_args, T)
        .map_err(|e| format!("检查暂存内容失败: {e}"))?;
    let paths: Vec<String> = staged
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    if paths.is_empty() {
        return Ok(BootstrapCommitDto {
            committed: false,
            paths: Vec::new(),
        });
    }
    // 与 ensure_initial_commit 同一模式：绕过 gpgsign；git 身份缺失时仅本次提交
    // 用 -c 注入临时身份，不写入用户 git config
    let configured = |key: &str| {
        crate::workspaces::run_git(repo, &["config", "--get", key], T)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    };
    let mut args: Vec<&str> = vec!["-c", "commit.gpgsign=false", "--literal-pathspecs"];
    if !configured("user.name") {
        args.extend(["-c", "user.name=Mesa"]);
    }
    if !configured("user.email") {
        args.extend(["-c", "user.email=ccode@localhost"]);
    }
    // pathspec 限定提交范围：用户先前自行暂存的其他文件留在暂存区，不被本次提交带走
    args.extend([
        "commit",
        "-m",
        "Mesa: 项目档案卡与 gitignore 自动提交",
        "--",
    ]);
    args.extend(existing.iter().copied());
    crate::workspaces::run_git(repo, &args, T).map_err(|e| format!("自动提交失败: {e}"))?;
    Ok(BootstrapCommitDto {
        committed: true,
        paths,
    })
}

/// 示例课题：把检索步演示产物（清单/bib/README）提交进主仓，精读步才能直接读到。
/// PDF 走 *.pdf gitignore，不提交。失败不阻断创建。
fn commit_demo_seed_at(repo: &Path) -> Result<(), String> {
    const T: Duration = Duration::from_secs(30);
    const PATHS: [&str; 6] = [
        "papers/included.md",
        "papers/screening.md",
        "papers/to-fetch.md",
        "papers/to-fetch.ris",
        "references.bib",
        "README.md",
    ];
    let existing: Vec<&str> = PATHS
        .into_iter()
        .filter(|p| repo.join(p).exists())
        .collect();
    if existing.is_empty() {
        return Ok(());
    }
    let mut add_args: Vec<&str> = vec!["--literal-pathspecs", "add", "--"];
    add_args.extend(existing.iter().copied());
    crate::workspaces::run_git(repo, &add_args, T)?;
    let configured = |key: &str| {
        crate::workspaces::run_git(repo, &["config", "--get", key], T)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    };
    let mut args: Vec<&str> = vec!["-c", "commit.gpgsign=false", "--literal-pathspecs"];
    if !configured("user.name") {
        args.extend(["-c", "user.name=Mesa"]);
    }
    if !configured("user.email") {
        args.extend(["-c", "user.email=ccode@localhost"]);
    }
    args.extend(["commit", "-m", "Mesa: 示例课题检索步演示产物", "--"]);
    args.extend(existing.iter().copied());
    crate::workspaces::run_git(repo, &args, T)?;
    Ok(())
}

// ===== Tauri commands =====

#[tauri::command]
pub async fn list_projects() -> Result<Vec<ProjectDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let conn = db()?;
        list_projects_in(&conn)
    })
    .await
    .map_err(|e| format!("读取项目列表失败: {e}"))?
}

#[tauri::command]
pub async fn register_project(path: String, name: String) -> Result<ProjectDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        let conn = db()?;
        register_at(&conn, &project, &name, &crate::sessions::now_iso())
    })
    .await
    .map_err(|e| format!("注册项目失败: {e}"))?
}

/// 项目只保存默认 Agent id 引用，不保存密钥或模型目录。
#[tauri::command]
pub async fn set_project_default_agent(
    project_root: String,
    agent: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&project_root));
        let key = canonical_key(&project);
        let agent = agent.and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty()).then_some(value)
        });
        if let Some(agent) = agent.as_deref() {
            if crate::agent_specs::agent_spec(agent).is_none() {
                return Err(format!("未知 Agent：{agent}"));
            }
        }
        let conn = db()?;
        let changed = conn
            .execute(
                "UPDATE projects SET default_agent=?2 WHERE path=?1",
                params![key, agent],
            )
            .map_err(|e| format!("保存项目默认 Agent 失败: {e}"))?;
        if changed == 0 {
            return Err("项目尚未注册，不能保存默认 Agent".into());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("保存项目默认 Agent 失败: {e}"))?
}

/// 保存某个 Agent 在该项目中的默认 profile，以及这条连接里选用的模型 id。
/// 模型必须在该连接的名单里；不传模型 = 用名单第一个。只保存引用，不改连接本身。
#[tauri::command]
pub async fn set_project_default_profile(
    project_root: String,
    agent: String,
    profile_id: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&project_root));
        let key = canonical_key(&project);
        if crate::agent_specs::agent_spec(&agent).is_none() {
            return Err(format!("未知 Agent：{agent}"));
        }
        let profile_id = profile_id
            .map(|value| value.trim().to_string())
            .filter(|id| !id.is_empty());
        let model = if let Some(profile_id) = profile_id.as_deref() {
            let bindings = crate::gateway_store::load_bindings()?;
            let binding = bindings
                .iter()
                .find(|binding| binding.id == profile_id)
                .ok_or("默认配置不存在")?;
            if binding.agent != agent {
                return Err("默认配置与 Agent 不匹配".into());
            }
            accept_project_model(&binding.models, model.as_deref())?
        } else {
            None
        };
        let conn = db()?;
        let raw: String = conn
            .query_row(
                "SELECT default_profiles FROM projects WHERE path=?1",
                params![key],
                |r| r.get(0),
            )
            .map_err(|_| "项目尚未注册，不能保存默认配置".to_string())?;
        let raw_models: String = conn
            .query_row(
                "SELECT default_models FROM projects WHERE path=?1",
                params![key],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "{}".to_string());
        let mut defaults: BTreeMap<String, String> = serde_json::from_str(&raw).unwrap_or_default();
        let mut models: BTreeMap<String, String> =
            serde_json::from_str(&raw_models).unwrap_or_default();
        if let Some(profile_id) = profile_id {
            defaults.insert(agent.clone(), profile_id);
            match model {
                Some(model) => {
                    models.insert(agent, model);
                }
                None => {
                    models.remove(&agent);
                }
            }
        } else {
            defaults.remove(&agent);
            models.remove(&agent);
        }
        let encoded =
            serde_json::to_string(&defaults).map_err(|e| format!("保存默认配置失败: {e}"))?;
        let encoded_models =
            serde_json::to_string(&models).map_err(|e| format!("保存默认模型失败: {e}"))?;
        conn.execute(
            "UPDATE projects SET default_profiles=?2, default_models=?3 WHERE path=?1",
            params![key, encoded, encoded_models],
        )
        .map_err(|e| format!("保存项目默认配置失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("保存项目默认配置失败: {e}"))?
}

/// 项目槽位专属 Agent 绑定可用槽位（白名单：槽位是稳定契约 key，先开一个，
/// 后续任务槽位按需入列）
/// 槽位白名单：固定用途槽逐一列出（reader=精读阅读会话；discuss=问 AI 与聊想法）。
/// 步骤槽走 `step:<步骤名>` 前缀（B1）。读取侧
/// （get_project_agent_binding）不做白名单校验，天然通用
const PROJECT_AGENT_BINDING_SLOTS: &[&str] = &["reader", "discuss", "chat"];
const STEP_SLOT_PREFIX: &str = "step:";

/// 槽位合法性：固定槽在白名单，或 step: 前缀 + 非空步骤名
fn valid_agent_binding_slot(slot: &str) -> bool {
    if PROJECT_AGENT_BINDING_SLOTS.contains(&slot) {
        return true;
    }
    slot.strip_prefix(STEP_SLOT_PREFIX)
        .is_some_and(|name| !name.trim().is_empty())
}

/// 保存项目某槽位的专属 Agent 绑定（profile + model；agent 跟随 profile 所属 CLI，
/// 不单存）。模型须在该连接名单里；不传 = 用名单第一个。清空 = profile 传 None
/// （该槽位回落项目默认/启动栏自动链）。只保存引用，不改连接本身。
#[tauri::command]
pub async fn set_project_agent_binding(
    project_root: String,
    slot: String,
    profile_id: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&project_root));
        let key = canonical_key(&project);
        if !valid_agent_binding_slot(&slot) {
            return Err(format!("未知绑定槽位：{slot}"));
        }
        let profile_id = profile_id
            .map(|value| value.trim().to_string())
            .filter(|id| !id.is_empty());
        let model = if let Some(profile_id) = profile_id.as_deref() {
            let bindings = crate::gateway_store::load_bindings()?;
            let binding = bindings
                .iter()
                .find(|binding| binding.id == profile_id)
                .ok_or("连接不存在")?;
            accept_project_model(&binding.models, model.as_deref())?
        } else {
            None
        };
        let conn = db()?;
        let raw: String = conn
            .query_row(
                "SELECT task_bindings FROM projects WHERE path=?1",
                params![key],
                |r| r.get(0),
            )
            .map_err(|_| "项目尚未注册，不能保存专属绑定".to_string())?;
        let mut map: BTreeMap<String, ProjectAgentBinding> =
            serde_json::from_str(&raw).unwrap_or_default();
        match profile_id {
            Some(profile_id) => {
                map.insert(
                    slot,
                    ProjectAgentBinding {
                        profile: profile_id,
                        model,
                    },
                );
            }
            None => {
                map.remove(&slot);
            }
        }
        let encoded =
            serde_json::to_string(&map).map_err(|e| format!("保存专属绑定失败: {e}"))?;
        conn.execute(
            "UPDATE projects SET task_bindings=?2 WHERE path=?1",
            params![key, encoded],
        )
        .map_err(|e| format!("保存专属绑定失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("保存专属绑定失败: {e}"))?
}

/// 读项目某槽位的专属绑定（前端拉起前现读，不动注册表）；未绑定/未注册返回 None
#[tauri::command]
pub async fn get_project_agent_binding(
    project_root: String,
    slot: String,
) -> Result<Option<ProjectAgentBinding>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&project_root));
        let key = canonical_key(&project);
        let conn = db()?;
        let map = project_task_bindings(&conn, &key);
        Ok(map.into_iter().find(|(s, _)| s == &slot).map(|(_, b)| b))
    })
    .await
    .map_err(|e| format!("读取专属绑定失败: {e}"))?
}

#[tauri::command]
pub async fn remove_project(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        let conn = db()?;
        remove_project_at(&conn, &project)
    })
    .await
    .map_err(|e| format!("移除项目注册失败: {e}"))?
}

/// 彻底删除项目目录：该 repo 的全部工作区 + 目录本身 + 注册记录（不可逆，前端已确认）。
/// 返回中文成功摘要（如「已删除目录与 2 个工作区」）；防护口径见 delete_project_dir_impl。
#[tauri::command]
pub async fn delete_project_dir(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        let conn = db()?;
        delete_project_dir_impl(&conn, &project)
    })
    .await
    .map_err(|e| format!("删除项目目录失败: {e}"))?
}

/// 清除 Mesa 痕迹（保留文件夹）：全部工作区 + `.ccode/`（回收站）+ 注册记录。
/// 返回中文成功摘要（如「已清除：2 个工作区、档案卡与简报（回收站）、注册记录」）。
#[tauri::command]
pub async fn purge_project_traces(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        let conn = db()?;
        purge_project_traces_impl(&conn, &project)
    })
    .await
    .map_err(|e| format!("清除 Mesa 痕迹失败: {e}"))?
}

#[tauri::command]
pub async fn read_project_config(path: String) -> ProjectConfigReadDto {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        read_config_at(&project)
    })
    .await
    .unwrap_or_else(|_| ProjectConfigReadDto {
        config: ProjectConfigDto::default(),
        warnings: vec!["读取项目配置时发生内部错误".to_string()],
    })
}

/// 步骤名校验（write_project_config 入口；纯函数供测试）：非空 + 不重名。
/// 重名会让 step:<名> 绑定与 Agents 页坏行归堆错乱（B1）
fn validate_step_names(steps: &[StepDto]) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for (i, step) in steps.iter().enumerate() {
        let name = step.name.trim();
        if name.is_empty() {
            return Err(format!("第 {} 步还没有填写步骤名", i + 1));
        }
        if !seen.insert(name.to_string()) {
            return Err(format!(
                "步骤名重复：{name}（第 {} 步）；步骤专属绑定按步骤名匹配，重名会错乱",
                i + 1
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn write_project_config(path: String, config: ProjectConfigDto) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        let _guard = project_config_lock(&project)?;
        // 步骤重名防御（B1 步骤绑定按步骤名做槽键）：编辑器保存只拦空名，
        // 手工改名可造重名。内部模板追加路径自带去重（append 步骤重名跳过），
        // 不走本命令
        validate_step_names(&config.steps)?;
        write_config_at(&project, &config)
    })
    .await
    .map_err(|e| format!("写入项目配置失败: {e}"))?
}

/// 对话注入两键的原子单键写（2026-10-16 审查补审拍板）：设置抽屉里注入面板与规则面板
/// 同卡片并存，走整份 write_project_config 的前端「读最新→改→写」往返会让两个写者
/// 的窗口互相覆盖。本命令在配置锁内读改写，只动 session_injection_mode/template
/// 两个键，其余字段（含未知键与用户手写内容）由 render_config 原样保留。
#[tauri::command]
pub async fn project_set_session_injection(
    path: String,
    mode: String,
    template: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        let mode_arg = mode.trim().to_string();
        if !SESSION_INJECTION_MODES.contains(&mode_arg.as_str()) {
            return Err(format!("对话注入模式取值无效：{mode_arg}"));
        }
        let root = ensure_task_project_root(&project)?;
        set_session_injection_at(&root, &mode_arg, &template)
    })
    .await
    .map_err(|e| format!("保存对话注入设置失败: {e}"))?
}

/// 读-改-原子写对话注入两键（root 需已过项目门槛校验；测试直接调这里）。
/// mode = auto 不写行；template 空白 = 清除；模板非空即写（切 mode 不清草稿）。
/// 锁罩住整段读改写：与规则面板等整卡写者的交错窗口里，本命令总是基于最新盘面落笔。
pub(crate) fn set_session_injection_at(
    root: &Path,
    mode: &str,
    template: &str,
) -> Result<(), String> {
    let template = template.trim();
    let _guard = project_config_lock(root)?;
    let mut cfg = read_config_at(root).config;
    cfg.session_injection_mode = if mode == "auto" {
        None
    } else {
        Some(mode.to_string())
    };
    cfg.session_injection_template = if template.is_empty() {
        None
    } else {
        Some(template.to_string())
    };
    write_config_at(root, &cfg)
}

/// 步骤推荐技能的读-改-原子写（开工确认弹层技能区增删写回 steps[].skills，v3.67）：
/// 不走整份 write_project_config 往返——read_config_at 读出现有配置，只改目标步骤的 skills，
/// 其余字段（含未知键）由 render_config 原样保留。
#[tauri::command]
pub async fn update_step_skills(
    project_root: String,
    step_name: String,
    skills: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_step_skills_impl(&project_root, &step_name, skills)
    })
    .await
    .map_err(|e| format!("更新步骤技能失败: {e}"))?
}

fn update_step_skills_impl(
    project_root: &str,
    step_name: &str,
    skills: Vec<String>,
) -> Result<(), String> {
    let root = ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(project_root)))?;
    update_step_skills_at(&root, step_name, skills)
}

/// scheduler 用：读项目的雷达筛选（读失败/无配置/全空 = None，不阻断任务）
pub(crate) fn lit_watch_filter_for(root: &Path) -> Option<LitWatchFilterDto> {
    read_config_at(root)
        .config
        .lit_watch_filter
        .filter(|f| !f.is_inert())
}

#[tauri::command]
pub async fn update_lit_watch_filter(
    project_root: String,
    filter: Option<LitWatchFilterDto>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        // 读-改-原子写；全空筛选归一为 None（toml 不留空段）
        let mut cfg = read_config_at(&root).config;
        cfg.lit_watch_filter = filter.filter(|f| !f.is_inert());
        write_config_at(&root, &cfg)
    })
    .await
    .map_err(|e| format!("更新文献筛选失败: {e}"))?
}

/// 读-改-原子写 steps[].skills（root 需已过项目门槛校验；测试直接调这里）。
/// 新挂载技能沿用旧入口语义，默认加入 required_skills；编辑器若要改成可选，走整份配置保存。
pub(crate) fn update_step_skills_at(
    root: &Path,
    step_name: &str,
    skills: Vec<String>,
) -> Result<(), String> {
    let mut cfg = read_config_at(root).config;
    let step = cfg
        .steps
        .iter_mut()
        .find(|s| s.name == step_name)
        .ok_or_else(|| format!("步骤不存在: {step_name}"))?;
    let previous = step.skills.clone();
    // 归一：去空白、去空项、保序去重
    let mut seen = std::collections::HashSet::new();
    step.skills = skills
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect();
    step.required_skills
        .retain(|skill| step.skills.contains(skill));
    for skill in &step.skills {
        if !previous.contains(skill) && !step.required_skills.contains(skill) {
            step.required_skills.push(skill.clone());
        }
    }
    write_config_at(root, &cfg)
}

#[tauri::command]
pub async fn discover_resources(path: String) -> Result<Vec<DiscoveredResourceDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        discover_at(&project)
    })
    .await
    .map_err(|e| format!("扫描项目资源失败: {e}"))?
}

#[tauri::command]
pub async fn ensure_git_repo(
    path: String,
    work_mode: Option<String>,
) -> Result<EnsureGitDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = PathBuf::from(crate::sessions::expand_tilde(&path));
        let mode = work_mode
            .as_deref()
            .map(normalize_work_mode)
            .unwrap_or_else(|| "research".into());
        ensure_git_at_mode(&project, &mode)
    })
    .await
    .map_err(|e| format!("git 初始化失败: {e}"))?
}

/// 一键开步前置：把 .ccode 与 .gitignore 两个 Mesa 自有路径提交进主仓库。
/// 幂等：无改动返回 committed=false；非仓库报错（前端开步流程已先走 ensure_git_repo）。
#[tauri::command]
pub async fn commit_project_bootstrap(repo_path: String) -> Result<BootstrapCommitDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = PathBuf::from(crate::sessions::expand_tilde(&repo_path));
        commit_bootstrap_at(&repo)
    })
    .await
    .map_err(|e| format!("自动提交项目档案卡失败: {e}"))?
}

// ===== 任务卡 commands（[[tasks]] 段，实现见上方「任务卡」节） =====

#[tauri::command]
pub async fn list_task_cards(project_root: String) -> Result<Vec<TaskCardDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(crate::sessions::expand_tilde(&project_root));
        Ok(task_cards_at(&root))
    })
    .await
    .map_err(|e| format!("读取任务卡失败: {e}"))?
}

#[tauri::command]
pub async fn create_task_card(
    project_root: String,
    name: String,
    step: Option<String>,
    kind: Option<String>,
) -> Result<TaskCardDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        create_task_card_at(&root, &name, step.as_deref(), kind.as_deref())
    })
    .await
    .map_err(|e| format!("创建任务卡失败: {e}"))?
}

#[tauri::command]
pub async fn rename_task_card(
    project_root: String,
    task_id: String,
    new_name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        rename_task_card_at(&root, &task_id, &new_name)
    })
    .await
    .map_err(|e| format!("重命名任务卡失败: {e}"))?
}

/// 只删卡片记录：归到该卡的会话由后端顺手摘掉失效的 task_id（session_meta 在同一份 app.db）
#[tauri::command]
pub async fn delete_task_card(project_root: String, task_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        delete_task_card_at(&root, &task_id)?;
        if let Ok(conn) = crate::sessions::open_db() {
            let _ = crate::sessions::clear_task_assignment(&conn, &task_id);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("删除任务卡失败: {e}"))?
}

// ===== 「◈ 融合进任务书」（想法卡 → 任务书草稿，两阶段：AI 出稿 → 人确认落盘） =====

/// 融合稿 command 返回：新草稿全文（AI 输出已过 redact_and_cap 脱敏截断）+ 草稿相对路径
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuseDraftDto {
    pub rel_path: String,
    pub text: String,
    /// 纳入融合的会话数（该卡名下；0 时前端不应走到这里）
    pub session_count: usize,
}

/// 融合 prompt（纯函数，可测）：草稿非空 = 织进既有结构；草稿为空 = 以讨论结论直接起草
pub(crate) fn build_fuse_prompt(
    card_name: &str,
    step_name: &str,
    draft: Option<&str>,
    discussion: &str,
) -> String {
    let base = format!(
        "项目里有一张某步骤「{step_name}」的想法卡「{card_name}」，下面是归到这张卡里的自由讨论记录。\n\n\
         【讨论记录】\n{discussion}\n\n"
    );
    let task = match draft {
        Some(d) if !d.trim().is_empty() => format!(
            "【当前任务书草稿】\n{}\n\n\
             请从讨论记录里提炼与「{step_name}」相关的结论，输出一段可直接追加到草稿末尾的 Markdown 片段：\n\
             - 一条结论一个要点（`- ` 开头），只写讨论中真的定下来的事，没定的收进末尾「### 待拍板」小项；\n\
             - 草稿里已经写过的结论不要重复；\n\
             - 不要复述讨论过程，不要输出标题行（调用方会自动加），不要解释、前后缀或代码围栏；\n\
             - 提炼不出任何新结论时输出一行「（本轮讨论未产生新结论）」。",
            d.trim()
        ),
        _ => "当前还没有任务书草稿。请从讨论记录里提炼与本步骤相关的结论，\
              输出一段 Markdown 片段：一条结论一个要点（`- ` 开头），没定下来的收进末尾「### 待拍板」小项。\
              不要复述讨论过程，不要输出标题行（调用方会自动加），不要解释、前后缀或代码围栏。"
            .to_string(),
    };
    format!("{base}{task}")
}

fn fuse_card_into_draft_impl(
    profiles: Vec<crate::profiles::Profile>,
    project_root: &str,
    task_id: &str,
    step_name: &str,
) -> Result<FuseDraftDto, String> {
    let root = ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(project_root)))?;
    let card = task_cards_at(&root)
        .into_iter()
        .find(|c| c.id == task_id)
        .ok_or_else(|| "卡片不存在（可能已被删除）".to_string())?;
    let cfg = read_config_at(&root).config;
    let step = cfg
        .steps
        .iter()
        .find(|s| s.name == step_name)
        .ok_or_else(|| format!("步骤不存在: {step_name}"))?;
    let rel = draft_rel_path(&step.name, &step.workspace_name);
    let draft_text = fs::read_to_string(root.join(&rel)).ok();
    // 范围 = 该卡名下的会话（session_meta.task_id 口径），逐个读全文（DTO 层已脱敏）
    let sessions = crate::sessions::sessions_for_card(task_id);
    if sessions.is_empty() {
        return Err("这张卡片还没有归入任何对话，先去「聊想法」聊一轮再融合".into());
    }
    let mut discussion = String::new();
    for s in &sessions {
        let text = crate::ai::conversation_text(&crate::sessions::conversation_impl(
            &s.agent,
            &s.file_path,
        ));
        if text.trim().is_empty() {
            continue;
        }
        discussion.push_str(&format!("--- 会话：{} ---\n{}\n\n", s.session_id, text));
    }
    if discussion.trim().is_empty() {
        return Err("卡片内的对话内容为空，无法融合".into());
    }
    // 与「◈ 提炼接力」同口径：中段挖空截 24KB，profile 走设置页 digest 功能键
    let prompt = build_fuse_prompt(
        &card.name,
        step_name,
        draft_text.as_deref(),
        &crate::ai::cap_text_middle(&discussion, 24 * 1024),
    );
    let ai_out = crate::ai::ai_prompt_impl(profiles, None, Some(crate::ai::FN_DIGEST), prompt)?;
    let text = crate::handoff::redact_and_cap(&ai_out).trim().to_string();
    if text.is_empty() {
        return Err("AI 没有产出融合稿，请重试".into());
    }
    Ok(FuseDraftDto {
        rel_path: rel,
        text,
        session_count: sessions.len(),
    })
}

/// 「◈ 沉淀进任务书」第一阶段：从想法卡的讨论里提炼结论片段（不写盘）。
/// 人在前端预览/编辑后经 append_step_draft 追加到草稿末尾——**不是整份覆盖**：
/// 头脑风暴是发散的半成品，拿它重写一份已定好的合同方向就反了，
/// 且整份覆盖时唯一的防线只有那个 textarea（无 diff、无备份）。追加则不可能删掉已有内容。
#[tauri::command]
pub async fn fuse_card_into_draft(
    store: tauri::State<'_, crate::profiles::ProfileStore>,
    project_root: String,
    task_id: String,
    step_name: String,
) -> Result<FuseDraftDto, String> {
    let profiles = store.list()?;
    tauri::async_runtime::spawn_blocking(move || {
        fuse_card_into_draft_impl(profiles, &project_root, &task_id, &step_name)
    })
    .await
    .map_err(|e| format!("融合进任务书失败: {e}"))?
}

fn write_task_draft_at(
    root: &Path,
    step_name: &str,
    content: &str,
    expected_revision: Option<&str>,
) -> Result<TaskDraftDto, String> {
    let cfg = read_config_at(root).config;
    let step = cfg
        .steps
        .iter()
        .find(|s| s.name == step_name)
        .ok_or_else(|| format!("步骤不存在: {step_name}"))?;
    let rel = draft_rel_path(&step.name, &step.workspace_name);
    let path = root.join(&rel);
    let current = fs::read_to_string(&path).ok();
    let current_rev = draft_revision(current.as_deref());
    if current_rev.as_deref() != expected_revision {
        return Err(
            "任务书已被 Agent 或其他程序修改，未覆盖磁盘内容。请先保留本次编辑，再重新打开对比。"
                .into(),
        );
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建草稿目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(&path, content)?;
    Ok(TaskDraftDto {
        rel_path: rel,
        text: Some(content.to_string()),
        revision: draft_revision(Some(content)),
    })
}

/// 整份覆盖写任务书草稿（融合稿确认落盘用；读-改-原子写同 drafts 口径：路径单一出处
/// draft_rel_path，atomic_write，父目录缺失自动建）。保存必须携带读取时的 revision。
#[tauri::command]
pub async fn write_task_draft(
    project_root: String,
    step_name: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<TaskDraftDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        write_task_draft_at(&root, &step_name, &content, expected_revision.as_deref())
    })
    .await
    .map_err(|e| format!("写入任务书草稿失败: {e}"))?
}

// ===== 示例课题（首启引导最小版落地，§11.4 backlog） =====
// 在「文档/Mesa 示例课题」生成带演示数据的完整项目：目录骨架、程序生成的一页示例 PDF、
// references.bib、README、英文综述五步流水线档案卡，然后 git 初始化并注册。
// 幂等：已注册直接返回现有 project（进行中不覆盖）。
// 目录还在但未注册（删除项目目录后废纸篓/iCloud 还原、或只摘了注册）：
// 档案卡按当前英文综述模板重写，缺的演示文件才补，已有笔记/PDF/README 不动。

const DEMO_DIR_NAME: &str = "Mesa 示例课题";
/// 2026-09-30 前创建的示例课题用这个目录名。再点「创建示例课题」时先认它，避免旁边再长出一份。
const DEMO_DIR_NAME_LEGACY: &str = "Ccode 示例课题";
const DEMO_PROJECT_NAME: &str = "示例课题（演示）";

const DEMO_BIB: &str = r#"@article{marso2016liraglutide,
  author  = {Marso, Steven P. and Daniels, Gilbert H. and others},
  title   = {Liraglutide and Cardiovascular Outcomes in Type 2 Diabetes},
  journal = {New England Journal of Medicine},
  year    = {2016},
  volume  = {375},
  number  = {4},
  pages   = {311--322},
  doi     = {10.1056/NEJMoa1603827},
}

@article{marso2016semaglutide,
  author  = {Marso, Steven P. and Bain, Stephen C. and others},
  title   = {Semaglutide and Cardiovascular Outcomes in Patients with Type 2 Diabetes},
  journal = {New England Journal of Medicine},
  year    = {2016},
  volume  = {375},
  number  = {19},
  pages   = {1834--1844},
  doi     = {10.1056/NEJMoa1607141},
}
"#;

const DEMO_README: &str = r#"# 示例课题（演示）

15 分钟走完「开读一篇文献」：检索步已经筛完，点「开读这一篇」进入笔记｜PDF｜终端三栏。
划一段写进笔记，看左边大圆下一步是「综述大纲」。完整五步留给你自己的课题。

- `papers/included.md` / `papers/included.json`：同一篇演示纳入文献与稳定 ID；演示 PDF 不可作为真实全文证据；
- `papers/Liraglutide-and-Cardiovascular-Outcomes-in-Type-2-Diabetes.pdf`：可划词的一页摘要（演示文件，不是真论文）；
- `references.bib`：LEADER / SUSTAIN-6 两条真实引文。

整个目录可随时删除。
"#;

const DEMO_INCLUDED: &str = "Liraglutide and Cardiovascular Outcomes in Type 2 Diabetes — Marso SP, 2016 — N Engl J Med — https://doi.org/10.1056/NEJMoa1603827\n";

/// 积累账演示（gitignored，磁盘存在即可）：演示「加入积累」的日常进料面——
/// 与正典 included.md 不同篇，避免示例里两表撞车。
const DEMO_READING_LIST: &str = "\
Semaglutide and Cardiovascular Outcomes in Patients with Type 2 Diabetes — Marso SP, 2016 — N Engl J Med — https://doi.org/10.1056/NEJMoa1607141\n\
Effect of Once-Weekly Semaglutide vs Placebo in Adults with Overweight or Obesity — Wilding JPH, 2021 — N Engl J Med — https://doi.org/10.1056/NEJMoa2032183\n";

const DEMO_INCLUDED_JSON: &str = r#"[
  {"id":"leader-2016-demo","title":"Liraglutide and Cardiovascular Outcomes in Type 2 Diabetes","decision":"included","reason":"演示纳入，仅用于阅读操作；演示 PDF 不是真实全文，不可作为科研证据","fulltextStatus":"demo-only"}
]
"#;

const DEMO_SCREENING: &str = "# 筛选记录（演示）\n\n检索主题假设：GLP-1 受体激动剂的心血管结局。\n\n本课题是 Mesa 示例，检索步已预置完成，不必再跑 OpenAlex。\n纳入 1 篇：Marso 2016 LEADER（见 papers/included.md）。\n";

const DEMO_TO_FETCH: &str = "# 待获取全文（演示）\n\n（无付费文献）\n";

const DEMO_TO_FETCH_RIS: &str = "# 空：演示课题没有付费墙条目\n";

const DEMO_PDF_REL: &str = "papers/Liraglutide-and-Cardiovascular-Outcomes-in-Type-2-Diabetes.pdf";

/// PDF 文本对象的内容串转义（反斜杠与括号在 PDF 字符串里是控制字符）
fn pdf_escape_text(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)")
}

/// 最小合法单页 PDF：程序拼装 5 个对象并记录字节偏移生成 xref 表。
/// 全部内容为 ASCII，字节偏移 = 字符偏移；演示课题的示例文献，不依赖任何外部库。
fn build_demo_pdf() -> Vec<u8> {
    let lines = [
        "Liraglutide and Cardiovascular Outcomes in Type 2 Diabetes",
        "Marso SP et al. N Engl J Med 2016;375:311-322. (demo abstract)",
        "",
        "Background. GLP-1 receptor agonists lower glucose in type 2 diabetes.",
        "Whether they also reduce major cardiovascular events was uncertain until",
        "dedicated outcome trials reported. This page is a readable stand-in so you",
        "can highlight a sentence, send it to the note, and see the next pipeline",
        "step. It is not a real paper; replace it with your own PDF later.",
        "",
        "Methods. Adults with type 2 diabetes and high cardiovascular risk were",
        "randomized to liraglutide or placebo, both added to standard care.",
        "The primary outcome was a composite of cardiovascular death, nonfatal",
        "myocardial infarction, or nonfatal stroke.",
        "",
        "Results. Liraglutide reduced the primary composite versus placebo. The",
        "authors reported fewer cardiovascular deaths; heart-failure hospitalization",
        "did not increase. Gastrointestinal events were more common with liraglutide.",
        "",
        "Limitations. This demo does not reproduce tables or the full discussion.",
        "Treat numbers here as placeholders. For a real review, read the original.",
        "",
        "Relation to this topic. The trial is a common anchor for reviews of GLP-1",
        "cardiovascular benefit. Use it to practice the reading pane, then move on",
        "to the outline step when you are ready.",
    ];
    let mut stream = String::from("BT /F1 11 Tf 72 740 Td 16 TL\n");
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            stream.push_str("T* ");
        }
        stream.push_str(&format!("({}) Tj\n", pdf_escape_text(line)));
    }
    stream.push_str("ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!("<< /Length {} >>\nstream\n{}\nendstream", stream.len(), stream),
    ];
    let mut out: Vec<u8> = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, body).as_bytes());
    }
    let xref_pos = out.len();
    let count = objects.len() + 1;
    out.extend_from_slice(format!("xref\n0 {count}\n").as_bytes());
    // 每条 xref 项固定 20 字节（10 位偏移 + 代序号 + f/n + 空格 + LF）
    out.extend_from_slice(b"0000000000 65535 f \n");
    for off in &offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n")
            .as_bytes(),
    );
    out
}

/// 与前端 `PIPELINE_TEMPLATES` 的「英文综述」同步：JSON 由
/// `scripts/export-review-template.ts` 从 `pipeline-presets.ts` 导出。
/// 演示只叠加：课题主题、资源、检索步 `seed_complete`（产物已预置）。
#[derive(Debug, Deserialize)]
struct ReviewTemplateFile {
    steps: Vec<StepDto>,
    #[serde(default, rename = "projectSettings")]
    project_settings: Vec<String>,
    #[serde(default, rename = "projectRules")]
    project_rules: Vec<String>,
}

const REVIEW_TEMPLATE_JSON: &str = include_str!("../resources/pipeline-review.json");

fn demo_review_template() -> ReviewTemplateFile {
    serde_json::from_str(REVIEW_TEMPLATE_JSON)
        .expect("src-tauri/resources/pipeline-review.json 损坏；请运行 node --experimental-strip-types scripts/export-review-template.ts")
}

fn demo_project_config() -> ProjectConfigDto {
    let file = demo_review_template();
    let mut steps = file.steps;
    if let Some(search) = steps
        .iter_mut()
        .find(|s| s.workspace_name == "lit-search" || s.name == "文献检索与筛选")
    {
        search.seed_complete = true;
    }
    ProjectConfigDto {
        topic: Some("GLP-1 受体激动剂的心血管结局（演示课题）".into()),
        settings: {
            let mut lines = file.project_rules;
            lines.extend(
                file.project_settings
                    .into_iter()
                    .filter(|line| !setting_is_placeholder(line)),
            );
            lines
        },
        rules_owned: false,
        protected_paths: Vec::new(),
        skills: Vec::new(),
        artifact_dir: DEFAULT_ARTIFACT_DIR.into(),
        resources: vec![
            ResourceDto {
                name: "示例文献（演示 PDF）".into(),
                path: DEMO_PDF_REL.into(),
                kind: "paper".into(),
                readonly: true,
                note: "程序生成的演示文件，可替换为真实文献".into(),
            },
            ResourceDto {
                name: "引文库".into(),
                path: "references.bib".into(),
                kind: "reference".into(),
                readonly: false,
                note: String::new(),
            },
        ],
        steps,
        pipeline_opt_out: false,
        lit_source: "search".into(),
        submission_mode: None,
        submission_round: None,
        lit_watch_filter: None,
        work_mode: "research".into(),
        session_injection_mode: None,
        session_injection_template: None,
    }
}

/// 示例课题预置的示范任务书草稿：演示「讨论结论沉淀进 .ccode/drafts/ 草稿」长什么样，
/// 让新用户点开第一步就理解草稿的用途（对话是过程，草稿是下一步任务书的积累区）。
const DEMO_STEP_DRAFT: &str = "结论：先精读演示里这一篇 LEADER 试验摘要，再决定要不要开工「文献精读与笔记」。\n\n\
- 请用「开读这一篇」进三栏（笔记｜PDF｜终端），划一段写进笔记；\n\
- 检索步已预置完成，不必先跑 OpenAlex；演示 PDF 不是真实全文，只用于阅读操作，不据此形成科研结论；\n\
- 若交付精读笔记，notes/index.json 沿用 papers/included.json 的 id，填写 notePath/bibKey/fulltextStatus（demo-only）/reviewStatus（pending）；\n\
- 下一步大圆是「综述大纲」。\n\n\
—— 这是 Mesa 预置的示范草稿。你自己的草稿由「评审沉淀 / ◈ 提炼接力」追加到这里（.ccode/drafts/）。";

fn write_if_missing(path: &Path, contents: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建示例课题目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(path, contents)
}

/// 档案卡始终写成当前英文综述模板；演示 PDF/清单/笔记仅在缺失时补，不覆盖已有文件。
fn refresh_demo_content(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir.join("papers")).map_err(|e| format!("创建示例课题目录失败: {e}"))?;
    fs::create_dir_all(dir.join("notes")).map_err(|e| format!("创建示例课题目录失败: {e}"))?;
    let pdf = dir.join(DEMO_PDF_REL);
    if !pdf.exists() {
        fs::write(&pdf, build_demo_pdf()).map_err(|e| format!("写入示例 PDF 失败: {e}"))?;
    }
    write_if_missing(&dir.join("papers/included.md"), DEMO_INCLUDED)?;
    write_if_missing(&dir.join("papers/reading-list.md"), DEMO_READING_LIST)?;
    write_if_missing(&dir.join("papers/included.json"), DEMO_INCLUDED_JSON)?;
    write_if_missing(&dir.join("papers/screening.md"), DEMO_SCREENING)?;
    write_if_missing(&dir.join("papers/to-fetch.md"), DEMO_TO_FETCH)?;
    write_if_missing(&dir.join("papers/to-fetch.ris"), DEMO_TO_FETCH_RIS)?;
    write_if_missing(&dir.join("references.bib"), DEMO_BIB)?;
    write_if_missing(&dir.join("README.md"), DEMO_README)?;
    write_config_at(dir, &demo_project_config())?;
    Ok(())
}

/// 预置演示任务卡 + 第一步示范任务书草稿（best-effort：播种失败不阻断示例课题创建；
/// 已注册早退；未注册重建时若已有卡片则不重复播种）。
fn seed_demo_task_card(root: &Path) -> Result<(), String> {
    create_task_card_at(root, "示例：开读这一篇", Some("文献精读与笔记"), None)?;
    append_step_draft_at(
        root,
        "文献精读与笔记",
        "想法期讨论沉淀（示范）",
        DEMO_STEP_DRAFT,
    )?;
    Ok(())
}

/// 按 canonical 主键查注册表；未注册返回 None
fn demo_registered(conn: &Connection, key: &str) -> Result<Option<ProjectDto>, String> {
    match conn.query_row(
        "SELECT path, name, created_at, last_opened_at, default_agent, default_profiles, id, default_models, task_bindings FROM projects WHERE path=?1",
        params![key],
        |r| {
            Ok(attach_work_mode(ProjectDto {
                id: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                path: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                last_opened_at: r.get(3)?,
                work_mode: "research".into(),
                default_agent: r.get(4)?,
                default_profiles: serde_json::from_str(
                    &r.get::<_, String>(5)?,
                )
                .unwrap_or_default(),
                default_models: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
                task_bindings: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
            }))
        },
    ) {
        Ok(p) => Ok(Some(p)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("查询项目注册表失败: {e}")),
    }
}

fn create_demo_at(base: &Path, conn: &Connection) -> Result<ProjectDto, String> {
    let current = base.join(DEMO_DIR_NAME);
    let legacy = base.join(DEMO_DIR_NAME_LEGACY);
    let dir = if current.is_dir() {
        current
    } else if legacy.is_dir() {
        legacy
    } else {
        current
    };
    if dir.is_dir() {
        let key = canonical_key(&dir);
        if let Some(existing) = demo_registered(conn, &key)? {
            return Ok(existing); // 幂等：进行中的演示不覆盖
        }
        // 未注册但目录还在：按当前模板重写档案卡（删除后再创建要拿到新流程）。
        refresh_demo_content(&dir)?;
        ensure_git_at(&dir)?;
        let _ = commit_bootstrap_at(&dir);
        let _ = commit_demo_seed_at(&dir);
        let project = register_at(conn, &dir, DEMO_PROJECT_NAME, &crate::sessions::now_iso())?;
        if task_cards_at(&dir).is_empty() {
            let _ = seed_demo_task_card(&dir);
        }
        return Ok(project);
    }
    refresh_demo_content(&dir)?;
    ensure_git_at(&dir)?;
    // best-effort：自动提交失败不阻断演示课题创建（档案卡未提交只影响后续评审合并提示）
    let _ = commit_bootstrap_at(&dir);
    let _ = commit_demo_seed_at(&dir);
    let project = register_at(conn, &dir, DEMO_PROJECT_NAME, &crate::sessions::now_iso())?;
    let _ = seed_demo_task_card(&dir);
    Ok(project)
}

/// 首启引导最小版：一键创建带演示数据的示例课题（目录固定限系统文档目录下）。
#[tauri::command]
pub async fn create_demo_project() -> Result<ProjectDto, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let base = dirs::document_dir().ok_or_else(|| "无法确定系统文档目录".to_string())?;
        let conn = db()?;
        create_demo_at(&base, &conn)
    })
    .await
    .map_err(|e| format!("创建示例课题失败: {e}"))?
}

/// 一键开步（§11.4 P1b）：把步骤简报落成工作区 TASK.md。
/// 只写固定文件名且必须位于给定工作树根内；不存在则新建，原子写入。
#[tauri::command]
pub async fn write_workspace_task_md(worktree_path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        const CAP: usize = 64 * 1024;
        if content.len() > CAP {
            return Err("TASK.md 内容超过 64 KB".into());
        }
        let root = fs::canonicalize(crate::sessions::expand_tilde(&worktree_path))
            .map_err(|e| format!("工作区目录无效: {e}"))?;
        // TASK.md 是开步脚手架而非任务产物：把它加进仓库级 .git/info/exclude，
        // 防止工作区全量提交把它带进分支、合并后污染主项目根目录（旧 TASK.md 会误导后续 Agent）
        exclude_task_md(&root);
        crate::profiles::atomic_write(&root.join("TASK.md"), &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInputChipDto {
    pub pattern: String,
    pub role: String,
    pub present: bool,
    pub count: u32,
    pub preview_path: Option<String>,
}

fn count_list_lines(path: &Path) -> u32 {
    fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .filter(|l| {
                    let t = l.trim();
                    !t.is_empty() && !t.starts_with('#')
                })
                .count() as u32
        })
        .unwrap_or(0)
}

fn chips_for_patterns(root: &Path, patterns: &[String], role: &str) -> Vec<StepInputChipDto> {
    let mut out = Vec::new();
    for pattern in patterns {
        let p = pattern.trim();
        if p.is_empty() {
            continue;
        }
        let files = crate::workspaces::glob_files_at(root, p);
        let mut count = files.len() as u32;
        if p.replace('\\', "/").ends_with("included.md") {
            if let Some(f) = files.first() {
                let n = count_list_lines(f);
                if n > 0 {
                    count = n;
                }
            }
        }
        let preview_path = files.first().map(|f| f.to_string_lossy().into_owned());
        out.push(StepInputChipDto {
            pattern: p.to_string(),
            role: role.into(),
            present: count > 0,
            count,
            preview_path,
        });
    }
    out
}

fn inspect_step_inputs_at(root: &Path, step_name: &str) -> Result<Vec<StepInputChipDto>, String> {
    let cfg = read_config_at(root).config;
    let step = cfg
        .steps
        .iter()
        .find(|s| s.name == step_name)
        .ok_or_else(|| format!("步骤不存在: {step_name}"))?;
    let mut chips = chips_for_patterns(root, &step.inputs, "required");
    chips.extend(chips_for_patterns(root, &step.optional_inputs, "optional"));
    for group in &step.any_of_inputs {
        chips.extend(chips_for_patterns(root, group, "any"));
    }
    Ok(chips)
}

/// 开步确认弹层：扫本步 inputs 在项目根的实文件，供芯片展示（不读提货单）。
#[tauri::command]
pub async fn inspect_step_inputs(
    project_root: String,
    step_name: String,
) -> Result<Vec<StepInputChipDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        inspect_step_inputs_at(&root, &step_name)
    })
    .await
    .map_err(|e| format!("检查步骤输入失败: {e}"))?
}

/// 把 TASK.md 追加到仓库共享的 .git/info/exclude（对所有 worktree 与主仓生效）。
/// best-effort：拿不到 git 公共目录（非仓库/异常）时静默跳过，不阻断 TASK.md 写入。
pub(crate) fn exclude_task_md(worktree_root: &Path) {
    let Ok(common) = crate::workspaces::run_git(
        worktree_root,
        &["rev-parse", "--git-common-dir"],
        std::time::Duration::from_secs(30),
    ) else {
        return;
    };
    let common = common.trim();
    if common.is_empty() {
        return;
    }
    // --git-common-dir 可能返回相对路径（相对 worktree 根）
    let dir = Path::new(common);
    let dir = if dir.is_absolute() {
        dir.to_path_buf()
    } else {
        worktree_root.join(dir)
    };
    let exclude = dir.join("info").join("exclude");
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == "TASK.md") {
        return;
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str("TASK.md\n");
    let _ = fs::create_dir_all(exclude.parent().unwrap());
    let _ = crate::profiles::atomic_write(&exclude, &content);
}

// ===== P2b「整理为笔记」：PDF 选段 → notes/excerpts.md（精读工作区在跑写工作区，否则写项目根） =====

/// 归属判定（纯函数，测试友好）：登记资源精确命中优先，其次项目根前缀命中；
/// 前缀取最长匹配（项目嵌套时归内层）。输入均为 canonical 路径。
fn resolve_owner(target: &Path, projects: &[(PathBuf, Vec<PathBuf>)]) -> Option<usize> {
    // 资源可以是项目根外的单个文件，故精确命中先于前缀判定
    if let Some(i) = projects
        .iter()
        .position(|(_, resources)| resources.iter().any(|r| target == r))
    {
        return Some(i);
    }
    projects
        .iter()
        .enumerate()
        .filter(|(_, (root, _))| target.starts_with(root))
        .max_by_key(|(_, (root, _))| root.as_os_str().len())
        .map(|(i, _)| i)
}

fn pdf_owner_at(pdf_path: &Path) -> Result<Option<ProjectDto>, String> {
    let target = fs::canonicalize(pdf_path).map_err(|e| format!("PDF 路径无效: {e}"))?;
    let conn = db()?;
    let projects = list_projects_in(&conn)?;
    let mut entries: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
    for p in &projects {
        // 根已失效（目录被移走）的项目跳过，不阻断其它项目的判定
        let Ok(root) = fs::canonicalize(&p.path) else {
            continue;
        };
        let mut resources = Vec::new();
        if let Ok(text) = fs::read_to_string(config_path(&root)) {
            let (config, _) = parse_config(&text);
            for r in config.resources {
                let rp = PathBuf::from(&r.path);
                let abs = if rp.is_absolute() { rp } else { root.join(&rp) };
                // 资源文件被移动/删除后无法精确命中，跳过（宁缺勿滥）
                if let Ok(c) = fs::canonicalize(&abs) {
                    resources.push(c);
                }
            }
        }
        entries.push((root, resources));
    }
    Ok(resolve_owner(&target, &entries).map(|i| projects[i].clone()))
}

/// 按 PDF 路径反查归属项目：登记资源精确命中 → 项目根前缀命中 → Ok(None)
/// （前端询问是否把所在文件夹添加为项目，默认不挂研究流程）。
#[tauri::command]
pub async fn pdf_owner_project(pdf_path: String) -> Result<Option<ProjectDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pdf_owner_at(&PathBuf::from(crate::sessions::expand_tilde(&pdf_path)))
    })
    .await
    .map_err(|e| format!("查询 PDF 归属项目失败: {e}"))?
}

/// 首次创建 excerpts.md 时的文件头（注明来源与用途）
const EXCERPTS_HEADER: &str = "# 文献摘录\n\n\
     > 由 Mesa「整理为笔记」从 PDF 选段自动追加；精读时并进对应文献的笔记，这份摘录原样保留。\n";

/// 摘录文件（2026-10-17 审查修复）：原先写 notes/inbox.md，那是文献雷达的收件箱——
/// 被 gitignore（摘录进不了合并、删工作区即丢），还会让雷达采纳把主仓多出的行当冲突。
const EXCERPTS_FILE: &str = "excerpts.md";

/// 追加语义 + 白名单（同步函数供测试）：
/// 目标固定为根内 notes/excerpts.md（不接受外部传入子路径），单次追加 ≤ 64 KB；
/// 读-改-原子写（atomic_write 走 tmp+rename，symlink 会被整体替换而非穿透）；
/// 已存在的摘录文件先 canonicalize 双校验仍在根内，堵符号链接逃逸。
fn append_excerpt_at(worktree_path: &Path, content: &str) -> Result<(), String> {
    append_notes_file_at(worktree_path, EXCERPTS_FILE, EXCERPTS_HEADER, content)
}

/// 摘记（2026-10-17 用户：选中终端文字「存进笔记」）：独立一份 notes/clips.md，不混进文献摘录——
/// 摘录会被精读步并进文献笔记，终端输出不是文献。前端只在科研 / 办公项目里给这个按钮。
/// 2026-10-20 起手机发来的话也存这里（phone_drop），新建时文件头写通用的「摘记」；已有文件不改写
const CLIPS_HEADER: &str = "# 摘记\n\n\
     > 由 Mesa「存进笔记」追加（终端里选中的文字、手机发来的话），最新的在最后。\n";
const CLIPS_FILE: &str = "clips.md";

/// 手机发来的话追加进 notes/clips.md（phone_drop 用；root 须已过项目根门槛）
pub(crate) fn append_clip_at(root: &Path, content: &str) -> Result<(), String> {
    append_notes_file_at(root, CLIPS_FILE, CLIPS_HEADER, content)
}

/// notes/<file> 追加的公共内核（摘录 / 摘记共用写入规则，见上）
fn append_notes_file_at(
    worktree_path: &Path,
    file: &str,
    header: &str,
    content: &str,
) -> Result<(), String> {
    const CAP: usize = 64 * 1024;
    if content.len() > CAP {
        return Err("追加内容超过 64 KB".into());
    }
    let root = fs::canonicalize(worktree_path).map_err(|e| format!("工作区目录无效: {e}"))?;
    if !root.is_dir() {
        return Err("工作区路径不是目录".into());
    }
    let notes_dir = root.join("notes");
    fs::create_dir_all(&notes_dir).map_err(|e| format!("创建 notes 目录失败: {e}"))?;
    let target = notes_dir.join(file);
    if target.exists() {
        let canon_target =
            fs::canonicalize(&target).map_err(|e| format!("读取 {file} 失败: {e}"))?;
        if !canon_target.starts_with(&root) {
            return Err(format!("notes/{file} 指向目录之外，拒绝写入"));
        }
    }
    let mut text = if target.exists() {
        fs::read_to_string(&target).map_err(|e| format!("读取 {file} 失败: {e}"))?
    } else {
        header.to_string()
    };
    text.push_str(content);
    crate::profiles::atomic_write(&target, &text)
}

/// 把终端里选中的一段追加到项目 notes/clips.md；写入规则同 append_excerpt_at
#[tauri::command]
pub async fn append_project_clip(project_root: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        append_notes_file_at(
            Path::new(&crate::sessions::expand_tilde(&project_root)),
            CLIPS_FILE,
            CLIPS_HEADER,
            &content,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把选段追加到 notes/excerpts.md（P2b；根 = 在跑的精读工作区或项目根）；写入规则见 append_excerpt_at。
#[tauri::command]
pub async fn append_notes_excerpt(worktree_path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        append_excerpt_at(
            Path::new(&crate::sessions::expand_tilde(&worktree_path)),
            &content,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 流水线模板库：用户自定义模板（<config>/ccode/pipeline-templates.json） =====
// 只存用户模板，内置模板在前端。文件存储风格同 settings.rs（同目录、原子写）；
// 损坏处理参照 keys.json 教训改名备份，但模板不是密钥——备份后按空表继续，
// 不丢其他数据（损坏的整份文件内容保留在 corrupt 备份里供人工恢复）。

/// 契约名别名：流水线步骤 DTO 即本文件的 StepDto（字段/camelCase 完全一致）
pub type ProjectStepDto = StepDto;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTemplateDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub steps: Vec<ProjectStepDto>,
    pub created_at: String,
}

fn templates_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("pipeline-templates.json"))
}

/// 读模板表：文件缺失视为空表；解析失败说明文件损坏——改名备份为
/// pipeline-templates.json.corrupt-<unix 秒> 后按空表继续（模板非密钥，参照 keys.json
/// 教训但不需要报错阻断）；其他 IO 错误向上报，避免下次写回静默清空
fn read_templates_at(path: &Path) -> Result<Vec<PipelineTemplateDto>, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path.display())),
    };
    match serde_json::from_str(&text) {
        Ok(v) => Ok(v),
        Err(_) => {
            // 备份名用 unix 秒：冒号在 Windows 文件名非法（同 keys.json 约定）
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let mut name = path.as_os_str().to_os_string();
            name.push(format!(".corrupt-{ts}"));
            let _ = fs::rename(path, PathBuf::from(name));
            Ok(Vec::new())
        }
    }
}

fn write_templates_at(path: &Path, templates: &[PipelineTemplateDto]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(templates).map_err(|e| e.to_string())?;
    crate::profiles::atomic_write(path, &text)
}

/// 保存模板：name 去空白后非空、steps 非空；同名 = 覆盖（覆盖确认在前端完成），
/// 覆盖时保留原 id 与 created_at，只更新 description/steps
fn save_template_at(
    path: &Path,
    name: &str,
    description: &str,
    steps: Vec<ProjectStepDto>,
) -> Result<PipelineTemplateDto, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("模板名称不能为空".into());
    }
    if steps.is_empty() {
        return Err("模板至少需要一个步骤".into());
    }
    let mut templates = read_templates_at(path)?;
    let tpl = match templates.iter_mut().find(|t| t.name == name) {
        Some(existing) => {
            existing.description = description.to_string();
            existing.steps = steps;
            existing.clone()
        }
        None => {
            let tpl = PipelineTemplateDto {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.to_string(),
                description: description.to_string(),
                steps,
                created_at: crate::sessions::now_iso(),
            };
            templates.push(tpl.clone());
            tpl
        }
    };
    write_templates_at(path, &templates)?;
    Ok(tpl)
}

/// 删除模板：id 不存在时按无操作处理（与 profiles 删除语义一致）
fn delete_template_at(path: &Path, id: &str) -> Result<(), String> {
    let mut templates = read_templates_at(path)?;
    templates.retain(|t| t.id != id);
    write_templates_at(path, &templates)
}

#[tauri::command]
pub async fn list_pipeline_templates() -> Result<Vec<PipelineTemplateDto>, String> {
    tauri::async_runtime::spawn_blocking(|| read_templates_at(&templates_path()?))
        .await
        .map_err(|e| format!("读取研究流程模板失败: {e}"))?
}

#[tauri::command]
pub async fn save_pipeline_template(
    name: String,
    description: String,
    steps: Vec<ProjectStepDto>,
) -> Result<PipelineTemplateDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 与 profiles/settings 共用同一把读-改-写锁，防并发保存互相覆盖
        let _g = crate::profiles::store_lock()?;
        save_template_at(&templates_path()?, &name, &description, steps)
    })
    .await
    .map_err(|e| format!("保存研究流程模板失败: {e}"))?
}

#[tauri::command]
pub async fn delete_pipeline_template(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _g = crate::profiles::store_lock()?;
        delete_template_at(&templates_path()?, &id)
    })
    .await
    .map_err(|e| format!("删除研究流程模板失败: {e}"))?
}

/// 「快速开聊」的落脚目录 `~/ccode/scratch`（不存在则创建）。
///
/// 刻意**不**做的事：不 git init、不写 `.ccode`、不登记项目——快速开聊就是「先聊聊」，
/// 不该在磁盘上留下项目结构。改动面板对这个目录如实显示「不是 git 仓库」即为预期。
/// 想转正时由用户显式走 `register_project`（终端标签 ⋯「转为项目…」）。
#[tauri::command]
pub async fn ensure_scratch_dir() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = dirs::home_dir()
            .ok_or("无法确定用户主目录")?
            .join("ccode")
            .join("scratch");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建 {} 失败: {e}", dir.display()))?;
        Ok(dir.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("准备快速开聊目录失败: {e}"))?
}

// ===== 从模板追加步骤（模板接壤拼接：相邻段模板追加进同一项目续走） =====
// 与「使用模板 = 整体替换 steps」不同：把模板步骤追加到 [[steps]] 末尾，
// 步骤链/提货单/资源机制对新步骤天然生效。步骤名重复时跳过；非空 workspace_name
// 冲突时自动加序号后缀，避免覆盖已有工作区绑定且不静默丢步骤。

/// 追加结果：实际追加步数 + 因步骤名重复跳过的步骤名 + 因工作区名冲突自动改名的记录。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppendStepsResultDto {
    pub appended: usize,
    pub skipped: Vec<String>,
    pub renamed: Vec<WorkspaceRenameDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRenameDto {
    pub name: String,
    pub from: String,
    pub to: String,
}

fn setting_parts(line: &str) -> (&str, &str) {
    if let Some((q, answer)) = line.split_once('：') {
        (q.trim(), answer.trim())
    } else if let Some((q, answer)) = line.split_once(':') {
        (q.trim(), answer.trim())
    } else {
        (line.trim(), "")
    }
}

fn setting_is_placeholder(line: &str) -> bool {
    let (question, answer) = setting_parts(line);
    // 没有冒号的是纪律句，不是待填设定。
    if question.is_empty() || question == line.trim() {
        return false;
    }
    answer.is_empty()
        || (answer.starts_with('（') && answer.ends_with('）'))
        || (answer.starts_with('(') && answer.ends_with(')'))
}

/// 合并模板建议的项目级设定：按问题名去重；已有真实答案优先，没填过的占位也要留下。
pub(crate) fn merge_project_settings(existing: &mut Vec<String>, candidates: &[String]) {
    for candidate in candidates {
        let candidate = candidate.trim();
        if candidate.is_empty() {
            continue;
        }
        let key = setting_parts(candidate).0;
        if key.is_empty() {
            continue;
        }
        if let Some(index) = existing
            .iter()
            .position(|current| setting_parts(current).0 == key)
        {
            if setting_is_placeholder(&existing[index]) && !setting_is_placeholder(candidate) {
                existing[index] = candidate.to_string();
            }
        } else {
            existing.push(candidate.to_string());
        }
    }
}

/// 统一模板应用实现：追加与替换共用同一份读-改-原子写逻辑。
pub(crate) fn apply_pipeline_template_at(
    root: &Path,
    steps: Vec<ProjectStepDto>,
    project_settings: Vec<String>,
    strategy: &str,
    topic: Option<String>,
    submission_mode: Option<&str>,
    submission_round: Option<u32>,
) -> Result<AppendStepsResultDto, String> {
    if steps.is_empty() {
        return Err("没有可应用的步骤（模板为空）".into());
    }
    if strategy != "append" && strategy != "replace" {
        return Err(format!("模板应用策略无效：{strategy}"));
    }
    if let Some(mode) = submission_mode {
        if !SUBMISSION_MODES.contains(&mode) {
            return Err(format!("投稿分支取值无效：{mode}"));
        }
    }
    let _guard = project_config_lock(root)?;
    let mut cfg = read_config_at(root).config;
    let original_cfg = cfg.clone();
    let mut result = AppendStepsResultDto {
        appended: 0,
        skipped: Vec::new(),
        renamed: Vec::new(),
    };

    if strategy == "replace" {
        let mut normalized_steps = Vec::with_capacity(steps.len());
        for mut step in steps {
            let name = step.name.trim().to_string();
            if name.is_empty() {
                return Err("替换模板包含未命名步骤".into());
            }
            if normalized_steps.iter().any(|s: &StepDto| s.name == name) {
                return Err(format!("替换模板包含重复步骤名：{name}"));
            }
            let original_workspace_name = step.workspace_name.trim().to_string();
            let mut workspace_name = original_workspace_name.clone();
            if !workspace_name.is_empty()
                && normalized_steps
                    .iter()
                    .any(|s: &StepDto| s.workspace_name == workspace_name)
            {
                let base = workspace_name.clone();
                let mut n = 2usize;
                loop {
                    let candidate = format!("{base}-{n}");
                    if !normalized_steps
                        .iter()
                        .any(|s: &StepDto| s.workspace_name == candidate)
                    {
                        workspace_name = candidate;
                        break;
                    }
                    n += 1;
                }
                result.renamed.push(WorkspaceRenameDto {
                    name: name.clone(),
                    from: original_workspace_name,
                    to: workspace_name.clone(),
                });
            }
            step.name = name;
            step.workspace_name = workspace_name;
            normalized_steps.push(step);
        }
        result.appended = normalized_steps.len();
        cfg.steps = normalized_steps;
    } else {
        for step in steps {
            let name = step.name.trim().to_string();
            if name.is_empty() {
                result.skipped.push("（未命名步骤）".to_string());
                continue;
            }
            if let Some(previous) = cfg.steps.iter().find(|s| s.name == name) {
                let missing: Vec<_> = step
                    .expected_artifacts
                    .iter()
                    .filter(|path| !previous.expected_artifacts.contains(path))
                    .collect();
                if !missing.is_empty() {
                    return Err(format!("同名步骤「{name}」交付不同，未应用模板。请改名追加或确认复用后调整输入：{}", missing.into_iter().cloned().collect::<Vec<_>>().join("、")));
                }
                result.skipped.push(name);
                continue;
            }
            let original_workspace_name = step.workspace_name.trim().to_string();
            let mut workspace_name = original_workspace_name.clone();
            if !workspace_name.is_empty()
                && cfg.steps.iter().any(|s| s.workspace_name == workspace_name)
            {
                let base = workspace_name.clone();
                let mut n = 2usize;
                loop {
                    let candidate = format!("{base}-{n}");
                    if !cfg.steps.iter().any(|s| s.workspace_name == candidate) {
                        workspace_name = candidate;
                        break;
                    }
                    n += 1;
                }
                result.renamed.push(WorkspaceRenameDto {
                    name: name.clone(),
                    from: original_workspace_name,
                    to: workspace_name.clone(),
                });
            }
            cfg.steps.push(StepDto {
                name,
                workspace_name,
                ..step
            });
            result.appended += 1;
        }
    }

    cfg.settings.retain(|line| !setting_is_placeholder(line));
    if original_cfg.steps.is_empty() {
        // 首次选择工具可覆盖旧 opt-out 留下的偏好；已有流程必须经编辑器统一改步骤。
        for candidate in project_settings
            .iter()
            .filter(|s| s.starts_with("科研工具/"))
        {
            cfg.settings
                .retain(|line| setting_parts(line).0 != setting_parts(candidate).0);
        }
    }
    merge_project_settings(&mut cfg.settings, &project_settings);
    let has_topic = topic
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let has_settings = project_settings
        .iter()
        .any(|value| !value.trim().is_empty());
    if let Some(topic) = topic.map(|x| x.trim().to_string()) {
        if !topic.is_empty() {
            cfg.topic = Some(topic);
        }
    }
    // 选择模板或写入模板附带元数据都意味着启用研究流程；普通追加全部跳过且无元数据时
    // 保留原文件，避免把一次无效操作伪装成成功写入。
    let template_selected = strategy == "replace"
        || result.appended > 0
        || submission_mode.is_some()
        || has_settings
        || has_topic;
    if template_selected {
        cfg.pipeline_opt_out = false;
    }
    match submission_mode {
        Some(mode) => {
            cfg.submission_mode = Some(mode.to_string());
            cfg.submission_round = if mode == "revision" {
                Some(submission_round.unwrap_or(1).max(1))
            } else {
                None
            };
        }
        None if strategy == "replace" => {
            cfg.submission_mode = None;
            cfg.submission_round = None;
        }
        None => {}
    }
    if cfg != original_cfg {
        write_config_at(root, &cfg)?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn apply_pipeline_template(
    project_root: String,
    steps: Vec<ProjectStepDto>,
    project_settings: Vec<String>,
    strategy: String,
    topic: Option<String>,
    submission_mode: Option<String>,
    submission_round: Option<u32>,
) -> Result<AppendStepsResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        apply_pipeline_template_at(
            &root,
            steps,
            project_settings,
            &strategy,
            topic,
            submission_mode.as_deref(),
            submission_round,
        )
    })
    .await
    .map_err(|e| format!("应用研究流程模板失败: {e}"))?
}

#[tauri::command]
pub async fn append_pipeline_steps(
    project_root: String,
    steps: Vec<ProjectStepDto>,
) -> Result<AppendStepsResultDto, String> {
    if steps.is_empty() {
        return Err("没有可追加的步骤（模板为空）".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        apply_pipeline_template_at(&root, steps, Vec::new(), "append", None, None, None)
    })
    .await
    .map_err(|e| format!("追加模板步骤失败: {e}"))?
}

/// 投稿/返修分支专用追加：步骤与分支元数据在同一次 project.toml 读-改-原子写中落盘。
#[tauri::command]
pub async fn append_pipeline_steps_with_submission(
    project_root: String,
    steps: Vec<StepDto>,
    submission_mode: String,
    submission_round: Option<u32>,
) -> Result<AppendStepsResultDto, String> {
    if steps.is_empty() {
        return Err("没有可追加的步骤（模板为空）".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        apply_pipeline_template_at(
            &root,
            steps,
            Vec::new(),
            "append",
            None,
            Some(submission_mode.as_str()),
            submission_round,
        )
    })
    .await
    .map_err(|e| format!("追加投稿/返修步骤失败: {e}"))?
}

/// 追加实现（root 需已过项目门槛校验；测试直接调这里）。
/// 保留旧测试/内部调用名，但实现统一委托给模板应用事务，避免三处入口再次分叉。
#[cfg(test)]
pub(crate) fn append_pipeline_steps_at(
    root: &Path,
    steps: Vec<ProjectStepDto>,
) -> Result<AppendStepsResultDto, String> {
    if steps.is_empty() {
        return Err("没有可追加的步骤（模板为空）".into());
    }
    apply_pipeline_template_at(root, steps, Vec::new(), "append", None, None, None)
}

#[cfg(test)]
pub(crate) fn append_pipeline_steps_at_with_submission(
    root: &Path,
    steps: Vec<ProjectStepDto>,
    submission_mode: Option<&str>,
    submission_round: Option<u32>,
) -> Result<AppendStepsResultDto, String> {
    if steps.is_empty() {
        return Err("没有可追加的步骤（模板为空）".into());
    }
    apply_pipeline_template_at(
        root,
        steps,
        Vec::new(),
        "append",
        None,
        submission_mode,
        submission_round,
    )
}

// ===== 「不使用研究流程」显式标记（pipeline_opt_out） =====
// 与「稍后再选」（不写标记、保留模板引导）区分：true = 隐藏模板引导横幅与定时任务区块。

/// 读-改-原子写实现（root 需已过项目门槛校验；测试直接调这里）。
/// 选 true：同时清空步骤表（否则步进器还在），投稿元数据一并拿掉；
/// 资源、笔记、课题主题、工作区目录都不动。
pub(crate) fn set_pipeline_opt_out_at(root: &Path, opt_out: bool) -> Result<(), String> {
    let mut cfg = read_config_at(root).config;
    cfg.pipeline_opt_out = opt_out;
    if opt_out {
        cfg.steps.clear();
        cfg.submission_mode = None;
        cfg.submission_round = None;
    }
    write_config_at(root, &cfg)
}

pub(crate) fn set_work_mode_at(root: &Path, mode: &str) -> Result<(), String> {
    let mut cfg = read_config_at(root).config;
    cfg.work_mode = normalize_work_mode(mode);
    write_config_at(root, &cfg)
}

#[tauri::command]
pub async fn set_work_mode(project_root: String, mode: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(crate::sessions::expand_tilde(&project_root));
        set_work_mode_at(&root, &mode)
    })
    .await
    .map_err(|e| format!("写入工作方式失败: {e}"))?
}

#[tauri::command]
pub async fn set_pipeline_opt_out(project_root: String, opt_out: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        set_pipeline_opt_out_at(&root, opt_out)
    })
    .await
    .map_err(|e| format!("更新研究流程标记失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ccode-projects-{tag}-{}", uuid::Uuid::new_v4()))
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn sample_config() -> ProjectConfigDto {
        ProjectConfigDto {
            topic: None,
            settings: Vec::new(),
            rules_owned: false,
            protected_paths: Vec::new(),
            skills: Vec::new(),
            artifact_dir: "outputs".into(),
            resources: vec![
                ResourceDto {
                    name: "核心论文".into(),
                    path: "papers/a.pdf".into(),
                    kind: "paper".into(),
                    readonly: true,
                    note: "先读这篇".into(),
                },
                ResourceDto {
                    name: "原始数据".into(),
                    path: "data/x.csv".into(),
                    kind: "dataset".into(),
                    readonly: false,
                    note: String::new(),
                },
            ],
            steps: vec![StepDto {
                name: "文献整理".into(),
                workspace_name: "lit".into(),
                brief: "读文献写笔记".into(),
                expected_artifacts: vec!["notes/".into()],
                acceptance_criteria: Vec::new(),
                decision_mode: "auto_continue".into(),
                inputs: Vec::new(),
                optional_inputs: Vec::new(),
                any_of_inputs: Vec::new(),
                skills: vec!["paper-notes".into()],
                required_skills: vec!["paper-notes".into()],
                resources: Vec::new(),
                human_tasks: Vec::new(),
                discussion_seeds: Vec::new(),
                decisions: Vec::new(),
                asks_lit_source: false,
                seed_complete: false,
                role: "ai".into(),
                run: vec![
                    StepRunDto {
                        name: "dev".into(),
                        command: "echo hi".into(),
                        is_default: true,
                        command_windows: None,
                    },
                    StepRunDto {
                        name: "test".into(),
                        command: "echo test".into(),
                        is_default: false,
                        command_windows: Some("Write-Output test".into()),
                    },
                ],
            }],
            pipeline_opt_out: false,
            lit_source: "search".into(),
            submission_mode: None,
            submission_round: None,
            lit_watch_filter: None,
            work_mode: "research".into(),
            session_injection_mode: None,
            session_injection_template: None,
        }
    }

    #[test]
    fn lit_watch_filter_round_trip_and_legacy_default() {
        // 旧档案卡没有该字段：serde default → None（不筛选）
        let legacy: ProjectConfigDto = toml::from_str(r#"artifact_dir = "outputs""#).unwrap();
        assert_eq!(legacy.lit_watch_filter, None);
        // 有筛选的档案卡：读回字段齐全；全空筛选在命令层归一为 None（is_inert 判定）
        let with_filter: ProjectConfigDto = toml::from_str(
            r#"artifact_dir = "outputs"
[litWatchFilter]
minIf = 10.0
maxCasQuartile = 2
topOnly = true
"#,
        )
        .unwrap();
        let f = with_filter.lit_watch_filter.clone().unwrap();
        assert_eq!(f.min_if, Some(10.0));
        assert_eq!(f.max_cas_quartile, Some(2));
        assert!(f.top_only);
        assert!(!f.is_inert());
        assert!(LitWatchFilterDto::default().is_inert());
        // 整卡重写必须把筛选写回去。漏写时保存成功、再打开是空的。
        let rendered = render_config(None, &with_filter).unwrap();
        assert!(rendered.contains("litWatchFilter"), "{rendered}");
        assert!(rendered.contains("minIf"), "{rendered}");
        let back = parse_config(&rendered).0.lit_watch_filter.unwrap();
        assert_eq!(back.min_if, Some(10.0));
        assert_eq!(back.max_cas_quartile, Some(2));
        assert!(back.top_only);
        let mut cleared = with_filter;
        cleared.lit_watch_filter = None;
        let rendered = render_config(Some(&rendered), &cleared).unwrap();
        assert!(!rendered.contains("litWatchFilter"), "{rendered}");
    }

    #[test]
    fn parse_full_config_and_render_round_trip() {
        let text = r#"artifact_dir = "outputs"
future_top_key = 42

[[resources]]
name = "核心论文"
path = "papers/a.pdf"
type = "paper"
readonly = true
note = "先读这篇"
unknown_field = "保持宽容"

[[resources]]
name = "原始数据"
path = "data/x.csv"
type = "dataset"

[[steps]]
name = "文献整理"
workspace_name = "lit"
brief = "读文献写笔记"
expected_artifacts = ["notes/"]
skills = ["paper-notes"]
[steps.run]
dev = { command = "echo hi", default = true }
test = { command = "echo test", command_windows = "Write-Output test" }
"#;
        let (config, warnings) = parse_config(text);
        assert!(warnings.is_empty(), "合法配置不应有警告: {warnings:?}");
        assert_eq!(config, sample_config());
        // 往返：渲染后再解析应还原；未知顶层键必须保留
        let rendered = render_config(Some(text), &config).unwrap();
        assert!(
            rendered.contains("future_top_key = 42"),
            "未知顶层键丢失: {rendered}"
        );
        let (back, back_warnings) = parse_config(&rendered);
        assert!(
            back_warnings.is_empty(),
            "回读不应有警告: {back_warnings:?}"
        );
        assert_eq!(back, config);
    }

    #[test]
    fn required_skills_defaults_to_all_and_preserves_explicit_optional_subset() {
        let text = r#"[[steps]]
name = "旧配置"
skills = ["a", "b"]

[[steps]]
name = "部分必需"
skills = ["a", "b"]
required_skills = ["a"]

[[steps]]
name = "全部可选"
skills = ["a", "b"]
required_skills = []
"#;
        let (config, warnings) = parse_config(text);
        assert!(warnings.is_empty(), "合法配置不应有警告: {warnings:?}");
        assert_eq!(config.steps[0].required_skills, vec!["a", "b"]);
        assert_eq!(config.steps[1].required_skills, vec!["a"]);
        assert!(config.steps[2].required_skills.is_empty());
        let rendered = render_config(Some(text), &config).unwrap();
        let (back, back_warnings) = parse_config(&rendered);
        assert!(
            back_warnings.is_empty(),
            "回读不应有警告: {back_warnings:?}"
        );
        assert_eq!(back.steps[2].required_skills, Vec::<String>::new());
    }

    #[test]
    fn parse_tolerates_broken_entries_and_reports() {
        let text = r#"artifact_dir = 42
resources = "not-an-array"
"#;
        let (config, warnings) = parse_config(text);
        assert_eq!(config.artifact_dir, DEFAULT_ARTIFACT_DIR);
        assert!(config.resources.is_empty());
        assert_eq!(warnings.len(), 2, "坏标量与坏数组各一条警告: {warnings:?}");

        let text = r#"[[resources]]
name = "没有 path"
type = "paper"

[[resources]]
name = "类型值非法"
path = "a.pdf"
type = 123

[[resources]]
name = "好资源"
path = "data/x.csv"
type = "xlsx-ish"

[[steps]]
brief = "没有 name 的步骤"

[[steps]]
name = "好步骤"
"#;
        let (config, warnings) = parse_config(text);
        assert_eq!(config.resources.len(), 1, "两条坏资源跳过，只留好的");
        assert_eq!(
            config.resources[0].kind, "other",
            "无法识别的 type 归为 other"
        );
        assert_eq!(config.steps.len(), 1);
        assert_eq!(config.steps[0].name, "好步骤");
        let joined = warnings.join("\n");
        assert!(
            joined.contains("resources[0]"),
            "缺字段条目要报告: {joined}"
        );
        assert!(
            joined.contains("resources[1]"),
            "类型非法条目要报告: {joined}"
        );
        assert!(joined.contains("无法识别"), "未知 type 要报告: {joined}");
        assert!(joined.contains("steps[0]"), "缺 name 步骤要报告: {joined}");
    }

    #[test]
    fn parse_broken_file_falls_back_to_default() {
        let (config, warnings) = parse_config("not [valid toml");
        assert_eq!(config, ProjectConfigDto::default());
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("解析失败"));
    }

    #[test]
    fn structured_inputs_and_human_completion_round_trip() {
        let text = r#"[[steps]]
name = "实验执行"
inputs = ["data/clean.csv"]
optional_inputs = ["notes/" ]
any_of_inputs = [["analysis/report.md", "analysis/report.qmd"]]

[[steps.human_tasks]]
title = "补齐数据授权"
target = ""

[[steps.human_tasks]]
title = "上传实验记录"
target = "records/*.csv"
completion = "all"
expected_count = 3
manifest_path = "records/manifest.txt"
"#;
        let (config, warnings) = parse_config(text);
        assert!(warnings.is_empty(), "结构化字段不应产生警告: {warnings:?}");
        let step = &config.steps[0];
        assert_eq!(step.inputs, vec!["data/clean.csv"]);
        assert_eq!(step.optional_inputs, vec!["notes/"]);
        assert_eq!(
            step.any_of_inputs,
            vec![vec!["analysis/report.md", "analysis/report.qmd"]]
        );
        assert_eq!(step.human_tasks[0].completion, "manual");
        assert_eq!(step.human_tasks[1].expected_count, Some(3));
        assert_eq!(step.human_tasks[1].manifest_path, "records/manifest.txt");

        let rendered = render_config(Some(text), &config).unwrap();
        let (back, back_warnings) = parse_config(&rendered);
        assert!(
            back_warnings.is_empty(),
            "结构化字段回读不应有警告: {back_warnings:?}"
        );
        assert_eq!(back, config);
    }

    #[test]
    fn render_replaces_known_sections_keeps_unknown() {
        let existing = r#"# 用户手写注释
artifact_dir = "old"
custom_pipeline = { foo = "bar" }

[[resources]]
name = "旧资源"
path = "old.pdf"
type = "paper"
"#;
        let config = ProjectConfigDto {
            topic: None,
            settings: Vec::new(),
            rules_owned: false,
            protected_paths: Vec::new(),
            skills: Vec::new(),
            artifact_dir: "new-out".into(),
            resources: vec![ResourceDto {
                name: "新资源".into(),
                path: "new.csv".into(),
                kind: "dataset".into(),
                readonly: false,
                note: String::new(),
            }],
            steps: Vec::new(),
            pipeline_opt_out: false,
            lit_source: "search".into(),
            submission_mode: None,
            submission_round: None,
            lit_watch_filter: None,
            work_mode: "research".into(),
            session_injection_mode: None,
            session_injection_template: None,
        };
        let rendered = render_config(Some(existing), &config).unwrap();
        assert!(
            rendered.contains("# 用户手写注释"),
            "注释必须保留: {rendered}"
        );
        assert!(
            rendered.contains("custom_pipeline"),
            "未知表必须保留: {rendered}"
        );
        assert!(
            !rendered.contains("旧资源"),
            "resources 全量替换: {rendered}"
        );
        let (back, _) = parse_config(&rendered);
        assert_eq!(back, config);
        // 现有文件是坏 TOML 时停止写入，不覆盖未知内容
        assert!(render_config(Some("not [valid"), &config).is_err());
    }

    #[test]
    fn topic_round_trip_and_absent() {
        // 缺失时 None，渲染不写入 topic 行
        let (config, warnings) = parse_config("artifact_dir = \"outputs\"\n");
        assert!(warnings.is_empty());
        assert_eq!(config.topic, None);
        let rendered = render_config(None, &config).unwrap();
        assert!(!rendered.contains("topic"), "空 topic 不应写入: {rendered}");

        // 往返：解析 → 渲染 → 再解析一致；未知顶层键保留
        let text = "topic = \"GLP-1 受体激动剂的心血管结局\"\nfuture_top_key = 42\n";
        let (config, warnings) = parse_config(text);
        assert!(warnings.is_empty());
        assert_eq!(
            config.topic.as_deref(),
            Some("GLP-1 受体激动剂的心血管结局")
        );
        let rendered = render_config(Some(text), &config).unwrap();
        assert!(
            rendered.contains("future_top_key = 42"),
            "未知顶层键丢失: {rendered}"
        );
        let (back, back_warnings) = parse_config(&rendered);
        assert!(
            back_warnings.is_empty(),
            "回读不应有警告: {back_warnings:?}"
        );
        assert_eq!(back, config);

        // 清空：渲染移除已有 topic 行
        let cleared = ProjectConfigDto {
            topic: None,
            ..config
        };
        let rendered = render_config(Some(&rendered), &cleared).unwrap();
        assert!(
            !rendered.contains("topic ="),
            "清空后应移除 topic 行: {rendered}"
        );
        let (back, _) = parse_config(&rendered);
        assert_eq!(back.topic, None);

        // 非字符串 topic：忽略并告警，不阻断
        let (config, warnings) = parse_config("topic = 42\n");
        assert_eq!(config.topic, None);
        assert_eq!(warnings.len(), 1, "坏 topic 要报告: {warnings:?}");
    }

    #[test]
    fn session_injection_round_trip_and_bad_value() {
        let text = r#"session_injection_mode = "custom"
session_injection_template = "你正在项目「{{项目名}}」中工作。\n{{项目规则}}"
"#;
        let (config, warnings) = parse_config(text);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(config.session_injection_mode.as_deref(), Some("custom"));
        assert!(config
            .session_injection_template
            .as_deref()
            .unwrap()
            .contains("{{项目名}}"));
        let rendered = render_config(Some(text), &config).unwrap();
        let (back, _) = parse_config(&rendered);
        assert_eq!(back.session_injection_mode, config.session_injection_mode);
        assert_eq!(
            back.session_injection_template,
            config.session_injection_template
        );
        // 切到 off：mode 行改写，模板草稿保留
        let switched = ProjectConfigDto {
            session_injection_mode: Some("off".into()),
            ..config
        };
        let rendered = render_config(Some(&rendered), &switched).unwrap();
        assert!(rendered.contains(r#"session_injection_mode = "off""#));
        assert!(rendered.contains("session_injection_template"));
        let (back, _) = parse_config(&rendered);
        assert_eq!(back.session_injection_mode.as_deref(), Some("off"));
        assert_eq!(
            back.session_injection_template,
            switched.session_injection_template
        );
        // 切回 auto：mode 行移除，模板仍保留；空模板 = 清除
        let auto = ProjectConfigDto {
            session_injection_mode: None,
            ..switched
        };
        let rendered = render_config(Some(&rendered), &auto).unwrap();
        assert!(!rendered.contains("session_injection_mode"));
        assert!(rendered.contains("session_injection_template"));
        let cleared = ProjectConfigDto {
            session_injection_template: None,
            ..auto
        };
        let rendered = render_config(Some(&rendered), &cleared).unwrap();
        assert!(!rendered.contains("session_injection_template"));
        // 非法 mode：告警并按 auto；空白模板视为未填写
        let (config, warnings) = parse_config("session_injection_mode = \"loud\"\n");
        assert_eq!(config.session_injection_mode, None);
        assert_eq!(warnings.len(), 1, "坏 mode 要报告: {warnings:?}");
        let (config, warnings) =
            parse_config("session_injection_template = \"  \"\n");
        assert_eq!(config.session_injection_template, None);
        assert!(warnings.is_empty(), "{warnings:?}");
        // 模板首尾空白：parse 存原文（面板读回所见即所存），render 写 trim 后——落盘一轮归一
        let (config, _) = parse_config("session_injection_template = \"  前后空白  \"\n");
        assert_eq!(
            config.session_injection_template.as_deref(),
            Some("  前后空白  ")
        );
        let rendered = render_config(None, &config).unwrap();
        assert!(rendered.contains("\"前后空白\""), "{rendered}");
        let (back, _) = parse_config(&rendered);
        assert_eq!(back.session_injection_template.as_deref(), Some("前后空白"));
        // 非字符串模板：告警不阻断
        let (config, warnings) = parse_config("session_injection_template = 42\n");
        assert_eq!(config.session_injection_template, None);
        assert_eq!(warnings.len(), 1, "坏模板类型要报告: {warnings:?}");
    }

    #[test]
    fn set_session_injection_at_touches_only_its_two_keys() {
        let root = temp_dir("injection-atomic");
        let toml_path = root.join(".ccode").join("project.toml");
        write(
            &toml_path,
            "topic = \"旧主题\"\nsettings = [\"只写中文\"]\n# 用户手写注释\n",
        );
        // 单键原子写：只动两个注入键，topic/settings/手写注释原样保留
        set_session_injection_at(&root, "custom", "你正在项目「{{项目名}}」中工作。").unwrap();
        let text = fs::read_to_string(&toml_path).unwrap();
        assert!(text.contains("topic = \"旧主题\""), "{text}");
        assert!(text.contains("settings = [\"只写中文\"]"), "{text}");
        assert!(text.contains("# 用户手写注释"), "{text}");
        assert!(text.contains("session_injection_mode = \"custom\""), "{text}");
        assert!(text.contains("session_injection_template"), "{text}");
        // off 写行；空白模板 = 显式清除
        set_session_injection_at(&root, "off", "  ").unwrap();
        let text = fs::read_to_string(&toml_path).unwrap();
        assert!(text.contains(r#"session_injection_mode = "off""#), "{text}");
        assert!(!text.contains("session_injection_template"), "{text}");
        // 坏档不覆盖：现有文件解析失败时停止写入
        write(&toml_path, "topic = ");
        assert!(set_session_injection_at(&root, "auto", "").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn protected_paths_and_rules_owned_round_trip() {
        let text = r#"settings = ["只写中文"]
rules_owned = true
protected_paths = ["数据/raw", "数据/raw/a.csv", "../x"]
"#;
        let (config, warnings) = parse_config(text);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(config.rules_owned);
        assert_eq!(config.protected_paths, vec!["数据/raw".to_string()]);
        assert!(!path_is_protected("论文/综述.md", &config.protected_paths));
        assert!(path_is_protected("数据/raw/a.csv", &config.protected_paths));
        let rendered = render_config(Some(text), &config).unwrap();
        let (back, _) = parse_config(&rendered);
        assert_eq!(back.protected_paths, config.protected_paths);
        assert!(back.rules_owned);
        let cleared = ProjectConfigDto {
            rules_owned: false,
            protected_paths: Vec::new(),
            ..config
        };
        let rendered = render_config(Some(&rendered), &cleared).unwrap();
        assert!(!rendered.contains("rules_owned"));
        assert!(!rendered.contains("protected_paths"));
    }

    #[test]
    fn path_is_protected_matches_case_insensitively() {
        // 保护 RAW/ 时，macOS 默认 APFS 上 raw/a.txt 在盘上是同一个文件，必须拦
        let protected = vec!["RAW".to_string()];
        assert!(path_is_protected("raw/a.txt", &protected));
        assert!(path_is_protected("Raw", &protected));
        assert!(!path_is_protected("rawish/a.txt", &protected));
        assert!(!path_is_protected("raw", &[]));
    }

    #[test]
    fn parse_config_warns_on_non_string_protected_path_items() {
        let (config, warnings) = parse_config("protected_paths = [\"raw\", 42]\n");
        assert_eq!(config.protected_paths, vec!["raw".to_string()]);
        assert_eq!(warnings.len(), 1, "混入非字符串项要报告: {warnings:?}");
    }

    #[test]
    fn project_skills_roundtrip_and_empty_omits_line() {
        let (config, warnings) =
            parse_config("skills = [\"lit-search\", \" lit-search \", \"data-eda\"]\n");
        assert!(warnings.is_empty(), "{warnings:?}");
        // 去空白 + 去重
        assert_eq!(
            config.skills,
            vec!["lit-search".to_string(), "data-eda".to_string()]
        );
        let rendered = render_config(None, &config).unwrap();
        assert!(rendered.contains("skills"), "{rendered}");
        let back = parse_config(&rendered).0;
        assert_eq!(back.skills, config.skills);
        // 空名单不写行
        let cleared = ProjectConfigDto {
            skills: Vec::new(),
            ..config
        };
        let rendered = render_config(Some(&rendered), &cleared).unwrap();
        assert!(!rendered.contains("skills"));
        // 非数组类型进 warnings 不阻断
        let (_, warnings) = parse_config("skills = \"oops\"\n");
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn register_assigns_stable_id_and_relinks_moved_project() {
        let dir = temp_dir("project-id");
        let proj_a = dir.join("a");
        std::fs::create_dir_all(&proj_a).unwrap();
        let conn = db_at(&dir.join("app.db")).unwrap();
        let first = register_at(&conn, &proj_a, "课题", "2026-09-09T00:00:00Z").unwrap();
        assert!(!first.id.is_empty(), "注册应分配稳定 id");
        // id 写进档案卡，跟随文件夹
        let toml = std::fs::read_to_string(proj_a.join(".ccode/project.toml")).unwrap();
        assert!(toml.contains(&format!("id = \"{}\"", first.id)), "{toml}");
        // 重复注册：id 稳定
        let again = register_at(&conn, &proj_a, "课题", "2026-09-09T01:00:00Z").unwrap();
        assert_eq!(again.id, first.id);
        // 目录移动：同一 id 在新路径注册 = 同一项目（路径改写、不建新行、created_at 保留）
        let proj_b = dir.join("b");
        conn.execute_batch("CREATE TABLE tasks(project_root TEXT, project_id TEXT);")
            .unwrap();
        conn.execute(
            "INSERT INTO tasks(project_root) VALUES(?1)",
            [canonical_key(&proj_a)],
        )
        .unwrap();
        std::fs::rename(&proj_a, &proj_b).unwrap();
        let moved = register_at(&conn, &proj_b, "课题", "2026-09-09T02:00:00Z").unwrap();
        assert_eq!(moved.id, first.id);
        assert_eq!(moved.created_at, first.created_at);
        let list = list_projects_in(&conn).unwrap();
        assert_eq!(list.len(), 1, "移动重连不得产生第二行");
        assert_eq!(list[0].path, canonical_key(&proj_b));
        assert_eq!(list[0].id, first.id);
        let task_id: String = conn
            .query_row("SELECT project_id FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(task_id, first.id);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn registering_a_copy_never_takes_over_a_live_project() {
        let dir = temp_dir("project-copy");
        let original = dir.join("original");
        let copy = dir.join("copy");
        std::fs::create_dir_all(&original).unwrap();
        let conn = db_at(&dir.join("app.db")).unwrap();
        let first = register_at(&conn, &original, "原项目", "t1").unwrap();
        std::fs::create_dir_all(copy.join(".ccode")).unwrap();
        let card = std::fs::read(original.join(".ccode/project.toml")).unwrap();
        std::fs::write(copy.join(".ccode/project.toml"), &card).unwrap();
        let error = register_at(&conn, &copy, "副本", "t2").unwrap_err();
        assert!(error.contains("原目录仍存在"), "{error}");
        let projects = list_projects_in(&conn).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].path, first.path);
        assert_eq!(projects[0].name, first.name);
        assert_eq!(
            std::fs::read(copy.join(".ccode/project.toml")).unwrap(),
            card
        );
        drop(conn);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn write_config_assigns_and_preserves_project_id() {
        let dir = temp_dir("project-id-write");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let config = ProjectConfigDto::default();
        write_config_at(&root, &config).unwrap();
        let id = project_id_at(&root).expect("配置写入应分配 id");
        // 后续改写不丢 id 行
        let changed = ProjectConfigDto {
            topic: Some("t".into()),
            ..config
        };
        write_config_at(&root, &changed).unwrap();
        assert_eq!(project_id_at(&root).as_deref(), Some(id.as_str()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn protected_paths_at_fail_closed_on_broken_config() {
        // 档案卡不存在 = 没配保护，正常放行
        let dir = temp_dir("protected-ok");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(protected_paths_at(&root).unwrap(), Vec::<String>::new());

        // 正常配置读出保护清单
        std::fs::create_dir_all(root.join(".ccode")).unwrap();
        write(
            &root.join(".ccode/project.toml"),
            "protected_paths = [\"数据/raw\"]\n",
        );
        assert_eq!(
            protected_paths_at(&root).unwrap(),
            vec!["数据/raw".to_string()]
        );

        // 整份解析失败 / 键类型不对 / 数组混入非字符串：保护清单不可信，一律拒绝
        write(
            &root.join(".ccode/project.toml"),
            "protected_paths = [\"raw\"\n",
        );
        let err = protected_paths_at(&root).unwrap_err();
        assert!(err.contains("无法确认保护路径"), "{err}");
        write(
            &root.join(".ccode/project.toml"),
            "protected_paths = \"raw\"\n",
        );
        assert!(protected_paths_at(&root).is_err());
        write(
            &root.join(".ccode/project.toml"),
            "protected_paths = [\"raw\", 42]\n",
        );
        assert!(protected_paths_at(&root).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_status_records_accepted_goals() {
        let dir = temp_dir("project-status");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        record_accepted_goal_at(&root, "研究综述", &["论文/综述.md".into()], "引用太少").unwrap();
        record_accepted_goal_at(&root, "研究综述", &["论文/综述.md".into()], "已补").unwrap();
        record_accepted_goal_at(&root, "数据清洗", &["data/clean.csv".into()], "").unwrap();
        let status = read_project_status_at(&root);
        assert_eq!(status.accepted[0].name, "数据清洗");
        assert_eq!(status.accepted[1].name, "研究综述");
        assert_eq!(status.accepted[1].note, "已补");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_memory_appends_only_confirmed_entries() {
        let dir = temp_dir("project-memory");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(read_memory_at(&root), "");
        append_project_memory_at(&root, "综述", "结论A：X 显著优于 Y", Some("run-1")).unwrap();
        append_project_memory_at(&root, "综述", "", Some("run-empty")).unwrap(); // 空意见不沉淀
        append_project_memory_at(&root, "综述", "结论A：X 显著优于 Y", Some("run-1")).unwrap(); // 同 Run 幂等
        let text = read_memory_at(&root);
        assert!(text.contains("mesa-memory"));
        assert_eq!(text.matches("结论A").count(), 1);
        assert!(text.contains("\"sourceVersion\":\"run-1\""));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn acceptance_log_appends_and_dedupes_by_run() {
        let dir = temp_dir("acceptance-log");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let entry = |run: &str| AcceptanceLogEntry {
            goal_id: "goal-1".into(),
            goal_name: "研究综述".into(),
            run_id: run.into(),
            paths: vec!["论文/综述.md".into()],
            note: "已补引用".into(),
            frozen: true,
            decided_at: "2026-09-09T00:00:00Z".into(),
            kind: "goal_adopt".into(),
            version_id: format!("{run}:1"),
            ..Default::default()
        };
        append_acceptance_log_at(&root, &entry("run-1")).unwrap();
        // 同一 Run 重试采纳：幂等跳过，不产生重复行
        append_acceptance_log_at(&root, &entry("run-1")).unwrap();
        append_acceptance_log_at(&root, &entry("run-2")).unwrap();
        let log = read_acceptance_log_at(&root);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].run_id, "run-1");
        assert_eq!(log[1].run_id, "run-2");
        assert!(log[0].frozen);
        assert_eq!(log[0].paths, vec!["论文/综述.md".to_string()]);
        assert_eq!(log[0].kind, "goal_adopt");
        let mut next_version = entry("run-1");
        next_version.version_id = "run-1:2".into();
        append_acceptance_log_at(&root, &next_version).unwrap();
        append_acceptance_log_at(&root, &next_version).unwrap();
        assert_eq!(
            read_acceptance_log_at(&root).len(),
            3,
            "同 Run 的新结果版本必须留下独立接受事实"
        );
        next_version.paths.push("data.csv".into());
        append_acceptance_log_at(&root, &next_version).unwrap();
        next_version.paths.reverse();
        append_acceptance_log_at(&root, &next_version).unwrap();
        assert_eq!(
            read_acceptance_log_at(&root).len(),
            4,
            "补采纳其它文件要记账，选择顺序不制造重复"
        );
        // 旧七字段行必须读回一条
        let legacy = r#"{"goalId":"g","goalName":"旧","runId":"r-old","paths":["a.md"],"note":"","frozen":false,"decidedAt":"t"}"#;
        std::fs::write(acceptance_log_path(&root), format!("{legacy}\n")).unwrap();
        let old = read_acceptance_log_at(&root);
        assert_eq!(old.len(), 1);
        assert_eq!(old[0].run_id, "r-old");
        assert_eq!(old[0].kind, "goal_adopt");
        assert_eq!(old[0].paths, vec!["a.md".to_string()]);
        // 损坏行不拖垮整本账
        std::fs::write(
            acceptance_log_path(&root),
            format!(
                "{}{}",
                std::fs::read_to_string(acceptance_log_path(&root)).unwrap(),
                "not-json\n"
            ),
        )
        .unwrap();
        assert_eq!(read_acceptance_log_at(&root).len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn acceptance_log_recovers_after_a_partial_final_line_without_destroying_evidence() {
        let dir = temp_dir("acceptance-torn-tail");
        fs::create_dir_all(dir.join(".ccode")).unwrap();
        let torn = b"{\"goalId\":\"unfinished";
        fs::write(acceptance_log_path(&dir), torn).unwrap();
        let entry = AcceptanceLogEntry {
            goal_id: "goal".into(),
            run_id: "run".into(),
            version_id: "run:1".into(),
            paths: vec!["paper.md".into()],
            ..Default::default()
        };
        append_acceptance_log_at(&dir, &entry).unwrap();
        assert_eq!(read_acceptance_log_at(&dir), vec![entry.clone()]);
        assert!(fs::read(acceptance_log_path(&dir))
            .unwrap()
            .starts_with(torn));
        append_acceptance_log_at(&dir, &entry).unwrap();
        assert_eq!(read_acceptance_log_at(&dir).len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    // ===== 步骤资源绑定（resources 字段与 validate_step） =====

    #[test]
    fn step_resources_round_trip_and_default_empty() {
        // 缺失 resources 的步骤默认空数组；绑定的步骤精确往返（相对与绝对路径混合）
        let text = r#"[[resources]]
name = "论文A"
path = "papers/a.pdf"

[[resources]]
name = "共享数据"
path = "/shared/data/x.csv"

[[steps]]
name = "文献整理"
brief = "读文献写笔记"

[[steps]]
name = "数据分析"
brief = "跑数据"
resources = ["papers/a.pdf", "/shared/data/x.csv"]
"#;
        let (config, warnings) = parse_config(text);
        assert!(warnings.is_empty(), "合法配置不应有警告: {warnings:?}");
        assert_eq!(
            config.steps[0].resources,
            Vec::<String>::new(),
            "缺失默认空"
        );
        assert_eq!(
            config.steps[1].resources,
            vec!["papers/a.pdf".to_string(), "/shared/data/x.csv".to_string()]
        );
        let rendered = render_config(Some(text), &config).unwrap();
        assert!(
            rendered.contains("resources = ["),
            "绑定必须写回: {rendered}"
        );
        let (back, back_warnings) = parse_config(&rendered);
        assert!(
            back_warnings.is_empty(),
            "回读不应有警告: {back_warnings:?}"
        );
        assert_eq!(back, config);
        // 空数组渲染时省略不写（语义同省略）
        let cleared = StepDto {
            resources: Vec::new(),
            ..config.steps[1].clone()
        };
        let mut cfg = config.clone();
        cfg.steps[1] = cleared;
        let rendered = render_config(Some(&rendered), &cfg).unwrap();
        assert!(
            !rendered.contains("resources ="),
            "空绑定不应写入: {rendered}"
        );
        let (back, _) = parse_config(&rendered);
        assert_eq!(back, cfg);
    }

    #[test]
    fn step_resources_tolerates_bad_values() {
        // 非数组 → 整条忽略并告警，步骤本体保留；非字符串/空白项逐条跳过并告警
        let text = r#"[[steps]]
name = "坏绑定一"
resources = "not-an-array"

[[steps]]
name = "坏绑定二"
resources = [1, "papers/a.pdf", "", 42]
"#;
        let (config, warnings) = parse_config(text);
        assert_eq!(
            config.steps.len(),
            2,
            "坏 resources 不得拖垮步骤: {warnings:?}"
        );
        assert!(config.steps[0].resources.is_empty());
        assert_eq!(config.steps[1].resources, vec!["papers/a.pdf".to_string()]);
        let joined = warnings.join("\n");
        assert!(
            joined.contains("steps[0] 的 resources 不是数组"),
            "{joined}"
        );
        assert!(joined.contains("steps[1] 的 resources[0]"), "{joined}");
        assert!(
            joined.contains("steps[1] 的 resources[2]"),
            "空白项也要报告: {joined}"
        );
        assert!(joined.contains("steps[1] 的 resources[3]"), "{joined}");
    }

    #[test]
    fn validate_step_binding_rules() {
        let resources = vec![
            ResourceDto {
                name: "论文A".into(),
                path: "papers/a.pdf".into(),
                kind: "paper".into(),
                readonly: true,
                note: String::new(),
            },
            ResourceDto {
                name: "共享数据".into(),
                path: "/shared/x.csv".into(),
                kind: "dataset".into(),
                readonly: false,
                note: String::new(),
            },
        ];
        // 规则①：绑定 path 不在 [[resources]] 里 → 提示；精确命中（相对/绝对）与空绑定不提示
        let step = StepDto {
            name: "分析".into(),
            resources: vec![
                "papers/a.pdf".into(),
                "/shared/x.csv".into(),
                "missing.pdf".into(),
            ],
            ..StepDto::default()
        };
        let warnings = validate_step(&step, &resources, &[], true);
        assert_eq!(warnings.len(), 1, "只有不存在的绑定要提示: {warnings:?}");
        assert!(
            warnings[0].contains("绑定的资源不存在：missing.pdf"),
            "{}",
            warnings[0]
        );
        let ok = StepDto {
            resources: vec!["papers/a.pdf".into()],
            ..StepDto::default()
        };
        assert!(
            validate_step(&ok, &resources, &[], true).is_empty(),
            "精确命中不提示"
        );
        let unbound = StepDto::default();
        assert!(
            validate_step(&unbound, &resources, &[], true).is_empty(),
            "空数组 = 不绑定 = 全部资源，不校验"
        );

        // 规则②：brief 引用约定路径，本步产物/上游产物/登记资源三处都查无 → 提示
        // papers/ 已登记为资源（papers/a.pdf 前缀命中）= 输入物料，不报；references.bib 三处皆无 → 报
        let miss = StepDto {
            name: "整理".into(),
            brief: "通读 papers/ 后把笔记写进 notes/，更新 references.bib".into(),
            expected_artifacts: vec!["notes/".into()],
            ..StepDto::default()
        };
        let warnings = validate_step(&miss, &resources, &[], true);
        assert_eq!(warnings.len(), 1, "只有 references.bib 提示: {warnings:?}");
        assert!(warnings[0].contains("「references.bib」"), "{warnings:?}");
        // 上游产物豁免：references.bib 与 papers/ 均由更早步骤产出 → 引用它们是合法输入，不报
        let prior = vec!["references.bib".to_string(), "papers/".to_string()];
        assert!(
            validate_step(&miss, &[], &prior, false).is_empty(),
            "上游产物被引用 = 合法输入，不提示"
        );
        // 只豁免一个时另一个仍报
        let warnings = validate_step(&miss, &[], &["papers/".to_string()], false);
        assert_eq!(warnings.len(), 1, "references.bib 仍提示: {warnings:?}");
        // 本步产物/上游产物/资源三处皆无才提示（miss 去掉资源后 papers/ 也要报）
        assert_eq!(
            validate_step(&miss, &[], &[], true).len(),
            2,
            "papers/ 与 references.bib 各提示一次"
        );
        let optional = StepDto {
            name: "检索".into(),
            brief: "已有 references.bib 不得覆盖".into(),
            optional_inputs: vec!["references.bib".into()],
            ..StepDto::default()
        };
        assert!(
            validate_step(&optional, &[], &[], true).is_empty(),
            "声明过的可选输入被简报提到，不当成缺产物"
        );
        let hit = StepDto {
            brief: "把综述草稿写进 manuscript/ 并同步 outline.md".into(),
            expected_artifacts: vec!["manuscript/draft.md".into(), "outline.md".into()],
            ..StepDto::default()
        };
        assert!(
            validate_step(&hit, &resources, &[], true).is_empty(),
            "目录前缀命中与文件精确命中都不提示"
        );
        let no_ref = StepDto {
            brief: "读文献写笔记".into(),
            ..StepDto::default()
        };
        assert!(
            validate_step(&no_ref, &resources, &[], true).is_empty(),
            "无引用不提示"
        );
    }

    #[test]
    fn read_config_merges_validation_warnings() {
        // read_project_config 的 warnings 自动并入校验结果
        let dir = temp_dir("validate");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        let text = r#"[[steps]]
name = "分析"
brief = "产出进 notes/"
resources = ["ghost.pdf"]
"#;
        write(&config_path(&project), text);
        let read = read_config_at(&project);
        let joined = read.warnings.join("\n");
        assert!(joined.contains("绑定的资源不存在：ghost.pdf"), "{joined}");
        assert!(joined.contains("「notes/」"), "{joined}");
        // 无问题的配置 warnings 为空
        write_config_at(&project, &sample_config()).unwrap();
        let read = read_config_at(&project);
        assert!(
            read.warnings.is_empty(),
            "干净配置不应有警告: {:?}",
            read.warnings
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn step_names_at_maps_workspace_to_step() {
        let dir = temp_dir("stepnames");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        // 无档案卡：空映射，不报错
        assert!(step_names_at(&project).is_empty());
        write_config_at(&project, &sample_config()).unwrap();
        let map = step_names_at(&project);
        assert_eq!(map.get("lit").map(String::as_str), Some("文献整理"));
        // 无 workspace_name 的步骤不进映射
        let mut config = sample_config();
        config.steps.push(StepDto {
            name: "无工作区步骤".into(),
            ..StepDto::default()
        });
        write_config_at(&project, &config).unwrap();
        let map = step_names_at(&project);
        assert_eq!(map.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_then_read_config_through_fs() {
        let dir = temp_dir("rw");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        // 无文件时读默认空配置
        let read = read_config_at(&project);
        assert_eq!(read.config, ProjectConfigDto::default());
        assert!(read.warnings.is_empty());
        // 写入后读回一致（.ccode 目录自动创建）
        let config = sample_config();
        write_config_at(&project, &config).unwrap();
        let read = read_config_at(&project);
        assert_eq!(read.config, config);
        // 再次写入全量替换 resources
        let mut config2 = config.clone();
        config2.resources.clear();
        write_config_at(&project, &config2).unwrap();
        let read = read_config_at(&project);
        assert_eq!(read.config, config2);
        let on_disk = fs::read_to_string(config_path(&project)).unwrap();
        assert!(
            !on_disk.contains("核心论文"),
            "resources 应被全量替换: {on_disk}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discover_classifies_limits_depth_and_skips_dirs() {
        let dir = temp_dir("discover");
        let root = dir.join("proj");
        let files = [
            ("paper.pdf", "paper"),
            ("data/a.csv", "dataset"),
            ("refs.bib", "reference"),
            ("deep1/deep2/mid.parquet", "dataset"), // 第 3 层，在内
        ];
        for (rel, _) in files {
            write(&root.join(rel), "x");
        }
        // 应被排除：超深、隐藏目录、node_modules、target、artifacts 目录、未识别扩展名
        for rel in [
            "d1/d2/d3/too-deep.pdf",
            ".hidden/secret.pdf",
            "node_modules/dep.pdf",
            "target/build.pdf",
            "artifacts/out.pdf",
            "notes.txt",
        ] {
            write(&root.join(rel), "x");
        }
        // 登记一个已有资源验证 exists 标记
        let mut config = ProjectConfigDto::default();
        config.resources.push(ResourceDto {
            name: "已登记".into(),
            path: "data/a.csv".into(),
            kind: "dataset".into(),
            readonly: false,
            note: String::new(),
        });
        write_config_at(&root, &config).unwrap();

        let found = discover_at(&root).unwrap();
        let got: Vec<(&str, &str, bool)> = found
            .iter()
            .map(|d| (d.path.as_str(), d.kind.as_str(), d.exists))
            .collect();
        assert_eq!(
            got,
            vec![
                ("data/a.csv", "dataset", true),
                ("deep1/deep2/mid.parquet", "dataset", false),
                ("paper.pdf", "paper", false),
                ("refs.bib", "reference", false),
            ],
            "分类、限深与排除目录都要正确"
        );
        assert!(found.iter().all(|d| d.size == 1 && d.mtime.is_some()));
        // 不存在的目录要报错而不是静默空列表
        assert!(discover_at(&root.join("missing")).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn registry_crud_and_reregister() {
        let dir = temp_dir("db");
        let db_path = dir.join("app.db");
        let conn = db_at(&db_path).unwrap();
        let p1 = dir.join("proj-a");
        let p2 = dir.join("proj-b");
        fs::create_dir_all(&p1).unwrap();
        fs::create_dir_all(&p2).unwrap();

        let d1 = register_at(&conn, &p1, "课题甲", "2026-08-01T00:00:00Z").unwrap();
        register_at(&conn, &p2, "课题乙", "2026-08-02T00:00:00Z").unwrap();
        let list = list_projects_in(&conn).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "课题乙", "按 last_opened_at 降序");
        assert_eq!(list[1].path, d1.path);

        // 重复注册：保留 created_at、更新 name 与 last_opened，行数不变
        let d1b = register_at(&conn, &p1, "课题甲改", "2026-08-03T00:00:00Z").unwrap();
        assert_eq!(d1b.path, d1.path, "同目录不同写法应归并到同一主键");
        assert_eq!(d1b.created_at, d1.created_at);
        assert_eq!(d1b.name, "课题甲改");
        let list = list_projects_in(&conn).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "课题甲改");

        // 移除只删注册记录，目录仍在
        remove_project_at(&conn, &p2).unwrap();
        assert!(p2.exists());
        let list = list_projects_in(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, d1.path);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_git_repo_idempotent() {
        let dir = temp_dir("git");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        if crate::agents::resolve_binary("git").is_none() {
            eprintln!("测试环境无 git，跳过 ensure_git_repo 用例");
            return;
        }
        let first = ensure_git_at(&project).unwrap();
        assert!(first.initialized && first.gitignore_written);
        assert!(project.join(".git").exists());
        let gitignore = fs::read_to_string(project.join(".gitignore")).unwrap();
        assert!(
            gitignore.contains("/artifacts/"),
            "默认产物目录进 gitignore: {gitignore}"
        );
        assert!(gitignore.contains(".DS_Store"));
        assert!(
            gitignore.contains(".ccode/handoff-*.md"),
            "接力简报规则进默认 gitignore: {gitignore}"
        );

        let coding = dir.join("proj-coding");
        fs::create_dir_all(&coding).unwrap();
        let c = ensure_git_at_mode(&coding, "coding").unwrap();
        assert!(c.initialized && c.gitignore_written);
        let cgi = fs::read_to_string(coding.join(".gitignore")).unwrap();
        assert!(!cgi.contains("*.pdf"), "编程项目不应忽略 pdf: {cgi}");
        assert!(cgi.contains(".DS_Store"));

        // 幂等：已是仓库直接返回，不改写任何文件
        let second = ensure_git_at(&project).unwrap();
        assert!(!second.initialized && !second.gitignore_written);
        assert_eq!(
            fs::read_to_string(project.join(".gitignore")).unwrap(),
            gitignore
        );

        // 自定义 artifact_dir 的项目：gitignore 用配置值
        let project2 = dir.join("proj2");
        fs::create_dir_all(&project2).unwrap();
        let mut config = ProjectConfigDto::default();
        config.artifact_dir = "outputs".into();
        write_config_at(&project2, &config).unwrap();
        let r = ensure_git_at(&project2).unwrap();
        assert!(r.initialized);
        let gitignore2 = fs::read_to_string(project2.join(".gitignore")).unwrap();
        assert!(gitignore2.contains("/outputs/"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 开步自动提交（commit_bootstrap_at） =====

    fn git_ok(dir: &Path, args: &[&str]) -> String {
        crate::workspaces::run_git(dir, args, Duration::from_secs(30))
            .unwrap_or_else(|e| panic!("git {args:?} 失败: {e}"))
    }

    fn git_has_head(dir: &Path) -> bool {
        crate::workspaces::run_git(
            dir,
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            Duration::from_secs(10),
        )
        .is_ok()
    }

    #[test]
    fn bootstrap_commit_only_ccode_paths_and_idempotent() {
        if crate::agents::resolve_binary("git").is_none() {
            eprintln!("测试环境无 git，跳过 commit_bootstrap 用例");
            return;
        }
        let dir = temp_dir("bootstrap");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        ensure_git_at(&project).unwrap(); // git init + 默认 .gitignore
        write_config_at(&project, &sample_config()).unwrap(); // .ccode/project.toml
                                                              // 用户文件：必须保持未跟踪，绝不纳入自动提交
        write(&project.join("paper.pdf"), "pdf");
        write(&project.join("data/notes.txt"), "n");
        // 用户自行暂存的文件也不得被本次提交带走（commit 有 pathspec 限定）
        write(&project.join("staged.txt"), "s");
        git_ok(&project, &["add", "staged.txt"]);

        let r = commit_bootstrap_at(&project).unwrap();
        assert!(r.committed, "untracked 的 .ccode/.gitignore 必须提交");
        assert!(r.paths.contains(&".gitignore".to_string()), "{:?}", r.paths);
        assert!(
            r.paths.contains(&".ccode/project.toml".to_string()),
            "{:?}",
            r.paths
        );
        assert!(
            !r.paths
                .iter()
                .any(|p| p.contains("paper.pdf") || p.contains("notes") || p.contains("staged")),
            "用户文件绝不进提交清单: {:?}",
            r.paths
        );

        // HEAD 树里只有 Mesa 自有路径
        let tree = git_ok(&project, &["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(
            tree.contains(".gitignore") && tree.contains(".ccode/project.toml"),
            "{tree}"
        );
        assert!(
            !tree.contains("paper.pdf")
                && !tree.contains("notes.txt")
                && !tree.contains("staged.txt"),
            "用户文件绝不进树: {tree}"
        );
        // 用户文件保持原状态：未跟踪的仍 ??，用户暂存的仍 A
        let status = git_ok(
            &project,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        );
        assert!(
            status
                .lines()
                .any(|l| l.starts_with("??") && l.contains("notes.txt")),
            "未跟踪用户文件不动: {status}"
        );
        assert!(
            status
                .lines()
                .any(|l| l.starts_with("A ") && l.contains("staged.txt")),
            "用户暂存文件留在暂存区: {status}"
        );

        // 幂等：第二次 committed=false，用户暂存内容仍不被带走
        let r2 = commit_bootstrap_at(&project).unwrap();
        assert!(
            !r2.committed && r2.paths.is_empty(),
            "第二次必须幂等: {r2:?}"
        );
        let status2 = git_ok(&project, &["status", "--porcelain=v1"]);
        assert!(
            status2
                .lines()
                .any(|l| l.starts_with("A ") && l.contains("staged.txt")),
            "{status2}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bootstrap_commit_picks_up_modified_gitignore() {
        if crate::agents::resolve_binary("git").is_none() {
            eprintln!("测试环境无 git，跳过 commit_bootstrap 用例");
            return;
        }
        let dir = temp_dir("bootstrap-mod");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        ensure_git_at(&project).unwrap();
        // 只存在 .gitignore（无 .ccode）：只提交存在的路径
        let r1 = commit_bootstrap_at(&project).unwrap();
        assert!(
            r1.committed && r1.paths == [".gitignore".to_string()],
            "{r1:?}"
        );

        // 修改已跟踪的 .gitignore：modified 也要被提交
        fs::write(project.join(".gitignore"), "# 用户改过的\n*.pdf\n").unwrap();
        let r2 = commit_bootstrap_at(&project).unwrap();
        assert!(r2.committed, "modified 的 .gitignore 必须提交");
        assert_eq!(r2.paths, [".gitignore".to_string()], "{:?}", r2.paths);

        // 无改动时幂等
        let r3 = commit_bootstrap_at(&project).unwrap();
        assert!(!r3.committed && r3.paths.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bootstrap_commit_unborn_repo_and_non_repo() {
        if crate::agents::resolve_binary("git").is_none() {
            eprintln!("测试环境无 git，跳过 commit_bootstrap 用例");
            return;
        }
        let dir = temp_dir("bootstrap-unborn");
        // 非仓库报错（前端开步流程已先走 ensure_git_repo，此处为防御）
        let plain = dir.join("plain");
        fs::create_dir_all(&plain).unwrap();
        assert!(commit_bootstrap_at(&plain).is_err(), "非仓库必须报错");

        // 空仓库（unborn HEAD）：bootstrap 直接落第一个内容提交，无需先跑空初始提交
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        ensure_git_at(&project).unwrap();
        assert!(!git_has_head(&project), "前置：仓库应为 unborn");
        write_config_at(&project, &sample_config()).unwrap();
        let r = commit_bootstrap_at(&project).unwrap();
        assert!(r.committed);
        // HEAD 已存在：create_workspace 内的 ensure_initial_commit 见到 HEAD 直接 no-op
        assert!(git_has_head(&project), "bootstrap 后 HEAD 必须存在");
        let tree = git_ok(&project, &["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(
            tree.contains(".gitignore") && tree.contains(".ccode/project.toml"),
            "{tree}"
        );

        // 空仓库且两个路径都不存在：committed=false，仓库保持 unborn，
        // 由 create_workspace 的 ensure_initial_commit 兜底空提交
        let bare = dir.join("bare");
        fs::create_dir_all(&bare).unwrap();
        git_ok(&bare, &["init"]);
        let r = commit_bootstrap_at(&bare).unwrap();
        assert!(
            !r.committed && r.paths.is_empty(),
            "无内容可提交时必须幂等: {r:?}"
        );
        assert!(!git_has_head(&bare), "无内容时不得凭空制造提交");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_owner_rules() {
        let outside_res = PathBuf::from("/shared/paper.pdf");
        let projects = vec![
            (PathBuf::from("/proj/a"), vec![outside_res.clone()]),
            (PathBuf::from("/proj/b"), Vec::new()),
            (PathBuf::from("/proj/a/inner"), Vec::new()),
        ];
        // 登记资源精确命中（资源在项目根外也认）
        assert_eq!(resolve_owner(&outside_res, &projects), Some(0));
        // 项目根前缀命中
        assert_eq!(
            resolve_owner(Path::new("/proj/b/docs/x.pdf"), &projects),
            Some(1)
        );
        // 嵌套项目归内层根（最长前缀）
        assert_eq!(
            resolve_owner(Path::new("/proj/a/inner/x.pdf"), &projects),
            Some(2)
        );
        // 前缀混淆（/proj/bb 不是 /proj/b 内）与完全根外都不命中
        assert_eq!(resolve_owner(Path::new("/proj/bb/x.pdf"), &projects), None);
        assert_eq!(resolve_owner(Path::new("/etc/x.pdf"), &projects), None);
    }

    #[test]
    fn append_excerpt_creates_with_header_then_appends() {
        let dir = temp_dir("inbox");
        let wt = dir.join("wt");
        fs::create_dir_all(&wt).unwrap();
        append_excerpt_at(&wt, "## a.pdf · 第 3 页 · 2026-08-05\n\n选段一\n").unwrap();
        let target = wt.join("notes/excerpts.md");
        let text = fs::read_to_string(&target).unwrap();
        assert!(
            text.starts_with("# 文献摘录"),
            "首次写入要有文件头: {text}"
        );
        assert!(text.contains("选段一"));
        // 第二次：追加不覆盖，文件头不重复
        append_excerpt_at(&wt, "## b.pdf · 第 1 页 · 2026-08-05\n\n选段二\n").unwrap();
        let text = fs::read_to_string(&target).unwrap();
        assert!(
            text.contains("选段一") && text.ends_with("选段二\n"),
            "追加语义: {text}"
        );
        assert_eq!(
            text.matches("# 文献摘录").count(),
            1,
            "文件头只出现一次: {text}"
        );
        // 目录不存在要报错而不是静默
        assert!(append_excerpt_at(&dir.join("missing"), "x").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn terminal_clips_go_to_their_own_file_not_excerpts() {
        let dir = temp_dir("clips");
        let root = dir.join("proj");
        fs::create_dir_all(&root).unwrap();
        append_notes_file_at(&root, CLIPS_FILE, CLIPS_HEADER, "\n## 片段一\n").unwrap();
        append_notes_file_at(&root, CLIPS_FILE, CLIPS_HEADER, "\n## 片段二\n").unwrap();
        let text = fs::read_to_string(root.join("notes/clips.md")).unwrap();
        assert!(text.starts_with("# 摘记"));
        assert_eq!(text.matches("# 摘记").count(), 1);
        assert!(text.ends_with("## 片段二\n"));
        assert!(!root.join("notes/excerpts.md").exists(), "终端输出不混进文献摘录");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_excerpt_rejects_oversize() {
        let dir = temp_dir("inbox-cap");
        fs::create_dir_all(&dir).unwrap();
        let big = "x".repeat(64 * 1024 + 1);
        let err = append_excerpt_at(&dir, &big).unwrap_err();
        assert!(err.contains("64 KB"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[cfg(unix)] // 符号链接语义仅 unix；Windows 无权限创建
    fn append_excerpt_rejects_symlink_escape() {
        let dir = temp_dir("inbox-sym");
        let outside = dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("inbox.md"), "外部内容").unwrap();
        let wt = dir.join("wt");
        fs::create_dir_all(wt.join("notes")).unwrap();
        std::os::unix::fs::symlink(outside.join("inbox.md"), wt.join("notes/excerpts.md")).unwrap();
        let err = append_excerpt_at(&wt, "追加").unwrap_err();
        assert!(err.contains("拒绝写入"), "{err}");
        // 外部文件未被改动
        assert_eq!(
            fs::read_to_string(outside.join("inbox.md")).unwrap(),
            "外部内容"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 流水线模板库 =====

    fn templates_file(tag: &str) -> (PathBuf, PathBuf) {
        let dir = temp_dir(tag);
        fs::create_dir_all(&dir).unwrap();
        (dir.join("pipeline-templates.json"), dir)
    }

    fn sample_steps() -> Vec<ProjectStepDto> {
        vec![
            StepDto {
                name: "读文献".into(),
                workspace_name: "lit-notes".into(),
                brief: "整理笔记".into(),
                expected_artifacts: vec!["notes/".into()],
                acceptance_criteria: Vec::new(),
                decision_mode: "auto_continue".into(),
                inputs: Vec::new(),
                optional_inputs: Vec::new(),
                any_of_inputs: Vec::new(),
                skills: vec!["paper-notes".into()],
                required_skills: Vec::new(),
                resources: Vec::new(),
                human_tasks: Vec::new(),
                discussion_seeds: Vec::new(),
                decisions: Vec::new(),
                asks_lit_source: false,
                seed_complete: false,
                role: "ai".into(),
                run: vec![StepRunDto {
                    name: "dev".into(),
                    command: "echo hi".into(),
                    is_default: true,
                    command_windows: None,
                }],
            },
            StepDto {
                name: "写论文".into(),
                ..StepDto::default()
            },
        ]
    }

    #[test]
    fn pipeline_template_crud_round_trip() {
        let (path, dir) = templates_file("tpl-crud");
        // 文件缺失时读为空表
        assert!(read_templates_at(&path).unwrap().is_empty());

        let saved = save_template_at(&path, "  科研流水线  ", "三步走", sample_steps()).unwrap();
        assert_eq!(saved.name, "科研流水线", "name 要去空白");
        assert!(!saved.id.is_empty() && !saved.created_at.is_empty());
        assert_eq!(saved.steps.len(), 2);

        let list = read_templates_at(&path).unwrap();
        assert_eq!(list, vec![saved.clone()], "保存后列表往返一致");
        // camelCase 字段名
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("\"createdAt\""), "{on_disk}");
        assert!(on_disk.contains("\"workspaceName\""), "{on_disk}");

        // 删除后清空；删除不存在的 id 是无操作而非报错
        delete_template_at(&path, &saved.id).unwrap();
        assert!(read_templates_at(&path).unwrap().is_empty());
        delete_template_at(&path, "不存在").unwrap();
        assert!(path.exists(), "删除不应移除文件本身");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pipeline_template_same_name_overwrites() {
        let (path, dir) = templates_file("tpl-overwrite");
        let first = save_template_at(&path, "模板A", "旧描述", sample_steps()).unwrap();
        save_template_at(&path, "模板B", "", sample_steps()).unwrap();

        let mut new_steps = sample_steps();
        new_steps.pop();
        let second = save_template_at(&path, "模板A", "新描述", new_steps.clone()).unwrap();
        assert_eq!(second.id, first.id, "同名覆盖保留原 id");
        assert_eq!(
            second.created_at, first.created_at,
            "同名覆盖保留 created_at"
        );
        assert_eq!(second.description, "新描述");
        assert_eq!(second.steps, new_steps);

        let list = read_templates_at(&path).unwrap();
        assert_eq!(list.len(), 2, "覆盖不新增条目");
        assert_eq!(list[0].steps.len(), 1, "覆盖后 steps 已更新");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pipeline_template_corrupt_file_backed_up_and_empty() {
        let (path, dir) = templates_file("tpl-corrupt");
        fs::write(&path, "{ 不是合法 json").unwrap();

        let list = read_templates_at(&path).unwrap();
        assert!(list.is_empty(), "损坏按空表继续");
        assert!(!path.exists(), "原损坏文件应已改名备份");
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("pipeline-templates.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1, "应生成唯一 corrupt 备份: {backups:?}");
        // 损坏内容完整保留在备份里，可被人工恢复
        assert_eq!(
            fs::read_to_string(dir.join(&backups[0])).unwrap(),
            "{ 不是合法 json"
        );
        // 备份后正常保存不受影响
        save_template_at(&path, "模板A", "", sample_steps()).unwrap();
        assert_eq!(read_templates_at(&path).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pipeline_template_rejects_empty_name_and_steps() {
        let (path, dir) = templates_file("tpl-reject");
        let err = save_template_at(&path, "   ", "d", sample_steps()).unwrap_err();
        assert!(err.contains("名称不能为空"), "{err}");
        let err = save_template_at(&path, "模板A", "d", Vec::new()).unwrap_err();
        assert!(err.contains("至少需要一个步骤"), "{err}");
        // 校验失败不落盘
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 从模板追加步骤（append_pipeline_steps_at） =====

    #[test]
    fn append_steps_appends_in_order_and_preserves_unknown_keys() {
        let dir = temp_dir("append-ok");
        let root = dir.join("proj");
        let text = "artifact_dir = \"outputs\"\nfuture_top_key = 42\n\n\
                    [[steps]]\nname = \"初稿\"\nworkspace_name = \"draft\"\n";
        write(&config_path(&root), text);
        let res = append_pipeline_steps_at(&root, sample_steps()).unwrap();
        assert_eq!(res.appended, 2);
        assert!(res.skipped.is_empty());
        let cfg = read_config_at(&root).config;
        let names: Vec<&str> = cfg.steps.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["初稿", "读文献", "写论文"], "追加在末尾且保序");
        // 追加步骤的字段完整落盘（run/简报随步骤走）
        assert_eq!(cfg.steps[1].workspace_name, "lit-notes");
        assert_eq!(cfg.steps[1].run.len(), 1);
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        assert!(raw.contains("future_top_key = 42"), "未知顶层键丢失: {raw}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn work_mode_roundtrip_default_research_omitted() {
        let dir = temp_dir("work-mode");
        let root = dir.join("proj");
        set_work_mode_at(&root, "coding").unwrap();
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        assert!(raw.contains("work_mode = \"coding\""), "{raw}");
        assert!(
            raw.contains("Mesa 项目档案卡"),
            "新建档案卡必须带勿删文件头: {raw}"
        );
        assert_eq!(read_config_at(&root).config.work_mode, "coding");
        set_work_mode_at(&root, "research").unwrap();
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        assert!(!raw.contains("work_mode"), "{raw}");
        assert_eq!(read_config_at(&root).config.work_mode, "research");
        set_work_mode_at(&root, "nope").unwrap();
        assert_eq!(read_config_at(&root).config.work_mode, "research");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_toml_header_injected_once_and_keeps_user_comments() {
        let config = ProjectConfigDto {
            work_mode: "coding".into(),
            ..ProjectConfigDto::default()
        };
        let first = render_config(None, &config).unwrap();
        assert!(first.contains("Mesa 项目档案卡"), "{first}");
        assert!(first.contains("按「科研」重新分类"), "{first}");
        assert!(first.contains("work_mode = \"coding\""), "{first}");
        assert_eq!(first.matches("Mesa 项目档案卡").count(), 1);
        let second = render_config(Some(&first), &config).unwrap();
        assert_eq!(
            second.matches("Mesa 项目档案卡").count(),
            1,
            "已有文件头不得重复: {second}"
        );
        let custom = "# 用户手写注释\nartifact_dir = \"out\"\n";
        let mixed = render_config(Some(custom), &config).unwrap();
        assert!(mixed.contains("Mesa 项目档案卡"), "{mixed}");
        assert!(mixed.contains("# 用户手写注释"), "{mixed}");
        assert_eq!(mixed.matches("Mesa 项目档案卡").count(), 1);
        let tasks = render_tasks(Some(custom), &[]).unwrap();
        assert!(tasks.contains("Mesa 项目档案卡"), "{tasks}");
        assert!(tasks.contains("# 用户手写注释"), "{tasks}");
        let legacy =
            "# Ccode 项目档案卡（工作方式 / 研究流程 / 资源清单）。\nwork_mode = \"coding\"\n";
        let kept = render_config(Some(legacy), &config).unwrap();
        assert!(
            kept.contains("Ccode 项目档案卡"),
            "旧文件头必须保留: {kept}"
        );
        assert!(
            !kept.contains("Mesa 项目档案卡"),
            "旧文件头不得再插 Mesa 头: {kept}"
        );
    }

    // ===== pipeline_opt_out（「不使用研究流程」显式标记） =====

    #[test]
    fn pipeline_opt_out_roundtrip_and_append_clears_it() {
        let dir = temp_dir("opt-out");
        let root = dir.join("proj");
        // 无 project.toml 起步（已注册项目也允许：write_config_at 会新建）
        set_pipeline_opt_out_at(&root, true).unwrap();
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        assert!(raw.contains("pipeline_opt_out = true"), "{raw}");
        assert!(read_config_at(&root).config.pipeline_opt_out);
        // 清回 false：行移除（false 是缺省，不落盘），未知键保留
        set_pipeline_opt_out_at(&root, false).unwrap();
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        assert!(!raw.contains("pipeline_opt_out"), "{raw}");
        assert!(!read_config_at(&root).config.pipeline_opt_out);
        // 再次置 true 后追加模板步骤：追加成功自动清标记
        set_pipeline_opt_out_at(&root, true).unwrap();
        let res = append_pipeline_steps_at(&root, sample_steps()).unwrap();
        assert_eq!(res.appended, 2);
        assert!(
            !read_config_at(&root).config.pipeline_opt_out,
            "选了模板 = 启用流程，标记必须清掉"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opt_out_clears_steps_keeps_resources() {
        let dir = temp_dir("opt-out-clear-steps");
        let root = dir.join("proj");
        write(
            &config_path(&root),
            "topic = \"旧课题\"\n\n[[resources]]\nname = \"一篇\"\npath = \"papers/a.pdf\"\ntype = \"paper\"\n\n[[steps]]\nname = \"文献精读\"\nworkspace_name = \"lit-notes\"\n",
        );
        set_pipeline_opt_out_at(&root, true).unwrap();
        let cfg = read_config_at(&root).config;
        assert!(cfg.pipeline_opt_out);
        assert!(cfg.steps.is_empty());
        assert_eq!(cfg.topic.as_deref(), Some("旧课题"));
        assert_eq!(cfg.resources.len(), 1);
        assert_eq!(cfg.resources[0].path, "papers/a.pdf");
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        assert!(!raw.contains("[[steps]]"), "{raw}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pipeline_opt_out_preserves_unknown_keys() {
        let dir = temp_dir("opt-out-unknown");
        let root = dir.join("proj");
        write(
            &config_path(&root),
            "artifact_dir = \"outputs\"\nfuture_top_key = 42\n",
        );
        set_pipeline_opt_out_at(&root, true).unwrap();
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        assert!(raw.contains("future_top_key = 42"), "未知顶层键丢失: {raw}");
        assert!(raw.contains("pipeline_opt_out = true"), "{raw}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_steps_skips_name_conflicts_and_renames_workspace_conflicts() {
        let dir = temp_dir("append-skip");
        let root = dir.join("proj");
        let text = "[[steps]]\nname = \"读文献\"\nworkspace_name = \"lit-notes\"\n\n\
                    [[steps]]\nname = \"占位\"\nworkspace_name = \"write\"\n";
        write(&config_path(&root), text);
        let mut batch = sample_steps();
        batch[0].expected_artifacts.clear(); // 「读文献」(lit-notes) + 「写论文」(无 workspace_name)
        batch.push(StepDto {
            name: "换个名字".into(),
            workspace_name: "write".into(), // 与既有步骤 workspace_name 撞车
            ..StepDto::default()
        });
        batch.push(StepDto {
            name: "写论文".into(), // 模板内部重复：撞上刚追加进来的同名步骤
            ..StepDto::default()
        });
        let res = append_pipeline_steps_at(&root, batch).unwrap();
        assert_eq!(
            res.appended, 2,
            "重名步骤跳过，工作区名冲突的步骤应自动追加并改名"
        );
        assert_eq!(
            res.skipped,
            vec!["读文献", "写论文"],
            "只因步骤名撞车跳过，workspace_name 撞车不应丢步骤"
        );
        assert_eq!(res.renamed.len(), 1);
        assert_eq!(res.renamed[0].name, "换个名字");
        assert_eq!(res.renamed[0].from, "write");
        assert_eq!(res.renamed[0].to, "write-2");
        let cfg = read_config_at(&root).config;
        assert_eq!(cfg.steps.len(), 4);
        assert_eq!(cfg.steps[2].name, "写论文");
        assert_eq!(cfg.steps[3].workspace_name, "write-2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_conflicting_contract_fails_without_changing_project() {
        let dir = temp_dir("append-contract");
        let root = dir.join("proj");
        write(
            &config_path(&root),
            "[[steps]]\nname = \"论文初稿\"\nexpected_artifacts = [\"manuscript/draft.md\"]\n",
        );
        let before = fs::read(config_path(&root)).unwrap();
        let result = append_pipeline_steps_at(
            &root,
            vec![StepDto {
                name: "论文初稿".into(),
                expected_artifacts: vec!["manuscript/thesis-draft.md".into()],
                ..StepDto::default()
            }],
        );
        assert!(result.unwrap_err().contains("交付不同"));
        assert_eq!(fs::read(config_path(&root)).unwrap(), before);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn append_steps_all_skipped_leaves_file_untouched() {
        let dir = temp_dir("append-allskip");
        let root = dir.join("proj");
        let text = "[[steps]]\nname = \"文献整理\"\nworkspace_name = \"lit\"\n";
        write(&config_path(&root), text);
        let before = fs::read_to_string(config_path(&root)).unwrap();
        let res = append_pipeline_steps_at(
            &root,
            vec![StepDto {
                name: "文献整理".into(),
                ..StepDto::default()
            }],
        )
        .unwrap();
        assert_eq!(res.appended, 0);
        assert_eq!(res.skipped, vec!["文献整理"]);
        assert_eq!(
            fs::read_to_string(config_path(&root)).unwrap(),
            before,
            "全部跳过时不落盘"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_template_merges_settings_and_topic_without_overwriting_real_answers() {
        let dir = temp_dir("apply-settings");
        let root = dir.join("proj");
        write(
            &config_path(&root),
            "pipeline_opt_out = true\ntopic = \"旧主题\"\nsettings = [\"目标读者：专家\", \"综述角度：（待填写）\"]\n",
        );
        let res = apply_pipeline_template_at(
            &root,
            vec![StepDto {
                name: "新增步骤".into(),
                ..StepDto::default()
            }],
            vec![
                "目标读者：专家/小白".into(),
                "综述角度：机制综述".into(),
                "目标期刊：Nature".into(),
            ],
            "append",
            Some("新主题".into()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(res.appended, 1);
        let cfg = read_config_at(&root).config;
        assert_eq!(cfg.topic.as_deref(), Some("新主题"));
        assert_eq!(
            cfg.settings,
            vec![
                "目标读者：专家".to_string(),
                "综述角度：机制综述".to_string(),
                "目标期刊：Nature".to_string(),
            ]
        );
        assert!(!cfg.pipeline_opt_out);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_template_all_skipped_without_metadata_leaves_opt_out_file_untouched() {
        let dir = temp_dir("apply-allskip-optout");
        let root = dir.join("proj");
        write(
            &config_path(&root),
            "pipeline_opt_out = true\n\n[[steps]]\nname = \"已有步骤\"\n",
        );
        let before = fs::read_to_string(config_path(&root)).unwrap();
        let res = apply_pipeline_template_at(
            &root,
            vec![StepDto {
                name: "已有步骤".into(),
                ..StepDto::default()
            }],
            Vec::new(),
            "append",
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(res.appended, 0);
        assert_eq!(fs::read_to_string(config_path(&root)).unwrap(), before);
        assert!(read_config_at(&root).config.pipeline_opt_out);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn replace_template_normalizes_names_and_workspace_conflicts() {
        let dir = temp_dir("replace-normalize");
        let root = dir.join("proj");
        fs::create_dir_all(&root).unwrap();
        let res = apply_pipeline_template_at(
            &root,
            vec![
                StepDto {
                    name: "  第一步  ".into(),
                    workspace_name: " work ".into(),
                    ..StepDto::default()
                },
                StepDto {
                    name: "第二步".into(),
                    workspace_name: "work".into(),
                    ..StepDto::default()
                },
            ],
            Vec::new(),
            "replace",
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(res.appended, 2);
        assert_eq!(res.renamed[0].to, "work-2");
        let cfg = read_config_at(&root).config;
        assert_eq!(cfg.steps[0].name, "第一步");
        assert_eq!(cfg.steps[0].workspace_name, "work");
        assert_eq!(cfg.steps[1].workspace_name, "work-2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_submission_writes_branch_metadata_atomically_even_when_steps_skip() {
        let dir = temp_dir("append-submission");
        let root = dir.join("proj");
        write(
            &config_path(&root),
            "pipeline_opt_out = true\n\n[[steps]]\nname = \"读文献\"\n\n[[steps]]\nname = \"写论文\"\n",
        );

        // 模板步骤全部因名称重复跳过，但返修分支仍必须在同一次读-改-原子写中生效。
        let mut steps = sample_steps();
        for step in &mut steps {
            step.expected_artifacts.clear();
        }
        let res = append_pipeline_steps_at_with_submission(&root, steps, Some("revision"), Some(0))
            .unwrap();
        assert_eq!(res.appended, 0);
        assert_eq!(res.skipped, vec!["读文献", "写论文"]);

        let cfg = read_config_at(&root).config;
        assert!(!cfg.pipeline_opt_out, "选择返修分支应清掉 opt-out");
        assert_eq!(cfg.submission_mode.as_deref(), Some("revision"));
        assert_eq!(cfg.submission_round, Some(1), "轮次 0 应归一为第 1 轮");
        assert_eq!(cfg.steps.len(), 2, "全跳过时不应重复追加步骤");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_steps_rejects_empty_batch() {
        let dir = temp_dir("append-empty");
        let root = dir.join("proj");
        write(&config_path(&root), "[[steps]]\nname = \"一步\"\n");
        let err = append_pipeline_steps_at(&root, Vec::new()).unwrap_err();
        assert!(err.contains("没有可追加的步骤"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn append_steps_rejects_unregistered_project() {
        let dir = temp_dir("append-unreg");
        let plain = dir.join("plain");
        write(&plain.join("a.txt"), "x");
        // 无 .ccode/project.toml 且未注册 → 写门槛拒绝（查询真实注册表，随机路径必未注册）
        let err = ensure_task_project_root(&plain).unwrap_err();
        assert!(err.contains("不是 Mesa 项目"), "{err}");
        assert!(!config_path(&plain).exists(), "拒绝后不得留下档案卡");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 示例课题（create_demo_at / build_demo_pdf） =====

    #[test]
    fn demo_pdf_xref_offsets_are_valid() {
        let pdf = build_demo_pdf();
        assert!(pdf.starts_with(b"%PDF-1.4\n"), "PDF 魔数头");
        assert!(pdf.ends_with(b"%%EOF\n"), "EOF 收尾");
        // 全 ASCII：字节偏移可直接按文本解析
        let text = String::from_utf8(pdf.clone()).unwrap();
        let sx = text.rfind("startxref").expect("缺 startxref");
        let xref_pos: usize = text[sx..].lines().nth(1).unwrap().trim().parse().unwrap();
        assert_eq!(
            &pdf[xref_pos..xref_pos + 4],
            b"xref",
            "startxref 必须指向 xref 表"
        );
        // 逐条 n 项的偏移必须精确指向 "N 0 obj"
        let xref = &text[xref_pos..];
        let entries: Vec<&str> = xref.lines().skip(2).take(6).collect();
        assert_eq!(entries.len(), 6, "xref 应有 0..=5 共 6 项");
        assert!(entries[0].ends_with(" f "), "0 号为 free 项");
        for (i, entry) in entries.iter().enumerate().skip(1) {
            // lines() 不含换行符：19 字符 + LF = 固定的 20 字节 xref 项
            assert_eq!(entry.len(), 19, "xref 项固定 20 字节（含 LF）: {entry:?}");
            let off: usize = entry[..10].trim().parse().unwrap();
            assert!(
                pdf[off..].starts_with(format!("{i} 0 obj").as_bytes()),
                "对象 {i} 的 xref 偏移错位"
            );
        }
        assert!(text.contains("trailer\n<< /Size 6 /Root 1 0 R >>"));
    }

    #[test]
    fn create_demo_flow_and_idempotency() {
        if crate::agents::resolve_binary("git").is_none() {
            eprintln!("测试环境无 git，跳过 create_demo 用例");
            return;
        }
        let dir = temp_dir("demo");
        let conn = db_at(&dir.join("app.db")).unwrap();
        let base = dir.join("documents");
        let root = base.join(DEMO_DIR_NAME);

        let p = create_demo_at(&base, &conn).unwrap();
        assert_eq!(p.name, DEMO_PROJECT_NAME);
        assert!(root.join(DEMO_PDF_REL).exists());
        assert!(root.join("notes").is_dir());
        assert!(root.join("references.bib").exists());
        assert!(root.join("README.md").exists());
        let included: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join("papers/included.json")).unwrap())
                .unwrap();
        assert_eq!(included[0]["id"], "leader-2016-demo");
        assert_eq!(included[0]["fulltextStatus"], "demo-only");
        let pdf = fs::read(root.join(DEMO_PDF_REL)).unwrap();
        assert!(
            pdf.starts_with(b"%PDF-") && pdf.ends_with(b"%%EOF\n"),
            "PDF 结构完整"
        );
        // 档案卡 = 当前英文综述模板 + 检索步 seed_complete；不另写一套旧简报
        let text = fs::read_to_string(config_path(&root)).unwrap();
        let (config, _) = parse_config(&text);
        let canon = demo_review_template();
        assert_eq!(
            config.topic.as_deref(),
            Some("GLP-1 受体激动剂的心血管结局（演示课题）")
        );
        assert_eq!(config.steps.len(), canon.steps.len());
        assert_eq!(config.steps[0].workspace_name, "lit-search");
        assert_eq!(
            config.steps[0].skills, canon.steps[0].skills,
            "检索步技能应与英文综述模板一致"
        );
        assert!(config.steps[0].seed_complete);
        assert_eq!(config.steps[0].brief, canon.steps[0].brief);
        assert_eq!(
            config.steps[1].skills, canon.steps[1].skills,
            "精读步技能应与英文综述模板一致"
        );
        assert_eq!(config.steps[1].brief, canon.steps[1].brief);
        assert_eq!(config.steps[3].run.len(), canon.steps[3].run.len());
        assert_eq!(config.steps[4].workspace_name, "polish");
        assert_eq!(config.resources.len(), 2);
        assert!(git_has_head(&root), "bootstrap 应已产生初始提交");
        let cards = task_cards_at(&root);
        assert_eq!(cards.len(), 1, "示例课题应预置一张演示卡片");
        let demo_card = &cards[0];
        assert_eq!(demo_card.name, "示例：开读这一篇");
        assert_eq!(demo_card.step.as_deref(), Some("文献精读与笔记"));
        let draft_text = fs::read_to_string(root.join(".ccode/drafts/lit-notes.md")).unwrap();
        assert!(
            draft_text.starts_with("# 任务书草稿：文献精读与笔记"),
            "{draft_text}"
        );
        for marker in ["想法期讨论沉淀（示范）", "开读这一篇", "综述大纲"] {
            assert!(draft_text.contains(marker), "示范草稿缺内容: {marker}");
        }
        assert!(
            config.steps[0]
                .human_tasks
                .iter()
                .any(|h| h.title.contains("下载付费墙文献全文")),
            "检索步应保留模板的付费墙事项: {:?}",
            config.steps[0].human_tasks
        );

        // 幂等：二次调用返回同一项目，且不覆盖用户改过的内容
        write(&root.join("README.md"), "user edit");
        write(&root.join("papers/included.json"), "user supplied records");
        let p2 = create_demo_at(&base, &conn).unwrap();
        assert_eq!(p2.path, p.path);
        assert_eq!(
            fs::read_to_string(root.join("papers/included.json")).unwrap(),
            "user supplied records"
        );
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "user edit"
        );
        assert_eq!(
            task_cards_at(&root).len(),
            1,
            "幂等路径不得重复播种演示卡片"
        );

        // 目录已存在但未注册：档案卡跟当前模板，缺的演示文件才补，已有 README 不动
        remove_project_at(&conn, &root).unwrap();
        fs::remove_file(root.join("references.bib")).unwrap();
        write(
            &config_path(&root),
            "topic = \"旧演示\"\n[[steps]]\nname = \"旧步骤\"\nworkspace_name = \"old\"\nbrief = \"过期简报\"\n",
        );
        let p3 = create_demo_at(&base, &conn).unwrap();
        assert_eq!(p3.path, p.path);
        assert!(root.join("references.bib").exists(), "缺的演示文件应补回");
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "user edit",
            "已有 README 不得覆盖"
        );
        let text = fs::read_to_string(config_path(&root)).unwrap();
        let (config, _) = parse_config(&text);
        assert_eq!(config.steps.len(), canon.steps.len());
        assert_eq!(config.steps[0].brief, canon.steps[0].brief);
        assert!(config.steps[0].seed_complete);
        assert_eq!(task_cards_at(&root).len(), 1, "已有演示卡片不得重复播种");

        // 只有旧目录名时继续用它，不在旁边再造「Mesa 示例课题」
        remove_project_at(&conn, &root).unwrap();
        let legacy = base.join(DEMO_DIR_NAME_LEGACY);
        std::fs::rename(&root, &legacy).unwrap();
        let p4 = create_demo_at(&base, &conn).unwrap();
        assert!(
            Path::new(&p4.path).ends_with(DEMO_DIR_NAME_LEGACY),
            "应继续用旧目录，实际 {}",
            p4.path
        );
        assert!(!root.exists(), "旧目录还在时不得另建新目录");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_project_dir_removes_dir_and_registration() {
        let dir = temp_dir("deldir");
        let conn = db_at(&dir.join("app.db")).unwrap();
        let root = dir.join("demo-proj");
        write(&config_path(&root), "artifact_dir = \"artifacts\"\n");
        write(&root.join("notes/x.md"), "x");
        register_at(&conn, &root, "演示", "2026-08-01T00:00:00Z").unwrap();

        let msg = delete_project_dir_impl(&conn, &root).unwrap();
        assert_eq!(msg, "目录已移入回收站，注册记录已删除");
        assert!(!root.exists(), "目录应已移入回收站（原位不再存在）");
        assert!(!is_registered_at(&conn, &root), "注册记录应被移除");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_project_dir_rejects_non_project() {
        let dir = temp_dir("deldir-nonproj");
        let conn = db_at(&dir.join("app.db")).unwrap();
        // 普通目录：无 project.toml、未注册、无工作区 → 拒绝且目录原样保留
        let plain = dir.join("plain");
        write(&plain.join("a.txt"), "x");
        let err = delete_project_dir_impl(&conn, &plain).unwrap_err();
        assert!(err.contains("不是 Mesa 项目"), "{err}");
        assert!(plain.join("a.txt").exists());
        // 不存在的路径：降级为只清库（该项目未注册、无工作区时等于摘注册空操作）
        let gone = dir.join("missing");
        let msg_gone = delete_project_dir_impl(&conn, &gone).unwrap();
        assert!(
            msg_gone.contains("已不在磁盘上"),
            "缺失目录应降级清理: {msg_gone}"
        );
        // 文件而非目录
        let f = dir.join("file.txt");
        write(&f, "x");
        let err3 = delete_project_dir_impl(&conn, &f).unwrap_err();
        assert!(err3.contains("不是目录"), "{err3}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_project_dir_missing_dir_cleans_registration_and_workspaces() {
        let dir = temp_dir("deldir-gone");
        let conn = db_at(&dir.join("app.db")).unwrap();
        let root = dir.join("demo-proj");
        write(&config_path(&root), "artifact_dir = \"artifacts\"\n");
        register_at(&conn, &root, "演示", "2026-08-01T00:00:00Z").unwrap();
        crate::workspaces::workspaces_of_repo(&conn, &root).unwrap(); // 建表
        conn.execute(
            "INSERT INTO workspaces(id, repo_path, name, branch, worktree_path, base_branch, port_base, status, created_at)
             VALUES('w1', ?1, 'lit', 'ccode/lit', ?2, 'main', 4000, 'active', '2026-08-01T00:00:00Z')",
            params![
                root.to_string_lossy().into_owned(),
                dir.join("wt-missing").to_string_lossy().into_owned()
            ],
        )
        .unwrap();
        // 用户在 Finder 里手动删掉项目目录后再来 Mesa 删除：不再报 os error 2，降级只清库
        fs::remove_dir_all(&root).unwrap();

        let msg = delete_project_dir_impl(&conn, &root).unwrap();
        assert_eq!(
            msg,
            "项目目录已不在磁盘上，无法删除目录本身；已移除：注册记录、1 个工作区记录"
        );
        assert!(!is_registered_at(&conn, &root), "注册记录应被移除");
        assert!(
            crate::workspaces::workspaces_of_repo(&conn, &root)
                .unwrap()
                .is_empty(),
            "工作区记录应被清空"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn purge_traces_missing_dir_cleans_registration() {
        let dir = temp_dir("purge-gone");
        let conn = db_at(&dir.join("app.db")).unwrap();
        let root = dir.join("demo-proj");
        write(&config_path(&root), "artifact_dir = \"artifacts\"\n");
        register_at(&conn, &root, "演示", "2026-08-01T00:00:00Z").unwrap();
        fs::remove_dir_all(&root).unwrap();

        let msg = purge_project_traces_impl(&conn, &root).unwrap();
        assert!(msg.contains("已不在磁盘上"), "{msg}");
        assert!(!is_registered_at(&conn, &root));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 清除 Mesa 痕迹（purge_project_traces，中间档：保留文件夹与用户文件） =====

    #[test]
    fn purge_traces_removes_ccode_registration_and_workspace_but_keeps_user_files() {
        let dir = temp_dir("purge");
        let conn = db_at(&dir.join("app.db")).unwrap();
        let root = dir.join("demo-proj");
        write(&config_path(&root), "artifact_dir = \"artifacts\"\n");
        write(&root.join(".ccode/brief-20260801T100000Z.md"), "# 简报");
        write(&root.join("notes/x.md"), "用户文件");
        register_at(&conn, &root, "演示", "2026-08-01T00:00:00Z").unwrap();
        // 一条工作区记录（worktree 不存在、目录非 git 仓库也能走删除实现：两者都按缺失容忍）
        crate::workspaces::workspaces_of_repo(&conn, &root).unwrap(); // 顺带建表
        conn.execute(
            "INSERT INTO workspaces(id, repo_path, name, branch, worktree_path, base_branch, port_base, status, created_at)
             VALUES('w1', ?1, 'lit', 'ccode/lit', ?2, 'main', 4000, 'active', '2026-08-01T00:00:00Z')",
            params![
                root.canonicalize().unwrap().to_string_lossy().into_owned(),
                dir.join("wt-missing").to_string_lossy().into_owned()
            ],
        )
        .unwrap();

        let msg = purge_project_traces_impl(&conn, &root).unwrap();
        assert_eq!(msg, "已清除：1 个工作区、档案卡与简报（回收站）、注册记录");
        assert!(root.is_dir(), "项目文件夹必须保留");
        assert_eq!(
            fs::read_to_string(root.join("notes/x.md")).unwrap(),
            "用户文件",
            "用户文件原样保留"
        );
        assert!(!root.join(".ccode").exists(), ".ccode 应已移入回收站");
        assert!(!is_registered_at(&conn, &root), "注册记录应被移除");
        assert!(
            crate::workspaces::workspaces_of_repo(&conn, &root)
                .unwrap()
                .is_empty(),
            "工作区记录应被清空"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn purge_traces_rejects_dir_without_traces() {
        let dir = temp_dir("purge-empty");
        let conn = db_at(&dir.join("app.db")).unwrap();
        // 无 .ccode、无注册、无工作区 → 报错且目录原样保留
        let plain = dir.join("plain");
        write(&plain.join("a.txt"), "x");
        let err = purge_project_traces_impl(&conn, &plain).unwrap_err();
        assert!(err.contains("没有 Mesa 痕迹"), "{err}");
        assert!(plain.join("a.txt").exists());
        // 防护：home 本身拒绝（复用 guard_project_dir 口径）
        let home = dirs::home_dir().unwrap();
        assert!(purge_project_traces_impl(&conn, &home).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn purge_traces_tolerates_unregistered() {
        let dir = temp_dir("purge-unreg");
        let conn = db_at(&dir.join("app.db")).unwrap();
        let root = dir.join("proj");
        // 只有 .ccode、未注册：照样清，摘注册容忍未注册
        write(&config_path(&root), "artifact_dir = \"artifacts\"\n");
        let msg = purge_project_traces_impl(&conn, &root).unwrap();
        assert_eq!(msg, "已清除：档案卡与简报（回收站）");
        assert!(!root.join(".ccode").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 步骤推荐技能写回（update_step_skills，v3.67） =====

    #[test]
    fn update_step_skills_writes_only_skills_and_preserves_rest() {
        let dir = temp_dir("stepskills");
        let root = dir.join("proj");
        let text = "artifact_dir = \"outputs\"\nfuture_top_key = 42\n\n\
                    [[steps]]\nname = \"文献整理\"\nworkspace_name = \"lit\"\nbrief = \"读文献写笔记\"\nskills = [\"paper-notes\"]\n\n\
                    [[steps]]\nname = \"写作\"\nworkspace_name = \"write\"\n";
        write(&config_path(&root), text);
        // 归一：去空白、保序去重
        update_step_skills_at(
            &root,
            "文献整理",
            vec![
                " lit-search ".into(),
                "paper-notes".into(),
                "lit-search".into(),
            ],
        )
        .unwrap();
        let cfg = read_config_at(&root).config;
        assert_eq!(cfg.steps[0].skills, vec!["lit-search", "paper-notes"]);
        // 其余字段与步骤原样；未知顶层键保留（render_config 口径）
        assert_eq!(cfg.steps[0].brief, "读文献写笔记");
        assert_eq!(cfg.steps[1].name, "写作");
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        assert!(raw.contains("future_top_key = 42"), "未知键丢失: {raw}");
        // 步骤不存在 → 报错，文件不动
        let before = fs::read_to_string(config_path(&root)).unwrap();
        let err = update_step_skills_at(&root, "没有这步", vec![]).unwrap_err();
        assert!(err.contains("步骤不存在"), "{err}");
        assert_eq!(fs::read_to_string(config_path(&root)).unwrap(), before);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 人工事项（steps[].human_tasks）解析/写回 =====

    #[test]
    fn cleanup_project_db_traces_removes_orphans() {
        // 这个 bug 的特征是「删完当场看不出问题」——下次在同路径建项目才发作
        // （继承上个项目的勾选状态），所以必须有测试盯着
        let dir = temp_dir("orphans");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE human_task_checks(project_path TEXT NOT NULL, step TEXT NOT NULL, \
               title TEXT NOT NULL, updated_at TEXT, PRIMARY KEY(project_path, step, title));\
             CREATE TABLE card_claims(agent TEXT NOT NULL, cwd TEXT NOT NULL, \
               task_id TEXT NOT NULL, created_at TEXT, PRIMARY KEY(agent, cwd));\
             CREATE TABLE session_meta(agent TEXT NOT NULL, session_id TEXT NOT NULL, \
               task_id TEXT, PRIMARY KEY(agent, session_id));",
        )
        .unwrap();
        let key = canonical_key(&root);
        conn.execute(
            "INSERT INTO human_task_checks VALUES (?1,'检索筛选','补文献','t')",
            rusqlite::params![key],
        )
        .unwrap();
        // 别的项目的行必须原样留着
        conn.execute(
            "INSERT INTO human_task_checks VALUES ('/other/proj','检索筛选','补文献','t')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO card_claims VALUES ('claude-code',?1,'t-abc','t')",
            rusqlite::params![key],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_meta VALUES ('claude-code','s1','t-abc')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_meta VALUES ('claude-code','s2','t-other')",
            [],
        )
        .unwrap();

        let (cleaned, warn) = cleanup_project_db_traces(&conn, &root, &["t-abc".to_string()]);
        assert!(warn.is_empty(), "{warn:?}");
        assert_eq!(cleaned, 3, "勾选 1 + 认领 1 + 归卡 1");

        let mine: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM human_task_checks WHERE project_path=?1",
                rusqlite::params![key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mine, 0, "本项目的勾选记录应清空");
        let others: i64 = conn
            .query_row("SELECT COUNT(*) FROM human_task_checks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(others, 1, "别的项目的勾选记录不该被误删");
        let claims: i64 = conn
            .query_row("SELECT COUNT(*) FROM card_claims", [], |r| r.get(0))
            .unwrap();
        assert_eq!(claims, 0);
        let cleared: Option<String> = conn
            .query_row(
                "SELECT task_id FROM session_meta WHERE session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cleared, None, "本项目卡片的归卡标记应清掉");
        let kept: Option<String> = conn
            .query_row(
                "SELECT task_id FROM session_meta WHERE session_id='s2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept.as_deref(), Some("t-other"), "别的卡片不该被动");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cleanup_tolerates_lazily_created_tables() {
        // 三张表都是懒建的：用户从没勾过人工事项时表根本不存在。
        // 这时 DELETE 会报 no such table——当成「没有痕迹」而不是错误，
        // 否则新用户第一次删项目就会看到一条莫名其妙的「清理失败」
        let dir = temp_dir("lazytables");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        let (cleaned, warn) = cleanup_project_db_traces(&conn, &root, &["t-abc".to_string()]);
        assert_eq!(cleaned, 0);
        assert!(warn.is_empty(), "表不存在不该报错: {warn:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lit_source_parse_render_roundtrip() {
        let dir = temp_dir("litsource");
        let root = dir.join("proj");
        // 合法值原样保留
        let (cfg, w) = parse_config("lit_source = \"zotero\"\n");
        assert_eq!(cfg.lit_source, "zotero");
        assert!(w.is_empty(), "{w:?}");
        write(&config_path(&root), "x = 1\n");
        write_config_at(&root, &cfg).unwrap();
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        assert!(raw.contains("lit_source"), "{raw}");
        assert_eq!(parse_config(&raw).0.lit_source, "zotero");

        // 缺省 = search，且默认值不写进文件（同 pipeline_opt_out 口径）
        let (d, _) = parse_config("");
        assert_eq!(d.lit_source, "search");
        write_config_at(&root, &d).unwrap();
        let raw2 = fs::read_to_string(config_path(&root)).unwrap();
        assert!(!raw2.contains("lit_source"), "默认值不该落盘: {raw2}");

        // zotero / endnote / folder 都是合法来源（已有文献盘点）；真非法值归一为 search 并留 warning
        let (ok2, _) = parse_config("lit_source = \"endnote\"\n");
        assert_eq!(ok2.lit_source, "endnote");
        let (bad, wb) = parse_config("lit_source = \"wos\"\nartifact_dir = \"out\"\n");
        assert_eq!(bad.lit_source, "search");
        assert_eq!(bad.artifact_dir, "out", "坏字段不该带垮其余解析");
        assert!(wb.iter().any(|x| x.contains("lit_source")), "{wb:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn inputs_and_submission_branch_round_trip() {
        let text = r#"submission_mode = "revision"
submission_round = 2

[[steps]]
name = "第 2 轮返修"
workspace_name = "rebuttal-r2"
inputs = ["reviews/round-2.md", "manuscript/revised-r1.md"]
optional_inputs = ["supplementary.csv"]
any_of_inputs = [["manuscript/paper-final.md", "manuscript/review-final.md"]]
"#;
        let (cfg, warnings) = parse_config(text);
        assert!(
            warnings.is_empty(),
            "合法输入/投稿字段不应告警: {warnings:?}"
        );
        assert_eq!(cfg.submission_mode.as_deref(), Some("revision"));
        assert_eq!(cfg.submission_round, Some(2));
        assert_eq!(
            cfg.steps[0].inputs,
            vec!["reviews/round-2.md", "manuscript/revised-r1.md"]
        );
        assert_eq!(cfg.steps[0].optional_inputs, vec!["supplementary.csv"]);
        assert_eq!(
            cfg.steps[0].any_of_inputs,
            vec![vec![
                "manuscript/paper-final.md".to_string(),
                "manuscript/review-final.md".to_string()
            ]]
        );
        let rendered = render_config(Some(text), &cfg).unwrap();
        let (back, back_warnings) = parse_config(&rendered);
        assert!(back_warnings.is_empty(), "回读不应告警: {back_warnings:?}");
        assert_eq!(back, cfg);
        assert!(rendered.contains("submission_mode = \"revision\""));
        assert!(rendered.contains("submission_round = 2"));
    }

    #[test]
    fn project_settings_merge_keeps_answers_and_replaces_placeholders() {
        let mut existing = vec![
            "目标篇幅：6000-8000 词".into(),
            "读者与文风：（偏同行专家 / 偏入门科普）".into(),
        ];
        merge_project_settings(
            &mut existing,
            &[
                "目标篇幅：（如 5000 词）".into(),
                "读者与文风：偏入门科普".into(),
                "去向：（投期刊 / 课程作业）".into(),
            ],
        );
        assert_eq!(existing[0], "目标篇幅：6000-8000 词");
        assert_eq!(existing[1], "读者与文风：偏入门科普");
        assert_eq!(existing[2], "去向：（投期刊 / 课程作业）");
        assert_eq!(existing.len(), 3);
    }

    #[test]
    fn first_step_external_inputs_do_not_create_noise_but_later_missing_inputs_warn() {
        let first = StepDto {
            name: "入口".into(),
            inputs: vec!["upstream/notes/".into(), "analysis-report.md".into()],
            ..StepDto::default()
        };
        assert!(
            validate_step(&first, &[], &[], true).is_empty(),
            "第一步输入可来自上游项目/外部资源，不应制造不可行动警告"
        );
        let later = StepDto {
            name: "后续".into(),
            inputs: vec!["missing/result.md".into()],
            ..StepDto::default()
        };
        let warnings = validate_step(&later, &[], &["previous.md".into()], false);
        assert_eq!(warnings.len(), 1, "后续步骤缺失输入仍应提示: {warnings:?}");
        let warnings = validate_step(&later, &[], &[], false);
        assert_eq!(
            warnings.len(),
            1,
            "即使前一步没有声明产物，后续步骤缺失输入也应提示: {warnings:?}"
        );
    }

    #[test]
    fn review_template_steps_survive_serialization() {
        let dir = temp_dir("review-quality-gate");
        let cfg = demo_project_config();
        write_config_at(&dir, &cfg).unwrap();
        let restored = read_config_at(&dir).config;
        let draft = restored
            .steps
            .iter()
            .find(|s| s.workspace_name == "draft")
            .unwrap();
        // 模板已去掉 draft 步开工前的 hard_pause 质量门槛与决策问题：
        // 范围由人在审阅初稿时拍板，序列化往返后保持 auto_continue 且无决策问题
        assert_eq!(draft.decision_mode, "auto_continue");
        assert!(draft.decisions.is_empty());
        assert!(restored.steps[1]
            .inputs
            .iter()
            .any(|s| s == "papers/included.json"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn decisions_parse_render_roundtrip() {
        let dir = temp_dir("decisions");
        let root = dir.join("proj");
        // 同一步骤里 decisions（表数组）与 discussion_seeds（内联数组）并存：
        // 渲染顺序必须仍是合法 toml，否则 seeds 会被吸进最后一个 decisions 表
        let text = "[[steps]]\nname = \"检索筛选\"\nworkspace_name = \"lit\"\n\
                    discussion_seeds = [\"范式锚点：借哪篇的结构？\"]\n\n\
                    [[steps.decisions]]\nq = \"综述角度怎么收\"\n\
                    options = [\"领域全景铺开\", \" 聚焦某个子问题 \", \"  \"]\n\n\
                    [[steps.decisions]]\nq = \"  \"\noptions = [\"甲\"]\n\n\
                    [[steps.decisions]]\nq = \"没有选项的题\"\noptions = []\n";
        write(&config_path(&root), text);
        let (cfg, warnings) = parse_config(text);
        // 非空问题都保留；无选项表示需手写依据，空问题仍丢弃。
        assert_eq!(
            cfg.steps[0].decisions.len(),
            2,
            "{:?}",
            cfg.steps[0].decisions
        );
        assert_eq!(cfg.steps[0].decisions[0].q, "综述角度怎么收");
        assert_eq!(
            cfg.steps[0].decisions[0].options,
            vec!["领域全景铺开", "聚焦某个子问题"]
        );
        assert_eq!(cfg.steps[0].decisions[1].q, "没有选项的题");
        assert!(cfg.steps[0].decisions[1].options.is_empty());
        // 讨论种子与待填依据互不影响
        assert_eq!(
            cfg.steps[0].discussion_seeds,
            vec!["范式锚点：借哪篇的结构？"]
        );
        // 写回再读：两个字段都原样回来（证明并存时的 toml 结构合法）
        write_config_at(&root, &cfg).unwrap();
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        let (cfg2, w2) = parse_config(&raw);
        assert_eq!(cfg2.steps[0].decisions, cfg.steps[0].decisions, "{raw}");
        assert_eq!(
            cfg2.steps[0].discussion_seeds, cfg.steps[0].discussion_seeds,
            "{raw}"
        );
        assert!(raw.contains("[[steps.decisions]]"), "{raw}");
        assert!(w2.is_empty(), "{w2:?}");
        assert!(warnings.is_empty(), "{warnings:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn asks_lit_source_round_trips_and_defaults_false() {
        let dir = temp_dir("asks-lit");
        let root = dir.join("proj");
        // 缺省不写这一行 → 解析为 false，渲染后也不该冒出来（档案卡保持简洁）
        let plain = "[[steps]]\nname = \"检索\"\nworkspace_name = \"lit\"\n";
        let (cfg0, w0) = parse_config(plain);
        assert!(!cfg0.steps[0].asks_lit_source);
        assert!(w0.is_empty(), "{w0:?}");
        write(&config_path(&root), plain);
        write_config_at(&root, &cfg0).unwrap();
        let raw0 = fs::read_to_string(config_path(&root)).unwrap();
        assert!(!raw0.contains("asks_lit_source"), "{raw0}");

        // 声明为 true → 解析出来，写回后仍在（漏了透传会让编辑器一保存就把声明抹掉，
        // 与 human_tasks.optional 同一类静默丢失）
        let text = "[[steps]]\nname = \"检索\"\nworkspace_name = \"lit\"\n\
                    asks_lit_source = true\n";
        write(&config_path(&root), text);
        let (cfg, warnings) = parse_config(text);
        assert!(cfg.steps[0].asks_lit_source);
        assert!(warnings.is_empty(), "{warnings:?}");
        write_config_at(&root, &cfg).unwrap();
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        let (cfg2, w2) = parse_config(&raw);
        assert!(cfg2.steps[0].asks_lit_source, "{raw}");
        assert!(w2.is_empty(), "{w2:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn seed_complete_round_trips_and_defaults_false() {
        let dir = temp_dir("seed-complete");
        let root = dir.join("proj");
        let plain = "[[steps]]\nname = \"检索\"\nworkspace_name = \"lit\"\n";
        let (cfg0, w0) = parse_config(plain);
        assert!(!cfg0.steps[0].seed_complete);
        assert!(w0.is_empty(), "{w0:?}");
        write(&config_path(&root), plain);
        write_config_at(&root, &cfg0).unwrap();
        let raw0 = fs::read_to_string(config_path(&root)).unwrap();
        assert!(!raw0.contains("seed_complete"), "{raw0}");

        let text = "[[steps]]\nname = \"检索\"\nworkspace_name = \"lit\"\n\
                    seed_complete = true\n";
        let (cfg, warnings) = parse_config(text);
        assert!(cfg.steps[0].seed_complete);
        assert!(warnings.is_empty(), "{warnings:?}");
        write_config_at(&root, &cfg).unwrap();
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        let (cfg2, w2) = parse_config(&raw);
        assert!(cfg2.steps[0].seed_complete, "{raw}");
        assert!(w2.is_empty(), "{w2:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn inspect_step_inputs_counts_included_lines_and_notes() {
        let dir = temp_dir("inspect-inputs");
        let root = dir.join("proj");
        fs::create_dir_all(root.join("papers")).unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(
            root.join("papers/included.md"),
            "# skip\nPaper A — a, 2020 — j — doi\nPaper B — b, 2021 — j — doi\n",
        )
        .unwrap();
        fs::write(root.join("notes/a.md"), b"n1").unwrap();
        fs::write(root.join("notes/b.md"), b"n2").unwrap();
        let cfg = ProjectConfigDto {
            steps: vec![StepDto {
                name: "精读".into(),
                workspace_name: "lit-notes".into(),
                inputs: vec!["papers/included.md".into(), "notes/*.md".into()],
                optional_inputs: vec!["outline.md".into()],
                ..StepDto::default()
            }],
            ..ProjectConfigDto::default()
        };
        write_config_at(&root, &cfg).unwrap();
        let chips = inspect_step_inputs_at(&root, "精读").unwrap();
        let included = chips
            .iter()
            .find(|c| c.pattern.ends_with("included.md"))
            .unwrap();
        assert_eq!(included.count, 2);
        assert!(included.present);
        let notes = chips.iter().find(|c| c.pattern.contains("notes")).unwrap();
        assert_eq!(notes.count, 2);
        let missing = chips.iter().find(|c| c.pattern == "outline.md").unwrap();
        assert!(!missing.present);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn human_tasks_parse_render_roundtrip() {
        let dir = temp_dir("humantasks");
        let root = dir.join("proj");
        let text = "[[steps]]\nname = \"检索筛选\"\nworkspace_name = \"lit\"\n\
                    discussion_seeds = [\"角度怎么收？\", \"  \", \"检索哪几个库？\"]\n\n\
                    [[steps.human_tasks]]\ntitle = \"下载付费文献\"\nguidance = \"渠道自选\"\n\
                    target = \"papers/*.pdf\"\ntiming = \"after\"\n\n\
                    [[steps.human_tasks]]\ntitle = \"补充已知文献\"\ntarget = \"papers/\"\n\n\
                    [[steps]]\nname = \"写作\"\n";
        write(&config_path(&root), text);
        let (cfg, warnings) = parse_config(text);
        assert_eq!(
            cfg.steps[0].human_tasks.len(),
            2,
            "{:?}",
            cfg.steps[0].human_tasks
        );
        // 讨论种子：去空白、空项剔除
        assert_eq!(
            cfg.steps[0].discussion_seeds,
            vec!["角度怎么收？", "检索哪几个库？"]
        );
        let h0 = &cfg.steps[0].human_tasks[0];
        assert_eq!(h0.title, "下载付费文献");
        assert_eq!(h0.target, "papers/*.pdf");
        assert_eq!(h0.timing, "after");
        // 缺省 timing = during
        assert_eq!(cfg.steps[0].human_tasks[1].timing, "during");
        // 写回再读：内容不变；during 与空字段省略不写
        write_config_at(&root, &cfg).unwrap();
        let raw = fs::read_to_string(config_path(&root)).unwrap();
        let (cfg2, _) = parse_config(&raw);
        assert_eq!(cfg2.steps[0].human_tasks, cfg.steps[0].human_tasks);
        assert_eq!(
            cfg2.steps[0].discussion_seeds,
            cfg.steps[0].discussion_seeds
        );
        assert!(raw.contains("[[steps.human_tasks]]"), "{raw}");
        assert!(raw.contains("discussion_seeds"), "{raw}");
        assert!(!raw.contains("during"), "默认时机省略不写: {raw}");
        assert!(warnings.is_empty(), "{warnings:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn human_tasks_bad_entries_tolerated() {
        // 空标题跳过、非法时机归一 during 并告警、无 human_tasks 段的步骤不受影响
        let text = "[[steps]]\nname = \"检索\"\n\n\
                    [[steps.human_tasks]]\ntitle = \"  \"\n\n\
                    [[steps.human_tasks]]\ntitle = \"下载全文\"\ntiming = \"whenever\"\n";
        let (cfg, warnings) = parse_config(text);
        assert_eq!(cfg.steps[0].human_tasks.len(), 1);
        assert_eq!(cfg.steps[0].human_tasks[0].timing, "during");
        assert!(
            warnings.iter().any(|w| w.contains("标题为空")),
            "{warnings:?}"
        );
        assert!(
            warnings.iter().any(|w| w.contains("whenever")),
            "{warnings:?}"
        );
    }

    // ===== 任务书草稿（v3.72） =====

    #[test]
    fn draft_rel_path_prefers_workspace_name() {
        assert_eq!(
            draft_rel_path("文献检索与筛选", "lit-search"),
            ".ccode/drafts/lit-search.md"
        );
        // 无工作区名回落步骤名，不安全字符替换为 -
        assert_eq!(
            draft_rel_path("综述 大纲/初稿", ""),
            ".ccode/drafts/综述-大纲-初稿.md"
        );
        // 回归：注释曾写「workspace_name 已 sanitize」，实际写入链路全程原样落 TOML，
        // 而它来自裸输入框。含 Windows 非法字符时落盘 os error 123，
        // 「聊想法 / 评审沉淀 / 融合进任务书」在该步骤永久不可用。
        assert_eq!(
            draft_rel_path("步骤", "draft:v2"),
            ".ccode/drafts/draft-v2.md"
        );
        assert_eq!(draft_rel_path("步骤", "方案?"), ".ccode/drafts/方案-.md");
        // 路径逃逸（这条 macOS 同样中招）：不锚定 - 的个数，只断言逃不出 drafts 目录
        let escaped = draft_rel_path("步骤", "../../../evil");
        assert!(
            escaped.starts_with(".ccode/drafts/") && !escaped.contains(".."),
            "{escaped}"
        );
        assert_eq!(
            escaped.matches('/').count(),
            2,
            "不得多出目录层级: {escaped}"
        );
        // 保留设备名：拼出的 .ccode/drafts/CON.md 在 Windows 上是设备而非文件
        assert_eq!(draft_rel_path("步骤", "CON"), ".ccode/drafts/CON-.md");
    }

    #[test]
    fn append_step_draft_creates_then_appends() {
        let dir = temp_dir("draft");
        let root = dir.join("proj");
        write(
            &config_path(&root),
            "[[steps]]\nname = \"检索筛选\"\nworkspace_name = \"lit\"\n",
        );
        // 草稿不存在 → 以标题头新建
        let rel = append_step_draft_at(&root, "检索筛选", "上一步评审沉淀", "结论 A 保留").unwrap();
        assert_eq!(rel, ".ccode/drafts/lit.md");
        let text = fs::read_to_string(root.join(&rel)).unwrap();
        assert!(text.starts_with("# 任务书草稿：检索筛选"), "{text}");
        assert!(text.contains("## 上一步评审沉淀"), "{text}");
        assert!(text.contains("结论 A 保留"), "{text}");
        // 再次追加：原有内容保留，新小节在后
        append_step_draft_at(&root, "检索筛选", "二次沉淀", "结论 B").unwrap();
        let text = fs::read_to_string(root.join(&rel)).unwrap();
        assert!(
            text.contains("结论 A 保留") && text.contains("结论 B"),
            "{text}"
        );
        assert!(text.find("结论 A 保留") < text.find("结论 B"), "追加保序");
        // 步骤不存在报错
        assert!(append_step_draft_at(&root, "没有这步", "x", "y").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_project_dir_rejects_home_and_shallow() {
        let dir = temp_dir("deldir-guard");
        // home 与文档目录本身一律拒绝
        let home = dirs::home_dir().unwrap();
        let err = guard_project_dir(&home).unwrap_err();
        assert!(err.contains("主目录"), "{err}");
        // 回归：Windows 上 canonicalize 带 `\\?\` 前缀，两侧口径不一致会让这道闸静默失效。
        // 两种写法都必须拦下（生产调用方传的正是 canonicalize 后的形式）。
        if let Ok(home_c) = std::fs::canonicalize(&home) {
            let err = guard_project_dir(&home_c).unwrap_err();
            assert!(err.contains("主目录"), "canonicalize 形式也必须拦下: {err}");
        }
        if let Some(docs) = dirs::document_dir() {
            let err = guard_project_dir(&docs).unwrap_err();
            assert!(err.contains("文档目录"), "{err}");
        }
        // 浅层路径：文件系统根（零有效段）拒绝
        #[cfg(unix)]
        {
            let err = guard_project_dir(Path::new("/")).unwrap_err();
            assert!(err.contains("层级过浅"), "{err}");
            // 系统目录
            assert!(guard_project_dir(Path::new("/usr/bin")).is_err());
        }
        // 正常两级以上项目目录放行
        let ok = dir.join("a").join("b");
        fs::create_dir_all(&ok).unwrap();
        assert!(guard_project_dir(&ok.canonicalize().unwrap()).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn task_card_kind_inferred_for_legacy_and_written_back() {
        let dir = temp_dir("task-kind");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        // 旧卡（无 kind 字段）：step 非空 → draft，step 空 → idea
        write(
            &config_path(&project),
            "[[tasks]]\nid = \"t-a\"\nname = \"挂步骤旧卡\"\nstep = \"检索筛选\"\ncreated_at = \"2026-01-01\"\n\n\
             [[tasks]]\nid = \"t-b\"\nname = \"未挂旧卡\"\ncreated_at = \"2026-01-01\"\n\n\
             [[tasks]]\nid = \"t-c\"\nname = \"显式想法卡\"\nstep = \"检索筛选\"\nkind = \"idea\"\ncreated_at = \"2026-01-01\"\n\n\
             [[tasks]]\nid = \"t-d\"\nname = \"未知 kind\"\nkind = \"weird\"\ncreated_at = \"2026-01-01\"\n",
        );
        let cards = task_cards_at(&project);
        assert_eq!(cards.len(), 4);
        assert_eq!(cards[0].kind, "draft", "缺 kind + 有 step → draft");
        assert_eq!(cards[1].kind, "idea", "缺 kind + 无 step → idea");
        assert_eq!(
            cards[2].kind, "idea",
            "显式 kind 保留（哪怕与 step 推断相反）"
        );
        assert_eq!(cards[3].kind, "idea", "未知 kind 按缺省规则推断");
        // 写回固化推断值（免迁移脚本）
        write_tasks_at(&project, &cards).unwrap();
        let raw = fs::read_to_string(config_path(&project)).unwrap();
        assert!(raw.contains("kind = \"draft\""), "{raw}");
        assert!(raw.contains("kind = \"idea\""), "{raw}");
        // 新建：显式 kind 生效；缺省按 step 推断
        let idea = create_task_card_at(&project, "新想法", Some("检索筛选"), Some("idea")).unwrap();
        assert_eq!(idea.kind, "idea");
        let draft = create_task_card_at(&project, "新讨论", Some("检索筛选"), None).unwrap();
        assert_eq!(draft.kind, "draft");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fuse_prompt_branches_on_draft_presence() {
        // 草稿非空：带上现有草稿做去重参照，但只要结论片段
        let p = build_fuse_prompt(
            "选角度",
            "文献检索",
            Some("# 任务书草稿\n\n## 待拍板\n"),
            "[用户] 聊角度",
        );
        assert!(p.contains("文献检索") && p.contains("选角度"));
        assert!(p.contains("当前任务书草稿"));
        assert!(p.contains("已经写过的结论不要重复"));
        assert!(p.contains("[用户] 聊角度"));
        // 草稿为空/缺失：同样只要片段，不要整份草稿
        for empty in [None, Some(""), Some("   ")] {
            let p = build_fuse_prompt("选角度", "文献检索", empty, "讨论内容");
            assert!(p.contains("还没有任务书草稿"), "{p}");
            assert!(p.contains("提炼"), "{p}");
            assert!(!p.contains("已经写过的结论不要重复"), "{p}");
        }
        // 两个分支都不得索要整份草稿：落盘走 append_step_draft 追加，
        // 让 AI 输出全文会诱导它复述已有内容，追加后草稿越滚越重复
        for d in [Some("# 任务书草稿\n"), None] {
            let p = build_fuse_prompt("选角度", "文献检索", d, "讨论内容");
            assert!(!p.contains("全文"), "不该索要整份草稿: {p}");
            assert!(p.contains("不要输出标题行"), "标题由 append 侧生成: {p}");
        }
    }

    #[test]
    fn write_task_draft_at_writes_atomically() {
        let dir = temp_dir("writedraft");
        let root = dir.join("proj");
        write(
            &config_path(&root),
            "[[steps]]\nname = \"检索筛选\"\nworkspace_name = \"lit\"\n",
        );
        let saved =
            write_task_draft_at(&root, "检索筛选", "# 任务书草稿：检索筛选\n", None).unwrap();
        let path = root.join(&saved.rel_path);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# 任务书草稿：检索筛选\n"
        );
        assert!(saved.revision.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_task_draft_rejects_stale_revision_and_keeps_disk() {
        let dir = temp_dir("writedraft-rev");
        let root = dir.join("proj");
        write(
            &config_path(&root),
            "[[steps]]\nname = \"检索筛选\"\nworkspace_name = \"lit\"\n",
        );
        let first = write_task_draft_at(&root, "检索筛选", "v1\n", None).unwrap();
        let err = write_task_draft_at(&root, "检索筛选", "v2\n", Some("deadbeef")).unwrap_err();
        assert!(err.contains("未覆盖"), "{err}");
        assert_eq!(
            fs::read_to_string(root.join(&first.rel_path)).unwrap(),
            "v1\n"
        );
        let second =
            write_task_draft_at(&root, "检索筛选", "v2\n", first.revision.as_deref()).unwrap();
        assert_eq!(
            fs::read_to_string(root.join(&second.rel_path)).unwrap(),
            "v2\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ===== 任务卡（[[tasks]]） =====

    #[test]
    fn task_card_crud_round_trip_and_dup_rejected() {
        let dir = temp_dir("task-crud");
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        // 无档案卡时读为空表
        assert!(task_cards_at(&project).is_empty());

        // 创建：id 带 t- 前缀、created_at 非空、step 可选
        let card = create_task_card_at(&project, "文献筛选", Some("文献检索与筛选"), None).unwrap();
        assert!(card.id.starts_with("t-"), "id 前缀: {}", card.id);
        assert!(!card.created_at.is_empty());
        assert_eq!(card.step.as_deref(), Some("文献检索与筛选"));
        assert_eq!(card.workspace, None);
        // 空白 step 视为未挂
        let card2 = create_task_card_at(&project, "数据分析", Some("  "), None).unwrap();
        assert_eq!(card2.step, None);

        // 读回一致；档案卡其余段不受影响（先写一份 resources/steps 再读）
        write_config_at(&project, &sample_config()).unwrap();
        let cards = task_cards_at(&project);
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].name, "文献筛选");
        let read = read_config_at(&project);
        assert_eq!(
            read.config,
            sample_config(),
            "tasks 写回不得动 resources/steps"
        );

        // 重名拒绝（大小写敏感：不同大小写允许）
        let err = create_task_card_at(&project, "文献筛选", None, None).unwrap_err();
        assert!(err.contains("同名卡片"), "{err}");
        assert!(
            create_task_card_at(&project, "文献筛选 ", None, None).is_err(),
            "尾随空白去重后仍同名应拒绝"
        );
        // 空名拒绝
        assert!(create_task_card_at(&project, "   ", None, None).is_err());

        // 重命名：改其他卡撞名拒绝；改自己同名放行；不存在的 id 报错
        let err = rename_task_card_at(&project, &card2.id, "文献筛选").unwrap_err();
        assert!(err.contains("同名卡片"), "{err}");
        rename_task_card_at(&project, &card.id, "文献筛选").unwrap();
        assert!(rename_task_card_at(&project, "t-gone", "x").is_err());

        // 删除：少一张；删不存在的 id 报错
        let card3 = create_task_card_at(&project, "润色", None, None).unwrap();
        delete_task_card_at(&project, &card2.id).unwrap();
        let cards = task_cards_at(&project);
        assert_eq!(cards.len(), 2, "删一张后剩两张: {cards:?}");
        assert!(delete_task_card_at(&project, "t-gone").is_err());
        // 全删后 tasks 段从档案卡移除
        delete_task_card_at(&project, &card.id).unwrap();
        delete_task_card_at(&project, &card3.id).unwrap();
        assert!(task_cards_at(&project).is_empty());
        let on_disk = fs::read_to_string(config_path(&project)).unwrap();
        assert!(
            !on_disk.contains("[[tasks]]"),
            "空 tasks 不应落盘: {on_disk}"
        );
        // resources/steps 仍在
        let read = read_config_at(&project);
        assert_eq!(read.config, sample_config());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn task_card_parse_tolerates_broken_and_render_keeps_unknown() {
        // 防御式解析：坏条目跳过、缺字段容忍、空白 step 归 None；
        // 旧版残留的 briefs 字段解析时忽略（类型对错都不阻断），写回自然丢弃
        let text = r#"artifact_dir = "outputs"

[[tasks]]
id = "t-a1"
name = "好卡片"
step = "步骤一"
created_at = "2026-08-11T00:00:00Z"
briefs = [".ccode/brief-1.md"]

[[tasks]]
id = "t-b2"
name = "缺字段容忍"
step = "  "

[[tasks]]
name = "没有 id"

[[tasks]]
id = "t-c3"
name = "坏 briefs 残留也忽略"
briefs = "not-an-array"
"#;
        let cards = parse_task_cards(text);
        assert_eq!(
            cards.len(),
            3,
            "缺 id 的整条跳过；残留 briefs 字段一律忽略: {cards:?}"
        );
        assert_eq!(cards[1].step, None, "空白 step 归 None");
        assert_eq!(cards[1].created_at, "");
        // 整份坏掉 → 空表
        assert!(parse_task_cards("not [valid toml").is_empty());

        // 写回只替换 tasks 段，未知键与注释保留；残留 briefs 写回后自然丢弃
        let existing =
            "# 用户注释\nfuture_top_key = 42\n\n[[tasks]]\nid = \"t-old\"\nname = \"旧卡\"\n";
        let rendered = render_tasks(Some(existing), &cards[..1]).unwrap();
        assert!(rendered.contains("# 用户注释"), "{rendered}");
        assert!(rendered.contains("future_top_key = 42"), "{rendered}");
        assert!(!rendered.contains("旧卡"), "{rendered}");
        assert!(
            !rendered.contains("brief-1.md"),
            "残留 briefs 写回应丢弃: {rendered}"
        );
        let back = parse_task_cards(&rendered);
        assert_eq!(back, cards[..1].to_vec(), "tasks 往返一致");
        // 现有文件是坏 TOML 时停止写入，不覆盖未知内容
        assert!(render_tasks(Some("not [valid"), &cards).is_err());
    }

    #[test]
    fn project_model_must_belong_to_the_connection() {
        let models = vec!["glm-5.3".to_string(), "glm-5.3-flashx".to_string()];
        assert_eq!(accept_project_model(&models, None).unwrap(), None);
        assert_eq!(accept_project_model(&models, Some("  ")).unwrap(), None);
        assert_eq!(
            accept_project_model(&models, Some("glm-5.3-flashx"))
                .unwrap()
                .as_deref(),
            Some("glm-5.3-flashx"),
        );
        assert!(accept_project_model(&models, Some("deepseek-v4-flash-0731")).is_err());
        assert!(accept_project_model(&[], Some("glm-5.3")).is_err());
    }

    #[test]
    fn gitignore_template_covers_ledger_block_and_coding_mode_does_not() {
        let research = gitignore_text("research", "artifacts");
        assert!(research.contains(GITIGNORE_LEDGER_MARKER));
        for path in LEDGER_IGNORE_PATHS {
            assert!(research.contains(path), "模板缺忽略行：{path}");
        }
        // 迁移 marker 块与模板同款，保证幂等判据不会误判老模板
        assert!(research.contains("（日常积累，不进 git；2026-10-13 双台账口径）"));
        // coding 模式没有文献台账，不带积累面
        assert!(!gitignore_text("coding", "artifacts").contains(GITIGNORE_LEDGER_MARKER));
        // 人工请求一步一份、不进 git（2026-10-22：提交进去后一路带到下一步，收件箱里全是上一步答过的问题）
        for mode in ["research", "coding"] {
            assert!(gitignore_text(mode, "artifacts").lines().any(|l| l == ".ccode/help-wanted.md"), "{mode}");
        }
        // 同步到文献库生成的导入文件不进 git（科研项目才有文献库）
        for path in ["/papers/zotero-library.ris", "/papers/endnote-library.ris"] {
            assert!(gitignore_text("research", "artifacts").lines().any(|l| l == path), "{path}");
        }
    }


    // ===== B1 步骤槽位 =====

    #[test]
    fn agent_binding_slot_accepts_reader_and_step_prefix_rejects_garbage() {
        assert!(valid_agent_binding_slot("reader"));
        assert!(valid_agent_binding_slot("step:文献检索与筛选"));
        assert!(valid_agent_binding_slot("step:a"));
        // 裸 step 前缀（空步骤名）/未知固定槽/乱写一律拒绝
        assert!(!valid_agent_binding_slot("step:"));
        assert!(!valid_agent_binding_slot("step"));
        assert!(valid_agent_binding_slot("discuss")); // B4 已与消费同批放开
        assert!(valid_agent_binding_slot("chat")); // 项目对话，与 discuss 分开
        assert!(!valid_agent_binding_slot(""));
        assert!(!valid_agent_binding_slot("random-slot"));
    }

    #[test]
    fn step_names_must_be_nonempty_and_unique() {
        let mk = |names: &[&str]| {
            names
                .iter()
                .map(|n| StepDto {
                    name: (*n).into(),
                    ..Default::default()
                })
                .collect::<Vec<_>>()
        };
        assert!(validate_step_names(&mk(&["文献检索与筛选", "综述大纲"])).is_ok());
        // 空名与重名都拦；重名文案点名「专属绑定按步骤名匹配」
        let empty = validate_step_names(&mk(&["甲", " "]));
        assert!(empty.is_err() && empty.unwrap_err().contains("还没有填写步骤名"));
        let dup = validate_step_names(&mk(&["文献精读", "文献精读"]));
        assert!(dup.is_err() && dup.unwrap_err().contains("步骤名重复"));
        assert!(validate_step_names(&[]).is_ok());
    }
}
