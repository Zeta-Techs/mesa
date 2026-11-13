//! 连接弹层「看实际会拿到什么」逐项对照（2026-11-01 用户：原来两栏一边是命令行原文、一边只列差异，对比看不出什么）。
//! 不按家写映射：拿这条连接自己的值（地址 / 模型 / 密钥 / 上下文窗口 / 请求参数）去两份真实产物里找落点——
//! 左边是 `agents::launch_plan` 的环境变量与参数，右边是设为全局后各配置文件的完整内容。
//! 找到哪个键就报哪个键，找不到如实写「不带」；值一律脱敏，密钥只报落点和尾号。

use crate::agents::{LaunchPlan, LaunchPlanPreviewDto};
use crate::global_config::GlobalWritePreviewDto;
use crate::profiles::{Profile, ProfileStore};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EffectCellDto {
    /// 展示值（已脱敏、截断）；None = 这一侧不带这一项
    pub value: Option<String>,
    /// 落在哪：`环境变量 X`、`-c a.b`、`~/.codex/config.toml · a.b`
    pub via: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectRowDto {
    pub label: String,
    pub launch: EffectCellDto,
    pub global: EffectCellDto,
    /// 两边不一致（一边带一边不带，或值不同）；设为全局算不出来时恒 false
    pub differs: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPreviewDto {
    pub rows: Vec<EffectRowDto>,
    /// 启动侧算不出来的原因（如缺密钥）
    pub launch_error: Option<String>,
    /// 设为全局算不出来的原因（不支持的家、无密钥连接等）
    pub global_error: Option<String>,
    /// 磁盘已是设为全局后的样子
    pub global_unchanged: bool,
    /// 原始参数（折叠区）：启动参数与环境变量名、说明行
    pub launch: Option<LaunchPlanPreviewDto>,
    /// 原始改动（折叠区）：要改的文件与键、不会生效的项、会被盖掉的来源
    pub global: Option<GlobalWritePreviewDto>,
}

/// 一个落点：via 给人看，key 用来按名字认（小写），value 是原值（未脱敏，只在本模块内比较）
#[derive(Debug, Clone)]
struct Source {
    via: String,
    key: String,
    value: String,
}

fn flatten_structured(text: &str) -> Option<BTreeMap<String, String>> {
    let t = text.trim();
    if !t.starts_with('{') {
        return None;
    }
    let v = serde_json::from_str::<serde_json::Value>(t).ok()?;
    let mut out = BTreeMap::new();
    crate::global_config::flatten_json(&v, "", &mut out);
    Some(out)
}

/// 值是指向配置文件的路径（Qwen 的连接覆盖层、Claude 的 --settings 文件）时读出来按键展开
fn flatten_file(text: &str) -> Option<BTreeMap<String, String>> {
    let p = Path::new(text.trim());
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    if !p.is_absolute() || !matches!(ext.as_str(), "json" | "jsonc" | "toml") || !p.is_file() {
        return None;
    }
    let content = std::fs::read_to_string(p).ok()?;
    Some(crate::global_config::flatten_content(p, &content))
}

fn unquote(v: &str) -> String {
    let t = v.trim();
    for q in ['"', '\''] {
        if t.len() >= 2 && t.starts_with(q) && t.ends_with(q) {
            return t[1..t.len() - 1].to_string();
        }
    }
    t.to_string()
}

fn push_value(out: &mut Vec<Source>, via: String, key: &str, value: &str) {
    let nested = flatten_structured(value).or_else(|| flatten_file(value));
    match nested {
        Some(map) => {
            for (k, v) in map {
                out.push(Source { via: format!("{via} · {k}"), key: k.to_ascii_lowercase(), value: v });
            }
        }
        None => out.push(Source { via, key: key.to_ascii_lowercase(), value: unquote(value) }),
    }
}

fn launch_sources(plan: &LaunchPlan) -> Vec<Source> {
    let mut out = Vec::new();
    for (name, value) in &plan.env {
        push_value(&mut out, format!("环境变量 {name}"), name, value);
    }
    let args = &plan.args;
    let mut i = 0;
    while i < args.len() {
        let t = args[i].as_str();
        let next = args.get(i + 1).map(String::as_str);
        if matches!(t, "-c" | "--config") {
            if let Some((k, v)) = next.and_then(|n| n.split_once('=')) {
                push_value(&mut out, format!("{t} {k}"), k, v);
                i += 2;
                continue;
            }
        }
        if let Some((flag, v)) = t.strip_prefix("--").and_then(|f| f.split_once('=')) {
            push_value(&mut out, format!("--{flag}"), flag, v);
            i += 1;
            continue;
        }
        if t.starts_with('-') {
            if let Some(v) = next.filter(|n| !n.starts_with('-')) {
                let key = match t {
                    "-m" | "--model" => "model",
                    other => other.trim_start_matches('-'),
                };
                push_value(&mut out, t.to_string(), key, v);
                i += 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn global_sources(flat: &[(String, BTreeMap<String, String>)]) -> Vec<Source> {
    flat.iter()
        .flat_map(|(file, map)| {
            map.iter().map(move |(k, v)| Source {
                via: format!("{file} · {k}"),
                key: k.to_ascii_lowercase(),
                value: v.clone(),
            })
        })
        .collect()
}

/// 最末一段名字（`model_providers.custom.base_url` → `base_url`；环境变量名整个算）
fn leaf(key: &str) -> &str {
    key.rsplit(['.', ' ']).next().unwrap_or(key)
}

/// 同一份产物里常并存多家渠道（Codex 给老对话留的 `ccode-<短id>` 块、OpenCode 的多个 provider）：
/// 当前生效的那个渠道名下的键排前面
fn active_ids(sources: &[Source]) -> Vec<String> {
    let mut ids = Vec::new();
    for s in sources {
        let l = leaf(&s.key);
        if l == "model_provider" {
            ids.push(s.value.to_ascii_lowercase());
        }
        // OpenCode：model = "<provider>/<model>"
        if l == "model" && !s.key.contains('.') {
            if let Some((p, _)) = s.value.split_once('/') {
                ids.push(p.to_ascii_lowercase());
            }
        }
    }
    ids
}

fn in_active(s: &Source, ids: &[String]) -> bool {
    s.key.split('.').any(|seg| ids.iter().any(|id| id == seg))
}

fn pick<'a>(
    sources: &'a [Source],
    ids: &[String],
    pred: impl Fn(&Source) -> bool,
    rank: impl Fn(&Source) -> i32,
) -> Option<&'a Source> {
    let mut best: Option<(&Source, i32)> = None;
    for s in sources.iter().filter(|s| pred(s)) {
        let r = rank(s) + i32::from(in_active(s, ids));
        if best.map_or(true, |(_, b)| r > b) {
            best = Some((s, r));
        }
    }
    best.map(|(s, _)| s)
}

fn host_of(url: &str) -> Option<String> {
    let u = reqwest::Url::parse(url.trim()).ok()?;
    Some(u.host_str()?.to_ascii_lowercase())
}

/// 值等于目标，或是含目标的数组（`"a", "b"` 两种引号形态都认），或是 OpenCode 的 `<provider>/<model>`
fn value_has(value: &str, target: &str) -> bool {
    let v = unquote(value);
    v == target
        || v.ends_with(&format!("/{target}"))
        || v.split(',').any(|part| unquote(part.trim()) == target)
}

/// 键落在某个模型的分段里（`model.<id>.…`、`models.<id>.…`、`modelDefinitions.<id>.…`）时返回那个 id
fn model_block(key: &str) -> Option<&str> {
    let segs: Vec<&str> = key.split('.').collect();
    segs.windows(2)
        .take(segs.len().saturating_sub(2))
        .find(|w| matches!(w[0], "model" | "models" | "modeldefinitions"))
        .map(|w| w[1])
}

/// 当前模型认得的分段名：模型名本身，以及分段里 `.model` 写着这个模型的（Kimi 的 `__kimi_env_model__`）
fn model_blocks(sources: &[Source], model: Option<&str>) -> Vec<String> {
    let Some(m) = model.map(str::to_ascii_lowercase) else { return Vec::new() };
    let mut out = vec![m.clone()];
    for s in sources {
        if leaf(&s.key) == "model" && unquote(&s.value).to_ascii_lowercase() == m {
            if let Some(b) = model_block(&s.key) {
                out.push(b.to_string());
            }
        }
    }
    out
}

/// 别的模型分段里的值（用户给另一个模型配的窗口、思考档）不算这条连接的
fn in_other_block(s: &Source, blocks: &[String]) -> bool {
    model_block(&s.key).is_some_and(|b| !blocks.iter().any(|x| x == b))
}

fn is_scalar_eq(value: &str, target: &str) -> bool {
    unquote(value) == target
}

fn show(value: &str) -> String {
    let red = crate::sessions::redact_sensitive_text(&unquote(value));
    if red.chars().count() > 120 {
        format!("{}…", red.chars().take(117).collect::<String>())
    } else {
        red
    }
}

fn cell(s: Option<&Source>) -> EffectCellDto {
    match s {
        Some(s) => EffectCellDto { value: Some(show(&s.value)), via: Some(s.via.clone()) },
        None => EffectCellDto::default(),
    }
}

fn tail(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let n = chars.len().min(4);
    chars[chars.len() - n..].iter().collect()
}

/// 密钥不在明文里时，看这份产物用什么办法拿密钥（引用环境变量、认证命令现取、引用文件）
fn key_reference(sources: &[Source], ids: &[String]) -> Option<EffectCellDto> {
    let s = pick(
        sources,
        ids,
        |s| {
            let l = leaf(&s.key);
            (l == "env_key"
                || (l == "command" && s.key.contains("auth"))
                || l.contains("api_key")
                || l.contains("apikey")
                || l.contains("auth_token")
                || l.contains("bearer"))
                && !unquote(&s.value).is_empty()
        },
        |s| i32::from(leaf(&s.key) == "command") * 2 + i32::from(leaf(&s.key) == "env_key"),
    )?;
    let v = unquote(&s.value);
    let l = leaf(&s.key);
    let text = if l == "env_key" {
        format!("读环境变量 {v}")
    } else if l == "command" {
        let prog = v.split_whitespace().next().unwrap_or(&v).trim_matches(['"', '[', ']', '\'']);
        let name = Path::new(prog).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        format!("运行 {name} 现取")
    } else if let Some(var) = v
        .strip_prefix("{env:")
        .and_then(|r| r.strip_suffix('}'))
        .or_else(|| v.strip_prefix("${").and_then(|r| r.strip_suffix('}')))
        .or_else(|| v.strip_prefix('$'))
    {
        format!("引用环境变量 {var}")
    } else if v.starts_with("{file:") {
        "引用密钥文件".to_string()
    } else {
        "已写入（已脱敏）".to_string()
    };
    Some(EffectCellDto { value: Some(text), via: Some(s.via.clone()) })
}

fn key_cell(sources: &[Source], ids: &[String], key: &str, plain_label: &str) -> EffectCellDto {
    match pick(sources, ids, |s| unquote(&s.value) == key, |_| 0) {
        Some(s) => EffectCellDto { value: Some(format!("{plain_label} ···{}", tail(key))), via: Some(s.via.clone()) },
        None => key_reference(sources, ids).unwrap_or_default(),
    }
}

/// 按名字认的数值 / 档位项（上下文窗口、思考档、温度……）：有目标值时同值优先，但不同值也报出来——差异正是要看的
fn hinted(
    sources: &[Source],
    ids: &[String],
    blocks: &[String],
    hint: &dyn Fn(&str) -> bool,
    target: Option<&str>,
) -> Option<Source> {
    pick(
        sources,
        ids,
        |s| hint(leaf(&s.key)) && !unquote(&s.value).is_empty() && !in_other_block(s, blocks),
        |s| target.map_or(0, |t| i32::from(is_scalar_eq(&s.value, t)) * 3),
    )
    .cloned()
}

fn norm(v: &str) -> String {
    unquote(v).trim_end_matches('/').to_ascii_lowercase()
}

struct Inputs<'a> {
    profile: &'a Profile,
    key: Option<&'a str>,
    launch_model: Option<&'a str>,
    global_model: Option<&'a str>,
    context: Option<String>,
}

fn build_rows(inp: &Inputs, launch: Option<&[Source]>, global: Option<&[Source]>) -> Vec<EffectRowDto> {
    let empty: Vec<Source> = Vec::new();
    let l_src = launch.unwrap_or(&empty);
    let g_src = global.unwrap_or(&empty);
    let l_ids = active_ids(l_src);
    let g_ids = active_ids(g_src);
    let mut rows = Vec::new();
    let mut push = |label: &str, l: EffectCellDto, g: EffectCellDto, compare_values: bool| {
        if l.value.is_none() && g.value.is_none() {
            return;
        }
        // 启动侧不注入的项，CLI 照旧读自己的配置文件，和外面一样——不算不一致；
        // Mesa 注入了而设为全局不写，外面就没有这一项，这才是差别
        let differs = launch.is_some()
            && global.is_some()
            && match (&l.value, &g.value) {
                (Some(a), Some(b)) => compare_values && norm(a) != norm(b),
                (Some(_), None) => true,
                _ => false,
            };
        rows.push(EffectRowDto { label: label.into(), launch: l, global: g, differs });
    };

    // 地址：按主机认（各家对路径的规整不同，Claude 去 /v1、Gemini 不带 /v1 都正常）
    if let Some(host) = inp.profile.base_url.as_deref().and_then(host_of) {
        let find = |src: &[Source], ids: &[String], blocks: &[String]| {
            cell(pick(
                src,
                ids,
                |s| host_of(&unquote(&s.value)).as_deref() == Some(host.as_str()),
                |s| {
                    let l = leaf(&s.key);
                    i32::from(l.contains("url") || l.contains("base") || l.contains("endpoint")) * 2
                        - i32::from(in_other_block(s, blocks))
                },
            ))
        };
        push(
            "地址",
            find(l_src, &l_ids, &model_blocks(l_src, inp.launch_model)),
            find(g_src, &g_ids, &model_blocks(g_src, inp.global_model)),
            false,
        );
    }

    // 默认模型
    let model_find = |src: &[Source], ids: &[String], target: Option<&str>| {
        let Some(t) = target else { return EffectCellDto::default() };
        cell(pick(
            src,
            ids,
            |s| value_has(&s.value, t),
            |s| {
                let l = leaf(&s.key);
                let named = l.contains("model");
                let exact = matches!(l, "model" | "default_model" | "anthropic_model" | "-m");
                let role = ["small", "haiku", "sonnet", "opus", "fable", "subagent", "slot", "fast", "title"]
                    .iter()
                    .any(|r| s.key.contains(r));
                i32::from(is_scalar_eq(&s.value, t)) * 3 + i32::from(named) * 2 + i32::from(exact)
                    - i32::from(role) * 3
            },
        ))
    };
    push(
        "默认模型",
        model_find(l_src, &l_ids, inp.launch_model),
        model_find(g_src, &g_ids, inp.global_model),
        true,
    );

    if let Some(k) = inp.key.filter(|k| !k.is_empty()) {
        let l = key_cell(l_src, &l_ids, k, "已注入");
        let g = key_cell(g_src, &g_ids, k, "明文写入");
        push("密钥", l, g, false);
    }

    let policy = &inp.profile.request_policy;
    let numeric: [(&str, &dyn Fn(&str) -> bool, Option<String>); 5] = [
        (
            "上下文窗口",
            &|l: &str| (l.contains("context") || l.contains("window")) && !l.contains("compact"),
            inp.context.clone(),
        ),
        (
            "思考档",
            &|l: &str| l.contains("effort") || l.contains("reasoning") || l.contains("thinking"),
            policy.reasoning_effort.clone(),
        ),
        ("温度", &|l: &str| l.contains("temperature"), policy.temperature.map(|v| v.to_string())),
        (
            "top_p",
            &|l: &str| l == "top_p" || l == "topp" || l.ends_with("top_p"),
            policy.top_p.map(|v| v.to_string()),
        ),
        (
            "输出上限",
            &|l: &str| l.contains("max_output") || l.contains("max_tokens") || l.contains("output_tokens"),
            policy.max_output_tokens.map(|v| v.to_string()),
        ),
    ];
    let l_blocks = model_blocks(l_src, inp.launch_model);
    let g_blocks = model_blocks(g_src, inp.global_model);
    for (label, hint, target) in numeric {
        let l = hinted(l_src, &l_ids, &l_blocks, hint, target.as_deref());
        let g = hinted(g_src, &g_ids, &g_blocks, hint, target.as_deref());
        push(label, cell(l.as_ref()), cell(g.as_ref()), true);
    }
    rows
}

pub(crate) fn effect_preview(store: &ProfileStore, profile_id: &str) -> Result<EffectPreviewDto, String> {
    match crate::agents::launch_preview_inputs(store, profile_id, None) {
        Ok((profile, selected, plan)) => finish(store, profile_id, profile, selected, Some(plan), None),
        // 启动侧算不出来（如缺密钥）也要能看全局侧
        Err(e) => {
            let profile = store.get_with_model(profile_id, None)?;
            let first = profile.models.first().cloned();
            finish(store, profile_id, profile, first, None, Some(e))
        }
    }
}

fn finish(
    store: &ProfileStore,
    profile_id: &str,
    profile: Profile,
    selected: Option<String>,
    plan: Option<LaunchPlan>,
    launch_error: Option<String>,
) -> Result<EffectPreviewDto, String> {
    let key = crate::profiles::get_key_for_profile(&profile).ok().flatten();
    let launch_src = plan.as_ref().map(launch_sources);
    let (global_dto, global_src, global_error) = match crate::global_config::global_preview_flat(store, profile_id) {
        Ok((dto, flat)) => (Some(dto), Some(global_sources(&flat)), None),
        Err(e) => (None, None, Some(e)),
    };
    let context = selected
        .as_deref()
        .and_then(|m| crate::model_registry::model_context_size_declared_for(m, profile.gateway_id.as_deref()))
        .map(|n| n.to_string());
    let inputs = Inputs {
        profile: &profile,
        key: key.as_deref(),
        launch_model: selected.as_deref(),
        // 设为全局取名单第一个（与 global_preview_inputs 同口径）
        global_model: profile.models.first().map(String::as_str),
        context,
    };
    let rows = build_rows(&inputs, launch_src.as_deref(), global_src.as_deref());
    let launch = if launch_error.is_none() {
        crate::agents::launch_plan_preview(store, profile_id, None).ok()
    } else {
        None
    };
    Ok(EffectPreviewDto {
        rows,
        launch_error,
        global_unchanged: global_dto.as_ref().is_some_and(|g| g.files.is_empty()),
        global_error,
        launch,
        global: global_dto,
    })
}

/// 连接弹层「看实际会拿到什么」：同一项在 Mesa 里启动与设为全局后各落在哪、值是否一致
#[tauri::command]
pub fn preview_effect(
    store: tauri::State<'_, ProfileStore>,
    profile_id: String,
) -> Result<EffectPreviewDto, String> {
    effect_preview(&store, &profile_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(via: &str, key: &str, value: &str) -> Source {
        Source { via: via.into(), key: key.to_ascii_lowercase(), value: value.into() }
    }

    fn profile(base: &str, models: &[&str]) -> Profile {
        let mut p: Profile = serde_json::from_value(serde_json::json!({
            "id": "p1", "name": "Zeta", "agent": "codex", "baseUrl": base,
            "models": models, "hasKey": true, "protocol": null,
        }))
        .unwrap();
        p.request_policy.reasoning_effort = Some("high".into());
        p
    }

    #[test]
    fn launch_args_are_split_into_named_sources() {
        let plan = LaunchPlan {
            env: vec![("CODEX_API_KEY".into(), "sk-secret-1234".into())],
            args: vec![
                "-c".into(),
                "model_providers.ccode-1.base_url=\"https://api.example.com/v1\"".into(),
                "-c".into(),
                "model_provider=\"ccode-1\"".into(),
                "-m".into(),
                "glm-5".into(),
                "-s".into(),
                "workspace-write".into(),
                "--yolo".into(),
                "--settings".into(),
                r#"{"env":{"ANTHROPIC_MODEL":"glm-5"}}"#.into(),
            ],
            ..Default::default()
        };
        let s = launch_sources(&plan);
        let by_via = |v: &str| s.iter().find(|x| x.via == v).map(|x| x.value.clone());
        assert_eq!(by_via("-c model_providers.ccode-1.base_url").as_deref(), Some("https://api.example.com/v1"));
        assert_eq!(by_via("-m").as_deref(), Some("glm-5"));
        assert_eq!(by_via("--settings · env.ANTHROPIC_MODEL").as_deref(), Some("glm-5"));
        assert_eq!(active_ids(&s), vec!["ccode-1".to_string()]);
    }

    #[test]
    fn rows_line_up_launch_and_global_and_flag_differences() {
        let p = profile("https://api.example.com/v1", &["glm-5", "glm-4"]);
        let launch = vec![
            src("-c model_providers.ccode-1.base_url", "model_providers.ccode-1.base_url", "https://api.example.com/v1"),
            src("-c model_provider", "model_provider", "ccode-1"),
            src("-m", "model", "glm-5"),
            src("环境变量 CODEX_API_KEY", "CODEX_API_KEY", "sk-secret-1234"),
            src("-c model_context_window", "model_context_window", "1048576"),
            src("-c model_reasoning_effort", "model_reasoning_effort", "high"),
        ];
        let global = vec![
            // 给老对话留的块排在前面，也不能被认成当前渠道
            src("~/.codex/config.toml · model_providers.ccode-9.base_url", "model_providers.ccode-9.base_url", "https://api.example.com/v1"),
            src("~/.codex/config.toml · model_providers.custom.base_url", "model_providers.custom.base_url", "https://api.example.com/v1"),
            src("~/.codex/config.toml · model_provider", "model_provider", "custom"),
            src("~/.codex/config.toml · model", "model", "glm-5"),
            src("~/.codex/config.toml · model_providers.custom.auth.command", "model_providers.custom.auth.command", "/Applications/Mesa.app/mesa_helper"),
            src("~/.codex/config.toml · model_context_window", "model_context_window", "200000"),
        ];
        let inp = Inputs {
            profile: &p,
            key: Some("sk-secret-1234"),
            launch_model: Some("glm-5"),
            global_model: Some("glm-5"),
            context: Some("1048576".into()),
        };
        let rows = build_rows(&inp, Some(&launch), Some(&global));
        let row = |l: &str| rows.iter().find(|r| r.label == l).unwrap();
        assert_eq!(row("地址").global.via.as_deref(), Some("~/.codex/config.toml · model_providers.custom.base_url"));
        assert!(!row("地址").differs);
        assert!(!row("默认模型").differs);
        let key = row("密钥");
        assert_eq!(key.launch.value.as_deref(), Some("已注入 ···1234"));
        assert_eq!(key.global.value.as_deref(), Some("运行 mesa_helper 现取"));
        assert!(!key.differs, "两边都带密钥，只是办法不同");
        // 窗口两边值不同、思考档只有启动侧带（外面不会有）：都要标出来
        assert!(row("上下文窗口").differs);
        assert!(row("思考档").differs);
        assert_eq!(row("思考档").global, EffectCellDto::default());
        // 两边都没有的项不出行
        assert!(rows.iter().all(|r| r.label != "温度"));
        // 任何一格都不出密钥原文
        let json = serde_json::to_string(&rows).unwrap();
        assert!(!json.contains("sk-secret-1234"));
    }

    /// 启动侧不注入 = CLI 照读自己的配置文件，不算不一致；别的模型分段里的值不算这条连接的
    #[test]
    fn inherited_items_and_other_model_blocks_are_not_differences() {
        let p = profile("https://api.example.com/v1", &["glm-5"]);
        let launch = vec![src("-m", "model", "glm-5")];
        let global = vec![
            src("f · models.default", "models.default", "glm-5"),
            src("f · model.grok-4.5.context_window", "model.grok-4.5.context_window", "1000000"),
            src("f · models.__env__.model", "models.__env__.model", "glm-5"),
            src("f · models.__env__.max_context_size", "models.__env__.max_context_size", "131072"),
            src("f · effortlevel", "effortlevel", "high"),
        ];
        let inp = Inputs { profile: &p, key: None, launch_model: Some("glm-5"), global_model: Some("glm-5"), context: None };
        let rows = build_rows(&inp, Some(&launch), Some(&global));
        let row = |l: &str| rows.iter().find(|r| r.label == l).unwrap();
        assert_eq!(row("上下文窗口").global.value.as_deref(), Some("131072"), "认 .model 写着当前模型的分段");
        assert!(!row("上下文窗口").differs);
        assert!(!row("思考档").differs, "启动不注入时 CLI 也读到这个 effortLevel");
    }

    #[test]
    fn global_unavailable_never_flags_differences() {
        let p = profile("https://api.example.com/v1", &["glm-5"]);
        let launch = vec![src("-m", "model", "glm-5")];
        let inp = Inputs { profile: &p, key: None, launch_model: Some("glm-5"), global_model: Some("glm-5"), context: None };
        let rows = build_rows(&inp, Some(&launch), None);
        assert!(rows.iter().all(|r| !r.differs));
    }

    #[test]
    fn key_references_are_described_without_values() {
        let ids = Vec::new();
        for (key, value, want) in [
            ("model_providers.custom.env_key", "ZETA_KEY", "读环境变量 ZETA_KEY"),
            ("provider.zeta.options.apikey", "{env:ZETA_KEY}", "引用环境变量 ZETA_KEY"),
            ("provider.zeta.options.apikey", "{file:~/.config/opencode/zeta.key}", "引用密钥文件"),
            ("env.anthropic_auth_token", "sk-other", "已写入（已脱敏）"),
        ] {
            let c = key_reference(&[src("f", key, value)], &ids).unwrap();
            assert_eq!(c.value.as_deref(), Some(want), "{key}");
        }
    }
}

#[cfg(test)]
mod real_data {
    /// 本机真实连接逐条打印对照表（只读；手动跑：cargo test dump_real_effect_rows -- --ignored --nocapture）
    #[test]
    #[ignore]
    fn dump_real_effect_rows() {
        let store = crate::profiles::ProfileStore::new().unwrap();
        for p in store.list().unwrap() {
            println!("== {} · {} ({:?})", p.agent, p.name, p.account_type);
            match super::effect_preview(&store, &p.id) {
                Ok(d) => {
                    if let Some(e) = &d.launch_error { println!("  launch_error: {e}"); }
                    if let Some(e) = &d.global_error { println!("  global_error: {e}"); }
                    for r in &d.rows {
                        println!(
                            "  {}{} | {:?} @ {:?} | {:?} @ {:?}",
                            if r.differs { "≠ " } else { "  " },
                            r.label, r.launch.value, r.launch.via, r.global.value, r.global.via
                        );
                    }
                }
                Err(e) => println!("  ERR {e}"),
            }
        }
    }
}
