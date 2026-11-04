//! 任务包（2026-11-03 第一期，design-task-packs.md）：用户自己定义的专属科研任务。
//!
//! 包 = `pack.toml`（身份 + 参数 + 步骤合同；步骤与项目档案卡 `[[steps]]` 同一套写法，由 projects.rs 渲染与解析）
//! + `skills/`（随包的用户技能快照，内置技能不打包）。**不含跑在 Mesa 进程里的代码。**
//! 存放：`<配置目录>/ccode/packs/<id>/`。加进项目时复用 `apply_pipeline_template_at` 原子追加，
//! 每一步带上 `pack`（溯源）与 `params`（定义连同取值，项目自带一份）。

use crate::projects::{ProjectConfigDto, StepDto, StepParamDto};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const PACK_FILE: &str = "pack.toml";

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskPackDto {
    pub id: String,
    pub name: String,
    pub description: String,
    /// 每次另存覆盖 +1
    pub version: u32,
    pub created_at: String,
    pub updated_at: String,
    /// 参数定义；`value` 是默认值
    pub params: Vec<StepParamDto>,
    pub steps: Vec<StepDto>,
    /// 随包技能名（`skills/` 下有 SKILL.md 的目录）
    pub skills: Vec<String>,
    /// 可选的触发（第三期）：加进项目时由人勾选一并建定时任务或事件规则
    pub trigger: Option<PackTriggerDto>,
    /// 从内置模板另存的「我的版本」（第四期）：记基于哪个内置、当时的内置步骤原样，内置升级时前端拿它算差异
    pub based_on: Option<PackBasedOnDto>,
    /// 从别人的 zip 导入、带的脚本还没在加进项目前再确认过一次（第四期）
    pub imported: bool,
    /// 随包技能里 SKILL.md 以外的文件（`skills/<技能>/<相对路径>`）：脚本等，导入与首次加进项目时给人看
    pub scripts: Vec<String>,
    /// 加进项目时带上的项目规则与全局设定（与内置模板 projectRules + projectSettings 同一写法，「名称：（提示）」是待填空位）；
    /// 内置另存为我的版本时带上，从项目另存的不带（那是那个项目自己的）
    pub project_settings: Vec<String>,
    /// 推荐配的 MCP（2026-11-04，design-task-packs §9 第 5 项）：每条「名字：用途」，只列给人看，不自动安装、不写任何配置
    pub mcp: Vec<String>,
}

/// 基于哪个内置模板。`steps` 是另存时的内置步骤，存前经与包步骤同一套归一（`normalize_steps`），
/// 前端拿它和现在的内置（同样经 `normalize_pack_steps` 归一）比：变了就是「内置有更新」；和我的版本比：没改过就自动跟新版
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PackBasedOnDto {
    pub template: String,
    pub template_name: String,
    /// 投稿与返修模板的分支（initial / revision）与轮次；其他模板留空
    pub mode: String,
    pub round: u32,
    pub steps: Vec<StepDto>,
}

const BASED_ON_FILE: &str = "based-on.json";

/// 另存时除步骤与参数外的东西；覆盖时没给的沿用旧版本
#[derive(Default)]
pub(crate) struct SaveExtras {
    pub trigger: Option<PackTriggerDto>,
    pub based_on: Option<PackBasedOnDto>,
    pub imported: bool,
    pub project_settings: Option<Vec<String>>,
    pub mcp: Option<Vec<String>>,
    /// 整份换掉（导入、装草稿）：覆盖同名时不沿用旧版本的技能、触发、based_on、项目设定——新来的那份就是全部
    pub fresh: bool,
}

/// 任务包带的触发：schedule 按时间；folder / radar / phone 是事件规则（模式缺省只记录）。
/// 跑的是 skill（技能目录名，随包或本机已有）；folder 里可以写 {param:键}
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PackTriggerDto {
    pub name: String,
    pub kind: String,
    pub skill: String,
    pub frequency: String,
    pub weekday: Option<u8>,
    pub interval_hours: Option<u8>,
    pub hour: u8,
    pub minute: u8,
    pub folder: String,
    pub exts: Vec<String>,
    pub mode: String,
}

const TRIGGER_KINDS: [&str; 4] = ["schedule", "folder", "radar", "phone"];
const FREQUENCIES: [&str; 5] = ["daily", "weekdays", "weekly", "hourly", "manual"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPackResultDto {
    pub appended: usize,
    pub skipped: Vec<String>,
    pub renamed: Vec<crate::projects::WorkspaceRenameDto>,
    /// 这次新装进技能库的随包技能（默认没分发给任何 Agent，要去技能页打开）
    pub skills_added: Vec<String>,
    /// 包带的触发建了什么 / 为什么没建（没带触发或人没勾为 None）
    pub trigger_note: Option<String>,
}

fn packs_root() -> Result<PathBuf, String> {
    // 走 config_root：与 config_dir()/ccode 同一处，单测可重定向
    Ok(crate::storage::config_root().ok_or("无法确定配置目录")?.join("packs"))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn pack_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("任务包 id 不合法：{id}"));
    }
    Ok(root.join(id))
}

/// 文字里的 `{param:键}`（键只收字母数字下划线连字符）
pub(crate) fn param_refs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("{param:") {
        rest = &rest[at + 7..];
        let Some(end) = rest.find('}') else { break };
        let key = &rest[..end];
        if !key.is_empty()
            && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            && !out.iter().any(|k| k == key)
        {
            out.push(key.to_string());
        }
        rest = &rest[end + 1..];
    }
    out
}

/// 一步里会被参数替换的文字（与前端 task-packs.ts applyStepParams 同一范围）
fn step_texts(step: &StepDto) -> Vec<&str> {
    let mut out = vec![step.brief.as_str()];
    // machine: 验收行由机器按原文判，不做参数替换（前端 mapTexts 同样跳过；2026-11-03 自查对齐）
    out.extend(step.acceptance_criteria.iter().map(String::as_str).filter(|c| !c.trim_start().starts_with("machine:")));
    out.extend(step.discussion_seeds.iter().map(String::as_str));
    out.extend(step.decisions.iter().map(|d| d.q.as_str()));
    for h in &step.human_tasks {
        out.push(h.title.as_str());
        out.push(h.guidance.as_str());
    }
    out
}

fn render_pack(pack: &TaskPackDto) -> Result<String, String> {
    use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};
    let cfg = ProjectConfigDto {
        steps: pack.steps.clone(),
        ..Default::default()
    };
    let body: DocumentMut = crate::projects::render_config(None, &cfg)?
        .parse()
        .map_err(|e| format!("任务包步骤渲染失败：{e}"))?;
    let mut doc = DocumentMut::new();
    let mut meta = Table::new();
    meta["id"] = value(&pack.id);
    meta["name"] = value(&pack.name);
    meta["description"] = value(&pack.description);
    meta["version"] = value(i64::from(pack.version));
    meta["created_at"] = value(&pack.created_at);
    meta["updated_at"] = value(&pack.updated_at);
    if pack.imported {
        meta["imported"] = value(true);
    }
    if !pack.project_settings.is_empty() {
        let mut arr = toml_edit::Array::new();
        for line in &pack.project_settings {
            arr.push(line.as_str());
        }
        meta["project_settings"] = value(arr);
    }
    if !pack.mcp.is_empty() {
        let mut arr = toml_edit::Array::new();
        for line in &pack.mcp {
            arr.push(line.as_str());
        }
        meta["mcp"] = value(arr);
    }
    doc["pack"] = Item::Table(meta);
    if !pack.params.is_empty() {
        let mut ps = ArrayOfTables::new();
        for p in &pack.params {
            let mut t = Table::new();
            t["key"] = value(&p.key);
            t["label"] = value(&p.label);
            t["value"] = value(&p.value);
            if !p.help.is_empty() {
                t["help"] = value(&p.help);
            }
            if !p.kind.is_empty() {
                t["kind"] = value(&p.kind);
            }
            if !p.options.is_empty() {
                let mut opts = toml_edit::Array::new();
                for o in &p.options {
                    opts.push(o.as_str());
                }
                t["options"] = value(opts);
            }
            ps.push(t);
        }
        doc["params"] = Item::ArrayOfTables(ps);
    }
    if let Some(tr) = &pack.trigger {
        let mut t = Table::new();
        t["name"] = value(&tr.name);
        t["kind"] = value(&tr.kind);
        t["skill"] = value(&tr.skill);
        if tr.kind == "schedule" {
            t["frequency"] = value(&tr.frequency);
            if let Some(w) = tr.weekday {
                t["weekday"] = value(i64::from(w));
            }
            if let Some(n) = tr.interval_hours {
                t["interval_hours"] = value(i64::from(n));
            }
            t["hour"] = value(i64::from(tr.hour));
            t["minute"] = value(i64::from(tr.minute));
        } else {
            if !tr.folder.is_empty() {
                t["folder"] = value(&tr.folder);
            }
            if !tr.exts.is_empty() {
                let mut a = toml_edit::Array::new();
                for e in &tr.exts {
                    a.push(e.as_str());
                }
                t["exts"] = value(a);
            }
            t["mode"] = value(if tr.mode.is_empty() { "record" } else { tr.mode.as_str() });
        }
        doc["trigger"] = Item::Table(t);
    }
    if let Some(steps) = body.get("steps") {
        doc["steps"] = steps.clone();
    }
    Ok(format!(
        "# Mesa 任务包：{}\n# [[steps]] 字段与项目档案卡（.ccode/project.toml）同名同义；文字里的 {{param:键}} 在拼任务书时替换成参数值。\n{doc}",
        pack.name.replace('\n', " ")
    ))
}

fn parse_pack(text: &str, dir: &Path) -> Result<TaskPackDto, String> {
    let value: toml::Value = toml::from_str(text).map_err(|e| format!("pack.toml 解析失败：{e}"))?;
    let meta = value.get("pack").and_then(|v| v.as_table()).ok_or("pack.toml 缺少 [pack] 段")?;
    let s = |k: &str| meta.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let id = s("id");
    if !valid_id(&id) {
        return Err(format!("pack.toml 的 id 不合法：{id}"));
    }
    let params: Vec<StepParamDto> = match value.get("params") {
        Some(v) => v.clone().try_into().map_err(|e| format!("[[params]] 写法不对：{e}"))?,
        None => Vec::new(),
    };
    let skills_dir = dir.join("skills");
    let mut skills: Vec<String> = fs::read_dir(&skills_dir)
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().join("SKILL.md").is_file())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    skills.sort();
    let mut scripts = Vec::new();
    for skill in &skills {
        let base = skills_dir.join(skill);
        let mut stack = vec![base.clone()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    stack.push(p);
                } else if ft.is_file() && p != base.join("SKILL.md") {
                    let rel = p.strip_prefix(&skills_dir).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                    scripts.push(format!("skills/{rel}"));
                }
            }
        }
    }
    scripts.sort();
    let based_on = match fs::read_to_string(dir.join(BASED_ON_FILE)) {
        Ok(text) => serde_json::from_str::<PackBasedOnDto>(&text)
            .map_err(|e| crate::logbuf::record("warn", "task_packs", &format!("{BASED_ON_FILE} 读不懂：{e}")))
            .ok(),
        Err(_) => None,
    };
    Ok(TaskPackDto {
        name: s("name"),
        description: s("description"),
        version: meta.get("version").and_then(|v| v.as_integer()).unwrap_or(1).clamp(1, i64::from(u32::MAX)) as u32,
        created_at: s("created_at"),
        updated_at: s("updated_at"),
        params: crate::projects::normalize_step_params(params),
        steps: crate::projects::parse_config(text).0.steps,
        skills,
        trigger: match value.get("trigger") {
            Some(v) => Some(trigger_from_toml(v)?),
            None => None,
        },
        based_on,
        imported: meta.get("imported").and_then(|v| v.as_bool()).unwrap_or(false),
        scripts,
        project_settings: meta
            .get("project_settings")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
            .unwrap_or_default(),
        mcp: meta
            .get("mcp")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
            .unwrap_or_default(),
        id,
    })
}

pub(crate) fn read_pack_at(root: &Path, id: &str) -> Result<TaskPackDto, String> {
    let dir = pack_dir(root, id)?;
    let text = fs::read_to_string(dir.join(PACK_FILE)).map_err(|_| format!("找不到任务包：{id}"))?;
    parse_pack(&text, &dir)
}

pub(crate) fn list_at(root: &Path) -> Vec<TaskPackDto> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<TaskPackDto> = entries
        .flatten()
        .filter(|e| e.path().is_dir() && valid_id(&e.file_name().to_string_lossy()))
        .filter_map(|e| {
            let id = e.file_name().to_string_lossy().into_owned();
            read_pack_at(root, &id)
                .map_err(|err| crate::logbuf::record("warn", "task_packs", &format!("读不了任务包 {id}：{err}")))
                .ok()
        })
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// 另存进库的步骤：去掉来自上一个包的溯源与参数取值（参数在包这一层定义），预置完成不带
fn pack_step(mut step: StepDto) -> StepDto {
    step.pack.clear();
    step.params.clear();
    step.seed_complete = false;
    step
}

#[cfg(test)]
pub(crate) fn save_at(
    root: &Path,
    id: Option<&str>,
    name: &str,
    description: &str,
    params: Vec<StepParamDto>,
    steps: Vec<StepDto>,
    skill_dirs: &[(String, PathBuf)],
) -> Result<TaskPackDto, String> {
    save_with_trigger_at(root, id, name, description, params, steps, skill_dirs, SaveExtras::default())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn save_with_trigger_at(
    root: &Path,
    id: Option<&str>,
    name: &str,
    description: &str,
    params: Vec<StepParamDto>,
    steps: Vec<StepDto>,
    skill_dirs: &[(String, PathBuf)],
    extras: SaveExtras,
) -> Result<TaskPackDto, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("任务名不能为空".into());
    }
    if steps.is_empty() {
        return Err("至少要有一个步骤".into());
    }
    let params = crate::projects::normalize_step_params(params);
    let steps: Vec<StepDto> = steps.into_iter().map(pack_step).collect();
    for step in &steps {
        for key in step_texts(step).into_iter().flat_map(param_refs) {
            if !params.iter().any(|p| p.key == key) {
                return Err(format!("步骤「{}」里用了没定义的参数 {{param:{key}}}", step.name));
            }
        }
    }
    let _lock = crate::storage::config_lock("task-packs")?;
    fs::create_dir_all(root).map_err(|e| format!("建任务包目录失败：{e}"))?;
    let existing = match id {
        Some(id) => Some(read_pack_at(root, id)?),
        None => None,
    };
    // 覆盖时旧版本随包、这次没给的技能沿用（从项目另存拿不到包里的核验 / 触发技能，不该丢）
    let mut skill_dirs: Vec<(String, PathBuf)> = skill_dirs.to_vec();
    // 整份换掉时当作没有旧版本可沿用（版本号、建立时间照旧接上）
    let inherit = existing.as_ref().filter(|_| !extras.fresh);
    if let Some(old) = inherit {
        let old_dir = pack_dir(root, &old.id)?.join("skills");
        for name in &old.skills {
            if !skill_dirs.iter().any(|(n, _)| n == name) {
                skill_dirs.push((name.clone(), old_dir.join(name)));
            }
        }
    }
    let trigger = extras.trigger.or_else(|| inherit.and_then(|p| p.trigger.clone()));
    let based_on = match extras.based_on {
        Some(b) => Some(PackBasedOnDto { steps: normalize_steps(b.steps)?, ..b }),
        None => inherit.and_then(|p| p.based_on.clone()),
    };
    // 导入的标记一直带到人在加进项目前确认过脚本为止（本人覆盖另存也不清：脚本还是别人写的）
    let imported = extras.imported || inherit.is_some_and(|p| p.imported);
    let project_settings = extras
        .project_settings
        .or_else(|| inherit.map(|p| p.project_settings.clone()))
        .unwrap_or_default();
    let mcp = extras.mcp.or_else(|| inherit.map(|p| p.mcp.clone())).unwrap_or_default();
    // 拦下的一律不存（提醒不拦）；技能库名单只影响提醒，这里不用
    let probe = TaskPackDto {
        id: "pk-check".into(),
        name: name.to_string(),
        description: String::new(),
        version: 1,
        created_at: String::new(),
        updated_at: String::new(),
        params: params.clone(),
        steps: steps.clone(),
        skills: skill_dirs.iter().map(|(n, _)| n.clone()).collect(),
        trigger: trigger.clone(),
        project_settings: project_settings.clone(),
        mcp: mcp.clone(),
        ..Default::default()
    };
    if let Some(msg) = blocked(&check_pack(&probe, &crate::skills::library_skill_names_for_check())) {
        return Err(msg);
    }
    let now = crate::sessions::now_iso();
    let pack = TaskPackDto {
        id: existing
            .as_ref()
            .map(|p| p.id.clone())
            .unwrap_or_else(|| format!("pk-{}", &uuid::Uuid::new_v4().simple().to_string()[..12])),
        name: name.to_string(),
        description: description.trim().to_string(),
        version: existing.as_ref().map(|p| p.version + 1).unwrap_or(1),
        created_at: existing.as_ref().map(|p| p.created_at.clone()).unwrap_or_else(|| now.clone()),
        updated_at: now,
        params,
        steps,
        skills: skill_dirs.iter().map(|(n, _)| n.clone()).collect(),
        // 没给触发就沿用旧版本的（从项目另存时拿不到触发，不该把它丢掉）
        trigger,
        based_on,
        imported,
        scripts: Vec::new(),
        project_settings,
        mcp,
    };
    // 先在临时目录写全，再整目录换上：中途失败不留半个包
    let final_dir = pack_dir(root, &pack.id)?;
    let tmp = root.join(format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| -> Result<(), String> {
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        crate::profiles::atomic_write(&tmp.join(PACK_FILE), &render_pack(&pack)?)?;
        if let Some(b) = &pack.based_on {
            let json = serde_json::to_string_pretty(b).map_err(|e| e.to_string())?;
            crate::profiles::atomic_write(&tmp.join(BASED_ON_FILE), &json)?;
        }
        for (skill, src) in &skill_dirs {
            crate::paths::validate_fs_name(skill)?;
            crate::skills::copy_dir_recursive(src, &tmp.join("skills").join(skill))?;
        }
        let old = root.join(format!(".old-{}", uuid::Uuid::new_v4().simple()));
        if final_dir.exists() {
            fs::rename(&final_dir, &old).map_err(|e| format!("换下旧版本失败：{e}"))?;
        }
        if let Err(e) = fs::rename(&tmp, &final_dir) {
            let _ = fs::rename(&old, &final_dir);
            return Err(format!("写入任务包失败：{e}"));
        }
        let _ = fs::remove_dir_all(&old);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&tmp);
    }
    result?;
    read_pack_at(root, &pack.id)
}

/// 步骤按存进包的样子归一：去溯源与取值，再走一遍档案卡写出、读回（缺省值补齐、空白去掉）。
/// 包里的步骤就是这样读出来的；内置对照也走这里，前后才比得上
pub(crate) fn normalize_steps(steps: Vec<StepDto>) -> Result<Vec<StepDto>, String> {
    let cfg = ProjectConfigDto {
        steps: steps.into_iter().map(pack_step).collect(),
        ..Default::default()
    };
    Ok(crate::projects::parse_config(&crate::projects::render_config(None, &cfg)?).0.steps)
}

#[tauri::command]
pub async fn normalize_pack_steps(steps: Vec<StepDto>) -> Result<Vec<StepDto>, String> {
    tauri::async_runtime::spawn_blocking(move || normalize_steps(steps))
        .await
        .map_err(|e| e.to_string())?
}

/// 加进项目的步骤：每一步带上包 id 与参数（取值 = 人填的，没填用默认）
pub(crate) fn steps_for_project(pack: &TaskPackDto, values: &BTreeMap<String, String>) -> Vec<StepDto> {
    let params: Vec<StepParamDto> = pack
        .params
        .iter()
        .map(|p| StepParamDto {
            value: values.get(&p.key).map(|v| v.trim().to_string()).unwrap_or_else(|| p.value.clone()),
            ..p.clone()
        })
        .collect();
    pack.steps
        .iter()
        .map(|s| StepDto {
            pack: pack.id.clone(),
            params: params.clone(),
            ..s.clone()
        })
        .collect()
}

#[tauri::command]
pub async fn list_task_packs() -> Result<Vec<TaskPackDto>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(list_at(&packs_root()?)))
        .await
        .map_err(|e| e.to_string())?
}

/// 另存为我的任务：步骤用到的用户技能一并快照进包。id 给了就是覆盖那一个（同名覆盖的确认在前端）。
/// `based_on`：内置模板「另存为我的版本」与内置升级后「保留我的 / 按勾选更新」时给，记这次对照的内置原样
#[tauri::command]
pub async fn save_task_pack(
    id: Option<String>,
    name: String,
    description: String,
    params: Vec<StepParamDto>,
    steps: Vec<StepDto>,
    based_on: Option<PackBasedOnDto>,
    project_settings: Option<Vec<String>>,
) -> Result<TaskPackDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut names: Vec<String> = Vec::new();
        for s in &steps {
            for k in s.skills.iter().chain(s.required_skills.iter()).chain(s.checks.iter().map(|c| &c.skill)) {
                if !names.contains(k) {
                    names.push(k.clone());
                }
            }
        }
        let skill_dirs = crate::skills::user_skill_dirs(&names)?;
        let extras = SaveExtras { based_on, project_settings, ..Default::default() };
        save_with_trigger_at(&packs_root()?, id.as_deref(), &name, &description, params, steps, &skill_dirs, extras)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删包走回收站（可反悔）；已加进项目的步骤不受影响（项目自带参数与步骤）
#[tauri::command]
pub async fn delete_task_pack(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = crate::storage::config_lock("task-packs")?;
        let dir = pack_dir(&packs_root()?, &id)?;
        if !dir.exists() {
            return Ok(());
        }
        crate::projects::trash_delete_retry(&dir, "任务包")
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 从我的任务加进项目流程：先补装库里缺的随包技能，再按模板追加同一条原子写入。
/// strategy 缺省追加到末尾；模板库里「使用」整条换掉时传 replace（覆盖确认在前端）。
/// 导入来的包带脚本：人在前端再确认一次（scripts_reviewed）才加，加成后去掉导入标记
#[tauri::command]
pub async fn add_task_pack_to_project(
    project_root: String,
    id: String,
    values: BTreeMap<String, String>,
    with_trigger: Option<bool>,
    strategy: Option<String>,
    scripts_reviewed: Option<bool>,
    steps: Option<Vec<StepDto>>,
    project_settings: Option<Vec<String>>,
    topic: Option<String>,
) -> Result<AddPackResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        let packs = packs_root()?;
        let pack = read_pack_at(&packs, &id)?;
        let runs = pack.steps.iter().map(|s| s.run.len()).sum::<usize>();
        if pack.imported && (!pack.scripts.is_empty() || runs > 0) && scripts_reviewed != Some(true) {
            return Err(format!("「{}」是导入的，带别人写的文件或运行命令，加进项目前要先确认看过", pack.name));
        }
        let strategy = match strategy.as_deref() {
            None | Some("append") => "append",
            Some("replace") => "replace",
            Some(other) => return Err(format!("不认识的加入方式：{other}")),
        };
        // 前端按项目的研究工具设置改过的步骤（withResearchTools）：只认名字、顺序与包一致的，不许借这里塞别的步骤
        let project_steps = match steps {
            Some(given) => {
                let names = |list: &[StepDto]| list.iter().map(|s| s.name.trim().to_string()).collect::<Vec<_>>();
                if names(&given) != names(&pack.steps) || given.iter().any(|s| s.pack != pack.id) {
                    return Err("加进来的步骤和我的任务对不上，重新打开再试".into());
                }
                given
            }
            None => steps_for_project(&pack, &values),
        };
        let skills = crate::skills::install_pack_skills(&pack_dir(&packs, &id)?.join("skills"))?;
        let res = crate::projects::apply_pipeline_template_at(
            &root,
            project_steps,
            project_settings.unwrap_or_else(|| pack.project_settings.clone()),
            strategy,
            topic,
            None,
            None,
        )?;
        if pack.imported {
            if let Err(e) = clear_imported_at(&packs, &id) {
                crate::logbuf::record("warn", "task_packs", &format!("去掉导入标记失败：{e}"));
            }
        }
        let trigger_note = match (&pack.trigger, with_trigger.unwrap_or(false)) {
            (Some(tr), true) => Some(create_trigger(&root, &pack, tr, &values)),
            _ => None,
        };
        Ok(AddPackResultDto {
            appended: res.appended,
            skipped: res.skipped,
            renamed: res.renamed,
            skills_added: skills.added,
            trigger_note,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 导入的包在人确认过脚本后去掉标记（只改 [pack] imported，不升版本）
fn clear_imported_at(root: &Path, id: &str) -> Result<(), String> {
    let _lock = crate::storage::config_lock("task-packs")?;
    let mut pack = read_pack_at(root, id)?;
    if !pack.imported {
        return Ok(());
    }
    pack.imported = false;
    crate::profiles::atomic_write(&pack_dir(root, id)?.join(PACK_FILE), &render_pack(&pack)?)
}

/// [trigger] 表 → 触发（toml 的整数是 i64，逐键取，写错类型当没写）
fn trigger_from_toml(v: &toml::Value) -> Result<PackTriggerDto, String> {
    let t = v.as_table().ok_or("[trigger] 要写成一张表")?;
    let s = |k: &str| t.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let n = |k: &str| t.get(k).and_then(|x| x.as_integer()).and_then(|x| u8::try_from(x).ok());
    Ok(PackTriggerDto {
        name: s("name"),
        kind: s("kind"),
        skill: s("skill"),
        frequency: s("frequency"),
        weekday: n("weekday"),
        interval_hours: n("interval_hours"),
        hour: n("hour").unwrap_or(0),
        minute: n("minute").unwrap_or(0),
        folder: s("folder"),
        exts: t
            .get("exts")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        mode: s("mode"),
    })
}

/// 文字里的 {param:键} 换成取值（触发的目录用；没取值用默认）
fn fill_params(text: &str, pack: &TaskPackDto, values: &BTreeMap<String, String>) -> String {
    let mut out = text.to_string();
    for p in &pack.params {
        let v = values.get(&p.key).map(|v| v.trim().to_string()).unwrap_or_else(|| p.value.clone());
        out = out.replace(&format!("{{param:{}}}", p.key), &v);
    }
    out
}

/// 按包的触发建定时任务或事件规则；建不成说明原因，不挡步骤已经加进来
fn create_trigger(root: &Path, pack: &TaskPackDto, tr: &PackTriggerDto, values: &BTreeMap<String, String>) -> String {
    let name = if tr.name.trim().is_empty() { pack.name.clone() } else { tr.name.trim().to_string() };
    let event = (tr.kind != "schedule").then(|| crate::scheduler::EventRule {
        kind: tr.kind.clone(),
        folder: (tr.kind == "folder").then(|| fill_params(&tr.folder, pack, values)),
        exts: tr.exts.clone(),
        mode: if tr.mode.is_empty() { "record".into() } else { tr.mode.clone() },
        // 每周花费上限由人在定时任务里设，包不带
        weekly_cap_usd: None,
    });
    let (frequency, weekday, interval) = if tr.kind == "schedule" {
        (tr.frequency.as_str(), tr.weekday, tr.interval_hours)
    } else {
        ("manual", None, None)
    };
    match crate::scheduler::create_schedule_for_pack(root, &name, &tr.skill, frequency, weekday, interval, tr.hour, tr.minute, event) {
        Ok((task, dist)) => {
            let what = match &task.event {
                Some(e) => format!("事件规则「{}」（{}）", task.name, if e.mode == "run" { "直接跑" } else { "先只记录" }),
                None => format!("定时任务「{}」", task.name),
            };
            match dist {
                Some(e) => format!("建了{what}；技能「{}」没分发成：{e}，去「技能」页打开", tr.skill),
                None => format!("建了{what}，在项目的定时任务页能看到"),
            }
        }
        Err(e) => format!("步骤已加进来，但没建成触发：{e}"),
    }
}

// ===== 机器校验（第二期，design-task-packs.md §5）=====
// 把 step-panel.md「新增模板 / 新增步骤检查清单」里机器判得了的做成校验：「拦下」不让存，「提醒」只提醒。

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackIssueDto {
    /// "block" 拦下 | "warn" 提醒
    pub level: String,
    /// 哪一步（整包的问题为 None）
    pub step: Option<String>,
    pub message: String,
}

fn issue(level: &str, step: Option<&str>, message: impl Into<String>) -> PackIssueDto {
    PackIssueDto { level: level.into(), step: step.map(str::to_string), message: message.into() }
}

/// 一步的文字超过这么多字提醒、超过上限拦下（任务书长度预算：内置模板每步约 4–5 千字）
const STEP_TEXT_WARN: usize = 6000;
const STEP_TEXT_BLOCK: usize = 12000;

const PACK_KEYS: [&str; 4] = ["pack", "params", "steps", "trigger"];
const CHECK_KEYS: [&str; 4] = ["name", "skill", "script", "description"];
const TRIGGER_KEYS: [&str; 11] = ["name", "kind", "skill", "frequency", "weekday", "interval_hours", "hour", "minute", "folder", "exts", "mode"];
const META_KEYS: [&str; 9] = ["id", "name", "description", "version", "created_at", "updated_at", "imported", "project_settings", "mcp"];
const PARAM_KEYS: [&str; 6] = ["key", "label", "value", "help", "options", "kind"];
const STEP_KEYS: [&str; 23] = [
    "name", "workspace_name", "brief", "expected_artifacts", "acceptance_criteria", "decision_mode", "inputs",
    "optional_inputs", "any_of_inputs", "skills", "required_skills", "resources", "run", "human_tasks",
    "discussion_seeds", "decisions", "asks_lit_source", "seed_complete", "role", "pack", "params", "checks", "fan_out",
];
const HUMAN_KEYS: [&str; 8] = ["title", "guidance", "target", "timing", "optional", "completion", "expected_count", "manifest_path"];
const DECISION_MODES: [&str; 3] = ["auto_continue", "soft_pause", "hard_pause"];

/// 手写的 pack.toml：字段闭集与取值闭集（parse_config 会把写错的悄悄丢掉或归一，这里先说出来）
fn check_structure(value: &toml::Value) -> Vec<PackIssueDto> {
    let mut out = Vec::new();
    let unknown = |out: &mut Vec<PackIssueDto>, step: Option<&str>, table: &toml::value::Table, allowed: &[&str], what: &str| {
        for key in table.keys() {
            if !allowed.contains(&key.as_str()) {
                out.push(issue("block", step, format!("{what}里有不认识的字段「{key}」")));
            }
        }
    };
    let Some(root) = value.as_table() else { return out };
    unknown(&mut out, None, root, &PACK_KEYS, "pack.toml 顶层");
    if let Some(meta) = root.get("pack").and_then(|v| v.as_table()) {
        unknown(&mut out, None, meta, &META_KEYS, "[pack] ");
    }
    if let Some(tr) = root.get("trigger").and_then(|v| v.as_table()) {
        unknown(&mut out, None, tr, &TRIGGER_KEYS, "[trigger] ");
    }
    for p in root.get("params").and_then(|v| v.as_array()).into_iter().flatten() {
        if let Some(t) = p.as_table() {
            unknown(&mut out, None, t, &PARAM_KEYS, "[[params]] ");
        }
    }
    for s in root.get("steps").and_then(|v| v.as_array()).into_iter().flatten() {
        let Some(t) = s.as_table() else { continue };
        let name = t.get("name").and_then(|v| v.as_str());
        unknown(&mut out, name, t, &STEP_KEYS, "这一步");
        if let Some(mode) = t.get("decision_mode").and_then(|v| v.as_str()) {
            if !DECISION_MODES.contains(&mode) {
                out.push(issue("block", name, format!("decision_mode 只能是 auto_continue / soft_pause / hard_pause，写的是「{mode}」")));
            }
        }
        for h in t.get("human_tasks").and_then(|v| v.as_array()).into_iter().flatten() {
            if let Some(ht) = h.as_table() {
                unknown(&mut out, name, ht, &HUMAN_KEYS, "人工事项");
            }
        }
        for c in t.get("checks").and_then(|v| v.as_array()).into_iter().flatten() {
            if let Some(ct) = c.as_table() {
                unknown(&mut out, name, ct, &CHECK_KEYS, "核验");
            }
        }
    }
    out
}

fn path_issue(step: &str, what: &str, path: &str) -> Option<PackIssueDto> {
    let p = path.trim().replace('\\', "/");
    if p.is_empty() {
        return None;
    }
    if p.starts_with('/') || p.chars().nth(1) == Some(':') || p.split('/').any(|seg| seg == "..") {
        return Some(issue("block", Some(step), format!("{what}「{path}」要写成项目内的相对路径")));
    }
    let first = p.split('/').next().unwrap_or_default();
    if first == ".git" {
        return Some(issue("block", Some(step), format!("{what}「{path}」不能指向 .git")));
    }
    if first == ".ccode" {
        return Some(issue("warn", Some(step), format!("{what}「{path}」在 .ccode/ 下：那是 Mesa 的地方，一般不该写")));
    }
    None
}

/// 内容校验。lib_skills = 本机技能库里有的技能名
pub(crate) fn check_pack(pack: &TaskPackDto, lib_skills: &[String]) -> Vec<PackIssueDto> {
    let mut out = Vec::new();
    if pack.name.trim().is_empty() {
        out.push(issue("block", None, "任务名不能为空"));
    }
    if pack.steps.is_empty() {
        out.push(issue("block", None, "至少要有一个步骤"));
    }
    if pack.project_settings.iter().any(|l| crate::sessions::redact_sensitive_text(l) != *l) {
        out.push(issue("block", None, "项目设定里像是有密钥，拿掉再存"));
    }
    // 推荐的 MCP 只写名字与用途；连接串、令牌一律不进包（包会导出给别人）
    if pack.mcp.iter().any(|l| crate::sessions::redact_sensitive_text(l) != *l) {
        out.push(issue("block", None, "推荐的 MCP 里像是有密钥，只写名字和用途"));
    }
    if pack.mcp.len() > 12 {
        out.push(issue("warn", None, format!("推荐了 {} 个 MCP，偏多；只留真用得上的", pack.mcp.len())));
    }
    let anchors = crate::skills::builtin_skill_names();
    let mut produced: Vec<String> = Vec::new();
    let mut used_params: Vec<String> = Vec::new();
    for (i, step) in pack.steps.iter().enumerate() {
        let name = step.name.trim();
        let sn = Some(name);
        if name.is_empty() {
            out.push(issue("block", None, format!("第 {} 步没有名字", i + 1)));
        } else if pack.steps[..i].iter().any(|s| s.name.trim() == name) {
            out.push(issue("block", sn, "步骤名重复"));
        }
        if step.brief.trim().is_empty() {
            out.push(issue("block", sn, "没有简报：AI 不知道这一步做什么"));
        }
        let texts = step_texts(step);
        if step.acceptance_criteria.iter().any(|c| c.trim_start().starts_with("machine:") && c.contains("{param:")) {
            out.push(issue("block", sn, "machine: 验收行由机器按原文判，不能写 {param:…}（拼任务书时不会替换）"));
        }
        let len: usize = texts.iter().map(|t| t.chars().count()).sum();
        if len > STEP_TEXT_BLOCK {
            out.push(issue("block", sn, format!("文字有 {len} 字，超过一步 {STEP_TEXT_BLOCK} 字的上限，任务书会太长；把细则挪进技能")));
        } else if len > STEP_TEXT_WARN {
            out.push(issue("warn", sn, format!("文字有 {len} 字，偏长；细则可以挪进技能")));
        }
        for t in &texts {
            if crate::sessions::redact_sensitive_text(t) != *t {
                out.push(issue("block", sn, "文字里像是有密钥，拿掉再存"));
                break;
            }
            for key in param_refs(t) {
                if !pack.params.iter().any(|p| p.key == key) {
                    out.push(issue("block", sn, format!("用了没定义的参数 {{param:{key}}}")));
                }
                if !used_params.contains(&key) {
                    used_params.push(key);
                }
            }
        }
        let brief = &step.brief;
        let mut rest = brief.as_str();
        while let Some(at) = rest.find("{skill:") {
            rest = &rest[at + 7..];
            let Some(end) = rest.find('}') else { break };
            let anchor = &rest[..end];
            if !anchors.contains(&anchor) {
                out.push(issue("block", sn, format!("{{skill:{anchor}}} 不是认得的技能位（只能写内置技能名）")));
            }
            rest = &rest[end + 1..];
        }
        let paths = step
            .expected_artifacts
            .iter()
            .map(|p| ("预期产物", p))
            .chain(step.inputs.iter().map(|p| ("输入", p)))
            .chain(step.optional_inputs.iter().map(|p| ("可选输入", p)))
            .chain(step.any_of_inputs.iter().flatten().map(|p| ("任一输入", p)))
            .chain(step.resources.iter().map(|p| ("资源", p)))
            .chain(step.human_tasks.iter().map(|h| ("人工事项落点", &h.target)))
            .chain(step.human_tasks.iter().map(|h| ("人工事项清单", &h.manifest_path)));
        for (what, p) in paths {
            if let Some(found) = path_issue(name, what, p) {
                out.push(found);
            }
        }
        if step.expected_artifacts.is_empty() {
            out.push(issue("warn", sn, "没有预期产物：Mesa 判断不了这一步做没做完"));
        } else if step.expected_artifacts.iter().all(|p| p.ends_with('/') || p.rsplit('/').next().is_some_and(|last| last.contains('*'))) {
            out.push(issue("warn", sn, "预期产物只写了目录或通配：先写一个能证明做完的入口文件（如 analysis/report.md）"));
        }
        if step.acceptance_criteria.is_empty() {
            out.push(issue("warn", sn, "没有验收条件：评审时不知道按什么标准看"));
        }
        if i > 0 {
            for input in &step.inputs {
                if !produced.iter().any(|p| p == input) {
                    out.push(issue("warn", sn, format!("必需输入「{input}」不是前面步骤的产物：加进项目时要确认项目里已有")));
                }
            }
        }
        produced.extend(step.expected_artifacts.iter().cloned());
        let asks = ["问用户", "问人", "请用户", "让用户决定", "等用户"].iter().any(|w| brief.contains(w));
        if asks && step.decisions.is_empty() && !brief.contains("help-wanted") {
            out.push(issue("warn", sn, "简报说要问人，但没写决策项；开工前就能问的写成决策项，干到一半才知道的写明写进 .ccode/help-wanted.md"));
        }
        // skills 与 required_skills 常写同一个：一步里同一技能只提醒一次
        let mut named: Vec<&String> = Vec::new();
        for skill in step.skills.iter().chain(step.required_skills.iter()) {
            if named.contains(&skill) {
                continue;
            }
            named.push(skill);
            if !lib_skills.iter().any(|s| s == skill) && !pack.skills.iter().any(|s| s == skill) {
                out.push(issue("warn", sn, format!("技能「{skill}」本机没有，也没随包带上")));
            }
        }
        // 核验脚本（第三期）：名字只收小写字母数字连字符（拼进结果文件名），脚本放在随包或本机的技能目录里
        for (ci, c) in step.checks.iter().enumerate() {
            if c.name.is_empty() || !c.name.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-') {
                out.push(issue("block", sn, format!("核验名「{}」只能用小写英文、数字和连字符", c.name)));
            } else if step.checks[..ci].iter().any(|x| x.name == c.name) {
                out.push(issue("block", sn, format!("核验名「{}」重复", c.name)));
            }
            if c.skill.trim().is_empty() || (!pack.skills.contains(&c.skill) && !lib_skills.contains(&c.skill)) {
                out.push(issue("block", sn, format!("核验「{}」的脚本所在技能「{}」没随包，本机也没有", c.name, c.skill)));
            }
            let script = c.script.replace('\\', "/");
            if script.trim().is_empty() || script.starts_with('/') || script.chars().nth(1) == Some(':') || script.split('/').any(|seg| seg == "..") {
                out.push(issue("block", sn, format!("核验「{}」的脚本要写技能目录里的相对路径，写的是「{}」", c.name, c.script)));
            }
        }
    }
    // 触发：种类与周期闭集；跑的技能要随包或本机有；目录写项目内相对路径
    if let Some(tr) = &pack.trigger {
        if !TRIGGER_KINDS.contains(&tr.kind.as_str()) {
            out.push(issue("block", None, format!("[trigger] kind 只能是 schedule / folder / radar / phone，写的是「{}」", tr.kind)));
        }
        if tr.skill.trim().is_empty() {
            out.push(issue("block", None, "[trigger] 要写跑哪个技能（skill）"));
        } else if !pack.skills.contains(&tr.skill) && !lib_skills.contains(&tr.skill) {
            out.push(issue("block", None, format!("[trigger] 跑的技能「{}」没随包，本机也没有", tr.skill)));
        }
        if tr.kind == "schedule" {
            if !FREQUENCIES.contains(&tr.frequency.as_str()) {
                out.push(issue("block", None, format!("[trigger] frequency 只能是 daily / weekdays / weekly / hourly / manual，写的是「{}」", tr.frequency)));
            }
            if tr.hour > 23 || tr.minute > 59 {
                out.push(issue("block", None, "[trigger] 时间不对：hour 0–23、minute 0–59"));
            }
        } else if !tr.mode.is_empty() && !matches!(tr.mode.as_str(), "record" | "run") {
            out.push(issue("block", None, format!("[trigger] mode 只能是 record（只记录）或 run（直接跑），写的是「{}」", tr.mode)));
        }
        if tr.kind == "folder" {
            if tr.folder.trim().is_empty() {
                out.push(issue("block", None, "[trigger] 目录事件要写盯哪个目录（folder）"));
            } else if let Some(found) = path_issue("触发", "盯的目录", &tr.folder) {
                out.push(PackIssueDto { step: None, ..found });
            }
            for key in param_refs(&tr.folder) {
                if !pack.params.iter().any(|p| p.key == key) {
                    out.push(issue("block", None, format!("[trigger] 目录里用了没定义的参数 {{param:{key}}}")));
                } else if !used_params.contains(&key) {
                    used_params.push(key);
                }
            }
        }
        if tr.kind != "schedule" && tr.mode == "run" {
            out.push(issue("warn", None, "触发是直接跑：建议先写 record（只记录），装进项目看几次再改"));
        }
    }
    for p in &pack.params {
        if !used_params.contains(&p.key) {
            out.push(issue("warn", None, format!("参数「{}」没有被任何步骤用到", p.label)));
        }
    }
    for skill in &pack.skills {
        if lib_skills.iter().any(|s| s == skill) {
            out.push(issue("warn", None, format!("随包技能「{skill}」本机库里已有同名的：加进项目时用库里那份，不覆盖")));
        }
    }
    out
}

fn blocked(issues: &[PackIssueDto]) -> Option<String> {
    let blocks: Vec<String> = issues
        .iter()
        .filter(|i| i.level == "block")
        .map(|i| match &i.step {
            Some(s) => format!("「{s}」{}", i.message),
            None => i.message.clone(),
        })
        .collect();
    (!blocks.is_empty()).then(|| format!("没存：{}", blocks.join("；")))
}

/// 另存前的检查（前端先展示提醒、问人要不要照存；拦下的另存时后端还会再拒一次）
#[tauri::command]
pub async fn check_task_pack(name: String, params: Vec<StepParamDto>, steps: Vec<StepDto>) -> Result<Vec<PackIssueDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pack = TaskPackDto {
            id: "pk-check".into(),
            name,
            description: String::new(),
            version: 1,
            created_at: String::new(),
            updated_at: String::new(),
            params: crate::projects::normalize_step_params(params),
            steps: steps.into_iter().map(pack_step).collect(),
            ..Default::default()
        };
        Ok(check_pack(&pack, &crate::skills::library_skill_names()))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 跟 AI 写（第二期）：草稿在 <项目>/.ccode/pack-drafts/<id>/，写进 .git/info/exclude 不进 git =====
// 放项目里是因为 Agent 的沙箱多半不让写工作目录以外（Codex workspace-write）

const DRAFTS_REL: &str = ".ccode/pack-drafts";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackDraftDto {
    pub id: String,
    pub name: String,
    /// 草稿目录、pack.toml 相对项目根的路径（给 Agent 的提示词用）
    pub dir_rel: String,
    pub pack_rel: String,
    pub updated_at: String,
    /// 内置技能名（{skill:锚名} 的闭集）与本机库里的用户技能名，写进提示词
    pub anchors: Vec<String>,
    pub user_skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackDraftCheckDto {
    pub pack: Option<TaskPackDto>,
    pub issues: Vec<PackIssueDto>,
    /// pack.toml 读不懂时的原因（还没写、TOML 写错）
    pub parse_error: Option<String>,
}

fn draft_dir(project: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("草稿 id 不合法：{id}"));
    }
    Ok(project.join(DRAFTS_REL).join(id))
}

fn draft_dto(project: &Path, id: &str) -> PackDraftDto {
    let dir = project.join(DRAFTS_REL).join(id);
    let text = fs::read_to_string(dir.join(PACK_FILE)).unwrap_or_default();
    let name = toml::from_str::<toml::Value>(&text)
        .ok()
        .and_then(|v| v.get("pack")?.get("name")?.as_str().map(str::to_string))
        .unwrap_or_default();
    let updated_at = fs::metadata(dir.join(PACK_FILE))
        .and_then(|m| m.modified())
        .map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339())
        .unwrap_or_default();
    let user = crate::skills::library_skill_names();
    let anchors: Vec<String> = crate::skills::builtin_skill_names().into_iter().map(str::to_string).collect();
    PackDraftDto {
        id: id.to_string(),
        name,
        dir_rel: format!("{DRAFTS_REL}/{id}"),
        pack_rel: format!("{DRAFTS_REL}/{id}/{PACK_FILE}"),
        updated_at,
        user_skills: user.into_iter().filter(|s| !anchors.contains(s)).collect(),
        anchors,
    }
}

pub(crate) fn start_draft_at(project: &Path, name: &str, description: &str) -> Result<PackDraftDto, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("先给任务起个名字".into());
    }
    let id = format!("pk-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let dir = draft_dir(project, &id)?;
    fs::create_dir_all(dir.join("skills")).map_err(|e| format!("建草稿目录失败：{e}"))?;
    let skeleton = TaskPackDto {
        id: id.clone(),
        name: name.to_string(),
        description: description.trim().lines().next().unwrap_or_default().to_string(),
        version: 1,
        created_at: crate::sessions::now_iso(),
        updated_at: crate::sessions::now_iso(),
        ..Default::default()
    };
    crate::profiles::atomic_write(&dir.join(PACK_FILE), &render_pack(&skeleton)?)?;
    crate::projects::exclude_in_git(project, &format!("{DRAFTS_REL}/"));
    Ok(draft_dto(project, &id))
}

pub(crate) fn list_drafts_at(project: &Path) -> Vec<PackDraftDto> {
    let Ok(entries) = fs::read_dir(project.join(DRAFTS_REL)) else { return Vec::new() };
    let mut out: Vec<PackDraftDto> = entries
        .flatten()
        .filter(|e| e.path().join(PACK_FILE).is_file() && valid_id(&e.file_name().to_string_lossy()))
        .map(|e| draft_dto(project, &e.file_name().to_string_lossy()))
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

pub(crate) fn check_draft_at(project: &Path, id: &str, lib_skills: &[String]) -> Result<PackDraftCheckDto, String> {
    let dir = draft_dir(project, id)?;
    let text = match fs::read_to_string(dir.join(PACK_FILE)) {
        Ok(text) => text,
        Err(_) => return Ok(PackDraftCheckDto { pack: None, issues: Vec::new(), parse_error: Some("还没有 pack.toml".into()) }),
    };
    let value: toml::Value = match toml::from_str(&text) {
        Ok(v) => v,
        Err(e) => return Ok(PackDraftCheckDto { pack: None, issues: Vec::new(), parse_error: Some(format!("pack.toml 写法不对：{e}")) }),
    };
    let mut issues = check_structure(&value);
    match parse_pack(&text, &dir) {
        Ok(mut pack) => {
            // 草稿里的步骤不该带溯源与取值；id 以草稿目录为准
            pack.id = id.to_string();
            pack.steps = pack.steps.into_iter().map(pack_step).collect();
            issues.extend(check_pack(&pack, lib_skills));
            // 随包技能里的核验脚本要真有这个文件
            issues.extend(missing_check_scripts(&pack, &dir));
            // 草稿是 AI 写的：技能目录里的链接文件会被复制成它指向的真文件（可能是密钥、~/.ssh），一律拦下（2026-11-03 自查）
            if let Some(link) = first_symlink(&dir.join("skills")) {
                issues.push(issue("block", None, format!("技能目录里有链接文件 {link}：删掉，换成真文件")));
            }
            Ok(PackDraftCheckDto { pack: Some(pack), issues, parse_error: None })
        }
        Err(e) => Ok(PackDraftCheckDto { pack: None, issues, parse_error: Some(e) }),
    }
}

/// 草稿装进我的任务：有拦下就不装；随包技能 = 草稿 skills/ 里写的 + 步骤用到的本机用户技能（草稿里有的优先）
pub(crate) fn install_draft_at(
    project: &Path,
    packs: &Path,
    id: &str,
    overwrite: Option<&str>,
    lib_skills: &[String],
    library_dirs: &[(String, PathBuf)],
) -> Result<TaskPackDto, String> {
    let check = check_draft_at(project, id, lib_skills)?;
    if let Some(e) = check.parse_error {
        return Err(e);
    }
    if let Some(msg) = blocked(&check.issues) {
        return Err(msg);
    }
    let pack = check.pack.ok_or("草稿读不出来")?;
    let dir = draft_dir(project, id)?;
    let mut skill_dirs: Vec<(String, PathBuf)> = pack.skills.iter().map(|s| (s.clone(), dir.join("skills").join(s))).collect();
    for (name, path) in library_dirs {
        if !skill_dirs.iter().any(|(n, _)| n == name) {
            skill_dirs.push((name.clone(), path.clone()));
        }
    }
    let saved = save_with_trigger_at(
        packs,
        overwrite,
        &pack.name,
        &pack.description,
        pack.params,
        pack.steps,
        &skill_dirs,
        SaveExtras { trigger: pack.trigger, project_settings: Some(pack.project_settings), mcp: Some(pack.mcp), fresh: true, ..Default::default() },
    )?;
    let _ = fs::remove_dir_all(&dir);
    Ok(saved)
}

fn draft_project(project_root: &str) -> Result<PathBuf, String> {
    crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(project_root)))
}

#[tauri::command]
pub async fn start_task_pack_draft(project_root: String, name: String, description: String) -> Result<PackDraftDto, String> {
    tauri::async_runtime::spawn_blocking(move || start_draft_at(&draft_project(&project_root)?, &name, &description))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_task_pack_drafts(project_root: String) -> Result<Vec<PackDraftDto>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(list_drafts_at(&draft_project(&project_root)?)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn check_task_pack_draft(project_root: String, id: String) -> Result<PackDraftCheckDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_draft_at(&draft_project(&project_root)?, &id, &crate::skills::library_skill_names())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_task_pack_draft(project_root: String, id: String, overwrite: Option<String>) -> Result<TaskPackDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = draft_project(&project_root)?;
        let lib = crate::skills::library_skill_names();
        let names: Vec<String> = check_draft_at(&project, &id, &lib)?
            .pack
            .map(|p| {
                // 核验脚本与触发用到的本机技能也一并快照进包（2026-11-03 自查：只收了步骤技能，导出后别处装不上）
                let mut names: Vec<String> = p
                    .steps
                    .iter()
                    .flat_map(|s| s.skills.iter().chain(s.required_skills.iter()).chain(s.checks.iter().map(|c| &c.skill)).cloned())
                    .collect();
                names.extend(p.trigger.map(|t| t.skill));
                names
            })
            .unwrap_or_default();
        let library_dirs = crate::skills::user_skill_dirs(&names)?;
        install_draft_at(&project, &packs_root()?, &id, overwrite.as_deref(), &lib, &library_dirs)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 丢弃草稿：整个草稿目录进回收站
#[tauri::command]
pub async fn discard_task_pack_draft(project_root: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = draft_dir(&draft_project(&project_root)?, &id)?;
        if !dir.exists() {
            return Ok(());
        }
        crate::projects::trash_delete_retry(&dir, "任务草稿")
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 导出 / 导入（第四期，design-task-packs.md §7.2）=====
// 导出：包目录原样打成 zip（顶层一层 <id>/）。导入：先只读解到暂存区，列出会装的技能（与库里同名的怎么处理）、
// 随包的每个文件全文、参数与检查结果，人确认才装进我的任务；装好标「导入」，加进项目前再确认一次脚本。

const IMPORTS_DIR: &str = "pack-imports";
const IMPORT_MAX_ENTRIES: usize = 2000;
const IMPORT_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// 预览里给人看全文的单个文件上限；超了只列名字
const PREVIEW_TEXT_MAX: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackImportSkillDto {
    pub name: String,
    /// "new" 库里没有，会装 | "same" 库里有、内容一样 | "differs" 库里有同名但内容不同：用库里那份，包里这份不装
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackImportFileDto {
    /// `skills/<技能>/<相对路径>`
    pub path: String,
    pub size: u64,
    /// 文本且不太大时给全文；二进制或太大为 None
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackImportPreviewDto {
    /// 暂存区编号：确认装 / 放弃时带回来
    pub token: String,
    pub pack: TaskPackDto,
    pub issues: Vec<PackIssueDto>,
    pub skills: Vec<PackImportSkillDto>,
    /// 随包的全部文件（SKILL.md 也列：那是写给 Agent 的指令，一样要人看过）
    pub files: Vec<PackImportFileDto>,
    /// zip 里被忽略的条目数（包目录约定之外的文件）
    pub ignored: usize,
}

fn imports_root() -> Result<PathBuf, String> {
    Ok(crate::storage::config_root().ok_or("无法确定配置目录")?.join(IMPORTS_DIR))
}

pub(crate) fn export_at(root: &Path, id: &str, dest: &Path) -> Result<(), String> {
    let dir = pack_dir(root, id)?;
    if !dir.join(PACK_FILE).is_file() {
        return Err(format!("找不到任务包：{id}"));
    }
    let tmp = dest.with_extension(format!("zip.part-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| -> Result<(), String> {
        let file = fs::File::create(&tmp).map_err(|e| format!("建导出文件失败：{e}"))?;
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        let mut stack = vec![dir.clone()];
        while let Some(d) = stack.pop() {
            let mut entries: Vec<_> = fs::read_dir(&d).map_err(|e| e.to_string())?.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                let p = e.path();
                let ft = e.file_type().map_err(|e| e.to_string())?;
                if ft.is_dir() {
                    stack.push(p);
                } else if ft.is_file() {
                    let rel = p.strip_prefix(&dir).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
                    writer.start_file(format!("{id}/{rel}"), options).map_err(|e| format!("写 zip 失败：{e}"))?;
                    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
                    std::io::Write::write_all(&mut writer, &bytes).map_err(|e| e.to_string())?;
                }
            }
        }
        writer.finish().map_err(|e| format!("写 zip 失败：{e}"))?;
        fs::rename(&tmp, dest).map_err(|e| format!("写导出文件失败：{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// zip 里的条目名 → 包内相对路径：认顶层直接是 pack.toml，或只套一层目录；只收 pack.toml、based-on.json、skills/**
fn import_rel(name: &Path, prefix: &Option<PathBuf>) -> Option<PathBuf> {
    let rel = match prefix {
        Some(pre) => name.strip_prefix(pre).ok()?.to_path_buf(),
        None => name.to_path_buf(),
    };
    // 只收普通路径段：enclosed_name 会放过不越出 zip 根的 ..，去掉顶层目录后 skills/../../x 就能逃出暂存区（2026-11-03 自查）
    if !rel.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return None;
    }
    let s = rel.to_string_lossy().replace('\\', "/");
    (s == PACK_FILE || s == BASED_ON_FILE || (s.starts_with("skills/") && s.len() > 7)).then_some(rel)
}

fn dirs_equal(a: &Path, b: &Path) -> bool {
    fn files(root: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                match e.file_type() {
                    Ok(ft) if ft.is_dir() => stack.push(p),
                    Ok(ft) if ft.is_file() => {
                        let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                        // 库里的副本有 Mesa 自己的分发标记，不算内容
                        if !rel.starts_with(".ccode") {
                            out.push((rel, fs::read(&p).unwrap_or_default()));
                        }
                    }
                    _ => {}
                }
            }
        }
        out.sort();
        out
    }
    files(a) == files(b)
}

/// 只读解开到暂存区并检查。lib_dir：库里同名技能的目录（单测注入）
pub(crate) fn preview_import_at(
    imports: &Path,
    zip_path: &Path,
    lib_skills: &[String],
    lib_dir: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<PackImportPreviewDto, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读不懂这个 zip：{e}"))?;
    if archive.len() > IMPORT_MAX_ENTRIES {
        return Err(format!("zip 里文件太多（{} 个），不像一个任务包", archive.len()));
    }
    // 找 pack.toml：顶层或套一层目录
    let mut prefix: Option<Option<PathBuf>> = None;
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else { continue };
        let Some(name) = entry.enclosed_name() else { continue };
        if name.file_name().is_some_and(|n| n == PACK_FILE) {
            match name.parent() {
                Some(p) if p.as_os_str().is_empty() => prefix = Some(None),
                Some(p) if p.components().count() == 1 && prefix.is_none() => prefix = Some(Some(p.to_path_buf())),
                _ => {}
            }
        }
    }
    let prefix = prefix.ok_or("zip 里没有 pack.toml：不是 Mesa 导出的任务包")?;
    // 清掉一天以前没处理的暂存
    if let Ok(entries) = fs::read_dir(imports) {
        for e in entries.flatten() {
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
            if old.is_some_and(|d| d.as_secs() > 86_400) {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    let stage = imports.join(&token);
    let result = (|| -> Result<PackImportPreviewDto, String> {
        fs::create_dir_all(&stage).map_err(|e| format!("建暂存目录失败：{e}"))?;
        let mut total = 0u64;
        let mut ignored = 0usize;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| format!("读 zip 条目失败：{e}"))?;
            if entry.is_dir() {
                continue;
            }
            // 路径穿越与链接一律不收
            let is_link = entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000);
            let Some(rel) = entry.enclosed_name().filter(|_| !is_link).and_then(|n| import_rel(&n, &prefix)) else {
                ignored += 1;
                continue;
            };
            let out = stage.join(&rel);
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("建暂存目录失败：{e}"))?;
            }
            let mut buf = Vec::new();
            let budget = IMPORT_MAX_BYTES.saturating_sub(total) + 1;
            std::io::Read::read_to_end(&mut std::io::Read::take(&mut entry, budget), &mut buf)
                .map_err(|e| format!("解开 zip 失败：{e}"))?;
            total += buf.len() as u64;
            if total > IMPORT_MAX_BYTES {
                return Err(format!("解开后超过 {}MB，不像一个任务包", IMPORT_MAX_BYTES / 1024 / 1024));
            }
            fs::write(&out, &buf).map_err(|e| format!("写暂存文件失败：{e}"))?;
        }
        let text = fs::read_to_string(stage.join(PACK_FILE)).map_err(|_| "pack.toml 读不出来")?;
        let value: toml::Value = toml::from_str(&text).map_err(|e| format!("pack.toml 写法不对：{e}"))?;
        let mut issues = check_structure(&value);
        let pack = parse_pack(&text, &stage)?;
        issues.extend(check_pack(&pack, lib_skills));
        issues.extend(missing_check_scripts(&pack, &stage));
        let skills = pack
            .skills
            .iter()
            .map(|name| PackImportSkillDto {
                name: name.clone(),
                status: match lib_dir(name) {
                    None => "new",
                    Some(dir) if dirs_equal(&dir, &stage.join("skills").join(name)) => "same",
                    Some(_) => "differs",
                }
                .into(),
            })
            .collect();
        let mut files = Vec::new();
        for skill in &pack.skills {
            let mut paths = vec![format!("skills/{skill}/SKILL.md")];
            paths.extend(pack.scripts.iter().filter(|p| p.starts_with(&format!("skills/{skill}/"))).cloned());
            for path in paths {
                let full = stage.join(&path);
                let size = fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
                let text = (size <= PREVIEW_TEXT_MAX)
                    .then(|| fs::read(&full).ok().and_then(|b| String::from_utf8(b).ok()))
                    .flatten();
                files.push(PackImportFileDto { path, size, text });
            }
        }
        Ok(PackImportPreviewDto { token: token.clone(), pack, issues, skills, files, ignored })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

/// 目录下第一个符号链接（相对目录的路径）；没有返回 None
fn first_symlink(dir: &Path) -> Option<String> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).into_iter().flatten().flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                return Some(e.path().strip_prefix(dir).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default());
            }
            if ft.is_dir() {
                stack.push(e.path());
            }
        }
    }
    None
}

/// 核验脚本要真在随包技能里（草稿与导入同一条）
fn missing_check_scripts(pack: &TaskPackDto, dir: &Path) -> Vec<PackIssueDto> {
    let mut out = Vec::new();
    for step in &pack.steps {
        for c in step.checks.iter().filter(|c| pack.skills.contains(&c.skill)) {
            let rel = c.script.replace('\\', "/");
            if !rel.split('/').any(|seg| seg == "..") && !dir.join("skills").join(&c.skill).join(&rel).is_file() {
                out.push(issue("block", Some(&step.name), format!("核验「{}」的脚本 skills/{}/{} 不存在", c.name, c.skill, rel)));
            }
        }
    }
    out
}

fn import_stage(imports: &Path, token: &str) -> Result<PathBuf, String> {
    if token.len() != 32 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("导入编号不对".into());
    }
    Ok(imports.join(token))
}

/// 人确认后装进我的任务：再检查一遍，拦下的不装；标「导入」
pub(crate) fn install_import_at(
    imports: &Path,
    packs: &Path,
    token: &str,
    overwrite: Option<&str>,
    lib_skills: &[String],
) -> Result<TaskPackDto, String> {
    let stage = import_stage(imports, token)?;
    let text = fs::read_to_string(stage.join(PACK_FILE)).map_err(|_| "导入已失效：重新选一次 zip")?;
    let value: toml::Value = toml::from_str(&text).map_err(|e| format!("pack.toml 写法不对：{e}"))?;
    let pack = parse_pack(&text, &stage)?;
    let mut issues = check_structure(&value);
    issues.extend(check_pack(&pack, lib_skills));
    issues.extend(missing_check_scripts(&pack, &stage));
    if let Some(msg) = blocked(&issues) {
        return Err(msg);
    }
    let skill_dirs: Vec<(String, PathBuf)> = pack.skills.iter().map(|s| (s.clone(), stage.join("skills").join(s))).collect();
    let saved = save_with_trigger_at(
        packs,
        overwrite,
        &pack.name,
        &pack.description,
        pack.params,
        pack.steps,
        &skill_dirs,
        SaveExtras { trigger: pack.trigger, based_on: pack.based_on, imported: true, project_settings: Some(pack.project_settings), mcp: Some(pack.mcp), fresh: true },
    )?;
    let _ = fs::remove_dir_all(&stage);
    Ok(saved)
}

#[tauri::command]
pub async fn export_task_pack(id: String, dest_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_at(&packs_root()?, &id, Path::new(&dest_path))?;
        Ok(dest_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn preview_task_pack_import(zip_path: String) -> Result<PackImportPreviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        preview_import_at(
            &imports_root()?,
            Path::new(&zip_path),
            &crate::skills::library_skill_names(),
            &crate::skills::library_skill_dir,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_task_pack_import(token: String, overwrite: Option<String>) -> Result<TaskPackDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_import_at(&imports_root()?, &packs_root()?, &token, overwrite.as_deref(), &crate::skills::library_skill_names())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 放弃导入：删暂存（Mesa 自己的临时目录，不进回收站）
#[tauri::command]
pub async fn discard_task_pack_import(token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stage = import_stage(&imports_root()?, &token)?;
        if stage.exists() {
            fs::remove_dir_all(&stage).map_err(|e| format!("清暂存失败：{e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(name: &str, brief: &str) -> StepDto {
        StepDto {
            name: name.into(),
            workspace_name: name.into(),
            brief: brief.into(),
            expected_artifacts: vec!["out/report.md".into()],
            skills: vec!["my-qc".into()],
            pack: "old".into(),
            params: vec![StepParamDto { key: "x".into(), ..Default::default() }],
            seed_complete: true,
            ..Default::default()
        }
    }

    fn param(key: &str, label: &str, value: &str) -> StepParamDto {
        StepParamDto { key: key.into(), label: label.into(), value: value.into(), ..Default::default() }
    }

    #[test]
    fn param_refs_finds_valid_keys_once() {
        assert_eq!(param_refs("投 {param:journal}，阈值 {param:p_value} 再投 {param:journal} {param:坏} {param:"), ["journal", "p_value"]);
    }

    #[test]
    fn save_round_trips_and_bumps_version_and_rejects_undefined_params() {
        let dir = std::env::temp_dir().join(format!("mesa-pack-{}", uuid::Uuid::new_v4()));
        let _config = crate::storage::redirect_config_root(&dir.join("config"));
        let root = dir.join("packs");
        let skill_src = dir.join("lib/my-qc");
        fs::create_dir_all(&skill_src).unwrap();
        fs::write(skill_src.join("SKILL.md"), "---\nname: my-qc\n---\n质控").unwrap();
        let skills = vec![("my-qc".to_string(), skill_src.clone())];
        assert!(save_at(&root, None, " ", "", vec![], vec![step("a", "b")], &skills).is_err());
        assert!(save_at(&root, None, "质控", "", vec![], vec![step("a", "按 {param:journal} 投")], &skills)
            .unwrap_err()
            .contains("没定义的参数"));
        let mut s = step("单细胞质控", "按 {param:journal} 的要求，线粒体比例阈值 {param:mt}");
        s.acceptance_criteria = vec!["报告写明阈值 {param:mt}".into()];
        let first = save_at(
            &root,
            None,
            "单细胞质控",
            "组里的 QC 流程",
            vec![param("journal", "目标期刊", "Nature"), param("mt", "线粒体阈值", "20%")],
            vec![s.clone()],
            &skills,
        )
        .unwrap();
        assert!(first.id.starts_with("pk-"));
        assert_eq!(first.version, 1);
        assert_eq!(first.skills, ["my-qc"]);
        let st = &first.steps[0];
        assert_eq!(st.brief, s.brief);
        assert_eq!(st.acceptance_criteria, s.acceptance_criteria);
        assert!(st.pack.is_empty() && st.params.is_empty() && !st.seed_complete, "包里的步骤不带溯源与取值");
        assert_eq!(first.params[1].value, "20%");
        let text = fs::read_to_string(root.join(&first.id).join(PACK_FILE)).unwrap();
        assert!(text.starts_with("# Mesa 任务包：单细胞质控"), "{text}");
        assert!(!text.contains("artifact_dir"), "只留步骤，不带项目级键：{text}");
        // 覆盖：版本 +1，建立时间不变；这次没给的随包技能沿用旧版本的
        let second = save_at(&root, Some(&first.id), "单细胞质控", "改过", first.params.clone(), first.steps.clone(), &[]).unwrap();
        assert_eq!(second.version, 2);
        assert_eq!(second.created_at, first.created_at);
        assert_eq!(second.skills, ["my-qc"]);
        assert_eq!(list_at(&root).len(), 1);
        assert!(save_at(&root, Some("../x"), "n", "", vec![], vec![step("a", "b")], &[]).is_err());
        // 加进项目：取值按人填的，没填用默认；每一步带包 id
        let values = BTreeMap::from([("journal".to_string(), " Cell ".to_string())]);
        let steps = steps_for_project(&second, &values);
        assert_eq!(steps[0].pack, second.id);
        assert_eq!(steps[0].params.iter().map(|p| p.value.as_str()).collect::<Vec<_>>(), ["Cell", "20%"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_toml_keeps_pack_and_params() {
        let mut s = step("质控", "按 {param:journal}");
        s.pack = "pk-abc".into();
        s.params = vec![StepParamDto {
            key: "journal".into(),
            label: "目标期刊".into(),
            value: "Nature".into(),
            help: "投哪家".into(),
            options: vec!["Nature".into(), "Cell".into()],
            kind: String::new(),
        }];
        let cfg = ProjectConfigDto { steps: vec![s.clone()], ..Default::default() };
        let text = crate::projects::render_config(None, &cfg).unwrap();
        let back = crate::projects::parse_config(&text).0.steps;
        assert_eq!(back[0].pack, "pk-abc");
        assert_eq!(back[0].params, s.params);
    }

    fn levels(issues: &[PackIssueDto], level: &str) -> Vec<String> {
        issues.iter().filter(|i| i.level == level).map(|i| i.message.clone()).collect()
    }

    #[test]
    fn check_blocks_and_warns() {
        let good = StepDto {
            name: "质控".into(),
            brief: "按 {skill:data-clean} 做质控，期刊 {param:j}".into(),
            expected_artifacts: vec!["analysis/qc.md".into()],
            acceptance_criteria: vec!["写明阈值".into()],
            ..Default::default()
        };
        let mut pack = TaskPackDto {
            id: "pk-x".into(),
            name: "质控".into(),
            description: String::new(),
            version: 1,
            created_at: String::new(),
            updated_at: String::new(),
            params: vec![param("j", "期刊", "Nature"), param("unused", "没用上", "x")],
            steps: vec![good.clone()],
            ..Default::default()
        };
        let issues = check_pack(&pack, &[]);
        assert!(levels(&issues, "block").is_empty(), "{issues:?}");
        assert_eq!(levels(&issues, "warn"), ["参数「没用上」没有被任何步骤用到"]);
        // 拦下：越界路径、.git、不认得的技能位、没简报、重名、像密钥
        let bad = StepDto {
            name: "质控".into(),
            brief: "按 {skill:not-a-skill} 做，key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".into(),
            expected_artifacts: vec!["../out.md".into(), ".git/x".into()],
            inputs: vec!["/abs/in.csv".into()],
            ..Default::default()
        };
        let empty = StepDto { name: "空".into(), ..Default::default() };
        pack.steps = vec![good.clone(), bad, empty];
        let blocks = levels(&check_pack(&pack, &[]), "block");
        for want in ["步骤名重复", "不是认得的技能位", "像是有密钥", "「../out.md」要写成项目内的相对路径", "不能指向 .git", "「/abs/in.csv」要写成项目内的相对路径", "没有简报"] {
            assert!(blocks.iter().any(|b| b.contains(want)), "缺「{want}」：{blocks:?}");
        }
        // 提醒：只写目录的产物、没验收、上游没提供的输入、要问人却没决策项、本机没有的技能
        let step2 = StepDto {
            name: "注释".into(),
            brief: "做完问用户要不要继续".into(),
            expected_artifacts: vec!["figures/*".into()],
            inputs: vec!["data/raw.csv".into()],
            skills: vec!["my-anno".into()],
            ..Default::default()
        };
        pack.steps = vec![good, step2];
        let warns = levels(&check_pack(&pack, &[]), "warn");
        for want in ["只写了目录或通配", "没有验收条件", "不是前面步骤的产物", "简报说要问人", "技能「my-anno」本机没有"] {
            assert!(warns.iter().any(|w| w.contains(want)), "缺「{want}」：{warns:?}");
        }
        // save_at 拒存有拦下的
        let dir = std::env::temp_dir().join(format!("mesa-pack-chk-{}", uuid::Uuid::new_v4()));
        let _config = crate::storage::redirect_config_root(&dir.join("config"));
        let err = save_at(&dir.join("packs"), None, "x", "", vec![], vec![StepDto { name: "a".into(), ..Default::default() }], &[]).unwrap_err();
        assert!(err.contains("没有简报"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn draft_round_trip_checks_structure_then_installs() {
        let dir = std::env::temp_dir().join(format!("mesa-pack-draft-{}", uuid::Uuid::new_v4()));
        let _config = crate::storage::redirect_config_root(&dir.join("config"));
        let project = dir.join("proj");
        fs::create_dir_all(&project).unwrap();
        assert!(start_draft_at(&project, " ", "").is_err());
        let draft = start_draft_at(&project, "单细胞质控", "组里的 QC\n第二行不要").unwrap();
        assert_eq!(draft.pack_rel, format!(".ccode/pack-drafts/{}/pack.toml", draft.id));
        assert_eq!(draft.name, "单细胞质控");
        assert!(draft.anchors.iter().any(|a| a == "data-clean"));
        assert_eq!(list_drafts_at(&project).len(), 1);
        // 骨架没有步骤：检查给出拦下
        let skeleton = check_draft_at(&project, &draft.id, &[]).unwrap();
        assert!(levels(&skeleton.issues, "block").iter().any(|m| m.contains("至少要有一个步骤")));
        // AI 写的 pack.toml：带一个写错的字段与决策模式
        let ddir = project.join(&draft.dir_rel);
        fs::write(
            ddir.join(PACK_FILE),
            format!(
                "[pack]\nid = \"{}\"\nname = \"单细胞质控\"\ndescription = \"QC\"\n\n[[params]]\nkey = \"mt\"\nlabel = \"线粒体阈值\"\nvalue = \"20%\"\n\n[[steps]]\nname = \"质控\"\nbrief = \"线粒体阈值 {{param:mt}}，按 my-qc 技能做\"\nexpected_artifacts = [\"analysis/qc.md\"]\nacceptance_criteria = [\"写明阈值\"]\nskills = [\"my-qc\"]\ndecision_mode = \"maybe\"\nbreif = \"拼错\"\n",
                draft.id
            ),
        )
        .unwrap();
        fs::create_dir_all(ddir.join("skills/my-qc")).unwrap();
        fs::write(ddir.join("skills/my-qc/SKILL.md"), "---\nname: my-qc\n---\n质控").unwrap();
        let checked = check_draft_at(&project, &draft.id, &[]).unwrap();
        let blocks = levels(&checked.issues, "block");
        assert!(blocks.iter().any(|b| b.contains("不认识的字段「breif」")), "{blocks:?}");
        assert!(blocks.iter().any(|b| b.contains("decision_mode")), "{blocks:?}");
        assert!(install_draft_at(&project, &dir.join("packs"), &draft.id, None, &[], &[]).unwrap_err().starts_with("没存："));
        // 改对了再装：随包技能来自草稿，装完草稿目录删掉
        let text = fs::read_to_string(ddir.join(PACK_FILE)).unwrap().replace("decision_mode = \"maybe\"\nbreif = \"拼错\"\n", "");
        fs::write(ddir.join(PACK_FILE), text).unwrap();
        let ok = check_draft_at(&project, &draft.id, &[]).unwrap();
        assert!(levels(&ok.issues, "block").is_empty(), "{:?}", ok.issues);
        let installed = install_draft_at(&project, &dir.join("packs"), &draft.id, None, &[], &[]).unwrap();
        assert_eq!(installed.skills, ["my-qc"]);
        assert_eq!(installed.params[0].value, "20%");
        assert!(!ddir.exists());
        assert!(list_drafts_at(&project).is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn checks_and_trigger_round_trip_validate_and_create() {
        let dir = std::env::temp_dir().join(format!("mesa-pack-p3-{}", uuid::Uuid::new_v4()));
        let _config = crate::storage::redirect_config_root(&dir.join("config"));
        let project = dir.join("proj");
        fs::create_dir_all(project.join("data/incoming")).unwrap();
        let draft = start_draft_at(&project, "质控", "").unwrap();
        let ddir = project.join(&draft.dir_rel);
        let pack_toml = |trigger: &str, script: &str| {
            format!(
                "[pack]\nid = \"{id}\"\nname = \"质控\"\n\n[[params]]\nkey = \"inbox\"\nlabel = \"数据目录\"\nvalue = \"data/incoming\"\n\n{trigger}\n[[steps]]\nname = \"质控\"\nbrief = \"按 sc-qc 做\"\nexpected_artifacts = [\"analysis/qc.md\"]\nacceptance_criteria = [\"写明阈值\"]\nskills = [\"sc-qc\"]\n\n[[steps.checks]]\nname = \"qc-thresholds\"\nskill = \"sc-qc\"\nscript = \"{script}\"\ndescription = \"阈值是否都写进报告\"\n",
                id = draft.id
            )
        };
        fs::create_dir_all(ddir.join("skills/sc-qc/scripts")).unwrap();
        fs::write(ddir.join("skills/sc-qc/SKILL.md"), "---\nname: sc-qc\n---\n").unwrap();
        // 写错的：脚本不存在、触发 kind / frequency 不认识、核验名带大写、多余字段
        fs::write(
            ddir.join(PACK_FILE),
            pack_toml("[trigger]\nkind = \"webhook\"\nskill = \"sc-qc\"\nwhen = \"x\"\n", "scripts/nope.py").replace("qc-thresholds", "QC"),
        )
        .unwrap();
        let bad = check_draft_at(&project, &draft.id, &[]).unwrap();
        let blocks = levels(&bad.issues, "block");
        for want in ["不认识的字段「when」", "kind 只能是", "核验名「QC」", "脚本 skills/sc-qc/scripts/nope.py 不存在"] {
            assert!(blocks.iter().any(|b| b.contains(want)), "缺「{want}」：{blocks:?}");
        }
        // 改对：目录事件、目录用参数、脚本真在
        fs::write(ddir.join("skills/sc-qc/scripts/qc_check.py"), "print('ok')").unwrap();
        fs::write(
            ddir.join(PACK_FILE),
            pack_toml("[trigger]\nname = \"新数据质控\"\nkind = \"folder\"\nskill = \"sc-qc\"\nfolder = \"{param:inbox}\"\nexts = [\"h5\"]\n", "scripts/qc_check.py"),
        )
        .unwrap();
        let ok = check_draft_at(&project, &draft.id, &[]).unwrap();
        assert!(levels(&ok.issues, "block").is_empty(), "{:?}", ok.issues);
        let pack = install_draft_at(&project, &dir.join("packs"), &draft.id, None, &[], &[]).unwrap();
        let tr = pack.trigger.clone().expect("触发随包");
        assert_eq!((tr.kind.as_str(), tr.folder.as_str(), tr.mode.as_str()), ("folder", "{param:inbox}", "record"));
        assert_eq!(pack.steps[0].checks[0].script, "scripts/qc_check.py");
        // 覆盖另存（拿不到触发）沿用旧的
        let again = save_at(&dir.join("packs"), Some(&pack.id), "质控", "", pack.params.clone(), pack.steps.clone(), &[]).unwrap();
        assert_eq!(again.trigger, pack.trigger);
        // 加进项目：步骤带核验进 project.toml；触发按参数取值建成只记录的事件规则
        let steps = steps_for_project(&again, &BTreeMap::new());
        crate::projects::apply_pipeline_template_at(&project, steps, Vec::new(), "append", None, None, None).unwrap();
        let back = crate::projects::read_config_at(&project).config;
        assert_eq!(back.steps[0].checks[0].name, "qc-thresholds");
        let note = create_trigger(&project, &again, again.trigger.as_ref().unwrap(), &BTreeMap::new());
        assert!(note.contains("建了事件规则「新数据质控」（先只记录）"), "{note}");
        let list = crate::scheduler::read_schedules_for_test();
        let rule = list.iter().find(|t| t.name == "新数据质控").unwrap();
        assert_eq!(rule.event.as_ref().unwrap().folder.as_deref(), Some("data/incoming"));
        // 目录不存在：建不成、说明原因，不 panic
        let values = BTreeMap::from([("inbox".to_string(), "no/such".to_string())]);
        assert!(create_trigger(&project, &again, again.trigger.as_ref().unwrap(), &values).contains("没建成触发"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_import_preview_install_and_based_on_carry() {
        let dir = std::env::temp_dir().join(format!("mesa-pack-p4-{}", uuid::Uuid::new_v4()));
        let _config = crate::storage::redirect_config_root(&dir.join("config"));
        let packs = dir.join("packs");
        let skill_src = dir.join("lib/sc-qc");
        fs::create_dir_all(skill_src.join("scripts")).unwrap();
        fs::write(skill_src.join("SKILL.md"), "---\nname: sc-qc\n---\n质控").unwrap();
        fs::write(skill_src.join("scripts/qc_check.py"), "print('ok')\n").unwrap();
        let mut s = step("质控", "按 {param:mt} 做");
        s.skills = vec!["sc-qc".into()];
        s.checks = vec![crate::projects::StepCheckDto {
            name: "qc".into(),
            skill: "sc-qc".into(),
            script: "scripts/qc_check.py".into(),
            description: String::new(),
        }];
        let based = PackBasedOnDto {
            template: "review".into(),
            template_name: "综述".into(),
            steps: vec![StepDto { name: "质控".into(), brief: " 旧 ".into(), ..Default::default() }],
            ..Default::default()
        };
        let saved = save_with_trigger_at(
            &packs,
            None,
            "质控",
            "",
            vec![param("mt", "线粒体阈值", "20%")],
            vec![s],
            &[("sc-qc".to_string(), skill_src.clone())],
            SaveExtras { based_on: Some(based.clone()), ..Default::default() },
        )
        .unwrap();
        // 对照步骤存前归一：与包步骤读回来同一个样子
        let b = saved.based_on.clone().unwrap();
        assert_eq!((b.template.as_str(), b.steps.len()), ("review", 1));
        assert_eq!(b.steps, normalize_steps(based.steps.clone()).unwrap());
        assert_eq!(b.steps[0].decision_mode, "auto_continue");
        assert_eq!(saved.scripts, ["skills/sc-qc/scripts/qc_check.py"]);
        assert!(!saved.imported);
        // 覆盖另存不给 based_on：沿用
        let again = save_at(&packs, Some(&saved.id), "质控", "", saved.params.clone(), saved.steps.clone(), &[]).unwrap();
        assert_eq!(again.based_on, saved.based_on);
        // 项目设定：给了就存，覆盖另存不给就沿用
        let with_settings = save_with_trigger_at(
            &packs,
            Some(&saved.id),
            "质控",
            "",
            saved.params.clone(),
            saved.steps.clone(),
            &[],
            SaveExtras { project_settings: Some(vec!["综述角度：（写一句）".into(), "目标期刊：Nature".into()]), ..Default::default() },
        )
        .unwrap();
        assert_eq!(with_settings.project_settings, ["综述角度：（写一句）", "目标期刊：Nature"]);
        let again = save_at(&packs, Some(&saved.id), "质控", "", saved.params.clone(), saved.steps.clone(), &[]).unwrap();
        assert_eq!(again.project_settings, with_settings.project_settings);

        // 导出：顶层一层 <id>/
        let zip_path = dir.join("out.zip");
        export_at(&packs, &again.id, &zip_path).unwrap();
        let names: Vec<String> = {
            let mut a = zip::ZipArchive::new(fs::File::open(&zip_path).unwrap()).unwrap();
            (0..a.len()).map(|i| a.by_index(i).unwrap().name().to_string()).collect()
        };
        for want in ["pack.toml", "based-on.json", "skills/sc-qc/SKILL.md", "skills/sc-qc/scripts/qc_check.py"] {
            assert!(names.contains(&format!("{}/{want}", again.id)), "{names:?}");
        }

        // 导入预览：库里同名技能内容不同 → differs；文件全文给人看；多余条目忽略
        let imports = dir.join("imports");
        let lib_other = dir.join("lib-other/sc-qc");
        fs::create_dir_all(&lib_other).unwrap();
        fs::write(lib_other.join("SKILL.md"), "别的版本").unwrap();
        let lib = |name: &str| (name == "sc-qc").then(|| lib_other.clone());
        let preview = preview_import_at(&imports, &zip_path, &[], &lib).unwrap();
        assert!(levels(&preview.issues, "block").is_empty(), "{:?}", preview.issues);
        assert_eq!(preview.skills[0].status, "differs");
        let script = preview.files.iter().find(|f| f.path.ends_with("qc_check.py")).unwrap();
        assert_eq!(script.text.as_deref(), Some("print('ok')\n"));
        assert!(preview.files.iter().any(|f| f.path == "skills/sc-qc/SKILL.md"));
        assert_eq!(preview.pack.based_on, saved.based_on);
        assert!(imports.join(&preview.token).is_dir());
        let same = |_: &str| Some(skill_src.clone());
        assert_eq!(preview_import_at(&imports, &zip_path, &[], &same).unwrap().skills[0].status, "same");

        // 装进去：新 id、标导入、based_on 跟着走，暂存删掉
        let installed = install_import_at(&imports, &packs, &preview.token, None, &[]).unwrap();
        assert_ne!(installed.id, again.id);
        assert!(installed.imported);
        assert_eq!(installed.based_on, saved.based_on);
        assert!(!imports.join(&preview.token).exists());
        assert!(install_import_at(&imports, &packs, &preview.token, None, &[]).is_err(), "暂存用过就没了");
        assert!(install_import_at(&imports, &packs, "../x", None, &[]).is_err());
        // 本人覆盖另存：导入标记不清（脚本还是别人写的）；确认过脚本后才清
        let resaved = save_at(&packs, Some(&installed.id), "质控", "", installed.params.clone(), installed.steps.clone(), &[]).unwrap();
        assert!(resaved.imported);
        clear_imported_at(&packs, &installed.id).unwrap();
        let cleared = read_pack_at(&packs, &installed.id).unwrap();
        assert!(!cleared.imported);
        assert_eq!(cleared.version, resaved.version, "去标记不升版本");

        // 不是任务包的 zip、路径穿越条目
        let bad = dir.join("bad.zip");
        {
            let mut w = zip::ZipWriter::new(fs::File::create(&bad).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            w.start_file("readme.txt", o).unwrap();
            std::io::Write::write_all(&mut w, b"x").unwrap();
            w.finish().unwrap();
        }
        assert!(preview_import_at(&imports, &bad, &[], &lib).unwrap_err().contains("没有 pack.toml"));
        let evil = dir.join("evil.zip");
        {
            let mut w = zip::ZipWriter::new(fs::File::create(&evil).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            w.start_file("pack.toml", o).unwrap();
            std::io::Write::write_all(&mut w, b"[pack]\nid = \"pk-a\"\nname = \"a\"\n\n[[steps]]\nname = \"a\"\nbrief = \"b\"\nexpected_artifacts = [\"o.md\"]\n").unwrap();
            w.start_file("../escape.txt", o).unwrap();
            std::io::Write::write_all(&mut w, b"x").unwrap();
            w.start_file("notes/other.txt", o).unwrap();
            std::io::Write::write_all(&mut w, b"x").unwrap();
            w.finish().unwrap();
        }
        let p = preview_import_at(&imports, &evil, &[], &lib).unwrap();
        assert_eq!(p.ignored, 2);
        assert!(!dir.join("escape.txt").exists() && !imports.join("escape.txt").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn selfcheck_zip_dotdot_fresh_overwrite_machine_params_and_symlinks() {
        // zip 条目去掉顶层目录后带 .. 的不收
        let pre = Some(PathBuf::from("a"));
        assert!(import_rel(Path::new("a/skills/../../evil/x"), &pre).is_none());
        assert!(import_rel(Path::new("a/skills/x/SKILL.md"), &pre).is_some());
        // 整份换掉（导入 / 装草稿）不沿用旧版本的触发与 based_on
        let dir = std::env::temp_dir().join(format!("mesa-pack-sc-{}", uuid::Uuid::new_v4()));
        let _config = crate::storage::redirect_config_root(&dir.join("config"));
        let packs = dir.join("packs");
        let s = StepDto { name: "a".into(), brief: "b".into(), expected_artifacts: vec!["o.md".into()], ..Default::default() };
        let skill = dir.join("lib/sc");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "---\nname: sc\n---\n").unwrap();
        let trig = PackTriggerDto { kind: "radar".into(), skill: "sc".into(), ..Default::default() };
        let bundled = [("sc".to_string(), skill.clone())];
        let first = save_with_trigger_at(&packs, None, "包", "", vec![], vec![s.clone()], &bundled, SaveExtras { trigger: Some(trig), ..Default::default() }).unwrap();
        assert!(first.trigger.is_some());
        let kept = save_at(&packs, Some(&first.id), "包", "", vec![], vec![s.clone()], &[]).unwrap();
        assert!(kept.trigger.is_some(), "本人覆盖另存照旧沿用");
        let fresh = save_with_trigger_at(&packs, Some(&first.id), "包", "", vec![], vec![s.clone()], &[], SaveExtras { fresh: true, ..Default::default() }).unwrap();
        assert!(fresh.trigger.is_none() && fresh.based_on.is_none());
        assert_eq!(fresh.version, kept.version + 1, "版本号照旧接上");
        // machine: 行里写参数拦下；machine 行不算参数用到
        let mut m = s.clone();
        m.acceptance_criteria = vec!["machine:exists:{param:dir}/x.md".into()];
        let pack = TaskPackDto { name: "x".into(), params: vec![param("dir", "目录", "out")], steps: vec![m], ..Default::default() };
        let issues = check_pack(&pack, &[]);
        assert!(issues.iter().any(|i| i.level == "block" && i.message.contains("machine:")), "{issues:?}");
        // 草稿技能目录里的链接文件拦下
        #[cfg(unix)]
        {
            let project = dir.join("proj");
            let draft = start_draft_at(&project, "链接", "").unwrap();
            let ddir = project.join(&draft.dir_rel);
            fs::create_dir_all(ddir.join("skills/x")).unwrap();
            fs::write(ddir.join("skills/x/SKILL.md"), "---\nname: x\n---\n").unwrap();
            std::os::unix::fs::symlink("/etc/hosts", ddir.join("skills/x/k")).unwrap();
            let text = fs::read_to_string(ddir.join(PACK_FILE)).unwrap()
                + "\n[[steps]]\nname = \"a\"\nbrief = \"b\"\nexpected_artifacts = [\"o.md\"]\nacceptance_criteria = [\"c\"]\n";
            fs::write(ddir.join(PACK_FILE), text).unwrap();
            let checked = check_draft_at(&project, &draft.id, &[]).unwrap();
            assert!(checked.issues.iter().any(|i| i.level == "block" && i.message.contains("链接文件 x/k")), "{:?}", checked.issues);
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn typed_params_normalize_validate_and_round_trip() {
        use crate::projects::{normalize_step_params, param_value_problem};
        let p = |key: &str, kind: &str, value: &str| StepParamDto {
            key: key.into(),
            label: key.into(),
            value: value.into(),
            kind: kind.into(),
            options: vec!["a".into()],
            ..Default::default()
        };
        let got = normalize_step_params(vec![
            p("n", "Number", "0.05"),
            p("n2", "number", "五"),
            p("b", "bool", "true"),
            p("b2", "bool", "也许"),
            p("dir", "path", "data/raw/"),
            p("bad", "file", "../secret.txt"),
            p("abs", "file", "/etc/passwd"),
            p("x", "color", "红"),
        ]);
        let v: Vec<(&str, &str, &str)> = got.iter().map(|q| (q.key.as_str(), q.kind.as_str(), q.value.as_str())).collect();
        assert_eq!(
            v,
            [("n", "number", "0.05"), ("n2", "number", ""), ("b", "bool", "是"), ("b2", "bool", ""), ("dir", "path", "data/raw/"), ("bad", "file", ""), ("abs", "file", ""), ("x", "", "红")]
        );
        assert!(got[0].options.is_empty(), "有类型的不是下拉");
        assert_eq!(got[7].options, ["a"], "不认得的类型当普通参数，下拉照旧");
        assert!(param_value_problem("file", "C:/x.txt").is_some());
        assert!(param_value_problem("number", "").is_none(), "空值不算错");
        // 写进 project.toml 再读回，类型跟着走
        let mut s = step("质控", "读 {param:dir}");
        s.params = got[..5].to_vec();
        let cfg = ProjectConfigDto { steps: vec![s.clone()], ..Default::default() };
        let text = crate::projects::render_config(None, &cfg).unwrap();
        assert!(text.contains("kind = \"path\""), "{text}");
        assert_eq!(crate::projects::parse_config(&text).0.steps[0].params, s.params);
    }

    #[test]
    fn pack_mcp_round_trips_and_blocks_secrets() {
        let dir = std::env::temp_dir().join(format!("mesa-pack-mcp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let pack = TaskPackDto {
            id: "pk-abcdefabcdef".into(),
            name: "质控".into(),
            version: 1,
            steps: vec![step("质控", "按 sc-qc 做")],
            mcp: vec!["zotero：读文献库题录".into()],
            ..Default::default()
        };
        let text = render_pack(&pack).unwrap();
        assert!(text.contains("mcp = [\"zotero：读文献库题录\"]"), "{text}");
        let back = parse_pack(&text, &dir).unwrap();
        assert_eq!(back.mcp, pack.mcp);
        let value: toml::Value = toml::from_str(&text).unwrap();
        let issues = check_structure(&value);
        assert!(!issues.iter().any(|i| i.message.contains("mcp")), "mcp 在 [pack] 字段闭集里：{issues:?}");
        let leaky = TaskPackDto { mcp: vec!["github：token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()], ..pack };
        assert!(check_pack(&leaky, &[]).iter().any(|i| i.level == "block" && i.message.contains("MCP")));
        // 一步里 skills 与 required_skills 写了同一个技能，只提醒一次（2026-11-04 真实项目往返干跑发现）
        let mut st = step("检索", "按 lit-search 做");
        st.skills = vec!["lit-search".into()];
        st.required_skills = vec!["lit-search".into()];
        let twice = TaskPackDto { steps: vec![st], mcp: Vec::new(), ..leaky };
        assert_eq!(check_pack(&twice, &[]).iter().filter(|i| i.message.contains("lit-search")).count(), 1);
        fs::remove_dir_all(&dir).ok();
    }
}
