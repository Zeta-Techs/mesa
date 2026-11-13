//! 全局配置漂移：只比对 Mesa 写入的键集合（子集），CLI 自升级多出来的无关字段不算漂移。

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriftKind {
    Matches,
    Drifted,
    NeverWritten,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalDriftDto {
    pub status: String,
    pub files: Vec<String>,
    pub message: Option<String>,
}

impl DriftKind {
    fn as_str(self) -> &'static str {
        match self {
            DriftKind::Matches => "matches",
            DriftKind::Drifted => "drifted",
            DriftKind::NeverWritten => "neverWritten",
            DriftKind::Error => "error",
        }
    }
}

pub fn json_subset_equal(planned: &Value, live: &Value) -> bool {
    match (planned, live) {
        (Value::Object(p), Value::Object(l)) => p
            .iter()
            .all(|(k, v)| l.get(k).is_some_and(|lv| json_subset_equal(v, lv))),
        (Value::Array(p), Value::Array(l)) => p == l,
        _ => planned == live,
    }
}

fn parse_env_map(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = t.split_once('=') {
            out.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    out
}

pub fn env_subset_equal(planned: &str, live: &str) -> bool {
    let p = parse_env_map(planned);
    let l = parse_env_map(live);
    p.iter().all(|(k, v)| l.get(k).is_some_and(|lv| lv == v))
}

fn toml_subset_equal(planned: &str, live: &str) -> bool {
    let Ok(p) = planned.parse::<toml::Value>() else {
        return false;
    };
    let Ok(l) = live.parse::<toml::Value>() else {
        return false;
    };
    toml_value_subset(&p, &l)
}

fn toml_value_subset(planned: &toml::Value, live: &toml::Value) -> bool {
    match (planned, live) {
        (toml::Value::Table(p), toml::Value::Table(l)) => p
            .iter()
            .all(|(k, v)| l.get(k).is_some_and(|lv| toml_value_subset(v, lv))),
        (toml::Value::Array(p), toml::Value::Array(l)) => p == l,
        _ => planned == live,
    }
}

/// 按文件形态做子集比对。读失败视为漂移。
pub fn planned_matches_live(path: &Path, planned: &str) -> bool {
    let live = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name.ends_with(".json") || name.ends_with(".jsonc") {
        let planned_v = serde_json::from_str::<Value>(&crate::mcp::strip_jsonc(planned))
            .or_else(|_| serde_json::from_str::<Value>(planned));
        let live_v = serde_json::from_str::<Value>(&crate::mcp::strip_jsonc(&live))
            .or_else(|_| serde_json::from_str::<Value>(&live));
        match (planned_v, live_v) {
            (Ok(p), Ok(l)) => json_subset_equal(&p, &l),
            _ => planned.trim() == live.trim(),
        }
    } else if name.ends_with(".toml") {
        toml_subset_equal(planned, crate::mcp::strip_bom(&live))
    } else if name == ".env" || name.ends_with(".env") {
        env_subset_equal(planned, &live)
    } else {
        planned.trim() == live.trim()
    }
}

pub fn classify(
    never_written: bool,
    plan_error: Option<String>,
    drifted_files: Vec<String>,
) -> GlobalDriftDto {
    if never_written {
        return GlobalDriftDto {
            status: DriftKind::NeverWritten.as_str().into(),
            files: Vec::new(),
            message: None,
        };
    }
    if let Some(message) = plan_error {
        return GlobalDriftDto {
            status: DriftKind::Error.as_str().into(),
            files: Vec::new(),
            message: Some(message),
        };
    }
    if drifted_files.is_empty() {
        GlobalDriftDto {
            status: DriftKind::Matches.as_str().into(),
            files: Vec::new(),
            message: None,
        }
    } else {
        GlobalDriftDto {
            status: DriftKind::Drifted.as_str().into(),
            files: drifted_files,
            message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_subset_ignores_extra_live_keys() {
        let planned = json!({"env": {"ANTHROPIC_MODEL": "m1"}});
        let live = json!({"env": {"ANTHROPIC_MODEL": "m1", "OTHER": "x"}, "theme": "dark"});
        assert!(json_subset_equal(&planned, &live));
        let drifted = json!({"env": {"ANTHROPIC_MODEL": "m2", "OTHER": "x"}});
        assert!(!json_subset_equal(&planned, &drifted));
    }

    #[test]
    fn env_subset_compares_planned_keys_only() {
        let planned = "FOO=1\nBAR=2\n";
        let live = "FOO=1\nBAR=2\nCLI_NEW=9\n";
        assert!(env_subset_equal(planned, live));
        assert!(!env_subset_equal(planned, "FOO=1\nBAR=3\n"));
    }

    #[test]
    fn classify_four_states() {
        assert_eq!(classify(true, None, vec![]).status, "neverWritten");
        assert_eq!(classify(false, Some("x".into()), vec![]).status, "error");
        assert_eq!(classify(false, None, vec![]).status, "matches");
        let d = classify(false, None, vec!["config.toml".into()]);
        assert_eq!(d.status, "drifted");
        assert_eq!(d.files, vec!["config.toml"]);
    }

    #[test]
    fn jsonc_live_still_matches_planned_object() {
        let dir = std::env::temp_dir().join(format!("ccode-drift-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, "{\n  // c\n  \"env\": {\"A\": \"1\"},\n}\n").unwrap();
        assert!(planned_matches_live(&path, "{\"env\":{\"A\":\"1\"}}"));
        let jsonc = dir.join("opencode.jsonc");
        std::fs::write(&jsonc, "\u{feff}{\n  // c\n  \"model\": \"m1\",\n  \"theme\": \"dark\",\n}\n").unwrap();
        assert!(planned_matches_live(&jsonc, "{\"model\":\"m1\"}"));
        assert!(!planned_matches_live(&jsonc, "{\"model\":\"m2\"}"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
