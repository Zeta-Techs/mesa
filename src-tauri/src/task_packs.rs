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

#[derive(Debug, Clone, Serialize, PartialEq)]
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPackResultDto {
    pub appended: usize,
    pub skipped: Vec<String>,
    pub renamed: Vec<crate::projects::WorkspaceRenameDto>,
    /// 这次新装进技能库的随包技能（默认没分发给任何 Agent，要去技能页打开）
    pub skills_added: Vec<String>,
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
    out.extend(step.acceptance_criteria.iter().map(String::as_str));
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
    Ok(TaskPackDto {
        name: s("name"),
        description: s("description"),
        version: meta.get("version").and_then(|v| v.as_integer()).unwrap_or(1).clamp(1, i64::from(u32::MAX)) as u32,
        created_at: s("created_at"),
        updated_at: s("updated_at"),
        params: crate::projects::normalize_step_params(params),
        steps: crate::projects::parse_config(text).0.steps,
        skills,
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

pub(crate) fn save_at(
    root: &Path,
    id: Option<&str>,
    name: &str,
    description: &str,
    params: Vec<StepParamDto>,
    steps: Vec<StepDto>,
    skill_dirs: &[(String, PathBuf)],
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
    };
    // 先在临时目录写全，再整目录换上：中途失败不留半个包
    let final_dir = pack_dir(root, &pack.id)?;
    let tmp = root.join(format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| -> Result<(), String> {
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        crate::profiles::atomic_write(&tmp.join(PACK_FILE), &render_pack(&pack)?)?;
        for (skill, src) in skill_dirs {
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

/// 另存为我的任务：步骤用到的用户技能一并快照进包。id 给了就是覆盖那一个（同名覆盖的确认在前端）
#[tauri::command]
pub async fn save_task_pack(
    id: Option<String>,
    name: String,
    description: String,
    params: Vec<StepParamDto>,
    steps: Vec<StepDto>,
) -> Result<TaskPackDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut names: Vec<String> = Vec::new();
        for s in &steps {
            for k in s.skills.iter().chain(s.required_skills.iter()) {
                if !names.contains(k) {
                    names.push(k.clone());
                }
            }
        }
        let skill_dirs = crate::skills::user_skill_dirs(&names)?;
        save_at(&packs_root()?, id.as_deref(), &name, &description, params, steps, &skill_dirs)
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

/// 从我的任务加进项目流程末尾：先补装库里缺的随包技能，再按模板追加同一条原子写入
#[tauri::command]
pub async fn add_task_pack_to_project(
    project_root: String,
    id: String,
    values: BTreeMap<String, String>,
) -> Result<AddPackResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        let packs = packs_root()?;
        let pack = read_pack_at(&packs, &id)?;
        let skills = crate::skills::install_pack_skills(&pack_dir(&packs, &id)?.join("skills"))?;
        let res = crate::projects::apply_pipeline_template_at(
            &root,
            steps_for_project(&pack, &values),
            Vec::new(),
            "append",
            None,
            None,
            None,
        )?;
        Ok(AddPackResultDto {
            appended: res.appended,
            skipped: res.skipped,
            renamed: res.renamed,
            skills_added: skills.added,
        })
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
        // 覆盖：版本 +1，建立时间不变，旧技能快照被替换
        let second = save_at(&root, Some(&first.id), "单细胞质控", "改过", first.params.clone(), first.steps.clone(), &[]).unwrap();
        assert_eq!(second.version, 2);
        assert_eq!(second.created_at, first.created_at);
        assert!(second.skills.is_empty());
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
        }];
        let cfg = ProjectConfigDto { steps: vec![s.clone()], ..Default::default() };
        let text = crate::projects::render_config(None, &cfg).unwrap();
        let back = crate::projects::parse_config(&text).0.steps;
        assert_eq!(back[0].pack, "pk-abc");
        assert_eq!(back[0].params, s.params);
    }
}
