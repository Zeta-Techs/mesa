//! 一步按数据分几路（2026-11-03 项目内协作四期，docs/design-project-coordination.md §9）：同一个工作区里分片，最后一路收尾。
//!
//! - 几路由数据定：从步骤声明的 `items` 文件（项目内 JSON）按 `filter` 挑条目，每路 `per` 条、最多 `max` 路，均匀分；
//!   每条带全局序号（从 1 起，按文件里的顺序），各路按给的序号起文件名，不会撞名。
//! - 每路做完写 `.ccode/fanout/lane-<k>.done`；Mesa 数到齐了开收尾一路（TerminalPage）。标记与分片清单不进 git。
//! - 只读数据文件，不改；分不分由人在开工弹层勾选（默认不分）。

use crate::projects::StepFanOutDto;
use serde::Serialize;
use std::fs;
use std::path::Path;

pub const MARK_DIR: &str = ".ccode/fanout";
const ITEMS_CAP: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FanOutItemDto {
    /// 全局序号（1 起）：起文件名用
    pub seq: usize,
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FanOutPlanDto {
    pub total: usize,
    pub lanes: Vec<Vec<FanOutItemDto>>,
}

fn value_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 数据文件里的条目：数组本身，或对象里第一个数组字段
pub(crate) fn items_at(dir: &Path, spec: &StepFanOutDto) -> Result<Vec<FanOutItemDto>, String> {
    let rel = spec.items.replace('\\', "/");
    // 只收普通路径段：Windows 上 C:/x、C:x 不以 / 开头，join 却会整个换掉 dir（2026-11-03 自查）
    if rel.is_empty() || !Path::new(&rel).components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return Err(format!("分路的数据文件要写项目内相对路径：{}", spec.items));
    }
    let path = dir.join(&rel);
    let file = fs::File::open(&path).map_err(|_| format!("找不到分路用的数据文件 {rel}（上一步还没交？）"))?;
    let mut text = String::new();
    std::io::Read::read_to_string(&mut std::io::Read::take(file, ITEMS_CAP), &mut text).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{rel} 读不懂：{e}"))?;
    let array = match &value {
        serde_json::Value::Array(a) => a.clone(),
        // 对象里认 items / records / rows（与 lit_records.py 同序），都没有再取第一个数组；serde_json 的对象按键名排序，「第一个」不是文件里的顺序
        serde_json::Value::Object(o) => ["items", "records", "rows"]
            .iter()
            .find_map(|k| o.get(*k).and_then(|v| v.as_array()).cloned())
            .or_else(|| o.values().find_map(|v| v.as_array().cloned()))
            .ok_or(format!("{rel} 里没有条目列表"))?,
        _ => return Err(format!("{rel} 里没有条目列表")),
    };
    let (fk, fv) = match spec.filter.split_once('=') {
        Some((k, v)) => (k.trim().to_string(), v.trim().to_string()),
        None => (String::new(), String::new()),
    };
    let mut out = Vec::new();
    for item in &array {
        if !fk.is_empty() && item.get(&fk).map(value_text).as_deref() != Some(fv.as_str()) {
            continue;
        }
        let key = item.get(&spec.key).map(value_text).unwrap_or_default();
        if key.is_empty() {
            continue;
        }
        let label = if spec.label.is_empty() { String::new() } else { item.get(&spec.label).map(value_text).unwrap_or_default() };
        out.push(FanOutItemDto { seq: out.len() + 1, key, label });
    }
    Ok(out)
}

/// 均匀切：路数 = ceil(总数 / per)，封顶 max；条目不到两路就不分（返回一路）
pub(crate) fn shard(items: Vec<FanOutItemDto>, per: u32, max: u32) -> Vec<Vec<FanOutItemDto>> {
    if items.is_empty() {
        return Vec::new();
    }
    let per = per.max(1) as usize;
    let lanes = items.len().div_ceil(per).clamp(1, max.max(1) as usize);
    let base = items.len() / lanes;
    let extra = items.len() % lanes;
    let mut out = Vec::with_capacity(lanes);
    let mut it = items.into_iter();
    for k in 0..lanes {
        let n = base + usize::from(k < extra);
        out.push(it.by_ref().take(n).collect());
    }
    out
}

pub(crate) fn plan_at(dir: &Path, spec: &StepFanOutDto) -> Result<FanOutPlanDto, String> {
    let items = items_at(dir, spec)?;
    let total = items.len();
    Ok(FanOutPlanDto { total, lanes: shard(items, spec.per, spec.max) })
}

/// 做完了的路（`.ccode/fanout/lane-<k>.done`，k 从 1 起）
pub(crate) fn done_lanes_at(dir: &Path) -> Vec<usize> {
    let mut out: Vec<usize> = fs::read_dir(dir.join(MARK_DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.strip_prefix("lane-")?.strip_suffix(".done")?.parse().ok()
        })
        .collect();
    out.sort_unstable();
    out
}

/// 开工弹层预览与开工时切片：dir 是项目根（预览）或刚建好的工作区（开工）
#[tauri::command]
pub async fn fan_out_plan(dir: String, spec: StepFanOutDto) -> Result<FanOutPlanDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::PathBuf::from(crate::sessions::expand_tilde(&dir));
        let plan = plan_at(&dir, &spec)?;
        // 标记目录不进 git（开工后在工作区里调到这里时顺手写，与 TASK.md 同口径）
        crate::projects::exclude_in_git(&dir, &format!("{MARK_DIR}/"));
        Ok(plan)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 收尾判定用：这个工作区里哪几路写了做完标记
#[tauri::command]
pub async fn fan_out_done(dir: String) -> Result<Vec<usize>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(done_lanes_at(Path::new(&crate::sessions::expand_tilde(&dir)))))
        .await
        .map_err(|e| e.to_string())?
}

/// 这个工作副本里、开工以来各段对话一共花了多少（分路每步花费上限用，2026-11-04）：按运行库里落在这个目录、
/// 这之后开的运行合计（各路与收尾都在同一个工作副本里）；查不到价的不计
pub(crate) fn spent_in(runs: &[crate::runs::RunDto], dir: &Path, since_ms: i64) -> Vec<(String, String)> {
    runs.iter()
        .filter(|r| !r.internal && crate::paths::path_within_path(Path::new(&r.isolation_path), dir))
        .filter(|r| chrono::DateTime::parse_from_rfc3339(&r.created_at).is_ok_and(|t| t.timestamp_millis() >= since_ms))
        .filter_map(|r| Some((r.agent.clone(), r.session_id.clone()?)))
        .collect()
}

#[tauri::command]
pub async fn fan_out_spent(dir: String, since_ms: i64) -> Result<f64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::PathBuf::from(crate::sessions::expand_tilde(&dir));
        let runs = crate::runs::run_list_sync(None)?;
        Ok(crate::usage::sessions_cost_usd(&spent_in(&runs, &dir, since_ms)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(per: u32, max: u32) -> StepFanOutDto {
        StepFanOutDto {
            items: "papers/included.json".into(),
            filter: "decision=included".into(),
            key: "id".into(),
            label: "title".into(),
            per,
            max,
            ..Default::default()
        }
    }

    #[test]
    fn items_filter_keys_and_global_seq() {
        let dir = std::env::temp_dir().join(format!("mesa-fan-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("papers")).unwrap();
        let rows: Vec<serde_json::Value> = (1..=11)
            .map(|i| serde_json::json!({ "id": format!("doi/{i}"), "title": format!("T{i}"), "decision": if i % 4 == 0 { "excluded" } else { "included" } }))
            .chain([serde_json::json!({ "title": "没编号", "decision": "included" })])
            .collect();
        fs::write(dir.join("papers/included.json"), serde_json::to_string(&rows).unwrap()).unwrap();
        let items = items_at(&dir, &spec(3, 4)).unwrap();
        assert_eq!(items.len(), 9, "排除的与没编号的不算");
        assert_eq!((items[0].seq, items[0].key.as_str(), items[0].label.as_str()), (1, "doi/1", "T1"));
        assert_eq!(items[3].key, "doi/5", "序号按挑出来后的顺序连续");
        // 对象包着数组也认
        fs::write(dir.join("papers/included.json"), serde_json::json!({ "papers": rows }).to_string()).unwrap();
        assert_eq!(items_at(&dir, &spec(3, 4)).unwrap().len(), 9);
        let plan = plan_at(&dir, &spec(3, 4)).unwrap();
        assert_eq!(plan.total, 9);
        assert_eq!(plan.lanes.iter().map(Vec::len).collect::<Vec<_>>(), [3, 3, 3]);
        // 越界路径、没有文件
        assert!(items_at(&dir, &StepFanOutDto { items: "../x.json".into(), ..spec(3, 4) }).is_err());
        assert!(items_at(&dir, &StepFanOutDto { items: "no.json".into(), ..spec(3, 4) }).unwrap_err().contains("找不到"));
        // 做完标记
        fs::create_dir_all(dir.join(MARK_DIR)).unwrap();
        for name in ["lane-2.done", "lane-1.done", "lane-x.done", "other"] {
            fs::write(dir.join(MARK_DIR).join(name), "").unwrap();
        }
        assert_eq!(done_lanes_at(&dir), [1, 2]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_toml_round_trips_fan_out_and_drops_empty() {
        let mut step = crate::projects::StepDto { name: "精读".into(), brief: "b".into(), ..Default::default() };
        step.fan_out = Some(StepFanOutDto { own: "只写自己的笔记".into(), merge: "写 index".into(), ..spec(8, 4) });
        let cfg = crate::projects::ProjectConfigDto { steps: vec![step.clone()], ..Default::default() };
        let text = crate::projects::render_config(None, &cfg).unwrap();
        assert!(text.contains("[steps.fan_out]"), "{text}");
        let back = crate::projects::parse_config(&text).0;
        assert_eq!(back.steps[0].fan_out, step.fan_out);
        // 没写数据来源的当没声明；路数封顶 8
        let raw = "[[steps]]\nname = \"a\"\nbrief = \"b\"\n[steps.fan_out]\nper = 0\nmax = 99\n\n[[steps]]\nname = \"c\"\nbrief = \"d\"\n[steps.fan_out]\nitems = \"x.json\"\nper = 0\nmax = 99\n";
        let parsed = crate::projects::parse_config(raw).0;
        assert!(parsed.steps[0].fan_out.is_none());
        let f = parsed.steps[1].fan_out.clone().unwrap();
        assert_eq!((f.per, f.max, f.key.as_str()), (1, 8, "id"));
    }

    #[test]
    fn shard_balances_and_caps() {
        let items = |n: usize| (1..=n).map(|i| FanOutItemDto { seq: i, key: i.to_string(), label: String::new() }).collect::<Vec<_>>();
        let sizes = |v: Vec<Vec<FanOutItemDto>>| v.iter().map(Vec::len).collect::<Vec<_>>();
        assert_eq!(sizes(shard(items(10), 8, 4)), [5, 5]);
        assert_eq!(sizes(shard(items(30), 8, 4)), [8, 8, 7, 7]);
        assert_eq!(sizes(shard(items(100), 8, 4)), [25, 25, 25, 25], "封顶 max 路");
        assert_eq!(sizes(shard(items(5), 8, 4)), [5], "不到两路就一路");
        assert!(shard(items(0), 8, 4).is_empty());
        let lanes = shard(items(7), 3, 4);
        assert_eq!(lanes[2][0].seq, 6, "序号连续不跳");
    }

    #[test]
    fn items_reject_non_normal_paths_and_prefer_known_list_keys() {
        let dir = std::env::temp_dir().join(format!("mesa-fan-keys-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("x.json"), r#"{"excluded":[{"id":"e"}],"rows":[{"id":"r1"},{"id":"r2"}]}"#).unwrap();
        let s = StepFanOutDto { items: "x.json".into(), key: "id".into(), per: 1, max: 4, ..Default::default() };
        assert_eq!(items_at(&dir, &s).unwrap().iter().map(|i| i.key.as_str()).collect::<Vec<_>>(), ["r1", "r2"]);
        for bad in ["/etc/x.json", "../x.json", "./x.json", ""] {
            assert!(items_at(&dir, &StepFanOutDto { items: bad.into(), ..s.clone() }).is_err(), "{bad}");
        }
        fs::remove_dir_all(&dir).ok();
    }
}
